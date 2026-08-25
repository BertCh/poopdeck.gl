/**
 * MaplibreRenderer — mounts a MapLibre GL map and the `@poopdeck.gl/maplibre`
 * custom layer(s) for the supplied dataset. Drop into any page that already
 * owns a `TimeController`; this component subscribes to its `tick` event and
 * forwards `setCurrentTime` to the STT layer(s) on every frame. When the host
 * also passes `usePlayback`'s `registry`, each mounted layer's tileset registers
 * as a governor source so playback gates on its buffered runway, exactly like
 * the deck path.
 *
 * A dataset that resolves to ONE layer is added directly with `map.addLayer`;
 * a composite that resolves to SEVERAL (e.g. the radar/weather suites) is hosted
 * behind one {@link STTLayerGroup} so the map pays a single custom-layer GL
 * cycle per frame — the native analogue of deck's `MapboxLayerGroup`.
 *
 * Kept deliberately self-contained so it can sit next to the deck.gl
 * viewport on the DemoPage without leaking state.
 */

import React, { useEffect, useMemo, useRef } from 'react';
// MapLibre 6 is ESM-only and publishes no default export;
// the namespace carries both the classes and the types.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  STTPointLayer,
  STTLineLayer,
  STTPolygonLayer,
  STTTripsLayer,
  STTHeatmapLayer,
  STTTripHeadsLayer,
  STTArcLayer,
  STTColumnLayer,
  STTH3SummaryLayer,
  STTQuadbinSummaryLayer,
  STTFlowmapLayer,
  STTLayerGroup,
  type STTBaseLayer,
  type STTBaseLayerOptions,
  type RGBA8,
} from '@poopdeck.gl/maplibre';
// h3-js is not a dependency of `@poopdeck.gl/maplibre` (it ships zero extra
// deps); the H3 summary layer takes the boundary resolver injected. See
// `STTH3SummaryLayerOptions.cellToBoundary`.
import { cellToBoundary } from 'h3-js';
import type { TimeController } from '@poopdeck.gl/playback';
import type { SourceRegistry } from '@poopdeck.gl/react';
import type { Dataset } from '../types';

// CARTO's free dark style. We accept any style URL via prop, but this is the
// sensible default so we stay visually consistent with the deck.gl viewport
// (Mapbox dark-v11).
const DEFAULT_BASEMAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/**
 * Dataset types the maplibre adapter can mount (see {@link buildSttLayers}).
 * READ from the `maplibreBackend` descriptor, so a kind the adapter gains or
 * loses moves this set on its own; `DemoPageImpl` gates the renderer toggle on
 * it, and the two can no longer disagree about what will actually draw.
 *
 * The composites listed here are the showcase's own multi-archive stacks (a
 * descriptor knows nothing about them), and each is still checked against the
 * descriptor: `lightning` needs heatmap + point, `radar` needs polygon + point
 * + trips, `flowmap-bundled` needs flowmap (bundling is the `liveBundling`
 * capability, which maplibre lacks — it draws the straight flowmap, see the
 * dispatch below). `av` / `storm4d` / `weather` are not wired here (LIDAR
 * splats, extruded prisms and per-vertex trip gradients have no native
 * analogue), and `worlds` is a bespoke page that never routes through this
 * renderer.
 *
 * KNOWN DESCRIPTOR GAP: `path` is absent because `maplibreBackend` declares
 * `path` unsupported with no fallback, even though `STTLineLayer` renders
 * polylines and the `case 'path'` below mounts it — the descriptor's own
 * pathReveal claim is filed under `line`. That is a capability-matrix bug in
 * @poopdeck.gl/maplibre, not something to override from here.
 */
export { MAPLIBRE_RENDERABLE_TYPES } from '../lib/rendererEligibility';

/** Bright, slightly-blue flash color for lightning (deck's LIGHTNING_FLASH_COLOR). */
const LIGHTNING_FLASH_COLOR: RGBA8 = [222, 236, 255, 255];

export interface MaplibreRendererProps {
  dataset: Dataset;
  timeController: TimeController;
  /**
   * Multi-source governor registration API (`usePlayback`'s `registry`). When
   * present, every mounted layer's tileset registers as a governor source under
   * a per-layer id — so the clock gates on its buffered runway exactly like the
   * deck path — and unregisters on teardown. The demo's PRIMARY source registers
   * `required: true`; composite OVERLAYS register `required` per the dataset's
   * {@link Dataset.overlayGatesPlayback} (default true).
   */
  registry?: SourceRegistry;
  /** Optional override for the basemap style URL or JSON. */
  basemapStyle?: string | maplibregl.StyleSpecification;
  /** Optional className applied to the outer container. */
  className?: string;
  /** Map projection. Defaults to mercator; pass 'globe' for the globe view. */
  projection?: 'mercator' | 'globe';
}

/** One mounted STT layer + the governor bookkeeping the renderer needs for it. */
interface LayerDescriptor {
  layer: STTBaseLayer;
  /** Governor source key (also the layer id). Distinct from the deck path's. */
  sourceId: string;
  /** Whether the clock must wait for this source's buffered runway. */
  required: boolean;
}

/** The minimal driver surface both a single layer and a group expose. */
interface TimeDriver {
  setCurrentTime(t: number): void;
}

const MaplibreRenderer: React.FC<MaplibreRendererProps> = ({
  dataset,
  timeController,
  registry,
  basemapStyle = DEFAULT_BASEMAP_STYLE,
  className,
  projection = 'mercator',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const driverRef = useRef<TimeDriver | null>(null);

  // Latest-registry ref so the tileset-ready/buffer callbacks (which fire
  // async, after archive metadata resolves) read the current registry without
  // the mount effect depending on its identity — a registry swap must not
  // tear down the map.
  const registryRef = useRef<SourceRegistry | undefined>(registry);
  useEffect(() => {
    registryRef.current = registry;
  }, [registry]);

  // We snapshot the initial dataset so the dataset prop isn't accidentally
  // captured stale by the timeController subscription. Re-mounting on dataset
  // change is handled by React's keying — see the parent.
  const initialTime = useMemo(
    () => dataset.timeRange.start,
    [dataset.timeRange.start],
  );

  // Mount the map + STT layer(s) once per (dataset, basemap) tuple.
  useEffect(() => {
    if (!containerRef.current) return;

    const view = dataset.initialViewState;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle,
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
      // maplibre-gl v5 dropped the boolean form; {} keeps the default control.
      attributionControl: {},
    });
    mapRef.current = map;
    // setProjection lives on the runtime map, not the constructor — apply on
    // load so the style is ready, and reapply when the prop changes below.
    map.on('style.load', () => {
      try {
        // Applied once on the initial style.load; the dedicated effect below
        // reapplies `projection` live without re-mounting the map.
        (map as any).setProjection?.({ type: projection });
      } catch {
        // older maplibre builds without setProjection: silently fall back to mercator
      }
    });

    // Governor plumbing (mirrors buildDemoLayers' sourceProps): each layer's
    // tileset registers as a source keyed by the maplibre layer id — distinct
    // from the deck path's dataset-id key, so a deck ↔ maplibre renderer switch
    // cannot clobber the other path's registration. Every registration is
    // remembered so teardown unregisters from exactly the instance it used.
    const registered: Array<{ reg: SourceRegistry; sourceId: string }> = [];
    const makePlumbing = (
      sourceId: string,
      required: boolean,
    ): Pick<STTBaseLayerOptions, 'onTilesetReady' | 'onBufferChange'> => ({
      onTilesetReady: (tileset) => {
        const reg = registryRef.current;
        if (!reg) return;
        reg.registerSource(sourceId, tileset, { required });
        registered.push({ reg, sourceId });
      },
      onBufferChange: (runway) =>
        registryRef.current?.onBufferChange(sourceId, runway),
    });

    const descriptors = buildSttLayers(dataset, initialTime, makePlumbing);

    // One layer → add directly (proven path). Several → host behind one group
    // so the map pays a single custom-layer GL cycle per frame.
    let group: STTLayerGroup | null = null;
    if (descriptors.length === 1) {
      const layer = descriptors[0].layer;
      driverRef.current = layer;
      map.on('load', () => {
        map.addLayer(layer as unknown as maplibregl.CustomLayerInterface);
      });
    } else if (descriptors.length > 1) {
      group = new STTLayerGroup({
        id: `stt-${dataset.id}-group`,
        layers: descriptors.map((d) => d.layer),
      });
      driverRef.current = group;
      const g = group;
      // `attach` (not plain addLayer) installs the styledata re-add guard so a
      // basemap style rebuild re-initializes the whole group + its children.
      // Cast: the package's bundled maplibre-gl types and the app's differ by
      // patch, same as the `CustomLayerInterface` cast on the single-layer path.
      map.on('load', () =>
        g.attach(map as unknown as Parameters<typeof g.attach>[0]),
      );
    }

    return () => {
      // Unregister BEFORE map.remove(): removal finalizes each layer's tileset,
      // and the governor must not keep querying a finalized source.
      for (const { reg, sourceId } of registered)
        reg.unregisterSource(sourceId);
      registered.length = 0;
      if (group) {
        try {
          group.detach();
        } catch {
          // detach is best-effort; map.remove() below tears children down too.
        }
      }
      driverRef.current = null;
      mapRef.current = null;
      map.remove();
    };
    // `projection` is deliberately omitted: it's seeded above and the effect below
    // reapplies it live, so listing it here would needlessly tear down the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, basemapStyle, initialTime]);

  // Forward ticks → driver. We keep this in a separate effect so the
  // subscription survives a basemap-only swap.
  useEffect(() => {
    const onTick = (t: number) => {
      driverRef.current?.setCurrentTime(t);
    };
    timeController.on('tick', onTick);
    // Sync once on mount so the first frame doesn't render stale.
    driverRef.current?.setCurrentTime(timeController.getTime());
    return () => {
      timeController.off('tick', onTick);
    };
  }, [timeController]);

  // Live projection swap. Separated from the mount effect so flipping
  // mercator ↔ globe doesn't tear down the map (which would drop tiles
  // and the STT layer's GPU resources).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      (map as any).setProjection?.({ type: projection });
    } catch {
      // setProjection unsupported in this maplibre build — no-op.
    }
  }, [projection]);

  return <div ref={containerRef} className={className ?? 'w-full h-full'} />;
};

export default MaplibreRenderer;

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

type PlumbingFor = (
  sourceId: string,
  required: boolean,
) => Pick<STTBaseLayerOptions, 'onTilesetReady' | 'onBufferChange'>;

/**
 * Translate a showcase {@link Dataset} into the maplibre STT layer(s) that
 * render it, tracking each layer's governor source id. Mirrors the deck path's
 * `buildDemoLayers` dispatch, but only for the {@link MAPLIBRE_RENDERABLE_TYPES}
 * the native backend can mount. Returns `[]` for an unsupported type (the
 * renderer then draws just the basemap; the toggle prevents reaching that).
 */
function buildSttLayers(
  dataset: Dataset,
  initialTime: number,
  plumbing: PlumbingFor,
): LayerDescriptor[] {
  const primaryId = `stt-${dataset.id}`;
  // Common base options for the PRIMARY, required source.
  const base = {
    id: primaryId,
    url: dataset.url,
    currentTime: initialTime,
    timeWindow: dataset.timeWindow,
    autoRepaint: true,
    ...plumbing(primaryId, true),
  };
  // Stable category → RGBA map for `colorProperty` (deck parity): required for
  // cross-tile color consistency, since the positional-palette fallback assigns
  // indices in first-seen order per tile.
  const keyedColors = {
    colorMapping: dataset.colorMapping,
    colorMappingDefault: dataset.colorMappingDefault,
  };
  const one = (layer: STTBaseLayer): LayerDescriptor[] => [
    { layer, sourceId: primaryId, required: true },
  ];
  // Base options for a composite OVERLAY archive (its own url + governor key).
  // Overlays gate the clock per the dataset's `overlayGatesPlayback` (default
  // true), mirroring the deck path's `sourceProps(id, overlayGatesPlayback)`.
  const overlay = (suffix: string, url: string) => {
    const sourceId = `${primaryId}-${suffix}`;
    const required = dataset.overlayGatesPlayback ?? true;
    return {
      sourceId,
      required,
      opts: {
        id: sourceId,
        url,
        currentTime: initialTime,
        timeWindow: dataset.timeWindow,
        autoRepaint: true,
        ...plumbing(sourceId, required),
      },
    };
  };

  switch (dataset.type) {
    case 'point':
      return one(
        new STTPointLayer({
          ...base,
          ...keyedColors,
          color: [0.12, 0.73, 0.84, 0.95],
          radius: 4,
          colorProperty: dataset.colorProperty,
          radiusProperty: dataset.radiusProperty,
        }),
      );

    case 'path':
      return one(
        new STTLineLayer({
          ...base,
          ...keyedColors,
          color: [1.0, 0.84, 0.0, 0.9],
          width: 2,
          colorProperty: dataset.colorProperty,
        }),
      );

    case 'trips':
      return one(
        new STTTripsLayer({
          ...base,
          color: [0.12, 0.73, 0.84, 1],
          width: 2,
          trailLength: Math.max(dataset.timeWindow / 4, 30_000),
          colorProperty: dataset.colorProperty,
        }),
      );

    case 'polygon':
      return one(
        new STTPolygonLayer({
          ...base,
          ...keyedColors,
          color: [0.94, 0.42, 0.13, 0.55],
          stroked: true,
          lineWidth: 1,
          lineColor: [0.2, 0.2, 0.25, 0.9],
          fillColorProperty: dataset.colorProperty,
        }),
      );

    case 'heatmap': {
      const first = dataset.heatmapLayers?.[0];
      const colorRange = first?.colorRange as RGBA8[] | undefined;
      return one(
        new STTHeatmapLayer({
          ...base,
          radiusPixels: first?.radiusPixels ?? 30,
          intensity: first?.intensity ?? 1,
          colorRange,
          weightProperty: first?.weightProperty ?? dataset.weightProperty,
        }),
      );
    }

    case 'tripHeads': {
      // A smooth moving dot at each active trip's head. deck spells the size as
      // headRadiusPixels (pixels) OR headRadius + min/max clamps (meters); this
      // backend takes ONE radius prop + a unit selector.
      const meters = dataset.headSizeUnits === 'meters';
      return one(
        new STTTripHeadsLayer({
          ...base,
          ...keyedColors,
          color: dataset.headColor ?? [253, 128, 93, 255],
          radiusUnits: meters ? 'meters' : 'pixels',
          radius: meters
            ? (dataset.headRadius ?? 4)
            : (dataset.headRadiusPixels ?? 4),
          radiusMinPixels: dataset.headRadiusMinPixels,
          radiusMaxPixels: dataset.headRadiusMaxPixels,
          colorProperty: dataset.colorProperty,
        }),
      );
    }

    case 'arc':
      // Origin→destination flow arcs (2-vertex LineStrings bowed into arcs).
      return one(
        new STTArcLayer({
          ...base,
          sourceColor: dataset.arcSourceColor ?? [56, 196, 232, 210],
          targetColor: dataset.arcTargetColor ?? [255, 142, 64, 220],
          colorProperty: dataset.colorProperty,
          ...(dataset.colorPalette && { colorPalette: dataset.colorPalette }),
          width: dataset.arcWidth ?? 1.5,
          widthUnits: dataset.widthUnits ?? 'pixels',
          widthMinPixels: dataset.widthMinPixels ?? 1,
          widthMaxPixels: dataset.widthMaxPixels,
          greatCircle: dataset.arcGreatCircle ?? false,
          arcHeight: dataset.arcHeight ?? 1,
          fadeInDuration: dataset.fadeInDuration ?? 300,
        }),
      );

    case 'column':
      // Extruded 3D columns at point features; height from a numeric column.
      return one(
        new STTColumnLayer({
          ...base,
          radius: dataset.columnRadius ?? 100,
          radiusUnits:
            dataset.columnRadiusUnits === 'pixels' ? 'pixels' : 'meters',
          diskResolution: dataset.columnDiskResolution ?? 12,
          extruded: true,
          elevation:
            dataset.elevationProperty ?? dataset.columnElevation ?? 1000,
          elevationScale: dataset.elevationScale ?? 1,
          color: dataset.columnFillColor ?? [253, 128, 93, 220],
          fillColorProperty: dataset.colorProperty,
          ...(dataset.colorPalette && { colorPalette: dataset.colorPalette }),
          fadeInDuration: dataset.fadeInDuration ?? 300,
        }),
      );

    case 'h3Summary':
      return one(
        new STTH3SummaryLayer({
          ...base,
          cellToBoundary,
          weightProperty: dataset.summaryWeightProperty ?? 'count',
          colorRange: dataset.summaryColorRange as RGBA8[] | undefined,
          colorDomain: dataset.summaryColorDomain,
          extruded: dataset.summaryExtruded ?? false,
          elevationScale: dataset.summaryElevationScale ?? 1,
          coverage: dataset.summaryCoverage ?? 0.92,
          opacity: 0.85,
        }),
      );

    case 'quadbinSummary':
      // Square-cell (CARTO Quadbin) analog of `summary`; same option surface.
      return one(
        new STTQuadbinSummaryLayer({
          ...base,
          weightProperty: dataset.summaryWeightProperty ?? 'count',
          colorRange: dataset.summaryColorRange as RGBA8[] | undefined,
          colorDomain: dataset.summaryColorDomain,
          extruded: dataset.summaryExtruded ?? false,
          elevationScale: dataset.summaryElevationScale ?? 1,
          coverage: dataset.summaryCoverage ?? 0.92,
          opacity: 0.85,
        }),
      );

    case 'flowmap':
    case 'flowmap-bundled':
      // flowmap.gl-style animated OD flowmap. The native backend renders the
      // tapered per-bucket arrows; live GPU edge-bundling (the `-bundled`
      // superset) has no native analogue yet, so it DEGRADES to the straight
      // flowmap here — same tiles, same width animation, no relaxed rivers.
      return one(
        new STTFlowmapLayer({
          ...base,
          widthScale: dataset.flowWidthScale ?? 1.1,
          widthMinPixels: dataset.flowWidthMinPixels ?? 1,
          widthMaxPixels: dataset.flowWidthMaxPixels ?? 12,
          sourceColor: dataset.flowSourceColor ?? [56, 196, 232, 235],
          targetColor: dataset.flowTargetColor ?? [255, 142, 64, 245],
          gap: dataset.flowGap ?? 0.5,
          minFlow: dataset.flowMinFlow ?? 0.25,
        }),
      );

    case 'lightning':
      // GLM lightning from one flash-point archive: each flash appears bright
      // then fades + shrinks over `wakeLength` sim-ms (the comet decay). The
      // native point layer lacks deck's additive splat, so overlapping flashes
      // don't stack into the white-hot glow — a documented degrade.
      return one(
        new STTPointLayer({
          ...base,
          ...keyedColors,
          color: LIGHTNING_FLASH_COLOR,
          colorProperty: dataset.colorProperty,
          radius: 2,
          radiusUnits: 'pixels',
          wakeLength: dataset.wakeLength ?? 700_000,
          wakeTailScale: dataset.wakeTailScale ?? 0.15,
        }),
      );

    case 'radar': {
      // Composite NEXRAD/MRMS render, painter order field → tracks → cells.
      //   1. reflectivity CONTOUR BANDS (the field) — primary, required source,
      //      categorical `dbz_band` fill at FULL parity;
      //   2. storm-cell TRACKS — a trips overlay. deck grades the trail by
      //      per-vertex intensity (`tripGradient`); the native trips layer has
      //      no per-vertex gradient, so the tracks render a CONSTANT colour;
      //   3. storm-cell CENTROIDS — a point overlay. deck sizes them by
      //      `max_dbz` (sqrt transform, min/max clamp) + a stroke; the native
      //      point layer has none of those, so they render a modest CONSTANT
      //      radius (a location marker, not a magnitude-encoded dot).
      const descriptors: LayerDescriptor[] = [
        {
          sourceId: primaryId,
          required: true,
          layer: new STTPolygonLayer({
            ...base,
            filled: true,
            fillColorProperty: dataset.colorProperty ?? 'dbz_band',
            ...keyedColors,
            ...(dataset.fadeInDuration !== undefined && {
              fadeInDuration: dataset.fadeInDuration,
            }),
            ...(dataset.fadeOutDuration !== undefined && {
              fadeOutDuration: dataset.fadeOutDuration,
            }),
          }),
        },
      ];
      if (dataset.radarTracksUrl) {
        const o = overlay('tracks', dataset.radarTracksUrl);
        descriptors.push({
          sourceId: o.sourceId,
          required: o.required,
          layer: new STTTripsLayer({
            ...o.opts,
            color: dataset.tripColor ?? [255, 255, 255, 200],
            width:
              typeof dataset.tripWidth === 'number' ? dataset.tripWidth : 2.5,
            widthMinPixels: dataset.widthMinPixels ?? 1.2,
            widthMaxPixels: dataset.widthMaxPixels ?? 5,
            trailLength: dataset.trailLength ?? 1_800_000,
            fadeTrail: dataset.fadeTrail ?? true,
          }),
        });
      }
      if (dataset.radarCellsUrl) {
        const o = overlay('cells', dataset.radarCellsUrl);
        descriptors.push({
          sourceId: o.sourceId,
          required: o.required,
          layer: new STTPointLayer({
            ...o.opts,
            color: dataset.radarCellColor ?? [255, 255, 255, 230],
            radius: 3.5,
            radiusUnits: 'pixels',
          }),
        });
      }
      return descriptors;
    }

    default:
      return [];
  }
}
