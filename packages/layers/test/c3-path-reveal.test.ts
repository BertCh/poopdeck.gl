/**
 * C3 — AnimatedPathLayer progressive-reveal / trail mode.
 *
 * The path layer is window-mode by default (whole path on/off + fade). This
 * suite pins the opt-in `revealTrail` mode that draws a TIMELESS line
 * progressively up to the play head, reusing TimeFilterExtension's trail branch
 * fed by per-vertex times synthesized from each feature's [startTime,endTime]
 * span. It asserts three contracts:
 *
 *   1. reveal ON synthesizes MONOTONE per-vertex times and drives the trail
 *      (feeds `instanceVertexTime`, sets a non-zero `trailLength`);
 *   2. reveal OFF (the default) is BYTE-IDENTICAL to the pre-reveal layer — no
 *      `instanceVertexTime`, no trail props, same window-mode attributes;
 *   3. `reducedMotion` suppresses the animation back to the whole-path window
 *      render even when `revealTrail` is set.
 *
 * Exercises the real prepareTile + buildSublayer paths via Object.create (which
 * bypasses CompositeLayer's lifecycle), with the shared deck.gl mocks that
 * stash constructor props — no GPU. Imports the layer from its SPECIFIC source
 * path (not the barrel, which is edited concurrently).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePathTile } from './fake-tile';

// Stash-props mock for the deck.gl layer constructors (PathLayer /
// NoPickingPathLayer-via-PathLayer). No GPU; the @poopdeck.gl layer is real.
vi.mock('@deck.gl/layers', () => {
  class FakePathLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { PathLayer: FakePathLayer };
});

// Shared `@deck.gl/core` mock reproduces the real
// getSubLayerProps/getSubLayerClass contract without a deck.gl runtime.
vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A single TIMELESS line: `v` equally-spaced vertices along the equator, with a
 * feature time span [start, end] but NO baked per-vertex timestamps. Equal
 * spacing ⇒ cumulative-distance synthesis lands the vertex times on evenly
 * spaced values across the span.
 */
function timelessLineTile(v: number, start: number, end: number) {
  const ring: number[][] = new Array(v);
  for (let k = 0; k < v; k++) ring[k] = [k, 0];
  return makePathTile({
    paths: [ring],
    startTimes: [start],
    endTimes: [end],
    timeOffset: 0,
  });
}

/** Two timeless lines, so the per-vertex expansion length can be checked. */
function twoLineTile() {
  return makePathTile({
    paths: [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [0, 1],
        [1, 1],
      ],
    ],
    startTimes: [1000, 2000],
    endTimes: [3000, 4000],
    timeOffset: 0,
  });
}

describe('AnimatedPathLayer progressive-reveal / trail mode (C3)', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let buildSublayerForTile: (tile: any, opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-path-layer');
    LayerCtor = mod.AnimatedPathLayer as any;

    makeLayer = (opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        // Color / width (constant fallbacks — no property columns named).
        pathColor: [31, 186, 214, 255],
        pathWidth: 2,
        getColor: null,
        getWidth: null,
        colorPalette: [],
        colorMapping: null,
        colorMappingDefault: [120, 120, 120, 255],
        widthUnits: 'pixels',
        widthScale: 1,
        widthMinPixels: 0,
        widthMaxPixels: Number.MAX_SAFE_INTEGER,
        capRounded: false,
        jointRounded: false,
        miterLimit: 4,
        billboard: false,
        // Elevation (unset ⇒ flat).
        elevationProperty: null,
        elevationMapping: null,
        elevationScale: 1,
        elevationOpacityRange: null,
        elevationOpacityNear: 1,
        elevationOpacityFar: 1,
        // Column filter (unset).
        filterProperty: null,
        filterRange: null,
        filterSoftRange: null,
        filterEnabled: true,
        // Time.
        timeWindow: 1000,
        fadeInDuration: 300,
        fadeOutDuration: 300,
        timeHeightScale: 0,
        timeHeightOrigin: 0,
        // Reveal-mode defaults (matching static defaultProps).
        revealTrail: false,
        revealDuration: 0,
        fadeTrail: true,
        reducedMotion: false,
        // Composite.
        opacity: 1,
        visible: true,
        pickable: false,
        ...opts,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = { __id: 'time-filter' };
      layer.categoryColorExtension = { __id: 'category-color' };
      layer.dataFilterExtension = { __id: 'data-filter' };
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      return layer;
    };

    buildSublayerForTile = (tile, opts = {}) => {
      const layer = makeLayer(opts);
      return layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    };
  });

  // -------------------------------------------------------------------------
  // 1. reveal ON synthesizes monotone vertex times and drives the trail
  // -------------------------------------------------------------------------

  it('synthesizes MONOTONE per-vertex times spanning the feature start→end', () => {
    const built = buildSublayerForTile(timelessLineTile(5, 1000, 5000), {
      revealTrail: true,
    });
    const vt = built.props.data.attributes.instanceVertexTime;

    expect(vt).toBeDefined();
    expect(vt.size).toBe(1);
    // One value per VERTEX (not per feature).
    expect(vt.value.length).toBe(5);
    // Monotone non-decreasing along the path.
    for (let i = 1; i < vt.value.length; i++) {
      expect(vt.value[i]).toBeGreaterThanOrEqual(vt.value[i - 1]);
    }
    // Ends pinned to the feature span; equal spacing ⇒ evenly stepped interior.
    expect(vt.value[0]).toBeCloseTo(1000);
    expect(vt.value[4]).toBeCloseTo(5000);
    expect(vt.value[2]).toBeCloseTo(3000);
  });

  it('expands vertex times per-VERTEX across multiple features (length = totalVerts)', () => {
    const tile = twoLineTile(); // 3 + 2 = 5 vertices
    const built = buildSublayerForTile(tile, { revealTrail: true });
    const vt = built.props.data.attributes.instanceVertexTime;

    expect(vt.value.length).toBe(5);
    // Feature 0 span [1000,3000] over 3 verts → 1000, 2000, 3000.
    expect(vt.value[0]).toBeCloseTo(1000);
    expect(vt.value[2]).toBeCloseTo(3000);
    // Feature 1 span [2000,4000] over 2 verts → 2000, 4000.
    expect(vt.value[3]).toBeCloseTo(2000);
    expect(vt.value[4]).toBeCloseTo(4000);
  });

  it('drives the trail: a non-zero trailLength flips TimeFilterExtension into trail mode', () => {
    // Default revealDuration (0) ⇒ persist: an effectively-infinite trail so the
    // whole revealed portion stays drawn.
    const persist = buildSublayerForTile(timelessLineTile(4, 0, 3000), {
      revealTrail: true,
    });
    expect(persist.props.trailLength).toBeGreaterThan(0);
    // ~4 years — far beyond any real playback span.
    expect(persist.props.trailLength).toBeGreaterThan(
      365 * 24 * 60 * 60 * 1000,
    );

    // A finite revealDuration is passed through verbatim as the comet-trail length.
    const comet = buildSublayerForTile(timelessLineTile(4, 0, 3000), {
      revealTrail: true,
      revealDuration: 2000,
    });
    expect(comet.props.trailLength).toBe(2000);
  });

  it('forwards fadeTrail to the sublayer in reveal mode', () => {
    const solid = buildSublayerForTile(timelessLineTile(4, 0, 3000), {
      revealTrail: true,
      fadeTrail: false,
    });
    expect(solid.props.fadeTrail).toBe(false);

    const comet = buildSublayerForTile(timelessLineTile(4, 0, 3000), {
      revealTrail: true,
      fadeTrail: true,
    });
    expect(comet.props.fadeTrail).toBe(true);
  });

  it("prefers the tile's own vertexTimestamps over synthesis when present", () => {
    const tile = timelessLineTile(4, 0, 3000);
    const baked = new Float32Array([10, 20, 30, 40]);
    tile.layers[0].features.vertexTimestamps = baked;
    const built = buildSublayerForTile(tile, { revealTrail: true });
    // Zero-copy: the same buffer reference the tile carries.
    expect(built.props.data.attributes.instanceVertexTime.value).toBe(baked);
  });

  // -------------------------------------------------------------------------
  // 2. reveal OFF is byte-identical to the pre-reveal (window-mode) layer
  // -------------------------------------------------------------------------

  it('reveal OFF adds no instanceVertexTime and no trail props (window mode)', () => {
    const built = buildSublayerForTile(timelessLineTile(5, 1000, 5000), {
      revealTrail: false,
    });
    const attrs = built.props.data.attributes;

    // Only the window-mode attributes — no per-vertex trail time.
    expect(attrs.instanceVertexTime).toBeUndefined();
    expect(Object.keys(attrs).sort()).toEqual(
      ['getPath', 'instanceEndTime', 'instanceStartTime'].sort(),
    );
    // No trail props leak into the sublayer.
    expect(built.props.trailLength).toBeUndefined();
    expect(built.props.fadeTrail).toBeUndefined();
  });

  it('reveal:false is byte-identical to omitting the reveal props entirely', () => {
    const tile = timelessLineTile(6, 500, 6500);
    // Baseline: no reveal props supplied at all (falls back to defaults).
    const baseline = buildSublayerForTile(tile);
    // Explicit off.
    const off = buildSublayerForTile(timelessLineTile(6, 500, 6500), {
      revealTrail: false,
    });

    const a = baseline.props.data.attributes;
    const b = off.props.data.attributes;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    // Window-mode time attributes match value-for-value.
    expect(Array.from(a.instanceStartTime.value)).toEqual(
      Array.from(b.instanceStartTime.value),
    );
    expect(Array.from(a.instanceEndTime.value)).toEqual(
      Array.from(b.instanceEndTime.value),
    );
    // Same window-mode sublayer props (no trail).
    expect(baseline.props.trailLength).toBeUndefined();
    expect(off.props.trailLength).toBeUndefined();
    expect(baseline.props.timeWindow).toBe(off.props.timeWindow);
  });

  // -------------------------------------------------------------------------
  // 3. reducedMotion shows the full path (window mode), no animation
  // -------------------------------------------------------------------------

  it('reducedMotion suppresses the trail even when revealTrail is on', () => {
    const built = buildSublayerForTile(timelessLineTile(5, 1000, 5000), {
      revealTrail: true,
      reducedMotion: true,
    });
    const attrs = built.props.data.attributes;

    // Whole-path window mode: no per-vertex trail time, no trailLength.
    expect(attrs.instanceVertexTime).toBeUndefined();
    expect(built.props.trailLength).toBeUndefined();
    expect(built.props.fadeTrail).toBeUndefined();
    // Full-path window attributes are still present (the whole path renders).
    expect(attrs.getPath).toBeDefined();
    expect(attrs.instanceStartTime).toBeDefined();
    expect(attrs.instanceEndTime).toBeDefined();
  });

  it('reducedMotion output matches the plain reveal-OFF output (identical attrs)', () => {
    const reduced = buildSublayerForTile(timelessLineTile(5, 1000, 5000), {
      revealTrail: true,
      reducedMotion: true,
    });
    const off = buildSublayerForTile(timelessLineTile(5, 1000, 5000), {
      revealTrail: false,
    });
    expect(Object.keys(reduced.props.data.attributes).sort()).toEqual(
      Object.keys(off.props.data.attributes).sort(),
    );
    expect(reduced.props.trailLength).toBe(off.props.trailLength); // both undefined
  });
});
