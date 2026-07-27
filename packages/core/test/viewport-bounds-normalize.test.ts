/**
 * The shared camera→bounds repair (`geo/viewport-bounds.ts`).
 *
 * Every backend can hand tile selection a DEGENERATE box for a camera that is
 * ordinary to a user — a rotated map, a tilted map, a globe camera looking past
 * the limb. Before 2026-07-26 those boxes reached `boundsToTiles` unchecked and
 * failed silently and totally: an inverted latitude box makes the row loop body
 * never execute (zero tiles, while every readiness signal reports "settled and
 * fully buffered"), and an inverted longitude box is indistinguishable from the
 * deliberate antimeridian crossing encoding (510 of 512 columns at z9).
 *
 * See `docs/roadmap/tile-loading-3d-2026-07.md` §4.1 for the binding contract.
 *
 * The tension this file pins down: rule 3 has to keep a GENUINE seam crossing
 * (`minLon > maxLon`, a real and load-bearing encoding here) while rejecting an
 * INVERTED box, which looks identical from the pair alone. Only the implied
 * width separates them.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeViewportBounds,
  boundsFromCorners,
  MAX_SEAM_SPAN_DEG,
} from '../src/geo/viewport-bounds';
import { MAX_MERCATOR_LAT } from '../src/geo/mercator';

describe('normalizeViewportBounds — rejection', () => {
  it.each([
    ['minLon', { minLon: NaN, minLat: 0, maxLon: 1, maxLat: 1 }],
    ['minLat', { minLon: 0, minLat: NaN, maxLon: 1, maxLat: 1 }],
    ['maxLon', { minLon: 0, minLat: 0, maxLon: Infinity, maxLat: 1 }],
    ['maxLat', { minLon: 0, minLat: 0, maxLon: 1, maxLat: -Infinity }],
  ])('rejects a box with non-finite %s', (_name, bounds) => {
    // null is the signal to KEEP THE PREVIOUS VIEWPORT. Selecting against
    // garbage is strictly worse than selecting against a slightly stale box.
    expect(normalizeViewportBounds(bounds)).toBeNull();
  });
});

describe('normalizeViewportBounds — latitude', () => {
  it('passes a well-formed box through untouched, with no issues', () => {
    const bounds = { minLon: -98, minLat: 34, maxLon: -96, maxLat: 36 };
    const out = normalizeViewportBounds(bounds)!;
    expect(out.bounds).toEqual(bounds);
    expect(out.issues).toEqual([]);
  });

  it('swaps an inverted latitude pair — the bearing > atan2(h,w) case', () => {
    // What a 1000x1000 canvas at bearing 90 actually produced: the two sampled
    // diagonal corners come back in the wrong order and minLat > maxLat.
    const out = normalizeViewportBounds({
      minLon: -97.687,
      minLat: 35.561,
      maxLon: -96.313,
      maxLat: 34.436,
    })!;
    expect(out.bounds.minLat).toBeCloseTo(34.436, 3);
    expect(out.bounds.maxLat).toBeCloseTo(35.561, 3);
    expect(out.issues).toContain('inverted-lat');
  });

  it('swaps BEFORE clamping, so an inverted out-of-range box is not baked in', () => {
    // Order matters: clamping first would turn {min: 95, max: -95} into
    // {min: -LIMIT, max: -95}, which is still inverted and now also wrong.
    const out = normalizeViewportBounds({
      minLon: 0,
      minLat: 95,
      maxLon: 10,
      maxLat: -95,
    })!;
    expect(out.bounds.minLat).toBe(-MAX_MERCATOR_LAT);
    expect(out.bounds.maxLat).toBe(MAX_MERCATOR_LAT);
    expect(out.issues).toEqual(
      expect.arrayContaining(['inverted-lat', 'clamped-lat']),
    );
  });

  it('clamps latitude to the Mercator edge without reporting an inversion', () => {
    // The clamp target is ±MAX_MERCATOR_LAT, NOT ±90: `latToTileY` returns NaN
    // in the sliver just inside the poles, which selects zero tiles. See
    // polar-tile-row-collapse.test.ts.
    const out = normalizeViewportBounds({
      minLon: 0,
      minLat: -120,
      maxLon: 10,
      maxLat: 120,
    })!;
    expect(out.bounds.minLat).toBe(-MAX_MERCATOR_LAT);
    expect(out.bounds.maxLat).toBe(MAX_MERCATOR_LAT);
    expect(out.issues).toContain('clamped-lat');
    expect(out.issues).not.toContain('inverted-lat');
  });

  it('leaves a degenerate-but-ordered latitude pair alone', () => {
    // minLat === maxLat is thin, not invalid: `boundsToTiles` still yields the
    // single row that contains it. Repairing it would be inventing coverage.
    const out = normalizeViewportBounds({
      minLon: -98,
      minLat: 35,
      maxLon: -96,
      maxLat: 35,
    })!;
    expect(out.bounds.minLat).toBe(35);
    expect(out.bounds.maxLat).toBe(35);
    expect(out.issues).toEqual([]);
  });
});

describe('normalizeViewportBounds — longitude, the seam-vs-inversion split', () => {
  it('KEEPS a genuine antimeridian crossing (narrow implied span)', () => {
    // A camera at lon 179 spanning ~20°: minLon 172, maxLon -168. This is the
    // crossing encoding and it MUST survive — `tileXSpanForLonRange` relies on
    // it to emit columns from both edges of the world.
    const out = normalizeViewportBounds({
      minLon: 172,
      minLat: 30,
      maxLon: -168,
      maxLat: 40,
    })!;
    expect(out.bounds.minLon).toBe(172);
    expect(out.bounds.maxLon).toBe(-168);
    expect(out.issues).not.toContain('inverted-lon');
  });

  it('KEEPS a wide-but-believable crossing just under the threshold', () => {
    // implied span = maxLon - minLon + 360
    const minLon = 10;
    const maxLon = minLon + (MAX_SEAM_SPAN_DEG - 1) - 360; // implied = 349
    const out = normalizeViewportBounds({
      minLon,
      minLat: 0,
      maxLon,
      maxLat: 10,
    })!;
    expect(out.issues).not.toContain('inverted-lon');
    expect(out.bounds.minLon).toBe(minLon);
  });

  it('REJECTS an inverted longitude pair — the pitch > 71.57 case', () => {
    // What pitch 75 actually produced: lon[-97.306, -99.814]. Implied span
    // 357.5° — no camera sees that while also crossing the seam.
    const out = normalizeViewportBounds({
      minLon: -97.306,
      minLat: 33.9,
      maxLon: -99.814,
      maxLat: 34.2,
    })!;
    expect(out.bounds.minLon).toBeCloseTo(-99.814, 3);
    expect(out.bounds.maxLon).toBeCloseTo(-97.306, 3);
    expect(out.issues).toContain('inverted-lon');
  });

  it('does NOT re-clamp unwrapped longitude — the seam regression guard', () => {
    // `unproject` reports maxLon 184 for a camera centred at lon 179. Clamping
    // into [-180, 180] here is what used to blank the right half of the screen
    // on `ais-all-us` and `drifters`. The core scan wraps at emit; leave it be.
    const out = normalizeViewportBounds({
      minLon: 174,
      minLat: 30,
      maxLon: 184,
      maxLat: 40,
    })!;
    expect(out.bounds.minLon).toBe(174);
    expect(out.bounds.maxLon).toBe(184);
    expect(out.issues).toEqual([]);
  });

  it('normalises a full-world span to exactly [-180, 180]', () => {
    const out = normalizeViewportBounds({
      minLon: -200,
      minLat: -60,
      maxLon: 200,
      maxLat: 60,
    })!;
    expect(out.bounds.minLon).toBe(-180);
    expect(out.bounds.maxLon).toBe(180);
    expect(out.issues).toContain('full-world');
  });

  it('handles a box that is inverted in BOTH axes at once', () => {
    // pitch 75 + bearing 90 produced exactly this shape.
    const out = normalizeViewportBounds({
      minLon: -97.3,
      minLat: 35.5,
      maxLon: -99.8,
      maxLat: 34.4,
    })!;
    expect(out.bounds.minLon).toBeLessThan(out.bounds.maxLon);
    expect(out.bounds.minLat).toBeLessThan(out.bounds.maxLat);
    expect(out.issues).toEqual(
      expect.arrayContaining(['inverted-lat', 'inverted-lon']),
    );
  });
});

describe('normalizeViewportBounds — the downstream invariant', () => {
  it('never emits minLat > maxLat, over a wide sweep of hostile boxes', () => {
    // This is the property that actually matters: `boundsToTiles` iterates
    // `for (y = minY; y <= maxY; y++)`, so minLat > maxLat means ZERO TILES.
    for (const minLat of [-95, -40, 0, 40, 95]) {
      for (const maxLat of [-95, -40, 0, 40, 95]) {
        for (const [minLon, maxLon] of [
          [-10, 10],
          [10, -10],
          [174, 184],
          [172, -168],
          [-200, 200],
        ]) {
          const out = normalizeViewportBounds({
            minLon,
            minLat,
            maxLon,
            maxLat,
          });
          expect(out).not.toBeNull();
          expect(out!.bounds.minLat).toBeLessThanOrEqual(out!.bounds.maxLat);
          expect(out!.bounds.minLat).toBeGreaterThanOrEqual(-90);
          expect(out!.bounds.maxLat).toBeLessThanOrEqual(90);
        }
      }
    }
  });

  it('is idempotent — normalising a normalised box changes nothing', () => {
    const hostile = {
      minLon: -97.3,
      minLat: 35.5,
      maxLon: -99.8,
      maxLat: 34.4,
    };
    const once = normalizeViewportBounds(hostile)!;
    const twice = normalizeViewportBounds(once.bounds)!;
    expect(twice.bounds).toEqual(once.bounds);
    expect(twice.issues).toEqual([]);
  });
});

describe('boundsFromCorners', () => {
  it('bounds all four corners, not just the diagonal pair', () => {
    // The whole point: a rotated quad's AABB is decided by the corners the old
    // two-sample code never looked at.
    const rotated: Array<[number, number]> = [
      [-97.0, 35.8],
      [-97.9, 35.0],
      [-97.0, 34.2],
      [-96.1, 35.0],
    ];
    const b = boundsFromCorners(rotated)!;
    expect(b.minLon).toBeCloseTo(-97.9, 6);
    expect(b.maxLon).toBeCloseTo(-96.1, 6);
    expect(b.minLat).toBeCloseTo(34.2, 6);
    expect(b.maxLat).toBeCloseTo(35.8, 6);
  });

  it('skips non-finite components PER AXIS, keeping the conservative superset', () => {
    // three drops above-horizon rays; cesium substitutes a horizon quad. A
    // partially-degenerate corner still contributes the axis it can prove —
    // over-covering costs a fetch, under-covering costs a blank region.
    const b = boundsFromCorners([
      [-97, 35],
      [NaN, 36],
      [-96, Infinity],
      [-98, 34],
    ])!;
    expect(b.minLon).toBe(-98);
    expect(b.maxLon).toBe(-96); // from the corner whose LAT diverged
    expect(b.minLat).toBe(34);
    expect(b.maxLat).toBe(36); // from the corner whose LON diverged
  });

  it('returns null when either axis has no finite sample', () => {
    expect(boundsFromCorners([])).toBeNull();
    expect(
      boundsFromCorners([
        [NaN, NaN],
        [Infinity, -Infinity],
      ]),
    ).toBeNull();
    // longitudes present, no usable latitude at all ⇒ still unusable
    expect(
      boundsFromCorners([
        [-97, NaN],
        [-96, Infinity],
      ]),
    ).toBeNull();
  });

  it('preserves unwrapped longitude', () => {
    const b = boundsFromCorners([
      [174, 30],
      [184, 30],
      [184, 40],
      [174, 40],
    ])!;
    expect(b.minLon).toBe(174);
    expect(b.maxLon).toBe(184);
  });
});
