# Glossary and naming

Use these terms consistently in code, documentation, issues, and releases.

| Term                           | Meaning                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SpatioTemporal Tiles (STT)** | The format and overall toolkit. Use “STT” after the first expansion.                                                                                                                                             |
| **poopdeck.gl**                | The TypeScript rendering ecosystem and public showcase. Preserve lowercase spelling.                                                                                                                             |
| **`spatiotemporal-tiles`**     | The published Rust umbrella crate. It installs five CLIs: `stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`, `stt-serve`.                                                                                |
| **`@poopdeck.gl/*`**           | The npm package family. Seven packages are currently public; Cesium is private and experimental.                                                                                                                 |
| **archive / dataset**          | A complete STT publication rooted at `manifest.json`. The normal static representation is a directory tree.                                                                                                      |
| **manifest**                   | The mutable JSON entry point and authoritative declaration of dataset metadata, time, variants, directory, and packs.                                                                                            |
| **`formatVersion`**            | The packed **container** version in the manifest — currently `3`. `stt-serve` reuses the key name for the **layer-frame** version (`2`); they are separate axes.                                                 |
| **capabilities**               | The manifest's must-understand list (`manifest.capabilities`): a reader MUST refuse an archive declaring one it does not implement. Distinct from a renderer backend's capabilities (below).                     |
| **directory**                  | The binary index mapping tile addresses to byte ranges in packs, stored at `index/<blake3>.sttd`. Current writers use codec v6. Always “the directory” — `index/` is only the path prefix.                       |
| **pack**                       | An immutable, content-addressed `packs/<blake3>.sttp` object containing compressed tile blobs.                                                                                                                   |
| **tile blob**                  | One tile's independently zstd-compressed bytes. A blob is the compressed unit; a pack is the object that stores many of them.                                                                                    |
| **blob ordering**              | The space-filling order the writer laid blobs down in, recorded in `manifest.blobOrdering` (`spatial`, `time-major`, `hilbert3`, `morton3`).                                                                     |
| **tile address**               | `(zoom, x, y, time-bucket, variant)` in the current packed format.                                                                                                                                               |
| **time bucket**                | A fixed-width interval used as the temporal part of a tile address. Prose says “time bucket”; the flag and field are `--temporal-bucket` and `temporal_bucket_ms`.                                               |
| **tile payload / layer frame** | The decompressed tile blob: a sectioned envelope carrying one or more named layers, each with an Arrow IPC core batch, an optional props batch, and per-tile metadata. Versioned on its own axis (currently v2). |
| **schema template**            | A layer's Arrow IPC schema, factored out of every frame and published once in `manifest.schemas` under its blake3-128 hash; a v2 frame carries a 16-byte reference to it.                                        |
| **layer**                      | One named data stream inside a layer frame. The manifest lists them in `metadata.layers`; a variant names its canonical one in `layerName`.                                                                      |
| **variant**                    | A named data representation within an archive: `raw` (variant 0) or `summary` (variant 1).                                                                                                                       |
| **raw tier**                   | Full-fidelity feature data. Default builds preserve every usable feature.                                                                                                                                        |
| **summary tier**               | An opt-in H3 or Quadbin coarse-zoom aggregation stored alongside the raw tier.                                                                                                                                   |
| **temporal LOD**               | Additional, coarser time buckets used for long windows or low zooms.                                                                                                                                             |
| **sidecar asset**              | A time-indexed, non-tile file — telemetry, camera keyframes, scene JSON — composed with one or more archives by the scene-bundle profile.                                                                        |
| **tileset**                    | The reader-side object that turns a viewport plus a time window into tile requests against one archive (`SpatioTemporalTileset`).                                                                                |
| **playback governor**          | The component that couples the playback clock to the loader's buffered runway, pausing rather than advancing through unloaded time (`PlaybackGovernor`).                                                         |
| **runway**                     | The span of contiguous, already-buffered time ahead of the playhead. The governor pauses when it runs out.                                                                                                       |
| **layer kind**                 | One of the renderer's visualization families (`LayerKind`: `point`, `path`, `polygon`, …) — a rendering choice, not the format's **layer**.                                                                      |
| **backend capability**         | A cross-cutting renderer feature a backend either has or degrades (`Capability`: `globe`, `picking`, …). Not the manifest's `capabilities`.                                                                      |
| **`.sttb` bundle**             | Optional single-file interchange container created by `stt-bundle`; not the primary CDN layout.                                                                                                                  |
| **`.stt`**                     | An internal build intermediate, never a deployment artifact; `stt-validate` refuses it.                                                                                                                          |
| **`stt-generate`**             | Repository-only CLI for rebuilding bundled showcase datasets. It has its own workspace under `tools/stt-generate`.                                                                                               |

## Identifier spelling

Prose uses **spatiotemporal** as one lowercase word unless it begins the proper
name **SpatioTemporal Tiles**. Code identifiers follow their exported spelling,
for example `SpatioTemporalTileset` and `SpatioTemporalLayer`. The lowercase-`t`
`Spatiotemporal*` aliases in `@poopdeck.gl/core` are deprecated back-compat
exports: never write them in prose and never add new ones.

`STTPointLayer` (flat billboards) and `STTPointCloudLayer` (lit 3-D points with
optional normals) are two distinct classes with distinct pick tags. The flat
kind was renamed **out of** the old `STTPointCloudLayer` name with no alias, so
an old reference to it is wrong rather than merely dated.

Use **pack**, **directory**, and **archive** for the current packed layout.
Avoid calling an archive “the STT file”; that wording confuses the normal
directory layout with the optional `.sttb` bundle and the internal `.stt`
intermediate.

The [packed-format specification](../spec/stt-packed-format.md) owns normative
wire terminology. The [status page](./status-and-support.md) owns the concise
public package and compatibility summary.

This page is authored in the SpatioTemporal Tiles repository and vendored into
poopdeck.gl by `pnpm stt:sync`. Do not edit the copy there.
