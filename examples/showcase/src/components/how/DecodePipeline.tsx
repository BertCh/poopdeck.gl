import React from 'react';

/**
 * "Off-thread decode + two-tier cache" figure: what happens to a fetched pack
 * byte-range on the consumer side, and why 60 fps streaming holds while a
 * second visit is instant.
 *
 * A pack slice is dispatched to a POOL of Web Workers (least-pending wins) so
 * the deck.gl render loop never blocks. Each worker zstd-decompresses (fzstd —
 * pure JS, ~30 kB, no WASM), parses the Arrow IPC stream, extracts the column
 * buffers, then TRANSFERS them back zero-copy. A tile scrolled off-view cancels
 * its in-flight decode. Two cache tiers short-circuit the path: an in-memory
 * LRU of compressed bytes under a device-aware cap, and an opt-in OPFS store of
 * decompressed payloads keyed by the content-addressed directory fingerprint.
 *
 * Evidence: packages/core/src/tile-decoder.ts (WorkerTileDecoder — pool sized
 * max(2, min(4, cores−1)), least-pending pick, cancel message, Transferables),
 * compression.ts (fzstd ~30 kB pure JS, no WASM), archive.ts (device-aware
 * byteCache + content-addressed fingerprint), opfs-cache.ts (512 MB default,
 * quota-clamped, keyed by the fingerprint so redeploy invalidates cleanly).
 */

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

const Box: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  sub2?: string;
  accent?: boolean;
  faint?: boolean;
}> = ({ x, y, w, h, title, sub, sub2, accent, faint }) => (
  <g opacity={faint ? 0.5 : 1}>
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx="6"
      fill={accent ? 'var(--accent-soft)' : 'var(--surface-sunken)'}
      stroke={accent ? 'var(--accent)' : 'var(--ink-400)'}
      strokeWidth="1"
    />
    <text
      x={x + w / 2}
      y={sub ? y + 20 : y + h / 2 + 4}
      fontSize="11"
      fontWeight="600"
      fontFamily={MONO}
      textAnchor="middle"
      fill="var(--ink-900)"
    >
      {title}
    </text>
    {sub ? (
      <text
        x={x + w / 2}
        y={y + 34}
        fontSize="9"
        textAnchor="middle"
        fill="var(--ink-500)"
      >
        {sub}
      </text>
    ) : null}
    {sub2 ? (
      <text
        x={x + w / 2}
        y={y + 46}
        fontSize="8.5"
        textAnchor="middle"
        fill="var(--ink-400)"
      >
        {sub2}
      </text>
    ) : null}
  </g>
);

/** A labeled bezier arrow. */
const Arrow: React.FC<{ d: string; accent?: boolean; bold?: boolean }> = ({
  d,
  accent,
  bold,
}) => (
  <path
    d={d}
    fill="none"
    stroke={accent ? 'var(--accent)' : 'var(--ink-400)'}
    strokeWidth={bold ? 1.5 : 1}
    opacity={accent ? 0.85 : 0.7}
    markerEnd={accent ? 'url(#dp-arr-accent)' : 'url(#dp-arr)'}
  />
);

/** One decode stage chip inside the worker card. */
const Stage: React.FC<{ x: number; top: string; bottom: string }> = ({
  x,
  top,
  bottom,
}) => (
  <g>
    <rect
      x={x}
      y={296}
      width={96}
      height={48}
      rx="4"
      fill="var(--surface)"
      stroke="var(--hairline)"
      strokeWidth="1"
    />
    <text
      x={x + 48}
      y={316}
      fontSize="9.5"
      fontWeight="600"
      fontFamily={MONO}
      textAnchor="middle"
      fill="var(--ink-900)"
    >
      {top}
    </text>
    <text
      x={x + 48}
      y={330}
      fontSize="8"
      textAnchor="middle"
      fill="var(--accent)"
    >
      {bottom}
    </text>
  </g>
);

const CALLOUTS = [
  'least-pending dispatch',
  'cancel on scroll-off',
  'redeploy ⇒ new fingerprint ⇒ clean invalidation',
];

const DecodePipeline: React.FC = () => (
  <div
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
      Fetched bytes decode on a worker pool; two cache tiers skip the work
      entirely
    </h4>

    <div className="mt-3 overflow-x-auto">
      <svg
        viewBox="0 0 1000 470"
        className="w-full min-w-[820px]"
        role="img"
        aria-label="Diagram: the UI thread hands a fetched pack slice to a pool of Web Workers that zstd-decompress, parse Arrow IPC and extract column buffers, transferring them back zero-copy. A two-tier cache — an in-memory compressed LRU and an on-disk OPFS store of decompressed payloads keyed by the directory fingerprint — short-circuits the network and the decode."
      >
        <defs>
          <marker
            id="dp-arr"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--ink-400)" />
          </marker>
          <marker
            id="dp-arr-accent"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--accent)" />
          </marker>
        </defs>

        {/* ── UI thread (left) ─────────────────────────────────────────── */}
        <Box
          x={30}
          y={190}
          w={150}
          h={96}
          title="UI thread"
          sub="deck.gl render loop"
          accent
        />
        <text
          x={105}
          y={306}
          fontSize="9.5"
          fontWeight="600"
          textAnchor="middle"
          fill="var(--accent)"
        >
          stays at 60 fps
        </text>
        <text
          x={105}
          y={319}
          fontSize="9"
          textAnchor="middle"
          fill="var(--ink-500)"
        >
          never decodes on-thread
        </text>

        {/* ── Two-tier cache (top center) ──────────────────────────────── */}
        <text
          x={520}
          y={18}
          fontSize="10.5"
          fontWeight="600"
          textAnchor="middle"
          fill="var(--ink-700)"
        >
          two-tier cache — checked first
        </text>
        <Box
          x={380}
          y={26}
          w={280}
          h={52}
          title="RAM"
          sub="in-memory LRU · compressed bytes"
          sub2="device-aware cap (scales w/ deviceMemory)"
          accent
        />
        <Box
          x={380}
          y={82}
          w={280}
          h={52}
          title="OPFS"
          sub="on-disk · decompressed payloads (opt-in)"
          sub2="keyed by directory fingerprint · 512 MB"
        />

        {/* ── Network (top right) ──────────────────────────────────────── */}
        <Box
          x={720}
          y={44}
          w={210}
          h={76}
          title="network"
          sub="HTTP range read"
          sub2="content-addressed pack (R2)"
        />

        {/* ── Worker pool (center) — stacked cards imply N ─────────────── */}
        <rect
          x={342}
          y={232}
          width={340}
          height={150}
          rx="6"
          fill="var(--surface-sunken)"
          stroke="var(--hairline)"
          strokeWidth="1"
          opacity="0.55"
        />
        <rect
          x={351}
          y={241}
          width={340}
          height={150}
          rx="6"
          fill="var(--surface-sunken)"
          stroke="var(--hairline)"
          strokeWidth="1"
          opacity="0.75"
        />
        <rect
          x={360}
          y={250}
          width={340}
          height={150}
          rx="6"
          fill="var(--surface)"
          stroke="var(--ink-400)"
          strokeWidth="1"
        />
        <text
          x={374}
          y={272}
          fontSize="11"
          fontWeight="600"
          fontFamily={MONO}
          fill="var(--ink-900)"
        >
          worker
        </text>
        <text x={430} y={272} fontSize="9" fill="var(--ink-500)">
          pool · N = max(2, min(4, cores−1))
        </text>

        <Stage x={372} top="decompress" bottom="zstd · ~30 kB JS" />
        <Stage x={482} top="parse" bottom="Arrow IPC" />
        <Stage x={592} top="extract" bottom="column buffers" />
        <Arrow d="M 468 320 L 480 320" />
        <Arrow d="M 578 320 L 590 320" />
        <text
          x={530}
          y={368}
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          each buffer is TRANSFERRED back — moved, not copied
        </text>

        {/* ── Arrows ───────────────────────────────────────────────────── */}
        {/* 1. UI → cache lookup */}
        <Arrow d="M 180 208 C 262 192, 300 60, 376 48" />
        <text
          x={300}
          y={112}
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--ink-500)"
        >
          getTile(z,x,y,t) → look up cache
        </text>

        {/* 2. OPFS hit → straight back to UI (skips workers) */}
        <Arrow d="M 378 110 C 296 142, 250 214, 184 244" accent />
        <text
          x={276}
          y={200}
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--accent)"
        >
          OPFS hit · decoded
        </text>
        <text
          x={276}
          y={212}
          fontSize="8"
          textAnchor="middle"
          fill="var(--accent)"
        >
          → straight to UI (skips workers)
        </text>

        {/* 3. RAM hit → workers */}
        <Arrow d="M 520 136 C 520 180, 528 208, 530 248" />
        <text x={538} y={192} fontSize="8.5" fill="var(--ink-500)">
          RAM hit · compressed
        </text>
        <text x={538} y={204} fontSize="8.5" fill="var(--ink-500)">
          → decode
        </text>

        {/* 4. both miss → network */}
        <Arrow d="M 662 84 L 716 74" />
        <text
          x={688}
          y={64}
          fontSize="8"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          both miss
        </text>

        {/* 5. network → workers */}
        <Arrow d="M 812 122 C 792 172, 742 212, 694 248" />
        <text
          x={772}
          y={200}
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--ink-500)"
        >
          fetched pack → decode
        </text>

        {/* 6. workers → UI: zero-copy column buffers */}
        <Arrow d="M 360 344 C 280 344, 232 300, 184 278" accent bold />
        <text
          x={262}
          y={412}
          fontSize="9"
          textAnchor="middle"
          fill="var(--accent)"
        >
          zero-copy transfer
        </text>
        <text
          x={262}
          y={424}
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--ink-500)"
        >
          column buffers → GPU
        </text>

        {/* cancel note near worker */}
        <text
          x={530}
          y={384}
          fontSize="8"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          scroll a tile off-view ⇒ its in-flight decode is cancelled mid-pool
        </text>
      </svg>
    </div>

    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {CALLOUTS.map((c) => (
        <span
          key={c}
          className="rounded px-1.5 py-0.5 font-mono text-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          {c}
        </span>
      ))}
    </div>

    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      Decoding one tile inline is ~5–20 ms of decompress +{' '}
      <span className="font-mono">tableFromIPC</span> + buffer extraction — a
      whole frame gone. So the archive hands each fetched slice to a small
      worker pool instead, picks the least-pending worker, and transfers the
      decoded typed-array buffers back zero-copy; the render loop never touches
      the work. That is why streaming holds 60 fps. The two-tier cache is why a{' '}
      <em>second</em> visit is instant: a warm RAM hit skips the network, and an
      OPFS hit skips the network <em>and</em> the zstd step, returning a decoded
      payload straight to the UI. Because the OPFS key is the content-addressed
      directory fingerprint, a redeploy mints a new key and the stale tiles
      simply stop being found — no walk-and-delete.
    </p>
  </div>
);

export default DecodePipeline;
