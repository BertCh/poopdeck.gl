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

| axis                | current                                | governed by                                                                                             |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Packed **format**   | writes `formatVersion: 3`; reads 3 + 2 | [packed-format §3, §6, §9.1](./stt-packed-format.md) + [`manifest.schema.json`](./manifest.schema.json) |
| **Directory** codec | `directoryVersion: 6`                  | [packed-format §4, §4.1](./stt-packed-format.md)                                                        |
| **Tile payload**    | Arrow IPC + GeoArrow                   | [data-format.md](../architecture/data-format.md) + [time-model.md](./time-model.md)                     |

A **conformant reader** opens any dataset these specs permit (both directory
layouts, every `vertex_time` width, both `TILE_META` time forms, quantized
and raw per-vertex value columns, unknown additive columns and fields). A
**conformant writer** emits only datasets a conformant reader can open, with
the integrity and self-description guarantees below.

> **Conformance is declared against v3.** Reference writers emit only v3.
> Reference readers additionally open v2 read-only so already-published
> archives are not stranded ([packed-format §9.1](./stt-packed-format.md)), but
> that window is a compatibility affordance, not a conformance requirement: an
> implementation that reads only v3 is fully conformant, and v1 is refused by
> both.

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
closed enum `[3]`; `directory.encoding` is an enum that is _not_ required
(absence selects the raw v3 codec bytes); pack/index keys are `pattern`-checked to
the blake3-128 hex shape; and every envelope level permits unknown fields
(additive evolution). The contract test also asserts five **negative** cases
drift loudly (wrong format, wrong version, missing `packs`, bad key pattern,
bad directory version) and that **unknown fields validate** at every level.

Most of `metadata` is deliberately opaque to the schema (it is the writer's
`Metadata` JSON folded in verbatim), with four exceptions pinned key by key:
`style_hints`, `ordering_workload`, `z_range` and `content_fingerprint`. The
last three are the **content claims** of §3.1 — fields whose whole purpose is to
assert something about the data rather than describe the container — and a
malformed claim is worse than an absent one, because the validator compares
decoded content against it. Both reference implementations pin their shapes:
`crates/stt-core/tests/spec_conformance.rs` (the Rust writer, which also
asserts the schema declares every key the type emits) and the same TS contract
test (the reader).

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
All generated archives are `formatVersion: 3`; there is no other version to
emit.

| fixture                                  | exercises                                                                                                                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packed-golden/`                         | manifest folding, v6 directory decode (12 entries), **byte-identical blob dedup** (3 tiles share one physical blob), multi-pack cutting. Self-contained frames (inline schemas, no `schemas` table)                                           |
| `paged-golden/` + `paged-golden-single/` | the **paged ⇄ whole-load differential**: the same 252-tile corpus emitted both ways, asserting paged queries return _byte-identical_ results to a whole-load directory while fetching only the leaf pages a viewport/zoom/time window touches |
| `v2-golden/`                             | the real v3 `stt-build` writer on points (historical path name): manifest-level `schemas` templates, coord-quant, per-tile `qa` affines, numeric + two adaptive categorical columns with nulls, paged directory                               |
| `v2-golden-tracks/`                      | the same for trajectories: delta `vertex_time` with the `vt` TILE_META affine, unquantized Float64 coordinates, single (whole-load) directory                                                                                                 |
| `legacy-shape/` (4 datasets)             | frozen real **formatVersion 2** archives (no `variants` registry, directory codec v5) proving the read window of §9.1 actually opens and decodes them, and that `formatVersion: 1` is still refused                                           |

They are **committed, not regenerated per build**, so they double as a
regression corpus. `legacy-shape/` in particular must **never** be
regenerated: it is frozen evidence of what v2 archives look like in the wild,
and regenerating it with the current writer would emit v3 and silently delete
the only coverage the compatibility path has. (These were negative fixtures
under the original clean-cutover plan; they became positive ones when the read
window was kept — see the `formatVersion: 3` rationale in §9.1 of the packed
spec.)

Two generators, because the families are produced by different halves of the
toolchain:

```bash
# packed-golden/, paged-golden/, paged-golden-single/ — hand-built payloads
# through stt-core's PackWriter.
cargo run -p stt-core --example make-golden-fixture

# v2-golden*/ — historical fixture-directory names; the bytes are the current
# v3 archive emitted by the real stt-build writer from synthetic DuckDB
# sources (needs `--features duckdb`).
packages/core/scripts/make-v2-golden.sh
```

The first generator (`crates/stt-core/examples/make-golden-fixture.rs`) uses
`BlobOrdering::SpatialMajor` (not `Auto`) so content hashes are stable across
regenerations, and builds each distinct payload once + clones it for the dedup
cases. Builds are byte-reproducible, so re-running it is a no-op diff unless
the writer's bytes intentionally changed.

The hand-built generator derives `manifest.capabilities` from the same
`EncoderConfig` used to encode its payloads. This keeps direct `PackWriter`
fixtures conformant even though `stt-core` cannot depend on
`stt-build::EncoderSettings`.

#### Byte-exact writer pins

Decoding a fixture proves reader agreement. Pinning a fixture's _bytes_ proves
the writer did not drift.

| version                  | fixtures                                                                                                                                          | asserted by                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 3 (**the only version**) | `crates/stt-core/tests/fixtures/v2-golden/` — a historical path containing current `single/` and `paged/` v3 datasets plus `expected-hashes.json` | `crates/stt-core/tests/v2_golden.rs` |

The byte pin catches a writer that starts emitting different bytes even when
the changed encoder still round-trips cleanly. The `v2-golden*` path names are
retained only to avoid noisy fixture-path churn; their manifests and objects
are v3. The current format is the only positive archive pin, which is why it must be
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
- **directory decode** — the v6 codec decodes and every entry's `pack_id` is in
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

**Semantic (only when the archive makes a content claim):**

- **content fingerprint** (check 12) — when `metadata.content_fingerprint` is
  present, the decoded content's vertex bbox, vertical extent, per-column
  numeric ranges and categorical cardinalities are recomputed from the tiles and
  compared against the declared block: **containment** under `--sample` (every
  observed value must lie inside the declared extent, every observed
  cardinality at or below the declared one), containment **plus equality within
  the declared tolerances** under a full decode — a declared box wider than the
  decoded content means the manifest describes data the archive does not
  contain, which is a failure in the other direction. A declared tolerance is
  **rejected outright** unless its matching capability is declared
  (`coord-quant` for `coord_tolerance_deg`, `attr-quant` for
  `column_tolerance`), so a writer cannot buy slack it did not earn; the
  `stt:quant` / `stt:qa` steps the archive itself carries on the wire are
  admitted as slack with no declaration at all, because they are exactly what
  the reader dequantizes with. A fingerprint whose `version` is newer than the
  validator understands **warns and skips** rather than mis-checking. Layers a
  summary tier declares are excluded (their rows are derived aggregates
  addressed by cell index, so a cell centroid may legitimately sit outside the
  source bbox); every other layer is checked.

  This is the check that closes the gap structural validation cannot: an archive
  whose coordinates have been silently scrambled hashes, decodes, and
  schema-checks perfectly. A stride-2 read of a 3D `xyz` leaf once flattened and
  scrambled 106 archives and **every one passed** the checks above it.

  When the fingerprint is **absent** — which is every archive published before
  the field existed — the run **warns and continues**, mirroring the CRS84
  precedent. The JSON report's `fingerprint_checked` boolean says whether the
  comparison ran at all; `false` means the archive's CONTENT is unverified and
  only its structure was checked. Distinct-feature counts are compared through a
  fixed-size HyperLogLog sketch, the one approximation in an otherwise exact
  validator, so any finding derived from it prints its error bound.

  `--emit-fingerprint <PATH>` and `--expect-fingerprint <PATH>` run the same
  comparison against an **external** file rather than the manifest's own block.
  That is how a lossless transform is accepted without being allowed to vouch
  for itself — see the transform rule in [§3.1](#31-content-claims-and-the-transform-rule).
  `--emit-fingerprint` refuses to run under `--sample` / `--skip-decode`: a
  capture from a subset understates the content, and an understated expectation
  is a check that cannot fail.

- **declared bounds containment** (check 13) — `metadata.bounds` MUST **contain**
  every vertex the archive decodes to, and `metadata.z_range` (when declared)
  the decoded vertical extent. The validator recomputes both from the same
  decode pass check 12 rides and compares them.

  The direction is asymmetric and that asymmetry is the rule. A declared box
  that is too **small** is silent data loss at **query** time: tile selection,
  frustum pre-culling and the opening camera all pre-intersect a query box
  against `metadata.bounds`, so an under-stated box makes them discard tiles
  that really do carry visible data, with no error anywhere in the stack. A
  declared box that is too **large** keeps every reader sound — it merely costs
  a fetch and opens the camera wide — so it is at most a warning, and only on a
  full decode (a sampled decode is _expected_ to be narrower).

  Severity mirrors the fingerprint's: an **error** when the archive _attests_
  vertex-derived bounds — it carries a `content_fingerprint`, or a
  `bounds_mode = vertex` entry in `metadata.properties` — and a **warning that
  names the rebuild as the fix** otherwise, because every archive published
  before the vertex-bounds writer carries the centroid bbox, which under-states
  the extent of every non-point geometry by construction. Four narrowings keep
  the check from firing on honest archives: the `stt:quant` step the wire
  carries is admitted as slack; an escape explained entirely by the writer's
  null-island `(0,0)` sentinel policy (which `metadata.bounds` excludes and the
  fingerprint's bbox includes) warns rather than fails; a **wrapped**
  antimeridian longitude interval (`min_lon > max_lon`) is not decidable against
  an unwrapped decoded bbox, so that axis is skipped with a warning rather than
  guessed at (the reference writer never emits one — a straddling dataset gets
  the loose _unwrapped_ interval instead, pinned by
  `antimeridian_crossing_yields_a_loose_unwrapped_bbox_that_still_contains_everything`,
  `crates/stt-build/tests/vertex_bounds_multi_tile.rs`); and an escape explained entirely by
  the builder's **antimeridian split** — which synthesises vertices at exactly
  ±180 that the source-vertex fold behind `metadata.bounds` never saw — warns,
  under the three conditions the **antimeridian note** below spells out.

> **The invariance rule applies here too, and harder.** A fingerprint is a
> statistic of the dataset **domain** — computed once, dataset-globally, over
> the source features before tiling — never of whichever tiles a run happened to
> sample. `--sample` weakens the _comparison_ (containment instead of equality);
> it must never weaken the _quantity_, and no per-tile shortcut may recompute a
> "local" fingerprint to compare against. That is the same rule the drift
> classifier above obeys, for the same reason: a sample-dependent claim is not a
> claim about the archive. Only **replication-invariant** statistics are
> admissible in the block at all — a feature lands in N tiles (zoom pyramid,
> clipping, temporal LOD), so min/max and distinct counts survive tiling
> unchanged while sums and means do not.

> **What check 13 still does NOT cover — both gaps are the antimeridian.**
> Containment now has a validator behind it (check 13 above) and the reference
> builder now _declares_ the honest vertex box by default
> (`default_bounds_mode_is_vertex_since_the_r1_rebuild`,
> `crates/stt-build/src/input.rs`), so the two caveats that used to live here are
> gone. Two narrower ones replace them, and both were measured against the real
> tiler rather than assumed:
>
> - **A seam escape is downgraded to a warning, by design.** `stt-build` splits
>   a ±180°-crossing ring and synthesises vertices at exactly ±180 that the
>   source never carried, while `metadata.bounds` is a plain unwrapped min/max
>   over the _source_ vertices — so a polygon reaching 178°E and 178°W declares
>   `[-178, 178]` and decodes to `[-180, 180]`. That is correct writer behaviour
>   producing a real containment failure, so check 13 reports it as a warning
>   naming the seam instead of failing the archive. The relaxation is scoped by
>   three conditions — no latitude escape, every escaping longitude edge landing
>   _on_ ±180 within the wire's quantization step, and a declared interval
>   already wider than 180° — so a compact archive whose tiles decoded to the
>   world edges (the scrambled-coordinate class) still errors. Pinned by
>   `antimeridian_seam_split_escape_warns_rather_than_failing` and
>   `the_seam_exemption_is_scoped_to_the_seam_and_nothing_else`
>   (`crates/spatiotemporal-tiles/src/bin/stt-validate/fingerprint.rs`), against
>   the builder-side measurement in
>   `seam_split_synthesises_pm180_vertices_the_declared_source_bbox_cannot_contain`
>   (`crates/stt-build/tests/antimeridian_polygon.rs`). The durable fix is at the
>   writer: widen the declared longitude interval to the full `[-180, 180]` when
>   the source straddles ±180.
> - **A seam-crossing LINE is invisible to check 13.** Lines are not split at
>   the seam — `clip_trajectory` ends the run at the `|Δlon| > 180°` edge and
>   never emits that edge — so the decode stays strictly _inside_ the declared
>   source bbox and containment passes while geometry is missing. The loss is
>   uncounted (`TileStats::antimeridian_fallbacks` covers the polygon
>   dead-letter only). Pinned, as a known gap rather than a fixed one, by
>   `a_seam_crossing_line_loses_its_crossing_edge_instead_of_being_split` and
>   `a_two_vertex_seam_crossing_line_dead_letters_into_one_tile_uncounted`
>   (`crates/stt-build/tests/antimeridian_polygon.rs`).
>
> For both, `stt-optimize export`'s bbox — the comparison a human used to find
> the 106-archive defect — remains the manual cross-check.

For a **paged** directory it additionally runs `verify_paged_structure`: every
leaf descriptor's bounds (geo bbox, zoom range, `[t_min, t_max]`) **cover** the
leaf's entries (so a prune never drops a matching tile), and cross-page key order
is monotonic.

```bash
stt-validate data/earthquakes            # full check
stt-validate data/earthquakes --sample 200 --json   # sampled, machine-readable
stt-validate data/earthquakes --skip-decode         # integrity/hashes only

# accepting a lossless transform against the archive as it was BEFORE it
stt-validate before/ --emit-fingerprint   truth.json
stt-validate after/  --expect-fingerprint truth.json
```

A dataset that passes `stt-validate` with no errors satisfies the integrity,
addressing, schema, temporal (interval sanity, `time_end` tightness), payload
self-description (`stt:quant` / vertex-time metadata), summary cell-id, and
(for paged) covering invariants of the spec — **and, when it declares a
`content_fingerprint`, the semantic invariants too**: its decoded coordinates,
vertical extent, per-column ranges and cardinalities are the ones the manifest
claims. Without a fingerprint the same clean report certifies structure only;
the run says so, in a warning and in `fingerprint_checked: false`, and a reader
of the report must not upgrade that to a content guarantee. The one invariant a
clean report never certifies is `metadata.bounds` containment (see the note
above).

The full numbered list — checks 1–12, cited as "check N" in reports and reviews
— lives in the `stt-validate` module doc and is restated in
[`docs/api/cli-reference.md`](../api/cli-reference.md); the three numberings are
pinned against each other by
`validator_check_numbering_agrees_across_the_documents`
(`crates/stt-core/tests/spec_conformance.rs`).

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
  the parsed report. The file's convention is **one deliberately broken archive
  per named check**, so a check that cannot fail is visible as a missing
  negative. `every_encoder_payload_shape_passes_the_validator` builds one
  archive carrying a two-part holed polygon (`part_offsets`), a 3-day track
  (`UInt32` `vertex_time`) and quantized vertex values, then re-decodes it to
  prove each shape really reached the wire — a clean report proves nothing if
  the corpus stopped producing the shape. Check 12's negatives are
  `fingerprint_catches_scrambled_coordinates` (the recorded 106-archive
  regression class, encoded as a test),
  `sampled_fingerprint_still_catches_out_of_bbox`,
  `fingerprint_catches_scaled_property_column` and
  `expect_fingerprint_accepts_identical_and_rejects_mutated`, against the
  positives `honest_fingerprint_passes_full_and_sampled` and
  `absent_fingerprint_warns_but_never_fails`.
- `crates/stt-core/src/metadata.rs` unit tests — the fingerprint comparison
  itself, below the CLI: containment-vs-equality mode selection
  (`containment_always_equality_only_on_full_decode`), an escaping vertex
  failing even under a sample (`escaping_vertex_is_an_error_even_when_sampled`),
  capability gating (`tolerance_without_its_capability_is_rejected`,
  `on_wire_quant_step_is_admitted_as_slack`), accumulator order-independence
  (`accumulator_merge_is_order_independent`), and the recorded defect shape
  reproduced directly (`stride_two_xyz_fold_escapes_the_declared_bbox`).
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
  metadata keys). It also carries the **manifest** half of the same lock:
  `metadata_honesty_blocks_match_the_published_schema` validates a populated
  `content_fingerprint` / `z_range` / `ordering_workload` against
  `manifest.schema.json` **and** fails on any key the Rust type emits that the
  schema has not declared (the direction a reader-side validator can never
  check); `honesty_blocks_are_absent_from_a_legacy_metadata` pins that an unset
  block is omitted rather than null-filled, so pre-field manifests keep their
  bytes; `validator_check_numbering_agrees_across_the_documents` pins §2.3, the
  CLI reference and the validator's module doc to one numbering.
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
  (`format: "stt-packed"`, `formatVersion: 3`, `directory.directoryVersion: 6`);
- declare the required `variants` registry, including `{id: 0, kind: "raw"}`,
  and qualify every directory entry with a declared `variant_id`;
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
- emit a v6 directory: delta + zig-zag varint key columns, blob-run RLE, the
  per-run `pack_id` column, pack-relative offset contiguity, and the optional
  covering section (emitted iff _every_ entry has a covering bound);
- tag every `geometry` field with `ARROW:extension:name` =
  `geoarrow.{point,linestring,polygon}` (and, unquantized, the CRS84
  `ARROW:extension:metadata`);
- compute `metadata.bounds` from geometry **vertices** — the quantity tiles are
  addressed by — never from feature centroids: the declared bbox MUST contain
  every vertex the archive decodes to. A centroid-derived box provably
  under-states the extent of any geometry wider than a point, and everything
  that pre-intersects a query box against `metadata.bounds` (tile selection,
  frustum pre-culling, an opening camera) is unsound on such an archive — it can
  discard tiles that really do carry visible data. Likewise `metadata.z_range`,
  when declared, MUST contain every altitude the archive decodes to. This is a
  MUST newer than the deployed fleet, exactly like the CRS84 tagging above:
  see §3.1 for what enforces it and what does not. ⚠️ **The reference writer
  does not yet satisfy it across the ±180° seam** — it folds min/max over the
  _source_ vertices while the tiler synthesises seam vertices at exactly ±180,
  so a seam-crossing non-point dataset declares a box 2°-ish short of its own
  output. That is a known, measured gap with a warning (not an error) behind it;
  §2.3's antimeridian note states the shape and the writer-side fix;
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

A conformant **formatVersion-3** writer additionally **MUST**
([packed-format §§3.2, 5.2, 9.2](./stt-packed-format.md)):

- prefix every `.sttp` object with the 8-byte `STTP` magic prelude and every
  `.sttd` object with `STTD` (version byte 3, reserved bytes zero), with
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
  `formatVersion: 3` dataset opens with the `0xFFFF` escape, and readers
  hard-error on anything else rather than guessing at an older frame shape;
- when emitting a paged directory, publish `directory.rootHash` and the ordered
  `directory.pageHashes` array over the exact at-rest frame bytes, with one
  page hash per root descriptor.

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
  fetch directory bytes proportional to the viewport;
- emit `metadata.content_fingerprint` (version 1), computed from the **source
  features before tiling and encode** — the semantic claim check 12 verifies.
  SHOULD rather than MUST: a third-party writer without one stays conformant and
  the validator degrades to a warning, mirroring the CRS84 precedent. A writer
  that emits one MUST compute it pre-tiling: recomputing it from its own tiles
  proves only that the tiles agree with themselves (§3.1);
- emit the additive `metadata.z_range` when any vertex — or a property column
  the build declares as its elevation source — carries altitude. Metadata only:
  declaring an elevation column here does not rewrite geometry;
- record, alongside `blobOrdering`, the workload model the layout was chosen
  under (`orderingWorkload`, and its `metadata.ordering_workload` mirror),
  including the range-coalescing gap the writer's cost model priced it at.
  `blobOrdering` alone says _what_ the layout is; it cannot say whether the
  layout is still optimal, because a re-fit of the query weights or a change to
  the reader's coalescing gap invalidates a simulated layout without moving a
  single archive byte. Informational, never a reader directive.

### 3.1 Content claims and the transform rule

Four manifest fields are unlike the rest of the envelope. `metadata.bounds`,
`metadata.z_range` and `metadata.content_fingerprint` do not describe the
container; they **assert something about the data inside it**. (The fourth,
`orderingWorkload`, asserts something about the assumptions the layout was
priced under.) A claim is only worth having if it is true, so this section
states each obligation, and — because a MUST nothing executes is prose that
rots — names exactly what enforces it and what does not.

**The transform rule.** A tool that transforms an archive **losslessly** —
reorder, repack, re-optimize — **MUST** carry `metadata.content_fingerprint`
through **verbatim**, and **MUST NOT** recompute it from its own output.
Recomputing is precisely how a corrupting transform self-certifies: the tool
fingerprints its own scrambled output, the numbers agree with themselves, and
the archive validates. That is not hypothetical — a v1→v2 sweep that re-read
3D `xyz` coordinate leaves with a stride of 2 flattened and scrambled 106
archives, and a recomputing fingerprint would have blessed every one. Acceptance
for such a transform is therefore never "the output validates"; it is

```bash
stt-validate <before> --emit-fingerprint   truth.json   # capture from the TRUSTED input
stt-validate <after>  --expect-fingerprint truth.json   # hold the output to it
```

A transform that legitimately changes content (a re-quantization, a tier drop)
is **not** a lossless transform, and must be rebuilt from source rather than
re-stamped.

**Readers need nothing new.** All four fields are additive metadata, and §4's
"ignore unknown fields at every manifest envelope level" already covers them.
None of them re-types a tile column, so none of them is a capability — §3's
capability rule explicitly exempts additive metadata.

#### Rule → the test that enforces it

| obligation                                                                | enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MUST** — declared `bounds` (and `z_range`) contain every decoded vertex | ✅ **writer and validator.** Writer: `vertex_bbox_is_a_conservative_superset_of_every_vertex_and_of_the_centroid_box`, `null_island_sentinel_features_are_excluded_from_both_bboxes`, `z_range_comes_from_three_element_positions` (`crates/stt-build/src/input.rs`) pin the honest computation; `default_bounds_mode_is_vertex_since_the_r1_rebuild` (same file) and `the_shipped_default_is_the_honest_quantity` (`crates/stt-build/tests/vertex_bounds_multi_tile.rs`) pin that it is what the reference builder now **declares by default**, with `--bounds-mode centroid` the documented rollback; `long_lines_declare_bounds_that_contain_every_decoded_vertex` and `centroid_bounds_would_lose_data_on_the_same_fixture` (same file) prove containment end to end through the tiler. Validator: check 13 recomputes containment from the decode — `wrong_hemisphere_declared_bounds_fails`, `understated_bounds_warn_on_legacy_and_fail_once_attested`, `honest_declared_bounds_pass_full_and_sampled` (`crates/spatiotemporal-tiles/tests/validate_cli.rs`). ⚠️ Two antimeridian gaps remain — see §2.3's antimeridian note. |
| **MUST** — a lossless transform carries the fingerprint verbatim          | `expect_fingerprint_accepts_identical_and_rejects_mutated` (`validate_cli.rs`) enforces the _acceptance_ half: a mutated copy fails against a captured truth. ⚠️ Nothing tests that a transform tool **preserves the key**, because no in-repo tool rewrites an archive today — the one that did (`reoptimize`) was deleted after the incident. Any successor lands with that test, or the rule is unenforced again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **SHOULD** — emit `content_fingerprint` v1, computed pre-tiling           | `built_archive_declares_a_fingerprint_that_validates` (the end-to-end build→validate loop) and `fingerprint_is_byte_identical_across_builds_and_survives_quantization` (`validate_cli.rs`); `content_fingerprint_is_order_independent_and_reproducible` (`input.rs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| check 12's comparison semantics (containment vs equality, severity)       | `containment_always_equality_only_on_full_decode`, `escaping_vertex_is_an_error_even_when_sampled`, `numeric_column_containment`, `unknown_fingerprint_version_warns_and_skips`, `distinct_count_drift_warns_with_its_error_bound` (`crates/stt-core/src/metadata.rs`); `honest_fingerprint_passes_full_and_sampled`, `absent_fingerprint_warns_but_never_fails`, `sampled_fingerprint_still_catches_out_of_bbox` (`validate_cli.rs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| a tolerance without its capability is rejected                            | `tolerance_without_its_capability_is_rejected`, `on_wire_quant_step_is_admitted_as_slack` (`metadata.rs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| the recorded regression class stays caught                                | `stride_two_xyz_fold_escapes_the_declared_bbox` (`metadata.rs`, the defect shape in isolation) and `fingerprint_catches_scrambled_coordinates` (`validate_cli.rs`, end to end through the binary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **SHOULD** — emit `z_range` when altitude is present                      | `z_range_roundtrips_through_json`, `z_range_field_omitted_when_unset`, `z_range_is_normalised_and_refuses_non_finite`, `tilejson_bounds_stay_four_elements_with_a_z_range_declared` (`metadata.rs`); `six_element_bbox_when_a_z_range_is_declared` / `four_element_bbox_when_no_z_range_is_declared` (`crates/stt-build/src/stac.rs`); `elevation_column_folds_into_the_z_range` (`input.rs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **SHOULD** — record the workload a `blobOrdering` was priced under        | `ordering_workload_is_omitted_unless_the_ordering_was_simulated`, `manifest_records_the_ordering_workload_at_both_pinned_keys` (`crates/stt-core/src/pack/mod.rs`); `recorded_workload_drift_is_flagged_including_the_reader_gap` (`crates/stt-optimize/src/order_audit.rs`); `default_measured_build_validates_and_records_its_ordering_and_workload` (`validate_cli.rs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| the wire shape of all four blocks                                         | `metadata_honesty_blocks_match_the_published_schema`, `honesty_blocks_are_absent_from_a_legacy_metadata` (`crates/stt-core/tests/spec_conformance.rs`, writer side); the `manifest honesty blocks (M7)` suite in `packages/core/test/manifest-schema.test.ts` (reader side, incl. wrong-arity bbox, malformed per-column maps, non-integer `coalesce_gap_bytes`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| the two `orderingWorkload` copies stay identical                          | `manifest_records_the_ordering_workload_at_both_pinned_keys` (values) and `the two ordering-workload copies are pinned to the SAME shape` (schema declarations).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

#### Reference-writer status (2026-08)

A conformance document that describes intentions rather than shipped behavior is
the failure mode this table exists to prevent, so:

- **`content_fingerprint` is opt-in.** The reference builder emits it only under
  `stt-build --content-fingerprint`; the key is absent from every published
  archive. The validator's absent-key path is therefore the normal path today,
  and is permanent, not transitional.
- **`metadata.bounds` is vertex-derived by default (flipped in rebuild window
  R1).** `DEFAULT_BOUNDS_MODE` is `BoundsMode::Vertex`, `stt-build --bounds-mode
{vertex,centroid}` selects it explicitly, and the choice is stamped into
  `metadata.properties.bounds_mode` — the exact key and `vertex` spelling
  `stt-validate`'s check 13 reads as an _attestation_, pinned on both sides by
  `bounds_mode_manifest_stamp_matches_the_validator_contract`
  (`crates/stt-build/src/input.rs`) and
  `the_manifest_records_which_quantity_bounds_came_from`
  (`crates/stt-build/tests/vertex_bounds_multi_tile.rs`). The legacy centroid box
  is the documented rollback, not a deleted path, and an archive built without
  the stamp stays unattested so the pre-R1 fleet is not turned red. Flipping the
  default widens manifest values fleet-wide, which is why it rode one scheduled
  rebuild window rather than dribbling across the fleet.
- **`metadata.z_range` is written when the source carries altitude.** The
  builder folds the pre-tiling profile's vertical extent into the manifest, and
  the field stays absent — byte-invisibly — for a 2D source:
  `z_range_is_declared_only_when_the_source_carried_altitude`
  (`crates/stt-build/tests/vertex_bounds_multi_tile.rs`) pins both halves, over
  the same `profile_features_with` → `Metadata::with_z_range` path the CLI uses.
  ⚠️ A build using `--point-elevation-column` must pass that column to the
  profiler too (the encoder folds it into point `z` long after the profile runs)
  — `elevation_column_folds_into_the_z_range` (`crates/stt-build/src/input.rs`).
- **`orderingWorkload` is emitted only for a SIMULATED ordering** — a `measured`
  build with enough tiles to simulate — not for every archive that carries a
  `blobOrdering`. Presence/absence is itself the signal: absent means the
  layout's provenance is unknown, and a consumer must not assume a gap. It is
  written at two keys (top-level, and a `metadata.ordering_workload` mirror)
  because the shipped TS reader resolves the build-assumed gap through the
  mirror; the mirror is scheduled for removal once the reader moves.

## 4. Conformant **reader** requirements

A conformant reader **MUST**:

- **reject** an unrecognized `format`, `formatVersion`, or `directoryVersion`
  (refuse, don't guess);
- reject manifest object keys outside the exact relative
  `index/<32-hex>.sttd` / `packs/<32-hex>.sttp` shapes before resolving or
  fetching them;
- **refuse** a dataset whose `manifest.capabilities` declares a feature the
  reader does not implement, naming the unknown entries (a capability re-types
  existing columns, so proceeding is silent misdecode — not an error later);
- **ignore unknown fields** at every manifest envelope level (additive evolution);
- support **both** directory layouts — whole-load (`single`/absent) and `paged`
  (root page + on-demand leaf fetches), including the small-directory whole-load
  shortcut;
- verify every partial paged-directory range against `rootHash` /
  `pageHashes`; an older paged v2 manifest without those hashes must use the
  whole-load path and verify the complete object's content address;
- validate the fetched directory body length against `directory.length` before
  decoding, and unwrap `directory.encoding` when set;
- bound every tile decompression by its directory-declared
  `uncompressed_size`, and bound directory page decompression before allocating
  attacker-controlled counts;
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

A conformant reader that accepts **formatVersion 3** additionally **MUST**:

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

- **verify the CRC32C** of each blob before decompression (both reference
  readers do);
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
golden fixtures to byte-identical results. A writer that also makes the content
claims of [§3.1](#31-content-claims-and-the-transform-rule) demonstrates those
by (c) passing a **full-decode** run — `stt-validate <dataset>` with no
`--sample` — since only a full decode compares its fingerprint for equality
rather than containment.
