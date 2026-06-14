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
  [k: string]: unknown;
}

const MAX_SAMPLES = 4096;

/** The governor emits quality-of-experience samples on the `playback` channel. */
export type PlaybackProbeChannel = 'playback';

function getBag(): ProbeBag | undefined {
  return (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
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
  if (arr.length > MAX_SAMPLES) arr.shift();
}
