import React from 'react';
import { Link } from 'react-router';
import FigureSvg from '../FigureSvg.tsx';

/**
 * "The parts list" figure: the Rust crates that write archives and the npm
 * packages that read them, with their real dependency edges — plus the
 * backend capability matrix (mirrors the generated
 * docs/spec/backend-capabilities.md; regenerate that doc when a
 * BackendDescriptor changes and update this table to match).
 */

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

const Card: React.FC<{
  title: string;
  children: React.ReactNode;
  foot?: React.ReactNode;
}> = ({ title, children, foot }) => (
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
      {title}
    </h4>
    <div className="mt-2 overflow-x-auto">{children}</div>
    {foot ? (
      <p
        className="mt-2 text-[11px] leading-relaxed"
        style={{ color: 'var(--ink-500)' }}
      >
        {foot}
      </p>
    ) : null}
  </div>
);

const Box: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  accent?: boolean;
}> = ({ x, y, w, h, title, sub, accent }) => (
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
      y={sub ? y + h / 2 - 3 : y + h / 2 + 4}
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
        y={y + h / 2 + 12}
        fontSize="9"
        textAnchor="middle"
        fill="var(--ink-500)"
      >
        {sub}
      </text>
    ) : null}
  </g>
);

const RustPanel: React.FC = () => (
  <Card
    title="Build time — the Rust crates"
    foot={
      <>
        Also in the workspace: <span className="font-mono">stt-generate</span>,
        the demo-dataset generator behind every showcase demo — it fetches real
        data, writes GeoParquet and shells out to{' '}
        <span className="font-mono">stt-build</span>.
      </>
    }
  >
    <FigureSvg
      viewBox="0 0 440 250"
      className="w-full min-w-[400px]"
      aria-label="Diagram: the spatiotemporal-tiles facade crate ships four CLI binaries and sits on the stt-build and stt-optimize libraries, which both sit on stt-core, the format implementation."
    >
      <defs>
        <marker
          id="arr-rs"
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

      <Box
        x={20}
        y={14}
        w={400}
        h={70}
        title="spatiotemporal-tiles"
        sub="crates.io · one install, four CLIs"
        accent
      />
      <text
        x="220"
        y="74"
        fontSize="9.5"
        fontFamily={MONO}
        textAnchor="middle"
        fill="var(--accent)"
      >
        stt-build · stt-optimize · stt-validate · stt-serve
      </text>

      <line
        x1="110"
        y1="84"
        x2="110"
        y2="112"
        stroke="var(--ink-400)"
        strokeWidth="1"
        markerEnd="url(#arr-rs)"
      />
      <line
        x1="330"
        y1="84"
        x2="330"
        y2="112"
        stroke="var(--ink-400)"
        strokeWidth="1"
        markerEnd="url(#arr-rs)"
      />

      <Box
        x={40}
        y={116}
        w={140}
        h={42}
        title="stt-build"
        sub="the tiler / encoder"
      />
      <Box
        x={260}
        y={116}
        w={140}
        h={42}
        title="stt-optimize"
        sub="analyzer — powers --auto"
      />

      <line
        x1="110"
        y1="158"
        x2="110"
        y2="186"
        stroke="var(--ink-400)"
        strokeWidth="1"
        markerEnd="url(#arr-rs)"
      />
      <line
        x1="330"
        y1="158"
        x2="330"
        y2="186"
        stroke="var(--ink-400)"
        strokeWidth="1"
        markerEnd="url(#arr-rs)"
      />

      <Box
        x={40}
        y={190}
        w={360}
        h={48}
        title="stt-core"
        sub="the format — packs · directory · Arrow tiles · projection"
      />
    </FigureSvg>
  </Card>
);

/** Top-row npm packages and where their dependency curves land. */
const TS_TOP: {
  name: string;
  sub: string;
  x: number;
  coreX: number;
  playbackX?: number;
}[] = [
  { name: 'layers', sub: 'deck.gl catalog', x: 10, coreX: 50, playbackX: 300 },
  { name: 'maplibre', sub: 'custom layers', x: 96, coreX: 95 },
  { name: 'three', sub: 'TSL · WebGPU', x: 182, coreX: 140, playbackX: 346 },
  { name: 'cesium', sub: 'WGS84 globe', x: 268, coreX: 185 },
  { name: 'react', sub: 'hooks + UI', x: 354, coreX: 225, playbackX: 400 },
];

const TsPanel: React.FC = () => (
  <Card
    title="Runtime — the npm packages (@poopdeck.gl)"
    foot="One decoder, one clock: every renderer consumes the same decoded tiles from core. layers, three and react import the playback engine directly; MapLibre and Cesium take no dependency on it and drive from any clock through a small structural interface."
  >
    <FigureSvg
      viewBox="0 0 440 262"
      className="w-full min-w-[400px]"
      aria-label="Diagram: five renderer and UI packages sit on @poopdeck.gl/core; layers, three and react additionally sit on the zero-dependency @poopdeck.gl/playback."
    >
      {TS_TOP.map((p) => (
        <React.Fragment key={p.name}>
          <path
            d={`M ${p.x + 38} 64 C ${p.x + 38} 110, ${p.coreX} 130, ${p.coreX} 166`}
            fill="none"
            stroke="var(--ink-400)"
            strokeWidth="1"
            opacity="0.6"
          />
          {p.playbackX !== undefined ? (
            <path
              d={`M ${p.x + 38} 64 C ${p.x + 38} 110, ${p.playbackX} 130, ${p.playbackX} 166`}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1"
              opacity="0.55"
            />
          ) : null}
        </React.Fragment>
      ))}

      {TS_TOP.map((p) => (
        <Box
          key={p.name}
          x={p.x}
          y={16}
          w={76}
          h={48}
          title={`/${p.name}`}
          sub={p.sub}
        />
      ))}

      <Box
        x={10}
        y={170}
        w={230}
        h={52}
        title="@poopdeck.gl/core"
        sub="decoder · tileset · scheduler"
        accent
      />
      <Box
        x={262}
        y={170}
        w={168}
        h={52}
        title="…/playback"
        sub="clock · governor · zero deps"
        accent
      />

      {/* legend */}
      <line
        x1="14"
        y1="248"
        x2="34"
        y2="248"
        stroke="var(--ink-400)"
        strokeWidth="1.2"
        opacity="0.7"
      />
      <text x="40" y="251" fontSize="9.5" fill="var(--ink-500)">
        tiles (depends on core)
      </text>
      <line
        x1="170"
        y1="248"
        x2="190"
        y2="248"
        stroke="var(--accent)"
        strokeWidth="1.2"
        opacity="0.8"
      />
      <text x="196" y="251" fontSize="9.5" fill="var(--ink-500)">
        clock (depends on playback)
      </text>
    </FigureSvg>
  </Card>
);

/* ── Capability matrix ────────────────────────────────────────────────── */

type Cell = 'y' | '-' | `↳ ${string}`;

interface MatrixRow {
  kind: string;
  cells: [Cell, Cell, Cell, Cell]; // deck, three, maplibre, cesium
}

const LAYER_MATRIX: MatrixRow[] = [
  { kind: 'point', cells: ['y', 'y', 'y', 'y'] },
  { kind: 'path', cells: ['y', 'y', '-', 'y'] },
  { kind: 'polygon', cells: ['y', 'y', 'y', '-'] },
  { kind: 'line', cells: ['y', 'y', 'y', 'y'] },
  { kind: 'arc', cells: ['y', 'y', 'y', 'y'] },
  { kind: 'icon', cells: ['y', 'y', 'y', '-'] },
  { kind: 'column', cells: ['y', 'y', 'y', '-'] },
  { kind: 'trips', cells: ['y', 'y', 'y', 'y'] },
  { kind: 'tripHeads', cells: ['y', 'y', 'y', 'y'] },
  { kind: 'boundingBox', cells: ['y', 'y', '-', '-'] },
  { kind: 'surfel', cells: ['y', 'y', '-', '↳ point'] },
  { kind: 'heatmap', cells: ['y', '↳ point', 'y', '-'] },
  { kind: 'h3Summary', cells: ['y', 'y', 'y', '-'] },
  { kind: 'quadbinSummary', cells: ['y', 'y', 'y', '-'] },
  { kind: 'flowmap', cells: ['y', 'y', 'y', '↳ line'] },
  { kind: 'flowCorridor', cells: ['y', 'y', 'y', '↳ line'] },
  { kind: 'flowStroke', cells: ['y', '↳ flowCorridor', 'y', '↳ line'] },
  { kind: 'isoLines', cells: ['↳ path', 'y', '-', '↳ path'] },
  { kind: 'ego', cells: ['-', 'y', '-', '-'] },
];

const MODE_MATRIX: MatrixRow[] = [
  { kind: 'window', cells: ['y', 'y', 'y', 'y'] },
  { kind: 'trail', cells: ['y', 'y', 'y', 'y'] },
  { kind: 'wake', cells: ['y', 'y', 'y', 'y'] },
  { kind: 'cumulative', cells: ['y', 'y', 'y', 'y'] },
];

const BACKENDS = ['deck', 'three', 'maplibre', 'cesium'];

const MatrixCell: React.FC<{ cell: Cell }> = ({ cell }) => {
  if (cell === 'y')
    return (
      <span
        aria-label="native"
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: 'var(--accent)' }}
      />
    );
  if (cell === '-')
    return (
      <span
        aria-label="unsupported"
        style={{ color: 'var(--ink-400)', opacity: 0.6 }}
      >
        —
      </span>
    );
  return (
    <span
      className="font-mono text-[9.5px]"
      style={{ color: 'var(--ink-500)' }}
    >
      {cell}
    </span>
  );
};

const MatrixTable: React.FC<{ rows: MatrixRow[]; label: string }> = ({
  rows,
  label,
}) => (
  <table className="border-collapse w-full text-[11px]">
    <thead>
      <tr>
        <th
          className="text-left font-medium pb-1.5 pr-2"
          style={{ color: 'var(--ink-400)' }}
        >
          {label}
        </th>
        {BACKENDS.map((b) => (
          <th
            key={b}
            className="font-mono font-medium pb-1.5 px-2 text-center"
            style={{ color: 'var(--ink-500)' }}
          >
            {b}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((r) => (
        <tr key={r.kind} style={{ borderTop: '1px solid var(--hairline)' }}>
          <td
            className="py-1 pr-2 font-mono"
            style={{ color: 'var(--ink-700)' }}
          >
            {r.kind}
          </td>
          {r.cells.map((c, i) => (
            <td key={i} className="py-1 px-2 text-center">
              <MatrixCell cell={c} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

const CapabilityMatrix: React.FC = () => (
  <Card
    title="Who renders what — the capability matrix"
    foot={
      <>
        <span style={{ color: 'var(--accent)' }}>●</span> native · ↳ falls back
        to a simpler kind · — unsupported. Generated from each backend's{' '}
        <span className="font-mono">BackendDescriptor</span> — the full,
        regenerated table lives in{' '}
        <Link
          to="/docs/spec/backend-capabilities"
          style={{ color: 'var(--accent)' }}
        >
          the spec
        </Link>
        .
      </>
    }
  >
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6">
      <div className="min-w-[380px]">
        <MatrixTable rows={LAYER_MATRIX} label="layer kind" />
      </div>
      <div className="min-w-[300px] lg:w-72">
        <MatrixTable rows={MODE_MATRIX} label="time-filter mode" />
        <p
          className="mt-3 text-[10.5px] leading-relaxed"
          style={{ color: 'var(--ink-400)' }}
        >
          deck.gl is the reference backend; Three (WebGPU/TSL) tracks it closest
          and adds the ego/cockpit kinds; MapLibre now renders nearly the whole
          catalog as native custom layers — points through summary tiers and
          flow families — on the basemap; Cesium focuses on the movement catalog
          on a WGS84 globe.
        </p>
      </div>
    </div>
  </Card>
);

const PackagesMap: React.FC = () => (
  <div className="space-y-4">
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <RustPanel />
      <TsPanel />
    </div>
    <CapabilityMatrix />
  </div>
);

export default PackagesMap;
