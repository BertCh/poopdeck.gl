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
| Packed **format** | `formatVersion: 1` | [packed-format §3, §6](./stt-packed-format.md) + [`manifest.schema.json`](./manifest.schema.json) |
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
cross-implementation agreement (Rust writes → TS reads):

| fixture | exercises |
| --- | --- |
| `packed-golden/` | manifest folding, v5 directory decode (12 entries), **byte-identical blob dedup** (3 tiles share one physical blob), multi-pack cutting |
| `paged-golden/` + `paged-golden-single/` | the **paged ⇄ whole-load differential**: the same 252-tile corpus emitted both ways, asserting paged queries return *byte-identical* results to a whole-load directory while fetching only the leaf pages a viewport/zoom/time window touches |
| `sample.stt` | single-file → packed transcode + tile decode (geometry, numeric + categorical properties, dictionary null-bitmap) |

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
or its `manifest.json` (the single-file `.stt` container is an internal build
intermediate — spec D3 — and is not accepted), and runs, by cost tier:

**Cheap (all tiles):**
- **content-addressing integrity** — every `packs/*.sttp` and `index/*.sttd`
  blake3-hashes to its filename, and on-disk lengths match the manifest
  (`verify_packed_objects`);
- **manifest schema** — `format` / `formatVersion` / `directoryVersion` constants;
- **directory decode** — the v5 codec decodes and every entry's `pack_id` is in
  range;
- **temporal bounds** — every tile's `[time_start, time_end]` lies within
  `metadata.time_range`;
- **CRC32C** — every compressed blob's integrity tag round-trips.

**Expensive (full or `--sample N`):**
- **Arrow decode** — each tile decodes as an Arrow IPC stream;
- **schema contract** — required columns (`id` U64, `start_time`/`end_time` I64,
  `geometry` with a `geoarrow.*` extension name) and the permitted optional/
  property column types (`check_tile_schema`);
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
addressing, schema, and (for paged) covering invariants of the spec.

### 2.4 Internal pins (for implementers extending the spec)

Two Rust/TS test suites lock the spec to the code so the *spec itself* can't
drift; an external implementer reads them as worked examples:

- `crates/stt-core/tests/spec_conformance.rs` — round-trips point / line /
  polygon / pre-tessellated-polygon layers and asserts the exact documented Arrow
  schema (column names, types, nullability, GeoArrow extension names, the
  `stt:vertex_time_origin_ms` / `stt:vertex_time_step_ms` / `stt:has_triangles`
  metadata keys).
- `packages/core/test/{manifest-schema,packed-golden,paged-directory,archive}.test.ts`
  — the manifest contract and the golden-fixture reads above.

## 3. Conformant **writer** requirements

A conformant writer **MUST**:

- emit a `manifest.json` valid against [`manifest.schema.json`](./manifest.schema.json)
  (`format: "stt-packed"`, `formatVersion: 1`, `directory.directoryVersion: 5`);
- **content-address** every pack and directory object by blake3-128 (32 hex
  chars) and name each file by its hash;
- **deduplicate byte-identical blobs** (one physical blob, multiple directory
  entries) so the directory's run-length encoding can collapse them;
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

A conformant writer **SHOULD**:

- order blobs and directory entries with the §5 total tiebreaks so a rebuild is
  byte-reproducible — **and** serialize Arrow schema/field custom metadata in a
  canonical (lexicographic) key order so content addresses are reproducible
  *across processes*. The reference Rust writer meets the former but **not yet**
  the latter (a pinned-`arrow` limitation; see
  [packed-format §7-D6](./stt-packed-format.md#7-design-decisions)) — this is the
  one published conformance gap;
- compress the directory at rest (`directory.encoding: "zstd"`);
- emit a paged directory (`layout: "paged"`) for large datasets so cold readers
  fetch directory bytes proportional to the viewport.

## 4. Conformant **reader** requirements

A conformant reader **MUST**:

- **reject** an unrecognized `format`, `formatVersion`, or `directoryVersion`
  (refuse, don't guess);
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
