# AV Telemetry Cockpit — shipped historical record

> **Status: SHIPPED** (committed `86bbb0f` … `17789f7`). This is the internal
> decision record for the `/drive` AV cockpit: the original build contract, the
> two fidelity-refinement rounds, and the LiDAR tile-compression pass — all
> landed. It is rationale + open follow-ups, not a forward plan.
>
> Live/canonical docs carry the normative detail now:
> - Scene-bundle + sidecar format → [`../spec/sidecar-assets.md`](../spec/sidecar-assets.md)
> - Object cuboid layer → [`../api/animated-bounding-box-layer.md`](../api/animated-bounding-box-layer.md)
> - LiDAR point layer → [`../api/animated-point-layer.md`](../api/animated-point-layer.md)
> - Compression flags → [`../api/cli-reference.md`](../api/cli-reference.md) (`--quantize-attr`, `--quantize-attrs-auto`)

A poopdeck.gl visualization inspired by **avs.auto / streetscape.gl** (Aurora/Uber's
XVIZ viewer): real autonomous-vehicle sensor logs — LIDAR point clouds, tracked-object
3D boxes, the ego trajectory, and CAN-bus telemetry — served as **spatiotemporal tiles**
on a real basemap, with a streetscape.gl-style cockpit (left stream list, bottom timeline
scrubber, bottom-left metric gauges/charts, top-right camera inset, picked-object inspector).

Shipped surface: `pages/AvCockpit.tsx` + `components/av/*` (showcase, `/drive/:sceneId?`),
`AnimatedBoundingBoxLayer` (packages/layers), and the
`scripts/data-generation/{av_common,nuscenes_extract,comma_extract,argoverse_extract,av_synthetic,waymo_extract}.py`
adapters. Datasets live: synthetic + nuScenes v1.0-mini (10 scenes) + Argoverse 2 (6 cities)
+ comma; Waymo is local-only (license). Render-mode / Three+TSL work that grew on top of this
cockpit lives in [`three-renderer-parity.md`](./three-renderer-parity.md).

---

## 1. Build contract (shipped)

### 1.1 Why AV logs fit STT — georeferencing

AV ego poses live in a *local map frame* (meters from a map origin), but the source maps
have **documented lat/lon origins**, so the whole scene georeferences onto a real basemap.
Ego pose, every object box, and every LIDAR return are transformed to the *global* (map)
frame, then to lon/lat. comma.ai already ships GPS lat/lon (no transform needed).

nuScenes map **SW-corner** origins (byte-exact to the devkit `export_poses.py::REFERENCE_COORDINATES`):

| nuScenes map | origin (lat, lon) |
|---|---|
| boston-seaport | 42.336849169438615, -71.05785369873047 |
| singapore-onenorth | 1.2882100868743724, 103.78475189208984 |
| singapore-hollandvillage | 1.2993652317780957, 103.78217697143555 |
| singapore-queenstown | 1.2782562240223188, 103.76741409301758 |

**Georef conventions (the load-bearing gotchas):**
- **nuScenes coords are TRUE GROUND METERS in a local frame** anchored at the SW corner —
  NOT EPSG:3857 web-mercator meters. `av_common.local_to_lonlat(x, y, originLat, originLon)`
  is equirectangular about the origin (`lat = originLat + y/111320`,
  `lon = originLon + x/(111320·cos originLat)`) and matches the devkit's bearing+distance
  `derive_latlon` to ~5 m over a ~1 km scene. An earlier `mercator=True` mode (deflate by
  `1/cos(originLat)`) was a **misdiagnosis** — it shifted Boston ~450 m off-basemap and shrank
  scenes ~26%; it has been **removed**. The origins are approximate visualization anchors
  (nuScenes ships no GNSS ground truth).
- **Argoverse 2 city frames are UTM meters**, and the scene is ~6.9 km from the city origin, so
  equirectangular is ~75 m off. `av_common.utm_to_lonlat(E, N, epsg)` (pyproj) with the per-city
  UTM origins is used instead — e.g. PIT `EPSG:32617`, E0 583710.007, N0 4477259.9999 (MIA/ATX/
  DTW/PAO/WDC documented in `argoverse_extract.py`).

License: nuScenes & Argoverse 2 are **CC BY-NC-SA 4.0** (non-commercial; attribute the source);
comma.ai is permissive; Waymo is non-commercial + no-redistribution (local-only). The cockpit
renders an attribution string from the scene manifest.

### 1.2 The AV scene bundle

Every adapter emits the SAME bundle layout (lidar / ego / objects / map_poly / map_line packed
STT archives + telemetry.json + cameras.json + scene.json manifest). Streams are optional — the
cockpit shows only those present. **The full bundle + sidecar contract is formalized in
[`../spec/sidecar-assets.md`](../spec/sidecar-assets.md)** — that spec is the source of truth
(column schemas, `height_band` categorical bucketing, sidecar JSON shapes, the `scene.json`
manifest). Notable convention preserved there: `height_band` ships as a **string** label (e.g.
`"0-2"`) — a bare numeric string would be promoted to Numeric and the categorical color map
would no-op.

### 1.3 Frontend + layer

- Showcase: `type:'av'` composite in `buildDemoLayers` (painter order map → lidar → ego → objects;
  ego/objects/map ride the `overlayBase` no-governor pattern, LIDAR carries governor plumbing).
  Route `/drive/:sceneId?`; cockpit chrome under `components/av/*` (stream panel, gauges/charts,
  timeline, camera inset, scene switcher, object inspector, ego-follow + pitch toggle).
- **`AnimatedBoundingBoxLayer`** (packages/layers) renders each active object as an oriented
  cuboid (true 12-edge outline + optional labels/velocity arrows). API →
  [`../api/animated-bounding-box-layer.md`](../api/animated-bounding-box-layer.md). The
  "fallback to ColumnLayer" the original contract hedged on was not needed.

### 1.4 Adapters (scripts/data-generation/)

`av_common.py` is the shared library (georef transforms, GeoParquet writers, telemetry/cameras/
scene.json writers, `run_stt_build` helper, canonical category map). Per-source extractors:
`nuscenes_extract.py` (nuscenes-devkit), `comma_extract.py`, `argoverse_extract.py` (av2-devkit),
`waymo_extract.py` (Perception v2.0.1 Parquet, pure-numpy), and `av_synthetic.py` (no deps — the
bootstrap scene). All emit byte-identical bundle layouts.

---

## 2. Fidelity refinement — Round 1 + Round 2 (shipped)

Refines the cockpit to match/exceed the canonical viewers (streetscape.gl / XVIZ, nuScenes &
av2 devkits, Cabana/openpilot). **Both rounds are committed in HEAD.**

**Round 1 (code-only, off already-shipped columns):**
- Object **labels** + **velocity arrows** as gated sublayers on `AnimatedBoundingBoxLayer`
  (`showLabels`, `showVelocity`; velocity derived from `speed`·`heading`, no new data).
- **Telemetry strip-charts** (`components/av/MetricCharts.tsx`, Cabana/XVIZ-Metrics style),
  **object inspector** (`ObjectInspector.tsx`, streetscape.gl selection card), and **ego
  footprint + predicted-path ribbon** (`egoLayers.ts`, openpilot look) — all shipped.

**Round 2 (re-gen + data):**
- **Georef fixes** — the nuScenes ground-meter + AV2 `utm_to_lonlat` corrections in §1.1.
- **HD-map substrate** — static `map_poly/` + `map_line/` streams (`write_map_polygons`/
  `write_map_lines`, `MAP_LAYERS` frozenset in Python; rendered by `AnimatedPolygonLayer` +
  `AnimatedPathLayer`, colored by the TS `AV_MAP_COLORS`). Wired for nuScenes + AV2; Waymo
  (no HD map) correctly excludes it.
- **AV2 real velocity** — finite-differenced from city-frame centers grouped by `track_uuid`
  (replaced the hardcoded 0.0), so the R1 velocity arrows work on AV2.
- **Richer CAN channels** — comma emits `wheel_fl..rr` / `gyro` / `yaw_rate` (fixed the
  vector-slice that dropped them); nuScenes adds `yaw_rate` / `left_signal` / `right_signal`.
  telemetry.json just grows more `fields`; the strip-charts auto-render them.

### Object-class palette — canonical copy + provenance

The rendered palette is the **nuScenes `get_colormap()` projection** (RGBA, alpha ~235):

```
car [255,158,0]  truck [255,99,71]  bus [255,69,0]  trailer [255,140,0]
construction_vehicle [233,150,70]  pedestrian [0,80,230]  bicycle [220,20,60]
motorcycle [255,61,99]  traffic_cone [47,79,79]  barrier [112,128,144]  other [150,160,175]
```

Provenance: the first cut invented an arbitrary palette (car = blue) that baked into
`scene.json.objectColors` (legend/inspector) while the boxes used a different `datasets.ts`
palette (car = orange) — a legend↔box mismatch. Both were reconciled to the devkit
`color_map.py` projection above (vehicles warm, pedestrians blue, cyclists crimson).

**Rule — three copies MUST stay in lockstep:** `av_common.OBJECT_COLORS` (→ `scene.json`,
Python side) ⇄ `datasets.ts AV_OBJECT_COLORS` (box render) ⇄ the map palette `AV_MAP_COLORS`.
Parity is guarded by `scripts/data-generation/test_av_palette_parity.py`. Map-layer RGBA lives
only on the TS render side (`AV_MAP_COLORS`); Python keeps just the `MAP_LAYERS` key set, so
there is no dead Python color copy that can drift.

**Deliberate divergences (not bugs):** LIDAR is colored by **height band**, not the devkit's
default depth/distance (height reads better on a georeferenced 3D scene — ground vs façades).

---

## 3. LiDAR tile compression (shipped)

Waymo LIDAR was the size bottleneck. A measurement-driven pass cut a point's on-the-wire cost
~4.5× (whole `waymo-sf-day` bundle 3.84 GB → 633 MB, **6.07×**). The compression **flags are
documented in [`../api/cli-reference.md`](../api/cli-reference.md)**; kept here is the *why*.

**Measure first** — before porting the research's headline lever (uint16-RTC coordinate
quantization), we attributed a real z14 Waymo tile's bytes per column
(`crates/stt-core/examples/point_column_stats.rs`, per-column zstd):

```
z14 baseline, 20.0 B/pt:
  id          8.04 B/pt   40.2%   <- UInt64 hash of (time,lon,lat): incompressible
  z           7.58 B/pt   37.9%   <- raw Float64 elevation: barely compresses
  geometry    2.53 B/pt   12.7%   <- already i32-quantized (--quantize-coords)
  intensity   1.66 B/pt    8.3%   <- DEAD: nothing in the render path reads it
  height_band 0.12 B/pt    0.6%
  start/end   0.06 B/pt    0.2%   <- constant per 100ms frame -> ~free already
```

This **redirected the plan**: the cost was `id` and `z`, not `geometry` (already 2.5 B/pt), and
the expected "per-point time tax" was already free (zstd crushes the constant-per-frame times).

**What shipped** (all decode-free, inside the existing Arrow-columnar format):
1. **Sequential point ids** (`columnar.rs`) — a point is never split across tiles, so the
   incompressible u64 hash fallback is replaced by the per-tile row index (unique → picking
   works; monotonic → zstd crushes it). Explicit source ids preserved. **8.04 → 1.07 B/pt.**
2. **Drop dead `intensity`** (`av_common.py write_lidar_points`) — decoded from Waymo but no
   consumer reads it (cloud colors by `height_band`/`seg_class`/camera RGB). **−1.66 B/pt.**
3. **Numeric-attribute quantization** — `--quantize-attr name=prec` stores a named Float64 as
   the smallest int leaf + a per-column affine (`stt:qa` metadata); reader reconstructs
   `o + q·s`. Waymo opts `z` in at 0.05 m. **7.58 → 0.69 B/pt.** Deterministic min-offset →
   content-addressed dedup preserved.

**Born-optimized generation (default):** the same levers are now the default of the generation
pipeline (`common.rs::run_stt_build_with_full_options`): coord quantization
(`DEFAULT_QUANTIZE_COORDS_M = 0.1`, world-grid so dedup survives) + `--quantize-attrs-auto`
(every Float64 scalar → range-adaptive UInt16, always the same type per column so schema never
drifts) + sequential ids, ON for every dataset. `STT_GEN_NO_QUANTIZE=1` opts out wholesale.
Measured −28% on an OD-line double-build; win is dataset-shaped (large on geometry/numeric,
modest on text-heavy). For the ~50 GB of already-built live archives,
`crates/stt-core/examples/reoptimize.rs` re-optimizes data-preserving (decode → re-encode
through the production encoder → re-pack) as the slower fallback path.

**Deferred levers (measured, declined):**
- **uint16-RTC geometry** — would halve `geometry` (~1 B/pt) but a per-tile/node origin breaks
  cross-tile blob dedup (why `--quantize-coords` uses a world grid). Not worth it unless
  geometry becomes the dominant column.
- **Pyramid replication** — the cloud is re-tiled at every zoom with no thinning. Collapsing to
  one/two data zooms is the biggest remaining total-archive lever but changes LOD behaviour.
  (Partly attacked later, out of this doc, by the additive zoom-LOD work.)
- **Additive octree + screen-space-error LOD** (Potree/COPC) — the "proper" fix, but a large
  architectural change to a 2D-mercator-keyed engine. Out of scope.
- **Browser point codecs** (Draco / G-PCC / range-image) — research verdict: only Draco is
  WASM-portable and it isn't rate-distortion optimal; strong codecs decode 1–3 orders of
  magnitude too slowly for interactive playback. Quantization captured most of the win
  decode-free, so a codec path isn't justified.

---

## 4. Genuinely-open follow-ups

These are **the user's domain, not code gaps** — the code above is committed
(re-confirmed in the 2026-07-01 triage; nothing here was re-scoped as code work):
- Bundle **re-generation** (from re-staged raw data) and **R2 sync** of the refreshed
  nuScenes/AV2 bundles.
- **In-browser aesthetic verification** of the re-genned scenes (per project convention, the
  user judges look; no screenshot loops).

This is the same class of un-run ops/verify gate carried by
[`stt-packed.md` §3](./stt-packed.md) (paged-directory rollout) and
[`playback-and-loading.md` §7](./playback-and-loading.md) (multi-source verify) —
one combined re-transcode → R2 sync → browser-verify pass closes all three.

Plus the deferred compression levers in §3 (uint16-RTC, pyramid collapse, octree, codecs) —
**counted out** (measured/declined), revisited only if a specific column/archive becomes the
bottleneck.
