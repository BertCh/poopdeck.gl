import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from "react";
import { useParams, Navigate } from "react-router-dom";
import DeckGL from "@deck.gl/react";
import { _GlobeView as GlobeView } from "@deck.gl/core";
import { SolidPolygonLayer, PathLayer } from "@deck.gl/layers";
import { TileLayer } from "@deck.gl/geo-layers";
import { Map } from "react-map-gl";
import {
  AnimatedPointLayer,
  AnimatedPathLayer,
  AnimatedTripsLayer,
  AnimatedPolygonLayer,
  HeatmapTimeLayer,
  H3SummaryLayer,
  TimeController,
} from "@stt/deck.gl";
import { getDatasetById } from "../datasets";
import { calculateAnimationSpeed } from "../types";
import Legend from "../components/Legend";
import TimeControls from "../components/TimeControls";
import PerformanceMonitor from "../components/PerformanceMonitor";
import CodePanel from "../components/CodePanel";
import MaplibreRenderer from "../components/MaplibreRenderer";
import { getCodeExample } from "../codeExamples";

/**
 * Which renderer is in use. Both share the same `TimeController` so a play /
 * seek / speed change in the bottom bar drives whichever viewport is mounted.
 * Switching renderers tears the old viewport down (so we don't keep an idle
 * WebGL context around) and mounts the other one fresh.
 */
type RendererKind = "deck" | "maplibre";

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
  const [bottomPanelExpanded, setBottomPanelExpanded] = useState(false);
  const [showTileBoundaries, setShowTileBoundaries] = useState(false);
  const [renderer, setRenderer] = useState<RendererKind>("deck");

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

  const layers = useMemo(() => {
    if (!selectedDataset) return [];
    const datasetDuration =
      selectedDataset.timeRange.end - selectedDataset.timeRange.start;
    const playbackSpeed =
      datasetDuration / (selectedDataset.targetPlaybackSeconds || 60) / 1000;
    const timeWindow = selectedDataset.timeWindow || 86400000;

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
      opacity: 0.8,
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
            radius: selectedDataset.radiusProperty || 1000,
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
          }),
        ];
      case "trips": {
        const tripsLayer = new AnimatedTripsLayer({
          ...baseProps,
          // useGlobe / useGlobalBounds / zoomOverride let a dataset opt into
          // a global tile load without bespoke per-id branching here.
          ...(selectedDataset.zoomOverride !== undefined && {
            zoomOverride: selectedDataset.zoomOverride,
          }),
          ...(selectedDataset.useGlobalBounds && { useGlobalBounds: true }),
          tripColor: selectedDataset.tripColor ?? [31, 186, 214, 255],
          tripWidth: selectedDataset.tripWidth ?? 4,
          widthMinPixels: selectedDataset.widthMinPixels ?? 2,
          widthMaxPixels: selectedDataset.widthMaxPixels ?? 8,
          trailLength: selectedDataset.trailLength ?? 60000,
          fadeTrail: selectedDataset.fadeTrail ?? true,
          // Rounded caps/joints are the dominant fragment-shader cost at small
          // widths; default off and let datasets opt in.
          capRounded: selectedDataset.capRounded ?? false,
          jointRounded: selectedDataset.jointRounded ?? false,
        });
        if (selectedDataset.useGlobe) {
          return [
            new SolidPolygonLayer({
              id: "earth-background",
              data: EARTH_POLYGON,
              getPolygon: (d) => d as any,
              stroked: false,
              filled: true,
              getFillColor: [36, 39, 48, 255],
            }),
            tripsLayer,
          ];
        }
        return [tripsLayer];
      }
      case "heatmap":
        if (
          selectedDataset.heatmapLayers &&
          selectedDataset.heatmapLayers.length > 0
        ) {
          return selectedDataset.heatmapLayers.map(
            (spec) =>
              new HeatmapTimeLayer({
                ...baseProps,
                id: `${selectedDataset.id}-${spec.id}`,
                radiusPixels: spec.radiusPixels ?? 30,
                intensity: spec.intensity ?? 1,
                colorRange: spec.colorRange,
                weightProperty:
                  spec.weightProperty ?? selectedDataset.weightProperty,
                categoryFilter: spec.categoryFilter,
                colorDomain: spec.colorDomain ?? null,
                debounceTimeout: spec.debounceTimeout ?? 1000,
              }),
          );
        }
        return [
          new HeatmapTimeLayer({
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
          }),
        ];
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
      case "summary":
        return [
          new H3SummaryLayer({
            id: selectedDataset.id,
            data: selectedDataset.url,
            currentTime: selectedDataset.timeRange.start,
            timeController,
            timeWindow,
            weightProperty: selectedDataset.summaryWeightProperty ?? "count",
            colorRange: selectedDataset.summaryColorRange,
            colorDomain: selectedDataset.summaryColorDomain,
            extruded: selectedDataset.summaryExtruded ?? false,
            elevationScale: selectedDataset.summaryElevationScale ?? 1,
            coverage: selectedDataset.summaryCoverage ?? 0.92,
            opacity: 0.85,
            pickable: false,
          }),
        ];
      default:
        return [];
    }
    // `currentTime` is deliberately NOT in the dependency list: the layer
    // pulls live time from the shared TimeController on every draw, and
    // including currentTime here rebuilt the prop tree every tick (60Hz),
    // which forced deck.gl to invalidate the trip consolidation cache and
    // re-copy ~10M vertex positions per frame on the NYC taxi dataset.
  }, [selectedDataset, timeController]);

  // Debug tile boundary layer
  const tileBoundaryLayer = useMemo(() => {
    if (!showTileBoundaries) return null;

    return new TileLayer({
      id: "tile-boundaries",
      // Use same tile scheme as typical web maps
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      renderSubLayers: (props: any) => {
        const { tile } = props;
        const { x, y, z } = tile.index;
        const { west, south, east, north } = tile.bbox;

        // Create a path around the tile boundary
        const boundary = [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
          [west, north], // Close the loop
        ];

        return new PathLayer({
          id: `tile-boundary-${z}-${x}-${y}`,
          data: [{ path: boundary, tile: `${z}/${x}/${y}` }],
          getPath: (d: any) => d.path,
          getColor: [255, 255, 255, 100], // Thin white with transparency
          getWidth: 1,
          widthUnits: "pixels",
          widthMinPixels: 1,
          widthMaxPixels: 1,
          pickable: false,
        });
      },
    });
  }, [showTileBoundaries]);

  // Compose the final layer array. Memoized so deck.gl sees a stable array
  // reference across React re-renders (when `layers` and the optional tile
  // boundary overlay are unchanged). Without this the inline
  // `[...layers, tileBoundaryLayer].filter(Boolean)` in JSX allocated a new
  // array every render and forced deck.gl to re-run layer matching every tick.
  const composedLayers = useMemo(
    () => [...layers, tileBoundaryLayer].filter(Boolean),
    [layers, tileBoundaryLayer],
  );

  const useGlobe = selectedDataset?.useGlobe ?? false;
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

  if (!selectedDataset) return <Navigate to="/" replace />;

  const codeExample = getCodeExample(selectedDataset.type, selectedDataset.id);

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: "#242730" }}
    >
      {/* Header */}
      <div
        className="shrink-0 px-4 py-3 border-b flex items-center justify-between gap-4"
        style={{ background: "#29323C", borderColor: "#3A414C" }}
      >
        <div>
          <h1 className="text-sm font-semibold" style={{ color: "#FFFFFF" }}>
            {selectedDataset.name}
            <span
              className="ml-2 font-normal text-xs"
              style={{ color: "#1FBAD6" }}
            >
              · {renderer === "deck" ? "@stt/deck.gl" : "@stt/maplibre"}
            </span>
          </h1>
          <p className="text-xs mt-0.5" style={{ color: "#6A7485" }}>
            {selectedDataset.description}
          </p>
        </div>
        <RendererToggle value={renderer} onChange={setRenderer} />
      </div>

      {/* Map Viewport */}
      <div className="flex-1 min-h-0 p-2 lg:p-3">
        <div
          className="w-full h-full rounded overflow-hidden map-viewport"
          style={{ border: "1px solid #3A414C" }}
        >
          {renderer === "deck" ? (
            <DeckGL
              initialViewState={initialViewState}
              controller={true}
              layers={composedLayers}
              views={views}
              parameters={useGlobe ? ({ cull: true } as any) : undefined}
            >
              {!selectedDataset.useGlobe && (
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
          ) : (
            // `key` forces a remount when the dataset changes so MapLibre's
            // internal state (style, tile cache, viewport) doesn't try to
            // straddle two unrelated archives.
            <MaplibreRenderer
              key={selectedDataset.id}
              dataset={selectedDataset}
              timeController={timeController}
            />
          )}

          {/* Legend */}
          {selectedDataset.legend && (
            <div className="absolute bottom-3 right-3">
              <Legend legend={selectedDataset.legend} />
            </div>
          )}

          {/* Debug Controls (deck.gl only — the MapLibre adapter doesn't draw
              tile boundaries; users can inspect bounds via the native style). */}
          {renderer === "deck" && (
            <div className="absolute top-3 right-3 flex flex-col gap-2">
              <button
                onClick={() => setShowTileBoundaries(!showTileBoundaries)}
                className="px-3 py-1.5 text-xs rounded transition-colors"
                style={{
                  background: showTileBoundaries ? "#1FBAD6" : "#29323C",
                  color: showTileBoundaries ? "#000" : "#fff",
                  border: "1px solid #3A414C",
                }}
              >
                {showTileBoundaries ? "🔲 Tiles ON" : "🔲 Tiles"}
              </button>
            </div>
          )}

          {/* Performance Monitor */}
          <PerformanceMonitor visible={true} />
        </div>
      </div>

      {/* Bottom Controls */}
      <div
        className="shrink-0 border-t"
        style={{ background: "#29323C", borderColor: "#3A414C" }}
      >
        <div className="px-4 py-3">
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

        {/* Code Toggle */}
        <button
          onClick={() => setBottomPanelExpanded(!bottomPanelExpanded)}
          className="w-full flex items-center justify-between px-4 py-2 border-t transition-colors"
          style={{ borderColor: "#3A414C", color: "#6A7485" }}
          onMouseOver={(e) => (e.currentTarget.style.background = "#242730")}
          onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <div className="flex items-center gap-2">
            <span style={{ color: "#1FBAD6" }}>{"</>"}</span>
            <span className="text-xs">
              {bottomPanelExpanded ? "Hide Code" : "View Code Example"}
            </span>
          </div>
          <span
            className={`text-xs transition-transform ${bottomPanelExpanded ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>

        {bottomPanelExpanded && (
          <div className="h-40 border-t" style={{ borderColor: "#3A414C" }}>
            <CodePanel code={codeExample} />
          </div>
        )}
      </div>
    </div>
  );
};

export default DemoPage;

/**
 * Small segmented control for swapping between the deck.gl and `@stt/maplibre`
 * renderers. Kept inline here because it has no other consumer.
 */
const RendererToggle: React.FC<{
  value: RendererKind;
  onChange: (next: RendererKind) => void;
}> = ({ value, onChange }) => {
  const items: Array<{ id: RendererKind; label: string; sub: string }> = [
    { id: "deck", label: "deck.gl", sub: "@stt/deck.gl" },
    { id: "maplibre", label: "MapLibre", sub: "@stt/maplibre" },
  ];
  return (
    <div
      className="inline-flex items-center rounded overflow-hidden"
      style={{ background: "#242730", border: "1px solid #3A414C" }}
      role="group"
      aria-label="Renderer"
    >
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className="px-3 py-1.5 text-xs transition-colors flex flex-col items-start"
            style={{
              background: active ? "#1FBAD6" : "transparent",
              color: active ? "#000" : "#A0A7B4",
              minWidth: 100,
              borderRight: it.id === "deck" ? "1px solid #3A414C" : undefined,
            }}
            aria-pressed={active}
          >
            <span className="font-semibold leading-tight">{it.label}</span>
            <span
              className="text-[10px] leading-tight mt-0.5"
              style={{ color: active ? "#000" : "#6A7485" }}
            >
              {it.sub}
            </span>
          </button>
        );
      })}
    </div>
  );
};
