# AV Telemetry Cockpit — design & shared contract

> **Status: BUILT (uncommitted).** The cockpit ships in the showcase —
> `pages/AvCockpit.tsx`, `components/av/*`, the `AnimatedBoundingBoxLayer`
> ([docs](../api/animated-bounding-box-layer.md)), and the
> `scripts/data-generation/{av_synthetic,nuscenes_extract,comma_extract,argoverse_extract,av_common}.py`
> adapters. This document is the original design + cross-workstream build
> contract, kept as a decision record — not a forward plan.

A poopdeck.gl visualization inspired by **avs.auto / streetscape.gl** (Aurora/Uber's
XVIZ viewer): real autonomous-vehicle sensor logs — LIDAR point clouds, tracked-object
3D boxes, the ego trajectory, and CAN-bus telemetry — served as **spatiotemporal tiles**
on a real basemap, with a streetscape.gl-style cockpit (left stream list, bottom timeline
scrubber, bottom-left metric gauges, top-right camera inset).

This file is the **source of truth** for the parallel build. Every workstream conforms to
the contracts here so the pieces compose without collisions. **Do not change a contract in
your own workstream — if a contract is wrong, flag it; the lead reconciles it here.**

---

## 1. Why this fits STT

AV ego poses live in a *local map frame* (meters from a map origin), but the source maps
have **documented lat/lon origins**, so the whole scene georeferences onto a real basemap:

| nuScenes map | SW-corner origin (lat, lon) |
|---|---|
| boston-seaport | 42.336849169438615, -71.05785369873047 |
| singapore-onenorth | 1.2882100868743724, 103.78475189208984 |
| singapore-hollandvillage | 1.2993652317780957, 103.78217697143555 |
| singapore-queenstown | 1.2782562240223188, 103.76741409301758 |

Local meters → lon/lat (equirectangular about the origin; good enough for a coherent scene):

```
lat = originLat + (y_m / 111320)
lon = originLon + (x_m / (111320 * cos(originLat·π/180)))
```

Ego pose, every object box, and every LIDAR return are transformed to the *global* (map)
frame, then to lon/lat with this. comma.ai already ships GPS lat/lon (no transform needed);
Argoverse uses a city coordinate frame with its own documented origins.

License note: nuScenes & Argoverse 2 are **CC BY-NC-SA 4.0** (non-commercial; fine for this
showcase, attribute the source). comma.ai is permissive. The cockpit must render an
attribution string from `scene.json`.

---

## 2. Data contract — the "AV scene bundle"

Every dataset adapter (nuScenes / comma.ai / Argoverse / synthetic) emits the SAME bundle
under `examples/showcase/public/data/<sceneId>/`. **Streams are optional**: comma.ai has only
`ego` + `telemetry`; Argoverse has `lidar` + `ego` + `objects` but no CAN telemetry. The
cockpit shows only the streams present in `scene.json`.

```
<sceneId>/
  scene.json            # manifest (below) — cockpit source of truth
  lidar/                # packed STT POINT archive (manifest.json + *.sttp/.sttd)
  ego/                  # packed STT TRIPS archive (one linestring = ego path)
  objects/              # packed STT POINT archive (one point per object per sample)
  telemetry.json        # CAN-bus time series (sidecar JSON, loaded client-side)
  cameras.json          # keyframe camera images (sidecar JSON), images under cam/
  cam/*.jpg             # optional camera frames
```

### 2a. `lidar/` — accumulated LIDAR returns (STT point archive)
GeoParquet → `stt-build` (point geometry). Columns:
- `geometry`  Binary WKB **Point** (lon, lat)
- `timestamp` Int64 Unix-ms — the LIDAR sweep time (build `--time-field timestamp --time-format unix-ms`)
- `height_band` Utf8 — **categorical** height band string, e.g. `"-2-0"`, `"0-2"`, `"2-4"`, … (NOT a bare
  number — stt-build promotes all-numeric-string columns to Numeric and the categorical color map no-ops).
  Drives LIDAR color via `colorMapping`. Use ~8 bands across the height domain.
- `z` Float64 — raw height (m), kept for reference/picking.
- `intensity` Float64 — 0–255 return intensity (reference).

Build with a short `--temporal-bucket` (e.g. `100ms` if supported, else `1s`) so sweeps step
crisply. Decimate to ≈ a few hundred k points per scene (every Nth return) to keep tiles light.

### 2b. `ego/` — ego trajectory (STT trips archive)
GeoParquet → `stt-build` LineString contract (identical to `ecco_advect.py`):
- `geometry` Binary WKB LineString (lon, lat) — the ego path
- `timestamp` Int64 — track start Unix-ms; `end_timestamp` Int64 — track end (`--end-time-field`)
- `vertex_timestamps` List<Int64> — one Unix-ms per vertex
- `vertex_values` List<Float32> — ego speed (m/s) per vertex (drives an optional gradient)
- `vehicle` Utf8 — constant label (e.g. `"ego"`) for legend

### 2c. `objects/` — tracked objects (STT point archive)
One point **per object per annotated sample** (objects move → many points over time).
- `geometry` Binary WKB Point (lon, lat) — object center
- `timestamp` Int64 Unix-ms — annotation sample time
- `category` Utf8 — **categorical** class: one of
  `car, truck, bus, trailer, construction_vehicle, pedestrian, bicycle, motorcycle, traffic_cone, barrier`
  (adapters map their native taxonomy onto this set; unknown → `other`).
- `heading` Float64 — yaw in **radians**, world frame, **0 = +x (east), CCW positive** (deck `getOrientation` z-rotation in degrees = heading·180/π).
- `length` Float64, `width` Float64, `height` Float64 — box dims (m).
- `track_id` Utf8 — stable per-object id (for picking).
- `speed` Float64 — object speed (m/s).

Build `--time-field timestamp --time-format unix-ms`, short `--temporal-bucket` (`100ms`/`1s`).

### 2d. `telemetry.json` — CAN-bus gauges sidecar
```jsonc
{
  "t0": 1531883530450,            // Unix-ms of first sample (also == timeRange.start)
  "hz": 50,
  "fields": {                     // any subset; cockpit renders gauges for those present
    "speed":   { "unit": "m/s", "label": "Speed",    "samples": [[t_ms, v], ...] },
    "steer":   { "unit": "rad", "label": "Steering", "samples": [[t_ms, v], ...] },
    "accel":   { "unit": "m/s²","label": "Accel",    "samples": [[t_ms, v], ...] },
    "throttle":{ "unit": "frac","label": "Throttle", "samples": [[t_ms, v], ...] },
    "brake":   { "unit": "frac","label": "Brake",    "samples": [[t_ms, v], ...] }
  }
}
```
Samples sorted by `t_ms`. The cockpit binary-searches the active sample at the playhead.

### 2e. `cameras.json` — camera inset sidecar (optional)
```jsonc
{ "camera": "CAM_FRONT",
  "frames": [ { "t": t_ms, "url": "cam/0001.jpg" }, ... ] }   // url relative to <sceneId>/
```

### 2f. `scene.json` — manifest (cockpit source of truth)
```jsonc
{
  "id": "nuscenes-0061",
  "name": "Boston Seaport · Scene 0061",
  "dataset": "nuScenes",                 // attribution label
  "datasetUrl": "https://www.nuscenes.org/nuscenes",
  "license": "CC BY-NC-SA 4.0",
  "location": "boston-seaport",
  "description": "20s urban drive; 32-beam LIDAR, CAN telemetry, 3D object boxes.",
  "georef": { "originLat": 42.336849, "originLon": -71.057853 },
  "timeRange": { "start": 1531883530450, "end": 1531883550450 },
  "initialView": { "longitude": -71.05, "latitude": 42.34, "zoom": 17, "pitch": 55, "bearing": 20 },
  "objectColors": {                      // category → [r,g,b,a]
    "car": [80,170,255,255], "pedestrian": [255,90,90,255], "bicycle":[255,200,60,255], ...
  },
  "streams": {                           // present streams only
    "lidar":     { "url": "lidar/manifest.json",   "points": 280000 },
    "ego":       { "url": "ego/manifest.json" },
    "objects":   { "url": "objects/manifest.json", "categories": ["car","pedestrian", ...] },
    "telemetry": { "url": "telemetry.json" },
    "camera":    { "url": "cameras.json" }
  }
}
```

---

## 3. Frontend contract

### 3a. `DatasetType` (types.ts) — add `'av'`
New `Dataset` fields (additive; mirror the `radar` composite's multi-URL convention):
- `avSceneUrl?: string` — `scene.json` (cockpit fetches it for chrome/colors/telemetry/camera).
- `avEgoUrl?: string`, `avObjectsUrl?: string` — extra archive manifests (primary `url` = `lidar/manifest.json`).
- `avTelemetryUrl?: string`, `avCamerasUrl?: string` — sidecar JSON URLs.
- `avObjectColors?: Record<string, ColorRGBA>` — category → color (also in scene.json; the
  Dataset copy keeps `buildDemoLayers` self-contained).
- `lidarColorMapping?: Record<string, ColorRGBA>` — `height_band` → color ramp.
- `lidarColorMappingDefault?: ColorRGBA`.
All URLs go through `resolveDataUrl` so an R2 deploy resolves them (same as `radarCellsUrl`).

### 3b. `buildDemoLayers` — add `case 'av'`
Composite, painter order **lidar → ego → objects** (governor plumbing rides the LIDAR = heaviest):
```
lidar:   AnimatedPointLayer  { data: url, fillColor:'height_band', colorMapping: lidarColorMapping,
                               radiusUnits:'pixels', radius: 1.4, radiusMinPixels:1, opacity:0.9 }
ego:     AnimatedTripsLayer   { data: avEgoUrl, tripColor:[120,230,255,255], widthUnits:'meters',
                               tripWidth:2.2, trailLength: <full scene>, fadeTrail:true }  // overlayBase (no governor)
objects: AnimatedBoundingBoxLayer { data: avObjectsUrl, colorProperty:'category',
                               colorMapping: avObjectColors, headingProperty:'heading',
                               lengthProperty:'length', widthProperty:'width', heightProperty:'height' } // overlayBase
```
Use the SAME `overlayBase` (governor stripped) pattern as `case 'radar'` for ego + objects.

### 3c. New deck layer — `AnimatedBoundingBoxLayer` (packages/layers)
- File: `packages/layers/src/layers/core/animated-bounding-box-layer.ts`; export from `packages/layers/src/index.ts`.
- Extends `SpatioTemporalLayer`, modeled on **`animated-column-layer.ts`** (which already maps a
  time-filtered point archive → an extruded sublayer with categorical color via `colorMapping`).
- Renders each active object as an **oriented extruded box**: use `SimpleMeshLayer`
  (`@deck.gl/mesh-layers`) with a `CubeGeometry` (`@luma.gl/engine`), accessors:
  `getPosition` (point), `getOrientation: [0,0, heading·180/π]`, `getScale: [length,width,height]`,
  `getColor` (category via the same colorMapping machinery AnimatedColumnLayer uses).
- Props (extend `SpatioTemporalLayerProps`): `colorProperty`, `colorMapping`, `colorMappingDefault`,
  `headingProperty` (default `'heading'`), `lengthProperty`/`widthProperty`/`heightProperty`
  (defaults `'length'`/`'width'`/`'height'`), `sizeScale?` (default 1), `wireframe?` (default false).
- **Fallback** if instanced `SimpleMeshLayer` through the tile binary-features path needs core
  changes: render `ColumnLayer` (diskResolution 4 = a square prism) extruded by `height`, colored
  by category — still reads as tracked-object volumes. Ship whichever works; note which in the file header.
- Add a unit test `packages/layers/test/animated-bounding-box-layer.test.ts` mirroring the existing
  column/point layer tests (deep-import from `../src`, assert construction + renderLayers shape).

### 3d. Cockpit page + chrome (showcase)
- Route (`main.tsx`, chrome-free fullscreen group): `<Route path="drive/:sceneId?" element={<AvCockpit />} />`.
- `pages/AvCockpit.tsx` — orchestrator. Loads `scene.json`, owns a `TimeController` +
  `PlaybackGovernor` (clone the StoryMap plumbing), renders:
  - `components/av/AvDeck.tsx` — the DeckGL surface (dark `mapbox/dark-v11`, mercator). Builds the
    AV layer tree via `buildDemoLayers({dataset, timeController, useGlobe:false, timeHeightScale:0, plumbing})`.
    Supports an **ego-follow** camera toggle (recenters on the live ego position each tick) and a
    perspective⇄top-down pitch toggle.
  - `components/av/StreamPanel.tsx` — left list of streams from `scene.json.streams` with on/off
    toggles + object-category color legend; toggles set a `visibleStreams` set the deck reads.
  - `components/av/MetricGauges.tsx` — bottom-left radial gauges for each `telemetry.json` field
    present (speed/steer/accel), reading the active sample at the playhead.
  - `components/av/Timeline.tsx` — bottom scrubber + play/pause. Reuse `PlaybackControls` from
    `@poopdeck.gl/react` if it fits; otherwise a thin local scrubber over the same TimeController.
  - `components/av/CameraInset.tsx` — top-right `<img>` of the active `cameras.json` frame.
  - `components/av/SceneSwitcher.tsx` — small selector across all `type:'av'` datasets.
- Honor `useReducedMotion()` (no autoplay / no ego-follow easing when set), matching the stories.
- Loading/empty states: any missing stream simply hides its panel; no hard failures.

### 3e. Catalog (the "standard demo" half)
- Each AV scene also gets a normal catalog entry: a `datasets.ts` `type:'av'` Dataset **and** a
  `content/demoMeta.ts` `DEMO_META[id]` entry (category `mobility`), so it shows in `/demos` and
  renders on the standard `DemoPage` (which calls `buildDemoLayers` → the same `case 'av'`).
- The bespoke cockpit lives at `/drive/:sceneId`; the demo card links to it.

---

## 4. Python adapters (scripts/data-generation/)

Follow the **`ecco_advect.py`** pattern (source → GeoParquet → `stt-build` subprocess). Files:
- `av_common.py` — shared library: the georef transform, the box→global transform, the GeoParquet
  writers for lidar(points)/ego(trips)/objects(points), the telemetry/cameras/scene.json writers,
  and a `run_stt_build(...)` helper. Defines the canonical category map + `height_band` bucketer.
- `nuscenes_extract.py` — uses `nuscenes-devkit` (`pip install nuscenes-devkit`) on a `v1.0-mini`
  (or full) download. CLI: `--dataroot ./nuscenes --version v1.0-mini --scene <name|index> --out <sceneId dir>`.
  Pulls ego_pose, sample_annotation boxes (→ objects), LIDAR_TOP sweeps (→ decimated points),
  CAN-bus `vehicle_monitor`/`pose` (→ telemetry), CAM_FRONT keyframes (→ cameras). Login-gated
  download; document the `nuscenes.org` steps in the module docstring (like ecco does for Earthdata).
- `comma_extract.py` — comma2k19 / commaCarSegments: GPS (lat/lon directly) → ego trip; CAN speed,
  steering, accel → telemetry; dashcam frames → cameras. No lidar/objects (omit those streams).
- `argoverse_extract.py` — Argoverse 2 sensor/lidar: city-frame poses → ego + objects + lidar
  (document the city origins); no CAN telemetry.
- `av_synthetic.py` — **NO external deps / no download**: procedurally generate a realistic 20s
  scene (ego driving a curve through an intersection, ~12 agents on plausible paths, a rotating
  LIDAR ring sampled to ground+facades, sinusoidal CAN telemetry, placeholder camera frames). Writes
  a full, valid bundle so the entire cockpit + catalog is runnable/verifiable **today**, before any
  login-gated download. This is the demo's bootstrap scene (`sceneId: av-synthetic`).

All adapters import `av_common` and emit byte-identical bundle layouts. Real downloads are a
documented one-liner per adapter; `av_synthetic.py` needs nothing.

---

## 5. Workstream ownership (no file overlaps)

- **WS-A (data/python)** — owns ONLY new files under `scripts/data-generation/`: `av_common.py`,
  `nuscenes_extract.py`, `comma_extract.py`, `argoverse_extract.py`, `av_synthetic.py`. Touches no TS/Rust.
- **WS-C (deck layer)** — owns `packages/layers/src/layers/core/animated-bounding-box-layer.ts`,
  its test, and the single export line in `packages/layers/src/index.ts`. Touches nothing else.
- **WS-D (showcase cockpit + registry)** — owns ALL showcase TS: `types.ts`, `buildDemoLayers.ts`,
  `datasets.ts`, `main.tsx`, `content/demoMeta.ts`, `pages/AvCockpit.tsx`, `components/av/*`. Imports
  `AnimatedBoundingBoxLayer` (WS-C) by the agreed name; consumes the WS-A bundle layout by path.
- **Lead (integration)** — this doc; runs `av_synthetic.py` → tiles; wires the synthetic dataset;
  builds layers + showcase; fixes seams; verifies.

Browser **aesthetics** are verified by the user in-browser (per project convention — no screenshot
loops). Automated checks cover build-green + construction/PASS-FAIL correctness only.

---

## 6. Verified nuScenes fidelity notes (2026-06-19)

A deep-dive against the official nuScenes docs + `nuscenes-devkit` source confirmed
the contract's coordinate conventions and surfaced three things to fix. **Already
correct (verified, don't "fix"):** quaternion order `[w, x, y, z]` (scalar-first —
NOT SciPy/ROS `[x, y, z, w]`), box `size = wlh` (width, length, height), yaw via
`Quaternion(...).yaw_pitch_roll[0]`, the sensor→ego→global LIDAR transform, and the
four `NUSCENES_MAP_ORIGINS` (they are byte-exact to the devkit's
`export_poses.py::REFERENCE_COORDINATES`, the **SW-corner** anchors).

**Fixed in this pass:**
- **CAN `brake` is bar `[0, 126]`, not 0–1000 pedal units.** `nuscenes_extract.py`
  divided by 1000, pinning the brake gauge near zero; corrected to `/126`. The live
  `nuscenes-0103/telemetry.json` brake series was rescaled in place (×1000/126) since
  the login-gated source can't be re-downloaded. `throttle` *is* `[0, 1000]` (÷1000 ✓).
- **Steering now prefers `steeranglefeedback`** (100 Hz, native radians) over
  `vehicle_monitor['steering']` (2 Hz degrees) for a smooth wheel gauge; falls back
  when absent. Added a longitudinal **accel** gauge from the 50 Hz ego-frame `pose`
  stream (`accel[0]`), so the nuScenes cockpit matches the synthetic gauge set.
- **Object palette reconciled to the canonical devkit colors.** `av_common.OBJECT_COLORS`
  held an arbitrary palette (car = blue) that bakes into `scene.json` and drives the
  cockpit legend/inspector, while the rendered boxes use `datasets.ts AV_OBJECT_COLORS`
  (already canonical: car = orange). They now match the devkit `color_map.py` projection
  (vehicles warm, pedestrians blue, cyclists crimson). The four live `scene.json`
  legends were patched to match without a regen. **Rule: change both copies together.**

**Deliberate divergences (not bugs):**
- LIDAR is colored by **height band**, not the devkit's default **distance/depth** —
  height reads better on a georeferenced 3D scene (ground vs façades). Intensity is
  kept in the archive for reference.
- The `local_to_lonlat` equirectangular transform differs slightly from the devkit's
  bearing+distance `derive_latlon`, but the gap is <1 m over a ~1 km scene. The origins
  are **approximate visualization anchors** — nuScenes ships no GPS/GNSS ground truth.

**Documented future fidelity hooks (not yet wired):** object `attribute`
(vehicle.moving/parked, pedestrian.standing) to dim parked agents; `num_lidar_pts`
filtering to drop zero-point GT boxes; the full **6-camera ring** (`cameras.json`
currently carries one channel). Each needs a schema bump + regen, so they wait for a
fresh nuScenes download.
