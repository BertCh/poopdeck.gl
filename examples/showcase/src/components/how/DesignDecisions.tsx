import React from "react";

/**
 * "Why it's built this way" — the format's locked-in choices and their
 * rationale, condensed from the packed-format spec's design-decisions
 * section (docs/spec/stt-packed-format.md §7).
 */

interface Decision {
  q: string;
  a: React.ReactNode;
}

const DECISIONS: Decision[] = [
  {
    q: "Why static files instead of a tile server?",
    a: "Tiling cost is paid once, at build. Serving is any object store behind any CDN — no capacity planning, nothing to fall over under load, and archives work offline or air-gapped. The entire runtime contract is HTTP GET plus range requests.",
  },
  {
    q: "Static files — but can a tile be generated on the fly?",
    a: (
      <>
        Yes, and it is the same tile. The offline tiler and the on-demand{" "}
        <span className="font-mono">stt-serve</span> share one{" "}
        <span className="font-mono">EncoderConfig</span> and per-tile encode
        path, so a dynamically served tile is <em>byte-identical</em> to what a
        batch build would have written — a live PostGIS or DuckDB query can back
        the map, and static hosting stays the default rather than the only mode.
      </>
    ),
  },
  {
    q: "Why Apache Arrow for the payload?",
    a: (
      <>
        Columns arrive GPU-shaped and slice zero-copy, the same schema opens in
        Rust, JS and Python with stock libraries, and field metadata carries
        the format's affines (<span className="font-mono">stt:quant</span>,{" "}
        <span className="font-mono">stt:qa</span>) without side files.
      </>
    ),
  },
  {
    q: "Why zstd per blob, with no shared dictionary?",
    a: "Every blob decodes alone, which is what makes random access real: any tile is readable from a single range read, the browser decoder is ~30 kB of pure JS, and caching never depends on fetching a dictionary first.",
  },
  {
    q: "Why packs instead of a file per tile?",
    a: "Millions of tiny objects make deploys, listings and cold caches slow. Packs target 64 MiB (blobs are never split), stay far under CDN object caps, upload in seconds and serve precise range reads — with gap coalescing fusing neighbours into one request.",
  },
  {
    q: "Why blake3 content addressing?",
    a: "One hash is simultaneously the dedup key, the cache key and the integrity check. Immutable URLs cache forever, a deploy is an atomic manifest pointer flip, stale objects age out via retention, and corruption is detectable end to end (crc32c guards each blob besides).",
  },
  {
    q: "Why animate in the shader?",
    a: "Rebuilding buffers per frame caps out orders of magnitude below what GPUs can draw. Attributes upload once; a frame is a handful of uniform writes — which is why a million features scrub at 60 fps and why scrubbing backwards is free.",
  },
  {
    q: "Why four renderers over one kernel?",
    a: "Teams already own a map stack. Decode, streaming, the clock and the gate math are shared; each backend is a thin dialect of the same kernel — GLSL for deck.gl and MapLibre, TSL for Three's WebGPU path, primitives for Cesium.",
  },
  {
    q: "Are builds reproducible?",
    a: "Deliberately, in layers: blob order and directory order carry total tiebreaks, so identical payload bytes always re-derive identical content addresses. One honest gap remains — Arrow serializes field metadata in hash-map order, which can differ across processes; a cache-efficiency issue (never correctness), tracked for an upstream fix.",
  },
  {
    q: "What happens if you never tune it?",
    a: (
      <>
        Nothing is taken away. Every size budget and quantization lever is inert
        unless you opt in, so an untuned build is byte-identical to one you never
        analyzed — the <strong>no-thinning</strong> rule. Run{" "}
        <span className="font-mono">--auto</span> or{" "}
        <span className="font-mono">--publish</span> and any flag you set
        explicitly still wins (resolved from clap's{" "}
        <span className="font-mono">ValueSource</span>, not sentinels), while
        lossy advice is surfaced loudly but never applied for you.
      </>
    ),
  },
];

const DesignDecisions: React.FC = () => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    {DECISIONS.map((d) => (
      <div
        key={d.q}
        className="rounded-lg p-4"
        style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
      >
        <h4 className="font-display text-[13px] font-semibold" style={{ color: "var(--ink-900)" }}>
          {d.q}
        </h4>
        <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--ink-500)" }}>
          {d.a}
        </p>
      </div>
    ))}
  </div>
);

export default DesignDecisions;
