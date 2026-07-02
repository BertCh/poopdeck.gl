# New large-dataset candidates for the STT showcase — research report (2026-07-01)

**Status: ANALYSIS-ONLY.** Nothing here is built. This is a verified shortlist of new large datasets that
would be visually compelling in the showcase and would force genuinely new rendering / data-representation
techniques the stack does not have yet.

**Method.** A multi-agent deep-research run (106 agents; fan-out search → source fetch → 3-vote adversarial
license/claim verification) plus a second targeted verification wave over the categories the first pass did
not reach. Every license verdict below was verified **verbatim against the live license page on 2026-07-01**,
and every "verified" bulk endpoint was confirmed by an actual anonymous request where possible. AWS Open Data
registry listing was explicitly confirmed to imply **nothing** about license (counterexample: nuScenes is
listed but NC) — each verdict is against the upstream licensor.

**Hard requirement applied throughout:** processed STT tiles are publicly rehosted on Cloudflare R2, so
redistribution of *derived products* must be permitted. CC-BY / public-domain / CC0 / ODbL pass;
non-commercial or no-redistribution terms are blockers (the Waymo lesson).

---

## 1. Where the format actually has gaps (code-verified)

The tile format today is strictly **vector-feature**: Point / LineString / Polygon layers, per-feature
`start_time`/`end_time`, optional per-vertex times (LineString only), scalar + categorical + vector-group
(`FixedSizeList`) columns, `vertex_value_matrix` as the space-time-cube primitive, pre-tessellated triangles,
opt-in quantization. Confirmed **absent** from the payload (they exist only as build-time intermediates or
unbuilt roadmap items in `preprocessing-framework.md`):

| Gap | Evidence |
|---|---|
| Raster / gridded time-series tiles | `raster_tier` scaffold was removed (`stt-core/src/metadata.rs`); radar pipeline vectorizes grids to isoband polygons at build |
| Eulerian vector fields + particle advection | no flow-field primitive anywhere; "currents" are Lagrangian trips |
| Volumetric (3D field) data | voxels only as LiDAR build-time decimation concept; rendered output is 2D-geometry surfels |
| Analytic / parametric motion | all motion is baked sampled vertices; `satellites.rs` runs SGP4 **at build** (60 s steps) and bakes LineStrings, dropping altitude |
| True vertical axis over time | 3D `[x,y,z]` points exist (elevation fold) but no dataset exercises a *changing* z |
| Schedule/graph-constrained movement | OSRM routing exists (BIXI) but nothing schedule-expanded at national scale |

The candidates below are chosen to hit these gaps.

---

## 2. Candidates, grouped by the technique they force

### A. Eulerian wind fields + GPU particle advection — **NOAA HRRR / GFS** ⭐

- **Access (verified live, anonymous):** `s3://noaa-hrrr-bdp-pds` and `s3://noaa-gfs-bdp-pds` (us-east-1),
  no credentials, no requester-pays. GRIB2 (~90 MB files) + Zarr U/V wind. HRRR = 3 km CONUS, hourly runs,
  radar assimilated every 15 min; GFS = global 0.25°, 4×/day. Combined >7 PB under NOAA NODD.
- **License: YES.** NODD/US-gov: data "open to the public and can be used as desired"; derived products must
  not be passed off as original NOAA data, no implied endorsement. R2 hosting fine.
- **Why compelling:** this is literally the source class behind earth.nullschool and windy.com (cambecc/earth
  confirms GFS via NOMADS). Streamlines/particles over a hurricane landfall or a derecho (pairs with the
  existing storm-radar demo) is the single most iconic missing visual.
- **New tech:** a **vector-field tile tier** (u,v grids per time bucket, quantized — the raster/grid tier and
  this can share an encoding) + a GPU particle-advection layer (deck.gl custom layer + TSL port). Time
  interpolation between hourly fields on-GPU.
- **Risks:** GRIB2 decode in Rust (crates exist; or preprocess via wgrib2/Python); designing the grid tile
  encoding; HRRR eventually superseded by RRFS v2 (~2027-28, archive remains).

### B. Billions-of-events density LOD — **GOES GLM lightning** ⭐

- **Access (verified live, anonymous):** `s3://noaa-goes16|18|19/GLM-L2-LCFA/YYYY/DDD/HH/…nc` — one NetCDF
  per **20 seconds** (~345–437 KB), ~4,320 files/day/satellite, ~600 GB/yr/satellite. Continuous since 2018.
- **Scale:** ~13 **billion** events (~320 M flashes) per satellite-year, per-event millisecond timestamps,
  hemispheric coverage. Native **event → group → flash hierarchy**.
- **License: YES.** Same NODD terms as above.
- **Why compelling:** storms as pulsing point clouds sweeping the hemisphere through day/night cycles —
  arguably the best open "billions of timed points" dataset in existence.
- **New tech:** per-zoom **density aggregation baked at build** (the event→group→flash hierarchy maps
  naturally onto zoom LOD — flashes at low zoom, raw events deep) — this is the flagship first customer for
  the preprocessing-framework cube/sufficient-stats design. Additive zoom-LOD machinery from the LiDAR work
  reuses directly.
- **Risks:** ingest is S3-list/IO-bound (~1.5 M files/satellite-year — pick one satellite-year or one storm
  season); NetCDF group parsing; GOES-East handover G16→G19 (Apr 2025).

### C. Schedule-constrained national transit ballet — **Netherlands GTFS (or Switzerland / Germany)** ⭐

| Country | Feed (verified) | Size | Scale | License | shapes.txt | GTFS-RT |
|---|---|---|---|---|---|---|
| **Netherlands** | `gtfs.ovapi.nl/nl/gtfs-nl.zip` (daily) | 226 MB | 907 K trips, 18.1 M stop_times | **CC0** (NDOV/OVapi) | **yes, 7.39 M pts** | **open, no key** (incl. vehiclePositions.pb) |
| Switzerland | `data.opentransportdata.swiss/...gtfs2020/permalink` | 188 MB | 1.66 M trips, 26.4 M stop_times | YES, attribution + keep-updated duty | **no** (geOps mirror `gtfs.geops.ch/dl/gtfs_complete.zip` adds them) | TripUpdates only, keyed, 2 req/min |
| Germany | `download.gtfs.de/germany/free/latest.zip` | 262 MB | 1.67 M trips, 34.5 M stop_times | CC BY 4.0 (DELFI) | no (paid tier only) | yes (CC BY-SA) |
| Norway / Sweden / Finland | Entur / Trafiklab / Fintraffic | — | national | NLOD 2.0 / CC0 / CC-BY | varies | yes |
| Japan (ODPT) | — | — | — | **NO / risky** — bespoke license text unverifiable without account; only patchwork CC-BY subsets | — | — |

- **Why compelling:** Mini Tokyo 3D, nation-scale — every train, bus, tram and ferry in a country moving on
  schedule for 24 h. NL is the lowest-risk start (CC0 + real geometry + free realtime positions); CH is the
  prettiest network (boats, funiculars, PostBus); DE is the biggest spectacle.
- **New tech:** **schedule expansion as a build stage** (calendar/calendar_dates → concrete trip instances →
  per-vertex timestamps along shapes) — mostly reuses the trips/trip-heads pipeline, so this is the cheapest
  headline demo. Optionally a novel representation: store per-trip (shape ref + stop-time knots) and
  interpolate in-shader instead of baking dense vertices — a stepping stone to analytic motion.
- **Risks:** service-day expansion correctness (a solved, testable problem); NL feed includes cross-border
  fringe to clip; CH terms include an "update tiles when source updates" obligation.

### D. Network flow on a natural network — **NOAA National Water Model retrospective** ⭐

- **Access (verified):** `s3://noaa-nwm-retrospective-3-0-pds` (anonymous, NetCDF + Zarr): **hourly modeled
  streamflow for ~2.7 M CONUS river reaches, 1979 → Jan 2023** (44 years). Streamflow Zarr slice ≈ 1.4 TB.
  Gauge-only fallback: USGS water APIs (public domain; note `waterservices.usgs.gov` is decommissioned early
  2027 → build against `api.waterdata.usgs.gov`). Reach geometry: NHDPlus (US-gov public domain; frozen in
  favor of 3DHP but downloadable). Avoid MERIT Hydro unless electing its ODbL branch (its other branch is NC).
- **License: YES.** Registry: "Open Data. There are no restrictions on the use of this data."
- **Why compelling:** the continental river network *breathing* through floods and droughts — spring melt
  pulses rolling down the Mississippi, flash floods, the 2011/2019 flood years. No well-known public
  visualization does this at reach scale; it would be genuinely novel content.
- **New tech:** modest but real — this is **flow-corridor + `vertex_value_matrix` at 2.7 M-feature scale**
  (river reaches = corridors, per-hour discharge = the BIXI-streets ridership pattern on a natural network).
  Forces zoom-dependent network generalization (stream-order pruning per zoom = the flowmap clustering idea
  on a tree) and stresses the paged directory.
- **Risks:** feature_id → NHDPlus geometry join at 2.7 M reaches; TB-scale Zarr subsetting (pick a basin ×
  a famous flood year for the demo, keep CONUS-decade as the stretch goal).

### E. Analytic motion evaluated in-shader — **asteroid + satellite catalogs** ⭐

- **Asteroids:** MPC MPCORB — **1.55 M orbital elements**, 315 MB fixed-width (or 180 MB JSON), updated
  daily (`minorplanetcenter.net/iau/MPCORB/`). License **conditional YES**: redistribution allowed with
  attribution + shipping the file header + pointing at updates (the oft-claimed CC-BY 4.0 is **unverified** —
  treat as not CC). Cleaner alternative: **JPL SBDB** API (US-gov, no restrictions, 1.557 M bodies).
- **Satellites:** **CelesTrak GP** (`celestrak.org/NORAD/elements/gp.php`, no login) — 34,373 objects on
  orbit (19.4 K payloads incl. Starlink shells + 15 K debris). Redistribution of derived products covered by
  USSPACECOM's **blanket approval with citation** (Space-Track user agreement). ⚠ 5-digit catalog numbers
  exhaust ~mid-July 2026 — ingest **OMM/CSV, not legacy TLE**.
- **Why compelling:** 1.5 M asteroids swarming (Kirkwood gaps, Trojans, NEA flybys) or the full debris
  population + Starlink shells over the existing globe — with **smooth motion at any time scrub speed**.
- **New tech:** the deepest representation change on this list — **store orbital elements as columns and
  propagate in the vertex shader** (2-body Kepler for asteroids; SGP4 for satellites) instead of baking
  sampled trajectories. ~6 floats/object vs thousands of baked vertices; time-filter becomes an analytic
  evaluation. Upgrades the existing satellites demo (currently SGP4-baked at build, altitude dropped).
- **Risks:** SGP4 in-shader is a serious port (WGS72 constants, deep-space branch) — start with Kepler
  asteroids, which is easy; asteroids are heliocentric (needs a solar-system, non-mercator scene — the globe
  renderer is the nearest existing home); 1-opposition MPC orbits are junk-quality (drop them).

### F. Raster / gridded time-series tier — **GOES imagery, GPM IMERG, nighttime lights, Hansen, GHSL, sea ice**

One new capability (a gridded tile tier) unlocks a whole family. All license-clean:

| Dataset | Access (verified) | Cadence / span | License |
|---|---|---|---|
| **GOES-16/18/19 full-disk imagery** (ABI L2 CMIP) | `s3://noaa-goes19/ABI-L2-CMIPF/…` anonymous; 25–411 MB NetCDF / 10 min; >4.7 PB | 10 min, 2017→ | NODD open |
| **GPM IMERG precipitation** | GES DISC / Earthdata S3 (login), 0.1° global half-hourly, ~0.5 TB/yr | 30 min, 1998→ | **CC-BY 4.0** (registry) / NASA open |
| **VIIRS nighttime lights (EOG VNL)** | `eogdata.mines.edu/nighttime_light/annual/v22/` no-auth GeoTIFF | annual (monthly avail.), 2012→ | **CC-BY 4.0** (explicit on product page) |
| **Hansen Global Forest Change** | `storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12/` — `lossyear` band = per-pixel YEAR of loss; <10 GB/band global | annual, 2000–2024 | **CC-BY 4.0** (verbatim on page) |
| **GHSL built-up surface** | JRC open FTP, 100 m, epochs 1975–2030 | 5-yr epochs | EC reuse w/ attribution |
| **NSIDC sea-ice concentration CDR** | NOAA@NSIDC HTTPS, daily 25 km polar grids | daily, 1978→ | US-gov, cite |
| **Google Open Buildings 2.5D Temporal** | GCS GeoTIFFs by country; presence/height/count channels, ~4 m eff. | annual, 2016–2023, Global South only | **dual CC-BY 4.0 / ODbL — elect CC-BY** |

- **Why compelling:** global rainfall pulse (IMERG), a 13-year urbanization glow time-lapse (VNL), the
  deforestation front marching across the Amazon (Hansen lossyear), Global-South cities growing upward
  (Open Buildings heightfield), 47 years of polar ice breathing (CDR).
- **New tech:** the **raster time-series tile tier** itself (the removed `raster_tier` scaffold, resurrected
  with intent), heightfield extrusion from rasters (Open Buildings), and — cheaper interim path — several of
  these (Hansen lossyear, sea ice, IMERG isobands) can be **vectorized at build** with the existing radar
  isoband machinery to ship a demo before the raster tier exists.
- **Risks:** IMERG/Black-Marble sit behind (free) Earthdata auth; GOES full-disk is in geostationary
  projection (reprojection cost); volume forces aggressive subsetting.

### G. Volumetric 3D over time — **full NEXRAD Level-II volumes**

- **Access (verified):** `s3://unidata-nexrad-level2` (anonymous; the legacy `noaa-nexrad-level2` bucket was
  **deprecated 2025-09-01** — do not build against it). June 1991 → present, ~6.2 MB per full volume scan
  (all elevation sweeps: reflectivity, velocity, spectrum width, dual-pol). The 2020 derecho KDMX file used
  by the existing demo re-downloads credential-free.
- **License: YES** (NODD).
- **Why compelling:** upgrade the existing flat isoband derecho into a true 3D storm — supercell hook echo
  and mesocyclone rendered volumetrically over an hour of scans.
- **New tech:** first **volumetric time-series representation** (voxel bricks or 3D isosurfaces per time
  bucket; the existing marching-squares isoband path generalizes to marching-cubes isosurfaces as the
  vector-payload-compatible option).
- **Risks:** volume rendering is the biggest renderer lift on this list; radar-polar → Cartesian gridding;
  scope to one storm, not the archive.

### H. True depth axis over time — **Argo profiling floats**

- **Access (verified):** `s3://argo-gdac-sandbox` (anonymous, eu-west-3, daily sync) or GDAC https/ftp;
  global snapshot **83 GB** NetCDF, ~2.7 M profiles / ~5 B observations, ~4,000 active floats, 1999→.
  Deep Argo to 6000 m; BGC adds O₂/chlorophyll/nitrate.
- **License: YES — CC-BY 4.0** (SEANOE DOI 10.17882/42182; AWS registry: "no restrictions").
- **Why compelling:** thousands of floats yo-yoing 0–2000 m through the water column every ~10 days,
  colored by temperature/salinity — an elegant, never-mainstream visual that pairs with the existing
  drifters/currents demos as the ocean's third dimension.
- **New tech:** cheapest genuinely-new item — exercises the existing 3D point/elevation fold with a
  **time-varying z**, plus camera/space-time-cube treatment of depth. Mostly build-side work.
- **Risks:** low — QC-flag filtering (use `_ADJUSTED` delayed-mode), irregular vertical sampling.

### Also verified, lower priority

- **NASA FIRMS / VIIRS active fires** — YES (NASA open); ~150–250 M detections 2012→; strong seasonal fire
  waves, but overlaps the existing wildfires domain and is only daily-stepped.
- **GDELT** — YES, explicitly: "You may redistribute, rehost, republish, and mirror any of the GDELT
  datasets in any form" (citation required); 500 M+ geolocated events 1979→. Tempting scale, but city-centroid
  geocoding produces ugly stacking; treat as pre-aggregated counts if used.
- **ICESat-2 ATL03 photon clouds / GEDI** — public domain, PB-scale (~1 TB/day); a regional
  Greenland/Antarctica extract via SlideRule reuses the LiDAR/surfel machinery on planetary-scale altimetry;
  Earthdata auth + subsetting engineering.
- **World Ocean Database** (CC0), **GTSPP**, **IOOS gliders** — open depth-profile alternates to Argo.

---

## 3. Blocked or conditional (verified verbatim — do not use without re-reading)

| Dataset | Verdict |
|---|---|
| **OpenSky ADS-B** | **HARD BLOCKER** — non-profit research/education only; no distribution outside licensee's institute; restrictions attach to "any and all subsequent uses and disclosures". Escape hatch: their separately-licensed **CC-BY 4.0 Zenodo derivatives** (e.g. 2019–2020 crowdsourced air traffic, ~41.9 M flights, doi:10.5281/zenodo.3931948). |
| **Global Fishing Watch** | **CC BY-NC 4.0** — derived tiles redistributable but non-commercial only; usable only if the showcase is definitively non-commercial. Legacy GEE V1 subset is CC-BY-SA. |
| **Gaia DR3** | **CC BY-NC 3.0 IGO** (not BY-SA as often assumed) — NC blocker. |
| **WWLLN / Earth Networks lightning** | Copyrighted/commercial, no redistribution. GLM is the open substitute. |
| **ESA DISCOS** | Registration-gated, no redistribution right. |
| **Japan ODPT transit** | Bespoke license, full text unverifiable without an account; patchwork CC-BY subsets only. Legal risk for public rehosting. |
| **MERIT Hydro** | Dual CC-BY-NC / ODbL — usable **only** by electing ODbL (share-alike). Prefer NHDPlus/NWM. |

Cross-cutting: **AWS Open Data registry listing ≠ open license** (their own disclaimer; nuScenes counterexample).
NOAA/NODD labeling duties: never present derived tiles as original NOAA data; no implied endorsement; attribute.

---

## 4. Ranking (visual impact × technique novelty × feasibility)

1. **HRRR/GFS wind → vector-field tiles + GPU particle advection.** The most iconic missing visual
   (earth.nullschool precedent), a clean license, trivial access, and the single highest-leverage new
   capability — the field tier it forces is also the substrate for IMERG/ocean-current fields later.
2. **GOES GLM lightning → billions-of-events density LOD.** Maximum raw spectacle per engineering hour:
   point rendering is the stack's core strength, the event→group→flash hierarchy maps directly onto the
   existing additive zoom-LOD work, and it is the natural first customer for the preprocessing-framework
   density/cube design.
3. **Netherlands GTFS → nation-scale transit ballet.** CC0, shapes + free realtime included, and mostly
   reuses the trips pipeline — the cheapest headline demo on the list, with schedule expansion (and optional
   in-shader stop-time interpolation) as the new build-side technique. Switzerland/Germany as follow-ons.
4. **NOAA National Water Model → the continental river network breathing.** Genuinely novel public content
   (nobody shows reach-scale discharge animation), no restrictions, and it stress-tests flow-corridor +
   `vertex_value_matrix` + paged directory at 2.7 M features rather than requiring a new render primitive.
5. **MPC/JPL asteroids (then CelesTrak satellites) → analytic in-shader motion.** The deepest representation
   novelty (elements-as-columns, ~6 floats/object replacing baked trajectories) with a spectacular 1.5 M-body
   payoff; ranked last of the five only because Kepler/SGP4-in-shader and the heliocentric scene are real
   renderer work. Start with Kepler asteroids; SGP4 satellites second.

**Runners-up:** Argo floats (cheapest genuinely-new axis — could ship quickly as a "small" win), the raster
tier family (GOES/IMERG/VNL/Hansen — one format investment, many demos; interim vectorized cuts possible
today), NEXRAD Level-II volumes (hold until there's appetite for volume rendering), ICESat-2 regional photon
clouds (reuses surfel machinery).

**Suggested pairing strategy:** each new *technique* ships with one flagship dataset, and each flagship
reuses an existing demo as its foil — wind particles over the existing storm-radar derecho; GLM lightning
over the hurricane tracks; NWM rivers beside the BIXI street-flow family; analytic satellites replacing the
baked satellites demo.
