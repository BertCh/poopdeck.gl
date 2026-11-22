---
'@poopdeck.gl/core': minor
---

Read `path-codec` archives: lossless predictor-coded LineString layers

`stt-build --path-codec` (opt-in, off by default and under `--auto`) stores a
LineString layer's coordinates and per-vertex times as per-feature predictor
residuals in a new layer-frame section (tag `0x06`, `PATH_CODEC`) instead of as
Arrow leaf buffers, and declares the must-understand manifest capability
`path-codec`. This reader now implements it: `KNOWN_MANIFEST_CAPABILITIES`
includes `'path-codec'`, and `decodeTile` rebuilds the layer's `geometry` and
`vertex_time` columns before anything downstream sees it.

**What consumers see.** Nothing new. A codec layer decodes to exactly the
columns a classic layer carries — the `Float64` coordinate leaf (decimal mode)
or the `stt:quant` `Int32` world-grid leaf, and `vertex_time` as absolute
`Int64` Unix ms — so `BinaryFeatures` and `toGeoArrowTable()` are unchanged in
shape, and no renderer backend changes. Vertex times are exact to the
millisecond, where the classic default form quantizes them to a per-tile step.

**Reader/writer compatibility.** A 0.8.x reader refuses a `path-codec` archive
at open ("dataset requires capabilities this reader does not implement")
instead of misdecoding its empty columns. Archives without the capability decode
exactly as before.

**Strictness.** Every rejection the wire spec lists (wrong version, reserved
flag bits, flags that disagree with the schema, unknown predictor tags, count
mismatches, `r >= U`, bad exception indices or patches, values that do not fit,
trailing bytes) throws an error naming the tile, the layer and the field; reads
never leave the section and allocations are bounded by its length.

`STTTileLayer` gains an optional `pathCodec` (a copy of the section, so a
worker-decoded layer can still be rehydrated by `toGeoArrowTable()`). It is
transferred with the tile and dropped with `arrowIpc` under
`ArchiveOptions.retainArrowIpc`.
