import React from "react";
import { useReducedMotion } from "../../lib/reducedMotion";

/**
 * The space-time cube figure: a tile blob's address has three axes — (x, y)
 * on the map plus a time bucket — but a pack is one flat byte string.
 * `--blob-ordering` picks the space-filling walk that linearizes that cube
 * (see `crates/stt-core/src/curve.rs`); this draws the three real orderings
 * threading a toy 4×4×4 cube, and a byte strip showing how the two canonical
 * queries (scrub a viewport / pan at one instant) coalesce under each.
 *
 * The curve math is a direct port of curve.rs: the classic d2xy for the 2D
 * Hilbert walk, Skilling's transpose algorithm for the 3D one. Run counts in
 * the comparison table are computed from the same arrays the SVG draws, so
 * the numbers can never drift from the picture.
 */

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

const WARM = "rgba(240, 193, 75, 0.9)";
const WARM_SOFT = "rgba(240, 193, 75, 0.16)";
const WARM_INK = "#8a5a0a";

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

const H2: [number, number][] = Array.from({ length: N * N }, (_, d) => hilbert2(2, d));

const ALL: Cell[] = [];
for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let t = 0; t < T; t++) ALL.push({ x, y, t });

type OrderKey = "spatial" | "hilbert3" | "time";
type QueryKey = "scrub" | "pan";

const ORDERS: Record<OrderKey, Cell[]> = {
  spatial: H2.flatMap(([x, y]) => Array.from({ length: T }, (_, t) => ({ x, y, t }))),
  hilbert3: [...ALL].sort((a, b) => hilbert3(a.x, a.y, a.t, BITS) - hilbert3(b.x, b.y, b.t, BITS)),
  time: Array.from({ length: T }, (_, t) => t).flatMap((t) => H2.map(([x, y]) => ({ x, y, t }))),
};

const manhattan = (a: Cell, b: Cell) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.t - b.t);

/** Jumps in the walk — consecutive blobs that are NOT grid neighbours. */
const SEEKS: Record<OrderKey, number> = Object.fromEntries(
  (Object.keys(ORDERS) as OrderKey[]).map((k) => [
    k,
    ORDERS[k].slice(1).filter((c, i) => manhattan(ORDERS[k][i], c) !== 1).length,
  ]),
) as Record<OrderKey, number>;

/* ── The two canonical queries (16 of 64 tiles each) ──────────────────── */

// The viewport: the first 2×2 quadrant the 2D walk fills (x, y ∈ {0, 1}).
const VIEWPORT = new Set(H2.slice(0, 4).map(([x, y]) => `${x},${y}`));
const PAN_T = 1; // the frozen playhead's bucket

const QUERIES: Record<QueryKey, { label: string; hit: (c: Cell) => boolean }> = {
  scrub: { label: "scrub a viewport", hit: (c) => VIEWPORT.has(`${c.x},${c.y}`) },
  pan: { label: "pan at one instant", hit: (c) => c.t === PAN_T },
};

/** Byte positions the query touches under an ordering, grouped into runs. */
function runsOf(order: Cell[], hit: (c: Cell) => boolean): { positions: number[]; runs: [number, number][] } {
  const positions = order.map((c, i) => (hit(c) ? i : -1)).filter((i) => i >= 0);
  const runs: [number, number][] = [];
  for (const p of positions) {
    const last = runs[runs.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  return { positions, runs };
}

const STATS: Record<OrderKey, Record<QueryKey, ReturnType<typeof runsOf>>> = Object.fromEntries(
  (Object.keys(ORDERS) as OrderKey[]).map((k) => [
    k,
    { scrub: runsOf(ORDERS[k], QUERIES.scrub.hit), pan: runsOf(ORDERS[k], QUERIES.pan.hit) },
  ]),
) as Record<OrderKey, Record<QueryKey, ReturnType<typeof runsOf>>>;

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
  pts.map(([x, y, t]) => iso(x, y, t).join(",")).join(" ");

const ORDER_META: Record<OrderKey, { label: string; blurb: React.ReactNode }> = {
  spatial: {
    label: "2D Hilbert + time",
    blurb: (
      <>
        The classic map-tile walk: a 2D Hilbert curve threads the map plane,
        and each cell lays down its <em>whole timeline</em> before the curve
        moves on. Scrubbing a fixed viewport is one contiguous read — but one
        instant across the whole map shatters into a read per cell.
      </>
    ),
  },
  hilbert3: {
    label: "3D Hilbert",
    blurb: (
      <>
        Space and time threaded as a single cube: one 3D Hilbert curve visits
        every blob so that consecutive blobs are <em>always</em> neighbours in
        x, y or t — zero seeks, by construction. Neither scrubbing nor panning
        is ever catastrophic, which is why it's the default generalist.
      </>
    ),
  },
  time: {
    label: "time-major",
    blurb: (
      <>
        Frame by frame: every map cell of one instant, then the next instant.
        Panning at a frozen playhead is a single read, but every tick of
        playback seeks across the entire file — the worst walk for the most
        common access pattern.
      </>
    ),
  },
};

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
    <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-400)" }}>
      {label}
    </span>
    <div
      className="flex rounded-full p-0.5"
      style={{ background: "var(--surface-sunken)", border: "1px solid var(--hairline)" }}
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
                ? { background: "var(--surface)", color: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" }
                : { background: "transparent", color: "var(--ink-500)" }
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  </div>
);

/** The isometric cube with the walk drawn up to `drawn` segments. */
const Cube: React.FC<{ order: OrderKey; query: QueryKey; drawn: number; animating: boolean }> = ({
  order,
  query,
  drawn,
  animating,
}) => {
  const cells = ORDERS[order];
  const hit = QUERIES[query].hit;

  // Base-plane grid just below the t=0 centers, so the lattice reads as "the map".
  const GZ = -0.55;
  const gridLines: React.ReactNode[] = [];
  for (let i = 0; i <= N; i++) {
    const b = i - 0.5;
    const [ax, ay] = iso(b, -0.5, GZ);
    const [bx, by] = iso(b, N - 0.5, GZ);
    const [cx, cy] = iso(-0.5, b, GZ);
    const [dx, dy] = iso(N - 0.5, b, GZ);
    gridLines.push(
      <line key={`gx${i}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="var(--hairline)" strokeWidth="0.9" />,
      <line key={`gy${i}`} x1={cx} y1={cy} x2={dx} y2={dy} stroke="var(--hairline)" strokeWidth="0.9" />,
    );
  }

  // Query highlight: the viewport column (scrub) or the one-instant slab (pan).
  let highlight: React.ReactNode = null;
  if (query === "scrub") {
    const corners: [number, number, number][] = [
      [-0.5, -0.5, GZ],
      [1.5, -0.5, GZ],
      [1.5, 1.5, GZ],
      [-0.5, 1.5, GZ],
    ];
    highlight = (
      <g>
        <polygon points={isoPoly(corners)} fill={WARM_SOFT} stroke={WARM} strokeWidth="1" />
        {corners.map(([x, y], i) => {
          const [x0, y0] = iso(x, y, GZ);
          const [x1, y1] = iso(x, y, T - 0.8);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={WARM} strokeWidth="0.9" opacity="0.55" />;
        })}
      </g>
    );
  } else {
    highlight = (
      <polygon
        points={isoPoly([
          [-0.5, -0.5, PAN_T],
          [N - 0.5, -0.5, PAN_T],
          [N - 0.5, N - 0.5, PAN_T],
          [-0.5, N - 0.5, PAN_T],
        ])}
        fill={WARM_SOFT}
        stroke={WARM}
        strokeWidth="1"
      />
    );
  }

  // Painter's order for the dots: far corner first, low buckets first.
  const dots = [...ALL].sort((a, b) => a.x + a.y - (b.x + b.y) || a.t - b.t);

  // Clamp hard: `drawn` drives array indexing, and animation timing must
  // never be able to walk it out of [0, SEGS].
  const full = Math.min(Math.max(Math.floor(drawn), 0), SEGS);
  const frac = Math.min(Math.max(drawn - full, 0), 1);

  const segs: React.ReactNode[] = [];
  for (let i = 0; i < Math.min(full, SEGS); i++) {
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
        stroke="var(--accent)"
        strokeWidth={adjacent ? 1.8 : 1.1}
        strokeDasharray={adjacent ? undefined : "3 3"}
        opacity={adjacent ? 0.9 : 0.4}
        strokeLinecap="round"
      />,
    );
  }
  let head: [number, number] | null = null;
  if (full < SEGS) {
    const a = cells[full];
    const b = cells[full + 1];
    const [x0, y0] = iso(a.x, a.y, a.t);
    const [x1, y1] = iso(b.x, b.y, b.t);
    const hx = x0 + (x1 - x0) * frac;
    const hy = y0 + (y1 - y0) * frac;
    if (frac > 0) {
      const adjacent = manhattan(a, b) === 1;
      segs.push(
        <line
          key="partial"
          x1={x0}
          y1={y0}
          x2={hx}
          y2={hy}
          stroke="var(--accent)"
          strokeWidth={adjacent ? 1.8 : 1.1}
          strokeDasharray={adjacent ? undefined : "3 3"}
          opacity={adjacent ? 0.9 : 0.4}
          strokeLinecap="round"
        />,
      );
    }
    head = [hx, hy];
  }

  // Time axis at the west corner of the base plane.
  const [tx, ty0] = iso(-0.5, N - 0.5, GZ);
  const [, ty1] = iso(-0.5, N - 0.5, T - 0.7);

  return (
    <svg
      viewBox="0 0 260 284"
      width="272"
      height="297"
      role="img"
      aria-label={`Diagram: the ${ORDER_META[order].label} walk threading a 4 by 4 by 4 space-time cube of tile blobs; highlighted tiles are the ones a ${QUERIES[query].label} query needs.`}
    >
      {gridLines}
      {highlight}

      {/* time axis */}
      <line x1={tx} y1={ty0} x2={tx} y2={ty1} stroke="var(--ink-400)" strokeWidth="1" />
      <path d={`M ${tx - 3.5} ${ty1 + 6} L ${tx} ${ty1} L ${tx + 3.5} ${ty1 + 6}`} fill="none" stroke="var(--ink-400)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      <text x={tx} y={ty1 - 6} fontSize="9.5" textAnchor="middle" fill="var(--ink-500)">
        time
      </text>

      {/* blobs */}
      {dots.map((c) => {
        const [px, py] = iso(c.x, c.y, c.t);
        return hit(c) ? (
          <circle key={`${c.x}-${c.y}-${c.t}`} cx={px} cy={py} r="3.4" fill={WARM} stroke={WARM_INK} strokeWidth="0.75" />
        ) : (
          <circle key={`${c.x}-${c.y}-${c.t}`} cx={px} cy={py} r="1.7" fill="var(--ink-400)" opacity="0.4" />
        );
      })}

      {/* the walk */}
      {segs}
      {animating && head ? <circle cx={head[0]} cy={head[1]} r="3" fill="var(--accent)" /> : null}

      <text x={MX} y="279" fontSize="9.5" textAnchor="middle" fill="var(--ink-500)">
        the map plane (x, y)
      </text>
    </svg>
  );
};

/** The 64 blobs as one flat byte string, with the query's runs bracketed. */
const ByteStrip: React.FC<{ order: OrderKey; query: QueryKey; drawn: number }> = ({ order, query, drawn }) => {
  const { positions, runs } = STATS[order][query];
  const posSet = new Set(positions);
  const PITCH = 13;
  const W = CELLS * PITCH + 2;
  return (
    <svg
      viewBox={`0 0 ${W} 36`}
      className="w-full min-w-[540px]"
      role="img"
      aria-label={`Diagram: the same 64 blobs laid out as one byte string in ${ORDER_META[order].label} order; the ${QUERIES[query].label} query touches 16 of them in ${runs.length} contiguous ${runs.length === 1 ? "run" : "runs"}.`}
    >
      {Array.from({ length: CELLS }, (_, i) => {
        const wanted = posSet.has(i);
        const written = i <= drawn;
        return (
          <rect
            key={i}
            x={1 + i * PITCH}
            y="2"
            width={PITCH - 2}
            height="13"
            rx="2"
            fill={wanted ? (written ? WARM : "none") : written ? "var(--surface-sunken)" : "none"}
            stroke={wanted ? WARM_INK : "var(--hairline)"}
            strokeWidth={wanted ? 0.9 : 0.75}
            opacity={written ? 1 : 0.55}
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
      <text x={W - 1} y="35" fontSize="9" fontFamily={MONO} textAnchor="end" fill="var(--ink-400)">
        end of pack
      </text>
    </svg>
  );
};

/* ── The card ─────────────────────────────────────────────────────────── */

const ORDER_KEYS: OrderKey[] = ["spatial", "hilbert3", "time"];
const HOLD = 22; // extra "segments" of hold time before the draw loops

const SpaceTimeCurve: React.FC = () => {
  const reduced = useReducedMotion();
  const [order, setOrder] = React.useState<OrderKey>("hilbert3");
  const [query, setQuery] = React.useState<QueryKey>("scrub");
  const [seg, setSeg] = React.useState(0);

  React.useEffect(() => {
    if (reduced) {
      setSeg(SEGS);
      return;
    }
    setSeg(0);
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // The first rAF timestamp can precede the performance.now() captured
      // above (it's the frame's vsync start) — a negative dt would walk the
      // curve out of bounds, so floor it at zero.
      const dt = Math.min(Math.max(now - last, 0), 250);
      last = now;
      setSeg((s) => (s + dt / 65 >= SEGS + HOLD ? 0 : s + dt / 65));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, order]);

  const drawn = Math.min(seg, SEGS);
  const runs = STATS[order][query].runs.length;

  return (
    <div
      className="rounded-lg p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
    >
      <h4 className="font-display text-[13px] font-semibold" style={{ color: "var(--ink-900)" }}>
        Deeper: laying the space-time cube down in a line
      </h4>
      <p className="mt-1 text-[11px] max-w-3xl" style={{ color: "var(--ink-500)", lineHeight: 1.6 }}>
        A blob's address has three axes — (x, y) on the map plus a time bucket —
        but a pack is one flat byte string. <span className="font-mono">--blob-ordering</span>{" "}
        chooses the space-filling walk that linearizes the cube, and the walk decides
        how many range reads a query costs.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Seg
          label="walk"
          value={order}
          onChange={setOrder}
          options={ORDER_KEYS.map((k) => ({ key: k, label: ORDER_META[k].label }))}
        />
        <Seg
          label="query"
          value={query}
          onChange={setQuery}
          options={(Object.keys(QUERIES) as QueryKey[]).map((k) => ({ key: k, label: QUERIES[k].label }))}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-x-6 gap-y-4 items-start">
        {/* the cube */}
        <div>
          <Cube order={order} query={query} drawn={drawn} animating={!reduced} />
          <div className="mt-1 flex flex-col gap-1 max-w-[272px]">
            <span className="inline-flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--ink-500)" }}>
              <svg viewBox="0 0 18 6" width="18" height="6" aria-hidden="true">
                <line x1="1" y1="3" x2="17" y2="3" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              adjacent step — bytes touch
            </span>
            <span className="inline-flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--ink-500)" }}>
              <svg viewBox="0 0 18 6" width="18" height="6" aria-hidden="true">
                <line x1="1" y1="3" x2="17" y2="3" stroke="var(--accent)" strokeWidth="1.1" strokeDasharray="3 3" opacity="0.5" />
              </svg>
              jump — a seek in the file
            </span>
            <span className="inline-flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--ink-500)" }}>
              <svg viewBox="0 0 18 8" width="18" height="8" aria-hidden="true">
                <circle cx="9" cy="4" r="3.4" fill={WARM} stroke={WARM_INK} strokeWidth="0.75" />
              </svg>
              blobs the query needs (16 of 64)
            </span>
          </div>
        </div>

        {/* the consequence */}
        <div className="min-w-0">
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--ink-500)" }}>
            {ORDER_META[order].blurb}
          </p>

          <div className="mt-3 overflow-x-auto">
            <ByteStrip order={order} query={query} drawn={drawn} />
          </div>
          <p className="mt-1 text-[11px]" style={{ color: "var(--ink-700)" }}>
            <span className="font-semibold" style={{ color: "var(--accent)" }}>
              {runs} range {runs === 1 ? "read" : "reads"}
            </span>{" "}
            for the {QUERIES[query].label} query — before gap-coalescing fuses the near-misses.
          </p>

          <table className="mt-3 border-collapse text-[11px]">
            <thead>
              <tr style={{ color: "var(--ink-400)" }}>
                <th className="text-left font-medium pb-1 pr-4">walk</th>
                <th className="text-right font-medium pb-1 pr-4">seeks</th>
                <th className="text-right font-medium pb-1 pr-4">scrub</th>
                <th className="text-right font-medium pb-1">pan</th>
              </tr>
            </thead>
            <tbody>
              {ORDER_KEYS.map((k) => {
                const active = k === order;
                return (
                  <tr
                    key={k}
                    style={{
                      borderTop: "1px solid var(--hairline)",
                      background: active ? "var(--accent-soft)" : undefined,
                    }}
                  >
                    <td className="py-1 pr-4 font-mono" style={{ color: active ? "var(--accent)" : "var(--ink-700)" }}>
                      {ORDER_META[k].label}
                    </td>
                    <td className="py-1 pr-4 font-mono text-right" style={{ color: "var(--ink-500)" }}>
                      {SEEKS[k]}
                    </td>
                    {(["scrub", "pan"] as QueryKey[]).map((q) => (
                      <td
                        key={q}
                        className={`py-1 font-mono text-right ${q === "scrub" ? "pr-4" : ""}`}
                        style={{
                          color: active && q === query ? "var(--accent)" : "var(--ink-500)",
                          fontWeight: active && q === query ? 600 : 400,
                        }}
                      >
                        {STATS[k][q].runs.length}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p
        className="mt-3 pt-3 text-[11px] leading-relaxed"
        style={{ color: "var(--ink-500)", borderTop: "1px solid var(--hairline)" }}
      >
        <span className="font-mono">--blob-ordering auto</span> measures the
        archive's shape and picks the walk: time-deep datasets (a buoy's
        four-year track over a few cells) get{" "}
        <span className="font-mono">spatial</span>, because playback wants each
        cell's whole timeline in one pull — measured ~3× fewer requests than the
        cube walk there. Balanced or space-heavy datasets (a day of global
        flights) get the <span className="font-mono">hilbert3</span> generalist.
        Either way the directory index keeps its own{" "}
        <span className="font-mono">(zoom, hilbert(x,y), t)</span> sort — the
        knob permutes bytes inside packs, never keys.
      </p>
    </div>
  );
};

export default SpaceTimeCurve;

/** Internals exposed for the contract test only — not part of the page API. */
export const __test = { ORDERS, STATS, SEEKS, CELLS, SEGS, HOLD, Cube, ByteStrip };
