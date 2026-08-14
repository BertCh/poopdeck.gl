#!/usr/bin/env node
/**
 * Deterministic client-policy trace-replay harness  (plan item P0-3).
 *
 * ── FIDELITY BOUNDARY — READ THIS BEFORE QUOTING ANY NUMBER ────────────────
 * This replayer models **policy decisions only**: which tiles a recorded
 * trajectory demands, what the prefetch horizon speculates on, what stays
 * resident, which key the eviction policy drops first, and how long a tile
 * waits for a decode slot.
 *
 * It does **NOT** model GPU or render feedback. No frame pacing, no draw
 * calls, no buffer uploads, no rasterisation, no compositor. Anything
 * render-coupled stays with `frame-cost.mjs`, which measures it in a real
 * browser. A number out of this harness is a statement about what the policy
 * DECIDED — never about what the screen DID.
 *
 * It also does not model transport: fetches complete instantly on the mock
 * clock. That is deliberate. Transport noise is exactly what makes a live
 * policy A/B unreadable, and removing it is the whole point of replaying
 * offline. Latency-sensitive claims belong to `cold-start.mjs`.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * WHY IT EXISTS. Phase 1 of the optimization program changes policies —
 * prefetch horizon feasibility, byte-metered DRR, loop-aware eviction, decode
 * priority. Live QoE runs are browser sessions against a real network, so a
 * policy A/B drowns in transport noise; cold-start stops at first frame and
 * never exercises playback policy at all. This harness closes that gap:
 * **record on the composite routes, replay against policy variants
 * deterministically.**
 *
 * DETERMINISM IS THE CONTRACT. Same trace + same variant ⇒ byte-identical
 * JSON report. Every reported figure is an integer; there is no wall clock,
 * no RNG, no arrival-order or Map-iteration dependence in any output-affecting
 * path. Sorts carry total tiebreaks. This is what makes the harness usable as
 * the arbiter for the program's "named QoE metrics move" claims.
 *
 * COST IS ALWAYS BLENDED. Every cost this harness reports is
 * `bytes + g·reads`, with `g` (`--read-cost-bytes`) defaulting to the
 * shipping range-coalescing gap — the reader's own standing estimate of what
 * one extra request is worth in bytes (`DEFAULT_RANGE_COALESCE_GAP`,
 * packages/core/src/archive.ts). Request count is reported as a *counter* and
 * is never a cost or a ranking key on its own: ranking by request count is a
 * standing rejection in the do-not-touch register (the 669 MiB "2 reads =
 * cheapest" incident).
 *
 * The replayed queries are the *recorded client trajectory*, so the rejected
 * whole-map-instant surrogate workload cannot sneak back in through the side
 * door, and byte sizes come from the trace or from the archive **directory**
 * — measured entries, never an analytic size model.
 *
 * Usage:
 *   node src/policy-replay.mjs <trace.jsonl> [--archive <path-or-url>]
 *                              [--variant <name>] [--all] [--json]
 *                              [--read-cost-bytes N] [--horizon N]
 *                              [--max-tiles N] [--max-bytes N]
 *   node src/policy-replay.mjs --list-variants
 *
 * The committed micro-trace lives at `test/fixtures/micro-loop-boundary.jsonl`
 * and is the unit/determinism substrate; recorded traces land in
 * `out/traces/` via `policy-record.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ───────────────────────────────────────────────────────────── constants ──

/** Trace schema version. Bump on any incompatible record change. */
export const TRACE_VERSION = 1;

/** Report schema version. Bump when a reported field changes meaning. */
export const HARNESS_VERSION = 1;

/**
 * `g` in `bytes + g·reads`: what one extra HTTP request is worth, in bytes.
 *
 * Not invented here. 2 MiB is `DEFAULT_RANGE_COALESCE_GAP` in
 * packages/core/src/archive.ts — the reader already fuses two needed ranges
 * across up to that many unneeded bytes rather than pay for a second request,
 * which is precisely the statement "one read ≈ 2 MiB". Reusing it keeps the
 * harness's cost model and the shipping coalescer from disagreeing.
 * Override with `--read-cost-bytes` to test sensitivity.
 */
export const DEFAULT_READ_COST_BYTES = 2 * 1024 * 1024;

/** Config defaults, used when a trace header omits a field. */
export const DEFAULT_CONFIG = Object.freeze({
  temporalBucketMs: 1000,
  prefetchHorizonBuckets: 2,
  maxResidentTiles: 6,
  maxResidentBytes: 1_000_000_000,
  decodePoolSize: 2,
  /** Fallback decode rate when a trace carries no `decode` sample for a key. */
  decodeBytesPerMs: 2000,
  /** Playback loop extent; `loopEndMs <= loopStartMs` means "no loop". */
  loopStartMs: 0,
  loopEndMs: 0,
});

/**
 * Grace periods ported verbatim from `evictUnusedTiles`
 * (packages/core/src/spatiotemporal-tileset.ts): 120 s while animating, 30 s
 * while paused. Measured here on the mock clock, not the wall clock.
 */
const GRACE_ANIMATING_MS = 120_000;
const GRACE_PAUSED_MS = 30_000;

/** Channels this harness understands. `requests|evict|scrub|decode|playback` */
export const TRACE_CHANNELS = Object.freeze([
  'header',
  'viewport',
  'demand',
  'requests',
  'decode',
  'evict',
  'scrub',
  'playback',
]);

// ─────────────────────────────────────────────────── canonical JSON ──────

/**
 * Keys hoisted to the front of every object so a canonical line stays
 * human-readable. Everything else sorts lexicographically. Both halves are
 * total orders, so the output is a pure function of the value.
 */
const KEY_PRIORITY = [
  'ch',
  'tMs',
  'harness',
  'harnessVersion',
  'traceVersion',
  'variant',
  'route',
  'key',
];

function keyRank(k) {
  const i = KEY_PRIORITY.indexOf(k);
  return i < 0 ? KEY_PRIORITY.length : i;
}

/**
 * Stable stringify: object keys in canonical order at every depth, no
 * incidental whitespace. Two structurally equal values always produce
 * byte-identical text — which is what the determinism test asserts.
 *
 * Rejects non-finite numbers outright: an `Infinity` or `NaN` reaching the
 * report would serialize as `null` and silently destroy a comparison.
 */
export function canonicalJson(value, indent = 0, depth = 0) {
  const pad = indent ? '\n' + ' '.repeat(indent * (depth + 1)) : '';
  const padEnd = indent ? '\n' + ' '.repeat(indent * depth) : '';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number (${value})`);
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'undefined') return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const parts = value.map((v) => canonicalJson(v, indent, depth + 1));
    return `[${pad}${parts.join(`,${pad || ''}`)}${padEnd}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort((a, b) => keyRank(a) - keyRank(b) || (a < b ? -1 : a > b ? 1 : 0));
    if (keys.length === 0) return '{}';
    const parts = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${indent ? ' ' : ''}${canonicalJson(value[k], indent, depth + 1)}`,
    );
    return `{${pad}${parts.join(`,${pad || ''}`)}${padEnd}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}

/**
 * FNV-1a 64-bit over a UTF-8 string, hex. Same hash family the archive uses
 * for ids, so nobody has to learn a second one. Used only to fingerprint a
 * trace in the report — identical traces get identical digests, which is how
 * a reader tells two reports are comparable.
 */
export function fnv1a64Hex(text) {
  const bytes = new TextEncoder().encode(text);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

// ───────────────────────────────────────────────────────── mock clock ──────

/**
 * Integer-millisecond monotonic clock. The only source of "time" in the
 * replay — `Date.now()` and `performance.now()` are never called, because a
 * wall clock in an output-affecting path would break the byte-identical
 * contract on the first slow machine.
 */
export class MockClock {
  #now;

  constructor(startMs = 0) {
    if (!Number.isSafeInteger(startMs)) {
      throw new Error(`MockClock: startMs must be an integer, got ${startMs}`);
    }
    this.#now = startMs;
  }

  /** Current simulated time, integer ms. */
  get nowMs() {
    return this.#now;
  }

  /** Advance to an absolute instant. Never goes backwards. */
  advanceTo(ms) {
    if (!Number.isSafeInteger(ms)) {
      throw new Error(`MockClock: advanceTo needs an integer, got ${ms}`);
    }
    if (ms < this.#now) {
      throw new Error(
        `MockClock: refusing to move backwards (${this.#now} → ${ms})`,
      );
    }
    this.#now = ms;
    return this.#now;
  }

  /** Advance by a non-negative delta. */
  advanceBy(deltaMs) {
    if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
      throw new Error(
        `MockClock: advanceBy needs a non-negative integer, got ${deltaMs}`,
      );
    }
    this.#now += deltaMs;
    return this.#now;
  }
}

// ───────────────────────────────────────────────────────── trace I/O ──────

/**
 * Parse a JSON-lines trace.
 *
 * Line 1 must be the `header` record: it carries the schema version and the
 * replay config, and a trace without it is a trace whose provenance nobody
 * can check. Blank lines are tolerated (editors add them); anything else is
 * an error rather than a silent skip — a malformed trace that replays anyway
 * is how a bogus baseline gets pinned.
 */
export function parseTrace(text) {
  const lines = String(text).split('\n');
  const events = [];
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      throw new Error(`trace line ${i + 1}: not JSON (${err.message})`);
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new Error(`trace line ${i + 1}: record must be an object`);
    }
    if (typeof rec.ch !== 'string') {
      throw new Error(`trace line ${i + 1}: missing string field "ch"`);
    }
    if (!TRACE_CHANNELS.includes(rec.ch)) {
      throw new Error(`trace line ${i + 1}: unknown channel "${rec.ch}"`);
    }
    if (rec.ch === 'header') {
      if (header) throw new Error(`trace line ${i + 1}: second header record`);
      if (events.length) {
        throw new Error(`trace line ${i + 1}: header must be the first record`);
      }
      header = rec;
      continue;
    }
    events.push(rec);
  }
  if (!header) throw new Error('trace has no header record');
  if (header.traceVersion !== TRACE_VERSION) {
    throw new Error(
      `trace version ${header.traceVersion} != harness ${TRACE_VERSION}`,
    );
  }
  return { header, events };
}

/** Inverse of {@link parseTrace}. Canonical, so round-trips are byte-stable. */
export function serializeTrace(trace) {
  const lines = [canonicalJson(trace.header)];
  for (const e of trace.events) lines.push(canonicalJson(e));
  return lines.join('\n') + '\n';
}

/** Merge a trace header's config over the defaults, then over CLI overrides. */
export function resolveConfig(header, overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...header?.config };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null) cfg[k] = v;
  }
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (!Number.isFinite(cfg[k])) {
      throw new Error(`config.${k} must be a finite number, got ${cfg[k]}`);
    }
  }
  return cfg;
}

// ──────────────────────────────────────────────────── tile-key parsing ──────

/**
 * Parse the leading `z/x/y/t#variant[@bucket]` half of a tile key.
 *
 * Deliberately a *reader* of the format, never a writer: `tileKey()` in
 * packages/core is the only place that spelling is produced, and it is an
 * OPFS persistence contract. This harness parses and never re-spells.
 */
export function parseKey(key) {
  const sep = key.indexOf(':');
  const head = sep >= 0 ? key.slice(0, sep) : key;
  const at = head.indexOf('@');
  const beforeBucket = at >= 0 ? head.slice(0, at) : head;
  const hash = beforeBucket.indexOf('#');
  const coords = hash >= 0 ? beforeBucket.slice(0, hash) : beforeBucket;
  const variantId = hash >= 0 ? Number(beforeBucket.slice(hash + 1)) : 0;
  const parts = coords.split('/');
  if (parts.length !== 4) return undefined;
  const [z, x, y, t] = parts.map(Number);
  if (![z, x, y, t, variantId].every((n) => Number.isFinite(n)))
    return undefined;
  const bucketMs = at >= 0 ? Number(head.slice(at + 1)) : undefined;
  return { z, x, y, t, variantId, bucketMs };
}

/** Web-Mercator slippy-tile x for a longitude. */
export function lonToTileX(lon, z) {
  const n = 2 ** z;
  return Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
}

/** Web-Mercator slippy-tile y for a latitude. */
export function latToTileY(lat, z) {
  const n = 2 ** z;
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat));
  const r = (clamped * Math.PI) / 180;
  const yy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return Math.min(n - 1, Math.max(0, Math.floor(yy)));
}

// ─────────────────────────────────────────────────────────── universe ──────

/**
 * The addressable tile set, with a measured byte size per key.
 *
 * Two sources, in order of preference:
 *  1. `--archive` — the archive **directory** (`getTileByteSize`), i.e. the
 *     M5 cost oracle itself: real entry lengths, never a size model.
 *  2. the trace — byte sizes the recorder observed on the `requests` /
 *     `decode` / `evict` channels.
 *
 * First occurrence wins on a byte-size conflict, and the conflict is counted
 * and reported rather than averaged away.
 */
export function buildUniverseFromTrace(events) {
  const universe = new Map();
  let conflicts = 0;
  for (const e of events) {
    const key = e.key;
    if (typeof key !== 'string') continue;
    const bytes = Number.isFinite(e.bytes) ? Math.round(e.bytes) : undefined;
    const existing = universe.get(key);
    if (existing) {
      if (bytes !== undefined && existing.bytes !== bytes) conflicts++;
      continue;
    }
    const id = parseKey(key);
    if (!id) continue;
    universe.set(key, { key, ...id, bytes: bytes ?? 0 });
  }
  return { universe, conflicts };
}

// ─────────────────────────────────────────────────── demand derivation ──────

/**
 * Steps are the recorded trajectory: one `viewport` record each. Demand and
 * lookahead are derived from the trajectory and the addressable set ALONE —
 * never from what the recorded policy happened to fetch. That independence is
 * the whole reason a variant comparison means anything: a policy that keeps
 * more resident must be credited with the hit, not penalised for the absence
 * of a recorded request.
 */
export function buildSteps(events, config, universe) {
  const explicitDemand = new Map();
  for (const e of events) {
    if (e.ch === 'demand' && Number.isFinite(e.tMs)) {
      explicitDemand.set(e.tMs, e);
    }
  }

  const steps = [];
  for (const e of events) {
    if (e.ch !== 'viewport') continue;
    if (!Number.isFinite(e.tMs)) {
      throw new Error(
        `viewport record needs an integer tMs: ${JSON.stringify(e)}`,
      );
    }
    const bucketMs = config.temporalBucketMs;
    const playheadMs = Number.isFinite(e.playheadMs) ? e.playheadMs : 0;
    const step = {
      index: steps.length,
      tMs: Math.round(e.tMs),
      playheadMs: Math.round(playheadMs),
      timeWindowMs: Number.isFinite(e.timeWindowMs)
        ? Math.round(e.timeWindowMs)
        : bucketMs,
      zoom: Number.isFinite(e.zoom) ? Math.round(e.zoom) : 0,
      bounds: Array.isArray(e.bounds) ? e.bounds : undefined,
      timeStartMs: Math.round(playheadMs),
      timeEndMs:
        Math.round(playheadMs) +
        (Number.isFinite(e.timeWindowMs)
          ? Math.round(e.timeWindowMs)
          : bucketMs),
      direction: e.direction === -1 ? -1 : 1,
      animating: e.animating !== false,
      demand: [],
      lookahead: [],
      coverage: new Set(),
    };

    // Coverage index == current viewport at the primary zoom, FULL time range
    // (spatiotemporal-tileset.ts). Keys outside it are the "stale viewport"
    // tier-A candidates.
    const inSpatial = [];
    for (const m of universe.values()) {
      if (m.z !== step.zoom) continue;
      if (step.bounds && !boundsContainTile(step.bounds, m, step.zoom))
        continue;
      inSpatial.push(m);
      step.coverage.add(m.key);
    }
    inSpatial.sort(cmpMeta);

    const explicit = explicitDemand.get(step.tMs);
    if (explicit && Array.isArray(explicit.needed)) {
      step.demand = [...explicit.needed].filter((k) => universe.has(k)).sort();
      step.lookahead = Array.isArray(explicit.lookahead)
        ? [...explicit.lookahead].filter((k) => universe.has(k)).sort()
        : [];
    } else {
      const winStart = step.playheadMs;
      const winEnd = step.playheadMs + step.timeWindowMs;
      for (const m of inSpatial) {
        const tEnd = m.t + bucketMs;
        if (m.t < winEnd && tEnd > winStart) step.demand.push(m.key);
      }
      // Lookahead: the horizon along the committed direction, nearest bucket
      // first. Identical across variants by construction — this harness
      // isolates the EVICTION decision; a horizon change is CO-2's item and
      // lands as its own variant.
      const base = bucketStart(step.playheadMs, bucketMs);
      const byT = new Map();
      for (const m of inSpatial) byT.set(m.t, m.key);
      for (let k = 1; k <= config.prefetchHorizonBuckets; k++) {
        const t = base + step.direction * k * bucketMs;
        const key = byT.get(t);
        if (key && !step.demand.includes(key)) step.lookahead.push(key);
      }
    }
    steps.push(step);
  }
  return steps;
}

function bucketStart(tMs, bucketMs) {
  return Math.floor(tMs / bucketMs) * bucketMs;
}

function boundsContainTile(bounds, meta, zoom) {
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every((n) => Number.isFinite(n))) return true;
  const x0 = lonToTileX(west, zoom);
  const x1 = lonToTileX(east, zoom);
  const y0 = latToTileY(north, zoom);
  const y1 = latToTileY(south, zoom);
  return (
    meta.x >= Math.min(x0, x1) &&
    meta.x <= Math.max(x0, x1) &&
    meta.y >= Math.min(y0, y1) &&
    meta.y <= Math.max(y0, y1)
  );
}

/** Total order on tile metas: (t, z, x, y, key). No ties survive. */
function cmpMeta(a, b) {
  return (
    a.t - b.t ||
    a.z - b.z ||
    a.x - b.x ||
    a.y - b.y ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** Total tiebreak for eviction ranking. Never returns 0 for distinct keys. */
function cmpTiebreak(a, b) {
  return a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ───────────────────────────────────────────────────── policy variants ──────

function tagged(list, tier) {
  return list.map((c) => ({ key: c.key, tier, metric: c.metric }));
}

/**
 * THE INCUMBENT — a faithful port of `evictUnusedTiles`'s over-limit branch
 * (packages/core/src/spatiotemporal-tileset.ts). Playhead-relative, coverage-
 * protected, four tiers:
 *   A  non-coverage (stale viewports/zooms)         LRU, oldest first
 *   B  coverage, far behind the playhead            furthest behind first
 *   C  coverage, far ahead (distant speculation)    furthest ahead first
 *   D  the near-playhead protected window           LRU, last resort
 * `runwayFrom = |A| + |B|`: anything past that prefix reached into protected
 * content and increments `runwayEvictions` — the fetch-evict-refetch signal.
 *
 * Distances are LINEAR along the committed direction. At a playback loop
 * boundary that is exactly wrong: the buckets nearest in loop order are the
 * ones ranked "furthest behind", so they are dropped last-thing-before and
 * refetched first-thing-after. That is the §9.4 inverse-of-Belady pathology,
 * and the committed micro-trace pins it.
 */
function planIncumbent(ctx) {
  const { candidates, step, config } = ctx;
  const bucketMs = config.temporalBucketMs;
  const direction = step.direction;
  const playhead = step.playheadMs;
  const timeWindow = step.timeWindowMs || bucketMs;
  const keepBehind = Math.max(timeWindow, bucketMs);
  const protectedAhead = Math.max(timeWindow, 2 * bucketMs);

  const A = [];
  const B = [];
  const C = [];
  const D = [];
  for (const c of candidates) {
    if (!step.coverage.has(c.key) || !Number.isFinite(c.t)) {
      A.push({ ...c, metric: c.lastUsedMs });
      continue;
    }
    const behind = direction > 0 ? playhead - (c.t + bucketMs) : c.t - playhead;
    const ahead = direction > 0 ? c.t - playhead : playhead - (c.t + bucketMs);
    if (behind > keepBehind) B.push({ ...c, metric: behind });
    else if (ahead > protectedAhead) C.push({ ...c, metric: ahead });
    else D.push({ ...c, metric: c.lastUsedMs });
  }
  A.sort((a, b) => a.metric - b.metric || cmpTiebreak(a, b));
  B.sort((a, b) => b.metric - a.metric || cmpTiebreak(a, b));
  C.sort((a, b) => b.metric - a.metric || cmpTiebreak(a, b));
  D.sort((a, b) => a.metric - b.metric || cmpTiebreak(a, b));

  return {
    order: [
      ...tagged(A, 'a'),
      ...tagged(B, 'b'),
      ...tagged(C, 'c'),
      ...tagged(D, 'd'),
    ],
    runwayFrom: A.length + B.length,
  };
}

/**
 * PLAIN LRU — the control, and the incumbent's own documented fallback: the
 * `!coverageKeys || playhead === undefined` branch of the same function,
 * where "nothing counts as a runway eviction" (`runwayFrom = plan.length`).
 * Kept so a tiering claim can be stated against the thing tiering replaced.
 */
function planLru(ctx) {
  const order = [...ctx.candidates]
    .map((c) => ({ ...c, metric: c.lastUsedMs }))
    .sort((a, b) => a.metric - b.metric || cmpTiebreak(a, b));
  return { order: tagged(order, 'a'), runwayFrom: order.length };
}

/**
 * LOOP-AWARE — a REFERENCE MODEL, not a shipping policy.
 *
 * Measures distance circularly over `[loopStartMs, loopEndMs)` instead of
 * linearly, so the bucket one step past the loop wrap is "near" rather than
 * "furthest behind". Exists here to give the micro-trace a demonstrable
 * upper bound for the loop pathology; the shipping rotation is its own work
 * item and this file has no authority over its design. With no loop declared
 * in the trace header it degrades to the incumbent, unchanged.
 */
function planLoopAware(ctx) {
  const { candidates, step, config } = ctx;
  const period = config.loopEndMs - config.loopStartMs;
  if (!(period > 0)) return planIncumbent(ctx);

  const bucketMs = config.temporalBucketMs;
  const timeWindow = step.timeWindowMs || bucketMs;
  const protectedAhead = Math.max(timeWindow, 2 * bucketMs);
  const playhead = step.playheadMs;

  const A = [];
  const C = [];
  const D = [];
  for (const c of candidates) {
    if (!step.coverage.has(c.key) || !Number.isFinite(c.t)) {
      A.push({ ...c, metric: c.lastUsedMs });
      continue;
    }
    const raw =
      step.direction > 0 ? c.t - playhead : playhead - (c.t + bucketMs);
    const fwd = (((raw - config.loopStartMs) % period) + period) % period;
    if (fwd > protectedAhead) C.push({ ...c, metric: fwd });
    else D.push({ ...c, metric: c.lastUsedMs });
  }
  A.sort((a, b) => a.metric - b.metric || cmpTiebreak(a, b));
  C.sort((a, b) => b.metric - a.metric || cmpTiebreak(a, b));
  D.sort((a, b) => a.metric - b.metric || cmpTiebreak(a, b));

  return {
    order: [...tagged(A, 'a'), ...tagged(C, 'c'), ...tagged(D, 'd')],
    runwayFrom: A.length + C.length,
  };
}

/**
 * BELADY — the offline optimum, and an ORACLE ONLY. It reads the future of
 * the recorded trajectory, so it can never ship; it is here to bound the gap
 * a real policy is allowed to claim. Evicts the candidate whose next
 * reference (demand or lookahead) is furthest away, ∞ first.
 *
 * `runwayFrom` = the count of never-referenced-again candidates: dropping
 * those is free, so only evictions past that prefix reach into future demand.
 */
function planBelady(ctx) {
  const { candidates, nextRef } = ctx;
  const ranked = candidates
    .map((c) => ({
      ...c,
      metric: nextRef.get(c.key) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => b.metric - a.metric || cmpTiebreak(a, b));
  const free = ranked.filter(
    (c) => c.metric === Number.MAX_SAFE_INTEGER,
  ).length;
  return { order: tagged(ranked, 'o'), runwayFrom: free };
}

/**
 * The variant registry.
 *
 * Every variant here changes ONE thing: eviction order. None of them
 * re-litigates a standing rejection — no request-count ranking, no analytic
 * size model, no silent thinning, no change to the aggregate-rate recovery
 * formula or the two-threshold gating shape. A Phase 1 item that changes a
 * policy registers its own variant here and pins its before/after against
 * `incumbent`.
 */
export const VARIANTS = new Map([
  [
    'incumbent',
    {
      name: 'incumbent',
      tiers: ['a', 'b', 'c', 'd'],
      description:
        'Shipping playhead-relative tiered eviction (linear distances).',
      plan: planIncumbent,
    },
  ],
  [
    'lru',
    {
      name: 'lru',
      tiers: ['a'],
      description: "Plain LRU — the tileset's own no-coverage fallback branch.",
      plan: planLru,
    },
  ],
  [
    'loop-aware',
    {
      name: 'loop-aware',
      tiers: ['a', 'c', 'd'],
      description:
        'Reference model: circular playhead distance over the declared loop.',
      plan: planLoopAware,
    },
  ],
  [
    'belady',
    {
      name: 'belady',
      tiers: ['o'],
      description:
        'Offline optimum (reads the future). An unshippable lower bound.',
      plan: planBelady,
    },
  ],
]);

// ──────────────────────────────────────────────────────── cost model ──────

/**
 * The ONLY cost this harness reports: `bytes + g·reads`.
 *
 * Request count alone is not a cost and is never a ranking key — the
 * do-not-touch register records why (a "2 reads = cheapest" ranking once
 * selected a 669 MiB answer). `reads` is still reported, as a counter beside
 * the bytes it cost.
 */
export function blendedCost({ bytesFetched, reads, readCostBytes }) {
  for (const [n, v] of Object.entries({ bytesFetched, reads, readCostBytes })) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new Error(
        `blendedCost: ${n} must be a non-negative integer (${v})`,
      );
    }
  }
  return {
    model: 'bytes + g*reads',
    readCostBytes,
    bytesFetched,
    reads,
    value: bytesFetched + readCostBytes * reads,
  };
}

// ───────────────────────────────────────────────── the decode queue ──────

/**
 * A deterministic discrete-event decode pool. `decodePoolSize` workers, each
 * with a "free at" instant; an arrival takes the earliest-free worker (lowest
 * index breaks the tie) and waits `max(0, freeAt - arrival)`.
 *
 * FIDELITY: arrival order only — demand misses are offered before prefetch
 * misses within a step, which is the priority ordering the tileset already
 * has. It does NOT model preemption or mid-queue re-prioritisation; a decode
 * *priority* policy is a separate work item and would register as a variant.
 */
class DecodeQueue {
  constructor(poolSize) {
    this.free = new Array(Math.max(1, Math.round(poolSize))).fill(0);
    this.waits = [];
    this.bytes = 0;
    this.count = 0;
  }

  enqueue(arrivalMs, decodeMs, bytes) {
    let best = 0;
    for (let i = 1; i < this.free.length; i++) {
      if (this.free[i] < this.free[best]) best = i;
    }
    const start = Math.max(arrivalMs, this.free[best]);
    const wait = start - arrivalMs;
    this.free[best] = start + decodeMs;
    this.waits.push(wait);
    this.bytes += bytes;
    this.count++;
    return wait;
  }

  stats() {
    const s = [...this.waits].sort((a, b) => a - b);
    const q = (p) =>
      s.length === 0
        ? 0
        : s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
    return {
      queued: this.count,
      bytesDecoded: this.bytes,
      pool: this.free.length,
      p50WaitMs: q(0.5),
      p95WaitMs: q(0.95),
      maxWaitMs: s.length ? s[s.length - 1] : 0,
      totalWaitMs: s.reduce((a, b) => a + b, 0),
    };
  }
}

// ──────────────────────────────────────────────────────────── replay ──────

/**
 * Replay one trace against one policy variant.
 *
 * Returns a plain object of integers; `formatReport` turns it into the
 * byte-stable JSON the determinism test pins.
 */
export function replay(trace, options = {}) {
  const variantName = options.variant ?? 'incumbent';
  const variant = VARIANTS.get(variantName);
  if (!variant) {
    throw new Error(
      `unknown variant "${variantName}" (have: ${[...VARIANTS.keys()].join(', ')})`,
    );
  }
  const readCostBytes = Number.isFinite(options.readCostBytes)
    ? Math.round(options.readCostBytes)
    : DEFAULT_READ_COST_BYTES;
  const config = resolveConfig(trace.header, options.config ?? {});

  const fromTrace = buildUniverseFromTrace(trace.events);
  const universe = options.universe ?? fromTrace.universe;
  const universeSource = options.universe ? 'archive' : 'trace';

  // Recorded decode durations, keyed by tile. Absent ⇒ derived from bytes at
  // `decodeBytesPerMs` — a stated, uniform fallback, not a fitted model.
  const recordedDecodeMs = new Map();
  for (const e of trace.events) {
    if (e.ch === 'decode' && typeof e.key === 'string') {
      const ms = Number.isFinite(e.decodeMs)
        ? Math.max(0, Math.round(e.decodeMs))
        : undefined;
      if (ms !== undefined && !recordedDecodeMs.has(e.key)) {
        recordedDecodeMs.set(e.key, ms);
      }
    }
  }
  const decodeMsFor = (meta) => {
    const rec = recordedDecodeMs.get(meta.key);
    if (rec !== undefined) return rec;
    return Math.max(
      1,
      Math.ceil(meta.bytes / Math.max(1, config.decodeBytesPerMs)),
    );
  };

  const steps = buildSteps(trace.events, config, universe);

  // Future-reference table for the Belady oracle. Precomputed from the
  // trajectory, which is policy-independent, so every variant sees the same
  // future — there is no way for a variant to "win" by changing demand.
  const refIndex = new Map();
  for (let i = steps.length - 1; i >= 0; i--) {
    for (const k of [...steps[i].demand, ...steps[i].lookahead]) {
      refIndex.set(k, i);
    }
    steps[i].nextRef = new Map(refIndex);
  }

  const clock = new MockClock(steps.length ? steps[0].tMs : 0);
  const decode = new DecodeQueue(config.decodePoolSize);

  /** key → { bytes, lastUsedMs } */
  const resident = new Map();
  const everEvicted = new Set();
  const fetchCount = new Map();

  const counters = {
    bytesFetched: 0,
    reads: 0,
    priorityReads: 0,
    prefetchReads: 0,
    priorityHits: 0,
    priorityMisses: 0,
    prefetchHits: 0,
    prefetchMisses: 0,
    refetchCycles: 0,
    refetchOnDemand: 0,
    refetchOnPrefetch: 0,
    refetchBytes: 0,
    evictions: 0,
    bytesEvicted: 0,
    runwayEvictions: 0,
    graceEvictions: 0,
    runwayViolations: 0,
    peakTiles: 0,
    peakBytes: 0,
  };
  const byTier = {};
  for (const t of variant.tiers) byTier[t] = 0;
  let residentBytes = 0;
  let minRunwayMs = Number.MAX_SAFE_INTEGER;

  const doFetch = (meta, kind) => {
    counters.reads++;
    counters.bytesFetched += meta.bytes;
    if (kind === 'priority') counters.priorityReads++;
    else counters.prefetchReads++;
    const n = (fetchCount.get(meta.key) ?? 0) + 1;
    fetchCount.set(meta.key, n);
    if (everEvicted.has(meta.key)) {
      counters.refetchCycles++;
      counters.refetchBytes += meta.bytes;
      if (kind === 'priority') counters.refetchOnDemand++;
      else counters.refetchOnPrefetch++;
    }
    resident.set(meta.key, { bytes: meta.bytes, lastUsedMs: clock.nowMs });
    residentBytes += meta.bytes;
    decode.enqueue(clock.nowMs, decodeMsFor(meta), meta.bytes);
  };

  const evictKey = (key, tier, isRunway) => {
    const r = resident.get(key);
    if (!r) return;
    resident.delete(key);
    residentBytes -= r.bytes;
    everEvicted.add(key);
    counters.evictions++;
    counters.bytesEvicted += r.bytes;
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    if (isRunway) counters.runwayEvictions++;
  };

  for (const step of steps) {
    clock.advanceTo(step.tMs);

    // 1. Demand — the priority selection for this viewport + time window.
    for (const key of step.demand) {
      const r = resident.get(key);
      if (r) {
        r.lastUsedMs = clock.nowMs;
        counters.priorityHits++;
      } else {
        counters.priorityMisses++;
        doFetch(universe.get(key), 'priority');
      }
    }
    // 2. Lookahead — speculation, offered after demand (priority ordering).
    for (const key of step.lookahead) {
      const r = resident.get(key);
      if (r) {
        r.lastUsedMs = clock.nowMs;
        counters.prefetchHits++;
      } else {
        counters.prefetchMisses++;
        doFetch(universe.get(key), 'prefetch');
      }
    }

    if (resident.size > counters.peakTiles) counters.peakTiles = resident.size;
    if (residentBytes > counters.peakBytes) counters.peakBytes = residentBytes;

    // 3. Eviction.
    const needed = new Set(step.demand);
    const candidates = [];
    for (const [key, r] of resident) {
      if (needed.has(key)) continue;
      const meta = universe.get(key);
      candidates.push({
        key,
        t: meta ? meta.t : Number.NaN,
        bytes: r.bytes,
        lastUsedMs: r.lastUsedMs,
      });
    }
    candidates.sort(cmpTiebreak);

    const overTiles = resident.size > config.maxResidentTiles;
    const overBytes = residentBytes > config.maxResidentBytes;

    if (!overTiles && !overBytes) {
      // Under limits: only age-out, and coverage tiles are exempt from the
      // wall-clock timer (they are exactly what getBufferedRanges() reports
      // as buffered — timing them out un-buffers time the player was just
      // told is ready). Ported as-is from evictUnusedTiles.
      const grace = step.animating ? GRACE_ANIMATING_MS : GRACE_PAUSED_MS;
      for (const c of candidates) {
        if (step.coverage.has(c.key)) continue;
        if (clock.nowMs - c.lastUsedMs < grace) continue;
        counters.graceEvictions++;
        evictKey(c.key, variant.tiers[0], false);
      }
    } else {
      const { order, runwayFrom } = variant.plan({
        candidates,
        step,
        config,
        nextRef: step.nextRef,
      });
      let tiles = resident.size;
      let bytes = residentBytes;
      for (let i = 0; i < order.length; i++) {
        if (
          tiles <= config.maxResidentTiles &&
          bytes <= config.maxResidentBytes
        ) {
          break;
        }
        const entry = order[i];
        const r = resident.get(entry.key);
        if (!r) continue;
        tiles--;
        bytes -= r.bytes;
        evictKey(entry.key, entry.tier, i >= runwayFrom);
      }
    }

    // 4. Runway: contiguous resident buckets ahead of the playhead, capped by
    // what the archive actually addresses (running off the end of the
    // timeline is not a policy failure and is not counted as one).
    const bucketMs = config.temporalBucketMs;
    const base = bucketStart(step.playheadMs, bucketMs);
    const byT = new Map();
    for (const key of step.coverage) {
      const m = universe.get(key);
      if (m) byT.set(m.t, key);
    }
    let residentBuckets = 0;
    let addressableBuckets = 0;
    for (let k = 0; k <= config.prefetchHorizonBuckets; k++) {
      const key = byT.get(base + step.direction * k * bucketMs);
      if (!key) break;
      addressableBuckets++;
      if (resident.has(key) && residentBuckets === k) residentBuckets++;
    }
    if (residentBuckets < addressableBuckets) counters.runwayViolations++;
    const runwayMs = residentBuckets * bucketMs;
    if (runwayMs < minRunwayMs) minRunwayMs = runwayMs;
  }

  const decodeStats = decode.stats();
  const report = {
    harness: 'policy-replay',
    harnessVersion: HARNESS_VERSION,
    traceVersion: TRACE_VERSION,
    variant: variant.name,
    variantKind: variantName === 'belady' ? 'oracle-bound' : 'policy',
    fidelity:
      'policy decisions only — no GPU/render feedback, no transport latency',
    trace: {
      route:
        typeof trace.header.route === 'string'
          ? trace.header.route
          : '(unknown)',
      digest: fnv1a64Hex(serializeTrace(trace)),
      events: trace.events.length,
      steps: steps.length,
      universeSource,
      universeTiles: universe.size,
      byteSizeConflicts: fromTrace.conflicts,
    },
    params: {
      readCostBytes,
      temporalBucketMs: config.temporalBucketMs,
      prefetchHorizonBuckets: config.prefetchHorizonBuckets,
      maxResidentTiles: config.maxResidentTiles,
      maxResidentBytes: config.maxResidentBytes,
      decodePoolSize: config.decodePoolSize,
      decodeBytesPerMs: config.decodeBytesPerMs,
      loopStartMs: config.loopStartMs,
      loopEndMs: config.loopEndMs,
    },
    cost: blendedCost({
      bytesFetched: counters.bytesFetched,
      reads: counters.reads,
      readCostBytes,
    }),
    requests: {
      reads: counters.reads,
      priorityReads: counters.priorityReads,
      prefetchReads: counters.prefetchReads,
      priorityHits: counters.priorityHits,
      priorityMisses: counters.priorityMisses,
      prefetchHits: counters.prefetchHits,
      prefetchMisses: counters.prefetchMisses,
    },
    refetch: {
      cycles: counters.refetchCycles,
      onDemand: counters.refetchOnDemand,
      onPrefetch: counters.refetchOnPrefetch,
      bytes: counters.refetchBytes,
    },
    eviction: {
      total: counters.evictions,
      byTier,
      runwayEvictions: counters.runwayEvictions,
      graceEvictions: counters.graceEvictions,
      bytesEvicted: counters.bytesEvicted,
    },
    runway: {
      violations: counters.runwayViolations,
      minRunwayMs: minRunwayMs === Number.MAX_SAFE_INTEGER ? 0 : minRunwayMs,
    },
    decode: decodeStats,
    residency: {
      tilesResident: resident.size,
      bytesResident: residentBytes,
      peakTilesResident: counters.peakTiles,
      peakBytesResident: counters.peakBytes,
    },
  };
  report.invariants = checkConservation(report);
  return report;
}

/**
 * Conservation invariants. Every fetched byte is either still resident or was
 * evicted; nothing is decoded that was not fetched. A replay that violates
 * one of these has a bookkeeping bug and its numbers are worthless, so the
 * check ships inside the report rather than only inside the tests.
 */
export function checkConservation(report) {
  const fetched = report.cost.bytesFetched;
  const decoded = report.decode.bytesDecoded;
  const evicted = report.eviction.bytesEvicted;
  const residentBytes = report.residency.bytesResident;
  const checks = [
    { name: 'fetched>=decoded', ok: fetched >= decoded },
    {
      name: 'decoded>=evicted+resident',
      ok: decoded >= evicted + residentBytes,
    },
    {
      name: 'fetched==evicted+resident',
      ok: fetched === evicted + residentBytes,
    },
    {
      name: 'reads==priority+prefetch',
      ok:
        report.requests.reads ===
        report.requests.priorityReads + report.requests.prefetchReads,
    },
    {
      name: 'refetch<=reads',
      ok: report.refetch.cycles <= report.requests.reads,
    },
    {
      name: 'runwayEvictions<=evictions',
      ok: report.eviction.runwayEvictions <= report.eviction.total,
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

/** The byte-stable serialization of a report. This is the pinned artifact. */
export function formatReport(report) {
  return canonicalJson(report, 2) + '\n';
}

// ────────────────────────────────────────────── optional archive oracle ──────

/**
 * Open an archive read-only and expose its DIRECTORY as the universe: real
 * entry byte lengths via `getTileByteSize`, tile ids via `getTileIdsInBounds`.
 * This is the M5 oracle used exactly as intended — measured directory sums,
 * never an analytic size model.
 *
 * Optional by design: with no `--archive` the replay runs off the byte sizes
 * the recorder observed, which is what makes the committed micro-trace a
 * self-contained fixture.
 */
export async function universeFromArchive(spec, steps) {
  const { register } = await import('node:module');
  // `@poopdeck.gl/core`'s dist uses extensionless relative imports, which
  // Node's strict ESM resolver rejects. Same shim the cold-start harness
  // registers; registered lazily so importing this module for its pure
  // functions costs nothing.
  register(new URL('./loader-hook.mjs', import.meta.url));
  const coreEntryUrl = import.meta.resolve('@poopdeck.gl/core');
  const { STTArchive } = await import(coreEntryUrl);

  const remote = /^https?:\/\//.test(spec);
  let url = spec;
  let fetchFn;
  if (remote) {
    url = spec.endsWith('.json')
      ? spec
      : `${spec.replace(/\/$/, '')}/manifest.json`;
  } else {
    // A packed archive is a directory of objects; `STTArchive.url` is the
    // MANIFEST url and every other object resolves relative to it.
    let p = path.resolve(spec);
    if (fs.statSync(p).isDirectory()) p = path.join(p, 'manifest.json');
    url = pathToFileURL(p).href;
    fetchFn = fileRangeFetch;
  }
  const archive = new STTArchive(fetchFn ? { url, fetch: fetchFn } : { url });

  const universe = new Map();
  for (const step of steps) {
    const b = step.bounds ?? [-180, -85.0511, 180, 85.0511];
    const ids = await archive.getTileIdsInBounds(
      { minLon: b[0], minLat: b[1], maxLon: b[2], maxLat: b[3] },
      step.zoom,
      { start: step.timeStartMs, end: step.timeEndMs },
    );
    for (const id of ids) {
      const key = `${id.z}/${id.x}/${id.y}/${id.t}#${id.variantId ?? 0}`;
      if (universe.has(key)) continue;
      universe.set(key, {
        key,
        z: id.z,
        x: id.x,
        y: id.y,
        t: id.t,
        variantId: id.variantId ?? 0,
        // The M5 oracle: a MEASURED directory entry length. Never a model.
        bytes: archive.getTileByteSize(id) ?? 0,
      });
    }
  }
  return universe;
}

/** Range-capable `fetch` over local `file://` objects. Read-only, always. */
async function fileRangeFetch(url, init) {
  const filePath = fileURLToPath(String(url));
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return new Response(null, { status: 404, statusText: 'Not Found' });
  }
  const range = init?.headers?.Range ?? init?.headers?.range;
  if (!range) {
    return new Response(buf.subarray(), {
      status: 200,
      headers: { ETag: 'local' },
    });
  }
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  if (!m) return new Response(null, { status: 416 });
  const slice = buf.subarray(Number(m[1]), Number(m[2]) + 1);
  return new Response(slice, { status: 206, headers: { ETag: 'local' } });
}

// ────────────────────────────────────────────────────────────── CLI ──────

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out.positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (['json', 'all', 'list-variants', 'help'].includes(name)) {
      out.flags[name] = true;
    } else {
      out.flags[name] = argv[++i];
    }
  }
  return out;
}

const USAGE = `policy-replay — deterministic client-policy trace replay

  node src/policy-replay.mjs <trace.jsonl> [options]

  --variant <name>        policy variant (default: incumbent)
  --all                   replay every variant and print a comparison table
  --archive <path|url>    take the universe from the archive DIRECTORY
  --read-cost-bytes N     g in "bytes + g*reads" (default ${DEFAULT_READ_COST_BYTES})
  --horizon N             override prefetchHorizonBuckets
  --max-tiles N           override maxResidentTiles
  --max-bytes N           override maxResidentBytes
  --json                  emit the canonical JSON report on stdout
  --list-variants         print the variant registry and exit

Cost is ALWAYS reported as bytes + g*reads. Request count is a counter, never
a ranking key. The replayer models policy decisions only — no GPU/render
feedback, no transport latency.
`;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flags['list-variants']) {
    for (const v of VARIANTS.values()) {
      process.stdout.write(`${v.name.padEnd(12)} ${v.description}\n`);
    }
    return 0;
  }
  const tracePath = positional[0];
  if (!tracePath) {
    process.stderr.write(USAGE);
    return 2;
  }
  const text = fs.readFileSync(path.resolve(tracePath), 'utf8');
  const trace = parseTrace(text);

  const config = {};
  if (flags.horizon !== undefined)
    config.prefetchHorizonBuckets = Number(flags.horizon);
  if (flags['max-tiles'] !== undefined)
    config.maxResidentTiles = Number(flags['max-tiles']);
  if (flags['max-bytes'] !== undefined)
    config.maxResidentBytes = Number(flags['max-bytes']);
  const readCostBytes =
    flags['read-cost-bytes'] !== undefined
      ? Number(flags['read-cost-bytes'])
      : DEFAULT_READ_COST_BYTES;

  let universe;
  if (flags.archive) {
    const probe = buildUniverseFromTrace(trace.events).universe;
    const steps = buildSteps(
      trace.events,
      resolveConfig(trace.header, config),
      probe,
    );
    universe = await universeFromArchive(flags.archive, steps);
  }

  const names = flags.all
    ? [...VARIANTS.keys()]
    : [flags.variant ?? 'incumbent'];
  const reports = names.map((n) =>
    replay(trace, { variant: n, readCostBytes, config, universe }),
  );

  if (flags.json) {
    process.stdout.write(
      reports.length === 1
        ? formatReport(reports[0])
        : canonicalJson(reports, 2) + '\n',
    );
    return reports.every((r) => r.invariants.ok) ? 0 : 1;
  }

  const head = reports[0];
  process.stdout.write(
    `trace ${head.trace.route}  ${head.trace.steps} steps  ` +
      `${head.trace.universeTiles} tiles (${head.trace.universeSource})  ` +
      `digest ${head.trace.digest}\n`,
  );
  process.stdout.write(
    `cost model: bytes + g*reads   g = ${fmtBytes(head.params.readCostBytes)}\n\n`,
  );
  process.stdout.write(
    `${'variant'.padEnd(12)}${'cost'.padStart(12)}${'bytes'.padStart(12)}` +
      `${'reads'.padStart(8)}${'refetch'.padStart(9)}${'runwayEv'.padStart(10)}` +
      `${'evict'.padStart(8)}${'p95 wait'.padStart(10)}\n`,
  );
  for (const r of reports) {
    process.stdout.write(
      `${r.variant.padEnd(12)}${fmtBytes(r.cost.value).padStart(12)}` +
        `${fmtBytes(r.cost.bytesFetched).padStart(12)}` +
        `${String(r.cost.reads).padStart(8)}` +
        `${String(r.refetch.cycles).padStart(9)}` +
        `${String(r.eviction.runwayEvictions).padStart(10)}` +
        `${String(r.eviction.total).padStart(8)}` +
        `${String(r.decode.p95WaitMs + ' ms').padStart(10)}\n`,
    );
  }
  const bad = reports.filter((r) => !r.invariants.ok);
  if (bad.length) {
    for (const r of bad) {
      const failed = r.invariants.checks
        .filter((c) => !c.ok)
        .map((c) => c.name);
      process.stderr.write(
        `\n  !! ${r.variant}: conservation invariant(s) violated: ${failed.join(', ')}\n`,
      );
    }
    return 1;
  }
  process.stdout.write(
    '\nfidelity: policy decisions only — no GPU/render feedback, no transport latency.\n',
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
