import React from 'react';
import FigureSvg from '../FigureSvg.tsx';

/**
 * "One formula, every engine" figure — the clearest evidence of the
 * same-data / same-behaviour / any-renderer thesis.
 *
 * The time→alpha gate (relativize each feature/vertex time against a per-tile
 * offset, then map window | trail | wake | cumulative age to an alpha) has ONE
 * definition: the framework-free CPU module @poopdeck.gl/core render/time-filter.ts,
 * "the oracle". render/shader-codegen.ts states the same four formulas a SECOND
 * time, independently derived, as a branchless expression AST; its `evalExpr` is
 * pinned numerically equal to the oracle over 2000 random envs
 * (core/test/shader-codegen.test.ts).
 *
 * NOTHING IS MACHINE-EMITTED. Every backend hand-writes its own shader:
 *   - deck.gl   — hand-written GLSL ES 3.00 inject (TimeFilterExtension; the
 *                 inject uses `layout(std140) uniform` + `in`/`out`)
 *   - MapLibre  — hand-written GLSL ES 1.00 (shaders/time-window.glsl.ts, which
 *                 declares `attribute vec2 aTime` — WebGL1-compatible)
 *   - Three.js  — hand-written TSL node graph (tsl/time-filter.ts)
 *   - Cesium    — no time-filter shader at all: its layers call the CPU oracle
 *                 per feature per frame
 * An earlier version of this figure had the deck/MapLibre dialects SWAPPED and
 * showed Cesium as machine-emitted. Cesium does export a generated GLSL snippet
 * (`timeFilterAlphaGlsl` → `emitGLSL300`), but no layer calls it — it targets a
 * GPU `Appearance` path that is not wired. See docs/api/render-kernel.md and
 * docs/spec/render-spec.json.
 *
 * What prevents drift is a per-backend CONFORMANCE OBLIGATION, declared in
 * docs/spec/render-spec.json and enforced structurally by
 * core/test/render-spec-contract.test.ts: each backend keeps a JS reference of
 * its shader math, tests pin that reference to BOTH oracles, and the shipped
 * GLSL/TSL is locked to the reference (structurally — shader source can't run
 * headless). See packages/maplibre/test/time-modes.test.ts and
 * packages/layers/test/time-filter-conformance.test.ts.
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

/**
 * The four backends and where each fan-out curve lands. `direct` marks the one
 * that runs the oracle itself instead of mirroring it into a shader.
 */
const TARGETS: {
  name: string;
  dialect: string;
  authoring: string;
  cx: number;
  direct?: boolean;
}[] = [
  {
    name: 'deck.gl',
    dialect: 'GLSL ES 3.00',
    authoring: 'hand-written',
    cx: 58,
  },
  {
    name: 'MapLibre',
    dialect: 'GLSL ES 1.00',
    authoring: 'hand-written',
    cx: 172,
  },
  {
    name: 'Three.js',
    dialect: 'TSL · WebGPU nodes',
    authoring: 'hand-written',
    cx: 286,
  },
  {
    name: 'Cesium',
    dialect: 'CPU — no shader',
    authoring: 'calls the oracle',
    cx: 400,
    direct: true,
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
        aria-label="Diagram: the time-filter alpha has one definition, a framework-free CPU oracle, plus a second independently-derived branchless statement of the same formulas pinned numerically equal to it. deck.gl, MapLibre and Three.js each hand-write the math in their own shading dialect; Cesium calls the oracle directly on the CPU. A conformance test pins every backend to both oracles."
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
          sub="the SECOND oracle · same formulas, branchless, derived separately"
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

        {/* fan-out: dashed where the backend hand-mirrors the math into a shader */}
        {TARGETS.map((t) => (
          <path
            key={t.name}
            d={`M 230 ${FANOUT_Y} C 230 ${FANOUT_Y + 22}, ${t.cx} ${TARGET_Y - 22}, ${t.cx} ${TARGET_Y}`}
            fill="none"
            stroke={t.direct ? 'var(--accent)' : 'var(--ink-400)'}
            strokeWidth="1"
            strokeDasharray={t.direct ? undefined : '3 3'}
            opacity={t.direct ? 0.75 : 0.55}
            markerEnd="url(#arr-pk)"
          />
        ))}
        <text x="14" y={FANOUT_Y + 22} fontSize="8.5" fill="var(--ink-400)">
          ╌╌ hand-written shader
        </text>
        <text x="14" y={FANOUT_Y + 34} fontSize="8.5" fill="var(--accent)">
          — runs the oracle itself
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
            foot={t.authoring}
            accent={t.direct}
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
          conformance tests pin all four to BOTH oracles
        </text>
        <text
          x="230"
          y={BRACKET_Y + 28}
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          each backend's JS reference == both oracles, and its shipped shader ==
          that reference
        </text>
      </FigureSvg>
    </div>

    <p
      className="mt-2 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      This is the guarantee behind the package map above. The alpha math is{' '}
      <em>defined</em> once, as a framework-free CPU function in{' '}
      <span className="font-mono">@poopdeck.gl/core</span> — and then{' '}
      <em>stated a second time</em>, independently, as a branchless expression
      AST. Two derivations disagree wherever the spec is ambiguous, which one
      implementation can never reveal; that is how two out-of-contract inputs
      were found and pinned. Nothing here is machine-emitted. deck.gl, MapLibre
      and Three each hand-write the math in their own dialect, because each host
      wants it inlined its own way, and Cesium skips the shader entirely and
      runs the oracle on the CPU. What keeps them honest is a chain of
      assertions rather than a compiler: every backend keeps a JS reference of
      its shader math, tests pin that reference to both oracles numerically, and
      the shipped shader is locked to the reference. So a{' '}
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
