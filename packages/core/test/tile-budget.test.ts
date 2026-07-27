// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * The viewport cell budget — `viewportCellCount` / `fitZoomToCellBudget`.
 *
 * Two things are pinned here that are easy to break and expensive to notice:
 *
 *  1. The budget is INERT for ordinary cameras. It exists for the pitch-85
 *     volumetric demos, and a budget that quietly clamps a flat map would be a
 *     silent LOD regression on every demo in the fleet — the kind of change
 *     that reads as "the tiles look blurry now" months later.
 *  2. The count it measures is the count the archive's scan actually
 *     enumerates. `viewportCellCount` is asserted against a local transcription
 *     of `boundsToTiles`' loop rather than against a formula, because a budget
 *     that predicts a different number from the one being paid clamps for a
 *     cost that is not there (or fails to clamp for one that is).
 *
 * See docs/roadmap/tile-loading-3d-2026-07.md §4.4.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VIEWPORT_CELL_BUDGET,
  DEFAULT_CELL_BUDGET_HYSTERESIS,
  viewportCellCount,
  fitZoomToCellBudget,
} from '../src/index.js';
import type { BoundingBox } from '../src/index.js';

/**
 * The row/column loop `archive.ts`'s private `boundsToTiles` runs, transcribed
 * so this file measures the enumeration WITHOUT importing it (it is not
 * exported, and a test that imported the thing it pins would pin nothing).
 * Kept deliberately literal, including the order-then-clamp on y.
 */
function enumerateCells(b: BoundingBox, zoom: number): Set<string> {
  const n = 1 << zoom;
  const out = new Set<string>();
  const lonToTileX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const latToTileY = (lat: number) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
    );
  };
  // The wrap-aware column span, mirroring `tileXSpanForLonRange`.
  let start: number;
  let count: number;
  const crossing = b.minLon > b.maxLon && b.maxLon - b.minLon + 360 < 350;
  const [west, east] = crossing
    ? [b.minLon, b.maxLon]
    : b.minLon <= b.maxLon
      ? [b.minLon, b.maxLon]
      : [b.maxLon, b.minLon];
  if (west <= east && west >= -180 && east <= 180) {
    start = Math.max(0, lonToTileX(west));
    count = Math.max(0, Math.min(lonToTileX(east), n - 1) - start + 1);
  } else {
    const first = lonToTileX(west);
    const last = lonToTileX(east) + (west > east ? n : 0);
    count = Math.min(n, Math.max(0, last - first + 1));
    start = ((first % n) + n) % n;
  }
  const yTop = latToTileY(b.maxLat);
  const yBottom = latToTileY(b.minLat);
  const minY = Math.max(0, Math.min(yTop, yBottom));
  const maxY = Math.min(Math.max(yTop, yBottom), n - 1);
  for (let i = 0; i < count; i++) {
    const x = (((start + i) % n) + n) % n;
    for (let y = minY; y <= maxY; y++) out.add(`${x}/${y}`);
  }
  return out;
}

/** A box centred on `lon`/`lat` spanning `span` degrees each way. */
function box(lon: number, lat: number, span: number): BoundingBox {
  return {
    minLon: lon - span / 2,
    maxLon: lon + span / 2,
    minLat: lat - span / 2,
    maxLat: lat + span / 2,
  };
}

describe('viewportCellCount', () => {
  it('equals the number of cells the archive scan enumerates', () => {
    const boxes: BoundingBox[] = [
      box(-98, 39, 4),
      box(-98, 39, 0.5),
      box(0, 0, 40),
      box(12, 60, 3),
      box(-122, -33, 7),
      // Unwrapped past the seam — the shape a camera at lon 179 produces.
      { minLon: 176, maxLon: 184, minLat: -5, maxLat: 5 },
      // The explicit crossing encoding.
      { minLon: 170, maxLon: -170, minLat: 40, maxLat: 45 },
      // Whole world.
      { minLon: -180, maxLon: 180, minLat: -85, maxLat: 85 },
      // Latitudes past the mercator limit — must clamp, not blow up.
      { minLon: -20, maxLon: 20, minLat: -90, maxLat: 90 },
    ];
    for (const b of boxes) {
      for (let z = 0; z <= 10; z++) {
        expect(viewportCellCount(b, z)).toBe(enumerateCells(b, z).size);
      }
    }
  });

  it('measures an INVERTED latitude box as the band it brackets, not as zero', () => {
    // `boundsToTiles` orders the row span before clamping precisely so an
    // inverted box degrades to a band rather than to nothing. If the budget
    // did not order it too, a degenerate camera would measure as free and the
    // step-down would never fire on the one input most likely to need it.
    const ordered = { minLon: -10, maxLon: 10, minLat: 20, maxLat: 40 };
    const inverted = { minLon: -10, maxLon: 10, minLat: 40, maxLat: 20 };
    expect(viewportCellCount(inverted, 8)).toBe(viewportCellCount(ordered, 8));
    expect(viewportCellCount(inverted, 8)).toBeGreaterThan(0);
  });

  it('returns NaN rather than throwing on a non-finite box', () => {
    expect(
      viewportCellCount({ minLon: NaN, maxLon: 10, minLat: 0, maxLat: 1 }, 8),
    ).toBeNaN();
  });
});

describe('fitZoomToCellBudget', () => {
  /**
   * The ground footprint of an UNPITCHED 1600×900 camera at `zoom`, in
   * degrees. A viewport's footprint shrinks with zoom exactly as the tile grid
   * grows, which is why the on-screen tile count is zoom-invariant (~3.1 × 1.8
   * of deck's 512 px tiles here) — and why a single fixed budget can be inert
   * at every zoom rather than at one.
   */
  function flatCamera(zoom: number): BoundingBox {
    const degPerTile = 360 / 2 ** zoom;
    const b = box(-98, 39, Math.max((1600 / 512) * degPerTile, 1e-6));
    // Latitude clamped as `normalizeViewportBounds` clamps it, so the
    // zoomed-right-out cases stay the boxes a real chassis would hand down.
    return {
      ...b,
      minLat: Math.max(-90, b.minLat),
      maxLat: Math.min(90, b.maxLat),
    };
  }

  // The pitch-85 shape: a box that reaches the horizon band, so it is wide in
  // latitude while the frame it bounds is a few screen rows deep.
  const PITCHED = { minLon: -110, maxLon: -86, minLat: 39, maxLat: 62 };

  it('is inert for an unpitched camera at every zoom', () => {
    // The regression this guards: a budget that clamps a flat map is a silent
    // LOD downgrade across the whole demo fleet.
    for (let z = 0; z <= 14; z++) {
      const camera = flatCamera(z);
      expect(viewportCellCount(camera, z)).toBeLessThanOrEqual(
        DEFAULT_VIEWPORT_CELL_BUDGET,
      );
      expect(fitZoomToCellBudget(camera, z)).toBe(z);
      // ... and still inert one frame after a clamp, i.e. the hysteresis band
      // does not hold an ordinary camera down.
      expect(fitZoomToCellBudget(camera, z, { previousZoom: z - 1 })).toBe(z);
    }
  });

  it('steps down until it fits, and no further', () => {
    const fitted = fitZoomToCellBudget(PITCHED, 8);
    expect(fitted).toBeLessThan(8);
    expect(viewportCellCount(PITCHED, fitted)).toBeLessThanOrEqual(
      DEFAULT_VIEWPORT_CELL_BUDGET,
    );
    // "No further" is the half that matters: one zoom higher must genuinely
    // have been over budget, or the budget is costing resolution for nothing.
    expect(viewportCellCount(PITCHED, fitted + 1)).toBeGreaterThan(
      DEFAULT_VIEWPORT_CELL_BUDGET,
    );
  });

  it('never returns above the requested zoom, at any zoom or budget', () => {
    for (let z = 0; z <= 16; z++) {
      for (const maxCells of [1, 4, 64, 256, 10_000]) {
        expect(
          fitZoomToCellBudget(PITCHED, z, { maxCells }),
        ).toBeLessThanOrEqual(z);
      }
    }
  });

  it('is monotonic in the requested zoom', () => {
    // A camera zooming IN must never end up selecting a coarser tile than it
    // did one zoom out — that inversion would make a zoom gesture look like it
    // went backwards.
    let previous = -1;
    for (let z = 0; z <= 16; z++) {
      const fitted = fitZoomToCellBudget(PITCHED, z, { maxCells: 64 });
      expect(fitted).toBeGreaterThanOrEqual(previous);
      previous = fitted;
    }
  });

  it('never steps below minZoom, even when nothing fits there', () => {
    const world: BoundingBox = {
      minLon: -180,
      maxLon: 180,
      minLat: -85,
      maxLat: 85,
    };
    // At minZoom 6 the world is 4096 cells — far over any budget — and the
    // answer is still 6: a zoom with no tiles is a blank map, which is worse
    // than an expensive one.
    expect(fitZoomToCellBudget(world, 12, { minZoom: 6, maxCells: 8 })).toBe(6);
    expect(viewportCellCount(world, 6)).toBeGreaterThan(8);
    // And a request already at or below minZoom is passed through untouched.
    expect(fitZoomToCellBudget(world, 6, { minZoom: 6, maxCells: 8 })).toBe(6);
    expect(fitZoomToCellBudget(world, 3, { minZoom: 6, maxCells: 8 })).toBe(3);
  });

  it('is disabled by an infinite or non-positive budget', () => {
    expect(fitZoomToCellBudget(PITCHED, 8, { maxCells: Infinity })).toBe(8);
    expect(fitZoomToCellBudget(PITCHED, 8, { maxCells: NaN })).toBe(8);
    expect(fitZoomToCellBudget(PITCHED, 8, { maxCells: 0 })).toBe(8);
    expect(fitZoomToCellBudget(PITCHED, 8, { maxCells: -5 })).toBe(8);
  });

  it('keeps the requested zoom when the box is unmeasurable', () => {
    const bad = { minLon: NaN, maxLon: NaN, minLat: NaN, maxLat: NaN };
    expect(fitZoomToCellBudget(bad, 9, { maxCells: 4 })).toBe(9);
  });

  describe('hysteresis', () => {
    /**
     * A box whose cell count at z8 sits INSIDE the release band — over the
     * release threshold, under the cap. A camera here is exactly the one that
     * flaps: each frame's count crosses the cap by a cell or two either way.
     */
    function inBandBox(): BoundingBox {
      const release =
        DEFAULT_VIEWPORT_CELL_BUDGET * (1 - DEFAULT_CELL_BUDGET_HYSTERESIS);
      // Grow a box until its z8 count lands between the release threshold and
      // the cap, rather than hand-tuning a literal that a budget change breaks.
      for (let span = 1; span < 60; span += 0.05) {
        const b = box(-98, 39, span);
        const cells = viewportCellCount(b, 8);
        if (cells > release && cells <= DEFAULT_VIEWPORT_CELL_BUDGET) return b;
      }
      throw new Error('no in-band box found');
    }

    it('holds a clamped zoom down while the count is inside the band', () => {
      const b = inBandBox();
      // Unclamped, this box fits: the plain threshold returns the full zoom.
      expect(fitZoomToCellBudget(b, 8)).toBe(8);
      // Having clamped last frame, the same box does NOT release — it has to
      // fall all the way under the release threshold first.
      expect(fitZoomToCellBudget(b, 8, { previousZoom: 7 })).toBe(7);
    });

    it('releases once the count clears the release threshold', () => {
      const release =
        DEFAULT_VIEWPORT_CELL_BUDGET * (1 - DEFAULT_CELL_BUDGET_HYSTERESIS);
      const small = box(-98, 39, 2);
      expect(viewportCellCount(small, 8)).toBeLessThanOrEqual(release);
      expect(fitZoomToCellBudget(small, 8, { previousZoom: 7 })).toBe(8);
    });

    it('stops a camera oscillating across the cap from flapping the zoom', () => {
      // Drive 40 frames whose count alternates just under and just over the
      // cap. Without the band the result alternates every frame; with it, the
      // zoom settles after the first clamp and stays put.
      const release =
        DEFAULT_VIEWPORT_CELL_BUDGET * (1 - DEFAULT_CELL_BUDGET_HYSTERESIS);
      let under: BoundingBox | null = null;
      let over: BoundingBox | null = null;
      for (let span = 1; span < 60; span += 0.02) {
        const b = box(-98, 39, span);
        const cells = viewportCellCount(b, 8);
        if (!under && cells > release && cells <= DEFAULT_VIEWPORT_CELL_BUDGET)
          under = b;
        if (under && cells > DEFAULT_VIEWPORT_CELL_BUDGET) {
          over = b;
          break;
        }
      }
      expect(under).not.toBeNull();
      expect(over).not.toBeNull();

      const withBand: number[] = [];
      let previous: number | null = null;
      for (let frame = 0; frame < 40; frame++) {
        const b = (frame % 2 === 0 ? over : under) as BoundingBox;
        previous = fitZoomToCellBudget(b, 8, { previousZoom: previous });
        withBand.push(previous);
      }
      // One transition (8 → 7 on the first over-budget frame), then constant.
      expect(new Set(withBand.slice(1)).size).toBe(1);
      expect(withBand[withBand.length - 1]).toBe(7);

      // The control: with the band off, the same camera flaps every frame.
      const withoutBand: number[] = [];
      let prev2: number | null = null;
      for (let frame = 0; frame < 40; frame++) {
        const b = (frame % 2 === 0 ? over : under) as BoundingBox;
        prev2 = fitZoomToCellBudget(b, 8, {
          previousZoom: prev2,
          hysteresis: 0,
        });
        withoutBand.push(prev2);
      }
      expect(new Set(withoutBand).size).toBe(2);
    });

    it('does NOT ratchet a stationary camera down an extra zoom', () => {
      // The regression: the release threshold was applied to every rung of the
      // descent instead of to the release decision alone, so the zoom chosen on
      // frame 1 was re-judged against 0.75 × budget on frame 2 and stepped down
      // again — permanently, because `previousZoom < requested` stays true.
      //
      // This is the box a real 1600×900 deck viewport derives at lon -98 /
      // lat 39 / zoom 8 / pitch 85 — the four `maxPitch: 85` volumetric demos.
      // Its z7 count lands INSIDE the release band, which is what makes the
      // ratchet fire: 208 cells is comfortably under the 256 cap, so z7 is the
      // right answer on every frame, but it is over the 192 release threshold.
      const pitch85: BoundingBox = {
        minLon: -119.97,
        maxLon: -76.03,
        minLat: 36.67,
        maxLat: 60.23,
      };
      expect(viewportCellCount(pitch85, 8)).toBeGreaterThan(
        DEFAULT_VIEWPORT_CELL_BUDGET,
      );
      expect(viewportCellCount(pitch85, 7)).toBeLessThanOrEqual(
        DEFAULT_VIEWPORT_CELL_BUDGET,
      );
      expect(viewportCellCount(pitch85, 7)).toBeGreaterThan(
        DEFAULT_VIEWPORT_CELL_BUDGET * (1 - DEFAULT_CELL_BUDGET_HYSTERESIS),
      );

      // The camera never moves. Feed the answer back the way the chassis does
      // (`_budgetZoom` persists in layer state across frames).
      const seq: number[] = [];
      let previous: number | null = null;
      for (let frame = 0; frame < 8; frame++) {
        previous = fitZoomToCellBudget(pitch85, 8, { previousZoom: previous });
        seq.push(previous);
      }
      // Before the fix this printed 7,6,6,6,6,6,6,6 — a zoom flip on frame 2 of
      // a camera that never moved, i.e. exactly the `zoom !== lastSpatialZoom`
      // prefetch-runway flush the band exists to PREVENT, and then a 63-cell
      // steady state against a 256-cell budget.
      expect(seq).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
    });

    it('reaches a fixed point on the first frame for any static camera', () => {
      // The general form of the ratchet: for an unmoving box, frame 2 must
      // return what frame 1 returned. A budget whose output changes with no
      // input change is a re-selection the camera never asked for.
      const spans = [0.5, 2, 5, 11, 24, 47, 90];
      for (const span of spans) {
        for (const lat of [0, 39, 62]) {
          for (let z = 2; z <= 14; z++) {
            const b = box(-98, lat, span);
            const first = fitZoomToCellBudget(b, z);
            const second = fitZoomToCellBudget(b, z, { previousZoom: first });
            expect({ span, lat, z, first, second }).toEqual({
              span,
              lat,
              z,
              first,
              second: first,
            });
          }
        }
      }
    });

    it('tightens immediately when the count grows, band or no band', () => {
      // The band is one-directional. Releasing resolution is gated; TAKING it
      // is not — a camera that has just blown past the cap must clamp on the
      // frame it happens, not one frame later.
      const wide: BoundingBox = {
        minLon: -140,
        maxLon: -40,
        minLat: 10,
        maxLat: 70,
      };
      const plain = fitZoomToCellBudget(wide, 8);
      expect(viewportCellCount(wide, plain)).toBeLessThanOrEqual(
        DEFAULT_VIEWPORT_CELL_BUDGET,
      );
      // Held at a zoom the plain cap can no longer justify: step down to the
      // cap's answer this frame, not to something coarser and not next frame.
      expect(fitZoomToCellBudget(wide, 8, { previousZoom: plain + 1 })).toBe(
        plain,
      );
    });

    it('ignores a previousZoom at or above the requested zoom', () => {
      // Arriving from a higher zoom is not "clamped last frame", so the plain
      // cap applies and the budget cannot fire on a count it would tolerate.
      const b = inBandBox();
      expect(fitZoomToCellBudget(b, 8, { previousZoom: 8 })).toBe(8);
      expect(fitZoomToCellBudget(b, 8, { previousZoom: 11 })).toBe(8);
      expect(fitZoomToCellBudget(b, 8, { previousZoom: null })).toBe(8);
      expect(fitZoomToCellBudget(b, 8, { previousZoom: NaN })).toBe(8);
    });
  });
});
