import React, { useState, useCallback, useMemo } from "react";
import DeckGL from "@deck.gl/react";
import { Map } from "react-map-gl";
import {
  AnimatedPointLayer,
  AnimatedPathLayer,
  HeatmapTimeLayer,
  TimeController,
} from "@stt/deck.gl";
import { DATASETS, getDatasetById } from "./datasets";
import Sidebar from "./components/Sidebar";
import Legend from "./components/Legend";
import TimeControls from "./components/TimeControls";
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

  const [timeController] = useState(
    () =>
      new TimeController({
        initialTime:
          selectedDataset?.timeRange.start || Date.parse("2020-01-01"),
        speed: selectedDataset?.animationSpeed || 86400000, // Use dataset speed or default
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
      timeController.setTimeRange(selectedDataset.timeRange);
      timeController.setTime(selectedDataset.timeRange.start);
      timeController.setSpeed(
        (selectedDataset.animationSpeed || 86400000) * speedMultiplier
      ); // Use dataset speed with multiplier
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
      const baseSpeed = selectedDataset?.animationSpeed || 86400000;
      timeController.setSpeed(baseSpeed * multiplier);
    },
    [timeController, selectedDataset]
  );

  // Create appropriate layer based on dataset type
  const layers = useMemo(() => {
    if (!selectedDataset) return [];

    const baseProps = {
      id: selectedDataset.id,
      data: selectedDataset.url,
      currentTime,
      timeController,
      timeWindow: selectedDataset.timeWindow || 86400000, // Use dataset time window or default to 1 day
      timeRange: selectedDataset.timeRange, // Pass time range for precision handling
      opacity: 0.8,
      pickable: true,
    };

    switch (selectedDataset.type) {
      case "point":
        // Check dataset type
        const isEarthquakeData = selectedDataset.id === "earthquake-activity";
        const isShipData = selectedDataset.id === "ship-traffic";

        return [
          new AnimatedPointLayer({
            ...baseProps,
            getFillColor: (d: any) => {
              if (isEarthquakeData) {
                // Color by earthquake magnitude (4.0 - 9.0)
                const magnitude =
                  d.properties.magnitude || d.properties.value || 0;
                if (magnitude < 5.0) return [255, 237, 160, 200]; // Yellow
                if (magnitude < 6.0) return [254, 178, 76, 200]; // Orange
                if (magnitude < 7.0) return [252, 78, 42, 200]; // Red-Orange
                if (magnitude < 8.0) return [227, 26, 28, 200]; // Red
                return [128, 0, 38, 200]; // Dark Red
              } else if (isShipData) {
                // Color by vessel type (real AIS data from NOAA)
                const vesselType = d.properties.vessel_type || "other";
                switch (vesselType) {
                  case "cargo":
                    return [74, 144, 226, 200]; // Blue
                  case "tanker":
                    return [245, 166, 35, 200]; // Orange
                  case "passenger":
                    return [80, 227, 194, 200]; // Teal
                  case "fishing":
                    return [184, 233, 134, 200]; // Green
                  case "towing":
                    return [155, 89, 182, 200]; // Purple
                  case "special":
                    return [241, 196, 15, 200]; // Yellow
                  default:
                    return [128, 128, 128, 200]; // Gray for 'other'
                }
              } else {
                // Color by value (e.g., case count)
                const value = d.properties.value || 0;
                if (value < 100) return [254, 217, 118, 200];
                if (value < 500) return [254, 178, 76, 200];
                if (value < 1000) return [253, 141, 60, 200];
                if (value < 5000) return [252, 78, 42, 200];
                if (value < 10000) return [227, 26, 28, 200];
                return [177, 0, 38, 200];
              }
            },
            getRadius: (d: any) => {
              if (isEarthquakeData) {
                // Scale radius exponentially for earthquake magnitude
                // Magnitude 4.0 = ~10km, Magnitude 8.0 = ~500km radius
                const magnitude =
                  d.properties.magnitude || d.properties.value || 4.0;
                return Math.pow(2, magnitude - 4) * 10000;
              } else if (isShipData) {
                // Fixed size for ships (about 1km radius)
                return 1000;
              } else {
                const value = d.properties.value || 1;
                return Math.sqrt(value) * 50;
              }
            },
            radiusUnits: "meters",
            radiusScale: 1,
          }),
        ];

      case "path":
        return [
          new AnimatedPathLayer({
            ...baseProps,
            getColor: (d: any) => {
              // Color by status or category
              const status = d.properties.status || "default";
              switch (status) {
                // Taxi statuses
                case "available":
                  return [0, 208, 132, 255];
                case "occupied":
                  return [255, 107, 53, 255];
                case "enroute":
                  return [74, 144, 226, 255];
                
                // Hurricane statuses
                case "tropical_depression":
                  return [0, 208, 132, 255];
                case "tropical_storm":
                  return [255, 107, 53, 255];
                case "category_1":
                case "category_2":
                case "category_3":
                case "category_4":
                case "category_5":
                  return [74, 144, 226, 255];
                case "subtropical_storm":
                  return [189, 16, 224, 255];
                case "extratropical":
                  return [144, 19, 254, 255];
                case "disturbance":
                  return [80, 227, 194, 255];
                  
                default:
                  return [128, 128, 128, 255];
              }
            },
            getWidth: () => 3,
            widthUnits: "pixels",
            trail: true,
            trailLength: 5000,
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
            getWeight: (d: any) => d.properties.weight || 1,
          }),
        ];

      default:
        return [];
    }
  }, [selectedDataset, currentTime, timeController]);

  if (!selectedDataset) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="app">
      <DeckGL
        initialViewState={selectedDataset.initialViewState}
        controller={true}
        layers={layers}
        getTooltip={({ object }) =>
          object && object.properties
            ? Object.entries(object.properties)
                .slice(0, 3)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n")
            : null
        }
      >
        <Map
          reuseMaps
          mapStyle="mapbox://styles/mapbox/dark-v11"
          mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
          projection={{ name: "mercator" }}
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
      />

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
