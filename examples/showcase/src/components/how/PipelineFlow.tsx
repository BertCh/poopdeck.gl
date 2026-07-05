import React from "react";

/**
 * The end-to-end pipeline flowchart for the "How it works" page: four stages
 * (source → build → publish → play) rendered as HTML cards so the text stays
 * crisp and wraps responsively — arrows point right on desktop, down when the
 * stages stack on mobile.
 */

interface Stage {
  n: string;
  label: string;
  title: string;
  steps: { t: string; d?: string }[];
  foot?: string;
}

const STAGES: Stage[] = [
  {
    n: "01",
    label: "Source",
    title: "Rows with geometry + time",
    steps: [
      { t: "GeoParquet / Parquet", d: "WKB, GeoArrow or lon/lat columns" },
      { t: "PostGIS", d: "--postgres · table or SQL, reprojected server-side" },
      { t: "DuckDB", d: "--duckdb · scans CSV, GeoJSON & Parquet too" },
    ],
    foot: "Every row: a point, line or polygon in WGS84 plus start (and optional end) timestamps.",
  },
  {
    n: "02",
    label: "Build",
    title: "stt-build — the Rust tiler",
    steps: [
      { t: "Normalize time", d: "ISO 8601 / unix → milliseconds" },
      { t: "Tile in space", d: "Web-Mercator z/x/y across the zoom range" },
      { t: "Cut in time", d: "each tile splits into buckets (default 1 h)" },
      { t: "Encode", d: "Arrow IPC columns, GeoArrow geometry" },
      { t: "Compress + dedup", d: "zstd per blob, blake3 collapses identical bytes" },
      { t: "Pack", d: "blobs packed into ≤ 64 MiB objects + a directory" },
    ],
    foot: "cargo install spatiotemporal-tiles",
  },
  {
    n: "03",
    label: "Publish",
    title: "A folder of static files",
    steps: [
      { t: "manifest.json", d: "tiny + mutable — names the current build" },
      { t: "index/<blake3>.sttd", d: "the tile directory, immutable" },
      { t: "packs/<blake3>.sttp", d: "tile blobs, immutable, range-read" },
    ],
    foot: "Any object store behind any CDN. No tile server, no database, cache-forever URLs.",
  },
  {
    n: "04",
    label: "Play",
    title: "Streamed like video",
    steps: [
      { t: "@poopdeck.gl/core", d: "range requests, off-thread Arrow decode" },
      { t: "@poopdeck.gl/playback", d: "clock + buffering governor" },
      { t: "GPU time gate", d: "two uniforms per frame, zero rebuilds" },
      { t: "Four renderers", d: "deck.gl · MapLibre · Three (WebGPU) · Cesium" },
    ],
    foot: "npm i @poopdeck.gl/layers",
  },
];

const Arrow: React.FC = () => (
  <div className="flex items-center justify-center py-1 lg:py-0 lg:px-0.5">
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      className="rotate-90 lg:rotate-0"
      style={{ color: "var(--ink-400)" }}
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 12h13M13 6l6 6-6 6"
      />
    </svg>
  </div>
);

const StageCard: React.FC<{ stage: Stage }> = ({ stage }) => (
  <div
    className="rounded-lg p-4 flex flex-col"
    style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
  >
    <div className="flex items-baseline gap-2">
      <span
        className="font-mono text-[11px] font-semibold"
        style={{ color: "var(--accent)" }}
      >
        {stage.n}
      </span>
      <span className="eyebrow">{stage.label}</span>
    </div>
    <h3
      className="font-display text-sm font-semibold mt-1.5"
      style={{ color: "var(--ink-900)" }}
    >
      {stage.title}
    </h3>
    <ul className="mt-3 space-y-2 flex-1">
      {stage.steps.map((s) => (
        <li key={s.t} className="flex gap-2 text-xs leading-snug">
          <span
            aria-hidden="true"
            className="mt-[5px] h-[5px] w-[5px] shrink-0 rounded-full"
            style={{ background: "var(--accent)", opacity: 0.55 }}
          />
          <span>
            <span className="font-medium" style={{ color: "var(--ink-700)" }}>
              {s.t}
            </span>
            {s.d ? (
              <span style={{ color: "var(--ink-500)" }}> — {s.d}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
    {stage.foot ? (
      <p
        className={`mt-3 pt-3 text-[11px] leading-snug ${
          stage.foot.startsWith("cargo") || stage.foot.startsWith("npm")
            ? "font-mono"
            : ""
        }`}
        style={{
          color: "var(--ink-400)",
          borderTop: "1px solid var(--hairline)",
        }}
      >
        {stage.foot}
      </p>
    ) : null}
  </div>
);

const PipelineFlow: React.FC = () => (
  <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch">
    {STAGES.map((stage, i) => (
      <React.Fragment key={stage.n}>
        {i > 0 ? <Arrow /> : null}
        <StageCard stage={stage} />
      </React.Fragment>
    ))}
  </div>
);

export default PipelineFlow;
