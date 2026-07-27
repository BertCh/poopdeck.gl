# Tile loading in 3D — pitch, bearing, altitude (2026-07)

Status: **RATIFIED 2026-07-26 — Waves 1+2 in execution.** Authored from a 21-agent
audit (10 dimension auditors, 10 adversarial verifiers, 1 synthesis) plus independent
numeric verification against a real `WebMercatorViewport` and the real core tile math.
§4 is the binding contract shared by all implementation agents.

## 1. The finding

**STT tile selection is correct only at `pitch = 0` _and_ `bearing = 0`.**

`packages/layers/src/layers/spatiotemporal-layer.ts` derived the viewport lon/lat box
from **two** screen corners:

```ts
const [minLon, minLat] = viewport.unproject([0, viewport.height]); // screen bottom-LEFT
const [maxLon, maxLat] = viewport.unproject([viewport.width, 0]); // screen top-RIGHT
```

Those are the endpoints of **one diagonal** of the ground quad, treated as if they were
the axis-aligned min/max. Three defects in two lines:

1. **Two corners, not four.** Correct only at `bearing === 0`. Under rotation the AABB of
   one diagonal is a strict subset of the quad's AABB, and past `bearing > atan2(h, w)`
   (≈32° on 1440×900, 45° on a square canvas) the two sampled corners swap order and the
   box **inverts**.
2. **No horizon guard.** `unproject` with a 2-element pixel array is an unclamped
   ray/plane solve. Once `pitch + fovy/2 > 90` — **71.57°** at deck's default
   `altitude: 1.5` — the top ray points at sky and the returned "ground point" is _behind
   the camera_.
3. **`z = 0` only.** No `targetZ`, no `zRange`.

The `Math.max(-90, …)` / `Math.min(90, …)` clamps that followed clamp to the **world**,
not to `min ≤ max`, so they never caught the inversion. The 70-line doc comment above the
function reasons exclusively about antimeridian longitude wrapping; pitch and bearing are
never mentioned, while the bounds cache key includes both. An unexamined assumption, not a
documented tradeoff.

### Measured impact at the shipped demo cameras

Real `WebMercatorViewport` → real `boundsToTiles`, % of on-screen tiles never selected:

| demo                                       | pitch/bearing   | never selected |
| ------------------------------------------ | --------------- | -------------- |
| `storm-4d-isolines` (iso3d)                | 62 / 20         | **44%**        |
| `earthquake-columns`                       | 55 / 15         | 33%            |
| `storm-4d-greenfield`, `storm-3d-conus`    | 55 / 20         | 20%            |
| `bixi-flowmap` / `-streets` / `-corridors` | 30–35 / −10…−12 | 25%            |
| any flat 2D demo                           | 0 / 0           | **0%** ✅      |

Selection at z9, 1000×1000, as pitch and bearing sweep:

| pitch | bearing | STT selects | on screen | outcome                         |
| ----- | ------- | ----------- | --------- | ------------------------------- |
| 0     | 0       | 3×3 = 9     | 9         | ✅ correct                      |
| 0     | 45      | 4×1 = 4     | 16        | misses 75%                      |
| 0     | 60      | 4×**0** = 0 | 16        | **zero tiles**                  |
| 60    | 0       | 4×7 = 28    | 42        | misses 33%                      |
| 70    | 0       | 13×37 = 481 | 888       | misses 46%                      |
| 75    | 0       | **510**×0=0 | 600       | lon inverted _and_ lat inverted |

### Why it was never caught

`packages/layers/test/chassis-viewport-bounds.test.ts` pinned `pitch: 0, bearing: 0` **and**
stubbed `unproject` to return a pre-ordered rect. The bug was structurally unreachable from
the suite.

## 2. Root causes

**RC1 — deck reduces a 3-D frustum to a two-corner, ground-plane, screen-diagonal AABB.**
The three defects above. Six of the ten audit dimensions rediscovered this independently.

**RC2 — core treats `BoundingBox` as trusted.** Nothing between the layer and the tile scan
validates ordering or finiteness. Four amplifier sites turn a degenerate box into visible
failure:

| site                                                 | behaviour on an inverted box                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `archive.ts` `boundsToTiles` row loop                | `minY > maxY` ⇒ loop never runs ⇒ **zero tiles**                                                                                    |
| `archive.ts` `tileXSpanForLonRange`                  | inverted lon is **indistinguishable** from the seam-crossing encoding ⇒ near-whole-world span (510/512 cols @ z9)                   |
| `spatiotemporal-tileset.ts` `getVisibleTiles` pass 2 | clamps the parent-cover test to the same box; an under-reported box declares children "covering" ⇒ **the coarse parent is dropped** |
| `SPATIAL_FLUSH_TOLERANCE` via `lonSpanOf`            | inverted lon → 355° span → prefetch never flushes                                                                                   |

Plus a readiness lie: on an empty enumeration `getBufferedRunway` returns
`{complete: true}` and `getVisibleTiles()` returns `[]`, so every signal reports
_settled and fully buffered_ while the map draws nothing.

**RC3 — selection is 2-D by construction on all four backends, and the format cannot say
otherwise.** No camera→bounds path has an altitude term. The format has no vertical extent:
`Metadata.bounds` is 4 f64s, and a repo-wide grep for
`zRange|z_range|altitudeRange|boundingVolume` returns zero hits. Altitude rides as an
untagged property column, so **no consumer can discover that a dataset is volumetric**.

**RC4 — one integer zoom per frame; no per-tile distance LOD.** At pitch 55 a frame spans
1.49 true zoom levels and receives one integer; at pitch 80, 5.8 levels.

**RC5 — three's `cameraToViewport` is structurally wrong for two camera classes.** On globe
it solves the world-space `z = 0` plane, which under `GlobeProjection` is the **ECEF
equatorial plane through the Earth's centre** — so `minLat === maxLat === 0` for every globe
camera. At `pitch ≥ 90 − fov/2` the two top rays are dropped, the `hits.length < 2` fallback
never fires (exactly 2 survive), and the AABB collapses to a zero-height line.

**RC6 — Cesium bridge.** `camera.ts` returns the camera _slant distance_ as `height` and
passes the look-at target verbatim to `camera.setView({destination})` — in Cesium
`destination` **is the camera position**. `Math.round` where every other backend floors.
`republish()` is O(N·M) synchronous with `removeAll()` before the empty guard.

**RC7 — no retry after a failed settle.** The only site that queues a needed tile is
`selectAndLoadTiles`'s candidate loop, short-circuited by the exact-bounds fast path and
declining any header that is `isLoading`. A tile whose batch resolves `null` is left
`{isLoaded: false, isLoading: false, isCancelled: false}`, still in `neededTileKeys`, in
**no queue**. Reproduced: 0 re-requests across 30 identical `update()` calls; a 1 ms
playhead nudge heals it. The prefetch tier already has this fix; the priority tier never
got it. Mirror bug: that prefetch revival has **no attempt cap**.

**RC8 — cross-source scheduling ranks by bucket _boundary_, not bucket _interval_.**
_(UNVERIFIED — measure before fixing.)_ `e.timeStart` is the addressable bucket boundary,
so for any playhead strictly inside a bucket the on-screen bucket is classified "already
passed" and penalised `5e14`.

**RC9 — configuration removes every fallback at exactly the cameras that trigger RC1.**
`refinementStrategy: 'no-overlap'` is forced on all ten storm4d tilesets. **CORRECTED
2026-07-27 — the audit was right about one of the three sites and wrong about two.**
Per-zoom feature counts decoded from the shipped paged directories:

- **LOD floor (parents are strict SUBSETS — `no-overlap` is wrong, now removed):**
  `storm4d-volume-lod` 43,245 features @z4 vs 18,343,623 @z9 (0.2%), with z5–z8 at
  1.3 / 4.8 / 10.2 / 15.0%; `mrms-storm3d-volume` 1,035 @z2 vs 26,505,283 @z8 (0.004%).
- **Full duplication (premise HOLDS — `no-overlap` is correct, kept):** `storm4d-isolines`
  exactly 100,129 features at z5, z6 _and_ z7; `storm4d-couplet` exactly 6,046 at z3–z9;
  `-reports` 488, `-stations` 15,200, `-sounding` 5,789 identical at every zoom;
  `goes-glm-lightning` ~100% across z0–z7. (`-cloudtop` 90.9→100%, `-warnings` 94.7→100%,
  `-wind3d` 88.6→100% — the growth is polygon CLIP fragments at deeper zooms, not new
  features.)
- Corroborating: `--min-zoom-field` is passed **only** by `nexrad_volume.py` and
  `mrms_volume.py`; none of the eight overlay generators nor `nexrad_isolines.py` pass it.
  `feature_out_of_band` (`crates/stt-build/src/tiler.rs`) confirms the cumulative-floor
  semantics (`if zoom < mz { skip }`).
- Why the stale comment existed: the LOD build and the "full-duplication pyramid / 4 fps /
  2.7 s stalls" comment landed in the **same** commit (`9f52804`). The measurement was
  taken on the legacy `--no-lod` build, which no longer ships.
  `maxPitch: 85` appears on exactly the four volumetric demos plus `DemoViewer`'s `?? 85`
  default for any `timeHeight` dataset; deck's default of 60 is what keeps every other demo
  out of the inverted band.

## 3. The three reported symptoms

**S2 "tiles genuinely in view flash out" — fully explained.** The mechanism that makes it a
_flash_ rather than a hole is `getVisibleTiles` pass 2: coarse parents land first and paint
the whole pitched frame; when the primaries finish the clamp declares the shrunken child
range covered, `needed` goes false, and **the parent is dropped** — the top fifth of the
screen, drawn a moment ago, goes empty.

Eviction is **not** the cause but **is** the executioner. Both eviction branches correctly
hard-exclude `neededTileKeys`, pinned and in-flight; a selected tile cannot be evicted. But
RC1 removes the tile from `neededTileKeys` first, at which point `cancelSupersededRequests`
aborts its in-flight load. The bug does not merely fail to fetch — it tears down content
already on screen.

**S3 "there may be a 3D aspect" — fully explained.** Pitch is RC1's second, independent
trigger; no rotation required. And the connection is causal, not coincidental: the demos
that raise `maxPitch` from deck's default 60 to 85 are _exactly_ the volumetric ones. Only
the 3-D demos can reach the broken band.

**S1 "LOD w.r.t. the ground but weather-4D tiles are high off the ground" — partly.** The
diagnosis is mechanically correct but does not account for what was seen. Measured: unioning
`getBounds({z: 0})` with `getBounds({z: 15000})` widens the box by only 0.3–0.6%; the
ground-vs-content LOD term is ≤0.63 zoom levels at z10 and is **fully absorbed** at
storm-4d's shipped framing (8 → 8.594 → floor 8; 9 → 10.63 → clamped to `max_zoom: 9`, the
lossless tier). The real residue is ~half a z8 tile row of unrequested anvil at the near
edge. Weather-4D was reported because it has the most pitched and rotated camera, not
because the data is high up. **Most probable remaining candidate: RC4**, the missing
per-tile distance LOD.

_The one measurement that settles S1:_ instrument the selected tile set and per-tile gate
count on `/demos/storm-4d-greenfield` at the shipped camera; compare rendered gate density
in the near third vs the far third of the pitched frame against the same content at
pitch 0. Flat ⇒ the complaint is RC1/RC3 footprint. Visibly sparser near third ⇒ RC4.

## 4. The binding contract (§4 — all implementation agents honour this)

### 4.1 One shared bounds primitive

New module `packages/core/src/geo/viewport-bounds.ts`, exported from
`@poopdeck.gl/core`. Every backend routes its camera-derived box through
`normalizeViewportBounds` before it reaches `tileset.update()`. No backend re-derives
these rules.

```ts
normalizeViewportBounds(bounds): { bounds, issues } | null
```

Rules, in order:

1. **Non-finite** in any component ⇒ return `null`. Callers **keep the previous
   viewport** rather than selecting against garbage.
2. **Latitude** — if `minLat > maxLat`, swap. Then clamp to `[-90, 90]`. Latitude is
   never a wrapping axis; an inverted lat box is always an artefact.
3. **Longitude** — `minLon > maxLon` is the legal antimeridian **crossing encoding**, but
   only when the implied span `(maxLon - minLon + 360)` is `< MAX_SEAM_SPAN_DEG` (350°).
   A wider implied span is an inversion artefact ⇒ swap. This is what separates a genuine
   seam crossing from a pitch-inverted box.
4. **Full-world** — if `maxLon - minLon >= 360`, normalise to exactly `[-180, 180]`.
5. `issues[]` names every repair applied, for `warnOnce` diagnostics and tests.

**Do NOT re-clamp longitude into `[-180, 180]`.** The unwrapped contract
(`unproject` reporting lon 184 at a camera on lon 179) is load-bearing: `tileXSpanForLonRange`
walks unwrapped column space and wraps at emit. Re-clamping silently drops the far side of
the seam — that regression is what `ais-all-us` and `drifters` were fixed for.

### 4.2 Four corners, with the horizon clamp

The deck chassis uses `viewport.getBounds()`, not two `unproject` calls. Verified in
`@math.gl/web-mercator@4.1.0` `get-bounds.js`: it samples the two bottom corners normally
and, when `halfFov > angleToGround - 0.01` (the top plane at/above the horizon), substitutes
`unprojectOnFarPlane` for the two top corners. It preserves unwrapped longitude —
`worldToLngLat` is a pure linear map with no wrapping — so §4.1 rule 3 stays intact.

Keep the existing two-corner path as an explicit fallback for viewports that do not expose
`getBounds` (the synthetic viewports in the test suite), routed through
`normalizeViewportBounds` either way.

### 4.3 Defence in depth

The layer fix is necessary but not sufficient. Core must not be destroyed by a bad box from
_any_ producer:

- `SpatiotemporalTileset.update()` normalises and rejects.
- `boundsToTiles` orders its row span, so an inverted box degrades to the **right band**
  rather than to nothing.
- `getVisibleTiles` pass 2 **skips** the parent-cover clamp when the viewport intersection
  is empty, and inflates it by one primary-zoom tile of slack. An empty intersection
  currently means "drop the parent", which is backwards for a fallback tile.
- Query bounds are intersected with `metadata.bounds` and the cell count is capped with a
  dev warning before the scan.

**Erratum (F3 scope).** The skip above is triggered by a degenerate **viewport** — no
columns at all, or `vpMinY > vpMaxY` — and by nothing else. It is emphatically NOT "skip
the clamp for a parent that misses the viewport": every parent spatially larger than the
frame contains child cells outside it, those cells can never enter `primaryCover`, so that
reading makes the "some child uncovered" test pass forever and retains every off-screen
parent for the life of the session. On a full-duplication archive (the no-thinning default)
each retained parent level is a permanent extra full copy of the visible data — the exact
cost the clamp was added to remove. The one-tile slack ring is likewise qualified: a ring
cell keeps a parent only when the viewport actually asked for that cell and has not received
it, because counting ring cells like in-box cells reinstates the same full-copy cost for
every parent whose block reaches past the frame edge.

**Erratum (`metadata.bounds`).** The last bullet is WITHDRAWN. Query bounds are no longer
intersected with the archive's declared extent, and must not be: `metadata.bounds` is the
bbox of feature CENTROIDS while tiles are addressed by VERTEX, so on any line / polygon /
multi-point archive the occupied tiles provably extend past it and the intersection drops
real, non-empty edge tiles. See §6b, and the "DELIBERATELY ABSENT" note above `lonToTileX`
in `core/archive.ts`. The cell-count cap survives as `MAX_QUERY_SCAN_CELLS`, and it is a
**warning only** — the scan still returns every cell (§5b's reasoning: a slow correct frame
beats a fast wrong one).

### 4.4 Tile counts will rise — that is correct

The corrected footprint fetches **more** tiles under pitch, because today's is a
36%-coverage under-selection. Do not "fix" that back. `maxParentTileBytes` (2 MiB default
against a ~42 KB average tile) already bounds the parent-fallback downside.

**Erratum (the pitch band this holds over).** The ruling above stands, and it is measured to
roughly **pitch 65**: up to there the extra tiles are tiles that were always on screen and
simply never loaded, and any "optimisation" that removes them re-opens the blank-region bug.
Past that the axis-aligned box stops being a bound on the frame and starts being a bound on
the horizon: at **pitch 85 / z8 the box enumerates 832 cells against the ~12 a flat camera
selects at the same zoom**, nearly all of them in the band where the ground occupies a few
screen rows. That is not under-selection being repaired, it is the AABB approximation
failing, and no amount of "do not tune it back" makes 832 fetches the right answer.

The resolution is explicit rather than implicit — `viewportCellBudget` on the deck chassis,
`fitZoomToCellBudget` / `viewportCellCount` in `@poopdeck.gl/core` (default 256 cells, with
a hysteresis band so a camera hovering on the threshold cannot flap the zoom and flush the
prefetch runway every pass). It spends the excess as **one coarser integer zoom**, which
quarters the count while still covering the whole frame; on a full-duplication archive that
coarser tile carries the same features at a coarser simplification rather than fewer of
them. It is **never** a truncation of the tile list — dropping enumerated cells is the
blank-region symptom this document exists to remove.

The budget is a stopgap for the AABB, not a replacement for fixing it. Wave 3 / A1 (the
frustum-quadtree primitive) selects 47 tiles across z5–z8 where the ground AABB selects 754
at z8, and when it lands the budget should go inert on its own — verify that before removing
it, and expect it to stay as the backstop for foreign viewports that cannot supply frustum
planes.

## 5. Waves

### Wave 1 — correctness (no format change, no rebuild, no republish)

| #   | Where                                               | Change                                                                                                                                                                                                                     |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `layers/…/spatiotemporal-layer.ts`                  | `getBounds()` + normalize + `warnOnce`; rewrite the bounds test over the pitch×bearing matrix                                                                                                                              |
| F2  | `core/geo/viewport-bounds.ts`, `core/archive.ts`    | the §4.1 primitive; ordered row span; seam-span cap                                                                                                                                                                        |
| F3  | `core/spatiotemporal-tileset.ts`                    | pass-2 clamp skip + one-tile slack                                                                                                                                                                                         |
| F4  | `core/spatiotemporal-tileset.ts`                    | ungate pass 3 for `no-overlap` (it issues no fetches — pure reuse of resident tiles)                                                                                                                                       |
| F5  | `core/spatiotemporal-tileset.ts`                    | settle-time re-check. **As shipped the cap and the retry are two different things** (see §5b): the attempt cap (3) is a READINESS write-off only, and fetching follows an expiring exponential ladder with no hard give-up |
| F6  | `core/spatiotemporal-tileset.ts`                    | prefetch flush skips records holding a needed key; spatial path only                                                                                                                                                       |
| F7  | `core/archive.ts`, `core/spatiotemporal-tileset.ts` | intersect query bounds with `metadata.bounds`; cap `xCount·yCount` with a dev warning                                                                                                                                      |
| F8  | `layers/…/spatiotemporal-layer.ts`                  | `_pushTilesetOptions` must re-apply subclass overrides                                                                                                                                                                     |
| F9  | `core/spatiotemporal-tileset.ts`                    | guard `activeRequests.delete` with an ownership check                                                                                                                                                                      |
| F10 | `core/archive.ts`                                   | sort coalesced groups by priority **before** the runner loop                                                                                                                                                               |
| F11 | `core/archive.ts`                                   | RC8 interval-aware ranking — **measure first**, gated                                                                                                                                                                      |

#### 5b. F5 as shipped — why the cap became readiness-only

The first cut latched `isFailed` at 3 attempts and used it as the FETCH gate. All three
attempts land inside ~1.5 s, the latch never cleared, and a needed tile's header is never
replaced (eviction hard-excludes `neededTileKeys`, §7) — so **a 1.5-second network blip
blanked that region for the rest of the session**, healing only on a playhead nudge. That is
strictly worse than the bug F5 set out to fix.

The shipped design separates the two jobs the one counter was doing:

- **Readiness write-off** — `attempts` still latches `isFailed` at 3, and `isFailed` is
  sticky and consulted only by `isCoverageReady`. This is what stops one permanently-absent
  tile pinning the buffered runway at zero.
- **Fetch eligibility** — a separate expiring gate on an exponential ladder,
  `min(500 ms × 2^(n−1), 60 s)`, so a blip heals with no user action while a genuinely
  absent tile costs about one coalesced probe a minute. One shared timer, not one per hole.
- **Aborts** advance the ladder but not `attempts`: an abort is the transport being torn
  down, not evidence about the tile, and `isCancelled` cannot see a timeout raised _inside_
  the fetch. ⚠️ That exemption is **bounded** at 8 settles (`FAILED_TILE_READINESS_WRITEOFF_SETTLES`),
  because an unbounded exemption re-opens the runway-pinning failure through the abort door —
  a transport that aborts every request would otherwise never write anything off.

### Wave 2 — backend parity

| #   | Change                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A3  | `elevationRange?: [min, max]` layer prop, defaulted from what the layer already knows (`elevationProperty` × `elevationScale`; `timeHeightScale` × time span). Unions `getBounds({z: min})` with `getBounds({z: max})`. Closes S1's footprint half with **zero data changes**.                             |
| A4  | three: branch on `proj.kind` and ray/sphere-solve on globe (reuse `view-state.ts` `recoverTarget`); **clip** above-horizon rays at the horizon instead of dropping them; take zoom from `cameraToViewState(...).zoom`; add a polar clamp. There is currently **zero** test coverage of `cameraToViewport`. |
| A5  | cesium: `lookAt` so lon/lat is the target; reject `Rectangle.MAX_VALUE` and handle `west > east`; real canvas dims and `frustum.fovy`; `round` → `floor`; incremental `republish`.                                                                                                                         |
| A6  | maplibre: route per-layer mode through the **visible** set (today `render()` walks the resident map ⇒ up to 5 zoom levels composited); add `tileLoadTimeWindow`.                                                                                                                                           |
| A7  | export core's `tileIdToKey` and use it in all ten layer `makeTileKey` helpers, maplibre's `tileKey`, three's `residentSetEqual`.                                                                                                                                                                           |

### Wave 3 — architectural (staged, not blocking)

**A1. Replace the AABB with a frustum-quadtree selection primitive.** Port the shape of
deck's `getOSMTileIndices`: `viewport.getFrustumPlanes()` + `@math.gl/culling` CullingVolume

- per-node `z += floor(log2(distance))` + `elevationBounds`. The tileset needs a
  `tileIds?: TileId[]` alternative to `{bounds, zoom}`; `selectAndLoadTiles` already builds
  `neededTileKeys` from an id list, so the surgery is contained. **This subsumes F1–F3 and
  fixes RC4 — S1's LOD half — in one move.** Motivation: at z8/pitch 80 deck returns 47 tiles
  across z5–z8 where the ground AABB returns 754 at z8.

**A2. One shared `viewportFromCamera` in `@poopdeck.gl/core/geo`.** Each backend supplies
only its four corner rays; the horizon clamp, altitude dilation and floor convention live in
one place. Gate with a conformance test: one fixture camera through all four adapters,
agreeing within one tile and zero zoom levels.

### Wave 4 — config (cheap, independent)

`no-overlap` off the **volume branch only** (see the correction in §7) · `maxPitch`
85 → 70 on the four volumetric demos and `DemoViewer`'s default · couple `useGlobalBounds`
⇒ `zoomOverride` in the layer · `--blob-ordering time-major` on the nwm/GTFS build paths ·
extend the reconcile gate to every archive-bearing url with camera-zoom, camera-centre,
blob-ordering and `maxPitch` assertions.

## 6. Format: what is and is not required

- **NOT required for S2 or S3.** Every mechanism behind the flashing and the pitch collapse
  is renderer/core-side. No rebuild, no republish, no fleet blast radius.
- **NOT required for the minimum-viable S1 fix.** The renderer already knows the vertical
  extent for every affected demo (`STORM4D_ELEVATION_SCALE`, `elevationScale`,
  `timeHeightScale` × time span). A3 closes the footprint half with zero data changes.
- **IS required for the general case.** Without a declared vertical extent no consumer can
  discover that a dataset is volumetric — not the tileset, not `stt-validate`, not
  `stt-optimize`'s advisors, not a future z-aware culler. Altitude-aware selection stays
  hand-configured per demo forever.

**Staging, to keep the blast radius at zero:**

1. **Now, additive:** `zRange: Option<{min, max}>` on `Metadata`/`ArchiveMetadata` with
   `#[serde(skip_serializing_if = "Option::is_none")]`. Existing manifests round-trip
   **byte-identically**; no reader breaks; no rebuild forced; golden-fixture hashes
   unaffected.
2. **Now:** ship A3's `zRange` prop so nothing waits on data (done — but it must then be SET by the volumetric demos, which is still open).
3. **Opportunistically:** a `--elevation-column NAME` build flag (the generators already
   emit exactly one each: `alt_m`, `top_alt_m`, `level_alt_m`), populating `zRange` on the
   next rebuild of each volumetric archive.
4. **Only if wanted fleet-wide at once:** ~1.5 GB to R2 across the ten storm4d archives +
   `mrms-storm3d-volume` + `earthquake-columns` + `flights`, plus `v2-golden` hash churn.
   **Fold into B2 rather than running a republish for this alone.**
5. **Do NOT change the tile address.** Build-side 2-D assignment — a tile is a full vertical
   column — is correct by design. A 3-D tile address would be a genuine breaking change with
   no demonstrated payoff; every altitude fix identified here is renderer-side selection.

## 6b. `metadata.bounds` does not bound the data (found while implementing F7a)

An attempt to fix the enumeration blow-up by intersecting the query box with the archive's
declared extent was **reverted as unsound**, and the reason is a defect worth fixing on its
own:

- `stt-build.rs` fills the manifest bounds from `input::calculate_bounds`.
- `calculate_bounds` takes the min/max of each `ParsedFeature.lon` / `.lat`.
- `ParsedFeature.lon`/`.lat` is the geometry's **CENTROID** (`input.rs` — "Parse a WKB/EWKB
  blob into a GeoJSON geometry and its centroid").
- But the tiler addresses tiles by **VERTEX**: `tiler.rs` places each point of a
  multi-point/line geometry with `lonlat_to_tile(p[0], p[1], zoom)`, and polygons are
  clipped across every tile they cross.

So the declared bounds are the bbox of **centroids** while tiles are laid out by
**vertices**, and on any line / polygon / multi-point archive the occupied tiles provably
extend past the declared extent. (`calculate_bounds` separately skips the `(0, 0)`
null-island sentinel, so even a pure-point archive can hold data outside its bounds.)

Blast radius beyond tile selection: the showcase's opening camera is framed from these
bounds, and `stt-validate` and the MCP `describe_dataset` both report them as the dataset's
bbox. All three understate the true extent today.

**Fix belongs in the builder** (compute the real geometry bbox, not the centroid bbox) and
only takes effect on a rebuild — so it is a natural rider on the B2 republish rather than a
reason to schedule one. Until then a query box is honoured as given, and the oversized-scan
threshold **warns without truncating**: a slow correct frame beats a fast wrong one.

## 7. Verified correct — do not re-investigate

- **The antimeridian / unwrapped-longitude algebra.** `tileXSpanForLonRange` walks unwrapped
  column space and wraps at emit with a one-world cap; the deliberate pass-through in the
  chassis is right. `viewportTileXIntervals` provably agrees with `boundsToTiles`.
  `latToTileY` / `latToTileClamped` are correct including the poles.
- **Eviction.** Both branches hard-exclude `neededTileKeys`, pinned and in-flight; the
  4-tier playhead-relative ladder never reaches the current viewport tier; in-flight tiles
  are never evicted. **There is no cross-dataset eviction coupling** — no shared budget, no
  shared LRU, no cross-tileset eviction call anywhere.
- **`cancelSupersededRequests`** — tier-aware, prefetch fully exempt, a priority batch
  aborted only when _every_ member has left the needed set.
- **The temporal window/bucket math.** The directory filter is a true interval overlap and a
  strict superset of the shader's `windowAlpha` predicate — a narrow window can never "fall
  between bucket centres". The storm-4d cadence ↔ fade ↔ `tileLoadTimeWindow` triad is
  correctly sized on deck.
- **Zoom-range configuration across all 133 demos.** No dataset overrides min/max; the
  `maxZoom ?? 14` default is unreachable. The nwm-rivers detail-zoom regression recorded in
  memory **is fixed** (`-dz8`, max_zoom 8).
- **Flooring the zoom** is correct and required (the directory is keyed by integer z).
- **Additive LOD** does not blow up the tile count (~2.2× the deepest level) and cannot evict
  in-view tiles. `isOversizedParent` can never skip the primary zoom.
- **Build-side 2-D tile assignment.** Do not propose a 3-D tile address.

### Magnitudes the verifiers overturned

- The "1275 / 24,832-tile request storms" are candidate **coordinates**, not fetches —
  `getTileIdsInBounds` filters every candidate through `tileEntryIndex`. For storm-4d the
  real cost is the enumeration loop, not bandwidth. A globally-extensive archive
  (`ais-all-us`, `flights`, `drifters`) _would_ see real column over-fetch.
- The "every parent dropped when fully inverted" path is **unreachable** — `getVisibleTiles`
  short-circuits on an empty needed set. Only the under-report case is real.
- `flushPrefetch` does **not** leave a needed tile unfetched; it clears `lastSelectKey`
  first. The damage is the lost slice and the collapsed runway.
- three's `hits.length < 2` nadir fallback is **unreachable by tilt** — a symmetric frustum
  goes 4 → 2, never 3 or 1. The real failure is the 2-hit degenerate strip.
- **maplibre's `getBounds()` is not the "unproject the sky" failure** — all three supported
  majors clamp the top sample row. It is the least-broken backend.
- Cesium's zoom nets ~1.0–1.3 levels too **coarse**, not too fine. The dangerous Cesium
  bounds path is the antimeridian `west > east` fallback to the archive's full extent.

## 8. Unconfirmed — measure before acting

The pinned-overview count gate (**check `getCacheStats().pinnedCount` first — one-line
measurement**; if real it is critical for `hurricanes` at 17,899 pins and `earthquakes-v2`
at 8,927 against a 2,000-tile cap) · RC8's scheduler interval · the coverage-index
quantisation staleness · maplibre's constant-zoom and globe deltas · three's altitude slab.
