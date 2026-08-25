// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/maplibre contributors

/**
 * Rate limit for driving `tileset.update()` from a render loop.
 *
 * The core tileset's identical-params fast path keys on the RAW selection
 * `timeRange`, so a playhead that moves at all misses it — and a maplibre
 * custom layer renders every frame while time advances. Unthrottled, that is
 * one full selection pass (directory scans for the primary + four parent
 * levels, needed-set rebuild, supersession, eviction sweep) per drawn frame,
 * per layer. The deck chassis has always guarded its tick path with the rule
 * below (`spatiotemporal-layer.ts` `_handleTimeUpdate`); this is the same
 * rule, lifted out so the maplibre path can share it.
 *
 * The rule, per candidate viewport:
 *  1. The FIRST call, and any SPATIAL change (zoom, bounds, or the selection
 *     window itself), drive immediately — a throttle that delayed a pan would
 *     be a visible hole in the map.
 *  2. A time-only change drives immediately when the playhead moved more than
 *     `timeWindow × timeFraction` of sim time AND at least `minWallMs` of wall
 *     time elapsed since the last pass. Both are required: the wall floor is
 *     what bounds the cost at high playback speed ("never more than ~10×/s
 *     regardless of how fast sim-time advances"), the sim threshold is what
 *     keeps slow scrubbing from re-selecting for a few ms of travel.
 *  3. Otherwise the change is HELD and the caller is told how long to wait
 *     before a trailing pass — the last tick of a paused clock, or a seek
 *     inside the window, must never be lost. That trailing pass runs at most
 *     once per wall floor, so the rate ceiling holds on that path too.
 *
 * Pure and Map-free: the caller owns the timer and the tileset.
 */

import type { BoundingBox } from '@poopdeck.gl/core';

export interface ThrottledViewport {
  bounds: BoundingBox;
  zoom: number;
  /** Playhead, absolute ms. */
  time: number;
  /** SELECTION window (ms) — the sim threshold is a fraction of it. */
  timeWindow: number;
}

export interface UpdateThrottleOptions {
  /** Wall-clock floor between two time-driven passes. @default 100 */
  minWallMs?: number;
  /** Sim-time threshold as a fraction of `timeWindow`. @default 1/20 */
  timeFraction?: number;
  /** Wall clock (ms). @default performance.now */
  now?: () => number;
}

export type UpdateDecision =
  /** Drive the tileset now (and call {@link TilesetUpdateThrottle.markDriven}). */
  | { kind: 'drive' }
  /** Nothing moved since the last pass; do nothing. */
  | { kind: 'idle' }
  /** Time moved but is throttled; arm a trailing pass in `waitMs`. */
  | { kind: 'hold'; waitMs: number };

const DEFAULT_MIN_WALL_MS = 100;
const DEFAULT_TIME_FRACTION = 1 / 20;

export class TilesetUpdateThrottle {
  private readonly minWallMs: number;
  private readonly timeFraction: number;
  private readonly now: () => number;

  private lastTime = Number.NaN;
  private lastWall = Number.NEGATIVE_INFINITY;
  private lastZoom = Number.NaN;
  private lastWindow = Number.NaN;
  private lastBounds: BoundingBox | null = null;

  constructor(opts: UpdateThrottleOptions = {}) {
    this.minWallMs = opts.minWallMs ?? DEFAULT_MIN_WALL_MS;
    this.timeFraction = opts.timeFraction ?? DEFAULT_TIME_FRACTION;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Classify a candidate viewport against the last DRIVEN one. */
  decide(v: ThrottledViewport): UpdateDecision {
    const last = this.lastBounds;
    if (
      !last ||
      v.zoom !== this.lastZoom ||
      v.timeWindow !== this.lastWindow ||
      v.bounds.minLon !== last.minLon ||
      v.bounds.minLat !== last.minLat ||
      v.bounds.maxLon !== last.maxLon ||
      v.bounds.maxLat !== last.maxLat
    ) {
      return { kind: 'drive' };
    }
    if (v.time === this.lastTime) return { kind: 'idle' };
    const elapsed = this.now() - this.lastWall;
    const simDelta = Math.abs(v.time - this.lastTime);
    if (
      elapsed >= this.minWallMs &&
      simDelta > v.timeWindow * this.timeFraction
    ) {
      return { kind: 'drive' };
    }
    return { kind: 'hold', waitMs: Math.max(0, this.minWallMs - elapsed) };
  }

  /** Record that the tileset was driven with `v` (now). */
  markDriven(v: ThrottledViewport): void {
    this.lastTime = v.time;
    this.lastWall = this.now();
    this.lastZoom = v.zoom;
    this.lastWindow = v.timeWindow;
    this.lastBounds = v.bounds;
  }

  /** Forget the last pass so the next call drives (a fresh tileset). */
  reset(): void {
    this.lastTime = Number.NaN;
    this.lastWall = Number.NEGATIVE_INFINITY;
    this.lastZoom = Number.NaN;
    this.lastWindow = Number.NaN;
    this.lastBounds = null;
  }
}
