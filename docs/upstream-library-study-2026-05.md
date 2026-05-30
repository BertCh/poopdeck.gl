# Upstream-Library Study — Arrow, GeoArrow, deck.gl, luma.gl (2026-05-29)

> Multi-agent study: 5 subsystem maps (Rust encoder, TS reader, deck.gl layers,
> MapLibre adapter, summary/showcase) → 5 deep upstream-library research passes →
> synthesis → adversarial grounding critique (verified against the code; 4 of the
> synthesis's recommendations were corrected or struck). Goal: translate the core
> concepts and roadmaps of the libraries that inspired STT into concrete,
> file:line-grounded improvements — *past* what STT already ships and *without*
> contradicting the documented non-goals.

## 1. TL;DR

STT has independently re-derived almost every upstream **scale** pattern
correctly — one-sublayer-per-RecordBatch, interleaved coords for zero-copy GPU
upload, uniform-block (UBO-aligned) LayerExtensions, server-side spatial-index
aggregation (H3 summary tier), and relativize-to-origin for f32 time. So the
remaining wins are **not** architectural rewrites; they are cheap,
standards-aligning **encoder** changes and a few "adopt-upstream-to-delete-code"
moves. The Rust encoder is the highest-leverage surface: it ships geometry with
**no CRS metadata**, a **silently-corrupting** categorical-dictionary overflow,
raw `Int64` times instead of the Arrow `Timestamp` logical type, and a full Arrow
schema re-emitted per layer per tile.

**Act first (cheap, verified, no non-goal conflict):** (1) add
`ARROW:extension:metadata` **CRS** JSON to the geometry field — a few bytes that
make every tile self-describing to GDAL / GeoPandas / lonboard / QGIS; (2) fix the
**u16 dictionary overflow** to error or widen instead of writing `u16::MAX-1`
(a real correctness bug); (3) **audit the TS reader** for the GeoArrow
padded-offset-buffer bug (deck.gl-geoarrow #214) — cheap to check, high severity
if present. A strong fourth is bumping **deck.gl → 9.4** to delete the
`NoPickingPathLayer` GLSL-regex shim once picking moves to `gl_InstanceID`.

> **Correction vs the first synthesis pass:** byte-budget tile eviction is **not**
> a gap — it is already fully implemented
> (`spatiotemporal-tileset.ts` `maxCacheByteSize`/`currentCacheBytes`/`byteSize`).
> The bbox-covering and coordinate-f32 ideas are real but were *over-ranked*: the
> reader already culls tiles to the viewport by `(z,x,y)`, and coordinate rebasing
> overlaps in-flight "Track B" work (`crates/stt-core/src/geometry.rs:9-10`).

## 2. How STT maps onto the upstream stack

### Apache Arrow (format + IPC)

| Library offers | STT today | Gap |
|---|---|---|
| Validity bitmap omitted when `null_count==0` | Non-null `id`/`start`/`end`/geometry pass all-`None` validity at the array constructors (`arrow_tile.rs:~236/252/285/443`) | Already optimal — no action |
| One RecordBatch = Schema + equal-length arrays; metadata side-channel | One RecordBatch/layer; sidecars in **schema-level** metadata `stt:layer`/`stt:geometry`/`stt:vertex_time_*`/`stt:has_triangles` | App semantics in schema-level `stt:` keys don't survive projection/reorder; `vertex_time` reads as an opaque `List<UInt16>` to non-STT tools |
| IPC streaming vs file footer (random access to named blocks) | `StreamWriter`, one stream per layer, bespoke `[u16 count][name][u32 len][ipc]` frame (`arrow_tile.rs:556-589`) | Re-emits a full Schema + EOS **per layer per tile**. A single multi-batch stream / IPC File footer removes the repeated schema bytes |
| Per-buffer IPC body compression (LZ4/ZSTD) | Deliberately **not** used — outer whole-blob zstd-3/gzip-6 (`compression.rs:52/64`) | **Correct as-is.** Outer-zstd supersedes per-buffer IPC compression for small tiles — do not enable it |
| `Timestamp(Millisecond)` logical type | Encoder emits raw `Int64` (`arrow_tile.rs:443/446`); the **input** path already speaks `TimestampMillisecondArray` (`input.rs:515/528`) | Encoder is *less* Arrow-idiomatic than its own decoder. Symmetric Timestamp = self-describing tiles, near-zero cost |
| Dictionary encoding + cross-batch unification | `Dictionary<UInt16,Utf8>` rebuilt **per layer per tile**, first-seen order (`arrow_tile.rs:303` / `build_dictionary_indices`) | No cross-tile unification: a recurring category re-ships its full string table every tile. Trained-zstd dict (`compression.rs:101`) only dedups raw bytes, not the Arrow dict |
| Dictionary key overflow handling | Past 65 535 categories the encoder writes `Some(u16::MAX-1)` — silently mis-labels (`build_dictionary_indices`, overflow branch) | **Correctness bug.** Should `Err` or widen the key |
| Run-End Encoding (REE) — standard Arrow RLE | Not used | `start/end` are locally clustered per tile (textbook REE); but verify `apache-arrow ^17` JS decodes REE before committing |

### GeoArrow (spec 0.2)

| Library offers | STT today | Gap |
|---|---|---|
| Interleaved `FixedSizeList<f64,2>` vs separated `Struct` coords | **Interleaved** (`arrow_tile.rs:236`) | **Correct for render** — lonboard/@geoarrow choose interleaved to avoid a re-interleave copy before GPU upload. Do **not** switch to separated |
| `ARROW:extension:name` **+** `ARROW:extension:metadata` (CRS, edges) | Sets `name` only (`arrow_tile.rs` geom_meta insert); **no metadata sibling** | No CRS → external readers treat geometry as unknown-CRS. Cheapest high-value interop fix |
| Native LineString offset buffer **is** deck `startIndices` | Stored as `List<FixedSizeList>`; TS rebuilds `startIndices` from `valueOffsets` (`tile.ts:131-140`) | Native-shaped — good. TS flattens polygon interior rings to feature-level offsets, discarding ring structure (`tile.ts:144-150`) |
| `geoarrow.box` bbox covering for chunk skipping | None computed (`stt-core/src/geometry.rs` has `bounding_box_*` helpers, unused by the encoder) | **Refinement, not a "biggest gap":** the reader already culls tiles to the viewport via `boundsToTiles()` (`archive.ts:789`) + archive bounds (`:358-363`). A per-tile box only helps *sparse/underfilled* tiles |
| IPC padded-offset trap (#214): size offsets from `FieldNode.length+1`, not `buffer.length` | TS derives counts from `valueOffsets`/`.offset` directly (`tile.ts:131-167`) | **Audit needed** — any count from `offsetBuffer.byteLength/4` is exactly this bug class |

### deck.gl v9.x

| Library offers | STT today | Gap |
|---|---|---|
| Binary data path `{length, attributes}`; `getPosition` accepts `size:2` | Used throughout (`animated-point-layer.ts:504-512`) but pads 2D tiles to size-3 | `padPositionsTo3D` allocates a fresh array per 2D tile; passing `size:2` drops it |
| `dataComparator:(a,b)=>a===b` + reference-stable data + per-tile sublayer cache | Applied correctly (`animated-trips-layer.ts:631-633`, `:305-308`) | Idiomatic and beyond — exactly what @geoarrow/deck.gl-layers does (one sublayer per RecordBatch). No action |
| `LayerExtension`: memoized `getShaders`, UBO module, `setShaderModuleProps` in draw | `TimeFilterExtension`/`CategoryColorExtension` are textbook (`time-filter-extension.ts:263-278/473`) | Aligned with the 9.x UBO convention — WebGPU-forward. No action |
| fp64 deprecated v6.3; project32 camera-relative origin ≈ same precision at ~½ the attributes | PathLayer trips use the 8-slot fp64 position split (`animated-trips-layer.ts:515-518`) → 16-attr WebGL2 ceiling → `NoPickingPathLayer` GLSL regex (`no-picking-path-layer.ts:47-48`) | Local-origin f32 frees ~4 slots (depends on the layer using project32 — no `fp64:true` set today). VAT already proves f32 positions work (`vat-trips-layer.ts:321-323`) |
| 9.4 removes `instancePickingColors` attribute (picking via `gl_InstanceID`) | Worked around with `NoPickingPathLayer` + `pickable:false` | Upgrade deletes the shim and re-enables pickable per-tile sublayers |
| `Tileset2D`/`TileLayer` (concurrency, LRU, **byte-budget** eviction, `visibleMin/MaxZoom`) | Bespoke `SpatiotemporalTileset` for the 4D `(z,x,y,t)` axis | **Justified** by the time axis. Byte-budget eviction is **already present** (`maxCacheByteSize` :262, `currentCacheBytes` :218, dual eviction :1021-1062) — adopt only the framing of `visibleMin/MaxZoom`, track RFC #6816 |
| `DataFilterExtension(filterSize:1)` + `filterSoftRange` (window+fade) | `TimeFilterExtension` reimplements window/fade in GLSL (`time-filter-extension.ts:281-364`) | Only **window** mode overlaps; trail/wake/cumulative have no upstream equivalent. Don't replace; maybe adopt `countItems`/`onFilteredItemsChange` for a free HUD count |
| CARTO `_count/_sum/_average/_min/_max` columns + global `stats` for stable domains; A5 equal-area DGGS | H3 summary tier, ad-hoc weight names; auto-fit domain flagged "visually unstable" (`h3-summary-layer.ts:583-584`) | No global stats blob; H3 cells vary up to 2× in area, biasing density ramps |

### luma.gl v9.x

| Library offers | STT today | Gap |
|---|---|---|
| `device.limits` (`maxTextureDimension2D`), `device.features.has('float32-filterable')` | VAT hardcodes `MAX_TEXTURE_SIZE=8192` (`vat-trips-layer.ts:61`) and uses nearest + manual 2-tap lerp on every backend (`:310-316`) | Query the real limit; feature-gate hardware linear filtering; `rg16float` halves VRAM where filterable |
| `project_position_to_clipspace(pos, position64Low, offset)` | VAT/heatmap hard-zero `world64Low=vec3(0.0)` (`vat-trips-layer.ts:321-323`, heatmap shader) → m-scale jitter at zoom ≥ 16 | Port the fp64 lo/hi split into the VAT texture to close the precision gap |

## 3. Improvement roadmap

Ordered by leverage within tiers. Excludes ALREADY-KNOWN items; nothing here
violates a documented NON-GOAL. `Cat` = NEW idea / REFINE-known /
ADOPT-upstream(delete code).

> **Implementation status (2026-05-29):** **U1, U2, U3 landed** on
> `audit-fixes-2026-05`. U1 — every geometry field now carries
> `ARROW:extension:metadata = {"crs":"OGC:CRS84","crs_type":"authority_code"}`
> (`arrow_tile.rs`), with a Rust round-trip test + a TS interop assertion against
> a regenerated `sample.stt`. U2 — `build_dictionary_indices` now returns `Err`
> on >`u16::MAX` distinct categories instead of silently writing `u16::MAX-1`
> (Rust test `categorical_overflow_errors_instead_of_corrupting`). U3 — audit
> confirmed the #214 bug is **absent** (the reader sizes from logical
> `geom.length`, never `buffer.length`); locked in by
> `packages/core/test/offset-buffer-padding.test.ts`. The spec
> (`docs/architecture/data-format.md`) documents the CRS key.

### Tier 1 — Act first (cheap, verified, high-confidence)

| ID | Title | Lib | Cat | What & why | Current state | Eff | Risk | Conf |
|---|---|---|---|---|---|---|---|---|
| U1 | CRS in `ARROW:extension:metadata` on the geometry field | GeoArrow | ADOPT | `{"crs":"EPSG:4326","crs_type":"authority_code"}` (or WGS84 PROJJSON). A few bytes; tiles become self-describing to GDAL/GeoPandas/lonboard/QGIS | name-only, no metadata sibling (`arrow_tile.rs` geom_meta) | S | Low | 0.95 |
| U2 | u16 dictionary overflow → `Err`/widen (correctness) | Arrow | NEW | >65 535 categories silently writes `u16::MAX-1`, mis-labeling features. Return `Err` or widen to `UInt32` | overflow branch in `build_dictionary_indices` | S | Low | 0.9 |
| U3 | Audit/guard the padded-offset-buffer bug (#214) + regression test | GeoArrow | NEW | Sizing offsets from `buffer.length` not `FieldNode.length+1` leaks 64-byte padding as bogus offsets (corrupts outer geometry/strokes). STT indexes `valueOffsets` directly | `tile.ts:131-167` | S | Low | 0.8 |
| U4 | Encode `start_time`/`end_time` as `Timestamp(Millisecond)` | Arrow | ADOPT | Encoder emits raw `Int64`; decoder/input already speak Timestamp (`input.rs:515/528`). Symmetric + self-describing, near-zero cost | `arrow_tile.rs:443/446` | S | Low | 0.8 |
| U5 | `padPositionsTo3D` → pass `size:2` binary positions | deck.gl | ADOPT | deck binary `getPosition` accepts `size:2`; the pad copy is a per-2D-tile allocation | `animated-point-layer.ts:504-512` | S | Low | 0.75 |
| U6 | `vertex_time` origin/step → per-column `ARROW:extension:metadata` | Arrow | REFINE | Move origin/step out of schema-level `stt:` keys so the column self-describes and survives projection; non-STT tools degrade gracefully | schema-level `stt:vertex_time_*` | S | Low | 0.7 |

### Tier 2 — Adopt upstream to delete code (medium, sequenced)

| ID | Title | Lib | Cat | What & why | Current state | Eff | Risk | Conf |
|---|---|---|---|---|---|---|---|---|
| U7 | deck.gl → 9.4: delete `NoPickingPathLayer` regex shim, re-enable picking | deck.gl | ADOPT | 9.4 drops `instancePickingColors` (picking via `gl_InstanceID`), freeing the exact slot STT regex-strips. For within-tile→global id remap, copy geoarrow's `computeChunkOffsets`/`invertedGeomOffsets` (`makeTileKey` already encodes `recordBatchIdx`). Best **after** U10 | `no-picking-path-layer.ts:47-48`, `pickable:false` | M | Med | 0.7 |
| U8 | Single multi-batch IPC stream / IPC File footer (stop re-emitting schema) | Arrow | REFINE | One stream of N batches (or the File format's block index) instead of a full Schema+EOS per layer per tile. Encoder-only | `arrow_tile.rs:556-589` | M | Low | 0.6 |
| U9 | Wire (or drop) the unconsumed `bucket_<i>` summary columns | deck.gl | REFINE | Rust emits `bucket_0..N` + metadata promising zero-re-upload uniform animation, but **no renderer reads them** → wasted wire/decode bytes. Either wire the uniform-swap consumer or stop emitting | built but unconsumed (`summary.rs:355-382`; no ref in `packages/deck.gl/src`) | M | Med | 0.6 |
| U10 | Global `stats` blob in metadata + CARTO `_count/_sum/_avg/_min/_max` naming | deck.gl / CARTO | REFINE | Server-supplied global min/max/percentiles per aggregate column gives `H3SummaryLayer` a stable `colorDomain`, fixing the documented "visually unstable" auto-fit and removing the double-`prepareTile` pass | auto-fit per visible-tileset (`h3-summary-layer.ts:583-601`) | M | Low | 0.7 |

### Tier 3 — Structural / measure-first (larger, lower-confidence)

| ID | Title | Lib | Cat | What & why | Current state | Eff | Risk | Conf |
|---|---|---|---|---|---|---|---|---|
| U11 | Per-tile local-origin **Float32** coordinates | Arrow/deck | REFINE | Rebase coords to a per-tile origin (mirrors existing **time** relativization `tile.ts:242-249`) + store f32: halves geometry bytes **and** frees ~4 PathLayer fp64 slots via project32. **Cross-references in-flight Track B** (`stt-core/src/geometry.rs:9-10`); the f32/slot-freeing angle is the new part. Gate by tile extent (globe) | f64 interleaved, no rebase (`arrow_tile.rs:235`) | L | Med | 0.65 |
| U12 | Cross-dataset categorical dictionary unification (keys-only tiles) | Arrow | REFINE | One dataset-wide dict; ship keys-only per-tile columns; store the value table in the archive dict slot. **Constraint:** the fzstd reader refuses zstd-dictionary archives (`archive.ts:523-536`) — keep the *Arrow* dict separate from any *zstd* training dict | per-tile dict, no unification | L | Med | 0.6 |
| U13 | REE/narrowing for `start/end` + the `id` column | Arrow | NEW | Temporally-clustered `start/end` are textbook REE; `id` is often monotonic — narrow to `UInt32` for raw tiers (TS already truncates to 32 bits `tile.ts:219-232`) or delta/REE-encode. **Verify `apache-arrow ^17` decodes REE first** | plain `Int64` start/end; `UInt64` id | M | Med | 0.55 |
| U14 | Add a Boolean property type stored as `arrow.bool8` (Int8) | Arrow | NEW | **No boolean path exists today** — `columnar.rs:329/335` captures only `as_f64()`/`as_str()`, so JSON booleans are *dropped*. Add a `Boolean` `PropertyColumn` variant; `arrow.bool8` uploads as a `Uint8Array` attribute | booleans dropped (`columnar.rs:326-338`) | S–M | Low | 0.55 |
| U15 | VAT luma cleanups: query `device.limits`, feature-gate `float32-filterable`, fp64 lo/hi in-texture | luma.gl | NEW | Replace the unconditional 2-tap lerp with one `texture()` where `float32-filterable` is reported; query `maxTextureDimension2D` (not the 8192 floor); port project64's lo/hi split into the texture to kill zoom ≥ 16 jitter; consider `rg16float` (½ VRAM) | manual lerp always; hardcoded 8192 (`vat-trips-layer.ts:61/310-316`); `world64Low=vec3(0)` (`:321-323`) | M | Med | 0.55 |

## 4. Deep dives (highest-leverage)

### U1 — CRS in `ARROW:extension:metadata`

GeoArrow type identity is `ARROW:extension:name`, but the spec's
`ARROW:extension:metadata` JSON carries `crs`/`crs_type`/`edges`. STT sets the
name but emits **no** metadata sibling, so every external consumer (GDAL,
GeoPandas, lonboard, QGIS) treats the geometry as unknown-CRS even though the
docs declare WGS84. Adding `{"crs":"EPSG:4326","crs_type":"authority_code"}`
(or the full WGS84 PROJJSON) on the geometry `Field` is a few bytes, no layout
change, and the single biggest interop-per-effort win available. Only judgment
call: if STT ever does great-circle interpolation for its antimeridian-split
lines, set `edges:"spherical"`; otherwise omit it (planar is the default).
Source: https://geoarrow.org/extension-types.html

### U2 — u16 dictionary overflow is a silent-corruption bug

`build_dictionary_indices` (`arrow_tile.rs`) caps categories at `u16::MAX` and,
on overflow, pushes `Some(u16::MAX - 1)` — i.e. it *reuses an arbitrary existing
category index* for every subsequent distinct string, silently mislabeling
features rather than failing. The comment frames this as "in practice columns top
out in the low hundreds," but a single adversarial/auto-generated dataset
(per-feature UUID-ish category) corrupts quietly. Fix: return `Err` (the build
already surfaces errors) or widen the key to `UInt32` for that column. Low effort,
real correctness payoff. This is also why U12 (global dictionary) should bound the
key width explicitly.

### U3 — Padded-offset-buffer audit (deck.gl-geoarrow #214)

On 2026-05-25, deck.gl-geoarrow #214 (fix #215) documented that Arrow IPC
producers pad buffers to 64-byte alignment, so an offset buffer's *physical*
typed-array length exceeds its *logical* length; sizing offset tables from
`buffer.length` instead of `FieldNode.length+1` leaks trailing zero-padding in as
bogus offsets — which corrupted the outermost geometry and rendered polygon
strokes black while fills (using `startIndices`) still worked. STT's reader
indexes straight into `valueOffsets`/`.offset`/child `.values` and subarrays them
(`tile.ts:131-167`), so any place it derives a count from `offsetBuffer.byteLength/4`
(rather than the Arrow `FieldNode` length) is exactly this bug class. Cheap,
targeted read; add a unit test that decodes a tile whose logical geometry count
makes the padded offset-buffer length differ, and assert the last feature's vertex
range. Source: https://github.com/geoarrow/deck.gl-geoarrow/issues/214

### U4 — `Timestamp(Millisecond)` on the encoder

The encoder emits `start_time`/`end_time` as raw `Int64` (`arrow_tile.rs:443/446`),
yet the **input** path already downcasts `TimestampMillisecondArray`
(`input.rs:515/528`) and the JS reader knows the columns are time. Emitting the
Arrow `Timestamp(Millisecond)` logical type closes that asymmetry: the column
becomes self-describing as time to *any* Arrow/GeoArrow tool (DuckDB, pandas,
lonboard) at near-zero cost and no wire-size change. It is arguably a cleaner,
lower-risk standards-alignment than U13's REE (whose `apache-arrow ^17` decode
support must be verified first). Source: https://arrow.apache.org/docs/format/Columnar.html

### U7 — deck.gl 9.4 picking, retiring `NoPickingPathLayer`

`NoPickingPathLayer` exists solely because PathLayer's attrs + TimeFilterExtension's
3 + CategoryColor's 1 overrun WebGL2's guaranteed 16, so STT regex-strips
`in vec3 instancePickingColors;` from the compiled VS (`no-picking-path-layer.ts:47-48`)
— an explicitly fragile shim that warns and self-disables if the regex misses.
deck.gl 9.4 removes the `instancePickingColors` vertex attribute entirely,
switching picking to the `gl_InstanceID`/`instance_index` built-in — the exact
upstream fix STT's own comments anticipate. Upgrading deletes the class and
re-enables pickable per-tile sublayers; for the within-tile→global-feature-id
remap, adopt geoarrow's `computeChunkOffsets`+`invertedGeomOffsets` blueprint
(`makeTileKey` already encodes the equivalent of `recordBatchIdx`). Sequence
**after** U11 (which independently frees slots) so the two compound. This is a
WebGL2 picking change — it does **not** violate the WebGPU non-goal. Gate behind
the showcase render tests. Source: https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md

### U10 — Global `stats` blob + CARTO aggregate-column naming

CARTO's spatial-index tilesets ship a global `stats` object so the client
normalizes color domains consistently across tiles; STT's `H3SummaryLayer`
instead auto-fits the domain over the currently-visible tile set and its own code
flags this as "visually unstable when tiles stream in" (`h3-summary-layer.ts:583-584`),
forcing every showcase summary dataset to pin `colorDomain` manually. Emitting
per-aggregate-column global min/max (and ideally percentiles) into
`ArchiveMetadata` during the Rust build lets the layer pin a stable domain without
the caller guessing; adopting CARTO's `_count/_sum/_average/_min/_max` suffix
convention (vs STT's ad-hoc names) makes the summary schema self-describing. This
also removes the double-`prepareTile` pass (`h3-summary-layer.ts:588-601`) that
exists only to compute the fallback domain. Source: https://carto.com/blog/carto-tile-generation-cloud-native/

### U11 — Per-tile local-origin Float32 coordinates (cross-ref Track B)

WebGL2 has no 64-bit attributes, so STT's `FixedSizeList<Float64,2>` positions
are either truncated to f32 or fp64-doubled on upload. deck.gl deprecated fp64
projection in v6.3 because project32's camera-relative origin is precision-
equivalent at ~half the attribute count. STT already relativizes **time** to a
per-tile offset for f32 safety (`tile.ts:242-249`); applying the identical trick
to coordinates halves geometry bytes and frees ~4 of PathLayer's 8 fp64 position
slots (`animated-trips-layer.ts:515-518`) — the root cause of the 16-attribute
ceiling behind `NoPickingPathLayer`. **Important caveats:** (a) this is *adjacent
to in-flight work* — `stt-core/src/geometry.rs:9-10` records that format-v3
"Track B" is already "rebuilding quantized coordinate encoding on top of
fixed-precision Arrow columns," so U11 should be folded into Track B, not run as a
parallel effort; (b) the slot-saving only materializes if the layer actually uses
project32 (no `fp64:true` is set today, so it is plausible — verify); (c) at
globe-spanning extents a single tile origin won't suffice (gate by tile geographic
extent). Source: https://deck.gl/docs/developer-guide/fp64

## 5. Explicitly not worth doing

- **Byte-budget tile eviction** — *already shipped.* `SpatiotemporalTileset` has
  `maxCacheByteSize` (default 2 GB, `:262`), `currentCacheBytes` (`:218`),
  per-tile `byteSize` via `estimateTileSize` (`:876/952`), and dual
  count+byte eviction (`:1021-1062`). Not a todo. (At most: verify
  `estimateTileSize` accuracy for decoded Arrow tiles — a measurement note.)
- **WebGPU / WGSL rewrite of any layer (now)** — NON-GOAL, confirmed by research:
  deck.gl 9.3 WebGPU has only Line/PointCloud/Scatterplot in preview, and every
  STT custom layer + extension is GLSL-injection-based, which the deck.gl WebGPU
  docs say does not port. Re-evaluate Q4 2026. Continue WebGL2 + binary attributes.
- **Mode-aware `TimeFilterExtension` attribute registration** — NON-GOAL; already
  tried, broke deck 9.3's accessor fallback and tanked FPS, reverted
  (`time-filter-extension.ts:226-250`). The wasted slot is fixed by U7/U11, not by
  re-litigating this.
- **Cross-tile draw-call consolidation** — NON-GOAL; abandoned after the 3.6 GB
  disaster; the baseline is GPU-bound, not submission-bound. The per-tile-sublayer
  model is correct and matches @geoarrow/deck.gl-layers exactly.
- **Arrow IPC body-buffer compression (LZ4/ZSTD)** — outer whole-blob zstd already
  supersedes it for small tiles; adding it is double work over the same bytes
  (`compression.rs:52`).
- **Separated `Struct` coordinates** — the GeoArrow "recommendation" is for
  analytics/columnar compression, **not** rendering. lonboard/@geoarrow
  deliberately use interleaved because deck expects it and separated forces a
  re-interleave copy before every GPU upload. Keep interleaved (`arrow_tile.rs:236`).
- **Wholesale `Tileset2D` / `DataFilterExtension` replacement** — the 4D `(z,x,y,t)`
  axis and the trail/wake/cumulative time modes have no upstream analog. Adopt only
  the leaf wins (the `visibleMin/MaxZoom` framing; maybe `countItems` for a HUD).
- **`geoarrow.box` framed as the "biggest at-scale gap"** — *downgraded.* The reader
  already culls tiles to the viewport at `(z,x,y)` (`archive.ts:789` + bounds
  `:358-363`); the GeoParquet ~191× figure is flat-file row-group skipping, not a
  tiled pyramid. A per-tile box helps only *sparse/underfilled* tiles — keep it as a
  low-priority refinement, not a headline.
- **Importing the declared-but-dead `geoarrow-rs` crate now** — dead weight today;
  the hand-rolled construction is correct. Reach for it only if/when the
  GeoParquet-2.0 WKB ingest path needs its WKB→native converter.

## 6. Open questions / things to measure

1. **U3 first, regardless of priority:** does the padded-offset bug exist? Construct
   a tile whose logical geometry count makes the padded offset-buffer length differ,
   decode, assert the last feature. Cheap and decisive.
2. **U7/U13 Arrow-version floor:** confirm deck.gl 9.4's peer requirements and
   whether pinned `apache-arrow ^17` decodes REE arrays before committing U13; a JS
   Arrow bump may be a prerequisite (newer Arrow also improves ESM/StringView).
3. **U11 payoff vs effort:** measure actual geometry-byte savings and the
   attribute-slot count after f32 rebasing; confirm no visible jitter at the deepest
   showcase zooms; decide the tile-extent threshold above which one local origin is
   insufficient — and **coordinate with Track B** so the work isn't double-counted.
4. **U12 browser constraint:** decide whether keys-only tiles + a *global Arrow
   dictionary in the archive* can ship **without** a zstd training dictionary (so the
   fzstd reader can still decode — `archive.ts:523-536`), or whether it waits on a
   wasm-zstd dictionary path.
5. **U10 percentiles:** exact (second pass in `summary.rs`) vs a sketch; and whether
   global min/max alone stabilizes the domain enough to remove the double-`prepareTile`.
6. **U15 device distribution:** telemeter what fraction of real showcase clients
   report `float32-filterable`; the hardware-lerp win only lands where present, and
   `rg16float` jitter must be measured at zoom ≥ 16 before adopting half-float.
7. **U9 sub-bucket consumer:** confirm the wire/decode overhead of the unconsumed
   `bucket_<i>` columns is non-trivial enough to justify wiring the consumer rather
   than dropping the columns until one exists.

---

### Appendix — corrections folded in from the grounding critique

The first synthesis pass was adversarially verified against the code; these were
corrected here so the roadmap is trustworthy:

- **Struck "byte-budget eviction" as a recommendation** — it is already fully
  implemented (`spatiotemporal-tileset.ts` `maxCacheByteSize`/`currentCacheBytes`/
  `byteSize`/dual eviction). Moved to §5 as a non-todo.
- **Downgraded `geoarrow.box`** from "biggest at-scale gap / ~191×" to a
  low-priority refinement — the reader already culls by `(z,x,y)` against archive
  bounds (`archive.ts:789`, `:358-363`).
- **Rescoped the boolean item (U14)** — there is no boolean→`Float64` path;
  `columnar.rs:329/335` capture only `as_f64()`/`as_str()`, so booleans are
  *dropped*. The item is now "add a Boolean property type," not "shrink an existing
  one."
- **Cross-referenced U11 to Track B** (`stt-core/src/geometry.rs:9-10`) so the
  coordinate-rebasing isn't presented as greenfield; only the f32/project32
  slot-freeing angle is new.
- **Fixed citations:** start/end Timestamp input handling is `input.rs:515/528`
  (`:257` is the vertex-time child); the geometry-helpers/Track-B file is
  `crates/stt-core/src/geometry.rs` (there is no `stt-build/src/geometry.rs`); the
  fzstd dictionary refusal is `archive.ts:523-536`.
- **Added three omitted opportunities:** `Timestamp(Millisecond)` on the encoder
  (U4), single multi-batch IPC stream / File footer (U8), and `id`-column
  narrowing/REE (folded into U13).
