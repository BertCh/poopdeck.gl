/**
 * Stock-deck extension pass-through contract.
 *
 * Four deck.gl extensions work on the STT layers **today** with no adapter —
 * you just add them to the top-level `extensions` prop:
 *   - BrushingExtension  (show/hide by pointer distance)
 *   - MaskExtension      (geofence to another layer's geometry)
 *   - ClipExtension      (rectangular clip bounds)
 *   - PathStyleExtension (dashed / offset paths)
 *
 * "Works" means two things reach the built binary sublayer:
 *   1. the extension INSTANCE — via `composeExtensions`, which appends the
 *      user's `extensions` to the layer's internal set so a user extension is
 *      never dropped by the explicit sublayer `extensions` list; and
 *   2. its scalar PROPS — via deck's extension `getSubLayerProps` pass, which
 *      forwards the keys named in each extension's `defaultProps` from the
 *      composite onto the sublayer.
 *
 * We run REAL deck extensions against a faithful `@deck.gl/core` mock that
 * reproduces that pass (see `faithful-deck-core.ts`) — no GPU needed.
 *
 * Documented limits asserted here: per-FEATURE data-driven variants
 * (`brushingTarget:'custom'` via `getBrushingTarget`, per-feature
 * `getDashArray`/`getOffset`) cannot run against binary tiles — only the
 * CONSTANT forms pass through. The constants forward fine; a function accessor
 * is forwarded verbatim but has no per-row data to bind to on a binary tile.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BrushingExtension,
  MaskExtension,
  ClipExtension,
  PathStyleExtension,
} from '@deck.gl/extensions';
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
  return { ScatterplotLayer: FakeScatterplotLayer, PathLayer: FakePathLayer };
});

// Faithful core mock — reproduces deck's extension getSubLayerProps pass so a
// REAL extension's scalar props reach the sublayer.
vi.mock('@deck.gl/core', async () => {
  const core = (
    await import('./faithful-deck-core')
  ).createFaithfulDeckCoreMock();
  class FakeLayer<P = any> {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { ...core, Layer: FakeLayer, project32: { name: 'project32' } };
});

function basePointTile() {
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
  return tile;
}

function basePathTile() {
  return makePathTile({
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
    updateTriggers: {},
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
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
    updateTriggers: {},
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  return layer;
}

/** True if `list` holds an instance of `ctor`. */
function hasExtension(list: any[], ctor: any): boolean {
  return Array.isArray(list) && list.some((e) => e instanceof ctor);
}

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// BrushingExtension
// ---------------------------------------------------------------------------

describe('BrushingExtension passthrough (point layer)', () => {
  it('forwards the extension instance AND its constant scalar props to the sublayer', async () => {
    const layer = await makePointLayer({
      extensions: [new BrushingExtension()],
      brushingEnabled: true,
      brushingRadius: 5000,
      brushingTarget: 'source',
    });
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    // 1. instance reaches the sublayer (composeExtensions), alongside the
    //    internal time-filter / category-color extensions.
    expect(hasExtension(sub.props.extensions, BrushingExtension)).toBe(true);
    // 2. scalar props forwarded via the extension getSubLayerProps pass.
    expect(sub.props.brushingEnabled).toBe(true);
    expect(sub.props.brushingRadius).toBe(5000);
    expect(sub.props.brushingTarget).toBe('source');
  });

  it("documented limit: brushingTarget:'custom' needs getBrushingTarget, a per-feature accessor that can't bind to a binary tile", async () => {
    const custom = () => [0, 0] as [number, number];
    const layer = await makePointLayer({
      extensions: [new BrushingExtension()],
      brushingTarget: 'custom',
      getBrushingTarget: custom,
    });
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    // The accessor IS forwarded (deck copies it), but there are no JS rows on a
    // binary tile for it to run over — so only 'source'/'target'/'source_target'
    // (position-derived, GPU) are meaningful. We assert it's a passthrough only.
    expect(sub.props.brushingTarget).toBe('custom');
    expect(sub.props.getBrushingTarget).toBe(custom);
  });
});

// ---------------------------------------------------------------------------
// MaskExtension
// ---------------------------------------------------------------------------

describe('MaskExtension passthrough (point layer geofenced to a mask layer)', () => {
  it('forwards maskId / maskByInstance / maskInverted to the sublayer', async () => {
    const layer = await makePointLayer({
      extensions: [new MaskExtension()],
      maskId: 'harbor',
      maskByInstance: true,
      maskInverted: false,
    });
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    expect(hasExtension(sub.props.extensions, MaskExtension)).toBe(true);
    expect(sub.props.maskId).toBe('harbor');
    expect(sub.props.maskByInstance).toBe(true);
    expect(sub.props.maskInverted).toBe(false);
  });

  it('forwards the base `operation` prop (the mask-defining layer uses operation:"mask")', async () => {
    // `operation` is a stock base prop already forwarded by getSubLayerProps —
    // the layer that DEFINES the mask sets operation:'mask'. Prove it reaches
    // the sublayer so a mask layer can be an STT layer too.
    const layer = await makePointLayer({
      extensions: [new MaskExtension()],
      operation: 'mask',
    });
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    expect(sub.props.operation).toBe('mask');
  });
});

// ---------------------------------------------------------------------------
// ClipExtension
// ---------------------------------------------------------------------------

describe('ClipExtension passthrough (point layer)', () => {
  it('forwards clipBounds / clipByInstance (pure uniforms, no accessors)', async () => {
    const bounds: [number, number, number, number] = [-74.1, 40.6, -73.9, 40.9];
    const layer = await makePointLayer({
      extensions: [new ClipExtension()],
      clipBounds: bounds,
      clipByInstance: true,
    });
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    expect(hasExtension(sub.props.extensions, ClipExtension)).toBe(true);
    expect(sub.props.clipBounds).toEqual(bounds);
    expect(sub.props.clipByInstance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PathStyleExtension
// ---------------------------------------------------------------------------

describe('PathStyleExtension passthrough (path layer)', () => {
  it('forwards constant getDashArray / getOffset / dashJustified to the path sublayer', async () => {
    const layer = await makePathLayer({
      extensions: [new PathStyleExtension({ dash: true, offset: true })],
      getDashArray: [4, 2],
      getOffset: 1,
      dashJustified: true,
    });
    const tile = basePathTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(hasExtension(sub.props.extensions, PathStyleExtension)).toBe(true);
    // Constant dash / offset forward verbatim — the common case.
    expect(sub.props.getDashArray).toEqual([4, 2]);
    expect(sub.props.getOffset).toBe(1);
    expect(sub.props.dashJustified).toBe(true);
  });

  it('documented limit: a per-FEATURE getDashArray function is forwarded but binds to no rows on a binary tile', async () => {
    const perFeature = () => [3, 1] as [number, number];
    const layer = await makePathLayer({
      extensions: [new PathStyleExtension({ dash: true })],
      getDashArray: perFeature,
    });
    const tile = basePathTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    // Forwarded (deck copies the accessor) but there are no JS rows — so only a
    // constant [dash,gap] produces a visible dash on STT binary tiles.
    expect(sub.props.getDashArray).toBe(perFeature);
  });
});
