import React from 'react';
import FigureSvg from '../FigureSvg.tsx';

/**
 * "Inside a tile" figure: the v2 sectioned layer frame (schema hoisted into
 * `manifest.schemas`, CORE/PROPS split) and the columnar schema — the three
 * required columns plus the optional ones that turn static geometry into
 * animation.
 *
 * Evidence: docs/spec/stt-packed-format.md §5.2 (frame layout, section tag
 * registry, reserved CORE column order, TILE_META keys);
 * crates/stt-core/src/arrow_tile/{encode,frame}.rs.
 */

interface Col {
  group: string;
  name: string;
  type: string;
  note: string;
  required?: boolean;
}

const COLS: Col[] = [
  {
    group: 'identity',
    name: 'id',
    type: 'UInt64',
    note: 'stable feature id — picking and cross-tile identity',
    required: true,
  },
  {
    group: 'time',
    name: 'start_time',
    type: 'UInt32 Δ from t0',
    note: "offset from the layer's own t0 by default; absolute Int64 when a tile needs it",
    required: true,
  },
  {
    group: 'space',
    name: 'geometry',
    type: 'GeoArrow pt · line · poly',
    note: 'interleaved f64 — or fixed-point ints on a world-anchored stt:quant grid',
    required: true,
  },
  {
    group: 'time',
    name: 'end_time',
    type: 'UInt32 duration',
    note: 'dropped entirely when every feature is instantaneous — true of most event data',
  },
  {
    group: 'per-vertex time',
    name: 'vertex_time',
    type: 'List<UInt16|UInt32>',
    note: 'a timestamp per vertex (origin + step in TILE_META.vt; exact Int64 fallback) — trips & trails',
  },
  {
    group: 'per-vertex values',
    name: 'vertex_value',
    type: 'List<Float32|UInt16>',
    note: 'one scalar per vertex, NaN = no sample — e.g. temperature along a track',
  },
  {
    group: 'per-vertex values',
    name: 'vertex_value_matrix',
    type: 'List<Float32|UInt16>',
    note: 'vertex-major × time buckets (TILE_META.vb) — static geometry, animated values',
  },
  {
    group: 'geometry extras',
    name: 'triangles',
    type: 'List<UInt16|UInt32>',
    note: 'pre-baked earcut indices — polygons skip tessellation on load',
  },
  {
    group: 'geometry extras',
    name: 'part_offsets',
    type: 'List<UInt32>',
    note: 'MultiPolygon part boundaries — without it, parts 2..n read as holes',
  },
  {
    group: 'props batch',
    name: '<your columns>',
    type: 'Float64 · Dict<UInt16,Utf8>',
    note: 'numeric + categorical props; optionally fixed-point ints + a TILE_META.qa affine',
  },
  {
    group: 'props batch',
    name: '<vector groups>',
    type: 'FixedSizeList<f32|u8, N>',
    note: 'interleaved quats / colors / scales — bound to the GPU zero-copy',
  },
];

/** The v2 frame header, left to right. */
const FRAME_SEGMENTS: { label: string; accent?: boolean }[] = [
  { label: 'u16 0xFFFF' },
  { label: 'u8 ver = 2' },
  { label: 'u16 layer count' },
  { label: 'name "default"' },
  { label: 'schema ref → blake3-128', accent: true },
  { label: 'section TOC' },
  { label: 'pad → 8 B' },
];

/** The sections that follow, in tag order. */
const FRAME_SECTIONS: { label: string; sub: string; wide?: boolean }[] = [
  { label: 'TILE_META', sub: 'per-tile JSON: t0 · st/et · qa · vt · vb · vq' },
  {
    label: 'CORE_BATCH',
    sub: 'id · times · geometry · vertex columns',
    wide: true,
  },
  {
    label: 'PROPS_BATCH',
    sub: 'your property columns — omitted if none',
    wide: true,
  },
];

const TileAnatomy: React.FC = () => (
  <div
    className="rounded-lg p-4"
    style={{
      background: 'var(--surface)',
      border: '1px solid var(--hairline)',
    }}
  >
    {/* the layer frame */}
    <h4
      className="font-display text-[13px] font-semibold"
      style={{ color: 'var(--ink-900)' }}
    >
      A tile is a sectioned frame — and its schema isn't in it
    </h4>
    <div className="mt-3 overflow-x-auto">
      <div className="flex items-stretch gap-1 min-w-[680px]">
        {FRAME_SEGMENTS.map((seg) => (
          <div
            key={seg.label}
            className="rounded px-2 py-1.5 font-mono text-[10px] whitespace-nowrap"
            style={
              seg.accent
                ? {
                    background: 'var(--accent-soft)',
                    border: '1px solid var(--accent)',
                    color: 'var(--accent)',
                  }
                : {
                    background: 'var(--surface-sunken)',
                    border: '1px solid var(--hairline)',
                    color: 'var(--ink-500)',
                  }
            }
          >
            {seg.label}
          </div>
        ))}
      </div>
      <div className="flex items-stretch gap-1 min-w-[680px] mt-1">
        {FRAME_SECTIONS.map((s) => (
          <div
            key={s.label}
            className={`rounded px-2 py-1.5 ${s.wide ? 'flex-1' : ''}`}
            style={{
              background: 'var(--surface-sunken)',
              border: '1px solid var(--hairline)',
            }}
          >
            <span
              className="block font-mono text-[10px]"
              style={{ color: 'var(--ink-900)' }}
            >
              {s.label}
            </span>
            <span
              className="block text-[9.5px] mt-0.5 whitespace-nowrap"
              style={{ color: 'var(--ink-400)' }}
            >
              {s.sub}
            </span>
          </div>
        ))}
      </div>
    </div>
    <p
      className="mt-2 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      Arrow schemas are dataset-constant, so shipping one per tile pays for the
      same bytes tens of thousands of times. Instead each layer carries a
      16-byte blake3 reference into a schema table embedded in{' '}
      <span className="font-mono">manifest.json</span>; only genuinely per-tile
      metadata rides in <span className="font-mono">TILE_META</span>. Splitting
      geometry from properties lets a reader decode a tile's shape without
      touching its columns. Every section pads to 8 bytes and the IPC writer is
      pinned to 8-byte buffer alignment, so column buffers hand to the GPU
      without copying.
    </p>

    {/* the columns */}
    <h4
      className="font-display text-[13px] font-semibold mt-6"
      style={{ color: 'var(--ink-900)' }}
    >
      …and the batches are columns
    </h4>
    <div className="mt-3 overflow-x-auto pb-1">
      <div className="flex items-stretch gap-2">
        {COLS.map((c) => (
          <div
            key={c.name}
            className="w-44 shrink-0 rounded-md px-3 py-2.5 flex flex-col"
            style={{
              background: c.required
                ? 'var(--surface)'
                : 'var(--surface-sunken)',
              border: '1px solid var(--hairline)',
              borderTop: `2px solid ${c.required ? 'var(--accent)' : 'var(--hairline)'}`,
            }}
          >
            <span className="eyebrow" style={{ fontSize: 9 }}>
              {c.group}
            </span>
            <span
              className="font-mono text-xs font-semibold mt-1"
              style={{ color: 'var(--ink-900)' }}
            >
              {c.name}
            </span>
            <span
              className="font-mono text-[10px] mt-0.5"
              style={{ color: 'var(--accent)' }}
            >
              {c.type}
            </span>
            <span
              className="text-[10.5px] leading-snug mt-1.5 flex-1"
              style={{ color: 'var(--ink-500)' }}
            >
              {c.note}
            </span>
            {c.required ? (
              <span
                className="mt-2 text-[9px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--accent)' }}
              >
                required
              </span>
            ) : (
              <span
                className="mt-2 text-[9px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--ink-400)' }}
              >
                optional
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
    <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-500)' }}>
      A tile of simple events costs three columns — most event data is
      instantaneous, so <span className="font-mono">end_time</span> isn't
      written at all. Trips, splats, flow corridors and summary tiers are the
      same container with more columns switched on; there is no separate format
      per layer type.
    </p>

    {/* quantization deep-dive */}
    <h4
      className="font-display text-[13px] font-semibold mt-6"
      style={{ color: 'var(--ink-900)' }}
    >
      Deeper: how the numbers shrink
    </h4>
    <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-500)' }}>
      Every quantization is opt-in and ships its own inverse, so the reader
      reconstructs real values on decode and nothing downstream knows the wire
      was smaller. Each one also declares itself in{' '}
      <span className="font-mono">manifest.capabilities</span> — a reader that
      doesn't implement it refuses the dataset at open rather than silently
      drawing integer grid indices as degrees.
    </p>
    <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
      {/* coordinates */}
      <div
        className="rounded-md p-3"
        style={{
          background: 'var(--surface-sunken)',
          border: '1px solid var(--hairline)',
        }}
      >
        <span className="eyebrow" style={{ fontSize: 9 }}>
          coordinates
        </span>
        <FigureSvg
          viewBox="0 0 180 90"
          className="w-full mt-2"
          aria-label="Diagram: a point snapping to one world-anchored integer grid shared by every tile."
        >
          {Array.from({ length: 9 }, (_, i) => (
            <React.Fragment key={i}>
              <line
                x1={10 + i * 20}
                y1="6"
                x2={10 + i * 20}
                y2="86"
                stroke="var(--hairline)"
                strokeWidth="0.75"
              />
              {i < 5 ? (
                <line
                  x1="10"
                  y1={6 + i * 20}
                  x2="170"
                  y2={6 + i * 20}
                  stroke="var(--hairline)"
                  strokeWidth="0.75"
                />
              ) : null}
            </React.Fragment>
          ))}
          <circle cx="97" cy="53" r="3.5" fill="var(--ink-400)" />
          <path
            d="M 97 53 L 89 47"
            stroke="var(--accent)"
            strokeWidth="1.25"
            markerEnd="none"
          />
          <circle cx="90" cy="46" r="3" fill="var(--accent)" />
        </FigureSvg>
        <p
          className="font-mono text-[10px] mt-2"
          style={{ color: 'var(--ink-700)' }}
        >
          lon = x0 + q · sx
        </p>
        <p
          className="text-[10.5px] mt-1 leading-snug"
          style={{ color: 'var(--ink-500)' }}
        >
          Vertices snap to <em>one</em> grid anchored at the world corner
          (−180°, −90°), constant across the dataset, sized to your ground
          precision. Because every tile shares it, identical geometry stays
          byte-identical — a per-tile grid would give the same point different
          indices per tile and defeat blob dedup (measured +61%). Affine lives
          in <span className="font-mono">stt:quant</span>.
        </p>
        <span
          className="inline-block mt-2 rounded px-1.5 py-0.5 font-mono text-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          f64 8 B → int 4 B
        </span>
      </div>

      {/* vertex times */}
      <div
        className="rounded-md p-3"
        style={{
          background: 'var(--surface-sunken)',
          border: '1px solid var(--hairline)',
        }}
      >
        <span className="eyebrow" style={{ fontSize: 9 }}>
          vertex times
        </span>
        <FigureSvg
          viewBox="0 0 180 90"
          className="w-full mt-2"
          aria-label="Diagram: vertex timestamps stored as small step counts from a per-tile origin."
        >
          <line
            x1="10"
            y1="60"
            x2="170"
            y2="60"
            stroke="var(--ink-400)"
            strokeWidth="1"
          />
          {Array.from({ length: 9 }, (_, i) => (
            <line
              key={i}
              x1={14 + i * 19}
              y1="55"
              x2={14 + i * 19}
              y2="65"
              stroke="var(--hairline)"
              strokeWidth="1"
            />
          ))}
          <path d="M 14 60 L 14 34" stroke="var(--accent)" strokeWidth="1.25" />
          <text
            x="14"
            y="26"
            fontSize="9"
            textAnchor="middle"
            fill="var(--accent)"
            fontFamily="monospace"
          >
            origin
          </text>
          {[2, 3, 5, 8].map((k) => (
            <circle
              key={k}
              cx={14 + k * 19}
              cy="60"
              r="3"
              fill="var(--accent)"
            />
          ))}
          <text
            x="90"
            y="82"
            fontSize="9"
            textAnchor="middle"
            fill="var(--ink-400)"
            fontFamily="monospace"
          >
            step = 250 ms
          </text>
        </FigureSvg>
        <p
          className="font-mono text-[10px] mt-2"
          style={{ color: 'var(--ink-700)' }}
        >
          t = origin + q · step
        </p>
        <p
          className="text-[10.5px] mt-1 leading-snug"
          style={{ color: 'var(--ink-500)' }}
        >
          Trajectory timestamps become UInt16 step counts, widening to UInt32
          when a tile's span needs it and falling back to exact Int64 past the{' '}
          <span className="font-mono">--vertex-time-precision</span> ceiling.
        </p>
        <span
          className="inline-block mt-2 rounded px-1.5 py-0.5 font-mono text-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          i64 8 B → u16 2 B / vertex
        </span>
      </div>

      {/* attributes */}
      <div
        className="rounded-md p-3"
        style={{
          background: 'var(--surface-sunken)',
          border: '1px solid var(--hairline)',
        }}
      >
        <span className="eyebrow" style={{ fontSize: 9 }}>
          attributes
        </span>
        <FigureSvg
          viewBox="0 0 180 90"
          className="w-full mt-2"
          aria-label="Diagram: a float value range mapped onto 65536 integer levels."
        >
          <rect
            x="10"
            y="24"
            width="160"
            height="14"
            rx="7"
            fill="none"
            stroke="var(--ink-400)"
          />
          <text
            x="10"
            y="16"
            fontSize="9"
            fill="var(--ink-400)"
            fontFamily="monospace"
          >
            min
          </text>
          <text
            x="170"
            y="16"
            fontSize="9"
            textAnchor="end"
            fill="var(--ink-400)"
            fontFamily="monospace"
          >
            max
          </text>
          {Array.from({ length: 17 }, (_, i) => (
            <line
              key={i}
              x1={12 + i * 9.75}
              y1="42"
              x2={12 + i * 9.75}
              y2="48"
              stroke="var(--hairline)"
              strokeWidth="1"
            />
          ))}
          <text
            x="90"
            y="64"
            fontSize="9"
            textAnchor="middle"
            fill="var(--ink-400)"
            fontFamily="monospace"
          >
            65 536 levels across the range
          </text>
          <circle cx="104" cy="31" r="3.5" fill="var(--accent)" />
        </FigureSvg>
        <p
          className="font-mono text-[10px] mt-2"
          style={{ color: 'var(--ink-700)' }}
        >
          value = o + q · s
        </p>
        <p
          className="text-[10.5px] mt-1 leading-snug"
          style={{ color: 'var(--ink-500)' }}
        >
          <span className="font-mono">--quantize-attrs-auto</span> maps every
          Float64 property onto 65 536 levels of its own range;{' '}
          <span className="font-mono">--quantize-attr z=0.05</span> pins one
          column to a fixed precision instead. The per-column affine rides in{' '}
          <span className="font-mono">TILE_META.qa</span>.
        </p>
        <span
          className="inline-block mt-2 rounded px-1.5 py-0.5 font-mono text-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          f64 8 B → u16 2 B / value
        </span>
      </div>
    </div>
    <p
      className="mt-2 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      Integers also compress better: small deltas and repeated values give zstd
      far more to work with than float mantissas, so the wire savings compound
      beyond the raw width cut. On dense LiDAR archives the combination has
      measured 4–6× end-to-end.
    </p>
  </div>
);

export default TileAnatomy;
