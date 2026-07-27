---
'@poopdeck.gl/core': minor
---

Tile payloads are re-encoded — rebuild and republish every archive

Six wire changes land as **one** churn event, on purpose: content addresses are
blake3 of the bytes, so batching them means the fleet re-uploads once instead of
six times. `formatVersion` stays `2` — every change either rides a
`manifest.capabilities` declaration or is strictly additive, so the envelope,
object layout and addressing rules are untouched.

**What you have to do.** Rebuild each archive with the 0.6.0 `stt-build` and
re-upload it. Every pack hash changes even for archives already on
`formatVersion: 2`, so this is a full re-upload rather than a delta — use
`--no-prune` and let the retention window pass before deleting the old objects.

**Reader/writer compatibility.** A default 0.6.0 archive declares the new
`time-delta` capability, and a 0.5.x reader refuses any capability outside its
own set **at open** — "dataset requires capabilities this reader does not
implement" — rather than misdecoding the re-typed columns. So the failure is
loud in the direction that matters: an old client will not silently read
millisecond offsets as absolute Unix times. A
0.6.0 reader opens every 0.5.x archive unchanged. `stt-build --no-compact-times`
suppresses the capability if you need to serve readers you do not control.

**The six changes**

- **Arrow IPC buffer alignment 64 → 8 bytes** (unconditional). 8 is what the
  Arrow IPC spec requires; 64 is a SIMD _recommendation_ arrow-rs defaults to.
  Refunds a fixed 445–1300 B per tile blob — −4.0% uncompressed on
  110-feature event tiles, and it halves one-feature property sections.
- **Compact feature times** (`TILE_META.st`/`.et`, capability `time-delta`,
  **on by default**). `start_time` becomes a `UInt32` offset from the tile's
  `t0`, `end_time` a `UInt32` duration — or is dropped entirely when every
  feature is instantaneous. −13.1% uncompressed on an all-instantaneous corpus.
  This is a decode/memory lever, **not** a wire lever: sorted absolute `Int64`
  compresses better, so packed bytes go _up_ ~3% on that corpus. It buys
  uncompressed size and removes a `Number(BigInt)` per feature on the JS side.
  Kill switch: `--no-compact-times`.
- **`vertex_time` as `List<UInt32>`** (unconditional) — −14.25% uncompressed on
  a 20-hour track corpus, same compressed-vs-uncompressed trade as above.
- **`part_offsets`** (additive column, emitted only for multi-part layers) —
  per-feature ring boundaries, so a MultiPolygon's parts survive the round trip.
  +7.40 B/feature where emitted, zero bytes on single-part datasets.
- **`--quantize-vertex-values`** (opt-in, capability `vertex-value-quant`).
  Stores `vertex_value` / `vertex_value_matrix` as `UInt16` under a per-column
  affine — **exactly half** those columns' bytes, which is −48.2% of _all_
  uncompressed tile bytes on a corridor dataset. Off by default because it is
  genuinely lossy.
- **Exact-integer attribute quantization** (fixes `--quantize-attrs-auto`;
  `attr-quant` is unchanged). An integer column now round-trips exactly instead
  of being mapped onto a fractional `span/65535` step. This was silently
  decoding OSM node ids ~84k off. Columns whose magnitude exceeds `i32::MAX`
  refuse quantization and stay `Float64`; the test is on magnitude, not on
  span, so the same column cannot ship `UInt16` in one tile and `Float64` in
  the next.

**Two builder bugs fixed in the same pass**

- MultiPolygon parts were earcut as one ring list, i.e. parts 2..n were bridged
  as holes of part 1 — wrong on every multi-part feature in the probe corpus.
  The trigger is not exotic: the tiler emits a MultiPolygon whenever clipping
  cuts one source polygon into pieces inside a tile. Single-part polygons are
  byte-identical before and after.
- Unreadable geometry was replaced with fabricated placeholders (a single-point
  "line", a one-vertex "ring"). It is now dropped and counted, so
  `metadata.feature_count` for affected sources goes **down** — and becomes
  honest.

`stt-serve` keeps compact times **opt-in** (`--compact-times`): a served tile
carries no manifest, so a client cannot refuse a capability it has never been
told about. Rationale and full measurements:
`docs/roadmap/stt-packed-format-decisions.md` §10.
