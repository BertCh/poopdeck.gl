/**
 * Regression guard: geometry-derived per-vertex attributes are memoized PER TILE
 * across playback sub-step re-prepares.
 *
 * FlowCorridorLayer / FlowStrokeLayer fold the playback sub-step into each tile's
 * `styleKey` (`gradientStyleSuffix` → `:fp{step}`), so `prepareTile` re-runs
 * ~6×/second during playback (once per daily bucket at a year-in-120s pace). The
 * per-vertex TIME array is a pure function of the tile's static geometry (a
 * haversine over every vertex) — recomputing it on every sub-step was the single
 * largest per-sub-step CPU cost in the rivers+rain composite. The synthesized
 * array is now cached by the tile's `binary` object identity, so a cache-busting
 * re-prepare (what a sub-step change is) must hand back the SAME array reference.
 *
 * A clearing of `preparedTileCache` stands in for a `styleKey` change: it forces
 * a fresh `prepareTile`, isolating the geometry memo (which is independent of the
 * prepared-tile cache) as the thing under test. Before the memo, each re-prepare
 * allocated a brand-new `Float32Array`; this guard fails on that behaviour.
 */

import { describe, it, expect, vi } from 'vitest';
import { makePathTile } from './fake-tile';

vi.mock('@deck.gl/layers', () => {
  class Fake {
    props: Record<string, any>;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { PathLayer: Fake, ScatterplotLayer: Fake, SolidPolygonLayer: Fake };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

import { AnimatedTripsLayer } from '../src/layers/trips/animated-trips-layer';

/** A trips tile of `n` multi-vertex features, no per-vertex timestamps (so the
 *  layer synthesizes them via haversine — the path under test). */
function tripsTile(n: number, v: number, lonBase = 0) {
  const paths: number[][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ring: number[][] = new Array(v);
    for (let k = 0; k < v; k++) ring[k] = [lonBase + k * 0.01, i * 0.01];
    paths[i] = ring;
  }
  return makePathTile({
    paths,
    startTimes: new Array(n).fill(0),
    endTimes: new Array(n).fill(1000),
    timeOffset: 0,
  });
}

function makeLayer() {
  const layer: any = Object.create(AnimatedTripsLayer.prototype);
  layer.props = {
    id: 'test',
    tripColor: [31, 186, 214, 255],
    tripWidth: 2,
    widthUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
  };
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
  layer.preparedTileCache = new Map();
  return layer;
}

function vertexTimesOf(layer: any, tile: any): Float32Array {
  const prepared = layer.prepareTile(tile, tile.layers[0]);
  return prepared.data.attributes.instanceVertexTime.value;
}

function nextVertexTimesOf(layer: any, tile: any): Float32Array | undefined {
  const prepared = layer.prepareTile(tile, tile.layers[0]);
  return prepared.data.attributes.instanceEndTime?.value;
}

describe('AnimatedTripsLayer vertex-time memoization', () => {
  it('reuses the synthesized vertex-time array across a sub-step re-prepare', () => {
    const layer = makeLayer();
    const tile = tripsTile(40, 8);

    const first = vertexTimesOf(layer, tile);
    expect(first).toBeInstanceOf(Float32Array);

    // A sub-step change busts the per-tile styleKey cache; simulate it.
    layer.preparedTileCache.clear();
    const second = vertexTimesOf(layer, tile);

    // Same tile geometry ⇒ same memoized array, NOT a fresh haversine pass.
    expect(second).toBe(first);
  });

  it('keys the memo by tile identity (distinct tiles get distinct arrays)', () => {
    // Fresh layers ⇒ empty preparedTileCache, so each tile's own `binary` is
    // actually re-prepared (the two fake tiles share a tile-key, which would
    // otherwise let the prepared-tile cache short-circuit the second call).
    const a = vertexTimesOf(makeLayer(), tripsTile(40, 8, 0));
    const b = vertexTimesOf(makeLayer(), tripsTile(40, 8, 5));
    // Distinct tile objects ⇒ distinct memo entries, NOT one global array.
    expect(b).not.toBe(a);
  });
});

describe('AnimatedTripsLayer per-segment trail times', () => {
  it('binds the NEXT vertex time to the idle instanceEndTime slot', () => {
    const layer = makeLayer();
    const tile = tripsTile(3, 5);
    const times = vertexTimesOf(layer, tile);
    const next = nextVertexTimesOf(layer, tile)!;

    expect(next).toBeInstanceOf(Float32Array);
    expect(next.length).toBe(times.length);

    // Per feature: every vertex reads its SUCCESSOR's time, except the last,
    // which reads its own — it starts no segment, and taking the next feature's
    // first vertex would interpolate the final quad across an arbitrary jump.
    for (let f = 0; f < 3; f++) {
      const v0 = f * 5;
      for (let v = v0; v < v0 + 4; v++) expect(next[v]).toBe(times[v + 1]);
      expect(next[v0 + 4]).toBe(times[v0 + 4]);
    }
    // Concretely: no value ever crosses a feature boundary.
    expect(next[4]).not.toBe(times[5]);
  });

  it('memoizes the derived array per tile, like the vertex times themselves', () => {
    const layer = makeLayer();
    const tile = tripsTile(40, 8);
    const first = nextVertexTimesOf(layer, tile);
    layer.preparedTileCache.clear();
    expect(nextVertexTimesOf(layer, tile)).toBe(first);
  });

  it('tells the shader about the reinterpretation via the segmentTime prop', () => {
    // The buffer alone is inert: without this prop the trail branch still reads
    // instanceEndTime as a feature end, so the two must be wired together.
    const layer = makeLayer();
    const tile = tripsTile(3, 5);
    const on = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(on.props.segmentTime).toBe(true);

    const off = makeLayer();
    off.usesSegmentVertexTimes = () => false;
    const offTile = tripsTile(3, 5, 5);
    expect(
      off.buildSublayer(off.prepareTile(offTile, offTile.layers[0])).props
        .segmentTime,
    ).toBe(false);
  });

  it('is OFF for window-mode subclasses, which need the slot for feature bounds', () => {
    // FlowCorridorLayer's contract: `timeBoundsForSublayer` feeds real feature
    // bounds through instanceStartTime/instanceEndTime, so the slot is taken.
    // Emulated here via the hook — instantiating the corridor layer would drag
    // in the value-matrix machinery this test has no tile for.
    const layer = makeLayer();
    layer.usesSegmentVertexTimes = () => false;
    expect(nextVertexTimesOf(layer, tripsTile(3, 5))).toBeUndefined();
  });
});
