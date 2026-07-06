# STT Packed v2 — the coordinated byte break (design)

> Status: **FROZEN 2026-07-05** after the stage-1 gate: the template-splice
> spike PASSED all five questions (evidence: `scratchpad/v2spike`, summarized
> §3.1) and both design critiques' blockers/amendments are resolved below
> (changes vs the draft are marked ★). Executes Phase C of
> [`stt-format-review-2026-07.md`](./stt-format-review-2026-07.md) §8: every
> wire-breaking change batched into ONE version bump so content addresses
> churn once.

## 0. Goals and non-goals

Goals, in value order:
1. **Kill the per-tile schema tax** (~430 B zstd/tile ≈ 30–45 % of pack bytes
   on sparse-bucket datasets; spike-measured saving 400–414 B/tile →
   ≈ 40 MB ≈ 34 % on earthquakes-v2): hoist each layer's Arrow IPC schema
   into a per-dataset template written once.
2. **Sectioned payloads**: per-layer TOC so properties can be decoded lazily
   and future sections are skippable (fixes the v1 one-flag-bit jam).
3. **Self-identification**: magic bytes on `.sttp`/`.sttd`.
4. **Time-sorted rows** + a sorted flag (client window slicing; future
   partial decode).
5. Ride-alongs measured in Stage III: relative-Int32 feature times, narrowed
   ids, row-sort zstd verdict.
6. ★ **Bundle profile shipped early** (stage 1): `.sttb` + `stt-bundle` +
   `PackedReader::open_bundle` + validator support are DONE — spec §13,
   byte-identical round-trip E2E-verified. Nothing below changes it.

Non-goals: per-column compression, attribute statistics (descriptor kind 1
stays reserved), directory codec changes (v5 untouched), stt-serve v2
framing (★ serve stays v1 — §7), client-side lazy-props *materialization*
(★ format enables it; the C-TS reader ships eager-only — §4.1).

## 1. Versioning & compatibility

- `manifest.formatVersion: 2` is the **authoritative** discriminator; the
  frame's `0xFFFF` escape (§4) is defense-in-depth, not a negotiation
  channel (★ F6). A v2 frame reached through a v1-declared manifest is a
  hard error, and vice versa.
- The deployed 0.3.0 readers already hard-reject `formatVersion != 1` at
  open by name — the v2 failure mode for old clients is the loud refusal,
  by design.
- `stt-build` emits v2 by default; `--format-version 1` is the kill switch.
  ★ (F3, normative — reworded 2026-07) v1 mode is **0.3.x-READER-compatible
  v1 emission** (v1 frames, no object magic, `formatVersion: 1`, no
  `schemas`), pinned **byte-stable against the CURRENT writer** by the
  committed goldens (`crates/stt-core/tests/v1_golden.rs`): one branch point
  (frame assembly + metadata placement in `encode_layer_cfg`; everything
  upstream shared). Two clarifications the original "byte-identical to the
  0.3.x writer" wording glossed over:
    * Additive manifest fields the current writer emits (`capabilities`,
      `blobOrdering`) are IGNORED by 0.3.x readers under §3's open-envelope
      rule (spec §9.1: every envelope level is open; unknown fields never
      bump `formatVersion`), so reader compatibility — not byte parity with
      a historical binary — is the contract.
    * Bit-parity with the 0.3.0 writer was already broken before v2 shipped,
      by the deliberate FNV-1a synthetic-id migration (spec §9.3, "v1,
      builder-behavior") — the goldens contain post-0.3.0 id bytes and the
      `Auto` ordering heuristic drifted via the occupied-extent fix. The
      goldens therefore pin the CURRENT `--format-version 1` output so it
      can never drift again, not a promise to reproduce 0.3.0 bytes.
- Capabilities remain orthogonal (payload axis): `rel-times32` /
  `narrow-ids` declare via `manifest.capabilities` if Stage III adopts them.

## 2. Object layout changes

### 2.1 Magic bytes
- `.sttp` = `"STTP" u8 version(2) [3 × 0x00]` (8 bytes) + blobs. Directory
  blob offsets are object-absolute (first blob at 8) — no directory-codec
  change. ★ (F5, normative) The manifest's `length` fields and the blake3
  content addresses cover the **entire object including magic**. Consumer
  audit (range math, coalescing gap, validator hashing, r2-sync) is part of
  the C-RUST/C-TS checklists.
- `.sttd` = `"STTD" u8 version(2) [3 × 0x00]` + root frame + leaves.
  `rootLength` keeps meaning the root frame's at-rest length; readers fetch
  `bytes=0..(8+rootLength-1)`, validate magic. Leaf `rel_offset` stays
  relative to the end of the root frame.
- ★ There is **no schemas object kind** — templates are embedded (§3).

### 2.2 Manifest additions (v2)

★ Replaces the draft's external `schemas/<hash>.sttt` objects (dissolves:
the r2-sync new-object-class blocker, the template-404-bricks-dataset
failure class, the extra cold-start fetch, and the schema_ref index
determinism/churn blocker F1 — all four in one move; at 1–2 templates ×
~900 B the manifest grows by low KB, which every session already fetches):

```jsonc
{
  "formatVersion": 2,
  "schemas": [
    { "hash": "<blake3-128 hex of raw template bytes>",
      "data":  "<base64 of raw template bytes>" }
  ],
  // directory/packs/metadata/capabilities: unchanged shape
}
```

- `schemas` is sorted by `hash` (byte-reproducible manifests) and deduped.
- A reader validates each entry (blake3(data) == hash) at open — corrupt
  manifests fail loudly, dataset-level, before any tile fetch.
- ★ Template cardinality (F2): templates are keyed per **distinct stripped
  schema**, not per layer — per-tile type selection (attr-quant
  UInt16/Int32/Float64-fallback, vertex_time u16/i64, triangles u16/u32)
  legitimately yields several templates per layer. No type pinning; the
  hash-keyed registry absorbs it. Stage III records the realized
  cardinality per demo dataset (expected single digits; if a dataset ever
  produced pathological hundreds, the writer warns and `--v2-inline-schemas`
  is the escape).

## 3. Schema templates

1. **TILE_META extraction** (§4.3) moves every per-tile-varying metadata
   key out of the schema. ★ Audit complete (critic F8 + encoder grep): the
   per-tile-varying set is exactly `stt:qa` (field), `stt:time_offset_ms`,
   `stt:vertex_time_origin_ms`/`stt:vertex_time_step_ms`,
   `stt:vertex_value_buckets` (schema). Dataset-constant and
   template-resident: `ARROW:extension:name`, `ARROW:extension:metadata`
   (CRS), `stt:quant` (world-anchored), `stt:layer`, `stt:geometry`
   (legacy), `stt:has_triangles`.
2. **Template** = the layer's Arrow IPC stream bytes from offset 0 through
   the end of the schema message. Spike-proven: boundary = walk the
   encapsulated framing (continuation `0xFFFFFFFF` + i32 metadata_len;
   schema has bodyLength 0), deterministic, 64-aligned under arrow-rs 59
   (spec floor 8) — sections need no template padding.
3. **Tile blob section** (CORE_BATCH / PROPS_BATCH) = the remaining stream
   bytes verbatim. ★ (spike, normative wording) A tail is
   **dictionary batch(es) + record batch + end-of-stream** — dictionary
   batches are per-tile (categories vary) and MUST live in the tail; an
   empty tile still carries one DictionaryBatch per dictionary column.
   The EOS marker (8 bytes `FFFFFFFF 00000000`) belongs to the tail.
4. **Reader** materializes `concat(template, section)` → stock Arrow reader.
   ★ (spike, normative guards) The splice MUST use exactly the TOC-declared
   section length and SHOULD assert the section begins with `0xFFFFFFFF`:
   stray zero bytes make arrow-rs silently return an EMPTY tile (legacy
   4-byte EOS) and make arrow-js silently drop zero-copy.
5. ★ **Frame reference = template hash** (16 raw bytes, blake3-128), not an
   index (F1): blob bytes depend only on their own template's content —
   deterministic under any encode parallelism (E1-proof), no churn coupling
   to the template set. Registry lookup is hash → bytes from
   `manifest.schemas`. Inline mode (self-contained blobs) uses a per-layer
   ref_kind byte instead of a sentinel hash.
6. **Dedup**: blob bytes no longer contain the schema → cross-tile blob
   dedup strictly improves (spike-confirmed: strip leaves tail bytes
   byte-identical).

### 3.1 Spike evidence (gate PASSED)
(a) split determinism PROVEN; (b) rust splice parses, RecordBatch bit-equal
PROVEN (incl. two dictionary columns, cross-tile categories); (c) TS splice
parses zero-copy under apache-arrow 17 PROVEN, no padding amendment needed;
(d) constancy PROVEN — 896 B byte-identical templates across tiles differing
in qa-affines/t0/categories/row-count; (e) numbers — template 896 B raw /
471 B zstd3 once per dataset; per-tile v2 overhead ≈ frame+TOC 32 B +
TILE_META ~104 B raw; v1→v2 whole-blob zstd3: 610→210 B (n=0), 872→458
(n=5), 13686→13060 (n=1000); earthquakes-v2 projection ≈ 40.4 MB ≈ 34 %.

## 4. Layer frame v2

```text
u16  0xFFFF                    # v2 escape (unreachable in v1: aligned path
                               # caps count at 0x7fff; a legacy bare frame
                               # with count ≥ 0x8000 was already unreadable)
u8   frame_version = 2
u8   flags = 0                 # reserved, MUST be 0
u16  layer_count
per layer:
  u16  name_len, [name utf8]
  u8   ref_kind_core           # 0 = INLINE_SCHEMA_CORE section present;
                               # 1 = the next 16 bytes are the template hash
  [16] core template hash      # present iff ref_kind_core == 1
  u8   ref_kind_props          # 0/1 as above; 2 = NO props sections at all
  [16] props template hash     # present iff ref_kind_props == 1
  u8   section_count
  per section (TOC): u8 tag, u32 length     # at-rest bytes, pad excluded
  [pad to 8, derived]
  per section: [section bytes][pad to 8, derived]
```

Section tag registry (unknown tags SKIPPABLE via the TOC):
| tag | name | content |
| --- | --- | --- |
| 0x01 | `INLINE_SCHEMA_CORE` | full IPC prefix (self-contained mode) |
| 0x02 | `TILE_META` | §4.3 |
| 0x03 | `CORE_BATCH` | IPC tail (dict batches + record batch + EOS) |
| 0x04 | `INLINE_SCHEMA_PROPS` | as 0x01, props schema |
| 0x05 | `PROPS_BATCH` | as 0x03, props schema |

### 4.1 Core/props split
Reserved columns form the CORE batch; non-reserved property columns form
the PROPS batch (own schema/template), emitted only when present. ★ The
C-TS reader ships **eager-only** materialization (behavior-identical to
v1); lazy materialization is a format-enabled follow-up — when built, it
must (ops A6) run its Arrow parse in the decode worker and re-account the
tile's cached byteSize through an explicit tileset callback, never silently.

### 4.2 Row order
Rows stable-sorted by `start_time` (input order = the tiler's deterministic
placement order — determinism established by the 2026-07-05 hardening pass;
★ F10: the sort runs AFTER id assignment so ids are order-independent).
TILE_META carries `sorted: true`. Stage III measures the zstd delta and can
demote the sort to a flag if it loses.

### 4.3 TILE_META section
★ (F8) Canonical serialization: JSON, keys sorted (BTreeMap), no
whitespace; readers MUST ignore unknown keys (additive evolution). Presence
rules: a key is present iff the corresponding feature is (e.g. `qa` omits
Float64-fallback columns entirely — absence of a column key means
not-quantized, mirroring the v1 absent-`stt:qa` contract); `t0` present iff
a start-time column exists; `vt` iff delta-encoded vertex_time; `vb` iff a
value matrix.
```jsonc
{ "qa": {"speed": [0.0, 0.15]}, "sorted": true, "t0": 1577836800000,
  "vb": 24, "vt": [1577836800000, 1000] }
```
Readers MUST source these from TILE_META in v2 (templates carry only
dataset-constant metadata).

### 4.4 Reader/worker distribution (★ ops A5, normative for C-TS)
- At open: parse `manifest.schemas`, validate hashes, build the in-memory
  registry. No network fetches — templates arrive with the manifest.
- Worker pool: the pool wrapper (re)sends the template registry to every
  worker **on every spawn and respawn** before dispatching decodes to it
  (respawn-safe); the inline decoder and the OPFS warm path share the same
  registry object. OPFS note: the fingerprint (directory hash) already
  covaries with blob bytes, so stale v1 payloads MISS, never misparse; v2
  OPFS payloads decode via registry + splice like network payloads.

## 5. Measured ride-alongs (Stage III gate)
Unchanged: `rel-times32`, `narrow-ids` — implemented only if
`stt-optimize diff` on rebuilt demos says yes; plus the §4.2 row-sort
verdict and the §2.2 template-cardinality census.

**Gate decided 2026-07-05 (§5.1): `rel-times32` SKIPPED, `narrow-ids`
SKIPPED, §4.2 row-sort default CONFIRMED (no `--no-row-sort` escape
needed), §2.2 census single-digit as expected (2–3 templates/dataset).**
Neither capability ships; `manifest.capabilities` stays unaffected (§1).

### 5.1 Stage III results (measured 2026-07-05)

Method: four locally-buildable datasets covering distinct shapes were each
built twice with **identical flags except `--format-version`** (v1 = frozen
0.3.x layout, v2 = default), all at publish level (`--zstd-level 19`,
`-w 8`); every build ran `stt-validate`, `stt-optimize inspect`
(per-column standalone IPC+zstd-19 cost attribution), and
`stt-optimize diff` v1→v2. Artifacts (builds + reports) are parked for the
review stage under
`/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-spatiotemporal-tiles/4b689f61-ea93-4a74-a895-4b91eb6d9c9f/scratchpad/stage3/`
(`builds/<name>-v{1,2}/`, `reports/*.{bytes,inspect,diff,validate,retype}.json`).

Corpus (all offline; the §9.4 named demos need network re-fetch, so local
shape-equivalents were substituted — limitations below):

| dataset | shape | features | key flags |
| --- | --- | --- | --- |
| hurricanes | sparse global points, 4 dict cols, quantized | 48,538 (291,228 placed) | `scratch-duckdb/hurricane_points.parquet`, `-t iso_time`, 7d bucket, z0–5, `--quantize-coords 100 --quantize-attrs-auto` |
| ecco | global current trajectories, vertex_time+values, long-lived tracks | 134,045 (8.80 M placed) | `ecco-currents.parquet`, unix-ms, `--end-time-field`, 5d bucket, z0–5, Float64 coords |
| taxi | dense urban trajectories, vertex_time, short trips | 100,000 (1/5 stride of Jan-2015 paths; 1.33 M placed) | 1h bucket, z0–10, `--quantize-coords 1` |
| ais | dense coastal points, categorical-heavy (3 string + 3 code cols) | 1,664,628 (1/5 stride of 2023-01-09; 14.98 M placed) | 1h bucket, z0–8, `--quantize-coords 1 --quantize-attrs-auto` |

Results (pack bytes = physical `packs/` size; diff gate metric =
entry-weighted blob bytes from `stt-optimize diff`):

| dataset | v1 pack B | v2 pack B | Δ pack | Δ blob (diff) | dir B v1→v2 | manifest B v1→v2 | templates (raw B) | wall s v1→v2 | validate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hurricanes | 10,049,785 | 6,392,849 | **−36.4 %** | −35.8 % | 141,368→144,348 | 1,035→3,093 | 2 (1,408) | 26.2→29.3 | clean/clean |
| ecco | 733,409,267 | 702,361,861 | **−4.2 %** | −4.3 % | 768,905→767,620 | 2,007→5,254 | 3 (2,240) | 143.0→159.8 | drift† both |
| taxi | 132,399,630 | 131,853,238 | **−0.4 %** | −0.1 % | 3,838→3,832 | 1,152→4,315 | 3 (2,176) | 42.4→45.5 | drift† both |
| ais | 292,576,474 | 276,000,619 | **−5.7 %** | −5.8 % | 205,504→208,757 | 1,440→3,498 | 2 (1,408) | 64.6→68.6 | clean/clean |

† Pre-existing benign validator finding, byte-identical wording on BOTH
sides: per-tile `vertex_time` type varies (u16-delta vs i64-exact
fallback), which the validator reports as "schema drift". Not a v2
regression (same finding on the v1 build; documented in
`scripts/duckdb/bench-ingest.sh`). Feature counts decode complete and
equal v1 = v2 on every dataset.

Reading: the schema-tax saving scales inversely with tile size, as
predicted — −36 % on sparse-tile hurricanes (12,886 tiles, ~780 B/tile
pack), −4…−6 % on mid-size-tile ecco/ais, −0.4 % on taxi (600 tiles,
~220 KB/tile). v2 build wall time costs +6…12 % (sort + template
registry). No dataset grew.

**§2.2 template-cardinality census: PASS.** Realized cardinality 2–3
templates per dataset (1 core + 1 props on hurricanes/ais; ecco/taxi add a
second core template from the legitimate `vertex_time` u16/i64 type
split), 1.4–2.2 KB raw total riding the manifest (+2.1–3.2 KB manifest
growth incl. base64 + hashes). Nowhere near the pathological-hundreds
warning threshold; `--v2-inline-schemas` escape stays theoretical.

**Ride-along method.** `stt-optimize` has no re-typing mode (the
format-review's `sample-encode` idea was never built as such), so the
estimate combines (a) the measured v2 per-column standalone shares from
`inspect` with (b) an out-of-band re-encode of the same columns from the
source parquets, grouped into max-zoom×bucket tile-groups with v2 row
order, encoded both ways at zstd-19 (`reports/*.retype.json`;
`retype_measure.py`). Two bounds per feature: *buf* = zstd over the raw
value buffers (marginal effect inside a real multi-column tile; upper
bound) and *framed* = standalone single-column IPC+zstd (the inspect
convention; lower bound). Projected saving = v2 column share × (1 −
ratio), as % of blob bytes — the same convention `doctor` uses.

**Verdict: `rel-times32` → SKIP.** Projected blob-byte saving
(buf…framed): hurricanes **+1.4…+5.2 %**, ecco **+0.2…+0.8 %**, taxi
**−0.2…−0.3 %**, ais **−1.9…−3.1 %**. Corpus median ≈ +0.2 % (< the 1 %
SKIP line); the sign FLIPS on dense tiles — sorted absolute Int64 times
(constant high 5 bytes per 8-byte value) are *more* zstd-redundant per row
than dense Int32 offsets (taxi time column re-encodes **+46 %**, ais
**+34 %** as rel-Int32). The §4.2 sort already banks the time-column win
(ais start/end_time −61 % v1→v2, below), which is precisely what strands
rel32. Kill-shot anomaly: on ecco 125,526 / 134,045 features (94 %)
overflow Int32 ms relative to bucket t0 (`end − t0` > 24.8 d on long-lived
tracks), so end_time would need a per-tile fallback path for near-zero
median upside. Consistent with the repo's MLT-study negative on
lightweight encodings under zstd-at-rest.

**Verdict: `narrow-ids` → SKIP.** Projected blob-byte saving: hurricanes
+0.05…+0.4 %, ecco +0.3…+2.2 %, taxi ±0.0 %, ais −0.2…−0.8 %. Median
≈ +0.2 % (< 1 %). UInt64 sequential ids carry 4 always-zero high bytes
that zstd folds into its match model almost for free — halving the raw
width often *hurts* (u32 re-encoded LARGER than u64 on ais z8, taxi z10,
and every dataset's shallow-zoom groups). The one mild positive (ecco,
ids replicated across clipped track segments) tops out at +2.2 % on the
optimistic bound only.

**Verdict: §4.2 row-sort → CONFIRMED default, no escape flag.** Isolated
per-COLUMN (v1 rows = unsorted 0.3.x order, v2 = sorted; standalone
re-encode removes the schema-tax confound): geometry/coordinate cost
deltas are hurricanes **+0.19 %**, ecco **−0.09 %**, taxi **+0.01 %**,
ais **−0.12 %** — nowhere near the 2 %-of-pack-bytes damage line, i.e.
the time-sort does NOT scramble spatial locality at tile granularity.
Upside is real: ais start_time/end_time −61.2 %/−61.2 % v1→v2; ecco
start_time −8.9 %, vertex_time −3.7 %. Worst column regressions anywhere:
ais `id` +55.0 % (sort de-correlates the id sequence; +1.1 MB standalone
vs −5.1 MB banked on the time columns) and taxi `trip_id` +1.8 % — both
net-positive tiles. `sorted: true` stays baked in.

**Corpus limitations.** (1) The §9.4-named demos (earthquakes-v2,
drifters, nyc-taxi-points) need network re-fetch and were not rebuilt;
their shapes are covered by proxies (sparse points → hurricanes, ocean
trajectories → ecco, dense urban → taxi/ais) and the hurricanes result
(−36.4 %) brackets the spike's earthquakes-v2 projection (−34 %). (2) No
summary-tier or temporal-LOD archive in the corpus. (3) taxi/ais are 1/5
deterministic strides of their sources; taxi/ais/ecco per-column numbers
ride `--sample 1500/2000` decodes (deterministic, same tiles both sides;
totals exact). (4) The ride-along projections are share×ratio estimates,
not an end-to-end re-typed writer — acceptable because both land SKIP
with margin in both bounds; a future re-litigation should re-run
`retype_measure.py` against a rebuilt corpus.

## 6. Bundle profile — ★ SHIPPED (stage 1)
Implemented as spec §13 (non-normative draft): magic `STTB`+v1, u32
header_len, header JSON with the manifest embedded as **verbatim raw
bytes** (serde RawValue — pack→unpack round-trips byte-identically),
canonical object order (directory, packs by pack_id, future schemas —
already v2-proof), 8-aligned u64 offsets; `stt-bundle pack/unpack`,
`PackedReader::open_bundle` (windows into one mmap), `stt-validate .sttb`.
One open item rides C-RUST: teach `verify_packed_objects` formatVersion 2
so v2 bundles unpack-verify.

## 7. stt-serve (★ F7/ops A7 — resolved: serve stays v1)
`stt-serve` keeps emitting v1 frames (inline schemas are its only mode
anyway; responses are `no-store` origin/LAN — template amortization buys
nothing). The serve protocol gains no version channel in this break; a
future serve-v2 must add `formatVersion` to `/metadata.json` FIRST. The
file≡DB byte-parity story is therefore scoped: parity holds between a
`--format-version 1` offline build and serve. This is recorded in the serve
protocol spec as part of C-RUST's doc updates.

## 8. Migration & deploy (★ new — ops B1/B2)
- No new object class ships (templates embedded), so r2-sync's copy pass is
  already sufficient. TWO r2-sync fixes ship BEFORE any v2 republish:
  1. **Prune grace** (pre-existing latent bug, maximized by v2): the prune
     pass builds its referenced set from the LOCAL manifest only; a v2
     republish makes every v1 object unreferenced-and-old → reaped on the
     first default sync while edge manifests (≤60 s) and open sessions
     still resolve v1. Fix: fetch the CURRENTLY-DEPLOYED remote
     manifest.json before upload and union its references into the
     protected set (one-deploy grace, honoring spec §2), keeping
     `--min-age` as the second gate.
  2. `--no-prune` documented as the belt-and-braces mode for major
     republishes; spec §2 gains a sentence pointing at the grace rule.
- Republish playbook: everything re-uploads (all blobs change); v1 objects
  age out via the §2 GC retention pass after the grace window; rollback =
  re-upload the previous manifest (v1 objects still present through the
  window).
- A v1 rebuild of a published dataset still churns content addresses (the
  FNV-1a id migration + `Auto`-heuristic drift, spec §9.3) — republishing is
  a full re-upload regardless of format version.

## 9. Execution stages — ALL COMPLETE (2026-07-05)
1. ✅ Stage 1: spike PASSED; critiques resolved (this revision); D1
   scrub-LOD wired (kill-switched, default off); C6 bundle shipped.
2. ✅ **C-RUST** (2026-07-05, one mid-run agent loss, resumed): frame v2 +
   TILE_META + templates + magic + manifest schemas + PackedReader v2 +
   `--format-version` (v1 goldens; the flag wiring exposed and fixed a
   latent mixed-version default) + row sort + spec/schema updates +
   `verify_packed_objects` v2 + two stt-validate v2 bugs found by its own
   E2E. First real number: hurricane −44.8 % pack bytes. r2-sync
   prune-grace shipped alongside (31 offline assertions).
3. ✅ **C-TS** (2026-07-05): both formats; pure-TS blake3 (22 Rust-crate
   vectors); registry re-send on every worker (re)spawn; splice guards;
   ResolvedTileMeta convergence; eager PROPS merge; 4 Rust-writer golden
   fixtures proving v2-decode ≡ v1-decode; full-dataset E2E decode ==
   `stt-validate` (436,842 features).
4. ✅ **Stage III measure** (2026-07-05): 4-dataset offline corpus
   (hurricanes / ecco / taxi / ais — the named demos need network, shapes
   covered by proxies) built v1-vs-v2 + `stt-optimize diff`; §5 decided:
   rel-times32 SKIPPED, narrow-ids SKIPPED, row-sort CONFIRMED, census
   2–3 templates/dataset. Numbers in §5.1.
5. ✅ **E1** (2026-07-05): spill-to-disk PackWriter + parallel encode on the
   frozen v2 writer; dead streaming pipeline deleted; benchmark. See §9.5.
6. ✅ **Close-out review** (2026-07-05): 3 recall-tuned finders over the new
   wire/behavioral surfaces → 15 candidates → 15/15 CONFIRMED by verifiers
   → all fixed with tests (highlights: streaming finalize pack phase —
   the compressed-blob head E1 missed; mixed-version repack coherence
   guard + tool seeding; validator template-ref walking; TILE_META shape
   validation; LOD/base tile aliasing fixed via `TileId.bucketMs` through
   every cache key; governor interactive-bit lifecycle; F3 contract
   reworded to 0.3.x-READER-compatible — writer bit-parity was already
   forfeited by the FNV migration). Final sweeps: Rust workspace 0 failed
   suites; TS 489/146/697 green; E2E matrix (v2 exploded + bundle + v1,
   all `stt-validate` OK; −44.8 % re-confirmed post-fixes).

**Open (deliberately outside this campaign):** demo-fleet republish (full
re-upload once; use the §8 playbook; browser verification is manual),
lazy-props client materialization (§4.1), serve-v2 (§7), scrub-LOD P3/P4 +
QoE verify, interior-tile/quadtree polygon coverage, remaining T5.1 memory
heads (feature-vec + per-zoom placement residency).

### 9.5 E1 results (2026-07-05)

Shipped, byte-frozen (no output byte changed at any setting — the v1 goldens,
v2 reproducible-rebuild tests and every committed fixture pass unchanged):

- **Spill-to-disk `PackWriter`** — `stt-build --pack-memory-budget <MiB>`
  (default **512**, `0` = unlimited/legacy) caps the UNCOMPRESSED payload
  bytes buffered between `add_tile_full` and `finalize`. Excess payloads
  append to a temp spill file in the output dir (`.spill-<pid>-<nanos>`,
  removed on success, error and drop); the ~100 B/tile of directory metadata
  stays in RAM. Finalize's chunked parallel-zstd pass reads spilled payloads
  back per `(offset, len)` record, with chunks additionally capped at
  ~budget bytes; chunk boundaries cannot affect output bytes (per-blob
  compression, strictly sequential dedup across boundaries), and the
  existing total-order sort key already made arrival order irrelevant.
- **Parallel encode loop** — every `PackWriter` write loop (plain, LOD,
  `--streaming`) now encodes tiles to Arrow IPC in parallel on the
  `--workers` pool and hands them to the writer in the original
  deterministic order (`tiler::write_tiles_parallel` /
  `TileWriter::write_tiles`). Template collection is order-independent by
  construction (★F1), so parallelism cannot move a byte.
- **Dead pipeline deleted** — `build_streaming_from_batches` +
  `OwnedTileFeature`/`TileBucket`/`push_feature`/`flush_bucket` (doc-marked
  "retained but currently unused") and their two dedicated tests
  (`streaming_matches_in_memory_for_points`,
  `streaming_handles_trajectory_clipping`) are gone; format-review T5.1's
  "two pipelines with subtly different semantics" debt is closed.

**Benchmark** (M-series MBP, 12 cores / 36 GB, release build): synthetic
GeoParquet, 20 M points (numeric `intensity` + categorical `category`,
12 world clusters, 90 days), `--streaming --min-zoom 0 --max-zoom 3
--temporal-bucket 6h --workers 8`; 9,386 tiles, 31 packs, 2.03 GB output.
`/usr/bin/time -l` peak RSS:

| budget | wall | peak RSS | byte-identical |
| ------ | ---- | -------- | -------------- |
| 512 MiB (spill; default) | 359.5 s | 14.71 GiB | — (reference) |
| 0 (unlimited/legacy) | 338.1 s | 16.41 GiB | `diff -r` clean vs spill |

Spilling traded −1.83 GB peak RSS (−10.4 %) for +21 s wall (+6.3 %); the
spill file transiently held ~4.3 GB of payloads that the unlimited build
kept resident through finalize. The remaining resident set is T5.1's other
heads — the full `Vec<ParsedFeature>` plus per-zoom placement/tile vecs
(~20 M features ≈ 10+ GB) — explicitly out of E1 scope; E1 removed the
`PackWriter.pending` payload head (≈ uncompressed dataset size, the one
that grows without bound at finalize) and bounded it at the budget.
`scratch-duckdb/hurricane_points.parquet` (48,538 features → 388,597 tiles,
z0–8, non-streaming path, so this also pins the parallel encode loop)
rebuilt at `--pack-memory-budget 1` vs `0`: `diff -r` clean. No spec
change: spilling is invisible in every emitted object.
