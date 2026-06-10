# SOTA Evaluation — STT vs. web-scale spatiotemporal systems (June 2026)

**Provenance.** An external 110-agent research pass surveyed the 2024–2026 state of the art
(PMTiles/COMTiles, Arrow/GeoArrow/Lonboard, COG/Zarr, deck.gl v9/WebGPU, MapLibre v5) and
evaluated STT against it. This document is that evaluation **re-verified against the actual
codebase** (six parallel code audits, 2026-06-09): every claim about our code was checked with
file-level evidence. Where the external evaluation was wrong about us, it is corrected here.

**Headline.** STT independently re-derived the verified SOTA on every mechanism that matters —
content-addressed immutable packs + range requests + edge CDN, all-binary Arrow/GeoArrow
pipeline, worker-pool decode with real zero-copy transfers, per-tile f32 time relativization,
GPU-side time filtering. The real exposure is in (a) scope boundaries not yet stated (raster,
live/append), (b) one shipped-format scaling wall (whole-load directory), (c) a platform shift
(WebGPU) that strands our GLSL extensions, and (d) an adoption surface that is currently zero —
though *not* for the reason the external evaluation thought.

---

## 1. Verified strengths (codebase-confirmed, keep & market)

| Capability | Verified reality |
|---|---|
| Content-addressed packs | blake3-128 keys (`pack.rs:64–72`), 64 MiB target never splitting blobs (`pack.rs:57,337–351`), edge-cache MISS→HIT proven on R2. Matches the PMTiles/Protomaps serverless pattern exactly. |
| Per-tile time relativization | `tile.ts:255–276` computes per-tile `timeOffset` = min `start_time`; vertex times too (`tile.ts:180–209`); layers rebase tile→slab (`animated-point-layer.ts:900–906`). **No raw epoch-ms reaches any f32 GPU attribute** — audit found zero residual precision leaks. This is the deck.gl-documented fix for the ~190-day f32 trap. |
| Binary pipeline | Arrow IPC + GeoArrow tiles decoded in a 2–4 worker pool (`tile-decoder.ts:100–111`), positions as `.subarray()` views into the IPC buffer (`tile.ts:126,140,167`), de-duplicated transferables (`tile-transferables.ts:29–75`). Honest framing: zero-copy worker→main, copy-direct-to-GPU — same as the research's corrected claim for Lonboard/deck.gl. |
| Loading stack | Range coalescing with **2 MB** gap (raised from 512 K for R2 free egress, `archive.ts:58–75`), 24-way concurrency pool, device-aware memory LRU (256/512 MB), OPFS persistence (512 MB, survives reload). **Correction to prior claims: this is a 2-tier cache, not 3** — `frameNumber` is a render-validity counter, not a cache tier. |
| Player/buffering | Runway API (`getBufferedRunway`), 5-state PlaybackGovernor with ExoPlayer-style hysteresis, dual-EWMA throughput estimator (hls.js-style), auto-speed suggestion. `PLAYBACK_SLOWDOWN` deleted. Ahead of anything documented by verified competitors on the temporal axis. |
| H3 summary tier | Genuinely end-to-end, unlike raster: builder emits (`stt-build/src/summary.rs`), client renders (`h3-summary-layer.ts`), auto tier dispatch (`spatiotemporal-layer.ts:716–744`), integration-tested roundtrip. |

---

## 2. Corrections to the external evaluation

These matter because two of its top recommendations don't survive contact with the code.

### 2.1 ❌ `maplibre.addProtocol('stt', …)` is NOT the adoption unlock (refuted as framed)

The external evaluation called the addProtocol shim "the single highest-leverage adoption move,"
by analogy to PMTiles. The analogy fails: `addProtocol` is a fetch interceptor that returns tile
bytes for **MapLibre's native renderers** (MVT/raster). PMTiles works because its payload *is*
MVT. STT tiles are Arrow IPC + GeoArrow (`tile.ts:6–18`) with time semantics that require our
custom shaders — stock MapLibre cannot render them no matter how the bytes arrive. There is no
MVT export path. An addProtocol shim only becomes meaningful if we ever ship a (lossy,
time-flattened) MVT export — which is a different, lower-priority decision.

**The actual #1 adoption blocker is that the packages cannot be installed at all.** Root
`package.json` is `"private": true`; `@stt/core` / `@stt/deck.gl` / `@stt/maplibre` are 0.1.x
workspace packages with `workspace:*` internal deps, never published to npm. A third party today
must fork the monorepo. The adoption unlock, in order: **npm publish → consumption quickstart
(non-monorepo deck.gl + maplibre integration guide) → `stt info` / `stt serve` inspector.**
Docs are strong on data *production* (python.md, data-generation.md) and weak on *consumption*.

### 2.2 ⚠️ The README does not over-advertise raster (overstated)

"Silently (a) while advertising (b)" is wrong: the README positions STT as an Arrow/GeoArrow
**tile format** and never promises raster/COG/Zarr. The "PMTiles/COG pattern, extended to time"
line lives only in `docs/roadmap/stt-v4.md`. The real loose end is smaller and concrete:
`stt-build --heatmap-raster` is a shipped CLI flag that writes **metadata only**
(`stt-build/src/main.rs:858–872`: "Records intent only — sidecar generation lands in a
follow-up"; `RasterTier` parsed by the TS client at `archive.ts:542,1336` but rendered by
nothing). Decision needed: ship the sidecar generation or delete the flag + `RasterTier` types.
A scope paragraph in the README ("vector trajectories, not datacubes — use Zarr/COG for
time-varying rasters") closes the rest.

### 2.3 ⚠️ MapLibre version claim was imprecise (but the gap is real)

Not "pinned ^3.6.0": the adapter peerDeps `maplibre-gl ^3 || ^4`, dev-tested against 4.7.0; only
the **showcase** pins ^3.6.0. The genuine blocker is scoped precisely: `base-layer.ts:448–454`
explicitly rejects v5 globe ("shaders assume mercator-unit-square inputs and v5 globe passes a
4D projector"); `projection.ts` hardcodes Web Mercator; ~40 matrix/NDC touchpoints across the
5 layer classes (clip transform + screen-space line/stroke expansion). The showcase's
`MaplibreRenderer.tsx` already calls `setProjection` behind try/catch, so the wiring is staged.
Estimate: maplibre-gl 4.7→5 bump + globe branch in the adapter ≈ **2–3 days**. While in there,
note the other parity debt found: the maplibre adapter has **no summary tier, no picking, butt
joints only**.

### 2.4 Minor strength-table corrections

"3-tier cache" → 2-tier (memory LRU + OPFS; `frameNumber` is a memoization version key).
"512K gap" → 2 MB since the R2 tuning. Everything else in the strengths table verified.

---

## 3. Confirmed gaps, now with hard numbers

### 3.1 Whole-load single-level directory — real wall, but further away than implied ⭐

Confirmed: the client fetches the entire `.sttd` in one GET and fully decodes it before any tile
fetch (`archive.ts:559–567`); no two-level/leaf directories (the stt-v4 §2.1 design was not built
into v5); the manifest carries **no section offsets**, so partial range-reads are impossible —
decode must start at byte 0.

Measured scaling from production directories:

| Dataset | Entries | Directory | Bytes/entry |
|---|---|---|---|
| flights | ~320 K tiles × 24 buckets | 6.38 MB | ~20 B |
| drifters | ~1.05 M tiles | 7.32 MB | ~7 B |

So the current fleet is comfortably fine (single-digit MB, immutable, edge-cached). The wall:
~7–22 B/entry means ~5 M entries ≈ 35–100 MB (painful) and 1 B entries ≈ ~22 GB (impossible).
Adaptive fine temporal buckets multiply entries and break blob-run RLE, so planet × fine-time
hits this earlier.

**Cheap additive first step (before COMTiles-style fragments):** write per-zoom-band (or
zoom×time-band) **section offsets into the manifest**. The `.sttd` blob is unchanged — new
readers range-read the bands they need; old readers keep fetching whole. Full COMTiles fragment
index only if a real planet-scale dataset materializes.

### 3.2 Live/append — structurally precluded today; one contract is the actual blocker ⭐

Confirmed strictly batch: no append/stream/tail path anywhere; `--streaming` flags are internal
bounded-RAM batch optimizations. The specific structural blocker is the **manifest contract,
not the directory codec**: `pack_id` is the *positional index* into `manifest.packs[]`
(`pack.rs:90–91`), the TS reader assumes a dense contiguous array, and there is no
generation/epoch field — so any append that inserts packs invalidates every existing directory
reference. The directory encoding itself already supports sparse per-run pack ids, so a
tail-pack design needs only: (1) generation field in the manifest, (2) packs keyed by content
hash instead of position, (3) reader generation-mismatch refresh. That's a contained spec rev.

**Decision needed either way:** state live/append as an explicit non-goal in the README, or
reserve the manifest fields now (cheap) and put the tail-pack design in the packed roadmap.
Don't let reviewers discover the limitation themselves.

### 3.3 WebGPU/WGSL exposure — inventoried; smaller than feared except VAT ⭐

We're already on deck.gl/luma.gl **9.3** (the v9 uniform-block extension API — good position).
The custom shader surface and port risk:

| Module | GLSL | Self-contained? | WGSL risk / effort |
|---|---|---|---|
| TimeFilterExtension | ~150 lines | Pure arithmetic, no samplers, no deck utils; used by 3 layers | **LOW — 1–2 days. Do this spike first.** |
| PolygonTimeFilterExtension | ~90 lines | Same window math, tesselator is deck's problem | LOW — 1 day |
| CategoryColorExtension | ~60 lines | 4096×1 palette texture → bind-group plumbing | MEDIUM — 2–3 days |
| VatTripsLayer (head+trail) | ~400 lines | Depends on deck's `project_position_to_clipspace`, `gl_VertexID`, manual texture lerp, NDC extrusion | **HIGH — 2–3 weeks, partly blocked on upstream deck WGSL** |
| HeatmapLayer | 0 custom | Canonical deck layers + DataFilterExtension | upstream's problem |
| NoPickingPathLayer | 0 (regex shader rewrite) | Strips `instancePickingColors` to fit the 16-attribute WebGL2 budget | **Brittle across deck versions; likely obsolete in deck 9.4 (gl_InstanceID picking) — check on next bump** |

Also confirmed: CategoryColorExtension does **coloring only** (no discard/filtering), so deck
v9's `getFilterCategory` does *not* obviously let us delete code — the external suggestion was
based on a wrong premise about what our extension does.

### 3.4 Scope decisions (raster, live) — see §2.2 and §3.2; both are one-paragraph README
statements plus one cheap code action each (delete-or-ship the raster scaffold; reserve
manifest generation fields).

---

## 4. Inspiration (kept from the research, still valid)

- **COMTiles fragment index** → the eventual answer for §3.1 if planet-scale lands; ship the
  low-zoom band inline in the manifest, lazy-load deeper bands.
- **Generated catalog** → `manifest.json` metadata (bounds, time_range, layers, counts) is
  already self-describing enough to generate a `catalog.json`; `datasets.ts` would shrink to
  presentation config (palette, playback speed, camera). No DuckDB needed at our catalog size.
- **Zarr "chunk = read granularity"** → validates adaptive temporal chunking; informs any future
  raster tier.
- **WebGPU compute** → future alternative to build-time H3 summary aggregation.

---

## 5. Revised priority order (evidence-based, replaces the external list)

1. **Publish to npm + consumption quickstart + `stt info`** — the real adoption unlock
   (replaces "addProtocol shim", which is architecturally moot without an MVT export).
   `stt info` is small: manifest + metadata pretty-printer over existing structs.
2. **Scope statement in README** — vector-trajectory niche owned explicitly; live/append as
   stated non-goal *or* roadmapped tail-pack; delete-or-ship `--heatmap-raster`.
3. **MapLibre 4.7→5 + adapter globe branch** (~2–3 days, ~40 touchpoints) + summary-tier parity
   while in the adapter. Verify upstream globe bugs (custom-layer z12, deck sync) against our
   datasets.
4. **WGSL TimeFilterExtension spike** (1–2 days) — de-risks the platform shift; defer VAT until
   upstream deck WGSL utilities exist. Re-check NoPickingPathLayer on the next deck bump.
5. **Manifest hardening** — generation field + hash-keyed packs (enables future append) and
   directory section offsets (additive partial-read path) **before** any planet-scale +
   fine-bucket dataset is attempted.
