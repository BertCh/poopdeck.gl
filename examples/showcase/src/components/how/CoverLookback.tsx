import React from 'react';

/**
 * "Deeper:" cut for the Space×time section — the temporal look-back rule.
 *
 * An interval feature (a taxi trip alive 08:20 → 10:40) is stored ONCE, in the
 * time bucket of its *start* (the 08:00 bucket); it is never duplicated into
 * every bucket it overlaps. That keeps the archive small, but it means the
 * playhead at 10:00 can't simply fetch the 10:00 bucket — a trip that started
 * at 08:20 is still on screen while its bytes live in the 08:00 blob.
 *
 * So every directory entry carries `cover_t_min` — the minimum feature *start*
 * time actually present in that tile (a tight lower covering bound; the
 * (z,x,y,bucket) key itself stays loose so lookup still works). To render time
 * T the reader fetches the bucket containing T and LOOKS BACK to earlier
 * buckets, using `cover_t_min` to bound how far back it must go: it stops once
 * an earlier bucket can't possibly still be alive at T. Archives without the
 * bound fall back to `time_start` (look back to the start — correct, heavier).
 *
 * Evidence: crates/stt-core/src/archive.rs:95-102 (TileEntry.cover_t_min),
 * :631-654 (add_tile_full carries the bound; None leaves entries unbounded).
 *
 * STATIC figure — no animation, no state.
 */

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="rounded-lg p-4"
    style={{
      background: 'var(--surface)',
      border: '1px solid var(--hairline)',
    }}
  >
    {children}
  </div>
);

const SubHead: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4
    className="font-display text-[13px] font-semibold"
    style={{ color: 'var(--ink-900)' }}
  >
    {children}
  </h4>
);

/* ── Geometry ──────────────────────────────────────────────────────────── */
const X0 = 100; // left edge of the 06:00 bucket
const PITCH = 120; // one hour bucket
const BUCKET_Y = 50;
const BUCKET_H = 30;
const tx = (hour: number) => X0 + (hour - 6) * PITCH; // clock → svg x
const PLAYHEAD = tx(10); // 580

type State = 'skipped' | 'fetched' | 'current';
const STATE: Record<State, { fill: string; stroke: string; ink: string }> = {
  skipped: {
    fill: 'var(--surface-sunken)',
    stroke: 'var(--hairline)',
    ink: 'var(--ink-400)',
  },
  fetched: {
    fill: 'rgba(10,119,144,0.14)',
    stroke: 'var(--accent)',
    ink: 'var(--accent)',
  },
  current: { fill: 'var(--accent)', stroke: 'var(--accent)', ink: '#ffffff' },
};

const BUCKETS: { hour: string; state: State }[] = [
  { hour: '06:00', state: 'skipped' },
  { hour: '07:00', state: 'skipped' },
  { hour: '08:00', state: 'fetched' }, // holds the still-alive trip → looked back
  { hour: '09:00', state: 'fetched' },
  { hour: '10:00', state: 'current' }, // bucket containing the playhead
  { hour: '11:00', state: 'skipped' }, // future — nothing born yet
];

// One row per interval feature. `alive` = crosses / touches the playhead at T=10:00.
const FEATURES: {
  x1: number;
  x2: number;
  y: number;
  alive: boolean;
  note: string;
  noteX: number;
  anchor: 'start' | 'end';
}[] = [
  {
    x1: tx(6.5),
    x2: tx(8.167),
    y: 112,
    alive: false,
    note: 'ended 08:10 · past',
    noteX: tx(8.167) + 8,
    anchor: 'start',
  },
  {
    x1: tx(8.333),
    x2: tx(10.667),
    y: 134,
    alive: true,
    note: '08:20 → 10:40 · still on screen',
    noteX: tx(10.667) + 8,
    anchor: 'start',
  },
  {
    x1: tx(9.25),
    x2: tx(10.333),
    y: 156,
    alive: true,
    note: '09:15 → 10:20',
    noteX: tx(10.333) + 8,
    anchor: 'start',
  },
  {
    x1: tx(10),
    x2: tx(10.417),
    y: 178,
    alive: true,
    note: 'born in the 10:00 bucket',
    noteX: tx(10.417) + 8,
    anchor: 'start',
  },
  {
    x1: tx(11.167),
    x2: tx(11.833),
    y: 200,
    alive: false,
    note: '11:10 · not yet',
    noteX: tx(11.167) - 8,
    anchor: 'end',
  },
];

const LB_LEFT = tx(8); // earliest still-relevant bucket, bounded by cover_t_min
const COVER = tx(8.333); // cover_t_min of the 08:00 bucket = 08:20 (the star's start)

const LegendChip: React.FC<{
  kind: 'dot' | 'fetched' | 'skipped';
  label: string;
}> = ({ kind, label }) => (
  <span
    className="inline-flex items-center gap-1.5 text-[11px]"
    style={{ color: 'var(--ink-500)' }}
  >
    <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
      {kind === 'dot' ? (
        <circle cx="7" cy="7" r="3.4" fill="var(--ink-700)" />
      ) : (
        <rect
          x="1"
          y="1"
          width="12"
          height="12"
          rx="3"
          fill={kind === 'fetched' ? STATE.fetched.fill : STATE.skipped.fill}
          stroke={
            kind === 'fetched' ? STATE.fetched.stroke : STATE.skipped.stroke
          }
          strokeWidth="1.4"
        />
      )}
    </svg>
    {label}
  </span>
);

const CoverLookback: React.FC = () => (
  <Card>
    <SubHead>
      Deeper: long-lived features live in one blob — the reader looks back
    </SubHead>
    <p
      className="mt-1 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      An interval feature is written once, in the bucket of its <em>start</em>{' '}
      time — never copied into every bucket it spans. So rendering time T means
      fetching the bucket that contains T <em>and</em> looking back to earlier
      buckets that still hold live features.
    </p>

    <div className="overflow-x-auto">
      <svg
        viewBox="0 0 920 258"
        className="w-full min-w-[720px]"
        role="img"
        aria-label="Diagram: a row of hourly time buckets from 06:00 to 12:00 with a playhead at 10:00. Interval features are stored once in their start bucket; a trip starting 08:20 is still alive at 10:00 though its bytes live in the 08:00 blob, so the reader looks back from the playhead bucket to the 08:00 bucket, bounded by cover_t_min. Buckets it can skip are greyed."
      >
        {/* look-back bracket */}
        <path
          d={`M ${LB_LEFT} 44 v -6 H ${PLAYHEAD} v 6`}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.25"
        />
        <text
          x={(LB_LEFT + PLAYHEAD) / 2}
          y="30"
          fontSize="10.5"
          fontWeight="600"
          textAnchor="middle"
          fill="var(--accent)"
        >
          look-back window · bounded by cover_t_min
        </text>

        {/* look-back band behind the gantt */}
        <rect
          x={LB_LEFT}
          y="100"
          width={tx(11) - LB_LEFT}
          height="114"
          fill="rgba(10,119,144,0.06)"
        />

        {/* bucket header */}
        {BUCKETS.map((b, i) => {
          const st = STATE[b.state];
          const bx = X0 + i * PITCH;
          return (
            <g key={b.hour}>
              <rect
                x={bx + 2}
                y={BUCKET_Y}
                width={PITCH - 4}
                height={BUCKET_H}
                rx="5"
                fill={st.fill}
                stroke={st.stroke}
                strokeWidth="1.2"
              />
              <text
                x={bx + PITCH / 2}
                y={BUCKET_Y + 19}
                fontSize="11"
                fontFamily={MONO}
                textAnchor="middle"
                fill={st.ink}
              >
                {b.hour}
              </text>
            </g>
          );
        })}
        <text x={X0} y="94" fontSize="9.5" fill="var(--ink-400)">
          one archive day · 1-hour buckets · a feature sits in its start bucket
          only
        </text>

        {/* cover_t_min marker at the 08:00 bucket */}
        <line
          x1={COVER}
          y1={BUCKET_Y + BUCKET_H}
          x2={COVER}
          y2="214"
          stroke="var(--accent)"
          strokeWidth="1"
          strokeDasharray="2 3"
          opacity="0.55"
        />
        <text
          x={COVER + 5}
          y="112"
          fontSize="8.5"
          fontFamily={MONO}
          fill="var(--accent)"
        >
          cover_t_min = 08:20
        </text>

        {/* feature interval bars */}
        {FEATURES.map((f, i) => {
          const col = f.alive ? 'var(--accent)' : 'var(--ink-400)';
          return (
            <g key={i}>
              <rect
                x={f.x1}
                y={f.y}
                width={Math.max(f.x2 - f.x1, 4)}
                height="7"
                rx="3.5"
                fill={col}
                opacity={f.alive ? 0.9 : 0.5}
              />
              {/* filled dot at the LEFT end — "stored in start bucket" */}
              <circle cx={f.x1} cy={f.y + 3.5} r="3.2" fill="var(--ink-700)" />
              <text
                x={f.noteX}
                y={f.y + 7}
                fontSize="9"
                textAnchor={f.anchor}
                fill="var(--ink-400)"
              >
                {f.note}
              </text>
            </g>
          );
        })}
        <text x={X0} y="228" fontSize="9" fill="var(--ink-400)">
          each dot = the one bucket a feature is stored in; the bar = its
          lifespan
        </text>

        {/* playhead */}
        <line
          x1={PLAYHEAD}
          y1="48"
          x2={PLAYHEAD}
          y2="220"
          stroke="var(--accent)"
          strokeWidth="1.5"
        />
        <path d={`M ${PLAYHEAD - 5} 46 h 10 l -5 7 z`} fill="var(--accent)" />
        <text
          x={PLAYHEAD}
          y="248"
          fontSize="10"
          fontWeight="600"
          textAnchor="middle"
          fill="var(--accent)"
        >
          playhead · T = 10:00
        </text>
      </svg>
    </div>

    {/* legend */}
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <LegendChip kind="dot" label="stored in start bucket" />
      <LegendChip kind="fetched" label="fetched (look-back)" />
      <LegendChip kind="skipped" label="skipped" />
    </div>

    {/* naive alternative — warm / attention colour */}
    <div
      className="mt-3 rounded-md p-2.5 flex items-start gap-2.5"
      style={{
        background: 'rgba(240,193,75,0.16)',
        border: '1px solid rgba(240,193,75,0.9)',
      }}
    >
      <svg
        viewBox="0 0 120 40"
        width="96"
        height="32"
        role="img"
        aria-label="Naive alternative: one feature duplicated into all three buckets it overlaps."
        className="shrink-0 mt-0.5"
      >
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <rect
              x={4 + i * 38}
              y="4"
              width="34"
              height="32"
              rx="3"
              fill="none"
              stroke="rgba(240,193,75,0.9)"
              strokeWidth="1"
            />
            <rect
              x={8 + i * 38}
              y="16"
              width="26"
              height="6"
              rx="3"
              fill="#8a5a0a"
              opacity="0.75"
            />
          </g>
        ))}
        <text
          x="60"
          y="12"
          fontSize="8"
          fontFamily={MONO}
          textAnchor="middle"
          fill="#8a5a0a"
        >
          ×3 copies
        </text>
      </svg>
      <p className="text-[11px] leading-relaxed" style={{ color: '#8a5a0a' }}>
        The naive alternative duplicates each feature into <em>every</em> bucket
        it overlaps, so a long-lived trip, storm or vessel track is written N
        times and the archive balloons. The look-back avoids that: store once,
        pay a bounded read.
      </p>
    </div>

    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      <span
        className="rounded px-1.5 py-0.5 font-mono text-[10px]"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
      >
        cover_t_min
      </span>{' '}
      is a tight lower covering bound recorded per directory entry — the 08:00
      bucket advertises 08:20, so the reader knows exactly how far back to walk
      and stops once an earlier bucket's newest feature has already ended. When
      it is <span className="font-mono">None</span> (repacked or pre-covering
      archives) the reader falls back to{' '}
      <span className="font-mono">time_start</span>: correct, but it looks all
      the way back to the bucket start.
    </p>
  </Card>
);

export default CoverLookback;
