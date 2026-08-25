// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Rate limit for driving `tileset.update()` from Cesium's render loop.
 *
 * `attachCesiumClock` applies the playhead on every DRAWN frame
 * (`scene.preRender`), and the natural thing to do in that callback is to
 * push the new time into the tileset so temporal prefetch tracks it. But the
 * core tileset's identical-params fast path keys on the RAW selection time
 * range, so any moving playhead misses it — and each miss is a full selection
 * pass (directory scans for the primary + four parent levels, needed-set
 * rebuild, supersession, eviction sweep). At 60 fps that was 60 passes per
 * second, the whole of it main-thread work competing with the draw.
 *
 * This is the deck chassis's rule (`spatiotemporal-layer.ts`
 * `_handleTimeUpdate`), lifted so the Cesium consumer can share it:
 *  1. The FIRST call, and any SPATIAL change (zoom, bounds, or the selection
 *     window itself), drive immediately — a throttle that delayed a pan would
 *     be a visible hole on the globe.
 *  2. A time-only change drives immediately when the playhead moved more than
 *     `timeWindow × timeFraction` of sim time AND at least `minWallMs` of wall
 *     time elapsed since the last pass. Both are required: the wall floor
 *     bounds the cost at high playback speed, the sim threshold keeps slow
 *     scrubbing from re-selecting for a few ms of travel.
 *  3. Otherwise the change is HELD and one trailing pass is armed for when
 *     the floor elapses — the last tick of a paused clock, or a seek inside
 *     the window, must never be lost. The trailing pass carries the LATEST
 *     viewport offered, not the one that armed it.
 *
 * Cesium-free and unit-tested against a fake tileset + injected clock.
 */

import type { BoundingBox } from '@poopdeck.gl/core';

export interface TilesetViewport {
  bounds: BoundingBox;
  zoom: number;
  /** Playhead, absolute ms. */
  time: number;
  /** SELECTION window (ms) — the sim threshold is a fraction of it. */
  timeWindow: number;
}

/** The slice of `SpatioTemporalTileset` the throttle drives. */
export interface ThrottledTileset {
  update(viewport: TilesetViewport, skipDebounce?: boolean): unknown;
}

export interface ThrottledTilesetUpdateOptions {
  /** Wall-clock floor between two time-driven passes. @default 100 */
  minWallMs?: number;
  /** Sim-time threshold as a fraction of `timeWindow`. @default 1/20 */
  timeFraction?: number;
  /** Wall clock (ms). @default performance.now */
  now?: () => number;
}

export interface ThrottledTilesetUpdate {
  /**
   * Offer a viewport. Drives the tileset now and returns `true`, or holds it
   * (arming the trailing pass) and returns `false`. `skipDebounce` is
   * forwarded to `tileset.update` on whichever pass carries the viewport.
   */
  update(viewport: TilesetViewport, skipDebounce?: boolean): boolean;
  /** Run a held viewport now, if any. Returns whether a pass ran. */
  flush(): boolean;
  /** Drop any held viewport and its timer. Call from the clock's disposer. */
  dispose(): void;
}

const DEFAULT_MIN_WALL_MS = 100;
const DEFAULT_TIME_FRACTION = 1 / 20;

function sameBox(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.minLon === b.minLon &&
    a.minLat === b.minLat &&
    a.maxLon === b.maxLon &&
    a.maxLat === b.maxLat
  );
}

export function createThrottledTilesetUpdate(
  tileset: ThrottledTileset,
  opts: ThrottledTilesetUpdateOptions = {},
): ThrottledTilesetUpdate {
  const minWallMs = opts.minWallMs ?? DEFAULT_MIN_WALL_MS;
  const timeFraction = opts.timeFraction ?? DEFAULT_TIME_FRACTION;
  const now = opts.now ?? (() => performance.now());

  let last: TilesetViewport | null = null;
  let lastWall = Number.NEGATIVE_INFINITY;
  let held: { viewport: TilesetViewport; skipDebounce?: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const drive = (viewport: TilesetViewport, skipDebounce?: boolean): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    held = null;
    last = viewport;
    lastWall = now();
    tileset.update(viewport, skipDebounce);
  };

  const flush = (): boolean => {
    if (disposed || !held) return false;
    const { viewport, skipDebounce } = held;
    drive(viewport, skipDebounce);
    return true;
  };

  return {
    update(viewport, skipDebounce) {
      if (disposed) return false;
      const spatialChange =
        !last ||
        viewport.zoom !== last.zoom ||
        viewport.timeWindow !== last.timeWindow ||
        !sameBox(viewport.bounds, last.bounds);
      if (spatialChange) {
        drive(viewport, skipDebounce);
        return true;
      }
      if (viewport.time === last!.time) return false;
      const elapsed = now() - lastWall;
      if (
        elapsed >= minWallMs &&
        Math.abs(viewport.time - last!.time) >
          viewport.timeWindow * timeFraction
      ) {
        drive(viewport, skipDebounce);
        return true;
      }
      // Held: the trailing pass carries whatever is offered LAST, so a
      // still-running clock lands on its final tick, not its first held one.
      held = { viewport, skipDebounce };
      if (timer === undefined) {
        timer = setTimeout(
          () => {
            timer = undefined;
            flush();
          },
          Math.max(0, minWallMs - elapsed),
        );
      }
      return false;
    },
    flush,
    dispose() {
      disposed = true;
      held = null;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
