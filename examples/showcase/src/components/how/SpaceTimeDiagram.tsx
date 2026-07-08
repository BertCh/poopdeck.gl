import React from 'react';
import { useReducedMotion } from '../../lib/reducedMotion';

/**
 * The core-idea diagram: tiles are cut in space (Web-Mercator z/x/y) AND in
 * time (fixed buckets per tile), so a tile address is (z, x, y, t) and the
 * viewer only fetches the intersection of viewport × zoom × time window.
 *
 * The playhead drifts slowly on its own (gated on `useReducedMotion`, stops
 * for good once the user grabs the slider) so the "video over tiles" idea
 * reads at a glance.
 */

const BUCKETS = 12;
const X0 = 300; // left edge of the bucket row
const PITCH = 50;
const BUCKET_W = 44;
const BUCKET_Y = 130;
const BUCKET_H = 56;
const RUNWAY = 2.5; // buckets of lookahead past the playhead

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

/** Deterministic little "feature" dots inside each bucket. */
const DOTS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [12, 18],
    [30, 38],
  ],
  [
    [10, 34],
    [24, 14],
    [34, 42],
  ],
  [
    [16, 24],
    [32, 30],
  ],
  [
    [8, 40],
    [20, 20],
    [30, 44],
    [36, 12],
  ],
  [
    [14, 30],
    [28, 16],
  ],
  [
    [10, 14],
    [22, 40],
    [34, 24],
  ],
  [
    [18, 36],
    [30, 12],
  ],
  [
    [8, 22],
    [22, 30],
    [36, 40],
  ],
  [
    [14, 12],
    [26, 44],
  ],
  [
    [10, 28],
    [24, 18],
    [34, 36],
  ],
  [
    [16, 42],
    [28, 26],
  ],
  [
    [12, 20],
    [26, 36],
    [36, 16],
  ],
];

type BucketState = 'played' | 'current' | 'buffered' | 'fetching' | 'idle';

function bucketState(b: number, playhead: number): BucketState {
  const cur = Math.floor(playhead);
  if (b === cur) return 'current';
  if (b < cur) return 'played';
  if (b <= cur + Math.floor(RUNWAY)) return 'buffered';
  if (b === cur + Math.floor(RUNWAY) + 1) return 'fetching';
  return 'idle';
}

const BUCKET_STYLE: Record<
  BucketState,
  { fill: string; stroke: string; dash?: string; dot: string }
> = {
  played: {
    fill: 'var(--surface-sunken)',
    stroke: 'var(--hairline)',
    dot: 'var(--ink-400)',
  },
  current: { fill: 'var(--accent)', stroke: 'var(--accent)', dot: '#ffffff' },
  buffered: {
    fill: 'rgba(10, 119, 144, 0.14)',
    stroke: 'var(--accent)',
    dot: 'var(--accent)',
  },
  fetching: {
    fill: 'none',
    stroke: 'var(--accent)',
    dash: '4 3',
    dot: 'var(--ink-400)',
  },
  idle: { fill: 'none', stroke: 'var(--hairline)', dot: 'var(--ink-400)' },
};

const LEGEND: { label: string; state: BucketState }[] = [
  { label: 'played', state: 'played' },
  { label: 'on screen', state: 'current' },
  { label: 'buffered runway', state: 'buffered' },
  { label: 'fetching', state: 'fetching' },
  { label: 'not requested', state: 'idle' },
];

/** One level of the zoom pyramid: an s×s square with an n×n grid. */
const PyramidLevel: React.FC<{
  x: number;
  y: number;
  s: number;
  n: number;
  highlight?: { col: number; row: number; span: number };
  label: string;
}> = ({ x, y, s, n, highlight, label }) => {
  const cell = s / n;
  const lines: React.ReactNode[] = [];
  for (let i = 1; i < n; i++) {
    lines.push(
      <line
        key={`v${i}`}
        x1={x + i * cell}
        y1={y}
        x2={x + i * cell}
        y2={y + s}
        stroke="var(--hairline)"
        strokeWidth="1"
      />,
      <line
        key={`h${i}`}
        x1={x}
        y1={y + i * cell}
        x2={x + s}
        y2={y + i * cell}
        stroke="var(--hairline)"
        strokeWidth="1"
      />,
    );
  }
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={s}
        height={s}
        rx="3"
        fill="var(--surface)"
        stroke="var(--ink-400)"
        strokeWidth="1"
      />
      {lines}
      {highlight ? (
        <rect
          x={x + highlight.col * cell}
          y={y + highlight.row * cell}
          width={cell * highlight.span}
          height={cell * highlight.span}
          fill="rgba(10, 119, 144, 0.18)"
          stroke="var(--accent)"
          strokeWidth="1.5"
        />
      ) : null}
      <text
        x={x + s + 12}
        y={y + s / 2 + 4}
        fontSize="12"
        fontFamily={MONO}
        fill="var(--ink-500)"
      >
        {label}
      </text>
    </g>
  );
};

const Chevron: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <path
    d={`M ${x - 5} ${y} l 5 6 l 5 -6`}
    fill="none"
    stroke="var(--ink-400)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

/**
 * Deeper cut: the time axis has zoom levels of its own. `--temporal-lod`
 * writes extra aggregate tiers with coarser buckets for lower zooms; each
 * directory entry records its `temporal_bucket_ms`, so the reader dispatches
 * to the right tier for the current camera.
 */
const LOD_TIERS: { label: string; buckets: number; note: string }[] = [
  {
    label: 'z 0–4',
    buckets: 2,
    note: '30-day buckets — a planet scrubs months',
  },
  { label: 'z 5–8', buckets: 8, note: '1-day buckets — a region scrubs weeks' },
  {
    label: 'z 9–14',
    buckets: 24,
    note: '1-hour buckets — a street scrubs a day',
  },
];

const LOD_X0 = 150;
const LOD_W = 700;
const LOD_PLAYHEAD = LOD_X0 + LOD_W * 0.46;

export const TemporalLodFigure: React.FC = () => (
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
      Deeper: the time axis has zoom levels too
    </h4>
    <div className="overflow-x-auto">
      <svg
        viewBox="0 0 920 210"
        className="w-full min-w-[680px]"
        role="img"
        aria-label="Diagram: the same instant covered by three temporal tiers — 30-day buckets at low zoom, 1-day buckets at mid zoom, 1-hour buckets at high zoom — with one shared playhead."
      >
        {LOD_TIERS.map((tier, row) => {
          const y = 28 + row * 58;
          const pitch = LOD_W / tier.buckets;
          return (
            <g key={tier.label}>
              <text
                x="20"
                y={y + 17}
                fontSize="11"
                fontFamily={MONO}
                fill="var(--ink-700)"
              >
                {tier.label}
              </text>
              {Array.from({ length: tier.buckets }, (_, b) => {
                const bx = LOD_X0 + b * pitch;
                const hit = LOD_PLAYHEAD >= bx && LOD_PLAYHEAD < bx + pitch;
                return (
                  <rect
                    key={b}
                    x={bx + 1.5}
                    y={y}
                    width={pitch - 3}
                    height={26}
                    rx="4"
                    fill={hit ? 'var(--accent)' : 'var(--surface-sunken)'}
                    stroke={hit ? 'var(--accent)' : 'var(--hairline)'}
                    opacity={hit ? 0.9 : 1}
                  />
                );
              })}
              <text
                x={LOD_X0 + LOD_W + 12}
                y={y + 12}
                fontSize="9.5"
                fill="var(--ink-500)"
              >
                {tier.note.split(' — ')[0]}
              </text>
              <text
                x={LOD_X0 + LOD_W + 12}
                y={y + 24}
                fontSize="9.5"
                fill="var(--ink-400)"
              >
                {tier.note.split(' — ')[1]}
              </text>
            </g>
          );
        })}
        <line
          x1={LOD_PLAYHEAD}
          y1="16"
          x2={LOD_PLAYHEAD}
          y2="192"
          stroke="var(--accent)"
          strokeWidth="1.5"
        />
        <path
          d={`M ${LOD_PLAYHEAD - 5} 10 h 10 l -5 7 z`}
          fill="var(--accent)"
        />
        <text x={LOD_X0} y="206" fontSize="10" fill="var(--ink-400)">
          the same instant, three tiers — one tile of data at every altitude
        </text>
      </svg>
    </div>
    <p
      className="mt-2 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      <span className="font-mono">--temporal-lod "1d@8,30d@4"</span> bakes
      aggregate tiers whose buckets are strict multiples of the base bucket;
      each directory entry records its own{' '}
      <span className="font-mono">temporal_bucket_ms</span>, so the reader
      dispatches per zoom with no special cases. Dense-then-quiet datasets can
      instead use <span className="font-mono">--adaptive-temporal N</span>,
      which sizes windows by feature count rather than the clock.
    </p>
  </div>
);

const SpaceTimeDiagram: React.FC = () => {
  const reduced = useReducedMotion();
  const [grabbed, setGrabbed] = React.useState(false);
  const [playhead, setPlayhead] = React.useState(4.2); // bucket units, 0..12

  React.useEffect(() => {
    if (reduced || grabbed) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 250);
      last = now;
      setPlayhead((p) => (p + dt / 2400) % BUCKETS);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, grabbed]);

  const cur = Math.floor(playhead);
  const px = X0 + playhead * PITCH;
  const runwayEnd = Math.min(
    X0 + (playhead + RUNWAY) * PITCH,
    X0 + BUCKETS * PITCH - 6,
  );
  const hh = String(cur).padStart(2, '0');

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 920 300"
          className="w-full min-w-[720px]"
          role="img"
          aria-label="Diagram: the tile pyramid subdivides space; each tile is further cut into time buckets, and the playhead selects which buckets stream in."
        >
          {/* ── Left: the spatial pyramid ─────────────────────────────── */}
          <text
            x="40"
            y="40"
            fontSize="12"
            fontWeight="600"
            fill="var(--ink-700)"
          >
            Space — a tile pyramid
          </text>
          <PyramidLevel
            x={40}
            y={56}
            s={56}
            n={1}
            highlight={{ col: 0, row: 0, span: 1 }}
            label="z = 5"
          />
          <Chevron x={68} y={120} />
          <PyramidLevel
            x={40}
            y={132}
            s={56}
            n={2}
            highlight={{ col: 1, row: 0, span: 1 }}
            label="z = 6"
          />
          <Chevron x={68} y={196} />
          <PyramidLevel
            x={40}
            y={208}
            s={56}
            n={4}
            highlight={{ col: 3, row: 0, span: 1 }}
            label="z = 7"
          />

          {/* connector: the highlighted z=7 tile expands into its bucket row */}
          <path
            d="M 98 218 C 180 218, 220 158, 288 158"
            fill="none"
            stroke="var(--ink-400)"
            strokeWidth="1"
            strokeDasharray="3 4"
          />

          {/* ── Right: the temporal axis of that one tile ─────────────── */}
          <text
            x={X0}
            y="40"
            fontSize="12"
            fontWeight="600"
            fill="var(--ink-700)"
          >
            Time — the same tile, cut into buckets
          </text>
          <text x={X0} y="58" fontSize="11" fill="var(--ink-500)">
            one archive day, 1-hour buckets · address = (z, x, y, t)
          </text>

          {/* runway band behind the buckets */}
          <rect
            x={px}
            y={BUCKET_Y - 8}
            width={Math.max(runwayEnd - px, 0)}
            height={BUCKET_H + 16}
            rx="6"
            fill="rgba(10, 119, 144, 0.07)"
          />

          {/* buckets */}
          {Array.from({ length: BUCKETS }, (_, b) => {
            const st = BUCKET_STYLE[bucketState(b, playhead)];
            const bx = X0 + b * PITCH;
            return (
              <g key={b}>
                <rect
                  x={bx}
                  y={BUCKET_Y}
                  width={BUCKET_W}
                  height={BUCKET_H}
                  rx="5"
                  fill={st.fill}
                  stroke={st.stroke}
                  strokeWidth="1.2"
                  strokeDasharray={st.dash}
                />
                {DOTS[b].map(([dx, dy], i) => (
                  <circle
                    key={i}
                    cx={bx + dx}
                    cy={BUCKET_Y + dy}
                    r="1.8"
                    fill={st.dot}
                    opacity={bucketState(b, playhead) === 'idle' ? 0.5 : 0.9}
                  />
                ))}
              </g>
            );
          })}

          {/* hour ticks */}
          {[0, 3, 6, 9].map((i) => (
            <text
              key={i}
              x={X0 + i * PITCH}
              y="212"
              fontSize="10"
              fontFamily={MONO}
              fill="var(--ink-400)"
            >
              {String(i).padStart(2, '0')}:00
            </text>
          ))}
          <text
            x={X0 + BUCKETS * PITCH - 6}
            y="212"
            fontSize="10"
            fontFamily={MONO}
            fill="var(--ink-400)"
            textAnchor="end"
          >
            12:00
          </text>

          {/* playhead */}
          <line
            x1={px}
            y1={112}
            x2={px}
            y2={198}
            stroke="var(--accent)"
            strokeWidth="1.5"
          />
          <path d={`M ${px - 5} 106 h 10 l -5 7 z`} fill="var(--accent)" />
          <text
            x={px}
            y="100"
            fontSize="10"
            fontWeight="600"
            textAnchor="middle"
            fill="var(--accent)"
          >
            playhead
          </text>

          {/* the current tile address */}
          <text
            x={X0}
            y="240"
            fontSize="12"
            fontFamily={MONO}
            fill="var(--ink-700)"
          >
            {`fetching tile (z = 7, x = 41, y = 52, t = ${hh}:00)`}
          </text>
          <text x={X0} y="260" fontSize="11" fill="var(--ink-500)">
            The viewer streams only viewport ∩ zoom ∩ time window — never the
            whole archive.
          </text>
        </svg>
      </div>

      {/* scrubber */}
      <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-3">
        <input
          type="range"
          min={0}
          max={(BUCKETS - 0.01) * 100}
          value={Math.round(playhead * 100)}
          aria-label="Scrub the diagram playhead"
          onPointerDown={() => setGrabbed(true)}
          onChange={(e) => {
            setGrabbed(true);
            setPlayhead(Number(e.target.value) / 100);
          }}
          className="w-full sm:max-w-xs"
          style={{ accentColor: 'var(--accent)' }}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {LEGEND.map(({ label, state }) => {
            const st = BUCKET_STYLE[state];
            return (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 text-[11px]"
                style={{ color: 'var(--ink-500)' }}
              >
                <svg
                  viewBox="0 0 14 14"
                  width="12"
                  height="12"
                  aria-hidden="true"
                >
                  <rect
                    x="1"
                    y="1"
                    width="12"
                    height="12"
                    rx="3"
                    fill={st.fill}
                    stroke={st.stroke}
                    strokeWidth="1.4"
                    strokeDasharray={st.dash}
                  />
                </svg>
                {label}
              </span>
            );
          })}
        </div>
      </div>

      <div className="mt-4">
        <TemporalLodFigure />
      </div>
    </div>
  );
};

export default SpaceTimeDiagram;
