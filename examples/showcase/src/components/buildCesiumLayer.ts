// Dataset → @poopdeck.gl/cesium layer factory — the Cesium mirror of
// buildDemoLayers' type dispatch, kept to the kinds the Cesium backend
// actually supports, which it declares in `cesiumBackend` (see
// packages/cesium/src/backend-descriptor.ts). Styling fields map 1:1 onto the
// same Dataset vocabulary deck reads (colorProperty/colorMapping, pathColor,
// tripColor/tripGradient/trailLength, headColor, arcSourceColor/arcHeight) so
// a dataset looks the same family of colours on either backend.
//
// Deviations from deck (documented on the layers): one colour per feature —
// per-vertex trip gradients collapse to a ramp keyed on the FIRST value and
// arc endpoint gradients collapse to the source colour.
//
// This dispatch must stay EXHAUSTIVE over `CESIUM_SUPPORTED_TYPES`, which is
// derived from the descriptor — `test/cesium-dispatch.test.ts` fails if the
// backend declares a kind this file cannot build. That gate is the reason the
// non-deck parity campaign's descriptor growth could not silently put a Cesium
// toggle on six demo pages that would have rendered nothing.

import type { Scene } from 'cesium';
import { cellToBoundary } from 'h3-js';
import {
  STTPointLayer,
  STTPathLayer,
  STTTripsLayer,
  STTTripHeadsLayer,
  STTArcLayer,
  STTPolygonLayer,
  STTColumnLayer,
  STTHeatmapLayer,
  STTFlowmapLayer,
  STTH3SummaryLayer,
  STTQuadbinSummaryLayer,
  cesiumBackend,
  type FeatureColorMode,
} from '@poopdeck.gl/cesium';
import type { Tile } from '@poopdeck.gl/core';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import { renderableDatasetTypes } from '../lib/backendSupport';
import type { ColorRGBA, Dataset } from '../types';

/** The SttRenderNode slice CesiumRenderer drives. */
export interface CesiumDemoLayer {
  setTiles(tiles: Tile[]): void;
  setTime(absoluteMs: number): void;
  pick?(cssX: number, cssY: number): SttPickResult | null;
  dispose(): void;
}

/**
 * Dataset types the Cesium demo route can render today — READ from the
 * `cesiumBackend` descriptor, so retiring or adding a Cesium layer class moves
 * this set without a showcase edit. No showcase-local composite is wired here
 * (the Cesium route mounts exactly one archive), hence no `locals`.
 */
export const CESIUM_SUPPORTED_TYPES = renderableDatasetTypes(cesiumBackend);

const rgba = (c: ColorRGBA | undefined, fallback: ColorRGBA): ColorRGBA =>
  c ?? fallback;

/** Categorical-or-constant colour mode from the shared dataset colour fields. */
function categoricalOrConstant(
  d: Dataset,
  constant: ColorRGBA,
): FeatureColorMode {
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
export function buildCesiumLayer(
  scene: Scene,
  dataset: Dataset,
): CesiumDemoLayer | null {
  const id = `cesium-${dataset.id}`;

  switch (dataset.type) {
    case 'point': {
      // Mode mirrors deck's AnimatedPointLayer prop precedence: cumulative
      // ("draw and persist") wins, then wake, else the sliding window.
      const mode = dataset.cumulative
        ? 'cumulative'
        : dataset.wakeLength
          ? 'wake'
          : 'window';
      return new STTPointLayer(scene, {
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
      return new STTPathLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        color: categoricalOrConstant(
          dataset,
          rgba(dataset.pathColor, [31, 186, 214, 255]),
        ),
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
        : categoricalOrConstant(
            dataset,
            rgba(dataset.tripColor, [31, 186, 214, 255]),
          );
      return new STTTripsLayer(scene, {
        id,
        trailLength: dataset.trailLength ?? 60_000,
        color,
        width: typeof dataset.tripWidth === 'number' ? dataset.tripWidth : 4,
        fadeTrail: dataset.fadeTrail ?? true,
      });
    }

    case 'tripHeads':
      return new STTTripHeadsLayer(scene, {
        id,
        color: {
          type: 'constant',
          color: rgba(dataset.headColor, [253, 128, 93, 255]),
        },
        // deck's headRadiusPixels is a radius; PointPrimitive.pixelSize is a diameter.
        pixelSize: 2 * (dataset.headRadiusPixels ?? 4),
      });

    case 'arc':
      return new STTArcLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        // Endpoint gradient collapses to the source colour (documented deviation).
        color: categoricalOrConstant(
          dataset,
          rgba(dataset.arcSourceColor, [0, 150, 255, 255]),
        ),
        height: dataset.arcHeight ?? 1,
        width: dataset.arcWidth ?? 2,
      });

    case 'polygon': {
      // Ground fill. `extrudedHeightProperty` is left unset on purpose: the
      // shipped polygon demos (rain-flood, wildfires) are flat decals, and a
      // prism would occlude the very terrain they sit on. `zLift` keeps the
      // decal off the ellipsoid so it does not z-fight with 3D terrain.
      return new STTPolygonLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        color: categoricalOrConstant(
          dataset,
          rgba(dataset.polygonFillColor, [240, 107, 33, 140]),
        ),
        zLift: 2,
      });
    }

    case 'column':
      // Extruded prisms at point features. deck spells the radius unit; this
      // backend's cross-section is TRUE metres only, so a `pixels` dataset gets
      // its number read as metres — the documented deviation, and the one
      // shipped column demo (earthquake-columns) is already metric.
      return new STTColumnLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        color: categoricalOrConstant(
          dataset,
          rgba(dataset.columnFillColor, [253, 128, 93, 220]),
        ),
        elevationProperty: dataset.elevationProperty ?? null,
        defaultElevation: dataset.columnElevation ?? 1000,
        elevationScale: dataset.elevationScale ?? 1,
        radius: dataset.columnRadius ?? 100,
        diskResolution: dataset.columnDiskResolution ?? 12,
      });

    case 'heatmap': {
      // CPU density field on a geodetic raster, NOT deck's GPU splat — so the
      // blob keeps a fixed GROUND size while deck's keeps a fixed SCREEN size
      // (see the layer header). deck's `radiusPixels` is therefore not a
      // transferable number: it is screen pixels there and field CELLS here.
      // Carry the palette, the weight column and the intensity, which DO mean
      // the same thing, and let the radius take this backend's own default.
      const channel = dataset.heatmapLayers?.[0];
      return new STTHeatmapLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        weightProperty: channel?.weightProperty ?? dataset.weightProperty,
        ...(channel?.colorRange && {
          colorRange: channel.colorRange as ColorRGBA[],
        }),
        intensity: channel?.intensity ?? 1,
      });
    }

    case 'flowmap':
      // Tapered per-bucket OD arrows. `flowmap-bundled` is NOT routed here:
      // the Cesium route mounts exactly one archive and declares no locals, so
      // a composite never reaches this dispatch.
      return new STTFlowmapLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        color: {
          type: 'constant',
          color: rgba(dataset.flowSourceColor, [56, 196, 232, 235]),
        },
        widthScale: dataset.flowWidthScale ?? 1.1,
        minWidthPx: dataset.flowWidthMinPixels ?? 1,
        maxWidthPx: dataset.flowWidthMaxPixels ?? 12,
        gapWidths: dataset.flowGap ?? 0.65,
        minFlow: dataset.flowMinFlow ?? 0.25,
        zLift: 2,
      });

    case 'h3Summary':
      // h3-js is injected, never imported by @poopdeck.gl/cesium — the same
      // seam MaplibreRenderer uses, and the constructor throws without it.
      return new STTH3SummaryLayer(scene, {
        id,
        cellToBoundary,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        weightProperty: dataset.summaryWeightProperty ?? 'count',
        ...(dataset.summaryColorRange && {
          colorRange: dataset.summaryColorRange as ColorRGBA[],
        }),
        colorDomain: dataset.summaryColorDomain ?? null,
        coverage: dataset.summaryCoverage ?? 0.92,
        extruded: dataset.summaryExtruded ?? false,
        elevationScale: dataset.summaryElevationScale ?? 1,
      });

    case 'quadbinSummary':
      // Square-cell analog of h3Summary; same option surface, no injection
      // (a Quadbin cell id decodes to its own tile bounds arithmetically).
      return new STTQuadbinSummaryLayer(scene, {
        id,
        mode: 'window',
        timeFilter: { windowHalf: dataset.timeWindow / 2 },
        weightProperty: dataset.summaryWeightProperty ?? 'count',
        ...(dataset.summaryColorRange && {
          colorRange: dataset.summaryColorRange as ColorRGBA[],
        }),
        colorDomain: dataset.summaryColorDomain ?? null,
        coverage: dataset.summaryCoverage ?? 0.92,
        extruded: dataset.summaryExtruded ?? false,
        elevationScale: dataset.summaryElevationScale ?? 1,
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
  if (dataset.type === 'trips' || dataset.type === 'tripHeads') {
    return Math.max(dataset.timeWindow, 2 * (dataset.trailLength ?? 60_000));
  }
  return dataset.timeWindow;
}
