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

| axis | current | governed by |
| --- | --- | --- |
| Packed **format** | `formatVersion: 2` (default; `1` frozen) | [packed-format §3, §6](./stt-packed-format.md) + [`manifest.schema.json`](./manifest.schema.json) |
| **Directory** codec | `directoryVersion: 5` | [packed-format §4, §4.1](./stt-packed-format.md) |
| **Tile payload** | Arrow IPC + GeoArrow | [data-format.md](../architecture/data-format.md) + [time-model.md](./time-model.md) |

A **conformant reader** opens any dataset these specs permit (both directory
layouts, both layer-frame shapes, both `vertex_time` encodings, unknown
additive fields). A **conformant writer** emits only datasets a conformant
reader can open, with the integrity and self-description guarantees below.

## 2. The portable conformance kit

Three artifacts travel with the spec so an external implementation can verify
itself without reading Rust:

### 2.1 The manifest JSON Schema

[`manifest.schema.json`](./manifest.schema.json) is the **cross-language wire
contract** for `manifest.json`. It is pinned in CI against three things that must
agree (`packages/core/test/manifest-schema.test.ts`):

1. the Rust writer type (`crate::pack::Manifest`),
2. the TypeScript reader type (`@poopdeck.gl/core` `PackedManifest`),
3. a committed golden manifest (below).

The schema encodes the format's evolution rules directly: `format`,
`formatVersion`, and `directory.directoryVersion` are strict `const`s;
`directory.encoding` is an enum that is *not* required (pre-encoding manifests
omit it); pack/index keys are `pattern`-checked to the blake3-128 hex shape; and
every envelope level permits unknown fields (additive evolution). The contract
test also asserts five **negative** cases drift loudly (wrong format, wrong
version, missing `packs`, bad key pattern, bad directory version) and that
**unknown fields validate** at every level.

### 2.2 Committed golden fixtures

Tiny, deterministic, byte-stable datasets live under
`packages/core/test/fixtures/` and are read by the TS reader tests to prove
cross-implementation agreement. The two packed fixtures are the genuine
**Rust writes → TS reads** cases; `sample.stt` is a frozen legacy artifact:

| fixture | exercises |
| --- | --- |
| `packed-golden/` | manifest folding, v5 directory decode (12 entries), **byte-identical blob dedup** (3 tiles share one physical blob), multi-pack cutting |
| `paged-golden/` + `paged-golden-single/` | the **paged ⇄ whole-load differential**: the same 252-tile corpus emitted both ways, asserting paged queries return *byte-identical* results to a whole-load directory while fetching only the leaf pages a viewport/zoom/time window touches |
| `sample.stt` (frozen legacy v4 fixture) | a test helper transcodes it to an in-memory packed dataset, then the packed reader decodes its tiles (geometry, numeric + categorical properties, dictionary null-bitmap). Not written by the current Rust toolchain — the single-file writer was removed |

They are **committed, not regenerated per build**, so they double as a
regression corpus. Regenerate after an intentional format change with:

```bash
cargo run -p stt-core --example make-golden-fixture
```

The generator (`crates/stt-core/examples/make-golden-fixture.rs`) uses
`BlobOrdering::SpatialMajor` (not `Auto`) so content hashes are stable across
regenerations, and builds each distinct payload once + clones it for the dedup
cases.

### 2.3 The reference validator

`stt-validate <dataset>` (the `stt-validate` crate) is the executable
specification of the integrity contract. It accepts a packed dataset directory
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
- **vertex-time metadata sanity** — a `List<UInt16>` `vertex_time` column MUST
  carry parseable `stt:vertex_time_origin_ms` / `stt:vertex_time_step_ms`;
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
  and the first disagreeing pair reported.

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

Two Rust/TS test suites lock the spec to the code so the *spec itself* can't
drift; an external implementer reads them as worked examples:

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
  (`format: "stt-packed"`, `formatVersion: 1 | 2`, `directory.directoryVersion: 5`);
- declare every required-to-understand feature it used in
  `manifest.capabilities` (registry: `coord-quant`, `attr-quant`,
  `elevation-fold` — [packed-format §3.1](./stt-packed-format.md#31-required-to-understand-capabilities-capabilities)),
  omitting the key when none were used; additive columns are never declared;
- **content-address** every pack and directory object by blake3-128 (32 hex
  chars) and name each file by its hash;
- emit a v5 directory: delta + zig-zag varint key columns, blob-run RLE, the
  per-run `pack_id` column, pack-relative offset contiguity, and the optional
  covering section (emitted iff *every* entry has a covering bound);
- tag every `geometry` field with `ARROW:extension:name` =
  `geoarrow.{point,linestring,polygon}` (and, unquantized, the CRS84
  `ARROW:extension:metadata`);
- write a **CRC32C** of each compressed blob into its directory entry;
- align each Arrow IPC stream to 8 bytes when the layer-frame aligned flag
  (`0x8000`) is set (and write no padding when it is unset);
- ship **no shared zstd dictionary** — each blob is an independent zstd frame;
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
- emit v2 frames per the §5.2 layout: `0xFFFF` escape, `frame_version 2`,
  `flags 0`, per-layer ref kinds (inline section or 16-byte template hash),
  ascending-tag TOC with exact at-rest lengths, derived 8-byte pads; tails
  are `dictionary batch(es) + record batch + EOS` (an empty tile still
  carries one DictionaryBatch per dictionary column);
- stable-sort each layer's rows by `start_time` after feature-id assignment
  and declare `TILE_META.sorted: true`;
- never mix frame and manifest versions (a v1 frame in a v2 dataset — or
  vice versa — is non-conformant; readers hard-error on it).

A conformant writer **SHOULD**:

- **deduplicate byte-identical blobs** (one physical blob, multiple directory
  entries) so the directory's run-length encoding can collapse them — a size
  optimization, not interop-affecting (a reader cannot observe whether two
  entries share bytes, so this is unverifiable as a MUST); the reference
  writer always dedups;
- order blobs and directory entries with the §5 total tiebreaks so a rebuild is
  byte-reproducible — **and** serialize Arrow schema/field custom metadata in a
  canonical (lexicographic) key order so content addresses are reproducible
  *across processes*. The reference Rust writer meets **both** on Arrow ≥59
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
- accept **both** layer-frame shapes (aligned `0x8000` + padding, and unaligned);
- accept **both** `vertex_time` encodings (`List<UInt16>` deltas with
  `origin`/`step` schema metadata, and absolute `List<Int64>`);
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
- source the per-tile metadata from `TILE_META` (ignoring unknown keys),
  and skip unknown section tags via their TOC length;
- support **both** v2 schema modes: template-hash references and
  self-contained inline schema sections.

A conformant reader **SHOULD**:

- **verify the CRC32C** of each blob (the Rust reader does; the TS hot path
  defers to Arrow/zstd decode errors — verifying is recommended);
- select temporal LOD via `max_zoom_level` when the app opts in;
- render [`anchored-local`](./sidecar-assets.md#4-georeferencing-georeferenced-vs-anchored-local)
  scene bundles on a neutral basemap.

## 5. Running the suite

```bash
cargo test -p stt-core spec_conformance          # payload schema lock
cargo test -p stt-validate                        # validator behavior
cargo run  -p stt-core --example make-golden-fixture   # regenerate fixtures (after an intended change)
pnpm --filter @poopdeck.gl/core test              # manifest contract + golden-fixture reads
stt-validate <your-dataset>                        # validate your own output
```

A new implementation demonstrates conformance by (a) producing a dataset that
passes `stt-validate` and the manifest schema, and (b) reading the committed
golden fixtures to byte-identical results.
