/**
 * Dataset configurations for the spatiotemporal tiles showcase.
 *
 * Playback speed is derived per dataset from targetPlaybackSeconds; see
 * calculateAnimationSpeed in types.ts.
 */

import { Dataset, ColorRGBA, DatasetLegend } from './types';

/**
 * Chronological color ramp for OSM "edit age strata": older node creations read
 * cool (deep blue), recent ones warm (red). Keyed by year string so the point
 * layer's `colorMapping` can color each creation by the year it first appeared.
 */
function osmYearColors(startYear: number, endYear: number): Record<string, ColorRGBA> {
  const stops: ColorRGBA[] = [
    [37, 52, 148, 255],   // deep blue (oldest)
    [44, 127, 184, 255],  // blue
    [65, 182, 196, 255],  // cyan
    [120, 198, 121, 255], // green
    [255, 204, 92, 255],  // yellow
    [253, 141, 60, 255],  // orange
    [227, 26, 28, 255],   // red (newest)
  ];
  const out: Record<string, ColorRGBA> = {};
  const span = Math.max(1, endYear - startYear);
  for (let y = startYear; y <= endYear; y++) {
    const f = ((y - startYear) / span) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(f));
    const frac = f - i;
    const a = stops[i];
    const b = stops[i + 1];
    out[String(y)] = [
      Math.round(a[0] + (b[0] - a[0]) * frac),
      Math.round(a[1] + (b[1] - a[1]) * frac),
      Math.round(a[2] + (b[2] - a[2]) * frac),
      255,
    ];
  }
  return out;
}

const OSM_YEAR_COLORS = osmYearColors(2007, 2026);

/**
 * LIDAR `height_band` → RGBA color ramp for the AV cockpit. Keyed by the
 * generator's categorical band labels (e.g. "-2-0", "0-2", … — a range form,
 * deliberately non-numeric so stt-build keeps the column Categorical instead of
 * promoting an all-numeric-string column to Numeric and no-opping the map).
 * Low (ground) reads cool deep-blue → high (rooftops/canopy) reads warm amber,
 * a viridis-ish 8-band ground→sky ramp.
 */
// Keys MUST match the generator's `av_common.HEIGHT_BANDS` exactly (the two
// outermost bands are open-ended: "<-2" and ">10"). A key that doesn't match a
// band label silently no-ops to `lidarColorMappingDefault`.
const AV_HEIGHT_BAND_COLORS: Record<string, ColorRGBA> = {
  '<-2': [46, 30, 96, 255],     // below grade — deep indigo
  '-2-0': [52, 60, 158, 255],   // ground — blue
  '0-2': [40, 120, 190, 255],   // curb / low — cyan-blue
  '2-4': [38, 168, 168, 255],   // car-roof height — teal
  '4-6': [72, 196, 120, 255],   // green
  '6-8': [170, 214, 74, 255],   // lime
  '8-10': [248, 198, 60, 255],  // building edge — amber
  '>10': [250, 140, 48, 255],   // rooftops / canopy — orange
};

/**
 * LIDAR `seg_class` → RGBA color for AV scenes that ship per-point SEMANTIC
 * labels (nuScenes-lidarseg, collapsed to a coarse taxonomy by the extractor).
 * Used instead of `AV_HEIGHT_BAND_COLORS` when a dataset sets
 * `colorProperty: 'seg_class'`, so the cloud reads as a labelled scene (orange
 * cars, blue people, green canopy, grey road) rather than a height ramp.
 */
// Keys MUST match the generator's `av_common.LIDARSEG_COLORS` exactly (the dual
// copy — this colors the rendered points, that bakes the scene.json legend). A
// key that doesn't match a class silently no-ops to `lidarColorMappingDefault`.
const AV_LIDARSEG_COLORS: Record<string, ColorRGBA> = {
  vehicle: [255, 158, 0, 255], // orange — echoes the car box color
  cyclist: [220, 20, 60, 255], // crimson — bicycle + motorcycle
  pedestrian: [40, 130, 255, 255], // bright blue — people
  road: [80, 90, 120, 255], // blue-grey — drivable surface
  sidewalk: [205, 175, 125, 255], // tan — sidewalk
  terrain: [150, 140, 70, 255], // olive — terrain / other flat
  vegetation: [70, 180, 95, 255], // green — trees / bushes
  manmade: [190, 130, 215, 255], // violet — buildings, poles, barriers, cones
  other: [120, 125, 140, 255], // dim grey — noise / unknown
};

/**
 * Tracked-object category → RGBA color for the AV cockpit (mirrors the
 * `objectColors` block the adapters write into `scene.json`). Keyed by the
 * canonical category set (car/truck/bus/…/barrier; unknown → `other`).
 */
// Canonical nuScenes class palette — a projection of the devkit's `get_colormap()`
// onto our 10-class taxonomy: vehicles read warm (orange→tomato→red), pedestrians
// blue, cyclists crimson/red, cones dark-slate, barriers slate-grey. Matches every
// nuScenes figure, so the boxes read as "real" AV output. Box color comes from the
// Dataset's `avObjectColors`, so swapping this recolors all scenes with no re-gen.
const AV_OBJECT_COLORS: Record<string, ColorRGBA> = {
  car: [255, 158, 0, 235], // orange
  truck: [255, 99, 71, 235], // tomato
  bus: [255, 69, 0, 235], // orangered
  trailer: [255, 140, 0, 235], // darkorange
  construction_vehicle: [233, 150, 70, 235],
  pedestrian: [0, 80, 230, 240], // blue
  bicycle: [220, 20, 60, 240], // crimson
  motorcycle: [255, 61, 99, 240], // red
  traffic_cone: [47, 79, 79, 235], // darkslategrey
  barrier: [112, 128, 144, 225], // slategrey
  other: [150, 160, 175, 220],
  // SYNTHETIC — render-only, NOT part of the python OBJECT_COLORS dual copy. The
  // tracks archive carries an extra `category: "ego"` track (the vehicle's own
  // spacetime spine); the cube ribbon paints it this signature cyan so the ego
  // thread stands out against the object tracks. No tile/legend dependency.
  ego: [120, 230, 255, 255],
};

// HD-map `map_layer` → RGBA. Keys MUST match `av_common.MAP_COLORS`. Polygon
// layers (drivable/crosswalk/…) get low-alpha fills so they read as a subtle
// substrate; line layers (dividers / lane boundaries) get crisp high-alpha. The
// nuScenes layer palette + the Argoverse-2 lane-mark-type colors both live here.
const AV_MAP_COLORS: Record<string, ColorRGBA> = {
  // nuScenes / synthetic polygons (fills, under the scene)
  drivable_area: [166, 206, 227, 90],
  road_segment: [31, 120, 180, 70],
  road_block: [178, 223, 138, 70],
  lane: [51, 160, 44, 70],
  ped_crossing: [251, 154, 153, 150],
  walkway: [227, 26, 28, 110],
  stop_line: [253, 191, 111, 170],
  carpark_area: [255, 127, 0, 90],
  // nuScenes / synthetic lines (dividers)
  road_divider: [202, 178, 214, 230],
  lane_divider: [106, 61, 154, 230],
  // Argoverse 2 polygons
  drivable: [122, 122, 122, 90],
  crosswalk: [150, 60, 200, 150],
  // Argoverse 2 lane boundaries (by LaneMarkType)
  lane_white: [255, 255, 255, 210],
  lane_yellow: [250, 210, 1, 220],
  lane_blue: [42, 130, 193, 220],
  lane_red: [223, 1, 1, 210],
  lane_boundary: [200, 200, 200, 200],
  // Argoverse 2 lane centerlines (the dataset's signature feature) — subtle
  // steel-blue threads; intersection lanes read amber so junctions pop.
  lane_centerline: [90, 130, 165, 95],
  lane_centerline_intersection: [255, 170, 50, 160],
};

/**
 * Base URL for hosted STT tile datasets. Each dataset is now a packed DIRECTORY
 * (`/data/<stem>/manifest.json` + `index/` + `packs/`), not a single `.stt`
 * file, so a `url` points at the dataset's `manifest.json`. When
 * `VITE_DATA_BASE_URL` is set (e.g. an R2 custom domain like
 * `https://tiles.example.com`), every dataset's `/data/<stem>/manifest.json`
 * path is rewritten to `<base>/data/<stem>/manifest.json`. Unset → served from
 * the showcase origin (local `public/data`), so behavior is unchanged by default.
 */
const DATA_BASE_URL: string = ((import.meta as any).env?.VITE_DATA_BASE_URL ?? '')
  .toString()
  .replace(/\/$/, '');

function resolveDataUrl(url: string): string {
  return DATA_BASE_URL && url.startsWith('/data/') ? `${DATA_BASE_URL}${url}` : url;
}

// Shared cockpit legend for the semantic-LIDAR scenes (hex of AV_LIDARSEG_COLORS;
// `other` omitted — it's noise/unknown). Reused by every nuScenes scene.
const AV_LIDARSEG_LEGEND: DatasetLegend = {
  title: 'LIDAR semantic class',
  items: [
    { color: '#ff9e00', label: 'vehicle' },
    { color: '#dc143c', label: 'cyclist' },
    { color: '#2882ff', label: 'pedestrian' },
    { color: '#505a78', label: 'road' },
    { color: '#cdaf7d', label: 'sidewalk' },
    { color: '#968c46', label: 'terrain' },
    { color: '#46b45f', label: 'vegetation' },
    { color: '#be82d7', label: 'building / manmade' },
  ],
};

// Shared cockpit legend for the height-band LIDAR scenes (Argoverse 2 / synthetic
// — sources with no per-point semantic labels), hex of AV_HEIGHT_BAND_COLORS.
const AV_HEIGHT_BAND_LEGEND: DatasetLegend = {
  title: 'LIDAR height band (m)',
  items: [
    { color: '#343c9e', label: 'ground' },
    { color: '#26a8a8', label: 'car-roof' },
    { color: '#aad64a', label: 'mid' },
    { color: '#f8c63c', label: 'building edge' },
    { color: '#fa8c30', label: 'rooftops' },
  ],
};

// LIDAR density iso-line ramp (waymo_extract.py --contours). Ordinal bands sparse
// outer ring → dense core (cool/dim → hot/bright), alpha rising with density so
// the dense cores — walls, parked cars — pop against the dark cockpit backdrop.
// DUAL-COPY: keys MUST match `av_common.ISO_DENSITY_BANDS` ('d1'..'d5'); this is
// the ACTUAL rendered line palette (via the iso variant's `lidarColorMapping`).
const AV_ISO_DENSITY_COLORS: Record<string, ColorRGBA> = {
  d1: [78, 96, 188, 150],   // sparse outer ring — dim blue-violet
  d2: [44, 152, 222, 185],  // cyan-blue
  d3: [40, 200, 176, 210],  // teal-green
  d4: [248, 200, 74, 236],  // amber
  d5: [255, 120, 56, 255],  // dense core — hot orange
};
const AV_ISO_DENSITY_LEGEND: DatasetLegend = {
  title: 'LIDAR return density',
  items: [
    { color: '#4e60bc', label: 'sparse' },
    { color: '#2c98de', label: 'low' },
    { color: '#28c8b0', label: 'medium' },
    { color: '#f8c84a', label: 'high' },
    { color: '#ff7838', label: 'dense (walls / cars)' },
  ],
};

// 3D iso-line relief (cockpit "Iso 3D" mode = the `-iso3d` bundle): the contours
// carry their REAL per-layer height in a numeric `z_layer` column (metres), built
// by `waymo_extract.py --contours --contour-z-step`. The render lifts each ring to
// `z_layer × this scale`, so the vertical axis is true LIDAR structure (walls
// contour up their full height, cars only near the ground). VERTICAL EXAGGERATION
// only: 1 = true 1:1 with the point cloud; ~2–3 makes the few-metre structure read
// against the ~100 m-wide scene. Tune to taste.
const AV_ISO_DENSITY_ELEVATION_SCALE = 2.5;

// Height-graded opacity for the iso3d stack (cockpit "Iso 3D" mode). The contour
// rings are stacked at their real `z_layer` altitude; viewed top-down, the upper
// slabs would otherwise occlude everything beneath them. Fading alpha with height
// — ground crisp, roof translucent — makes the whole stack read coherently from
// above (you see down through the layers). Range is RAW metres (pre-exaggeration);
// the Miami scene spans ~0–7 m, so [0, 6] grades across the structure with the top
// dropping to ~30% alpha. Tune `far` lower for a more see-through roof.
const AV_ISO_DENSITY_TOP_FADE = { range: [0, 6] as [number, number], near: 1, far: 0.3 };
// Waymo variant: the Waymo top-LIDAR FOV is vertically shallow (a few metres),
// so the iso3d stack spans far less height than AV2's georeferenced cloud. A
// tighter range keeps the same ground-crisp→roof-translucent grading engaged
// across Waymo's true z-span rather than barely fading. Refined to the scenes'
// measured span. Local-only (Waymo tiles aren't on R2 — license).
const AV_ISO_DENSITY_TOP_FADE_WAYMO = {
  range: [0, 3.5] as [number, number],
  near: 1,
  far: 0.3,
};

/**
 * Symmetric visible window (ms) for the AV LIDAR cloud — each sweep return is
 * drawn for `[t − w/2, t + w/2]` around the play-head (TimeFilterExtension
 * window mode). LIDAR is per-sweep at ~10 Hz (returns stamped with their true
 * sweep time, tiles bucketed at 200 ms), so a TIGHT window shows essentially
 * the live sweep ± a couple of neighbours and the cloud reads CRISP while the
 * ego moves. The old 2 s window kept returns on-screen for a full second on
 * EITHER side of the play-head, smearing ~1 s of past+future sweeps into a
 * draggy tail during motion. This does NOT change tile loading: the loader's
 * prefetch horizon is keyed to playback speed (~5 real-seconds of lookahead),
 * which dominates this window — so only what the shader DRAWS changes.
 * Surfel scenes ignore this (SplatLayer fades via its own `temporalSigma`).
 * Tune here to trade crispness (lower, e.g. 250) vs. cloud density/continuity
 * (higher, e.g. 450). Paired with window-proportional fades on the LIDAR layer
 * (buildDemoLayers) so a tight window snaps to full brightness rather than
 * riding a long soft ramp — the default 300 ms fades alone capped alpha well
 * below 1 on a sub-second window and re-smeared the tail.
 */
const AV_LIDAR_TIME_WINDOW_MS = 500;

/**
 * AV scene-bundle factory for the nuScenes v1.0-mini scenes. Every nuScenes
 * scene emits the identical 6-stream bundle under `/data/<id>/` (lidar / ego /
 * objects / map_poly / map_line packed archives + telemetry.json + cameras.json),
 * colored by the shared semantic-LIDAR + object palettes — so the scenes differ
 * only by id, label, time range, and camera framing. This factory collapses ten
 * otherwise-identical ~60-line entries. Reachable in the cockpit SceneSwitcher
 * (which lists every `type:'av'` dataset) and at `/drive/<id>`; the `/demos`
 * catalog curation is separate (see demoMeta `CATALOG_EXCLUDED_IDS`).
 */
/**
 * Per-scene Google Photorealistic 3D Tiles config, keyed by BASE scene id.
 * Presence here ENABLES the toggle on that base scene; the values seed the
 * cockpit's sliders (the `?tiles3dz=` / `?tiles3dop=` URL params still override).
 *   • `ground` — local ground ellipsoidal height (m) at the anchor. Google's mesh
 *     uses true WGS84 ellipsoidal heights while the AV cloud sits at local z≈0, so
 *     the cockpit lowers the mesh by this much to land it on the streets. Seeded by
 *     a one-off offline tileset probe, then visually fine-tuned per scene.
 *   • `opacity` — default mesh opacity (0–1); below 1 ghosts the buildings so the
 *     LIDAR reads against them. Omit for fully opaque.
 */
const AV_TILES3D_CONFIG: Record<
  string,
  { ground: number; opacity?: number }
> = {
  // Argoverse 2 (georeferenced). Pittsburgh / Miami / Detroit visually fine-tuned;
  // the rest are auto-estimated by the box-bottom probe (scripts/estimate-3d-tiles-
  // ground.mjs) — validated to ±2 m on flat AV2 terrain, so likely close, but may
  // want a small slider trim (more on hilly scenes, like Pittsburgh's ~+8).
  'argoverse-02678d04': { ground: 237.4 }, // Pittsburgh — tuned (est ~229, hilly)
  'argoverse-02a00399': { ground: -24 }, // Miami — tuned (est -25.3)
  'argoverse-0b5142c1': { ground: -6 }, // Washington DC — estimated
  'argoverse-0bae3b5e': { ground: 146 }, // Detroit — tuned (est 144.3)
  'argoverse-25e5c600': { ground: -23 }, // Palo Alto — estimated
  'argoverse-92b900b1': { ground: 111 }, // Austin — estimated
  // nuScenes (georeferenced; ground-biased probe estimates — noisier because the
  // Singapore high-rises pollute the tile sample, so expect a per-scene trim).
  'nuscenes-0061': { ground: 31 }, // One-North
  'nuscenes-0103': { ground: -25 }, // Boston Seaport
  'nuscenes-0553': { ground: -21 }, // Boston Seaport
  'nuscenes-0655': { ground: -20 }, // Boston Seaport
  'nuscenes-0757': { ground: -20 }, // Boston Seaport
  'nuscenes-0796': { ground: 25 }, // Queenstown
  'nuscenes-0916': { ground: 41 }, // Queenstown
  'nuscenes-1077': { ground: 37 }, // Holland Village
  'nuscenes-1094': { ground: 32 }, // Holland Village
  'nuscenes-1100': { ground: 33 }, // Holland Village
  // NOTE: Waymo scenes are deliberately excluded — they're anchored in an
  // approximate local frame (no real georef), so the georeferenced photoreal mesh
  // would never line up with the cloud's streets.
};

function nuscenesScene(opts: {
  id: string;
  name: string;
  description: string;
  timeRange: { start: number; end: number };
  longitude: number;
  latitude: number;
  /** Street-level framing; 18.5 frames a ~150 m scene so the cloud reads as 3D. */
  zoom?: number;
}): Dataset {
  const base = `/data/${opts.id}`;
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    url: `${base}/lidar/manifest.json`,
    avLidarUrl: `${base}/lidar/manifest.json`,
    avSceneUrl: `${base}/scene.json`,
    avEgoUrl: `${base}/ego/manifest.json`,
    avObjectsUrl: `${base}/objects/manifest.json`,
    avTracksUrl: `${base}/tracks/manifest.json`,
    avTelemetryUrl: `${base}/telemetry.json`,
    avCamerasUrl: `${base}/cameras.json`,
    avMapPolyUrl: `${base}/map_poly/manifest.json`,
    avMapLineUrl: `${base}/map_line/manifest.json`,
    mapColors: AV_MAP_COLORS,
    type: 'av',
    // Google Photorealistic 3D Tiles toggle — nuScenes is georeferenced (real
    // Boston Seaport / Singapore), so the photoreal mesh registers with the cloud.
    ...(AV_TILES3D_CONFIG[opts.id] && {
      tiles3d: true,
      tiles3dGroundHeight: AV_TILES3D_CONFIG[opts.id].ground,
      ...(AV_TILES3D_CONFIG[opts.id].opacity !== undefined && {
        tiles3dOpacity: AV_TILES3D_CONFIG[opts.id].opacity,
      }),
    }),
    timeRange: opts.timeRange,
    timeWindow: AV_LIDAR_TIME_WINDOW_MS,
    targetPlaybackSeconds: 20,
    initialViewState: {
      longitude: opts.longitude,
      latitude: opts.latitude,
      zoom: opts.zoom ?? 18.5,
      pitch: 55,
      bearing: 20,
    },
    // LIDAR colored by per-point nuScenes-lidarseg SEMANTIC class (`seg_class`),
    // not height band — orange cars, blue people, green canopy, grey road.
    colorProperty: 'seg_class',
    lidarColorMapping: AV_LIDARSEG_COLORS,
    lidarColorMappingDefault: [120, 130, 150, 220],
    radius: 1.4,
    radiusUnits: 'pixels',
    radiusMinPixels: 1,
    opacity: 0.9,
    avObjectColors: AV_OBJECT_COLORS,
    colorMappingDefault: [150, 160, 175, 220],
    tripColor: [120, 230, 255, 255],
    widthUnits: 'meters',
    tripWidth: 2.2,
    fadeTrail: true,
    legend: AV_LIDARSEG_LEGEND,
  };
}

/**
 * AV scene-bundle factory for the Argoverse 2 sensor scenes (one per city). Every
 * AV2 scene emits the same full-stream bundle under `/data/<id>/` (lidar / ego /
 * objects / map_poly / map_line packed archives + telemetry.json + cameras.json),
 * built by `argoverse_extract.py` via `argoverse_batch.sh`. Unlike nuScenes, AV2
 * sensor ships NO per-point semantic labels, so the LIDAR is colored by
 * `height_band` (not `seg_class`); telemetry is DERIVED from the ego pose (AV2 has
 * no CAN bus). Scenes differ only by id, label, time range, and camera framing.
 * Reachable in the cockpit SceneSwitcher and at `/drive/<id>`.
 */
function argoverseScene(opts: {
  id: string;
  name: string;
  description: string;
  timeRange: { start: number; end: number };
  longitude: number;
  latitude: number;
  /** Street-level framing; ~18 frames a ~150 m AV2 scene so the cloud reads 3D. */
  zoom?: number;
  /**
   * Oriented-surfel splat variant: the bundle was built with
   * `argoverse_extract.py --surfel` (per-sweep k-NN covariance → orientation +
   * extents + confidence). Renders the cloud as oriented anisotropic Gaussian
   * disks via `SplatLayer` — a "formal" splat that reads as surface and evolves
   * over time — instead of the height ramp. Implies camera color (surfels are
   * camera-colored). Unlike Waymo, AV2 is georeferenced, so the surfel scene
   * keeps the real basemap + HD-map substrate the surface reconstruction sits on.
   */
  surfel?: boolean;
  /**
   * Worldbuild ("scene reconstruction") variant: the bundle was built with
   * `argoverse_extract.py --world` (a SplatLayer-compatible surfel cloud plus
   * `is_dynamic` / `world_class` columns, each surfel stamped with its first-seen
   * time). STATIC surfels persist once revealed so the 3D world accumulates as the
   * car drives; DYNAMIC surfels smear with a short temporal Gaussian so traffic
   * reads as motion. Implies camera color. Mutually exclusive with `surfel` /
   * `scan`.
   */
  world?: boolean;
  /**
   * Raw-sweep variant: the `<id>-scan` bundle is raw LIDAR with a per-point TRUE
   * scan-time `start_time` + a phase-ramp `r`/`g`/`b`, rendered as a WAKE-mode
   * point layer so the rotating scan-line sweeps across the scene like a live
   * radar. AV2 only. Mutually exclusive with `surfel` / `world`.
   */
  scan?: boolean;
  /**
   * TRUE-3D density iso-line variant: the `<id>-iso3d` bundle was built with
   * `argoverse_extract.py --contours --contour-z-step` (density contoured per
   * HEIGHT LAYER, each contour tagged with its real `z_layer` altitude). Rendered
   * as iso-lines stacked at true height (`AnimatedPathLayer`, `density_band` ramp,
   * lifted by `z_layer`). Mutually exclusive with `surfel` / `world` / `scan`.
   */
  iso3d?: boolean;
  /**
   * FLAT density iso-line variant: the `<id>-iso` bundle (`argoverse_extract.py
   * --contours`, no z-step) — a high-XY-resolution topographic overview of return
   * density, drawn flat (`AnimatedPathLayer`, `density_band` ramp). The 2D sibling
   * of `iso3d`. Mutually exclusive with the others.
   */
  iso?: boolean;
  /**
   * Additive-octree zoom-LOD variant: the `<id>-lod` bundle was built with
   * `argoverse_extract.py --lod` (each return materialized at a single per-sweep
   * `home_zoom`). Rendered through the normal point path with the engine's
   * `lodMode: 'additive'` — coarse zooms hold a sparse overview, finer zooms add
   * only the residual, so zooming in streams detail without re-fetching the
   * coarse cloud. Mutually exclusive with `surfel` / `world` / `scan` / iso.
   */
  lod?: boolean;
}): Dataset {
  const base = `/data/${opts.id}`;
  // Base scene id with any render-mode suffix stripped, for the 3D-tiles ground
  // lookup (so every `-lod` / `-surfel` / … variant resolves to its city's value).
  const tiles3dBaseId = opts.id.replace(
    /-(?:surfel|world|scan|iso3d|iso|lod|splat|stage)$/,
    "",
  );
  const surfel = opts.surfel ?? false;
  const world = opts.world ?? false;
  const scan = opts.scan ?? false;
  const iso3d = opts.iso3d ?? false;
  const iso = opts.iso ?? false;
  const lod = opts.lod ?? false;
  // Both iso flavours render through the same lidarIso path; iso3d additionally
  // lifts each contour by its real `z_layer`.
  const isoAny = iso || iso3d;
  // world / surfel / scan / iso / iso3d are mutually exclusive — each is a
  // different cloud representation reading a different bundle.
  if (Number(surfel) + Number(world) + Number(scan) + Number(iso3d) + Number(iso) + Number(lod) > 1) {
    throw new Error(
      `argoverseScene(${opts.id}): surfel / world / scan / iso / iso3d / lod are mutually exclusive`,
    );
  }
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    url: `${base}/lidar/manifest.json`,
    avLidarUrl: `${base}/lidar/manifest.json`,
    avSceneUrl: `${base}/scene.json`,
    avEgoUrl: `${base}/ego/manifest.json`,
    avObjectsUrl: `${base}/objects/manifest.json`,
    avTracksUrl: `${base}/tracks/manifest.json`,
    avTelemetryUrl: `${base}/telemetry.json`,
    avCamerasUrl: `${base}/cameras.json`,
    avMapPolyUrl: `${base}/map_poly/manifest.json`,
    avMapLineUrl: `${base}/map_line/manifest.json`,
    mapColors: AV_MAP_COLORS,
    type: 'av',
    // Google Photorealistic 3D Tiles. AV2 is georeferenced, so the photoreal mesh
    // registers with the cloud's real streets. Every base scene with a config entry
    // gets the toggle (`tiles3d` on the BASE only — the cockpit gates on it); the
    // ground height + opacity are keyed by BASE id so EVERY render-mode variant
    // (`-lod` / `-surfel` / …) carries them too (the cockpit swaps the active
    // dataset per mode, so without this variants would fall back to the runtime
    // auto-detect).
    ...(AV_TILES3D_CONFIG[tiles3dBaseId] && {
      tiles3dGroundHeight: AV_TILES3D_CONFIG[tiles3dBaseId].ground,
      ...(AV_TILES3D_CONFIG[tiles3dBaseId].opacity !== undefined && {
        tiles3dOpacity: AV_TILES3D_CONFIG[tiles3dBaseId].opacity,
      }),
      ...(opts.id === tiles3dBaseId && { tiles3d: true }),
    }),
    // AV2 nanosecond sensor clock ÷1e6 — the large ms values are internally
    // consistent for relative playback (AV2 ships no wall-clock epoch).
    timeRange: opts.timeRange,
    // Scan mode wants a TIGHT window (~300 ms) so each frame shows roughly one
    // live rotating sweep as a wake; iso (flat/3d) wants ~one contour window
    // (260 ms) so the map morphs; points/surfels/world keep the wider window.
    timeWindow: scan ? 300 : isoAny ? 260 : AV_LIDAR_TIME_WINDOW_MS,
    targetPlaybackSeconds: 16,
    initialViewState: {
      longitude: opts.longitude,
      latitude: opts.latitude,
      zoom: opts.zoom ?? 18,
      // The 3D iso relief reads best from a steeper tilt; flat iso sits lower.
      pitch: iso3d ? 62 : 55,
      bearing: 20,
    },
    // No per-point semantic labels in AV2 sensor → color LIDAR by height band…
    // …or, for either iso-line variant, by the categorical density band.
    colorProperty: isoAny ? 'density_band' : 'height_band',
    lidarColorMapping: isoAny ? AV_ISO_DENSITY_COLORS : AV_HEIGHT_BAND_COLORS,
    lidarColorMappingDefault: isoAny ? [96, 116, 168, 150] : [120, 130, 150, 220],
    // …UNLESS this is a camera/phase-colored variant:
    //   • SURFEL — paint per-point r/g/b (projected into the 7 ring cameras) and
    //     render those returns as oriented Gaussian disks via SplatLayer,
    //     brightening/fading around each sweep's instant. AV2 is city-scale +
    //     sparser per-area than the compact Waymo scenes, so its surfels get a
    //     WIDER temporal window so the surface reads continuous as the car drives.
    //   • WORLD — the same camera-colored surfels, but STATIC ones persist once
    //     revealed (cumulative) so the 3D scene accumulates; dynamic ones smear
    //     over ~200 ms so traffic still reads as motion (`-world` bundle).
    //   • SCAN — raw returns colored by a per-point phase ramp (r/g/b), drawn as
    //     a WAKE-mode point sweep that rotates across the scene (`-scan` bundle).
    //   • ISO3D — density iso-line contours stacked at their real `z_layer`
    //     height (`-iso3d` bundle); the cockpit's "Iso 3D" render mode.
    ...(surfel
      ? { lidarRgb: true, lidarSurfel: true, lidarSurfelTemporalSigma: 1800 }
      : world
        ? {
            lidarRgb: true,
            lidarWorldbuild: true,
            lidarWorldbuildRevealFade: 0,
            lidarWorldbuildDynamicSigma: 200,
          }
        : scan
          ? {
              lidarRgb: true,
              lidarScan: true,
              radius: 1.6,
              radiusMinPixels: 1,
              opacity: 1,
            }
          : iso3d
            ? {
                lidarIso: true,
                lidarIso3d: true,
                lidarIsoElevationScale: AV_ISO_DENSITY_ELEVATION_SCALE,
                // Fade the upper height slabs translucent so the stack reads
                // coherently from a top-down view (the roof no longer occludes
                // the structure below it). Keyed on raw `z_layer` metres: ground
                // (~0 m) stays crisp, the top of the scene (~6 m) drops to ~30%.
                lidarIsoTopFade: AV_ISO_DENSITY_TOP_FADE,
              }
            : iso
              ? { lidarIso: true } // flat high-XY-res overview (no z lift)
              : lod
                ? { lidarLod: true } // additive-octree zoom LOD (height-band color)
                : {}),
    // Splats read best a touch larger; surfels/world carry their own per-disk
    // confidence + temporal alpha, so the layer opacity stays at full. Scan sets
    // its own radius/opacity above; iso (flat/3d) renders as paths (radius irrelevant).
    ...(scan || isoAny
      ? { radiusUnits: 'pixels' as const }
      : {
          radius: surfel || world ? 2.4 : 1.4,
          radiusUnits: 'pixels' as const,
          radiusMinPixels: surfel || world ? 1.4 : 1,
          opacity: surfel || world ? 1 : 0.9,
        }),
    avObjectColors: AV_OBJECT_COLORS,
    colorMappingDefault: [150, 160, 175, 220],
    tripColor: [120, 230, 255, 255],
    widthUnits: 'meters',
    tripWidth: 2.2,
    fadeTrail: true,
    // The height-band legend is meaningless for camera/phase-colored variants →
    // omit it; both iso variants show the density-band legend instead.
    ...(surfel || world || scan
      ? {}
      : { legend: isoAny ? AV_ISO_DENSITY_LEGEND : AV_HEIGHT_BAND_LEGEND }),
  };
}

/**
 * AV scene-bundle factory for the Waymo Open Dataset (Perception v2.0.1) scenes,
 * built by waymo_extract.py / waymo_batch.sh from the *modular* Parquet release
 * (decoded with pyarrow + numpy — no TensorFlow / waymo lib). Like AV2 it has no
 * usable per-point semantic labels (Waymo's 3D-semseg covers only ~20/199 frames),
 * so LIDAR is colored by `height_band`, and telemetry is DERIVED from the ego pose
 * (Waymo Perception ships no CAN bus). DELIBERATELY no HD-map streams: v2.0.1 is
 * the "modular without maps" release, AND Waymo discloses no georeferencing — each
 * scene is anchored to an APPROXIMATE local frame (lat/lon by metro), so it rides
 * the cockpit's dark basemap with the lidar itself as the map (the dark streets
 * won't line up with the cloud — expected). Scenes differ only by id/label/
 * timeRange/framing. Reachable in the cockpit SceneSwitcher and at `/drive/<id>`.
 */
function waymoScene(opts: {
  id: string;
  name: string;
  description: string;
  timeRange: { start: number; end: number };
  longitude: number;
  latitude: number;
  /** Street-level framing; ~18 frames a ~150 m Waymo scene so the cloud reads 3D. */
  zoom?: number;
  /**
   * Camera-colored splat variant: the bundle was built with
   * `waymo_extract.py --colorize` (per-point r/g/b from projecting LIDAR into
   * the 5 cameras). Paints each return its sampled color + renders soft gaussian
   * splats — a photographic point cloud — instead of the height ramp.
   */
  colored?: boolean;
  /**
   * Oriented-surfel splat variant: the bundle was built with
   * `waymo_extract.py --surfel` (per-sweep k-NN covariance → orientation +
   * extents + confidence). Renders the cloud as oriented anisotropic Gaussian
   * disks via `SplatLayer` — a "formal" splat that reads as surface and evolves
   * over time. Implies camera color (surfels are camera-colored).
   */
  surfel?: boolean;
  /**
   * Density iso-line variant: the bundle was built with `waymo_extract.py
   * --contours` (windowed 2D density contours of the returns). Renders the LIDAR
   * as live topographic iso-lines (`AnimatedPathLayer`, `density_band` ramp)
   * instead of points/surfels — height-independent, so it reads on a flat scene.
   */
  iso?: boolean;
  /**
   * TRUE-3D density iso-line variant: the bundle was built with `waymo_extract.py
   * --contours --contour-z-step` (density contoured per HEIGHT LAYER, each contour
   * tagged with a numeric `z_layer` altitude). Renders like `iso` but lifts each
   * ring to its real height, so the vertical axis carries actual LIDAR structure.
   * Mutually exclusive with `surfel` / `iso` / `world` / `colored`.
   */
  iso3d?: boolean;
  /**
   * Worldbuild ("scene reconstruction") variant: the bundle was built with
   * `waymo_extract.py --world` (a SplatLayer-compatible surfel cloud + `is_dynamic`
   * / `world_class` columns, each surfel stamped with its first-seen time). STATIC
   * surfels persist once revealed so the 3D world accumulates as the car drives;
   * DYNAMIC surfels smear over ~200 ms so traffic reads as motion. Implies camera
   * color. Mutually exclusive with `surfel` / `iso` / `colored`. Local-only (Waymo
   * no-redistribution).
   */
  world?: boolean;
  /**
   * Additive-octree zoom-LOD variant: the `<id>-lod` bundle was built with
   * `waymo_extract.py --lod` (each return materialized at one geometry-aware
   * `home_zoom`). Rendered through the normal point path with `lodMode:'additive'`
   * — coarse zooms keep a structure-preserving overview, finer zooms add only the
   * residual. Mutually exclusive with surfel / iso / iso3d / world.
   */
  lod?: boolean;
  /**
   * Override the LIDAR point radius (pixels). Smaller points reduce overplotting
   * on dense/scattered clouds (e.g. the rain scene, where returns smear) so the
   * cloud reads at its true resolution instead of a merged blob.
   */
  radius?: number;
  /** Override the LIDAR point floor radius (pixels); pair with a smaller `radius`. */
  radiusMinPixels?: number;
}): Dataset {
  const base = `/data/${opts.id}`;
  const surfel = opts.surfel ?? false;
  const iso = opts.iso ?? false;
  const iso3d = opts.iso3d ?? false;
  const world = opts.world ?? false;
  const lod = opts.lod ?? false;
  // Both iso flavours render through the same lidarIso path (the `density_band`
  // contour LineStrings); iso3d additionally lifts them by the real `z_layer`.
  const isoAny = iso || iso3d;
  // world / surfel / iso / iso3d / lod are mutually exclusive — each reads a
  // different bundle representation. Guard against an entry setting two.
  if (Number(surfel) + Number(iso) + Number(iso3d) + Number(world) + Number(lod) > 1) {
    throw new Error(
      `waymoScene(${opts.id}): surfel / iso / iso3d / world / lod are mutually exclusive`,
    );
  }
  // Surfels + worldbuild are camera-colored too, so the height-band legend is
  // meaningless for them as well as the plain `colored` splat variant.
  const colored = (opts.colored ?? false) || surfel || world;
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    url: `${base}/lidar/manifest.json`,
    avLidarUrl: `${base}/lidar/manifest.json`,
    avSceneUrl: `${base}/scene.json`,
    avEgoUrl: `${base}/ego/manifest.json`,
    avObjectsUrl: `${base}/objects/manifest.json`,
    avTracksUrl: `${base}/tracks/manifest.json`,
    avTelemetryUrl: `${base}/telemetry.json`,
    avCamerasUrl: `${base}/cameras.json`,
    // No avMapPolyUrl/avMapLineUrl — Waymo Perception v2.0.1 ships no HD map.
    type: 'av',
    // Waymo discloses no lat/lon → the scene is anchored at an approximate metro
    // point (right city, wrong streets). Drop the street basemap so the real road
    // network can't visibly contradict the anchor (the extractor's intent). For the
    // same reason it gets NO Google 3D Tiles toggle — the photoreal mesh is
    // georeferenced and would never line up with the approximate-frame cloud.
    avLocalFrame: true,
    timeRange: opts.timeRange,
    // Iso-lines are cut per ~200 ms playhead window (waymo_extract --contour-step);
    // a tight window shows ~one window's contours at a time so the map morphs as
    // the car drives instead of smearing several windows together. Points/surfels
    // keep the wider sweep window.
    timeWindow: isoAny ? 260 : 2000,
    targetPlaybackSeconds: 20,
    initialViewState: {
      longitude: opts.longitude,
      latitude: opts.latitude,
      zoom: opts.zoom ?? 18,
      // The 3D relief reads best from a steeper tilt; flat scenes sit lower.
      pitch: iso3d ? 62 : 55,
      bearing: 20,
    },
    // No per-point semantic labels → color LIDAR by height band (like AV2)…
    // …or, for either iso-line variant, by the categorical density band.
    colorProperty: isoAny ? 'density_band' : 'height_band',
    lidarColorMapping: isoAny ? AV_ISO_DENSITY_COLORS : AV_HEIGHT_BAND_COLORS,
    lidarColorMappingDefault: isoAny ? [96, 116, 168, 150] : [120, 130, 150, 220],
    // …UNLESS this is the camera-colored variant: paint per-point r/g/b (sampled
    // by projecting each return into the 5 cameras). The SURFEL variant renders
    // those colored returns as oriented Gaussian disks via SplatLayer; the plain
    // colored variant renders them as soft round point-splats. Both ISO variants
    // draw the `lidar/` contour LineStrings as AnimatedPathLayer iso-lines; the
    // 3D one additionally lifts each ring to its real `z_layer` altitude.
    ...(isoAny
      ? {
          lidarIso: true,
          ...(iso3d
            ? {
                lidarIso3d: true,
                lidarIsoElevationScale: AV_ISO_DENSITY_ELEVATION_SCALE,
                // Same top-down opacity fade as the AV2 iso3d stack (fade the
                // upper slabs translucent so it reads from above). Keyed on raw
                // metres; Waymo's z-span is shallower than AV2 so the range is
                // tighter to engage the fade across the cloud's true height.
                lidarIsoTopFade: AV_ISO_DENSITY_TOP_FADE_WAYMO,
              }
            : {}),
        }
      : surfel
        ? { lidarRgb: true, lidarSurfel: true, lidarSurfelTemporalSigma: 120 }
        : colored
          ? { lidarRgb: true, lidarSplat: true }
          : lod
            ? { lidarLod: true } // additive-octree zoom LOD (height-band color)
            : {}),
    // Splats read best a touch larger + slightly transparent so overlaps blend.
    // A scene can override these (smaller) when its cloud overplots.
    radius: opts.radius ?? (colored ? 2.4 : 1.4),
    radiusUnits: 'pixels',
    radiusMinPixels: opts.radiusMinPixels ?? (colored ? 1.4 : 1),
    // Surfels carry their own per-disk confidence + temporal alpha, so the layer
    // opacity stays at full; the round point-splats blend better slightly under 1.
    opacity: surfel ? 1 : colored ? 0.96 : 0.9,
    avObjectColors: AV_OBJECT_COLORS,
    colorMappingDefault: [150, 160, 175, 220],
    tripColor: [120, 230, 255, 255],
    widthUnits: 'meters',
    tripWidth: 2.2,
    fadeTrail: true,
    // The height-band legend is meaningless for camera-colored points → omit it;
    // both iso variants show the density-band legend instead of the height band.
    ...(colored
      ? {}
      : { legend: isoAny ? AV_ISO_DENSITY_LEGEND : AV_HEIGHT_BAND_LEGEND }),
  };
}

const rawDatasets: Dataset[] = [
  {
    id: 'nyc-taxi-od-summary',
    name: 'NYC Pickup vs Dropoff Hex Density',
    description:
      'H3 hex-bin density of 1.36M NYC taxi pickups and dropoffs (Jan 1-2, 2015). ' +
      'Toggle pickup vs dropoff.',
    url: '/data/nyc-taxi-od-summary/manifest.json',
    type: 'summary',
    timeRange: {
      start: 1420070400000, // 2015-01-01 00:00:00 UTC
      end: 1420213385000,   // 2015-01-02 15:43:05 UTC
    },
    timeWindow: 1800000, // 30 min — matches the archive's temporal bucket
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -73.985,
      latitude: 40.748,
      zoom: 11,
      pitch: 30,
      bearing: 0,
    },
    summaryExtruded: true,
    // Per-cell density at zoom 11 / 30-min slice tops out around 80-100 in
    // the busiest Midtown cells; scaling each "1 trip" by ~80 m gives the
    // tallest hexes a visible spike without flying past the camera.
    summaryElevationScale: 80,
    summaryCoverage: 0.94,
    // Two-up toggle: pickups (green) vs dropoffs (orange/red), both reading
    // the sum-aggregated columns the build emitted from `is_pickup`/
    // `is_dropoff` indicator columns. Color domain pinned so the legend
    // doesn't jitter as new tiles stream in.
    summaryToggleWeights: [
      {
        id: 'pickup',
        label: 'Pickups',
        weightProperty: 'sum_is_pickup',
        colorDomain: [1, 80],
        colorRange: [
          [16, 64, 32, 220],
          [22, 122, 60, 230],
          [38, 174, 88, 235],
          [76, 218, 122, 240],
          [144, 240, 168, 250],
          [218, 252, 218, 255],
        ],
        legendColors: ['#103a20', '#26ae58', '#90f0a8', '#dafcda'],
      },
      {
        id: 'dropoff',
        label: 'Dropoffs',
        weightProperty: 'sum_is_dropoff',
        colorDomain: [1, 80],
        colorRange: [
          [64, 16, 16, 220],
          [148, 38, 38, 230],
          [216, 84, 50, 235],
          [248, 142, 64, 240],
          [252, 198, 120, 250],
          [255, 240, 210, 255],
        ],
        legendColors: ['#3a0d0d', '#d85432', '#fcc678', '#fff0d2'],
      },
    ],
    legend: {
      title: 'Trips per hex (30 min)',
      ramps: [
        { label: 'Pickups',  colors: ['#103a20', '#26ae58', '#90f0a8', '#dafcda'] },
        { label: 'Dropoffs', colors: ['#3a0d0d', '#d85432', '#fcc678', '#fff0d2'] },
      ],
    },
  },
  {
    id: 'earthquake-activity',
    name: 'Earthquakes',
    sources: ['usgs'],
    description: 'Global M4.0+ events, 2020–2024. Source: USGS.',
    url: '/data/earthquakes-v2/manifest.json',
    type: 'point',
    timeRange: {
      start: Date.parse('2020-01-01T00:00:00Z'),
      end: Date.parse('2024-12-31T23:59:59Z'),
    },
    timeWindow: 86400000 * 30, // 30 day window for multi-year data
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: 140,
      latitude: 20,
      zoom: 2,
      pitch: 0,
      bearing: 0,
    },
    // Marker radius scales with magnitude. Smaller range and tamer slope keep
    // fragment-shader work down: M4.5 ≈ 2.8 px, M6 ≈ 3.0 px, M7 ≈ 4.5 px,
    // M8.5 ≈ 6.8 px. Capped at radiusMaxPixels so a single big quake never
    // explodes into a viewport-wide disc.
    radiusProperty: 'magnitude',
    radiusUnits: 'pixels',
    radiusScale: 1,
    radiusMinPixels: 2,
    radiusMaxPixels: 16,
    radiusTransform: (mag: number) => Math.max(2, (mag - 4) * 1.5),
    // Color by magnitude band (categorical column emitted by stt-generate).
    // Fully opaque so the GPU can skip alpha blending — biggest perf win
    // after dropping `stroked`.
    colorProperty: 'mag_band',
    colorMapping: {
      '1-M4.5-5': [254, 229, 217, 255],
      '2-M5-6':   [252, 174, 145, 255],
      '3-M6-7':   [251, 106,  74, 255],
      '4-M7-8':   [222,  45,  38, 255],
      '5-M8+':    [165,  15,  21, 255],
    },
    colorMappingDefault: [120, 120, 120, 255],
    legend: {
      title: "Magnitude",
      items: [
        { color: "#FEE5D9", label: "M4.5–5.0" },
        { color: "#FCAE91", label: "M5.0–6.0" },
        { color: "#FB6A4A", label: "M6.0–7.0" },
        { color: "#DE2D26", label: "M7.0–8.0" },
        { color: "#A50F15", label: "M8.0+" }
      ]
    },
  },
  {
    // 3D columns reusing the SAME earthquakes-v2 archive as earthquake-activity
    // — magnitude (numeric column) drives column height via AnimatedColumnLayer.
    id: 'earthquake-columns',
    name: 'Earthquakes as 3D Columns',
    sources: ['usgs'],
    description: 'Global M4.0+ catalog as extruded columns; column height is magnitude. Same archive as the points demo. AnimatedColumnLayer.',
    url: '/data/earthquakes-v2/manifest.json',
    type: 'column',
    timeRange: {
      start: Date.parse('2020-01-01T00:00:00Z'),
      end: Date.parse('2024-12-31T23:59:59Z'),
    },
    timeWindow: 86400000 * 30, // 30-day rolling window, matches the points demo
    targetPlaybackSeconds: 60,
    // Tilted regional view over the Ring of Fire (Japan) where the seismic
    // field is dense enough for the columns to read as a 3D bar field; pan out
    // for the global plate-boundary picture.
    initialViewState: {
      longitude: 138,
      latitude: 36,
      zoom: 5,
      pitch: 55,
      bearing: 15,
    },
    elevationProperty: 'magnitude',
    // magnitude is ~4–8; ×12 km gives 48–96 km columns — tall enough to read
    // at zoom ~5 without flying past the camera.
    elevationScale: 12000,
    columnRadius: 6000,
    columnRadiusUnits: 'meters',
    columnDiskResolution: 6,
    columnFillColor: [251, 106, 74, 220],
    opacity: 0.85,
    legend: {
      title: 'Column height = magnitude',
      items: [{ color: '#fb6a4a', label: 'M4.0+ earthquake' }],
    },
  },
  {
    // Origin→destination flow arcs — straight pickup→dropoff lines bowed into
    // arcs, animated by trip time. Synthetic offline data (no OSRM).
    id: 'nyc-od-arcs',
    name: 'NYC Taxi Origin→Destination Arcs',
    description: '~5.8K synthetic NYC taxi trips as origin→destination arcs, animated by pickup→dropoff time. AnimatedArcLayer.',
    url: '/data/nyc-od-arcs/manifest.json',
    type: 'arc',
    timeRange: {
      start: 1705276800000, // 2024-01-15 00:00 UTC
      end: 1705364736000,   // ~24 h later
    },
    timeWindow: 1800000, // 30-min slice — arcs whose [pickup, dropoff] overlaps
    targetPlaybackSeconds: 45,
    initialViewState: {
      longitude: -73.965,
      latitude: 40.745,
      zoom: 11.2,
      pitch: 45,
      bearing: 0,
    },
    arcSourceColor: [56, 196, 232, 210], // pickup — cool cyan
    arcTargetColor: [255, 142, 64, 220], // dropoff — warm orange
    arcWidth: 1.5,
    arcHeight: 0.4,
    opacity: 0.7,
    legend: {
      title: 'Trip direction',
      items: [
        { color: '#38c4e8', label: 'Pickup (origin)' },
        { color: '#ff8e40', label: 'Dropoff (destination)' },
      ],
    },
  },
  {
    // CARTO Quadbin summary tier — point density aggregated into square cells
    // by the Rust quadbin aggregator, rendered by QuadbinSummaryLayer.
    id: 'nyc-od-quadbin',
    name: 'NYC Trip Density — Quadbin Cells',
    description:
      '~23K synthetic NYC pickup/dropoff points aggregated into CARTO Quadbin ' +
      'square cells, extruded by count. QuadbinSummaryLayer.',
    url: '/data/nyc-od-quadbin/manifest.json',
    type: 'quadbin-summary',
    timeRange: {
      start: 1705276800000,
      end: 1705366051000,
    },
    timeWindow: 3600000, // 1 h — matches the summary temporal bucket
    targetPlaybackSeconds: 45,
    initialViewState: {
      // The Quadbin aggregator offsets cells +3 levels finer than the view
      // zoom, so zoom 12 → quadbin z15 cells (~1.2 km): ~40 cells over
      // Manhattan, each ~20 points/hour — a legible density grid. The summary
      // tier covers zooms 8–15; pan out to coarsen, zoom past it for raw points.
      longitude: -73.97,
      latitude: 40.75,
      zoom: 12,
      pitch: 30,
      bearing: 0,
    },
    summaryWeightProperty: 'count',
    summaryColorRange: [
      [12, 44, 76, 200],
      [22, 92, 138, 220],
      [38, 150, 190, 235],
      [104, 204, 214, 245],
      [180, 236, 226, 250],
      [240, 252, 240, 255],
    ],
    summaryColorDomain: [1, 30],
    summaryExtruded: true,
    // Elevation is raw count × scale (not domain-clamped); keep it small — a
    // ~30-count cell rises ~240 m, a modest block at zoom 12.
    summaryElevationScale: 8,
    summaryCoverage: 0.9,
    legend: {
      title: 'Points per Quadbin cell (1 h)',
      ramps: [
        { label: 'Density', colors: ['#0c2c4c', '#2696c2', '#b4ece2', '#f0fcf0'] },
      ],
    },
  },
  {
    // Real Montreal BIXI bike-share trips (August 2024) aggregated into directed
    // origin→destination station-pair flows. FlowmapLayer animates each tapered
    // arrow's width from a per-hour vertexValueMatrix + sizes node circles by
    // incident flow — the tile spans the whole month, so it loads once and
    // animates from the matrix as the playhead scrubs the daily commute rhythm.
    // Stations are clustered into hubs per zoom at build time (flowmap.gl-style).
    id: 'bixi-flowmap',
    name: 'Montréal BIXI — OD Flowmap',
    sources: ['bixi'],
    description: 'A month of real Montréal BIXI trips (August 2024) as an origin→destination flowmap: station-pair arrows sized by hourly demand, node circles sized by dock traffic. FlowmapLayer.',
    url: '/data/bixi-flowmap/manifest.json',
    type: 'flowmap',
    timeRange: {
      start: 1722470400000, // 2024-08-01 00:00 UTC
      end: 1725148800000,   // 2024-09-01 00:00 UTC
    },
    // 1 h — matches the flow matrix bucket. Cosmetic for this type: the matrix
    // decode (not a time window) drives the animation.
    timeWindow: 3600000,
    targetPlaybackSeconds: 90,
    // Opens on the clustered hub overview (z~11): flowmap.gl-style fat
    // hub-to-hub arrows + node circles. Zoom in to dissolve hubs into
    // per-station corridors (full resolution at the deepest zoom).
    initialViewState: {
      longitude: -73.585,
      latitude: 45.523,
      zoom: 11.2,
      pitch: 35,
      bearing: -10,
    },
    flowSourceColor: [56, 196, 232, 235], // origin — cool cyan
    flowTargetColor: [255, 142, 64, 245], // destination — warm orange
    flowWidthScale: 1.1,
    flowWidthMaxPixels: 14,
    flowGap: 0.5, // A→B and B→A arrows sit side-by-side
    flowNodeRadiusScale: 1.3,
    flowMinFlow: 0.5, // hide corridors with < ~1 trip in the current hour
    opacity: 0.85,
    legend: {
      title: 'BIXI trips per corridor (hourly)',
      items: [
        { color: '#38c4e8', label: 'Origin' },
        { color: '#ff8e40', label: 'Destination' },
      ],
    },
  },
  {
    // Same BIXI OD tiles as `bixi-flowmap`, but rendered with GPU force-directed
    // edge bundling: compatible corridors are relaxed into smooth rivers on the
    // GPU (Holten FDEB, cosmos.gl-style ping-pong float textures) so the overview
    // reads as flowing channels instead of a hairball of crossing arrows. The
    // bundle is computed once per tile and stays resident on the GPU; only ribbon
    // width animates with the hourly demand. Bundling is purely client-side —
    // identical tiles, no separate build.
    id: 'bixi-flowmap-bundled',
    name: 'BIXI Edge Bundling',
    sources: ['bixi'],
    description: 'A month of real Montréal BIXI trips (August 2024), origin→destination flows bundled into rivers by GPU kernel-density edge bundling (KDEEB). Ribbon width follows hourly demand.',
    // Denser build than the unbundled flowmap (min-trips 5, cluster-radius 15) —
    // thousands of corridors per overview tile, to load up the GPU bundler.
    url: '/data/bixi-flowmap-dense/manifest.json',
    type: 'flowmap-bundled',
    timeRange: {
      start: 1722470400000, // 2024-08-01 00:00 UTC
      end: 1725148800000,   // 2024-09-01 00:00 UTC
    },
    timeWindow: 3600000,
    targetPlaybackSeconds: 90,
    initialViewState: {
      longitude: -73.585,
      latitude: 45.523,
      zoom: 11.2,
      pitch: 0,
      bearing: 0,
    },
    flowSourceColor: [56, 196, 232, 220], // origin — cool cyan
    flowTargetColor: [255, 142, 64, 230], // destination — warm orange
    // Thinner, lighter ribbons + subdued small nodes so the denser graph reads
    // as bundles instead of a carpet of ink.
    flowWidthScale: 0.9,
    flowWidthMaxPixels: 9,
    flowGap: 0.5,
    flowNodeRadiusScale: 0.7,
    flowNodeRadiusMaxPixels: 9,
    flowNodeColor: [232, 238, 255, 110],
    flowMinFlow: 0.75,
    // KDEEB tuning — a slightly larger kernel (7% of the tile) bundles the
    // denser graph into fewer, clearer trunk rivers.
    flowSubdivisionPoints: 48,
    flowKernelRadius: 0.07,
    flowBundlingIterations: 16,
    flowSmoothingStrength: 0.5,
    // Dense build: bundle up to ~30k corridors/tile before falling back.
    flowMaxBundledEdges: 30000,
    opacity: 0.7,
    legend: {
      title: 'BIXI trips per corridor (hourly)',
      items: [
        { color: '#38c4e8', label: 'Origin' },
        { color: '#ff8e40', label: 'Destination' },
      ],
    },
  },
  {
    // Same BIXI OD flowmap, but the edge bundling is BAKED into the tiles at
    // build time (`stt-generate bixi --bake-bundling`): each zoom's clustered
    // hub-pair corridors are relaxed by a deterministic CPU KDEEB into smooth
    // multi-vertex rivers and stored as polylines. The client renders the
    // precomputed curve directly (BundledFlowmapLayer `preBundled`) — no GPU
    // edge bundler, no settling animation, no float-blend requirement (works on
    // mobile), and the bundle is stable under pan/zoom. Width still animates from
    // the hourly matrix. The trade vs the live `bixi-flowmap-bundled` demo: the
    // bundle is fixed at build time (no interactive kernel tuning) in exchange
    // for being deterministic, cheaper, and universally supported.
    id: 'bixi-flowmap-baked',
    name: 'BIXI Baked Bundling',
    sources: ['bixi'],
    description: 'A month of real Montréal BIXI trips (August 2024) with edge bundling precomputed at build time: corridors bundled by a deterministic CPU KDEEB pass and stored as polylines, so the client draws the precomputed curves with no GPU bundler. Ribbon width follows hourly demand.',
    url: '/data/bixi-flowmap-baked/manifest.json',
    type: 'flowmap-bundled',
    flowPreBundled: true,
    timeRange: {
      start: 1722470400000, // 2024-08-01 00:00 UTC
      end: 1725148800000,   // 2024-09-01 00:00 UTC
    },
    timeWindow: 3600000,
    targetPlaybackSeconds: 90,
    initialViewState: {
      longitude: -73.585,
      latitude: 45.523,
      zoom: 11.2,
      pitch: 0,
      bearing: 0,
    },
    flowSourceColor: [56, 196, 232, 235], // origin — cool cyan
    flowTargetColor: [255, 142, 64, 245], // destination — warm orange
    flowWidthScale: 1.1,
    // Show the WHOLE network, including the long tail of low-traffic corridors a
    // relaxed `--min-trips` keeps in the tiles: scale width down to a thin
    // hairline (sub-pixel floor) and drop the visibility cutoff toward zero so
    // faint tributaries render instead of being hidden — no thinning, width
    // carries the signal.
    flowWidthMinPixels: 0.6,
    flowWidthMaxPixels: 12,
    flowGap: 0.5,
    // GEOGRAPHIC node circles: radius in metres (per √incident-flow, so circle
    // AREA ∝ flow) — the hub set scales with the map and shrinks when you zoom out
    // instead of blowing out into overlapping dots. The pixel cap is generous (36)
    // so the busiest hubs aren't all flattened to one size: it's the clamp, not
    // the √, that kills variation among the largest — a log scale would compress
    // the top end further and make them MORE alike.
    flowNodeRadiusScale: 60,
    flowNodeRadiusUnits: 'meters',
    flowNodeRadiusMaxPixels: 36,
    flowMinFlow: 0.05, // ~0 → keep low-traffic corridors visible as thin lines
    // P must match the baked control-point count (`--bundle-points`, default 24)
    // so the renderer samples each baked vertex exactly.
    flowSubdivisionPoints: 24,
    opacity: 0.85,
    legend: {
      title: 'BIXI trips per corridor (hourly)',
      items: [
        { color: '#38c4e8', label: 'Origin' },
        { color: '#ff8e40', label: 'Destination' },
      ],
    },
  },
  {
    // ── BIXI street-network heatmap ──
    // The OD-flowmap's pre-aggregated companion: every BIXI trip is routed onto
    // Montréal's actual BICYCLE network (OSRM bicycle profile) and its per-hour
    // ridership baked onto each street/cycleway segment, so the city's bike
    // arteries — the REV, de Maisonneuve, the Lachine Canal path — light up with
    // the hourly commute. Same geometry-once value-matrix encoding as
    // nyc-taxi-flows, rendered by FlowCorridorLayer.
    id: 'bixi-streets',
    name: 'Montréal BIXI — Street Network',
    sources: ['bixi'],
    description: "A month of real BIXI trips routed onto Montréal's bike network and aggregated into hourly street-segment flows. Pre-aggregated overview companion to the BIXI flowmap. Source: BIXI Montréal open data.",
    url: '/data/bixi-streets/manifest.json',
    type: 'trips',
    // August 2024 (same span as the BIXI flowmap). The generator prints the exact
    // matrix start/end — set these to that after the build.
    timeRange: {
      start: 1722470400000, // 2024-08-01 00:00 UTC
      end: 1725148800000,   // 2024-09-01 00:00 UTC
    },
    // One 1-hour aggregation bin per tile bucket; loader auto-widens for the trail.
    timeWindow: 3600000,
    // ~744 hourly bins over the month ⇒ the daily commute rhythm reads clearly.
    targetPlaybackSeconds: 150,
    initialViewState: {
      longitude: -73.578,
      latitude: 45.52,
      zoom: 12,      // streets + cycleways visible (cycleway/tertiary surface ~z11)
      pitch: 30,
      bearing: -12,
    },
    // Heavy-tailed like the taxi flows (measured over the Aug-2024 build:
    // trips/segment/hour p50≈2, p90≈7.5, p97≈15, p99≈26, max≈136). Domain clamps
    // at ~p97 so the busiest cycleway-hours saturate white while quiet streets
    // stay visible; p90 lands mid-ramp on the BIXI green.
    tripGradient: {
      property: 'vertexValues',
      domain: [0, 16], // trips per segment per hour, clamped ~p97
      colors: [
        [30, 50, 120, 165],   // 0–4  — dim indigo (quiet side streets)
        [40, 150, 200, 210],  // ~4   — teal
        [120, 210, 160, 230],  // ~8  — BIXI green (busy cycleways, ~p90)
        [255, 170, 70, 245],  // ~12  — orange (arteries: de Maisonneuve / REV)
        [255, 255, 255, 255], // 16+  — white-hot (the busiest corridor-hours)
      ],
    },
    colorMappingDefault: [70, 80, 90, 120],
    // Static-geometry overview: the bike network is stored ONCE per tile with a
    // per-vertex × per-hour value matrix; FlowCorridorLayer selects the active
    // bucket from the playhead (CPU cross-fade between hours) so geometry never
    // re-fetches as time advances. trailLength 0 keeps every corridor lit.
    flowMatrix: true,
    trailLength: 0,
    widthMinPixels: 1.5,
    widthMaxPixels: 4,
    capRounded: false,
    jointRounded: false,
    legend: {
      title: 'BIXI trips per street segment / hour',
      ramps: [
        {
          label: '0 → 16+',
          colors: ['#1E3278', '#2896C8', '#78D2A0', '#FFAA46', '#FFFFFF'],
        },
      ],
    },
  },
  {
    // The street-network heatmap with DIRECTION added: same routed-and-baked
    // per-hour ridership, but the build (`bixi --streets --directional`) also
    // tracks each edge's net travel direction and PRE-ORIENTS every corridor's
    // geometry toward its month-dominant flow. FlowCorridorLayer + a
    // ChevronFlowExtension then slide arrowhead chevrons along each segment the
    // way riders actually go, so you read the tidal commute — cores fill in the
    // morning, empty at night — as motion, not just brightness.
    id: 'bixi-streets-flow',
    name: 'Montréal BIXI — Directional Flow',
    sources: ['bixi'],
    description: 'The BIXI street network with direction: each segment carries its dominant travel direction, drawn as marching chevrons; brightness follows hourly demand. Source: BIXI Montréal open data.',
    url: '/data/bixi-streets-flow/manifest.json',
    type: 'trips',
    // Same span as bixi-streets. The directional generator prints the exact
    // matrix start/end — set these to that after the build.
    timeRange: {
      start: 1722470400000, // 2024-08-01 00:00 UTC
      end: 1725148800000,   // 2024-09-01 00:00 UTC
    },
    timeWindow: 3600000,
    targetPlaybackSeconds: 150,
    initialViewState: {
      longitude: -73.578,
      latitude: 45.52,
      zoom: 12.5, // a touch closer so the chevrons read
      pitch: 30,
      bearing: -12,
    },
    // Magnitude still drives colour (same measured domain as bixi-streets); the
    // chevrons carry direction on top.
    tripGradient: {
      property: 'vertexValues',
      domain: [0, 16],
      colors: [
        [30, 50, 120, 0],
        [40, 150, 200, 210],
        [120, 210, 160, 230],
        [255, 170, 70, 245],
        [255, 255, 255, 255],
      ],
    },
    colorMappingDefault: [70, 80, 90, 120],
    flowMatrix: true,
    // Directional overlay: pre-oriented corridors + marching chevrons. Tunables
    // are conservative defaults — easy to retune in-browser without a rebuild.
    flowDirectional: true,
    chevronPeriod: 5,
    chevronSpeed: 0.0006,
    chevronSkew: 1.5,
    chevronDuty: 0.45,
    chevronBaseAlpha: 0.18,
    trailLength: 0,
    // A hair wider than bixi-streets so the arrowheads are legible.
    widthMinPixels: 2,
    widthMaxPixels: 5,
    capRounded: false,
    jointRounded: false,
    legend: {
      title: 'BIXI trips per segment / hour · chevrons = flow direction',
      ramps: [
        {
          label: '0 → 16+',
          colors: ['#1E3278', '#2896C8', '#78D2A0', '#FFAA46', '#FFFFFF'],
        },
      ],
    },
  },
  {
    // A coherent, Sankey-like FLOW NETWORK (Edge-Path Bundling, no streets):
    // stations cluster into hubs connected by a Delaunay proximity graph, and
    // every OD flow is routed along the graph's shortest path (cost = length^k),
    // so flows heading the same way collapse onto SHARED TRUNK LINES that swell
    // where tributaries join and taper where they leave — little lines entering
    // and leaving one big line. Width breathes with the active hour; the two
    // directions draw as twin offset ribbons (inbound vs outbound rush). The
    // coherent alternative to the abstract smear of force-directed bundling.
    id: 'bixi-corridors',
    name: 'Montréal BIXI — Flow Network',
    sources: ['bixi'],
    description: 'A month of real BIXI trips (August 2024) bundled into a Sankey-like flow network: origin→destination lines merge onto shared trunk lines that thicken where flows join and thin where they leave. Playback scrubs August 2024 hour by hour. Source: BIXI Montréal open data.',
    url: '/data/bixi-corridors/manifest.json',
    type: 'trips',
    // The WHOLE month at hourly resolution (744 buckets). The flow network is
    // compact (~500 trunks), so even at 744 buckets the biggest overview tile is
    // ~14 MB uncompressed — well within the worker's decode budget.
    timeRange: {
      start: 1722470400000, // 2024-08-01 00:00 UTC
      end: 1725148800000,   // 2024-09-01 00:00 UTC
    },
    timeWindow: 3600000,
    targetPlaybackSeconds: 150,
    // City overview: the volume LOD keeps only the heavy trunk lines here, so the
    // flow network reads cleanly before zooming into neighbourhood detail.
    initialViewState: {
      longitude: -73.578,
      latitude: 45.523,
      zoom: 11.5,
      pitch: 35,
      bearing: -12,
    },
    // Width AND colour carry the active-hour traveller count (PER VERTEX, so each
    // curved trunk tapers along its length AND breathes with the hour). Whole-month
    // hourly counts, so values are per single hour — domain tuned from the measured
    // distribution (busiest-hour count per trunk: p90≈47, p95≈76, p97≈96, max≈155)
    // so green lands mid-network and the busiest trunk-hours saturate white.
    tripGradient: {
      property: 'vertexValues',
      domain: [0, 90], // active single-hour travellers on a trunk
      colors: [
        [30, 50, 120, 180],   // quiet
        [40, 150, 200, 215],  // teal
        [120, 210, 160, 235], // BIXI green
        [255, 170, 70, 248],  // arterial orange
        [255, 255, 255, 255], // busiest trunk-hours
      ],
    },
    colorMappingDefault: [70, 80, 90, 120],
    // FlowStrokeLayer: trunk geometry loads once; colour animates by active bucket
    // AND per-vertex width breathes with the hour + tapers along the trunk. Twin
    // offset ribbons (baked) split the two directions. trailLength 0 keeps trunks lit.
    flowStroke: true,
    // SPATIAL widths: trunk thickness is in METRES, so ribbons are anchored to the
    // ground and thicken/thin as you zoom (like the map itself), clamped to a
    // pixel range so they stay legible at the overview and bounded up close.
    widthUnits: 'meters',
    flowWidthScale: 1,     // metres per √(active single-hour travellers); √155≈12 ⇒ ~680 m
    flowWidthExponent: 0.5, // √ → area-proportional
    flowMinFlow: 1,         // near-empty hours collapse to invisible (the pulse)
    // Twin-ribbon separation is BAKED into the geometry at build time
    // (--ribbon-offset), so no render-time PathStyleExtension (0 disables it and
    // keeps the sublayer on the proven FlowCorridorLayer shader layout).
    flowOffsetWidths: 0,
    trailLength: 0,
    widthMinPixels: 1.5,    // quiet trunks stay visible at the overview
    widthMaxPixels: 30,     // bold but bounded when zoomed in
    capRounded: true,
    jointRounded: true,
    legend: {
      title: 'BIXI trunk width & colour = travellers / hour',
      ramps: [
        {
          label: '0 → 90+',
          colors: ['#1E3278', '#2896C8', '#78D2A0', '#FFAA46', '#FFFFFF'],
        },
      ],
    },
  },
  {
    id: 'bixi-points',
    name: 'Montréal BIXI — Moving Bikes',
    sources: ['bixi'],
    description: 'Every BIXI ride as a dot moving along the real bike network — one dot per active trip, routed through OSRM and timed to its ride window. BIXI counterpart of the NYC taxi head-dots. Source: BIXI Montréal open data + OpenStreetMap (via OSRM).',
    // Same OSRM-routed per-trip path archive as a `type: 'trips'` ribbons demo
    // would use — rendered here as moving head-dots (AnimatedTripHeadsLayer:
    // stock ScatterplotLayer + CPU per-frame head interpolation). One build,
    // no separate points dataset, exactly like nyc-taxi-points.
    url: '/data/bixi-points/manifest.json',
    type: 'trip-heads',
    // Real archive span from the `bixi --paths` build: Thu 2024-08-15,
    // 49,974 OSRM-routed rides (all with per-vertex timing). End runs past
    // midnight UTC to the last ride's dropoff.
    timeRange: {
      start: 1723680000000, // 2024-08-15 00:00:00 UTC
      end: 1723773613449,   // 2024-08-16 02:00:13 UTC (last dropoff)
    },
    timeWindow: 20000,
    // A day of rides in ~10 min so individual bike heads stay readable as they
    // thread the cycleways (BIXI trips are slower and denser than cabs).
    targetPlaybackSeconds: 600,
    initialViewState: {
      longitude: -73.578,
      latitude: 45.518,
      zoom: 14,
      pitch: 45,
      bearing: -12,
    },
    legend: {
      title: 'BIXI',
      items: [{ color: '#E63946', label: 'Active ride' }],
    },
    // World-space head dots (meters): a 25 m head reads ~3.5 px at the zoom-14
    // view and emerges/shrinks on zoom with no pixel floor (radiusMinPixels: 0);
    // radiusMaxPixels caps a docked bike from ballooning at deep zoom.
    headColor: [230, 57, 70, 255],
    headSizeUnits: 'meters',
    headRadius: 25,      // metres
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 8,
  },
  {
    id: 'bixi-live',
    name: 'Montréal BIXI — Flow & Riders',
    sources: ['bixi'],
    description: 'Two layers on one clock: directional street-network flow underneath (chevrons, brightness by hourly demand) and every ride as a moving dot on its real route on top. Source: BIXI Montréal open data + OSM (via OSRM).',
    // COMPOSITE: primary = a directional flow-corridor archive built just for this
    // demo (bixi-live-flow: Aug 15, 25.6k corridors) as a DECORATIVE aggregate base
    // (static chevrons pulsing colour with volume); overlay = the per-trip OSRM
    // paths as moving heads (bixi-points) — the live per-trip motion. Both cover
    // the same single day. Built at 5-MINUTE buckets: finer would over-resolve the
    // colour pulse AND blow the browser worker's ArrayBuffer on the dense downtown
    // z13 tile (the per-vertex×bucket matrix decodes DENSE — 1-min = ~5 GB total,
    // 5-min ≈ 1 GB, 10-min ≈ 0.5 GB). Rebuild: stt-generate bixi --input
    // <bixi-2024.csv> --from 2024-08-15 --to 2024-08-16 --min-trips 1 --streets
    // --directional --per-bucket-direction --osm-pbf <quebec.osm.pbf> --bin 5m.
    url: '/data/bixi-live-flow/manifest.json',
    type: 'trips',
    headsOverlayUrl: '/data/bixi-points/manifest.json',
    // Aug 15 2024 — the single day both archives cover.
    timeRange: {
      start: 1723680000000, // 2024-08-15 00:00:00 UTC
      end: 1723766400000,   // 2024-08-16 00:00:00 UTC (clean 24 h; corridors lit throughout)
    },
    // 1h window comfortably covers the current 10-min flow bucket AND the current
    // tile of active rides for both layers (heads filter trips by the playhead).
    timeWindow: 3600000,
    targetPlaybackSeconds: 600, // the day plays in ~10 min (matches bixi-points)
    initialViewState: {
      longitude: -73.578,
      latitude: 45.52,
      zoom: 13, // wide enough to read the corridors, close enough to see riders
      pitch: 35,
      bearing: -12,
    },
    // Darkest-possible backdrop: hide every place/road label and sink the land
    // to near-black, leaving faint streets + water as context so the flow
    // corridors and moving riders own the frame. The street network is pulled
    // down to a dark blue-grey (just above the land) so it reads as quiet
    // context rather than dark-v11's brighter default grey.
    basemapHideLabels: true,
    basemapBackgroundColor: '#02040a',
    basemapRoadColor: '#0a0d14',
    // ── DECORATIVE corridor base: the aggregate network, styled. Volume drives
    //    OPACITY (quiet → transparent, busy → solid) via the ramp's alpha stops,
    //    so busy roads read brighter; the arrowheads take the cardinal DIRECTION
    //    hue. The live per-trip motion is carried by the moving-point overlay
    //    (bixi-points), NOT by flashing these arrows. ──
    tripGradient: {
      property: 'vertexValues',
      // 10-min bucket volume: below bixi-streets-flow's [0,16]. Lower the top to
      // brighten the network; raise it to keep only the busiest corridors lit.
      domain: [0, 4],
      colors: [
        [255, 230, 255, 20],  // white, low
        [255, 218, 255, 20],  // glowing pale pink
        [203, 132, 232, 20],  // pink-lilac
        [143, 92, 213, 40],   // lavender purple
        [91, 63, 166, 160],   // saturated purple
        [58, 43, 124, 200],   // deep violet, high
      ],
    },
    colorMappingDefault: [52, 46, 74, 120], // dim violet-grey for no-data segments
    flowMatrix: true,
    flowDirectional: true,
    // The flow archive is SIGNED (--per-bucket-direction), so the layer colours by
    // |value| (volume). Kept for the geometry pre-orientation (arrows point the
    // day-dominant direction) — but see chevronPerBucketDirection below.
    flowSignedDirection: true,
    chevronPeriod: 8,
    chevronSpeed: 0, // STATIC — no marching
    // Static, even arrows: fit a whole number of chevrons per street segment so
    // they land ~chevronPeriod apart and never truncate at a bend/intersection.
    chevronUniformSpacing: true,
    // STATIC CHEVRONS: no per-vertex direction morph/flip (the arrows don't move
    // or change over time). They point the pre-oriented (day-dominant) winding and
    // just pulse COLOUR with the volume matrix. This decouples from flowSignedDirection
    // so the layer still colours by |value| while the chevrons stay put.
    chevronPerBucketDirection: false,
    // Not per-trip: the corridor is a calm DECORATIVE base showing aggregate
    // volume; live per-trip motion is the moving-point overlay (bixi-points).
    chevronPerTripLight: false,
    chevronSkew: 1.5,
    chevronDuty: 0.45,
    // DE-EMPHASIZED: a higher track alpha shows the road NETWORK as the decoration
    // and keeps the arrowheads only slightly brighter, so the chevrons read as a
    // subtle directional texture rather than the focal point.
    chevronBaseAlpha: 0.5,
    trailLength: 0,
    widthMinPixels: 2,
    widthMaxPixels: 4,
    capRounded: false,
    jointRounded: false,
    // ── Moving riders: luminous BIXI green — the complementary accent that pops
    //    against the purple corridors. Min 2 px so a bike is always a visible dot
    //    at the z13 overview (world-space otherwise, so it still grows on zoom-in). ──
    headColor: [58, 220, 120, 255], // #3ADC78 BIXI green
    headSizeUnits: 'meters',
    headRadius: 6,      // metres
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 4,
    legend: {
      title: 'Corridor brightness = trips/segment/hour · chevrons = direction',
      ramps: [
        {
          label: '0 → 16+',
          colors: ['#3A2A6E', '#7052B2', '#9F7CE2', '#CAB6F6', '#F4EEFF'],
        },
      ],
      items: [{ color: '#3ADC78', label: 'Individual ride' }],
    },
  },
  {
    id: 'gtfs-nl',
    name: 'Netherlands — National Transit Ballet',
    sources: ['ovapi'],
    description: 'Every scheduled public-transport vehicle in the Netherlands for one Friday — 121,031 train, bus, tram, metro and ferry journeys expanded from the national CC0 GTFS timetable and positioned along their route geometry. Source: OVapi / NDOV national GTFS (CC0).',
    // Rebuild: stt-generate gtfs --feed data/gtfs-nl/feed --date 20260703
    //   --output examples/showcase/public/data/gtfs-nl
    // (feed refreshes daily at gtfs.ovapi.nl/nl/gtfs-nl.zip; a stale --date
    // simply matches fewer services, so re-download + re-date together.)
    url: '/data/gtfs-nl/manifest.json',
    type: 'trip-heads',
    // Real archive span: Fri 2026-07-03 service day (Europe/Amsterdam). Starts
    // at the first scheduled departure (00:19 local); GTFS >24:00:00 times run
    // the night network deep into Saturday morning (last arrival ~10:23 local).
    timeRange: {
      start: 1783030740000, // 2026-07-02 22:19:00 UTC = Fri 00:19 local
      end: 1783153380000,   // 2026-07-04 08:23:00 UTC = Sat 10:23 local
    },
    timeWindow: 20000,
    // ~34 h span in ~13 min — the core service day passes in about nine
    // minutes, matching the bixi-points pace per hour of data.
    targetPlaybackSeconds: 780,
    initialViewState: {
      longitude: 5.29,
      latitude: 52.13,
      zoom: 7.3, // whole country in frame; zoom in and the dots ride their routes
      pitch: 0,
      bearing: 0,
    },
    // Darkest backdrop so thousands of 2 px vehicles read as a living network.
    basemapHideLabels: true,
    basemapBackgroundColor: '#02040a',
    legend: {
      title: 'Dutch public transport — one Friday',
      items: [{ color: '#FFC71F', label: 'Scheduled vehicle' }],
    },
    // Pixel-sized heads: at the z7 national view a metric radius would vanish;
    // 2 px keeps rush hour readable as individual vehicles, not a blob.
    headColor: [255, 199, 31, 255], // #FFC71F — NS-yellow on near-black
    headRadiusPixels: 2,
  },
  {
    id: 'nwm-rivers-2019',
    name: 'US Rivers — A Year of Flow',
    sources: ['noaa', 'usgs'],
    description: 'The continental river network over the 2019 flood year — NOAA National Water Model hourly discharge reduced to daily means on every NHDPlus reach of stream order 4+. Brightness is absolute flow on a log scale. Source: NOAA NWM v3.0 retrospective + USGS NHDPlusV2 (both public domain).',
    // Rebuild: stt-generate nwm --window 2019 --bin 1d --value log-q
    //   --output examples/showcase/public/data/nwm-rivers-2019
    // (zarr chunks + reduced stripes cache under data/nwm/; resumable.)
    url: '/data/nwm-rivers-2019/manifest.json',
    type: 'trips',
    // Clean UTC year boundaries — matrix bucket 0 starts 2019-01-01.
    timeRange: {
      start: 1546300800000, // 2019-01-01 00:00 UTC
      end: 1577836800000,   // 2020-01-01 00:00 UTC
    },
    // One daily aggregation bin per matrix bucket.
    timeWindow: 86400000,
    // 365 daily bins in ~2 min: spring melt and the March/May flood crests roll
    // down the network at a pace the eye can follow.
    targetPlaybackSeconds: 120,
    initialViewState: {
      longitude: -96,
      latitude: 38.5,
      zoom: 4.3, // CONUS in frame; zoom bands add order-4 detail through z8
      pitch: 0,
      bearing: 0,
    },
    basemapHideLabels: true,
    basemapBackgroundColor: '#02040a',
    // Values are log10(m³/s) baked at generate time (matrix is linear-ramped).
    // domain [0,5] = 1 → 100,000 m³/s; sub-1 flows clamp into the dim end.
    tripGradient: {
      property: 'vertexValues',
      domain: [0, 5],
      colors: [
        [22, 42, 92, 90],     // ~1 m³/s — creeks, barely-there indigo
        [32, 96, 168, 150],   // ~30 m³/s — small rivers
        [56, 160, 216, 200],  // ~1,000 m³/s — majors
        [150, 222, 242, 235], // ~30,000 m³/s — great rivers
        [255, 255, 255, 255], // 100,000 m³/s — Mississippi in flood
      ],
    },
    // NaN buckets (model fill / intermittent reaches) — faint slate "dry" bed.
    colorMappingDefault: [45, 55, 70, 80],
    flowMatrix: true,
    trailLength: 0,
    // Static per-feature width baked from Strahler order (constant per merged
    // mainstem run); pixel clamps keep creeks hairline and mainstems bold.
    tripWidth: 'width',
    widthMinPixels: .2,
    widthMaxPixels: 1.5,
    capRounded: false,
    jointRounded: false,
    legend: {
      title: 'Daily mean discharge (log scale)',
      ramps: [
        {
          label: '1 → 100,000 m³/s',
          colors: ['#162A5C', '#2060A8', '#38A0D8', '#96DEF2', '#FFFFFF'],
        },
      ],
    },
  },
  {
    id: 'nwm-rivers-flood-2019-03',
    name: 'US Rivers — March 2019 Flood Wave',
    sources: ['noaa', 'usgs'],
    description: 'The March 2019 bomb-cyclone flood, hour by hour: each river reach colored by how far above its own 2019 median it is running, so flooding tributaries read as brightly as the mainstems they feed. Source: NOAA NWM v3.0 retrospective + USGS NHDPlusV2 (both public domain).',
    // Rebuild: stt-generate nwm --window 2019-03 --bin 1h --value log-anomaly
    //   --output examples/showcase/public/data/nwm-rivers-flood-2019-03
    // (anomaly medians come from the 2019 daily reduce — run the year demo first.)
    url: '/data/nwm-rivers-flood-2019-03/manifest.json',
    type: 'trips',
    // Clean UTC month boundaries — hourly matrix over March 2019.
    timeRange: {
      start: 1551398400000, // 2019-03-01 00:00 UTC
      end: 1554076800000,   // 2019-04-01 00:00 UTC
    },
    // One hourly bin per matrix bucket.
    timeWindow: 3600000,
    // 744 hourly bins in ~3 min — slow enough to see the flood front move.
    targetPlaybackSeconds: 180,
    initialViewState: {
      longitude: -96,
      latitude: 40.5,
      zoom: 4.8, // opens on the Missouri basin where the flood breaks
      pitch: 0,
      bearing: 0,
    },
    basemapHideLabels: true,
    basemapBackgroundColor: '#02040a',
    // Values are log2(q / 2019 median) clamped to [0,6] at generate time:
    // 0 = normal flow, 6 = running 64× its median. Cool → alarm ramp.
    tripGradient: {
      property: 'vertexValues',
      domain: [0, 6],
      colors: [
        [40, 56, 96, 70],     // ≤1× median — network at rest, dim blue
        [40, 130, 160, 140],  // ~2× — elevated
        [235, 215, 90, 215],  // ~8× — high water
        [255, 140, 50, 245],  // ~24× — flood
        [255, 255, 255, 255], // 64×+ — extreme crest
      ],
    },
    // NaN = intermittent reaches with ~zero median (anomaly undefined) — keep
    // them as the faint resting network rather than an error color.
    colorMappingDefault: [40, 50, 66, 70],
    flowMatrix: true,
    trailLength: 0,
    tripWidth: 'width',
    widthMinPixels: 1,
    widthMaxPixels: 5,
    capRounded: false,
    jointRounded: false,
    legend: {
      title: 'Flow vs 2019 median (log scale)',
      ramps: [
        {
          label: '1× → 64×+',
          colors: ['#283860', '#2882A0', '#EBD75A', '#FF8C32', '#FFFFFF'],
        },
      ],
    },
  },
  {
    id: 'flights',
    name: 'Flight Traffic',
    sources: ['opensky'],
    description: 'Aircraft positions over 24 hours. Source: OpenSky.',
    url: '/data/flights/manifest.json',
    type: 'point',
    timeRange: {
      start: 1578268800000,  // 2020-01-06 00:00 UTC
      end: 1578355190000,    // 2020-01-06 23:59 UTC
    },
    // Comet-wake aesthetic, mirrored from ship-traffic: every position ping
    // behind the play head fades and shrinks into a trail behind each
    // aircraft. Aircraft move ~25× faster than vessels (~900 km/h vs ~20 kn),
    // so a 5-min wake already paints a long contrail (~75 km), where ships
    // need an hour. timeWindow is 2× wakeLength so the tile loader covers the
    // past half of the wake (the shader filter is independent of the loader
    // window — see TimeFilterExtension.wakeLength docstring).
    wakeLength: 300000,     // 5-minute contrail behind each aircraft
    wakeTailScale: 0.15,    // tail shrinks to 15% of head radius
    timeWindow: 600000,     // 10-min loader window → 5-min past coverage
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -98.5,
      latitude: 39.8,
      zoom: 4,
      pitch: 45,
      bearing: 0
    },
    legend: {
      title: "Aircraft",
      items: [
        { color: "#4FC3F7", label: "In Flight" },
      ]
    },
    use3D: true,
    elevationProperty: 'altitude', // Altitude stored in properties (feet)
    elevationScale: 0.3048, // Convert feet to meters
    // World-space dots, mirrored from ship-traffic: `radius` is in METERS, so
    // aircraft scale with zoom like real objects. No pixel floor
    // (radiusMinPixels: 0) → dots fall sub-pixel at the zoom-4 national view
    // and only emerge as you zoom in — the deliberate "render by space"
    // tradeoff. radiusMaxPixels: 80 caps overdraw at deep zoom. The comet wake
    // (alpha fade + size taper) is dimensionless and unaffected.
    radiusUnits: 'meters',
    radius: 500,
    radiusScale: 1,
    radiusMinPixels: 0,
    radiusMaxPixels: 80,
  },
  {
    id: 'flight-paths',
    name: 'Flight Paths',
    description: 'Synthetic flight tracks',
    url: '/data/lines-v2/manifest.json',
    type: 'path',
    timeRange: {
      start: 1600000000000,
      end: 1726272000000,
    },
    timeWindow: 86400000 * 30,
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: 0,
      latitude: 20,
      zoom: 1,
      pitch: 0,
      bearing: 0,
    },
    legend: {
      title: "Flight Paths",
      items: [
        { color: "#4FC3F7", label: "Active Flight" },
      ]
    },
    use3D: true,
    elevationScale: 1, // Altitude already in meters (scaled during processing)
  },
  {
    id: 'flight-trips',
    name: 'Flight Trips',
    description: 'Animated 3-D flight trajectories. Source: OpenSky.',
    url: '/data/adsb-paths/manifest.json',
    type: 'trips',
    timeRange: {
      start: 1578268800000,  // 2020-01-06 00:00:00 UTC
      end: 1578354650000,    // 2020-01-06 23:50:50 UTC
    },
    timeWindow: 3600000, // 1 hour window for trips
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -98.5,
      latitude: 39.8,
      zoom: 4,
      pitch: 60,
      bearing: 0
    },
    legend: {
      title: "Flight Trips",
      items: [
        { color: "#FD805D", label: "Active Flight" },
      ]
    },
    use3D: true,
    elevationScale: 1, // Altitude already in meters (scaled during processing)
    tripColor: [31, 186, 214, 255],
    tripWidth: 4,
    widthMinPixels: 2,
    widthMaxPixels: 8,
    trailLength: 120000,
  },
  {
    id: 'hurricanes',
    name: 'Hurricane Tracks',
    sources: ['noaa'],
    description: 'Atlantic-basin storms, 2020–2023. Source: IBTrACS.',
    url: '/data/hurricanes/manifest.json',
    type: 'point',
    timeRange: {
      start: Date.parse('2020-05-16T18:00:00.000Z'),
      end: Date.parse('2023-11-17T21:00:00.000Z'),
    },
    timeWindow: 86400000 * 14, // 2 week window for multi-year hurricane data
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -65,
      latitude: 25,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
  },
  {
    id: 'nyc-rideshare',
    name: 'NYC Yellow Taxi',
    description: 'NYC TLC taxi pickups and dropoffs — 1M points (Jan 1, 2015, first 2.8h)',
    url: '/data/nyc-rideshare/manifest.json',
    type: 'point',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC (first chronological trip)
      end:   1420080391000,  // 2015-01-01 02:46:31 UTC (50K-trip cap)
    },
    // Comet-wake aesthetic, mirrored from ship-traffic: each cab leaves a
    // fading, shrinking trail of its recent positions. A 60s wake spans ~4
    // of the 15s position samples — long enough to read as a street-tracing
    // comet at the zoom-12 view, short enough not to smear into the trips-ribbon
    // look. timeWindow is 2× wakeLength so the loader covers the past half of
    // the wake (the shader filter is independent of the loader window).
    wakeLength: 60000,      // 60s comet trail behind each cab
    wakeTailScale: 0.15,    // tail shrinks to 15% of head radius
    timeWindow: 120000,     // 2-min loader window → 60s past coverage
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 12,
      pitch: 45,
      bearing: 0
    },
    legend: {
      title: "Trip Status",
      items: [
        { color: "#4CAF50", label: "Pickup" },
        { color: "#2196F3", label: "En Route" },
        { color: "#FF5722", label: "Dropoff" }
      ]
    },
    // World-space dots, mirrored from ship-traffic: `radius` is in METERS so
    // cabs scale with zoom like real objects. No pixel floor
    // (radiusMinPixels: 0) → at the zoom-12 view a 60 m dot reads ~2 px and
    // emerges/shrinks as you zoom in/out — the "render by space" tradeoff.
    // radiusMaxPixels: 8 caps a stopped cab from ballooning at deep zoom. The
    // comet wake (alpha fade + size taper) is dimensionless and unaffected.
    radiusUnits: 'meters',
    radius: 60,
    radiusScale: 1,
    radiusMinPixels: 0,
    radiusMaxPixels: 8,
  },
  {
    id: 'nyc-taxi-od-heatmap',
    name: 'NYC Pickups vs Dropoffs',
    description: 'Density heatmap of NYC taxi pickups (green) vs dropoffs (red), Jan 1, 2015',
    url: '/data/nyc-rideshare/manifest.json',
    type: 'heatmap',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC
      end:   1420080391000,  // 2015-01-01 02:46:31 UTC
    },
    // 30 min window — wide enough that point density forms readable heat
    // (both pickup-green and dropoff-red halos visible side-by-side), narrow
    // enough that ~5-minute time slices still animate visibly over the
    // 2.8-hour range.
    timeWindow: 60000 * 30,
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 12,
      pitch: 0,
      bearing: 0,
    },
    // Stacked heatmaps — both classes pack into ONE RGBA accumulator
    // channel (R = pickups, G = dropoffs) and composite via per-class
    // screen-blending so overlapping hot zones never go muddy. The
    // HeatmapLayer compiles these two specs into channels and runs ONE
    // splat pass total. Per-class `colorDomain` pins the intensity ramp;
    // every doubling of `radiusPixels` is ~4x more fragment-shader work in
    // the gaussian splat pass.
    heatmapLayers: [
      {
        id: 'pickups',
        radiusPixels: 24,
        intensity: 1.2,
        categoryFilter: { property: 'status', values: ['pickup'] },
        colorRange: [
          [16, 64, 32, 0],
          [22, 122, 60, 70],
          [38, 174, 88, 110],
          [76, 218, 122, 140],
          [144, 240, 168, 160],
          [218, 252, 218, 175],
        ],
      },
      {
        id: 'dropoffs',
        radiusPixels: 24,
        intensity: 1.2,
        categoryFilter: { property: 'status', values: ['dropoff'] },
        colorRange: [
          [64, 16, 16, 0],
          [148, 38, 38, 70],
          [216, 84, 50, 110],
          [248, 142, 64, 140],
          [252, 198, 120, 160],
          [255, 240, 210, 175],
        ],
      },
    ],
    legend: {
      title: 'Pickup vs Dropoff Density',
      ramps: [
        { label: 'Pickups',  colors: ['#0d3a1f', '#26ae58', '#90f0a8', '#dafcda'] },
        { label: 'Dropoffs', colors: ['#3a0d0d', '#d85432', '#fcc678', '#fff0d2'] },
      ],
    },
  },
  {
    id: 'nyc-taxi-points',
    name: 'NYC Taxi Points (Animated)',
    sources: ['tlc'],
    description:
      'Animated NYC taxi vehicle positions across Manhattan. Source: NYC TLC.',
    // Smooth moving head-dot on the FULL trip archive (same source as the trips
    // demo) — one interpolated dot per active trip, no separate derived points
    // file. Rendered by AnimatedTripHeadsLayer (stock ScatterplotLayer + CPU
    // per-frame head interpolation).
    url: '/data/nyc-taxi-paths/manifest.json',
    type: 'trip-heads',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC
      end: 1420213385000,    // 2015-01-02 13:43:05 UTC
    },
    timeWindow: 20000,
    // Slower than the 1-min default so individual cab heads stay readable.
    targetPlaybackSeconds: 1800,
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 14,
      pitch: 45,
      bearing: -15,
    },
    legend: {
      title: 'Taxis',
      items: [{ color: '#FD805D', label: 'Active Trip' }],
    },
    // World-space head dots (meters): a 20 m head reads ~2.8 px at the zoom-14
    // view and emerges/shrinks on zoom with no pixel floor (radiusMinPixels: 0);
    // radiusMaxPixels: 8 caps a stopped cab at deep zoom.
    headColor: [253, 128, 93, 255],
    headSizeUnits: 'meters',
    headRadius: 20,      // metres
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 8,
  },
  {
    id: 'nyc-taxi-paths',
    name: 'NYC Taxi Paths',
    description: 'NYC taxi trip paths — 500K trips (Jan 1-2, 2015)',
    url: '/data/nyc-taxi-paths/manifest.json',
    type: 'path',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC
      end: 1420213385000,    // 2015-01-02 13:43:05 UTC
    },
    timeWindow: 60000, // 1 min window for 1.5 day dataset
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 14,  // Higher zoom = fewer tiles loaded
      pitch: 45,
      bearing: -15
    },
    legend: {
      title: "Taxi Trips",
      items: [
        { color: "#FFD700", label: "Active Trip" },
      ]
    },
    // Match nyc-taxi-trips: rounded caps/joints are the dominant fragment cost
    // on dense Manhattan paths and the rounding is invisible at 2–8 px widths.
    capRounded: false,
    jointRounded: false,
  },
  {
    // ── Pre-aggregated overview companion to the per-trip taxi demos ──
    // Built by `stt-generate nyc-rideshare --flows`: the same 500K routed
    // trips, but aggregated build-side into one feature per (road corridor,
    // 15-min bin). Per-vertex `vertex_values` carry the traversal count, so
    // the gradient shades each street by how many cabs rolled over it that
    // bin — the whole network pulses once per bin as new counts light up and
    // the previous bin's trail fades.
    id: 'nyc-taxi-flows',
    name: 'NYC Taxi Flow',
    sources: ['tlc'],
    description: '500K NYC taxi trips aggregated into 15-minute road-segment flows. Pre-aggregated overview companion to the per-trip paths demos. Source: NYC TLC.',
    url: '/data/nyc-taxi-flows/manifest.json',
    type: 'trips',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC
      end: 1420213500000,    // 2015-01-02 13:45:00 UTC — last 15-min bin end
    },
    // One 15-min aggregation bin per tile bucket; the loader auto-widens to
    // cover the trail.
    timeWindow: 900000,
    // ~148 bins over the range ⇒ one pulse every ~2s at 1×.
    targetPlaybackSeconds: 300,
    initialViewState: {
      longitude: -73.97,
      latitude: 40.75,
      zoom: 11.5,   // overview framing — the whole grid, not single blocks
      pitch: 30,
      bearing: -15,
    },
    // Counts are heavy-tailed (measured: p50≈3, p90≈25, p97≈55, max≈280 per
    // segment per bin); the domain clamps at ~p97 so the top 3% saturates
    // white while side streets stay visible. Dark-indigo → white-hot
    // "city lights", with the warm stops pulled low so the p90 avenues glow.
    tripGradient: {
      property: 'vertexValues',
      domain: [0, 50], // trips per segment per 15 min, clamped ~p97
      colors: [
        [35, 45, 130, 170],   // 0–12 — dim indigo (most side streets)
        [40, 150, 200, 210],  // ~12 — teal
        [250, 200, 80, 235],  // ~25 — amber (p90: busy crosstown streets)
        [255, 150, 60, 245],  // ~37 — orange (arteries)
        [255, 255, 255, 255], // 50+ — white-hot (5th Ave / FDR tier)
      ],
    },
    colorMappingDefault: [70, 70, 90, 120],
    // Static-geometry overview: the street network is stored ONCE per tile and
    // carries a per-vertex × per-15-min-bin value matrix. FlowCorridorLayer
    // animates by selecting the active bucket column from the playhead (with a
    // CPU cross-fade between adjacent bins) — the geometry never re-fetches as
    // time advances. trailLength 0 keeps every corridor fully lit; the matrix,
    // not a trailing fade, carries the pulse.
    flowMatrix: true,
    trailLength: 0,
    widthMinPixels: 1.5,
    widthMaxPixels: 4,
    capRounded: false,
    jointRounded: false,
    legend: {
      title: 'Trips per street segment / 15 min',
      ramps: [
        {
          label: '0 → 50+',
          colors: ['#232D82', '#2896C8', '#FAC850', '#FF963C', '#FFFFFF'],
        },
      ],
    },
  },
  {
    id: 'nyc-flow-and-riders',
    name: 'NYC Taxi — Flow & Riders',
    sources: ['tlc'],
    description: 'Two layers on one clock: the street grid colored by aggregate taxi volume underneath (15-minute corridor flows) and every cab as a moving dot on its real route on top. Source: NYC TLC + OpenStreetMap (via OSRM).',
    // COMPOSITE (mirrors bixi-live "Flow & Riders"): primary = the pre-aggregated
    // flow-corridor archive (nyc-taxi-flows, static geometry + per-vertex × per-
    // 15-min-bin value matrix → FlowCorridorLayer, the DIM base); overlay = the
    // per-trip OSRM paths as moving heads (nyc-taxi-paths → AnimatedTripHeadsLayer,
    // the BRIGHT riders). Both archives cover the same Jan 1–2 2015 window and both
    // standalone demos already play exactly this range, so aggregate flow and
    // individual cabs stay locked to the same instant. Non-directional archive, so
    // no chevrons — just pulsing corridors + streaming dots.
    url: '/data/nyc-taxi-flows/manifest.json',
    type: 'trips',
    headsOverlayUrl: '/data/nyc-taxi-paths/manifest.json',
    timeRange: {
      start: 1420070400000, // 2015-01-01 00:00:00 UTC
      end: 1420213500000,   // 2015-01-02 13:45:00 UTC — last 15-min bin end
    },
    // 1-h window comfortably covers the current 15-min flow bucket AND the tiles of
    // active trips the heads overlay interpolates (heads only draw a dot for trips
    // live at the playhead, so a wide loader window never over-draws them).
    timeWindow: 3600000,
    // ~40 h in ~15 min (≈160× real time): quick enough to feel the pulse, slow
    // enough that individual cab dots stay legible as they cross the grid.
    targetPlaybackSeconds: 900,
    initialViewState: {
      longitude: -73.985,
      latitude: 40.742,
      zoom: 12.3, // between the flows overview (11.5) and the heads close-up (14)
      pitch: 40,
      bearing: -18,
    },
    // Near-black backdrop: hide every place/road label and sink the land to
    // near-black, leaving faint streets + water as quiet context so the flow
    // corridors and moving cabs own the frame (ported from bixi-live).
    basemapHideLabels: true,
    basemapBackgroundColor: '#02040a',
    basemapRoadColor: '#0a0d14',
    // ── Traffic corridors: a COOL indigo→cyan→white ramp (quiet → busy), the cold
    //    complement to the hot-magenta riders so the cabs pop. Same [0,50] domain
    //    (~p97) as nyc-taxi-flows.
    //    IMPORTANT: this is a LUMINANCE ramp at FULL alpha, NOT an alpha ramp.
    //    Corridor geometry is placed per-tile by centroid and never clipped, so a
    //    corridor crossing a tile edge overlaps its neighbour in a band along the
    //    boundary. With semi-transparent colours that overlap STACKS under alpha
    //    blending into a brighter rectangular grid at the tile seams. Full alpha
    //    kills it (same colour over same colour doesn't brighten) while luminance
    //    still tells the dim→bright story: quiet streets sit a hair above the
    //    near-black basemap, arteries glow cyan-white. (Mirrors the standalone
    //    nyc-taxi-flows ramp, which is near-opaque and seam-free.) ──
    tripGradient: {
      property: 'vertexValues',
      domain: [1, 50], // trips per segment per 15 min, clamped ~p97
      colors: [
        [10, 14, 34, 40],    // 0–12 — near-black navy, just above the basemap
        [22, 58, 120, 50],   // ~12 — deep navy blue
        [36, 132, 190, 75],  // ~25 — teal-blue (p90: busy crosstown)
        [110, 205, 235, 100], // ~37 — cyan (arteries)
        [225, 248, 255, 125], // 50+ — cool white-hot (5th Ave / FDR tier)
      ],
    },
    colorMappingDefault: [10, 13, 30, 255], // opaque near-black for no-data segments
    flowMatrix: true,
    trailLength: 0,
    widthMinPixels: 1,
    widthMaxPixels: 3,
    capRounded: false,
    jointRounded: false,
    // ── Moving riders: hot neon MAGENTA — a color that actually pops against the
    //    cool indigo→cyan→white corridors AND the near-black backdrop. Cab-yellow
    //    washed out over the white-hot busy streets — exactly where cabs cluster
    //    most — so it read worst where it mattered most. Magenta sits opposite the
    //    cyan ramp in hue and stays saturated on both the bright arteries and the
    //    dark side streets. World-space (meters) so a dot grows on zoom-in. ──
    headColor: [255, 46, 154, 255], // #FF2E9A neon magenta
    headSizeUnits: 'meters',
    headRadius: 6, // metres
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 6,
    legend: {
      title: 'Corridor brightness = taxi volume / 15 min · dots = live cabs',
      ramps: [
        {
          label: '0 → 50+ trips',
          colors: ['#16204E', '#1A4E8C', '#228CC3', '#5AC8E6', '#E1F8FF'],
        },
      ],
      items: [{ color: '#FF2E9A', label: 'Active cab' }],
    },
  },
  {
    // ── Space-time cube: time = height ──
    // The Hägerstrand classic, on the nyc-rideshare POINT archive: every
    // pickup / en-route sample / dropoff lifts to the altitude of its
    // timestamp, so the 15 s en-route samples stack into dotted threads
    // climbing through the cube (steep = stuck in traffic) while the
    // midnight pickup burst reads as a green stratum at street level.
    // `cumulative` keeps every played-through point resident below the
    // rising now-plane AND routes rendering through the consolidated-slab
    // path (a handful of draw calls at 1M points — the points cube is the
    // perf-cheap sibling of a PathLayer thread cube, which measured 4 fps
    // metro-wide). The tile-lattice overlay draws every loaded STT tile as
    // a wireframe box (spatial footprint × hourly temporal bucket): the
    // tiling system, made visible.
    id: 'nyc-taxi-cube',
    name: 'NYC Taxi Space-Time Cube',
    sources: ['tlc'],
    description: 'Time as height: a million taxi position samples from Jan 1, 2015 stacked into a cube — green pickups, red dropoffs, gold en-route trails. Wireframe boxes are the space-time tiles streaming in. Source: NYC TLC.',
    url: '/data/nyc-rideshare/manifest.json',
    type: 'point',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 — midnight, New Year's Eve peak
      end: 1420080391000,    // 2015-01-01 02:46:31 — same 50K-trip cut as nyc-rideshare
    },
    // Cumulative mode: DemoPage widens the loader window to 2× the range, so
    // the whole night stays resident and the shader does the progressive
    // reveal; fadeInDuration is the "ink appearing" ramp in sim-ms.
    cumulative: true,
    fadeInDuration: 90000,
    timeWindow: 1800000,
    targetPlaybackSeconds: 75,
    initialViewState: {
      longitude: -73.982,
      latitude: 40.748,
      zoom: 11.9,
      pitch: 60,
      bearing: -25,
    },
    colorProperty: 'status',
    colorMapping: {
      pickup: [110, 255, 160, 255],
      en_route: [255, 220, 140, 220],
      dropoff: [255, 105, 85, 255],
    },
    colorMappingDefault: [170, 170, 190, 180],
    // World-space dots with a hard pixel floor: a million points must read
    // as luminous nebula against the dark basemap, and a sub-pixel dot with
    // no floor simply vanishes at the metro framing (measured: radius 22 m /
    // minPixels 0 rendered an apparently empty cube at zoom 11.9).
    radiusUnits: 'meters',
    radius: 50,
    radiusScale: 1,
    radiusMinPixels: 1.6,
    radiusMaxPixels: 6,
    opacity: 1,
    timeHeight: {
      rangeHeightMeters: 8400, // 2.77 h → ~3 km per hour of city time
      initialFactor: 1,
      nowPlane: true,
      tileLattice: true,
      maxPitch: 85,
    },
    legend: {
      title: 'Space-Time Cube (height = time)',
      items: [
        { color: '#50DC78', label: 'Pickup' },
        { color: '#FFC46E', label: 'En route' },
        { color: '#FF5A46', label: 'Dropoff' },
        { color: '#1FBAD6', label: 'STT tile (space × time box)' },
      ],
    },
  },
  {
    id: 'nyc-taxi-trips',
    name: 'NYC Yellow Cab Trips',
    sources: ['tlc'],
    description: 'Animated yellow-cab trip lines across Manhattan. Source: NYC TLC.',
    url: '/data/nyc-taxi-paths/manifest.json',
    type: 'trips',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC
      end: 1420213385000,    // 2015-01-02 13:43:05 UTC
    },
    // Tile-load window: trail is 10s, so 20s comfortably covers the trail plus
    // a margin for tiles arriving slightly ahead of the playhead.
    timeWindow: 20000,
    // Longer than the 1-min default: this ~40h archive blurs past too fast to
    // read individual cabs at 60s, so play it slower (~30 min full range).
    targetPlaybackSeconds: 1800,
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 14,  // Higher zoom = fewer tiles loaded
      pitch: 45,
      bearing: -15
    },
    legend: {
      title: "Taxi Trips",
      items: [
        { color: "#1FBAD6", label: "Active Trip" },
      ]
    },
    // Trail config (AnimatedTripsLayer / PathLayer).
    // World-space width (metres), mirrored from the maritime points' "render by
    // space" look: the ribbon is ~1.4 px at the zoom-14 view and grows/shrinks
    // with zoom (caps at widthMaxPixels) instead of staying a fixed screen
    // width. The trail still alpha-fades toward its tail. Rounded caps/joints
    // off — the dominant fragment cost on dense Manhattan at small widths.
    tripColor: [31, 186, 214, 255],
    trailLength: 12500,
    widthUnits: 'meters',
    tripWidth: 10,          // metres
    widthMinPixels: 0,
    widthMaxPixels: 6,
    fadeTrail: true,
    capRounded: false,
    jointRounded: false,
  },
  {
    id: 'nyc-taxi-heads',
    name: 'NYC Yellow Cabs',
    description: 'Animated yellow-cab positions across Manhattan. Source: NYC TLC.',
    url: '/data/nyc-taxi-paths/manifest.json',
    // Head-dot via AnimatedTripHeadsLayer (vanilla ScatterplotLayer + CPU head
    // interpolation).
    type: 'trip-heads',
    timeRange: {
      start: 1420070400000,
      end: 1420213385000,
    },
    timeWindow: 20000,
    // Match nyc-taxi-trips: 60s is too fast to follow individual cabs.
    targetPlaybackSeconds: 1800,
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 14,
      pitch: 45,
      bearing: -15,
    },
    legend: {
      title: 'Taxis',
      items: [{ color: '#FD805D', label: 'Active Trip' }],
    },
    // World-space head dots (meters), mirrored from the maritime points: a
    // 20 m head reads ~2.8 px at the zoom-14 view and emerges/shrinks on zoom
    // with no pixel floor (radiusMinPixels: 0), matching nyc-taxi-points.
    // radiusMaxPixels: 8 caps a stopped cab at deep zoom.
    headColor: [253, 128, 93, 255],
    headSizeUnits: 'meters',
    headRadius: 20,      // metres
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 8,
  },
  {
    id: 'ship-traffic',
    name: 'US Maritime Traffic',
    sources: ['noaa'],
    description: 'NOAA Marine Cadastre AIS — 15.9K vessels over 24h (Jan 9, 2023)',
    url: '/data/ais-all-us/manifest.json',
    type: 'point',
    timeRange: {
      start: 1673222400000, // 2023-01-09T00:00:00Z (from actual data)
      end: 1673308799000,   // 2023-01-09T23:59:59Z (from actual data)
    },
    // Wake aesthetic: every AIS ping behind the play head fades and shrinks
    // to form a comet trail behind each vessel. `wakeLength` is the trail's
    // temporal span; `timeWindow` is set to 2× that so the tile loader still
    // covers the past half of the wake (the shader filter is independent of
    // the loader window — see TimeFilterExtension.wakeLength docstring).
    wakeLength: 3600000,    // 30-minute wake behind each ship
    wakeTailScale: 0.15,    // tail shrinks to 15% of head radius
    timeWindow: 5600000,    // 60-min loader window → 30-min past coverage
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    // World-space dots: `radius` is in METERS, so vessels scale with zoom like
    // real objects (300 m radius ≈ a large-vessel / berth footprint). No pixel
    // floor (radiusMinPixels: 0), so dots fall sub-pixel at the zoom-4 national
    // view and only emerge as you zoom toward a harbor — the deliberate
    // "render by space" tradeoff. m/px = 156543·cos(lat)/2^zoom, so at lat 30:
    // ~4.5 px @z11, ~9 px @z12, ~18 px @z13. radiusMaxPixels: 80 is a loose cap
    // so a docked vessel can't fill the screen / blow up overdraw at deep zoom.
    // The comet wake (alpha fade + size taper) is dimensionless and unaffected.
    radiusUnits: 'meters',
    radius: 500,
    radiusScale: 1,
    radiusMinPixels: 0,
    radiusMaxPixels: 80,
    initialViewState: {
      longitude: -95,
      latitude: 30,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
    // Color each ping by the tile's `vessel_type` categorical column (emitted
    // by the AIS generator). colorMapping keys are the exact category strings
    // from vessel_type_to_category(); colors mirror the legend below 1:1.
    // `special` has no legend swatch — folded into the gray "Other".
    colorProperty: 'vessel_type',
    colorMapping: {
      cargo:     [74, 144, 226, 255],  // #4A90E2
      tanker:    [245, 166, 35, 255],  // #F5A623
      passenger: [80, 227, 194, 255],  // #50E3C2
      fishing:   [184, 233, 134, 255], // #B8E986
      towing:    [155, 89, 182, 255],  // #9B59B6
      other:     [128, 128, 128, 255], // #808080
      special:   [128, 128, 128, 255], // grouped under "Other"
    },
    colorMappingDefault: [128, 128, 128, 255],
    legend: {
      title: "Vessel Type",
      items: [
        { color: "#4A90E2", label: "Cargo" },
        { color: "#F5A623", label: "Tanker" },
        { color: "#50E3C2", label: "Passenger" },
        { color: "#B8E986", label: "Fishing" },
        { color: "#9B59B6", label: "Towing" },
        { color: "#808080", label: "Other" }
      ]
    },
  },
  {
    id: 'wildfires',
    name: 'US Wildfires',
    description: 'NIFC wildfire perimeters — 1000+ acres (2020-2023)',
    url: '/data/wildfires/manifest.json',
    type: 'polygon',
    timeRange: {
      start: 1590969600000, // 2020-06-01T00:00:00Z
      end: 1702339200000,   // 2023-12-11T00:00:00Z
    },
    timeWindow: 86400000 * 30, // 30 day window for multi-year data
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -115,
      latitude: 40,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
    // Color each perimeter by the tile's `severity` categorical column (emitted
    // by the wildfires generator). colorMapping keys are the exact severity
    // strings; colors mirror the legend below. Opaque fills (alpha 255) avoid
    // the tile-seam double-blend AnimatedPolygonLayer warns about for large,
    // boundary-spanning polygons. `low` (<1K acres) is below the legend floor
    // and rare in this 1000+-acre cut — kept pale rather than dropped.
    colorProperty: 'severity',
    colorMapping: {
      low:          [255, 245, 200, 255],
      moderate:     [255, 237, 160, 255], // #FFEDA0
      high:         [254, 178, 76, 255],  // #FEB24C
      extreme:      [240, 59, 32, 255],   // #F03B20
      catastrophic: [189, 0, 38, 255],    // #BD0026
    },
    colorMappingDefault: [180, 180, 180, 255],
    legend: {
      title: "Fire Severity",
      items: [
        { color: "#FFEDA0", label: "Moderate (1K-10K acres)" },
        { color: "#FEB24C", label: "High (10K-50K acres)" },
        { color: "#F03B20", label: "Extreme (50K-100K acres)" },
        { color: "#BD0026", label: "Catastrophic (100K+ acres)" }
      ]
    },
  },
  {
    id: 'storm-radar',
    name: 'Iowa Derecho — Storm Radar',
    description: 'The 10 August 2020 Midwest derecho: NWS reflectivity contour bands, storm-cell centroids, and cell tracks, baked at build time from NOAA NEXRAD Level II (reprojection, multi-radar mosaic, contouring, and cell tracking done by stt-generate). Source: NOAA NEXRAD.',
    // Primary `url` = the reflectivity FIELD manifest; cells + tracks overlay.
    url: '/data/storm-field/manifest.json',
    radarCellsUrl: '/data/storm-cells/manifest.json',
    radarTracksUrl: '/data/storm-tracks/manifest.json',
    type: 'radar',
    sources: ['noaa'],
    timeRange: {
      start: Date.UTC(2020, 7, 10, 16, 0, 0), // 2020-08-10 16:00Z
      end: Date.UTC(2020, 7, 10, 22, 0, 0),   // 2020-08-10 22:00Z (Omaha→Quad Cities)
    },
    timeWindow: 600000, // 10-min loader window (volume scans ~5 min)
    targetPlaybackSeconds: 75,
    initialViewState: {
      longitude: -93,
      latitude: 42,
      zoom: 6,
      pitch: 35,
      bearing: 10,
    },
    // Reflectivity bands keyed by the generator's `dbz_band` categorical column
    // (the band's lower threshold as a bare integer string — must match
    // verbatim). Green→yellow→red→magenta NWS-style ramp; alpha climbs with
    // intensity so heavy cores read strongest.
    colorProperty: 'dbz_band',
    // Keyed by the generator's `dbz_band` RANGE label ("20-25"…). The range form
    // is deliberately non-numeric so stt-build keeps the column categorical (a
    // bare-integer label would be promoted to a Numeric column, defeating this
    // mapping). OPAQUE fills (alpha 255): the bands stack low→high, so any
    // per-band translucency composites them into one muddy tone — overall
    // translucency must live on the layer `opacity`, not the colors.
    colorMapping: {
      '20-25': [22, 150, 60, 255], // light green
      '25-30': [40, 190, 70, 255],
      '30-35': [70, 220, 90, 255], // green
      '35-40': [180, 220, 50, 255], // yellow-green
      '40-45': [250, 232, 45, 255], // yellow
      '45-50': [250, 190, 35, 255], // amber
      '50-55': [250, 140, 35, 255], // orange
      '55-60': [240, 70, 45, 255], // red
      '60-65': [205, 20, 30, 255], // dark red
    },
    colorMappingDefault: [130, 130, 140, 255],
    // Fully opaque so the nested bands overwrite (high dBZ on top) instead of
    // alpha-blending into a single tone; the storm reads as a solid echo.
    opacity: 1,
    // Storm-cell centroids sized by peak reflectivity.
    radiusProperty: 'max_dbz',
    radiusUnits: 'pixels',
    radiusScale: 1,
    radiusMinPixels: 2,
    radiusMaxPixels: 16,
    radiusTransform: (dbz: number) => Math.max(2, (dbz - 35) * 0.45),
    radarCellColor: [255, 255, 255, 230],
    stroked: true,
    strokeColor: [8, 12, 24, 220],
    lineWidthMinPixels: 1,
    // Cell tracks shaded by per-vertex intensity over time.
    tripGradient: {
      property: 'vertexValues',
      domain: [30, 70], // dBZ
      colors: [
        [40, 180, 80, 230],
        [250, 230, 60, 235],
        [250, 150, 40, 240],
        [240, 40, 40, 245],
      ],
    },
    trailLength: 1800000, // 30-min track trail
    tripWidth: 3,
    widthMinPixels: 1.5,
    widthMaxPixels: 6,
    fadeTrail: true,
    legend: {
      title: 'Reflectivity (dBZ)',
      items: [
        { color: '#1eaf1e', label: '30–40 · rain' },
        { color: '#fae82d', label: '40–45' },
        { color: '#fa8c23', label: '50–55' },
        { color: '#f03728', label: '55–60 · heavy' },
        { color: '#dc46e6', label: '65+ · hail core' },
      ],
    },
  },
  {
    id: 'av-synthetic',
    name: 'AV Cockpit — Synthetic Drive',
    description: 'A 20-second synthetic urban drive in a streetscape.gl-style AV cockpit: accumulated LIDAR point cloud (colored by height band), ego trajectory, tracked-object 3D boxes, and CAN-bus gauges. Cockpit at /drive/av-synthetic.',
    // Primary `url` = the LIDAR point archive; ego + objects overlay; the
    // cockpit additionally reads scene.json + the telemetry/camera sidecars.
    url: '/data/av-synthetic/lidar/manifest.json',
    avLidarUrl: '/data/av-synthetic/lidar/manifest.json',
    avSceneUrl: '/data/av-synthetic/scene.json',
    avEgoUrl: '/data/av-synthetic/ego/manifest.json',
    avObjectsUrl: '/data/av-synthetic/objects/manifest.json',
    avTelemetryUrl: '/data/av-synthetic/telemetry.json',
    avCamerasUrl: '/data/av-synthetic/cameras.json',
    avMapPolyUrl: '/data/av-synthetic/map_poly/manifest.json',
    avMapLineUrl: '/data/av-synthetic/map_line/manifest.json',
    mapColors: AV_MAP_COLORS,
    type: 'av',
    // MUST equal the av-synthetic bundle's scene.json range (the generator
    // stamps the scene at this fixed epoch) — the standard DemoPage / tile
    // loader keys off THIS, so a mismatch renders the demo blank. The cockpit
    // additionally reads the authoritative range from scene.json at runtime.
    timeRange: {
      start: 1700000000000,
      end: 1700000020000, // +20s
    },
    timeWindow: 2000, // 2s rolling window — LIDAR sweeps step crisply
    targetPlaybackSeconds: 20, // real-time-ish playback of the 20s drive
    // boston-seaport georef origin (per the contract table), tilted street view.
    initialViewState: {
      longitude: -71.0573,
      latitude: 42.3375,
      zoom: 17,
      pitch: 55,
      bearing: 20,
    },
    // LIDAR colored by categorical `height_band`; ground→sky 8-band ramp.
    colorProperty: 'height_band',
    lidarColorMapping: AV_HEIGHT_BAND_COLORS,
    lidarColorMappingDefault: [120, 130, 150, 220],
    radius: 1.4,
    radiusUnits: 'pixels',
    radiusMinPixels: 1,
    opacity: 0.9,
    // Object boxes colored by categorical `category`.
    avObjectColors: AV_OBJECT_COLORS,
    colorMappingDefault: [150, 160, 175, 220],
    // Cyan ego trail spanning the whole drive.
    tripColor: [120, 230, 255, 255],
    widthUnits: 'meters',
    tripWidth: 2.2,
    fadeTrail: true,
    legend: {
      title: 'LIDAR height band (m)',
      items: [
        { color: '#343c9e', label: 'ground' },
        { color: '#26a8a8', label: 'car-roof' },
        { color: '#aad64a', label: 'mid' },
        { color: '#f8c63c', label: 'building edge' },
        { color: '#fa8c30', label: 'rooftops' },
      ],
    },
  },
  // ── Argoverse 2 · one real sensor log per AV2 city (LIDAR + ego + objects +
  //    HD-map w/ lane centerlines + ring camera + ego-derived telemetry). Built
  //    by argoverse_batch.sh from the public AWS-open-data bucket; coords are each
  //    bundle's scene.json initialView (exact av2-devkit per-city CRS). The first
  //    (Pittsburgh) is the /demos headline card; the rest are cockpit-only.
  argoverseScene({
    id: 'argoverse-02678d04',
    name: 'Argoverse 2 · Pittsburgh',
    description: 'Real Argoverse 2 sensor log, Pittsburgh: 64-beam LIDAR, tracked-object 3D boxes, ego trajectory, HD-map substrate (lane boundaries + centerlines, drivable areas, crosswalks), a ring-camera inset, and ego-derived telemetry (AV2 ships no CAN bus).',
    timeRange: { start: 315969904357, end: 315969920307 },
    longitude: -79.9333411419541,
    latitude: 40.45610620281625,
  }),
  // Oriented-surfel splat variant (argoverse_extract.py --surfel) — see the
  // Miami `-surfel` note below. The cockpit render-mode toggle offers Surfel
  // automatically because this `<id>-surfel` entry exists.
  argoverseScene({
    id: 'argoverse-02678d04-surfel',
    name: 'Argoverse 2 · Pittsburgh — oriented surfel splat',
    description: 'The Pittsburgh Argoverse 2 log as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315969904357, end: 315969920307 },
    longitude: -79.9333411419541,
    latitude: 40.45610620281625,
    surfel: true,
  }),
  // WORLDBUILD variant (argoverse_extract.py --world): the camera-colored surfel
  // cloud, but STATIC surfels persist once revealed so the 3D scene reconstructs
  // itself as the car drives, while DYNAMIC surfels (moving traffic) smear over a
  // short temporal Gaussian. Started with ONE AV2 city (Pittsburgh) to validate;
  // mirror it to the other cities once the look is confirmed. The cockpit's render-
  // mode toggle offers "Worldbuild" automatically because this `-world` entry exists.
  argoverseScene({
    id: 'argoverse-02678d04-world',
    name: 'Argoverse 2 · Pittsburgh — worldbuild',
    description: 'The Pittsburgh Argoverse 2 log as a worldbuild reconstruction: static camera-colored surfels persist once revealed so the scene accumulates as the car drives; dynamic surfels smear over a short temporal window. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315969904357, end: 315969920307 },
    longitude: -79.9333411419541,
    latitude: 40.45610620281625,
    world: true,
  }),
  // SWEEP / SCAN variant (argoverse_extract.py --scan): raw LIDAR with each return
  // stamped at its TRUE scan time + colored by a per-point phase ramp, drawn as a
  // WAKE-mode point sweep so the rotating scan-line sweeps across the scene like a
  // live radar. AV2-only (only AV2 builds a `-scan` bundle); the cockpit's render-
  // mode toggle offers "Sweep" automatically because this `-scan` entry exists.
  argoverseScene({
    id: 'argoverse-02678d04-scan',
    name: 'Argoverse 2 · Pittsburgh — raw sweep',
    description: 'The Pittsburgh Argoverse 2 log as the raw LIDAR sweep: each return drawn at its true scan instant, colored by a rotating phase ramp, so the scan-line sweeps across the scene each revolution. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315969904357, end: 315969920307 },
    longitude: -79.9333411419541,
    latitude: 40.45610620281625,
    scan: true,
  }),
  argoverseScene({
    id: 'argoverse-02a00399',
    name: 'Argoverse 2 · Miami',
    description: 'Real Argoverse 2 sensor log, Miami: 64-beam LIDAR, tracked-object 3D boxes, ego trajectory, HD-map substrate with lane centerlines, a ring-camera inset, and ego-derived telemetry.',
    timeRange: { start: 315966070522, end: 315966086462 },
    longitude: -80.19521021126853,
    latitude: 25.81266355087901,
  }),
  // Scene-split "stage + actors" variants are AUTO-DERIVED from every AV2 + Waymo
  // base scene (see makeStageVariant / STAGE_BASE_IDS below) — no per-scene entry.
  // Oriented-surfel splat variant of the Miami scene (argoverse_extract.py
  // --surfel): every LIDAR return is an oriented elliptical disk lying on the
  // surface it sampled — orientation + size fit from a per-sweep k-NN covariance,
  // color projected from the 7 ring cameras — with a soft radial AND temporal
  // Gaussian, so the surface brightens at each sweep's instant and evolves as the
  // car drives (SplatLayer, depth-sorted, no point dots). The cockpit's render-
  // mode toggle (Points / Splat / Surfel) swaps to this `-surfel` bundle; AV2 is
  // georeferenced so it sits on Miami's real streets + HD map.
  argoverseScene({
    id: 'argoverse-02a00399-surfel',
    name: 'Argoverse 2 · Miami — oriented surfel splat',
    description: 'The Miami Argoverse 2 log as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315966070522, end: 315966086462 },
    longitude: -80.19521021126853,
    latitude: 25.81266355087901,
    surfel: true,
  }),
  // SWEEP / SCAN variant of the Miami scene (argoverse_extract.py --scan).
  argoverseScene({
    id: 'argoverse-02a00399-scan',
    name: 'Argoverse 2 · Miami — raw sweep',
    description: 'The Miami Argoverse 2 log as the raw LIDAR sweep: each return drawn at its true scan instant, colored by a rotating phase ramp, so the scan-line sweeps across the scene each revolution. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315966070522, end: 315966086462 },
    longitude: -80.19521021126853,
    latitude: 25.81266355087901,
    scan: true,
  }),
  // ADDITIVE-OCTREE ZOOM LOD variant of the Miami scene (argoverse_extract.py
  // --lod). One archive where each LIDAR return is materialized at a single
  // "home zoom" (per-sweep hierarchical voxel subsample): coarse zoom levels
  // hold a SPARSE overview of the live sweep, finer levels add ONLY the residual
  // detail. The cockpit's "Zoom LOD" render mode loads the UNION of zoom levels
  // (lodMode:'additive'), so zooming in streams in detail without re-fetching the
  // coarse cloud — replacing the 5 fixed density tiers with true zoom-driven LOD.
  // Starts a touch zoomed-out so the densify-on-zoom reveal is visible.
  argoverseScene({
    id: 'argoverse-02a00399-lod',
    name: 'Argoverse 2 · Miami — additive zoom LOD',
    description: 'The Miami Argoverse 2 log as an additive-octree point cloud: each LIDAR return assigned a single home zoom by a per-sweep hierarchical voxel subsample. Zoomed out shows a sparse overview; zooming in streams the residual detail while the coarse tiles stay resident. Lossless, and about half the bytes of the five fixed density tiers it replaces. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315966070522, end: 315966086462 },
    longitude: -80.19521021126853,
    latitude: 25.81266355087901,
    zoom: 16,
    lod: true,
  }),
  // ── Additive-octree zoom-LOD variants for the other 5 Argoverse cities ──
  // (argoverse_extract.py --lod). Each is the same sensor log as its base scene,
  // baked as ONE archive where every return lives at a single geometry-aware home
  // zoom; the cockpit's "Zoom LOD" mode loads the union of zoom levels.
  argoverseScene({
    id: 'argoverse-02678d04-lod',
    name: 'Argoverse 2 · Pittsburgh — additive zoom LOD',
    description: 'The Pittsburgh Argoverse 2 log as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to the full cloud as you zoom in.',
    timeRange: { start: 315969904357, end: 315969920307 },
    longitude: -79.9333411419541,
    latitude: 40.45610620281625,
    zoom: 16,
    lod: true,
  }),
  argoverseScene({
    id: 'argoverse-0b5142c1-lod',
    name: 'Argoverse 2 · Washington DC — additive zoom LOD',
    description: 'The Washington DC Argoverse 2 log as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to the full cloud as you zoom in.',
    timeRange: { start: 315968121172, end: 315968137127 },
    longitude: -76.97901441961996,
    latitude: 38.903158674858965,
    zoom: 16,
    lod: true,
  }),
  argoverseScene({
    id: 'argoverse-0bae3b5e-lod',
    name: 'Argoverse 2 · Detroit — additive zoom LOD',
    description: 'The Detroit Argoverse 2 log as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to the full cloud as you zoom in.',
    timeRange: { start: 315969524322, end: 315969540277 },
    longitude: -83.05092955863113,
    latitude: 42.33371685760447,
    zoom: 16,
    lod: true,
  }),
  argoverseScene({
    id: 'argoverse-25e5c600-lod',
    name: 'Argoverse 2 · Palo Alto — additive zoom LOD',
    description: 'The Palo Alto Argoverse 2 log as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to the full cloud as you zoom in.',
    timeRange: { start: 315966104242, end: 315966120187 },
    longitude: -122.12833142762317,
    latitude: 37.415846217190214,
    zoom: 16,
    lod: true,
  }),
  argoverseScene({
    id: 'argoverse-92b900b1-lod',
    name: 'Argoverse 2 · Austin — additive zoom LOD',
    description: 'The Austin Argoverse 2 log as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to the full cloud as you zoom in.',
    timeRange: { start: 315968947407, end: 315968963357 },
    longitude: -97.70213668235851,
    latitude: 30.255713070218487,
    zoom: 16,
    lod: true,
  }),
  argoverseScene({
    id: 'argoverse-0b5142c1',
    name: 'Argoverse 2 · Washington DC',
    description: 'Real Argoverse 2 sensor log, Washington DC: 64-beam LIDAR, tracked-object 3D boxes, ego trajectory, HD-map substrate with lane centerlines, a ring-camera inset, and ego-derived telemetry.',
    timeRange: { start: 315968121172, end: 315968137127 },
    longitude: -76.97901441961996,
    latitude: 38.903158674858965,
  }),
  argoverseScene({
    id: 'argoverse-0b5142c1-surfel',
    name: 'Argoverse 2 · Washington DC — oriented surfel splat',
    description: 'The Washington DC Argoverse 2 log as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315968121172, end: 315968137127 },
    longitude: -76.97901441961996,
    latitude: 38.903158674858965,
    surfel: true,
  }),
  // SWEEP / SCAN variant of the Washington DC scene (argoverse_extract.py --scan).
  argoverseScene({
    id: 'argoverse-0b5142c1-scan',
    name: 'Argoverse 2 · Washington DC — raw sweep',
    description: 'The Washington DC Argoverse 2 log as the raw LIDAR sweep: each return drawn at its true scan instant, colored by a rotating phase ramp, so the scan-line sweeps across the scene each revolution. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315968121172, end: 315968137127 },
    longitude: -76.97901441961996,
    latitude: 38.903158674858965,
    scan: true,
  }),
  argoverseScene({
    id: 'argoverse-0bae3b5e',
    name: 'Argoverse 2 · Detroit',
    description: 'Real Argoverse 2 sensor log, Detroit: 64-beam LIDAR, tracked-object 3D boxes, ego trajectory, HD-map substrate with lane centerlines, a ring-camera inset, and ego-derived telemetry.',
    timeRange: { start: 315969524322, end: 315969540277 },
    longitude: -83.05092955863113,
    latitude: 42.33371685760447,
  }),
  argoverseScene({
    id: 'argoverse-0bae3b5e-surfel',
    name: 'Argoverse 2 · Detroit — oriented surfel splat',
    description: 'The Detroit Argoverse 2 log as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315969524322, end: 315969540277 },
    longitude: -83.05092955863113,
    latitude: 42.33371685760447,
    surfel: true,
  }),
  // SWEEP / SCAN variant of the Detroit scene (argoverse_extract.py --scan).
  argoverseScene({
    id: 'argoverse-0bae3b5e-scan',
    name: 'Argoverse 2 · Detroit — raw sweep',
    description: 'The Detroit Argoverse 2 log as the raw LIDAR sweep: each return drawn at its true scan instant, colored by a rotating phase ramp, so the scan-line sweeps across the scene each revolution. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315969524322, end: 315969540277 },
    longitude: -83.05092955863113,
    latitude: 42.33371685760447,
    scan: true,
  }),
  argoverseScene({
    id: 'argoverse-25e5c600',
    name: 'Argoverse 2 · Palo Alto',
    description: 'Real Argoverse 2 sensor log, Palo Alto: 64-beam LIDAR, tracked-object 3D boxes, ego trajectory, HD-map substrate with lane centerlines, a ring-camera inset, and ego-derived telemetry.',
    timeRange: { start: 315966104242, end: 315966120187 },
    longitude: -122.12833142762317,
    latitude: 37.415846217190214,
  }),
  argoverseScene({
    id: 'argoverse-25e5c600-surfel',
    name: 'Argoverse 2 · Palo Alto — oriented surfel splat',
    description: 'The Palo Alto Argoverse 2 log as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315966104242, end: 315966120187 },
    longitude: -122.12833142762317,
    latitude: 37.415846217190214,
    surfel: true,
  }),
  // SWEEP / SCAN variant of the Palo Alto scene (argoverse_extract.py --scan).
  argoverseScene({
    id: 'argoverse-25e5c600-scan',
    name: 'Argoverse 2 · Palo Alto — raw sweep',
    description: 'The Palo Alto Argoverse 2 log as the raw LIDAR sweep: each return drawn at its true scan instant, colored by a rotating phase ramp, so the scan-line sweeps across the scene each revolution. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315966104242, end: 315966120187 },
    longitude: -122.12833142762317,
    latitude: 37.415846217190214,
    scan: true,
  }),
  argoverseScene({
    id: 'argoverse-92b900b1',
    name: 'Argoverse 2 · Austin',
    description: 'Real Argoverse 2 sensor log, Austin: 64-beam LIDAR, tracked-object 3D boxes, ego trajectory, HD-map substrate with lane centerlines, a ring-camera inset, and ego-derived telemetry.',
    timeRange: { start: 315968947407, end: 315968963357 },
    longitude: -97.70213668235851,
    latitude: 30.255713070218487,
  }),
  argoverseScene({
    id: 'argoverse-92b900b1-surfel',
    name: 'Argoverse 2 · Austin — oriented surfel splat',
    description: 'The Austin Argoverse 2 log as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315968947407, end: 315968963357 },
    longitude: -97.70213668235851,
    latitude: 30.255713070218487,
    surfel: true,
  }),
  // SWEEP / SCAN variant of the Austin scene (argoverse_extract.py --scan).
  argoverseScene({
    id: 'argoverse-92b900b1-scan',
    name: 'Argoverse 2 · Austin — raw sweep',
    description: 'The Austin Argoverse 2 log as the raw LIDAR sweep: each return drawn at its true scan instant, colored by a rotating phase ramp, so the scan-line sweeps across the scene each revolution. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315968947407, end: 315968963357 },
    longitude: -97.70213668235851,
    latitude: 30.255713070218487,
    scan: true,
  }),
  // ── Argoverse 2 · TRUE-3D density iso-lines (argoverse_extract.py --contours
  //    --contour-z-step) for all 6 cities. Density contoured per height layer,
  //    stacked at real altitude — the cockpit's "Iso 3D" render mode. AV2 is
  //    georeferenced, so these keep the real basemap + HD-map substrate.
  argoverseScene({
    id: 'argoverse-02678d04-iso3d',
    name: 'Argoverse 2 · Pittsburgh — 3D density iso-lines',
    description: 'The Pittsburgh Argoverse 2 log as a true-3D density field: LIDAR returns binned into height layers, each layer contoured independently and stacked at its real altitude, so the relief morphs as the car drives. Colored by return density. Same boxes / ego / HD map / telemetry as the height-ramp scene.',
    timeRange: { start: 315969904357, end: 315969920307 },
    longitude: -79.9333411419541,
    latitude: 40.45610620281625,
    iso3d: true,
  }),
  argoverseScene({
    id: 'argoverse-02a00399-iso3d',
    name: 'Argoverse 2 · Miami — 3D density iso-lines',
    description: 'The Miami Argoverse 2 log as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density.',
    timeRange: { start: 315966070522, end: 315966086462 },
    longitude: -80.19521021126853,
    latitude: 25.81266355087901,
    iso3d: true,
  }),
  argoverseScene({
    id: 'argoverse-0b5142c1-iso3d',
    name: 'Argoverse 2 · Washington DC — 3D density iso-lines',
    description: 'The Washington DC Argoverse 2 log as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density.',
    timeRange: { start: 315968121172, end: 315968137127 },
    longitude: -76.97901441961996,
    latitude: 38.903158674858965,
    iso3d: true,
  }),
  argoverseScene({
    id: 'argoverse-0bae3b5e-iso3d',
    name: 'Argoverse 2 · Detroit — 3D density iso-lines',
    description: 'The Detroit Argoverse 2 log as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density.',
    timeRange: { start: 315969524322, end: 315969540277 },
    longitude: -83.05092955863113,
    latitude: 42.33371685760447,
    iso3d: true,
  }),
  argoverseScene({
    id: 'argoverse-25e5c600-iso3d',
    name: 'Argoverse 2 · Palo Alto — 3D density iso-lines',
    description: 'The Palo Alto Argoverse 2 log as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density.',
    timeRange: { start: 315966104242, end: 315966120187 },
    longitude: -122.12833142762317,
    latitude: 37.415846217190214,
    iso3d: true,
  }),
  argoverseScene({
    id: 'argoverse-92b900b1-iso3d',
    name: 'Argoverse 2 · Austin — 3D density iso-lines',
    description: 'The Austin Argoverse 2 log as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density.',
    timeRange: { start: 315968947407, end: 315968963357 },
    longitude: -97.70213668235851,
    latitude: 30.255713070218487,
    iso3d: true,
  }),
  // ── Argoverse 2 · FLAT high-XY-res density iso-lines (the "Iso-lines" overview
  //    pill) for all 6 cities — the 2D sibling of the iso3d entries above.
  argoverseScene({
    id: 'argoverse-02678d04-iso',
    name: 'Argoverse 2 · Pittsburgh — density iso-lines',
    description: 'The Pittsburgh Argoverse 2 log as a flat topographic map of LIDAR return density — iso-density contours re-cut per playhead window, over the real basemap + HD map.',
    timeRange: { start: 315969904357, end: 315969920307 },
    longitude: -79.9333411419541,
    latitude: 40.45610620281625,
    iso: true,
  }),
  argoverseScene({
    id: 'argoverse-02a00399-iso',
    name: 'Argoverse 2 · Miami — density iso-lines',
    description: 'The Miami Argoverse 2 log as a flat topographic map of LIDAR return density — iso-density contours re-cut per playhead window.',
    timeRange: { start: 315966070522, end: 315966086462 },
    longitude: -80.19521021126853,
    latitude: 25.81266355087901,
    iso: true,
  }),
  argoverseScene({
    id: 'argoverse-0b5142c1-iso',
    name: 'Argoverse 2 · Washington DC — density iso-lines',
    description: 'The Washington DC Argoverse 2 log as a flat topographic map of LIDAR return density — iso-density contours per playhead window.',
    timeRange: { start: 315968121172, end: 315968137127 },
    longitude: -76.97901441961996,
    latitude: 38.903158674858965,
    iso: true,
  }),
  argoverseScene({
    id: 'argoverse-0bae3b5e-iso',
    name: 'Argoverse 2 · Detroit — density iso-lines',
    description: 'The Detroit Argoverse 2 log as a flat topographic map of LIDAR return density — iso-density contours per playhead window.',
    timeRange: { start: 315969524322, end: 315969540277 },
    longitude: -83.05092955863113,
    latitude: 42.33371685760447,
    iso: true,
  }),
  argoverseScene({
    id: 'argoverse-25e5c600-iso',
    name: 'Argoverse 2 · Palo Alto — density iso-lines',
    description: 'The Palo Alto Argoverse 2 log as a flat topographic map of LIDAR return density — iso-density contours per playhead window.',
    timeRange: { start: 315966104242, end: 315966120187 },
    longitude: -122.12833142762317,
    latitude: 37.415846217190214,
    iso: true,
  }),
  argoverseScene({
    id: 'argoverse-92b900b1-iso',
    name: 'Argoverse 2 · Austin — density iso-lines',
    description: 'The Austin Argoverse 2 log as a flat topographic map of LIDAR return density — iso-density contours per playhead window.',
    timeRange: { start: 315968947407, end: 315968963357 },
    longitude: -97.70213668235851,
    latitude: 30.255713070218487,
    iso: true,
  }),
  // ── Waymo Open Dataset · curated Perception v2.0.1 segments (day/night, SF/PHX,
  //    + the one rain scene). 5-laser LIDAR decoded from range images, 3D box
  //    tracks w/ real per-box velocity, ego trail, FRONT camera, ego-derived
  //    telemetry. NO HD map + NO disclosed georef → anchored local frame on the
  //    cockpit dark basemap. Built by waymo_batch.sh. coords = scene.json center.
  waymoScene({
    id: 'waymo-sf-day',
    name: 'Waymo · San Francisco · Day',
    description: 'Real Waymo Open Dataset perception segment, daytime San Francisco: 5-laser LIDAR (decoded from range images), tracked-object 3D boxes with per-box velocity, ego trajectory, a front-camera inset, and ego-derived telemetry (Waymo ships no CAN bus). Anchored to an approximate local frame (Waymo discloses no georeferencing).',
    timeRange: { start: 1559170821400, end: 1559170841225 },
    longitude: -122.41947418420166,
    latitude: 37.774902618839754,
  }),
  // EXPERIMENT: the same SF-day segment, but the LIDAR is COLORED from the
  // cameras — each return is projected into whichever of the 5 cameras sees it
  // (waymo_extract.py --colorize) and painted that pixel's color, then rendered
  // as soft gaussian splats. ~252° of the cloud is photo-colored; the rear wedge
  // (no camera) stays slate. Built local-only (Waymo no-redistribution).
  waymoScene({
    id: 'waymo-sf-day-splat',
    name: 'Waymo · SF · Day — camera-colored splats',
    description: 'The daytime San Francisco Waymo segment with each LIDAR return colored by projecting it into the cameras and sampling the pixel, rendered as soft gaussian splats. The forward ~252° is camera-colored (5 cameras); the rear wedge, seen by no camera, stays neutral slate. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1559170821400, end: 1559170841225 },
    longitude: -122.41947418420166,
    latitude: 37.774902618839754,
    colored: true,
  }),
  // SURFEL SPLAT: the same SF-day segment, but each LIDAR return is a real
  // ORIENTED anisotropic Gaussian surfel — a flat disk lying on the surface,
  // oriented by a per-sweep k-NN covariance fit (waymo_extract.py --surfel),
  // camera-colored, and rendered by SplatLayer with a soft radial AND a soft
  // temporal Gaussian. So the cloud reads as continuous surface that brightens
  // and fades around each sweep's instant instead of a field of round dots —
  // a "formal" splat that renders geometry over time. Built local-only.
  waymoScene({
    id: 'waymo-sf-day-surfel',
    name: 'Waymo · SF · Day — oriented surfel splat',
    description: 'The daytime San Francisco Waymo segment as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1559170821400, end: 1559170841225 },
    longitude: -122.41947418420166,
    latitude: 37.774902618839754,
    surfel: true,
  }),
  // WORLDBUILD: the same SF-day segment built with waymo_extract.py --world — the
  // camera-colored oriented surfels of the static scene PERSIST once revealed so
  // the 3D world reconstructs itself as the car drives, while moving traffic smears
  // with a short temporal Gaussian so it still reads as motion. The cockpit's
  // render-mode toggle offers "Worldbuild" automatically because this `-world`
  // bundle exists. Built local-only (Waymo no-redistribution).
  waymoScene({
    id: 'waymo-sf-day-world',
    name: 'Waymo · SF · Day — worldbuild',
    description: 'The daytime San Francisco Waymo segment as a worldbuild reconstruction: static camera-colored surfels persist once revealed so the scene accumulates as the car drives; dynamic surfels smear over a short temporal window. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1559170821400, end: 1559170841225 },
    longitude: -122.41947418420166,
    latitude: 37.774902618839754,
    world: true,
  }),
  // DENSITY ISO-LINES: the same SF-day segment, but the LIDAR is drawn as live
  // topographic contours of return DENSITY (waymo_extract.py --contours) — a map
  // of where the cloud clusters (walls, parked cars, vegetation), re-cut per ~200
  // ms playhead window so it morphs as the car drives. Height-independent, so it
  // reads richly even though this SF segment is flat. The cockpit's render-mode
  // toggle offers "Iso-lines" automatically because this `-iso` bundle exists.
  // Built local-only (Waymo no-redistribution).
  waymoScene({
    id: 'waymo-sf-day-iso',
    name: 'Waymo · SF · Day — density iso-lines',
    description: 'The daytime San Francisco Waymo segment as a live topographic map of LIDAR return density: returns binned onto a ground grid and drawn as iso-density contours, re-cut per ~200 ms playhead window. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1559170821400, end: 1559170841225 },
    longitude: -122.41947418420166,
    latitude: 37.774902618839754,
    iso: true,
  }),
  // TRUE-3D DENSITY ISO-LINES: the same SF-day segment, but density is contoured
  // per HEIGHT LAYER (waymo_extract.py --contours --contour-z-step) so the iso-
  // lines stack at their REAL altitudes — a wall's contours climb its full height,
  // a parked car's sit only near the ground, the road reads as a broad slab. The
  // cockpit offers "Iso 3D" automatically because this `-iso3d` bundle exists.
  // Built local-only (Waymo no-redistribution).
  waymoScene({
    id: 'waymo-sf-day-iso3d',
    name: 'Waymo · SF · Day — 3D density iso-lines',
    description: 'The daytime San Francisco Waymo segment as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1559170821400, end: 1559170841225 },
    longitude: -122.41947418420166,
    latitude: 37.774902618839754,
    iso3d: true,
  }),
  // Geometry-aware decimation A/B (local experiment, --adaptive-decimate): the
  // SAME surfel scene built at ~4× fewer disks, but the budget spent on edges/
  // poles (curvature) + one voxel representative per flat region instead of a
  // uniform stride. Compare side-by-side against the full-density
  // `waymo-sf-day-surfel` to judge the size↔fidelity tradeoff. Local-only.
  waymoScene({
    id: 'waymo-sf-day-surfel-adaptive',
    name: 'Waymo · SF · Day — oriented surfel splat (adaptive decimation)',
    description: 'The daytime SF surfel scene, decimated geometry-aware: high-curvature returns (edges, poles, vehicle outlines) kept, the flat majority summarized to one voxel representative — about 4× fewer disks than the full-density bundle. A/B vs waymo-sf-day-surfel.',
    timeRange: { start: 1559170821400, end: 1559170841225 },
    longitude: -122.41947418420166,
    latitude: 37.774902618839754,
    surfel: true,
  }),
  waymoScene({
    id: 'waymo-phx-day',
    name: 'Waymo · Phoenix · Day',
    description: 'Real Waymo Open Dataset segment, daytime suburban Phoenix: 5-laser LIDAR, tracked-object 3D box tracks (vehicles, pedestrians, cyclists) with per-box velocity, ego trajectory, a front-camera inset, and ego-derived telemetry. Anchored to an approximate local frame (Waymo discloses no georeferencing).',
    timeRange: { start: 1513450821409, end: 1513450841108 },
    longitude: -112.074419,
    latitude: 33.448329,
  }),
  // Oriented-surfel splat variant (waymo_extract.py --surfel) — the cockpit
  // render-mode toggle offers Surfel automatically when this entry exists.
  waymoScene({
    id: 'waymo-phx-day-surfel',
    name: 'Waymo · Phoenix · Day — oriented surfel splat',
    description: 'The daytime Phoenix Waymo segment as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1513450821409, end: 1513450841108 },
    longitude: -112.074419,
    latitude: 33.448329,
    surfel: true,
  }),
  waymoScene({
    id: 'waymo-phx-night',
    name: 'Waymo · Phoenix · Night',
    description: 'Real Waymo Open Dataset night segment, Phoenix: 5-laser LIDAR, tracked-object 3D box tracks with per-box velocity, ego trajectory, a front-camera inset, and ego-derived telemetry (Waymo ships no CAN bus). Anchored to an approximate local frame on a neutral basemap.',
    timeRange: { start: 1508038141882, end: 1508038161581 },
    longitude: -112.073977,
    latitude: 33.448178,
  }),
  waymoScene({
    id: 'waymo-phx-night-surfel',
    name: 'Waymo · Phoenix · Night — oriented surfel splat',
    description: 'The night Phoenix Waymo segment as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1508038141882, end: 1508038161581 },
    longitude: -112.073977,
    latitude: 33.448178,
    surfel: true,
  }),
  waymoScene({
    id: 'waymo-sf-night',
    name: 'Waymo · San Francisco · Night',
    description: 'Real Waymo Open Dataset night segment, San Francisco: 5-laser LIDAR, tracked-object 3D box tracks (vehicles, pedestrians, cyclists) with per-box velocity, ego trajectory, a front-camera inset, and ego-derived telemetry. Anchored to an approximate local frame (Waymo discloses no georeferencing).',
    timeRange: { start: 1541816058898, end: 1541816078598 },
    longitude: -122.419489,
    latitude: 37.774895,
  }),
  waymoScene({
    id: 'waymo-sf-night-surfel',
    name: 'Waymo · San Francisco · Night — oriented surfel splat',
    description: 'The night San Francisco Waymo segment as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1541816058898, end: 1541816078598 },
    longitude: -122.419489,
    latitude: 37.774895,
    surfel: true,
  }),
  waymoScene({
    id: 'waymo-phx-dusk-rain',
    name: 'Waymo · Phoenix · Dawn/Dusk (rain)',
    description: 'Real Waymo Open Dataset dawn/dusk segment, Phoenix, in rain — the only wet scene in the validation split. 5-laser LIDAR (rain scatters returns), tracked-object 3D box tracks with per-box velocity, ego trajectory, a front-camera inset, and ego-derived telemetry. Anchored to an approximate local frame.',
    timeRange: { start: 1518657647337, end: 1518657667137 },
    longitude: -112.071638,
    latitude: 33.448412,
    // Rain scatters the LIDAR, so this cloud overplots more than the dry scenes.
    // Shrink the points to render at max resolution (less merging into a blob).
    radius: 0.7,
    radiusMinPixels: 0.5,
  }),
  waymoScene({
    id: 'waymo-phx-dusk-rain-surfel',
    name: 'Waymo · Phoenix · Dawn/Dusk (rain) — oriented surfel splat',
    description: 'The rainy dawn/dusk Phoenix Waymo segment as a Gaussian surfel splat: each LIDAR return is an oriented camera-colored disk, fit from a per-sweep k-NN covariance, fading in and out around its sweep time. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1518657647337, end: 1518657667137 },
    longitude: -112.071638,
    latitude: 33.448412,
    surfel: true,
  }),
  // Scene-split "stage + actors" variants are AUTO-DERIVED from every AV2 + Waymo
  // base scene (see makeStageVariant / STAGE_BASE_IDS) — no per-scene entry here.
  // TRUE-3D density iso-lines for the remaining 4 Waymo scenes (sf-day's is above).
  // Density contoured per height layer, stacked at real altitude — the cockpit's
  // "Iso 3D" render mode. Local-only (Waymo no-redistribution).
  waymoScene({
    id: 'waymo-phx-day-iso3d',
    name: 'Waymo · Phoenix · Day — 3D density iso-lines',
    description: 'The daytime Phoenix Waymo segment as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density. Same boxes / ego / telemetry as the height-ramp scene.',
    timeRange: { start: 1513450821409, end: 1513450841108 },
    longitude: -112.074419,
    latitude: 33.448329,
    iso3d: true,
  }),
  waymoScene({
    id: 'waymo-phx-night-iso3d',
    name: 'Waymo · Phoenix · Night — 3D density iso-lines',
    description: 'The night Phoenix Waymo segment as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density.',
    timeRange: { start: 1508038141882, end: 1508038161581 },
    longitude: -112.073977,
    latitude: 33.448178,
    iso3d: true,
  }),
  waymoScene({
    id: 'waymo-sf-night-iso3d',
    name: 'Waymo · San Francisco · Night — 3D density iso-lines',
    description: 'The night San Francisco Waymo segment as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Colored by return density.',
    timeRange: { start: 1541816058898, end: 1541816078598 },
    longitude: -122.419489,
    latitude: 37.774895,
    iso3d: true,
  }),
  waymoScene({
    id: 'waymo-phx-dusk-rain-iso3d',
    name: 'Waymo · Phoenix · Dawn/Dusk (rain) — 3D density iso-lines',
    description: 'The rainy dawn/dusk Phoenix Waymo segment as a true-3D density field: returns binned into height layers, each contoured independently and stacked at its real altitude. Rain scatters the cloud, so the density structure reads differently from the dry scenes. Colored by return density.',
    timeRange: { start: 1518657647337, end: 1518657667137 },
    longitude: -112.071638,
    latitude: 33.448412,
    iso3d: true,
  }),
  // FLAT high-XY-res density iso-lines (the "Iso-lines" overview pill) for the
  // remaining 4 Waymo scenes (sf-day's is above). Same fine-XY contours as the 3D
  // version but drawn flat. Local-only.
  waymoScene({
    id: 'waymo-phx-day-iso',
    name: 'Waymo · Phoenix · Day — density iso-lines',
    description: 'The daytime Phoenix Waymo segment as a flat topographic map of LIDAR return density — iso-density contours re-cut per playhead window.',
    timeRange: { start: 1513450821409, end: 1513450841108 },
    longitude: -112.074419,
    latitude: 33.448329,
    iso: true,
  }),
  waymoScene({
    id: 'waymo-phx-night-iso',
    name: 'Waymo · Phoenix · Night — density iso-lines',
    description: 'The night Phoenix Waymo segment as a flat topographic map of LIDAR return density — iso-density contours re-cut per playhead window.',
    timeRange: { start: 1508038141882, end: 1508038161581 },
    longitude: -112.073977,
    latitude: 33.448178,
    iso: true,
  }),
  waymoScene({
    id: 'waymo-sf-night-iso',
    name: 'Waymo · San Francisco · Night — density iso-lines',
    description: 'The night San Francisco Waymo segment as a flat topographic map of LIDAR return density — iso-density contours per playhead window.',
    timeRange: { start: 1541816058898, end: 1541816078598 },
    longitude: -122.419489,
    latitude: 37.774895,
    iso: true,
  }),
  waymoScene({
    id: 'waymo-phx-dusk-rain-iso',
    name: 'Waymo · Phoenix · Dawn/Dusk (rain) — density iso-lines',
    description: 'The rainy dawn/dusk Phoenix Waymo segment as a flat topographic map of LIDAR return density — iso-density contours per window.',
    timeRange: { start: 1518657647337, end: 1518657667137 },
    longitude: -112.071638,
    latitude: 33.448412,
    iso: true,
  }),
  // ── Additive-octree zoom-LOD variants for the 5 Waymo scenes ──
  // (waymo_extract.py --lod). LOCAL-ONLY like every Waymo bundle (no-redistribution
  // license). Each return lives at a single geometry-aware home zoom; the cockpit's
  // "Zoom LOD" mode loads the union of zoom levels.
  waymoScene({
    id: 'waymo-sf-day-lod',
    name: 'Waymo · San Francisco · Day — additive zoom LOD',
    description: 'The daytime San Francisco Waymo segment as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to full resolution as you zoom in.',
    timeRange: { start: 1559170821400, end: 1559170841225 },
    longitude: -122.41947418420166,
    latitude: 37.774902618839754,
    zoom: 16,
    lod: true,
  }),
  waymoScene({
    id: 'waymo-phx-day-lod',
    name: 'Waymo · Phoenix · Day — additive zoom LOD',
    description: 'The daytime Phoenix Waymo segment as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to full resolution as you zoom in.',
    timeRange: { start: 1513450821409, end: 1513450841108 },
    longitude: -112.074419,
    latitude: 33.448329,
    zoom: 16,
    lod: true,
  }),
  waymoScene({
    id: 'waymo-phx-night-lod',
    name: 'Waymo · Phoenix · Night — additive zoom LOD',
    description: 'The night Phoenix Waymo segment as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to full resolution as you zoom in.',
    timeRange: { start: 1508038141882, end: 1508038161581 },
    longitude: -112.073977,
    latitude: 33.448178,
    zoom: 16,
    lod: true,
  }),
  waymoScene({
    id: 'waymo-sf-night-lod',
    name: 'Waymo · San Francisco · Night — additive zoom LOD',
    description: 'The night San Francisco Waymo segment as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to full resolution as you zoom in.',
    timeRange: { start: 1541816058898, end: 1541816078598 },
    longitude: -122.419489,
    latitude: 37.774895,
    zoom: 16,
    lod: true,
  }),
  waymoScene({
    id: 'waymo-phx-dusk-rain-lod',
    name: 'Waymo · Phoenix · Dawn/Dusk (rain) — additive zoom LOD',
    description: 'The rainy dawn/dusk Phoenix Waymo segment as an additive-octree point cloud: each return assigned a single geometry-aware home zoom, so a sparse overview densifies to full resolution as you zoom in.',
    timeRange: { start: 1518657647337, end: 1518657667137 },
    longitude: -112.071638,
    latitude: 33.448412,
    zoom: 16,
    lod: true,
  }),
  // ── comma.ai · real I-280 highway segment (ego GPS + CAN telemetry + camera;
  //    NO lidar/objects). Built by comma_extract.py from the comma2k19 HF mirror.
  //    LIDAR-less, so the PRIMARY (governor-gated) archive is the ego trips.
  {
    id: 'comma-280-1641',
    name: 'comma.ai · I-280 Highway',
    description: 'Real comma2k19 highway segment, California I-280 (San Francisco ↔ San Jose): GPS ego path, CAN-bus telemetry (speed / steering / acceleration), and a road-camera frame. No LIDAR or tracked objects — camera + CAN + GNSS only.',
    url: '/data/comma-280-1641/ego/manifest.json',
    avSceneUrl: '/data/comma-280-1641/scene.json',
    avEgoUrl: '/data/comma-280-1641/ego/manifest.json',
    avTelemetryUrl: '/data/comma-280-1641/telemetry.json',
    avCamerasUrl: '/data/comma-280-1641/cameras.json',
    type: 'av',
    // Matches comma-280-1641/scene.json (the extractor anchors the segment at a
    // fixed epoch; the relative timing is the real 60s drive).
    timeRange: { start: 1700000000000, end: 1700000059949 },
    timeWindow: 4000,
    targetPlaybackSeconds: 60,
    initialViewState: { longitude: -122.4021, latitude: 37.5774, zoom: 15, pitch: 50, bearing: 0 },
    tripColor: [120, 230, 255, 255],
    widthUnits: 'meters',
    tripWidth: 3,
    fadeTrail: true,
    legend: {
      title: 'comma2k19 · I-280',
      items: [{ color: '#78e6ff', label: 'ego vehicle' }],
    },
  },
  // ── nuScenes · all 10 v1.0-mini scenes (Boston Seaport + Singapore), built by
  //    nuscenes_extract.py from the login-gated v1.0-mini + can_bus + map-expansion
  //    + lidarseg. Each is the fullest cockpit — LIDAR (colored by per-point
  //    lidarseg SEMANTIC class), tracked 3D boxes, ego trail, CAN telemetry, and a
  //    front camera, on the nuScenes HD-map substrate. The factory above captures
  //    the shared shape; only id/label/timeRange/framing differ. All listed in the
  //    cockpit SceneSwitcher; the /demos card is the headline scene-0103 only.
  nuscenesScene({
    id: 'nuscenes-0061',
    name: 'nuScenes · One-North (construction)',
    description: 'Real nuScenes mini scene, Singapore one-north: construction zone at an intersection with a parked truck. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "parked truck, construction, intersection, turn."',
    timeRange: { start: 1532402927647, end: 1532402946797 },
    longitude: 103.788327,
    latitude: 1.298281,
  }),
  nuscenesScene({
    id: 'nuscenes-0103',
    name: 'nuScenes · Boston Seaport (pedestrians)',
    description: 'Real nuScenes mini scene, Boston Seaport: pedestrians as the ego waits for a turning car. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry (speed / steering / throttle / brake), and a front camera. Scene log: "many peds right, wait for turning car, long bike rack left, cyclist."',
    timeRange: { start: 1533151603547, end: 1533151622948 },
    longitude: -71.049976,
    latitude: 42.351321,
  }),
  nuscenesScene({
    id: 'nuscenes-0553',
    name: 'nuScenes · Boston Seaport (bicycle)',
    description: 'Real nuScenes mini scene, Boston Seaport: waiting at an intersection beside a bicycle and a large truck. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "wait at intersection, bicycle, large truck, peds."',
    timeRange: { start: 1535489296047, end: 1535489315948 },
    longitude: -71.041856,
    latitude: 42.346179,
  }),
  nuscenesScene({
    id: 'nuscenes-0655',
    name: 'nuScenes · Boston Seaport (parking lot)',
    description: 'Real nuScenes mini scene, Boston Seaport: a parking lot with parked cars, a jaywalker, and a bendy bus. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "parking lot, parked cars, jaywalker, bendy bus."',
    timeRange: { start: 1535385092150, end: 1535385111949 },
    longitude: -71.035317,
    latitude: 42.344646,
  }),
  nuscenesScene({
    id: 'nuscenes-0757',
    name: 'nuScenes · Boston Seaport (busy intersection)',
    description: 'Real nuScenes mini scene, Boston Seaport: arriving at a busy intersection with a bus. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "arrive at busy intersection, bus, wait at intersection."',
    timeRange: { start: 1535657108301, end: 1535657128149 },
    longitude: -71.054096,
    latitude: 42.342856,
  }),
  nuscenesScene({
    id: 'nuscenes-0796',
    name: 'nuScenes · Queenstown (scooters)',
    description: 'Real nuScenes mini scene, Singapore Queenstown: a scooter and pedestrians on the sidewalk amid buses, cars, and a truck. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "scooter, peds on sidewalk, bus, cars, truck."',
    timeRange: { start: 1538448744447, end: 1538448764047 },
    longitude: 103.783511,
    latitude: 1.301422,
  }),
  nuscenesScene({
    id: 'nuscenes-0916',
    name: 'nuScenes · Queenstown (parking)',
    description: 'Real nuScenes mini scene, Singapore Queenstown: a parking lot with a bicycle rack and parked bicycles. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "parking lot, bicycle rack, parked bicycles, bus."',
    timeRange: { start: 1538984233547, end: 1538984253447 },
    longitude: 103.773608,
    latitude: 1.294315,
  }),
  nuscenesScene({
    id: 'nuscenes-1077',
    name: 'nuScenes · Holland Village (night)',
    description: 'Real nuScenes mini scene, Singapore Holland Village: a night drive down a big street past a bus stop at high speed. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "night, big street, bus stop, high speed, construction."',
    timeRange: { start: 1542800367947, end: 1542800387897 },
    longitude: 103.788308,
    latitude: 1.316754,
  }),
  nuscenesScene({
    id: 'nuscenes-1094',
    name: 'nuScenes · Holland Village (night, after rain)',
    description: 'Real nuScenes mini scene, Singapore Holland Village: a night drive after rain, with many pedestrians and a personal mobility device. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "night, after rain, many peds, PMD, ped with bag."',
    timeRange: { start: 1542800847948, end: 1542800867447 },
    longitude: 103.795698,
    latitude: 1.310148,
  }),
  nuscenesScene({
    id: 'nuscenes-1100',
    name: 'nuScenes · Holland Village (night crossing)',
    description: 'Real nuScenes mini scene, Singapore Holland Village: a night drive with pedestrians on the sidewalk and crossing at a crosswalk. 32-beam LIDAR (semantic class), tracked 3D boxes, ego trail, CAN telemetry, and a front camera. Scene log: "night, peds in sidewalk, peds cross crosswalk."',
    timeRange: { start: 1542800987947, end: 1542801007446 },
    longitude: 103.794048,
    latitude: 1.307483,
  }),
  {
    id: 'satellites',
    name: 'Satellite Orbits',
    description: '~12,700 low-Earth-orbit satellites from CelesTrak over 24h (2026-05-31). Globe by default; toggle flat at top-left.',
    url: '/data/satellites/manifest.json',
    type: 'trips', // Use trips layer for animated satellite movement
    useGlobe: true, // Render on 3D globe for orbital visualization
    // MUST bracket the simulation window baked into satellites.stt. The archive
    // was regenerated without `--start-time`, so the generator defaulted to
    // Utc::now() (~2026-05-30) rather than the old 2024-06-21 epoch. A
    // mismatched timeRange makes the tile loader query a time with no data, so
    // getTileIdsInBounds returns nothing and the demo renders blank (a black
    // globe / bare base map) — which looks like "globe→flat is broken".
    // If you regenerate with a fixed `--start-time`, update these to match.
    timeRange: {
      start: 1780261200000, // first sim step in the regenerated archive (2026-05-31)
      end: 1780347600000,   // start + 24h (2026-06-11 rebuild: 5m buckets, pinned --start-time)
    },
    // Time window controls which segments are loaded/visible
    // For LEO satellites with ~90 min orbits and ~40 min segments, use larger window
    timeWindow: 600000, // 10 minute window - loads segments overlapping this range
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: 0,
      latitude: 20,
      zoom: 0.5,
      pitch: 0,
      bearing: 0
    },
    // 24h plays in ~15 min: LEO ground tracks move fast, so a slower playback
    // lets the eye follow individual streaks instead of a blur.
    legend: {
      title: "Orbit",
      items: [
        { color: "#1FBAD6", label: "LEO satellite" },
      ]
    },
    zoomOverride: 0,
    useGlobalBounds: true,
    tripColor: [31, 186, 214, 255],
    tripWidth: 1.5,
    widthMinPixels: 1,
    widthMaxPixels: 3,
    // LEO-tuned: a short 60s trail renders each satellite as a brief comet
    // streak (≈ the distance it covers in one sampling step) rather than a
    // long arc, so 12.7k of them read as a moving speckled field, not a ball
    // of yarn. Low opacity lets overlapping streaks build into a density glow
    // instead of a saturated cyan slab.
    opacity: 0.4,
    trailLength: 60000,
  },
  {
    id: 'animal-migration',
    name: 'Animal Migration',
    sources: ['gbif'],
    description:
      'Animal tracking studies from GBIF, coloured by taxonomic class; ' +
      'multi-year tracks folded into one year. Data: GBIF.org (CC0 / CC-BY / ' +
      'CC-BY-NC).',
    url: '/data/animals/manifest.json',
    type: 'trips',
    timeRange: {
      start: Date.parse('2024-01-01T00:00:00Z'),
      end: Date.parse('2025-01-01T00:00:00Z'),
    },
    // Day-scale loader window (1-day temporal buckets); ~2× the trail so the
    // loader covers the past portion of each fading trail.
    timeWindow: 86400000 * 4,
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: 0,
      latitude: 20,
      zoom: 1.2,
      pitch: 0,
      bearing: 0,
    },
    // Colour by coarse taxon group, resolved at build time from the GBIF
    // backbone. colorMapping keeps each class the same colour across tiles
    // (the ordered palette path is per-tile and would jitter).
    colorProperty: 'taxon_group',
    colorMapping: {
      bird:    [79, 195, 247, 235],
      mammal:  [255, 138, 101, 235],
      fish:    [77, 182, 172, 235],
      reptile: [174, 213, 129, 235],
      insect:  [255, 213, 79, 235],
      other:   [176, 190, 197, 200],
    },
    colorMappingDefault: [176, 190, 197, 200],
    opacity: 0.8,
    // World-space width (metres), mirrored from the maritime points' "render by
    // space" look: a track is ~3 px at a continental zoom (~5) and thins toward
    // the global view, where m/px is huge. widthMinPixels: 1 keeps a 1 px floor
    // so the hero global arc view (zoom 1.2) stays visible instead of vanishing
    // sub-pixel; widthMaxPixels: 3 caps it once zoomed deep into a flyway.
    widthUnits: 'meters',
    tripWidth: 14000,   // ~14 km → ~3 px at zoom 5, floored to 1 px globally
    widthMinPixels: 1,
    widthMaxPixels: 3,
    trailLength: 86400000 * 4, // 4-day fading trail shows the migration arc
    fadeTrail: true,
    zoomOverride: 0,
    useGlobalBounds: true,
    legend: {
      title: 'Taxonomic class',
      items: [
        { color: '#4FC3F7', label: 'Birds' },
        { color: '#FF8A65', label: 'Mammals' },
        { color: '#4DB6AC', label: 'Fish & sharks' },
        { color: '#AED581', label: 'Reptiles' },
        { color: '#FFD54F', label: 'Insects' },
        { color: '#B0BEC5', label: 'Other' },
      ],
    },
  },
  {
    id: 'ocean-drifters',
    name: 'Ocean Currents',
    sources: ['noaa'],
    description:
      'Surface-buoy drift tracks, shaded by sea-surface temperature. ' +
      'Source: NOAA Global Drifter Program.',
    url: '/data/drifters/manifest.json',
    type: 'trips',
    // Render on the 3D globe and slowly auto-rotate (DemoPage drives the spin
    // when useGlobe && autoRotate). `useGlobalBounds` loads the whole planet's
    // tiles so the back side of the globe is populated too.
    useGlobe: true,
    autoRotate: true,
    // Light earth sphere (matches the paper landing page / hero globe) instead
    // of the default dark sphere.
    globeBackgroundColor: [240, 240, 236, 255],
    timeRange: {
      start: 287884800000,  // 1979-02-15 — first fix in the GDP record
      end: 1667844000000,   // 2022-11-07 — last fix (PMEL interpolated product ends here)
    },
    // ~43 years compress into ~10 min, so sim-time races by; the loader window
    // is wide (weekly build buckets → ~30 buckets) and the trail long so each
    // comet tail still lasts a few real seconds.
    timeWindow: 86400000 * 200,
    // Slowed so the 43-year record doesn't race by: ~120s base ⇒ 1× ≈ 2 min,
    // 2× ≈ 1 min. Purely an aesthetic pacing choice — loading no longer needs
    // a speed margin (the PlaybackGovernor stalls honestly if R2 falls behind).
    targetPlaybackSeconds: 120,
    // Open centered on the west coast of South America (the Humboldt Current),
    // then the globe slowly spins via the auto-rotate loop.
    initialViewState: {
      longitude: -78,
      latitude: -20,
      zoom: 1.5,
      pitch: 0,
      bearing: 0,
    },
    // Color each track *along its length* by the per-vertex SST carried in the
    // tile, so a buoy's ribbon warms (blue→red) as it drifts into warmer water
    // — e.g. the Gulf Stream's warm core reads red while its polar tail cools
    // to blue. `colorMappingDefault` is the gray used where a fix had no SST.
    tripGradient: {
      property: 'vertexValues',
      domain: [0, 30], // °C
      colors: [
        [44, 90, 200, 235],  // ≤ 0 °C  — deep blue
        [40, 180, 200, 235], // ~7.5 °C — teal
        [250, 210, 90, 235], // ~15 °C  — yellow
        [244, 140, 60, 235], // ~22 °C  — orange
        [220, 50, 47, 235],  // ≥ 30 °C — red
      ],
    },
    colorMappingDefault: [130, 130, 130, 170],
    opacity: 0.85,
    tripWidth: 1.5,
    widthMinPixels: 1,
    widthMaxPixels: 3,
    trailLength: 86400000 * 90, // ~90-day trail ≈ a few real seconds at 43yr/10min
    fadeTrail: true,
    zoomOverride: 0,
    useGlobalBounds: true,
    legend: {
      title: 'Sea-surface temperature',
      ramps: [
        {
          label: '0 → 30 °C',
          colors: ['#2C5AC8', '#28B4C8', '#FAD25A', '#F48C3C', '#DC322F'],
        },
      ],
    },
  },
  {
    // ── ECCO "Perpetual Ocean" — generate with:
    //   scripts/data-generation/ecco_advect.py --input <ecco-vel-dir> \
    //     --output examples/showcase/public/data/ecco-currents.stt
    // See scripts/data-generation/ECCO.md. The .stt is kept local (synced to
    // R2, not committed) like the other large archives. timeRange below tracks
    // the ECCO year you advected (default 2017); update both if you change it.
    id: 'ecco-currents',
    name: 'Modeled Ocean Currents',
    sources: ['noaa'],
    description: 'Virtual particles advected through NASA ECCO surface currents, shaded by current speed. Modeled companion to the drifter tracks. Source: NASA/JPL ECCO V4r4.',
    url: '/data/ecco-currents/manifest.json',
    type: 'trips',
    useGlobe: true,
    autoRotate: true,
    globeBackgroundColor: [240, 240, 236, 255],
    timeRange: {
      start: 1481889600000, // 2016-12-16 — first ECCO monthly field
      end: 1512993600000,   // 2017-12-11 — last advected vertex
    },
    // ~1 year over ~1 min; wide loader window + long trail so each current
    // ribbon persists a few real seconds.
    timeWindow: 86400000 * 30,
    targetPlaybackSeconds: 60,
    initialViewState: {
      longitude: -50, // Gulf Stream / North Atlantic gyre in view at open
      latitude: 30,
      zoom: 1.6,
      pitch: 0,
      bearing: 0,
    },
    // Color each ribbon along its length by per-vertex current speed (m/s):
    // slow interior waters read deep blue, swift western-boundary currents
    // (Gulf Stream, Kuroshio, Agulhas) flare yellow→red.
    // Monthly-mean 0.5° currents top out ~0.66 m/s (99th pct ~0.38), so the
    // ramp domain is pinned to [0, 0.6] for full color spread on real data.
    tripGradient: {
      property: 'vertexValues',
      domain: [0, 0.6], // m/s
      colors: [
        [12, 44, 132, 235],  // ~0 m/s    — calm interior, deep blue
        [34, 124, 190, 235], // ~0.15 m/s — blue
        [60, 200, 180, 235], // ~0.3 m/s  — teal
        [250, 210, 90, 235], // ~0.45 m/s — yellow
        [220, 50, 47, 235],  // ≥0.6 m/s  — fast jet, red
      ],
    },
    colorMappingDefault: [130, 130, 130, 170],
    opacity: 0.85,
    tripWidth: 1.5,
    widthMinPixels: 1,
    widthMaxPixels: 3,
    trailLength: 86400000 * 20, // ~20-day trail
    fadeTrail: true,
    zoomOverride: 0,
    useGlobalBounds: true,
    legend: {
      title: 'Current speed',
      ramps: [
        {
          label: '0 → 0.6 m/s',
          colors: ['#0C2C84', '#227CBE', '#3CC8B4', '#FAD25A', '#DC322F'],
        },
      ],
    },
  },
  {
    // ── OSM editing history — generate with:
    //   stt-generate osm-edits --source nodes --input <region.osh.pbf> \
    //     --bounds 40.49,-74.27,40.92,-73.68 --tagged-only --summary-tier \
    //     --output examples/showcase/public/data/osm-nyc-nodes.stt
    // The archive is kept local (not committed); see docs/guides/data-generation.md.
    id: 'osm-nyc-draw',
    name: 'OSM Editing — NYC',
    sources: ['osm'],
    description:
      'OpenStreetMap node creations in New York City, coloured by year. ' +
      '© OpenStreetMap contributors.',
    url: '/data/osm-nyc-nodes/manifest.json',
    type: 'point',
    // Force raw points at every zoom: the archive carries an H3 summary tier
    // (built for the overview), but that hexbin overlay obscures the
    // point-level "drawing" story, so this demo always renders raw creations.
    tier: 'raw',
    // "Draw and persist": points appear at their creation time and stay. The
    // loader window is widened automatically (DemoPage) so revealed tiles stay
    // resident; the GPU does the progressive reveal.
    cumulative: true,
    timeRange: {
      start: Date.parse('2007-01-01T00:00:00Z'),
      end: Date.parse('2026-01-01T00:00:00Z'),
    },
    timeWindow: 86400000 * 30, // overridden for cumulative datasets; kept for completeness
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    // ~2 weeks of sim-time "ink appearing" ramp as each node is revealed.
    fadeInDuration: 86400000 * 14,
    initialViewState: {
      longitude: -73.97,
      latitude: 40.72,
      zoom: 11,
      pitch: 0,
      bearing: 0,
    },
    colorProperty: 'year',
    colorMapping: OSM_YEAR_COLORS,
    colorMappingDefault: [150, 150, 150, 255],
    // World-space dots, mirrored from nyc-taxi-points: `radius` is in METERS so
    // node creations scale with zoom like real objects. No pixel floor
    // (radiusMinPixels: 0) → at the zoom-11 home view a 100 m dot reads ~1.7 px
    // (m/px ≈ 58 at lat 40.7, z11), so the millions of creations read as fine
    // line-work, then visibly grow into structure as you zoom in. A loose
    // radiusMaxPixels: 8 (vs the old tight 3) lets that world-space growth
    // actually show before capping a dense cluster from blobbing at deep zoom.
    radiusUnits: 'meters',
    radius: 7,
    radiusScale: 1,
    radiusMinPixels: 0,
    radiusMaxPixels: 8,
    legend: {
      title: 'Year created',
      ramps: [
        { label: '2007 → 2026', colors: ['#253494', '#41b6c4', '#78c679', '#fd8d3c', '#e31a1c'] },
      ],
    },
  },
  {
    // ── generate with:
    //   stt-generate osm-edits --source changesets \
    //     --input changesets-latest.osm.bz2 --bounds 40.49,-74.27,40.92,-73.68 \
    //     --summary-tier --output examples/showcase/public/data/osm-nyc-changesets.stt
    id: 'osm-nyc-changesets-summary',
    name: 'OSM Editing — NYC Activity (Hex)',
    description:
      'H3 hex-bin density of New York City OpenStreetMap changesets, 2007→2025. ' +
      'Toggle total edits vs sessions. © OpenStreetMap contributors (ODbL).',
    url: '/data/osm-nyc-changesets/manifest.json',
    type: 'summary',
    timeRange: {
      start: Date.parse('2007-01-01T00:00:00Z'),
      end: Date.parse('2026-01-01T00:00:00Z'),
    },
    timeWindow: 86400000 * 30, // matches the 30-day temporal bucket
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -73.97,
      latitude: 40.72,
      zoom: 10,
      pitch: 0,
      bearing: 0,
    },
    // Flat choropleth, not extruded: per-cell edit counts are brutally
    // heavy-tailed (res-10 p99≈1.3K, max≈37K per 30-day bucket), so
    // weight-proportional extrusion would throw single 30 km+ towers. Colour
    // alone reads cleanly and works for both toggle metrics.
    summaryExtruded: false,
    summaryCoverage: 0.9,
    summaryToggleWeights: [
      {
        id: 'edits',
        label: 'Edits',
        weightProperty: 'sum_num_changes',
        // Total edits per hex per 30-day bucket. Tuned to the real res-10
        // distribution (p90≈135, p95≈315, p99≈1345) for good mid-range spread.
        colorDomain: [1, 600],
        colorRange: [
          [12, 44, 64, 220],
          [22, 92, 110, 230],
          [38, 150, 160, 235],
          [90, 200, 180, 240],
          [170, 230, 200, 250],
          [224, 250, 235, 255],
        ],
        legendColors: ['#0c2c40', '#26ae9c', '#aae6c8', '#e0faeb'],
      },
      {
        id: 'sessions',
        label: 'Sessions',
        weightProperty: 'count',
        // Changeset count per hex per 30-day bucket — small numbers (res-10
        // p90≈2, p99≈6), so a tight domain gives the map real contrast.
        colorDomain: [1, 8],
        colorRange: [
          [28, 24, 64, 220],
          [60, 48, 130, 230],
          [104, 80, 188, 235],
          [150, 120, 224, 240],
          [196, 170, 244, 250],
          [232, 220, 252, 255],
        ],
        legendColors: ['#1c1840', '#6850bc', '#c4aaf4', '#e8dcfc'],
      },
    ],
    legend: {
      title: 'OSM editing activity (per hex)',
      ramps: [
        { label: 'Edits',    colors: ['#0c2c40', '#26ae9c', '#aae6c8', '#e0faeb'] },
        { label: 'Sessions', colors: ['#1c1840', '#6850bc', '#c4aaf4', '#e8dcfc'] },
      ],
    },
  },
  {
    // Same archive as osm-nyc-changesets-summary, rendered raw and coloured by
    // the editor "era" (the tooling story: Potlatch → JOSM → iD → StreetComplete).
    id: 'osm-nyc-changesets-editors',
    name: 'OSM Editing — NYC by Editor',
    description:
      'New York City OpenStreetMap changesets coloured by editor (Potlatch, ' +
      'JOSM, iD, StreetComplete…), 2007→2025. © OpenStreetMap contributors (ODbL).',
    url: '/data/osm-nyc-changesets/manifest.json',
    type: 'point',
    timeRange: {
      start: Date.parse('2007-01-01T00:00:00Z'),
      end: Date.parse('2026-01-01T00:00:00Z'),
    },
    timeWindow: 86400000 * 60, // 60-day rolling window of editing activity
    targetPlaybackSeconds: 60, // full time-range plays in ~1 min
    initialViewState: {
      longitude: -73.97,
      latitude: 40.72,
      zoom: 11,
      pitch: 0,
      bearing: 0,
    },
    colorProperty: 'editor',
    colorMapping: {
      Potlatch: [142, 68, 173, 255],
      JOSM: [41, 128, 185, 255],
      iD: [39, 174, 96, 255],
      Rapid: [26, 188, 156, 255],
      StreetComplete: [243, 156, 18, 255],
      'Go Map!!': [233, 30, 99, 255],
      Vespucci: [211, 84, 0, 255],
      'Maps.me': [127, 140, 141, 255],
      'Organic Maps': [127, 140, 141, 255],
      'bot/import': [149, 165, 166, 255],
      other: [189, 195, 199, 255],
    },
    colorMappingDefault: [189, 195, 199, 255],
    // World-space dots, mirrored from nyc-taxi-points: `radius` is in METERS so
    // changesets scale with zoom like real objects. No pixel floor
    // (radiusMinPixels: 0) → at the zoom-11 home view a 150 m dot reads ~2.6 px
    // (m/px ≈ 58 at lat 40.7, z11) and emerges/shrinks as you zoom.
    // radiusMaxPixels: 6 caps a dense cluster from ballooning at deep zoom.
    radiusUnits: 'meters',
    radius: 150,
    radiusScale: 1,
    radiusMinPixels: 0,
    radiusMaxPixels: 6,
    legend: {
      title: 'Editor',
      items: [
        { color: '#8e44ad', label: 'Potlatch' },
        { color: '#2980b9', label: 'JOSM' },
        { color: '#27ae60', label: 'iD' },
        { color: '#1abc9c', label: 'Rapid' },
        { color: '#f39c12', label: 'StreetComplete' },
        { color: '#e91e63', label: 'Go Map!!' },
        { color: '#95a5a6', label: 'bot / import' },
        { color: '#bdc3c7', label: 'other' },
      ],
    },
  },
];

// ── Camera-colored splat variants (AV scenes with cameras) ───────────────────
// The camera-equipped AV sources (Waymo done inline; nuScenes + Argoverse 2 here)
// can color their LIDAR from the imagery: a `-splat` bundle built with
// `--colorize` bakes per-point r/g/b (each return projected into the cameras),
// and the cockpit paints + soft-splats them (AnimatedPointLayer rgb + SplatExtension).
// Rather than hand-duplicate every scene, we DERIVE the variant from each base
// scene: same framing/streams, but the bundle path is `<id>-splat` and the RGB +
// splat flags are flipped on. Add a base id here once its `-splat` bundle is built.
const COLORED_SPLAT_BASE_IDS = new Set<string>([
  // Argoverse 2 (7 ring cameras) — colored bundles built with --colorize.
  'argoverse-02678d04', 'argoverse-02a00399', 'argoverse-0b5142c1',
  'argoverse-0bae3b5e', 'argoverse-25e5c600', 'argoverse-92b900b1',
  // nuScenes is NOT here: its `-splat` bundles were never built (no local dir,
  // nothing on R2), so listing it registered 10 scene-switcher entries whose
  // manifests 404'd everywhere. Build the bundles (--colorize) and sync them
  // before re-adding the ids.
]);

function makeColoredSplatVariant(base: Dataset): Dataset {
  const newId = `${base.id}-splat`;
  const rebase = (u: string) => u.replace(`/data/${base.id}/`, `/data/${newId}/`);
  const rebaseOpt = (u?: string) => (u ? rebase(u) : u);
  // Drop the height/semantic legend — meaningless for camera-colored points.
  const { legend: _legend, ...rest } = base;
  return {
    ...rest,
    id: newId,
    name: `${base.name} — camera splats`,
    description: `Camera-colored splat variant: each LIDAR return painted by projecting it into the cameras and sampling the pixel, then rendered as soft gaussian splats. ${base.description}`,
    url: rebase(base.url),
    avLidarUrl: rebaseOpt(base.avLidarUrl),
    avSceneUrl: rebaseOpt(base.avSceneUrl),
    avEgoUrl: rebaseOpt(base.avEgoUrl),
    avObjectsUrl: rebaseOpt(base.avObjectsUrl),
    avTracksUrl: rebaseOpt(base.avTracksUrl),
    avTelemetryUrl: rebaseOpt(base.avTelemetryUrl),
    avCamerasUrl: rebaseOpt(base.avCamerasUrl),
    avMapPolyUrl: rebaseOpt(base.avMapPolyUrl),
    avMapLineUrl: rebaseOpt(base.avMapLineUrl),
    lidarRgb: true,
    lidarSplat: true,
    // Drop the street basemap (even though these scenes ARE geo-registered): the
    // camera-colored cloud IS the scene, so the real road network underneath just
    // competes with it. The cloud then floats on the cockpit's dark backdrop.
    avLocalFrame: true,
    // Splats read best a touch larger + slightly transparent so overlaps blend.
    radius: 2.4,
    radiusMinPixels: 1.4,
    opacity: 0.96,
  };
}

const coloredSplatVariants: Dataset[] = rawDatasets
  .filter((d) => COLORED_SPLAT_BASE_IDS.has(d.id))
  .map(makeColoredSplatVariant);

// Scene-split ("stage + actors") variants, auto-derived from the AV2 + Waymo base
// scenes (built by {argoverse,waymo}_extract.py --scene-split → static/ + dynamic/).
// nuScenes is EXCLUDED: its 32-beam cloud is too sparse to reconstruct a stage.
const STAGE_BASE_IDS = new Set<string>([
  'argoverse-02678d04', 'argoverse-02a00399', 'argoverse-0b5142c1',
  'argoverse-0bae3b5e', 'argoverse-25e5c600', 'argoverse-92b900b1',
  'waymo-sf-day', 'waymo-sf-night', 'waymo-phx-day', 'waymo-phx-night',
  'waymo-phx-dusk-rain',
]);

function makeStageVariant(base: Dataset): Dataset {
  const newId = `${base.id}-stage`;
  const root = `/data/${newId}`;
  // Height/semantic legend is meaningless for the camera-colored surfel stage.
  const { legend: _legend, ...rest } = base;
  return {
    ...rest,
    id: newId,
    name: `${base.name} — stage + actors`,
    description: `Scene-split: the fixed environment reconstructed as a static surfel "stage" (every sweep accumulated, moving returns removed) as a persistent backdrop, with the dynamic cars / cyclists / pedestrians animated over it. ${base.description}`,
    // Two LIDAR archives: the animated DYNAMIC actors (primary) + the timeless STATIC
    // stage. avLidarUrl aliases the actors so single-stream cockpit code resolves.
    url: `${root}/dynamic/manifest.json`,
    avLidarUrl: `${root}/dynamic/manifest.json`,
    avDynamicUrl: `${root}/dynamic/manifest.json`,
    avStaticUrl: `${root}/static/manifest.json`,
    avSceneUrl: `${root}/scene.json`,
    avEgoUrl: `${root}/ego/manifest.json`,
    avObjectsUrl: `${root}/objects/manifest.json`,
    avTracksUrl: `${root}/tracks/manifest.json`,
    avTelemetryUrl: `${root}/telemetry.json`,
    avCamerasUrl: `${root}/cameras.json`,
    // HD-map archives only exist for AV2 (Waymo Perception ships none) — rebase if present.
    ...(base.avMapPolyUrl ? { avMapPolyUrl: `${root}/map_poly/manifest.json` } : {}),
    ...(base.avMapLineUrl ? { avMapLineUrl: `${root}/map_line/manifest.json` } : {}),
    // Surfel stage + actors render; clear any base point-mode flags.
    lidarRgb: true,
    lidarSurfel: true,
    lidarStage: true,
    lidarStageStatic: true,
    lidarSurfelTemporalSigma: 200, // actors move → tighter temporal smear
    lidarSplat: false,
    lidarIso: false,
    lidarIso3d: false,
    lidarWorldbuild: false,
  };
}

const stageVariants: Dataset[] = rawDatasets
  .filter((d) => STAGE_BASE_IDS.has(d.id))
  .map(makeStageVariant);

// Experimental AV cockpit render-modes held back from the shipped product (their
// tiles aren't deployed to R2, so a registered scene would 404 the toggle). The
// scene factories + registration blocks stay in source (so dev can build/iterate
// and a future ship just removes a suffix here), but they're filtered out of the
// runtime registry — `getDatasetById` won't resolve them, so the cockpit shows no
// Sweep (`-scan`) / Worldbuild (`-world`) toggle. SHIPPED: flat Iso-lines
// (`-iso`) and Iso 3D (`-iso3d`) — both intentionally NOT matched here. Drop a
// group from this pattern to ship that mode (after uploading its tiles +
// confirming license). NOTE: the scene-split Stage (`-stage`) mode SHIPPED
// 2026-06-21 for the 6 Argoverse cities (tiles R2-synced) — so it is NOT held
// back here. The Waymo `-stage` variants stay hidden on the remote deploy via
// WAYMO_LOCAL_ONLY below (their underlying LIDAR can't be redistributed).
const HELD_BACK_AV_MODES = /-(scan|world)$/;

// Waymo Open Dataset tiles are LOCAL-ONLY: the license is non-commercial AND
// prohibits redistribution, so no waymo-* bundle is ever uploaded to R2. The
// scenes stay registered for local dev — which serves `public/data` directly and
// CAN render them — but are filtered out whenever tiles are served remotely
// (`VITE_DATA_BASE_URL` set = the R2 deploy, where the bundles don't exist), so
// the public site never references (and 404s) a Waymo scene in the catalog,
// scene switcher, or `/drive/:id` route. Drop this gate only after the license
// clears a public sync (and the tiles are actually on R2). This also keeps the
// Waymo scene-split `-stage` variants local: they match `^waymo-`, so they're
// filtered on the remote deploy even though the Argoverse `-stage` mode shipped.
const WAYMO_LOCAL_ONLY = /^waymo-/;

// (2026-07-02) Every registered non-Waymo dataset resolves remotely: the BIXI
// demos (streets-flow / corridors / points / live via its bixi-live-flow stem)
// AND the six Argoverse `-lod` zoom-LOD variants are R2-synced — all verified
// 200 on tiles.poopdeck.gl. If a future dataset is registered before its
// archives are synced, reintroduce the LOCAL_ONLY_DATASETS gate: filter its id
// whenever DATA_IS_REMOTE so the public site never links (and 404s) it.
// CAUTION: AV scene bundles have NO top-level manifest — to verify one on R2,
// probe `<base>/data/<stem>/lidar/manifest.json` (the cockpit's entry URL),
// never `<stem>/manifest.json`; the latter 404s even for live scenes.
const DATA_IS_REMOTE = DATA_BASE_URL !== '';

export const datasets: Dataset[] = [...rawDatasets, ...coloredSplatVariants, ...stageVariants]
  .filter((d) => !HELD_BACK_AV_MODES.test(d.id))
  .filter((d) => !(DATA_IS_REMOTE && WAYMO_LOCAL_ONLY.test(d.id)))
  .map((d) => ({
  ...d,
  url: resolveDataUrl(d.url),
  // The composite `radar` type carries two extra manifest URLs; rewrite them
  // through the same VITE_DATA_BASE_URL resolver or they 404 on the R2 deploy
  // while the primary field manifest loads.
  ...(d.radarCellsUrl && { radarCellsUrl: resolveDataUrl(d.radarCellsUrl) }),
  ...(d.radarTracksUrl && { radarTracksUrl: resolveDataUrl(d.radarTracksUrl) }),
  // The composite `av` type carries the scene manifest, two overlay archive
  // manifests, and two sidecar JSONs; rewrite all of them through the same
  // VITE_DATA_BASE_URL resolver so they don't 404 on the R2 deploy.
  ...(d.avSceneUrl && { avSceneUrl: resolveDataUrl(d.avSceneUrl) }),
  ...(d.avLidarUrl && { avLidarUrl: resolveDataUrl(d.avLidarUrl) }),
  // Scene-split ("stage + actors") carries two extra LIDAR archive manifests.
  ...(d.avStaticUrl && { avStaticUrl: resolveDataUrl(d.avStaticUrl) }),
  ...(d.avDynamicUrl && { avDynamicUrl: resolveDataUrl(d.avDynamicUrl) }),
  ...(d.avEgoUrl && { avEgoUrl: resolveDataUrl(d.avEgoUrl) }),
  ...(d.avObjectsUrl && { avObjectsUrl: resolveDataUrl(d.avObjectsUrl) }),
  ...(d.avTracksUrl && { avTracksUrl: resolveDataUrl(d.avTracksUrl) }),
  ...(d.avTelemetryUrl && { avTelemetryUrl: resolveDataUrl(d.avTelemetryUrl) }),
  ...(d.avCamerasUrl && { avCamerasUrl: resolveDataUrl(d.avCamerasUrl) }),
  ...(d.avMapPolyUrl && { avMapPolyUrl: resolveDataUrl(d.avMapPolyUrl) }),
  ...(d.avMapLineUrl && { avMapLineUrl: resolveDataUrl(d.avMapLineUrl) }),
}));

export function getDatasetById(id: string): Dataset | undefined {
  return datasets.find(d => d.id === id);
}

/**
 * The curated set shipped on `npm run build`, in navigation order. The full
 * `datasets` array above stays intact so dev (`npm run dev`) keeps every demo;
 * only the navigation surface is trimmed in production. Routing still resolves
 * any id via `getDatasetById`, so old deep-links keep working in dev.
 */
export const SHIPPED_DATASET_IDS: string[] = [
  'ocean-drifters',     // Ocean Currents — surface-drifter tracks (observed)
  'ecco-currents',      // Modeled Ocean Currents — ECCO advected particles
  'nyc-taxi-points',    // NYC Taxi Points — trip-heads layer, full nyc-taxi-paths.stt
  'nyc-taxi-trips',     // NYC Yellow Cab Trips
  'osm-nyc-draw',       // OSM Editing — NYC (cumulative "draw")
  'ship-traffic',       // US Maritime Traffic — vessel points
  // After the first 6 (the home-page grid is `navDatasets.slice(0, 6)`), so
  // it lands in navigation without bumping a grid card.
  'nyc-taxi-flows',     // NYC Taxi Flow — pre-aggregated overview corridors
  'storm-radar',        // Iowa Derecho — NEXRAD radar composite (field+cells+tracks)
];

export const shippedDatasets: Dataset[] = SHIPPED_DATASET_IDS
  .map((id) => datasets.find((d) => d.id === id))
  .filter((d): d is Dataset => Boolean(d));

/**
 * Datasets surfaced in the showcase (the Overview grid). This curated demo
 * shows the same emphasized set in dev and prod so `localhost` matches the
 * deploy. Every dataset still resolves by id via `getDatasetById`, so deep-links
 * to the non-emphasized demos keep working.
 */
export const navDatasets: Dataset[] = shippedDatasets;
