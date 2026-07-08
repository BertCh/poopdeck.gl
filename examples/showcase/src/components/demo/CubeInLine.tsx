import React from 'react';
import {
  type DensityProfile,
  PROFILE_META,
  loadDensityProfile,
  expandCube,
} from '../../lib/densityProfile';
import {
  type Cell,
  type Query,
  type Walk,
  WALKS,
  WALK_LABEL,
  bitsFor,
  linearize,
  scrubHit,
  panHit,
  simulateQuery,
} from '../../lib/spaceCurve';

/**
 * "Laying the space-time cube down in a line" — for a *real* dataset.
 *
 * The how-it-works figure (`how/SpaceTimeCurve.tsx`) tells this story on a
 * synthetic, fully-occupied 4×4×4 cube. This is the same idea driven by a real
 * archive's density profile (`/density/<id>.json`): the cube is sparse and
 * skewed, so where the data mass sits — deep in time, or wide in space — decides
 * which `--blob-ordering` walk linearizes it into the fewest range reads. Switch
 * datasets and the winning walk flips. All curve math is a port of the
 * production `crates/stt-core/src/curve.rs`; the density is sampled to an
 * SB×SB×TB grid (labelled below), and the archive's real anchors (`auto` pick,
 * adjacency breaks) come straight from the directory.
 *
 * No continuous motion — every pixel is a pure function of the controls — so
 * there is nothing for `prefers-reduced-motion` to gate.
 */

type Weight = 'count' | 'bytes';

const QUERY_LABEL: Record<Query, string> = {
  scrub: 'scrub a viewport',
  pan: 'pan at one instant',
};

const HEAT_COLS = 40; // space-order columns in the heatmap
const STRIP_COLS = 240; // columns in the laid-down line
const GAP_MAX = 24;

const fmt = (n: number): string =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}k`
      : `${Math.round(n)}`;

const bytesFmt = (n: number): string =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)} MB`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(0)} kB`
      : `${n} B`;

/** A generic space-vs-time shape word from the archive's occupied extent. */
function shapeOf(profile: DensityProfile): string {
  const sx = bitsFor(profile.spaceExtent.x1 - profile.spaceExtent.x0 + 1);
  const sy = bitsFor(profile.spaceExtent.y1 - profile.spaceExtent.y0 + 1);
  const spaceBits = Math.max(sx, sy);
  const timeBits = bitsFor(profile.tbSpan + 1);
  if (timeBits > spaceBits + 3) return 'time-deep';
  if (spaceBits > timeBits + 3) return 'space-heavy';
  return 'balanced in space and time';
}

/* ── Segmented pill control (house style, from SpaceTimeCurve) ────────── */

function Seg<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: K; label: string }[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
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
}

/* ── Derived, gap-independent geometry (memoized on profile) ──────────── */

interface Base {
  cells: Cell[];
  orderedByWalk: Record<Walk, Cell[]>;
  scrub: (c: Cell) => boolean;
  pan: { hit: (c: Cell) => boolean; tb: number };
  rankOf: Map<number, number>; // h2 → rank in space order
  spaceCount: number;
}

function buildBase(profile: DensityProfile): Base {
  const cells = expandCube(profile);
  const { spaceBits, timeBins } = profile;
  const orderedByWalk = Object.fromEntries(
    WALKS.map((w) => [w, linearize(cells, w, spaceBits, timeBins)]),
  ) as Record<Walk, Cell[]>;
  const h2s = [...new Set(cells.map((c) => c.h2))].sort((a, b) => a - b);
  const rankOf = new Map(h2s.map((h, i) => [h, i] as [number, number]));
  return {
    cells,
    orderedByWalk,
    scrub: scrubHit(cells),
    pan: panHit(cells),
    rankOf,
    spaceCount: h2s.length,
  };
}

/* ── The laid-down line ───────────────────────────────────────────────── */

const Strip: React.FC<{
  ordered: Cell[];
  hits: number[];
  runs: [number, number][];
  weightOf: (c: Cell) => number;
}> = ({ ordered, hits, runs, weightOf }) => {
  const L = ordered.length;
  const cols = Math.min(STRIP_COLS, Math.max(L, 1));
  const colOf = (pos: number) =>
    Math.min(cols - 1, Math.floor((pos / Math.max(L, 1)) * cols));
  const w = new Float64Array(cols);
  const hot = new Uint8Array(cols);
  for (let i = 0; i < L; i++) w[colOf(i)] += weightOf(ordered[i]);
  for (const p of hits) hot[colOf(p)] = 1;
  let max = 0;
  for (const v of w) if (v > max) max = v;
  const pitch = 960 / cols;
  const H = 46;
  return (
    <svg
      viewBox="0 0 960 66"
      className="w-full"
      style={{ display: 'block' }}
      role="img"
      aria-label="The cube laid down in one line, columns weighted by data density; highlighted columns are the ones the query needs."
    >
      {Array.from({ length: cols }, (_, i) => {
        const h = max > 0 ? Math.max(1.2, Math.sqrt(w[i] / max) * H) : 1.2;
        return (
          <rect
            key={i}
            x={i * pitch}
            y={H - h + 2}
            width={Math.max(pitch - 0.5, 0.8)}
            height={h}
            fill={hot[i] ? 'var(--accent)' : 'var(--ink-400)'}
            opacity={hot[i] ? 0.95 : 0.32}
          />
        );
      })}
      <line
        x1="0"
        y1={H + 3}
        x2="960"
        y2={H + 3}
        stroke="var(--hairline)"
        strokeWidth="1"
      />
      {runs.map(([a, b], i) => {
        const x0 = colOf(a) * pitch;
        const x1 = colOf(b) * pitch + Math.max(pitch - 0.5, 0.8);
        return (
          <path
            key={i}
            d={`M ${x0} ${H + 5} v 5 H ${x1} v -5`}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.25"
          />
        );
      })}
      <text x="0" y="65" fontSize="9" fill="var(--ink-400)">
        byte 0
      </text>
      <text x="960" y="65" fontSize="9" textAnchor="end" fill="var(--ink-400)">
        end of pack
      </text>
    </svg>
  );
};

/* ── Density heatmap (space-order × time) with marginals ──────────────── */

const Heatmap: React.FC<{
  base: Base;
  profile: DensityProfile;
  weightOf: (c: Cell) => number;
  panTb: number;
}> = ({ base, profile, weightOf, panTb }) => {
  const { cells, rankOf, spaceCount } = base;
  const rows = profile.timeBins;
  const scols = Math.min(HEAT_COLS, Math.max(spaceCount, 1));
  const grid = new Float64Array(scols * rows);
  const spaceMarg = new Float64Array(scols);
  const timeMarg = new Float64Array(rows);
  const scolOf = (c: Cell) =>
    Math.min(
      scols - 1,
      Math.floor(((rankOf.get(c.h2) ?? 0) / Math.max(spaceCount, 1)) * scols),
    );
  for (const c of cells) {
    const sc = scolOf(c);
    const wv = weightOf(c);
    grid[c.tb * scols + sc] += wv;
    spaceMarg[sc] += wv;
    timeMarg[c.tb] += wv;
  }
  const gmax = Math.max(1, ...grid);
  const smax = Math.max(1, ...spaceMarg);
  const tmax = Math.max(1, ...timeMarg);

  const CELL = 6.5;
  const MARG = 22;
  const gridW = scols * CELL;
  const gridH = rows * CELL;
  const W = gridW + MARG + 8;
  const H = gridH + MARG + 16;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
      role="img"
      aria-label={`Density of ${profile.label} across space (Hilbert order, horizontal) and time (vertical).`}
    >
      {/* space marginal (top) */}
      {Array.from({ length: scols }, (_, i) => {
        const h = Math.sqrt(spaceMarg[i] / smax) * (MARG - 3);
        return (
          <rect
            key={`sm${i}`}
            x={i * CELL}
            y={MARG - 3 - h}
            width={CELL - 0.6}
            height={h}
            fill="var(--accent)"
            opacity={0.5}
          />
        );
      })}
      {/* the heatmap grid */}
      <g transform={`translate(0 ${MARG})`}>
        {Array.from({ length: rows }, (_, r) =>
          Array.from({ length: scols }, (_, cIdx) => {
            const v = grid[r * scols + cIdx];
            if (v <= 0) return null;
            const hot = r === panTb;
            return (
              <rect
                key={`${r}-${cIdx}`}
                x={cIdx * CELL}
                y={r * CELL}
                width={CELL - 0.6}
                height={CELL - 0.6}
                fill={hot ? 'var(--accent)' : 'var(--ink-700)'}
                opacity={0.14 + Math.sqrt(v / gmax) * 0.82}
              />
            );
          }),
        )}
      </g>
      {/* time marginal (right) */}
      <g transform={`translate(${gridW + 4} ${MARG})`}>
        {Array.from({ length: rows }, (_, r) => {
          const wv = Math.sqrt(timeMarg[r] / tmax) * (MARG - 4);
          return (
            <rect
              key={`tm${r}`}
              x={0}
              y={r * CELL}
              width={wv}
              height={CELL - 0.6}
              fill="var(--accent)"
              opacity={0.5}
            />
          );
        })}
      </g>
      <text x={0} y={H - 3} fontSize="8.5" fill="var(--ink-400)">
        space (Hilbert order) →
      </text>
      <text
        x={gridW + MARG}
        y={MARG - 6}
        fontSize="8.5"
        textAnchor="end"
        fill="var(--ink-400)"
      >
        time ↓
      </text>
    </svg>
  );
};

/* ── The interactive view (fetch-free; test renders this directly) ────── */

export const CubeInLineView: React.FC<{ profile: DensityProfile }> = ({
  profile,
}) => {
  const [walk, setWalk] = React.useState<Walk>(profile.autoChoice);
  const [query, setQuery] = React.useState<Query>('scrub');
  const [weight, setWeight] = React.useState<Weight>('count');
  const [gap, setGap] = React.useState(0);

  const base = React.useMemo(() => buildBase(profile), [profile]);
  const weightOf = React.useMemo<(c: Cell) => number>(
    () => (weight === 'count' ? (c) => c.count : (c) => c.bytes),
    [weight],
  );

  // Gap-dependent read costs for every walk × query (linearizations are cached
  // in `base`, so a gap tick only re-runs the O(n) coalescing sim).
  const table = React.useMemo(
    () =>
      WALKS.map((w) => ({
        walk: w,
        scrub: simulateQuery(base.orderedByWalk[w], base.scrub, gap, weightOf),
        pan: simulateQuery(base.orderedByWalk[w], base.pan.hit, gap, weightOf),
      })),
    [base, gap, weightOf],
  );

  const active = React.useMemo(() => {
    const ordered = base.orderedByWalk[walk];
    const hit = query === 'scrub' ? base.scrub : base.pan.hit;
    return { ordered, res: simulateQuery(ordered, hit, gap, weightOf) };
  }, [base, walk, query, gap, weightOf]);

  const bestSeek = (
    Object.entries(profile.nativeSeeks) as [Walk, number][]
  ).sort((a, b) => a[1] - b[1])[0][0];
  const shape = shapeOf(profile);
  const wf = weight === 'bytes' ? bytesFmt : fmt;
  const side = 1 << profile.spaceBits;

  return (
    <div>
      <p
        className="text-[11px] max-w-3xl"
        style={{ color: 'var(--ink-500)', lineHeight: 1.6 }}
      >
        Every blob has three axes — (x, y) on the map plus a time bucket — but a
        pack is one flat byte string. Here the cube is a <em>real</em> archive's
        density (sampled to a {side}×{side}×{profile.timeBins} grid from{' '}
        {fmt(profile.tileCount)} native tiles). The{' '}
        <span className="font-mono">walk</span> linearizes it, and the walk
        decides how many range reads a query costs — so where the data mass sits
        decides which walk wins.
      </p>

      {/* controls */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Seg
          label="walk"
          value={walk}
          onChange={setWalk}
          options={WALKS.map((w) => ({ key: w, label: WALK_LABEL[w] }))}
        />
        <Seg
          label="query"
          value={query}
          onChange={setQuery}
          options={(['scrub', 'pan'] as Query[]).map((q) => ({
            key: q,
            label: QUERY_LABEL[q],
          }))}
        />
        <Seg
          label="weight"
          value={weight}
          onChange={setWeight}
          options={[
            { key: 'count' as Weight, label: 'features' },
            { key: 'bytes' as Weight, label: 'bytes' },
          ]}
        />
        <label
          className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide"
          style={{ color: 'var(--ink-400)' }}
        >
          coalesce gap
          <input
            type="range"
            min={0}
            max={GAP_MAX}
            value={gap}
            onChange={(e) => setGap(Number(e.target.value))}
            style={{ accentColor: 'var(--accent)' }}
            aria-label="range-read coalescing gap"
          />
          <span className="font-mono" style={{ color: 'var(--ink-600)' }}>
            {gap}
          </span>
        </label>
      </div>

      {/* the laid-down line */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span
            className="text-[10px] font-medium uppercase tracking-wide"
            style={{ color: 'var(--ink-400)' }}
          >
            the cube, laid down in a line — {WALK_LABEL[walk]}
          </span>
          <span
            className="text-[11px] whitespace-nowrap"
            style={{ color: 'var(--ink-700)' }}
          >
            <span className="font-semibold" style={{ color: 'var(--accent)' }}>
              {active.res.reads} range{' '}
              {active.res.reads === 1 ? 'read' : 'reads'}
            </span>{' '}
            for {QUERY_LABEL[query]}
          </span>
        </div>
        <div className="mt-1">
          <Strip
            ordered={active.ordered}
            hits={active.res.hits}
            runs={active.res.runs}
            weightOf={weightOf}
          />
        </div>
        <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--ink-500)' }}>
          {wf(active.res.weightNeeded)} needed · {wf(active.res.weightRead)}{' '}
          read (needed + over-read) at a coalescing gap of {gap} blob
          {gap === 1 ? '' : 's'}.
        </p>
      </div>

      {/* density + tradeoff */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-x-8 gap-y-4 items-start">
        <div>
          <span
            className="text-[10px] font-medium uppercase tracking-wide"
            style={{ color: 'var(--ink-400)' }}
          >
            where the data mass sits
          </span>
          <div className="mt-1">
            <Heatmap
              base={base}
              profile={profile}
              weightOf={weightOf}
              panTb={base.pan.tb}
            />
          </div>
        </div>

        <div className="min-w-0">
          <table className="border-collapse text-[11px] w-full max-w-md">
            <thead>
              <tr style={{ color: 'var(--ink-400)' }}>
                <th className="text-left font-medium pb-1 pr-3">walk</th>
                <th className="text-right font-medium pb-1 pr-3">breaks*</th>
                <th className="text-right font-medium pb-1 pr-3">scrub</th>
                <th className="text-right font-medium pb-1">pan</th>
              </tr>
            </thead>
            <tbody>
              {table.map((row) => {
                const activeRow = row.walk === walk;
                const isAuto = row.walk === profile.autoChoice;
                return (
                  <tr
                    key={row.walk}
                    style={{
                      borderTop: '1px solid var(--hairline)',
                      background: activeRow
                        ? 'var(--accent-soft, rgba(240,193,75,0.10))'
                        : undefined,
                    }}
                  >
                    <td
                      className="py-1 pr-3 font-mono"
                      style={{
                        color: activeRow ? 'var(--accent)' : 'var(--ink-700)',
                      }}
                    >
                      {WALK_LABEL[row.walk]}
                      {isAuto ? (
                        <span
                          className="ml-1 text-[9px] uppercase tracking-wide"
                          style={{ color: 'var(--ink-400)' }}
                        >
                          auto
                        </span>
                      ) : null}
                    </td>
                    <td
                      className="py-1 pr-3 font-mono text-right"
                      style={{ color: 'var(--ink-500)' }}
                    >
                      {fmt(profile.nativeSeeks[row.walk])}
                    </td>
                    {(['scrub', 'pan'] as Query[]).map((q) => (
                      <td
                        key={q}
                        className={`py-1 font-mono text-right ${q === 'scrub' ? 'pr-3' : ''}`}
                        style={{
                          color:
                            activeRow && q === query
                              ? 'var(--accent)'
                              : 'var(--ink-500)',
                          fontWeight: activeRow && q === query ? 600 : 400,
                        }}
                      >
                        {row[q].reads}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p
            className="mt-2 text-[10.5px]"
            style={{ color: 'var(--ink-500)', lineHeight: 1.55 }}
          >
            <span className="font-semibold" style={{ color: 'var(--ink-700)' }}>
              {shape}
            </span>
            {' — '}
            <span className="font-mono">auto</span> picks{' '}
            <span className="font-mono">{WALK_LABEL[profile.autoChoice]}</span>
            {bestSeek !== profile.autoChoice ? (
              <>
                {' '}
                ; but measured on this archive,{' '}
                <span className="font-mono">{WALK_LABEL[bestSeek]}</span> has
                the fewest adjacency breaks — the fast heuristic and the full
                simulator can disagree.
              </>
            ) : (
              <>, which also has the fewest adjacency breaks here.</>
            )}
          </p>
          <p
            className="mt-1 text-[10px]"
            style={{ color: 'var(--ink-400)', lineHeight: 1.5 }}
          >
            *breaks = non-neighbour hops over the {fmt(profile.tileCount)} real
            tiles (a locality proxy). Scrub/pan are range reads on the sampled
            grid at the current gap.
          </p>
        </div>
      </div>
    </div>
  );
};

/* ── Fetch wrappers ───────────────────────────────────────────────────── */

/** Lazily load one density profile by id. */
function useProfile(id: string): {
  profile: DensityProfile | null;
  error: string | null;
} {
  const [profile, setProfile] = React.useState<DensityProfile | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    setProfile(null);
    setError(null);
    loadDensityProfile(id)
      .then((p) => live && setProfile(p))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [id]);
  return { profile, error };
}

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

const Status: React.FC<{ error: string | null }> = ({ error }) =>
  error ? (
    <p className="text-[12px]" style={{ color: 'var(--ink-500)' }}>
      Couldn't load density profile: {error}
    </p>
  ) : (
    <p className="text-[12px]" style={{ color: 'var(--ink-400)' }}>
      Loading density profile…
    </p>
  );

/**
 * Demo-page panel: one dataset, no selector — the density of *this* demo's
 * archive. `id` is the archive directory (see `profileIdFromUrl`).
 */
const CubeInLine: React.FC<{ id: string }> = ({ id }) => {
  const { profile, error } = useProfile(id);
  return (
    <Card>
      {profile ? (
        <CubeInLineView key={profile.id} profile={profile} />
      ) : (
        <Status error={error} />
      )}
    </Card>
  );
};

export default CubeInLine;

/**
 * How-it-works explorer: the same utility with a dataset switcher over the four
 * "poles", so the winning walk visibly flips as you change the data's shape.
 */
export const CubeInLineExplorer: React.FC<{
  initialId?: string;
  title?: string;
  blurb?: React.ReactNode;
}> = ({ initialId = 'drifters', title, blurb }) => {
  const [activeId, setActiveId] = React.useState(initialId);
  const { profile, error } = useProfile(activeId);
  return (
    <Card>
      {title ? (
        <h4
          className="font-display text-[13px] font-semibold"
          style={{ color: 'var(--ink-900)' }}
        >
          {title}
        </h4>
      ) : null}
      {blurb ? (
        <p
          className="mt-1 text-[11px] max-w-3xl"
          style={{ color: 'var(--ink-500)', lineHeight: 1.6 }}
        >
          {blurb}
        </p>
      ) : null}
      <div className={title || blurb ? 'mt-3' : undefined}>
        <Seg
          label="dataset"
          value={activeId}
          onChange={setActiveId}
          options={PROFILE_META.map((p) => ({ key: p.id, label: p.label }))}
        />
      </div>
      <div className="mt-3">
        {profile ? (
          <CubeInLineView key={profile.id} profile={profile} />
        ) : (
          <Status error={error} />
        )}
      </div>
    </Card>
  );
};
