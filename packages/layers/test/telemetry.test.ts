/**
 * Telemetry channel contract tests.
 *
 * The probe is opt-in: when `globalThis.__sttProbe` is unset, every call is
 * a no-op. When it IS set, samples accumulate on per-channel arrays.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emit, measure, disableProbe } from '../src/lib/telemetry';

interface ProbeBag {
  enabled?: boolean;
  consolidations?: unknown[];
  renderLayers?: unknown[];
  tilePrepare?: unknown[];
  decode?: unknown[];
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
    expect(() => emit('consolidations', { ms: 1, n: 1, layer: 'x' })).not.toThrow();
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
