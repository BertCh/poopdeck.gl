import React from "react";
import { Link } from "react-router-dom";

interface LayerInfo {
  name: string;
  description: string;
  useCase: string;
  props: { name: string; type: string; description: string }[];
  demoId?: string;
}

const deckLayers: LayerInfo[] = [
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
      "Renders path geometries with time filtering. Paths are shown when their time range overlaps the current time window. For a vehicle-along-route trailing effect, use AnimatedTripsLayer.",
    useCase: "Ship tracks, flight routes, GPS traces, historical trajectories",
    props: [
      { name: "pathColor", type: "Color | string", description: "Path color or categorical property name" },
      { name: "pathWidth", type: "number", description: "Path width in pixels" },
      { name: "fadeInDuration", type: "number", description: "Fade-in duration in ms when a path enters the window" },
      { name: "fadeOutDuration", type: "number", description: "Fade-out duration in ms when a path leaves the window" },
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
    name: "VatTripsLayer",
    description:
      "Vertex-Animation-Texture variant. One quad instance per active trip; per-tile RGBA32F texture stores position-over-time and the vertex shader samples it at the current playhead. GPU work is independent of per-trajectory vertex count.",
    useCase: "100k+ simultaneous trips, dense urban taxi/rideshare animations, anywhere AnimatedTripsLayer's per-vertex upload becomes the bottleneck",
    props: [
      { name: "headColor", type: "Color", description: "Constant RGBA color of the head dot" },
      { name: "headRadiusPixels", type: "number", description: "Head-dot radius in pixels" },
      { name: "timeSlots", type: "number", description: "Resampled positions per trip in the VAT texture (default 64)" },
    ],
    demoId: "nyc-taxi-vat",
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

const maplibreLayers: LayerInfo[] = [
  {
    name: "STTPointLayer",
    description:
      "MapLibre custom layer that renders POINT-type tiles as circular billboards with time-window filtering. Per-feature radius and categorical colour are supported via property-name accessors.",
    useCase: "Earthquakes, sensor pings, event locations layered between native MapLibre style layers",
    props: [
      { name: "color", type: "[r,g,b,a] 0-1", description: "Constant fill colour" },
      { name: "radius", type: "number", description: "Pixel radius (constant)" },
      { name: "colorProperty", type: "string", description: "Categorical property → palette lookup" },
      { name: "radiusProperty", type: "string", description: "Numeric property name for per-feature radius" },
      { name: "fadeInDuration", type: "number", description: "Leading-edge alpha ramp in ms" },
      { name: "fadeOutDuration", type: "number", description: "Trailing-edge alpha ramp in ms" },
    ],
    demoId: "earthquake-activity",
  },
  {
    name: "STTLineLayer",
    description:
      "Renders LINESTRING tiles as screen-space thick lines with constant pixel width across zoom. Each segment is expanded to a quad on the CPU and offset along its normal in the vertex shader.",
    useCase: "Flight routes, ship tracks, road networks against a native MapLibre basemap",
    props: [
      { name: "color", type: "[r,g,b,a] 0-1", description: "Constant stroke colour" },
      { name: "width", type: "number", description: "Pixel width (constant)" },
      { name: "colorProperty", type: "string", description: "Categorical colour via palette lookup" },
      { name: "widthProperty", type: "string", description: "Numeric property → per-feature width" },
    ],
    demoId: "flight-paths",
  },
  {
    name: "STTPolygonLayer",
    description:
      "Renders POLYGON tiles as filled, earcut-triangulated triangles. Supports optional outlined stroke and 3D extrusion driven by a constant or per-feature elevation property.",
    useCase: "Wildfire perimeters, flood zones, extruded admin boundaries",
    props: [
      { name: "color", type: "[r,g,b,a] 0-1", description: "Fill colour" },
      { name: "fillColorProperty", type: "string", description: "Categorical fill via palette" },
      { name: "stroked", type: "boolean", description: "Add an outline pass over each ring" },
      { name: "lineColor", type: "[r,g,b,a] 0-1", description: "Outline colour (when stroked)" },
      { name: "lineWidth", type: "number", description: "Outline pixel width" },
      { name: "extruded", type: "boolean", description: "Raise the polygon top to `elevation` and draw side walls" },
      { name: "elevation", type: "number | string", description: "Constant height or numeric property name" },
    ],
    demoId: "wildfires",
  },
  {
    name: "STTTripsLayer",
    description:
      "Animated trailing-fade trajectories. Reads `binary.vertexTimestamps` when present (otherwise interpolates from feature start/end times). Alpha ramps 1→0 over `trailLength` and clips vertices in the future.",
    useCase: "Taxi routes, delivery tracking, satellite ground-tracks rendered without a deck.gl dependency",
    props: [
      { name: "color", type: "[r,g,b,a] 0-1", description: "Trail colour" },
      { name: "width", type: "number", description: "Pixel width" },
      { name: "trailLength", type: "number", description: "Trail length in milliseconds" },
      { name: "fadeTrail", type: "boolean", description: "Ramp alpha across the trail age vs. constant alpha" },
      { name: "colorProperty", type: "string", description: "Categorical colour via palette lookup" },
    ],
    demoId: "nyc-taxi-trips",
  },
  {
    name: "STTHeatmapLayer",
    description:
      "Density heatmap rendered with a two-pass FBO pipeline: each visible point is splatted into an offscreen framebuffer additively, then a fullscreen quad samples that buffer through a 256×1 RGBA colour-ramp texture.",
    useCase: "Pickup/dropoff density, sensor activity hotspots, density-only overlays without deck.gl",
    props: [
      { name: "radiusPixels", type: "number", description: "Splat radius in pixels" },
      { name: "intensity", type: "number", description: "Per-point intensity multiplier" },
      { name: "colorRange", type: "RGBA8[]", description: "Density-low → density-high colour ramp" },
      { name: "weightProperty", type: "string", description: "Optional numeric weight per point" },
      { name: "threshold", type: "number", description: "Hide pixels with intensity below this value" },
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
            STT ships two layer adapters. The <code style={{ color: "#1FBAD6" }}>@stt/deck.gl</code> package
            adds time-aware deck.gl layers (with picking, rounded joints,
            GPU consolidation, and a category-color extension), and{" "}
            <code style={{ color: "#1FBAD6" }}>@stt/maplibre</code> provides
            MapLibre custom layers for sites that prefer not to take a
            deck.gl dependency. Every demo lets you toggle between the two
            renderers from its header.
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

        {/* @stt/deck.gl Layers */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-6"
            style={{ color: "#FFFFFF" }}
          >
            <span style={{ color: "#1FBAD6" }}>@stt/deck.gl</span> Layers
          </h2>
          <p
            className="mb-4"
            style={{ color: "#6A7485", lineHeight: 1.7 }}
          >
            Time-aware deck.gl layers. Use these when you want GPU picking,
            cross-tile consolidation, rounded joints/caps, or the GPU-side
            category-color extension.
          </p>

          <div className="space-y-6">
            {deckLayers.map((layer) => (
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

        {/* @stt/maplibre Layers */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-6"
            style={{ color: "#FFFFFF" }}
          >
            <span style={{ color: "#1FBAD6" }}>@stt/maplibre</span> Layers
          </h2>
          <p
            className="mb-4"
            style={{ color: "#6A7485", lineHeight: 1.7 }}
          >
            MapLibre custom layers. Use these when you want to interleave STT
            data between native MapLibre style layers, or to skip the deck.gl
            runtime entirely. Each layer extends{" "}
            <code style={{ color: "#1FBAD6" }}>STTBaseLayer</code> (which
            implements{" "}
            <code style={{ color: "#1FBAD6" }}>CustomLayerInterface</code>) and
            shares the same archive reader and tileset scheduler as the
            deck.gl adapter.
          </p>

          <div className="space-y-6">
            {maplibreLayers.map((layer) => (
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
                      style={{
                        background: "#242730",
                        color: "#6A7485",
                        border: "1px solid #3A414C",
                      }}
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
                  <strong style={{ color: "#A0A7B4" }}>Use cases:</strong>{" "}
                  {layer.useCase}
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
                      <span style={{ color: "#A0A7B4" }}>
                        — {prop.description}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p
            className="text-sm mt-6"
            style={{ color: "#6A7485", lineHeight: 1.7 }}
          >
            All MapLibre layers share the{" "}
            <code style={{ color: "#1FBAD6" }}>STTBaseLayerOptions</code>{" "}
            shape (<code>id</code>, <code>url</code>, <code>currentTime</code>,{" "}
            <code>timeWindow</code>, plus prefetch / fade tuning), and expose{" "}
            <code>setCurrentTime</code>, <code>setTimeWindow</code>, and{" "}
            <code>ready()</code> at runtime. See{" "}
            <code style={{ color: "#1FBAD6" }}>docs/api/stt-maplibre.md</code>{" "}
            for the full reference.
          </p>
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


