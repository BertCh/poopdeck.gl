import React from 'react';

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
    q: 'Why static files instead of a tile server?',
    a: 'Tiling cost is paid once, at build. Serving is any object store behind any CDN — no capacity planning, nothing to fall over under load, and archives work offline or air-gapped. The entire runtime contract is HTTP GET plus range requests.',
  },
  {
    q: 'Static files — but can a tile be generated on the fly?',
    a: (
      <>
        Yes, and it is the same tile. The offline tiler and the on-demand{' '}
        <span className="font-mono">stt-serve</span> share one{' '}
        <span className="font-mono">EncoderConfig</span> and per-tile encode
        path, so a dynamically served tile is <em>byte-identical</em> to what a
        batch build would have written — a live PostGIS or DuckDB query can back
        the map, and static hosting stays the default rather than the only mode.
      </>
    ),
  },
  {
    q: 'Why Apache Arrow for the payload?',
    a: (
      <>
        Columns arrive GPU-shaped and slice zero-copy, and the same schema opens
        in Rust, JS and Python with stock libraries. Everything the format adds
        rides in metadata rather than side files — the dataset-constant part in
        the schema itself (<span className="font-mono">stt:quant</span>), the
        per-tile part in the frame's own{' '}
        <span className="font-mono">TILE_META</span> section.
      </>
    ),
  },
  {
    q: 'How does the format add features without breaking readers?',
    a: (
      <>
        Two rules. Additive columns need no announcement — a reader that doesn't
        know <span className="font-mono">part_offsets</span> ignores it. But a
        feature that <em>re-types</em> an existing column (quantized coordinates
        become integers) would make an old reader silently misdecode rather than
        fail, so each one declares itself in{' '}
        <span className="font-mono">manifest.capabilities</span> and a reader
        that lacks it must refuse the dataset at open. Silent wrongness is the
        only failure mode the format treats as unacceptable.
      </>
    ),
  },
  {
    q: 'Why zstd per blob, with no shared dictionary?',
    a: 'Every blob decodes alone, which is what makes random access real: any tile is readable from a single range read, the browser decoder is ~30 kB of pure JS, and caching never depends on fetching a dictionary first.',
  },
  {
    q: 'Why packs instead of a file per tile?',
    a: 'Millions of tiny objects make deploys, listings and cold caches slow. Packs target 64 MiB (blobs are never split), stay far under CDN object caps, upload in seconds and serve precise range reads — with gap coalescing fusing neighbours into one request.',
  },
  {
    q: 'Why blake3 content addressing?',
    a: 'One hash is simultaneously the dedup key, the cache key and the integrity check. Immutable URLs cache forever, a deploy is an atomic manifest pointer flip, stale objects age out via retention, and corruption is detectable end to end (crc32c guards each blob besides).',
  },
  {
    q: 'Why animate in the shader?',
    a: 'Rebuilding buffers per frame caps out orders of magnitude below what GPUs can draw. Attributes upload once; a frame is a handful of uniform writes — which is why a million features scrub at 60 fps and why scrubbing backwards is free.',
  },
  {
    q: 'Why four renderers over one kernel?',
    a: "Teams already own a map stack. Decode, streaming, the clock and the definition of the gate math are shared; only the last inch is per-host — GLSL for deck.gl and MapLibre, TSL for Three's WebGPU path, a custom Appearance for Cesium — and conformance tests pin every one of those to the same CPU oracle.",
  },
  {
    q: 'Are builds reproducible?',
    a: (
      <>
        Byte-for-byte, across processes. Blob order and directory order carry
        total tiebreaks, and the encoder assembles every metadata key from
        sorted maps that Arrow ≥59 then serializes in that order — so an
        unchanged dataset rebuilt in a fresh process re-derives identical
        content addresses, nothing re-uploads, and identical tiles across
        datasets share one physical object. (This was the format's one open gap
        under Arrow 54, whose writer emitted metadata in hash-map order; a
        formerly-<span className="font-mono">#[ignore]</span>d canary test now
        guards it.)
      </>
    ),
  },
  {
    q: 'What happens if you never tune it?',
    a: (
      <>
        Nothing is taken away. Every size budget and quantization lever is inert
        unless you opt in, so an untuned build is byte-identical to one you
        never analyzed — the <strong>no-thinning</strong> rule. Run{' '}
        <span className="font-mono">--auto</span> or{' '}
        <span className="font-mono">--publish</span> and any flag you set
        explicitly still wins (resolved from clap's{' '}
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
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--hairline)',
        }}
      >
        <h4
          className="font-display text-[13px] font-semibold"
          style={{ color: 'var(--ink-900)' }}
        >
          {d.q}
        </h4>
        <p
          className="mt-1.5 text-[11.5px] leading-relaxed"
          style={{ color: 'var(--ink-500)' }}
        >
          {d.a}
        </p>
      </div>
    ))}
  </div>
);

export default DesignDecisions;
