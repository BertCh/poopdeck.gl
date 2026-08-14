# Demos and datasets — standing decision register

The one place for **dataset licensing verdicts, the blocked list, operational time-bombs, and
the non-obvious per-demo decisions** behind the shipped showcase. Replaces the four per-demo
build logs and the dataset wishlist. Rationale and counted-out options only.

**Build commands do NOT live here.** `examples/showcase/src/datasets.ts` carries the exact
rebuild recipe in a comment on each dataset entry, and it is the copy that stays current. The
retired `rain-flood-demo-2026-07.md` proves why: it recorded a 6-hourly rain build with a
recipe that omitted the required `--blob-ordering time-major`, while the tree had long since
shipped 2-hourly _with_ that flag. Do not re-add commands to this file.

Normative behaviour is owned elsewhere: archive/sidecar format in `../spec/`, layer props in
`../api/`, CLI flags in `../api/cli-reference.md`.

---

## 1. Standing license register

**Hard requirement.** Processed STT tiles are publicly rehosted on Cloudflare R2, so
redistribution of _derived products_ must be permitted. CC-BY / public-domain / CC0 / ODbL
pass; non-commercial or no-redistribution terms are blockers (the Waymo lesson). Every verdict
below is against the **upstream licensor**, never the AWS Open Data registry — listing implies
nothing about license (nuScenes is the counterexample).

### 1.1 Blocked or conditional (verified verbatim 2026-07-01 — do not use without re-reading)

| Dataset                              | Verdict                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenSky ADS-B**                    | **HARD BLOCKER** — non-profit research/education only; no distribution outside licensee's institute; restrictions attach to "any and all subsequent uses and disclosures". Escape hatch: their separately-licensed **CC-BY 4.0 Zenodo derivatives** (e.g. 2019–2020 crowdsourced air traffic, ~41.9 M flights, doi:10.5281/zenodo.3931948). |
| **Global Fishing Watch**             | **CC BY-NC 4.0** — derived tiles redistributable but non-commercial only; usable only if the showcase is definitively non-commercial. Legacy GEE V1 subset is CC-BY-SA.                                                                                                                                                                     |
| **Gaia DR3**                         | **CC BY-NC 3.0 IGO** (not BY-SA as often assumed) — NC blocker.                                                                                                                                                                                                                                                                             |
| **WWLLN / Earth Networks lightning** | Copyrighted/commercial, no redistribution. GOES GLM is the open substitute.                                                                                                                                                                                                                                                                 |
| **ESA DISCOS**                       | Registration-gated, no redistribution right.                                                                                                                                                                                                                                                                                                |
| **Japan ODPT transit**               | Bespoke license, full text unverifiable without an account; patchwork CC-BY subsets only. Legal risk for public rehosting.                                                                                                                                                                                                                  |
| **MERIT Hydro**                      | Dual CC-BY-NC / ODbL — usable **only** by electing ODbL (share-alike). Prefer NHDPlus/NWM.                                                                                                                                                                                                                                                  |
| **Waymo Open Dataset**               | Non-commercial **and** no-redistribution. Enforced in code, not by convention: `WAYMO_LOCAL_ONLY = /^waymo-/` filters every `waymo-*` bundle out of the dataset list whenever tiles are served remotely, so no Waymo scene reaches `/demos`, the cockpit switcher, or a `/drive/:id` route on the public site.                              |

### 1.2 Operational time-bombs (check before any new build)

- **5-digit NORAD catalog numbers exhaust ~mid-July 2026** → ingest OMM/CSV, never legacy TLE.
- **MPC 1-opposition orbits are junk-quality** — drop them at ingest.
- **`waterservices.usgs.gov` decommissioned early 2027** → build against `api.waterdata.usgs.gov`.
- **`noaa-nexrad-level2` bucket deprecated 2025-09-01** (dead, 403) → use `s3://unidata-nexrad-level2`.
  This one already paid for itself: the storm-4D generator was written against the live bucket
  from day one instead of debugging a 403.
- **GOES-East handover G16→G19 (Apr 2025)** — pick the bucket per epoch.
- **AWS Open Data listing ≠ open license** — nuScenes counterexample; always verify upstream.
- **NODD labeling duties** — derived tiles must not be presented as original NOAA data; no
  implied endorsement; attribute.

### 1.3 Live defects (verified against tiles.poopdeck.gl, 2026-08-03)

The fleet-wide defects this section carried through July are **closed** — all 68
registered manifests return `formatVersion: 2`, `wpc-fronts` / `wpc-fronts-pips` are synced,
and `LOCAL_ONLY_DATASETS` is empty. What survives is the standing lesson and one open item.

- **Standing lesson: a demo is only as gated as its _least_ synced archive.** The gate keys on
  demo ids, so it cannot reach an overlay stem inside an otherwise-live composite — which is
  how `wpc-fronts` + `wpc-fronts-pips` shipped a 404-stalling fronts overlay under the un-gated
  `severe-weather-2024`, and how `mrms-storm3d-{cloudtop,outages,warnings,reports}` later
  stalled `storm-3d-conus` behind a 200 primary. Both are fixed by syncing, but the shape
  recurs: the worst version of this failure is a **200 primary with 404 overlays**, because the
  demo mounts and the governor starts before anything fails. The r2-sync-both-or-neither rule
  for `wpc-fronts` + `wpc-fronts-pips` predates both instances.
- **Open — the atlas generator sidecar 404s.** `/data/neural-atlas.json` is the one atlas
  artefact `r2-sync.sh` still cannot upload; **L1** in the [roadmap README](./README.md) owns it,
  and it is why `ATLAS_ARCHIVES_SYNCED` is still `false`.
- **`flights` / `adsb-paths` are OpenSky-derived and live on R2** (both 200).
  `crates/stt-generate/src/datasets/flights.rs` pulls `s3.opensky-network.org/data-samples/`.
  That is in tension with §1.1's HARD BLOCKER verdict on OpenSky. Either the data-samples
  distribution carries different terms (unverified) or these demos should move to the CC-BY
  Zenodo derivative. Unresolved; recorded so it is not discovered by someone else.

---

### 1.4 Neural-State Atlas (`/atlas`) — cleared 2026-07-27

Four upstream artefacts, all verified before `collect-corpus` ran (the record's
G4 rule is "cleared before, not after"):

| Artefact                                 | Verdict                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`openai-community/gpt2`**              | **MIT**, ungated. Outputs and derived activations redistribute freely.                                                                                                                                                                                                                                                    |
| **`jbloom/GPT2-Small-SAEs-Reformatted`** | **MIT**, ungated. The decoder directions ARE the atlas geometry, so this is a redistribution question, not a use question.                                                                                                                                                                                                |
| **Neuronpedia `gpt2-small/*-res-jb`**    | Public S3 bulk export. Labels are shown in the UI and attributed on every archive. (The `/api/explanation/export` endpoint was retired and now 400s with a pointer to the S3 prefix — build against `neuronpedia-datasets.s3.us-east-1.amazonaws.com/v1/`.)                                                               |
| **`Salesforce/wikitext`, 103-raw-v1**    | **CC-BY-SA-3.0 + GFDL**, © Wikipedia contributors. This is the one that mattered: the corpus is redistributed _in effect_ because top-activating spans and the trace's token strings are shown, so a permissive corpus was chosen deliberately rather than defaulting to whatever the SAEs were trained on (OpenWebText). |

**`google/gemma-2-2b` was the planned pin and is BLOCKED here** — `gated: manual`
on the Hub with no token on this machine, so the weights are unfetchable
regardless of the Gemma Terms verdict. Not a licence blocker; an access one. See
[neural-atlas-2026-07.md](./neural-atlas-2026-07.md) §14.2.

Gate status: still **LOCAL-ONLY**, held off the public deploy by `ATLAS_AVAILABLE`
in `datasets.ts` — the surface is not a `Dataset`, so `LOCAL_ONLY_DATASETS` cannot
reach it and it needed its own flag. The archives, their `.meta.json` files and
both `.bin` blobs are synced and return 200; the one artefact still missing is the
generator sidecar `/data/neural-atlas.json`, which is **L1** in the
[roadmap README](./README.md).

## 2. AV cockpit (`/drive`)

**Sources + license.** Synthetic bootstrap; nuScenes v1.0-mini (10 scenes) and Argoverse 2
(6 cities) are **CC BY-NC-SA 4.0** (non-commercial, attribute); comma.ai permissive; Waymo
local-only per §1.1. Attribution renders from each bundle's `scene.json`.

> **The AV record lives in [av-cockpit.md](./av-cockpit.md), not here.** It is the
> only per-demo doc that survived the 2026-07-24 consolidation, because it is not a
> campaign log — it is a **live data contract**. Forty-four section-anchored citations
> across `scripts/data-generation/*.py`, `packages/layers/src/layers/core/animated-bounding-box-layer.ts`
> and `examples/showcase/src/components/av/*` point into its numbered sections, and
> `scripts/data-generation/av_common.py:8` instructs extractor authors not to deviate
> from it. It carries the georeferencing gotchas (nuScenes local frame vs Argoverse 2
> UTM), the three-copy palette-lockstep rule and the legend↔box bug it prevents, and
> the measured LiDAR compression story (3.84 GB → 633 MB) with its counted-out levers.
>
> ⚠️ Some of its inbound citations were already stale before the consolidation — the
> `§3c` anchors in `animated-bounding-box-layer.ts` do not match its current §3. Fix
> the anchors, not the doc, and add them to the roadmap-citation CI check (W1.1).

---

## 3. World Model Scenario Explorer (`/worlds`, Cosmos-Drive-Dreams)

**Source + license.** `nvidia/PhysicalAI-Autonomous-Vehicle-Cosmos-Drive-Dreams` on Hugging
Face, **CC BY 4.0** — unlike Waymo, redistribution to R2 is permitted with attribution. Not
gated; anonymous download works (slowly — set `HF_TOKEN` for real rate limits). All five
archives plus `worlds.json` verified 200 on R2. First demo whose scale comes from the number of
WORLDS rather than the feature count of one world.

**The video constraint that shaped the demo.** The 81,802 generated videos exist ONLY as a
single ~695 GB `tar.gz` **byte-split into 17 parts**. There is no per-clip download. part-000 is
the head of the gzip stream, so it decompresses standalone until it truncates mid-member; parts
001+ cannot be decompressed independently at all. The generator therefore STREAMS part-000
(`requests` → `gzip` → `tarfile` in `r|` mode), keeping only the MP4s it wants and never storing
the 40 GB part. Truncation (`EOFError` / `zlib.error` / `tarfile.ReadError`) is the normal end
condition, not a failure.

**Measured, and it changed the design:** the archive is _not grouped by clip_ — a given clip's
14 variants (2 chunks × 7 weathers) are scattered across the whole 695 GB. 8.2 GB read yielded
938 MP4s over 902 distinct clips, i.e. ~1 variant each (35 clips got 2), with all seven weathers
evenly represented across the corpus. The original plan assumed a per-world weather carousel.
The corpus gives a **weather mosaic across worlds** instead, which is arguably the better story:
each world exists in one generated condition and the grid reads as a field of conditions.
Selection leans into this — it fills round-robin by weather so the mosaic is balanced (41–45
worlds per weather in the shipped set of 266).

**No true counterfactual pair exists in this corpus:** the 35 clips that got two videos got them
for DIFFERENT halves of the clip (and different weathers), not the same moment twice. The
planned "multiple worlds" chip was dropped for a "trucks & buses" one. _Revival trigger:_ a
`--videos-top-up` pass (~40 GB each) that turns up same-moment/different-weather pairs — the
panel's variant carousel already handles them.

**Sync correctness.** A generated video covers 121 of a clip's ~297 frames. Running the full clip
as the loop would leave most of it with no corresponding footage — the video would freeze or
desync for 60% of every cycle, defeating the demo's entire claim. So each world's geometry is
built for exactly the 121 source frames its video covers, rebased to a shared epoch. The loop IS
the generated window (~4 s), and the frontend's sync math reduces to `(t − start)/span × duration`.
This also cuts the objects archive to ~41% of what a full-clip build would produce.

**Three layer-side constraints shaped the UX** (all still true in the tree):

1. **`AnimatedBoundingBoxLayer` has no DataFilter support** (it is CPU-per-frame, outside the
   kind-parity DataFilter matrix). The boxes are unfiltered — moot, since they only mount at
   zoom ≥ 13.5 when you are inside a single world. _Revival trigger:_ adding
   `filterProperty`/`filterRange` to its per-frame sample rebuild is small and would let chips
   reach the agents.
2. **DataFilter is hide-only** — there is no dim mode. Filtered-out worlds lose their geometry,
   so a client-side anchor-dot layer stays drawn at low alpha to keep the grid's shape legible.
3. **`filterSize: 1`** — one numeric column at a time, so chips are single-select rather than
   checkboxes.

**Hero LiDAR — two traps, measured.** Sweep files are numbered by **camera frame, not sweep
ordinal** (10 Hz LiDAR against 30 FPS frames); treating the number as an ordinal walks the clip
three times too fast and silently drops two thirds of the sweeps. And each `.npz` ships its own
authoritative `lidar_to_world` 4×4 that already carries the sensor mount offset (0.776 m forward,
1.937 m up on the probed clip) — lifting by `vehicle_pose` instead drops that extrinsic. Measured
error of the wrong version against the correct placement: **0.8 m at frame 0, 72 m at frame 45,
118 m at frame 150** — a cloud drifting >100 m from its own HD map by mid-clip.

**No-thinning verdict:** ego poses are decimated 30 FPS → 10 Hz **vertices**. That is a
sampling-cadence choice on a continuous signal (~3 cm chord error at speed, below the 0.1 m
coordinate quantization), not feature thinning.

---

## 4. Storm as a 4D object — `storm-4d-greenfield` and `storm-3d-conus`

### 4.1 `storm-4d-greenfield` — one supercell, ten archives

**Source + license.** NEXRAD Level II from `s3://unidata-nexrad-level2` (KDMX, 2024-05-21),
plus IEM warnings/LSRs/ASOS, SPC reports, GOES ABI C13, HRRR, Wyoming soundings, and DOE EAGLE-I
outages (CC-BY 4.0). All NODD/US-gov open; attribute, and do not present derived tiles as
original NOAA data. Ten archives share one playhead; the radar volume is the required governor.

**No-thinning verdict (explicit, and declared in demoMeta):**

- The **dBZ floor (≥ 10)** and the **~150 km spatial crop** are _semantic filters_ —
  below-threshold gates are "no meteorological echo", out-of-crop is out-of-scene. Not thinning.
- **Gate decimation** (0.5 km range × 1.0° azimuth from super-res 0.25 km × 0.5°) is a declared
  **reduced tier** under the Waymo-class amendment; raw Level II remains the citable base.
- All elevation cuts are kept **including SAILS repeats — they ARE the temporal resolution**;
  each gate's timestamp is its own sweep's start time.

**Python + Py-ART, not Rust, deliberately.** Velocity dealiasing is mandatory (raw NEXRAD folds
at ~28 m/s, turning couplets into visual noise) and Py-ART ships `dealias_region_based`;
reimplementing it in Rust is a campaign of its own. Py-ART's `get_gate_lat_lon_alt` also matches
the repo's validated 4/3-earth beam model, and every other weather generator is already
Python → parquet → `stt-build`. _Revival trigger for a Rust port:_ regen cadence starts hurting.

**Couplet detection — one rejected criterion, with the number.** The bare Δv ≥ 30 m/s rule fired
305×/volume on dealias noise up to 368 km out, so peaks now also require spatial coherence (a
neighbouring ray-pair/range-gate carrying ≥ 25 m/s Δv — mesocyclones span multiple gates,
dealias spikes don't) and must sit inside the same `--crop-km` scene. An **opposite-sign
(inbound|outbound) requirement was tried and REJECTED**: it deleted the actual Greenfield EF4
couplet, whose pair at 20:26:00Z was (−62.9, −9.5) m/s — violent rotation embedded in strong
one-signed inflow.

**Perf amendment — the two fixes are GENERAL renderer fixes, not storm-specific.** The composite
first ran at ~4 fps (2.7 s main-thread stalls, ~4,000 tile decodes in the opening seconds, 280+
point sublayers, and a React "Maximum update depth exceeded" crash ~5 s into playback). Two
_storage_ knobs were responsible — no feature, timestamp, or column changed:

1. **1-minute buckets on tiny archives.** At ~288× playback the playhead crossed five 1-min
   buckets per real second, churning selection/fetch/decode/sublayer builds on every one of ten
   tilesets. Worse, `--end-time-field` replicates a feature into every bucket its [start, end]
   overlaps, so each ~30-min warning polygon was stored ~30×. Rebuilt to 1h/30m/2h buckets:
   warnings 4,205 → 113 tiles, reports 1,968 → 80, stations 32,256 → 190, sounding 807 → 4.
2. **Full zoom pyramids under a fixed-framing demo.** Overlay pyramids clamped z3–9 → z3–6
   (cloudtop z3–8 → z3–6, 16,750 → 2,960 tiles, 81 → 42 MB). Detail is unchanged — the base
   level is lossless and the camera never needs deeper spatial partitioning at this framing.

Their renderer counterparts are the durable part, and both apply to **any** full-duplication
archive:

- `SpatioTemporalLayer` grew a `refinementStrategy` prop (`'best-available' | 'no-overlap'`,
  default `'best-available'`). Every storm4d layer passes `'no-overlap'` because these archives
  are FULL-DUPLICATION pyramids (every zoom carries every feature — 18.3 M gates per level on the
  volume), so deck's best-available parent fallback fetched, decoded and drew up to 4 extra
  complete copies of the visible data per bucket.
- `SpatioTemporalTileset.getVisibleTiles` pass-2 parent-cover scan is now clamped to the
  viewport's primary-zoom tile range. The bug this prevents: a parent spatially larger than the
  viewport always contains child cells outside it, which are never selected and so can never
  enter `primaryCover` — without the clamp such a parent passes the "some child uncovered" test
  FOREVER and keeps rendering on top of the fully-streamed primary tiles. The clamp preserves the
  sparse-archive contract (`--min-features-per-tile` omits deep tiles, so an in-viewport cell
  with no primary tile keeps its parent).

**Superseded:** the amendment's optional "rebuild the volume `--min-zoom 6` to drop the z4+z5
duplicate levels (~230 MB of 556 MB)" is obsolete. The generator now bakes a **stratified
`--min-zoom-field` LOD pyramid**: at each zoom below max, a 3D grid (horizontal + vertical cell,
doubling per zoom out) keeps one representative per cell — the **strongest-echo** gate, so the
coarse skeleton is the meaningful storm core rather than noise; gates that never win a cell
default to `max_zoom`, so **the deepest tier stays lossless**. This exists because
`--maximum-tile-features --drop-densest` is a **no-op on a homogeneous point cloud** — every
single-vertex gate scores equally, so the cap just truncates scan order and drops whole regions.

### 4.2 `storm-3d-conus` — the national companion

Where Greenfield goes deep on one supercell from one radar, this scales the same idea to the
whole country from the pre-mosaicked **MRMS 3D reflectivity** product
(`MergedReflectivityQC_<height>`, 33 levels 0.5–19 km, 1 km horizontal, ~2-min cadence) on the
anonymous `noaa-mrms-pds` bucket. Generator `scripts/data-generation/mrms_volume.py`; no Py-ART,
no radar geometry (MRMS is already QC'd and Cartesian). Live on R2.

- **Reflectivity ONLY — no velocity toggle, no couplets.** National dealiased velocity would
  need a ~160-site Level-II mosaic. _Revival trigger:_ appetite for that mosaic.
- **Scale wall (measured):** at ≥ 10 dBZ and native 1 km, one CONUS frame ≈ **17.6 M points** —
  roughly the entire single-site Greenfield archive, per 5-min frame. So the demo ships a SHORT
  high-fidelity window (20:00→20:35Z, 5-min frames) and widens only as the byte budget allows.
  The stratified LOD (§4.1) bounds the _framing_ load regardless of total size.
- **Vertical exaggeration is 15×, against Greenfield's 4×** — a 19 km column is invisibly thin
  against a 4,500 km-wide continent. One shared `elevationScale` per demo across all
  altitude-bearing layers; mixed scales would make the scene lie.
- The dBZ band labels are a **byte-for-byte contract** across `nexrad_volume.py`,
  `mrms_volume.py` and the frontend `STORM4D_DBZ_COLORS`. Drift silently breaks the color map.

---

## 5. Weather → water: `rain-flood-2019`

**Sources + license.** NOAA CMORPH high-resolution hourly precipitation (anonymous NCEI),
contoured into annular isoband polygons, over the NWM v3.0 retrospective river discharge reused
verbatim from `nwm-rivers-2019`. All US public domain. Each archive carries its OWN baked
temporal bucket (rain 2-hourly, rivers daily), so the two cadences coexist on one clock and a
single scrub drives both without re-fetching geometry.

This **replaced the standalone March-2019 flood demo**; `nwm-rivers-flood-2019-03` is gone from
`datasets.ts`. `rainfall-2019` currently 404s on R2 — see §1.3.

**⚠ `--min-zoom 0` is load-bearing.** The overview/storyboard preload tier
(`preloadOverviewTier`, `spatiotemporal-tileset.ts`) enumerates zooms
`max(0, minZoom) … min(overviewMaxZoom = 1, maxZoom)` across the FULL time range and pins them so
a scrub always renders via parent-fallback. If the archive's `min_zoom > 1` that range is EMPTY →
the tier reports `no-tiles` and preloading silently does nothing. So the rain archive MUST build
with `--min-zoom 0`. The composite then overrides the default to pin **z0 only** — one
whole-CONUS tile per bucket, the ideal scrub thumbnail; z1 would double the always-resident cost
for no gain at this framing — with a raised budget, because the tier is dropped wholesale as
`over-budget` if it does not fit. Current tree (`buildDemoLayers.ts`, `case 'polygon'`): 4,380 z0
tiles ≈ 81 MB against a 128 MiB budget.

**Categorical-band rule:** `precip_band` is a non-numeric RANGE label (`"0.5-1"` … `"20+"`) so
stt-build keeps the column categorical — the same rule as `dbz_band`; a bare integer would be
promoted to Numeric and defeat the per-band `colorMapping`. Band thresholds are tuned to the
window: they are mm per accumulation window, so changing `--window-hours` without re-tuning them
collapses the field into the faint tier.

---

## 6. National transit ballets: `gtfs-nl`, `gtfs-ch`

**Sources + license.** Netherlands via OVapi/NDOV national GTFS — **CC0**, with real
`shapes.txt` geometry and free keyless realtime; it was the lowest-risk start. Switzerland via
opentransportdata.swiss — open with attribution plus a keep-updated duty. `gtfs-ch` currently
404s on R2 — see §1.3.

- **The Swiss feed publishes no `shapes.txt`**, so every CH trip uses stop-to-stop geometry. A
  geOps mirror adds shapes if that ever becomes worth the extra dependency.
- **Schedule expansion is a build stage**: a trip runs iff its `service_id` is active on `--date`
  (weekly `calendar.txt` plus `calendar_dates.txt` exceptions, removals win — the NL feed is
  calendar_dates-only). Stops are positioned by `shape_dist_traveled`; shape vertices between
  consecutive stops get timestamps linearly interpolated in shape-distance; **dwell is kept as a
  duplicated stop vertex** so heads visibly pause.
- GTFS times past `24:00:00` are anchored at local midnight in the agency timezone, which is why
  both archives run deep into the following morning.
- **`route_type` is emitted as a STRING label** (bus/rail/tram/…), never the numeric code — an
  all-numeric string column is promoted to Numeric by stt-build inference and the categorical
  `colorMapping` silently no-ops. Same lesson as `dbz_band` and `height_band`.
- Feeds refresh continuously; a stale `--date` just matches fewer services, so re-download and
  re-date together.
- **Not built:** in-shader stop-time-knot interpolation (the stepping stone to analytic motion).
  _Revival trigger:_ an analytic-motion demo that needs it anyway.

---

## 7. `nwm-rivers-2019` — the continental river network

**Source + license.** `s3://noaa-nwm-retrospective-3-0-pds` (anonymous): hourly modeled
streamflow for ~2.7 M CONUS river reaches, 1979 → Jan 2023. Registry terms: "Open Data. There are
no restrictions on the use of this data." Reach geometry from USGS NHDPlusV2 (public domain).
Live on R2. Renders through `FlowCorridorLayer` as-is — zero new layer code, as designed.

- **Self-scaled won.** Each reach is baked against its own annual [p2, p98] log-discharge → [0, 1],
  because absolute `log-q` let the great rivers pin the scale and left every tributary flat-dim.
  `SELF_SCALE_MIN_LOG_SPAN = 0.30` keeps near-constant/regulated reaches dim instead of amplifying
  their noise to full contrast. `log-q` is retained as a `--value` option. All shaping happens in
  the producer because `vertex_value_matrix` is f32-only — `stt:qa` quantization covers `<prop>`
  columns, never the matrix leaf.
- **Per-zoom generalization is baked by the generator**, because `--simplify` and a supplied
  `vertex_value_matrix` are incompatible: the matrix is only accepted when its length is a clean
  multiple of the vertex count (`columnar.rs`), and simplifying changes that count. Bands are a
  `[z, z]` ladder, z4–z8, each zoom carrying its own pre-resampled geometry.
- **Mainstem merging is near-required.** Merging reach chains within runs of constant
  `(LevelPathI, StreamOrde)`, ordered by `Hydroseq`, is a **12× vertex saving at z4** (163 k raw
  2-vertex floors → 13 k merged), and each resampled vertex inherits its source reach's series —
  so a merged mainstem shows the flood front moving downstream through its own geometry.
- **Order-1/2 headwaters at deep zoom was rejected by arithmetic:** order ≥ 2 at z10 = 12.7 M
  vertices → **17.3 GiB raw at 365 buckets**. _Revival trigger:_ a short time window or a
  typical-hydrograph fold that makes the bucket count small.
- **⚠ `--detail-zoom` must not exceed the max tiled zoom.** Vertex spacing targets 2 px at
  `detail-zoom` and is held at ALL zooms (no per-zoom decimation). The archive tiles z4–8, so the
  default 11 bakes ~8× more vertices than even z8 needs — at the CONUS z4 view that is ~1.1 M path
  verts/frame and the rivers+rain composite drops to ~20–30 fps. `--detail-zoom 8` gives ~140 k
  verts/frame at ~60 fps with no visible loss at any rendered zoom, and is safe _only_ because the
  flow matrix is per-reach-constant, so decimating vertices loses no data.
- **Why it compresses:** values rounded to 0.01 in log space give ≤ ~700 distinct f32 bit
  patterns; log-space series change slowly bucket to bucket; resampled vertices within one source
  reach carry byte-identical repeated rows that zstd collapses. Packed-format blob dedup adds
  nothing here — each tile is unique.

---

## 8. Standing rule for every playback demo

Multi-cell playback archives MUST build `--blob-ordering time-major`. `auto` can pick
SpatialMajor (when `time_bits > space_bits + 3`), which scatters every frame across the Hilbert
curve so no bucket ever fully loads, the buffer gate never opens, and playback stutters instead
of erroring. SpatialMajor is only right for single-cell scrub.
