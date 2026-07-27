/**
 * `SpatioTemporalTileset.update()` repairs the camera-derived box before it
 * reaches selection — defence in depth for
 * docs/roadmap/tile-loading-3d-2026-07.md §4.3.
 *
 * The producer-side fix (the deck chassis sampling four corners with a horizon
 * clamp) is necessary but not sufficient: three, maplibre, cesium and any host
 * application drive `update()` directly, and every one of those paths has a
 * camera for which its derivation emits a degenerate box. Downstream the
 * failures are silent and total — an inverted latitude box makes the row scan
 * never execute (zero tiles) while every readiness signal reports settled —
 * so the same primitive the backends use runs here as well.
 *
 * The rules themselves are pinned by viewport-bounds-normalize.test.ts; what
 * this file pins is that `update()` actually applies them, and what it does
 * with a box it cannot repair.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { BoundingBox, TileId } from '../src/types';
import { fakeTile, flush } from './helpers/fixtures';
import { MAX_MERCATOR_LAT } from '../src/geo/mercator';

const GOOD: BoundingBox = { minLon: 10, minLat: 20, maxLon: 30, maxLat: 40 };

/** Records every bounds object selection was run against. */
function makeTileset() {
  const seen: BoundingBox[] = [];
  const getAvailableTiles = vi.fn(
    async (bounds: BoundingBox, z: number): Promise<TileId[]> => {
      seen.push({ ...bounds });
      return z === 6 ? [{ z, x: 0, y: 0, t: 0 }] : [];
    },
  );
  const tileset = new SpatioTemporalTileset({
    minZoom: 6,
    maxZoom: 6,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: 1000,
    getAvailableTiles,
    getTileData: async (id: TileId) => fakeTile(id),
  });
  return { tileset, seen };
}

const view = (bounds: BoundingBox) => ({
  bounds,
  zoom: 6,
  time: 0,
  timeWindow: 100,
});

describe('update() normalizes the viewport box', () => {
  it('orders an inverted latitude box instead of selecting against it', async () => {
    const { tileset, seen } = makeTileset();
    // What deck's two-corner AABB produced past bearing > atan2(h, w): the
    // sampled corners swapped and the box inverted in latitude.
    tileset.update(
      view({ minLon: 10, minLat: 40, maxLon: 30, maxLat: 20 }),
      true,
    );
    await flush();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].minLat).toBe(20);
    expect(seen[0].maxLat).toBe(40);
    tileset.finalize();
  });

  it('clamps latitude to the Mercator edge', async () => {
    // ±MAX_MERCATOR_LAT, not ±90 — `latToTileY` returns NaN in the sliver just
    // inside the poles, collapsing selection to zero tiles. See
    // polar-tile-row-collapse.test.ts.
    const { tileset, seen } = makeTileset();
    tileset.update(
      view({ minLon: 10, minLat: -140, maxLon: 30, maxLat: 130 }),
      true,
    );
    await flush();

    expect(seen[0].minLat).toBe(-MAX_MERCATOR_LAT);
    expect(seen[0].maxLat).toBe(MAX_MERCATOR_LAT);
    tileset.finalize();
  });

  it('swaps a longitude pair that claims to cross the seam AND wrap the planet', async () => {
    const { tileset, seen } = makeTileset();
    // The pitch-inversion signature: `minLon > maxLon` implying a 359°+ span.
    // Read as a seam crossing it selects 510 of 512 columns at z9.
    tileset.update(
      view({ minLon: 30, minLat: 20, maxLon: 29, maxLat: 40 }),
      true,
    );
    await flush();

    expect(seen[0].minLon).toBe(29);
    expect(seen[0].maxLon).toBe(30);
    tileset.finalize();
  });

  it('leaves a GENUINE antimeridian crossing encoded as-is', async () => {
    const { tileset, seen } = makeTileset();
    // `minLon > maxLon` with a 20° implied span is the load-bearing crossing
    // encoding, not an artefact: the core scan walks unwrapped column space
    // and wraps at emit. Re-ordering it here would drop the far side of the
    // seam — the ais-all-us / drifters regression.
    tileset.update(
      view({ minLon: 170, minLat: 20, maxLon: -170, maxLat: 40 }),
      true,
    );
    await flush();

    expect(seen[0].minLon).toBe(170);
    expect(seen[0].maxLon).toBe(-170);
    tileset.finalize();
  });

  it('passes an UNWRAPPED longitude through without clamping', async () => {
    const { tileset, seen } = makeTileset();
    // What WebMercatorViewport.unproject actually reports for a camera at
    // lon 179. Clamping into [-180, 180] here silently discards the right
    // half of the screen.
    tileset.update(
      view({ minLon: 174, minLat: 20, maxLon: 184, maxLat: 40 }),
      true,
    );
    await flush();

    expect(seen[0].minLon).toBe(174);
    expect(seen[0].maxLon).toBe(184);
    tileset.finalize();
  });
});

describe('update() rejects an unusable viewport box', () => {
  it('keeps the previous viewport and selects nothing new on a non-finite box', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tileset, seen } = makeTileset();

    tileset.update(view(GOOD), true);
    await flush();
    const afterGood = seen.length;
    expect(afterGood).toBeGreaterThan(0);
    const visible = tileset.getVisibleTiles();
    expect(visible.length).toBe(1);

    // A degenerate unprojection matrix, or a ray/plane solve that divided by
    // a near-zero z. There is no repair that preserves any information.
    tileset.update(
      view({ minLon: NaN, minLat: 20, maxLon: 30, maxLat: 40 }),
      true,
    );
    await flush();

    // No new selection ran, and what was on screen is still on screen —
    // selecting against garbage is strictly worse than a slightly stale box.
    expect(seen.length).toBe(afterGood);
    expect(tileset.getVisibleTiles().length).toBe(1);
    expect(warn).toHaveBeenCalledOnce();

    // …and a later good box is honoured normally (the reject is not a latch).
    tileset.update({ ...view(GOOD), time: 1000, timeWindow: 100 }, true);
    await flush();
    expect(seen.length).toBeGreaterThan(afterGood);

    warn.mockRestore();
    tileset.finalize();
  });

  it('warns ONCE however many bad frames arrive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tileset } = makeTileset();
    for (let i = 0; i < 20; i++) {
      tileset.update(
        view({ minLon: 10, minLat: 20, maxLon: Infinity, maxLat: 40 }),
        true,
      );
    }
    await flush();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    tileset.finalize();
  });
});
