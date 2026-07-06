# @poopdeck.gl/core

## 0.4.0

### Minor Changes

- Packed formatVersion 2 reader: manifest-embedded schema templates
  (blake3-validated at open, distributed to decode workers on every spawn),
  layer-frame v2 with sectioned payloads + TILE_META, splice guards that
  fail loudly instead of silently emptying tiles. v1 archives decode
  byte-for-byte as before.
- Integrity: CRC-32C verification of every fetched blob (default on,
  `verifyChecksums: false` to disable) with poisoned-cache eviction and
  per-tile isolation; pure-TS blake3.
- `manifest.capabilities` must-understand gate: datasets declaring unknown
  capabilities are refused loudly at open.
- `retainArrowIpc: 'auto'` (default) drops raw IPC bytes only for
  coordinate-quantized layers; `toGeoArrowTable()` keeps working wherever
  its output is valid GeoArrow.
- Temporal-LOD addressing: `TileId.bucketMs` disambiguates pyramid tiers
  from base tiles across every cache key.
- Scrub-LOD hooks: `scrubLod` tileset option (spatial zoom-drop and/or
  temporal-pyramid routing while scrubbing; default off).
- Honest cache accounting: `estimateTileSize` deduplicates aliased buffers —
  zero-copy datasets now genuinely fill `maxCacheByteSize` where they
  previously plateaued around half.

## 0.3.0

### Minor Changes

- Reader-side style hints. Add `parseStyleHints` and `suggestedDomainFor`, plus
  the `StyleHints` / `PropertyStyleHint` types, so an archive can carry render
  defaults (color domains, property roles) that the layers consume.

## 0.2.0

## 0.1.1

### Patch Changes

- Correct the published READMEs: the 0.1.0 tarballs still carried the
  pre-release "Not yet published to npm — consume it from the monorepo"
  banners. Install sections now lead with the real `npm install` commands.
