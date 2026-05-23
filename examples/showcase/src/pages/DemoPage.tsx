import React, { useState, useCallback, useMemo, useEffect } from "react";
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
  TimeController,
} from "@stt/deck.gl";
import { getDatasetById } from "../datasets";
import { calculateAnimationSpeed } from "../types";
import Legend from "../components/Legend";
import TimeControls from "../components/TimeControls";
import PerformanceMonitor from "../components/PerformanceMonitor";
import CodePanel from "../components/CodePanel";
import { getCodeExample } from "../codeExamples";

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
    [datasetId]
  );
  const [bottomPanelExpanded, setBottomPanelExpanded] = useState(false);
  const [showTileBoundaries, setShowTileBoundaries] = useState(false);

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
      })
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

  useEffect(() => {
    const handleTimeUpdate = (time: number) => setCurrentTime(time);
    timeController.on("tick", handleTimeUpdate);
    return () => {
      timeController.off("tick", handleTimeUpdate);
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
    [timeController]
  );

  const handleSpeedChange = useCallback(
    (multiplier: number) => {
      setSpeedMultiplier(multiplier);
      timeController.setSpeed(baseAnimationSpeed * multiplier);
    },
    [timeController, baseAnimationSpeed]
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
      currentTime,
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
            radius: selectedDataset.radiusProperty || 1000,
            radiusUnits: "meters",
            radiusScale: 2,
            use3D: selectedDataset.use3D,
            elevationProperty: selectedDataset.elevationProperty,
            elevationScale: selectedDataset.elevationScale,
          }),
        ];
      case "path":
        return [
          new AnimatedPathLayer({
            ...baseProps,
            pathColor: selectedDataset.colorProperty || [31, 186, 214, 255],
            pathWidth: 3,
            widthUnits: "pixels",
          }),
        ];
      case "trips":
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
            new AnimatedTripsLayer({
              ...baseProps,
              zoomOverride: 0,
              useGlobalBounds: true,
              tripColor: [31, 186, 214, 255],
              tripWidth: 1.5,
              widthMinPixels: 1,
              widthMaxPixels: 3,
              trailLength: 1000,
              fadeTrail: true,
              capRounded: false,
              jointRounded: false,
            }),
          ];
        }
        if (selectedDataset.id === "satellite-trips-flat") {
          return [
            new AnimatedTripsLayer({
              ...baseProps,
              zoomOverride: 0,
              useGlobalBounds: true,
              tripColor: [31, 186, 214, 255],
              tripWidth: 1.5,
              widthMinPixels: 1,
              widthMaxPixels: 3,
              trailLength: 300000,
              fadeTrail: true,
              capRounded: false,
              jointRounded: false,
            }),
          ];
        }
        return [
          new AnimatedTripsLayer({
            ...baseProps,
            tripColor: [31, 186, 214, 255],
            tripWidth: 4,
            widthMinPixels: 2,
            widthMaxPixels: 8,
            trailLength: 60000,
            fadeTrail: true,
            capRounded: true,
            jointRounded: true,
          }),
        ];
      case "heatmap":
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
            filled: true,
            stroked: false,
            lineWidthUnits: "pixels",
            lineWidth: 2,
            lineColor: [31, 186, 214, 255],
            fillColor: selectedDataset.colorProperty || [31, 186, 214, 180],
          }),
        ];
      default:
        return [];
    }
  }, [selectedDataset, currentTime, timeController]);

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

  const useGlobe = selectedDataset?.useGlobe ?? false;
  const views = useMemo(
    () =>
      useGlobe ? [new GlobeView({ id: "globe", resolution: 10 })] : undefined,
    [useGlobe]
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
        className="shrink-0 px-4 py-3 border-b flex items-center justify-between"
        style={{ background: "#29323C", borderColor: "#3A414C" }}
      >
        <div>
          <h1 className="text-sm font-semibold" style={{ color: "#FFFFFF" }}>
            {selectedDataset.name}
          </h1>
          <p className="text-xs mt-0.5" style={{ color: "#6A7485" }}>
            {selectedDataset.description}
          </p>
        </div>
      </div>

      {/* Map Viewport */}
      <div className="flex-1 min-h-0 p-2 lg:p-3">
        <div
          className="w-full h-full rounded overflow-hidden map-viewport"
          style={{ border: "1px solid #3A414C" }}
        >
          <DeckGL
            initialViewState={initialViewState}
            controller={true}
            layers={[...layers, tileBoundaryLayer].filter(Boolean)}
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

          {/* Legend */}
          {selectedDataset.legend && (
            <div className="absolute bottom-3 right-3">
              <Legend legend={selectedDataset.legend} />
            </div>
          )}

          {/* Debug Controls */}
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
