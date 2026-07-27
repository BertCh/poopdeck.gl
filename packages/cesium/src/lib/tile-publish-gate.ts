// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Decides whether a resident tile set is worth handing to `setTiles`.
 *
 * Every Cesium STT layer's `setTiles` is a REPLACE-ALL: it drops its primitives
 * and rebuilds one per feature across every resident tile, synchronously
 * (`asynchronous: false` — deliberately, so a rebuild is deterministic and needs
 * no worker round-trip). That is the right shape for a viewport change and the
 * wrong shape for a tile-load callback, because the tileset fires one per tile:
 * filling M tiles holding N features costs O(N·M) primitive constructions on the
 * main thread, all of them redundant except the last.
 *
 * Two cheap filters remove most of that without touching how a layer builds:
 *
 * - **Unchanged.** `onTileUnload` fires on eviction and re-selection, and the
 *   playhead hook re-selects constantly, so the same visible set is offered again
 *   and again. Comparing keys is O(M) against an O(N·M) rebuild.
 * - **Empty, BRIEFLY.** `getVisibleTiles()` returns `[]` for the frames between a
 *   selection change and the first decoded tile of the new set. Publishing that
 *   tears the layer down to nothing and back — the "tiles genuinely in view flash
 *   out" symptom (`docs/roadmap/tile-loading-3d-2026-07.md` §3).
 *
 *   That refusal is a BET that the emptiness is a transient, and the bet has to
 *   have a deadline. Not every empty selection is a gap between decodes: pan a
 *   land-only archive out over open ocean, scrub the playhead past the end of the
 *   data, or switch to a time bucket the dataset does not cover, and
 *   `getVisibleTiles()` is empty for as long as the user cares to look. An
 *   unbounded refusal leaves the last good tiles on the globe forever — the map
 *   confidently drawing data that is not there, which is a worse failure than a
 *   blank one because nothing about it looks broken. So the hold is bounded by
 *   {@link TilePublishGateOptions.emptyHoldMs}, after which the gate publishes the
 *   empty set once (`reason: 'cleared'`) and then goes quiet again.
 *
 *   The original justification for holding — "the geometry is positioned in world
 *   space, so a set that is no longer selected is a set the camera has already
 *   left behind" — is true for a PAN and false for everything else. Zooming in,
 *   scrubbing time, or crossing the edge of the data all leave stale geometry
 *   inside the frustum.
 *
 * CALLER OBLIGATION for the bound to bite: the gate is passive — it decides only
 * when {@link TilePublishGate.offer} is called, and it cannot schedule itself. A
 * host that arms its republish exclusively from `onTileLoad`/`onTileUnload` can
 * reach a state where the selection is empty, the last unload has already fired
 * and no further offer ever arrives, so the hold never expires. Arm a republish
 * from the viewport/playhead update as well — those are the two events that MAKE
 * a selection empty — or drive `offer` from the render loop.
 */

import { tileKey, type Tile } from '@poopdeck.gl/core';

export type TilePublishReason = 'changed' | 'unchanged' | 'empty' | 'cleared';

export interface TilePublishDecision {
  publish: boolean;
  reason: TilePublishReason;
  /** Keys present now and not in the last published set. */
  added: number;
  /** Keys in the last published set and not present now. */
  removed: number;
}

const SKIP_EMPTY: TilePublishDecision = {
  publish: false,
  reason: 'empty',
  added: 0,
  removed: 0,
};

/**
 * How long the gate will keep refusing an empty set before it concludes the
 * emptiness is real and clears, ms.
 *
 * Sized against the transient it covers — request → response → decode for the
 * first tile of a new selection — with room for a cold cache. Too short and the
 * flash comes back on a slow network; too long and a genuinely empty view keeps
 * showing the previous region's tiles. 1.5 s sits past a warm CDN round trip
 * (50–300 ms) and well inside the point where a user reads the stale content as
 * the answer.
 */
const DEFAULT_EMPTY_HOLD_MS = 1500;

export interface TilePublishGateOptions {
  /** @see DEFAULT_EMPTY_HOLD_MS. `0` clears on the first empty offer. */
  emptyHoldMs?: number;
  /**
   * Clock, ms. Injectable so the hold is testable without timers, and so a host
   * that already has a frame clock can hand its own in. Defaults to
   * `performance.now()` where available — monotonic, so a wall-clock adjustment
   * (NTP, DST, a laptop waking up) cannot expire or freeze a hold.
   */
  now?: () => number;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class TilePublishGate {
  private published = new Set<string>();
  /**
   * When the current run of empty offers started, or `undefined` when the last
   * offer was non-empty. Armed on the FIRST empty offer rather than on the
   * selection change, so a long pause BEFORE the gap (a hidden tab, a paused
   * render loop) cannot expire a hold that never began.
   */
  private emptySince: number | undefined;
  private readonly emptyHoldMs: number;
  private readonly now: () => number;

  constructor(opts: TilePublishGateOptions = {}) {
    this.emptyHoldMs = opts.emptyHoldMs ?? DEFAULT_EMPTY_HOLD_MS;
    this.now = opts.now ?? defaultNow;
  }

  /**
   * Offer the current visible set. When `publish` is true the caller must call
   * `setTiles` with exactly the tiles it offered — the gate has already recorded
   * them as published. A `'cleared'` decision offers the EMPTY set, so the
   * caller's `setTiles([])` is the teardown it asks for, not an accident.
   */
  offer(tiles: readonly Tile[]): TilePublishDecision {
    if (tiles.length === 0) {
      // Nothing on screen to protect and nothing to clear: stay quiet and do
      // not arm a hold, or the first real set after a slow start-up would be
      // preceded by a pointless `setTiles([])`.
      if (this.published.size === 0) {
        this.emptySince = undefined;
        return SKIP_EMPTY;
      }
      const t = this.now();
      // Per-GAP, not cumulative. A dataset that flickers empty for 200 ms on
      // every scrub must never accumulate its way to a clear, so any non-empty
      // offer below disarms this.
      this.emptySince ??= t;
      if (t - this.emptySince < this.emptyHoldMs) return SKIP_EMPTY;
      const removed = this.published.size;
      this.published = new Set();
      this.emptySince = undefined;
      return { publish: true, reason: 'cleared', added: 0, removed };
    }
    this.emptySince = undefined;

    const next = new Set<string>();
    let added = 0;
    for (const tile of tiles) {
      const key = tileKey(tile.id);
      next.add(key);
      if (!this.published.has(key)) added++;
    }
    // Count against the deduplicated set, not `tiles.length`: a duplicate id in
    // the offered array would otherwise show up as a phantom removal forever.
    const removed = this.published.size - (next.size - added);
    if (added === 0 && removed === 0) {
      return { publish: false, reason: 'unchanged', added: 0, removed: 0 };
    }
    this.published = next;
    return { publish: true, reason: 'changed', added, removed };
  }

  /**
   * Forget what was published — after a `dispose`/`clear`, or a layer swap.
   *
   * Disarms any hold in progress too: the next empty offer belongs to the NEW
   * layer's first-decode transient, not to the gap the old layer left behind, so
   * inheriting the old timestamp would clear the new layer before it ever drew.
   */
  reset(): void {
    this.published = new Set();
    this.emptySince = undefined;
  }
}
