import React from 'react';
import FigureSvg from '../FigureSvg.tsx';

/**
 * "One formula, every engine" figure — the clearest evidence of the
 * same-data / same-behaviour / any-renderer thesis.
 *
 * The time→alpha gate (relativize each feature/vertex time against a per-tile
 * offset, then map window | trail | wake | cumulative age to an alpha) lives in
 * ONE framework-free CPU module — @poopdeck.gl/core render/time-filter.ts, the
 * "oracle". The same math is authored a second time as an expression AST in
 * render/shader-codegen.ts, whose `evalExpr` is pinned numerically equal to the
 * oracle over 2000 random envs (core/test/shader-codegen.test.ts).
 *
 * What each backend ships is NOT machine-emitted from that AST (except Cesium):
 *   - deck.gl   — hand-written GLSL ES 1.00 inject (TimeFilterExtension)
 *   - MapLibre  — hand-written GLSL ES 3.00 (shaders/time-window.glsl.ts)
 *   - Three.js  — hand-written TSL node graph (tsl/time-filter.ts); an
 *                 `emitTSL` entry point is referenced in core's source comments
 *                 but has NO implementation.
 *   - Cesium    — the one machine-emitted backend: shaders.ts calls
 *                 `emitGLSL300(ALPHA_EXPR[mode])`.
 * See docs/api/render-kernel.md, which states this explicitly.
 *
 * What actually prevents drift is a LAYERED conformance contract: each backend
 * keeps a JS reference impl of its shader math, tests pin that reference to the
 * CPU oracle AND to `evalExpr`, and the shipped GLSL/TSL is locked to the
 * reference (structurally for GLSL, which can't run headless). See
 * packages/maplibre/test/time-modes.test.ts for the three-way statement of it,
 * plus three/test/time-filter-math.test.ts and cesium/test/shaders.test.ts.
 *
 * Mirrors PackagesMap's Box + bezier fan-out. STATIC — no animation, no state.
 */

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

/** SVG box (PackagesMap vocabulary), optionally with a mono emitter footer. */
const Box: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  foot?: string;
  accent?: boolean;
}> = ({ x, y, w, h, title, sub, foot, accent }) => (
  <g>
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
      y={y + 17}
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
        y={y + 30}
        fontSize="9"
        textAnchor="middle"
        fill="var(--ink-500)"
      >
        {sub}
      </text>
    ) : null}
    {foot ? (
      <text
        x={x + w / 2}
        y={y + 45}
        fontSize="9"
        fontFamily={MONO}
        textAnchor="middle"
        fill="var(--accent)"
      >
        {foot}
      </text>
    ) : null}
  </g>
);

/** The four backends and where each fan-out curve lands. */
const TARGETS: {
  name: string;
  dialect: string;
  emit: string;
  cx: number;
  generated?: boolean;
}[] = [
  { name: 'deck.gl', dialect: 'GLSL ES 1.00', emit: 'hand-written', cx: 58 },
  { name: 'MapLibre', dialect: 'GLSL ES 3.00', emit: 'hand-written', cx: 172 },
  {
    name: 'Three.js',
    dialect: 'TSL · WebGPU nodes',
    emit: 'hand-written',
    cx: 286,
  },
  {
    name: 'Cesium',
    dialect: 'GLSL ES 3.00',
    emit: 'emitGLSL300',
    cx: 400,
    generated: true,
  },
];

const BOX_W = 104;
const TARGET_Y = 158;
const TARGET_H = 58;
const FANOUT_Y = 112; // where the fan-out curves leave the oracle row
const BRACKET_Y = 232;

const ParityKernel: React.FC = () => (
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
      One formula, every engine
    </h4>

    <div className="overflow-x-auto">
      <FigureSvg
        viewBox="0 0 460 270"
        className="w-full min-w-[420px] mt-2"
        aria-label="Diagram: the time-filter alpha lives in one framework-free CPU oracle, mirrored as an expression AST pinned numerically equal to it. Three backends hand-write their shader math and Cesium machine-emits it; conformance tests pin all four back to the oracle."
      >
        <defs>
          <marker
            id="arr-pk"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--ink-400)" />
          </marker>
        </defs>

        {/* ── The oracle, and its AST twin ─────────────────────────────── */}
        <Box
          x={16}
          y={12}
          w={200}
          h={44}
          title="render/time-filter.ts"
          sub="THE CPU oracle · window / trail / wake / cumulative → alpha"
          accent
        />
        <Box
          x={244}
          y={12}
          w={200}
          h={44}
          title="render/shader-codegen.ts"
          sub="the same math as an Expr AST"
        />
        <line
          x1="216"
          y1="34"
          x2="244"
          y2="34"
          stroke="var(--accent)"
          strokeWidth="1.4"
        />
        <text
          x="230"
          y="76"
          fontSize="9"
          fontFamily={MONO}
          textAnchor="middle"
          fill="var(--accent)"
        >
          evalExpr == oracle over 2000 random envs
        </text>

        {/* fan-out: dashed where the backend hand-writes its own dialect */}
        {TARGETS.map((t) => (
          <path
            key={t.name}
            d={`M 230 ${FANOUT_Y} C 230 ${FANOUT_Y + 22}, ${t.cx} ${TARGET_Y - 22}, ${t.cx} ${TARGET_Y}`}
            fill="none"
            stroke={t.generated ? 'var(--accent)' : 'var(--ink-400)'}
            strokeWidth="1"
            strokeDasharray={t.generated ? undefined : '3 3'}
            opacity={t.generated ? 0.75 : 0.55}
            markerEnd="url(#arr-pk)"
          />
        ))}
        <text x="14" y={FANOUT_Y + 22} fontSize="8.5" fill="var(--ink-400)">
          ╌╌ mirrored by hand
        </text>
        <text x="14" y={FANOUT_Y + 34} fontSize="8.5" fill="var(--accent)">
          — machine-emitted
        </text>

        {/* ── The four backends ────────────────────────────────────────── */}
        {TARGETS.map((t) => (
          <Box
            key={t.name}
            x={t.cx - BOX_W / 2}
            y={TARGET_Y}
            w={BOX_W}
            h={TARGET_H}
            title={t.name}
            sub={t.dialect}
            foot={t.emit}
            accent={t.generated}
          />
        ))}

        {/* ── Tie-bar: conformance tests pin every one to the oracle ───── */}
        {TARGETS.map((t) => (
          <line
            key={t.name}
            x1={t.cx}
            y1={TARGET_Y + TARGET_H}
            x2={t.cx}
            y2={BRACKET_Y}
            stroke="var(--ink-400)"
            strokeWidth="1"
            opacity="0.5"
          />
        ))}
        <line
          x1={TARGETS[0].cx}
          y1={BRACKET_Y}
          x2={TARGETS[TARGETS.length - 1].cx}
          y2={BRACKET_Y}
          stroke="var(--accent)"
          strokeWidth="1.4"
        />
        <text
          x="230"
          y={BRACKET_Y + 16}
          fontSize="9.5"
          fontFamily={MONO}
          textAnchor="middle"
          fill="var(--accent)"
        >
          conformance tests pin all four back to the oracle
        </text>
        <text
          x="230"
          y={BRACKET_Y + 28}
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          each backend's JS reference == oracle, and its shipped shader == that
          reference
        </text>
      </FigureSvg>
    </div>

    <p
      className="mt-2 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      This is the guarantee behind the capability matrix above. The alpha math
      is <em>defined</em> once, as a framework-free CPU function in{' '}
      <span className="font-mono">@poopdeck.gl/core</span>. Cesium emits its
      shader straight from the AST twin; deck.gl, MapLibre and Three each ship
      hand-written GLSL or TSL, because each host wants its math inlined its own
      way. What keeps those three honest is a chain of assertions rather than a
      compiler: every backend keeps a JS reference of its shader math, tests pin
      that reference to the oracle numerically, and the shipped shader is locked
      to the reference. So a{' '}
      <span
        className="rounded px-1.5 py-0.5 font-mono text-[10px]"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
      >
        trail
      </span>{' '}
      looks and times identically whether you draw it in deck.gl or on a Cesium
      globe — and changing the formula fails four test suites at once until
      every renderer follows.
    </p>
  </div>
);

export default ParityKernel;
