/**
 * Telemetry channel contract tests.
 *
 * The probe is opt-in: when `globalThis.__sttProbe` is unset, every call is
 * a no-op. When it IS set, samples accumulate on per-channel arrays.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  emit,
  measure,
  disableProbe,
  snapshot,
  getSnapshot,
  isProbeEnabled,
  enableProbe,
  acquireProbe,
} from '../src/lib/telemetry';

interface ProbeBag {
  enabled?: boolean;
  consolidations?: unknown[];
  renderLayers?: unknown[];
  tilePrepare?: unknown[];
  decode?: unknown[];
  snapshots?: Record<string, unknown>;
}

function setProbe(initial: ProbeBag = {}) {
  (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe = initial;
}

function clearProbe() {
  delete (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
}

describe('telemetry', () => {
  beforeEach(() => {
    clearProbe();
  });
  afterEach(() => {
    clearProbe();
  });

  it('emit() is a no-op when __sttProbe is unset (no global mutation, no throw)', () => {
    expect(() =>
      emit('consolidations', { ms: 1, n: 1, layer: 'x' }),
    ).not.toThrow();
    expect(
      (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe,
    ).toBeUndefined();
  });

  it('emit() appends samples to the named channel when the probe is enabled', () => {
    setProbe();
    emit('consolidations', { ms: 1.2, n: 5, layer: 'pts' });
    emit('consolidations', { ms: 2.4, n: 6, layer: 'pts' });
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.consolidations).toHaveLength(2);
    expect(bag.consolidations?.[1]).toMatchObject({ ms: 2.4, n: 6 });
  });

  it('emit() respects enabled=false (no append)', () => {
    setProbe({ enabled: false });
    emit('consolidations', { ms: 1, n: 1, layer: 'x' });
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.consolidations).toBeUndefined();
  });

  it('measure() returns the wrapped function value untouched', () => {
    setProbe();
    const result = measure('consolidations', { layer: 'x' }, () => 'hello');
    expect(result).toBe('hello');
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.consolidations).toHaveLength(1);
    const sample = bag.consolidations?.[0] as { ms: number; layer: string };
    expect(sample.layer).toBe('x');
    expect(sample.ms).toBeGreaterThanOrEqual(0);
  });

  it('measure() skips performance.now() entirely when probe is disabled', () => {
    // Without `enabled`, measure should still emit. With enabled=false,
    // it should NOT call into performance.now (no timing sample emitted).
    setProbe({ enabled: false });
    const result = measure('consolidations', { layer: 'x' }, () => 42);
    expect(result).toBe(42);
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.consolidations).toBeUndefined();
  });

  it('disableProbe() stops further emissions but keeps the bag', () => {
    setProbe();
    emit('renderLayers', { ms: 1, tiles: 1, layer: 'x' });
    disableProbe();
    emit('renderLayers', { ms: 2, tiles: 2, layer: 'x' });
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.enabled).toBe(false);
    // First sample is retained, second is dropped.
    expect(bag.renderLayers).toHaveLength(1);
  });

  it('emit() caps samples per channel to avoid unbounded growth', () => {
    setProbe();
    // Use a large but finite count to avoid making the test slow; the
    // implementation cap is 4096 — verify we never exceed it even after
    // 6000 pushes.
    for (let i = 0; i < 6000; i++) {
      emit('renderLayers', { ms: i, tiles: 1, layer: 'x' });
    }
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.renderLayers?.length ?? 0).toBeLessThanOrEqual(4096);
    expect(bag.renderLayers?.length ?? 0).toBeGreaterThan(0);
    // Oldest sample dropped → last entry is the most recently pushed.
    const last = bag.renderLayers?.at(-1) as { ms: number };
    expect(last.ms).toBe(5999);
  });

  it('a snapshot-only scoped consumer does not allocate sample channels', () => {
    const release = acquireProbe({ samples: false });
    snapshot('fps', 60);
    emit('renderLayers', { ms: 1, tiles: 1, layer: 'x' });
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(getSnapshot('fps')).toBe(60);
    expect(bag.renderLayers).toBeUndefined();
    release();
    expect(isProbeEnabled()).toBe(false);
  });

  it('scoped consumers compose and release independently', () => {
    const releaseSnapshots = acquireProbe({ samples: false });
    const releaseSamples = acquireProbe({ samples: true });
    emit('renderLayers', { ms: 1, tiles: 1, layer: 'x' });
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.renderLayers).toHaveLength(1);
    releaseSamples();
    expect(isProbeEnabled()).toBe(true);
    emit('renderLayers', { ms: 2, tiles: 2, layer: 'x' });
    expect(bag.renderLayers).toHaveLength(1);
    releaseSnapshots();
    expect(isProbeEnabled()).toBe(false);
  });

  it('measure() rethrows exceptions and still emits the sample', () => {
    setProbe();
    expect(() =>
      measure('consolidations', { layer: 'x' }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.consolidations).toHaveLength(1);
  });
});

describe('telemetry snapshot channel', () => {
  beforeEach(() => {
    clearProbe();
  });
  afterEach(() => {
    clearProbe();
  });

  it('snapshot() is a no-op when __sttProbe is unset (no throw, no bag created)', () => {
    expect(() => snapshot('fps', 60)).not.toThrow();
    expect(
      (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe,
    ).toBeUndefined();
  });

  it('getSnapshot() returns undefined when the probe is unset', () => {
    expect(getSnapshot('fps')).toBeUndefined();
  });

  it('snapshot() publishes a latest value readable via getSnapshot()', () => {
    setProbe();
    snapshot('fps', { value: 60 });
    expect(getSnapshot('fps')).toEqual({ value: 60 });
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.snapshots?.fps).toEqual({ value: 60 });
  });

  it('snapshot() OVERWRITES (latest wins) rather than appending like emit()', () => {
    setProbe();
    snapshot('fps', 30);
    snapshot('fps', 45);
    snapshot('fps', 60);
    expect(getSnapshot('fps')).toBe(60);
    // The snapshots channel is a keyed object, not a growing array.
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(Array.isArray(bag.snapshots)).toBe(false);
    expect(Object.keys(bag.snapshots ?? {})).toEqual(['fps']);
  });

  it('snapshot() respects enabled=false (nothing published)', () => {
    setProbe({ enabled: false });
    snapshot('fps', 60);
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.snapshots).toBeUndefined();
    expect(getSnapshot('fps')).toBeUndefined();
  });

  it('getSnapshot() returns undefined for a name that was never published', () => {
    setProbe();
    snapshot('fps', 60);
    expect(getSnapshot('never-set')).toBeUndefined();
  });

  it('getSnapshot() reads the last published value even after the probe is disabled', () => {
    // getSnapshot() is gated only by the bag existing, NOT by `enabled`; only
    // snapshot() WRITES are gated. A value published while enabled stays
    // readable after disableProbe(), but a new publish while disabled is dropped.
    setProbe();
    snapshot('fps', 60);
    disableProbe();
    expect(getSnapshot('fps')).toBe(60);
    snapshot('fps', 5); // dropped — probe disabled
    expect(getSnapshot('fps')).toBe(60);
  });
});

describe('telemetry probe enable/disable', () => {
  beforeEach(() => {
    clearProbe();
  });
  afterEach(() => {
    clearProbe();
  });

  it('isProbeEnabled() is false when the probe is unset', () => {
    expect(isProbeEnabled()).toBe(false);
  });

  it('isProbeEnabled() is true for a bag without an explicit enabled flag', () => {
    setProbe();
    expect(isProbeEnabled()).toBe(true);
  });

  it('isProbeEnabled() reflects an explicit enabled flag', () => {
    setProbe({ enabled: true });
    expect(isProbeEnabled()).toBe(true);
    setProbe({ enabled: false });
    expect(isProbeEnabled()).toBe(false);
  });

  it('enableProbe() creates the bag and turns sampling on when unset', () => {
    expect(
      (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe,
    ).toBeUndefined();
    enableProbe();
    expect(isProbeEnabled()).toBe(true);
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.enabled).toBe(true);
    // Sampling works now that the bag exists and is enabled.
    emit('consolidations', { ms: 1, n: 1, layer: 'x' });
    expect(bag.consolidations).toHaveLength(1);
  });

  it('enableProbe() is idempotent — re-enabling preserves existing samples', () => {
    setProbe({ enabled: false, consolidations: [{ ms: 1, n: 1, layer: 'x' }] });
    enableProbe();
    expect(isProbeEnabled()).toBe(true);
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(bag.consolidations).toHaveLength(1);
  });

  it('disableProbe() then enableProbe() resumes sampling onto the same buffers', () => {
    setProbe();
    emit('consolidations', { ms: 1, n: 1, layer: 'a' });
    disableProbe();
    emit('consolidations', { ms: 2, n: 2, layer: 'b' }); // dropped while disabled
    expect(isProbeEnabled()).toBe(false);
    enableProbe();
    emit('consolidations', { ms: 3, n: 3, layer: 'c' }); // appended after re-enable
    const bag = (globalThis as unknown as { __sttProbe: ProbeBag }).__sttProbe;
    expect(isProbeEnabled()).toBe(true);
    expect(bag.consolidations).toHaveLength(2);
    expect((bag.consolidations!.at(-1) as { layer: string }).layer).toBe('c');
  });
});
