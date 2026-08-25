/**
 * AnimatedTripHeadsLayer — terrain drape probe (`getTerrainElevation`).
 *
 * The showcase's `basemapTerrain` path hands the layer a per-frame height
 * probe so each dot rides a 3D basemap's surface. These tests pin the probe's
 * contract at the CPU kernel level:
 *
 *   - the probe is sampled at each dot's LIVE interpolated (lon, lat) and its
 *     answer ADDS to the dot's z;
 *   - a `null` answer ("terrain tile not resident") leaves the dot's z
 *     untouched — no snap to a wrong guess;
 *   - unset (default) → identical output to a layer that never heard of
 *     terrain (z stays 0 for 2D archives).
 *
 * Same Object.create harness as the sibling parity suite; GPU sublayers /
 * deck core are mocked so no luma shader loads.
 */

import { describe, it, expect } from 'vitest';
import { makePathTile } from './fake-tile';

import { vi } from 'vitest';

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

import { AnimatedTripHeadsLayer } from '../src/layers/trips/animated-trip-heads-layer';

/** Two 2-vertex corridors, both active over [0,100] — mid-trip yields 2 heads
 * at (0.5, 0.5) and (2.5, 2.5). */
function twoCorridorTile() {
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

function headsLayer(props: Record<string, any> = {}) {
  const layer: any = Object.create(AnimatedTripHeadsLayer.prototype);
  layer.props = {
    id: 'heads',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    headColor: [253, 128, 93, 255],
    sizeUnits: 'pixels',
    headRadiusPixels: 4,
    headRadius: 0,
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 1e9,
    radiusScale: 1,
    headBillboard: false,
    antialiasing: true,
    headStroked: false,
    headFilled: true,
    headStrokeColor: [0, 0, 0, 255],
    headStrokeWidth: 1,
    lineWidthUnits: 'meters',
    lineWidthScale: 1,
    lineWidthMinPixels: 0,
    lineWidthMaxPixels: Number.MAX_SAFE_INTEGER,
    gradientProperty: null,
    gradientDomain: [0, 1],
    gradientColorRamp: [],
    // Drape default (must match defaultProps): unset → no terrain sampling.
    getTerrainElevation: null,
    ...props,
  };
  layer._currentTime = 50; // mid-trip for [0,100] windows → both heads active
  layer.preparedTileCache = new Map();
  layer.lastTilesRef = null;
  return layer;
}

function headPositions(layer: any): Float64Array {
  layer.state = { tiles: [twoCorridorTile()] };
  const [sub] = layer.renderLayers();
  return sub.props.data.attributes.getPosition.value;
}

describe('AnimatedTripHeadsLayer — terrain drape probe', () => {
  it('samples the probe at each dot’s live position and adds the answer to z', () => {
    const sampled: Array<[number, number]> = [];
    const pos = headPositions(
      headsLayer({
        getTerrainElevation: (lon: number, lat: number) => {
          sampled.push([lon, lat]);
          return lon * 1000; // distinguishable per-dot heights
        },
      }),
    );
    // Mid-trip interpolated positions, then the probe's answer as z.
    expect(Array.from(pos)).toEqual([0.5, 0.5, 500, 2.5, 2.5, 2500]);
    // Probed exactly once per active dot, at the dot's live position.
    expect(sampled).toEqual([
      [0.5, 0.5],
      [2.5, 2.5],
    ]);
  });

  it('a null probe answer leaves the dot’s z untouched', () => {
    const pos = headPositions(
      headsLayer({
        // First dot's terrain is "not resident"; second answers 42.
        getTerrainElevation: (lon: number) => (lon < 1 ? null : 42),
      }),
    );
    expect(Array.from(pos)).toEqual([0.5, 0.5, 0, 2.5, 2.5, 42]);
  });

  it('unset probe (default) renders exactly as before — flat z', () => {
    const pos = headPositions(headsLayer());
    expect(Array.from(pos)).toEqual([0.5, 0.5, 0, 2.5, 2.5, 0]);
  });

  it('defaultProps carries the probe as an optional function slot', () => {
    const d = (AnimatedTripHeadsLayer as any).defaultProps;
    expect(d.getTerrainElevation).toMatchObject({
      type: 'function',
      value: null,
      optional: true,
      compare: false,
    });
    expect(d.elevationFromVertexValues).toBe(false);
  });
});

/** The two-corridor tile with a baked per-vertex elevation channel:
 * corridor 1 climbs 100 → 300 m, corridor 2 rides flat at 1000 m. */
function bakedTile() {
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
    vertexValues: [100, 300, 1000, 1000],
  });
}

function bakedHeadPositions(props: Record<string, any>): Float64Array {
  const layer = headsLayer(props);
  layer.state = { tiles: [bakedTile()] };
  const [sub] = layer.renderLayers();
  return sub.props.data.attributes.getPosition.value;
}

describe('AnimatedTripHeadsLayer — baked elevation (`elevationFromVertexValues`)', () => {
  it('interpolates the channel at the live position and scales it into z', () => {
    const pos = bakedHeadPositions({
      elevationFromVertexValues: true,
      elevationScale: 1.5,
    });
    // Mid-trip: corridor 1 halfway up its 100→300 climb (200 m), corridor 2
    // flat at 1000 m; both × the 1.5 scene exaggeration.
    expect(Array.from(pos)).toEqual([0.5, 0.5, 300, 2.5, 2.5, 1500]);
  });

  it('off by default — the channel alone does not lift dots', () => {
    const pos = bakedHeadPositions({});
    expect(Array.from(pos)).toEqual([0.5, 0.5, 0, 2.5, 2.5, 0]);
  });

  it('a tile without the channel leaves dots grounded even when enabled', () => {
    const layer = headsLayer({ elevationFromVertexValues: true });
    layer.state = { tiles: [twoCorridorTile()] };
    const [sub] = layer.renderLayers();
    const pos = sub.props.data.attributes.getPosition.value;
    expect(Array.from(pos)).toEqual([0.5, 0.5, 0, 2.5, 2.5, 0]);
  });

  it('baked elevation and gradient coloring share the channel', () => {
    const layer = headsLayer({
      elevationFromVertexValues: true,
      elevationScale: 1,
      gradientProperty: 'vertexValues',
      gradientColorRamp: [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
      ],
      gradientDomain: [0, 1000],
    });
    layer.state = { tiles: [bakedTile()] };
    const [sub] = layer.renderLayers();
    const pos = sub.props.data.attributes.getPosition.value;
    expect(Array.from(pos)).toEqual([0.5, 0.5, 200, 2.5, 2.5, 1000]);
    // The gradient consumer still gets its per-dot values buffer.
    expect(sub.props.data.attributes.getFillColor).toBeDefined();
  });
});
