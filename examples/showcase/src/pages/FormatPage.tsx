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
            for efficient streaming of time-series geospatial data. Tile payloads are
            Apache Arrow IPC frames carrying GeoArrow geometry, and the format combines
            spatial tiling with temporal indexing so clients fetch only the data needed
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
            An <code style={{ color: "#1FBAD6" }}>.stt</code> archive lays out five
            sections in the order a reader needs them:
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
                  <td className="px-4 py-3">
                    Fixed 64 bytes — magic <code>STT\x03</code>, version, and byte
                    offsets to the dictionary, index, and metadata sections.
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>Tile blobs</td>
                  <td className="px-4 py-3">
                    Each tile is an Apache Arrow IPC stream (one
                    <code> RecordBatch</code> per layer) compressed with zstd; CRC32C
                    integrity tag per tile.
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>Dictionary</td>
                  <td className="px-4 py-3">
                    Optional zstd training dictionary shared by every tile. Drops
                    payload size on small/repetitive tiles by 20–40%.
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>Index</td>
                  <td className="px-4 py-3">
                    Arrow IPC table — one row per tile (zoom, x, y, time range,
                    offset, length, feature count, Hilbert key) for O(log&nbsp;n) lookup.
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>Metadata</td>
                  <td className="px-4 py-3">
                    UTF-8 JSON: dataset bounds, time range, per-layer schema, optional
                    summary-tier and temporal-LOD descriptors.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p style={{ color: "#6A7485", fontSize: "0.875rem" }}>
            Readers fetch the header first, then the index + metadata + dictionary in
            up to three HTTP range requests, then each tile in one more. Tile payloads
            decode synchronously via <code>tableFromIPC</code> with no worker pool.
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
                Arrow IPC + GeoArrow
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Tiles are Apache Arrow IPC frames with <code>geoarrow.point</code>,
                <code> geoarrow.linestring</code>, and <code>geoarrow.polygon</code>
                extension metadata. Geometry and properties live in the same columnar
                batch — zero-copy interop with <code>@geoarrow/deck.gl-layers</code>,
                Lonboard, and kepler.gl 3.x.
              </p>
            </div>

            <div
              className="p-4 rounded"
              style={{ background: "#29323C", border: "1px solid #3A414C" }}
            >
              <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>
                zstd + Trained Dictionary
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Tiles are compressed with zstd-3 by default. An optional zstd
                training dictionary shared across tiles drops payload size by
                20–40% on small or repetitive tiles.
              </p>
            </div>

            <div
              className="p-4 rounded"
              style={{ background: "#29323C", border: "1px solid #3A414C" }}
            >
              <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>
                Temporal Indexing & LOD
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Each tile carries inclusive <code>time_start</code>/<code>time_end</code>
                bounds and an optional temporal bucket size. <code>--temporal-lod</code>
                bakes a multi-resolution time pyramid as sidecar tiers so a client
                animating years of data at "month scale" picks the coarser tier.
              </p>
            </div>

            <div
              className="p-4 rounded"
              style={{ background: "#29323C", border: "1px solid #3A414C" }}
            >
              <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>
                Summary Tier
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Optional pre-aggregated low-zoom tier — H3 hex bins with
                user-defined aggregates (<code>magnitude:mean</code>,{" "}
                <code>count</code>, …). Readers dispatch between raw and summary
                tiers automatically, unlocking 100M+ scale point datasets.
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
                The index is sorted by (zoom, Hilbert curve) so spatially adjacent
                tiles cluster on disk and over the wire — better CDN cacheability
                and smaller seek footprints during pans.
              </p>
            </div>

            <div
              className="p-4 rounded"
              style={{ background: "#29323C", border: "1px solid #3A414C" }}
            >
              <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>
                Pre-tessellated Polygons
              </h3>
              <p style={{ color: "#6A7485", fontSize: "0.875rem", lineHeight: 1.6 }}>
                With <code>--pre-tessellate</code>, polygon tiles ship earcut
                triangle indices in a sidecar column. Renderers skip CPU
                tessellation on tile arrival — wins scale with vertex count.
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
            <code style={{ color: "#1FBAD6" }}>stt-build</code> converts a GeoParquet
            file into a <code>.stt</code> archive. Input is always GeoParquet —
            convert other formats with <code>ogr2ogr</code> first. The
            Arrow-native streaming pipeline (<code>--streaming-arrow</code>) keeps
            peak RSS bounded by one record batch plus the active tile-spill budget,
            so multi-GB inputs build on a laptop.
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
{`# Basic usage (GeoParquet → .stt, zstd by default)
stt-build -i data.parquet -o output.stt

# Auto-tune zoom range, bucket size and compression
stt-build -i earthquakes.parquet -o earthquakes.stt --auto

# Point dataset with explicit time field + zoom range
stt-build -i earthquakes.parquet \\
  --time-field time \\
  --time-format unix-ms \\
  --min-zoom 0 --max-zoom 8 \\
  --temporal-bucket 1d \\
  -o earthquakes.stt

# Add a H3 summary tier for 100M-scale point data
stt-build -i earthquakes.parquet -o earthquakes.stt \\
  --summary-tier h3 \\
  --summary-columns "magnitude:mean,magnitude:max" \\
  --summary-min-zoom 0 --summary-max-zoom 4

# Trajectories with per-feature start/end timestamps
stt-build -i taxi-trips.parquet \\
  --time-field pickup_ts --end-time-field dropoff_ts \\
  --time-format unix-ms \\
  --streaming-arrow \\
  -o taxi-trips.stt

# Polygon dataset with pre-tessellation
stt-build -i wildfires.parquet -o wildfires.stt \\
  --pre-tessellate

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
                  <td className="px-4 py-3">Column name containing timestamps (default <code>timestamp</code>)</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--end-time-field</td>
                  <td className="px-4 py-3">Optional end timestamp for features with duration</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--time-format</td>
                  <td className="px-4 py-3">Timestamp format: <code>iso8601</code> (default), <code>unix-ms</code>, or <code>unix-sec</code></td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--min-zoom, --max-zoom</td>
                  <td className="px-4 py-3">Zoom level range for tile generation (defaults 0/14)</td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--compression</td>
                  <td className="px-4 py-3">
                    <code>zstd</code> (default), <code>gzip</code>, or
                    <code> none</code>
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--temporal-bucket</td>
                  <td className="px-4 py-3">
                    Fixed temporal interval per tile (<code>1h</code>, <code>6h</code>,{" "}
                    <code>1d</code>, <code>30m</code>; default <code>1h</code>)
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--temporal-lod</td>
                  <td className="px-4 py-3">
                    Coarser bucket pyramid, e.g. <code>1d,30d</code> or
                    <code> 1d@8,30d@4</code>
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--summary-tier</td>
                  <td className="px-4 py-3">
                    Emit a pre-aggregated low-zoom tier (<code>h3</code> currently)
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--summary-columns</td>
                  <td className="px-4 py-3">
                    Aggregates per cell, e.g.{" "}
                    <code>magnitude:mean,magnitude:max,depth:sum</code>
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--streaming-arrow</td>
                  <td className="px-4 py-3">
                    Arrow-native streaming pipeline. Required for &gt;10 GB inputs.
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--pre-tessellate</td>
                  <td className="px-4 py-3">
                    Bake earcut triangles into polygon tiles (skips CPU
                    tessellation in the renderer)
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #3A414C" }}>
                  <td className="px-4 py-3 font-mono" style={{ color: "#1FBAD6" }}>--auto</td>
                  <td className="px-4 py-3">
                    Auto-tune zoom range, bucket size and compression from the
                    input (explicit flags still win)
                  </td>
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
            <code style={{ color: "#1FBAD6" }}>stt-generate</code> fetches showcase
            datasets, streams them to an intermediate GeoParquet file, and shells
            out to <code>stt-build</code> to produce the <code>.stt</code> archive.
            Output the archive (<code>.stt</code>) and the intermediate Parquet is
            cleaned up; output a <code>.parquet</code>/<code>.geoparquet</code>{" "}
            path to keep the columnar source for analysis or for piping into
            <code> stt-build</code> yourself.
          </p>

          <div
            className="rounded overflow-hidden mb-4"
            style={{ background: "#29323C", border: "1px solid #3A414C" }}
          >
            <pre
              className="p-4 overflow-x-auto code-block"
              style={{ color: "#A0A7B4" }}
            >
{`# Generate every showcase dataset as .stt archives
stt-generate all --output-dir examples/showcase/public/data

# Earthquakes from USGS (writes .stt; Parquet intermediate is cleaned up)
stt-generate earthquakes --output earthquakes.stt

# Same data, but keep the GeoParquet (skip archive build)
stt-generate earthquakes --output earthquakes.parquet

# Satellite orbits from CelesTrak TLE
stt-generate satellites --output satellites.stt

# Flight traffic from OpenSky
stt-generate flights --date 2020-01-06 --output flights.stt

# Build manually from the kept GeoParquet
stt-build -i earthquakes.parquet -o earthquakes.stt --auto`}
            </pre>
          </div>

          <p style={{ color: "#6A7485", fontSize: "0.875rem" }}>
            Available subcommands:{" "}
            <code style={{ color: "#A0A7B4" }}>earthquakes</code>,{" "}
            <code style={{ color: "#A0A7B4" }}>ais</code>,{" "}
            <code style={{ color: "#A0A7B4" }}>flights</code>,{" "}
            <code style={{ color: "#A0A7B4" }}>hurricanes</code>,{" "}
            <code style={{ color: "#A0A7B4" }}>wildfires</code>,{" "}
            <code style={{ color: "#A0A7B4" }}>nyc-rideshare</code>,{" "}
            <code style={{ color: "#A0A7B4" }}>nyc-taxi-points</code>,{" "}
            <code style={{ color: "#A0A7B4" }}>satellites</code>, and{" "}
            <code style={{ color: "#A0A7B4" }}>all</code>.
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
            Both <code style={{ color: "#1FBAD6" }}>@stt/deck.gl</code> and{" "}
            <code style={{ color: "#1FBAD6" }}>@stt/maplibre</code> handle loading
            automatically — pass a URL as the <code>data</code>/<code>url</code>{" "}
            option. Tile payloads decode synchronously via Arrow's{" "}
            <code>tableFromIPC</code>, no worker pool required.
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
            The layer fetches the header + index + metadata first, then streams
            tiles for the current viewport and time window. For lower-level access
            (raw Arrow tables, custom dispatch, OPFS caching), use the{" "}
            <code style={{ color: "#A0A7B4" }}>@stt/core</code> reader directly.
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

