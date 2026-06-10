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
  PlaybackGovernor,
  TimeController,
  VatTripsLayer,
} from "@stt/deck.gl";
import type {
  BufferSource,
  BufferedRunway,
  HeatmapChannelSpec,
  OverviewPreloadResult,
  PlaybackGovernorState,
} from "@stt/deck.gl";
import { getDatasetById } from "../datasets";
import { calculateAnimationSpeed, tileLoadingProps } from "../types";
import type { SummaryToggleOption } from "../types";
import Legend from "../components/Legend";
import PerformanceMonitor from "../components/PerformanceMonitor";
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
  const [autoSpeed, setAutoSpeed] = useState(false);

  // ── Playback governor (player-buffering WS-B) ──────────────────────────────
  // One governor per mounted demo, wrapping the shared TimeController: play /
  // pause / seek all route through it so playback gates on the tileset's
  // buffered runway (start gate, mid-playback stall, post-seek gate) instead
  // of advancing into unloaded time. The tileset arrives async via the
  // layer's onTilesetReady and is handed over with setSource below.
  //
  // The governor is created INSIDE an effect (not useState) so that React
  // StrictMode's dev-only mount→cleanup→remount cycle gets a fresh instance:
  // dispose() is terminal, and a useState-held instance would come back from
  // the simulated remount permanently dead (every call a silent no-op).
  // tilesetRef remembers the layer's one-shot onTilesetReady handover so a
  // governor created after it (or re-created by StrictMode) still gets the
  // source.
  const governorRef = useRef<PlaybackGovernor | null>(null);
  const tilesetRef = useRef<BufferSource | null>(null);
  const [governor, setGovernor] = useState<PlaybackGovernor | null>(null);
  useEffect(() => {
    const g = new PlaybackGovernor(timeController);
    governorRef.current = g;
    if (tilesetRef.current) g.setSource(tilesetRef.current);
    setGovernor(g);
    return () => {
      governorRef.current = null;
      g.dispose();
      setGovernor(null);
    };
  }, [timeController]);

  // Reflect the governor's machine state into React (state transitions are
  // rare — start/stall/seek — so no extra throttling is needed). When the
  // governor lands in 'idle' from an external pause (e.g. the clock clamping
  // at a range end) the play button must follow.
  const [bufferState, setBufferState] = useState<PlaybackGovernorState>("idle");
  useEffect(() => {
    if (!governor) return;
    setBufferState(governor.state);
    const onStateChange = (state: PlaybackGovernorState) => {
      setBufferState(state);
      if (state === "idle") setIsPlaying(false);
    };
    governor.on("statechange", onStateChange);
    return () => governor.off("statechange", onStateChange);
  }, [governor]);

  useEffect(() => {
    if (selectedDataset) {
      const newSpeed = calculateAnimationSpeed(selectedDataset);
      // Drop the previous dataset's tileset before resetting the clock — the
      // layer finalizes it during its own re-init, and the governor must not
      // query a finalized source. The new tileset re-attaches via
      // onTilesetReady.
      tilesetRef.current = null;
      governor?.requestPause();
      governor?.setSource(null);
      timeController.setTimeRange(selectedDataset.timeRange);
      timeController.setTime(selectedDataset.timeRange.start);
      timeController.setSpeed(newSpeed * speedMultiplier);
      setIsPlaying(false);
      setSpeedMultiplier(1.0);
      setAutoSpeed(false);
    }
  }, [selectedDataset, timeController, governor]);

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
    const g = governorRef.current;
    if (!g) return;
    if (isPlaying) {
      g.requestPause();
    } else {
      g.requestPlay();
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying]);

  // Committed seek (keyboard arrows, jump-to-start). Drag-scrubbing previews
  // talk to the governor directly inside TimeControls.
  const handleSeek = useCallback((time: number) => {
    governorRef.current?.seekTo(time);
  }, []);

  const handleSpeedChange = useCallback(
    (multiplier: number) => {
      setAutoSpeed(false); // an explicit choice always exits Auto mode
      setSpeedMultiplier(multiplier);
      timeController.setSpeed(baseAnimationSpeed * multiplier);
    },
    [timeController, baseAnimationSpeed],
  );

  // ── Opt-in Auto speed (player-buffering WS-D) ──────────────────────────────
  // While Auto is selected, apply the governor's sustainable-speed suggestion
  // on a slow cadence (5 s) with hysteresis (ignore <25% moves), snapped to
  // preset-like steps and clamped to [0.25×, max preset]. Auto NEVER touches a
  // user-chosen explicit speed — it's its own mode; picking any preset exits.
  const speedMultiplierRef = useRef(speedMultiplier);
  useEffect(() => {
    speedMultiplierRef.current = speedMultiplier;
  }, [speedMultiplier]);
  useEffect(() => {
    if (!autoSpeed || !governor) return;
    const AUTO_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const MAX_PRESET = 10; // top of the preset row
    const applySuggestion = () => {
      const suggestion = governor.getAutoSpeedSuggestion();
      if (suggestion == null) return; // unknown cost/throughput → hold current
      const raw = suggestion / baseAnimationSpeed;
      const clamped = Math.min(MAX_PRESET, Math.max(0.25, raw));
      const snapped = AUTO_STEPS.reduce((best, step) =>
        Math.abs(step - clamped) < Math.abs(best - clamped) ? step : best,
      );
      const prev = speedMultiplierRef.current;
      if (prev > 0 && Math.abs(snapped - prev) / prev <= 0.25) return; // hysteresis
      timeController.setSpeed(baseAnimationSpeed * snapped);
      setSpeedMultiplier(snapped);
    };
    applySuggestion();
    const intervalId = setInterval(applySuggestion, 5000);
    return () => clearInterval(intervalId);
  }, [autoSpeed, governor, baseAnimationSpeed, timeController]);

  const handleAutoSpeedSelect = useCallback(() => setAutoSpeed(true), []);

  // Governor plumbing for the STT layers: the tileset (the BufferSource)
  // arrives async after archive init; buffer-runway events route into the
  // governor for immediate gate/stall evaluation.
  const handleTilesetReady = useCallback((tileset: BufferSource) => {
    tilesetRef.current = tileset;
    governorRef.current?.setSource(tileset);
  }, []);
  const handleBufferChange = useCallback(
    (runway: BufferedRunway) => governorRef.current?.notifyBufferChange(runway),
    [],
  );

  // ── Storyboard preview tier (player-buffering WS-C4) ───────────────────────
  // The layer preloads + pins the coarsest tiles across the full time range
  // (budget-gated per dataset) so scrubbing always shows a coarse preview.
  // The outcome surfaces as a one-line stat in the perf HUD.
  const [overviewPreload, setOverviewPreload] =
    useState<OverviewPreloadResult | null>(null);
  const handleOverviewPreload = useCallback(
    (result: OverviewPreloadResult) => setOverviewPreload(result),
    [],
  );
  useEffect(() => {
    // A dataset switch re-inits the tileset; the stale outcome must not
    // describe the new dataset's storyboard.
    setOverviewPreload(null);
  }, [selectedDataset]);

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
  ]);

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

          {/* Perf HUD (collapsed chip; top-right because the Legend owns the
              bottom-right corner). Carries the storyboard-preload outcome. */}
          <PerformanceMonitor anchor="top-right" overviewPreload={overviewPreload} />
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
            bufferState={bufferState}
            governor={governor}
            onPlayPause={handlePlayPause}
            onSeek={handleSeek}
            onSpeedChange={handleSpeedChange}
            currentSpeedMultiplier={speedMultiplier}
            targetPlaybackSeconds={selectedDataset.targetPlaybackSeconds ?? 30}
            autoSpeed={autoSpeed}
            onAutoSpeedSelect={handleAutoSpeedSelect}
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
