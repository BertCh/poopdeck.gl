/**
 * deck.gl prop-parity coverage for AnimatedPolygonLayer's outline subsystem
 * (deckgl-parity-audit-2026-07 §3, AnimatedPolygonLayer).
 *
 * AnimatedPolygonLayer wraps SolidPolygonLayer, which has NO outline sublayer.
 * These tests pin the newly-landed `stroked` outline PathLayer and the
 * line-* family that rides on it:
 *   - `stroked` → a SECOND (outline) sublayer per tile, off by default;
 *   - `getLineColor` (constant) → fill wireframe edge color AND outline color,
 *     shippable standalone (wireframe edges were locked at black);
 *   - `getLineWidth` (constant OR column) / `lineWidthUnits` /
 *     `lineWidthMinPixels` / `lineJointRounded` / `lineMiterLimit` /
 *     `lineDashJustified` → outline PathLayer pass-throughs;
 *   - `_full3d` → SolidPolygonLayer pass-through.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePolygonTile } from './fake-tile';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeSolidPolygonLayer implements CapturedLayer {
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
  return {
    SolidPolygonLayer: FakeSolidPolygonLayer,
    PathLayer: FakePathLayer,
  };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer<P = any> {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return {
    ...core,
    Layer: FakeLayer,
    project32: { name: 'project32' },
  };
});

/** A sublayer class for `_subLayerProps.<id>.type` substitution tests. */
class SwappedLayer implements CapturedLayer {
  props: Record<string, any>;
  constructor(props: Record<string, any>) {
    this.props = props;
  }
}

/** Single closed-ring triangle polygon. */
function basePolygonTile() {
  return makePolygonTile({
    polygons: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    startTimes: [0],
    endTimes: [100],
    timeOffset: 0,
  });
}

/** Two closed-ring polygons — exercises feature-level startIndices / loops. */
function twoPolygonTile() {
  return makePolygonTile({
    polygons: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
      [
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 2],
      ],
    ],
    startTimes: [0, 0],
    endTimes: [100, 100],
    timeOffset: 0,
  });
}

async function makePolygonLayer(props: Record<string, any> = {}) {
  const { AnimatedPolygonLayer } =
    await import('../src/layers/core/animated-polygon-layer');
  const layer: any = Object.create((AnimatedPolygonLayer as any).prototype);
  layer.props = {
    id: 'poly',
    fillColor: [255, 140, 0, 180],
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    filled: true,
    extruded: false,
    elevation: 0,
    // Outline subsystem — concrete defaults (Object.create bypasses
    // static defaultProps, so mirror them here like the sibling harnesses).
    stroked: false,
    getLineColor: [0, 0, 0, 255],
    getLineWidth: 1,
    lineWidthUnits: 'meters',
    lineWidthMinPixels: 0,
    lineJointRounded: false,
    lineMiterLimit: 4,
    lineDashJustified: false,
    _full3d: false,
    fadeInDuration: 500,
    fadeOutDuration: 500,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  layer.lastTilesRef = null;
  return layer;
}

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// stroked: the outline sublayer
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer stroked outline sublayer', () => {
  it('stroked:false emits ONLY the fill sublayer (zero extra cost)', async () => {
    const layer = await makePolygonLayer({ stroked: false });
    layer.state = { tiles: [basePolygonTile()] };
    const subs = layer.renderLayers();
    expect(subs).toHaveLength(1);
    // The single sublayer is the SolidPolygonLayer fill.
    const { SolidPolygonLayer } = await import('@deck.gl/layers');
    expect(subs[0]).toBeInstanceOf(SolidPolygonLayer as any);
  });

  it('stroked:true adds a SECOND outline PathLayer sublayer after the fill', async () => {
    const layer = await makePolygonLayer({ stroked: true });
    layer.state = { tiles: [basePolygonTile()] };
    const subs = layer.renderLayers();
    expect(subs).toHaveLength(2);
    const { SolidPolygonLayer, PathLayer } = await import('@deck.gl/layers');
    // Fill draws first (under the stroke), outline second.
    expect(subs[0]).toBeInstanceOf(SolidPolygonLayer as any);
    expect(subs[1]).toBeInstanceOf(PathLayer as any); // NoPickingPathLayer extends PathLayer
  });

  it('outline is fed the same ring positions + startIndices with _pathType loop', async () => {
    const layer = await makePolygonLayer({ stroked: true });
    const tile = twoPolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    expect(outline.props._pathType).toBe('loop');
    // Two features → two loop paths; feature-level startIndices reused verbatim.
    expect(outline.props.data.length).toBe(2);
    expect(outline.props.data.startIndices).toBe(prepared.data.startIndices);
    // getPath rides the SAME zero-copy positions buffer as the fill's getPolygon.
    expect(outline.props.data.attributes.getPath.value).toBe(
      prepared.data.attributes.getPolygon.value,
    );
    expect(outline.props.data.attributes.getPath.size).toBe(prepared.dims);
    expect(outline.props.positionFormat).toBe('XY');
  });

  it('outline reuses the fill per-vertex time buffers so it filters/fades in lock-step', async () => {
    const layer = await makePolygonLayer({ stroked: true });
    const tile = basePolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    expect(outline.props.data.attributes.instanceStartTime).toBe(
      prepared.data.attributes.instanceStartTime,
    );
    expect(outline.props.data.attributes.instanceEndTime).toBe(
      prepared.data.attributes.instanceEndTime,
    );
    // TimeFilterExtension is installed; the constant-color outline skips the
    // CategoryColorExtension (keeps PathLayer within the WebGL2 attr budget).
    expect(outline.props.extensions).toEqual([layer.timeFilterExtension]);
    expect(outline.props.getTime).toBe(layer.boundGetTime);
    expect(outline.props.timeOffset).toBe(prepared.timeOffset);
    expect(outline.props.timeWindow).toBe(1000);
    expect(outline.props.fadeInDuration).toBe(500);
    expect(outline.props.fadeOutDuration).toBe(500);
  });

  it('outline is non-pickable (fill owns picking)', async () => {
    const layer = await makePolygonLayer({ stroked: true, pickable: true });
    const tile = basePolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    expect(outline.props.pickable).toBe(false);
  });

  it('toggling stroked invalidates the cached sublayers', async () => {
    const layer = await makePolygonLayer({ stroked: false });
    layer.state = { tiles: [basePolygonTile()] };
    const first = layer.renderLayers();
    expect(first).toHaveLength(1);
    // Unchanged props → identical cached instances.
    expect(layer.renderLayers()[0]).toBe(first[0]);
    layer.props.stroked = true;
    const second = layer.renderLayers();
    expect(second).toHaveLength(2);
    expect(second[0]).not.toBe(first[0]);
  });

  it('_subLayerProps.outline swaps the outline sublayer class', async () => {
    const layer = await makePolygonLayer({
      stroked: true,
      _subLayerProps: { outline: { type: SwappedLayer } },
    });
    layer.state = { tiles: [basePolygonTile()] };
    const subs = layer.renderLayers();
    expect(subs[1]).toBeInstanceOf(SwappedLayer);
  });
});

// ---------------------------------------------------------------------------
// line-* style props forward to the outline PathLayer
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer outline line-* pass-throughs', () => {
  it('getLineColor / lineWidth* / lineJoint* forward to the outline', async () => {
    const layer = await makePolygonLayer({
      stroked: true,
      getLineColor: [12, 34, 56, 200],
      getLineWidth: 7,
      lineWidthUnits: 'pixels',
      lineWidthMinPixels: 3,
      lineJointRounded: true,
      lineMiterLimit: 9,
      lineDashJustified: true,
    });
    const tile = basePolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    expect(outline.props.getColor).toEqual([12, 34, 56, 200]);
    expect(outline.props.getWidth).toBe(7);
    expect(outline.props.widthUnits).toBe('pixels');
    expect(outline.props.widthMinPixels).toBe(3);
    expect(outline.props.jointRounded).toBe(true);
    expect(outline.props.miterLimit).toBe(9);
    expect(outline.props.dashJustified).toBe(true);
  });

  it('getLineWidth column name bakes a PER-VERTEX width buffer onto the outline', async () => {
    const layer = await makePolygonLayer({ stroked: true, getLineWidth: 'w' });
    const tile = twoPolygonTile();
    // Two 4-vertex rings → featureCount 2, vertexCount 8, startIndices [0,4,8].
    tile.layers[0].features.numericProps['w'] = new Float32Array([2, 5]) as any;
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    // Width column must be EXPANDED per-vertex, not left per-feature: PathLayer's
    // binary-mode tessellator sizes the instanced draw to the total ring-vertex
    // count (8), so a 2-element per-feature buffer would under-size the draw and
    // throw "vertex buffer is not big enough" on ANGLE/Metal. Each ring's four
    // vertices carry the feature's width.
    const vertexCount = tile.layers[0].features.positions.length / 2;
    expect(prepared.outlineWidths).toBeInstanceOf(Float32Array);
    expect(prepared.outlineWidths.length).toBe(vertexCount);
    expect([...prepared.outlineWidths]).toEqual([2, 2, 2, 2, 5, 5, 5, 5]);
    const outline = layer.buildOutlineSublayer(prepared);
    // The bound getWidth buffer length must match the ring-vertex count so the
    // instanced draw is fully backed.
    const bound = outline.props.data.attributes.getWidth.value;
    expect(bound.length).toBe(vertexCount);
    expect([...bound]).toEqual([2, 2, 2, 2, 5, 5, 5, 5]);
    // Constant getWidth stays as the fallback (the attribute wins in deck).
    expect(outline.props.getWidth).toBe(1);
  });

  it('getLineWidth constant leaves outlineWidths null (constant rides the prop)', async () => {
    const layer = await makePolygonLayer({ stroked: true, getLineWidth: 4 });
    const tile = basePolygonTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.outlineWidths).toBeNull();
    const outline = layer.buildOutlineSublayer(prepared);
    expect(outline.props.data.attributes.getWidth).toBeUndefined();
    expect(outline.props.getWidth).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// getLineColor on the FILL (wireframe) — shippable standalone (no stroked)
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer getLineColor on the fill (wireframe edges)', () => {
  it('forwards getLineColor to the SolidPolygonLayer even when stroked:false', async () => {
    const layer = await makePolygonLayer({
      stroked: false,
      wireframe: true,
      extruded: true,
      getLineColor: [10, 20, 30, 255],
    });
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    // Previously locked at deck's black default; now colorable.
    expect(fill.props.getLineColor).toEqual([10, 20, 30, 255]);
    expect(fill.props.wireframe).toBe(true);
  });

  it('getLineColor defaults to deck black when unset', async () => {
    const layer = await makePolygonLayer({});
    layer.props.getLineColor = null; // simulate "unset" alias
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(fill.props.getLineColor).toEqual([0, 0, 0, 255]);
  });

  it('a function getLineColor warns once and falls back to black', async () => {
    const { _resetWarnOnce } = await import('../src/lib/log');
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePolygonLayer({
        stroked: true,
        getLineColor: () => [255, 0, 0, 255],
      });
      const tile = basePolygonTile();
      const prepared = layer.prepareTile(tile, tile.layers[0]);
      const fill = layer.buildSublayer(prepared);
      const outline = layer.buildOutlineSublayer(prepared);
      expect(fill.props.getLineColor).toEqual([0, 0, 0, 255]);
      expect(outline.props.getColor).toEqual([0, 0, 0, 255]);
      const accessorWarnings = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('function accessor'),
      );
      expect(accessorWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// _full3d → SolidPolygonLayer pass-through
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer _full3d', () => {
  it('forwards _full3d into the SolidPolygonLayer fill', async () => {
    const layer = await makePolygonLayer({ _full3d: true });
    const tile = basePolygonTile();
    const fill = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(fill.props._full3d).toBe(true);
  });

  it('a _full3d change invalidates the cached sublayers', async () => {
    const layer = await makePolygonLayer({ _full3d: false });
    layer.state = { tiles: [basePolygonTile()] };
    const [first] = layer.renderLayers();
    expect(layer.renderLayers()[0]).toBe(first);
    layer.props._full3d = true;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props._full3d).toBe(true);
  });
});
