---
'@poopdeck.gl/core': minor
---

Packed format v1 is gone; the reader is single-version

Through 0.5.x the reader accepted two packed formats: the transitional 0.3.x
layout (`formatVersion: 1` — no object magic, the old layer frame, no manifest
`schemas` table) and the current one. That second path existed only to keep
already-published archives readable while they were migrated. They have been,
so it is removed.

**What this means for you**

- A `formatVersion: 1` archive no longer opens. `STTArchive` fails at open with
  `unsupported formatVersion 1 (expected 2)` rather than half-decoding it.
  Rebuild the archive with current `stt-build`.
- The published `manifest.schema.json` pins `formatVersion` to the closed enum
  `[2]`.
- `stt-serve` now emits the current layer frame (self-contained, schema inline)
  and advertises `formatVersion` on `/metadata.json`, so a client can tell what
  it is being served before it fetches a tile.

Everything a current archive does is unchanged — this only removes the ability
to read the retired one.

**Also removed**

- `ArchiveOptions.verifyChecksums`. Blob CRC-32C verification is now
  unconditional; the escape hatch existed for the rollout and cost far less
  than the zstd decode it guards.
- The shared request scheduler's `enabled` flag and the per-archive fallback
  runner it selected. Every archive routes through the process-shared
  scheduler; `configureSharedScheduler({ maxRequests })` still re-tunes the
  global budget.
- `ArchiveOptions.cache` and `ArchiveOptions.maxCacheSize`, which nothing read.
- `@poopdeck.gl/cesium`'s `Cesium*Layer` aliases (use the `STT*` spellings).
  That package is unpublished/experimental, so it carries no version of its own.
