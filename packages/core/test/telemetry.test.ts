/**
 * Core telemetry shim (`src/telemetry.ts`): probe gating + ring-buffer bound.
 *
 * The shim writes samples to `globalThis.__sttProbe` when (and only when) a
 * probe object is installed and not explicitly disabled. In production the
 * probe is unset, so every call must be a cheap no-op. These tests pin:
 *   - unset probe   → no-op (no throw, nothing recorded)
 *   - enabled:false → gated off for both emit() and snapshot()
 *   - installed probe → records, and the per-channel array is bounded to
 *     MAX_SAMPLES by a FIFO shift() of the oldest sample.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emit, snapshot } from '../src/telemetry';

// Mirror of the module-private constant (src/telemetry.ts). Kept in sync by
// the ring-buffer test below, which asserts the array never exceeds it.
const MAX_SAMPLES = 4096;

interface ProbeBag {
  enabled?: boolean;
  decode?: unknown[];
  tilePrepare?: unknown[];
  snapshots?: Record<string, unknown>;
  [k: string]: unknown;
}

function getBag(): ProbeBag | undefined {
  return (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
}
function setBag(bag: ProbeBag | undefined): void {
  if (bag === undefined) {
    delete (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  } else {
    (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe = bag;
  }
}

describe('core telemetry shim', () => {
  let original: ProbeBag | undefined;

  beforeEach(() => {
    original = getBag();
    setBag(undefined);
  });

  afterEach(() => {
    setBag(original);
  });

  it('is a no-op when no probe is installed', () => {
    expect(getBag()).toBeUndefined();
    // Neither call may throw, and nothing may be created.
    expect(() => emit('decode', { ms: 1 })).not.toThrow();
    expect(() => snapshot('latest', 42)).not.toThrow();
    expect(getBag()).toBeUndefined();
  });

  it('records nothing when the probe is explicitly disabled (enabled:false)', () => {
    setBag({ enabled: false });
    emit('decode', { ms: 1 });
    snapshot('latest', 42);
    const bag = getBag()!;
    // Gated at the top of emit()/snapshot(): the channel array and the
    // snapshots bag are never even lazily created.
    expect(bag.decode).toBeUndefined();
    expect(bag.snapshots).toBeUndefined();
  });

  it('emit() records to the channel when the probe is installed', () => {
    setBag({}); // enabled undefined → not === false → records
    emit('decode', { tileKey: 'a', ms: 3 });
    emit('tilePrepare', { tileKey: 'b' });
    const bag = getBag()!;
    expect(bag.decode).toEqual([{ tileKey: 'a', ms: 3 }]);
    expect(bag.tilePrepare).toEqual([{ tileKey: 'b' }]);
  });

  it('emit() lazily creates the channel array once, then appends', () => {
    setBag({ enabled: true });
    emit('decode', { i: 0 });
    const bag = getBag()!;
    const arr = bag.decode;
    emit('decode', { i: 1 });
    // Same array instance is reused (created only on first emit).
    expect(bag.decode).toBe(arr);
    expect(bag.decode).toEqual([{ i: 0 }, { i: 1 }]);
  });

  it('does not exceed MAX_SAMPLES at the boundary (no shift at exactly MAX_SAMPLES)', () => {
    setBag({ enabled: true });
    for (let i = 0; i < MAX_SAMPLES; i++) emit('decode', { i });
    const arr = getBag()!.decode!;
    expect(arr).toHaveLength(MAX_SAMPLES);
    // Nothing shifted yet — the oldest sample is still at the head.
    expect(arr[0]).toEqual({ i: 0 });
    expect(arr[arr.length - 1]).toEqual({ i: MAX_SAMPLES - 1 });
  });

  it('shifts the oldest sample once the ring buffer overflows MAX_SAMPLES', () => {
    setBag({ enabled: true });
    // One past the boundary triggers exactly one shift().
    for (let i = 0; i <= MAX_SAMPLES; i++) emit('decode', { i });
    const arr = getBag()!.decode!;
    expect(arr).toHaveLength(MAX_SAMPLES); // stays bounded
    expect(arr[0]).toEqual({ i: 1 }); // { i: 0 } was shifted off
    expect(arr[arr.length - 1]).toEqual({ i: MAX_SAMPLES });

    // Sustained overflow keeps it pinned at MAX_SAMPLES (FIFO window slides).
    for (let i = MAX_SAMPLES + 1; i < MAX_SAMPLES + 100; i++) emit('decode', { i });
    expect(arr).toHaveLength(MAX_SAMPLES);
    expect(arr[0]).toEqual({ i: 100 });
    expect(arr[arr.length - 1]).toEqual({ i: MAX_SAMPLES + 99 });
  });

  it('snapshot() publishes a latest-value under its name and overwrites', () => {
    setBag({});
    snapshot('viewport', { z: 10 });
    let bag = getBag()!;
    expect(bag.snapshots).toEqual({ viewport: { z: 10 } });
    // Latest-value semantics: a second snapshot replaces, not appends.
    snapshot('viewport', { z: 12 });
    bag = getBag()!;
    expect(bag.snapshots).toEqual({ viewport: { z: 12 } });
  });
});
