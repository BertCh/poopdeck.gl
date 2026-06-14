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
 */

interface ProbeBag {
  enabled?: boolean;
  consolidations?: unknown[];
  renderLayers?: unknown[];
  tilePrepare?: unknown[];
  decode?: unknown[];
  snapshots?: Record<string, unknown>;
  [k: string]: unknown;
}

const MAX_SAMPLES = 4096;

export type CoreProbeChannel = 'decode' | 'tilePrepare';

function getBag(): ProbeBag | undefined {
  return (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
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
  if (arr.length > MAX_SAMPLES) arr.shift();
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
