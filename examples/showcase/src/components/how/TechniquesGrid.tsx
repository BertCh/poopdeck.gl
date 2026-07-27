import React from 'react';

/**
 * The techniques cheat-sheet, grouped by what each lever buys: smaller
 * archives, fewer/smarter fetches, smoother frames. Each card carries the
 * flag or API that switches it on.
 */

interface Technique {
  title: string;
  body: string;
  tag: string;
}

interface TechniqueGroup {
  label: string;
  blurb: string;
  items: Technique[];
}

const GROUPS: TechniqueGroup[] = [
  {
    label: 'Smaller archives',
    blurb:
      'Cut bytes at build time. The lossless levers run by default; the ones that trade precision for size are opt-in, exact to a declared precision, and undone on decode.',
    items: [
      {
        title: 'Coordinate quantization',
        body: 'Geometry stored as fixed-point integers on one world-anchored grid — the same grid for every tile, so identical geometry stays byte-identical and content-addressed dedup survives — at a chosen ground precision, a fraction of float64 with no visible loss.',
        tag: '--quantize-coords · stt:quant',
      },
      {
        title: 'Attribute quantization',
        body: 'Every Float64 property maps onto 65 536 levels of its own range, plus a tiny affine to reconstruct real values on decode — or pin one column to a fixed precision.',
        tag: '--quantize-attrs-auto · TILE_META.qa',
      },
      {
        title: 'Compact feature times',
        body: 'On by default: start_time becomes a UInt32 offset from the tile’s own t0, and end_time vanishes entirely when every feature is instantaneous. Measured a third of a point archive’s bytes.',
        tag: 'TILE_META.st / .et',
      },
      {
        title: 'Shared schema templates',
        body: 'Arrow schemas are dataset-constant, so tiles reference one by 16-byte blake3 hash instead of repeating ~900 B of it each. Single-digit templates cover a whole dataset.',
        tag: 'manifest.schemas',
      },
      {
        title: 'Per-blob zstd',
        body: 'Every tile blob is an independent zstd frame, so the browser decodes with a ~30 kB pure-JS decoder — no WASM, no shared dictionary.',
        tag: '--zstd-level 1…22 · --publish',
      },
      {
        title: 'Content-addressed dedup',
        body: 'Blobs are stored once, keyed by blake3. Byte-identical time buckets collapse — static or quiet periods cost almost nothing.',
        tag: 'packs/<blake3>.sttp',
      },
      {
        title: 'Simplify + pre-tessellate',
        body: 'Time-aware line simplification keeps the motion and drops the noise, at a latitude-corrected ground tolerance; polygons can bake their earcut triangles so clients skip tessellation.',
        tag: '--time-aware-simplify · --pre-tessellate',
      },
    ],
  },
  {
    label: 'Fewer, smarter fetches',
    blurb:
      'Move only the bytes the current viewport, zoom and playhead actually need.',
    items: [
      {
        title: 'Paged directory',
        body: 'The default: the tile index ships in pages, and 52-byte root descriptors prune whole leaves by zoom ∧ bbox ∧ time span before any fetch.',
        tag: 'layout: "paged" · --page-entries',
      },
      {
        title: 'Range coalescing',
        body: 'Neighbouring blobs in a pack fuse into one HTTP range request when the gap is under 2 MiB — Hilbert ordering makes neighbours common.',
        tag: 'HTTP 206 · coalesceGapBytes',
      },
      {
        title: 'Temporal LOD',
        body: 'Coarser time buckets at low zooms: a continent view scrubs days per tile while street level streams hours.',
        tag: '--temporal-lod "1d@8,30d@4"',
      },
      {
        title: 'Summary tiers',
        body: 'Pre-aggregated H3 or quadbin cells serve the overview zooms, so a hundred million points still open instantly.',
        tag: '--summary-tier quadbin',
      },
      {
        title: 'Zoom bands',
        body: 'Each feature carries a [min, max] zoom range — clustered overviews own the low zooms, full resolution appears as you dive.',
        tag: '--min/max-zoom-field',
      },
      {
        title: 'Tile budgets',
        body: 'Opt-in per-tile caps on bytes or features drop the lowest-importance rows to fit, and log exactly what was dropped where.',
        tag: '--maximum-tile-bytes',
      },
    ],
  },
  {
    label: 'Smoother frames',
    blurb:
      'Keep the render thread idle: animation lives in the shader, decode lives in workers.',
    items: [
      {
        title: 'GPU time gate',
        body: 'Feature and vertex times upload once as attributes; each frame changes a few uniforms and the shader alpha-gates — no rebuilds, ever.',
        tag: 'TimeFilterExtension',
      },
      {
        title: 'Zero-copy GPU columns',
        body: 'Interleaved FixedSizeList columns (quaternions, colors, scales) bind to the GPU exactly as decoded — no main-thread repacking.',
        tag: '--vector-group',
      },
      {
        title: 'Off-thread decode + OPFS',
        body: "Workers decompress and parse tiles off the UI thread; decoded tiles persist in the browser's private file system across visits.",
        tag: 'createDefaultTileDecoder',
      },
      {
        title: 'Space-time values',
        body: 'A per-vertex × per-bucket value cube animates static geometry — streets breathing with hourly traffic while their shape ships once. Optionally UInt16-quantized, the only lever those columns have.',
        tag: 'vertex_value_matrix · --quantize-vertex-values',
      },
    ],
  },
];

const TechniquesGrid: React.FC = () => (
  <div className="space-y-8">
    {GROUPS.map((g) => (
      <div key={g.label}>
        <div
          className="pb-2 mb-3"
          style={{ borderBottom: '1px solid var(--hairline)' }}
        >
          <h3
            className="font-display text-sm font-semibold"
            style={{ color: 'var(--ink-900)' }}
          >
            {g.label}
          </h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            {g.blurb}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {g.items.map((t) => (
            <div
              key={t.title}
              className="rounded-lg p-3.5 flex flex-col"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--hairline)',
              }}
            >
              <h4
                className="font-display text-[13px] font-semibold"
                style={{ color: 'var(--ink-900)' }}
              >
                {t.title}
              </h4>
              <p
                className="mt-1.5 text-[11px] leading-relaxed flex-1"
                style={{ color: 'var(--ink-500)' }}
              >
                {t.body}
              </p>
              <span
                className="mt-2.5 self-start rounded px-1.5 py-0.5 font-mono text-[10px]"
                style={{
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                }}
              >
                {t.tag}
              </span>
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
);

export default TechniquesGrid;
