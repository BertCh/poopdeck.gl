// @poopdeck.gl/showcase
// SPDX-License-Identifier: MIT

/**
 * SttThreeGeoViewer — the GEOGRAPHIC-demo analog of {@link AvThreeViewer}: it
 * renders a resolved geo `Dataset` on the Three.js + TSL (WebGPU) engine via
 * `@poopdeck.gl/three/r3f`, as a drop-in alternative to the deck.gl `DemoViewer`.
 * Same resolved Dataset + palettes + the same shared `TimeController` and
 * playback-governor `registry`, composed declaratively as r3f layer components
 * inside `<SttCanvas>`. This mirrors how `AvThreeViewer` mirrors `buildDemoLayers`'
 * `case 'av'` — here we mirror the GEO cases (`point` / `path` / `trips` / `arc` /
 * `column` / `h3Summary` / `quadbinSummary` / `flowmap` / `polygon`).
 *
 * ── Two projection paths (chosen per dataset) ───────────────────────────────
 *   • FLAT demos → `MercatorProjection`: a web-mercator world where 1:1 camera-sync
 *     with a maplibre street basemap is exact. The basemap is a maplibre-gl `Map`
 *     stacked UNDER the transparent `<SttCanvas>` (ground OFF + transparent clear),
 *     driven each frame by `BasemapOverlay.sync()` reading the SAME MercatorProjection
 *     instance. A basemap on/off toggle is exposed.
 *   • GLOBE demos (`useGlobe`) → `GlobeProjection` (WGS84 datum, so any future
 *     3D-tiles co-register): data is placed on a real ECEF globe. There is no slippy
 *     basemap — instead we render `<SttGlobeBasemap>` (an earth sphere) as the
 *     backdrop and expose an opt-in atmosphere toggle (WebGPU-only, default OFF).
 *
 * Each layer registers a governor source under the SAME id the deck path uses
 * (`dataset.id`; overlays `${id}-heads`, gated per `overlayGatesPlayback`) via
 * `<SttCanvas registry>`, so the transport/clock gate identically.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useThree, useFrame } from '@react-three/fiber';
import type { PerspectiveCamera } from 'three';
import type { PlaybackState } from '@poopdeck.gl/react';
import {
  BasemapOverlay,
  MercatorProjection,
  GlobeProjection,
  EARTH_RADIUS,
  type BasemapLike,
  type GeoAnchor,
  type Projection,
  threeBackend,
  type RGBA,
  type SttSourceRegistry,
} from '@poopdeck.gl/three';
import {
  SttCanvas,
  SttGlobeBasemap,
  SttPointCloudLayer,
  SttTripsLayer,
  SttTripHeadsLayer,
  SttPathLayer,
  SttArcLayer,
  SttColumnLayer,
  SttH3Layer,
  SttQuadbinLayer,
  SttFlowmapLayer,
  SttFlowCorridorLayer,
  SttPolygonLayer,
} from '@poopdeck.gl/three/r3f';
import { renderableDatasetTypes } from '../../lib/backendSupport';
import type { Dataset } from '../../types';
import { useReducedMotion } from '../../lib/reducedMotion';
import Legend from '../Legend';

/** App cyan — the shared constant fallback colour across the geo layers. */
const DEFAULT_COLOR: RGBA = [31, 186, 214, 255];
/** Default low→high ramp for the value-matrix corridor layer. */
const DEFAULT_RAMP: RGBA[] = [
  [10, 40, 60, 140],
  [31, 186, 214, 255],
];
/** CARTO's free dark style — the showcase's maplibre default (needs no token). */
const BASEMAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/**
 * Dataset types the Three geo path can render today — READ from the
 * `threeBackend` descriptor rather than hand-listed, so a kind three gains or
 * loses moves this set without a showcase edit. `heatmap` and `pointCloud` drop
 * out on their own (three declares both unsupported, degrading to `point`),
 * which is what keeps them off the toggle: this viewer has no branch for
 * either. The one composite wired here is `flowmap-bundled` (it needs the
 * `flowmap` kind and degrades to the unbundled corridor); `av` has its own
 * {@link AvThreeViewer}, and `radar` / `weather` / `storm4d` stay on deck.
 */
const THREE_GEO_TYPES = renderableDatasetTypes(threeBackend, [
  'flowmap-bundled',
]);

/**
 * Whether a demo can be offered the Three.js backend. Both flat (Mercator +
 * maplibre basemap) and globe (`GlobeProjection` + `SttGlobeBasemap`) demos are
 * supported now; only the layer type needs to be one we can render.
 */
export function datasetSupportsThree(dataset: Dataset): boolean {
  return THREE_GEO_TYPES.has(dataset.type);
}

/** categorical | ramp | constant — structurally identical to every Stt*Layer colorMode. */
type GeoColorMode =
  | {
      type: 'categorical';
      property: string;
      mapping: Record<string, RGBA>;
      fallback: RGBA;
    }
  | {
      type: 'ramp';
      property: string;
      domain: [number, number];
      range: RGBA[];
      fallback: RGBA;
    }
  | { type: 'constant'; color: RGBA };

/** Resolve a per-feature colour the way `buildDemoLayers` picks the deck colour:
 *  per-vertex gradient → categorical `colorProperty`+`colorMapping` → constant. */
function featureColorMode(ds: Dataset, constFallback: RGBA): GeoColorMode {
  if (ds.tripGradient) {
    return {
      type: 'ramp',
      property: ds.tripGradient.property,
      domain: ds.tripGradient.domain,
      range: ds.tripGradient.colors as RGBA[],
      fallback: constFallback,
    };
  }
  if (ds.colorProperty && ds.colorMapping) {
    return {
      type: 'categorical',
      property: ds.colorProperty,
      mapping: ds.colorMapping as Record<string, RGBA>,
      fallback: (ds.colorMappingDefault as RGBA | undefined) ?? constFallback,
    };
  }
  return { type: 'constant', color: constFallback };
}

const asRGBA = (
  c: [number, number, number, number] | undefined,
): RGBA | undefined => c as RGBA | undefined;
const constColor = (
  c: [number, number, number, number] | undefined,
  fallback: RGBA,
): RGBA => asRGBA(c) ?? fallback;

/**
 * The r3f layer element(s) for the dataset's geo type — the GEO analog of
 * `buildDemoLayers`. Projection-agnostic: the layers CPU-project through the
 * canvas's active `Projection` (Mercator for flat, Globe for globe), so the same
 * mapping serves both paths.
 */
function renderGeoLayers(ds: Dataset, perfMode: boolean): React.ReactNode {
  switch (ds.type) {
    case 'point': {
      const sizeUnits = ds.radiusUnits === 'pixels' ? 'pixels' : 'meters';
      const hasCat = !!(ds.colorProperty && ds.colorMapping);
      return (
        <SttPointCloudLayer
          id={ds.id}
          url={ds.url}
          mode={
            ds.cumulative ? 'cumulative' : ds.wakeLength ? 'wake' : 'window'
          }
          timeWindow={ds.timeWindow}
          sizeUnits={sizeUnits}
          pointSize={ds.radius ?? (sizeUnits === 'pixels' ? 3 : 40)}
          colorProperty={hasCat ? ds.colorProperty : undefined}
          colorMapping={
            hasCat ? (ds.colorMapping as Record<string, RGBA>) : undefined
          }
          colorMappingDefault={asRGBA(ds.colorMappingDefault) ?? DEFAULT_COLOR}
          elevationProperty={ds.use3D ? (ds.elevationProperty ?? 'z') : null}
          elevationScale={ds.elevationScale ?? 1}
          wakeLength={ds.wakeLength}
          wakeTailScale={ds.wakeTailScale}
          opacity={ds.opacity ?? 0.9}
          alphaCutoff={perfMode ? 0.1 : undefined}
        />
      );
    }
    case 'tripHeads':
      return (
        <SttTripHeadsLayer
          id={ds.id}
          url={ds.url}
          headColor={asRGBA(ds.headColor) ?? [253, 128, 93, 255]}
          headRadius={ds.headRadius ?? 6}
          opacity={ds.opacity ?? 0.9}
        />
      );
    case 'path':
      return (
        <SttPathLayer
          id={ds.id}
          url={ds.url}
          colorMode={featureColorMode(
            ds,
            constColor(ds.pathColor, DEFAULT_COLOR),
          )}
          widthPx={typeof ds.pathWidth === 'number' ? ds.pathWidth : 3}
          timeWindow={ds.timeWindow}
          opacity={ds.opacity ?? 0.8}
        />
      );
    case 'trips': {
      // Static-geometry value-matrix corridors (flowMatrix / flowStroke) →
      // FlowCorridorLayer (width + colour animate from the per-segment matrix).
      // Everything else is a trailing AnimatedTripsLayer.
      const primary =
        ds.flowMatrix || ds.flowStroke ? (
          <SttFlowCorridorLayer
            id={ds.id}
            url={ds.url}
            domain={ds.tripGradient?.domain ?? ds.summaryColorDomain ?? [0, 60]}
            ramp={
              (ds.tripGradient?.colors as RGBA[] | undefined) ?? DEFAULT_RAMP
            }
            minWidthPx={ds.widthMinPixels ?? 1}
            maxWidthPx={ds.widthMaxPixels ?? 8}
            opacity={ds.opacity ?? 0.85}
          />
        ) : (
          <SttTripsLayer
            id={ds.id}
            url={ds.url}
            colorMode={featureColorMode(
              ds,
              constColor(ds.tripColor, DEFAULT_COLOR),
            )}
            widthPx={typeof ds.tripWidth === 'number' ? ds.tripWidth : 4}
            trailLength={ds.trailLength ?? 60000}
            trailFade={ds.fadeTrail === false ? 0 : 1}
            opacity={ds.opacity ?? 0.85}
          />
        );
      // Composite: moving head-dots from a SECOND (per-trip) archive on top of
      // the corridors. Gating is policy-driven, same as the deck path: REQUIRED
      // by DEFAULT so the shared clock waits for the riders too;
      // overlayGatesPlayback: false opts into continue-and-degrade.
      if (ds.headsOverlayUrl) {
        return (
          <>
            {primary}
            <SttTripHeadsLayer
              id={`${ds.id}-heads`}
              url={ds.headsOverlayUrl}
              sourceRequired={ds.overlayGatesPlayback ?? true}
              headColor={asRGBA(ds.headColor) ?? [253, 128, 93, 255]}
              headRadius={ds.headRadius ?? 6}
            />
          </>
        );
      }
      return primary;
    }
    case 'arc':
      return (
        <SttArcLayer
          id={ds.id}
          url={ds.url}
          sourceColor={{
            type: 'constant',
            color: constColor(ds.arcSourceColor, [56, 196, 232, 210]),
          }}
          targetColor={{
            type: 'constant',
            color: constColor(ds.arcTargetColor, [255, 142, 64, 220]),
          }}
          widthPx={ds.arcWidth ?? 1.5}
          height={ds.arcHeight ?? 1}
          // On the globe an arc should ride a great circle; the dataset flag wins,
          // else default to greatCircle for globe demos and parabolic for flat.
          shape={
            (ds.arcGreatCircle ?? ds.useGlobe) ? 'greatCircle' : 'parabolic'
          }
          timeWindow={ds.timeWindow}
          fadeInDuration={ds.fadeInDuration ?? 300}
          opacity={ds.opacity ?? 0.85}
        />
      );
    case 'column':
      return (
        <SttColumnLayer
          id={ds.id}
          url={ds.url}
          colorMode={featureColorMode(
            ds,
            constColor(ds.columnFillColor, [253, 128, 93, 220]),
          )}
          radius={ds.columnRadius ?? 100}
          diskResolution={ds.columnDiskResolution ?? 12}
          elevationProperty={ds.elevationProperty ?? null}
          defaultElevation={ds.columnElevation ?? 1000}
          elevationScale={ds.elevationScale ?? 1}
          opacity={ds.opacity ?? 0.9}
        />
      );
    case 'h3Summary':
    case 'quadbinSummary': {
      // Use the first weight-toggle option (the default view) if the demo declares
      // one, else its single-weight settings.
      const toggle = ds.summaryToggleWeights?.[0];
      const weightProperty =
        toggle?.weightProperty ?? ds.summaryWeightProperty ?? 'count';
      const colorRange = (toggle?.colorRange ?? ds.summaryColorRange) as
        | RGBA[]
        | undefined;
      const colorDomain = toggle?.colorDomain ?? ds.summaryColorDomain ?? null;
      const common = {
        id: ds.id,
        url: ds.url,
        weightProperty,
        colorRange,
        colorDomain,
        coverage: ds.summaryCoverage ?? 0.92,
        opacity: 0.85,
      };
      return ds.type === 'h3Summary' ? (
        <SttH3Layer {...common} />
      ) : (
        <SttQuadbinLayer {...common} />
      );
    }
    case 'flowmap':
    case 'flowmap-bundled':
      // No GPU edge-bundling in the Three engine yet — both render as flowmap.gl
      // tapered arrows (the bundled variant falls back to straight arrows).
      return (
        <SttFlowmapLayer
          id={ds.id}
          url={ds.url}
          sourceColor={asRGBA(ds.flowSourceColor) ?? [56, 196, 232, 235]}
          targetColor={asRGBA(ds.flowTargetColor) ?? [255, 142, 64, 245]}
          widthScale={ds.flowWidthScale ?? 1.1}
          widthMinPixels={ds.flowWidthMinPixels ?? 1}
          widthMaxPixels={ds.flowWidthMaxPixels ?? 12}
          nodeColor={asRGBA(ds.flowNodeColor)}
          nodeRadiusScale={ds.flowNodeRadiusScale ?? 1.3}
          minFlow={ds.flowMinFlow ?? 0.25}
          gap={ds.flowGap ?? 0.5}
          opacity={ds.opacity ?? 0.9}
        />
      );
    case 'polygon':
      return (
        <SttPolygonLayer
          id={ds.id}
          url={ds.url}
          colorMode={featureColorMode(
            ds,
            constColor(ds.polygonFillColor, [31, 186, 214, 180]),
          )}
          mode="window"
          timeWindow={ds.timeWindow}
          opacity={ds.opacity ?? 0.8}
        />
      );
    default:
      return null;
  }
}

/**
 * In-canvas r3f helper (FLAT demos only): reads the live camera + the active
 * `MercatorProjection` and drives the host maplibre map via `BasemapOverlay.sync()`
 * each frame. With a web-mercator world `cameraToViewState` is exact, so the
 * overlay uses the real canvas height as `viewportHeight` (1:1 alignment). The
 * overlay is rebuilt on projection/viewport change (NOT disposed — that would
 * `map.remove()` the host-owned map; we only `detach()`).
 */
function BasemapSync(props: {
  map: maplibregl.Map;
  projection: Projection;
  enabled: boolean;
}): null {
  const { map, projection, enabled } = props;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const height = useThree((s) => s.size.height);
  const overlayRef = useRef<BasemapOverlay | null>(null);

  useEffect(() => {
    const overlay = new BasemapOverlay(
      map as unknown as BasemapLike,
      projection,
      camera,
      {
        viewportHeight: Math.max(1, height),
        enabled,
      },
    );
    overlayRef.current = overlay;
    overlay.resize();
    return () => {
      overlay.detach();
      overlayRef.current = null;
    };
    // `enabled` is reconciled in the effect below so a toggle doesn't rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, projection, camera, height]);

  // Attach / detach without rebuilding when the toggle flips.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (enabled) overlay.attach();
    else overlay.detach();
  }, [enabled]);

  useFrame(() => {
    overlayRef.current?.sync();
  });

  return null;
}

export interface SttThreeGeoViewerProps {
  dataset: Dataset;
  playback: PlaybackState;
  /** Push the top-left in-map chip down by N px so a floating header clears it. */
  topLeftInset?: number;
  /** false renders with the controller off (embed tap-to-interact shield). */
  interactive?: boolean;
}

const SttThreeGeoViewer: React.FC<SttThreeGeoViewerProps> = ({
  dataset,
  playback,
  topLeftInset = 0,
}) => {
  const { timeController, registry } = playback;
  const reducedMotion = useReducedMotion();
  const timeRange = dataset.timeRange;
  const getTime = useCallback(() => timeController.getTime(), [timeController]);
  const isGlobe = !!dataset.useGlobe;

  const anchor = useMemo<GeoAnchor>(
    () => ({
      longitude: dataset.initialViewState.longitude,
      latitude: dataset.initialViewState.latitude,
    }),
    [dataset.initialViewState.longitude, dataset.initialViewState.latitude],
  );

  // Deck-parity initial camera: drive the Three camera from the demo's view state
  // (lng/lat/zoom/pitch/bearing) so the data is framed at the intended zoom — not the
  // AV/ENU bounds-fit, whose metre-scale distance clamps push a city-scale mercator
  // scene entirely off-screen (basemap shows, data does not). Works for globe too.
  const initialViewState = useMemo(() => {
    const v = dataset.initialViewState;
    return {
      longitude: v.longitude,
      latitude: v.latitude,
      zoom: v.zoom,
      pitch: v.pitch ?? (isGlobe ? 0 : 45),
      bearing: v.bearing ?? 0,
    };
  }, [dataset.initialViewState, isGlobe]);

  // One projection instance per dataset, shared by <SttCanvas> AND (flat) the
  // basemap overlay so `cameraToViewState` is exact. Globe uses the WGS84 datum so
  // any future 3D-tiles / atmosphere co-register.
  const projection = useMemo<Projection>(
    () =>
      isGlobe
        ? new GlobeProjection(anchor, EARTH_RADIUS, { datum: 'wgs84' })
        : new MercatorProjection(anchor),
    [isGlobe, anchor],
  );

  // FLAT-only chrome: maplibre street basemap + toggle.
  const [showBasemap, setShowBasemap] = useState(true);
  const basemapContainerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  // GLOBE-only chrome: opt-in atmosphere (WebGPU-only, default OFF).
  const [atmosphere, setAtmosphere] = useState(false);

  // Own the maplibre map (flat demos only): one per dataset (the SttCanvas is
  // keyed on dataset.id too, so both remount together on a dataset switch).
  useEffect(() => {
    if (isGlobe) return;
    const container = basemapContainerRef.current;
    if (!container) return;
    const view = dataset.initialViewState;
    const m = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
      // maplibre-gl v5 dropped the boolean form; {} keeps the default control.
      attributionControl: {},
      // The Three camera drives the map every frame — no user interaction with
      // the map itself (all gestures go to the transparent canvas above it).
      interactive: false,
    });
    // Per-dataset basemap tuning (same intent as DemoViewer's Mapbox onLoad):
    // hide labels / darken land / tint roads. Type-based so it survives style
    // revisions; wrapped because the CARTO style's layer set differs from Mapbox.
    m.on('style.load', () => {
      try {
        const hideLabels = dataset.basemapHideLabels;
        const bg = dataset.basemapBackgroundColor;
        const roadColor = dataset.basemapRoadColor;
        if (!hideLabels && !bg && !roadColor) return;
        for (const layer of m.getStyle().layers ?? []) {
          if (hideLabels && layer.type === 'symbol') {
            m.setLayoutProperty(layer.id, 'visibility', 'none');
          }
          if (bg) {
            if (layer.type === 'background') {
              m.setPaintProperty(layer.id, 'background-color', bg);
            } else if (layer.type === 'fill' && /land|earth/i.test(layer.id)) {
              m.setPaintProperty(layer.id, 'fill-color', bg);
            }
          }
          if (
            roadColor &&
            layer.type === 'line' &&
            /road|street|bridge|tunnel/i.test(layer.id)
          ) {
            m.setPaintProperty(layer.id, 'line-color', roadColor);
          }
        }
      } catch {
        /* a style without the expected layers → leave the basemap as-is */
      }
    });
    setMap(m);
    return () => {
      setMap(null);
      m.remove();
    };
  }, [dataset, isGlobe]);

  // Solid earth-sphere colour for the globe backdrop (from the dataset if set).
  const globeColor = useMemo<number | undefined>(() => {
    const c = dataset.globeBackgroundColor;
    return c ? (c[0] << 16) | (c[1] << 8) | c[2] : undefined;
  }, [dataset.globeBackgroundColor]);

  return (
    <div className="w-full h-full map-viewport relative">
      {/* Basemap canvas — stacked UNDER the transparent Three canvas, pixel-aligned
          (flat demos only; the globe has no slippy basemap). */}
      {!isGlobe && (
        <div
          ref={basemapContainerRef}
          className="absolute inset-0"
          style={{ visibility: showBasemap ? 'visible' : 'hidden' }}
        />
      )}

      <SttCanvas
        // Remount the whole scene (incl. the WebGPU context) on a dataset change;
        // the basemap map remounts in lock-step (its effect keys on the dataset).
        key={dataset.id}
        anchor={anchor}
        projection={projection}
        timeOrigin={timeRange.start}
        timeRange={timeRange}
        registry={registry as SttSourceRegistry}
        getTime={getTime}
        reducedMotion={reducedMotion}
        // Flat: no engine ground + transparent clear so the maplibre canvas shows
        // through. Globe: the SttGlobeBasemap sphere is the surface; clear to space.
        ground={false}
        background={isGlobe ? '#05070d' : 'transparent'}
        atmosphere={isGlobe ? atmosphere : false}
        // Geo archives are large (a taxi-trips archive is tens of millions of
        // segments at native zoom over its full span); the eager load-everything
        // source never finishes, so the layer renders nothing. Stream instead —
        // load only the tiles the camera can see at the current zoom, exactly like
        // the deck path. Viewport-driven LOD/eviction is wired in @poopdeck.gl/three.
        streaming
        initialViewState={initialViewState}
        headingDeg={dataset.initialViewState.bearing ?? 0}
        pitchDeg={dataset.initialViewState.pitch ?? 45}
        style={{ position: 'absolute', inset: 0 }}
      >
        {renderGeoLayers(dataset, false)}
        {isGlobe && <SttGlobeBasemap color={globeColor} />}
        {!isGlobe && map && (
          <BasemapSync
            map={map}
            projection={projection}
            enabled={showBasemap}
          />
        )}
      </SttCanvas>

      {/* Top-left toggle (clears a floating header via inset): basemap on/off for
          flat demos, atmosphere on/off for globe demos. */}
      <div className="absolute left-3 z-10" style={{ top: 12 + topLeftInset }}>
        {isGlobe ? (
          <button
            type="button"
            onClick={() => setAtmosphere((v) => !v)}
            aria-pressed={atmosphere}
            title="Toggle the physically-based atmosphere / sky (WebGPU only)"
            className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
              atmosphere
                ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
                : 'border-white/10 bg-black/55 text-slate-300 hover:bg-white/5'
            }`}
          >
            {atmosphere ? 'Atmosphere' : 'No atmosphere'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowBasemap((v) => !v)}
            aria-pressed={showBasemap}
            title="Toggle the street basemap under the data"
            className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
              showBasemap
                ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
                : 'border-white/10 bg-black/55 text-slate-300 hover:bg-white/5'
            }`}
          >
            {showBasemap ? 'Basemap' : 'No basemap'}
          </button>
        )}
      </div>

      {dataset.legend && (
        <div className="absolute bottom-3 right-3">
          <Legend legend={dataset.legend} />
        </div>
      )}
    </div>
  );
};

export default SttThreeGeoViewer;
