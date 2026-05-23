import React from "react";
import { Link } from "react-router-dom";

const FormatPage: React.FC = () => {
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
            The .stt Format & Tools
          </h1>
          <p style={{ color: "#A0A7B4", lineHeight: 1.7 }}>
            The SpatioTemporal Tile (.stt) format is a single-file archive designed 
            for efficient streaming of time-series geospatial data. It combines spatial 
            tiling with temporal indexing, allowing clients to fetch only the data needed 
            for a specific map view and time window.
          </p>
        </div>

        {/* File Structure */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-4"
            style={{ color: "#FFFFFF" }}
          >
            File Structure
          </h2>
          <p
            className="mb-4"
            style={{ color: "#A0A7B4", lineHeight: 1.7 }}
          >
            A <code style={{ color: "#1FBAD6" }}>.stt</code> file contains four sections:
          </p>
          
          <div
            className="rounded overflow-hidden mb-4"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#242730" }}>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Section</th>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Description</th>
                </tr>
              </thead>
              <tbody style={{ color: "#A0A7B4" }}>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>Header</td>
                  <td className="px-4 py-3">Magic bytes, version, and offsets to other sections (53 bytes)</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>Tiles</td>
                  <td className="px-4 py-3">Gzip-compressed Protocol Buffer tile data</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>Index</td>
                  <td className="px-4 py-3">Spatial and temporal lookup tables for random access</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>Metadata</td>
                  <td className="px-4 py-3">Dataset bounds, time range, and layer information</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p style={{ color: "#6A7485", fontSize: "0.875rem" }}>
            The header enables efficient HTTP Range Requests—clients read the header first, 
            then fetch only the tiles needed for the current viewport and time.
          </p>
        </section>

        {/* Key Features */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-4"
            style={{ color: "#FFFFFF" }}
          >
            Key Features
          </h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div
              className="p-4 rounded"
              style={{ background: "#29323C", border: "1px solid #3A414C" }}
            >
              <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>
                Columnar Layout
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Feature properties are stored in typed columnar arrays for efficient 
                GPU upload. Numeric and categorical properties are separated.
              </p>
            </div>
            
            <div
              className="p-4 rounded"
              style={{ background: "#29323C", border: "1px solid #3A414C" }}
            >
              <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>
                Delta-Encoded Coordinates
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Geometry coordinates are quantized to tile-relative integers and 
                delta-encoded, achieving ~2-4 bytes per coordinate.
              </p>
            </div>
            
            <div
              className="p-4 rounded"
              style={{ background: "#29323C", border: "1px solid #3A414C" }}
            >
              <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>
                Temporal Indexing
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Each tile has start/end timestamps. The index allows querying 
                "all tiles at zoom Z overlapping time T" efficiently.
              </p>
            </div>
            
            <div
              className="p-4 rounded"
              style={{ background: "#29323C", border: "1px solid #3A414C" }}
            >
              <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>
                Hilbert Curve Ordering
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Tiles are written in Hilbert Curve order to maximize spatial locality, 
                improving cache efficiency and reducing seek times.
              </p>
            </div>
          </div>
        </section>

        {/* CLI Tools */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-4"
            style={{ color: "#FFFFFF" }}
          >
            CLI Tools
          </h2>
          <p
            className="mb-4"
            style={{ color: "#A0A7B4", lineHeight: 1.7 }}
          >
            The <code style={{ color: "#1FBAD6" }}>stt-build</code> command-line tool 
            converts GeoParquet files into the .stt format using a memory-efficient streaming 
            architecture (~50MB per 1M features).
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
                Terminal
              </span>
            </div>
            <pre
              className="p-4 overflow-x-auto code-block"
              style={{ color: "#A0A7B4" }}
            >
{`# Basic usage (GeoParquet input)
stt-build -i data.parquet -o output.stt

# With time fields and zoom levels
stt-build -i earthquakes.parquet \\
  --time-field timestamp \\
  --time-format unix-ms \\
  --min-zoom 0 \\
  --max-zoom 8 \\
  -o earthquakes.stt

# For path/trajectory data with duration
stt-build -i taxi-trips.parquet \\
  --time-field timestamp \\
  --end-time-field end_timestamp \\
  --time-format unix-ms \\
  -o taxi-trips.stt

# Convert GeoJSON to GeoParquet first
ogr2ogr -f Parquet input.parquet input.geojson`}
            </pre>
          </div>

          <h3
            className="text-lg font-medium mb-3"
            style={{ color: "#FFFFFF" }}
          >
            Common Options
          </h3>
          
          <div
            className="rounded overflow-hidden"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#242730" }}>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Option</th>
                  <th className="text-left px-4 py-3" style={{ color: "#FFFFFF" }}>Description</th>
                </tr>
              </thead>
              <tbody style={{ color: "#A0A7B4" }}>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>-i, --input</td>
                  <td className="px-4 py-3">Input GeoParquet file (.parquet or .geoparquet)</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>-o, --output</td>
                  <td className="px-4 py-3">Output .stt file path</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--time-field</td>
                  <td className="px-4 py-3">Column name containing timestamps</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--end-time-field</td>
                  <td className="px-4 py-3">Optional end timestamp for features with duration</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--min-zoom, --max-zoom</td>
                  <td className="px-4 py-3">Zoom level range for tile generation</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--time-format</td>
                  <td className="px-4 py-3">Timestamp format: iso8601, unix-ms, or unix-sec</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Data Generation */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-4"
            style={{ color: "#FFFFFF" }}
          >
            Data Generation
          </h2>
          <p
            className="mb-4"
            style={{ color: "#A0A7B4", lineHeight: 1.7 }}
          >
            The <code style={{ color: "#1FBAD6" }}>stt-generate</code> tool can create 
            sample datasets for testing and development:
          </p>

          <div
            className="rounded overflow-hidden mb-4"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <pre
              className="p-4 overflow-x-auto code-block"
              style={{ color: "#A0A7B4" }}
            >
{`# Generate earthquake data from USGS feed
stt-generate earthquakes --output earthquakes.stt

# Generate satellite orbits from TLE data
stt-generate satellites --tle celestrak-active.tle --output satellites.stt

# Generate flight data from OpenSky
stt-generate flights --date 2024-01-06 --output flights.stt`}
            </pre>
          </div>

          <p style={{ color: "#6A7485", fontSize: "0.875rem" }}>
            See the <code style={{ color: "#A0A7B4" }}>scripts/data-generation/</code> directory 
            for additional data processing scripts.
          </p>
        </section>

        {/* Loading in JavaScript */}
        <section className="mb-10">
          <h2
            className="text-xl font-semibold mb-4"
            style={{ color: "#FFFFFF" }}
          >
            Loading .stt Files
          </h2>
          <p
            className="mb-4"
            style={{ color: "#A0A7B4", lineHeight: 1.7 }}
          >
            The deck.gl layers handle loading automatically—just pass a URL as the{" "}
            <code style={{ color: "#1FBAD6" }}>data</code> prop:
          </p>

          <div
            className="rounded overflow-hidden mb-4"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <pre
              className="p-4 overflow-x-auto code-block"
              style={{ color: "#A0A7B4" }}
            >
{`import { AnimatedPointLayer } from '@stt/deck.gl';

const layer = new AnimatedPointLayer({
  id: 'earthquakes',
  data: '/data/earthquakes.stt',  // URL to .stt file
  currentTime: Date.now(),
  timeWindow: 86400000,
});`}
            </pre>
          </div>

          <p style={{ color: "#6A7485", fontSize: "0.875rem" }}>
            The layer will fetch metadata first, then stream tiles as needed based on 
            the current viewport and time. For lower-level access, see the{" "}
            <code style={{ color: "#A0A7B4" }}>@stt/core</code> package.
          </p>
        </section>

        {/* Footer nav */}
        <div
          className="flex justify-between pt-6 border-t"
          style={{ borderColor: "#3A414C" }}
        >
          <Link
            to="/"
            className="text-sm transition-colors"
            style={{ color: "#6A7485" }}
            onMouseOver={(e) => (e.currentTarget.style.color = "#1FBAD6")}
            onMouseOut={(e) => (e.currentTarget.style.color = "#6A7485")}
          >
            ← Home
          </Link>
          <Link
            to="/layers"
            className="text-sm transition-colors"
            style={{ color: "#6A7485" }}
            onMouseOver={(e) => (e.currentTarget.style.color = "#1FBAD6")}
            onMouseOut={(e) => (e.currentTarget.style.color = "#6A7485")}
          >
            Layers →
          </Link>
        </div>
      </div>
    </div>
  );
};

export default FormatPage;

