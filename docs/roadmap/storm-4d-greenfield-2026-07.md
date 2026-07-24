# Storm as a 4D Object — Greenfield EF4 volumetric campaign (2026-07)

Status: **RATIFIED 2026-07-22 — comprehensive scope (Waves A+B + C1+C3), in execution.**
Authored 2026-07-22 from a 4-agent scouting pass (repo radar audit, 3D-capability audit,
composite-wiring audit, live data-source verification). §9 is the binding execution
contract shared by all build agents.

## 1. Intent

Build the flagship demonstration that the STT format handles **volumetric spatiotemporal
data, not only XYT paths**: one supercell rendered as a true 4D object —

- NEXRAD Level II radar gates stacked by elevation as a time-animated 3D point volume
- radial-velocity couplets (the mesocyclone) visible as a diverging-color render mode
- lightning embedded in the scene
- warning polygons rising as translucent extruded prisms on VTEC issue/expire clocks
- damage reports and county power outages arriving _behind_ the storm
- cloud-top "anvil canopy" isobands lifted to their brightness-temperature height
- surface stations gusting and multi-level winds threading the volume

This is the depth-first sibling of `severe-weather-2024` (continental, 72 h, 7 archives):
same event window, one storm, full 3D.

## 2. Event package: Greenfield, Iowa EF4 — 2024-05-21

Chosen over the other candidate packages (hurricane landfall, blizzard, AR flood, pyroCb)
because **the existing weather suite already lives on this clock**: `goes-glm-lightning`
(14.4 M flashes, 2024-05-19T11:45 → 05-22T12:00) needs no rebuild, and the MRMS/HRRR/WPC
archives provide continental context for cross-linking.

Verified timeline (UTC, 2024-05-21):

- 18:10 — PDS tornado watch (SPC), NWS Des Moines (DMX) county warning area
- 19:57 — touchdown near Villisca; 42.38 mi path, max width 1,600 yd
- ~20:26–20:32 — crosses Greenfield (41.305, −94.461); EF4, 185 mph official;
  DOW mobile radar measured 263–271 mph at 44 m ARL (~309–318 mph instantaneous
  near-surface — third tornado ever radar-measured above 300 mph). 5 fatalities.
- 20:45 — dissipation; supercells continue east through the evening, outages ongoing.

DOW/FARM mobile-radar data is request-only (not on any open bucket) → narrative color in
demoMeta, **not** a layer.

**Proposed demo window: 2024-05-21 17:30 → 05-22 03:00 UTC** (~9.5 h: pre-watch calm →
tornado → trailing damage/outage wave). The radar-volume archive covers this whole window;
heavy optional context layers may use narrower spans (per-source spans already supported).

## 3. What already exists (scouted 2026-07-22)

| Piece                                                                                                                      | Status                                   | Where                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Level II download/cache/decode, all sweeps + all moments decodable                                                         | ✅ exists                                | `crates/stt-generate/src/datasets/storms.rs`, `nexrad-*` crates                                         |
| 4/3-earth beam model returning per-gate `GeoPoint3D` **with altitude_meters**                                              | ✅ exists (altitude currently discarded) | `crates/stt-generate/src/geo.rs:224-238`                                                                |
| Geometry-native Z for POINTS (`--point-elevation-column`, quantized, zero-copy, `positionDimensions:3`)                    | ✅ exists + tested                       | `crates/stt-build/src/build_options.rs:159`, `packages/core/test/point-3d-geometry.test.ts`             |
| Dense point-cloud rendering (deck `AnimatedPointCloudLayer`/`AnimatedPointLayer` 3D, three `SttPointCloudLayer`)           | ✅ exists (AV LiDAR proven)              | `packages/layers/src/layers/core/animated-point-*.ts`, `packages/three/src/layers/point-cloud-layer.ts` |
| Additive home-zoom LOD for Waymo-class clouds                                                                              | ✅ exists                                | `--min/max-zoom-field`, `lidarLod`, `streaming-tile-source.ts`                                          |
| Extruded polygons (`extruded`, `getElevation`, wireframe)                                                                  | ✅ exists                                | `animated-polygon-layer.ts:132-165`                                                                     |
| Per-feature path altitude (`elevationProperty` on paths)                                                                   | ✅ exists                                | `animated-path-layer.ts:174-211`                                                                        |
| Multi-source composite machinery (governor gating, fairness, per-source runway HUD, cache scaling)                         | ✅ exists                                | `buildDemoLayers.ts`, `PerformanceMonitor.tsx`                                                          |
| GLM lightning archive for this exact window                                                                                | ✅ on R2                                 | `goes-glm-lightning`                                                                                    |
| **Volumetric anything** (multi-sweep stacking, velocity moment, 3D gridding, voxel/isosurface payload, 3D-radar demo type) | ❌ absent                                | roadmap `dataset-candidates-2026-07.md` §G (this doc supersedes that stub)                              |
| Continuous numeric→color ramp on deck point layers                                                                         | ❌ absent (categorical only)             | ramp primitive exists in `packages/core/src/render/style.ts:190-239` and three `rampProperty`           |
| LineString/Polygon geometry-Z                                                                                              | ❌ 2D by design                          | `packages/core/src/tile.ts:665,698`                                                                     |

Key consequence: **the volumetric core is an emit-path change, not a format change.**
Emit per-gate 3D points instead of flattening to the 2D mosaic; the format and renderers
already carry them.

## 4. Data sources (all live-verified 2026-07-22)

| #   | Source               | Access (anonymous unless noted)                                                                                                                                                                                                                                                                                                                               | Verdict                                     |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | NEXRAD Level II      | `s3://unidata-nexrad-level2/2024/05/21/KDMX/KDMX20240521_HHMMSS_V06` (skip `*_MDM`). ⚠ legacy `noaa-nexrad-level2` bucket is **dead (403)** since 2025-09. KDMX = 78 km from Greenfield (0.5° beam ~1.1 km AGL), 52 vols / 850 MB for 18–23Z, 5–7 min cadence (VCP 212 + SAILS). KOAX (159 km, mid-level second view) optional Wave C; KDVN useless (325 km). | EASY                                        |
| 2   | Warning polygons     | IEM `watchwarn.py?accept=shapefile&sts=2024-05-21T00:00Z&ets=2024-05-22T12:00Z&limit1=yes&addsvs=yes` (SBW polygons incl. SVS shrink updates, VTEC issue/expire); GeoJSON: `/api/1/vtec/sbw_interval.geojson?begints=...&endts=...`                                                                                                                           | EASY                                        |
| 3   | Storm/damage reports | SPC `climo/reports/240521_rpts_filtered.csv`; IEM LSR `geojson/lsr.geojson?sts=...&ets=...` (lat/lon + valid time); NCEI Storm Events for QC'd damage $                                                                                                                                                                                                       | EASY                                        |
| 4   | Surface stations     | IEM `asos1min.py?station=...&sample=1min&gis=yes` (verified live: DSM 31 kt gust 20:04Z); METAR fallback `asos.py?network=IA_ASOS` for full station coverage                                                                                                                                                                                                  | EASY                                        |
| 5   | Radiosondes          | Wyoming NEW endpoint `weather.uwyo.edu/wsgi/sounding?datetime=2024-05-21%2018:00:00&id=72558` (OAX **18Z special launch** exists; OAX 12Z missing — hole). IGRA v2 zips as cross-check                                                                                                                                                                        | EASY                                        |
| 6   | Upper-air winds      | HRRR prs on `s3://noaa-hrrr-bdp-pds/hrrr.20240521/conus/hrrr.tHHz.wrfprsf00.grib2` — use `.idx` byte-range subsetting (78 UGRD/VGRD isobaric records ≈ 15–25 MB/cycle vs 400 MB full). ERA5 needs CDS auth → skip; ARCO-ERA5 zarr on GCS is the no-auth reanalysis fallback                                                                                   | EASY                                        |
| 7   | Aircraft ADS-B       | ADSBx samples = 1st-of-month only (**404 for 05-21**). Real option: OpenSky Trino historical (`state_vectors_data4`) — free but requires approved research account (apply via "My OpenSky", days–weeks).                                                                                                                                                      | BLOCKED near-term → Wave C, pending account |
| 8   | Power outages        | EAGLE-I 2014–**2025** on figshare, CC-BY 4.0, direct: `ndownloader.figshare.com/files/53581661` (`eaglei_outages_2024.csv`, 1.44 GB; FIPS + customers-out per 15 min) → filter IA counties                                                                                                                                                                    | EASY                                        |
| 9   | GOES ABI             | `s3://noaa-goes16/ABI-L2-CMIPC/2024/142/HH/...C13...` (5-min CONUS, ~4 MB/file C13). Meso sector `ABI-L2-CMIPM1` verified 1-min ~350 KB/file, but footprint must be confirmed by opening one file. C02 visible = 67 MB/file → skip                                                                                                                            | EASY                                        |
| 10  | GLM lightning        | already archived (`goes-glm-lightning`) — subset by demo timeRange, no rebuild                                                                                                                                                                                                                                                                                | DONE                                        |

Raw-pull budget (core): KDMX 17:30–03:00 ≈ 1.5 GB; HRRR subset ≈ 250 MB; ABI C13 ≈ 460 MB;
EAGLE-I CSV 1.44 GB (one-time, filtered immediately); everything else KB–MB. **≈ 4 GB total.**

## 5. Architecture

### 5.1 New generator: `scripts/data-generation/nexrad_volume.py` (Python + Py-ART)

Python, not Rust, for v1 — deliberate:

- **Velocity dealiasing is mandatory** (Nyquist folding at ~25–35 m/s turns couplets into
  visual noise) and Py-ART ships `dealias_region_based`; reimplementing in Rust is a
  campaign of its own.
- Py-ART's `get_gate_lat_lon_alt` matches our validated 4/3-earth model.
- All other weather-suite generators are already Python → parquet → `stt-build`.
- Rust port (fast regen, shared beam code) is a declared follow-up if regen cadence hurts.

Emit per (thresholded, cropped, decimated) gate:
`lon, lat, alt_m, timestamp (sweep time), dbz, vel_ms, sweep_deg` →
GeoParquet → `stt-build --point-elevation-column alt_m --temporal-bucket 5m`.

Data-policy compliance (no-thinning principle + 2026-07-10 Waymo-class amendment):

- **dBZ floor (≥ ~10 dBZ)** and **spatial crop (~150 km radius of Greenfield)** are
  _semantic filters_ (below-threshold gates are "no meteorological echo", out-of-crop is
  out-of-scene), declared in demoMeta — not thinning.
- **Gate decimation (e.g. 0.5 km × 0.5–1.0° from super-res 0.25 km × 0.5°)** is a declared
  reduced tier under the Waymo-class amendment; raw Level II remains the citable base.
- If needed at low zooms: additive home-zoom LOD (existing `--min/max-zoom-field` path).

Size model (verify in W-A0 before committing): ~10–20 M gates/volume raw → ~1–3 M above
floor in crop → ~0.5–1 M after decimation × ~100 volumes (9.5 h) ≈ **50–100 M points**;
at GLM-like ~10–15 B/feature ≈ **0.6–1.4 GB** archive. Gate: **≤ 1.2 GB** or tighten knobs
(decimation, crop, window) — knobs documented in the script header like `hrrr_advect.py`.

Derived mini-archives from the same volumes:

- `storm4d-couplet` (Wave C): azimuthal-shear local maxima on the 0.5° velocity sweep →
  a handful of mesocyclone marker points/track. Cheap detection, big narrative payoff.

### 5.2 New/derived archives

| Archive                      | Kind                                                                                 | Source                                                           | Est. size                   | Bucket             |
| ---------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------- | ------------------ |
| `storm4d-volume`             | 3D points (geometry-Z), cols `dbz_band`, `vel_band`, `sweep_deg`, raw `dbz`,`vel_ms` | NEXRAD L2 KDMX                                                   | ≤ 1.2 GB (gated)            | 5 m                |
| `storm4d-warnings`           | polygons, VTEC cols, extruded at render                                              | IEM SBW `addsvs`                                                 | ~1 MB                       | event-driven (1 m) |
| `storm4d-reports`            | points (LSR type, magnitude, remarks)                                                | IEM LSR + SPC                                                    | ~1 MB                       | 1 m                |
| `storm4d-stations`           | points (wind, gust, pres, temp; 1-min)                                               | IEM ASOS 1-min                                                   | ~10 MB                      | 1 m                |
| `storm4d-outages`            | county polygons, `customers_out` per 15 min → extruded                               | EAGLE-I + county TIGER                                           | ~5–20 MB                    | 15 m               |
| `storm4d-cloudtop`           | isoband polygons of C13 BT, **per-feature elevation = BT→height** ("anvil canopy")   | GOES ABI C13                                                     | ~100–300 MB (gate: measure) | 5 m                |
| `storm4d-wind3d`             | multi-level particle trips, per-feature `level_alt_m`                                | HRRR prs (extend `hrrr_advect.py` for level list + altitude col) | ~100–200 MB                 | 2 h                |
| `storm4d-sounding`           | balloon-ascent points (alt from levels, drift integrated from wind profile)          | Wyoming OAX 18Z                                                  | ~KB                         | 1 m                |
| (reuse) `goes-glm-lightning` | existing archive, timeRange subset                                                   | —                                                                | 0 new                       | 15 m               |

### 5.3 Showcase wiring: new type `storm4d`

Follow the documented composite checklist (types.ts union + `*Url` fields →
`resolveDataUrl` map → `buildDemoLayers` case → `archiveCount` switch → demoMeta →
`LOCAL_ONLY_DATASETS` until r2-synced → `SHIPPED_DATASET_IDS`).

Layer mapping (painter order bottom→top):

1. `storm4d-outages` → `AnimatedPolygonLayer` extruded by `customers_out` (dark red prisms)
2. `storm4d-cloudtop` → `AnimatedPolygonLayer`, per-feature `elevationProperty` (translucent canopy)
3. `storm4d-wind3d` → `AnimatedPathLayer`/`AnimatedTripsLayer` at `level_alt_m`
4. **`storm4d-volume` → `AnimatedPointCloudLayer` (or `AnimatedPointLayer` billboard)** —
   primary/governor. Two render modes toggled in UI: reflectivity (`dbz_band` categorical
   NWS ramp, `filterProperty: dbz` GPU threshold slider) and velocity (`vel_band`
   diverging categorical, couplet reading)
5. `storm4d-warnings` → `AnimatedPolygonLayer` extruded ~12 km, wireframe+translucent
6. `storm4d-stations` → `AnimatedPointLayer` (radius = gust) or `AnimatedIconLayer` barbs
7. `storm4d-reports` → `AnimatedPointLayer`, wake, arriving behind the storm
8. `goes-glm-lightning` → existing additive splat treatment (altitude: flag §7)
9. `storm4d-sounding` → tiny 3D ascent trail (delight layer)

Camera: pitched `MapView`, `pitch ~55`, `maxPitch 85`, centered on the storm path.
**Single shared vertical exaggeration** (one `elevationScale`, likely 3–5×) across ALL
altitude-bearing layers — mixed scales would make the scene lie.

deck ramp gap: v1 uses categorical bands (proven `storm-radar` pattern; ~14 dBZ bands,
±5 kt velocity bins). Optional polish: `rampProperty` on `AnimatedPointLayer` reusing
`expandRampColors` from core (three backend already has it).

## 6. Waves

### Wave A — volumetric core (the demo exists after this)

- **A0 (gate)**: `nexrad_volume.py` on ONE volume (21:00Z KDMX) → measure gates-above-floor,
  bytes/point, fps of a single-timestep archive in showcase. Tune knobs; go/no-go on size model.
- A1: full-window `storm4d-volume` build (17:30–03:00, 5-min buckets, dealiased velocity).
- A2: `storm4d-warnings` + `storm4d-reports` generators (trivial fetch+shape scripts).
- A3: showcase `storm4d` type wired: volume (both render modes + dBZ slider) + extruded
  warnings + reports + reused lightning; per-demo cache scaling; LOCAL_ONLY until synced.
- A4: suites green, dists rebuilt; fps target ≥ 45 median on the composite; user browser verify.

### Wave B — context layers

- B1: `storm4d-outages` (EAGLE-I filter + TIGER county polygons, extruded).
- B2: `storm4d-cloudtop` (C13 marching-squares isobands, BT→height lift; meso-sector
  1-min upgrade only after footprint check).
- B3: `storm4d-stations` (ASOS 1-min; icon-barb option assessed against `animated-icon-layer` angle support).
- B4: `storm4d-wind3d` (`hrrr_advect.py` multi-level extension) + `storm4d-sounding`.
- B5: demoMeta narrative (DOW 300-mph story, WoFS 75-min lead time), legend, r2-sync, un-gate.

### Wave C — stretch / deferred

- C1: couplet auto-detection markers (azimuthal shear).
- C2: KOAX dual-radar second viewpoint (mid-level fill).
- C3: `rampProperty` continuous colors on deck point layer.
- C4: OpenSky aircraft (**blocked on research-account approval** — apply early, wire when granted).
- C5: three-backend variant (native ramps, globe/atmosphere cinematics).
- C6: Rust port of the volume generator.

## 7. Open design questions (resolve in A0/A3)

1. GLM flashes have **no altitude** (2D instrument): render at ground under the volume, or
   lift to nominal anvil height (~10 km) as declared stylization? (Leaning: ground + glow.)
2. `AnimatedPointCloudLayer` (lit, constant size) vs `AnimatedPointLayer` (billboard,
   radius-by-value, splat) for the volume — A0 decides on look + fps.
3. Volume archive zoom range (z4–9 like storms? tighter z5–10?) and whether home-zoom
   additive LOD is needed at all for a 150 km crop.
4. Warning-prism height: fixed 12 km vs echo-top-derived.
5. Exact window trim if the 1.2 GB gate fails (17:30–03:00 → 18:00–00:00 fallback).

## 8. Risks

- **Volume-archive fps** is the campaign risk: 50–100 M filtered points is AV-LiDAR-class;
  mitigations exist (LOD, decimation, crop, dBZ slider defaults) but A0/A4 gates are real.
- Dealiasing failures near the couplet (region-based can seed wrong) — spot-check 20:20–20:35Z.
- Meso-sector footprint unverified → C13 CONUS 5-min is the committed baseline.
- 1-min ASOS network is sparse near Greenfield (DSM is ~80 km) — METAR 5-min fallback
  covers small towns; expectation set in demoMeta.
- r2-sync: **all `storm4d-*` archives must sync before un-gating** (404-stall rule).

## 9. Execution contract (BINDING for all build agents — 2026-07-22)

Any deviation from this section must be reported as a `deviations` entry, never applied
silently. FE colorMapping keys and generator band labels MUST match byte-for-byte.

### 9.0 Global

- Demo id `storm-4d-greenfield`, dataset `type: 'storm4d'`.
- timeRange: `2024-05-21T17:30:00Z` → `2024-05-22T03:00:00Z`.
- initialViewState: lon −94.46, lat 41.40, zoom 8, **pitch 55, bearing 25**, maxPitch 85.
- **Altitude = property column** (LiDAR pattern: `use3D` + `elevationProperty` +
  `elevationScale`), NOT geometry-Z fold — so one shared vertical exaggeration works.
  Module const in buildDemoLayers: `STORM4D_ELEVATION_SCALE = 4`, applied to EVERY
  altitude-bearing layer.
- Storm reference point (crop center): `41.305, −94.461` (Greenfield).
- Smoke window for pipeline validation: `2024-05-21T20:00Z → 20:30Z`.
- Raw-download cache: `scripts/data-generation/data/storm4d/<source>/` (idempotent —
  skip files already present).
- Archives output to `examples/showcase/public/data/<stem>/` via the freshly built
  `target/release/stt-build` (parquet input, packed default). Python: `venv-storm4d`
  (Py-ART) for radar; main `venv` (xarray/cfgrib/netCDF4) for GOES/HRRR; plain
  urllib/HTTPS for S3 (`https://<bucket>.s3.amazonaws.com/<key>`), no boto3.

### 9.1 Archive schemas (stem → kind, columns, bands, bucket, zoom)

**`storm4d-volume`** — POINTS, bucket `5m`, zoom 4–9, target **≤ 1.2 GB**.
Per gate: `timestamp` (sweep start time), `alt_m` f32 (beam-height AGL+site elev, from
Py-ART `get_gate_lat_lon_alt`), `dbz` f32, `vel_ms` f32 (region-based **dealiased**;
NaN→omit vel columns for refl-only gates), `sweep_deg` f32, `dbz_band` str, `vel_band` str.
Knobs (A0-tunable, defaults): dBZ floor ≥ 10; crop ≤ 150 km of reference point;
decimate to 0.5 km range × 1.0° azimuth (from super-res 0.25 km × 0.5°); all elevation
cuts kept (SAILS repeats kept — they ARE the temporal resolution, timestamp per sweep).

- `dbz_band` labels (5-dBZ): `"10-15","15-20","20-25","25-30","30-35","35-40","40-45",
"45-50","50-55","55-60","60-65","65-70","70+"`.
- `vel_band` labels (m/s, negative = toward radar): `"in-extreme"` (≤−40),
  `"in-strong"` (−40,−25], `"in-mod"` (−25,−10], `"calm"` (−10,10), `"out-mod"` [10,25),
  `"out-strong"` [25,40), `"out-extreme"` (≥40).

**`storm4d-couplet`** — POINTS (C1), bucket `5m`, zoom 3–9. Detection on the lowest
dealiased velocity sweep: max gate-to-gate azimuthal Δv over adjacent radials within
2 km range bins; cluster peaks with Δv ≥ 30 m/s within 5 km; emit one marker per cluster:
`timestamp`, `strength_ms` f32 (peak Δv), `alt_m` f32 (beam height at marker).

**`storm4d-warnings`** — POLYGONS, bucket `1m`, zoom 3–9. One feature per SBW phase
(IEM `addsvs=yes` — each SVS shrink is its own feature): `timestamp` (phase start),
`end_timestamp` (phase end/expire), `phenom` str (`"TO"|"SV"|"FF"`), `etn` str.

**`storm4d-reports`** — POINTS, bucket `1m`, zoom 3–9. IEM LSR (+SPC cross-check):
`timestamp`, `kind` str (`"tornado"|"hail"|"wind"|"damage"|"flood"|"other"`),
`magnitude` f32 (hail inches / gust kt, 0 if n/a), `remark` str (≤ 120 chars).

**`storm4d-stations`** — POINTS, bucket `1m`, zoom 3–9. IEM 1-min ASOS (IA + border
sites within bbox [−98, 39, −90, 44]) + IA_ASOS METAR fallback for non-1-min sites:
per (station, minute): `timestamp`, `station` str, `wind_kt` f32, `gust_kt` f32,
`drct_deg` f32, `tmpf` f32, `gust_band` str: `"calm"` (<15), `"breezy"` [15,25),
`"windy"` [25,35), `"severe"` [35,50), `"extreme"` (≥50).

**`storm4d-outages`** — POLYGONS, bucket `15m`, zoom 3–8. EAGLE-I 2024 filtered to Iowa
(+ border MO counties in bbox above); county geometry from Census cartographic boundary
(20m simplified) via pyshp; one feature per (county, 15-min interval) where
customers_out > 0: `timestamp`, `end_timestamp` (+15 min), `county` str, `fips` str,
`customers_out` i32. FE extrudes by `customers_out`.

**`storm4d-cloudtop`** — POLYGONS, bucket `5m`, zoom 3–8, size gate ≤ 300 MB.
GOES-16 `ABI-L2-CMIPC` C13 per 5-min scan, cropped to bbox [−102, 37, −87, 46],
marching-squares isobands of brightness temperature every 10 K over 280→190 K:
`timestamp` (scan start), `end_timestamp` (+5 min, cross-dissolve), `bt_band` str
(`"270-280","260-270",…,"200-210","<200"`), `top_alt_m` f32 = standard-atmosphere height
of band-mid BT (piecewise linear: 288.15 K→0 m, 216.65 K→11 km, <216.65 K→
11 km + 500 m per −10 K, capped 16 km). FE lifts each band to `top_alt_m`.

**`storm4d-wind3d`** — TRIPS (per-vertex timestamps, hrrr_advect pattern), bucket `2h`,
zoom 3–6. Levels 850/700/500/250 mb, ~2,500 particles each, per-feature `level_mb` i32 +
`level_alt_m` f32 (1457/3012/5574/10363), per-vertex speed for gradient. HRRR prs f00
cycles 17–03Z via `.idx` byte-range subsetting (UGRD/VGRD at the 4 levels only).

**`storm4d-sounding`** — POINTS, bucket `1m`, zoom 3–9. OAX (72558) 2024-05-21 18Z
special launch (Wyoming wsgi endpoint): one point per reported level, `timestamp` =
18:00Z + alt/(5 m s⁻¹) ascent, position drift-integrated from the wind profile:
`alt_m`, `tmpc` f32, `dwpc` f32, `wspd_kt` f32.

**(reuse)** `goes-glm-lightning` — existing archive, timeRange-subset at render;
lightning renders at GROUND with existing additive splat treatment (§7 Q1 resolved:
no fabricated altitude).

### 9.2 FE wiring (single agent owns ALL showcase edits)

- New `*Url` fields on the dataset: primary `url` = volume; `coupletUrl`, `warningsUrl`,
  `reportsUrl`, `stationsUrl`, `outagesUrl`, `cloudTopUrl`, `wind3dUrl`, `soundingUrl`,
  reuse `lightningUrl`. Every one added to types.ts AND the `resolveDataUrl` map.
- Painter order bottom→top: outages (extruded, dark red translucent) → cloudtop (canopy
  at `top_alt_m`, translucent) → wind3d (paths at `level_alt_m`) → **volume** (primary/
  governor; `AnimatedPointLayer` billboard, `elevationProperty:'alt_m'`) → warnings
  (extruded 12,000 m, wireframe + translucent walls, TO red/SV amber/FF green) →
  couplet (white stroked ring markers, radius by `strength_ms`) → stations (radius by
  `gust_kt`, `gust_band` colors) → reports (wake, `kind` colors) → lightning (additive
  splat, topmost) → sounding (small trail).
- Volume render modes: reflectivity (`dbz_band`, NWS green→magenta) ↔ velocity
  (`vel_band`, green inbound / red outbound diverging). Reuse the cleanest existing
  in-demo toggle mechanism; two demo variants acceptable as fallback. GPU dBZ filter via
  `filterProperty:'dbz'` — reuse the earthquakes DataFilter slider mechanism if present.
- `archiveCount` switch: storm4d = **10**. Add id to `LOCAL_ONLY_DATASETS` (stays gated
  until r2-sync) + `SHIPPED_DATASET_IDS`. Legend + demoMeta (timeline, DOW 300 mph,
  WoFS 75-min lead, per-source build commands) required.

### 9.3 C3 layer work (separate agent, packages/layers only)

`rampProperty` / `rampDomain` / `rampColorRamp` on `AnimatedPointLayer` reusing core
`expandRampColors` (`packages/core/src/render/style.ts`); tests; rebuild layers dist.
FE v1 ships categorical bands regardless (ramp is follow-up polish, not a dependency).

### 9.4 Perf amendment — §9.1 buckets/zooms revised (2026-07-23)

The composite ran at ~4 fps (measured: Playwright+CDP probe, 2.7 s main-thread
stalls, ~4,000 tile decodes in the opening seconds, 280+ point sublayers, and a
React "Maximum update depth exceeded" crash ~5 s into playback as the event
avalanche flushed). Two §9.1 choices were responsible; both are STORAGE
knobs — no feature, timestamp, or column changed (no thinning):

1. **1-minute buckets on tiny archives.** At the demo's ~288× playback the
   playhead crossed five 1-min buckets per real second, churning selection /
   fetch / decode / sublayer builds on every one of ten tilesets. Worse,
   `--end-time-field` replicates a feature into every bucket its [start, end]
   overlaps, so each ~30-min warning polygon was stored ~30×. Rebuilt:
   warnings + reports `1m → 1h`, stations `1m → 30m`, sounding `1m → 2h`
   (whole flight = one bucket). Tile counts: warnings 4,205 → 113, reports
   1,968 → 80, stations 32,256 → 190, sounding 807 → 4.
2. **Full zoom pyramids under a fixed-framing demo.** Overlay pyramids clamped
   `z3–9 → z3–6` (cloudtop `z3–8 → z3–6`, 16,750 → 2,960 tiles, 81 → 42 MB);
   detail is unchanged — the base level is lossless (no-thinning default) and
   the camera never needs deeper spatial partitioning at this framing.

Renderer counterparts (general fixes, landed with this amendment):

- `SpatioTemporalLayer` grew a `refinementStrategy` prop; every storm4d layer
  passes `'no-overlap'` because these archives are FULL-DUPLICATION pyramids
  (every zoom carries every feature — 18.3M gates per level on the volume), so
  deck's best-available parent fallback fetched + decoded + drew up to 4 extra
  complete copies of the visible data per bucket.
- `SpatiotemporalTileset.getVisibleTiles` pass-2 parent-cover scan is now
  clamped to the viewport's primary-zoom tile range: a parent larger than the
  viewport could never be "covered" by its (never-loaded) out-of-viewport
  children and rendered forever on top of the streamed primary tiles.

The volume archive itself is UNCHANGED (bucket 5m, z4–9): with `'no-overlap'`
the extra zoom levels cost nothing at runtime. OPTIONAL before the R2 sync:
rebuild it `--min-zoom 6` to drop the z4+z5 duplicate levels (~230 MB of the
556 MB) — requires re-deriving the parquet from the cached Level II files
(`nexrad_volume.py --skip-fetch`, ~10 min).

Old archives kept beside the new as `storm4d-*.old/` (gitignored) until the
user's browser verify; delete after.

## 10. Iso-line cut — `storm4d-isolines` / demo `storm-4d-isolines` (2026-07-24)

A SECOND rendering of the same storm, built on request: the rain as CAPPI
**contour sheets** instead of a gate point cloud. Same event, same window, same
nine context archives (byte-identical — nothing was rebuilt); only the primary
archive and the layer that draws it differ. The two demos are meant to be read
against each other: the point cloud answers *where is the echo*, the sheets
answer *what shape is it* (core lean with height, anvil overhang, gradient
tightness where the rings crowd).

### 10.1 Why gridding, and why it is not thinning

A radar volume is a cone of tilted sweeps, so there is no constant-altitude
surface to contour until the polar gates are interpolated onto a Cartesian
grid. `nexrad_isolines.py` does that with Py-ART `grid_from_radars` (origin =
Greenfield, `grid_origin_alt = 0` so `alt_m` means MSL exactly as in
`storm4d-volume`), then contours each z-slice with contourpy.

Contours are a DERIVED product with the same status as `storm4d-cloudtop`'s
GOES isobands: the lossless, citable base stays `storm4d-volume` (every gate
above the semantic 10 dBZ floor). Grid resolution, contour levels, smoothing and
the simplify tolerance are presentation knobs of the derived geometry, not
feature thinning.

### 10.2 Measured decisions (KDMX 2024-05-21T20:24:22Z volume, unless noted)

| Decision | Measurement that forced it |
|---|---|
| **`weighting_function='nearest'`**, not Py-ART's `Barnes2` default | Raw sweep max **66.5 dBZ**. Barnes2 grid max **62.5** and per-level maxima 56/56/57/61/63…; after the contour pre-smooth only **2 rings** survived at 60 dBZ across all levels — the core isopleth all but vanished. `nearest` grids to **65.5** (per-level 64/64/66/65/64/66…) and is ~2× faster. The blockiness it leaves is what `--smooth-cells` is for. |
| **1 km horizontal grid** | The 0.5° beam is already ~1.3 km wide over Greenfield (78 km from KDMX). A 0.5 km grid cost 1.7 s vs 1.1 s and moved the per-level maxima by ≤2 dBZ — it invents detail the radar never resolved. |
| **15 CAPPI levels, 1 km spacing, 1–15 km MSL** | Ring counts peak at 9–10 km (the anvil), not at the ground: 26–75 rings/level at the tornado volume. 1 km spacing terraces visibly at the demo's 4× exaggeration. |
| **9 contour levels, 20→60 dBZ** | 60 dBZ yields **254 rings across the whole 9.5 h window** and 65 dBZ yields zero — the grid's own ceiling. Levels above 60 are dead weight. |
| **`--no-clip`** | A duration LineString that IS clipped goes through `clip_trajectory`, which interpolates per-vertex times along the path (`compute_vertex_timestamps`) — a closed isopleth would then animate as if it were being *drawn*. Whole-ring placement (`place_whole_feature`) is the only correct route, same as the AV density iso-lines. |
| **z5–7 pyramid** | With whole-ring placement the pyramid is pure duplication: deeper levels add no detail (a ring is never cut) and a ring whose centroid tile leaves the viewport would wink out. 674 tiles, **73 MB** packed. |
| **No `--quantize-coords`, no `--simplify`** | Inherited constraints: quantizing multi-vertex LineStrings mis-sizes PathLayer's instanced draw; `--simplify` distorts isopleths. Simplification happens in lon/lat at 0.002° (~200 m ≪ the 1 km cell). |

Full window (17:30→03:00Z, 93 cached volumes, 5 workers): **2 min wall**,
100,129 rings, 2.24 M vertices, 37 MB parquet, **73 MB archive** — against the
gate volume's 556 MB, because a contour spends vertices only on the boundary.

### 10.3 The timing contract (the part that breaks silently)

KDMX runs this window at a **~6.4 min median cadence** (measured: 386 s), NOT
the 5 min the temporal bucket suggests, and it drifts. Three facts have to line
up or the sheets either blink out between scans or stack two deep:

1. **Validity is derived from the NEXT scan**, not a fixed pad:
   `end_timestamp = next_scan_start + --fade-ms` (`scan_validity`), capped at
   2× the median cadence so a DATA gap reads as missing rather than as one
   frozen storm.
2. **The FE fades must equal `--fade-ms`** (both default 90 s):
   `STORM4D_ISO_FADE_MS` in `buildDemoLayers.ts`. The outgoing scan then ramps
   1→0 over exactly the span its successor ramps 0→1 — constant alpha through
   the handoff, the WPC-fronts cross-dissolve trick.
3. **The render window is ~zero** (`STORM4D_ISO_TIME_WINDOW_MS = 1 s`) because
   the features carry their own validity; the dataset's 360 s window belongs to
   the instantaneous point overlays and would stack three scans of contours.
   But `stt-build` files a feature in the bucket of its START time only
   (`chunk_by_temporal_bucket` — it does NOT replicate across the buckets its
   validity spans), so the tile-SELECTION window must out-reach both the scan
   cadence and the bucket: `tileLoadTimeWindow = ±10 min`.

### 10.4 Schema (`storm4d-isolines`) — LINESTRINGS, bucket `5m`, zoom 5–7

Per contour ring: `timestamp` (volume-scan start), `end_timestamp` (§10.3),
`alt_m` f32 (CAPPI level, metres MSL), `dbz` f32 (the contour's level — the GPU
`filterProperty` the threshold drives), `dbz_level` str, `alt_band` str.
Label contracts (FE `colorMapping` keys match byte-for-byte):
- `dbz_level`: `"20","25","30","35","40","45","50","55","60"`
- `alt_band`: `"1km"`, `"2km"`, … `"15km"`

FE (`stormVolumeMode: 'isolines'` on the dataset): `AnimatedPathLayer` with
`elevationProperty: 'alt_m'` × the SAME `STORM4D_ELEVATION_SCALE = 4` as every
other altitude-bearing layer, plus `elevationOpacityRange [1000, 15000]` /
`elevationOpacityFar 0.45` so the anvil sheets go translucent and the stack
stays readable from above. The render-mode toggle swaps the categorical column
between `dbz_level` and `alt_band` in place.

### 10.5 Open

- `storm4d-isolines` is **local-only** (`LOCAL_ONLY_DATASETS`) until r2-sync
  lands it — it is the composite's governor, so an un-gated deploy 404-stalls
  the whole demo.
- Browser verify (aesthetics: sheet density, whether the cloud-top canopy fights
  the thin lines, the fade timing at 288× playback).
- Counted out for v1: **velocity iso-lines**. Contouring dealiased velocity on
  the same grid is a one-flag change, but the toggle would have to swap the
  FEATURE SET rather than a color column (a dBZ ring colored by velocity is
  meaningless), which the in-place render-mode mechanism cannot express.
  Revival trigger: a categorical GPU filter (today's `filterProperty` is
  numeric-only), which would let one archive carry both moments.
