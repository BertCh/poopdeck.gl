// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `lib/edge-bundler.ts` — the `liveBundling` capability for the Cesium backend.
 *
 * This module deliberately owns NO KDEEB iteration of its own: the splat →
 * advect → resample → smooth → anneal schedule lives once, in
 * `@poopdeck.gl/core/edge-bundling`, and is already covered by 25 tests there
 * (including that neighbouring edges genuinely attract and a lone edge does
 * not). Re-testing the physics here would be re-testing core.
 *
 * So what is pinned here is the part that is actually this backend's: the two
 * MAPPINGS either side of the shared kernel, and the ribbon extruded along the
 * result.
 *
 *  - **The wiring is pinned to `bundleEdges` itself.** The headline test
 *    re-derives the work-box normalization independently, calls core's
 *    `bundleEdges` directly, maps the result back by hand, and requires
 *    `bundleFlows` to have produced exactly that. A second implementation
 *    sneaking in here would fail it; so would a drifted constant.
 *  - **The mapping round-trips.** At `bundlingIterations: 0` the relaxation is
 *    an identity, so the output must be the input chords resampled — to
 *    floating-point noise, in lon/lat, INCLUDING the `cos(meanLat)` squeeze.
 *    That isolates the normalize/un-normalize pair from the physics.
 *  - **Bundling is refused, never approximated.** Under 2 edges, over the cap,
 *    under 3 control points, or a degenerate extent all return `null` — the
 *    caller's signal to draw straight arrows — and nothing partially bundles.
 *  - **The bundled ribbon IS the straight ribbon when the river is straight.**
 *    Byte-comparable against `buildArrowRibbon` on a constant-latitude chord,
 *    which is the one geometry where arc-length stations and chord fractions
 *    coincide exactly. This is what proves the swap in `bake()` is a swap and
 *    not a redesign.
 *  - **A bent river bends the ribbon, and still lands on the destination.**
 *    The apex is exactly the target vertex, bundled or not — a bundle that
 *    walks the arrowhead off its station is a bundle that lies about the data.
 *
 * Everything here runs in plain Node: the module imports no Cesium.
 */

import { describe, it, expect } from 'vitest';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import {
  BUNDLING_WORK_SIZE,
  bundleEdges,
} from '@poopdeck.gl/core/edge-bundling';
import { GeometryType } from '@poopdeck.gl/core';
import type { Tile } from '@poopdeck.gl/core';
import { buildArrowRibbon, buildFlowmapFlows } from '../src/lib/flowmap';
import {
  DEFAULT_DENSITY_RESOLUTION,
  DEFAULT_KERNEL_RADIUS,
  DEFAULT_MAX_BUNDLED_EDGES,
  DEFAULT_SMOOTHING_STRENGTH,
  DEFAULT_SUBDIVISION_POINTS,
  buildBundledArrowRibbon,
  bundleFlows,
  bundledPath,
  workBoxMargin,
  type FlowEndpoints,
} from '../src/lib/edge-bundler';

// Byte-identical to the builder's own GLOBE — the datum is the point.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

function od(
  srcLon: number,
  srcLat: number,
  tgtLon: number,
  tgtLat: number,
): FlowEndpoints {
  return { srcLon, srcLat, tgtLon, tgtLat, srcAlt: 0, tgtAlt: 0 };
}

/**
 * The classic KDEEB fixture: origins spread along a north-south line all
 * converging on ONE destination 2° east. Every edge shares the approach, so the
 * middles have something to bundle into while the pinned origins stay fanned —
 * the "delta" silhouette the method is known for.
 */
function fan(count: number, spread = 0.15): FlowEndpoints[] {
  const flows: FlowEndpoints[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    flows.push(od(10, 45 + (t - 0.5) * 2 * spread, 12, 45));
  }
  return flows;
}

/** Point `i` of bundled edge `e`, as `[lon, lat]`. */
function pt(
  points: Float64Array,
  pointsPerEdge: number,
  e: number,
  i: number,
): [number, number] {
  const o = (e * pointsPerEdge + i) * 2;
  return [points[o], points[o + 1]];
}

function vertexAt(pos: Float64Array, i: number): [number, number, number] {
  return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
}

function dist3(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('bundleFlows — pinned to core `bundleEdges`', () => {
  it('reproduces an independent normalize → bundleEdges → un-normalize by hand', () => {
    const flows = fan(9);
    const P = 12;
    const opts = {
      subdivisionPoints: P,
      bundlingIterations: 4,
      densityResolution: 64,
    };
    const bundle = bundleFlows(flows, opts);
    expect(bundle).not.toBeNull();

    // ── the same mapping, re-derived here from first principles ──────────────
    const E = flows.length;
    let latSum = 0;
    for (const f of flows) latSum += f.srcLat + f.tgtLat;
    const cosLat0 = Math.max(0.1, Math.cos((latSum / (2 * E) / 180) * Math.PI));
    const work = new Float64Array(E * P * 2);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let e = 0; e < E; e++) {
      const f = flows[e];
      const ax = f.srcLon * cosLat0;
      const ay = f.srcLat;
      const bx = f.tgtLon * cosLat0;
      const by = f.tgtLat;
      for (let i = 0; i < P; i++) {
        const t = i / (P - 1);
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        work[(e * P + i) * 2] = x;
        work[(e * P + i) * 2 + 1] = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const extent = Math.max(maxX - minX, maxY - minY);
    const margin = workBoxMargin(64);
    const scale = (BUNDLING_WORK_SIZE - 2 * margin) / extent;
    for (let p = 0; p < E * P; p++) {
      work[p * 2] = margin + (work[p * 2] - minX) * scale;
      work[p * 2 + 1] = margin + (work[p * 2 + 1] - minY) * scale;
    }
    const expected = bundleEdges(work, E, P, {
      iterations: 4,
      kernelRadius: BUNDLING_WORK_SIZE * DEFAULT_KERNEL_RADIUS,
      smoothing: DEFAULT_SMOOTHING_STRENGTH,
      densityResolution: 64,
    });

    // The mapping metadata must agree exactly — a drifted cosLat0 or extent
    // would move every river without changing the kernel.
    expect(bundle!.cosLat0).toBe(cosLat0);
    expect(bundle!.originX).toBe(minX);
    expect(bundle!.originY).toBe(minY);
    expect(bundle!.scale).toBe(scale);
    expect(bundle!.margin).toBe(margin);
    expect(bundle!.edgeCount).toBe(E);
    expect(bundle!.pointsPerEdge).toBe(P);

    for (let p = 0; p < E * P; p++) {
      expect(bundle!.points[p * 2]).toBeCloseTo(
        ((expected[p * 2] - margin) / scale + minX) / cosLat0,
        10,
      );
      expect(bundle!.points[p * 2 + 1]).toBeCloseTo(
        (expected[p * 2 + 1] - margin) / scale + minY,
        10,
      );
    }
  });

  it('is deterministic — the same flows bundle to byte-identical rivers', () => {
    const flows = fan(7);
    const a = bundleFlows(flows, {
      subdivisionPoints: 10,
      densityResolution: 64,
    });
    const b = bundleFlows(flows, {
      subdivisionPoints: 10,
      densityResolution: 64,
    });
    expect(a).not.toBeNull();
    expect(Array.from(a!.points)).toEqual(Array.from(b!.points));
  });

  it('never mutates the flows it is handed', () => {
    const flows = fan(5);
    const before = flows.map((f) => ({ ...f }));
    bundleFlows(flows, { subdivisionPoints: 8, densityResolution: 64 });
    expect(flows).toEqual(before);
  });
});

describe('bundleFlows — the lon/lat mapping, isolated from the physics', () => {
  it('round-trips the chords exactly when the relaxation is a no-op', () => {
    // 0 iterations makes `bundleEdges` an identity, so anything but the input
    // chords back is the normalize/un-normalize pair being wrong.
    const flows = [
      od(10, 45, 12, 47),
      od(11, 44, 13, 46),
      od(10.5, 46, 12.5, 44),
    ];
    const P = 9;
    const bundle = bundleFlows(flows, {
      subdivisionPoints: P,
      bundlingIterations: 0,
    });
    expect(bundle).not.toBeNull();
    for (let e = 0; e < flows.length; e++) {
      const f = flows[e];
      for (let i = 0; i < P; i++) {
        const t = i / (P - 1);
        const [lon, lat] = pt(bundle!.points, P, e, i);
        expect(lon).toBeCloseTo(f.srcLon + (f.tgtLon - f.srcLon) * t, 9);
        expect(lat).toBeCloseTo(f.srcLat + (f.tgtLat - f.srcLat) * t, 9);
      }
    }
  });

  it('squeezes longitude by cos(mean latitude) so the box is isotropic in metres', () => {
    const flows = fan(4);
    const bundle = bundleFlows(flows, { subdivisionPoints: 8 });
    expect(bundle).not.toBeNull();
    // All eight endpoints sit at latitude 45 ± spread, mean exactly 45.
    expect(bundle!.cosLat0).toBeCloseTo(Math.cos((45 / 180) * Math.PI), 12);
    // ...and the origin is the corrected-space minimum, not the raw one.
    expect(bundle!.originX).toBeCloseTo(10 * bundle!.cosLat0, 12);
  });

  it('pins both endpoints of every river to the flow they came from', () => {
    const flows = fan(11);
    const P = 16;
    const bundle = bundleFlows(flows, {
      subdivisionPoints: P,
      densityResolution: 64,
    });
    expect(bundle).not.toBeNull();
    for (let e = 0; e < flows.length; e++) {
      const first = pt(bundle!.points, P, e, 0);
      const last = pt(bundle!.points, P, e, P - 1);
      expect(first[0]).toBeCloseTo(flows[e].srcLon, 9);
      expect(first[1]).toBeCloseTo(flows[e].srcLat, 9);
      expect(last[0]).toBeCloseTo(flows[e].tgtLon, 9);
      expect(last[1]).toBeCloseTo(flows[e].tgtLat, 9);
    }
  });

  it('draws neighbouring flows together in LON/LAT, not merely in work space', () => {
    // The attraction itself is core's; what this asserts is that the mapping
    // back does not undo it. Midpoint latitudes of a parallel fan must close up.
    const flows = fan(11);
    const P = 16;
    const bundle = bundleFlows(flows, {
      subdivisionPoints: P,
      densityResolution: 128,
    });
    expect(bundle).not.toBeNull();
    const mid = P >> 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (let e = 0; e < flows.length; e++) {
      const lat = pt(bundle!.points, P, e, mid)[1];
      if (lat < lo) lo = lat;
      if (lat > hi) hi = lat;
    }
    // The straight chords are still spread by the full fan at their midpoints;
    // bundled, they collapse into one approach.
    const before = 2 * 0.15;
    expect(hi - lo).toBeLessThan(before * 0.1);
  });
});

describe('workBoxMargin — the correction that keeps edges off the dead border', () => {
  it("is two density cells, with a floor matching core's own resolution floor", () => {
    expect(workBoxMargin(128)).toBeCloseTo((2 * BUNDLING_WORK_SIZE) / 128, 12);
    expect(workBoxMargin(64)).toBeCloseTo((2 * BUNDLING_WORK_SIZE) / 64, 12);
    // core clamps `densityResolution` up to 16; the margin must clamp with it,
    // or the inset would be computed for a grid that is not the one used.
    expect(workBoxMargin(4)).toBe(workBoxMargin(16));
  });

  it('rescues the outermost edges, which a min-anchored box strands', () => {
    // A parallel fan: every edge is a horizontal line, so the extreme edges sit
    // exactly on the box's y boundary under deck's min-anchored mapping — inside
    // the 1.5-cell band where core's advect refuses to sample a gradient.
    const E = 11;
    const P = 16;
    const res = 128;
    const flows: FlowEndpoints[] = [];
    for (let i = 0; i < E; i++) {
      const lat = 45 + (i / (E - 1) - 0.5) * 0.3;
      flows.push(od(10, lat, 12, lat));
    }

    // The margined mapping this module actually ships.
    const bundle = bundleFlows(flows, {
      subdivisionPoints: P,
      densityResolution: res,
    })!;
    const mid = P >> 1;
    const moved = Math.abs(pt(bundle.points, P, 0, mid)[1] - flows[0].srcLat);

    // The SAME relaxation with deck\'s un-inset box, driven straight through
    // core — the outermost edge cannot move at all.
    const work = new Float64Array(E * P * 2);
    const minY = flows[0].srcLat;
    const scale = BUNDLING_WORK_SIZE / (flows[E - 1].srcLat - minY);
    for (let e = 0; e < E; e++) {
      for (let i = 0; i < P; i++) {
        work[(e * P + i) * 2] = (i / (P - 1)) * BUNDLING_WORK_SIZE;
        work[(e * P + i) * 2 + 1] = (flows[e].srcLat - minY) * scale;
      }
    }
    const unInset = bundleEdges(work, E, P, {
      densityResolution: res,
      kernelRadius: BUNDLING_WORK_SIZE * DEFAULT_KERNEL_RADIUS,
      smoothing: DEFAULT_SMOOTHING_STRENGTH,
    });
    // Edge 0's midpoint, still at work-space y = 0: stranded, exactly zero.
    expect(unInset[mid * 2 + 1]).toBe(0);

    // ...whereas the shipped mapping moves it a visible fraction of the fan.
    expect(moved).toBeGreaterThan(0.02);
  });
});

describe('bundleFlows — the contract with `lib/flowmap.ts`', () => {
  it('takes a FlowmapFlow directly, edge `e` staying flow `e`', () => {
    // `bake()` indexes the bundle with the SAME counter it indexes `build.flows`
    // with, so any reordering or filtering here would silently extrude the wrong
    // arrow along the wrong river.
    const lines = [
      [10, 44.9, 12, 45],
      [10, 45, 12, 45],
      [10, 45.1, 12, 45],
      [10, 45.2, 12, 45],
    ];
    const startIndices = new Uint32Array([0, 2, 4, 6, 8]);
    const positions = new Float64Array(lines.flat());
    const build = buildFlowmapFlows([
      {
        id: { z: 12, x: 0, y: 0, t: 0 },
        timeRange: { start: 0, end: 1000 },
        layers: [
          {
            name: 'flows',
            extent: 0,
            geometryExtensionName: 'geoarrow.linestring',
            features: {
              featureCount: lines.length,
              geometryType: GeometryType.LineString,
              positionDimensions: 2,
              positions,
              startIndices,
              featureIds: new Uint32Array(lines.length),
              startTimes: new Float32Array(lines.length),
              endTimes: new Float32Array(lines.length).fill(1000),
              timeOffset: 0,
              numericProps: { flow: new Float32Array([3, 4, 5, 6]) },
              categoricalProps: {},
              vectorProps: {},
            },
          },
        ],
      } as unknown as Tile,
    ]);
    expect(build.flows.length).toBe(4);

    const P = 12;
    const bundle = bundleFlows(build.flows, { subdivisionPoints: P })!;
    expect(bundle.edgeCount).toBe(4);
    for (let e = 0; e < 4; e++) {
      expect(pt(bundle.points, P, e, 0)[1]).toBeCloseTo(
        build.flows[e].srcLat,
        9,
      );
      expect(pt(bundle.points, P, e, P - 1)[1]).toBeCloseTo(
        build.flows[e].tgtLat,
        9,
      );
    }
  });
});

describe('bundleFlows — the refusals (the caller draws straight arrows)', () => {
  it('refuses a single edge: there is nothing to bundle toward', () => {
    expect(bundleFlows(fan(1))).toBeNull();
    expect(bundleFlows([])).toBeNull();
  });

  it('refuses outright past maxBundledEdges — it never bundles a subset', () => {
    const flows = fan(6);
    expect(bundleFlows(flows, { maxBundledEdges: 5 })).toBeNull();
    expect(bundleFlows(flows, { maxBundledEdges: 6 })).not.toBeNull();
  });

  it('refuses fewer than 3 control points: no interior to advect', () => {
    expect(bundleFlows(fan(4), { subdivisionPoints: 2 })).toBeNull();
    expect(bundleFlows(fan(4), { subdivisionPoints: 3 })).not.toBeNull();
  });

  it('refuses a degenerate extent instead of dividing by it', () => {
    const flows = [od(10, 45, 10, 45), od(10, 45, 10, 45)];
    expect(bundleFlows(flows)).toBeNull();
  });

  it('ships a cap that matches the documented cost table', () => {
    // The header's measured ≈0.28 ms/edge makes 1000 edges a ~280 ms hitch.
    // If this constant moves, the header's cost story has to move with it.
    expect(DEFAULT_MAX_BUNDLED_EDGES).toBe(1000);
    expect(DEFAULT_SUBDIVISION_POINTS).toBe(24);
    expect(DEFAULT_DENSITY_RESOLUTION).toBe(128);
  });
});

describe('bundledPath', () => {
  it('copies one river out, and refuses an out-of-range edge', () => {
    const bundle = bundleFlows(fan(4), { subdivisionPoints: 7 })!;
    expect(bundledPath(bundle, 0)!.length).toBe(14);
    expect(bundledPath(bundle, -1)).toBeNull();
    expect(bundledPath(bundle, 4)).toBeNull();
  });
});

describe('buildBundledArrowRibbon', () => {
  const WIDTH = 400;
  const RIBBON_OPTS = { shaftSegments: 6 };

  it('equals the straight builder when the river is straight', () => {
    // Constant latitude is the one geometry where the bundled builder's
    // arc-length stations and the straight builder's chord fractions coincide
    // EXACTLY (cos(lat) is constant along the chord), so this is an equality
    // rather than an approximation.
    const flows = [od(10, 45, 12, 45), od(20, 45, 22, 45)];
    const P = 12;
    const bundle = bundleFlows(flows, {
      subdivisionPoints: P,
      bundlingIterations: 0, // identity → straight rivers
    })!;

    for (let e = 0; e < flows.length; e++) {
      for (const gap of [0, 150, -150]) {
        const bundled = buildBundledArrowRibbon(
          bundle,
          e,
          flows[e],
          WIDTH,
          RIBBON_OPTS,
          gap,
        )!;
        const straight = buildArrowRibbon(flows[e], WIDTH, RIBBON_OPTS, gap)!;
        expect(bundled.indices).toEqual(straight.indices);
        expect(bundled.positions.length).toBe(straight.positions.length);
        for (let i = 0; i < bundled.positions.length / 3; i++) {
          // Sub-millimetre agreement on ECEF metres.
          expect(
            dist3(
              vertexAt(bundled.positions, i),
              vertexAt(straight.positions, i),
            ),
          ).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('flips the twin ribbon when the endpoints reverse', () => {
    const there = od(10, 45, 12, 45);
    const back = od(12, 45, 10, 45);
    const bundle = bundleFlows([there, back], {
      subdivisionPoints: 12,
      bundlingIterations: 0,
    })!;
    const centre = GLOBE.project(11, 45, 0);
    const a = buildBundledArrowRibbon(
      bundle,
      0,
      there,
      WIDTH,
      RIBBON_OPTS,
      500,
    )!;
    const b = buildBundledArrowRibbon(
      bundle,
      1,
      back,
      WIDTH,
      RIBBON_OPTS,
      500,
    )!;
    // Mid-shaft rails of the two directions must straddle the centreline: their
    // midpoints sit on opposite sides, so the segment between them spans it.
    const midA = vertexAt(a.positions, 6);
    const midB = vertexAt(b.positions, 6);
    expect(dist3(midA, midB)).toBeGreaterThan(700);
    expect(dist3(midA, centre)).toBeGreaterThan(300);
    expect(dist3(midB, centre)).toBeGreaterThan(300);
  });

  it('keeps the arrowhead apex exactly on the destination', () => {
    const flows = fan(9);
    const P = 14;
    const bundle = bundleFlows(flows, {
      subdivisionPoints: P,
      densityResolution: 64,
    })!;
    for (let e = 0; e < flows.length; e++) {
      const ribbon = buildBundledArrowRibbon(
        bundle,
        e,
        flows[e],
        WIDTH,
        RIBBON_OPTS,
        0,
      )!;
      const apex = vertexAt(ribbon.positions, 2 * (6 + 1) + 2);
      const target = GLOBE.project(flows[e].tgtLon, flows[e].tgtLat, 0);
      expect(dist3(apex, target)).toBeLessThan(1e-3);
    }
  });

  it('bends the shaft off the chord once the river is bundled', () => {
    const flows = fan(11);
    const P = 16;
    const bundle = bundleFlows(flows, {
      subdivisionPoints: P,
      densityResolution: 128,
    })!;
    // The outermost flow is the one pulled furthest toward the corridor.
    const e = 0;
    const bundled = buildBundledArrowRibbon(
      bundle,
      e,
      flows[e],
      WIDTH,
      RIBBON_OPTS,
      0,
    )!;
    const straight = buildArrowRibbon(flows[e], WIDTH, RIBBON_OPTS, 0)!;
    const mid = 6; // a mid-shaft rail vertex
    expect(
      dist3(
        vertexAt(bundled.positions, mid),
        vertexAt(straight.positions, mid),
      ),
    ).toBeGreaterThan(1000); // > 1 km off the straight chord
  });

  it('returns null for a non-positive width or an out-of-range edge', () => {
    const flows = fan(4);
    const bundle = bundleFlows(flows, { subdivisionPoints: 8 })!;
    expect(buildBundledArrowRibbon(bundle, 0, flows[0], 0)).toBeNull();
    expect(buildBundledArrowRibbon(bundle, 0, flows[0], -5)).toBeNull();
    expect(buildBundledArrowRibbon(bundle, 9, flows[0], WIDTH)).toBeNull();
    expect(buildBundledArrowRibbon(bundle, -1, flows[0], WIDTH)).toBeNull();
  });

  it('returns null for a zero-length river, like the straight builder does', () => {
    const flows = [od(10, 45, 10, 45), od(12, 46, 14, 48)];
    const bundle = bundleFlows(flows, {
      subdivisionPoints: 8,
      bundlingIterations: 0,
    })!;
    expect(buildBundledArrowRibbon(bundle, 0, flows[0], WIDTH)).toBeNull();
    expect(buildBundledArrowRibbon(bundle, 1, flows[1], WIDTH)).not.toBeNull();
  });
});
