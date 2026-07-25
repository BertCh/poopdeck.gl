/**
 * STTDataFilterExtension — the poopdeck-native "filter by any baked column"
 * extension + its opt-in integration on AnimatedPointLayer / AnimatedPathLayer.
 *
 * Covers:
 *  1. The extension in isolation — reference-stable shaders, the `filterValue`
 *     attribute registration, the range/soft-fade/discard shader source, and
 *     the draw() → uniform forwarding (enabled/soft-margin/transform flags).
 *  2. Layer integration on BOTH layers — the extension is composed ONLY when
 *     `filterProperty` is set, the `filterValue` attribute is baked from the
 *     named column (zero-copy on points, per-vertex-expanded on paths),
 *     filterRange/filterEnabled forward as sublayer props, a missing column
 *     idles the filter for that tile, and a function accessor warns + falls back.
 *
 * Same Object.create + deck-mock harness as styling-passthrough.test.ts, with
 * `layer.dataFilterExtension` additionally stubbed (the constructor field
 * initializer never runs under Object.create).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShaderInputs } from '@luma.gl/engine';
import { makePointTile, makePathTile } from './fake-tile';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeScatterplotLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakePathLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeSolidPolygonLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return {
    ScatterplotLayer: FakeScatterplotLayer,
    PathLayer: FakePathLayer,
    SolidPolygonLayer: FakeSolidPolygonLayer,
  };
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

// Imported AFTER the mocks so the extension extends the fake LayerExtension —
// its constructor never touches LayerExtension internals (it clamps filterSize
// into the super() call), so a bare `new STTDataFilterExtension()` works here.
import {
  STTDataFilterExtension,
  dataFilterUniforms,
} from '../src/extensions/data-filter-extension';
import { _resetWarnOnce } from '../src/lib/log';

// ---------------------------------------------------------------------------
// Part 1 — the extension in isolation
// ---------------------------------------------------------------------------

describe('STTDataFilterExtension getShaders', () => {
  // getShaders only reads its `extension` arg (not `this`), matching the sibling
  // extension suites.
  const getShaders = (ext: STTDataFilterExtension) =>
    (ext.getShaders as any).call({}, ext);

  it('returns a reference-stable object (one shader-cache entry per instance)', () => {
    const ext = new STTDataFilterExtension();
    expect(getShaders(ext)).toBe(getShaders(ext));
  });

  it('binds a `filterValue` attribute and a `vDataFilterAlpha` varying', () => {
    const inject = getShaders(new STTDataFilterExtension()).inject;
    expect(inject['vs:#decl']).toContain('in float filterValue;');
    expect(inject['vs:#decl']).toContain('out float vDataFilterAlpha;');
    expect(inject['fs:#decl']).toContain('in float vDataFilterAlpha;');
  });

  it('hard-clips with step() and discards fully-filtered fragments', () => {
    const inject = getShaders(new STTDataFilterExtension()).inject;
    expect(inject['vs:#main-start']).toContain(
      'step(sttFilter.filterMin, filterValue)',
    );
    expect(inject['vs:#main-start']).toContain(
      'step(filterValue, sttFilter.filterMax)',
    );
    expect(inject['fs:#main-start']).toContain('discard');
  });

  it('soft-fades via smoothstep with deck-parity truncation fallback', () => {
    const mainStart = getShaders(new STTDataFilterExtension()).inject[
      'vs:#main-start'
    ];
    expect(mainStart).toContain('smoothstep');
    // The mix(smoothstep, step, step(soft, hard)) fallback that dodges
    // smoothstep's "edge0 >= edge1 is undefined" when the soft range is
    // truncated by the hard range (mirrors upstream STTDataFilterExtension).
    expect(mainStart).toContain(
      'step(sttFilter.filterSoftMin, sttFilter.filterMin)',
    );
    expect(mainStart).toContain(
      'step(sttFilter.filterMax, sttFilter.filterSoftMax)',
    );
  });

  it('collapses filtered features at the vertex stage (zero fragments)', () => {
    const mainEnd = getShaders(new STTDataFilterExtension()).inject[
      'vs:#main-end'
    ];
    expect(mainEnd).toContain('gl_Position = vec4(0.);');
    expect(mainEnd).toContain('vDataFilterAlpha == 0.0');
  });

  it('declares the uniform block with a poopdeck-distinct std140 name', () => {
    // Distinct from deck's own `dataFilter` module so both can coexist.
    expect(dataFilterUniforms.name).toBe('sttFilter');
    expect(dataFilterUniforms.vs).toContain(
      'layout(std140) uniform sttFilterUniforms',
    );
    const modules = getShaders(new STTDataFilterExtension()).modules as any[];
    expect(modules[0]).toBe(dataFilterUniforms);
  });
});

describe('STTDataFilterExtension attribute registration', () => {
  it('registers `filterValue` via add() + stepMode dynamic (not addInstanced)', () => {
    const perVertex: Record<string, any> = {};
    const instanced: Record<string, any> = {};
    const fakeLayer = {
      getAttributeManager: () => ({
        add: (d: Record<string, any>) => Object.assign(perVertex, d),
        addInstanced: (d: Record<string, any>) => Object.assign(instanced, d),
      }),
    };
    const ext = new STTDataFilterExtension();
    (ext.initializeState as any).call(fakeLayer, {}, ext);

    expect(Object.keys(instanced)).toEqual([]);
    expect(Object.keys(perVertex)).toEqual(['filterValue']);
    expect(perVertex.filterValue.size).toBe(1);
    expect(perVertex.filterValue.type).toBe('float32');
    expect(perVertex.filterValue.stepMode).toBe('dynamic');
    // Falls back to the constant `getFilterValue` accessor when a tile lacks
    // the binary column.
    expect(perVertex.filterValue.accessor).toBe('getFilterValue');
  });
});

describe('STTDataFilterExtension draw() uniform forwarding', () => {
  function drawUniforms(props: Record<string, any>) {
    const ext = new STTDataFilterExtension();
    let captured: any;
    const fakeLayer = {
      props,
      setShaderModuleProps: (u: any) => {
        captured = u;
      },
    };
    (ext.draw as any).call(fakeLayer, {}, ext);
    return captured.sttFilter;
  }

  it('idles (enabled=0) when no filterRange is supplied', () => {
    const u = drawUniforms({ filterProperty: 'mag' });
    expect(u.enabled).toBe(0);
    expect(u.useSoftMargin).toBe(0);
  });

  it('activates a hard range: min/max forwarded, soft edges collapse onto them', () => {
    const u = drawUniforms({ filterRange: [2, 8] });
    expect(u.enabled).toBe(1);
    expect(u.useSoftMargin).toBe(0);
    expect(u.filterMin).toBe(2);
    expect(u.filterMax).toBe(8);
    expect(u.filterSoftMin).toBe(2);
    expect(u.filterSoftMax).toBe(8);
    expect(u.transformSize).toBe(1);
    expect(u.transformColor).toBe(1);
  });

  it('a soft range turns on useSoftMargin and forwards the soft bounds', () => {
    const u = drawUniforms({ filterRange: [0, 10], filterSoftRange: [2, 8] });
    expect(u.enabled).toBe(1);
    expect(u.useSoftMargin).toBe(1);
    expect(u.filterMin).toBe(0);
    expect(u.filterMax).toBe(10);
    expect(u.filterSoftMin).toBe(2);
    expect(u.filterSoftMax).toBe(8);
  });

  it('filterEnabled:false forces enabled=0 even with a valid range', () => {
    expect(
      drawUniforms({ filterRange: [2, 8], filterEnabled: false }).enabled,
    ).toBe(0);
  });

  it('forwards the transform flags', () => {
    const u = drawUniforms({
      filterRange: [2, 8],
      filterTransformSize: false,
      filterTransformColor: false,
    });
    expect(u.transformSize).toBe(0);
    expect(u.transformColor).toBe(0);
  });

  it('a malformed range (non-finite) idles rather than corrupting the uniforms', () => {
    expect(drawUniforms({ filterRange: [NaN, 8] }).enabled).toBe(0);
    expect(drawUniforms({ filterRange: [2] }).enabled).toBe(0);
  });
});

describe('STTDataFilterExtension shader module (real luma ShaderInputs)', () => {
  it('flows the filter scalars through to the UBO values (no getUniforms drop)', () => {
    // The module has no getUniforms, so luma writes the props straight to the
    // UBO — this proves the uniformTypes declaration matches what draw() sends.
    const si = new ShaderInputs<{ sttFilter: Record<string, unknown> }>(
      { sttFilter: dataFilterUniforms as any },
      { disableWarnings: true },
    );
    si.setProps({
      sttFilter: {
        filterMin: 2,
        filterMax: 8,
        filterSoftMin: 3,
        filterSoftMax: 7,
        enabled: 1,
        useSoftMargin: 1,
        transformSize: 0,
        transformColor: 1,
      },
    });
    const values = si.getUniformValues() as any;
    expect(values.sttFilter.enabled).toBe(1);
    expect(values.sttFilter.filterMin).toBe(2);
    expect(values.sttFilter.filterMax).toBe(8);
    expect(values.sttFilter.filterSoftMin).toBe(3);
    expect(values.sttFilter.filterSoftMax).toBe(7);
    expect(values.sttFilter.useSoftMargin).toBe(1);
    expect(values.sttFilter.transformColor).toBe(1);
  });
});

describe('STTDataFilterExtension filterSize v1 guard', () => {
  it('warns once and clamps to 1 for an unsupported filterSize', () => {
    _resetWarnOnce();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Options are typed to `1`; cast to exercise the runtime clamp.
      expect(
        () => new STTDataFilterExtension({ filterSize: 3 } as any),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('filterSize'));
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — layer integration (AnimatedPointLayer + AnimatedPathLayer)
// ---------------------------------------------------------------------------

/** Point tile carrying a numeric `mag` column (the filter target). */
function pointTile() {
  const tile = makePointTile({
    positions: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    startTimes: [0, 1, 2],
    endTimes: [1, 2, 3],
    timeOffset: 0,
  });
  tile.layers[0].features.numericProps['mag'] = new Float32Array([
    1, 2, 3,
  ]) as any;
  return tile;
}

/** Two 2-vertex paths carrying a per-feature numeric `score` column. */
function pathTile() {
  const tile = makePathTile({
    paths: [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
    ],
    startTimes: [0, 0],
    endTimes: [100, 100],
    timeOffset: 0,
  });
  tile.layers[0].features.numericProps['score'] = new Float32Array([
    10, 20,
  ]) as any;
  return tile;
}

async function makePointLayer(props: Record<string, any> = {}) {
  const { AnimatedPointLayer } =
    await import('../src/layers/core/animated-point-layer');
  const layer: any = Object.create((AnimatedPointLayer as any).prototype);
  layer.props = {
    id: 'pts',
    fillColor: [255, 128, 0, 255],
    radius: 5,
    radiusUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = { __k: 'time' };
  layer.categoryColorExtension = { __k: 'category' };
  layer.dataFilterExtension = new STTDataFilterExtension({ filterSize: 1 });
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  return layer;
}

async function makePathLayer(props: Record<string, any> = {}) {
  const { AnimatedPathLayer } =
    await import('../src/layers/core/animated-path-layer');
  const layer: any = Object.create((AnimatedPathLayer as any).prototype);
  layer.props = {
    id: 'paths',
    pathColor: [0, 150, 255, 255],
    pathWidth: 3,
    widthUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = { __k: 'time' };
  layer.categoryColorExtension = { __k: 'category' };
  layer.dataFilterExtension = new STTDataFilterExtension({ filterSize: 1 });
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  return layer;
}

/** Build the single sublayer for `tile` through the real prepare/build path. */
function buildSub(layer: any, tile: any) {
  return layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
}

beforeEach(() => {
  vi.resetModules();
  _resetWarnOnce();
});

describe.each([
  {
    name: 'AnimatedPointLayer',
    make: makePointLayer,
    tile: pointTile,
    column: 'mag',
    // Points ride the tile's own Float32Array zero-copy.
    assertBaked: (attr: any, tile: any) => {
      expect(attr.value).toBe(tile.layers[0].features.numericProps.mag);
      expect(attr.size).toBe(1);
    },
  },
  {
    name: 'AnimatedPathLayer',
    make: makePathLayer,
    tile: pathTile,
    column: 'score',
    // Paths expand the per-feature value PER-VERTEX (2 paths × 2 verts = 4).
    assertBaked: (attr: any) => {
      expect(attr.value).toBeInstanceOf(Float32Array);
      expect(Array.from(attr.value)).toEqual([10, 10, 20, 20]);
      expect(attr.size).toBe(1);
    },
  },
])(
  '$name filterProperty integration',
  ({ make, tile, column, assertBaked }) => {
    it('does NOT compose STTDataFilterExtension when filterProperty is unset (zero cost)', async () => {
      const layer = await make();
      const sub = buildSub(layer, tile());
      expect(sub.props.extensions).not.toContain(layer.dataFilterExtension);
      expect(sub.props.data.attributes.filterValue).toBeUndefined();
      // No filter props leak onto the sublayer.
      expect(sub.props.filterEnabled).toBeUndefined();
      expect(sub.props.filterRange).toBeUndefined();
    });

    it('composes STTDataFilterExtension and bakes the named column when set', async () => {
      const layer = await make({ filterProperty: column, filterRange: [0, 5] });
      const t = tile();
      const sub = buildSub(layer, t);
      // Composed AFTER the time + category extensions.
      expect(sub.props.extensions).toContain(layer.dataFilterExtension);
      const idx = sub.props.extensions.indexOf(layer.dataFilterExtension);
      expect(idx).toBe(sub.props.extensions.length - 1);
      // The filter column is bound to the `filterValue` attribute.
      assertBaked(sub.props.data.attributes.filterValue, t);
    });

    it('forwards filterRange / filterSoftRange / filterEnabled as sublayer props', async () => {
      const layer = await make({
        filterProperty: column,
        filterRange: [1, 4],
        filterSoftRange: [2, 3],
      });
      const sub = buildSub(layer, tile());
      expect(sub.props.filterRange).toEqual([1, 4]);
      expect(sub.props.filterSoftRange).toEqual([2, 3]);
      // Present column ⇒ the filter is live.
      expect(sub.props.filterEnabled).toBe(true);
      // Constant fallback for tiles that lack the column.
      expect(sub.props.getFilterValue).toBe(0);
    });

    it('idles the filter for a tile missing the named column (extension installed, disabled)', async () => {
      const layer = await make({
        filterProperty: 'absent',
        filterRange: [0, 5],
      });
      const sub = buildSub(layer, tile());
      // Extension still installed (per-layer constant list) …
      expect(sub.props.extensions).toContain(layer.dataFilterExtension);
      // … but no attribute baked, so the per-tile enable is off → renders all.
      expect(sub.props.data.attributes.filterValue).toBeUndefined();
      expect(sub.props.filterEnabled).toBe(false);
    });

    it('a function accessor warns once and is ignored (no extension, no attribute)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const layer = await make({
          filterProperty: (d: any) => d[column],
          filterRange: [0, 5],
        });
        const sub = buildSub(layer, tile());
        expect(sub.props.extensions).not.toContain(layer.dataFilterExtension);
        expect(sub.props.data.attributes.filterValue).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('filterProperty'),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('filterEnabled:false forwards false even with a present column', async () => {
      const layer = await make({
        filterProperty: column,
        filterRange: [0, 5],
        filterEnabled: false,
      });
      const sub = buildSub(layer, tile());
      expect(sub.props.filterEnabled).toBe(false);
    });
  },
);

// Regression: the path pipeline sits at WebGL2's 16 vertex-attribute floor
// (NoPickingPathLayer 12 + TimeFilterExtension 3 + one extension attribute).
// Installing BOTH CategoryColorExtension (`instanceCategoryIndex`) AND
// STTDataFilterExtension (`filterValue`) would make 17 — a fatal link failure
// (blank paths) on GPUs reporting exactly 16. The path family never uses the
// GPU category path (categorical color is CPU-expanded into `getColor`;
// `gpuPalette` is always null), so when a filter is installed the layer DROPS
// the idle CategoryColorExtension and spends that slot on `filterValue`,
// keeping the count at 16. The point layer (roomier budget, genuine GPU
// category) must be UNAFFECTED — it keeps both.
describe('AnimatedPathLayer filterProperty attribute budget (16-slot floor)', () => {
  it('DROPS the idle CategoryColorExtension when a filter is installed (stays at 16, not 17)', async () => {
    const layer = await makePathLayer({
      filterProperty: 'score',
      filterRange: [0, 5],
    });
    const sub = buildSub(layer, pathTile());
    // filterValue IS composed …
    expect(sub.props.extensions).toContain(layer.dataFilterExtension);
    // … and the always-idle CategoryColorExtension is REMOVED to free its slot.
    expect(sub.props.extensions).not.toContain(layer.categoryColorExtension);
    // TimeFilterExtension stays. Exactly two internal extensions: time + filter.
    expect(sub.props.extensions).toContain(layer.timeFilterExtension);
    expect(sub.props.extensions).toEqual([
      layer.timeFilterExtension,
      layer.dataFilterExtension,
    ]);
  });

  it('keeps the CategoryColorExtension when NO filter is installed (baseline)', async () => {
    const layer = await makePathLayer();
    const sub = buildSub(layer, pathTile());
    expect(sub.props.extensions).toContain(layer.categoryColorExtension);
    expect(sub.props.extensions).not.toContain(layer.dataFilterExtension);
    expect(sub.props.extensions).toEqual([
      layer.timeFilterExtension,
      layer.categoryColorExtension,
    ]);
  });

  it('does NOT drop CategoryColorExtension on the point layer when filtering (roomy budget, genuine GPU category)', async () => {
    const layer = await makePointLayer({
      filterProperty: 'mag',
      filterRange: [0, 5],
    });
    const sub = buildSub(layer, pointTile());
    // The point layer keeps BOTH — the drop is a path-only budget workaround.
    expect(sub.props.extensions).toContain(layer.categoryColorExtension);
    expect(sub.props.extensions).toContain(layer.dataFilterExtension);
  });
});

describe('filterProperty naming a categorical column', () => {
  it('warns once and bakes no filter attribute (point layer)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = pointTile();
      t.layers[0].features.categoricalProps['kind'] = {
        categories: ['a', 'b'],
        indices: new Uint16Array([0, 1, 0]),
      } as any;
      const layer = await makePointLayer({
        filterProperty: 'kind',
        filterRange: [0, 5],
      });
      const sub = buildSub(layer, t);
      expect(sub.props.data.attributes.filterValue).toBeUndefined();
      expect(sub.props.filterEnabled).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('categorical'));
    } finally {
      warn.mockRestore();
    }
  });
});
