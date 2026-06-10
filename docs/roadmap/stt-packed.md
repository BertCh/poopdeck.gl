# Packed format — roadmap / deferred work

The packed format is **adopted and live** (see
[`docs/spec/stt-packed-format.md`](../spec/stt-packed-format.md)). The items
below were deliberately **deferred** during the 2026-06 formalization pass — they
are architectural bets, not cleanup, and were not in scope. Recorded here so the
direction isn't lost.

## 1. Global content-addressed pack store

**Today:** each dataset owns its own `packs/` directory, so blake3 dedup only
fires *within* a dataset.

**Bet:** move packs into one shared, content-addressed store
(`/packs/<blake3>.sttp`) with per-dataset manifests pointing into it — the Git
object-store / Docker-layer model. The manifest's "`packs[]` index **is** the
`pack_id`" design already supports this: the index stays manifest-local; only the
`key` changes to point at the shared store.

**Unlocks:**
- **Cross-dataset / cross-version dedup** — shared basemap, summary, or
  near-duplicate tiles stored once. (Within-dataset dedup already shrank
  earthquakes 266 MB → 72 MB; cross-dataset is the next increment.)
- **Incremental deploys** — a rebuild that changes two tiles ships the one or
  two new packs, not the whole dataset. Re-sync skips unchanged content
  addresses for free.
- **A natural GC story** — a pack is collectible once no live manifest references
  its hash.

**Open questions:** GC / refcount policy; whether the store is per-origin or
per-deploy; cache-key implications (still immutable, so unaffected); how
`r2-sync.sh` enumerates the shared store vs per-dataset trees.

## 2. Streaming `PackWriter` (closes spec D3)

**Today:** the only reason the single-file `ArchiveWriter` / `write_tail` write
path still exists is that `stt-build --streaming-arrow` needs a bounded-RAM
intermediate, and `PackWriter` currently buffers all tiles in memory to compute
blob ordering before cutting packs.

**Bet:** a spill-to-disk streaming `PackWriter` that orders and cuts packs
without holding the whole tile set in RAM. Then `--streaming-arrow` can cut packs
directly, and the single-file **write** path (and the v4-only write code) can be
deleted outright — finally closing decision **D3** (currently "demoted, not
deleted"). The v4 **read** path stays for transcoding old archives.

**Open questions:** how to choose a good blob ordering with only a streaming
(not global) view — e.g. external-sort the directory keys, or a two-pass
build (index pass to decide ordering, payload pass to write packs).

## 3. Smaller follow-ups

- **`stt-optimize` packed awareness** — it still analyses GeoParquet and legacy
  single-file `.stt`; teach its loader to read a packed dataset so it can
  re-analyse shipped datasets directly.
- **Retire single-file measurement scripts** once (1)/(2) land —
  `scripts/optimize-tiles.sh` and `reprocess-run.sh` are single-file-only
  (now labelled LEGACY).
