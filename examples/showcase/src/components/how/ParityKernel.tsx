import React from "react";

/**
 * "One formula, every engine" figure — the clearest evidence of the
 * same-data / same-behaviour / any-renderer thesis.
 *
 * The time→alpha gate (relativize each feature/vertex time against a per-tile
 * offset, then map window | trail | wake | cumulative age to an alpha) lives in
 * ONE framework-free CPU module — @poopdeck.gl/core render/time-filter.ts, the
 * "oracle". It is authored once more as an expression AST in render/
 * shader-codegen.ts, and a set of pure emitters machine-translate that single
 * AST into each backend's shading dialect: deck.gl (emitGLSL100, GLSL ES 1.00
 * inject), MapLibre (emitGLSL300), Three.js (emitTSL — WebGPU node graph), and
 * Cesium (emitGLSL300 fragment shader). No renderer hand-maintains its own gate
 * math. Shared parity/conformance tests (core/test/shader-codegen.test.ts) pin
 * every emission numerically equal to the oracle over thousands of random
 * inputs, so the four can never drift. Mirrors PackagesMap's Box + bezier
 * fan-out. STATIC — no animation, no state.
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
      fill={accent ? "var(--accent-soft)" : "var(--surface-sunken)"}
      stroke={accent ? "var(--accent)" : "var(--ink-400)"}
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
      <text x={x + w / 2} y={y + 30} fontSize="9" textAnchor="middle" fill="var(--ink-500)">
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
const TARGETS: { name: string; dialect: string; emit: string; cx: number }[] = [
  { name: "deck.gl", dialect: "GLSL ES 1.00", emit: "emitGLSL100", cx: 58 },
  { name: "MapLibre", dialect: "GLSL ES 3.00", emit: "emitGLSL300", cx: 172 },
  { name: "Three.js", dialect: "TSL · WebGPU nodes", emit: "emitTSL", cx: 286 },
  { name: "Cesium", dialect: "GLSL ES 3.00", emit: "emitGLSL300", cx: 400 },
];

const BOX_W = 104;
const TARGET_Y = 158;
const TARGET_H = 58;
const EMIT_BOTTOM = 116; // emitter box bottom-center y
const BRACKET_Y = 232;

const ParityKernel: React.FC = () => (
  <div
    className="rounded-lg p-4"
    style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
  >
    <h4 className="font-display text-[13px] font-semibold" style={{ color: "var(--ink-900)" }}>
      One formula, every engine
    </h4>

    <div className="overflow-x-auto">
      <svg
        viewBox="0 0 460 270"
        className="w-full min-w-[420px] mt-2"
        role="img"
        aria-label="Diagram: the time-filter alpha kernel lives in one framework-free core module; a shader codegen emits its single expression AST into deck.gl GLSL, MapLibre GLSL, Three.js TSL, and Cesium GLSL, and shared parity tests pin all four numerically equal."
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

        {/* ── The kernel: one CPU source of truth ─────────────────────── */}
        <Box
          x={90}
          y={12}
          w={280}
          h={44}
          title="render/time-filter.ts"
          sub="one CPU kernel · relativize + window / trail / wake / cumulative → alpha"
          accent
        />
        <line
          x1="230"
          y1="56"
          x2="230"
          y2="76"
          stroke="var(--ink-400)"
          strokeWidth="1"
          markerEnd="url(#arr-pk)"
        />

        {/* ── The emitter: same math authored once as an AST ──────────── */}
        <Box
          x={148}
          y={78}
          w={164}
          h={38}
          title="render/shader-codegen.ts"
          sub="one Expr AST → per-dialect emitters"
        />

        {/* fan-out curves from the emitter to each backend */}
        {TARGETS.map((t) => (
          <path
            key={t.name}
            d={`M 230 ${EMIT_BOTTOM} C 230 ${EMIT_BOTTOM + 26}, ${t.cx} ${TARGET_Y - 26}, ${t.cx} ${TARGET_Y}`}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1"
            opacity="0.55"
            markerEnd="url(#arr-pk)"
          />
        ))}

        {/* ── The four backends: thin dialects of one kernel ──────────── */}
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
          />
        ))}

        {/* ── Tie-bar: parity tests pin the emissions numerically equal ── */}
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
          shared parity tests pin these numerically equal
        </text>
        <text
          x="230"
          y={BRACKET_Y + 28}
          fontSize="8.5"
          textAnchor="middle"
          fill="var(--ink-400)"
        >
          core/test/shader-codegen.test.ts — evalExpr == oracle over 2000 random envs
        </text>
      </svg>
    </div>

    <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--ink-500)" }}>
      This is the guarantee behind the capability matrix above: the renderers are
      thin dialects of one kernel, not four parallel gate implementations. The
      alpha math is authored once — as a framework-free CPU function in{" "}
      <span className="font-mono">@poopdeck.gl/core</span> and mirrored as an
      expression AST — and machine-emitted into each backend's shading language.
      A conformance test asserts every emission returns the same number as that
      CPU oracle, so a{" "}
      <span
        className="rounded px-1.5 py-0.5 font-mono text-[10px]"
        style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
      >
        trail
      </span>{" "}
      looks and times identically whether you draw it in deck.gl or on a Cesium
      globe. Change the formula once and every renderer inherits it.
    </p>
  </div>
);

export default ParityKernel;
