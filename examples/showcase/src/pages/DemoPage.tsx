import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from "react";
import { useParams, Navigate, Link } from "react-router-dom";
import DeckGL from "@deck.gl/react";
import { _GlobeView as GlobeView } from "@deck.gl/core";
import { SolidPolygonLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl";
import {
  AnimatedPointLayer,
  AnimatedPathLayer,
  AnimatedTripsLayer,
  AnimatedPolygonLayer,
  HeatmapLayer,
  H3SummaryLayer,
  TimeController,
  VatTripsLayer,
} from "@stt/deck.gl";
import type { HeatmapChannelSpec } from "@stt/deck.gl";
import { getDatasetById } from "../datasets";
import { calculateAnimationSpeed } from "../types";
import type { SummaryToggleOption } from "../types";
import Legend from "../components/Legend";
import TimeControls from "../components/TimeControls";

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

const DemoPage: React.FC = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const selectedDataset = useMemo(
    () => getDatasetById(datasetId || ""),
    [datasetId],
  );

  // Active option for summary-tier weight toggles (e.g. pickup vs dropoff).
  // Reset to the dataset's first option whenever the dataset changes.
  const summaryToggleOptions = selectedDataset?.summaryToggleWeights;
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

  const baseAnimationSpeed = useMemo(() => {
    if (!selectedDataset) return 1000;
    return calculateAnimationSpeed(selectedDataset);
  }, [selectedDataset]);

  const [timeController] = useState(
    () =>
      new TimeController({
        initialTime:
          selectedDataset?.timeRange.start || Date.parse("2020-01-01"),
        speed: baseAnimationSpeed,
        loop: true,
        timeRange: selectedDataset?.timeRange,
      }),
  );

  const [currentTime, setCurrentTime] = useState(timeController.getTime());
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState(1.0);

  useEffect(() => {
    if (selectedDataset) {
      const newSpeed = calculateAnimationSpeed(selectedDataset);
      timeController.setTimeRange(selectedDataset.timeRange);
      timeController.setTime(selectedDataset.timeRange.start);
      timeController.setSpeed(newSpeed * speedMultiplier);
      timeController.pause();
      setIsPlaying(false);
      setSpeedMultiplier(1.0);
    }
  }, [selectedDataset, timeController]);

  // Throttle the React `currentTime` state update during playback. The
  // TimeController ticks once per rAF (60Hz); the deck.gl layer reads time
  // directly from the controller via a getter in TimeFilterExtension.draw(),
  // so this React state is ONLY used to repaint the time slider and the
  // displayed-time label. Updating those at 60Hz forces a full DemoPage
  // re-render every frame, which made deck.gl receive a fresh `layers`
  // array prop on every tick and rerun layer matching + updateState on
  // every visible sublayer. 20Hz is visually indistinguishable for the
  // UI and cuts React/deck.gl prop-diff work to a third.
  const lastUiTickRef = useRef(0);
  useEffect(() => {
    lastUiTickRef.current = 0;
    const handleTimeUpdate = (time: number) => {
      const now = performance.now();
      if (now - lastUiTickRef.current < 50) return;
      lastUiTickRef.current = now;
      setCurrentTime(time);
    };
    // Subscribe to play-state as well so the slider snaps to the final time
    // when playback stops (the throttled tick may have skipped the last update).
    const handlePlayState = (playing: boolean) => {
      if (!playing) {
        lastUiTickRef.current = 0;
        setCurrentTime(timeController.getTime());
      }
    };
    timeController.on("tick", handleTimeUpdate);
    timeController.on("playState", handlePlayState);
    return () => {
      timeController.off("tick", handleTimeUpdate);
      timeController.off("playState", handlePlayState);
    };
  }, [timeController]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      timeController.pause();
    } else {
      timeController.play();
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying, timeController]);

  const handleSeek = useCallback(
    (time: number) => {
      timeController.setTime(time);
    },
    [timeController],
  );

  const handleSpeedChange = useCallback(
    (multiplier: number) => {
      setSpeedMultiplier(multiplier);
      timeController.setSpeed(baseAnimationSpeed * multiplier);
    },
    [timeController, baseAnimationSpeed],
  );

  // Projection follows the dataset's tuned default (no user toggle in the
  // shipped UI). Globe-default demos (e.g. ocean currents) stay on the globe.
  const useGlobe = selectedDataset?.useGlobe ?? false;

  const layers = useMemo(() => {
    if (!selectedDataset) return [];
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

    // Prefetch budget keyed to REAL-time playback, not sim-time. We want a
    // few seconds of real-time buffer ahead of the play head, regardless of
    // how compressed sim-time is. `playbackSpeed` is sim-ms per real-ms, so
    // `playbackSpeed * PREFETCH_REAL_SECONDS * 1000` is that many real seconds
    // expressed in sim-time.
    //
    // The old math asked for max(5*timeWindow, playbackSpeed*60000) and up to
    // 150 steps. For ship-traffic that produced ~8h of lookahead × 150 steps
    // ≈ 50 days of prefetch horizon per tick — every tick blew through the
    // bucket-boundary cap and queued thousands of fetches, collapsing FPS to
    // 0.5 under SwiftShader.
    const PREFETCH_REAL_SECONDS = 5;
    const prefetchAhead = Math.max(
      timeWindow,
      playbackSpeed * 1000 * PREFETCH_REAL_SECONDS,
    );
    const prefetchSteps = 4;

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
      enablePrefetch: true,
      prefetchAhead,
      prefetchSteps,
      // Browsers cap to ~6 concurrent connections per HTTP/1.1 origin; asking
      // for more just queues inside the network layer and deepens the decode
      // backlog on the main thread. 12 is enough for HTTP/2 multiplexing too.
      maxRequests: 12,
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
        const tripsLayer = new AnimatedTripsLayer({
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
  }, [selectedDataset, timeController, activeSummaryToggle, useGlobe]);

  const views = useMemo(
    () =>
      useGlobe ? [new GlobeView({ id: "globe", resolution: 10 })] : undefined,
    [useGlobe],
  );
  const initialViewState = useMemo((): any => {
    if (!selectedDataset) return undefined;
    return useGlobe
      ? { globe: selectedDataset.initialViewState }
      : selectedDataset.initialViewState;
  }, [selectedDataset, useGlobe]);

  // Slow globe auto-rotation. When a dataset opts in (useGlobe + autoRotate) we
  // take over the view state so a requestAnimationFrame loop can nudge the
  // longitude each frame. As soon as the user interacts (drag/zoom fires
  // onViewStateChange) we stop the spin for good and hand the globe over — the
  // demo is for exploring, so it shouldn't keep spinning out from under a click.
  // Non-rotating demos keep the uncontrolled `initialViewState` path untouched.
  const autoRotate = useGlobe && (selectedDataset?.autoRotate ?? false);
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

  if (!selectedDataset) return <Navigate to="/" replace />;

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: "var(--page-bg)" }}
    >
      {/* Header */}
      <div
        className="shrink-0 px-5 py-4"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        {/* Back to the curated grid — the only nav home when the sidebar is
            hidden in production. */}
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-xs mb-2 transition-colors"
          style={{ color: "var(--ink-500)" }}
          onMouseOver={(e) => (e.currentTarget.style.color = "var(--accent)")}
          onMouseOut={(e) => (e.currentTarget.style.color = "var(--ink-500)")}
        >
          <span>←</span> Overview
        </Link>
        <h1
          className="font-display text-base font-semibold leading-tight"
          style={{ color: "var(--ink-900)" }}
        >
          {selectedDataset.name}
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--ink-500)" }}>
          {selectedDataset.description}
        </p>
      </div>

      {/* Map Viewport */}
      <div className="flex-1 min-h-0 p-3 lg:p-5">
        <div className="w-full h-full rounded-lg overflow-hidden map-viewport">
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
            controller={true}
            layers={layers}
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
        </div>
      </div>

      {/* Bottom Controls */}
      <div
        className="shrink-0"
        style={{ background: "var(--surface)", borderTop: "1px solid var(--hairline)" }}
      >
        <div className="px-5 py-3">
          <TimeControls
            currentTime={currentTime}
            timeRange={selectedDataset.timeRange}
            isPlaying={isPlaying}
            onPlayPause={handlePlayPause}
            onSeek={handleSeek}
            onSpeedChange={handleSpeedChange}
            currentSpeedMultiplier={speedMultiplier}
            targetPlaybackSeconds={selectedDataset.targetPlaybackSeconds ?? 30}
          />
        </div>
      </div>
    </div>
  );
};

export default DemoPage;

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
