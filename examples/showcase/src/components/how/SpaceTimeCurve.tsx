import React from 'react';
import { useReducedMotion } from '../../lib/reducedMotion';
import FigureSvg from '../FigureSvg.tsx';

/**
 * The space-time cube figure: a tile blob's address has three axes — (x, y)
 * on the map plus a time bucket — but a pack is one flat byte string.
 * `--blob-ordering` picks the space-filling walk that linearizes that cube
 * (see `crates/stt-core/src/curve.rs`); this draws the three real orderings
 * threading a toy 4×4×4 cube, then plays real map+time *gestures* over it —
 * play, pan, pan-while-playing, zoom-while-playing, click-to-preload — and
 * lights up which bytes each gesture touches so you can watch a scattered
 * read coalesce (or shatter) under each walk.
 *
 * The curve math is a direct port of curve.rs: the classic d2xy for the 2D
 * Hilbert walk, Skilling's transpose algorithm for the 3D one. Every run
 * count in the comparison table is computed from the same arrays the SVG
 * draws, so the numbers can never drift from the picture.
 */

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

const WARM = 'rgba(240, 193, 75, 0.9)';
const WARM_SOFT = 'rgba(240, 193, 75, 0.16)';
const WARM_INK = '#8a5a0a';

/* ── Curve math (ports of stt-core/src/curve.rs) ──────────────────────── */

/** Map a distance along the 2D Hilbert curve to (x, y) on a 2^order grid. */
function hilbert2(order: number, d: number): [number, number] {
  let x = 0;
  let y = 0;
  let t = d;
  for (let s = 1; s < 1 << order; s *= 2) {
    const rx = 1 & Math.floor(t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

/** 3D Hilbert distance via Skilling's transpose algorithm (n = 3). */
function hilbert3(x: number, y: number, t: number, bits: number): number {
  if (bits === 0) return 0;
  const n = 3;
  const coords = [x, y, t];
  let q = 1 << (bits - 1);
  while (q > 1) {
    const p = q - 1;
    for (let i = 0; i < n; i++) {
      if (coords[i] & q) {
        coords[0] ^= p;
      } else {
        const s = (coords[0] ^ coords[i]) & p;
        coords[0] ^= s;
        coords[i] ^= s;
      }
    }
    q >>= 1;
  }
  for (let i = 1; i < n; i++) coords[i] ^= coords[i - 1];
  let acc = 0;
  let q2 = 1 << (bits - 1);
  while (q2 > 1) {
    if (coords[n - 1] & q2) acc ^= q2 - 1;
    q2 >>= 1;
  }
  for (let i = 0; i < n; i++) coords[i] ^= acc;
  let key = 0;
  for (let bit = bits - 1; bit >= 0; bit--) {
    for (let i = 0; i < n; i++) key = (key << 1) | ((coords[i] >> bit) & 1);
  }
  return key;
}

/* ── The toy cube: 4×4 map cells × 4 time buckets ─────────────────────── */

interface Cell {
  x: number;
  y: number;
  t: number;
}

const N = 4;
const T = 4;
const BITS = 2;
const CELLS = N * N * T;
const SEGS = CELLS - 1;

const H2: [number, number][] = Array.from({ length: N * N }, (_, d) =>
  hilbert2(2, d),
);

const ALL: Cell[] = [];
for (let x = 0; x < N; x++)
  for (let y = 0; y < N; y++) for (let t = 0; t < T; t++) ALL.push({ x, y, t });

const key = (c: Cell) => `${c.x},${c.y},${c.t}`;

type OrderKey = 'spatial' | 'hilbert3' | 'time';
type GestureKey = 'play' | 'pan' | 'panPlay' | 'zoom' | 'preload';

const ORDER_KEYS: OrderKey[] = ['spatial', 'hilbert3', 'time'];
const GESTURE_KEYS: GestureKey[] = [
  'play',
  'pan',
  'panPlay',
  'zoom',
  'preload',
];

const ORDER_LABEL: Record<OrderKey, string> = {
  spatial: 'spatial',
  hilbert3: 'hilbert3',
  time: 'time',
};

const ORDERS: Record<OrderKey, Cell[]> = {
  spatial: H2.flatMap(([x, y]) =>
    Array.from({ length: T }, (_, t) => ({ x, y, t })),
  ),
  hilbert3: [...ALL].sort(
    (a, b) => hilbert3(a.x, a.y, a.t, BITS) - hilbert3(b.x, b.y, b.t, BITS),
  ),
  time: Array.from({ length: T }, (_, t) => t).flatMap((t) =>
    H2.map(([x, y]) => ({ x, y, t })),
  ),
};

const manhattan = (a: Cell, b: Cell) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.t - b.t);

/** Jumps in the walk — consecutive blobs that are NOT grid neighbours. */
const SEEKS: Record<OrderKey, number> = Object.fromEntries(
  ORDER_KEYS.map((k) => [
    k,
    ORDERS[k].slice(1).filter((c, i) => manhattan(ORDERS[k][i], c) !== 1)
      .length,
  ]),
) as Record<OrderKey, number>;

/* ── The gestures: real map+time interactions, as frame-by-frame reads ──── */

// A 2×2 viewport anchored at (x, y). The playback "viewport" is the first 2×2
// quadrant the 2D walk fills, so scrubbing it is one contiguous run under the
// time-deep spatial walk (that's the whole point).
const VIEWPORT = H2.slice(0, 4);
const QUADS = [
  H2.slice(0, 4),
  H2.slice(4, 8),
  H2.slice(8, 12),
  H2.slice(12, 16),
];
const TAP = H2[8]; // a central tile — the one a click warms

const box = (x: number, y: number): [number, number][] => [
  [x, y],
  [x + 1, y],
  [x, y + 1],
  [x + 1, y + 1],
];
const at = (xy: [number, number][], t: number): Cell[] =>
  xy.map(([x, y]) => ({ x, y, t }));
const allAt = (t: number): Cell[] => H2.map(([x, y]) => ({ x, y, t }));

interface Interaction {
  label: string; // control + prose
  short: string; // table header
  blurb: React.ReactNode;
  frames: Cell[][]; // ordered working sets — one per tick of the gesture
}

const INTERACTIONS: Record<GestureKey, Interaction> = {
  play: {
    label: 'play',
    short: 'play',
    blurb: (
      <>
        Fixed viewport, the playhead runs forward — the classic playback loop.
        Each visible tile wants its <em>whole timeline</em> in one pull, so the
        time-deep <span className="font-mono">spatial</span> walk (and the 3D
        generalist) read it as a single run;{' '}
        <span className="font-mono">time</span>-major seeks on every tick.
      </>
    ),
    frames: [0, 1, 2, 3].map((t) => at(VIEWPORT, t)),
  },
  pan: {
    label: 'pan',
    short: 'pan',
    blurb: (
      <>
        Frozen playhead, drag across the map. Now you want one whole{' '}
        <em>instant</em> contiguous — <span className="font-mono">time</span>
        -major delivers it in a single run, while the time-deep{' '}
        <span className="font-mono">spatial</span> walk shatters into a read per
        tile.
      </>
    ),
    frames: QUADS.map((q) => at(q, 1)),
  },
  panPlay: {
    label: 'pan + play',
    short: 'pan+play',
    blurb: (
      <>
        Drag across the map <em>while it plays</em> — moving through space and
        time at once. Only the 3D <span className="font-mono">hilbert3</span>{' '}
        walk keeps consecutive reads local here; the pure-space and pure-time
        walks each fragment along the axis they ignore. This is why the cube
        walk is the default generalist.
      </>
    ),
    frames: [
      at(box(0, 0), 0),
      at(box(1, 1), 1),
      at(box(2, 2), 2),
      at(box(2, 2), 3),
    ],
  },
  zoom: {
    label: 'zoom + play',
    short: 'zoom+play',
    blurb: (
      <>
        Pull back to an overview, then dive in as it plays. The wide overview
        frame is one big single-instant read — cheap for{' '}
        <span className="font-mono">time</span>-major and the cube walk, but the
        time-deep walk fetches it a tile at a time. Zoom changes the{' '}
        <em>size</em> of each read, not just the count.
      </>
    ),
    frames: [allAt(0), at(box(0, 0), 1), at(box(0, 0), 2), at(box(0, 0), 3)],
  },
  preload: {
    label: 'click → preload',
    short: 'click',
    blurb: (
      <>
        Tap a tile to warm its <em>whole timeline</em> — a speculative prefetch.
        Under the time-deep <span className="font-mono">spatial</span> walk
        that's one contiguous read; under{' '}
        <span className="font-mono">time</span>-major it's a seek per bucket.
        Even prefetches ride the walk you chose.
      </>
    ),
    frames: [
      [{ x: TAP[0], y: TAP[1], t: 1 }],
      [
        { x: TAP[0], y: TAP[1], t: 0 },
        { x: TAP[0], y: TAP[1], t: 2 },
      ],
      [{ x: TAP[0], y: TAP[1], t: 3 }],
    ],
  },
};

/** The distinct tiles a gesture touches over its whole run. */
const CUMULATIVE: Record<GestureKey, Cell[]> = Object.fromEntries(
  GESTURE_KEYS.map((g) => {
    const seen = new Set<string>();
    const cells: Cell[] = [];
    for (const frame of INTERACTIONS[g].frames)
      for (const c of frame)
        if (!seen.has(key(c))) {
          seen.add(key(c));
          cells.push(c);
        }
    return [g, cells];
  }),
) as Record<GestureKey, Cell[]>;

const HITSET: Record<GestureKey, Set<string>> = Object.fromEntries(
  GESTURE_KEYS.map((g) => [g, new Set(CUMULATIVE[g].map(key))]),
) as Record<GestureKey, Set<string>>;

/** Byte positions a set of tiles touches under an ordering, grouped into runs. */
function runsOf(
  order: Cell[],
  want: Set<string>,
): { positions: number[]; runs: [number, number][] } {
  const positions = order
    .map((c, i) => (want.has(key(c)) ? i : -1))
    .filter((i) => i >= 0);
  const runs: [number, number][] = [];
  for (const p of positions) {
    const last = runs[runs.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  return { positions, runs };
}

const STATS: Record<
  OrderKey,
  Record<GestureKey, ReturnType<typeof runsOf>>
> = Object.fromEntries(
  ORDER_KEYS.map((k) => [
    k,
    Object.fromEntries(
      GESTURE_KEYS.map((g) => [g, runsOf(ORDERS[k], HITSET[g])]),
    ),
  ]),
) as Record<OrderKey, Record<GestureKey, ReturnType<typeof runsOf>>>;

/**
 * The reader's state part-way through a gesture: `active` is the working set
 * being requested this instant, `touched` is everything requested so far.
 * Pure so the render test can drive it at any progress.
 */
function sceneAt(
  gesture: GestureKey,
  p: number,
): { active: Set<string>; touched: Set<string>; idx: number } {
  const frames = INTERACTIONS[gesture].frames;
  const fc = frames.length;
  const clamped = Math.min(Math.max(p, 0), 1);
  const idx = Math.min(Math.floor(clamped * fc), fc - 1);
  const active = new Set(frames[idx].map(key));
  const touched = new Set<string>();
  for (let i = 0; i <= idx; i++) for (const c of frames[i]) touched.add(key(c));
  return { active, touched, idx };
}

/* ── Isometric projection: t points up ────────────────────────────────── */

const IW = 26; // half-width of one cell step
const IH = 13; // half-height of one cell step
const LZ = 32; // vertical pitch per time bucket
const MX = 130;
const MY = 152;

const iso = (x: number, y: number, t: number): [number, number] => [
  MX + (x - y) * IW,
  MY + (x + y) * IH - t * LZ,
];

const isoPoly = (pts: [number, number, number][]) =>
  pts.map(([x, y, t]) => iso(x, y, t).join(',')).join(' ');

/* ── Sub-components ───────────────────────────────────────────────────── */

const Seg = <K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: K; label: string }[];
  value: K;
  onChange: (k: K) => void;
}) => (
  <div className="flex items-center gap-2">
    <span
      className="text-[10px] font-medium uppercase tracking-wide"
      style={{ color: 'var(--ink-400)' }}
    >
      {label}
    </span>
    <div
      className="flex flex-wrap rounded-full p-0.5"
      style={{
        background: 'var(--surface-sunken)',
        border: '1px solid var(--hairline)',
      }}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={
              active
                ? {
                    background: 'var(--surface)',
                    color: 'var(--accent)',
                    boxShadow: '0 0 0 1px var(--accent)',
                  }
                : { background: 'transparent', color: 'var(--ink-500)' }
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  </div>
);

const GZ = -0.55; // the base plane, just below the t=0 tile centers

/** The isometric cube: the walk threaded faintly through it, the gesture lit on top. */
const Cube: React.FC<{
  order: OrderKey;
  gesture: GestureKey;
  active: Set<string>;
  touched: Set<string>;
  animating: boolean;
}> = ({ order, gesture, active, touched, animating }) => {
  const cells = ORDERS[order];
  const inCum = HITSET[gesture];

  // Base-plane grid just below the t=0 centers, so the lattice reads as "the map".
  const gridLines: React.ReactNode[] = [];
  for (let i = 0; i <= N; i++) {
    const b = i - 0.5;
    const [ax, ay] = iso(b, -0.5, GZ);
    const [bx, by] = iso(b, N - 0.5, GZ);
    const [cx, cy] = iso(-0.5, b, GZ);
    const [dx, dy] = iso(N - 0.5, b, GZ);
    gridLines.push(
      <line
        key={`gx${i}`}
        x1={ax}
        y1={ay}
        x2={bx}
        y2={by}
        stroke="var(--hairline)"
        strokeWidth="0.9"
      />,
      <line
        key={`gy${i}`}
        x1={cx}
        y1={cy}
        x2={dx}
        y2={dy}
        stroke="var(--hairline)"
        strokeWidth="0.9"
      />,
    );
  }

  // The gesture's viewport, drawn as translucent footprints on each active
  // time-plane plus posts down to the map — the "camera" moving through the cube.
  const activeCells = ALL.filter((c) => active.has(key(c)));
  let viewport: React.ReactNode = null;
  if (activeCells.length) {
    const xs = activeCells.map((c) => c.x);
    const ys = activeCells.map((c) => c.y);
    const ts = activeCells.map((c) => c.t);
    const minx = Math.min(...xs) - 0.5;
    const maxx = Math.max(...xs) + 0.5;
    const miny = Math.min(...ys) - 0.5;
    const maxy = Math.max(...ys) + 0.5;
    const activeTs = [...new Set(ts)].sort((a, b) => a - b);
    const topT = activeTs[activeTs.length - 1];
    const corners: [number, number][] = [
      [minx, miny],
      [maxx, miny],
      [maxx, maxy],
      [minx, maxy],
    ];
    viewport = (
      <g>
        {corners.map(([cx, cy], i) => {
          const [x0, y0] = iso(cx, cy, GZ);
          const [x1, y1] = iso(cx, cy, topT);
          return (
            <line
              key={i}
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
              stroke={WARM}
              strokeWidth="0.9"
              opacity="0.5"
            />
          );
        })}
        {activeTs.map((t) => (
          <polygon
            key={t}
            points={isoPoly(
              corners.map(
                ([cx, cy]) => [cx, cy, t] as [number, number, number],
              ),
            )}
            fill={WARM_SOFT}
            stroke={WARM}
            strokeWidth="1"
          />
        ))}
      </g>
    );
  }

  // Painter's order for the dots: far corner first, low buckets first.
  const dots = [...ALL].sort((a, b) => a.x + a.y - (b.x + b.y) || a.t - b.t);

  // The walk drawn faintly, as the substrate the gesture reads across.
  const segs: React.ReactNode[] = [];
  for (let i = 0; i < SEGS; i++) {
    const [x0, y0] = iso(cells[i].x, cells[i].y, cells[i].t);
    const [x1, y1] = iso(cells[i + 1].x, cells[i + 1].y, cells[i + 1].t);
    const adjacent = manhattan(cells[i], cells[i + 1]) === 1;
    segs.push(
      <line
        key={i}
        x1={x0}
        y1={y0}
        x2={x1}
        y2={y1}
        stroke="var(--ink-500)"
        strokeWidth={adjacent ? 1 : 0.9}
        strokeDasharray={adjacent ? undefined : '3 3'}
        opacity={adjacent ? 0.22 : 0.3}
        strokeLinecap="round"
      />,
    );
  }

  // Time axis at the west corner of the base plane.
  const [tx, ty0] = iso(-0.5, N - 0.5, GZ);
  const [, ty1] = iso(-0.5, N - 0.5, T - 0.7);

  return (
    <FigureSvg
      viewBox="0 0 260 284"
      width="272"
      height="297"
      aria-label={`Diagram: the ${order} walk threading a 4 by 4 by 4 space-time cube of tile blobs, with the ${INTERACTIONS[gesture].label} gesture lighting up the tiles it reads.`}
    >
      {gridLines}
      {viewport}

      {/* time axis */}
      <line
        x1={tx}
        y1={ty0}
        x2={tx}
        y2={ty1}
        stroke="var(--ink-400)"
        strokeWidth="1"
      />
      <path
        d={`M ${tx - 3.5} ${ty1 + 6} L ${tx} ${ty1} L ${tx + 3.5} ${ty1 + 6}`}
        fill="none"
        stroke="var(--ink-400)"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x={tx}
        y={ty1 - 6}
        fontSize="9.5"
        textAnchor="middle"
        fill="var(--ink-500)"
      >
        time
      </text>

      {/* the walk, faint */}
      {segs}

      {/* blobs — idle / will-read / read / reading-now */}
      {dots.map((c) => {
        const [px, py] = iso(c.x, c.y, c.t);
        const k = key(c);
        if (active.has(k))
          return (
            <g key={k}>
              {animating ? (
                <circle cx={px} cy={py} r="6.5" fill={WARM} opacity="0.18" />
              ) : null}
              <circle
                cx={px}
                cy={py}
                r="4"
                fill={WARM}
                stroke="var(--accent)"
                strokeWidth="1.1"
              />
            </g>
          );
        if (touched.has(k))
          return (
            <circle
              key={k}
              cx={px}
              cy={py}
              r="3.4"
              fill={WARM}
              stroke={WARM_INK}
              strokeWidth="0.75"
            />
          );
        if (inCum.has(k))
          return (
            <circle
              key={k}
              cx={px}
              cy={py}
              r="3"
              fill="none"
              stroke={WARM_INK}
              strokeWidth="0.9"
              opacity="0.7"
            />
          );
        return (
          <circle
            key={k}
            cx={px}
            cy={py}
            r="1.7"
            fill="var(--ink-400)"
            opacity="0.4"
          />
        );
      })}

      <text
        x={MX}
        y="279"
        fontSize="9.5"
        textAnchor="middle"
        fill="var(--ink-500)"
      >
        the map plane (x, y)
      </text>
    </FigureSvg>
  );
};

/** The 64 blobs as one flat byte string; the gesture's reads coalesce (or don't) into runs. */
const ByteStrip: React.FC<{
  order: OrderKey;
  gesture: GestureKey;
  active: Set<string>;
  touched: Set<string>;
}> = ({ order, gesture, active, touched }) => {
  const cells = ORDERS[order];
  const inCum = HITSET[gesture];
  const { runs } = runsOf(cells, touched);
  const PITCH = 13;
  const W = CELLS * PITCH + 2;
  return (
    <FigureSvg
      viewBox={`0 0 ${W} 36`}
      className="w-full min-w-[540px]"
      aria-label={`Diagram: the same 64 blobs laid out as one byte string in ${order} order; the ${INTERACTIONS[gesture].label} gesture's reads so far group into ${runs.length} contiguous ${runs.length === 1 ? 'run' : 'runs'}.`}
    >
      {cells.map((c, i) => {
        const k = key(c);
        const isActive = active.has(k);
        const isTouched = touched.has(k);
        const wanted = inCum.has(k);
        const fill = isTouched ? WARM : 'none';
        const stroke = isActive
          ? 'var(--accent)'
          : wanted
            ? WARM_INK
            : 'var(--hairline)';
        return (
          <rect
            key={i}
            x={1 + i * PITCH}
            y="2"
            width={PITCH - 2}
            height="13"
            rx="2"
            fill={fill}
            stroke={stroke}
            strokeWidth={isActive ? 1.5 : wanted ? 0.9 : 0.75}
            opacity={wanted ? 1 : 0.5}
          />
        );
      })}
      {runs.map(([a, b], i) => (
        <path
          key={i}
          d={`M ${1 + a * PITCH} 21 v 4 H ${1 + b * PITCH + PITCH - 2} v -4`}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.25"
        />
      ))}
      <text x="1" y="35" fontSize="9" fontFamily={MONO} fill="var(--ink-400)">
        byte 0
      </text>
      <text
        x={W - 1}
        y="35"
        fontSize="9"
        fontFamily={MONO}
        textAnchor="end"
        fill="var(--ink-400)"
      >
        end of pack
      </text>
    </FigureSvg>
  );
};

/* ── The card ─────────────────────────────────────────────────────────── */

const FRAME_MS = 720; // wall-clock per gesture tick
const HOLD_MS = 1150; // dwell on the finished pattern before looping

const SpaceTimeCurve: React.FC = () => {
  const reduced = useReducedMotion();
  const [order, setOrder] = React.useState<OrderKey>('hilbert3');
  const [gesture, setGesture] = React.useState<GestureKey>('play');
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (reduced) return;
    setElapsed(0);
    let raf = 0;
    let last = performance.now();
    const play = INTERACTIONS[gesture].frames.length * FRAME_MS;
    const loop = play + HOLD_MS;
    const tick = (now: number) => {
      // The first rAF timestamp can precede the captured `now`; a negative dt
      // would run the clock backwards, so floor it at zero.
      const dt = Math.min(Math.max(now - last, 0), 250);
      last = now;
      setElapsed((e) => (e + dt >= loop ? 0 : e + dt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, order, gesture]);

  const frameCount = INTERACTIONS[gesture].frames.length;
  const p = reduced ? 1 : Math.min(elapsed / (frameCount * FRAME_MS), 1);
  // Reduced motion (and the very end of a run) show the whole touched set with
  // nothing pulsing; mid-gesture we track the moving working set.
  const scene = reduced
    ? { active: new Set<string>(), touched: HITSET[gesture] }
    : sceneAt(gesture, p);

  const finalRuns = STATS[order][gesture].runs.length;
  const label = INTERACTIONS[gesture].label;

  return (
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
        Deeper: laying the space-time cube down in a line
      </h4>
      <p
        className="mt-1 text-[11px] max-w-3xl"
        style={{ color: 'var(--ink-500)', lineHeight: 1.6 }}
      >
        A blob's address has three axes — (x, y) on the map plus a time bucket —
        but a pack is one flat byte string.{' '}
        <span className="font-mono">--blob-ordering</span> chooses the
        space-filling walk that linearizes the cube. Pick a walk, then play a
        real map+time gesture and watch which bytes it touches: the walk decides
        how many range reads the gesture costs.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Seg
          label="walk"
          value={order}
          onChange={setOrder}
          options={ORDER_KEYS.map((k) => ({ key: k, label: ORDER_LABEL[k] }))}
        />
        <Seg
          label="gesture"
          value={gesture}
          onChange={setGesture}
          options={GESTURE_KEYS.map((k) => ({
            key: k,
            label: INTERACTIONS[k].label,
          }))}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-x-6 gap-y-4 items-start">
        {/* the cube */}
        <div>
          <Cube
            order={order}
            gesture={gesture}
            active={scene.active}
            touched={scene.touched}
            animating={!reduced}
          />
          <div className="mt-1 grid grid-cols-1 gap-1 max-w-[272px]">
            <span
              className="inline-flex items-center gap-1.5 text-[10.5px]"
              style={{ color: 'var(--ink-500)' }}
            >
              <svg
                viewBox="0 0 12 12"
                width="12"
                height="12"
                aria-hidden="true"
              >
                <circle
                  cx="6"
                  cy="6"
                  r="4"
                  fill={WARM}
                  stroke="var(--accent)"
                  strokeWidth="1.1"
                />
              </svg>
              reading now (the gesture's viewport)
            </span>
            <span
              className="inline-flex items-center gap-1.5 text-[10.5px]"
              style={{ color: 'var(--ink-500)' }}
            >
              <svg
                viewBox="0 0 12 12"
                width="12"
                height="12"
                aria-hidden="true"
              >
                <circle
                  cx="6"
                  cy="6"
                  r="3.4"
                  fill={WARM}
                  stroke={WARM_INK}
                  strokeWidth="0.75"
                />
              </svg>
              already read this pass
            </span>
            <span
              className="inline-flex items-center gap-1.5 text-[10.5px]"
              style={{ color: 'var(--ink-500)' }}
            >
              <svg
                viewBox="0 0 12 12"
                width="12"
                height="12"
                aria-hidden="true"
              >
                <circle
                  cx="6"
                  cy="6"
                  r="3"
                  fill="none"
                  stroke={WARM_INK}
                  strokeWidth="0.9"
                  opacity="0.7"
                />
              </svg>
              still to read
            </span>
            <span
              className="inline-flex items-center gap-1.5 text-[10.5px]"
              style={{ color: 'var(--ink-500)' }}
            >
              <svg viewBox="0 0 22 6" width="22" height="6" aria-hidden="true">
                <line
                  x1="1"
                  y1="3"
                  x2="9"
                  y2="3"
                  stroke="var(--ink-500)"
                  strokeWidth="1"
                  opacity="0.3"
                  strokeLinecap="round"
                />
                <line
                  x1="13"
                  y1="3"
                  x2="21"
                  y2="3"
                  stroke="var(--ink-500)"
                  strokeWidth="0.9"
                  opacity="0.35"
                  strokeDasharray="3 3"
                />
              </svg>
              the walk: step / jump (a seek)
            </span>
          </div>
        </div>

        {/* the consequence */}
        <div className="min-w-0">
          <p
            className="text-[11px] leading-relaxed"
            style={{ color: 'var(--ink-500)' }}
          >
            {INTERACTIONS[gesture].blurb}
          </p>

          <div className="mt-3 overflow-x-auto">
            <ByteStrip
              order={order}
              gesture={gesture}
              active={scene.active}
              touched={scene.touched}
            />
          </div>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-700)' }}>
            <span className="font-semibold" style={{ color: 'var(--accent)' }}>
              {finalRuns} range {finalRuns === 1 ? 'read' : 'reads'}
            </span>{' '}
            for the {label} gesture under{' '}
            <span className="font-mono">{ORDER_LABEL[order]}</span> — watch the
            brackets fuse as it plays, before gap-coalescing merges the
            near-misses too.
          </p>

          <div className="mt-3 overflow-x-auto">
            <table className="border-collapse text-[11px]">
              <thead>
                <tr style={{ color: 'var(--ink-400)' }}>
                  <th className="text-left font-medium pb-1 pr-4">walk</th>
                  <th className="text-right font-medium pb-1 pr-3">seeks</th>
                  {GESTURE_KEYS.map((g) => (
                    <th
                      key={g}
                      className="text-right font-medium pb-1 pr-3 whitespace-nowrap"
                    >
                      {INTERACTIONS[g].short}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ORDER_KEYS.map((k) => {
                  const activeRow = k === order;
                  return (
                    <tr
                      key={k}
                      style={{
                        borderTop: '1px solid var(--hairline)',
                        background: activeRow
                          ? 'var(--accent-soft)'
                          : undefined,
                      }}
                    >
                      <td
                        className="py-1 pr-4 font-mono"
                        style={{
                          color: activeRow ? 'var(--accent)' : 'var(--ink-700)',
                        }}
                      >
                        {ORDER_LABEL[k]}
                      </td>
                      <td
                        className="py-1 pr-3 font-mono text-right"
                        style={{ color: 'var(--ink-500)' }}
                      >
                        {SEEKS[k]}
                      </td>
                      {GESTURE_KEYS.map((g) => {
                        const cellActive = activeRow && g === gesture;
                        return (
                          <td
                            key={g}
                            className="py-1 pr-3 font-mono text-right"
                            style={{
                              color: cellActive
                                ? 'var(--accent)'
                                : 'var(--ink-500)',
                              fontWeight: cellActive ? 600 : 400,
                            }}
                          >
                            {STATS[k][g].runs.length}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p
            className="mt-1.5 text-[10.5px]"
            style={{ color: 'var(--ink-400)' }}
          >
            Range reads per gesture. Notice the cube walk never spikes —
            1·4·5·3·2, no catastrophes — while the specialists each blow up on
            the gesture they ignore.
          </p>
        </div>
      </div>

      <p
        className="mt-3 pt-3 text-[11px] leading-relaxed"
        style={{
          color: 'var(--ink-500)',
          borderTop: '1px solid var(--hairline)',
        }}
      >
        <span className="font-mono">--blob-ordering auto</span> measures the
        archive's shape and picks the walk: time-deep datasets (a buoy's
        four-year track over a few cells) get{' '}
        <span className="font-mono">spatial</span>, because playback wants each
        cell's whole timeline in one pull — measured ~3× fewer requests than the
        cube walk there. Balanced or space-heavy datasets (a day of global
        flights) get the <span className="font-mono">hilbert3</span> generalist.
        Either way the directory index keeps its own{' '}
        <span className="font-mono">(zoom, hilbert(x,y), t)</span> sort — the
        knob permutes bytes inside packs, never keys.
      </p>
    </div>
  );
};

export default SpaceTimeCurve;

/** Internals exposed for the contract test only — not part of the page API. */
export const __test = {
  ORDERS,
  ORDER_KEYS,
  GESTURE_KEYS,
  INTERACTIONS,
  CUMULATIVE,
  STATS,
  SEEKS,
  CELLS,
  sceneAt,
  Cube,
  ByteStrip,
};
