/**
 * A temporal-LOD (scrub-preview) tile and the base tile it shares `z/x/y/t`
 * with must land in SEPARATE slots of a layer's prepared-tile registry.
 *
 * The tiers differ only in `bucketMs` — a LOD tile's bucket spans more time —
 * so a registry key that omits it hands both tiers one slot: the first one
 * prepared answers for the second, which then renders the wrong span of time,
 * and dropping either evicts both. The key comes from core's `tileLayerKey`,
 * whose tile half is the canonical `tileKey`, and this pins the outcome at the
 * layer that consumes it.
 *
 * AnimatedArcLayer stands in for the whole per-tile-sublayer family: every one
 * of them keys `preparedTileCache` / `sublayerCache` with the same producer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePathTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

vi.mock('@deck.gl/layers', () => {
  class Fake {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { ArcLayer: Fake, LineLayer: Fake };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

/** One 2-vertex OD flow at `lon`, addressed by `id`. */
function odTile(id: Tile['id'], lon: number): Tile {
  const tile = makePathTile({
    paths: [
      [
        [lon, 0],
        [lon + 1, 1],
      ],
    ],
    startTimes: [0],
    endTimes: [1000],
    timeOffset: 0,
  });
  tile.id = id;
  return tile;
}

const BASE_ID = { z: 6, x: 17, y: 24, t: 1_700_000_000_000 };
const LOD_ID = { ...BASE_ID, bucketMs: 3_600_000 };

describe('AnimatedArcLayer prepared-tile registry across temporal-LOD tiers', () => {
  let makeLayer: () => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-arc-layer');
    const LayerCtor = mod.AnimatedArcLayer as any;

    makeLayer = () => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'arcs',
        sourceColor: [0, 150, 255, 255],
        targetColor: [255, 127, 14, 255],
        width: 2,
        widthUnits: 'pixels',
        greatCircle: false,
        arcHeight: 1,
        arcTilt: 0,
        timeWindow: 1000,
        opacity: 1,
        visible: true,
      };
      layer._currentTime = 0;
      layer.boundGetTime = () => 0;
      layer.timeFilterExtension = {};
      layer.categoryColorExtension = {};
      layer.preparedTileCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      return layer;
    };
  });

  it('gives each tier its own entry, holding its own tile', () => {
    const base = odTile(BASE_ID, 10);
    const lod = odTile(LOD_ID, 20);
    const layer = makeLayer();

    const preparedBase = layer.prepareTile(base, base.layers[0]);
    const preparedLod = layer.prepareTile(lod, lod.layers[0]);

    expect(layer.preparedTileCache.size).toBe(2);
    // A shared slot would hand the LOD tile the base tile's prepared buffers.
    expect(preparedLod).not.toBe(preparedBase);
    expect(preparedBase.tile).toBe(base);
    expect(preparedLod.tile).toBe(lod);
    expect(preparedLod.tileKey).not.toBe(preparedBase.tileKey);
    expect(preparedBase.data.attributes.getSourcePosition.value[0]).toBe(10);
    expect(preparedLod.data.attributes.getSourcePosition.value[0]).toBe(20);
  });

  it('re-serves each tier from the cache under its own key', () => {
    const base = odTile(BASE_ID, 10);
    const lod = odTile(LOD_ID, 20);
    const layer = makeLayer();

    const preparedBase = layer.prepareTile(base, base.layers[0]);
    const preparedLod = layer.prepareTile(lod, lod.layers[0]);

    expect(layer.prepareTile(base, base.layers[0])).toBe(preparedBase);
    expect(layer.prepareTile(lod, lod.layers[0])).toBe(preparedLod);
    expect(layer.preparedTileCache.size).toBe(2);
  });

  it('keeps the base entry when only the LOD tile leaves the view', () => {
    const base = odTile(BASE_ID, 10);
    const lod = odTile(LOD_ID, 20);
    const layer = makeLayer();

    // LOD first: a scrub preview arrives ahead of the base tile it overlays.
    layer.prepareTile(lod, lod.layers[0]);
    layer.prepareTile(base, base.layers[0]);

    // The prune walk in renderLayers keeps entries whose key is in the live
    // set; with the tiers aliased, the entry that survives under the base
    // tile's key holds the LOD tile's coarser buffers.
    layer.state = { tiles: [base] };
    layer.renderLayers();

    expect(layer.preparedTileCache.size).toBe(1);
    expect([...layer.preparedTileCache.values()][0].tile).toBe(base);
  });
});
