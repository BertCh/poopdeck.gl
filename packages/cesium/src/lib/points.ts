// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of per-feature ECEF points from decoded Point
 * tiles — the CPU builder behind `CesiumPointLayer.setTiles`. Kernel-built,
 * mirroring the polyline builders:
 *
 *   - positions → `core/geo` `GlobeProjection({datum:'wgs84'})` (Cesium's frame)
 *   - colour    → `core/style` `expandCategoricalColors` (per-feature categorical
 *                 lookup with a fallback fill), channels pre-normalized to 0..1
 *                 so the per-frame `setTime` colour write never re-divides by 255
 *
 * Times are rebased to the first Point layer's `timeOffset` (the same scene-wide
 * origin convention every layer in this package uses). The layer maps each
 * {@link FeaturePoint} to a Cesium `PointPrimitive`; nothing here touches Cesium.
 */

import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { expandCategoricalColors, type RGBA255 } from '@poopdeck.gl/core/style';

/** One renderable point: absolute ECEF position + normalized base colour + window. */
export interface FeaturePoint {
  /** Absolute ECEF position (metres), x/y/z. */
  x: number;
  y: number;
  z: number;
  /** Base colour channels pre-normalized to 0..1. Alpha animates as `a × timeFilterAlpha`. */
  r: number;
  g: number;
  b: number;
  a: number;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Source lon/lat (degrees) — the picking coordinate. */
  lon: number;
  lat: number;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built point set, rebased to one scene-wide time origin. */
export interface PointBuild {
  points: FeaturePoint[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
}

export interface PointBuildOptions {
  /** Categorical property to colour by (else every point gets `colorMappingDefault`). */
  colorProperty?: string;
  colorMapping?: Record<string, RGBA255>;
  /** Colour for unmapped/absent categories (0–255). @default opaque grey */
  colorMappingDefault?: RGBA255;
}

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum matters).
// Byte-identical to the polyline builders' GLOBE; `project` is anchor-independent.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEFAULT_COLOR: RGBA255 = [200, 205, 215, 255];

/** Every non-empty Point layer across `tiles`, in tile/layer order. */
export function collectPointLayers(tiles: Tile[]): BinaryFeatures[] {
  const layers: BinaryFeatures[] = [];
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      if (
        layer.features.geometryType === GeometryType.Point &&
        layer.features.featureCount > 0
      ) {
        layers.push(layer.features);
      }
    }
  }
  return layers;
}

/**
 * Build one ECEF point per Point feature (geometry z used when the tile is
 * 3-D). Times are rebased to the first Point layer's `timeOffset`. Returns an
 * empty build (`timeOrigin: 0`) when there are no Point features — the layer
 * checks `points.length` before adopting `timeOrigin`, so an empty rebuild
 * leaves the previous origin untouched.
 */
export function buildPointEntries(
  tiles: Tile[],
  opts: PointBuildOptions = {},
): PointBuild {
  const pointLayers = collectPointLayers(tiles);
  if (pointLayers.length === 0) return { points: [], timeOrigin: 0 };

  const timeOrigin = pointLayers[0].timeOffset;
  const def = opts.colorMappingDefault ?? DEFAULT_COLOR;
  const points: FeaturePoint[] = [];

  for (const b of pointLayers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const colors = opts.colorProperty
      ? (expandCategoricalColors(
          b,
          {
            property: opts.colorProperty,
            colorMapping: opts.colorMapping,
            colorMappingDefault: def,
            onMissing: 'fill',
          },
          'u8',
        ) as Uint8Array)
      : null;

    for (let i = 0; i < b.featureCount; i++) {
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = dims > 2 ? b.positions[i * dims + 2] : 0;
      const [x, y, z] = GLOBE.project(lon, lat, alt);
      // Normalize colour channels to 0..1 ONCE here so the per-frame setTime
      // loop never re-divides by 255.
      const r = (colors ? colors[i * 4] : def[0]) / 255;
      const g = (colors ? colors[i * 4 + 1] : def[1]) / 255;
      const bb = (colors ? colors[i * 4 + 2] : def[2]) / 255;
      const a = (colors ? colors[i * 4 + 3] : (def[3] ?? 255)) / 255;
      points.push({
        x,
        y,
        z,
        r,
        g,
        b: bb,
        a,
        start: b.startTimes[i] + rebase,
        end: b.endTimes[i] + rebase,
        lon,
        lat,
        binary: b,
        featureIndex: i,
      });
    }
  }

  return { points, timeOrigin };
}
