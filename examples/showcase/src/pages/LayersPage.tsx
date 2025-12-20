import React from "react";
import { Link } from "react-router-dom";

interface LayerInfo {
  name: string;
  description: string;
  useCase: string;
  props: { name: string; type: string; description: string }[];
  demoId?: string;
}

const layers: LayerInfo[] = [
  {
    name: "AnimatedPointLayer",
    description:
      "Renders animated point features with time-based filtering. Points appear and disappear based on their temporal attributes.",
    useCase: "Earthquakes, sensor readings, event locations, vehicle positions",
    props: [
      { name: "fillColor", type: "Color | string", description: "Point fill color or categorical property name" },
      { name: "radius", type: "number | string", description: "Point radius in meters or property name" },
      { name: "radiusScale", type: "number", description: "Multiplier for radius values" },
    ],
    demoId: "earthquake-activity",
  },
  {
    name: "AnimatedPathLayer",
    description:
      "Renders path geometries with time filtering. Paths are shown when their time range overlaps the current time window.",
    useCase: "Ship tracks, flight routes, GPS traces, historical trajectories",
    props: [
      { name: "pathColor", type: "Color | string", description: "Path color or categorical property name" },
      { name: "pathWidth", type: "number", description: "Path width in pixels" },
      { name: "trail", type: "boolean", description: "Enable trailing effect behind current time" },
      { name: "trailLength", type: "number", description: "Trail length in milliseconds" },
    ],
    demoId: "flight-paths",
  },
  {
    name: "AnimatedTripsLayer",
    description:
      'Renders animated trajectories with a "vehicle moving along route" effect. Features a head that moves along the path with an optional fading trail.',
    useCase: "Taxi routes, delivery tracking, commute animations, transit vehicles",
    props: [
      { name: "tripColor", type: "Color | string", description: "Trip line color" },
      { name: "tripWidth", type: "number", description: "Line width in pixels" },
      { name: "trailLength", type: "number", description: "Trail length in milliseconds" },
      { name: "fadeTrail", type: "boolean", description: "Whether trail fades out" },
    ],
    demoId: "nyc-taxi-trips",
  },
  {
    name: "AnimatedPolygonLayer",
    description:
      "Renders polygon features with temporal filtering. Polygons appear when their time range overlaps the current window.",
    useCase: "Wildfire perimeters, flood zones, territorial changes, event boundaries",
    props: [
      { name: "fillColor", type: "Color | string", description: "Polygon fill color" },
      { name: "lineColor", type: "Color", description: "Polygon outline color" },
      { name: "lineWidth", type: "number", description: "Outline width in pixels" },
    ],
    demoId: "wildfires",
  },
  {
    name: "HeatmapTimeLayer",
    description:
      "Renders a heatmap that updates based on the current time window. Intensity is calculated from visible features.",
    useCase: "Activity hotspots, density over time, temporal clustering",
    props: [
      { name: "radiusPixels", type: "number", description: "Heatmap radius in pixels" },
      { name: "intensity", type: "number", description: "Intensity multiplier" },
      { name: "colorRange", type: "Color[]", description: "Color gradient for heatmap" },
      { name: "weightProperty", type: "string", description: "Property name to use for weighting" },
    ],
  },
];

const LayersPage: React.FC = () => {
  return (
    <div
      className="h-full overflow-y-auto custom-scrollbar"
      style={{ background: "#242730" }}
    >
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-10">
          <h1
            className="text-3xl font-bold mb-3"
            style={{ color: "#FFFFFF" }}
          >
            Layers
          </h1>
          <p style={{ color: "#A0A7B4", lineHeight: 1.7 }}>
            The <code style={{ color: "#1FBAD6" }}>@stt/deck.gl</code> package provides 
            several layer types for visualizing time-series geospatial data. Each layer 
            extends deck.gl's base layer system and adds temporal awareness.
          </p>
        </div>

        {/* Common Props */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-4"
            style={{ color: "#FFFFFF" }}
          >
            Common Properties
          </h2>
          <p
            className="mb-4"
            style={{ color: "#A0A7B4", lineHeight: 1.7 }}
          >
            All animated layers share these temporal properties:
          </p>
          
          <div
            className="rounded overflow-hidden"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#242730" }}>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Property</th>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Type</th>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Description</th>
                </tr>
              </thead>
              <tbody style={{ color: "#A0A7B4" }}>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>data</td>
                  <td className="px-4 py-3 font-mono text-xs">string</td>
                  <td className="px-4 py-3">URL to .stt file</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>currentTime</td>
                  <td className="px-4 py-3 font-mono text-xs">number</td>
                  <td className="px-4 py-3">Current time in Unix milliseconds</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>timeWindow</td>
                  <td className="px-4 py-3 font-mono text-xs">number</td>
                  <td className="px-4 py-3">Time window size in milliseconds</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>timeController</td>
                  <td className="px-4 py-3 font-mono text-xs">TimeController</td>
                  <td className="px-4 py-3">Optional controller for synchronized animation</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>timeRange</td>
                  <td className="px-4 py-3 font-mono text-xs">{`{start, end}`}</td>
                  <td className="px-4 py-3">Dataset time boundaries</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Layer List */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-6"
            style={{ color: "#FFFFFF" }}
          >
            Available Layers
          </h2>
          
          <div className="space-y-6">
            {layers.map((layer) => (
              <div
                key={layer.name}
                className="rounded p-5"
                style={{ background: "#29323C", border: "1px solid #3A414C" }}
              >
                <div className="flex items-start justify-between mb-3">
                  <h3
                    className="text-lg font-mono font-semibold"
                    style={{ color: "#1FBAD6" }}
                  >
                    {layer.name}
                  </h3>
                  {layer.demoId && (
                    <Link
                      to={`/demo/${layer.demoId}`}
                      className="text-xs px-3 py-1 rounded transition-colors"
                      style={{ background: "#242730", color: "#6A7485", border: "1px solid #3A414C" }}
                      onMouseOver={(e) => {
                        e.currentTarget.style.borderColor = "#1FBAD6";
                        e.currentTarget.style.color = "#1FBAD6";
                      }}
                      onMouseOut={(e) => {
                        e.currentTarget.style.borderColor = "#3A414C";
                        e.currentTarget.style.color = "#6A7485";
                      }}
                    >
                      View Demo →
                    </Link>
                  )}
                </div>
                
                <p
                  className="mb-3"
                  style={{ color: "#A0A7B4", lineHeight: 1.6 }}
                >
                  {layer.description}
                </p>
                
                <p
                  className="text-sm mb-4"
                  style={{ color: "#6A7485" }}
                >
                  <strong style={{ color: "#A0A7B4" }}>Use cases:</strong> {layer.useCase}
                </p>

                <h4
                  className="text-sm font-medium mb-2"
                  style={{ color: "#FFFFFF" }}
                >
                  Key Properties
                </h4>
                <div className="grid grid-cols-1 gap-2">
                  {layer.props.map((prop) => (
                    <div
                      key={prop.name}
                      className="flex items-baseline gap-3 text-sm"
                    >
                      <code
                        className="font-mono shrink-0"
                        style={{ color: "#1FBAD6" }}
                      >
                        {prop.name}
                      </code>
                      <span
                        className="font-mono text-xs shrink-0"
                        style={{ color: "#6A7485" }}
                      >
                        {prop.type}
                      </span>
                      <span style={{ color: "#A0A7B4" }}>— {prop.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* TimeController */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-4"
            style={{ color: "#FFFFFF" }}
          >
            TimeController
          </h2>
          <p
            className="mb-4"
            style={{ color: "#A0A7B4", lineHeight: 1.7 }}
          >
            The <code style={{ color: "#1FBAD6" }}>TimeController</code> class manages 
            animation playback and can be shared across multiple layers for synchronized 
            animation.
          </p>

          <div
            className="rounded overflow-hidden mb-4"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <div
              className="flex items-center gap-2 px-3 py-2 border-b"
              style={{ background: "#242730", borderColor: "#3A414C" }}
            >
              <span className="text-xs" style={{ color: "#6A7485" }}>
                example.tsx
              </span>
            </div>
            <pre
              className="p-4 overflow-x-auto code-block"
              style={{ color: "#A0A7B4" }}
            >
{`import { TimeController, AnimatedPointLayer } from '@stt/deck.gl';

// Create a controller
const timeController = new TimeController({
  initialTime: Date.parse('2020-01-01'),
  speed: 86400000,  // 1 day per second
  loop: true,
  timeRange: {
    start: Date.parse('2020-01-01'),
    end: Date.parse('2020-12-31'),
  },
});

// Subscribe to updates
timeController.on('tick', (time) => {
  console.log('Time:', new Date(time));
});

// Control playback
timeController.play();
timeController.pause();
timeController.seek(Date.parse('2020-06-15'));

// Pass to layers - they subscribe automatically
const layer = new AnimatedPointLayer({
  data: '/data/earthquakes.stt',
  timeController,
  timeWindow: 86400000 * 7,  // 1 week
});`}
            </pre>
          </div>

          <h3
            className="text-lg font-medium mb-3"
            style={{ color: "#FFFFFF" }}
          >
            Methods
          </h3>
          
          <div
            className="rounded overflow-hidden"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#242730" }}>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Method</th>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Description</th>
                </tr>
              </thead>
              <tbody style={{ color: "#A0A7B4" }}>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>play()</td>
                  <td className="px-4 py-3">Start playback</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>pause()</td>
                  <td className="px-4 py-3">Pause playback</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>seek(time)</td>
                  <td className="px-4 py-3">Jump to a specific time</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>getTime()</td>
                  <td className="px-4 py-3">Get current time</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>setSpeed(speed)</td>
                  <td className="px-4 py-3">Set playback speed multiplier</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>on('tick', fn)</td>
                  <td className="px-4 py-3">Subscribe to time updates</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Basic Example */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-4"
            style={{ color: "#FFFFFF" }}
          >
            Complete Example
          </h2>

          <div
            className="rounded overflow-hidden"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <div
              className="flex items-center gap-2 px-3 py-2 border-b"
              style={{ background: "#242730", borderColor: "#3A414C" }}
            >
              <span className="text-xs" style={{ color: "#6A7485" }}>
                App.tsx
              </span>
            </div>
            <pre
              className="p-4 overflow-x-auto code-block text-sm"
              style={{ color: "#A0A7B4" }}
            >
{`import React, { useState, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { Map } from 'react-map-gl';
import { AnimatedPointLayer, TimeController } from '@stt/deck.gl';

function App() {
  const [timeController] = useState(() => new TimeController({
    initialTime: Date.parse('2020-01-01'),
    speed: 86400000 * 7,  // 1 week per second
    loop: true,
  }));
  
  const [currentTime, setCurrentTime] = useState(timeController.getTime());

  useEffect(() => {
    timeController.play();
    const handleTick = (time: number) => setCurrentTime(time);
    timeController.on('tick', handleTick);
    return () => timeController.off('tick', handleTick);
  }, [timeController]);

  const layers = useMemo(() => [
    new AnimatedPointLayer({
      id: 'earthquakes',
      data: '/data/earthquakes.stt',
      currentTime,
      timeController,
      timeWindow: 86400000 * 30,  // 30 day window
      fillColor: [255, 100, 50, 200],
      radius: 50000,
    }),
  ], [currentTime, timeController]);

  return (
    <DeckGL
      initialViewState={{ longitude: -120, latitude: 37, zoom: 4 }}
      controller={true}
      layers={layers}
    >
      <Map mapStyle="mapbox://styles/mapbox/dark-v11" />
    </DeckGL>
  );
}`}
            </pre>
          </div>
        </section>

        {/* Footer nav */}
        <div
          className="flex justify-between pt-6 border-t"
          style={{ borderColor: "#3A414C" }}
        >
          <Link
            to="/format"
            className="text-sm transition-colors"
            style={{ color: "#6A7485" }}
            onMouseOver={(e) => (e.currentTarget.style.color = "#1FBAD6")}
            onMouseOut={(e) => (e.currentTarget.style.color = "#6A7485")}
          >
            ← Format & Tools
          </Link>
          <Link
            to="/demo/earthquake-activity"
            className="text-sm transition-colors"
            style={{ color: "#6A7485" }}
            onMouseOver={(e) => (e.currentTarget.style.color = "#1FBAD6")}
            onMouseOut={(e) => (e.currentTarget.style.color = "#6A7485")}
          >
            View Demos →
          </Link>
        </div>
      </div>
    </div>
  );
};

export default LayersPage;

