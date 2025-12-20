import React, { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import DeckGL from "@deck.gl/react";
import { Map } from "react-map-gl";
import { AnimatedTripsLayer, TimeController } from "@stt/deck.gl";
import { getDatasetById } from "../datasets";
import { calculateAnimationSpeed } from "../types";

const MAPBOX_ACCESS_TOKEN =
  (import.meta as any).env?.VITE_MAPBOX_TOKEN ||
  "pk.eyJ1IjoicmdjZ2VvZyIsImEiOiJjajBuNG1sMjUwMDFlMzNxcWY0M2RqMHI3In0.XfM0BMSqZqjRDcz-oJuadw";

// Speed multiplier for hero section - slower than demo page for smoother visuals
const HERO_SPEED_MULTIPLIER = 0.35;

const HomePage: React.FC = () => {
  const heroDataset = getDatasetById("nyc-taxi-trips");

  // Calculate base animation speed using the same function as DemoPage
  const baseAnimationSpeed = useMemo(() => {
    if (!heroDataset) return 1000;
    return calculateAnimationSpeed(heroDataset);
  }, [heroDataset]);

  const [timeController] = useState(
    () =>
      new TimeController({
        initialTime: heroDataset?.timeRange.start || Date.now(),
        speed: baseAnimationSpeed * HERO_SPEED_MULTIPLIER,
        loop: true,
        timeRange: heroDataset?.timeRange,
      })
  );

  const [currentTime, setCurrentTime] = useState(timeController.getTime());

  useEffect(() => {
    timeController.play();
    const handleTick = (time: number) => setCurrentTime(time);
    timeController.on("tick", handleTick);
    return () => {
      timeController.off("tick", handleTick);
      timeController.pause();
    };
  }, [timeController]);

  const layers = useMemo(() => {
    if (!heroDataset) return [];

    // Calculate prefetch settings the same way as DemoPage for smooth playback
    const datasetDuration =
      heroDataset.timeRange.end - heroDataset.timeRange.start;
    const playbackSpeed =
      (datasetDuration / (heroDataset.targetPlaybackSeconds || 60) / 1000) *
      HERO_SPEED_MULTIPLIER;
    const timeWindow = heroDataset.timeWindow || 300000;
    const timeWindowsPerSecond = (playbackSpeed / timeWindow) * 1000;
    const minPrefetchSteps = Math.max(15, Math.ceil(timeWindowsPerSecond * 60));
    const prefetchSteps = Math.min(minPrefetchSteps, 80);
    const prefetchAhead = Math.max(timeWindow * 3, playbackSpeed * 30000);

    return [
      new AnimatedTripsLayer({
        id: "hero-trips",
        data: heroDataset.url,
        currentTime,
        timeController,
        timeWindow,
        timeRange: heroDataset.timeRange,
        tripColor: [31, 186, 214, 255],
        tripWidth: 4,
        widthMinPixels: 2,
        widthMaxPixels: 8,
        trailLength: 60000,
        fadeTrail: true,
        capRounded: true,
        jointRounded: true,
        opacity: 0.8,
        pickable: false,
        enablePrefetch: true,
        prefetchAhead,
        prefetchSteps,
      }),
    ];
  }, [heroDataset, currentTime, timeController]);

  const features = [
    {
      icon: "🗺️",
      title: "deck.gl Layers",
      description:
        "AnimatedPointLayer, AnimatedPathLayer, AnimatedTripsLayer, and more for time-series geodata.",
      link: "/layers",
    },
    {
      icon: "📦",
      title: ".stt File Format",
      description:
        "A single-file archive containing tiles, indices, and metadata for efficient streaming.",
      link: "/format",
    },
    {
      icon: "🕐",
      title: "TimeController",
      description:
        "Utility class for synchronized animation playback across layers.",
      link: "/layers",
    },
    {
      icon: "🔧",
      title: "CLI Tools",
      description:
        "Rust-powered tile generation from GeoJSON and other spatial formats.",
      link: "/format",
    },
  ];

  return (
    <div
      className="h-full flex flex-col overflow-y-auto custom-scrollbar"
      style={{ background: "#242730" }}
    >
      {/* Hero Section */}
      <div className="flex flex-col lg:flex-row lg:min-h-[400px]">
        {/* Left: Content */}
        <div
          className="lg:w-[45%] flex flex-col justify-center p-6 lg:p-10 order-2 lg:order-1"
          style={{ background: "#242730" }}
        >
          <div className="max-w-lg animate-fade-in">
            <h1
              className="font-display text-3xl lg:text-4xl font-bold mb-4"
              style={{ color: "#FFFFFF", lineHeight: 1.2 }}
            >
              <span className="gradient-text">SpatioTemporal Tiles</span>
            </h1>

            <p
              className="text-sm lg:text-base mb-4"
              style={{ color: "#A0A7B4", lineHeight: 1.7 }}
            >
              A collection of layers, components, and utility functions for
              building animated, time-series geospatial visualizations with{" "}
              <a
                href="https://deck.gl"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#1FBAD6" }}
              >
                deck.gl
              </a>
              .
            </p>

            <p
              className="text-sm lg:text-base mb-6"
              style={{ color: "#6A7485", lineHeight: 1.7 }}
            >
              Includes the{" "}
              <code
                style={{
                  color: "#A0A7B4",
                  background: "#29323C",
                  padding: "2px 6px",
                  borderRadius: "4px",
                }}
              >
                .stt
              </code>{" "}
              file format and CLI tools for efficient streaming of temporal
              geodata.
            </p>

            <div className="flex flex-wrap gap-3">
              <Link
                to="/demo/nyc-taxi-trips"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-sm font-medium transition-all"
                style={{ background: "#0F9668", color: "#FFFFFF" }}
                onMouseOver={(e) =>
                  (e.currentTarget.style.background = "#13B17B")
                }
                onMouseOut={(e) =>
                  (e.currentTarget.style.background = "#0F9668")
                }
              >
                Explore Demos
                <span>→</span>
              </Link>
              <Link
                to="/layers"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-sm font-medium transition-all"
                style={{
                  background: "#29323C",
                  color: "#A0A7B4",
                  border: "1px solid #3A414C",
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.background = "#3A414C";
                  e.currentTarget.style.color = "#FFFFFF";
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.background = "#29323C";
                  e.currentTarget.style.color = "#A0A7B4";
                }}
              >
                View Layers
              </Link>
            </div>
          </div>
        </div>

        {/* Right: Map Viewport */}
        <div className="lg:w-[55%] h-64 lg:h-auto order-1 lg:order-2 lg:min-h-[400px] p-2 lg:p-4">
          <div
            className="w-full h-full rounded-lg overflow-hidden map-viewport"
            style={{ border: "1px solid #3A414C" }}
          >
            <DeckGL
              initialViewState={{
                longitude: -73.98,
                latitude: 40.75,
                zoom: 12,
                pitch: 45,
                bearing: -15,
              }}
              controller={true}
              layers={layers}
            >
              <Map
                reuseMaps
                mapStyle="mapbox://styles/mapbox/dark-v11"
                mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
                projection={{ name: "mercator" }}
              />
            </DeckGL>

            {/* Overlay label */}
            <div
              className="absolute top-3 left-3 px-2.5 py-1 rounded text-xs glass"
              style={{ color: "#A0A7B4" }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full mr-2"
                style={{ background: "#1FBAD6" }}
              />
              NYC Taxi Trips • 1M routes
            </div>
          </div>
        </div>
      </div>

      {/* What's Included */}
      <div
        className="shrink-0 px-6 lg:px-10 py-6 border-t"
        style={{ background: "#29323C", borderColor: "#3A414C" }}
      >
        <h2
          className="text-sm font-semibold mb-4 text-center uppercase tracking-wider"
          style={{ color: "#6A7485" }}
        >
          What's Included
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 max-w-5xl mx-auto">
          {features.map((feature) => (
            <Link
              key={feature.title}
              to={feature.link}
              className="p-4 rounded transition-all group"
              style={{ background: "#242730", border: "1px solid #3A414C" }}
              onMouseOver={(e) => {
                e.currentTarget.style.borderColor = "#1FBAD6";
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.borderColor = "#3A414C";
              }}
            >
              <div className="text-2xl mb-2">{feature.icon}</div>
              <h3
                className="text-sm font-medium mb-1 group-hover:text-[#1FBAD6] transition-colors"
                style={{ color: "#FFFFFF" }}
              >
                {feature.title}
              </h3>
              <p
                className="text-xs"
                style={{ color: "#6A7485", lineHeight: 1.5 }}
              >
                {feature.description}
              </p>
            </Link>
          ))}
        </div>
      </div>

      {/* Quick Start */}
      <div
        className="shrink-0 px-6 lg:px-10 py-6 border-t"
        style={{ borderColor: "#3A414C" }}
      >
        <div className="max-w-3xl mx-auto">
          <h2
            className="text-lg font-semibold mb-4 text-center"
            style={{ color: "#FFFFFF" }}
          >
            Quick Start
          </h2>
          <div
            className="rounded overflow-hidden"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <div
              className="flex items-center gap-2 px-3 py-2 border-b"
              style={{ background: "#242730", borderColor: "#3A414C" }}
            >
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ background: "#F9042C" }}
              />
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ background: "#FFBD2E" }}
              />
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ background: "#27C93F" }}
              />
              <span className="ml-2 text-xs" style={{ color: "#6A7485" }}>
                example.tsx
              </span>
            </div>
            <pre
              className="p-4 overflow-x-auto code-block"
              style={{ color: "#A0A7B4" }}
            >
              {`import { AnimatedTripsLayer, TimeController } from '@stt/deck.gl';

const timeController = new TimeController({
  initialTime: Date.parse('2024-01-01'),
  speed: 100000,
  loop: true,
});

const layer = new AnimatedTripsLayer({
  data: '/data/taxi-trips.stt',
  currentTime: timeController.getTime(),
  timeController,
  tripColor: [31, 186, 214],
  trailLength: 60000,
});`}
            </pre>
          </div>
          <p className="text-xs text-center mt-3" style={{ color: "#6A7485" }}>
            See the{" "}
            <Link to="/layers" style={{ color: "#1FBAD6" }}>
              Layers documentation
            </Link>{" "}
            and{" "}
            <Link to="/format" style={{ color: "#1FBAD6" }}>
              Format specification
            </Link>{" "}
            for more details.
          </p>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
