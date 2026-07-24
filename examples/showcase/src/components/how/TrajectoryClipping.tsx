import React from 'react';
import FigureSvg from '../FigureSvg.tsx';

/**
 * "Deeper:" cut for the Space×time section — how a moving trip stays continuous
 * across a tile seam.
 *
 * At BUILD time a trajectory (a path/line whose vertices each carry a timestamp
 * — e.g. an OSRM-routed trip with per-segment vertex times) that crosses a tile
 * boundary is CLIPPED at the border and split into one self-contained sub-path
 * per tile. The crossing point becomes a NEW border vertex whose POSITION is
 * interpolated onto the tile edge AND whose TIMESTAMP is linearly interpolated
 * between the two real vertices' times, at the same clip parameter. So each tile
 * owns a complete little polyline whose per-vertex times stay continuous — which
 * is exactly what lets a trip animate smoothly across the seam instead of
 * flashing / teleporting when it enters a new tile.
 *
 * Separately, a segment whose longitude jump exceeds 180° (antimeridian /
 * dateline wrap) is split so the clamped tile walk can't smear a sliver of the
 * line across the whole globe.
 *
 * Evidence:
 *   crates/stt-build/src/clip.rs:359-367  interpolate_timestamp (linear time lerp at t)
 *                              :505-541   border vertex = interpolated position + time + value
 *                              :21-43     ClippedSegment carries per-vertex `timestamps`
 *                              :806-821   antimeridian split where |Δlon| > 180°
 *   crates/stt-build/src/tiler.rs:443-466 clip_trajectory during per-tile placement
 *   OSRM per-segment vertex-time pipeline supplies the per-vertex clocks.
 *
 * STATIC figure — no animation, no state. All clock values are illustrative;
 * the mechanism (linear interp at the crossing fraction) is evidence-backed.
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

const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    className="rounded px-1.5 py-0.5 font-mono text-[10px]"
    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
  >
    {children}
  </span>
);

/* ── Geometry ──────────────────────────────────────────────────────────── */
const TX0 = 180; // left tile left edge
const TY0 = 56; // tiles top edge
const S = 220; // tile side
const SEAM = TX0 + S; // 400 — the shared border, where the split happens
const BOT = TY0 + S; // 276 — tiles bottom edge

// Four real vertices (each already has a real timestamp) + the interpolated
// border vertex the clip inserts on the seam (t linearly interpolated).
const VERTS: {
  x: number;
  y: number;
  t: string;
  ax: 'start' | 'end';
  dx: number;
  dy: number;
}[] = [
  { x: 240, y: 246, t: 't = 00:00', ax: 'end', dx: -9, dy: 4 },
  { x: 325, y: 190, t: 't = 00:12', ax: 'end', dx: -9, dy: -8 },
  { x: 540, y: 130, t: 't = 00:31', ax: 'start', dx: 9, dy: 16 },
  { x: 600, y: 100, t: 't = 00:48', ax: 'start', dx: 9, dy: -8 },
];
const BORDER = { x: SEAM, y: 169 }; // f ≈ 0.35 of the 00:12 → 00:31 edge ⇒ t ≈ 00:19

const LEFT_PATH = `${VERTS[0].x},${VERTS[0].y} ${VERTS[1].x},${VERTS[1].y} ${BORDER.x},${BORDER.y}`;
const RIGHT_PATH = `${BORDER.x},${BORDER.y} ${VERTS[2].x},${VERTS[2].y} ${VERTS[3].x},${VERTS[3].y}`;

type LegendKind = 'real' | 'border' | 'subpath';
const LegendChip: React.FC<{ kind: LegendKind; label: string }> = ({
  kind,
  label,
}) => (
  <span
    className="inline-flex items-center gap-1.5 text-[11px]"
    style={{ color: 'var(--ink-500)' }}
  >
    <svg viewBox="0 0 18 14" width="18" height="14" aria-hidden="true">
      {kind === 'real' ? (
        <circle cx="9" cy="7" r="3.6" fill="var(--accent)" />
      ) : kind === 'border' ? (
        <circle
          cx="9"
          cy="7"
          r="3.6"
          fill="var(--surface)"
          stroke="var(--accent)"
          strokeWidth="1.8"
        />
      ) : (
        <line
          x1="2"
          y1="10"
          x2="16"
          y2="4"
          stroke="var(--accent)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      )}
    </svg>
    {label}
  </span>
);

const TrajectoryClipping: React.FC = () => (
  <Card>
    <SubHead>
      Deeper: trips are clipped at tile seams — the crossing vertex is
      interpolated in time
    </SubHead>
    <p
      className="mt-1 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      A trajectory carries a timestamp per vertex. When it crosses a tile
      boundary the build clips it at the border and splits it into one
      self-contained sub-path per tile. The crossing point becomes a new border
      vertex whose position lands on the edge <em>and</em> whose time is
      interpolated between the two real vertices — so each tile owns a complete
      little polyline with continuous times.
    </p>

    <div className="overflow-x-auto">
      <FigureSvg
        viewBox="0 0 920 300"
        className="w-full min-w-[720px]"
        aria-label="Diagram: two neighbouring tiles share a vertical seam. A diagonal trajectory of four real vertices, each with a timestamp from 00:00 to 00:48, crosses from the left tile into the right tile. At the seam the clip inserts a border vertex whose position is interpolated onto the edge and whose timestamp is linearly interpolated to about 00:19. The left tile keeps the sub-path from 00:00 to 00:19; the right tile keeps 00:19 to 00:48; both are complete polylines."
      >
        <text
          x={TX0}
          y="40"
          fontSize="12"
          fontWeight="600"
          fill="var(--ink-700)"
        >
          Space — two neighbouring tiles, one trajectory
        </text>

        {/* tiles: faint wash + hairline internal grid, echoing the pyramid look */}
        {[TX0, SEAM].map((tx) => (
          <g key={tx}>
            <rect
              x={tx}
              y={TY0}
              width={S}
              height={S}
              rx="3"
              fill="rgba(10,119,144,0.05)"
              stroke="var(--ink-400)"
              strokeWidth="1"
            />
            <line
              x1={tx + S / 2}
              y1={TY0}
              x2={tx + S / 2}
              y2={BOT}
              stroke="var(--hairline)"
              strokeWidth="1"
            />
            <line
              x1={tx}
              y1={TY0 + S / 2}
              x2={tx + S}
              y2={TY0 + S / 2}
              stroke="var(--hairline)"
              strokeWidth="1"
            />
          </g>
        ))}

        {/* tile labels */}
        <text
          x={TX0 + 8}
          y={TY0 + 18}
          fontSize="10.5"
          fontFamily={MONO}
          fill="var(--ink-500)"
        >
          tile (x, y)
        </text>
        <text
          x={SEAM + 8}
          y={TY0 + 18}
          fontSize="10.5"
          fontFamily={MONO}
          fill="var(--ink-500)"
        >
          tile (x+1, y)
        </text>
        <text x={TX0 + 8} y={BOT - 10} fontSize="9.5" fill="var(--ink-400)">
          keeps t₀ … t_cross
        </text>
        <text x={SEAM + 8} y={BOT - 10} fontSize="9.5" fill="var(--ink-400)">
          keeps t_cross … t₃
        </text>

        {/* the seam — the border where the split happens */}
        <line
          x1={SEAM}
          y1={TY0}
          x2={SEAM}
          y2={BOT}
          stroke="var(--accent)"
          strokeWidth="1.6"
          strokeDasharray="5 4"
          opacity="0.85"
        />
        <text
          x={SEAM}
          y={BOT + 16}
          fontSize="9.5"
          fontFamily={MONO}
          textAnchor="middle"
          fill="var(--accent)"
        >
          seam · split here
        </text>

        {/* the two per-tile sub-paths (both accent; they meet at the border vertex) */}
        <polyline
          points={LEFT_PATH}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={RIGHT_PATH}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.78"
        />

        {/* real vertices — filled accent dots with real timestamps */}
        {VERTS.map((v) => (
          <g key={v.t}>
            <circle cx={v.x} cy={v.y} r="4" fill="var(--accent)" />
            <text
              x={v.x + v.dx}
              y={v.y + v.dy}
              fontSize="9.5"
              fontFamily={MONO}
              textAnchor={v.ax}
              fill="var(--ink-700)"
            >
              {v.t}
            </text>
          </g>
        ))}

        {/* the interpolated border vertex — open / ringed */}
        <circle
          cx={BORDER.x}
          cy={BORDER.y}
          r="8"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1"
          opacity="0.4"
        />
        <circle
          cx={BORDER.x}
          cy={BORDER.y}
          r="4.5"
          fill="var(--surface)"
          stroke="var(--accent)"
          strokeWidth="1.8"
        />

        {/* leader from the border vertex to the explanation block */}
        <path
          d={`M ${BORDER.x + 9} ${BORDER.y} C 570 150, 610 110, 648 108`}
          fill="none"
          stroke="var(--ink-400)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />

        {/* explanation block, right of the tiles */}
        <text
          x="650"
          y="96"
          fontSize="11"
          fontWeight="600"
          fill="var(--accent)"
        >
          border vertex — inserted at the clip
        </text>
        <text x="650" y="116" fontSize="10" fill="var(--ink-500)">
          • position → interpolated onto the tile edge
        </text>
        <text x="650" y="132" fontSize="10" fill="var(--ink-500)">
          • time → linearly interpolated (t ≈ 00:19)
        </text>
        <rect
          x="650"
          y="144"
          width="250"
          height="24"
          rx="5"
          fill="var(--accent-soft)"
          stroke="var(--accent)"
          strokeWidth="1"
        />
        <text
          x="662"
          y="160"
          fontSize="10.5"
          fontFamily={MONO}
          fill="var(--accent)"
        >
          t_border = t_a + (t_b − t_a) · f
        </text>
        <text x="650" y="186" fontSize="9.5" fill="var(--ink-400)">
          f = fraction of the a → b segment left of the seam
        </text>

        <text x={TX0} y="294" fontSize="9.5" fill="var(--ink-400)">
          clipped once, at build — each tile carries a complete polyline, so no
          cross-tile fetch is needed to draw a partial trip
        </text>
      </FigureSvg>
    </div>

    {/* legend */}
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <LegendChip kind="real" label="real vertex" />
      <LegendChip kind="border" label="interpolated border vertex" />
      <LegendChip kind="subpath" label="per-tile sub-path" />
    </div>

    {/* antimeridian edge case — warm / attention colour */}
    <div
      className="mt-3 rounded-md p-2.5 flex items-start gap-2.5"
      style={{
        background: 'rgba(240,193,75,0.16)',
        border: '1px solid rgba(240,193,75,0.9)',
      }}
    >
      <FigureSvg
        viewBox="0 0 150 84"
        width="120"
        height="68"
        aria-label="Edge case: a segment whose longitude jumps more than 180 degrees straddles the dateline. Drawn the long way it smears across the map; split at the plus-or-minus 180 degree edges it does not."
        className="shrink-0 mt-0.5"
      >
        <text
          x="75"
          y="14"
          fontSize="8"
          fontFamily={MONO}
          textAnchor="middle"
          fill="#8a5a0a"
        >
          |Δlon| &gt; 180°
        </text>
        {/* the flattened world strip; its left & right edges are ±180° */}
        <rect
          x="8"
          y="28"
          width="134"
          height="28"
          rx="2"
          fill="none"
          stroke="rgba(240,193,75,0.9)"
          strokeWidth="1"
        />
        <line
          x1="8"
          y1="24"
          x2="8"
          y2="60"
          stroke="rgba(240,193,75,0.9)"
          strokeWidth="1.5"
          strokeDasharray="3 2"
        />
        <line
          x1="142"
          y1="24"
          x2="142"
          y2="60"
          stroke="rgba(240,193,75,0.9)"
          strokeWidth="1.5"
          strokeDasharray="3 2"
        />
        <text
          x="8"
          y="72"
          fontSize="7"
          fontFamily={MONO}
          textAnchor="middle"
          fill="#8a5a0a"
        >
          −180
        </text>
        <text
          x="142"
          y="72"
          fontSize="7"
          fontFamily={MONO}
          textAnchor="middle"
          fill="#8a5a0a"
        >
          +180
        </text>
        {/* the smeared long-way line (bad) — faint, crossed out */}
        <line
          x1="14"
          y1="42"
          x2="138"
          y2="42"
          stroke="#8a5a0a"
          strokeWidth="1"
          strokeDasharray="2 3"
          opacity="0.4"
        />
        <path
          d="M 71 38 l 8 8 M 79 38 l -8 8"
          stroke="#8a5a0a"
          strokeWidth="1.2"
          opacity="0.85"
        />
        {/* the split (good): each end runs to its nearest ±180 edge */}
        <line
          x1="14"
          y1="42"
          x2="8"
          y2="42"
          stroke="#8a5a0a"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <line
          x1="142"
          y1="42"
          x2="138"
          y2="42"
          stroke="#8a5a0a"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="14" cy="42" r="2.6" fill="#8a5a0a" />
        <circle cx="138" cy="42" r="2.6" fill="#8a5a0a" />
      </FigureSvg>
      <p className="text-[11px] leading-relaxed" style={{ color: '#8a5a0a' }}>
        Edge case: a segment whose longitude jumps more than 180° straddles the
        dateline. Left whole, the clamped tile walk draws it the long way and
        bakes a globe-spanning sliver into every column between — so it is split
        at the wrap first.{' '}
        <strong>
          Dateline wrap → split, so a line never smears across the globe.
        </strong>
      </p>
    </div>

    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      Clipping runs once, at build — <Code>clip_trajectory</Code> during
      per-tile placement — so every tile ships a self-contained{' '}
      <Code>ClippedSegment</Code> and the viewer never fetches a neighbour to
      finish drawing a partial trip. Crucially the border vertex carries an
      interpolated <em>time</em>, not just a position:{' '}
      <Code>interpolate_timestamp</Code> gives the last frame on the left tile
      and the first frame on the right tile the same clock, to the millisecond.
      That continuity across seams is the fix behind trips no longer flashing or
      teleporting at tile borders.
    </p>
  </Card>
);

export default TrajectoryClipping;
