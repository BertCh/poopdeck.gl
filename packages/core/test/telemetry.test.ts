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

  it('trims the oldest QUARTER once the ring buffer overflows MAX_SAMPLES (batched, never one shift per sample)', () => {
    setBag({ enabled: true });
    // One past the boundary triggers one batched trim of MAX_SAMPLES / 4.
    for (let i = 0; i <= MAX_SAMPLES; i++) emit('decode', { i });
    const arr = getBag()!.decode!;
    expect(arr).toHaveLength(MAX_SAMPLES - MAX_SAMPLES / 4 + 1);
    expect(arr[0]).toEqual({ i: MAX_SAMPLES / 4 }); // { i: 0..1023 } trimmed
    expect(arr[arr.length - 1]).toEqual({ i: MAX_SAMPLES });

    // Sustained overflow stays inside (3/4 cap, cap] and keeps sliding.
    for (let i = MAX_SAMPLES + 1; i < MAX_SAMPLES + 100; i++)
      emit('decode', { i });
    expect(arr.length).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(arr.length).toBeGreaterThanOrEqual(MAX_SAMPLES - MAX_SAMPLES / 4);
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

// Tile-loading audit 2026-08 follow-up (found by a peer session's core audit):
// a full channel used to pay one `shift()` PER SAMPLE — ~90 µs/decode once the
// decode-wait ring held 4,096 entries, i.e. the probe changed what it measured
// and only after the 4,096th sample. Trims are batched now, and the roll-up
// ring is a small recent window.
describe('probe rings trim in batches, never one shift per sample', () => {
  beforeEach(() => {
    (globalThis as { __sttProbe?: unknown }).__sttProbe = { enabled: true };
  });
  afterEach(() => {
    delete (globalThis as { __sttProbe?: unknown }).__sttProbe;
  });

  it('emit() keeps a saturated channel between 3/4 and the full cap (batched trim)', () => {
    for (let i = 0; i < 4096 + 2000; i++) emit('decode', { i });
    const arr = (globalThis as { __sttProbe: { decode: unknown[] } }).__sttProbe
      .decode;
    expect(arr.length).toBeLessThanOrEqual(4096);
    expect(arr.length).toBeGreaterThanOrEqual(4096 - 1024);
    // Oldest samples are the ones dropped.
    expect((arr[arr.length - 1] as { i: number }).i).toBe(4096 + 2000 - 1);
  });

  it('recordDecodeWait() keeps a bounded recent window and still rolls up percentiles', async () => {
    const { recordDecodeWait } = await import('../src/telemetry');
    for (let i = 0; i < 5000; i++) recordDecodeWait(i % 100, 3);
    const bag = (
      globalThis as {
        __sttProbe: {
          __decodeWaitRing?: { waits: number[] };
          snapshots?: Record<string, { p50WaitMs: number; p95WaitMs: number }>;
        };
      }
    ).__sttProbe;
    const ring = bag.__decodeWaitRing;
    expect(ring).toBeDefined();
    expect(ring!.waits.length).toBeLessThanOrEqual(512);
    expect(ring!.waits.length).toBeGreaterThanOrEqual(512 - 128);
    const snap = bag.snapshots?.decodeQueue;
    expect(snap).toBeDefined();
    expect(snap!.p50WaitMs).toBeGreaterThan(0);
    expect(snap!.p95WaitMs).toBeGreaterThanOrEqual(snap!.p50WaitMs);
  });
});
