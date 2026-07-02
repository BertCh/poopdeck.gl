# Frontend Hot-Path Performance Audit — 2026-06

Audit of the frontend (`packages/layers`, `packages/core`, `examples/showcase/src`) for GPU-layer
hot-path bottlenecks — per-frame and per-tile-arrival CPU main-thread work that scales with feature
count.

**Status 2026-07-01: CLOSED.** Every actionable finding is fixed in the working tree
(`feat/db-parity-comprehensive`); the two remaining rows were explicitly accepted as
non-issues. Verified against source — kept as a decision record.

## Findings (all resolved)

| ID | Sev | Outcome | File:line | Issue | Resolution |
|----|-----|---------|-----------|-------|------------|
| HIGH-1 | HIGH | **FIXED** | `packages/layers/src/layers/core/animated-bounding-box-layer.ts:563–574` | `_handleTimeUpdate` forced `setState({boxFrame})` every tick (60 Hz) even when the playhead hadn't moved. | Gated on `time !== lastBoxFrameTime` — a repeated/identical tick (paused-but-emitting clock, duplicate governor tick) no longer forces renderLayers + instance-buffer reupload. Any real sim-time advance still re-samples, keeping interpolation smooth at all playback speeds. |
| HIGH-2 | HIGH | **FIXED** | `splat-layer.ts` | `computeStyleKey()` was called twice per tile (`prepareTile` + `buildTileData`). | Computed **once** in `buildTileData` and threaded as a param. |
| HIGH-3 | HIGH | **FIXED** | `animated-bounding-box-layer.ts` (`buildTrackIndex`, sort/dedupe pass ~691–726) | Post-process allocated a fresh `Array.from({length:n})` + stable sort + a second `keep` array per track — up to 2× array churn per track, on every visible-tile-set change. | Sort + dedupe folded into a SINGLE permutation applied by ONE reorder pass, using a **reused** index buffer across tracks. Output ordering byte-identical to the old sort→reorder→dedupe. (The per-track `sort` itself stays — Σ K log K ≤ N log N, allocation churn was the real cost.) |
| MED-1 | MED | **FIXED** | `packages/core/src/tile.ts` | Numeric columns unconditionally copied f64/f32 → fresh `Float32Array`. | Zero-copy fast path: a non-quantized `Float32Array` of the right length returns the Arrow buffer directly; the copy remains only for dequant/affine paths. |
| MED-2 | MED | **FIXED** | `animated-point-layer.ts:905–923` | Elevation-override path did `Float64Array.from(...)` **then** a separate z-overwrite loop — two passes per tile. | Fused into one pass: copy x/y from the Arrow buffer and bake `z = elevValues[i]*elevScale` in the same loop; source buffer never mutated. |
| MED-3 | MED | **accepted** | `packages/layers/src/lib/od-positions.ts` | `deriveSourceTargetPositions` allocates two buffers per arc/line tile arrival. | Cold path, already well-optimized. Revisit only under a measured dense-OD stall. |
| MED-4 | MED | **not an issue** | `heatmap-layer.ts` | ~30 Hz state flush for `filterRange`. | Wall-clock gated (`FILTER_UPDATE_HZ = 30`) — the reference pattern for per-frame layers. |
| MED-5 | MED | **FIXED** | `packages/core/src/tile.ts:354–368` ⇄ `crates/stt-core/src/arrow_tile.rs:1571–1574` | Start/end-time decode ran a min-scan pass to find `timeOffset` before the relativising convert. | `timeOffset` is now baked at build time as schema metadata (`stt:time_offset_ms`, the min of the layer's start times); the JS decoder reads it and skips the min-scan, falling back to the exact old scan for tiles from older builders. |
| LOW-1 | LOW | **FIXED** | `animated-bounding-box-layer.ts` | Per-track `Array.from` + `sort` alloc churn. | Folded into the HIGH-3 single-pass-merge rewrite, as recommended. |

## Kept as reference patterns

- **SplatLayer prepared-data caching** — caches by `tileKey + styleKey`, preserves object identity
  so deck.gl's `dataComparator: (a,b) => a===b` skips GPU re-uploads.
- **AnimatedPointLayer zero-copy elevation fallback** — returns `binary.positions` directly when no
  elevation override.
- **HeatmapLayer wall-clock gating (MED-4)** — the model other per-frame layers should follow.
