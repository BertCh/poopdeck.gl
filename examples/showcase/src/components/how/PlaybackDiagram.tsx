import React from 'react';

/**
 * "Streamed like video" figures: the buffered-runway model the playback
 * governor gates on, and the GPU time gate that animates features without
 * rebuilding a single buffer.
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

/* ── 1. The runway ────────────────────────────────────────────────────── */

const RunwayFigure: React.FC = () => (
  <Card>
    <SubHead>
      The governor buffers sim-time like a video player buffers seconds
    </SubHead>
    <div className="overflow-x-auto">
      <svg
        viewBox="0 0 920 130"
        className="w-full min-w-[680px]"
        role="img"
        aria-label="Diagram: a playback bar with played time behind the playhead, a buffered runway of fully loaded sim-time ahead of it, and unfetched time beyond; thresholds mark the stall watermark and the start gate."
      >
        {/* track */}
        <rect
          x="40"
          y="52"
          width="320"
          height="10"
          rx="5"
          fill="var(--surface-sunken)"
          stroke="var(--hairline)"
        />
        <rect
          x="360"
          y="52"
          width="280"
          height="10"
          rx="5"
          fill="var(--accent)"
          opacity="0.75"
        />
        <rect
          x="640"
          y="52"
          width="240"
          height="10"
          rx="5"
          fill="none"
          stroke="var(--hairline)"
        />

        <text
          x="200"
          y="44"
          fontSize="10"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          played
        </text>
        <text
          x="760"
          y="44"
          fontSize="10"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          not yet fetched
        </text>

        {/* buffered-runway bracket */}
        <path
          d="M 360 34 v -6 H 640 v 6"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.25"
        />
        <text
          x="500"
          y="18"
          fontSize="10.5"
          fontWeight="600"
          textAnchor="middle"
          fill="var(--accent)"
        >
          buffered runway — contiguous, fully resident sim-time
        </text>

        {/* playhead */}
        <path d="M 355 76 h 10 l -5 -8 z" fill="var(--ink-900)" />
        <text
          x="360"
          y="92"
          fontSize="10"
          fontWeight="600"
          textAnchor="middle"
          fill="var(--ink-900)"
        >
          playhead
        </text>

        {/* thresholds */}
        <line
          x1="430"
          y1="64"
          x2="430"
          y2="76"
          stroke="var(--ink-400)"
          strokeWidth="1"
        />
        <text
          x="430"
          y="92"
          fontSize="9.5"
          textAnchor="middle"
          fill="var(--ink-500)"
        >
          stall watermark · 0.6 s × speed
        </text>
        <line
          x1="580"
          y1="64"
          x2="580"
          y2="100"
          stroke="var(--ink-400)"
          strokeWidth="1"
        />
        <text
          x="580"
          y="114"
          fontSize="9.5"
          textAnchor="middle"
          fill="var(--ink-500)"
        >
          start gate · 2 s × speed (resume needs 2×)
        </text>
      </svg>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      {['starting', 'playing', 'buffering', 'playing'].map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden="true" style={{ color: 'var(--ink-400)' }}>
              →
            </span>
          ) : null}
          <span
            className="rounded px-1.5 py-0.5 font-mono"
            style={{
              background:
                s === 'buffering'
                  ? 'rgba(240,193,75,0.16)'
                  : 'var(--surface-sunken)',
              color: s === 'buffering' ? '#8a5a0a' : 'var(--ink-700)',
              border: '1px solid var(--hairline)',
            }}
          >
            {s}
          </span>
        </React.Fragment>
      ))}
      <span style={{ color: 'var(--ink-500)' }}>
        — the clock freezes rather than let the playhead outrun the data; if the
        network can't keep up, auto-speed downshifts instantly and upshifts
        cautiously.
      </span>
    </div>
  </Card>
);

/* ── 1b. The governor state machine ───────────────────────────────────── */

const GOV_WARM = 'rgba(240,193,75,0.9)';
const GOV_WARM_SOFT = 'rgba(240,193,75,0.16)';
const GOV_WARM_INK = '#8a5a0a';

const StateBox: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  tone: 'idle' | 'gate' | 'playing' | 'buffering' | 'creep';
}> = ({ x, y, w, h, label, sub, tone }) => {
  const style = {
    idle: {
      fill: 'var(--surface-sunken)',
      stroke: 'var(--ink-400)',
      ink: 'var(--ink-700)',
      dash: undefined as string | undefined,
    },
    gate: {
      fill: 'var(--accent-soft)',
      stroke: 'var(--accent)',
      ink: 'var(--accent)',
      dash: undefined,
    },
    playing: {
      fill: 'var(--accent)',
      stroke: 'var(--accent)',
      ink: '#ffffff',
      dash: undefined,
    },
    buffering: {
      fill: GOV_WARM_SOFT,
      stroke: GOV_WARM,
      ink: GOV_WARM_INK,
      dash: undefined,
    },
    creep: {
      fill: 'var(--accent-soft)',
      stroke: 'var(--accent)',
      ink: 'var(--accent)',
      dash: '4 3',
    },
  }[tone];
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="7"
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth="1.3"
        strokeDasharray={style.dash}
      />
      <text
        x={x + w / 2}
        y={sub ? y + h / 2 - 3 : y + h / 2 + 4}
        fontSize="11.5"
        fontWeight="600"
        fontFamily={MONO}
        textAnchor="middle"
        fill={style.ink}
      >
        {label}
      </text>
      {sub ? (
        <text
          x={x + w / 2}
          y={y + h / 2 + 12}
          fontSize="8.5"
          textAnchor="middle"
          fill={
            tone === 'playing' ? 'rgba(255,255,255,0.85)' : 'var(--ink-500)'
          }
        >
          {sub}
        </text>
      ) : null}
    </g>
  );
};

const GovStatesFigure: React.FC = () => (
  <Card>
    <SubHead>
      The governor is a small state machine — it degrades before it freezes
    </SubHead>
    <div className="overflow-x-auto">
      <svg
        viewBox="0 0 920 300"
        className="w-full min-w-[720px]"
        role="img"
        aria-label="Diagram: the playback governor's states — idle to starting to playing, playing stalling into buffering and resuming, playing branching to seeking on a scrub, and a degraded-creep mode entered when a gate can't pass within the escape-hatch window."
      >
        <defs>
          <marker
            id="gov-arr"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--ink-400)" />
          </marker>
          <marker
            id="gov-arr-warm"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill={GOV_WARM} />
          </marker>
        </defs>

        {/* states */}
        <StateBox x={30} y={128} w={96} h={46} label="idle" tone="idle" />
        <StateBox
          x={196}
          y={128}
          w={124}
          h={46}
          label="starting"
          sub="fill the runway"
          tone="gate"
        />
        <StateBox
          x={398}
          y={124}
          w={132}
          h={54}
          label="playing"
          sub="clock runs"
          tone="playing"
        />
        <StateBox
          x={398}
          y={26}
          w={132}
          h={46}
          label="buffering"
          sub="clock frozen"
          tone="buffering"
        />
        <StateBox
          x={398}
          y={228}
          w={132}
          h={46}
          label="seeking"
          sub="post-scrub gate"
          tone="gate"
        />
        <StateBox
          x={612}
          y={124}
          w={178}
          h={54}
          label="degraded creep"
          sub="pin to data frontier"
          tone="creep"
        />

        {/* idle → starting */}
        <line
          x1="126"
          y1="151"
          x2="196"
          y2="151"
          stroke="var(--ink-400)"
          strokeWidth="1.1"
          markerEnd="url(#gov-arr)"
        />
        <text
          x="161"
          y="143"
          fontSize="9"
          fontFamily={MONO}
          textAnchor="middle"
          fill="var(--ink-500)"
        >
          play()
        </text>

        {/* starting → playing */}
        <line
          x1="320"
          y1="151"
          x2="398"
          y2="151"
          stroke="var(--ink-400)"
          strokeWidth="1.1"
          markerEnd="url(#gov-arr)"
        />
        <text
          x="359"
          y="143"
          fontSize="9"
          textAnchor="middle"
          fill="var(--accent)"
        >
          gate ✓
        </text>
        <text
          x="359"
          y="167"
          fontSize="8"
          fontFamily={MONO}
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          ≥ 2 s × speed
        </text>

        {/* playing ↔ buffering */}
        <line
          x1="440"
          y1="124"
          x2="440"
          y2="72"
          stroke={GOV_WARM}
          strokeWidth="1.2"
          markerEnd="url(#gov-arr-warm)"
        />
        <text
          x="432"
          y="102"
          fontSize="8.5"
          textAnchor="end"
          fill={GOV_WARM_INK}
        >
          runway &lt;
        </text>
        <text
          x="432"
          y="112"
          fontSize="8.5"
          textAnchor="end"
          fill={GOV_WARM_INK}
        >
          watermark
        </text>
        <line
          x1="488"
          y1="72"
          x2="488"
          y2="124"
          stroke="var(--accent)"
          strokeWidth="1.2"
          markerEnd="url(#gov-arr)"
        />
        <text x="496" y="100" fontSize="8.5" fill="var(--accent)">
          resume
        </text>
        <text x="496" y="110" fontSize="8.5" fill="var(--accent)">
          gate · 2×
        </text>

        {/* playing ↔ seeking */}
        <line
          x1="440"
          y1="178"
          x2="440"
          y2="228"
          stroke="var(--ink-400)"
          strokeWidth="1.1"
          markerEnd="url(#gov-arr)"
        />
        <text
          x="432"
          y="206"
          fontSize="8.5"
          textAnchor="end"
          fill="var(--ink-500)"
        >
          scrub
        </text>
        <line
          x1="488"
          y1="228"
          x2="488"
          y2="178"
          stroke="var(--ink-400)"
          strokeWidth="1.1"
          markerEnd="url(#gov-arr)"
        />
        <text x="496" y="206" fontSize="8.5" fill="var(--ink-500)">
          seek gate
        </text>

        {/* buffering/starting → creep (escape hatch) */}
        <path
          d="M 530 49 C 604 49, 701 82, 701 124"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.1"
          strokeDasharray="4 3"
          markerEnd="url(#gov-arr)"
        />
        <text
          x="648"
          y="70"
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--accent)"
        >
          8 s escape hatch
        </text>
        <text
          x="648"
          y="80"
          fontSize="7.5"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          (also from starting)
        </text>

        {/* creep → playing */}
        <path
          d="M 612 165 C 572 172, 552 172, 530 168"
          fill="none"
          stroke="var(--ink-400)"
          strokeWidth="1.1"
          markerEnd="url(#gov-arr)"
        />
        <text
          x="571"
          y="192"
          fontSize="8"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          frontier catches up
        </text>
      </svg>
    </div>

    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div
        className="rounded-md p-2.5"
        style={{
          background: 'var(--surface-sunken)',
          border: '1px solid var(--hairline)',
        }}
      >
        <span
          className="font-display text-[11.5px] font-semibold"
          style={{ color: 'var(--ink-900)' }}
        >
          canplaythrough predictor
        </span>
        <p
          className="mt-1 text-[10.5px] leading-snug"
          style={{ color: 'var(--ink-500)' }}
        >
          A gate also passes when the <em>missing</em> bytes are predicted to
          arrive within the wall time the current runway buys — so a cold seek
          on a fast link starts almost instantly instead of demanding seconds of
          resident sim-time up front.
        </p>
      </div>
      <div
        className="rounded-md p-2.5"
        style={{ background: GOV_WARM_SOFT, border: `1px solid ${GOV_WARM}` }}
      >
        <span
          className="font-display text-[11.5px] font-semibold"
          style={{ color: GOV_WARM_INK }}
        >
          degraded creep, not a freeze
        </span>
        <p
          className="mt-1 text-[10.5px] leading-snug"
          style={{ color: GOV_WARM_INK }}
        >
          If a gate can't pass within{' '}
          <span className="font-mono">maxStartWaitMs</span> (~8 s), the governor
          stops waiting and pins the playhead to the data frontier, advancing at
          arrival rate — motion never lurches, and it re-tightens the moment the
          network recovers.
        </p>
      </div>
    </div>

    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      The governor never touches the network itself — it sees the loader only
      through a small <span className="font-mono">BufferSource</span> seam (
      <span className="font-mono">getBufferedRunway</span>,{' '}
      <span className="font-mono">estimateCost</span>,{' '}
      <span className="font-mono">flushPrefetch</span>,{' '}
      <span className="font-mono">setAnimationState</span>), which is why{' '}
      <span className="font-mono">@poopdeck.gl/playback</span> stays
      zero-dependency and renderer-agnostic.
    </p>
  </Card>
);

/* ── 2. The GPU time gate ─────────────────────────────────────────────── */

const FEATURES: [number, number][] = [
  [80, 360],
  [300, 520],
  [420, 500],
  [120, 860],
  [560, 760],
  [60, 200],
  [380, 620],
  [640, 830],
];

const BAND_X = 400;
const BAND_W = 140;

const GateFigure: React.FC = () => (
  <Card>
    <SubHead>
      Per frame, the GPU alpha-gates every feature — buffers never rebuild
    </SubHead>
    <div className="overflow-x-auto">
      <svg
        viewBox="0 0 920 240"
        className="w-full min-w-[680px]"
        role="img"
        aria-label="Diagram: feature lifespans as horizontal bars; a vertical band around the current time lights up only the overlapping portions, fading at the band's edges."
      >
        <defs>
          <linearGradient id="stt-gate-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.18" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.82" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="stt-gate-mask">
            <rect
              x={BAND_X}
              y="0"
              width={BAND_W}
              height="240"
              fill="url(#stt-gate-grad)"
            />
          </mask>
        </defs>

        {/* window band */}
        <rect
          x={BAND_X}
          y="26"
          width={BAND_W}
          height="182"
          fill="rgba(10,119,144,0.06)"
        />
        <line
          x1={BAND_X + BAND_W / 2}
          y1="26"
          x2={BAND_X + BAND_W / 2}
          y2="208"
          stroke="var(--accent)"
          strokeWidth="1.25"
        />
        <text
          x={BAND_X + BAND_W / 2}
          y="16"
          fontSize="10.5"
          fontWeight="600"
          textAnchor="middle"
          fill="var(--accent)"
        >
          currentTime (uniform)
        </text>
        <text
          x={BAND_X + BAND_W + 10}
          y="222"
          fontSize="10"
          fill="var(--ink-500)"
        >
          window = currentTime ± windowHalf
        </text>
        <text
          x={BAND_X - 8}
          y="222"
          fontSize="9.5"
          textAnchor="end"
          fill="var(--ink-400)"
        >
          fade in / fade out at the edges
        </text>

        {/* lifespans, muted */}
        {FEATURES.map(([x1, x2], i) => (
          <rect
            key={`m${i}`}
            x={x1}
            y={38 + i * 21}
            width={x2 - x1}
            height="6"
            rx="3"
            fill="var(--ink-400)"
            opacity="0.3"
          />
        ))}
        {/* lifespans, lit inside the gate */}
        <g mask="url(#stt-gate-mask)">
          {FEATURES.map(([x1, x2], i) => (
            <rect
              key={`a${i}`}
              x={x1}
              y={38 + i * 21}
              width={x2 - x1}
              height="6"
              rx="3"
              fill="var(--accent)"
            />
          ))}
        </g>

        <text x="60" y="232" fontSize="10" fill="var(--ink-500)">
          each bar = one feature's [start_time, end_time] — stored once as GPU
          vertex attributes
        </text>
      </svg>
    </div>
    <p
      className="mt-2 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      Per-feature (and per-vertex) times upload once as attributes. Each frame
      updates a handful of uniforms and the vertex shader gates alpha; fully
      hidden vertices collapse to a degenerate position so they cost no
      fragments. Times are relativized against a per-tile offset before upload,
      keeping f32 attributes millisecond-accurate (relative windows cap at 2²⁴
      ms ≈ 4.6 h). The identical gate math runs as deck.gl GLSL, MapLibre GLSL
      and Three TSL.
    </p>
  </Card>
);

/* ── 2b. The four gate modes ──────────────────────────────────────────── */

interface GateMode {
  name: string;
  blurb: string;
  path: string;
  px: number;
}

// Plots share one frame: x 15..185, alpha 0 at y=62, alpha 1 at y=16.
const GATE_MODES: GateMode[] = [
  {
    name: 'window',
    blurb: 'visible around the playhead, fade ramps at both edges',
    path: 'M 15 62 L 55 62 L 75 16 L 125 16 L 145 62 L 185 62',
    px: 100,
  },
  {
    name: 'trail',
    blurb: 'alpha = 1 − age / trailLength — comet tails per vertex',
    path: 'M 15 62 L 50 62 L 140 16 L 140 62 L 185 62',
    px: 140,
  },
  {
    name: 'wake',
    blurb: 'long low tail, bright head — size shrinks toward the tail too',
    path: 'M 15 62 L 40 62 C 80 58, 115 44, 140 16 L 140 62 L 185 62',
    px: 140,
  },
  {
    name: 'cumulative',
    blurb: 'everything up to the playhead stays — build-up stories',
    path: 'M 15 16 L 140 16 L 140 62 L 185 62',
    px: 140,
  },
];

const GateModesFigure: React.FC = () => (
  <Card>
    <SubHead>
      Deeper: four looks, one mechanism — alpha as a function of age
    </SubHead>
    <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
      {GATE_MODES.map((m) => (
        <div key={m.name}>
          <svg
            viewBox="0 0 200 80"
            className="w-full rounded-md"
            style={{
              background: 'var(--surface-sunken)',
              border: '1px solid var(--hairline)',
            }}
            role="img"
            aria-label={`Alpha curve for the ${m.name} time-filter mode.`}
          >
            <line
              x1="12"
              y1="62"
              x2="188"
              y2="62"
              stroke="var(--hairline)"
              strokeWidth="1"
            />
            <line
              x1={m.px}
              y1="10"
              x2={m.px}
              y2="68"
              stroke="var(--ink-400)"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            <path
              d={m.path}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.75"
              strokeLinejoin="round"
            />
          </svg>
          <p
            className="font-mono text-[11px] font-semibold mt-1.5"
            style={{ color: 'var(--ink-900)' }}
          >
            {m.name}
          </p>
          <p
            className="text-[10.5px] leading-snug mt-0.5"
            style={{ color: 'var(--ink-500)' }}
          >
            {m.blurb}
          </p>
        </div>
      ))}
    </div>
    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      Dashed line = the playhead. Switching modes changes a uniform, not the
      data — the same buffers render as a sliding window, a comet trail, a
      vessel wake or an accumulating record. A separate injection can also map
      age to <em>height</em>, turning any dataset into a space-time cube.
    </p>
  </Card>
);

/* ── 3. The control loop ──────────────────────────────────────────────── */

const LOOP: { t: string; d: string; pkg: 'playback' | 'core' }[] = [
  { t: 'TimeController', d: 'wall clock × speed', pkg: 'playback' },
  { t: 'PlaybackGovernor', d: 'gates the clock on runway', pkg: 'playback' },
  { t: 'Tileset', d: 'coverage probe + time-ordered prefetch', pkg: 'core' },
  { t: 'SharedRequestScheduler', d: 'EDF urgency + DRR fairness', pkg: 'core' },
  { t: 'HTTP', d: 'coalesced range reads', pkg: 'core' },
];

const LoopArrow: React.FC = () => (
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
);

const ControlLoop: React.FC = () => (
  <Card>
    <SubHead>The control loop — two packages, one seam</SubHead>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {LOOP.map((n, i) => {
        const accent = n.pkg === 'playback';
        // The BufferSource contract is the boundary between the playback
        // engine and the loader — mark it where the packages meet.
        const seam = i > 0 && LOOP[i - 1].pkg !== n.pkg;
        return (
          <React.Fragment key={n.t}>
            {i > 0 ? (
              seam ? (
                <span className="inline-flex flex-col items-center px-0.5">
                  <span
                    className="font-mono text-[9px] font-semibold"
                    style={{ color: 'var(--accent)' }}
                  >
                    BufferSource
                  </span>
                  <LoopArrow />
                </span>
              ) : (
                <LoopArrow />
              )
            ) : null}
            <span
              className="rounded-md px-2.5 py-1.5"
              style={{
                background: accent
                  ? 'var(--accent-soft)'
                  : 'var(--surface-sunken)',
                border: `1px solid ${accent ? 'var(--accent)' : 'var(--hairline)'}`,
              }}
            >
              <span
                className="block font-mono text-[11px] font-semibold"
                style={{ color: accent ? 'var(--accent)' : 'var(--ink-900)' }}
              >
                {n.t}
              </span>
              <span
                className="block text-[10px] mt-0.5"
                style={{ color: 'var(--ink-500)' }}
              >
                {n.d}
              </span>
            </span>
          </React.Fragment>
        );
      })}
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px]">
      <span
        className="inline-flex items-center gap-1.5"
        style={{ color: 'var(--ink-500)' }}
      >
        <span
          className="h-2 w-2 rounded-sm"
          style={{
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent)',
          }}
          aria-hidden="true"
        />
        @poopdeck.gl/playback · zero-dep clock + governor
      </span>
      <span
        className="inline-flex items-center gap-1.5"
        style={{ color: 'var(--ink-500)' }}
      >
        <span
          className="h-2 w-2 rounded-sm"
          style={{
            background: 'var(--surface-sunken)',
            border: '1px solid var(--hairline)',
          }}
          aria-hidden="true"
        />
        @poopdeck.gl/core · loader + scheduler
      </span>
    </div>
    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      In deck.gl apps the controller rides deck's own frame loop (
      <span className="font-mono">useDeckClock</span> mirrors it onto{' '}
      <span className="font-mono">context.userData.stt</span>), so STT layers
      stay cached layer instances that simply redraw. MapLibre, Three and Cesium
      bridge their render loops the same way.
    </p>
  </Card>
);

/* ── 4. Many datasets, one playhead ───────────────────────────────────── */

interface SourceRow {
  name: string;
  required: boolean;
  weight: number;
  runway: number; // 0..1 of the bar
  runwayLabel: string;
  note: string;
}

const SOURCES: SourceRow[] = [
  {
    name: 'taxi flows',
    required: true,
    weight: 1,
    runway: 0.82,
    runwayLabel: '8.2 s',
    note: 'healthy — waiting on the slowest sibling',
  },
  {
    name: 'lidar sweep',
    required: true,
    weight: 4,
    runway: 0.21,
    runwayLabel: '2.1 s',
    note: "the binding constraint — it sets the shared clock's pace",
  },
  {
    name: 'poi labels',
    required: false,
    weight: 1,
    runway: 0.05,
    runwayLabel: '0.4 s',
    note: 'optional — may lag, can never stall the clock',
  },
];

const SPEED_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

const MultiSourceFigure: React.FC = () => (
  <Card>
    <SubHead>Deeper: many datasets, one playhead</SubHead>
    <div className="mt-3 space-y-2">
      {SOURCES.map((s) => (
        <div
          key={s.name}
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span
            className="font-mono text-[11px] w-24"
            style={{ color: 'var(--ink-700)' }}
          >
            {s.name}
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide w-[4.5rem] text-center"
            style={
              s.required
                ? { color: 'var(--accent)', background: 'var(--accent-soft)' }
                : {
                    color: 'var(--ink-400)',
                    background: 'var(--surface-sunken)',
                  }
            }
          >
            {s.required ? 'required' : 'optional'}
          </span>
          <span
            className="font-mono text-[10px] w-16"
            style={{ color: 'var(--ink-500)' }}
          >
            weight {s.weight}
          </span>
          <span
            className="relative h-2.5 w-40 rounded-full overflow-hidden shrink-0"
            style={{
              background: 'var(--surface-sunken)',
              border: '1px solid var(--hairline)',
            }}
          >
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: `${s.runway * 100}%`,
                background: s.required ? 'var(--accent)' : 'var(--ink-400)',
                opacity: s.required ? 0.8 : 0.5,
              }}
            />
          </span>
          <span
            className="font-mono text-[10px] w-10"
            style={{ color: 'var(--ink-500)' }}
          >
            {s.runwayLabel}
          </span>
          <span className="text-[10.5px]" style={{ color: 'var(--ink-400)' }}>
            {s.note}
          </span>
        </div>
      ))}
    </div>
    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      The governor folds health over the <em>required</em> set only — combined
      runway is the minimum, completeness is the AND. The shared scheduler then
      splits the connection budget by deficit round robin (the lidar's weight 4
      earns 4× the bandwidth) and orders requests earliest-deadline-first, where
      a request's deadline is its distance from the playhead.
    </p>
    <div
      className="mt-3 pt-3"
      style={{ borderTop: '1px solid var(--hairline)' }}
    >
      <span className="eyebrow" style={{ fontSize: 9 }}>
        auto-speed ladder
      </span>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {SPEED_LADDER.map((v) => (
          <span
            key={v}
            className="rounded px-1.5 py-0.5 font-mono text-[10px]"
            style={
              v === 2
                ? { background: 'var(--accent)', color: '#fff' }
                : {
                    background: 'var(--surface-sunken)',
                    color: 'var(--ink-500)',
                    border: '1px solid var(--hairline)',
                  }
            }
          >
            {v}×
          </span>
        ))}
      </div>
      <p
        className="mt-2 text-[11px] leading-relaxed"
        style={{ color: 'var(--ink-500)' }}
      >
        When throughput can't sustain the requested speed, playback steps down
        this ladder <em>immediately</em>; it steps back up only after sustained
        headroom clears a deadband — asymmetry borrowed from video ABR, so the
        picture degrades fast and recovers calmly instead of oscillating.
      </p>
    </div>
  </Card>
);

const PlaybackDiagram: React.FC = () => (
  <div className="space-y-4">
    <RunwayFigure />
    <GovStatesFigure />
    <GateFigure />
    <GateModesFigure />
    <ControlLoop />
    <MultiSourceFigure />
  </div>
);

export default PlaybackDiagram;
