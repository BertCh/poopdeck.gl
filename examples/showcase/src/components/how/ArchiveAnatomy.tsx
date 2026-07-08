import React from 'react';
import SpaceTimeCurve from './SpaceTimeCurve';
import { CubeInLineExplorer } from '../demo/CubeInLine';

/**
 * "Inside the archive" figures: the three-file layout, the cold-start
 * request count, paged-directory pruning, the directory internals table,
 * the space-time-curve blob layout figure, and the pack diagram
 * (blake3 dedup + HTTP range coalescing).
 */

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

const SubHead: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4
    className="font-display text-[13px] font-semibold"
    style={{ color: 'var(--ink-900)' }}
  >
    {children}
  </h4>
);

const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <div
    className={`rounded-lg p-4 ${className}`}
    style={{
      background: 'var(--surface)',
      border: '1px solid var(--hairline)',
    }}
  >
    {children}
  </div>
);

/* ── 1. File tree ─────────────────────────────────────────────────────── */

interface TreeRow {
  tree: string;
  badge?: string;
  tone?: 'warm' | 'cool';
  note?: string;
}

const TREE: TreeRow[] = [
  { tree: 'my-dataset/' },
  {
    tree: '├─ manifest.json',
    badge: 'mutable · ~1 kB',
    tone: 'warm',
    note: 'names the current directory + packs — the only short-TTL fetch',
  },
  { tree: '├─ index/' },
  {
    tree: '│  └─ 9c41…f2.sttd',
    badge: 'immutable',
    tone: 'cool',
    note: 'the tile directory, content-addressed by blake3 — cache forever',
  },
  { tree: '└─ packs/' },
  {
    tree: '   ├─ 0e49…b2.sttp',
    badge: 'immutable · ≤ 64 MiB target',
    tone: 'cool',
    note: 'zstd tile blobs, read with HTTP range requests (a single oversized blob gets its own larger pack — blobs are never split)',
  },
  { tree: '   └─ a7d3…91.sttp' },
];

const Badge: React.FC<{ tone: 'warm' | 'cool'; children: React.ReactNode }> = ({
  tone,
  children,
}) => (
  <span
    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
    style={
      tone === 'warm'
        ? { color: '#8a5a0a', background: 'rgba(240, 193, 75, 0.16)' }
        : { color: 'var(--accent)', background: 'var(--accent-soft)' }
    }
  >
    {children}
  </span>
);

const FileTree: React.FC = () => (
  <Card>
    <SubHead>Three kinds of file — one mutable, two immutable</SubHead>
    <div className="mt-3 space-y-1.5">
      {TREE.map((row) => (
        <div
          key={row.tree}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
        >
          <span
            className="whitespace-pre font-mono text-xs"
            style={{ color: 'var(--ink-700)' }}
          >
            {row.tree}
          </span>
          {row.badge ? (
            <Badge tone={row.tone ?? 'cool'}>{row.badge}</Badge>
          ) : null}
          {row.note ? (
            <span className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
              {row.note}
            </span>
          ) : null}
        </div>
      ))}
    </div>
    <p
      className="mt-3 pt-3 text-[11px] leading-relaxed"
      style={{
        color: 'var(--ink-400)',
        borderTop: '1px solid var(--hairline)',
      }}
    >
      A new build writes new hashed objects and flips one pointer in{' '}
      <span className="font-mono">manifest.json</span> — deploys are atomic and
      additive, and every heavy object is cacheable forever.
    </p>
  </Card>
);

/* ── 2. Cold start ────────────────────────────────────────────────────── */

const ColdStart: React.FC = () => {
  const steps = [
    { n: '1', t: 'GET manifest.json' },
    { n: '2', t: 'GET directory root page' },
    { n: '3', t: 'ranged GETs into packs' },
  ];
  return (
    <Card>
      <SubHead>Cold start = three round trips</SubHead>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {steps.map((s, i) => (
          <React.Fragment key={s.n}>
            {i > 0 ? (
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                aria-hidden="true"
                style={{ color: 'var(--ink-400)' }}
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
            ) : null}
            <span
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px]"
              style={{
                background: 'var(--surface-sunken)',
                border: '1px solid var(--hairline)',
                color: 'var(--ink-700)',
              }}
            >
              <span
                className="font-semibold"
                style={{ color: 'var(--accent)' }}
              >
                {s.n}
              </span>
              {s.t}
            </span>
          </React.Fragment>
        ))}
      </div>
      <p
        className="mt-3 text-[11px] leading-relaxed"
        style={{ color: 'var(--ink-500)' }}
      >
        After that, panning, zooming and scrubbing only issue range reads into
        immutable packs — there is no per-tile URL and no server doing work.
      </p>
    </Card>
  );
};

/* ── 3. Paged-directory pruning ───────────────────────────────────────── */

interface Leaf {
  id: string;
  zooms: string;
  bbox: { x: number; y: number; w: number; h: number }; // in a 24×14 world
  time: [number, number]; // 0..24 h
  verdict: 'fetch' | 'skip';
  reason?: string;
}

const LEAVES: Leaf[] = [
  {
    id: 'leaf 0',
    zooms: 'z 5–9',
    bbox: { x: 1, y: 1, w: 9, h: 12 },
    time: [0, 24],
    verdict: 'skip',
    reason: 'wrong place',
  },
  {
    id: 'leaf 1',
    zooms: 'z 5–9',
    bbox: { x: 13, y: 1, w: 10, h: 12 },
    time: [0, 12],
    verdict: 'fetch',
  },
  {
    id: 'leaf 2',
    zooms: 'z 5–9',
    bbox: { x: 13, y: 1, w: 10, h: 12 },
    time: [12, 24],
    verdict: 'skip',
    reason: 'wrong time',
  },
  {
    id: 'leaf 3',
    zooms: 'z 10–14',
    bbox: { x: 1, y: 1, w: 22, h: 12 },
    time: [0, 24],
    verdict: 'skip',
    reason: 'wrong zoom',
  },
];

const BboxMini: React.FC<{ leaf: Leaf; active: boolean }> = ({
  leaf,
  active,
}) => (
  <svg viewBox="0 0 24 14" width="34" height="20" aria-hidden="true">
    <rect
      x="0.5"
      y="0.5"
      width="23"
      height="13"
      rx="1.5"
      fill="none"
      stroke="var(--hairline)"
    />
    <rect
      x={leaf.bbox.x}
      y={leaf.bbox.y}
      width={leaf.bbox.w}
      height={leaf.bbox.h}
      rx="1"
      fill={active ? 'rgba(10,119,144,0.25)' : 'var(--surface-sunken)'}
      stroke={active ? 'var(--accent)' : 'var(--ink-400)'}
      strokeWidth="0.75"
    />
  </svg>
);

const TimeMini: React.FC<{ leaf: Leaf; active: boolean }> = ({
  leaf,
  active,
}) => (
  <svg viewBox="0 0 60 8" width="66" height="9" aria-hidden="true">
    <rect
      x="0.5"
      y="1.5"
      width="59"
      height="5"
      rx="2.5"
      fill="none"
      stroke="var(--hairline)"
    />
    <rect
      x={(leaf.time[0] / 24) * 58 + 1}
      y="2.5"
      width={((leaf.time[1] - leaf.time[0]) / 24) * 58}
      height="3"
      rx="1.5"
      fill={active ? 'var(--accent)' : 'var(--ink-400)'}
      opacity={active ? 0.85 : 0.5}
    />
  </svg>
);

const DirectoryPruning: React.FC = () => (
  <Card>
    <SubHead>The directory prunes before anything is fetched</SubHead>
    <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-500)' }}>
      The root page carries one 52-byte descriptor per leaf — zoom range, geo
      bbox and time span. Only leaves overlapping the query are downloaded.
    </p>
    <div
      className="mt-3 inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-[11px]"
      style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
    >
      query: northeast viewport × z 7 × 08:00–11:00
    </div>
    <div className="mt-3 space-y-1.5">
      {LEAVES.map((leaf) => {
        const active = leaf.verdict === 'fetch';
        return (
          <div
            key={leaf.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-3 py-2"
            style={{
              border: `1px solid ${active ? 'var(--accent)' : 'var(--hairline)'}`,
              background: active ? 'rgba(10,119,144,0.05)' : 'var(--surface)',
              opacity: active ? 1 : 0.72,
            }}
          >
            <span
              className="font-mono text-[11px] w-12"
              style={{ color: 'var(--ink-700)' }}
            >
              {leaf.id}
            </span>
            <span
              className="font-mono text-[11px] w-16"
              style={{ color: 'var(--ink-500)' }}
            >
              {leaf.zooms}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <BboxMini leaf={leaf} active={active} />
            </span>
            <span className="inline-flex items-center gap-1.5">
              <TimeMini leaf={leaf} active={active} />
            </span>
            <span
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={
                active
                  ? { color: '#ffffff', background: 'var(--accent)' }
                  : {
                      color: 'var(--ink-400)',
                      background: 'var(--surface-sunken)',
                    }
              }
            >
              {active ? 'fetch' : `skip — ${leaf.reason}`}
            </span>
          </div>
        );
      })}
    </div>
  </Card>
);

/* ── 3b. Directory internals: sorted keys + run-length encoding ───────── */

interface DirEntryRow {
  key: string;
  count: string;
  run?: { span: number; label: string; note: string; dedup?: boolean };
}

const DIR_ROWS: DirEntryRow[] = [
  {
    key: 'z7 · h2841 · 08:00',
    count: '214',
    run: {
      span: 3,
      label: 'run ×3 → pack 0 @ 0, 41 kB',
      note: 'three identical hours — blob columns written once',
      dedup: true,
    },
  },
  { key: 'z7 · h2841 · 09:00', count: '214' },
  { key: 'z7 · h2841 · 10:00', count: '214' },
  {
    key: 'z7 · h2841 · 11:00',
    count: '890',
    run: {
      span: 1,
      label: 'run ×1 → pack 0 @ 41 kB, 96 kB',
      note: 'offset stores 0 — it follows the previous blob',
    },
  },
  {
    key: 'z7 · h2842 · 08:00',
    count: '3 102',
    run: {
      span: 1,
      label: 'run ×1 → pack 0 @ 137 kB, 210 kB',
      note: 'next Hilbert cell — still sequential',
    },
  },
  {
    key: 'z7 · h2842 · 09:00',
    count: '2 977',
    run: { span: 1, label: 'run ×1 → pack 0 @ 347 kB, 205 kB', note: '' },
  },
];

const DIR_CHIPS = [
  'keys delta-code to ~1 byte (LEB128 + zig-zag)',
  'crc32c integrity tag per blob',
  '.sttd itself is zstd at rest (~2×)',
  'cover section: tight t_min per entry',
];

const DirectoryInternals: React.FC = () => (
  <Card>
    <SubHead>
      Deeper: inside the directory — sorted keys plus run-length encoding
    </SubHead>
    <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-500)' }}>
      Entries sort by (zoom, <em>hilbert(x, y)</em>, time) — the 2D walk drawn
      in the next figure — so consecutive keys differ by almost nothing and
      delta-code down to about a byte each.
    </p>
    <div className="mt-3">
      {/* RLE table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-[11px]">
          <thead>
            <tr style={{ color: 'var(--ink-400)' }}>
              <th className="text-left font-medium pb-1.5 pr-3">
                entry key (delta-coded)
              </th>
              <th className="text-right font-medium pb-1.5 pr-4">features</th>
              <th className="text-left font-medium pb-1.5">
                blob run (written once per run)
              </th>
            </tr>
          </thead>
          <tbody>
            {DIR_ROWS.map((row) => (
              <tr
                key={row.key}
                style={{ borderTop: '1px solid var(--hairline)' }}
              >
                <td
                  className="py-1.5 pr-3 font-mono"
                  style={{ color: 'var(--ink-700)' }}
                >
                  {row.key}
                </td>
                <td
                  className="py-1.5 pr-4 font-mono text-right"
                  style={{ color: 'var(--ink-500)' }}
                >
                  {row.count}
                </td>
                {row.run ? (
                  <td
                    rowSpan={row.run.span}
                    className="py-1.5 pl-3 align-middle"
                    style={{
                      borderLeft: `2px solid ${row.run.dedup ? 'var(--accent)' : 'var(--hairline)'}`,
                      background: row.run.dedup
                        ? 'rgba(10,119,144,0.05)'
                        : undefined,
                    }}
                  >
                    <span
                      className="font-mono block"
                      style={{
                        color: row.run.dedup
                          ? 'var(--accent)'
                          : 'var(--ink-700)',
                      }}
                    >
                      {row.run.label}
                    </span>
                    {row.run.note ? (
                      <span
                        className="block mt-0.5"
                        style={{ color: 'var(--ink-400)' }}
                      >
                        {row.run.note}
                      </span>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    <div
      className="mt-3 pt-3 flex flex-wrap gap-1.5"
      style={{ borderTop: '1px solid var(--hairline)' }}
    >
      {DIR_CHIPS.map((c) => (
        <span
          key={c}
          className="rounded px-1.5 py-0.5 text-[10px]"
          style={{
            background: 'var(--surface-sunken)',
            color: 'var(--ink-500)',
            border: '1px solid var(--hairline)',
          }}
        >
          {c}
        </span>
      ))}
    </div>
    <p
      className="mt-2 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      This is the temporal analogue of PMTiles collapsing identical ocean tiles
      across space: because the writer dedups byte-identical blobs, a cell that
      doesn't change across consecutive buckets costs one run instead of N
      entries' worth of blob columns. Tens of thousands of tiles index in a few
      hundred kilobytes.
    </p>
  </Card>
);

/* ── 4. Pack diagram: dedup + range coalescing ────────────────────────── */

const BLOBS = [
  { x: 60, w: 150 },
  { x: 212, w: 120 },
  { x: 334, w: 180 },
  { x: 516, w: 90 },
  { x: 608, w: 200 },
];

const TILE_CHIPS: { label: string; x: number; blob: number }[] = [
  { label: 'z7·x41·y52·t08', x: 60, blob: 0 },
  { label: 'z7·x41·y52·t09', x: 190, blob: 1 },
  { label: 'z7·x41·y52·t10', x: 320, blob: 2 },
  { label: 'z7·x41·y52·t11', x: 450, blob: 2 }, // ← dedup: identical bytes
  { label: 'z7·x41·y53·t09', x: 580, blob: 3 },
  { label: 'z7·x41·y53·t10', x: 710, blob: 4 },
];

const CHIP_W = 112;
const CHIP_Y = 46;
const PACK_Y = 152;

const PackDiagram: React.FC = () => (
  <Card>
    <SubHead>Packs — dedup by content, fetch by range</SubHead>
    <div className="overflow-x-auto">
      <svg
        viewBox="0 0 920 244"
        className="w-full min-w-[720px]"
        role="img"
        aria-label="Diagram: directory entries point into a pack of zstd blobs; two identical time buckets share one blob, and adjacent blobs are fetched with a single coalesced HTTP range request."
      >
        <text x="60" y="26" fontSize="11" fill="var(--ink-500)">
          directory entries (tile addresses)…
        </text>

        {/* tile chips */}
        {TILE_CHIPS.map((c) => {
          const dedup = c.blob === 2;
          return (
            <g key={c.label}>
              <rect
                x={c.x}
                y={CHIP_Y - 14}
                width={CHIP_W}
                height={22}
                rx="5"
                fill={dedup ? 'var(--accent-soft)' : 'var(--surface-sunken)'}
                stroke={dedup ? 'var(--accent)' : 'var(--hairline)'}
              />
              <text
                x={c.x + CHIP_W / 2}
                y={CHIP_Y + 1}
                fontSize="10"
                fontFamily={MONO}
                textAnchor="middle"
                fill={dedup ? 'var(--accent)' : 'var(--ink-700)'}
              >
                {c.label}
              </text>
            </g>
          );
        })}

        {/* connectors */}
        {TILE_CHIPS.map((c) => {
          const blob = BLOBS[c.blob];
          const dedup = c.blob === 2;
          return (
            <path
              key={c.label}
              d={`M ${c.x + CHIP_W / 2} ${CHIP_Y + 10} C ${c.x + CHIP_W / 2} ${CHIP_Y + 60}, ${blob.x + blob.w / 2} ${PACK_Y - 50}, ${blob.x + blob.w / 2} ${PACK_Y - 2}`}
              fill="none"
              stroke={dedup ? 'var(--accent)' : 'var(--ink-400)'}
              strokeWidth={dedup ? 1.5 : 1}
              opacity={dedup ? 0.9 : 0.55}
            />
          );
        })}

        {/* dedup callout */}
        <text
          x="440"
          y="118"
          fontSize="10.5"
          fontWeight="600"
          fill="var(--accent)"
          textAnchor="middle"
        >
          identical bytes → one blob (blake3)
        </text>

        {/* pack frame */}
        <text
          x="48"
          y={PACK_Y - 12}
          fontSize="11"
          fontFamily={MONO}
          fill="var(--ink-500)"
        >
          packs/0e49f7a4….sttp
        </text>
        <rect
          x="48"
          y={PACK_Y}
          width="800"
          height="40"
          rx="6"
          fill="none"
          stroke="var(--ink-400)"
        />
        {BLOBS.map((b, i) => (
          <g key={i}>
            <rect
              x={b.x}
              y={PACK_Y + 5}
              width={b.w}
              height={30}
              rx="4"
              fill={i === 2 ? 'rgba(10,119,144,0.16)' : 'var(--surface-sunken)'}
              stroke={i === 2 ? 'var(--accent)' : 'var(--hairline)'}
            />
            <text
              x={b.x + b.w / 2}
              y={PACK_Y + 24}
              fontSize="10"
              fontFamily={MONO}
              textAnchor="middle"
              fill={i === 2 ? 'var(--accent)' : 'var(--ink-500)'}
            >
              zstd blob
            </text>
          </g>
        ))}
        <text
          x="828"
          y={PACK_Y + 24}
          fontSize="12"
          fill="var(--ink-400)"
          textAnchor="middle"
        >
          …
        </text>

        {/* coalesced-range bracket under blobs 1–3 */}
        <path
          d={`M 212 ${PACK_Y + 52} v 6 H 606 v -6`}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.25"
        />
        <text
          x="409"
          y={PACK_Y + 76}
          fontSize="10.5"
          fontWeight="600"
          textAnchor="middle"
          fill="var(--accent)"
        >
          one coalesced HTTP range request (gaps ≤ 2 MiB are fused)
        </text>
      </svg>
    </div>
  </Card>
);

const ArchiveAnatomy: React.FC = () => (
  <div className="space-y-4">
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <FileTree />
      <div className="flex flex-col gap-4">
        <ColdStart />
      </div>
    </div>
    <DirectoryPruning />
    <DirectoryInternals />
    <SpaceTimeCurve />
    <CubeInLineExplorer
      title="Deeper still: the same walk on real archives"
      blurb={
        <>
          The cube above is idealized — every cell full. Real archives are
          sparse and lopsided, and that shape is exactly what{' '}
          <span style={{ fontFamily: MONO }}>--blob-ordering auto</span> reads
          to pick a walk. Switch datasets and watch the winner flip: a buoy's
          multi-year track over a few cells wants{' '}
          <span style={{ fontFamily: MONO }}>spatial</span>; a day of flights
          wants the 3D-Hilbert generalist. Density is sampled from each
          archive's directory.
        </>
      }
    />
    <PackDiagram />
  </div>
);

export default ArchiveAnatomy;
