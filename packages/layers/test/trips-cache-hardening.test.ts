/**
 * Trips-family cache + parity hardening.
 *
 * Covers the review findings that all live in the same place — the per-tile
 * prepare/sublayer caches shared by AnimatedTripsLayer, FlowCorridorLayer,
 * FlowStrokeLayer and AnimatedTripHeadsLayer:
 *
 *   • FlowCorridorLayer must NOT inherit `trailLength: 180000` (blank network).
 *   • Cache keys must carry the ARCHIVE, and the prune must run before the
 *     empty-tiles early return (a `data` swap served the old buffers).
 *   • A playhead sub-step must keep `data` + the unchanged attribute wrappers
 *     reference-stable and invalidate via `updateTriggers` (no re-tessellation,
 *     no fp64 re-split of the position buffer).
 *   • Flow-specific props must reach BOTH cache keys (dead sliders when paused).
 *   • The caches must live on `state` so deck's `_transferState` keeps them.
 *   • The head-dot layer must pool its per-frame buffers and size them to the
 *     ACTIVE dot count.
 *   • `FlowStrokeLayer.widthsFor` must not recompute the matrix blend.
 *   • Geometry guard + the small default/parity gaps.
 *
 * Drives the real private `renderLayers` / `prepareTile` / `buildSublayer` via
 * the Object.create harness the sibling trips suites use; the GPU sublayers and
 * deck core are mocked so no luma shader loads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Tile } from '@poopdeck.gl/core';

vi.mock('@deck.gl/layers', () => {
  class Fake {
    props: Record<string, any>;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { PathLayer: Fake, ScatterplotLayer: Fake, SolidPolygonLayer: Fake };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { ...core, Layer: FakeLayer, project32: { name: 'project32' } };
});

vi.mock('@deck.gl/extensions', () => {
  class PathStyleExtension {
    opts: any;
    constructor(opts: any = {}) {
      this.opts = opts;
    }
  }
  return { PathStyleExtension };
});

import { AnimatedTripsLayer } from '../src/layers/trips/animated-trips-layer';
import { FlowCorridorLayer } from '../src/layers/trips/flow-corridor-layer';
import { FlowStrokeLayer } from '../src/layers/trips/flow-stroke-layer';
import { AnimatedTripHeadsLayer } from '../src/layers/trips/animated-trip-heads-layer';
import { makePathTile, makePointTile } from './fake-tile';
import { _resetWarnOnce } from '../src/lib/log';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The props a constructed trips layer would carry (defaults, flattened). */
const TRIPS_PROPS = {
  id: 'trips',
  tripColor: [1, 2, 3, 255],
  tripWidth: 3,
  colorPalette: [[9, 9, 9, 255]],
  colorMappingDefault: [120, 120, 120, 255],
  gradientDomain: [0, 1] as [number, number],
  gradientColorRamp: [],
  widthUnits: 'pixels',
  widthScale: 1,
  widthMinPixels: 2,
  widthMaxPixels: 10,
  capRounded: true,
  jointRounded: true,
  pathType: 'open',
  miterLimit: 4,
  billboard: false,
  trailLength: 180_000,
  fadeTrail: true,
  filterEnabled: true,
  timeWindow: 1000,
  opacity: 1,
  visible: true,
};

/** A bare layer with the chassis' instance-only collaborators stubbed in. */
function makeLayer(Ctor: any, props: Record<string, any> = {}, time = 0) {
  const layer: any = Object.create(Ctor.prototype);
  layer.props = { ...TRIPS_PROPS, ...props };
  layer.state = {};
  layer._currentTime = time;
  layer.boundGetTime = () => layer._currentTime;
  layer.getCurrentTime = () => layer._currentTime;
  layer.timeFilterExtension = { name: 'time' };
  layer.categoryColorExtension = { name: 'category' };
  layer.dataFilterExtension = { name: 'filter' };
  return layer;
}

const ID = { z: 14, x: 1, y: 2, t: 0 };

/** A 2-trip LineString tile (3 + 3 vertices). `lonBase` distinguishes buffers. */
function tripsTile(lonBase = 0, tileId = ID): Tile {
  return makePathTile({
    paths: [
      [
        [lonBase, 0],
        [lonBase + 0.1, 0.1],
        [lonBase + 0.2, 0.2],
      ],
      [
        [lonBase + 1, 1],
        [lonBase + 1.1, 1.1],
        [lonBase + 1.2, 1.2],
      ],
    ],
    startTimes: [0, 0],
    endTimes: [1000, 1000],
    timeOffset: 0,
    tileId,
  });
}

/**
 * A flow-corridor tile: one 4-vertex corridor carrying a per-vertex × 4-bucket
 * value matrix spanning [0, 4000) ms (1 s buckets), so a 500 ms playhead step
 * crosses a `STEP = 0.5` sub-step.
 */
function corridorTile(tileId = ID): Tile {
  const tile = makePathTile({
    paths: [
      [
        [0, 0],
        [0.1, 0.1],
        [0.2, 0.2],
        [0.3, 0.3],
      ],
    ],
    startTimes: [0],
    endTimes: [4000],
    timeOffset: 0,
    tileId,
  });
  const f = tile.layers[0].features as any;
  f.vertexValueBuckets = 4;
  // 4 vertices × 4 buckets, flattened vertex-major, distinct per bucket so a
  // sub-step change really moves the colours.
  f.vertexValueMatrix = Float32Array.from([
    0, 1, 2, 3, 3, 2, 1, 0, 1, 3, 0, 2, 2, 0, 3, 1,
  ]);
  return tile;
}

const RAMP = [
  [0, 0, 0, 255],
  [255, 255, 255, 255],
];

function prepare(layer: any, tile: Tile, archiveKey?: string) {
  return layer.prepareTile(
    tile,
    tile.layers[0],
    ...(archiveKey === undefined ? [] : [archiveKey]),
  );
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  _resetWarnOnce();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// 1. FlowCorridorLayer must not inherit trailLength
// ---------------------------------------------------------------------------

describe('FlowCorridorLayer trailLength', () => {
  it('overrides the inherited 180 s trail with 0 (window mode)', () => {
    // Inheriting AnimatedTripsLayer's 180 s put the shader in TRAIL mode, which
    // reads `instanceVertexTime` — the slot this class repurposes for the
    // chevron direction sign — as a relative vertex time, so the whole corridor
    // network blanked once the relative playhead passed trailLength.
    expect((AnimatedTripsLayer.defaultProps as any).trailLength.value).toBe(
      180_000,
    );
    expect((FlowCorridorLayer.defaultProps as any).trailLength.value).toBe(0);
    // FlowStrokeLayer spreads FlowCorridorLayer's defaults, so it inherits 0.
    expect((FlowStrokeLayer.defaultProps as any).trailLength.value).toBe(0);
  });

  it('no longer inflates the tile-load window by 2 × 180 s', () => {
    // `getEffectiveTimeWindow` maxes the configured window against
    // `trailLength * 2`; the inherited 180 s silently forced a 6-MINUTE tile
    // window on every corridor archive.
    const corridor = makeLayer(FlowCorridorLayer, {
      trailLength: 0,
      timeWindow: 1000,
      tileLoadTimeWindow: 0,
    });
    expect(corridor.getEffectiveTimeWindow()).toBe(1000);

    const trips = makeLayer(AnimatedTripsLayer, {
      trailLength: 180_000,
      timeWindow: 1000,
      tileLoadTimeWindow: 0,
    });
    expect(trips.getEffectiveTimeWindow()).toBe(360_000);
  });

  it('warns once when a caller sets trailLength > 0 with signedFlow', () => {
    const layer = makeLayer(FlowCorridorLayer, {
      trailLength: 5000,
      signedFlow: true,
      gradientColorRamp: RAMP,
    });
    layer.state = { tiles: [] };
    layer.renderLayers();
    layer.renderLayers();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('trailLength');
    expect(msg).toContain('instanceVertexTime');
  });

  it('stays silent at the default trailLength: 0', () => {
    const layer = makeLayer(FlowCorridorLayer, { trailLength: 0 });
    layer.state = { tiles: [] };
    layer.renderLayers();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. A data swap must not serve the previous archive's buffers
// ---------------------------------------------------------------------------

describe('archive identity in the tile cache', () => {
  it('AnimatedTripsLayer: the same z/x/y/t under a new archive gets fresh buffers', () => {
    const layer = makeLayer(AnimatedTripsLayer, { data: 'a.stt' });
    const a = tripsTile(0);
    const first = prepare(layer, a);
    expect(first.data.attributes.getPath.value).toBe(
      a.layers[0].features.positions,
    );

    // Same tile coordinates, different archive → different geometry buffer.
    layer.props = { ...layer.props, data: 'b.stt' };
    const b = tripsTile(100);
    const second = prepare(layer, b);
    expect(second).not.toBe(first);
    expect(second.data.attributes.getPath.value).toBe(
      b.layers[0].features.positions,
    );
    // …and the two entries are keyed apart, not overwritten.
    expect(second.tileKey).not.toBe(first.tileKey);
  });

  it('AnimatedTripsLayer: prunes on the `tiles: []` render the chassis emits on archive init', () => {
    const layer = makeLayer(AnimatedTripsLayer, { data: 'a.stt' });
    const a = tripsTile(0);
    layer.state = { ...layer.state, tiles: [a] };
    layer.renderLayers();
    expect(layer.preparedTileCache.size).toBe(1);
    expect(layer.sublayerCache.size).toBe(1);

    // `_initArchiveAndTileset` setStates `tiles: []` to signal the collapse.
    // The early return used to skip the prune entirely.
    layer.state.tiles = [];
    layer.renderLayers();
    expect(layer.preparedTileCache.size).toBe(0);
    expect(layer.sublayerCache.size).toBe(0);
  });

  it('AnimatedTripHeadsLayer: same, and its prepare has no style key to fall back on', () => {
    const layer = makeLayer(AnimatedTripHeadsLayer, {
      data: 'a.stt',
      headRadiusPixels: 4,
      sizeUnits: 'pixels',
      elevationScale: 1,
    });
    const a = tripsTile(0);
    layer.state = { ...layer.state, tiles: [a] };
    layer.renderLayers();
    expect(layer.preparedTileCache.size).toBe(1);

    layer.state.tiles = [];
    layer.renderLayers();
    expect(layer.preparedTileCache.size).toBe(0);

    // And an archive swap alone keys the entry apart.
    layer.props = { ...layer.props, data: 'b.stt' };
    const b = tripsTile(100);
    const prepared = layer.prepareTile(b, b.layers[0]);
    expect(prepared.positions).toBe(b.layers[0].features.positions);
  });
});

// ---------------------------------------------------------------------------
// 3. A playhead sub-step must not churn buffer identity
// ---------------------------------------------------------------------------

describe('playhead sub-step keeps geometry buffers reference-stable', () => {
  it('preserves data + getPath descriptor identity while swapping getColor', () => {
    const layer = makeLayer(
      FlowCorridorLayer,
      { gradientColorRamp: RAMP, trailLength: 0 },
      0,
    );
    const tile = corridorTile();
    const first = prepare(layer, tile);
    const firstData = first.data;
    const firstPath = first.data.attributes.getPath;
    const firstColor = first.data.attributes.getColor;
    expect(firstColor).toBeDefined();

    // Advance past a STEP = 0.5 sub-step of the 1 s buckets.
    layer._currentTime = 1000;
    const second = prepare(layer, tile);

    // Same PreparedTile, same `data` object (⇒ dataComparator says unchanged ⇒
    // no `changeFlags.dataChanged` ⇒ PathLayer never re-tessellates)…
    expect(second).toBe(first);
    expect(second.data).toBe(firstData);
    // …and the same fp64 position WRAPPER, which is what deck's
    // `Attribute.setExternalBuffer`/`setBinaryValue` short-circuit on. A fresh
    // wrapper would re-run toDoublePrecisionArray() over the whole buffer.
    expect(second.data.attributes.getPath).toBe(firstPath);
    expect(second.data.attributes.getPath.value).toBe(
      tile.layers[0].features.positions,
    );
    // Only the colour wrapper is new.
    expect(second.data.attributes.getColor).not.toBe(firstColor);
    expect(second.dynamicVersion).toBe(first.dynamicVersion);
  });

  it('bumps dynamicVersion and re-emits it as an updateTrigger', () => {
    const layer = makeLayer(
      FlowCorridorLayer,
      { gradientColorRamp: RAMP, trailLength: 0 },
      0,
    );
    const tile = corridorTile();
    const before = prepare(layer, tile);
    const v0 = before.dynamicVersion;
    const sub0 = layer.buildSublayer(before);
    expect(sub0.props.updateTriggers.instanceColors).toBe(v0);
    expect(sub0.props.updateTriggers.instanceStrokeWidths).toBe(v0);
    expect(sub0.props.updateTriggers.instanceVertexTime).toBe(v0);

    layer._currentTime = 1000;
    const after = prepare(layer, tile);
    expect(after.dynamicVersion).toBe(v0 + 1);
    const sub1 = layer.buildSublayer(after);
    // deck only re-runs `_updateAttributes` when something diffed; the data
    // object is deliberately identical, so the trigger is the ONLY signal.
    expect(sub1.props.data).toBe(sub0.props.data);
    expect(sub1.props.updateTriggers.instanceColors).toBe(v0 + 1);
  });

  it('rebuilds the cached sublayer on a sub-step (so the trigger actually ships)', () => {
    const layer = makeLayer(
      FlowCorridorLayer,
      { gradientColorRamp: RAMP, trailLength: 0 },
      0,
    );
    const tile = corridorTile();
    layer.state = { ...layer.state, tiles: [tile] };
    const [a] = layer.renderLayers();
    const [aAgain] = layer.renderLayers();
    expect(aAgain).toBe(a); // nothing changed → identical instance

    layer._currentTime = 1000;
    const [b] = layer.renderLayers();
    expect(b).not.toBe(a);
    expect(b.props.data).toBe(a.props.data);
  });

  it('keeps a user updateTrigger intact (we name attribute IDs, not accessors)', () => {
    const layer = makeLayer(FlowCorridorLayer, {
      gradientColorRamp: RAMP,
      trailLength: 0,
      updateTriggers: { getColor: 'user-token' },
    });
    const sub = layer.buildSublayer(prepare(layer, corridorTile()));
    expect(sub.props.updateTriggers.getColor).toBe('user-token');
    expect(sub.props.updateTriggers.instanceColors).toBe(0);
  });

  it('still rebuilds `data` when a STRUCTURAL prop changes', () => {
    const layer = makeLayer(FlowCorridorLayer, {
      gradientColorRamp: RAMP,
      trailLength: 0,
    });
    const tile = corridorTile();
    const first = prepare(layer, tile);
    layer.props = { ...layer.props, gradientDomain: [0, 10] };
    const second = prepare(layer, tile);
    expect(second).not.toBe(first);
    expect(second.data).not.toBe(first.data);
  });

  it('keys the ramp + domain even without `gradientProperty` (matrix subclasses)', () => {
    // The flow subclasses source their scalar from the value MATRIX and never
    // set `gradientProperty`, so a signature gated on that prop alone kept
    // serving the previous colours after a ramp swap until the playhead moved.
    const layer = makeLayer(FlowCorridorLayer, {
      gradientColorRamp: RAMP,
      trailLength: 0,
    });
    expect(layer.props.gradientProperty).toBeUndefined();
    const tile = corridorTile();
    const first = prepare(layer, tile);
    layer.props = {
      ...layer.props,
      gradientColorRamp: [
        [10, 0, 0, 255],
        [0, 10, 0, 255],
      ],
    };
    expect(prepare(layer, tile)).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 4. Flow-specific props must reach BOTH cache keys
// ---------------------------------------------------------------------------

describe('flow-specific props invalidate both caches', () => {
  const CORRIDOR_KNOBS: [string, unknown][] = [
    ['signedFlow', true],
    ['chevronPerTripLight', true],
    ['chevronAggregateWindowMs', 999],
    ['chevronInstantDomain', 9],
    ['chevronInstantDecayMs', 999],
    ['chevronDirectionWindowMs', 999],
    ['persistenceMs', 2000],
  ];

  it.each(CORRIDOR_KNOBS)(
    'FlowCorridorLayer: %s re-prepares the tile',
    (key, value) => {
      const layer = makeLayer(FlowCorridorLayer, {
        gradientColorRamp: RAMP,
        trailLength: 0,
        signedFlow: false,
        chevronPerTripLight: false,
        chevronAggregateWindowMs: 240000,
        chevronInstantDomain: 1.5,
        chevronInstantDecayMs: 120000,
        chevronDirectionWindowMs: 0,
        persistenceMs: 0,
      });
      const tile = corridorTile();
      const first = prepare(layer, tile);
      layer.props = { ...layer.props, [key as string]: value };
      // Paused: the playhead has NOT moved, so before this fix both caches hit
      // and the slider read as dead.
      expect(prepare(layer, tile)).not.toBe(first);
    },
  );

  const STROKE_KNOBS: [string, unknown][] = [
    ['widthExponent', 0.9],
    ['minFlow', 5],
    ['offsetWidths', 0],
  ];

  it.each(STROKE_KNOBS)(
    'FlowStrokeLayer: %s re-prepares the tile AND changes the sublayer digest',
    (key, value) => {
      const layer = makeLayer(FlowStrokeLayer, {
        gradientColorRamp: RAMP,
        trailLength: 0,
        widthExponent: 0.5,
        minFlow: 0,
        offsetWidths: 0.6,
      });
      const tile = corridorTile();
      const first = prepare(layer, tile);
      const firstDigest = layer.computeLayerPropsKey();

      layer.props = { ...layer.props, [key as string]: value };
      expect(prepare(layer, tile)).not.toBe(first);
      // `offsetWidths` gates extraTripsExtensions()/includeCategoryColorExtension(),
      // both "constant per instance" — the sublayer must be rebuilt, not reused.
      expect(layer.computeLayerPropsKey()).not.toBe(firstDigest);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Caches survive deck's _transferState
// ---------------------------------------------------------------------------

describe('caches live on state, not on class fields', () => {
  it('AnimatedTripsLayer: a simulated _transferState keeps prepared tiles + sublayers', () => {
    const older = makeLayer(AnimatedTripsLayer, { data: 'a.stt' });
    const tile = tripsTile();
    older.state = { ...older.state, tiles: [tile] };
    const [sub] = older.renderLayers();
    expect(older.preparedTileCache.size).toBe(1);

    // deck's `_transferState` moves ONLY state/internalState onto the new
    // instance; class-field initializers re-run on it. A field-held cache is
    // thrown away by any unmemoized `new AnimatedTripsLayer({...})`.
    const newer = makeLayer(AnimatedTripsLayer, { data: 'a.stt' });
    newer.state = older.state;

    expect(newer.preparedTileCache).toBe(older.preparedTileCache);
    expect(newer.preparedTileCache.size).toBe(1);
    expect(newer.sublayerCache.size).toBe(1);
    // …so the very next render reuses the cached PathLayer rather than
    // re-expanding every tile and re-uploading every GPU buffer.
    expect(newer.renderLayers()[0]).toBe(sub);
  });

  it('AnimatedTripHeadsLayer: a simulated _transferState keeps the prepared tiles', () => {
    const older = makeLayer(AnimatedTripHeadsLayer, {
      data: 'a.stt',
      headRadiusPixels: 4,
      sizeUnits: 'pixels',
      elevationScale: 1,
    });
    const tile = tripsTile();
    older.state = { ...older.state, tiles: [tile] };
    older.renderLayers();
    const prepared = older.preparedTileCache.values().next().value;

    const newer = makeLayer(AnimatedTripHeadsLayer, {
      data: 'a.stt',
      headRadiusPixels: 4,
      sizeUnits: 'pixels',
      elevationScale: 1,
    });
    newer.state = older.state;
    expect(newer.preparedTileCache.values().next().value).toBe(prepared);
  });

  it('FlowCorridorLayer: the bucket axis transfers too', () => {
    const older = makeLayer(FlowCorridorLayer, {
      data: 'a.stt',
      gradientColorRamp: RAMP,
      trailLength: 0,
    });
    prepare(older, corridorTile());
    const axis = older.state[(FlowCorridorLayer as any).AXIS_SLOT];
    expect(axis.numBuckets).toBe(4);

    const newer = makeLayer(FlowCorridorLayer, {
      data: 'a.stt',
      gradientColorRamp: RAMP,
      trailLength: 0,
    });
    newer.state = older.state;
    expect(newer.state[(FlowCorridorLayer as any).AXIS_SLOT]).toBe(axis);
  });
});

// ---------------------------------------------------------------------------
// 6. Head dots: pooled per-frame buffers, sized to the ACTIVE count
// ---------------------------------------------------------------------------

describe('AnimatedTripHeadsLayer per-frame allocation', () => {
  /** 4 trips; only trip 0 and 1 are alive at t = 500. */
  function stagedTile(): Tile {
    return makePathTile({
      paths: [
        [
          [0, 0],
          [0.1, 0.1],
        ],
        [
          [1, 1],
          [1.1, 1.1],
        ],
        [
          [2, 2],
          [2.1, 2.1],
        ],
        [
          [3, 3],
          [3.1, 3.1],
        ],
      ],
      startTimes: [0, 0, 5000, 5000],
      endTimes: [1000, 1000, 6000, 6000],
      timeOffset: 0,
    });
  }

  const HEAD_PROPS = {
    data: 'a.stt',
    headRadiusPixels: 4,
    sizeUnits: 'pixels',
    elevationScale: 1,
    radiusScale: 1,
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 1e9,
  };

  it('reuses the SAME position buffer across frames instead of allocating one per frame', () => {
    const layer = makeLayer(AnimatedTripHeadsLayer, HEAD_PROPS, 500);
    const tile = stagedTile();
    layer.state = { ...layer.state, tiles: [tile] };

    layer.renderLayers();
    const prepared = layer.preparedTileCache.values().next().value as any;
    const pool = prepared.headPositions;
    expect(pool).toBeInstanceOf(Float64Array);

    layer._currentTime = 600;
    layer.renderLayers();
    // 40 tiles × 20k features used to mean ~19 MB of fresh Float64 per FRAME.
    expect(prepared.headPositions).toBe(pool);
  });

  it('sizes the uploaded buffer to the ACTIVE dot count, not to every feature', () => {
    const layer = makeLayer(AnimatedTripHeadsLayer, HEAD_PROPS, 500);
    const tile = stagedTile();
    layer.state = { ...layer.state, tiles: [tile] };
    const [sub] = layer.renderLayers();

    expect(sub.props.data.length).toBe(2); // trips 2 and 3 have not started
    expect(sub.props.data.attributes.getPosition.value.length).toBe(2 * 3);
    // The pool itself is still capacity-sized for all 4 features.
    const prepared = layer.preparedTileCache.values().next().value as any;
    expect(prepared.headPositions.length).toBe(4 * 3);
  });

  it('pools the gradient colour buffer too, trimmed to the active count', () => {
    const layer = makeLayer(
      AnimatedTripHeadsLayer,
      {
        ...HEAD_PROPS,
        gradientProperty: 'vertexValues',
        gradientColorRamp: RAMP,
        gradientDomain: [0, 1],
      },
      500,
    );
    const tile = stagedTile();
    (tile.layers[0].features as any).vertexValues = Float32Array.from([
      0, 1, 0, 1, 0, 1, 0, 1,
    ]);
    layer.state = { ...layer.state, tiles: [tile] };

    const [sub] = layer.renderLayers();
    expect(sub.props.data.attributes.getFillColor.value.length).toBe(2 * 4);
    const prepared = layer.preparedTileCache.values().next().value as any;
    const pool = prepared.headColors;
    expect(pool.length).toBe(4 * 4);

    layer._currentTime = 600;
    layer.renderLayers();
    expect(prepared.headColors).toBe(pool);
  });

  it('emits a fresh position WRAPPER each frame so deck still re-uploads', () => {
    // Deck's setExternalBuffer short-circuits on wrapper identity; pooling the
    // typed array is only safe because the descriptor object is new each frame.
    const layer = makeLayer(AnimatedTripHeadsLayer, HEAD_PROPS, 500);
    const tile = stagedTile();
    layer.state = { ...layer.state, tiles: [tile] };
    const [a] = layer.renderLayers();
    layer._currentTime = 600;
    const [b] = layer.renderLayers();
    expect(b.props.data).not.toBe(a.props.data);
    expect(b.props.data.attributes.getPosition).not.toBe(
      a.props.data.attributes.getPosition,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. FlowStrokeLayer must not recompute the matrix blend
// ---------------------------------------------------------------------------

describe('FlowStrokeLayer width/colour share one blend', () => {
  it('computes gradientValuesFor exactly once per tile per prepare pass', () => {
    const layer = makeLayer(FlowStrokeLayer, {
      gradientColorRamp: RAMP,
      trailLength: 0,
      widthExponent: 0.5,
      minFlow: 0,
      offsetWidths: 0.6,
      persistenceMs: 2000, // the expensive trailingMax path
    });
    const spy = vi.spyOn(
      Object.getPrototypeOf(Object.getPrototypeOf(layer)),
      'gradientValuesFor',
    );
    prepare(layer, corridorTile());
    // Previously: once for the colour ramp, once again inside widthsFor.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('still produces the width buffer from that shared blend', () => {
    const layer = makeLayer(FlowStrokeLayer, {
      gradientColorRamp: RAMP,
      trailLength: 0,
      widthExponent: 1,
      minFlow: 0,
      offsetWidths: 0.6,
    });
    const tile = corridorTile();
    const prepared = prepare(layer, tile);
    const widths = prepared.data.attributes.getWidth.value as Float32Array;
    expect(widths.length).toBe(4);
    // At t = 0 the active bucket is column 0 → [0, 3, 1, 2] ** 1.
    expect(Array.from(widths)).toEqual([0, 3, 1, 2]);
  });

  it('falls back to recomputing when called outside a prepare pass', () => {
    const layer = makeLayer(FlowStrokeLayer, {
      gradientColorRamp: RAMP,
      trailLength: 0,
      widthExponent: 1,
      minFlow: 0,
      offsetWidths: 0.6,
    });
    const binary = corridorTile().layers[0].features as any;
    const widths = layer.widthsFor(binary, binary.featureCount);
    expect(Array.from(widths as Float32Array)).toEqual([0, 3, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 11. Small default / parity gaps
// ---------------------------------------------------------------------------

describe('defaults and parity gaps', () => {
  it('falls back to the documented tripWidth default (3) for tiles without the column', () => {
    const layer = makeLayer(AnimatedTripsLayer, { tripWidth: 'missingCol' });
    const sub = layer.buildSublayer(prepare(layer, tripsTile()));
    // Was 2, which silently disagreed with the documented `tripWidth: 3`.
    expect(sub.props.getWidth).toBe(3);
  });

  it('exposes _pathType through a `pathType` prop (upstream loop mode)', () => {
    const open = makeLayer(AnimatedTripsLayer, {});
    expect(open.buildSublayer(prepare(open, tripsTile())).props._pathType).toBe(
      'open',
    );
    const loop = makeLayer(AnimatedTripsLayer, { pathType: 'loop' });
    expect(loop.buildSublayer(prepare(loop, tripsTile())).props._pathType).toBe(
      'loop',
    );
    // …and it invalidates the sublayer cache like every other baked prop.
    expect(open.computeLayerPropsKey()).not.toBe(loop.computeLayerPropsKey());
  });

  it('warns once when a world-space width is silently clamped by widthMaxPixels', () => {
    const layer = makeLayer(AnimatedTripsLayer, {
      widthUnits: 'meters',
      widthScale: 500,
      // Left at the STT default 10 (upstream PathLayer: MAX_SAFE_INTEGER).
    });
    layer.buildSublayer(prepare(layer, tripsTile()));
    layer.buildSublayer(prepare(layer, tripsTile()));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('widthMaxPixels');
  });

  it('stays silent once widthMaxPixels is raised alongside widthUnits', () => {
    const layer = makeLayer(AnimatedTripsLayer, {
      widthUnits: 'meters',
      widthMaxPixels: 200,
    });
    layer.buildSublayer(prepare(layer, tripsTile()));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('encodes the resolved PathLayer class in the sublayer id', () => {
    // deck matches sublayers by id and then runs `_transferState` + `_update`,
    // never `_initialize` — so a stable id across a pickable flip would hand
    // NoPickingPathLayer's stripped shader + AttributeManager to a stock
    // PathLayer and leave picking permanently dead (and vice versa).
    const off = makeLayer(AnimatedTripsLayer, { pickable: false });
    const on = makeLayer(AnimatedTripsLayer, { pickable: true });
    const idOff = off.buildSublayer(prepare(off, tripsTile())).props.id;
    const idOn = on.buildSublayer(prepare(on, tripsTile())).props.id;
    expect(idOff).toMatch(/:np$/);
    expect(idOn).toMatch(/:pk$/);
    expect(idOff).not.toBe(idOn);
    // …and it is stable frame-to-frame, which is what keys the instance cache.
    expect(off.buildSublayer(prepare(off, tripsTile())).props.id).toBe(idOff);
  });

  it("AnimatedTripHeadsLayer forwards sizeUnits: 'common' to radiusUnits", () => {
    const layer = makeLayer(
      AnimatedTripHeadsLayer,
      {
        data: 'a.stt',
        sizeUnits: 'common',
        headRadius: 7,
        headRadiusPixels: 4,
        elevationScale: 1,
        radiusScale: 1,
        headRadiusMinPixels: 0,
        headRadiusMaxPixels: 1e9,
      },
      500,
    );
    const tile = tripsTile();
    layer.state = { ...layer.state, tiles: [tile] };
    const [sub] = layer.renderLayers();
    // Was hardwired to `sizeUnits === 'meters' ? 'meters' : 'pixels'`, so
    // 'common' silently degraded to screen space.
    expect(sub.props.radiusUnits).toBe('common');
    expect(sub.props.getRadius).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 12. Geometry guard
// ---------------------------------------------------------------------------

describe('geometry guard', () => {
  const pointTile = () =>
    makePointTile({
      positions: [
        [0, 0],
        [1, 1],
      ],
      startTimes: [0, 0],
      endTimes: [1000, 1000],
      timeOffset: 0,
    });

  it('AnimatedTripsLayer skips a Point tile with one named warning', () => {
    const layer = makeLayer(AnimatedTripsLayer, {});
    expect(prepare(layer, pointTile())).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('LineString');
  });

  it('AnimatedTripHeadsLayer skips a Point tile', () => {
    const layer = makeLayer(AnimatedTripHeadsLayer, { data: 'a.stt' });
    expect(layer.prepareTile(pointTile(), pointTile().layers[0])).toBeNull();
  });

  it('accepts LineString tiles, and untagged ones (pre-tag archives)', () => {
    const layer = makeLayer(AnimatedTripsLayer, {});
    expect(prepare(layer, tripsTile())).not.toBeNull();

    const untagged = tripsTile(0, { z: 14, x: 9, y: 9, t: 0 });
    delete (untagged.layers[0].features as any).geometryType;
    expect(prepare(layer, untagged)).not.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('renderLayers drops the mismatched layer instead of the whole tile set', () => {
    const layer = makeLayer(AnimatedTripsLayer, { data: 'a.stt' });
    const good = tripsTile(0);
    const bad = pointTile();
    bad.id = { z: 14, x: 5, y: 5, t: 0 } as any;
    layer.state = { ...layer.state, tiles: [good, bad] };
    expect(layer.renderLayers()).toHaveLength(1);
  });
});

describe('AnimatedTripHeadsLayer resident-tile culling', () => {
  const HEADS = { data: 'a.stt', headRadiusPixels: 4, sizeUnits: 'pixels' };

  /**
   * One tile whose covering range is `[start, end]` (absolute) holding a single
   * trip alive across the whole range — the shape the real archive produces,
   * where `timeRange` is the bucket edge below and the max feature end above.
   */
  function bucketTile(
    start: number,
    end: number,
    tileId = { z: 12, x: 1, y: 1, t: start },
  ): Tile {
    return makePathTile({
      paths: [
        [
          [0, 0],
          [0.1, 0.1],
        ],
      ],
      startTimes: [0],
      endTimes: [end - start],
      timeOffset: start,
      tileId,
      timeRange: { start, end },
    });
  }

  it('draws only the tiles whose covering range contains the playhead', () => {
    // Five 60 s buckets resident (what a 4-minute loader window holds on a
    // 1-minute-bucket archive); the playhead sits inside the third.
    const tiles = [0, 1, 2, 3, 4].map((i) =>
      bucketTile(i * 60_000, (i + 1) * 60_000, {
        z: 12,
        x: 1,
        y: 1,
        t: i * 60_000,
      }),
    );
    const layer = makeLayer(AnimatedTripHeadsLayer, HEADS, 150_000);
    layer.state = { ...layer.state, tiles };

    // 1 of 5 — the other four cannot hold an active trip, so scanning their
    // features (and emitting a zero-dot sublayer) is pure waste. At the
    // showcase's 1-hour window over 1-minute buckets that ratio was 1-in-61.
    expect(layer.renderLayers()).toHaveLength(1);
  });

  it('never prepares a culled tile (the per-tile scan is skipped, not just the draw)', () => {
    const inside = bucketTile(0, 60_000, { z: 12, x: 1, y: 1, t: 0 });
    const outside = bucketTile(600_000, 660_000, {
      z: 12,
      x: 2,
      y: 2,
      t: 600_000,
    });
    const layer = makeLayer(AnimatedTripHeadsLayer, HEADS, 30_000);
    layer.state = { ...layer.state, tiles: [inside, outside] };

    layer.renderLayers();
    expect(layer.preparedTileCache.size).toBe(1);
  });

  it('keeps a tile whose features run PAST its bucket edge (covering, not bucket, bounds)', () => {
    // stt-build records `time_end` as the max feature end_timestamp, which can
    // exceed the bucket edge when trajectory clipping is off. The cull has to
    // read that covering bound or it would drop live trips.
    const tile = bucketTile(0, 300_000, { z: 12, x: 1, y: 1, t: 0 });
    const layer = makeLayer(AnimatedTripHeadsLayer, HEADS, 250_000);
    layer.state = { ...layer.state, tiles: [tile] };
    expect(layer.renderLayers()).toHaveLength(1);
  });

  it('falls back to drawing when a tile carries no timeRange at all', () => {
    const tile = bucketTile(0, 60_000);
    delete (tile as any).timeRange;
    const layer = makeLayer(AnimatedTripHeadsLayer, HEADS, 30_000);
    layer.state = { ...layer.state, tiles: [tile] };
    expect(layer.renderLayers()).toHaveLength(1);
  });
});
