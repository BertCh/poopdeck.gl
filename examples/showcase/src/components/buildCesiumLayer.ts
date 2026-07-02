// Dataset → @poopdeck.gl/cesium layer factory — the Cesium mirror of
// buildDemoLayers' type dispatch, kept to the kinds the Cesium backend
// actually supports (see packages/cesium/src/backend-descriptor.ts):
// point / path / trips / trip-heads / arc. Styling fields map 1:1 onto the
// same Dataset vocabulary deck reads (colorProperty/colorMapping, pathColor,
// tripColor/tripGradient/trailLength, headColor, arcSourceColor/arcHeight) so
// a dataset looks the same family of colours on either backend.
//
// Deviations from deck (documented on the layers): one colour per feature —
// per-vertex trip gradients collapse to a ramp keyed on the FIRST value and
// arc endpoint gradients collapse to the source colour.

import type { Scene } from 'cesium';
import {
  CesiumPointLayer,
  CesiumPathLayer,
  CesiumTripsLayer,
  CesiumTripHeadsLayer,
  CesiumArcLayer,
  type FeatureColorMode,
} from '@poopdeck.gl/cesium';
import type { Tile } from '@poopdeck.gl/core';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import type { ColorRGBA, Dataset, DatasetType } from '../types';

/** The SttRenderNode slice CesiumRenderer drives. */
export interface CesiumDemoLayer {
  setTiles(tiles: Tile[]): void;
  setTime(absoluteMs: number): void;
  pick?(cssX: number, cssY: number): SttPickResult | null;
  dispose(): void;
}

/** Dataset types the Cesium demo route can render today. */
export const CESIUM_SUPPORTED_TYPES: readonly DatasetType[] = [
  'point',
  'path',
  'trips',
  'trip-heads',
  'arc',
];

const rgba = (c: ColorRGBA | undefined, fallback: ColorRGBA): ColorRGBA => c ?? fallback;

/** Categorical-or-constant colour mode from the shared dataset colour fields. */
function categoricalOrConstant(d: Dataset, constant: ColorRGBA): FeatureColorMode {
  if (d.colorProperty) {
    return {
      type: 'categorical',
      property: d.colorProperty,
      colorMapping: d.colorMapping,
      fallback: rgba(d.colorMappingDefault, constant),
    };
  }
  return { type: 'constant', color: constant };
}

/**
 * Build the Cesium layer for `dataset`, or `null` when its type isn't in the
 * backend catalog yet (callers gate the route on {@link CESIUM_SUPPORTED_TYPES}).
 */
export function buildCesiumLayer(scene: Scene, dataset: Dataset): CesiumDemoLayer | null {
  const id = `cesium-${dataset.id}`;

  switch (dataset.type) {
    case 'point': {
      // Mode mirrors deck's AnimatedPointLayer prop precedence: cumulative
      // ("draw and persist") wins, then wake, else the sliding window.
      const mode = dataset.cumulative ? 'cumulative' : dataset.wakeLength ? 'wake' : 'window';
      return new CesiumPointLayer(scene, {
        id,
        mode,
        timeFilter:
          mode === 'cumulative'
            ? { fadeIn: dataset.fadeInDuration ?? 0 }
            : mode === 'wake'
              ? { wakeLength: dataset.wakeLength! }
              : { windowHalf: dataset.timeWindow / 2 },
        colorProperty: dataset.colorProperty,
        colorMapping: dataset.colorMapping,
        colorMappingDefault: dataset.colorMappingDefault,
        pixelSize: 6,
      });
    }

    case 'path':
      return new CesiumPathLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        color: categoricalOrConstant(dataset, rgba(dataset.pathColor, [31, 186, 214, 255])),
        width: typeof dataset.pathWidth === 'number' ? dataset.pathWidth : 3,
      });

    case 'trips': {
      // Per-vertex gradients (tripGradient) collapse to a per-trip ramp; the
      // categorical/constant precedence matches deck's tripColor resolution.
      const color: FeatureColorMode = dataset.tripGradient
        ? {
            type: 'ramp',
            property: dataset.tripGradient.property,
            domain: dataset.tripGradient.domain,
            range: dataset.tripGradient.colors,
            fallback: rgba(dataset.tripColor, [31, 186, 214, 255]),
          }
        : categoricalOrConstant(dataset, rgba(dataset.tripColor, [31, 186, 214, 255]));
      return new CesiumTripsLayer(scene, {
        id,
        trailLength: dataset.trailLength ?? 60_000,
        color,
        width: typeof dataset.tripWidth === 'number' ? dataset.tripWidth : 4,
        fadeTrail: dataset.fadeTrail ?? true,
      });
    }

    case 'trip-heads':
      return new CesiumTripHeadsLayer(scene, {
        id,
        color: { type: 'constant', color: rgba(dataset.headColor, [253, 128, 93, 255]) },
        // deck's headRadiusPixels is a radius; PointPrimitive.pixelSize is a diameter.
        pixelSize: 2 * (dataset.headRadiusPixels ?? 4),
      });

    case 'arc':
      return new CesiumArcLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        // Endpoint gradient collapses to the source colour (documented deviation).
        color: categoricalOrConstant(dataset, rgba(dataset.arcSourceColor, [0, 150, 255, 255])),
        height: dataset.arcHeight ?? 1,
        width: dataset.arcWidth ?? 2,
      });

    default:
      return null;
  }
}

/**
 * The temporal window the tile loader must keep resident for this dataset —
 * trips/trip-heads need the trail behind the playhead, mirroring deck's
 * auto-widen to `2 × trailLength`.
 */
export function cesiumLoaderTimeWindow(dataset: Dataset): number {
  if (dataset.type === 'trips' || dataset.type === 'trip-heads') {
    return Math.max(dataset.timeWindow, 2 * (dataset.trailLength ?? 60_000));
  }
  return dataset.timeWindow;
}
