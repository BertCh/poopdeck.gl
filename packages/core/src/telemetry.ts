// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Minimal telemetry shim for `@poopdeck.gl/core`.
 *
 * Mirrors the channel layout used by `@poopdeck.gl/layers`'s `telemetry.ts` so
 * probe consumers see a single coherent `globalThis.__sttProbe` object.
 * Kept inline (rather than imported from `@poopdeck.gl/layers`) so the core
 * package has no dependency on a renderer.
 *
 * When the probe object isn't set up (production paths), every call is
 * a single property read + early return — safe to leave in hot paths.
 *
 * ─── The channel set (P0-2, optimization plan 2026-08) ───────────────────────
 *
 * `decode` / `tilePrepare` are the original two. P0-2 adds three more, because
 * the Phase-1 acceptance criteria (O1) name counters that did not exist:
 *
 *   - `requests` — one sample per scheduled range fetch (the shared request
 *     scheduler's settle path). Carries the enqueue → dispatch → complete
 *     timeline plus bytes, so a replay harness can price a policy in the
 *     blended `bytes + g·reads` form instead of request count alone.
 *   - `evict` — one sample per evicted tile, carrying the eviction TIER that
 *     freed the bytes. This is the per-tier attribution the loop-aware
 *     eviction work needs; the aggregate `runwayEvictions` counter only says
 *     that *some* eviction reached into the protected runway.
 *   - `scrub` — the governor's per-drag QoE roll-up (emitted from
 *     `@poopdeck.gl/playback`, same bag, same ring).
 *
 * Plus one derived snapshot, `decodeQueue`: a p50/p95 roll-up of decode QUEUE
 * WAIT (host enqueue → worker dispatch), so pool-size adaptation has a cheap
 * read instead of re-scanning the `decode` ring.
 *
 * ─── The trajectory snapshot (`tileset.viewport`) ────────────────────────────
 *
 * The channels above say what the loader DECIDED. None of them says where the
 * camera and the play-head WERE — and without that a recorded trace replays to
 * an empty report, because demand is re-derived from the trajectory (never from
 * what the recorded policy happened to fetch). `tools/bench/src/policy-record.mjs`
 * feature-detects exactly `snapshots['tileset.viewport']` and refuses to write a
 * trajectory-less trace; {@link recordViewport} is the publisher that satisfies
 * it. Its payload field names ARE that consumer contract — see
 * {@link ViewportProbeSnapshot} before renaming anything in it.
 *
 * PROBE-OFF DISCIPLINE. Every addition here keeps the "production is a single
 * property read" contract. Call sites that must build a payload object first
 * gate on {@link isProbeEnabled} so the allocation itself never happens when
 * the probe is off.
 */

interface ProbeBag {
  enabled?: boolean;
  consolidations?: unknown[];
  renderLayers?: unknown[];
  tilePrepare?: unknown[];
  decode?: unknown[];
  requests?: unknown[];
  evict?: unknown[];
  scrub?: unknown[];
  snapshots?: Record<string, unknown>;
  [k: string]: unknown;
}

const MAX_SAMPLES = 4096;
/**
 * Trim in batches, never one `shift()` per sample: once a channel is full a
 * per-sample shift copies ~4k slots on EVERY sample (measured 90 µs/decode,
 * ~18 ms/s at 200 decodes/s — a probe that changes what it measures, and only
 * after the 4,096th sample, so a long probe-on run is non-stationary). The
 * layers shim already trims a quarter buffer at a time; this is the same rule.
 */
const SAMPLE_TRIM_BATCH = MAX_SAMPLES / 4;
/**
 * The decode-wait roll-up only needs a RECENT window (the pool controller reads
 * a p50/p95 of the last few hundred decodes, not of the session), so the ring
 * is kept far smaller than a sample channel: the per-roll-up sort is over 512
 * values, not 4,096, and the batched trim copies 128 slots, not 1,024.
 */
const DECODE_WAIT_WINDOW = 512;
const DECODE_WAIT_TRIM_BATCH = DECODE_WAIT_WINDOW / 4;

export type CoreProbeChannel =
  | 'decode'
  | 'tilePrepare'
  | 'requests'
  | 'evict'
  | 'scrub';

/**
 * The eviction tiers of `SpatioTemporalTileset.evictUnusedTiles`:
 *
 *   a — non-coverage tiles (stale viewports/zooms) evicted LRU. Also the tier
 *       reported for the under-limit grace-timer sweep and for the plain-LRU
 *       fallback used when there is no coverage index / no playhead.
 *   b — coverage tiles far BEHIND the playhead (back buffer).
 *   c — coverage tiles far AHEAD (distant speculation).
 *   d — the near-playhead protected window (last resort).
 *
 * c and d are the "runway" tiers — the fetch-evict-refetch thrash signal.
 */
export type EvictionTier = 'a' | 'b' | 'c' | 'd';

/**
 * One sample on the `requests` channel: the life of a single scheduled range
 * request, from enqueue to settle.
 *
 * `dispatchedAt === 0` means the request was CANCELLED while still queued (a
 * superseded viewport, a negative-priority drop): it never occupied a slot and
 * moved no bytes. Consumers counting fetches must filter those out; consumers
 * counting supersession want exactly them.
 *
 * Timestamps are `performance.now()`-domain (see {@link probeNow}) — the same
 * clock the playback governor stamps its scrub window with, so the two
 * channels can be windowed against each other.
 */
export interface RequestProbeSample {
  /** Caller-supplied label. For a coalesced tile group: the LEAD tile's key. */
  key: string;
  /** Priority at dispatch (lower = more urgent); 0 for never-dispatched. */
  priority: number;
  /** Byte length of the range this request covers (0 when unknown). */
  bytes: number;
  enqueuedAt: number;
  /** 0 ⇒ never dispatched (cancelled while queued). */
  dispatchedAt: number;
  completedAt: number;
  /** The scheduler `sourceId` (the archive URL for tile fetches). */
  source: string;
}

/** One sample on the `evict` channel. */
export interface EvictProbeSample {
  /** The evicted tile's key (the OPFS-contract tileKey string). */
  key: string;
  tier: EvictionTier;
  /** Bytes actually released (0 for an in-flight header with no payload yet). */
  bytes: number;
  /** Playhead at the eviction, sim-ms; null when the tileset has no viewport. */
  playheadMs: number | null;
}

/**
 * Snapshot key for the viewport/play-head trajectory.
 *
 * NOT a free choice: `tools/bench/src/policy-record.mjs` looks this exact
 * string up in `__sttProbe.snapshots` (with `'playback.state'` as its fallback)
 * and exits 3 when neither is present. Changing it silently disarms the
 * recorder.
 */
export const VIEWPORT_SNAPSHOT = 'tileset.viewport';

/**
 * One trajectory sample: where the camera and the play-head were, published as
 * a LATEST-VALUE snapshot (not a channel) because a replay samples the
 * trajectory on its own cadence — a per-update ring would just be a
 * higher-resolution copy of the same walk, at 4096× the memory.
 *
 * FIELD NAMES ARE THE CONSUMER CONTRACT. `policy-record.mjs` reads
 * `playheadMs` / `timeWindowMs` / `zoom` / `bounds` / `direction` / `animating`
 * and `policy-replay.mjs`'s `buildSteps` consumes the result; a rename here
 * degrades a trace to defaults without erroring anywhere.
 *
 * `bounds` is the ARRAY form `[west, south, east, north]` — the recorder's
 * object branch reads `{west, south, east, north}`, which a core
 * `BoundingBox` (`minLon`/`minLat`/…) does not have, so the array is the only
 * lossless handoff.
 */
export interface ViewportProbeSnapshot {
  /** `[west, south, east, north]`, AFTER `geo/viewport-bounds.ts`'s repair. */
  bounds: [number, number, number, number];
  /** The primary display zoom the tileset selected at (not the camera float). */
  zoom: number;
  /** Play-head, sim-ms. */
  playheadMs: number;
  /** Time window width, sim-ms. */
  timeWindowMs: number;
  /** Committed prefetch direction: +1 forward, -1 backward. */
  direction: 1 | -1;
  /** True while the clock is advancing (drives the replay's eviction grace). */
  animating: boolean;
  /**
   * Camera tilt/heading, when the producer has them. The tileset does NOT:
   * it is handed a bounds box that already absorbed pitch and bearing (see
   * `geo/viewport-bounds.ts` — the 2026-07-26 fix moved that derivation to the
   * backends, deliberately, so core never re-does camera math). Left optional
   * so a backend-side publisher can add them without a shape change.
   */
  pitch?: number;
  bearing?: number;
}

/** The `decodeQueue` snapshot payload (see {@link recordDecodeWait}). */
export interface DecodeQueueSnapshot {
  p50WaitMs: number;
  p95WaitMs: number;
  /** Decodes queued on the host and not yet dispatched to a worker. */
  pending: number;
}

function getBag(): ProbeBag | undefined {
  return (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
}

/**
 * True when a probe bag is installed and not explicitly disabled.
 *
 * Same single-property-read guard `emit`/`snapshot` apply internally, exposed
 * so a call site can skip BUILDING a payload object when the probe is off.
 * Never branch behavior on this — it is an observation gate only.
 */
export function isProbeEnabled(): boolean {
  const bag = getBag();
  return bag !== undefined && bag.enabled !== false;
}

/**
 * Monotonic-ish probe timestamp: `performance.now()` where available (browsers,
 * vitest), `Date.now()` otherwise. Only ever called behind an
 * {@link isProbeEnabled} gate, so production pays nothing.
 */
export function probeNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Record one sample to `__sttProbe[channel]`. No-op when probe is unset. */
export function emit<T>(channel: CoreProbeChannel, payload: T): void {
  const bag = getBag();
  if (!bag || bag.enabled === false) return;
  let arr = bag[channel] as unknown[] | undefined;
  if (!arr) {
    arr = [];
    bag[channel] = arr;
  }
  arr.push(payload);
  if (arr.length > MAX_SAMPLES) arr.splice(0, SAMPLE_TRIM_BATCH);
}

/** Publish a latest-value snapshot under `name`. No-op when probe is unset. */
export function snapshot<T>(name: string, value: T): void {
  const bag = getBag();
  if (!bag || bag.enabled === false) return;
  let snaps = bag.snapshots;
  if (!snaps) {
    snaps = {};
    bag.snapshots = snaps;
  }
  snaps[name] = value;
}

/**
 * Key the decode-wait ring lives under ON THE BAG (not in module scope) so
 * that clearing `globalThis.__sttProbe` resets the roll-up too — and so that a
 * probe-off process never allocates the ring at all.
 */
const DECODE_WAIT_RING = '__decodeWaitRing';

/**
 * Republish the `decodeQueue` roll-up at most this often (in samples) once the
 * ring has warmed up. Percentiles need a sort; at a few hundred decodes a
 * second an unthrottled sort of a 4096-sample ring would itself show up in the
 * probe-on frame budget (and P0-2's acceptance is "probe on vs off within
 * run-to-run noise"). Below this many samples we publish every time so a short
 * harness run still sees a snapshot.
 */
const DECODE_ROLLUP_EVERY = 16;

interface DecodeWaitRing {
  waits: number[];
  /** Samples recorded since the last published roll-up. */
  since: number;
}

/**
 * Record one decode QUEUE WAIT (host enqueue → worker dispatch, ms) and
 * republish the `decodeQueue` snapshot.
 *
 * This is a ROLL-UP of information the `decode` channel already carries per
 * sample — §10.2's pool-size adaptation wants a cheap read, not a re-scan.
 * No-op (single property read) when the probe is off.
 *
 * @param waitMs   host enqueue → worker dispatch, in ms
 * @param pending  decodes still queued on the host at dispatch time
 */
export function recordDecodeWait(waitMs: number, pending: number): void {
  const bag = getBag();
  if (!bag || bag.enabled === false) return;
  let ring = bag[DECODE_WAIT_RING] as DecodeWaitRing | undefined;
  if (!ring) {
    ring = { waits: [], since: 0 };
    bag[DECODE_WAIT_RING] = ring;
  }
  const waits = ring.waits;
  waits.push(waitMs >= 0 ? waitMs : 0);
  if (waits.length > DECODE_WAIT_WINDOW)
    waits.splice(0, DECODE_WAIT_TRIM_BATCH);
  ring.since++;
  if (waits.length >= DECODE_ROLLUP_EVERY && ring.since < DECODE_ROLLUP_EVERY) {
    return;
  }
  ring.since = 0;
  snapshot<DecodeQueueSnapshot>('decodeQueue', {
    p50WaitMs: percentile(waits, 0.5),
    p95WaitMs: percentile(waits, 0.95),
    pending,
  });
}

/**
 * Publish the viewport/play-head trajectory sample (see
 * {@link ViewportProbeSnapshot}). OBSERVATION ONLY — nothing downstream of a
 * call to this may change what is selected, fetched, or evicted.
 *
 * The gate lives HERE, not at the call site, so the `bounds` array is never
 * built when the probe is off: probe-off remains one property read and ZERO
 * allocations, which is the condition for leaving the call in `update()` (a
 * per-tick path). `bounds` is taken as the caller's existing box object and
 * read field-by-field for the same reason — the caller allocates nothing.
 */
export function recordViewport(
  bounds: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  },
  zoom: number,
  playheadMs: number,
  timeWindowMs: number,
  direction: 1 | -1,
  animating: boolean,
): void {
  const bag = getBag();
  if (!bag || bag.enabled === false) return;
  snapshot<ViewportProbeSnapshot>(VIEWPORT_SNAPSHOT, {
    bounds: [bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat],
    zoom,
    playheadMs,
    timeWindowMs,
    direction,
    animating,
  });
}

/**
 * Nearest-rank percentile over an unsorted sample array. Deterministic (a
 * total order on numbers, no interpolation), and never mutates the input.
 */
function percentile(values: number[], p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(n - 1, Math.max(0, Math.floor(p * n)));
  return sorted[idx];
}
