/**
 * SplatLayer / SplatPrimitiveLayer hardening.
 *
 * Surfel rendering leans on three contracts that all fail QUIETLY:
 *
 *  - GPU STATE — surface splatting is sort-free only because depth-write is on
 *    with an alpha cutoff. deck calls `applyModelParameters(...)` before every
 *    draw and luma's `Model.setParameters` REPLACES `model.parameters`
 *    wholesale, so anything set in the `Model` constructor is gone after frame
 *    1; it happens to look right today only because deck's WebGL global
 *    defaults coincide.
 *  - COLUMN SHAPE — centres bind with `size: 2` off the geometry buffer, and
 *    the quaternion/scale/colour vectors bind by width alone. A 3D archive, or
 *    a column with the wrong leaf type, produces garbage geometry / blown-out
 *    white rather than an error.
 *  - CACHE RESIDENCY — deck moves only `state` onto the layer object it builds
 *    for each render, so class-field caches die on any unmemoized `new
 *    SplatLayer` in a React render.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile, makePathTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

vi.mock('../src/layers/internal/splat-primitive-layer', () => {
  class FakeSplatPrimitiveLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { SplatPrimitiveLayer: FakeSplatPrimitiveLayer };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

/** A surfel point tile with the interleaved `--vector-group` columns. */
function surfelTile(
  n: number,
  opts: {
    colorLeaf?: 'u8' | 'f32' | 'none';
    quatLeaf?: 'f32' | 'u8';
    dims?: number;
    tileId?: { z: number; x: number; y: number; t: number };
  } = {},
): Tile {
  const { colorLeaf = 'u8', quatLeaf = 'f32', dims = 2 } = opts;
  const tile = makePointTile({
    positions: Array.from({ length: n }, (_, i) => [
      -122.4 + i * 0.001,
      37.77 + i * 0.001,
    ]),
    startTimes: Array.from({ length: n }, (_, i) => i * 100),
    endTimes: Array.from({ length: n }, (_, i) => i * 100),
    timeOffset: 1_000_000,
    tileId: opts.tileId,
  });
  const f = tile.layers[0].features;
  f.positionDimensions = dims;
  f.numericProps['z'] = new Float32Array(n).fill(1);
  const quatValues = Array.from({ length: n * 4 }, (_, i) =>
    i % 4 === 3 ? 1 : 0,
  );
  f.vectorProps = {
    surfel_quat: {
      value:
        quatLeaf === 'f32'
          ? new Float32Array(quatValues)
          : new Uint8Array(quatValues),
      size: 4,
    },
    surfel_scale: { value: new Float32Array(n * 2).fill(0.3), size: 2 },
  };
  if (colorLeaf !== 'none') {
    const rgba = Array.from({ length: n * 4 }, (_, i) => (i % 4) * 60);
    f.vectorProps['surfel_rgba'] = {
      value: colorLeaf === 'u8' ? new Uint8Array(rgba) : new Float32Array(rgba),
      size: 4,
    };
  }
  return tile;
}

describe('SplatLayer hardening', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: Record<string, any>) => any;

  beforeEach(async () => {
    vi.resetModules();
    LayerCtor = (await import('../src/layers/core/splat-layer'))
      .SplatLayer as any;

    makeLayer = (opts: Record<string, any> = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'surfel',
        quaternionColumn: 'surfel_quat',
        scaleColumn: 'surfel_scale',
        colorColumn: 'surfel_rgba',
        elevationProperty: 'z',
        elevationScale: 1,
        fallbackColor: [200, 205, 215, 255],
        temporalSigma: 180,
        cumulative: false,
        revealFade: 0,
        temporalSigmaDynamic: 0,
        sizeScale: 1,
        gaussianFalloff: 3,
        alphaCutoff: 0.04,
        timeWindow: 2000,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer.boundGetTime = () => 0;
      return layer;
    };
  });

  // ── Cache residency ─────────────────────────────────────────────────────

  it('keeps the prepared + sublayer caches across a simulated _transferState', () => {
    const first = makeLayer();
    first.state = { tiles: [surfelTile(4)] };
    const [before] = first.renderLayers();
    expect(first.preparedTileCache.size).toBe(1);

    const next = makeLayer();
    next.state = first.state; // ← exactly what Layer._transferState does
    const [after] = next.renderLayers();

    expect(after).toBe(before); // same sublayer ⇒ no GPU re-upload
    expect(after.props.data).toBe(before.props.data);
    expect(next.preparedTileCache.size).toBe(1);
  });

  it('drops both caches on finalizeState', () => {
    const layer = makeLayer();
    layer.state = { tiles: [surfelTile(2)] };
    layer.renderLayers();
    expect(layer.sublayerCache.size).toBe(1);

    Object.getPrototypeOf(LayerCtor.prototype).finalizeState = () => {};
    layer.finalizeState({} as any);
    expect(layer.sublayerCache.size).toBe(0);
    expect(layer.preparedTileCache.size).toBe(0);
  });

  // ── Geometry / dimension guards ─────────────────────────────────────────

  it('skips a LineString tile layer rather than misreading the vertex run', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const paths = makePathTile({
        paths: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        startTimes: [0],
        endTimes: [1],
        timeOffset: 0,
      });
      const layer = makeLayer();
      layer.state = { tiles: [paths] };
      expect(layer.renderLayers()).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('LineString geometry'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('skips (and names) a 3D surfel tile instead of reading pairs across xyz', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = makeLayer();
      layer.state = { tiles: [surfelTile(3, { dims: 3 })] };
      expect(layer.renderLayers()).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('3D positions'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('renders a normal 2D surfel tile unchanged', () => {
    const layer = makeLayer();
    layer.state = { tiles: [surfelTile(3)] };
    const [sub] = layer.renderLayers();
    expect(sub.props.data.length).toBe(3);
    expect(sub.props.data.attributes.instancePositions.size).toBe(2);
  });

  // ── Vector-column leaf types ────────────────────────────────────────────

  it('binds a u8 surfel colour column ZERO-COPY and normalized', () => {
    const layer = makeLayer();
    const tile = surfelTile(2, { colorLeaf: 'u8' });
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    const attr = sub.props.data.attributes.instanceColors;
    expect(attr.value).toBe(
      tile.layers[0].features.vectorProps!.surfel_rgba.value,
    );
    expect(attr.normalized).toBe(true);
    expect(sub.props.useVertexColor).toBe(true);
  });

  it('converts an f32 surfel colour leaf (and warns) instead of binding float32x4', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = makeLayer();
      layer.state = { tiles: [surfelTile(2, { colorLeaf: 'f32' })] };
      const [sub] = layer.renderLayers();
      const attr = sub.props.data.attributes.instanceColors;
      expect(attr.value).toBeInstanceOf(Uint8Array);
      expect([...attr.value]).toEqual([0, 60, 120, 180, 0, 60, 120, 180]);
      expect(attr.normalized).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('float32 leaf'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('skips a tile whose quaternion column has a u8 leaf (format mismatch, not a rescale)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = makeLayer();
      layer.state = { tiles: [surfelTile(2, { quatLeaf: 'u8' })] };
      expect(layer.renderLayers()).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('u8 leaf'));
    } finally {
      warn.mockRestore();
    }
  });

  // ── parameters authority ────────────────────────────────────────────────

  it('does NOT let the composite’s empty inherited `parameters` shadow the primitive default', () => {
    const layer = makeLayer();
    layer.props.parameters = {}; // deck's Layer.defaultProps value
    layer.state = { tiles: [surfelTile(2)] };
    const [sub] = layer.renderLayers();
    expect('parameters' in sub.props).toBe(false);
  });

  it('forwards a caller-supplied `parameters` (deck prop-beats-default semantics)', () => {
    const layer = makeLayer();
    layer.props.parameters = { depthCompare: 'always' };
    layer.state = { tiles: [surfelTile(2)] };
    const [sub] = layer.renderLayers();
    expect(sub.props.parameters).toEqual({ depthCompare: 'always' });
  });

  // ── Dead state ──────────────────────────────────────────────────────────

  it('no longer carries the unread `hasDynamic` flag on prepared tiles', () => {
    const layer = makeLayer();
    const tile = surfelTile(2);
    tile.layers[0].features.numericProps['is_dynamic'] = new Float32Array([
      0, 1,
    ]);
    layer.state = { tiles: [tile] };
    layer.renderLayers();
    const prepared = layer.preparedTileCache.values().next().value;
    expect('hasDynamic' in prepared).toBe(false);
    // The attribute itself still binds — only the unread bookkeeping went.
    expect(prepared.data.attributes.instanceIsDynamic).toBeDefined();
  });
});
