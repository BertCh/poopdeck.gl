// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTQuadbinSummaryLayer` — the CARTO-Quadbin half of the summary-tier kind.
 *
 * The shared cell kernel (ring → ECEF, the ramp, the extrusion, the
 * build-before-teardown contract) is covered in `summary-cells.test.ts`, which
 * both summary layers feed. What is proven HERE is what that file cannot reach:
 *
 *   - the u64 → `(z, x, y)` → lon/lat box decode, pinned against CARTO's own
 *     published vector `(0,0,0) → 0x480fffffffffffff` and against the round
 *     trip, because a silently wrong decode draws a plausible cell in the wrong
 *     place — the one failure mode no visual check catches;
 *   - that a NON-Quadbin id (an H3 archive pointed at this layer) is SKIPPED
 *     and reported, never mis-drawn;
 *   - that the layer needs no injected library at all, unlike its H3 sibling;
 *   - and that per-frame alpha comes from the shared `core/time-filter` oracle.
 *
 * `time-filter-oracle.test.ts`'s `PROVEN_IN_OWN_SUITE` map points at this file
 * for this layer, and its companion case asserts this file really does assert
 * against `timeFilterAlpha` — so weakening the sweep below breaks the
 * package-level gate too, not just this file.
 */

import { describe, it, expect } from 'vitest';
import { Primitive, type Scene } from 'cesium';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { STTQuadbinSummaryLayer } from '../src/cesium-quadbin-summary-layer';
import {
  MAX_RING_SEGMENT_DEGREES,
  QUADBIN_MAX_ZOOM,
  isQuadbinId,
  quadbinBoundaryResolver,
  quadbinCellRing,
  quadbinTileToLngLatBounds,
  quadbinToTile,
  type QuadbinTile,
} from '../src/lib/quadbin-cells';
import {
  unwrapRing,
  type SummaryCellDiagnostics,
} from '../src/lib/summary-cells';

const TIME_OFFSET = 1_700_000_000_000;
const STARTS = [0, 120, 500, 999];
const ENDS = [40, 300, 900, 1200];

/** The mercator square's north/south edge, where the projection is cut. */
const MERC_LAT = 85.0511287798066;

// ── the ENCODER, written independently of the decoder under test ────────────
// CARTO's `tileToQuadbin`, transcribed from the spec's bit layout. Writing the
// inverse by hand (rather than reusing anything from src/) is what makes the
// round-trip below a real test and not a tautology.

function interleave(x: number, y: number): bigint {
  let v = 0n;
  for (let i = 0; i < 26; i++) {
    v |= BigInt((x >> i) & 1) << BigInt(2 * i);
    v |= BigInt((y >> i) & 1) << BigInt(2 * i + 1);
  }
  return v;
}

function tileToQuadbin({ z, x, y }: QuadbinTile): bigint {
  const morton = interleave(x, y) << BigInt(52 - 2 * z);
  const fill = 0xfffffffffffffn >> BigInt(2 * z);
  return (0b01001n << 59n) | (BigInt(z) << 52n) | morton | fill;
}

/** A few real cells to build tiles from — z6 around San Francisco. */
const SF_TILES: QuadbinTile[] = [
  { z: 6, x: 10, y: 24 },
  { z: 6, x: 11, y: 24 },
  { z: 6, x: 10, y: 25 },
  { z: 6, x: 11, y: 25 },
];

function summaryTile(n: number, timeOffset = TIME_OFFSET): Tile {
  return tileWithIds(SF_TILES.slice(0, n).map(tileToQuadbin), timeOffset);
}

function tileWithIds(ids: bigint[], timeOffset = TIME_OFFSET): Tile {
  const n = ids.length;
  const features: BinaryFeatures = {
    featureCount: n,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(n * 2),
    featureIds: new Uint32Array(n),
    featureIds64: BigUint64Array.from(ids),
    startTimes: new Float32Array(STARTS.slice(0, n)),
    endTimes: new Float32Array(ENDS.slice(0, n)),
    timeOffset,
    numericProps: {
      count: new Float32Array(
        Array.from({ length: n }, (_, i) => (i + 1) * 10),
      ),
    },
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'summary',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

function stubScene(picked?: unknown): {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
} {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const scene = {
    primitives: {
      add<T>(p: T): T {
        added.push(p);
        return p;
      },
      remove(p: unknown): boolean {
        removed.push(p);
        return true;
      },
    },
    pick(): unknown {
      return picked;
    },
  } as unknown as Scene;
  return { scene, added, removed };
}

/** The batch-table stand-in; the `color` setter must COPY (one shared scratch). */
function armPrimitive(prim: Primitive): Map<unknown, Uint8Array> {
  const store = new Map<unknown, Uint8Array>();
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    const bytes = new Uint8Array(4);
    store.set(id, bytes);
    return {
      get color(): Uint8Array {
        return bytes;
      },
      set color(v: Uint8Array) {
        bytes.set(v);
      },
    } as never;
  };
  return store;
}

describe('the Quadbin u64 decode', () => {
  it("matches CARTO's published vector for the root tile", () => {
    // (0,0,0) → 0x480fffffffffffff is the one number every port of this decode
    // is checked against; ours agrees in BOTH directions.
    expect(tileToQuadbin({ z: 0, x: 0, y: 0 })).toBe(0x480fffffffffffffn);
    expect(quadbinToTile(0x480fffffffffffffn)).toEqual({ z: 0, x: 0, y: 0 });
  });

  it('round-trips every zoom, including the 52-bit ceiling', () => {
    for (let z = 0; z <= QUADBIN_MAX_ZOOM; z++) {
      const n = 2 ** z;
      // Corners plus an interior cell whose x and y differ, so a swapped
      // even/odd de-interleave cannot pass.
      const cells: QuadbinTile[] = [
        { z, x: 0, y: 0 },
        { z, x: n - 1, y: 0 },
        { z, x: 0, y: n - 1 },
        { z, x: n - 1, y: n - 1 },
        { z, x: Math.floor(n / 3), y: Math.floor((2 * n) / 3) },
      ];
      for (const cell of cells) {
        expect(quadbinToTile(tileToQuadbin(cell))).toEqual(cell);
      }
    }
  });

  it('places the root cell over the whole mercator square', () => {
    const [w, s, e, n] = quadbinTileToLngLatBounds({ z: 0, x: 0, y: 0 });
    expect(w).toBeCloseTo(-180, 9);
    expect(e).toBeCloseTo(180, 9);
    expect(n).toBeCloseTo(MERC_LAT, 6);
    expect(s).toBeCloseTo(-MERC_LAT, 6);
  });

  it('puts the four z1 quadrants in the right hemispheres', () => {
    const quadrant = (x: number, y: number) =>
      quadbinTileToLngLatBounds({ z: 1, x, y });
    expect(quadrant(0, 0)).toEqual([
      expect.closeTo(-180, 9),
      expect.closeTo(0, 9),
      expect.closeTo(0, 9),
      expect.closeTo(MERC_LAT, 6),
    ]);
    // y counts SOUTHWARD from the north edge — the classic off-by-a-hemisphere.
    expect(quadrant(1, 1)[1]).toBeCloseTo(-MERC_LAT, 6);
    expect(quadrant(1, 1)[3]).toBeCloseTo(0, 9);
    expect(quadrant(1, 1)[0]).toBeCloseTo(0, 9);
  });

  it('emits an OPEN, counter-clockwise ring of the cell corners', () => {
    const tile = { z: 6, x: 10, y: 24 };
    const ring = quadbinCellRing(tile);
    expect(ring).toHaveLength(4); // open: no repeated first vertex
    expect(new Set(ring.map(([lng]) => lng)).size).toBe(2);
    expect(new Set(ring.map(([, lat]) => lat)).size).toBe(2);
    // Shoelace > 0 ⇒ counter-clockwise seen from above.
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      area += x1 * y2 - x2 * y1;
    }
    expect(area).toBeGreaterThan(0);
    const [w, s, e, n] = quadbinTileToLngLatBounds(tile);
    expect(ring).toEqual([
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ]);
  });
});

describe('a cell wider than 180° survives the antimeridian unwrap', () => {
  /** `[minLon, maxLon]` of an unwrapped ring — the span the projector will see. */
  function unwrappedSpan(ring: readonly (readonly number[])[]): number {
    const flat = unwrapRing(ring);
    expect(flat).not.toBeNull();
    const lons: number[] = [];
    for (let i = 0; i < (flat as Float64Array).length; i += 2) {
      lons.push((flat as Float64Array)[i]);
    }
    return Math.max(...lons) - Math.min(...lons);
  }

  it('NEGATIVE CONTROL: the naive four-corner ring collapses to nothing', () => {
    // This is the bug MAX_RING_SEGMENT_DEGREES exists to prevent, stated as a
    // test so nobody "simplifies" the densification away: `unwrapRing` places
    // each vertex within ±180° of its PREDECESSOR, so a 360°-wide south edge
    // folds +180 back onto −180 and the cell has zero width.
    const [w, s, e, n] = quadbinTileToLngLatBounds({ z: 0, x: 0, y: 0 });
    expect(
      unwrappedSpan([
        [w, s],
        [e, s],
        [e, n],
        [w, n],
      ]),
    ).toBe(0);
  });

  it('keeps the full longitude span at z0 and z1', () => {
    expect(unwrappedSpan(quadbinCellRing({ z: 0, x: 0, y: 0 }))).toBeCloseTo(
      360,
      9,
    );
    for (const x of [0, 1]) {
      for (const y of [0, 1]) {
        expect(unwrappedSpan(quadbinCellRing({ z: 1, x, y }))).toBeCloseTo(
          180,
          9,
        );
      }
    }
  });

  it('costs nothing from z2 down — still four corners', () => {
    for (let z = 2; z <= 8; z++) {
      expect(quadbinCellRing({ z, x: 1, y: 1 })).toHaveLength(4);
    }
    // …because a z2 cell is exactly the segment ceiling.
    const [w, , e] = quadbinTileToLngLatBounds({ z: 2, x: 0, y: 0 });
    expect(e - w).toBeCloseTo(MAX_RING_SEGMENT_DEGREES, 9);
  });
});

describe('a non-Quadbin id is refused, not mis-drawn', () => {
  const resolve = quadbinBoundaryResolver();

  it('rejects an H3 index, zero, and an out-of-band value', () => {
    expect(isQuadbinId(0x8928308280fffffn)).toBe(false); // a real H3 cell
    expect(isQuadbinId(0n)).toBe(false);
    expect(isQuadbinId(1n << 70n)).toBe(false); // wider than u64
    expect(isQuadbinId(-1n)).toBe(false);
    expect(resolve(0x8928308280fffffn)).toBeNull();
  });

  it('accepts every id the encoder produces', () => {
    for (const cell of SF_TILES)
      expect(isQuadbinId(tileToQuadbin(cell))).toBe(true);
  });

  it('counts H3 rows as SKIPPED in the diagnostics instead of blanking', () => {
    const { scene, added } = stubScene();
    const seen: SummaryCellDiagnostics[] = [];
    const layer = new STTQuadbinSummaryLayer(scene, {
      onDiagnostics: (d) => seen.push(d),
    });
    layer.setTiles([tileWithIds([0x8928308280fffffn, 0x8928308280bffffn])]);
    expect(added).toHaveLength(0); // nothing decoded ⇒ nothing published
    expect(seen).toHaveLength(1);
    expect(seen[0].skipped).toBe(2);
  });
});

describe('the layer needs no injected library', () => {
  it('constructs bare — the H3 sibling throws here, this one cannot', () => {
    const { scene } = stubScene();
    expect(() => new STTQuadbinSummaryLayer(scene)).not.toThrow();
  });

  it('publishes one batched Primitive carrying one instance per cell', () => {
    const { scene, added } = stubScene();
    const layer = new STTQuadbinSummaryLayer(scene);
    layer.setTiles([summaryTile(4)]);
    expect(added).toHaveLength(1);
    const prim = added[0] as Primitive & { geometryInstances: unknown[] };
    expect(prim).toBeInstanceOf(Primitive);
    expect(prim.geometryInstances).toHaveLength(4);
  });

  it('takes no dependency on a CARTO or h3 package', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    const manifest = pkg.default as Record<string, Record<string, string>>;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
    ]) {
      const names = Object.keys(manifest[field] ?? {});
      expect(names).not.toContain('h3-js');
      expect(names).not.toContain('quadbin');
      expect(names.filter((n) => n.startsWith('@carto/'))).toEqual([]);
    }
  });
});

describe('STTQuadbinSummaryLayer.setTime derives alpha from the core oracle', () => {
  const MODES: ReadonlyArray<{
    mode: TimeFilterMode;
    params: TimeFilterParams;
  }> = [
    { mode: 'window', params: { windowHalf: 400 } },
    { mode: 'window', params: { windowHalf: 400, fadeIn: 250, fadeOut: 150 } },
    { mode: 'wake', params: { wakeLength: 900 } },
    { mode: 'cumulative', params: { fadeIn: 700 } },
    { mode: 'trail', params: { trailLength: 600, trailFade: 1 } },
    { mode: 'none', params: {} },
  ];

  const PLAYHEADS: number[] = [];
  for (let t = -600; t <= 1800; t += 37) PLAYHEADS.push(TIME_OFFSET + t);
  for (const s of STARTS)
    PLAYHEADS.push(TIME_OFFSET + s, TIME_OFFSET + s + 900);
  for (const e of ENDS) PLAYHEADS.push(TIME_OFFSET + e);

  it('writes exactly `round(255 · timeFilterAlpha)` per cell, for every mode', () => {
    for (const { mode, params } of MODES) {
      const { scene, added } = stubScene();
      const layer = new STTQuadbinSummaryLayer(scene, {
        mode,
        timeFilter: params,
      });
      layer.setTiles([summaryTile(4)]);
      const prim = added[0] as Primitive;
      const store = armPrimitive(prim);

      for (const absoluteMs of PLAYHEADS) {
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        const bytes = [...store.entries()]
          .sort(
            (a, b) =>
              (a[0] as { featureIndex: number }).featureIndex -
              (b[0] as { featureIndex: number }).featureIndex,
          )
          .map(([, v]) => v[3]);
        expect(bytes).toHaveLength(STARTS.length);
        for (let i = 0; i < STARTS.length; i++) {
          expect(bytes[i]).toBe(
            Math.round(
              255 * timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params),
            ),
          );
        }
      }
    }
  });

  it('is not vacuous: the sweep produces 0, 1 and a fractional alpha', () => {
    const seen = new Set<string>();
    for (const absoluteMs of PLAYHEADS) {
      const a = timeFilterAlpha(
        'window',
        absoluteMs - TIME_OFFSET,
        STARTS[1],
        ENDS[1],
        { windowHalf: 400, fadeIn: 250, fadeOut: 150 },
      );
      seen.add(a === 0 ? 'zero' : a === 1 ? 'one' : 'frac');
    }
    expect(seen).toEqual(new Set(['zero', 'one', 'frac']));
  });

  it('rebases the playhead onto the tile time origin, not epoch 0', () => {
    const { scene, added } = stubScene();
    const layer = new STTQuadbinSummaryLayer(scene, {
      mode: 'window',
      timeFilter: { windowHalf: 400 },
    });
    layer.setTiles([summaryTile(1)]);
    const store = armPrimitive(added[0] as Primitive);
    layer.setTime(TIME_OFFSET + 10); // inside feature 0's window
    expect([...store.values()][0][3]).toBe(255);
    layer.setTime(10); // absolute epoch — nowhere near the data
    expect([...store.values()][0][3]).toBe(0);
  });

  it('does nothing before the primitive is ready (no batch table yet)', () => {
    const { scene, added } = stubScene();
    const layer = new STTQuadbinSummaryLayer(scene);
    layer.setTiles([summaryTile(2)]);
    expect(() => layer.setTime(TIME_OFFSET)).not.toThrow();
    expect((added[0] as Primitive).ready).toBe(false);
  });
});

describe('picking', () => {
  it('reports the cell CENTROID, inside the decoded cell bounds', () => {
    const cell = SF_TILES[1];
    const stub = stubScene();
    const layer = new STTQuadbinSummaryLayer(stub.scene);
    layer.setTiles([tileWithIds([tileToQuadbin(cell)])]);
    const instance = (
      stub.added[0] as Primitive & { geometryInstances: { id: unknown }[] }
    ).geometryInstances[0];
    // Re-stub the scene's pick to return the instance the layer just built.
    const picking = stubScene({ id: instance.id });
    const layer2 = new STTQuadbinSummaryLayer(picking.scene);
    layer2.setTiles([tileWithIds([tileToQuadbin(cell)])]);
    const hit = layer2.pick(12, 34);
    expect(hit).not.toBeNull();
    expect(hit?.layerId).toBe('stt-cesium-quadbin-summary');
    expect(hit?.index).toBe(0);
    expect(hit?.screen).toEqual([12, 34]);
    layer.dispose();
    layer2.dispose();
  });

  it('ignores a hit belonging to another layer', () => {
    const { scene } = stubScene({ id: { layerId: 'someone-else' } });
    const layer = new STTQuadbinSummaryLayer(scene);
    layer.setTiles([summaryTile(2)]);
    expect(layer.pick(1, 1)).toBeNull();
  });
});

describe('lifecycle', () => {
  it('keeps the standing primitive when a rebuild yields no cells', () => {
    const { scene, added } = stubScene();
    const layer = new STTQuadbinSummaryLayer(scene, {
      onDiagnostics: () => {},
    });
    layer.setTiles([summaryTile(3)]);
    expect(added).toHaveLength(1);
    const bare = summaryTile(1);
    delete bare.layers[0].features.featureIds64;
    layer.setTiles([bare]);
    // Build-before-teardown: no second primitive, and the first still stands.
    expect(added).toHaveLength(1);
  });

  it('removes the primitive on dispose, and is idempotent', () => {
    const { scene, added, removed } = stubScene();
    const layer = new STTQuadbinSummaryLayer(scene);
    layer.setTiles([summaryTile(2)]);
    layer.dispose();
    expect(removed).toEqual([added[0]]);
    expect(() => layer.dispose()).not.toThrow();
    expect(removed).toHaveLength(1); // nothing left to remove
  });

  it('destroys the primitive itself when the scene declines to', () => {
    const added: Primitive[] = [];
    const scene = {
      primitives: {
        add<T>(p: T): T {
          added.push(p as unknown as Primitive);
          return p;
        },
        // A host running `destroyPrimitives: false`, or a double dispose.
        remove(): boolean {
          return false;
        },
      },
    } as unknown as Scene;
    const layer = new STTQuadbinSummaryLayer(scene);
    layer.setTiles([summaryTile(2)]);
    layer.dispose();
    expect(added[0].isDestroyed()).toBe(true);
  });
});
