/**
 * The P0-2 telemetry channel extension (`src/telemetry.ts`).
 *
 * `telemetry.test.ts` pins the shim's original contract (gating + ring bound)
 * on the `decode` / `tilePrepare` channels. This suite pins the ADDITIONS that
 * Phase 1's acceptance criteria read, and — more importantly — that they
 * inherit the same two invariants:
 *
 *   1. PROBE-OFF IS A NO-OP. With no bag installed (or `enabled:false`)
 *      nothing is created, nothing is timed, nothing is allocated. The guard
 *      test at the bottom drives a real `SharedRequestScheduler` request end
 *      to end with the probe off and asserts the bag was never even created —
 *      the "zero allocations on the request path" requirement.
 *   2. THE RING CAP STANDS. Every new channel is bounded by the same
 *      MAX_SAMPLES = 4096 FIFO window, so a long session cannot grow memory.
 *
 * Plus the `decodeQueue` roll-up: percentiles over the decode QUEUE WAIT ring,
 * published as a latest-value snapshot so pool-size adaptation gets a cheap
 * read instead of re-scanning the `decode` channel.
 *
 * ── And the `tileset.viewport` TRAJECTORY snapshot ──────────────────────────
 * The channels above are a decision log; none of them says where the camera
 * and the play-head were. `tools/bench/src/policy-record.mjs` feature-detects
 * `snapshots['tileset.viewport']` and REFUSES (exit 3) to write a trace that
 * has no trajectory, because the replay re-derives demand from the trajectory
 * alone. The last two suites here pin the publisher and — by driving the
 * recorder's own page-side sampler against a real tileset — pin the contract
 * end to end, so a field rename on either side fails a test rather than
 * silently degrading every future trace to defaults.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  emit,
  isProbeEnabled,
  probeNow,
  recordDecodeWait,
  recordViewport,
  VIEWPORT_SNAPSHOT,
  type CoreProbeChannel,
  type DecodeQueueSnapshot,
  type EvictProbeSample,
  type RequestProbeSample,
  type ViewportProbeSnapshot,
} from '../src/telemetry';
import { SharedRequestScheduler } from '../src/request-scheduler';
import { STTArchive } from '../src/archive';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import { tileKey } from '../src/tile-key';
import type { BoundingBox, TileId } from '../src/types';
import { packedFromGolden } from './helpers/packed-fixture';
import { bufferToArrayBuffer, fakeTile, flush } from './helpers/fixtures';

/** Mirror of the module-private constant (src/telemetry.ts). */
const MAX_SAMPLES = 4096;
/** Mirror of the module-private roll-up throttle (src/telemetry.ts). */
const DECODE_ROLLUP_EVERY = 16;

/** The three channels P0-2 adds. */
const NEW_CHANNELS: CoreProbeChannel[] = ['requests', 'evict', 'scrub'];

interface ProbeBag {
  enabled?: boolean;
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

const settle = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('core telemetry — the P0-2 channels', () => {
  let original: ProbeBag | undefined;

  beforeEach(() => {
    original = getBag();
    setBag(undefined);
  });

  afterEach(() => {
    setBag(original);
  });

  it('isProbeEnabled() mirrors the emit() gate exactly', () => {
    expect(isProbeEnabled()).toBe(false); // unset
    setBag({ enabled: false });
    expect(isProbeEnabled()).toBe(false);
    setBag({}); // `enabled` undefined → not === false → on
    expect(isProbeEnabled()).toBe(true);
    setBag({ enabled: true });
    expect(isProbeEnabled()).toBe(true);
  });

  it('probeNow() returns a finite, non-decreasing timestamp', () => {
    const a = probeNow();
    const b = probeNow();
    expect(Number.isFinite(a)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it.each(NEW_CHANNELS)(
    'channel %s is a no-op with no probe installed',
    (channel) => {
      expect(getBag()).toBeUndefined();
      expect(() => emit(channel, { x: 1 })).not.toThrow();
      expect(getBag()).toBeUndefined();
    },
  );

  it.each(NEW_CHANNELS)(
    'channel %s records nothing when the probe is disabled',
    (channel) => {
      setBag({ enabled: false });
      emit(channel, { x: 1 });
      // Gated at the top of emit(): the array is never even lazily created.
      expect(getBag()![channel]).toBeUndefined();
    },
  );

  it.each(NEW_CHANNELS)('channel %s records when enabled', (channel) => {
    setBag({ enabled: true });
    emit(channel, { x: 1 });
    emit(channel, { x: 2 });
    expect(getBag()![channel]).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it.each(NEW_CHANNELS)(
    'channel %s stays bounded by the 4096-sample ring',
    (channel) => {
      setBag({ enabled: true });
      for (let i = 0; i <= MAX_SAMPLES; i++) emit(channel, { i });
      const arr = getBag()![channel] as Array<{ i: number }>;
      expect(arr).toHaveLength(MAX_SAMPLES);
      expect(arr[0]).toEqual({ i: 1 }); // oldest shifted off
      expect(arr[arr.length - 1]).toEqual({ i: MAX_SAMPLES });
    },
  );

  it('the new channels are independent rings (no cross-channel bleed)', () => {
    setBag({ enabled: true });
    emit<RequestProbeSample>('requests', {
      key: '3/1/2/0',
      priority: 5,
      bytes: 100,
      enqueuedAt: 1,
      dispatchedAt: 2,
      completedAt: 3,
      source: 'mem://a',
    });
    emit<EvictProbeSample>('evict', {
      key: '3/1/2/0',
      tier: 'c',
      bytes: 100,
      playheadMs: 42,
    });
    const bag = getBag()!;
    expect(bag.requests).toHaveLength(1);
    expect(bag.evict).toHaveLength(1);
    expect(bag.scrub).toBeUndefined();
    expect((bag.evict as EvictProbeSample[])[0].tier).toBe('c');
  });
});

describe('core telemetry — the decodeQueue roll-up', () => {
  let original: ProbeBag | undefined;

  beforeEach(() => {
    original = getBag();
    setBag(undefined);
  });

  afterEach(() => {
    setBag(original);
  });

  it('is a no-op with no probe installed', () => {
    expect(() => recordDecodeWait(12, 3)).not.toThrow();
    expect(getBag()).toBeUndefined();
  });

  it('records nothing when the probe is disabled', () => {
    setBag({ enabled: false });
    recordDecodeWait(12, 3);
    const bag = getBag()!;
    expect(bag.snapshots).toBeUndefined();
    // The wait ring lives ON the bag, so probe-off allocates nothing at all.
    expect(Object.keys(bag)).toEqual(['enabled']);
  });

  it('publishes p50/p95/pending as a latest-value snapshot', () => {
    setBag({ enabled: true });
    // 1..10 ms of wait. Nearest-rank over n = 10: p50 → index 5 (6 ms),
    // p95 → index min(9, floor(9.5)) = 9 (10 ms).
    for (let i = 1; i <= 10; i++) recordDecodeWait(i, 10 - i);
    const snap = getBag()!.snapshots!.decodeQueue as DecodeQueueSnapshot;
    expect(snap.p50WaitMs).toBe(6);
    expect(snap.p95WaitMs).toBe(10);
    // `pending` is the latest reported host queue depth, not an average.
    expect(snap.pending).toBe(0);
  });

  it('publishes every sample while warming up, then throttles', () => {
    setBag({ enabled: true });
    // WARM-UP: while the ring holds fewer than DECODE_ROLLUP_EVERY samples,
    // every record republishes, so a short harness run still sees a snapshot.
    for (let i = 0; i < DECODE_ROLLUP_EVERY - 1; i++) recordDecodeWait(1, i);
    let snap = getBag()!.snapshots!.decodeQueue as DecodeQueueSnapshot;
    expect(snap.pending).toBe(DECODE_ROLLUP_EVERY - 2);

    // WARM: the percentile sort must NOT run per decode — the snapshot only
    // refreshes once every DECODE_ROLLUP_EVERY samples.
    for (let i = 0; i < DECODE_ROLLUP_EVERY - 1; i++) recordDecodeWait(1, 999);
    snap = getBag()!.snapshots!.decodeQueue as DecodeQueueSnapshot;
    expect(snap.pending).toBe(DECODE_ROLLUP_EVERY - 2); // still the old value
    recordDecodeWait(1, 777); // the DECODE_ROLLUP_EVERY-th since the publish
    snap = getBag()!.snapshots!.decodeQueue as DecodeQueueSnapshot;
    expect(snap.pending).toBe(777);
  });

  it('keeps the wait ring bounded at MAX_SAMPLES', () => {
    setBag({ enabled: true });
    for (let i = 0; i < MAX_SAMPLES + 500; i++) recordDecodeWait(i, 0);
    const ring = getBag()!.__decodeWaitRing as { waits: number[] };
    expect(ring.waits).toHaveLength(MAX_SAMPLES);
    // FIFO window slid forward: the oldest 500 samples are gone.
    expect(ring.waits[0]).toBe(500);
  });

  it('clamps negative waits to zero (clock skew must not poison percentiles)', () => {
    setBag({ enabled: true });
    recordDecodeWait(-5, 0);
    const snap = getBag()!.snapshots!.decodeQueue as DecodeQueueSnapshot;
    expect(snap.p50WaitMs).toBe(0);
  });

  it('resets with the bag (the ring is bag-scoped, not module-scoped)', () => {
    setBag({ enabled: true });
    for (let i = 0; i < 5; i++) recordDecodeWait(100, 0);
    expect(
      (getBag()!.snapshots!.decodeQueue as DecodeQueueSnapshot).p50WaitMs,
    ).toBe(100);
    setBag({ enabled: true }); // fresh bag = fresh session
    recordDecodeWait(1, 0);
    expect(
      (getBag()!.snapshots!.decodeQueue as DecodeQueueSnapshot).p50WaitMs,
    ).toBe(1);
  });
});

describe('requests channel — the scheduler emission', () => {
  let original: ProbeBag | undefined;

  beforeEach(() => {
    original = getBag();
    setBag(undefined);
  });

  afterEach(() => {
    setBag(original);
  });

  it('GUARD: probe off ⇒ the request path leaves the bag untouched', async () => {
    expect(getBag()).toBeUndefined();
    const scheduler = new SharedRequestScheduler({ maxRequests: 2 });
    await Promise.all([
      scheduler.schedule({
        sourceId: 'mem://a',
        key: '3/1/2/0',
        bytes: 1234,
        getPriority: () => 0,
        execute: async () => 'ok',
      }),
      scheduler.schedule({
        sourceId: 'mem://a',
        key: '3/1/3/0',
        bytes: 4321,
        getPriority: () => 1,
        execute: async () => 'ok',
      }),
    ]);
    // Not merely "no samples" — the bag itself was never created.
    expect(getBag()).toBeUndefined();
  });

  it('GUARD: enabled:false ⇒ no channel array is created either', async () => {
    setBag({ enabled: false });
    const scheduler = new SharedRequestScheduler({ maxRequests: 1 });
    await scheduler.schedule({
      sourceId: 'mem://a',
      key: 'k',
      bytes: 7,
      getPriority: () => 0,
      execute: async () => 'ok',
    });
    expect(getBag()!.requests).toBeUndefined();
  });

  it('emits one sample per settled request with the full timeline', async () => {
    setBag({ enabled: true });
    const scheduler = new SharedRequestScheduler({ maxRequests: 1 });
    await scheduler.schedule({
      sourceId: 'mem://a',
      key: '3/1/2/0',
      bytes: 1234,
      getPriority: () => 7,
      execute: async () => {
        await settle(1);
        return 'ok';
      },
    });
    const samples = getBag()!.requests as RequestProbeSample[];
    expect(samples).toHaveLength(1);
    const s = samples[0];
    expect(s.key).toBe('3/1/2/0');
    expect(s.bytes).toBe(1234);
    expect(s.source).toBe('mem://a');
    expect(s.priority).toBe(7);
    // enqueue ≤ dispatch ≤ complete, and the request really did dispatch.
    expect(s.dispatchedAt).toBeGreaterThan(0);
    expect(s.dispatchedAt).toBeGreaterThanOrEqual(s.enqueuedAt);
    expect(s.completedAt).toBeGreaterThanOrEqual(s.dispatchedAt);
  });

  it('defaults key/bytes for callers that supply no probe label', async () => {
    setBag({ enabled: true });
    const scheduler = new SharedRequestScheduler({ maxRequests: 1 });
    await scheduler.schedule({
      sourceId: 'src',
      getPriority: () => 0,
      execute: async () => 1,
    });
    const s = (getBag()!.requests as RequestProbeSample[])[0];
    expect(s.key).toBe('');
    expect(s.bytes).toBe(0);
  });

  it('records a failed request too (the slot was still spent)', async () => {
    setBag({ enabled: true });
    const scheduler = new SharedRequestScheduler({ maxRequests: 1 });
    await expect(
      scheduler.schedule({
        sourceId: 'src',
        key: 'boom',
        bytes: 9,
        getPriority: () => 0,
        execute: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    const s = (getBag()!.requests as RequestProbeSample[])[0];
    expect(s.key).toBe('boom');
    expect(s.dispatchedAt).toBeGreaterThan(0);
  });

  it('marks a queued-then-cancelled request with dispatchedAt === 0', async () => {
    setBag({ enabled: true });
    const scheduler = new SharedRequestScheduler({ maxRequests: 1 });
    let release!: () => void;
    const blocker = scheduler.schedule({
      sourceId: 'src',
      key: 'running',
      bytes: 1,
      getPriority: () => 0,
      execute: () => new Promise<void>((r) => (release = r)),
    });
    // Occupies the only slot, so this one stays QUEUED and is aborted there.
    const queued = scheduler.scheduleRequest({
      sourceId: 'src',
      key: 'never-ran',
      bytes: 2,
      getPriority: () => 1,
      execute: async () => undefined,
    });
    queued.abort('superseded');
    await expect(queued.promise).rejects.toThrow('superseded');
    release();
    await blocker;

    const samples = getBag()!.requests as RequestProbeSample[];
    const cancelled = samples.find((s) => s.key === 'never-ran')!;
    const ran = samples.find((s) => s.key === 'running')!;
    // The sentinel is what separates supersession from a real fetch: a
    // never-dispatched request occupied no slot and moved no bytes.
    expect(cancelled.dispatchedAt).toBe(0);
    expect(ran.dispatchedAt).toBeGreaterThan(0);
  });

  it('labels a real archive range fetch with its lead tile key and bytes', async () => {
    setBag({ enabled: true });
    const ds = packedFromGolden({ manifestUrl: 'mem://probe/manifest.json' });
    const slash = ds.manifestUrl.lastIndexOf('/');
    const base = ds.manifestUrl.slice(0, slash + 1);
    const f = (async (url: string, init?: RequestInit) => {
      const key = url.startsWith(base) ? url.slice(base.length) : url;
      const bytes = ds.objects.get(key)!;
      const range = (init?.headers as Record<string, string> | undefined)
        ?.Range;
      const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
      if (!m) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          arrayBuffer: async () => bufferToArrayBuffer(bytes),
        };
      }
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), bytes.length - 1);
      return {
        ok: true,
        status: 206,
        statusText: 'Partial Content',
        arrayBuffer: async () =>
          bufferToArrayBuffer(bytes.subarray(start, end + 1)),
      };
    }) as unknown as typeof fetch;

    const archive = new STTArchive({ url: ds.manifestUrl, fetch: f });
    const index = await archive.getIndex();
    const e = index.tiles[0];
    // The BATCH path is what the tileset drives (and the only one that goes
    // through the shared scheduler — single `getTile` fetches directly).
    const tiles = await archive.getTiles([
      { z: e.zoom, x: e.x, y: e.y, t: e.timeStart },
    ]);
    expect(tiles[0]).not.toBeNull();

    const samples = getBag()!.requests as RequestProbeSample[];
    expect(samples.length).toBeGreaterThan(0);
    // Keyed with the canonical `tileKey` string (the OPFS persistence
    // contract) — read here, never reshaped.
    const expectedKey = tileKey({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
    const tileSample = samples.find((s) => s.key === expectedKey);
    // The label is the group's LEAD tile key, and `bytes` is the whole
    // coalesced range — the byte accounting P0-3 prices policies with.
    expect(tileSample).toBeDefined();
    expect(tileSample!.bytes).toBeGreaterThanOrEqual(e.length);
    expect(tileSample!.source).toBe(ds.manifestUrl);
    expect(tileSample!.dispatchedAt).toBeGreaterThan(0);
  });

  it('stays inside the ring cap under sustained request churn', async () => {
    setBag({ enabled: true });
    const scheduler = new SharedRequestScheduler({ maxRequests: 8 });
    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < MAX_SAMPLES + 32; i++) {
      jobs.push(
        scheduler.schedule({
          sourceId: 'src',
          key: `k${i}`,
          bytes: 1,
          getPriority: () => i,
          execute: async () => i,
        }),
      );
    }
    await Promise.all(jobs);
    expect(getBag()!.requests).toHaveLength(MAX_SAMPLES);
  });
});

// ─────────────────────────────────── the trajectory snapshot ────────────────

/** A tileset with a stubbed source, minimal enough to drive `update()`. */
function makeTileset() {
  const tileset = new SpatioTemporalTileset({
    minZoom: 6,
    maxZoom: 6,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: 1000,
    getAvailableTiles: async (_bounds: BoundingBox, z: number) =>
      z === 6 ? [{ z, x: 0, y: 0, t: 0 }] : [],
    getTileData: async (id: TileId) => fakeTile(id),
  });
  return tileset;
}

const BOX: BoundingBox = { minLon: 10, minLat: 20, maxLon: 30, maxLat: 40 };
const view = (over: Partial<{ bounds: BoundingBox; time: number }> = {}) => ({
  bounds: over.bounds ?? BOX,
  zoom: 6,
  time: over.time ?? 0,
  timeWindow: 5000,
});

const readViewport = (): ViewportProbeSnapshot | undefined =>
  getBag()?.snapshots?.[VIEWPORT_SNAPSHOT] as ViewportProbeSnapshot | undefined;

describe('tileset.viewport — the trajectory snapshot', () => {
  let original: ProbeBag | undefined;

  beforeEach(() => {
    original = getBag();
    setBag(undefined);
  });

  afterEach(() => {
    setBag(original);
  });

  it('recordViewport publishes the six fields the recorder reads', () => {
    setBag({ enabled: true });
    recordViewport(BOX, 7, 1234, 5000, -1, true);
    expect(readViewport()).toEqual({
      bounds: [10, 20, 30, 40],
      zoom: 7,
      playheadMs: 1234,
      timeWindowMs: 5000,
      direction: -1,
      animating: true,
    });
  });

  it('GUARD: probe unset ⇒ recordViewport allocates nothing at all', () => {
    expect(getBag()).toBeUndefined();
    recordViewport(BOX, 7, 1, 2, 1, false);
    // Not "no snapshot" — the bag itself was never created.
    expect(getBag()).toBeUndefined();
  });

  it('GUARD: enabled:false ⇒ no snapshots object is created', () => {
    setBag({ enabled: false });
    recordViewport(BOX, 7, 1, 2, 1, false);
    expect(getBag()!.snapshots).toBeUndefined();
    expect(Object.keys(getBag()!)).toEqual(['enabled']);
  });

  it('GUARD: probe off ⇒ a full update() pass leaves the bag uncreated', async () => {
    expect(getBag()).toBeUndefined();
    const tileset = makeTileset();
    tileset.update(view(), true);
    tileset.update(view({ time: 2000 }), true);
    await flush();
    // The "zero allocations on the request path" requirement, extended to the
    // per-tick viewport path: a production build pays one property read.
    expect(getBag()).toBeUndefined();
    tileset.finalize();
  });

  it('update() publishes the viewport, play-head and window', async () => {
    setBag({ enabled: true });
    const tileset = makeTileset();
    tileset.update(view({ time: 8000 }), true);
    await flush();

    const snap = readViewport()!;
    expect(snap).toBeDefined();
    expect(snap.bounds).toEqual([10, 20, 30, 40]);
    expect(snap.zoom).toBe(6);
    expect(snap.playheadMs).toBe(8000);
    expect(snap.timeWindowMs).toBe(5000);
    expect(snap.direction).toBe(1);
    tileset.finalize();
  });

  it('is a LATEST-VALUE snapshot, so a long session cannot grow memory', async () => {
    setBag({ enabled: true });
    const tileset = makeTileset();
    for (let i = 0; i < MAX_SAMPLES + 100; i++) {
      tileset.update(view({ time: i * 100 }), true);
    }
    await flush();
    // One slot, whatever the walk length — no ring to cap.
    expect(readViewport()!.playheadMs).toBe((MAX_SAMPLES + 99) * 100);
    expect(getBag()!.snapshots![VIEWPORT_SNAPSHOT]).toBeDefined();
    expect(Array.isArray(getBag()!.snapshots![VIEWPORT_SNAPSHOT])).toBe(false);
    tileset.finalize();
  });

  it('publishes the REPAIRED box, not the camera-derived one', async () => {
    setBag({ enabled: true });
    const tileset = makeTileset();
    // The inverted-latitude box deck produced past bearing > atan2(h, w).
    // A replay fed the raw box would derive an empty demand set for every
    // step and report a flawless policy.
    tileset.update(
      view({ bounds: { minLon: 10, minLat: 40, maxLon: 30, maxLat: 20 } }),
      true,
    );
    await flush();
    expect(readViewport()!.bounds).toEqual([10, 20, 30, 40]);
    tileset.finalize();
  });

  it('records nothing new when update() rejects a non-finite box', async () => {
    setBag({ enabled: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tileset = makeTileset();
    tileset.update(view({ time: 1000 }), true);
    await flush();
    tileset.update(
      {
        bounds: { minLon: NaN, minLat: 20, maxLon: 30, maxLat: 40 },
        zoom: 6,
        time: 9999,
        timeWindow: 5000,
      },
      true,
    );
    await flush();
    // The tileset KEPT its previous viewport, so the previous sample is still
    // the truth — publishing 9999 would put the trace somewhere the tileset
    // never selected against.
    expect(readViewport()!.playheadMs).toBe(1000);
    warn.mockRestore();
    tileset.finalize();
  });

  it('tracks the committed direction and the animating bit', async () => {
    setBag({ enabled: true });
    const tileset = makeTileset();
    tileset.update(view({ time: 10_000 }), true);
    await flush();
    expect(readViewport()!.animating).toBe(false);

    tileset.setAnimationState(true, -1);
    tileset.update(view({ time: 9_000 }), true);
    await flush();
    let snap = readViewport()!;
    expect(snap.animating).toBe(true);
    expect(snap.direction).toBe(-1);

    tileset.setAnimationState(false, 0);
    tileset.update(view({ time: 8_500 }), true);
    await flush();
    snap = readViewport()!;
    expect(snap.animating).toBe(false);
    expect(snap.playheadMs).toBe(8_500);
    tileset.finalize();
  });
});

describe("policy-record.mjs's feature detection, against the real publisher", () => {
  let original: ProbeBag | undefined;

  beforeEach(() => {
    original = getBag();
    setBag(undefined);
  });

  afterEach(() => {
    setBag(original);
    for (const k of ['__sttTrace', '__sttTraceDrain']) {
      delete (globalThis as unknown as Record<string, unknown>)[k];
    }
  });

  /**
   * Install the RECORDER'S OWN page-side sampler — not a re-implementation of
   * it — with `setInterval` stubbed out so nothing is scheduled (the driver
   * also calls `__sttTraceDrain` directly at the end of a capture, which is
   * what this drives).
   */
  async function installRecorderSampler(): Promise<() => void> {
    const mod = await import('../../../tools/bench/src/policy-record.mjs');
    const realSetInterval = globalThis.setInterval;
    (globalThis as unknown as { setInterval: unknown }).setInterval = () => 0;
    try {
      (
        mod as { installSampler: (ms: number, ch: string[]) => void }
      ).installSampler(250, [
        'requests',
        'decode',
        'evict',
        'scrub',
        'playback',
      ]);
    } finally {
      (globalThis as unknown as { setInterval: unknown }).setInterval =
        realSetInterval;
    }
    const trace = (
      globalThis as unknown as {
        __sttTrace: { armed: boolean; t0: number; events: unknown[] };
      }
    ).__sttTrace;
    trace.t0 = 0;
    trace.armed = true;
    return () =>
      (
        globalThis as unknown as { __sttTraceDrain: () => void }
      ).__sttTraceDrain();
  }

  interface ViewportEvent {
    ch: string;
    tMs: number;
    playheadMs: number | null;
    timeWindowMs: number | null;
    zoom: number | null;
    bounds: number[] | null;
    direction: 1 | -1;
    animating: boolean;
  }

  it('records a real trajectory from a tileset that only ran update()', async () => {
    const drain = await installRecorderSampler();
    const tileset = makeTileset();
    tileset.setAnimationState(true, 1);
    for (const t of [0, 1000, 2000]) {
      tileset.update(view({ time: t }), true);
      await flush();
      drain();
    }

    const events = (
      globalThis as unknown as { __sttTrace: { events: ViewportEvent[] } }
    ).__sttTrace.events;
    const viewportEvents = events.filter((e) => e.ch === 'viewport');
    // THE defect this closes: before the publisher existed this was 0, and
    // the recorder exited 3 with "NO TRAJECTORY RECORDED".
    expect(viewportEvents).toHaveLength(3);

    const last = viewportEvents[2];
    // Every field the replayer's buildSteps() reads must be non-null: each
    // null silently becomes a default (playhead 0, zoom 0, whole-world bounds)
    // and the replay reports on a trajectory nobody flew.
    expect(last.playheadMs).toBe(2000);
    expect(last.timeWindowMs).toBe(5000);
    expect(last.zoom).toBe(6);
    expect(last.bounds).toEqual([10, 20, 30, 40]);
    expect(last.bounds!.every((n) => Number.isFinite(n))).toBe(true);
    expect(last.direction).toBe(1);
    expect(last.animating).toBe(true);
    tileset.finalize();
  });

  it('reports the trajectory SOURCE as the tileset snapshot', async () => {
    const drain = await installRecorderSampler();
    const tileset = makeTileset();
    tileset.update(view(), true);
    await flush();
    drain();
    const trace = (
      globalThis as unknown as { __sttTrace: { trajectorySource: string } }
    ).__sttTrace;
    // The header line that tells a reader whether the replay had spatial
    // information at all ('playback.state' is temporal-only).
    expect(trace.trajectorySource).toBe(VIEWPORT_SNAPSHOT);
    tileset.finalize();
  });
});
