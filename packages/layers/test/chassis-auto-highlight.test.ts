/**
 * `autoHighlight` routing for the per-tile sublayer chassis.
 *
 * `CompositeLayer._updateAutoHighlight` BROADCASTS the picking info to every
 * sublayer, and each one matches the hovered object by its index-encoded
 * picking colour. This chassis renders one sublayer per tile and every tile
 * numbers its features from 0, so hovering feature 7 of one tile used to light
 * feature 7 in all ~40 visible tiles. Upstream `TileLayer` exists partly to fix
 * exactly this: it stamps `sourceTileSubLayer` in `getPickingInfo` and
 * overrides `_updateAutoHighlight` to delegate to that one sublayer.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatioTemporalLayer } from '../src/layers/spatiotemporal-layer';

function makeSublayer(name: string) {
  return {
    name,
    props: { tile: { id: { z: 1, x: 0, y: 0, t: 0 } } },
    updateAutoHighlight: vi.fn(),
  };
}

function makeLayer(subLayers: unknown[]) {
  const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
  layer.props = { id: 'stl' };
  layer.state = { tiles: [] };
  // `CompositeLayer.getSubLayers()` reads `internalState.subLayers`.
  layer.internalState = { subLayers };
  return layer;
}

describe('SpatioTemporalLayer autoHighlight', () => {
  it('getPickingInfo records the emitting sublayer as sourceTileSubLayer', () => {
    const sublayer = makeSublayer('a');
    const layer = makeLayer([sublayer]);

    const info = layer.getPickingInfo({
      info: { index: -1, object: undefined },
      sourceLayer: sublayer,
    });

    expect(info.sourceTileSubLayer).toBe(sublayer);
  });

  it('sets sourceTileSubLayer on hover-off too (index < 0)', () => {
    const sublayer = makeSublayer('a');
    const layer = makeLayer([sublayer]);
    const info = layer.getPickingInfo({
      info: { index: -1, object: undefined },
      sourceLayer: sublayer,
    });
    // `tile` stays unset on a miss (upstream contract) but the emitter is known,
    // which is what clears the previous highlight on the RIGHT sublayer.
    expect(info.tile).toBeUndefined();
    expect(info.sourceTileSubLayer).toBe(sublayer);
  });

  it('highlights only the tile that emitted the pick, not every visible tile', () => {
    const hit = makeSublayer('hit');
    const others = [makeSublayer('b'), makeSublayer('c'), makeSublayer('d')];
    const layer = makeLayer([hit, ...others]);

    const info = layer.getPickingInfo({
      info: { index: 7, object: undefined },
      sourceLayer: hit,
    });
    layer._updateAutoHighlight(info);

    expect(hit.updateAutoHighlight).toHaveBeenCalledTimes(1);
    expect(hit.updateAutoHighlight).toHaveBeenCalledWith(info);
    for (const other of others) {
      expect(other.updateAutoHighlight).not.toHaveBeenCalled();
    }
  });

  it('falls back to the composite broadcast for an info that never passed through getPickingInfo', () => {
    const subLayers = [makeSublayer('a'), makeSublayer('b')];
    const layer = makeLayer(subLayers);

    layer._updateAutoHighlight({ index: 3, picked: true });

    for (const sublayer of subLayers) {
      expect(sublayer.updateAutoHighlight).toHaveBeenCalledTimes(1);
    }
  });
});
