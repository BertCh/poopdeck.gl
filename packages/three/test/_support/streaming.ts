// @poopdeck.gl/three — test support
// SPDX-License-Identifier: MIT
//
// One controllable `DrivableTileset` mock shared by `streaming-tile-source.test.ts`
// (drives `StreamingTileSource` directly) and `scene-streaming.test.ts` (drives it
// through `SttScene`). Both used to hand-roll the same mock; this superset exposes
// everything either needs: an `updates` log (+ `updateCount`), a `setVisible` seam
// to flip the resident set, and `clear`/`setAnimationState` spies (+ `clearCalls`).

import { vi } from 'vitest';
import type { BoundingBox, Tile, TileId } from '@poopdeck.gl/core';
import type { DrivableTileset } from '../../src/scene/streaming-tile-source';

/** The viewport both suites pump (bounds ±1°, zoom 14, t=5000). */
export const VIEWPORT = {
  bounds: { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 } as BoundingBox,
  zoom: 14,
  time: 5000,
};

/** A minimal empty-layer tile keyed only by address. */
export function tile(id: TileId): Tile {
  return {
    id,
    timeRange: { start: id.t, end: id.t + 1000 },
    layers: [],
  } as Tile;
}

type UpdateArg = {
  bounds: BoundingBox;
  zoom: number;
  time: number;
  timeWindow: number;
};

export type MockTileset = DrivableTileset & {
  /** Every viewport passed to `update`, in order. */
  updates: UpdateArg[];
  /** `updates.length` — the number of `update` pumps. */
  readonly updateCount: number;
  /** How many times `clear` was called (via dispose). */
  readonly clearCalls: number;
  /** Swap the visible set the next `getVisibleTiles` returns. */
  setVisible(t: Tile[]): void;
  clear: ReturnType<typeof vi.fn>;
  setAnimationState: ReturnType<typeof vi.fn>;
  setInteractive: ReturnType<typeof vi.fn>;
};

export function mockTileset(initial: Tile[] = []): MockTileset {
  let visible = initial;
  const updates: UpdateArg[] = [];
  const clear = vi.fn();
  const setAnimationState = vi.fn();
  const setInteractive = vi.fn();
  return {
    updates,
    get updateCount() {
      return updates.length;
    },
    get clearCalls() {
      return clear.mock.calls.length;
    },
    setVisible(t: Tile[]) {
      visible = t;
    },
    update(v: UpdateArg) {
      updates.push(v);
      return 0;
    },
    getVisibleTiles() {
      return visible;
    },
    setAnimationState,
    setInteractive,
    clear,
  };
}
