/**
 * Shared per-tile-sublayer test harness for the animated-* layer chassis.
 *
 * Every animated layer copy-pastes its OWN private `renderLayers` /
 * `prepareTile` / `buildSublayer` — the chassis tests guard N parallel
 * implementations, not one shared function. So this harness does NOT abstract
 * the layer logic away; it only removes the mechanical `Object.create(...)` +
 * `layer.preparedTileCache = new Map()` boilerplate that every layer test
 * copy-pasted (~17 duplicated setups). `chassis-driver.test.ts` drives the
 * shared assertions against EACH layer via `describe.each`, so each layer's
 * own chassis remains under test.
 *
 * `Object.create(Ctor.prototype)` bypasses CompositeLayer's lifecycle so we can
 * exercise the prepare + sublayer-build path directly without a deck.gl runtime
 * / GPU.
 */

import { makePointTile, makePathTile, makePolygonTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

export interface LayerHarness {
  /** Build a bare layer instance with the chassis instance-fields initialised. */
  makeLayer: (opts?: Record<string, any>) => any;
  /** prepareTile + buildSublayer for a single tile (the capture-the-props path). */
  buildSublayerForTile: (tile: any, opts?: Record<string, any>) => any;
  /** Set `state.tiles` and call `renderLayers()`. */
  render: (layer: any, tiles: any[]) => any[];
}

/**
 * @param LayerCtor    the real animated layer class (its prototype supplies
 *                     the private renderLayers/prepareTile/buildSublayer).
 * @param defaultProps the base `layer.props` the layer's constructor would set.
 * @param init         optional per-layer extra instance-field setup (e.g. the
 *                     trips layer's `getEffectiveTimeWindow`).
 */
export function makeLayerHarness(
  LayerCtor: any,
  defaultProps: Record<string, any>,
  init?: (layer: any) => void,
): LayerHarness {
  const makeLayer = (opts: Record<string, any> = {}) => {
    const layer: any = Object.create(LayerCtor.prototype);
    layer.props = { ...defaultProps, ...opts };
    layer._currentTime = 0;
    layer.boundGetTime = () => 0;
    layer.timeFilterExtension = {};
    layer.categoryColorExtension = {};
    layer.preparedTileCache = new Map();
    layer.sublayerCache = new Map();
    layer.lastLayerPropsKey = '';
    layer.lastTilesRef = null;
    if (init) init(layer);
    return layer;
  };

  const buildSublayerForTile = (tile: any, opts: Record<string, any> = {}) => {
    const layer = makeLayer(opts);
    return layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
  };

  const render = (layer: any, tiles: any[]) => {
    layer.state = { tiles };
    return layer.renderLayers();
  };

  return { makeLayer, buildSublayerForTile, render };
}

// ---------------------------------------------------------------------------
// Shared tile fixtures (replace the copy-pasted per-file builders)
// ---------------------------------------------------------------------------

/** A fake point tile of `n` features, all timestamped sequentially. */
export function bigPointTile(n: number): Tile {
  const positions: number[][] = new Array(n);
  const startTimes: number[] = new Array(n);
  const endTimes: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    positions[i] = [(i % 360) - 180, (i % 180) - 90];
    startTimes[i] = i;
    endTimes[i] = i + 1;
  }
  return makePointTile({ positions, startTimes, endTimes, timeOffset: 0 });
}

/** A fake path tile of `n` features × `v` vertices each. */
export function bigPathTile(n: number, v: number): Tile {
  const paths: number[][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ring: number[][] = new Array(v);
    for (let k = 0; k < v; k++) ring[k] = [k * 0.01, i * 0.01];
    paths[i] = ring;
  }
  const startTimes = new Array(n).fill(0);
  const endTimes = new Array(n).fill(1000);
  return makePathTile({ paths, startTimes, endTimes, timeOffset: 0 });
}

/** A fake OD tile: `n` features, each a 2-vertex LineString (source→target). */
export function odTile(n: number): Tile {
  const paths: number[][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    paths[i] = [
      [i * 0.1, i * 0.2],
      [i * 0.1 + 1, i * 0.2 + 1],
    ];
  }
  const startTimes = new Array(n).fill(0);
  const endTimes = new Array(n).fill(1000);
  return makePathTile({ paths, startTimes, endTimes, timeOffset: 0 });
}

/** A fake polygon tile of `n` square polygons at distinct lon/lat. */
export function bigPolygonTile(n: number): Tile {
  const polygons: number[][][] = new Array(n);
  const startTimes: number[] = new Array(n);
  const endTimes: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * 0.1;
    polygons[i] = [
      [x, 0],
      [x + 0.05, 0],
      [x + 0.05, 0.05],
      [x, 0.05],
      [x, 0],
    ];
    startTimes[i] = i * 100;
    endTimes[i] = i * 100 + 500;
  }
  return makePolygonTile({ polygons, startTimes, endTimes, timeOffset: 0 });
}
