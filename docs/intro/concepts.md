# Core concepts

STT adds time to a spatial tile pyramid. A traditional vector tile is addressed
by `(zoom, x, y)`; an STT tile adds a fixed-width time bucket:
`(zoom, x, y, time-bucket)`.

This lets a reader request only the features relevant to the current viewport
and time window. The [time model](../spec/time-model.md) defines bucket
boundaries and interval semantics; the
[tile matrix set](../spec/tile-matrix-set.json) defines the spatial grid.

## The packed archive

A normal static STT dataset is a directory, not one large file:

```text
dataset/
  manifest.json
  index/<content-hash>.sttd
  packs/<content-hash>.sttp
```

- **`manifest.json`** is the small, mutable entry point. It declares metadata,
  time, capabilities, variants, the directory pointer, and pack table.
- **The directory** maps tile addresses to byte ranges in packs.
- **Packs** contain independently compressed tile blobs.

The directory and packs are named by their BLAKE3 content hashes. Changing
their bytes changes their names, so they can be cached as immutable objects.
Only the manifest needs a short cache lifetime. Readers fetch the manifest, the
directory or relevant directory pages, and coalesced HTTP ranges from the packs.

The archive layout and version rules are normative in the
[packed-format specification](../spec/stt-packed-format.md). A `.sttb` file is
an optional interchange bundle produced by `stt-bundle`; it is not the primary
CDN layout.

## Tile payloads

Each tile decompresses to one layer frame carrying one or more layers, whose
columns are encoded as Apache Arrow IPC. Geometry uses GeoArrow layouts, so
decoded columnar buffers can move efficiently into analysis tools and GPU
renderers. Compression, integrity checks, geometry encodings, and optional
quantization are defined in the
[tile-payload specification](../architecture/data-format.md).

The manifest is always the dataset contract. Applications should use its
declared layers, temporal metadata, variants, and capabilities instead of
guessing from filenames or sample tiles.

## Time and levels of detail

### Temporal bucketing

`stt-build` assigns features to fixed-width buckets such as an hour or a day.
The right bucket size depends on the source cadence and intended playback
window. Smaller buckets provide finer selection but create more tile addresses.
The [tuning guide](../guides/tuning-tiles.md) explains how to measure the
trade-off.

### Temporal LOD

An archive may include coarser time tiers, such as daily and monthly buckets,
for long-range views. Applications can select a coarser temporal level at low
zoom or across a long window, then return to the base tier for detailed
playback.

### Summary tiers

Very large datasets may add an H3 or Quadbin summary variant for coarse zooms
(`stt-build --summary-tier h3|quadbin`). These are explicit build options. They
supplement the raw feature tier and never authorize silent thinning, sampling,
or aggregation of that raw tier.

Default and `--auto` builds preserve every usable feature. To build to a size,
pass `stt-build --target-size 250MiB` — it solves for a recipe using only
reversible levers (zoom clamp, bucket width, temporal-LOD tiers, zstd level,
blob ordering, pack size) and never drops a feature to hit the number; see
[budget builds](../api/cli-reference.md#budget-builds-target-size). Expert
per-tile budgets remain opt-in and must report what they remove.

## Streaming and playback

The TypeScript reader combines the spatial viewport and visible time window to
select tiles. It groups nearby ranges, decodes tiles in workers where
configured, caches results, and prefetches a bounded runway ahead of playback.
Tiles already on the GPU are filtered by time uniforms rather than decoded and
uploaded on every animation frame.

See [Choosing STT](./choosing.md#playback-choice) for the player-vs-clock
decision.

## Build, serve, and render

```text
GeoParquet / PostGIS / DuckDB
            │
            ├─ stt-build ──> packed archive ──> CDN/static host
            └─ stt-serve ──> dynamic STT endpoint
                                      │
                                      v
                              STT archive reader
                                      │
                          renderer + playback clock
```

Static and dynamic delivery share the same manifest and tile semantics. The
[system overview](../architecture/system-overview.md) explains the complete
pipeline. See [Choosing STT](./choosing.md) for deployment and renderer
decisions.

## Canonical references

| Reference                                      | Owns                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| [Packed format](../spec/stt-packed-format.md)  | Manifest, directory, packs, versions, caching, bundles |
| [Tile payload](../architecture/data-format.md) | Layer frames, Arrow schemas, geometry and time columns |
| [Time model](../spec/time-model.md)            | Instants, intervals, buckets, temporal LOD, pruning    |
| [Conformance](../spec/conformance.md)          | Required reader/writer behavior and golden fixtures    |
| [CLI reference](../api/cli-reference.md)       | Commands, flags, defaults, and exit behavior           |
