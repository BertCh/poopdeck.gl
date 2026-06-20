# AV Cockpit — fidelity refinement contract (Round 1 + Round 2)

Refines the AV cockpit to match-and-exceed the canonical viewers (streetscape.gl / XVIZ,
nuScenes devkit, av2 devkit, Cabana/openpilot), per the four fidelity audits. Source of
truth for the refinement build. Companion to `av-cockpit.md` (the original contract).

Sequencing: **Round 1 = code-only (no bundle re-generation)** — everything here works off
columns/sidecars already in the shipped bundles, or derives from them. **Round 2 = re-gen +
data** (georef fixes, HD-map streams, AV2 real velocity, richer CAN channels).

Ownership (no file overlaps): **Agent L** = `packages/layers` only. **Agent S** = NEW showcase
files only (`components/av/MetricCharts.tsx`, `components/av/ObjectInspector.tsx`,
`components/av/egoLayers.ts`). **Lead** = integration edits to existing showcase files
(`buildDemoLayers.ts` case 'av', `AvDeck.tsx`, `AvCockpit.tsx`, `datasets.ts`, `sceneTypes.ts`)
— coordinated against the user's live multi-source edits. **Round 2 Python** = per-dataset later.

---

## Round 1 — code-only refinements

### R1.1 Object labels (Agent L — `AnimatedBoundingBoxLayer`)
Add a `TextLayer` sublayer to `renderLayers()`, gated by `showLabels?: boolean` (default false).
- `getText` from a `labelProperty` (default `'category'`; cockpit may pass `'track_id'`).
- `getPosition` = the box point (reuse the size-3 position buffer already prepared).
- `getPixelOffset:[0,-16]`, `billboard:true`, `getSize:11`, white text + dark `outlineColor`,
  `fontSettings:{sdf:true}`, `getColor` light.
- Time-filtered identically to the boxes (same `TimeFilterExtension` window) so labels
  appear/vanish with their object. `category`/`track_id` are already columns on the objects tile.

### R1.2 Velocity arrows (Agent L — `AnimatedBoundingBoxLayer`)
Add a `LineLayer` sublayer, gated by `showVelocity?: boolean` (default false).
- Derive direction from existing per-feature props: `vx = speed·cos(heading)`,
  `vy = speed·sin(heading)` (props `speedProperty` default `'speed'`, `headingProperty` default
  `'heading'`). NO new data needed for nuScenes/synthetic (AV2 gets real velocity in Round 2).
- `getSourcePosition` = box point; `getTargetPosition` = point + (vx,vy)·`velocityScale`
  (default scale so ~1 s of travel is visible; meters→deg via a small helper or world-space).
- Hide when `speed < ~0.3 m/s`. Color a bright accent. Time-filtered like the boxes.
- Prefer world-space (meters) so arrows scale with zoom; clamp a min pixel length.

### R1.3 Canonical class palette (Lead — `datasets.ts` `AV_OBJECT_COLORS`)
Replace the invented palette with the nuScenes `get_colormap()` projection (RGBA, alpha ~235):
`car [255,158,0]`, `truck [255,99,71]`, `bus [255,69,0]`, `trailer [255,140,0]`,
`construction_vehicle [233,150,70]`, `pedestrian [0,80,230]`, `bicycle [220,20,60]`,
`motorcycle [255,61,99]`, `traffic_cone [47,79,79]`, `barrier [112,128,144]`, `other [150,160,175]`.
Box color comes from the Dataset's `avObjectColors`, so this recolors all scenes WITHOUT re-gen.
(Round 2 also writes the same palette into `av_common.OBJECT_COLORS` → `scene.json.objectColors`
so the legend matches.)

### R1.4 Telemetry strip-charts (Agent S — `components/av/MetricCharts.tsx`)
A Cabana/XVIZ-Metrics-style panel of scrolling time-series strips, one per `telemetry.json`
field present — replaces (or sits beside) `MetricGauges`.
- Props: `{ telemetry: AvTelemetry, timeController: TimeController, windowMs?: number }` (default
  window ~8000). Read the field types from `sceneTypes.ts` (the existing `AvTelemetry`/sampler).
- Each strip: an SVG `<path>` of the field's `[t,v]` samples within `[t-windowMs, t]` (two binary
  searches via the existing `sampleIndexAtOrBefore` in `sceneTypes.ts`), playhead pinned at the
  right edge, a faint zero line, and a numeric readout of the value at the cursor.
- Drive updates imperatively off `timeController.on('tick')` + `useRef` (NO per-frame React
  re-render) — mirror the pattern `MetricGauges.tsx` already uses. Honor reduced motion (static
  full-window render, no scroll).
- Keep it compact, dark, on-brand (match the existing cockpit panel styling/Tailwind classes).

### R1.5 Object inspector (Agent S — `components/av/ObjectInspector.tsx`)
A streetscape.gl-style selection card for a picked object.
- Props: `{ object: PickedObject | null, onClose: () => void }` where `PickedObject` carries the
  decoded tile feature props (`category`, `track_id`, `speed`, `length`, `width`, `height`,
  `heading`). Define a local `PickedObject` type (or extend `sceneTypes.ts`).
- Render a small glass card (top-right or bottom-right): class (color swatch from the palette),
  track id, speed in km/h, L×W×H in m, heading in degrees. Close button. Hidden when `object` null.
- Pure presentational — the Lead wires picking in `AvDeck` (`pickable:true` + `onClick`).

### R1.6 Ego footprint + path-prediction (Agent S — `components/av/egoLayers.ts`)
Helper that builds two deck layers from the lightweight `scene.streams.ego.path`
(`[{t,lon,lat}]`, already shipped; heading derived from consecutive points):
- `buildEgoFootprintLayer({ path, time, color })` → a `SimpleMeshLayer` (`@deck.gl/mesh-layers`,
  already a showcase dep) with a `CubeGeometry`, ONE instance at the interpolated ego position at
  `time`, `getOrientation:[0,0,headingDeg]`, `getScale:[4.6,1.9,1.5]` (a car), a distinct ego
  color. Interpolate position + heading between the two bracketing `ego.path` samples.
- `buildEgoPathLayer({ path, time, aheadMs })` → a `PathLayer` of the ego positions in
  `[time, time+aheadMs]` (default ~5000) as a tapering bright ribbon ahead of the car (openpilot's
  predicted-path look). Width in meters, fades to transparent at the far end.
- These are plain deck layers returned to `AvDeck` to append (NOT tile layers). Export the two
  builders + a `egoHeadingAt(path, time)` helper. Honor reduced motion by the caller.

### R1.7 Integration (Lead — existing showcase files)
- `buildDemoLayers.ts` case 'av': pass `showLabels:true`, `showVelocity:true` (+ `labelProperty`,
  `velocityScale`) to the objects `AnimatedBoundingBoxLayer`; set `pickable:true` on the objects
  (and optionally lidar) layer. Keep coordinating with the live multi-source `sourceProps` edits.
- `AvDeck.tsx`: add `pickable` already via case 'av'; add `onClick` → lift the picked object to the
  parent; append the ego footprint + path layers (from `egoLayers.ts`) using `dataset` `ego.path`
  + the live clock; ego-follow already reads `ego.path`.
- `AvCockpit.tsx`: mount `MetricCharts` (replacing/with `MetricGauges`), `ObjectInspector` (state:
  selected object), pass `scene.streams.ego.path` down. Honor reduced motion.
- `sceneTypes.ts`: add a `"map"` `AvStreamKey` (used in Round 2) + any `PickedObject` type.

---

## Round 2 — re-gen + data refinements (per-dataset Python + map renderer)

### R2.1 Georef correctness (av_common + extractors)
- **nuScenes (Boston/Singapore)**: map meters are TRUE GROUND METERS in a LOCAL frame whose origin
  is the map's SW corner (`NUSCENES_MAP_ORIGINS`), exactly as the official devkit
  `export_poses.derive_latlon` treats them — so `av_common.local_to_lonlat(x, y, originLat, originLon)`
  (ground meters) places the scene correctly on the basemap. ⚠️ Do NOT treat these as EPSG:3857
  web-mercator meters: nuScenes uses a local metric frame, not the global mercator projection. The
  former `mercator=True` mode (deflate by `k = 1/cos(originLat)`) was a misdiagnosis — it shifted
  Boston scenes ~450 m off the basemap and shrank them ~26%; it has been REMOVED. (Verified: the
  ground-meter output matches the devkit's lat/lon to ~5 m and aligns the HD map with the basemap.)
- **Argoverse**: city frame is UTM meters; the scene is ~6.9 km from origin → equirectangular is
  ~75 m off. Add `av_common.utm_to_lonlat(E, N, epsg)` via `pyproj` and the AV2 city UTM origins
  (PIT `EPSG:32617` E0 583710.007 N0 4477259.9999; document MIA/ATX/DTW/PAO/WDC). Use it in
  `argoverse_extract` instead of `local_to_lonlat`.
- Re-generate the nuScenes + Argoverse bundles after the fix (re-stage raw data).
- Correct the `av-cockpit.md` §1 georef formula too (it bakes the wrong flat-earth assumption).

### R2.2 HD-map substrate (new streams + renderer)
New bundle streams (static, full-range): `map_poly/` (STT polygon archive: `geometry` WKB Polygon,
`map_layer` Utf8 categorical) + `map_line/` (STT linestring archive: `geometry` WKB LineString,
`map_layer` Utf8). Constant `timestamp = timeRange.start`, `end_timestamp = timeRange.end`.
- `av_common`: `write_map_polygons(...)`, `write_map_lines(...)`, and `MAP_COLORS` (nuScenes palette:
  drivable_area `[166,206,227]`, road_segment `[31,120,180]`, lane `[51,160,44]`, ped_crossing
  `[251,154,153]`, walkway `[227,26,28]`, stop_line `[253,191,111]`, carpark_area `[255,127,0]`,
  road_divider `[202,178,214]`, lane_divider `[106,61,154]`; AV2: drivable `[122,122,122]`,
  lane boundary by `LaneMarkType` white/yellow/blue/red, crosswalk `[150,60,200]`).
- nuScenes extractor: `NuScenesMap(dataroot, location)` → clip to ego bbox+80m → `extract_polygon`/
  `extract_line` for the poly/line layers → `local_to_lonlat` (with R2.1 fix). **Requires the
  map-expansion unpacked to `<dataroot>/maps/expansion/`** (the zip is in ~/Downloads).
- Argoverse extractor: `ArgoverseStaticMap.from_map_dir(log/map)` → lane boundaries (path),
  drivable areas + ped crossings (polygon) → `utm_to_lonlat`. **Requires re-pulling the log** (raw deleted).
- scene.json: `streams.map = { polyUrl, lineUrl, layers:[...] }`. Dataset fields `avMapPolyUrl`,
  `avMapLineUrl`, `mapColors`. `AvStreamKey` `'map'` (StreamPanel toggle).
- Renderer (case 'av', painter order FIRST, under lidar): `AnimatedPolygonLayer` (fill by
  `map_layer` via `mapColors`, low alpha, flat) + `AnimatedPathLayer` (color by `map_layer`,
  `widthUnits:'meters'`, ~0.25 m). Register both as OPTIONAL governor sources. Reuses existing layers.

### R2.3 AV2 real velocity (argoverse_extract)
`annotations.feather` has no velocity → group by `track_uuid`, finite-diff city-frame center / Δt →
write real `speed` (replace the hardcoded 0.0) + `vx,vy` (or `vel_heading`). Then R1.2 arrows work on AV2.

### R2.4 Richer CAN channels (comma + nuScenes extractors)
- comma: fix the `v[:,0]` slice (drops wheel_speeds[1:4] + accel axes); emit `wheel_fl/fr/rl/rr`,
  `gyro` (yaw-rate), all accel axes, GNSS bearing. nuScenes: add `left_signal/right_signal`,
  `yaw_rate`. telemetry.json just grows more `fields`; R1.4 charts auto-render them.

### R2.5 Canonical palette in av_common (legend parity)
Set `av_common.OBJECT_COLORS` = the R1.3 palette so `scene.json.objectColors` matches the boxes.
