/**
 * SplatLayer data-shape + temporal-wiring regression guard.
 *
 * SplatLayer renders an STT point cloud as oriented anisotropic Gaussian
 * surfels: per (tile, layer) it builds a reference-stable binary `data` object
 * for one {@link SplatPrimitiveLayer} sublayer. The surfel quaternion / scale /
 * colour are baked at BUILD time as interleaved `FixedSizeList` columns
 * (`stt-build --vector-group`), so the layer binds them STRAIGHT from
 * `binary.vectorProps` with **zero per-point work** on the main thread — this
 * test pins that zero-copy contract (no re-interleave, no large allocations).
 *
 * The custom-`Model` primitive needs a real GPU, so we mock it to a prop-stashing
 * stand-in and assert on the binary `data.attributes` the composite hands it.
 */

import { describe, it, expect, vi } from 'vitest';
import { makePointTile } from './fake-tile';

// The primitive imports luma's Model/Geometry + deck's project/picking modules
// (no GPU here), so swap it for a constructor that just stashes its props.
vi.mock('../src/layers/internal/splat-primitive-layer', () => {
  class FakeSplatPrimitiveLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { SplatPrimitiveLayer: FakeSplatPrimitiveLayer };
});

// Shared composite-base mock (getSubLayerProps/getSubLayerClass contract).
vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

/** A point tile of `n` surfels with the interleaved `--vector-group` columns. */
function surfelTile(
  n: number,
  opts: { withRgb?: boolean; withSurfel?: boolean; dynamic?: number[] } = {},
) {
  const { withRgb = true, withSurfel = true, dynamic } = opts;
  const positions: number[][] = [];
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  for (let i = 0; i < n; i++) {
    positions.push([(i % 10) * 0.001 - 122.4, (i % 7) * 0.001 + 37.77]);
    startTimes.push(i * 100); // relative ms (μ_t)
    endTimes.push(i * 100);
  }
  const tile = makePointTile({
    positions,
    startTimes,
    endTimes,
    timeOffset: 1_000_000,
  });
  const f = tile.layers[0].features;
  f.numericProps['z'] = new Float32Array(
    Array.from({ length: n }, (_, i) => (i % 5) - 2),
  );
  f.vectorProps = {};
  if (withSurfel) {
    // Identity-ish quaternions (normal = up) interleaved [qx,qy,qz,qw].
    const quat = new Float32Array(n * 4);
    const scale = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      quat[i * 4 + 3] = 1; // qw = 1
      scale[i * 2] = 0.3;
      scale[i * 2 + 1] = 0.15;
    }
    f.vectorProps['surfel_quat'] = { value: quat, size: 4 };
    f.vectorProps['surfel_scale'] = { value: scale, size: 2 };
  }
  if (withRgb) {
    // Interleaved RGBA u8 with the baked confidence (0.8 → 204) already in alpha.
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = i % 256;
      rgba[i * 4 + 1] = 128;
      rgba[i * 4 + 2] = 64;
      rgba[i * 4 + 3] = 204;
    }
    f.vectorProps['surfel_rgba'] = { value: rgba, size: 4 };
  }
  // Worldbuild per-point static/dynamic column (0/1). Absent unless supplied.
  if (dynamic) f.numericProps['is_dynamic'] = new Float32Array(dynamic);
  return tile;
}

/** Minimal SplatLayer instance (Object.create + hand-rolled props/state). */
function makeSplatLayer(
  LayerCtor: any,
  tiles: any[],
  overrides: Record<string, any> = {},
) {
  const layer = Object.create(LayerCtor.prototype);
  Object.assign(layer, {
    props: {
      id: 'surfel',
      quaternionColumn: 'surfel_quat',
      scaleColumn: 'surfel_scale',
      colorColumn: 'surfel_rgba',
      elevationProperty: 'z',
      elevationScale: 1,
      fallbackColor: [200, 205, 215, 255],
      temporalSigma: 180,
      sizeScale: 1,
      gaussianFalloff: 3,
      alphaCutoff: 0.04,
      timeWindow: 2000,
      opacity: 1,
      visible: true,
      ...overrides,
    },
    state: { tiles },
    _currentTime: 0,
    boundGetTime: () => 0,
    preparedTileCache: new Map(),
    sublayerCache: new Map(),
    lastLayerPropsKey: '',
    lastTilesRef: null,
  });
  return layer;
}

describe('SplatLayer surfel sublayer architecture', () => {
  it('binds the interleaved surfel columns zero-copy (no re-pack)', async () => {
    vi.resetModules();
    const { SplatLayer } =
      (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(4);
    const f = tile.layers[0].features;
    const layer = makeSplatLayer(SplatLayer, [tile]);

    const sublayers = layer.renderLayers();
    expect(sublayers).toHaveLength(1);
    const attrs = sublayers[0].props.data.attributes;

    // Positions: 2D geometry, bound ZERO-COPY (same reference, no new array).
    expect(attrs.instancePositions.size).toBe(2);
    expect(attrs.instancePositions.value).toBe(f.positions);
    // Altitude rides its own zero-copy column (feature 2 → z = 0).
    expect(attrs.instanceElevations.size).toBe(1);
    expect(attrs.instanceElevations.value).toBe(f.numericProps['z']);
    expect(attrs.instanceElevations.value[2]).toBe(0); // (2 % 5) - 2 = 0

    // Orientation + extents: bound straight from the vector columns (zero-copy).
    expect(attrs.instanceQuaternions.size).toBe(4);
    expect(attrs.instanceQuaternions.value).toBe(
      f.vectorProps!['surfel_quat'].value,
    );
    expect([...attrs.instanceQuaternions.value.slice(0, 4)]).toEqual([
      0, 0, 0, 1,
    ]);
    expect(attrs.instanceScales.size).toBe(2);
    expect(attrs.instanceScales.value).toBe(
      f.vectorProps!['surfel_scale'].value,
    );

    // Colour: the interleaved u8 RGBA, bound normalized & zero-copy.
    expect(attrs.instanceColors.size).toBe(4);
    expect(attrs.instanceColors.normalized).toBe(true);
    expect(attrs.instanceColors.value).toBe(
      f.vectorProps!['surfel_rgba'].value,
    );
    expect([...attrs.instanceColors.value.slice(0, 4)]).toEqual([
      0, 128, 64, 204,
    ]);
    expect(sublayers[0].props.useVertexColor).toBe(true);

    // Sample times ride zero-copy as the temporal-Gaussian centres μ_t.
    expect(attrs.instanceStartTimes.value).toBe(f.startTimes);

    // Temporal + shaping wiring forwarded to the primitive.
    expect(sublayers[0].props.timeOffset).toBe(1_000_000);
    expect(sublayers[0].props.temporalSigma).toBe(180);
    expect(sublayers[0].props.sizeScale).toBe(1);
    expect(sublayers[0].props.falloff).toBe(3);
    expect(sublayers[0].props.elevationScale).toBe(1);
    expect(sublayers[0].props.data.length).toBe(4);
  });

  it('caches prepared data + sublayer instances across renders (stable refs)', async () => {
    vi.resetModules();
    const { SplatLayer } =
      (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(3);
    const layer = makeSplatLayer(SplatLayer, [tile]);

    const first = layer.renderLayers();
    const second = layer.renderLayers();
    expect(second[0]).toBe(first[0]); // same sublayer reference → no GPU re-upload
    expect(second[0].props.data).toBe(first[0].props.data); // identity dataComparator
  });

  it('skips a tile missing the surfel vector columns (warns, renders nothing)', async () => {
    vi.resetModules();
    const { SplatLayer } =
      (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(3, { withSurfel: false });
    const layer = makeSplatLayer(SplatLayer, [tile]);
    expect(layer.renderLayers()).toHaveLength(0);
  });

  it('drops the colour attribute + flags useVertexColor=false when no rgba column', async () => {
    vi.resetModules();
    const { SplatLayer } =
      (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(2, { withRgb: false });
    const layer = makeSplatLayer(SplatLayer, [tile]);

    const [sub] = layer.renderLayers();
    // No per-surfel colour → the shader uses the fallbackColor uniform instead.
    expect(sub.props.data.attributes.instanceColors).toBeUndefined();
    expect(sub.props.useVertexColor).toBe(false);
    expect(sub.props.fallbackColor).toEqual([200, 205, 215, 255]);
  });

  it('forwards the Worldbuild props (cumulative/revealFade/temporalSigmaDynamic) to the primitive', async () => {
    vi.resetModules();
    const { SplatLayer } =
      (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(3);
    const layer = makeSplatLayer(SplatLayer, [tile], {
      cumulative: true,
      revealFade: 1500,
      temporalSigmaDynamic: 400,
    });
    const [sub] = layer.renderLayers();
    expect(sub.props.cumulative).toBe(true);
    expect(sub.props.revealFade).toBe(1500);
    expect(sub.props.temporalSigmaDynamic).toBe(400);
    // The static-world width still rides through unchanged.
    expect(sub.props.temporalSigma).toBe(180);
  });

  it('binds instanceIsDynamic zero-copy from the is_dynamic column', async () => {
    vi.resetModules();
    const { SplatLayer } =
      (await import('../src/layers/core/splat-layer')) as any;
    // Mixed scene: features 1 and 3 are moving actors. The shader thresholds at
    // 0.5, so the raw column rides straight through with no CPU pass.
    const tile = surfelTile(4, { dynamic: [0, 1, 0, 1] });
    const f = tile.layers[0].features;
    const layer = makeSplatLayer(SplatLayer, [tile], { cumulative: true });
    const [sub] = layer.renderLayers();

    const dyn = sub.props.data.attributes.instanceIsDynamic;
    expect(dyn).toBeDefined();
    expect(dyn.size).toBe(1);
    expect(dyn.value).toBe(f.numericProps['is_dynamic']); // zero-copy
    expect([...dyn.value]).toEqual([0, 1, 0, 1]);
  });

  it('degrades gracefully to all-static when the is_dynamic column is absent', async () => {
    vi.resetModules();
    const { SplatLayer } =
      (await import('../src/layers/core/splat-layer')) as any;
    // Surfel tiles without an is_dynamic column omit the attribute (primitive's
    // getIsDynamic default 0 ⇒ all static), and nothing crashes.
    const tile = surfelTile(3);
    const layer = makeSplatLayer(SplatLayer, [tile], { cumulative: true });
    const sublayers = layer.renderLayers();
    expect(sublayers).toHaveLength(1);
    expect(
      sublayers[0].props.data.attributes.instanceIsDynamic,
    ).toBeUndefined();
    expect(sublayers[0].props.data.length).toBe(3);
    expect(sublayers[0].props.data.attributes.instancePositions.size).toBe(2);
  });
});
