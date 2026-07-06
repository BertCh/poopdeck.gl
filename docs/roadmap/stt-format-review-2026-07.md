# STT Format Deep Review — 2026-07

> Comprehensive review of the STT format itself — the packed container, the v5
> directory codec, the Arrow/GeoArrow tile payload, the time model, and the two
> reference implementations' relationship to the spec — with a ranked findings
> list and a phased improvement plan. Method: full read of
> `crates/stt-core/src/{arrow_tile,pack,directory,directory_page,metadata,curve,budget,compression,projection,tile,timestamp}.rs`,
> `crates/stt-build/src/{tiler,columnar,clip,simplify,summary,input,build_options}.rs`,
> `packages/core/src/*`, all of `docs/spec/` + `docs/architecture/`, the
> format-relevant roadmap docs, plus byte-level probe measurements (arrow 59)
> and fleet stats from the 22 published demo datasets.

## 0. Verdict

The format's core ideas are sound and several are genuinely novel — no shipping
open format has them. The architecture does not need to change. What separates
STT-as-implemented from STT-as-a-credible-open-standard is a layer of
correctness hardening (silent-clamp/overflow paths, integrity checks that exist
on paper but not on the hot path), one large measured wire inefficiency
(per-tile Arrow IPC schema repetition), one semantic hole in the tiler
(non-trajectory geometry is never clipped), and a spec that a third party
cannot yet implement a writer from. All are fixable without abandoning any
locked-in design decision; most byte-breaking fixes can be batched into a
single coordinated version bump so content addresses churn once.

**The five contributions worth defending** (independently assessed, not just
self-claimed):

1. **The temporal directory** — `(z,x,y,t)`-keyed delta+zigzag varint columns
   with blob-run RLE that collapses *time-identical* content (the temporal
   analogue of PMTiles collapsing ocean tiles), plus the `cover_t_min`
   backward-coverage bound and per-leaf `[t_min,t_max]` page pruning. This is
   the format's central contribution and it is competitive with PMTiles v3 on
   its own terms while adding an axis PMTiles doesn't have.
2. **Byte-reproducible content-addressed builds as a spec concern** — total
   sort tiebreaks + canonical (sorted) Arrow metadata on arrow ≥59 → identical
   rebuilds re-derive identical pack names cross-process. No comparable format
   attempts this; it is what makes the immutable-CDN economics real.
3. **World-anchored quantization** — trading a few % of compression for
   cross-tile content-address dedup (measured: per-tile grids cost +61%).
   A coherent, original answer to MVT/MLT tile-local grids.
4. **First-class trajectory payload primitives** — `vertex_time` u16-delta with
   bounded precision ceiling and exact-Int64 fallback, and the
   `vertex_value_matrix` space-time-cube column. Absent from MVT/MLT/GeoParquet.
5. **Zero-copy GPU discipline** — the 8-byte-aligned layer frame +
   FixedSizeList interleaved leaves means the browser hands IPC buffers to the
   GPU without a copy. None of the comparison formats prioritize this.

The review is organized as: measured baseline (§1), findings ranked in five
tiers (§2–§6), prior-art scorecard (§7), improvement plan (§8).

---

## 1. Measured baseline

Byte-level probe (this crate, arrow 59, zstd-3, single point layer):

| Config | raw payload | zstd | note |
|---|---|---|---|
| 0 features, no props | 1,048 B | **429 B** | pure fixed tax: frame (16 B) + IPC schema/messages |
| 0 features, +2 props | 1,560 B | 547 B | +512 B raw per 2 fields |
| 1 feature ≡ 2 features | 1,688 B | ~570 B | arrow-rs pads each buffer to 64 B |
| 1,000 features | 41,880 B | 6,592 B | marginal ≈ 40.8 B/feat raw → 6.2 B/feat zstd |
| 1,000 features, quantized | 33,944 B | 3,720 B | → 3.3 B/feat zstd |

Fleet reality check (published demos, confirmed by `stt-optimize inspect` on
`earthquakes-v2`): 102,225 tiles / 522,982 feature-rows / 117 MB compressed →
**average compressed blob ≈ 1.1 KB, of which ~430 B is schema/framing tax ≈
37 % of all pack bytes** on this dataset (the review's 30–45 % band, measured).
Same inspection: per-zoom feature duplication is total (~47.5 K source quakes
× 11 zooms = 523 K stored rows), blob dedup only reaches 0.815 on sparse
events, and near-unique dictionary strings (`title`, `place`) are the top two
per-column costs (28 % of standalone column bytes) — a `stt-optimize doctor`
concern, not a format one. Directory objects run 0.2–8 MB at rest across the
fleet (paging keeps cold-start cost viewport-proportional; the at-rest size
itself is fine).

Fixed structural costs elsewhere are healthy: directory ≈ 8–20 B/entry
pre-zstd (~2× under zstd), paged root 12 B + 52 B/page, pack framing 0 B,
manifest ~60–100 B per pack entry.

---

## 2. Tier 1 — correctness and integrity (fix regardless of anything else)

Ranked; each with evidence and the shape of the fix.

**T1.1 — Non-trajectory geometry is never clipped: whole-feature single-tile
placement.** Only `LineString`s *with a duration* go through the clipper
(`clip.rs:917-928`); points, timeless lines, MultiLineStrings (even with
duration), polygons and multipolygons are placed whole into the one tile
containing a representative point (`tiler.rs:695-700`), which for a
MultiPolygon can lie outside the geometry (`input.rs:1251-1263`). A wildfire
perimeter or storm isoband spanning several z10 tiles exists in exactly one of
them — neighbours render a hole. This is the single largest semantic gap in
the format's delivery promise and it silently caps usable `max_zoom` for area
features. *Fix:* polygon/multi-geometry clipping (or minimum: multi-tile
*reference* placement — same blob listed under every covered tile, which the
dedup+RLE machinery already makes nearly free), plus MultiLineString
admission to the existing clipper.

**T1.2 — Projection failures file features into tile (0,0).**
`lonlat_to_tile` errors (lon∉[−180,180], |lat|>85.05, NaN) are swallowed by
`unwrap_or((0, 0))` at six call sites (`tiler.rs:459,471,685-687,697-698,
1148-1149,1180-1181`) — garbage rows become phantom features in the top-left
world tile at every zoom. *Fix:* drop + count + report (the summary path
already guards non-finite coords; the raw tier should too).

**T1.3 — Silent numeric clamps/overflows in the encoder.**
- `offsets_from_counts` does unchecked `acc += c as i32`
  (`arrow_tile.rs:315-323`): >2³¹ total vertices in one layer wraps silently in
  release → corrupt offsets. No cap enforces safety (budget is optional).
- Coordinate quantization clamps indices to i32 silently
  (`arrow_tile.rs:396-409`): precision finer than ~19 mm overflows near ±180°
  and snaps points to wrong locations; `set_quantize_coords_m` accepts down to
  1 µm with no guard (`:643-650`).
- Int32 attribute-quant path clamps silently (`arrow_tile.rs:1010`) where the
  dictionary path correctly errors (`:1042-1054`).
*Fix:* checked adds and validated precision floors; error loudly, never clamp.

**T1.4 — Integrity checks exist on paper, not on the hot path.** The TS reader
decodes `crc32c` and discards it (`packages/core/src/directory.ts:317`);
nothing checksums *uncompressed* bytes anywhere (CRC covers compressed only;
zstd's own content checksum is not enabled — `compression.rs:36-38`); a
decompressor bug or middlebox corruption that preserves lengths passes
silently. `PackedReader::open` never checks `formatVersion`
(`pack.rs:808-822`). *Fix:* verify CRC in the decode worker (off main thread,
cost is trivial vs fzstd), enable zstd content checksums at write, check
`formatVersion` on open.

**T1.5 — `time_end` tightness is load-bearing but never normatively defined.**
Interval features live only in their start bucket; they are findable later
*only because* the writer widens `time_end` to the max feature end
(`tiler.rs:724-728`). No spec sentence requires this. A third-party writer
emitting nominal bucket ends would pass `stt-validate` and silently break
every interval query. *Fix:* one MUST in `time-model.md` + a validator check.

**T1.6 — Required-to-understand payload features can silently misdecode.**
`stt:quant` / `stt:qa` re-type *existing* columns; a reader that doesn't check
the keys reads i32 grid indices as microscopic lon/lat degrees
(`data-format.md` compat section admits this). There is no manifest-level
capability declaration, so an old reader fails *silently*, mid-session, per
tile. *Fix:* additive `manifest.capabilities: ["coord-quant", "attr-quant",
"elevation-fold", …]` array + reader MUST refuse datasets listing unknown
capabilities. Cheap, additive, converts the format's worst failure mode
(silent garbage) into its best (loud refusal at open).

**T1.7 — Feature-id determinism rests on `DefaultHasher`.**
Synthetic ids for string-id features and clipped segments come from
`std::collections::hash_map::DefaultHasher` (`columnar.rs:757-816`) — stable
within a toolchain, explicitly unspecified across Rust releases. A rustc
upgrade can change every tile byte and every content address, silently
breaking the incremental-deploy economics (D6). Point layers were already
insulated (row-index rewrite, the measured "~40% of compressed point bytes"
fix); segments still carry high-entropy hash ids. *Fix:* explicit stable hash
(xxh3/blake3-short) + per-source sequential ids assigned at load for
segments.

**T1.8 — Two smaller determinism/pruning leaks.** `Metadata.properties` is a
`HashMap` → `manifest.json` key order is process-random when custom properties
are set (`metadata.rs:246`); paged-directory bbox descriptors use naive
min/max lon so an antimeridian-straddling leaf gets a world-spanning bbox and
loses all page pruning (`directory_page.rs:352-365` — correct, just slow;
descriptor-kind byte is reserved for a wrap-aware variant). Also stale:
`pack.rs:1139-1143` test comment still describes the pre-arrow-59
nondeterminism as open; shipped demo manifests still carry `tile_count: 0`
(the finalize-derivation fix at `pack.rs:489-497` postdates them — republish).

---

## 3. Tier 2 — wire efficiency

**T2.1 — Per-tile Arrow IPC schema repetition is the format's biggest fixed
tax.** Every tile × every layer serializes the full flatbuffers schema + field
metadata: **429 B compressed for an *empty* layer** (§1). Per-blob zstd cannot
amortize it across tiles because the shared dictionary was deliberately
dropped for fzstd compatibility. On sparse-bucket datasets (earthquakes: ~1 KB
avg blob) this is ~40 % of pack bytes; on 1 M-small-tile datasets it is
0.4–0.7 GB. PMTiles/MVT fixed overhead is single-digit bytes; Parquet/FGB
write the schema once per file.
*Fix (preferred): schema-template mode.* The manifest (or a content-addressed
sidecar) carries each layer's full IPC prefix once (schema message + metadata);
a tile blob stores only the record-batch message; the reader concatenates
template+batch before `tableFromIPC`. Zero-copy is preserved, apache-arrow
still does all parsing, tiny tiles drop to tens of bytes of framing.
Self-contained mode remains for interchange; a manifest field discriminates.
This is byte-breaking → batch into the v2 coordinated break (§8, Phase C).
*Alternative considered and not preferred:* shared zstd dictionary (requires
replacing fzstd with a WASM zstd — heavier client, and the repo's own MLT
study argues against codec exotica).

**T2.2 — Respect the existing negative result, but re-measure two columns.**
The repo's MLT study measured lightweight encodings (delta-bitpack, shuffle)
as NO-GO under zstd-at-rest — this review does *not* recommend relitigating
that. Two narrow exceptions worth one `stt-optimize sample-encode` pass each:
(a) `start_time`/`end_time` as Int32 relative to `stt:time_offset_ms` (the
offset already ships; the columns are never narrowed — 16 B/feature raw
today); (b) plain-`UInt64 id` when sequential (delta or width-narrowing).
Both are additive re-typings à la `stt:qa`, gated by the same
capability-declaration mechanism as T1.6.
**[RESOLVED 2026-07-05, Stage III measurement — both SKIPPED.** Measured
across a 4-dataset corpus (packed-v2 design §5.1): (a) rel-Int32 times
median ≈ +0.2 % of blob bytes and NEGATIVE on dense tiles (taxi +46 %,
ais +34 % larger re-encoded), with 94 % Int32-overflow of relative
`end_time` on long-lived ecco tracks; (b) u32 ids median ≈ +0.2 %, often
larger than u64 under zstd. The MLT-study negative stands.]

**T2.3 — Client memory doubles for nothing.** Every decoded layer retains raw
`arrowIpc` bytes forever for lazy GeoArrow rehydration (`tile.ts:663-669`) —
pure overhead for consumers that never call `toGeoArrowTable`;
`estimateTileSize` then double-counts aliased buffers (`archive.ts:424-446`),
overstating tiles ~2× and evicting early; quantized coords are dequantized
i32→f64 on the worker, quadrupling position bytes. *Fix:* opt-out for
`arrowIpc` retention, alias-deduped size accounting, and (v2-break era)
f32 tile-local coords + per-tile origin as a decode target — the same
origin/step scheme `vertex_time` already uses.

---

## 4. Tier 3 — access patterns and read amplification

**T4.1 — Whole-blob decode is the only granularity.** One zstd frame over the
whole multi-layer payload; one RecordBatch per layer; rows not time-sorted. A
narrow window inside a wide bucket decodes and uploads every feature in the
bucket; a one-property style read parses every column
(`tableToBinaryFeatures` materializes *all* properties, `tile.ts:495-608`).
MLT's measured killer app — 3.7–4.4× property-only scans — has no STT
equivalent. *Fix, two independent steps:*
- *Sectioned payload (v2 break):* compress geometry+time core and properties
  as separate zstd sections behind a tiny TOC in the layer frame → lazy
  property decode, still one HTTP fetch.
- *Time-sorted rows + sub-bucket row ranges (additive):* writer sorts rows by
  `start_time` and records per-sub-bucket row offsets in schema metadata →
  worker decodes only overlapping row ranges on scrub. The summary tier's
  `sub_buckets` and `vertex_value_matrix` are both point-solutions to exactly
  this gap; this generalizes them.

**T4.2 — The temporal-LOD pyramid neither aggregates nor gets used.**
Build side: coarse tiers re-bucket raw features with *no* feature-level
reduction (`tiler.rs:288-290`) — a 30-day tile is the union of 720 hourly
tiles, strictly larger; it trades request count for bytes only. Client side:
the tileset never requests any tier (`archive.ts:2081-2092` filters to base;
`pickTemporalLodForZoom` exists unused). And the spec never says what a coarse
tile MUST contain, so two writers could emit incompatible "1d" tiers. *Fix:*
(a) spec the aggregation contract (start with "identical features,
re-bucketed" as the only conformant level-0 semantics, leaving reduced tiers
as a declared variant); (b) wire the reader per the existing scrub-LOD plan;
(c) only then invest in actual reduction recipes (preprocessing framework).

**T4.3 — Long-lived features amplify reads structurally.** A tile containing
one near-immortal feature has `time_end ≈ ∞`, so it matches every query
window forever. `cover_t_min` solves the *lower* bound tightly; nothing bounds
the damage from mixed-duration cells. *Fix (research item):* duration
stratification — features whose extent exceeds K buckets go to a "long-lived"
stratum addressed like a temporal-LOD tier (the directory's
`temporal_bucket_ms` tagging already expresses this), so the animated
short-interval stream stops re-matching static furniture. Needs a
measured prototype before spec.

**T4.4 — No attribute statistics anywhere.** Space/zoom/time are the only
prunes; `style_hints` percentiles are dataset-level. Per-*leaf-page* column
min/max (a second descriptor kind in the paged root — the descriptor-kind
byte is reserved precisely for this) would give predicate pushdown for the
"magnitude > 5" class of query without touching tile bytes.

---

## 5. Tier 4 — scale ceilings (build and container)

**T5.1 — The build is O(dataset) resident in four ways.** Full
`Vec<ParsedFeature>` (~200 B/feature), per-zoom placement vec, all tiles for
all zooms on the default path, and `PackWriter.pending` holding **every
uncompressed payload until finalize** (`pack.rs:286-297`). The one true
streaming pipeline (`build_streaming_from_batches`, spill-to-disk, per-bucket
flush) is dead code with no caller (`tiler.rs:1083-1096`). The tile-encode
write loop is single-threaded. Practical ceiling ≈ 10⁷ comfortable / low-10⁸
heroic; 1 B features is out of reach. *Fix:* resurrect the streaming
pipeline as the engine of a spill-to-disk PackWriter (external sort by
`(z, curve, bucket)`), parallelize the encode loop, and delete the dead path
either way — two pipelines with subtly different semantics is debt.

**T5.2 — Container ceilings are fine but undocumented.** u32 caps blob size
(4 GiB) and `feature_count`; the paged directory is single-level (flat page
table — fine to ~5–10 M entries, then the root itself needs paging); the
manifest `packs[]` array is O(packs) JSON on the mutable critical path (fine
at 79 packs; a 10 TB dataset → 160 K entries → ~15 MB mutable manifest).
*Fix:* document the ceilings normatively now; reserve `packs` indirection
(content-addressed `packs.json`) and a multi-level root for a future additive
change.

**T5.3 — No append story, and the blocker is the manifest contract.**
Positional `pack_id`, no generation field, dense-array assumption — appending
a day of data means re-finalizing the dataset (content addressing makes the
re-upload cheap; the build cost is T5.1's problem). If incremental ingest ever
matters, the fix lives in the manifest envelope (generation counter +
pack-set diffing), not the codec.

---

## 6. Tier 5 — spec completeness and adoption readiness

The spec set is far above internal-project norm (CI-pinned JSON Schema,
golden fixtures, honest negative results). Measured against "a stranger ships
a compatible implementation":

**T6.1 — A third-party writer is impossible today: the Hilbert curve is
normative but never defined.** Directory order, the wire `Δhilbert` column,
and paged-validation monotonicity all depend on it; the actual definition is
`hilbert_2d::xy2h_discrete(x, y, order=z, Variant::Hilbert)` + a `z==0→0`
special case, living only in `tile.rs:46-59` behind a third-party crate's
enum. *Fix:* write the curve into the spec with test vectors. This is the
single biggest completeness hole.

**T6.2 — The payload spec abdicates.** It lives in `docs/architecture/`, not
`docs/spec/`, and says "if this document and the code disagree, the code
wins" — which inverts what a specification is and undermines any stability
promise. *Fix:* move it, invert the clause (spec wins; code bugs get errata),
and pin the Arrow IPC envelope (IPC version, no body compression, dictionary
batch rules).

**T6.3 — Underspecified corners with realized consequences.** The summary
tier has no spec home — and three shipped summary archives with wrong `id`
columns rendered blank *and passed `stt-validate`* (the id-repair incident).
The folded `metadata` is schema-opaque yet load-bearing
(`temporal_bucket_ms`, `temporal_lod`, `time_range`) — the TileJSON/MBTiles
mistake repeated. Directory trailing sections have no length prefix and no
registry: unknown sections can't be skipped, so the extension mechanism works
exactly once (already spent on `cover_t_min`); a second section effectively
forces v6. `conformance.md` claims a "fuzzed v5 codec" — no fuzz target exists
in the workspace. *Fixes:* summary-tier normative section + validator check
(cell-id validity per scheme/resolution), metadata sub-schema, length-prefixed
tagged sections in the v6 directory plan, actual cargo-fuzz targets (directory,
layer frame, paged root) to make the claim true.

**T6.4 — Adoption table stakes.** No magic bytes anywhere in the live format
(`.sttp` = headerless concatenated zstd frames; the retired container *had*
magic and the live one lost it) — `file(1)` and forensics are blind; media
types unregistered (`application/x-stt-tile` uses the deprecated `x-`
prefix); no spec license statement (MIT covers code, not spec docs; CC-BY/OWFa
is the norm); no governance/changelog/stability promise; no security
considerations section (decompression bounds, hostile-manifest validation,
entry-count limits); no standalone test vectors outside the monorepo; and no
single-file interchange profile — retiring the single-file container
surrendered PMTiles' killer usability feature ("download one file"). A trivial
optional bundle profile (manifest + directory + packs concatenated behind an
offset header) restores interchange without touching the CDN story.
`@poopdeck.gl` / `poopdeck.gl` naming is a real institutional-adoption
liability for spec artifacts specifically; the `spatiotemporal-tiles` crate
name is fine.

**T6.5 — Validator vs. claim gap.** `conformance.md` says a passing dataset
satisfies the spec's invariants; the validator does not check `stt:quant`
presence on Int32-leaf geometry, vertex-time metadata sanity, CRS84 writer
MUSTs, summary cell ids, `end_time ≥ start_time`, or `time_end` tightness.
Close the gap in whichever direction each item deserves — mostly by adding
the checks.

---

## 7. Prior-art scorecard

| vs | STT wins | STT loses | Steal |
|---|---|---|---|
| **PMTiles v3** | temporal axis; >512 MB CDN cacheability; reproducible builds; run-RLE across *time* | single-file interchange; spec governance/media type; brand neutrality | spec-in-own-repo; bundle profile |
| **MLT/MVT** | columnar GPU-zero-copy; time; GeoArrow interop | per-tile fixed overhead (429 B vs single-digit); no column projection; no lightweight int encodings (measured trade, mostly justified) | lazy property scan economics; feature-scoped encodings only where re-measured |
| **COPC** | time axis (COPC core has none); CDN-native objects | graceful degradation (any LAZ reader reads COPC; quantized STT breaks vanilla GeoArrow readers); extension registry | registry w/ owner prefixes; "N reads to first frame" as normative budget; strided in-blob sampling |
| **Parquet/GeoParquet** | tile-granular random access; GPU-readiness; time-addressed delivery | column stats/predicate pushdown; column projection; schema-once amortization | per-page column stats (paged-root descriptor kind 1); logical time types |
| **Zarr v3** | vector payloads; directory compactness | `must_understand` extension flags; codec/container separation | `capabilities` array (T1.6) is exactly Zarr's `must_understand` |
| **Hex Tiles** | open, exact geometry, published spec | marketing/platform integration | nothing technical |

Positioning risk stated plainly: the defensible moat is the temporal
directory + reproducible builds + trajectory primitives *plus the renderer
stack*. The container alone is squeezable by a future MLT temporal extension
or GeoZarr from either side; the spec-hardening tier (T6) is what converts
"nice internal format" into "the open standard for temporally-tiled vector
data" before someone else names that category.

---

## 8. Improvement plan

Phased to respect the repo's rules: no thinning, measured decisions
(`stt-optimize` before/after every encode change), kill-switched rollouts, and
**all byte-breaking changes batched into one coordinated break** so the
content-address churn (and edge-cache invalidation) is paid once.

### Phase A — Integrity & loud failure (days; no byte changes except A6)
- A1. Checked offset accumulation; quantization precision floor (error below
  ~2 cm world-grid precision); attr-quant Int32 overflow → error (T1.3).
- A2. Projection-failure drop+count, all six call sites (T1.2).
- A3. `formatVersion` check in `PackedReader::open`; CRC32C verification in
  the TS decode worker; zstd content checksum on write (T1.4).
- A4. Validator additions: `time_end` tightness, `end_time ≥ start_time`,
  summary cell-id validity, `stt:quant` gate, vertex-time metadata sanity,
  CRS84 (T1.5, T6.5). Kill the "fuzzed" claim or make it true — add
  cargo-fuzz targets for directory v5, paged root, layer frame (T6.3).
- A5. `Metadata.properties` → `BTreeMap`; stale determinism comment at
  `pack.rs:1139`; republish demo manifests (tile_count=0) (T1.8).
- A6. `DefaultHasher` → stable hash + sequential segment ids (T1.7). Byte-
  breaking for affected datasets → land the code now behind the Phase C flag.

### Phase B — Spec hardening & independent implementability (1–2 weeks of writing; no code risk)
- B1. Hilbert curve normative definition + test vectors (T6.1).
- B2. Payload spec into `docs/spec/`, "code wins" inverted, Arrow IPC envelope
  pinned (T6.2).
- B3. `time_end` MUST; temporal-LOD content contract; summary-tier normative
  section; metadata sub-schema; bucket>0, interval, zoom-bound invariants
  (T1.5, T4.2a, T6.3).
- B4. `manifest.capabilities` must-understand array (additive; readers that
  see unknown capability names refuse loudly) (T1.6).
- B5. Adoption kit: spec license (CC-BY) + changelog + stability statement;
  `vnd.` media types; security considerations; standalone test-vector
  fixtures; publish schema at its `$id` (T6.4).
- B6. Document container ceilings (u32 caps, single-level root, packs-array
  scale) and reserve the additive escape hatches (T5.2).

### Phase C — The one coordinated byte break: "packed v2 / directory v6 / frame v2" (design → measure → ship)
Batch every wire change; each item individually kill-switched and measured
with `stt-optimize diff` on the demo fleet before freeze:
- C1. **Schema-template payloads** — layer IPC prefix hoisted to manifest;
  blob = record-batch message only; self-contained mode retained (T2.1).
  Projected win: 30–45 % of pack bytes on sparse-bucket datasets.
- C2. **Sectioned layer frame** — core vs properties sections behind a TOC →
  lazy property decode (T4.1). Length-prefixed, registered section tags fix
  the jammed extension mechanism at the same time (T6.3).
- C3. **Time-sorted rows + sub-bucket row ranges** in schema metadata →
  partial decode for scrub (T4.1; additive but rides the same break so sort
  order changes bytes once).
- C4. **Magic bytes** for `.sttp`/`.sttd` (8-byte header) (T6.4).
- C5. Measured re-typings where `sample-encode` says yes: relative Int32
  feature times, narrowed ids (T2.2). Antimeridian-aware bbox descriptor
  kind 1 with per-leaf column stats (T1.8, T4.4).
  *(2026-07-05: measurement said NO — both re-typings SKIPPED, see T2.2
  resolution + packed-v2 design §5.1; row-sort default confirmed.)*
- C6. Optional **single-file bundle profile** (offset-header concatenation of
  manifest+directory+packs) for interchange (T6.4).

### Phase D — Reader/loader (parallel to C; no format changes)
- D1. Wire the temporal-LOD tier per the existing scrub-LOD plan; spec first
  per B3 (T4.2).
- D2. Client memory: `arrowIpc` retention opt-out; alias-deduped
  `estimateTileSize`; OPFS decompressed-bytes plumbing from the worker;
  render-spec-driven column materialization (T2.3, T4.1-lite — lazy prop
  *materialization* needs no format change even before C2 gives lazy prop
  *decode*).
- D3. Decode-path dedup (concurrent same-tile decodes), shared decode pools
  across archives.

### Phase E — Scale (when a dataset demands it)
- E1. Streaming build: external sort + spill-to-disk PackWriter, parallel
  encode loop; delete the dead pipeline; target = 1 B points on a workstation
  with a benchmark in CI (T5.1).
- E2. Long-lived-feature stratification prototype + measurement (T4.3).
- E3. Manifest generation/append semantics; multi-level root; packs-table
  indirection — only when E1's datasets exist (T5.2, T5.3).

### Implementation status (2026-07-05)

Phases **A and B are implemented**, plus T1.1 (non-trajectory
coverage-clipping, kill-switched via `--whole-feature-placement` on both
`stt-build` and `stt-serve`) and the D2 client items — landed via a
five-workstream parallel implementation followed by an 8-angle / 11-verifier
review pass whose 10 confirmed findings were all fixed (highlights: the
byte-cache poisoning path around the new CRC verification, unbuffered
polygon clipping for watertight fill seams, the 56×-amplification allocation
guard, per-part/per-ring bbox gates + a target-tile restriction for the
stt-serve polygon path, semantic `retainArrowIpc: 'auto'`, the
`x-stt-capability-registry` cross-language pin). Verified end-to-end:
full Rust + TS suites green, byte-reproducible double-build, capabilities
emitted, `stt-validate` OK. Deferred with rationale recorded in code
comments / this doc: interior-tile fast path and quadtree subdivision for
polygon coverage (byte-breaking, ride Phase C), cross-zoom clip pyramid,
`geo::BooleanOps` swap (revisit at geo ≥0.30), quadbin→stt-core move,
temporal-LOD wiring (D1, has its own scrub-LOD plan), and all of Phase C/E.

### Sequencing rationale
A is pure risk-removal and unblocks trust in everything after. B costs no
code risk and is what makes external adoption *possible* — it can ship while
C is being measured. C is one break, heavily measured, converting the two
biggest structural costs (schema tax, all-or-nothing decode) plus all
adoption table-stakes byte changes in a single content-address churn. D
extracts already-paid-for value (the LOD pyramid, memory halving) with zero
wire risk. E waits for a forcing dataset.
