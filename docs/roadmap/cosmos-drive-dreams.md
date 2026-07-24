# World Model Scenario Explorer (Cosmos-Drive-Dreams)

Decision record for the `/worlds` demo — a gallery of ~300 NVIDIA
Cosmos-Drive-Dreams driving scenarios laid out on a synthetic grid, all
animating at once on one shared clock, each pairable with the Cosmos-generated
video of itself played in sync with its own geometry.

Landed 2026-07-23. Generator: `scripts/data-generation/cosmos_drive_dreams.py`.
Page: `examples/showcase/src/pages/CosmosWorldsImpl.tsx` +
`examples/showcase/src/components/worlds/`.

## 1. Why this demo

The pitch is "the vector scene is authoritative; the world model supplies one
photoreal manifestation of it." That inverts the usual AI-video demo (play a
generated clip, admire it) into something the renderer is uniquely suited to:
hold hundreds of *structured* scenes live at once, and use the generated video
as corroboration of a scene you can already inspect, filter, and scrub.

It is also the first demo whose scale comes from the number of WORLDS rather
than the number of features in one world — a different stress axis than the
existing AV cockpit (one scene, dense LiDAR) or the weather suite (one region,
many overlays).

## 2. Source

`nvidia/PhysicalAI-Autonomous-Vehicle-Cosmos-Drive-Dreams` on Hugging Face,
**CC BY 4.0** — unlike Waymo, redistribution to R2 is permitted with
attribution. Not gated; anonymous download works (slowly — set `HF_TOKEN` for
real rate limits).

Per-clip label tars, one per modality folder, keyed `{uuid}_{start}_{end}.tar`:

| Folder | Contents (probed 2026-07-23) |
| --- | --- |
| `all_object_info` | per-FRAME JSON, `{tracking_id: {object_to_world 4×4, object_lwh, object_is_moving, object_type}}` |
| `vehicle_pose` | per-frame 4×4 FLU `.npy`; pose[0] is identity (clip world frame = rig frame at frame 0) |
| `3d_lanes` | `polylines3d.polylines[].vertices` — an edge PAIR per lane |
| `3d_lanelines`, `3d_road_boundaries`, `3d_wait_lines`, `3d_poles` | `polyline3d.vertices` |
| `3d_crosswalks`, `3d_road_markings` | `surface.vertices` |
| `3d_traffic_lights`, `3d_traffic_signs` | `cuboid3d.vertices` (8 corners) |
| `captions` | one plain-text generation prompt per clip |
| `lidar_raw` | per-clip tar of 10 Hz `.npz` sweeps (~350 MB/clip) |

Clips run ~297 frames @ 30 FPS (~9.9 s). Labels may carry `emptyLabel` families
(a clip with no crosswalks still ships a crosswalks file).

### 2.1 The video constraint (the one that shaped the demo)

The 81,802 generated videos exist ONLY as a single ~695 GB `tar.gz` **byte-split
into 17 parts**. There is no per-clip download. part-000 is the head of the gzip
stream, so it decompresses standalone until it truncates mid-member; parts 001+
cannot be decompressed independently at all.

The generator therefore STREAMS part-000 (`requests` → `gzip` → `tarfile` in
`r|` mode), keeping only the MP4s it wants and never storing the 40 GB part.
Truncation (`EOFError` / `zlib.error` / `tarfile.ReadError`) is the normal end
condition, not a failure.

**Measured, and it changed the design:** the archive is *not grouped by clip* —
a given clip's 14 variants (2 chunks × 7 weathers) are scattered across the
whole 695 GB. 8.2 GB read yielded 938 MP4s over 902 distinct clips, i.e. ~1
variant each (35 clips got 2), with all seven weathers evenly represented across
the corpus.

The original plan assumed a per-world weather carousel. The corpus gives a
**weather mosaic across worlds** instead, which is arguably the better story:
each world exists in one generated condition and the grid reads as a field of
conditions. Selection leans into this — it fills round-robin by weather so the
mosaic is balanced (41–45 worlds per weather in the shipped set).

There is **no true counterfactual pair** in this corpus: the 35 clips that got
two videos got them for DIFFERENT halves of the clip (and different weathers),
not the same moment twice. So the planned "multiple worlds" chip was dropped for
a "trucks & buses" one. A `--videos-top-up` mode re-streams keeping only the
already-selected worlds' variants, for anyone who wants to spend more bandwidth
hunting real same-moment pairs.

### 2.2 One generated window per world (the sync-correctness decision)

A generated video covers 121 of a clip's ~297 frames. Running the full clip as
the loop would leave most of it with no corresponding footage — the video would
freeze or desync for 60% of every cycle, which defeats the demo's entire claim.

So **each world's geometry is built for exactly the 121 source frames its video
covers**, rebased so that window starts at `T0`. The loop IS the generated
window (4033 ms), position in the loop maps 1:1 onto position in the video, and
the frontend's sync math reduces to `(t − start)/span × duration`. Worlds with
two videos commit to chunk 0. This also cuts the objects archive to ~41% of what
a full-clip build would produce.

## 3. Georeferencing: the synthetic grid

STT tiles are geographic (WKB lon/lat, Web-Mercator pyramid); there is no
Cartesian tiling mode and no `OrbitView` in the showcase. So the scenarios are
laid out as REAL lat/lon on a fake lattice:

- 17×18 cells at 1 km pitch, centred at (lat 0, lon −30) — the equator makes
  `local_to_lonlat` isotropic (`cos(lat) = 1`), and the mid-Atlantic guarantees
  nothing real is underneath. `hideBasemap: true` + `avLocalFrame: true`.
- Per clip: rebase on the first ego pose, optionally rotate by `−yaw0` so every
  world starts heading east, centre the ego bbox on the cell, then
  `local_to_lonlat` about the cell origin. ONE rigid transform per clip applied
  identically to ego, objects, map, and LiDAR, so the modalities stay registered.
- Every world is rebased onto a shared epoch (`T0 = 2024-01-01T00:00:00Z`) at
  the start of ITS generated window (§2.2), so the whole grid animates in phase
  on one ~4 s loop.

## 4. Archives

Four COMBINED cross-scenario archives (not 300 bundles) so the gallery animates
from a handful of tilesets:

| Archive | Kind | Zooms | Bucket | Notes |
| --- | --- | --- | --- | --- |
| `objects/` | point | 13–16 | 1 s | 10 Hz box keyframes over the generated window; low zooms deliberately absent (the FE gates boxes at z≥13.5, so those tiles would never be read) |
| `ego/` | trips | 10–16 | 1 s | one LineString per world; the PRIMARY + only required governor source |
| `map_line/` | map_line | 10–16 | whole-scene | timeless substrate |
| `map_poly/` | map_poly | 10–16 | whole-scene | timeless substrate |
| `heroes/<id>/lidar/` | point 3D | 14–18 | 100 ms | 3 worlds only, streamed on selection |

**Built 2026-07-23** — 266 worlds on a 16×17 grid, every world's loop exactly
4000 ms: `map_line` 105 MB (1.46 M features), `map_poly` 67 MB (522 k),
`heroes` 168 MB (3 × ~4.4 M points), `objects` 13 MB (1.39 M box keyframes),
`ego` 2.9 MB, `videos` 142 MB → **499 MB total**.

`stt-validate` is clean (exit 0, one schema, no errors) on `objects`,
`map_line`, `map_poly` and the hero clouds. The `ego` archive reports schema
drift — `--simplify` drops the per-vertex `vertex_value` column below its
max-simplify zoom — but this is **pre-existing behaviour shared by every AV ego
archive in the repo** (`av-synthetic`, Argoverse, nuScenes all report the same),
and this page colours trips with a constant, so nothing reads that column. Left
as-is rather than diverging from `run_stt_build`'s trips convention.

All playback archives are built `--blob-ordering time-major` (the project rule —
`auto` can pick spatial ordering and silently stall playback).

Every feature of all four archives carries a categorical `scenario_id` plus the
numeric filter columns `agent_count`, `has_ped`, `has_large`, `weather_id`,
so the chips filter on the GPU.

### 4.1 Per-modality decisions

- **Objects**: heading from `atan2(R[1,0], R[0,0])` (FLU) minus the clip's
  alignment yaw. 10 Hz keyframes emitted as-is — `AnimatedBoundingBoxLayer`
  interpolates between the two bracketing them, so resampling would only add
  error. `track_id` is prefixed with the scenario id because the layer pools
  tracks globally across the combined archive.
- **Ego**: 30 FPS poses decimated to 10 Hz VERTICES. This is a sampling-cadence
  choice on a continuous signal (~3 cm chord error at speed, below the 0.1 m
  coordinate quantization), not feature thinning — the same reasoning as the
  weather-suite wind vertex cadence.
- **Lanes** yield both a centerline (the two edge polylines resampled and
  averaged) and a lane SURFACE polygon (edge A + reversed edge B), so the map
  reads as filled roadway rather than wireframe.
- **Traffic lights / signs**: the 3D cuboids are flattened to their bottom-face
  footprint polygons with `z_base` / `obj_height` kept as properties. This rides
  the existing static whole-window map idiom with no new layer type; extruding
  them later needs only render-side work.
- **Hero LiDAR** — two traps here, both of which we fell into first time and
  which cost a cloud that drifted **>100 m from its own HD map by mid-clip**:

  1. Sweep files are numbered by **camera frame, not sweep ordinal**:
     `…000000.npz`, `…000003.npz`, … `…000294.npz` (10 Hz LiDAR against 30 FPS
     frames). The number IS the frame index. Treating it as an ordinal and
     multiplying by 3 walks the clip three times too fast — and, because the
     inflated index is also what the generated-window filter tests, silently
     drops two thirds of the sweeps.
  2. Each npz ships its own **`lidar_to_world` 4×4**, which is authoritative and
     already carries the sensor's mount offset from the rig origin (0.776 m
     forward, 1.937 m up on the probed clip). Lifting by `vehicle_pose` instead
     drops that extrinsic.

  Measured error of the wrong version against the correct placement: 0.8 m at
  frame 0, 72 m at frame 45, 118 m at frame 150. The fix is to read the frame
  index straight from the filename and place points with the file's own
  transform — no pose array, no frame-convention heuristic. Correct output is
  41 sweeps / 12.4 M points per hero over the generated window, with the cloud
  centroid tracking the ego path to a constant ~4 m (the centroid of a 200 m
  scan, not drift).

## 5. Frontend

A fully custom page (`/worlds/:worldId?`), not a `DemoViewer` demo. `case 'av'`
composes the wrong layer set (LiDAR-primary, and it deliberately omits ego
trips), and a `type: 'av'` entry would leak into the cockpit's scene switcher.
New `DatasetType: 'worlds'` with a bespoke `buildWorldsLayers` that copies the
`case 'av'` recipes (governor `sourceProps`, `tileLoadingProps`, composite cache
split, ground-decal parameters).

Three constraints from the layer code shaped the UX:

1. **`AnimatedBoundingBoxLayer` has no DataFilter support** (it is CPU-per-frame,
   outside the kind-parity DataFilter matrix). The boxes are unfiltered — moot,
   since they only mount when you are zoomed into a single world.
2. **DataFilter is hide-only** — there is no dim mode. So filtered-out worlds
   lose their geometry, and the client-side anchor-dot layer (300 rows from
   `worlds.json`) stays drawn at low alpha to keep the grid's shape legible.
3. **`filterSize: 1`** — one numeric column at a time, so chips are
   single-select rather than checkboxes.

Perf posture: the boxes mount only at zoom ≥ 13.5 (`BOX_ZOOM`). Below that a
whole scenario is ~40 px wide, and ~12k CPU-interpolated tracks would dominate
the frame for sub-pixel confetti. The overview is carried by the ego trails, the
map substrate, and the anchor dots. Unmounted layers' governor sources are
unregistered by a reconciliation effect (AvDeck's idiom) so a hidden source
never counts toward the buffer picture.

**Video sync** (`WorldVideoPanel`) extends `CameraInset`'s "drive media off
TimeController events" pattern with what a video needs: NORMALIZED position
mapping (`(t − start)/span × duration`, immune to the generated clip's unknown
fps), free-run with drift correction past 0.25 s instead of per-tick seeking,
`playbackRate` matched to the sim/real ratio, a hard snap on `wrap`, and frame
stepping on paused scrub (because `tick` also fires on seeks). A generated clip
covers ONE 121-frame chunk of its source clip, so the mapping targets that
chunk's sub-window of the loop.

## 6. Open / follow-ups

- **User browser verify** (aesthetics, per project preference): overview
  liveliness, fly-in feel, video sync under scrub + loop, filter readability,
  hero LiDAR.
- **R2 sync then un-gate**: the id is in `LOCAL_ONLY_DATASETS`. CC BY 4.0 permits
  the sync; verify the four manifests, `worlds.json`, AND `videos/` before
  un-gating (a partial sync leaves the galaxy animating over dead panels).
- **True counterfactuals**: none exist in the streamed corpus (§2.1). Finding
  same-moment/different-weather pairs needs more `--videos-top-up` passes at
  ~40 GB each; if any turn up, the panel's variant carousel already handles them.
- **Extruded signals**: traffic-light/sign footprints already carry `z_base` /
  `obj_height`; extruding them is render-side only.
- **Box DataFilter**: adding `filterProperty` / `filterRange` to
  `AnimatedBoundingBoxLayer`'s per-frame sample rebuild is small and would let
  chips reach the agents too (needs a layers dist rebuild).
