/**
 * The live demo map surface: layer construction, space-time-cube overlays,
 * globe auto-rotation, and the in-map chrome (legend, cube controls, summary
 * toggle, perf HUD). Mounted by both the fullscreen viewer (`/demo/:id`) and
 * the per-demo landing-page embed (`/demos/:id`); playback state arrives via
 * the shared `useDemoPlayback` hook so the two surfaces cannot drift.
 */
import React, { useState, useMemo, useEffect, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { _GlobeView as GlobeView } from "@deck.gl/core";
import { LineLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl";
import {
  AnimatedPointLayer,
  AnimatedPathLayer,
  AnimatedTripsLayer,
  FlowCorridorLayer,
  AnimatedPolygonLayer,
  HeatmapLayer,
  H3SummaryLayer,
  VatTripsLayer,
} from "@stt/deck.gl";
import type { BufferSource, HeatmapChannelSpec } from "@stt/deck.gl";
import { tileLoadingProps } from "../../types";
import type { Dataset, SummaryToggleOption } from "../../types";
import Legend from "../Legend";
import PerformanceMonitor from "../PerformanceMonitor";
import type { DemoPlayback } from "./useDemoPlayback";

const MAPBOX_ACCESS_TOKEN =
  (import.meta as any).env?.VITE_MAPBOX_TOKEN ||
  "pk.eyJ1IjoicmdjZ2VvZyIsImEiOiJjajBuNG1sMjUwMDFlMzNxcWY0M2RqMHI3In0.XfM0BMSqZqjRDcz-oJuadw";

const EARTH_POLYGON: number[][][] = [
  [
    [-180, 90],
    [0, 90],
    [180, 90],
    [180, -90],
    [0, -90],
    [-180, -90],
  ],
];

/**
 * Minimal slice of @stt/core's Tile that the space-time-cube lattice needs.
 * Kept local so the showcase doesn't grow a direct @stt/core dependency for
 * one overlay.
 */
interface LatticeTile {
  id: { z: number; x: number; y: number; t: number };
  timeRange: { start: number; end: number };
}

/** North-edge latitude of slippy-map tile row `y` at zoom with `n = 2^z` tiles. */
function tileLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}

export interface DemoViewerProps {
  dataset: Dataset;
  playback: DemoPlayback;
  /** Show the collapsed performance HUD chip (fullscreen viewer only). */
  showPerfHud?: boolean;
  /** false renders with controller off (embed tap-to-interact shield). */
  interactive?: boolean;
}

const DemoViewer: React.FC<DemoViewerProps> = ({
  dataset: selectedDataset,
  playback,
  showPerfHud = false,
  interactive = true,
}) => {
  const {
    timeController,
    tilesetRef,
    currentTime,
    overviewPreload,
    handleTilesetReady,
    handleBufferChange,
    handleOverviewPreload,
  } = playback;

  // Active option for summary-tier weight toggles (e.g. pickup vs dropoff).
  // Reset to the dataset's first option whenever the dataset changes.
  const summaryToggleOptions = selectedDataset.summaryToggleWeights;
  const [summaryToggleId, setSummaryToggleId] = useState<string | undefined>(
    summaryToggleOptions?.[0]?.id,
  );
  useEffect(() => {
    setSummaryToggleId(summaryToggleOptions?.[0]?.id);
  }, [summaryToggleOptions]);
  const activeSummaryToggle: SummaryToggleOption | undefined = useMemo(() => {
    if (!summaryToggleOptions) return undefined;
    return (
      summaryToggleOptions.find((o) => o.id === summaryToggleId) ??
      summaryToggleOptions[0]
    );
  }, [summaryToggleOptions, summaryToggleId]);

  // Projection follows the dataset's tuned default (no user toggle in the
  // shipped UI). Globe-default demos (e.g. ocean currents) stay on the globe.
  const useGlobe = selectedDataset.useGlobe ?? false;

  // ── Space-time cube (time = height) ────────────────────────────────────────
  // `heightFactor` is the squash slider: 0 = flat map, 1 = full cube. It feeds
  // a single shader uniform (timeHeightScale, meters per sim-ms), so dragging
  // it morphs the city into the cube with zero data re-upload.
  const timeHeight = selectedDataset.timeHeight;
  const [heightFactor, setHeightFactor] = useState(1);
  const [showLattice, setShowLattice] = useState(true);
  useEffect(() => {
    setHeightFactor(timeHeight?.initialFactor ?? 1);
    setShowLattice(timeHeight?.tileLattice !== false);
  }, [selectedDataset, timeHeight]);
  const rangeDurationMs =
    selectedDataset.timeRange.end - selectedDataset.timeRange.start || 1;
  const timeHeightScale = timeHeight
    ? (heightFactor * timeHeight.rangeHeightMeters) / rangeDurationMs
    : 0;

  // STT tile lattice: every loaded tile is literally a box in (x, y, t) — its
  // slippy-tile footprint × its temporal bucket. Poll the tileset's loaded
  // set on a slow cadence (tile arrivals are bursty but the set is small) and
  // re-render only when membership changes, so the cube visibly fills in
  // box-by-box as the loader streams.
  const [latticeTiles, setLatticeTiles] = useState<LatticeTile[]>([]);
  useEffect(() => {
    setLatticeTiles([]);
    if (!timeHeight) return;
    let prevSig = "";
    const poll = setInterval(() => {
      const tileset = tilesetRef.current as
        | (BufferSource & { getVisibleTiles?: () => LatticeTile[] })
        | null;
      const tiles = tileset?.getVisibleTiles?.();
      if (!tiles) return;
      const sig = tiles
        .map((t) => `${t.id.z}/${t.id.x}/${t.id.y}/${t.id.t}`)
        .sort()
        .join(",");
      if (sig === prevSig) return;
      prevSig = sig;
      setLatticeTiles(
        tiles.map((t) => ({ id: { ...t.id }, timeRange: { ...t.timeRange } })),
      );
    }, 300);
    return () => clearInterval(poll);
  }, [selectedDataset, timeHeight, tilesetRef]);

  const layers = useMemo(() => {
    const datasetDuration =
      selectedDataset.timeRange.end - selectedDataset.timeRange.start;
    const playbackSpeed =
      datasetDuration / (selectedDataset.targetPlaybackSeconds || 60) / 1000;
    // Cumulative ("draw and persist") datasets reveal progressively in the
    // shader, so the tile loader must keep every played-through bucket
    // resident. A symmetric window of 2× the dataset duration guarantees the
    // loader's [t-w/2, t+w/2] always covers the whole [start, end] range — at
    // metro/viewport scale this loads the visible city's tiles once and retains
    // them. Non-cumulative datasets keep their per-dataset rolling window.
    const isCumulative = !!selectedDataset.cumulative;
    const timeWindow = isCumulative
      ? datasetDuration * 2
      : selectedDataset.timeWindow || 86400000;

    const baseProps = {
      id: selectedDataset.id,
      data: selectedDataset.url,
      // Seed with the initial time. The layer reads the live time from the
      // shared TimeController every draw — we deliberately do NOT thread
      // the React `currentTime` state in here, because that would invalidate
      // the layer prop tree at 60Hz and force deck.gl to re-run updateState
      // (and the trip consolidation cache) on every tick.
      currentTime: selectedDataset.timeRange.start,
      timeController,
      timeWindow,
      timeRange: selectedDataset.timeRange,
      // Tile-tier dispatch. Defaults to 'auto' (summary overview at low zoom);
      // datasets can force 'raw' when the summary overlay obscures the story.
      tier: selectedDataset.tier,
      opacity: selectedDataset.opacity ?? 0.8,
      pickable: false,
      // Shared prefetch/concurrency recipe (see tileLoadingProps): a few real
      // seconds of sim-time lookahead, floored at the resident window.
      ...tileLoadingProps(timeWindow, playbackSpeed),
      // Playback-governor plumbing: hand the tileset over once it exists and
      // forward buffer-runway events for immediate gate/stall evaluation.
      onTilesetReady: handleTilesetReady,
      onBufferChange: handleBufferChange,
      // Storyboard preview tier: pin z0–z1 across the full time range so
      // scrubbing always renders SOMETHING (default 20 MiB budget gate — the
      // tileset rejects datasets with giant coarse tiles, e.g. satellites).
      overviewPreload: true,
      onOverviewPreload: handleOverviewPreload,
      // Space-time cube: 0 (inert) unless the dataset opts in via timeHeight.
      timeHeightScale,
      timeHeightOrigin: selectedDataset.timeRange.start,
    };

    switch (selectedDataset.type) {
      case "point":
        return [
          new AnimatedPointLayer({
            ...baseProps,
            fillColor: selectedDataset.colorProperty || [31, 186, 214, 255],
            colorMapping: selectedDataset.colorMapping,
            colorMappingDefault: selectedDataset.colorMappingDefault,
            radius:
              selectedDataset.radiusProperty ??
              selectedDataset.radius ??
              1000,
            // Per-dataset styling overrides; legacy datasets stay on the old
            // meters/×2 default so ship and flight markers keep their look.
            radiusUnits: selectedDataset.radiusUnits ?? "meters",
            radiusScale: selectedDataset.radiusScale ?? 2,
            radiusMinPixels: selectedDataset.radiusMinPixels,
            radiusMaxPixels: selectedDataset.radiusMaxPixels,
            radiusTransform: selectedDataset.radiusTransform,
            stroked: selectedDataset.stroked,
            strokeColor: selectedDataset.strokeColor,
            lineWidthMinPixels: selectedDataset.lineWidthMinPixels,
            wakeLength: selectedDataset.wakeLength,
            wakeTailScale: selectedDataset.wakeTailScale,
            // Cumulative "draw the map" mode (e.g. OSM node creations): points
            // appear at their creation time and persist. fadeInDuration (sim-ms)
            // doubles as the "ink appearing" ramp.
            cumulative: selectedDataset.cumulative,
            fadeInDuration: selectedDataset.fadeInDuration,
            use3D: selectedDataset.use3D,
            elevationProperty: selectedDataset.elevationProperty,
            elevationScale: selectedDataset.elevationScale,
          }),
        ];
      case "path":
        return [
          new AnimatedPathLayer({
            ...baseProps,
            pathColor:
              selectedDataset.colorProperty ||
              selectedDataset.pathColor ||
              [31, 186, 214, 255],
            pathWidth: selectedDataset.pathWidth ?? 3,
            widthUnits: selectedDataset.widthUnits ?? "pixels",
            // Same fragment-cost story as trips: rounded is the dominant cost
            // on dense Manhattan paths at small widths; default off.
            capRounded: selectedDataset.capRounded ?? false,
            jointRounded: selectedDataset.jointRounded ?? false,
          }),
        ];
      case "vat":
        return [
          new VatTripsLayer({
            ...baseProps,
            headColor: selectedDataset.vatHeadColor ?? [253, 128, 93, 255],
            headRadiusPixels: selectedDataset.vatHeadRadiusPixels ?? 4,
            // World-space sizing (meters) so VAT heads/ribbons emerge on zoom
            // like the maritime points; defaults to pixels (legacy look).
            sizeUnits: selectedDataset.vatSizeUnits,
            headRadius: selectedDataset.vatHeadRadius,
            headRadiusMinPixels: selectedDataset.vatHeadRadiusMinPixels,
            headRadiusMaxPixels: selectedDataset.vatHeadRadiusMaxPixels,
            timeSlots: selectedDataset.vatTimeSlots ?? 64,
            // Trail-mode props. When vatTrailLength > 0 the layer renders a
            // ribbon per active trip instead of a head dot — same scaling
            // characteristics, visual parity with AnimatedTripsLayer trips.
            trailLength: selectedDataset.vatTrailLength ?? 0,
            trailSamples: selectedDataset.vatTrailSamples ?? 16,
            trailColor:
              selectedDataset.vatTrailColor ??
              selectedDataset.vatHeadColor ??
              [253, 128, 93, 255],
            tripWidth: selectedDataset.vatTripWidth ?? 4,
            widthMinPixels: selectedDataset.widthMinPixels ?? 2,
            widthMaxPixels: selectedDataset.widthMaxPixels ?? 8,
            fadeTrail: selectedDataset.vatFadeTrail ?? true,
          }),
        ];
      case "trips": {
        // Static-geometry overviews (flow corridors) carry a per-vertex ×
        // per-bucket value matrix and animate via FlowCorridorLayer — the
        // geometry loads once and only the active bucket column changes.
        const TripsLayerCtor = selectedDataset.flowMatrix
          ? FlowCorridorLayer
          : AnimatedTripsLayer;
        const tripsLayer = new TripsLayerCtor({
          ...baseProps,
          // useGlobe / useGlobalBounds / zoomOverride let a dataset opt into
          // a global tile load without bespoke per-id branching here. Globe
          // mode forces global bounds because GlobeView's unproject() at low
          // zoom returns degenerate bounds — without it the tile loader sees
          // a tiny visible box and never requests the polar/back-side tiles.
          ...(selectedDataset.zoomOverride !== undefined && {
            zoomOverride: selectedDataset.zoomOverride,
          }),
          ...((selectedDataset.useGlobalBounds || useGlobe) && {
            useGlobalBounds: true,
          }),
          // A categorical `colorProperty` is passed as the property-name form
          // of `tripColor`; `colorMapping` keeps colors stable across tiles.
          tripColor:
            selectedDataset.colorProperty ?? selectedDataset.tripColor ?? [31, 186, 214, 255],
          ...(selectedDataset.colorMapping && { colorMapping: selectedDataset.colorMapping }),
          ...(selectedDataset.colorMappingDefault && {
            colorMappingDefault: selectedDataset.colorMappingDefault,
          }),
          // Per-vertex gradient (e.g. ocean-drifter SST) shades the line along
          // its length and takes precedence over categorical `tripColor`.
          ...(selectedDataset.tripGradient && {
            gradientProperty: selectedDataset.tripGradient.property,
            gradientDomain: selectedDataset.tripGradient.domain,
            gradientColorRamp: selectedDataset.tripGradient.colors,
          }),
          tripWidth: selectedDataset.tripWidth ?? 4,
          // World-space widths (meters) when a dataset opts in, so trails
          // thicken on zoom like the maritime points; defaults to pixels.
          widthUnits: selectedDataset.widthUnits ?? "pixels",
          widthMinPixels: selectedDataset.widthMinPixels ?? 2,
          widthMaxPixels: selectedDataset.widthMaxPixels ?? 8,
          trailLength: selectedDataset.trailLength ?? 60000,
          fadeTrail: selectedDataset.fadeTrail ?? true,
          // Rounded caps/joints are the dominant fragment-shader cost at small
          // widths; default off and let datasets opt in.
          capRounded: selectedDataset.capRounded ?? false,
          jointRounded: selectedDataset.jointRounded ?? false,
        });
        if (useGlobe) {
          return [
            new SolidPolygonLayer({
              id: "earth-background",
              data: EARTH_POLYGON,
              getPolygon: (d) => d as any,
              stroked: false,
              filled: true,
              getFillColor:
                selectedDataset.globeBackgroundColor ?? [36, 39, 48, 255],
            }),
            tripsLayer,
          ];
        }
        return [tripsLayer];
      }
      case "heatmap": {
        // Stacked heatmaps now compile down to ONE HeatmapLayer with N
        // channels packed into the RGBA accumulator — half the draw calls
        // and one shared FBO. The legacy per-spec sublayer fanout is gone.
        const specs = selectedDataset.heatmapLayers ?? [];
        if (specs.length === 0) {
          return [
            new HeatmapLayer({
              ...baseProps,
              radiusPixels: 30,
              intensity: 1,
              colorRange: [
                [255, 255, 178, 255],
                [254, 204, 92, 255],
                [253, 141, 60, 255],
                [240, 59, 32, 255],
                [189, 0, 38, 255],
              ],
              weightProperty: selectedDataset.weightProperty,
              // TAA — visible smoothness boost at no measurable cost.
              historyWeight: 0.15,
            }),
          ];
        }
        // Pick the first spec's radius/intensity for the layer-wide values
        // (the per-channel intensity multiplier still composes on top).
        const first = specs[0];
        const channels: HeatmapChannelSpec[] = specs.slice(0, 4).map((spec) => ({
          id: spec.id,
          categoryFilter: spec.categoryFilter,
          colorRange: spec.colorRange,
          colorDomain: spec.colorDomain ?? undefined,
          intensity: spec.intensity ?? 1,
        }));
        return [
          new HeatmapLayer({
            ...baseProps,
            id: `${selectedDataset.id}-heatmap`,
            radiusPixels: first.radiusPixels ?? 30,
            intensity: 1,
            weightProperty:
              first.weightProperty ?? selectedDataset.weightProperty,
            channels,
            historyWeight: 0.15,
          }),
        ];
      }
      case "polygon":
        return [
          new AnimatedPolygonLayer({
            ...baseProps,
            filled: selectedDataset.polygonFilled ?? true,
            stroked: selectedDataset.polygonStroked ?? false,
            lineWidthUnits: selectedDataset.polygonLineWidthUnits ?? "pixels",
            lineWidth: selectedDataset.polygonLineWidth ?? 2,
            lineColor: selectedDataset.polygonLineColor ?? [31, 186, 214, 255],
            fillColor:
              selectedDataset.colorProperty ||
              selectedDataset.polygonFillColor ||
              [31, 186, 214, 180],
          }),
        ];
      case "summary": {
        // If the dataset declares a toggle (e.g. pickup vs dropoff), the
        // active option overrides the base summary styling props. Otherwise
        // fall back to the dataset's single-weight settings.
        const weightProperty =
          activeSummaryToggle?.weightProperty ??
          selectedDataset.summaryWeightProperty ??
          "count";
        const colorRange =
          activeSummaryToggle?.colorRange ?? selectedDataset.summaryColorRange;
        const colorDomain =
          activeSummaryToggle?.colorDomain ?? selectedDataset.summaryColorDomain;
        return [
          new H3SummaryLayer({
            id: `${selectedDataset.id}-${activeSummaryToggle?.id ?? "default"}`,
            data: selectedDataset.url,
            currentTime: selectedDataset.timeRange.start,
            timeController,
            timeWindow,
            // Same governor plumbing as the raw-tier layers (baseProps).
            onTilesetReady: handleTilesetReady,
            onBufferChange: handleBufferChange,
            weightProperty,
            colorRange,
            colorDomain,
            extruded: selectedDataset.summaryExtruded ?? false,
            elevationScale: selectedDataset.summaryElevationScale ?? 1,
            coverage: selectedDataset.summaryCoverage ?? 0.92,
            opacity: 0.85,
            pickable: false,
          }),
        ];
      }
      default:
        return [];
    }
    // `currentTime` is deliberately NOT in the dependency list: the layer
    // pulls live time from the shared TimeController on every draw, and
    // including currentTime here rebuilt the prop tree every tick (60Hz),
    // which forced deck.gl to invalidate the trip consolidation cache and
    // re-copy ~10M vertex positions per frame on the NYC taxi dataset.
  }, [
    selectedDataset,
    timeController,
    activeSummaryToggle,
    useGlobe,
    handleTilesetReady,
    handleBufferChange,
    handleOverviewPreload,
    timeHeightScale,
  ]);

  // Cube overlay layers: the tile lattice and the rising now-plane. Kept in a
  // SEPARATE memo from the data layers — these legitimately rebuild with the
  // 20 Hz `currentTime` UI state and the squash slider (tiny geometry), while
  // the data layers must NOT (their memo deliberately excludes currentTime).
  const cubeLayers = useMemo(() => {
    if (!timeHeight || timeHeightScale <= 0) return [];
    const origin = selectedDataset.timeRange.start;
    const clampT = (t: number) => Math.max(0, Math.min(rangeDurationMs, t - origin));
    const out: any[] = [];

    // Union of loaded tile footprints — reused as the now-plane extent.
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;

    // The loaded set mixes in the pinned z0–z1 storyboard-overview tiles,
    // whose world-spanning boxes would dwarf the city. The lattice tells the
    // streaming story at the zoom actually serving the viewport — the finest
    // level present.
    const latticeZ = latticeTiles.reduce((m, t) => Math.max(m, t.id.z), 0);
    const viewTiles = latticeTiles.filter((t) => t.id.z === latticeZ);

    if (viewTiles.length > 0) {
      const segments: { s: [number, number, number]; t: [number, number, number] }[] = [];
      for (const tile of viewTiles) {
        const { z, x, y } = tile.id;
        const n = 2 ** z;
        const lonW = (x / n) * 360 - 180;
        const lonE = ((x + 1) / n) * 360 - 180;
        const latN = tileLat(y, n);
        const latS = tileLat(y + 1, n);
        minLon = Math.min(minLon, lonW); maxLon = Math.max(maxLon, lonE);
        minLat = Math.min(minLat, latS); maxLat = Math.max(maxLat, latN);
        if (!showLattice) continue;
        const z0 = clampT(tile.timeRange.start) * timeHeightScale;
        const z1 = clampT(tile.timeRange.end) * timeHeightScale;
        const corners: [number, number][] = [
          [lonW, latS], [lonE, latS], [lonE, latN], [lonW, latN],
        ];
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          // Bottom edge, top edge, vertical pillar — 12 edges per box total.
          segments.push({ s: [a[0], a[1], z0], t: [b[0], b[1], z0] });
          segments.push({ s: [a[0], a[1], z1], t: [b[0], b[1], z1] });
          segments.push({ s: [a[0], a[1], z0], t: [a[0], a[1], z1] });
        }
      }
      if (segments.length > 0) {
        out.push(
          new LineLayer({
            id: "stt-tile-lattice",
            data: segments,
            getSourcePosition: (d: any) => d.s,
            getTargetPosition: (d: any) => d.t,
            getColor: [31, 186, 214, 100],
            getWidth: 1,
            widthUnits: "pixels",
            pickable: false,
          }),
        );
      }
    }
    if (minLon > maxLon) {
      // No tiles yet — seed the plane around the camera target.
      const { longitude, latitude } = selectedDataset.initialViewState;
      minLon = longitude - 0.25; maxLon = longitude + 0.25;
      minLat = latitude - 0.2; maxLat = latitude + 0.2;
    }

    if (timeHeight.nowPlane !== false) {
      const zNow = clampT(currentTime) * timeHeightScale;
      const plane = [
        [minLon, minLat, zNow],
        [maxLon, minLat, zNow],
        [maxLon, maxLat, zNow],
        [minLon, maxLat, zNow],
      ];
      out.push(
        new SolidPolygonLayer({
          id: "cube-now-plane",
          data: [plane],
          getPolygon: (d: any) => d,
          filled: true,
          getFillColor: [31, 186, 214, 22],
          pickable: false,
          // The plane is a reference surface — it must tint, not occlude, the
          // threads it intersects.
          parameters: { depthWriteEnabled: false } as any,
        }),
      );
    }
    return out;
  }, [
    selectedDataset,
    timeHeight,
    timeHeightScale,
    latticeTiles,
    showLattice,
    currentTime,
    rangeDurationMs,
  ]);

  const views = useMemo(
    () =>
      useGlobe ? [new GlobeView({ id: "globe", resolution: 10 })] : undefined,
    [useGlobe],
  );
  const initialViewState = useMemo((): any => {
    if (useGlobe) return { globe: selectedDataset.initialViewState };
    // maxPitch is a MapState view-state constraint (not a controller option):
    // cube demos want to look down the time axis from above the 60° default.
    return selectedDataset.timeHeight
      ? {
          ...selectedDataset.initialViewState,
          maxPitch: selectedDataset.timeHeight.maxPitch ?? 85,
        }
      : selectedDataset.initialViewState;
  }, [selectedDataset, useGlobe]);

  // Slow globe auto-rotation. When a dataset opts in (useGlobe + autoRotate) we
  // take over the view state so a requestAnimationFrame loop can nudge the
  // longitude each frame. As soon as the user interacts (drag/zoom fires
  // onViewStateChange) we stop the spin for good and hand the globe over — the
  // demo is for exploring, so it shouldn't keep spinning out from under a click.
  // Non-rotating demos keep the uncontrolled `initialViewState` path untouched.
  const autoRotate = useGlobe && (selectedDataset.autoRotate ?? false);
  const [viewState, setViewState] = useState<any>(null);
  const rotateStoppedRef = useRef(false);
  useEffect(() => {
    setViewState(initialViewState);
    rotateStoppedRef.current = false;
  }, [initialViewState]);
  useEffect(() => {
    if (!autoRotate) return;
    let raf = 0;
    let last: number | null = null;
    // Negative spins east→west (wind-following); very slow (~6 min/revolution).
    const DEG_PER_SEC = -1;
    const step = (now: number) => {
      if (rotateStoppedRef.current) return; // user took over — stop spinning
      const dt = last == null ? 0 : (now - last) / 1000;
      last = now;
      setViewState((vs: any) => {
        const cur = vs?.globe ?? vs;
        if (!cur) return vs;
        const longitude = ((cur.longitude + DEG_PER_SEC * dt + 540) % 360) - 180;
        return { globe: { ...cur, longitude } };
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate]);

  return (
    <div className="w-full h-full map-viewport">
      <DeckGL
        {...(autoRotate
          ? {
              viewState: viewState ?? initialViewState,
              onViewStateChange: (e: any) => {
                rotateStoppedRef.current = true;
                setViewState({ globe: e.viewState });
              },
            }
          : { initialViewState })}
        controller={interactive}
        layers={cubeLayers.length > 0 ? [...layers, ...cubeLayers] : layers}
        views={views}
        parameters={useGlobe ? ({ cull: true } as any) : undefined}
      >
        {!useGlobe && (
          <Map
            reuseMaps
            mapStyle="mapbox://styles/mapbox/dark-v11"
            mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
            projection={{ name: "mercator" }}
            terrain={
              selectedDataset.use3D
                ? { source: "mapbox-dem", exaggeration: 1.5 }
                : undefined
            }
            onLoad={(evt) => {
              const map = evt.target;
              if (selectedDataset.use3D && !map.getSource("mapbox-dem")) {
                map.addSource("mapbox-dem", {
                  type: "raster-dem",
                  url: "mapbox://mapbox.mapbox-terrain-dem-v1",
                  tileSize: 512,
                  maxzoom: 14,
                });
              }
            }}
          />
        )}
      </DeckGL>

      {/* Legend */}
      {selectedDataset.legend && (
        <div className="absolute bottom-3 right-3">
          <Legend legend={selectedDataset.legend} />
        </div>
      )}

      {/* Space-time cube controls: squash slider + tile-lattice toggle. */}
      {timeHeight && (
        <div className="absolute top-3 left-3">
          <CubeControls
            heightFactor={heightFactor}
            onHeightFactor={setHeightFactor}
            showLattice={showLattice}
            onShowLattice={
              timeHeight.tileLattice !== false ? setShowLattice : undefined
            }
          />
        </div>
      )}

      {/* Summary-tier weight toggle (pickup ↔ dropoff style). */}
      {summaryToggleOptions && summaryToggleOptions.length > 1 && (
        <div className="absolute top-3 left-3">
          <SummaryToggle
            options={summaryToggleOptions}
            value={activeSummaryToggle?.id}
            onChange={setSummaryToggleId}
          />
        </div>
      )}

      {/* Perf HUD (collapsed chip; top-right because the Legend owns the
          bottom-right corner). Carries the storyboard-preload outcome. */}
      {showPerfHud && (
        <PerformanceMonitor anchor="top-right" overviewPreload={overviewPreload} />
      )}
    </div>
  );
};

export default DemoViewer;

/**
 * Space-time-cube control chip: the "squash" slider morphs between the flat
 * map (0) and the full time-as-height cube (1) — it drives one shader
 * uniform, so dragging it is free. The lattice checkbox toggles the
 * loaded-STT-tile wireframe overlay.
 */
const CubeControls: React.FC<{
  heightFactor: number;
  onHeightFactor: (f: number) => void;
  showLattice: boolean;
  onShowLattice?: (show: boolean) => void;
}> = ({ heightFactor, onHeightFactor, showLattice, onShowLattice }) => {
  return (
    <div
      className="rounded px-3 py-2 flex flex-col gap-1.5"
      style={{
        background: "rgba(36, 39, 48, 0.95)",
        border: "1px solid #3A414C",
        minWidth: 170,
      }}
    >
      <div
        className="text-[10px] font-semibold tracking-widest"
        style={{ color: "#A0A7B4" }}
      >
        TIME = HEIGHT
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px]" style={{ color: "#6B7280" }}>
          flat
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(heightFactor * 100)}
          onChange={(e) => onHeightFactor(Number(e.target.value) / 100)}
          className="flex-1"
          style={{ accentColor: "#1FBAD6" }}
          aria-label="Time-as-height squash factor"
        />
        <span className="text-[10px]" style={{ color: "#6B7280" }}>
          cube
        </span>
      </div>
      {onShowLattice && (
        <label
          className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none"
          style={{ color: "#A0A7B4" }}
        >
          <input
            type="checkbox"
            checked={showLattice}
            onChange={(e) => onShowLattice(e.target.checked)}
            style={{ accentColor: "#1FBAD6" }}
          />
          STT tile lattice
        </label>
      )}
    </div>
  );
};

/**
 * Pickup/dropoff segmented control for summary-tier demos. Sits above the
 * map and swaps the H3SummaryLayer's weight column + ramp in place. Coloured
 * dots come from the first entry of each option's legendColors so the active
 * option visually matches the legend ramp on the opposite corner.
 */
const SummaryToggle: React.FC<{
  options: SummaryToggleOption[];
  value: string | undefined;
  onChange: (next: string) => void;
}> = ({ options, value, onChange }) => {
  return (
    <div
      className="inline-flex items-center rounded overflow-hidden"
      style={{ background: "rgba(36, 39, 48, 0.95)", border: "1px solid #3A414C" }}
      role="group"
      aria-label="Summary weight"
    >
      {options.map((opt, i) => {
        const active = opt.id === value;
        const swatch =
          opt.legendColors?.[opt.legendColors.length - 2] ??
          opt.legendColors?.[opt.legendColors.length - 1] ??
          "#1FBAD6";
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className="px-3 py-1.5 text-xs transition-colors flex items-center gap-1.5"
            style={{
              background: active ? "#1FBAD6" : "transparent",
              color: active ? "#000" : "#A0A7B4",
              borderRight:
                i < options.length - 1 ? "1px solid #3A414C" : undefined,
            }}
            aria-pressed={active}
          >
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: swatch }}
            />
            <span className="font-semibold leading-tight">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
};
