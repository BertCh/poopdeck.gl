# STT Conformance

> **Scope:** what it means for an implementation to be a conformant STT
> **writer** or **reader**, and the portable artifacts — a published JSON
> Schema, committed cross-implementation golden fixtures, and a reference
> validator — that let anyone check theirs. This page turns the requirements
> scattered through the [packed-format](./stt-packed-format.md),
> [tile-payload](../architecture/data-format.md), and [time-model](./time-model.md)
> specs into one checklist plus the means to test against it.

## 1. What "conformant" means

STT has three independently-versioned axes (§9 of the packed spec). An
implementation declares conformance per axis:

| axis                | current                                            | governed by                                                                                       |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Packed **format**   | `formatVersion: 2` only (`1` withdrawn 2026-07-26) | [packed-format §3, §6](./stt-packed-format.md) + [`manifest.schema.json`](./manifest.schema.json) |
| **Directory** codec | `directoryVersion: 5`                              | [packed-format §4, §4.1](./stt-packed-format.md)                                                  |
| **Tile payload**    | Arrow IPC + GeoArrow                               | [data-format.md](../architecture/data-format.md) + [time-model.md](./time-model.md)               |

A **conformant reader** opens any dataset these specs permit (both directory
layouts, every `vertex_time` width, both `TILE_META` time forms, quantized
and raw per-vertex value columns, unknown additive columns and fields). A
**conformant writer** emits only datasets a conformant reader can open, with
the integrity and self-description guarantees below.

> **`formatVersion` 1 is out of scope for conformance.** Read support was
> withdrawn on 2026-07-26 ([packed-format §9.1](./stt-packed-format.md#91-stability--versioning-promise));
> a reader that opens a v1 dataset is not more conformant, and a writer
> cannot emit one. Everything below is v2.

## 2. The portable conformance kit

Three artifacts travel with the spec so an external implementation can verify
itself without reading Rust:

### 2.1 The manifest JSON Schema

[`manifest.schema.json`](./manifest.schema.json) is the **cross-language wire
contract** for `manifest.json`. It is served at the absolute URL it declares as
its own `$id` — <https://poopdeck.gl/spec/manifest.schema.json>, as
`application/schema+json` with `Access-Control-Allow-Origin: *` — so a
validator that _resolves_ the `$id` gets the schema instead of a web page
(likewise <https://poopdeck.gl/spec/scene.schema.json>). It is pinned in CI
against three things that must agree
(`packages/core/test/manifest-schema.test.ts`):

1. the Rust writer type (`crate::pack::Manifest`),
2. the TypeScript reader type (`@poopdeck.gl/core` `PackedManifest`),
3. a committed golden manifest (below).

The schema encodes the format's evolution rules directly: `format` and
`directory.directoryVersion` are strict `const`s, `formatVersion` is the
closed enum `[2]`; `directory.encoding` is an enum that is _not_ required
(pre-encoding manifests omit it); pack/index keys are `pattern`-checked to
the blake3-128 hex shape; and every envelope level permits unknown fields
(additive evolution). The contract test also asserts five **negative** cases
drift loudly (wrong format, wrong version, missing `packs`, bad key pattern,
bad directory version) and that **unknown fields validate** at every level.

It additionally carries the **machine-readable capability registry** as the
top-level `x-stt-capability-registry` array — the single source of truth
both reference implementations pin their constant lists against
(`crates/stt-core/tests/capability_registry.rs` for Rust
`KNOWN_CAPABILITIES`; the same TS contract test for
`KNOWN_MANIFEST_CAPABILITIES`), so a registry addition on either side fails
CI until the schema and both readers agree. Current entries: `attr-quant`,
`coord-quant`, `elevation-fold`, `time-delta`, `vertex-value-quant`.

### 2.2 Committed golden fixtures

Tiny, deterministic, byte-stable datasets live under
`packages/core/test/fixtures/` and are read by the TS reader tests to prove
cross-implementation agreement — the genuine **Rust writes → TS reads** cases.
All of them are `formatVersion: 2`; there is no longer any other version to
emit.

| fixture                                  | exercises                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packed-golden/`                         | manifest folding, v5 directory decode (12 entries), **byte-identical blob dedup** (3 tiles share one physical blob), multi-pack cutting. Self-contained frames (inline schemas, no `schemas` table)                                                                                     |
| `paged-golden/` + `paged-golden-single/` | the **paged ⇄ whole-load differential**: the same 252-tile corpus emitted both ways, asserting paged queries return _byte-identical_ results to a whole-load directory while fetching only the leaf pages a viewport/zoom/time window touches                                           |
| `v2-golden/`                             | the real `stt-build` writer on points: manifest-level `schemas` templates, coord-quant, per-tile `qa` affines, numeric + two dictionary columns with nulls, paged directory                                                                                                             |
| `v2-golden-tracks/`                      | the same for trajectories: delta `vertex_time` with the `vt` TILE_META affine, unquantized Float64 coordinates, single (whole-load) directory                                                                                                                                           |
| `legacy-shape/` (4 datasets)             | the **frozen back-compat corpus**: tile blobs lifted verbatim from shipped archives written BEFORE the 2026-07-26 payload change — absolute `Int64` times, raw `List<Float32>` vertex values with NaN holes, `List<UInt16>` and absolute `vertex_time`, no `st`/`et`/`vq` keys anywhere |

They are **committed, not regenerated per build**, so they double as a
regression corpus. `legacy-shape/` in particular must **never** be
regenerated: its whole purpose is to be old bytes, and its first test walks
the raw frames asserting `st`/`et`/`vq` are absent in every tile so the
corpus cannot silently drift into testing the new path.

Two generators, because the families are produced by different halves of the
toolchain:

```bash
# packed-golden/, paged-golden/, paged-golden-single/ — hand-built payloads
# through stt-core's PackWriter.
cargo run -p stt-core --example make-golden-fixture

# v2-golden*/ — the real stt-build writer, from one synthetic DuckDB source
# (needs `--features duckdb`).  ⚠ CURRENTLY BROKEN: the script still passes
# the removed `--format-version` flag and still builds the deleted `-v1`
# sibling dirs. The committed fixtures predate the 2026-07-26 payload change
# and are deliberately left stale — the TS tests only decode and validate
# them (no byte pins), so old-encoder bytes are exactly the back-compat case
# the reader must handle.
packages/core/scripts/make-v2-golden.sh
```

The first generator (`crates/stt-core/examples/make-golden-fixture.rs`) uses
`BlobOrdering::SpatialMajor` (not `Auto`) so content hashes are stable across
regenerations, and builds each distinct payload once + clones it for the dedup
cases. Builds are byte-reproducible, so re-running it is a no-op diff unless
the writer's bytes intentionally changed.

> **Known writer-conformance gap in `make-golden-fixture`.** It builds its
> manifest through `PackWriter` directly rather than through
> `EncoderSettings::required_capabilities()`, so its output uses the compact
> time encoding (`TILE_META.st`/`et`, on by default) while omitting the
> `time-delta` declaration from `manifest.capabilities`. Per §3 that is a
> **non-conformant writer**: a reader lacking the feature would silently
> misdecode instead of refusing at open. Harmless in-repo (the only consumer
> is the current TS reader) but it must not be copied as an example.

#### Byte-exact writer pins

Decoding a fixture proves reader agreement. Pinning a fixture's _bytes_ proves
the writer did not drift.

| version                  | fixtures                                                                                                     | asserted by                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 2 (**the only version**) | `crates/stt-core/tests/fixtures/v2-golden/` — a `single/` and a `paged/` dataset plus `expected-hashes.json` | `crates/stt-core/tests/v2_golden.rs` |

The v2 pin was added 2026-07-24 and closed a structural inversion worth
naming, because it is the failure mode this section exists to prevent: for a
while the **frozen legacy** format was byte-pinned while the **current
default** was not. The `v2-golden*` fixtures under `packages/core/test/` had
given v2 decode-equivalence coverage the whole time — which catches a reader
that stops understanding the bytes, but not a _writer_ that starts emitting
different ones. An encoder change that still round-tripped cleanly would have
turned the v1 pin red and left v2 silently green. The v1 pin
(`tests/fixtures/v1-golden/` + `tests/v1_golden.rs`) was deleted with v1
support on 2026-07-26; v2 is now the only pin, which is why it must be
regenerated **only** alongside an intentional, reviewed encoder change:

```bash
cargo test -p stt-core --test v2_golden -- --ignored regenerate_v2_golden
```

`v2_golden.rs` also carries a value assertion, not just a hash one: it
decodes the committed fixture and asserts both time columns come back as
non-null absolute `Int64` anchored at the corpus base. A regressed compact-
time re-inflation still _decodes_ — it just reports times near zero — so only
a value assertion catches it.

### 2.3 The reference validator

`stt-validate <dataset>` (a `[[bin]]` of the `spatiotemporal-tiles` crate —
there is no `stt-validate` package) is the executable specification of the
integrity contract. It accepts a packed dataset directory
or its `manifest.json` (the single-file `.stt` container has been removed — only
the packed format is accepted), and runs, by cost tier:

**Cheap (all tiles):**

- **content-addressing integrity** — every `packs/*.sttp` and `index/*.sttd`
  blake3-hashes to its filename, and on-disk lengths match the manifest
  (`verify_packed_objects`);
- **manifest schema** — `format` / `formatVersion` / `directoryVersion` constants;
- **directory decode** — the v5 codec decodes and every entry's `pack_id` is in
  range;
- **temporal bounds** — every tile's `[time_start, time_end]` lies within
  `metadata.time_range`;
- **metadata totals** — `metadata.tile_count` / `feature_count` agree with the
  directory's entry count and per-entry `feature_count` sum;
- **CRC32C** — every compressed blob's integrity tag round-trips.

**Expensive (full or `--sample N`):**

- **Arrow decode** — each tile decodes as an Arrow IPC stream;
- **schema contract** — required columns (`id` U64, `start_time`/`end_time` I64,
  `geometry` with a `geoarrow.*` extension name) and the permitted optional/
  property column types (`check_tile_schema`);
- **quantization gate** — an `Int32`-leaf `geometry` column MUST carry
  `stt:quant` (otherwise a naïve reader misdecodes grid indices as degrees);
- **vertex-time metadata sanity** — a delta `vertex_time` column (`List<UInt16>`
  **or** `List<UInt32>`) MUST carry parseable `stt:vertex_time_origin_ms` /
  `stt:vertex_time_step_ms`, and an absolute `List<Int64>` one MUST NOT;
- **CRS84 tagging** — a missing/non-CRS84 `ARROW:extension:metadata` on an
  unquantized `geometry` field is warned (the writer MUST of §3);
- **interval sanity** — every feature satisfies `end_time >= start_time`;
- **`time_end` tightness** — each entry's `time_end` equals the maximum
  feature `end_time` in the tile (the [time-model §5](./time-model.md#5-read-time-temporal-pruning--cover_t_min)
  MUST that interval findability rests on);
- **summary cell-id validity** — in a summary layer, every `id` is a valid
  cell index of the declared scheme at the zoom's declared resolution (the
  check that would have caught the shipped-blank summary archives);
- **feature-count match** — decoded row count equals the directory's
  `feature_count`;
- **producer-drift detection** — distinct per-tile schema signatures are tallied
  and the first disagreeing pair reported. Integer-**width** drift on one
  column (`UInt16` ⇄ `UInt32` ⇄ `Int32` ⇄ `Int64`) is classified _adaptive_
  and passes, as is the presence-vs-absence of a documented **optional
  reserved** column (`vertex_time`, `vertex_value`, `vertex_value_matrix`,
  `triangles`, `part_offsets`) — each is emitted per tile, iff that tile's data
  needs it, which is the format's design and not a producer defect. A
  **property** column appearing in one tile and absent in another, or any
  column changing type family, is _structural_ and errors.

The validator sees the payload **after** re-inflation, so the compact time
forms and per-vertex value quantization are invisible to it by construction —
what it checks is the canonical decoded shape. It does check the two columns
those changes added to the wire directly: `vertex_time` at all three widths,
and `part_offsets` as a reserved `List<UInt32>` column.

> **Why the drift check is asymmetric.** A per-tile encoding _choice_ and a
> producer that changed mid-build look identical to a schema comparison, so
> the classifier can only distinguish them by knowing which variation the
> format sanctions. Two are sanctioned — integer width, and optional-reserved
> presence — and both are properties the reference readers already branch on.
> Everything else errors. This is why the attribute quantizer's sole refusal
> keys off value _magnitude_ (a property of the column's domain) rather than
> span or distribution (properties of the tile's sample): a sample-dependent
> refusal would flip a column between `Float64` and an integer leaf from tile
> to tile, which is a type-family change and correctly errors here. An earlier
> revision of that quantizer did exactly this and was reverted.

For a **paged** directory it additionally runs `verify_paged_structure`: every
leaf descriptor's bounds (geo bbox, zoom range, `[t_min, t_max]`) **cover** the
leaf's entries (so a prune never drops a matching tile), and cross-page key order
is monotonic.

```bash
stt-validate data/earthquakes            # full check
stt-validate data/earthquakes --sample 200 --json   # sampled, machine-readable
stt-validate data/earthquakes --skip-decode         # integrity/hashes only
```

A dataset that passes `stt-validate` with no errors satisfies the integrity,
addressing, schema, temporal (interval sanity, `time_end` tightness), payload
self-description (`stt:quant` / vertex-time metadata), summary cell-id, and
(for paged) covering invariants of the spec.

### 2.4 Internal pins (for implementers extending the spec)

These Rust/TS test suites lock the spec to the code so the _spec itself_ can't
drift; an external implementer reads them as worked examples:

- `crates/stt-core/tests/v2_golden.rs` — the byte-exact writer pin against
  `crates/stt-core/tests/fixtures/v2-golden/` (both directory shapes, every
  object plus the manifest), plus a decode-and-assert-values pass over the
  committed bytes.
- `crates/stt-core/tests/capability_registry.rs` — pins Rust
  `KNOWN_CAPABILITIES` against the schema's `x-stt-capability-registry`
  (§2.1); `packages/core/test/manifest-schema.test.ts` pins the TS constant
  against the same array.
- `crates/spatiotemporal-tiles/tests/validate_cli.rs` — end-to-end tests of the
  reference validator: each builds a tiny packed dataset with `PackWriter`,
  runs the compiled `stt-validate` binary over it with `--json`, and asserts on
  the parsed report. `every_encoder_payload_shape_passes_the_validator` builds
  one archive carrying a two-part holed polygon (`part_offsets`), a 3-day
  track (`UInt32` `vertex_time`) and quantized vertex values, then re-decodes
  it to prove each shape really reached the wire — a clean report proves
  nothing if the corpus stopped producing the shape.
- `packages/core/test/legacy-shape-backcompat.test.ts` — decodes the frozen
  pre-2026-07-26 corpus (§2.2) through the current TS reader and pins exact
  time / vertex-value / offset arrays.
- `packages/core/test/compact-times.test.ts` and
  `packages/core/test/vertex-value-quant-and-parts.test.ts` — the TS side of
  the `st`/`et`/`vq`/`part_offsets` contracts, including the malformed-
  `TILE_META` rejections.
- `crates/stt-core/tests/spec_conformance.rs` — round-trips point / line /
  polygon / pre-tessellated-polygon layers and asserts the exact documented Arrow
  schema (column names, types, nullability, GeoArrow extension names, the
  `stt:vertex_time_origin_ms` / `stt:vertex_time_step_ms` / `stt:has_triangles`
  metadata keys).
- `crates/stt-core/tests/hilbert_vectors.rs` — pins the normative Hilbert-key
  test vectors published in
  [packed-format §4](./stt-packed-format.md#the-hilbert-key-normative) against
  the reference implementation, and cross-checks the spec's pseudocode
  (reimplemented independently in the test) exhaustively at low zooms.
- `crates/stt-core/tests/adversarial_decode.rs` — property-based adversarial
  decode tests (proptest): round-trip through the codecs, and **never-panic**
  on arbitrary and mutated input bytes. This is the hardening behind the
  security guidance in
  [packed-format §11](./stt-packed-format.md#11-security-considerations).
- `packages/core/test/{manifest-schema,packed-golden,paged-directory,archive}.test.ts`
  — the manifest contract and the golden-fixture reads above.

## 3. Conformant **writer** requirements

A conformant writer **MUST**:

- emit a `manifest.json` valid against [`manifest.schema.json`](./manifest.schema.json)
  (`format: "stt-packed"`, `formatVersion: 2`, `directory.directoryVersion: 5`);
- declare every required-to-understand feature it used in
  `manifest.capabilities` (registry: `coord-quant`, `attr-quant`,
  `elevation-fold`, `time-delta`, `vertex-value-quant` —
  [packed-format §3.1](./stt-packed-format.md#31-required-to-understand-capabilities-capabilities)),
  omitting the key when none were used; additive columns
  (`triangles`, `part_offsets`, vector groups, …) are never declared.
  **Note that `time-delta` applies to a default build** — the compact time
  forms are on unless suppressed, so a writer that emits them without
  declaring the capability is non-conformant even though it "changed
  nothing";
- **content-address** every pack and directory object by blake3-128 (32 hex
  chars) and name each file by its hash;
- emit a v5 directory: delta + zig-zag varint key columns, blob-run RLE, the
  per-run `pack_id` column, pack-relative offset contiguity, and the optional
  covering section (emitted iff _every_ entry has a covering bound);
- tag every `geometry` field with `ARROW:extension:name` =
  `geoarrow.{point,linestring,polygon}` (and, unquantized, the CRS84
  `ARROW:extension:metadata`);
- write a **CRC32C** of each compressed blob into its directory entry;
- pad every frame section to an 8-byte boundary with a **derived** (never
  stored) pad, and write every Arrow IPC stream at **8-byte buffer
  alignment** — not arrow-rs' 64-byte default, which reproduces neither STT's
  content addresses nor its payload sizes
  ([packed-format §5.2](./stt-packed-format.md#52-tile-payload-layer-frame-v2-sectioned-template-referencing));
- ship **no shared zstd dictionary** — each blob is an independent zstd frame;
- emit `triangles` **all-or-nothing per layer**: once any feature in a layer
  carries baked indices, every feature in it MUST carry a non-empty list
  (all three reference renderers bind the column as one whole-layer index
  buffer and draw nothing for an empty slice);
- emit `part_offsets` iff some feature in a polygon layer is multi-part, with
  feature-local ring indices starting at `0` and strictly increasing —
  absence means every feature is single-part;
- follow the [time model](./time-model.md): Unix-ms UTC, one start-anchored
  bucket per feature, strictly-increasing multiple LOD levels.

A conformant **formatVersion-2** writer additionally **MUST**
([packed-format §§3.2, 5.2, 9.2](./stt-packed-format.md)):

- prefix every `.sttp` object with the 8-byte `STTP` magic prelude and every
  `.sttd` object with `STTD` (version byte 2, reserved bytes zero), with
  directory blob offsets **object-absolute** (first blob at offset 8) and
  content addresses / `length` fields covering the **entire object including
  magic**;
- embed every schema template its frames reference in `manifest.schemas`,
  sorted by hash and deduped, each entry's `hash` equal to blake3-128 of the
  raw template bytes;
- keep templates **dataset-constant**: hoist the per-tile-varying metadata
  keys (`stt:qa`, `stt:time_offset_ms`, `stt:vertex_time_origin_ms`/
  `stt:vertex_time_step_ms`, `stt:vertex_value_buckets`) into each frame's
  canonical-JSON `TILE_META` section (sorted keys, no whitespace, a key
  present iff its feature is);
- if it uses the compact time forms, obey
  [§5.2.4](./stt-packed-format.md#524-compact-feature-times-st--et--capability-time-delta)
  exactly: `st: "u32"` only alongside a `t0` anchor, forms selected per layer
  only when **every** feature fits `u32` under checked arithmetic,
  `et: "zero"` only when every duration is 0 (and then the `end_time` column
  omitted, not zero-filled), and an empty layer always taking the absolute
  pair;
- if it quantizes a per-vertex value column, obey
  [§5.2.6](./stt-packed-format.md#526-per-tile-column-width-selections):
  `TILE_META.vq` keys drawn from the closed set, finite values clamped into
  `[0, 0xFFFE]` so none collides with the `0xFFFF` NaN sentinel, and the two
  degenerate affines pinned as specified so the bytes stay reproducible;
- emit the frame-only encodings (`st`/`et`/`vq`) **only inside a frame** —
  a layer serialized standalone has no `TILE_META` to discriminate them and
  MUST use the canonical shapes;
- emit v2 frames per the §5.2 layout: `0xFFFF` escape, `frame_version 2`,
  `flags 0`, per-layer ref kinds (inline section or 16-byte template hash),
  ascending-tag TOC with exact at-rest lengths, derived 8-byte pads; tails
  are `dictionary batch(es) + record batch + EOS` (an empty tile still
  carries one DictionaryBatch per dictionary column);
- stable-sort each layer's rows by `start_time` after feature-id assignment
  and declare `TILE_META.sorted: true`;
- never mix frame and manifest versions: every payload in a
  `formatVersion: 2` dataset opens with the `0xFFFF` escape, and readers
  hard-error on anything else rather than guessing at an older frame shape.

A conformant writer **SHOULD**:

- **deduplicate byte-identical blobs** (one physical blob, multiple directory
  entries) so the directory's run-length encoding can collapse them — a size
  optimization, not interop-affecting (a reader cannot observe whether two
  entries share bytes, so this is unverifiable as a MUST); the reference
  writer always dedups;
- order blobs and directory entries with the §5 total tiebreaks so a rebuild is
  byte-reproducible — **and** serialize Arrow schema/field custom metadata in a
  canonical (lexicographic) key order so content addresses are reproducible
  _across processes_. The reference Rust writer meets **both** on Arrow ≥59
  (sorted-`BTreeMap` metadata assembly + Arrow 59's stable IPC metadata
  serialization; see
  [packed-format §7-D6](./stt-packed-format.md#7-design-decisions)) — the former
  cross-process gap that existed under Arrow 54 is now closed;
- compress the directory at rest (`directory.encoding: "zstd"`);
- emit a paged directory (`layout: "paged"`) for large datasets so cold readers
  fetch directory bytes proportional to the viewport.

## 4. Conformant **reader** requirements

A conformant reader **MUST**:

- **reject** an unrecognized `format`, `formatVersion`, or `directoryVersion`
  (refuse, don't guess);
- **refuse** a dataset whose `manifest.capabilities` declares a feature the
  reader does not implement, naming the unknown entries (a capability re-types
  existing columns, so proceeding is silent misdecode — not an error later);
- **ignore unknown fields** at every manifest envelope level (additive evolution);
- support **both** directory layouts — whole-load (`single`/absent) and `paged`
  (root page + on-demand leaf fetches), including the small-directory whole-load
  shortcut;
- validate the fetched directory body length against `directory.length` before
  decoding, and unwrap `directory.encoding` when set;
- accept **all three** `vertex_time` encodings — `List<UInt16>` and
  `List<UInt32>` deltas (both carrying `origin`/`step`, v2: `TILE_META.vt`)
  and absolute `List<Int64>` — keying "is it a delta?" off the metadata and
  "how wide?" off the Arrow leaf type, never off the leaf type alone;
- accept a quantized `<prop>` column at **either** integer leaf (`UInt16`,
  `Int32`) and reconstruct through the per-tile `stt:qa` affine, without
  caching the affine or the leaf width across tiles;
- **ignore unknown reserved-looking columns** rather than mis-publishing them
  as properties (`part_offsets` is the current example: a reader that has
  never heard of it must not surface `List<UInt32>` ring indices as a numeric
  property);
- **coalesce range reads per pack** (a range must not bridge two pack objects);
- prune by time with `time_end >= w_start AND (cover_t_min ?? time_start) <= w_end`,
  falling back to `time_start` when `cover_t_min` is absent.

A conformant reader that accepts **formatVersion 2** additionally **MUST**:

- treat `manifest.formatVersion` as **authoritative** and hard-error on a
  frame of the other version inside a dataset (the `0xFFFF` escape is
  defense-in-depth, not negotiation);
- validate the `STTP`/`STTD` object magic (tag, version byte, zero reserved
  bytes) before any offset math, and read blob/root offsets object-absolute;
- validate every `manifest.schemas` entry (`blake3_128(data) == hash`) at
  open, failing the dataset loudly on any mismatch, and resolve frame
  template references against the resulting registry (an unresolvable hash
  is a hard error naming it);
- splice `concat(template, section)` using **exactly** the TOC-declared
  section length, verifying both template and batch section begin with the
  `0xFFFFFFFF` continuation marker (stray zeros silently EMPTY a tile in
  arrow-rs — the guard converts that to a loud error);
- source the per-tile metadata from `TILE_META` (ignoring unknown **keys**),
  and skip unknown section tags via their TOC length — while treating an
  unrecognized **value** of a key it does know (`st`, `et`) as a hard decode
  error, never a fallback;
- support **both** v2 schema modes: template-hash references and
  self-contained inline schema sections;
- re-inflate the compact time forms to absolute non-null `Int64` before any
  consumer sees the batch — including **synthesizing** the `end_time` column
  at the index right after `start_time` when `et == "zero"` — and reject the
  malformed combinations §5.2.4 lists (`st` without `t0`, `st: "u32"` on a
  non-`UInt32` column, `et: "zero"` alongside a present `end_time`,
  `et: "dur32"` without one, length disagreement);
- dequantize a `TILE_META.vq` column back to `Float32`, mapping the `0xFFFF`
  sentinel to `NaN`, and reject a `vq` key outside the closed set, naming an
  absent column, or naming a column whose leaf is not `UInt16`;
- read `part_offsets` when present as feature-local ring indices, and treat
  its **absence** as "every feature is single-part".

A conformant reader **SHOULD**:

- **verify the CRC32C** of each blob (the Rust reader does; the TS hot path
  defers to Arrow/zstd decode errors — verifying is recommended);
- select temporal LOD via `max_zoom_level` when the app opts in;
- render [`anchored-local`](./sidecar-assets.md#4-georeferencing-georeferenced-vs-anchored-local)
  scene bundles on a neutral basemap.

## 5. Running the suite

```bash
cargo test -p stt-core spec_conformance                     # payload schema lock
cargo test -p stt-core --test v2_golden                     # writer byte pin
cargo test -p stt-core --test capability_registry           # registry ⇄ schema pin
cargo test -p spatiotemporal-tiles --test cli_reference_doc # CLI surface ⇄ docs
cargo test -p spatiotemporal-tiles --test validate_cli      # validator behavior
cargo run  -p stt-core --example make-golden-fixture        # regenerate the reader fixtures
pnpm --filter @poopdeck.gl/core test                        # manifest contract + golden-fixture reads
stt-validate <your-dataset>                                 # validate your own output
```

(`packages/core/scripts/make-v2-golden.sh` is listed in §2.2 for
completeness but does not currently run — it still passes the removed
`--format-version` flag.)

`stt-validate` is a `[[bin]]` of the `spatiotemporal-tiles` crate, not a
package — `cargo test -p stt-validate` has never resolved.

A new implementation demonstrates conformance by (a) producing a dataset that
passes `stt-validate` and the manifest schema, and (b) reading the committed
golden fixtures to byte-identical results.
