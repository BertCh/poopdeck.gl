# Paged directory with temporal pruning — Wave 2 implementation plan

> **Status: PLANNED (design resolved, not started).** This is the focused-effort
> plan for rust-audit Wave 2's headline item: bounds + `[t_min, t_max]` on
> paged-directory page pointers (the COPC / GeoParquet-1.1 steal). It is a
> **wire-format change** touching `crates/stt-core` (writer + codec),
> `packages/core` (TS reader), the manifest contract, `stt-validate`, the
> transcode tool, and R2 deployment — it needs round-trip + cross-impl + browser
> verification, not a quick fan-out. Feasibility is already MEASURED VIABLE
> (`crates/stt-core/examples/directory-paging-sim.rs`); this doc turns that sim
> into a buildable design. Supersedes the "designed" sketch in
> [`stt-packed.md` §3](./stt-packed.md).

## 1. The wall this attacks

Today the `.sttd` directory is a **single whole-load blob** on the cold-start
critical path. The TS reader (`STTArchive.fetchAndBuildIndex`) does one
whole-object GET, decodes the *entire* v5 directory into `TileEntry[]`, and
builds two resident maps (`tileEntryIndex` by `z/x/y`, `tileEntryByKey` by
`z/x/y/t`). **Nothing can be requested until the whole directory is resident.**

Fresh sim numbers (2026-06-11, current packed data, 4096 entries/page):

| dataset (entries) | whole dir (zstd) | at-rest vs whole | viewport query bytes med / p90 (% of whole-load) |
|---|---|---|---|
| ais-all-us (560 K) | 7.7 MB | +19.1% | 70 KB / 137 KB (**0.9% / 1.8%**) |
| nyc-taxi-points (559 K) | 8.2 MB | +12.1% | 930 KB / 2.98 MB (11.4% / 36.5%) |
| drifters (256 K) | 2.4 MB | +6.7% | 622 KB / 1.57 MB (26.3% / 66.1%) |
| wildfires (1040) | 10.8 KB | +0.1% | 10.8 KB (**100%** → stays one page) |

Goal: **cold start proportional to the viewport/time-window footprint, not
dataset size.** A 15 MB directory becomes a few-KB root page + the handful of
leaf pages the session actually visits. Temporal pruning happens *before* any
leaf fetch. Small datasets stay a single read — request amplification never
fires.

## 2. Design decisions (resolved)

- **D1 — single-level (root + leaf pages), not a multi-level tree.** Max fleet
  directory is ~560 K entries → ~137 pages at 4096/page → a ~7 KB root. COPC's
  K-level paging earns its keep at 1.2 B points; at our scale a flat page-table
  is simpler, fully covers the fleet, and is trivially validated. Leave the door
  open for a future level if a dataset ever exceeds ~tens of MB of root.

- **D2 — a leaf page is the existing v5 codec, verbatim.** Each leaf page is a
  contiguous slice of directory order `(zoom, hilbert, time_start)` run through
  the *unchanged* `encode_directory` / `decodeDirectory`. Slicing resets delta
  state and splits RLE runs at boundaries — exactly what the sim measured
  (+6–19%). Reusing the proven, fuzzed v5 codec for leaves means the only *new*
  bytes are the root page + the container framing. Lowest-risk possible shape.

- **D3 — page descriptor = geographic bbox + zoom-range + `[t_min, t_max]` +
  `cover_t_min`. (RECOMMENDED; confirm in step 0.)** The reader's viewport query
  is already a lon/lat `BoundingBox` at a single zoom over a time window. Storing
  each page's **geographic** bbox (lon/lat, computed at build from the page's
  tiles), its `[min_zoom, max_zoom]`, and its temporal `[t_min, t_max]` (with
  `t_min` taken from `cover_t_min` when present) lets the reader prune purely by
  bbox-∩-viewport + zoom-membership + time-overlap — **no Hilbert index needed in
  TS**. The alternative is the sim's exact model (first/last `(zoom, hilbert)`
  key range per page), which is spatially tighter but forces a port of the
  discrete Hilbert curve (`hilbert_2d::xy2h_discrete`) into the TS reader.
  Trade-off: geo-bbox is zoom-correct, simpler, composes with the future
  per-tile `geoarrow.box` covering column (Wave 2 item 2), but a Hilbert run that
  snakes across the map (or the antimeridian) yields a loose bbox → some
  false-positive page fetches. **Step 0 (below) A/B-measures both in the sim
  before the wire format is frozen.** Store both is also viable (geo-bbox for
  pruning, key-range for exactness) at ~16 B/page extra.

- **D4 — one content-addressed `.sttd`; root is a byte-range prefix.** Keep a
  single immutable `index/<blake3>.sttd` (never a second addressing path — the
  COPC anti-lesson). Layout: `[root page][leaf 0][leaf 1]…`. The manifest carries
  `directory.rootLength`; the reader range-GETs `bytes=0-(rootLength-1)` for the
  root, then ranges for leaves. **Graceful small-dataset path:** when
  `directory.length ≤ SMALL_DIR_THRESHOLD` (~256 KB) the reader GETs the whole
  object in one shot and skips paging entirely — wildfires-shaped datasets behave
  exactly as today. Inlining the root into `manifest.json` (saves one RTT → 2
  requests-to-first-frame) is a noted future optimization; the manifest already
  lists every pack, so a ~7 KB page-table is consistent, but it couples
  immutable-derived data into the mutable manifest, so defer it.

- **D5 — `directoryVersion: 6` + `directory.layout: "paged"`; v5 whole-load
  path retained.** Readers branch on the layout: `paged` → the new query path;
  absent/`single` (v5) → the existing whole-load path, unchanged, for every
  currently-deployed dataset until re-transcoded. Same "keep the old read path"
  discipline as v4→v5.

- **D6 — per-page zstd, NO shared dictionary.** Each leaf is its own zstd frame
  so it is independently fetchable/decodable; the fzstd TS path (`unzstdSync`)
  keeps working. This forfeits the whole-directory zstd window (+6–19% generally;
  +117% on earthquakes, whose blob-dedup redundancy compresses 3.7× under one
  window). **Accepted:** the +% is paid once, by the immutable CDN-cached object
  — it is *not* a per-session cost, and per-session bytes (the actual UX lever)
  drop by 1–2 orders of magnitude. A shared zstd dict shipped in the root would
  recover it but breaks the fzstd dictionary-less contract; park it unless
  directory at-rest size becomes a real problem.

## 3. Wire format (the new bytes)

### 3.1 Manifest `directory` additions (schema-checked)

```jsonc
"directory": {
  "key": "index/<hash>.sttd",
  "length": 9165038,          // at-rest bytes of the whole object (unchanged meaning)
  "directoryVersion": 6,      // bumped from 5
  "encoding": "zstd",         // now means "leaf pages are zstd frames" (see §3.3)
  "layout": "paged",          // NEW; absent or "single" = the v5 whole-load object
  "rootLength": 7024,         // NEW; byte length of the root page prefix
  "pageCount": 137,           // NEW; informational / validation
  "pageEntries": 4096         // NEW; nominal entries-per-page used at build
}
```

Unknown fields are already ignored by both readers (additive within
`formatVersion: 1`); `manifest.schema.json`, the Rust `pack::DirectoryRef`, and
the TS `ManifestDirectoryRef` get the four new optional fields, kept in lockstep
by `manifest-schema.test.ts`.

### 3.2 Root page (the page-table)

Self-describing, fixed-width records (COPC's "count = bytes / record width"
trick — no per-record framing):

```
u8      root_version = 1
u8      descriptor_kind        # 0 = geo-bbox (D3 recommended), 1 = hilbert-key-range, 2 = both
uvarint page_count P
uvarint nominal_page_entries   # build-time K (informational)

repeat P  (fixed width per descriptor_kind):
  u64 (LE) page_byte_offset    # offset of the leaf page within the .sttd
  u32 (LE) page_byte_length    # at-rest (zstd) length of the leaf page
  u32 (LE) entry_count         # entries in this page (Σ == N; validation + presizing)
  u8       min_zoom
  u8       max_zoom
  # descriptor_kind 0 | 2 — geographic bbox, lon/lat × 1e7 fixed point:
  i32 (LE) min_lon_e7, min_lat_e7, max_lon_e7, max_lat_e7
  i64 (LE) t_min               # min(cover_t_min ?? time_start) over the page
  i64 (LE) t_max               # max(time_end) over the page
  # descriptor_kind 1 | 2 — Hilbert key range (only if we keep it):
  # u8 first_zoom; u64 first_hilbert; u8 last_zoom; u64 last_hilbert
```

geo-bbox descriptor ≈ 8+4+4+2+16+16 = **50 B/page** → 137 pages ≈ 6.9 KB root.

### 3.3 Container layout

```
.sttd object  =  [root page]              # bytes 0 .. rootLength-1, its own zstd frame
                 [leaf page 0]             # each leaf = encode_directory(slice) → zstd frame
                 [leaf page 1]
                 ...
```

`directory.encoding: "zstd"` now means *every page (root + leaves) is an
independent zstd frame*. A leaf's `page_byte_offset/length` address its frame;
the reader inflates that frame, then runs the unchanged v5 `decodeDirectory` on
the result. (v5 single objects keep the old meaning: one zstd frame over the
whole codec buffer.)

## 4. Reader algorithm (TS — `packages/core`)

The public surface (`getTile`, `getTiles`, `getTileIdsInBounds`,
`getTileIdsInBoundsForTemporalLod`, `getTileByteSize`, …) is **unchanged** — all
already async. `spatiotemporal-tileset.ts`, the deck.gl layers, and the maplibre
adapter need **zero** changes; paging is contained to `archive.ts` + a small
`directory.ts` addition. That containment is the design's main safety property.

1. **`fetchManifest`** unchanged; gains `directory.layout`/`rootLength` parse.
2. **`getIndex` (paged branch).** If `layout !== "paged"` OR
   `length ≤ SMALL_DIR_THRESHOLD`: keep today's whole-load path verbatim
   (fetch → decode → build full maps). Else: range-GET `bytes=0-(rootLength-1)`,
   decode the root → an in-memory `PageDescriptor[]`. Do **not** build the full
   tile maps. `tileEntryIndex`/`tileEntryByKey` become **incrementally populated
   caches**; track a `residentPages: Set<pageIndex>`.
3. **`ensurePages(bounds, zoom, window)`** (new). Select candidate pages:
   `min_zoom ≤ zoom ≤ max_zoom` **AND** page geo-bbox ∩ viewport **AND**
   `[t_min, t_max]` ∩ `window`. Fetch the missing candidates' byte ranges from
   the `.sttd` object, **coalescing adjacent page ranges** with the existing
   gap/concurrency/retry/stall machinery generalized to "ranges against an
   arbitrary object" (today it is per-pack; factor out a
   `fetchObjectRanges(url, ranges)` helper that both packs and the directory
   use). Inflate each page's zstd frame, `decodeDirectory` it, merge entries into
   the resident maps, mark the page resident.
4. **`getTileIdsInBounds` / `…ForTemporalLod`** (paged): `await
   ensurePages(bounds, zoom, window)` first, then run the *existing* map walk
   over `boundsToTiles` — identical output, just over an incrementally-filled
   map. The covering-bound filter (`coverTMin ?? timeStart`) is unchanged.
5. **`findTileEntry(id)` / `getTile(id)` (paged):** resolve candidate pages by
   `(zoom ∈ [min,max], tile lon/lat ∈ bbox, t ∈ [t_min,t_max])`, `ensurePages`
   them, then the existing exact map lookup. Usually 1 page; bbox overlap may
   yield a few.
6. **`getTileByteSize(id)`** must stay synchronous (the tileset's
   skip-giant-parent guard calls it without awaiting). For paged archives it
   returns `undefined` until the owning page is resident — acceptable: the guard
   degrades to "don't skip," and the page is resident the moment the tile is
   actually requested. Document this.

Page caching: keep decoded pages' entries in the resident maps (bounded by the
same LRU discipline if needed); the `.sttd` byte ranges are immutable +
content-addressed, so the HTTP edge cache serves warm reloads of page ranges for
free. OPFS page caching is out of scope for v1 (tiles still use OPFS as today).

## 5. Writer algorithm (Rust — `crates/stt-core`)

In `PackWriter::finalize` (and `transcode_archive_to_packs`), after the entries
are sorted into directory order, branch on a new `--paged` build option (default
ON for `stt-build`, opt-in for the transcode tool initially):

1. Cut the sorted `&[TileEntry]` into contiguous pages of `page_entries`
   (default 4096; `--page-entries`). Never reorder — slices preserve global
   order so each leaf is independently decodable and the cross-page key order is
   monotonic (a validation invariant).
2. For each page: `encode_directory(slice)` → `compress_zstd_with_dict(_, None)`
   → record `(byte_offset, byte_length, entry_count, min/max zoom, geo bbox via a
   new `tile_geo_bounds(z,x,y)` helper over `projection.rs`, t_min =
   `min(cover_t_min ?? time_start)`, t_max = `max(time_end)`)`.
3. Encode the root page (§3.2) → its own zstd frame at offset 0.
4. Concatenate `[root][leaf…]`; blake3 → `index/<hash>.sttd`. Emit the manifest
   with the new `directory` fields.
5. Byte-reproducibility (D6 of the format spec) is preserved: the page cut is a
   deterministic function of the already-deterministic sorted entry list, and
   per-page zstd is deterministic — identical rebuilds re-derive identical
   content addresses.

A single new module `crates/stt-core/src/directory_page.rs` (root encode/decode
+ `PagedDirectory` reader returning the same `Vec<TileEntry>` as the whole-load
decode for a given query) keeps the paging concern out of the leaf codec.

## 6. Backward compatibility & rollout

1. **Readers ship first**, supporting both layouts (v5 whole-load + v6 paged).
   Deploy the TS reader before any dataset is re-transcoded → zero-downtime.
2. **Transcode the fleet** with `pack-transcode --paged` (reads existing
   v5/v4 — **no generator re-runs**). New content addresses → new immutable
   objects; old `.sttd`/manifest age out under the §2 retention window.
3. **R2 re-sync** via `scripts/r2-sync.sh` (immutable `.sttd`/packs long-TTL,
   manifest short-TTL + purge). Note: the **packs are unchanged** — only the
   `index/<hash>.sttd` and `manifest.json` change, so re-sync is cheap
   (content-addressing skips every unchanged pack).
4. Keep the v5 whole-load path indefinitely for transcode input and any
   un-migrated archive.

## 7. Validation (round-trip + cross-impl + browser)

- **Rust round-trip:** a paged build of a corpus, read back through the paged
  reader for an exhaustive set of queries, must return byte-identical
  `TileEntry`s to the v5 whole-load decode of the same corpus. Property tests
  over random corpora: single-page (small) case, multi-zoom-straddling pages,
  exact page boundaries, t-bounds actually bound their page's entries, geo-bbox
  actually covers its page's tiles, cross-page key monotonicity.
- **Cross-impl golden fixture:** extend `packages/core/test/fixtures/` with a
  Rust-produced **paged** `.sttd` + manifest; a TS test decodes the root, fetches
  pages via a stub transport, and asserts the same entries + the same
  `getTileIdsInBounds` output as the whole-load fixture.
- **TS differential test:** for a real fixture, assert paged
  `getTileIdsInBounds(bounds, zoom, window)` ≡ whole-load output for many
  queries, AND assert only the expected page ranges were fetched (instrument the
  transport; this is the "did paging actually fire" guard).
- **`stt-validate`:** teach it the paged layout — root integrity, every
  `page_byte_offset+length` within the object, `Σ entry_count == N`, pages
  decode, bounds cover entries, cross-page key order monotonic.
- **Browser verification (the focused-effort gate):** open ais-all-us &
  nyc-taxi-points; confirm cold-start fetches a small fraction of the directory
  (network panel), panning fetches incremental pages, playback + time-window
  scrubbing are unaffected, and nothing regresses vs the v5 build. Capture
  requests-to-first-frame and bytes-to-first-frame before/after.

## 8. Metrics to capture (and keep)

- **Requests-to-first-frame** (manifest → root → first leaf → first pack) and
  **bytes-to-first-frame** — the user-facing number §1 exists to cut. Track as a
  t_first-frame budget per the COPC "3 reads" benchmark.
- Directory bytes fetched per session, paged vs whole-load (target: the §1 sim
  ratios in the browser).
- At-rest `.sttd` size delta (expect +6–19%; confirm it stays off the per-session
  path).

## 9. Sequenced task list (the focused effort)

0. **[de-risk] Extend `directory-paging-sim.rs`** to A/B geo-bbox vs
   Hilbert-key-range pruning on the fleet → freeze the D3 descriptor choice with
   numbers, not intuition. (Cheap: reads manifests, no rebuild.)
1. **Rust codec:** `directory_page.rs` (root encode/decode + `PagedDirectory`
   query), `tile_geo_bounds` helper, page-cut in `PackWriter::finalize` +
   `transcode_archive_to_packs`, `--paged` / `--page-entries` flags. Round-trip +
   property tests.
2. **Manifest contract:** new `DirectoryRef` fields (Rust + TS + JSON Schema +
   `manifest-schema.test.ts`).
3. **TS reader:** paged `getIndex`, `ensurePages`, `fetchObjectRanges`
   refactor, paged `findTileEntry`/query paths, small-dataset fast path.
   Differential + cross-impl golden tests.
4. **stt-validate:** paged-layout checks.
5. **Transcode + deploy:** `pack-transcode --paged`, fleet transcode, R2
   re-sync, browser verification, capture metrics.
6. **Docs:** fold the frozen format into `stt-packed-format.md` (promote from
   roadmap to spec §4), update `stt-packed.md` §3 to "shipped."

## 10. Risks / open questions

- **Descriptor choice (D3)** — settled by step 0; geo-bbox is the default.
- **Antimeridian / low-zoom pages** get world-spanning bboxes → always fetched.
  Few pages (zoom-first order keeps low-zoom pages clustered and small); quantify
  in step 0; the existing antimeridian clip already splits offending geometry.
- **`getTileByteSize` async-ness** — handled by the "undefined until resident,
  guard degrades to don't-skip" contract (§4.6); verify the tileset's
  giant-parent-skip still behaves on a paged archive in browser.
- **Coalescing the directory object vs packs** — the generalized
  `fetchObjectRanges` must not regress the per-pack coalescer; cover with the
  existing range-coalesce tests plus a directory-range case.
- **Shared zstd dict** — deliberately skipped (D6); revisit only if at-rest
  `.sttd` size becomes a problem (it is off the per-session path, so unlikely).
</content>
</invoke>
