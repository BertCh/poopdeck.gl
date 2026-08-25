// @poopdeck.gl/playback
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/playback contributors

/**
 * Minimal telemetry shim for `@poopdeck.gl/playback`.
 *
 * Mirrors the channel layout used by `@poopdeck.gl/core` and
 * `@poopdeck.gl/layers` so probe consumers see a single coherent
 * `globalThis.__sttProbe` object. Kept inline (rather than imported from a
 * sibling package) so the playback engine has ZERO runtime dependencies and
 * can be consumed by any renderer — deck.gl, MapLibre, or none.
 *
 * When the probe object isn't set up (production paths), every call is a
 * single property read + early return — safe to leave in hot paths.
 */

interface ProbeBag {
  enabled?: boolean;
  playback?: unknown[];
  scrub?: unknown[];
  snapshots?: Record<string, unknown>;
  [k: string]: unknown;
}

const MAX_SAMPLES = 4096;
/** Batched trim — a per-sample `shift()` on a full channel copies ~4k slots per sample (see core telemetry.ts). */
const SAMPLE_TRIM_BATCH = MAX_SAMPLES / 4;

/**
 * The channels this package writes.
 *
 * - `playback` — the governor's session QoE roll-up, one sample per state
 *   transition (`waiting` / `ready` / `statechange`).
 * - `scrub` — the per-drag QoE bracket. It is declared HERE, alongside
 *   `playback`, because the governor is what emits it. It was previously
 *   smuggled past this union by an `as unknown as` cast at the call site,
 *   which defeated the type system on exactly the trace contract the replay
 *   harness reads; the union is the fix, and the cast is gone.
 *
 * Both land in the same bag, under the same 4096-sample ring, as
 * `@poopdeck.gl/core`'s channels of the same names.
 */
export type PlaybackProbeChannel = 'playback' | 'scrub';

function getBag(): ProbeBag | undefined {
  return (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
}

/**
 * True when a probe bag is installed and not explicitly disabled.
 *
 * The same single-property-read guard {@link emit} / {@link snapshot} apply
 * internally, exposed so a call site can skip BUILDING a payload object when
 * the probe is off. Never branch behavior on this — it is an observation gate
 * only. (Mirrors `@poopdeck.gl/core`'s export of the same name; the two cannot
 * share code without giving this package a runtime dependency.)
 */
export function isProbeEnabled(): boolean {
  const bag = getBag();
  return bag !== undefined && bag.enabled !== false;
}

/** Record one sample to `__sttProbe[channel]`. No-op when probe is unset. */
export function emit<T>(channel: PlaybackProbeChannel, payload: T): void {
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
 * Snapshot key for the governor's latest playback state.
 *
 * NOT a free choice: `tools/bench/src/policy-record.mjs` reads
 * `snapshots['tileset.viewport'] ?? snapshots['playback.state']` and refuses to
 * write a trace when neither exists. This is the FALLBACK half of that pair —
 * the governor knows the play-head, the direction and whether the clock is
 * advancing, but not the camera, so a trace whose trajectory comes from here
 * is temporal-only. The recorder records which source it used in the trace
 * header; a spatial replay wants `tileset.viewport`.
 */
export const PLAYBACK_STATE_SNAPSHOT = 'playback.state';

/**
 * The `playback.state` payload. `playheadMs` / `direction` / `animating` are
 * the trajectory fields the recorder reads; the rest are the QoE counters the
 * O1 acceptance cells (`stallCount`, `totalStallMs`) name, published as a
 * snapshot so a harness whose measurement window contains NO state transition
 * can still read them — the `playback` channel only emits on transitions.
 *
 * The counters are CUMULATIVE over the governor's lifetime (they include
 * warm-up). A harness that wants a windowed figure must difference them
 * against a reading taken at the start of its window; `frame-cost.mjs` does.
 */
export interface PlaybackStateSnapshot {
  /** The governor state name (`idle` / `starting` / `playing` / …). */
  state: string;
  /** Play-head, sim-ms. */
  playheadMs: number;
  /** Signed playback rate, sim-ms per wall-ms. */
  speed: number;
  /** +1 forward, -1 backward (the sign of `speed`; +1 when parked). */
  direction: 1 | -1;
  /** User intent + a non-zero rate: true THROUGH a gate, where the clock is frozen but playback is wanted. */
  animating: boolean;
  stallCount: number;
  totalStallMs: number;
  startupMs: number | null;
  degradedResumeCount: number;
  creepMs: number;
  // Tile-loading audit G2 counters (see `PlaybackQoeStats`): the same
  // getQoeStats() object is spread here, so a harness reads them from the
  // snapshot exactly as from the getter.
  stallMs: number;
  seekCount: number;
  seekSettleMsP50: number | null;
  gateEntriesByReason: { starting: number; buffering: number; seeking: number };
  gateHoldsByReason: { starting: number; buffering: number; seeking: number };
  frontierSnapBacks: number;
  blockedPermanentlyCount: number;
}
