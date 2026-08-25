# Glossary and naming

Use these terms consistently in code, documentation, issues, and releases.

| Term                           | Meaning                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **SpatioTemporal Tiles (STT)** | The format and overall toolkit. Use “STT” after the first expansion.                                                  |
| **poopdeck.gl**                | The TypeScript rendering ecosystem and public showcase. Preserve lowercase spelling.                                  |
| **`spatiotemporal-tiles`**     | The published Rust umbrella crate. It installs the five `stt-*` CLIs.                                                 |
| **`@poopdeck.gl/*`**           | The npm package family. Seven packages are currently public; Cesium is private and experimental.                      |
| **archive / dataset**          | A complete STT publication rooted at `manifest.json`. The normal static representation is a directory tree.           |
| **manifest**                   | The mutable JSON entry point and authoritative declaration of dataset metadata, time, variants, directory, and packs. |
| **directory**                  | The binary index mapping tile addresses to byte ranges in packs. Current writers use codec v6.                        |
| **pack**                       | An immutable, content-addressed `.sttp` object containing compressed tile blobs.                                      |
| **tile address**               | `(zoom, x, y, time-bucket, variant)` in the current packed format.                                                    |
| **time bucket**                | A fixed-width interval used as the temporal part of a tile address.                                                   |
| **tile payload / layer frame** | The decoded per-tile Arrow IPC data, including GeoArrow geometry and properties.                                      |
| **variant**                    | A named data representation within an archive, such as raw, summary, or raster.                                       |
| **raw tier**                   | Full-fidelity feature data. Default builds preserve every usable feature.                                             |
| **summary tier**               | An opt-in H3 or Quadbin coarse-zoom aggregation stored alongside the raw tier.                                        |
| **raster tier**                | An opt-in coarse-zoom visualization stored alongside the raw tier; STT itself remains scoped to vector source data.   |
| **temporal LOD**               | Additional, coarser time buckets used for long windows or low zooms.                                                  |
| **`.sttb` bundle**             | Optional single-file interchange container created by `stt-bundle`; not the primary CDN layout.                       |
| **`stt-generate`**             | Repository-only CLI for rebuilding bundled showcase datasets. It has its own workspace under `tools/stt-generate`.    |

## Identifier spelling

Prose uses **spatiotemporal** as one lowercase word unless it begins the proper
name **SpatioTemporal Tiles**. Code identifiers follow their exported spelling,
for example `SpatioTemporalTileset` and `SpatioTemporalLayer`. Do not introduce
new `Spatiotemporal*` public identifiers.

Use **pack**, **directory**, and **archive** for the current packed layout. Avoid
calling an archive “the STT file”; that wording confuses the normal directory
layout with an optional `.sttb` bundle.

The [packed-format specification](../spec/stt-packed-format.md) owns normative
wire terminology. The [status page](./status-and-support.md) owns the concise
public package and compatibility summary.
