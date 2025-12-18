import React, { useState, useCallback, useMemo } from "react";
import DeckGL from "@deck.gl/react";
import { Map } from "react-map-gl";
import {
  AnimatedPointLayer,
  AnimatedPathLayer,
  AnimatedTripsLayer,
  AnimatedPolygonLayer,
  HeatmapTimeLayer,
  TimeController,
} from "@stt/deck.gl";
import { DATASETS, getDatasetById } from "./datasets";
import { calculateAnimationSpeed } from "./types";
import Sidebar from "./components/Sidebar";
import Legend from "./components/Legend";
import TimeControls from "./components/TimeControls";
import PerformanceMonitor from "./components/PerformanceMonitor";
import "./index.css";

const MAPBOX_ACCESS_TOKEN =
  (import.meta as any).env?.VITE_MAPBOX_TOKEN ||
  "pk.eyJ1IjoicmdjZ2VvZyIsImEiOiJjajBuNG1sMjUwMDFlMzNxcWY0M2RqMHI3In0.XfM0BMSqZqjRDcz-oJuadw";

function App() {
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>(
    "earthquake-activity"
  );

  const selectedDataset = useMemo(
    () => getDatasetById(selectedDatasetId),
    [selectedDatasetId]
  );

  // Calculate animation speed based on dataset for consistent playback
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Update time controller when dataset changes
  React.useEffect(() => {
    if (selectedDataset) {
      const newSpeed = calculateAnimationSpeed(selectedDataset);
      timeController.setTimeRange(selectedDataset.timeRange);
      timeController.setTime(selectedDataset.timeRange.start);
      timeController.setSpeed(newSpeed * speedMultiplier);
      timeController.pause();
      setIsPlaying(false);
      setSpeedMultiplier(1.0); // Reset speed multiplier when dataset changes
    }
  }, [selectedDataset, timeController]);

  // Subscribe to time updates
  React.useEffect(() => {
    const handleTimeUpdate = (time: number) => {
      setCurrentTime(time);
    };

    timeController.on("tick", handleTimeUpdate);

    return () => {
      timeController.off("tick", handleTimeUpdate);
    };
  }, [timeController]);

  const handleDatasetChange = useCallback((datasetId: string) => {
    setLoading(true);
    setError(null);
    setSelectedDatasetId(datasetId);

    // Simulate loading time
    setTimeout(() => {
      setLoading(false);
    }, 500);
  }, []);

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

  // Create appropriate layer based on dataset type
  // IMPORTANT: currentTime is NOT a dependency here!
  // The layer receives currentTime as a prop and handles time changes internally.
  // This prevents layer recreation on every animation frame.
  const layers = useMemo(() => {
    if (!selectedDataset) return [];

    // Calculate prefetch ahead time based on dataset duration and target playback
    // This ensures we prefetch tiles far enough ahead to cover animation speed
    const datasetDuration =
      selectedDataset.timeRange.end - selectedDataset.timeRange.start;
    const playbackSpeed =
      datasetDuration / (selectedDataset.targetPlaybackSeconds || 60) / 1000; // ms sim time per ms real time
    const timeWindow = selectedDataset.timeWindow || 86400000;

    // Calculate how many time windows we traverse per second of real time
    const timeWindowsPerSecond = (playbackSpeed / timeWindow) * 1000;

    // Prefetch enough steps to cover at least 30 seconds of real-time playback
    // More aggressive for fast-moving datasets with small time windows
    const minPrefetchSteps = Math.max(5, Math.ceil(timeWindowsPerSecond * 30));
    const prefetchSteps = Math.min(minPrefetchSteps, 50); // Cap at 50 to avoid excessive memory

    // Prefetch ahead should cover at least 10 seconds of real-time animation
    const prefetchAhead = Math.max(
      timeWindow * 2, // At least 2 time windows ahead per step
      playbackSpeed * 10000 // Or 10 seconds of real-time ahead
    );

    const baseProps = {
      id: selectedDataset.id,
      data: selectedDataset.url,
      currentTime,
      timeController,
      timeWindow, // Use dataset time window or default to 1 day
      timeRange: selectedDataset.timeRange, // Pass time range for precision handling
      opacity: 0.8,
      pickable: false,
      // Prefetch configuration - scale with animation speed
      enablePrefetch: true,
      prefetchAhead,
      prefetchSteps,
    };

    switch (selectedDataset.type) {
      case "point":
        return [
          new AnimatedPointLayer({
            ...baseProps,
            // Color can be a constant or categorical property name
            fillColor: selectedDataset.colorProperty || [255, 128, 0, 255],
            radius: selectedDataset.radiusProperty || 1000,
            radiusUnits: "meters",
            radiusScale: 2,
            // 3D support - pass through from dataset config
            use3D: selectedDataset.use3D,
            elevationProperty: selectedDataset.elevationProperty,
            elevationScale: selectedDataset.elevationScale,
            updateTriggers: {
              fillColor: selectedDataset.id,
              radius: selectedDataset.id,
            },
          }),
        ];

      case "path":
        return [
          new AnimatedPathLayer({
            ...baseProps,
            // Color can be a constant or categorical property name
            pathColor: selectedDataset.colorProperty || [0, 150, 255, 255],
            pathWidth: 3,
            widthUnits: "pixels",
            trail: true,
            trailLength: 5000,
            updateTriggers: {
              pathColor: selectedDataset.id,
              pathWidth: selectedDataset.id,
            },
          }),
        ];

      case "trips":
        return [
          new AnimatedTripsLayer({
            ...baseProps,
            tripColor: [253, 128, 93, 255], // Warm orange for taxi trips
            tripWidth: 4,
            widthMinPixels: 2,
            widthMaxPixels: 8,
            trailLength: 120000, // 2 minute trail
            fadeTrail: true,
            capRounded: true,
            jointRounded: true,
            updateTriggers: {
              tripColor: selectedDataset.id,
              tripWidth: selectedDataset.id,
            },
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
            // weightProperty is the name of a numeric property to use for weight
            weightProperty: selectedDataset.weightProperty,
            updateTriggers: {
              weightProperty: selectedDataset.id,
            },
          }),
        ];

      case "polygon":
        return [
          new AnimatedPolygonLayer({
            ...baseProps,
            filled: true,
            stroked: false, // Stroked requires separate PathLayer
            lineWidthUnits: "pixels",
            lineWidth: 2,
            lineColor: [255, 100, 0, 255],
            // fillColor can be a constant or categorical property name
            fillColor: selectedDataset.colorProperty || [255, 140, 0, 180],
            updateTriggers: {
              fillColor: selectedDataset.id,
              lineColor: selectedDataset.id,
            },
          }),
        ];

      default:
        return [];
    }
    // Note: currentTime is intentionally NOT a dependency here.
    // Layers subscribe to TimeController tick events directly for smooth animation
    // without triggering React re-renders on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDataset, timeController]);

  if (!selectedDataset) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="app">
      <DeckGL
        initialViewState={selectedDataset.initialViewState}
        controller={true}
        layers={layers}
        // getTooltip={({ object }) =>
        //   object && object.properties
        //     ? Object.entries(object.properties)
        //         .slice(0, 3)
        //         .map(([k, v]) => `${k}: ${v}`)
        //         .join("\n")
        //     : null
        // }
      >
        <Map
          reuseMaps
          mapStyle={
            // selectedDataset.use3D
            // ? "mapbox://styles/mapbox/standard"
            // :
            "mapbox://styles/mapbox/dark-v11"
          }
          mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
          projection={{ name: "mercator" }}
          terrain={
            selectedDataset.use3D
              ? { source: "mapbox-dem", exaggeration: 1.5 }
              : undefined
          }
          onLoad={(evt) => {
            const map = evt.target;
            // Add terrain source for 3D datasets
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
      </DeckGL>

      <Sidebar
        datasets={DATASETS}
        selectedDatasetId={selectedDatasetId}
        onDatasetChange={handleDatasetChange}
      />

      {selectedDataset.legend && <Legend legend={selectedDataset.legend} />}

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

      <PerformanceMonitor visible={true} />

      {loading && (
        <div className="loading">Loading {selectedDataset.name}...</div>
      )}

      {error && (
        <div className="error">
          <strong>Error:</strong> {error}
        </div>
      )}
    </div>
  );
}

export default App;
