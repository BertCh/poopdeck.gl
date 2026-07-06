/**
 * Editorial metadata for the demo catalog (`/demos`) and per-demo landing
 * pages (`/demos/:id`).
 *
 * Curation contract: a dataset appears in the catalog IF AND ONLY IF it has an
 * entry here. The runtime `Dataset` registry (`src/datasets.ts`) is untouched —
 * excluded datasets still resolve by id and render at `/demo/:id`; they just
 * aren't surfaced. `test/demo-meta-contract.test.ts` enforces the invariants
 * (ids resolve, doc links exist on disk, related ids are catalog members, the
 * deliberately-excluded set stays excluded).
 */

import { datasets, getDatasetById, SHIPPED_DATASET_IDS } from '../datasets';
import type { Dataset } from '../types';

export type DemoCategory = 'earth-ocean' | 'mobility' | 'built-life';

export const CATEGORY_ORDER: DemoCategory[] = ['earth-ocean', 'mobility', 'built-life'];

export const CATEGORY_LABELS: Record<DemoCategory, string> = {
  'earth-ocean': 'Earth & ocean',
  mobility: 'Mobility',
  'built-life': 'Built world & life',
};

export const CATEGORY_BLURBS: Record<DemoCategory, string> = {
  'earth-ocean':
    'Currents, storms, quakes and fire — the planet observed and modeled over years to decades.',
  mobility:
    'Ships, aircraft, half a million taxi trips and a year of animal migration — dense trajectory data at street to continental scale.',
  'built-life':
    'Two decades of OpenStreetMap editing — the mapped world, drawn one node and changeset at a time.',
};

export interface DemoTechnique {
  /** Display label, e.g. "AnimatedTripsLayer". */
  label: string;
  /** In-app docs route, e.g. "/docs/api/animated-trips-layer". */
  docPath: string;
}

export interface DemoDataSource {
  name: string;
  url: string;
  license?: string;
  note?: string;
}

export interface DemoMeta {
  category: DemoCategory;
  /** Short card tagline; catalog cards fall back to dataset.description. */
  tagline?: string;
  /** Technique chip on cards, e.g. "Trips · gradient", "Moving heads", "H3 summary". */
  techniqueTag: string;
  /** "About this demo" — 2–3 paragraphs of plain prose. */
  about: string[];
  dataSources: DemoDataSource[];
  /** Exact reproduction command; omitted for frozen fixtures (see buildNote). */
  buildCommand?: string;
  /** Caveat or context for the build (OSRM setup, gated inputs, no recipe…). */
  buildNote?: string;
  techniques: DemoTechnique[];
  /** Dataset ids of related demos (must be catalog members; no self-reference). */
  related: string[];
}

/**
 * Datasets deliberately kept OUT of the catalog. Re-including one means
 * deleting it from this list and adding a DEMO_META entry — a reviewed act,
 * enforced by the contract test.
 *
 *  - satellites: z0 tile is 17MB at the archive's floor zoom — the one true
 *    primary-zoom stall; re-add after the --temporal-bucket rebuild.
 *  - flight-paths: synthetic tracks, no source or recipe.
 *  - nyc-taxi-paths: 60× temporal over-fetch on its window; visually
 *    superseded by nyc-taxi-trips on the same archive.
 *  - nyc-taxi-heads: exact duplicate of nyc-taxi-points (same archive/config).
 *  - nyc-rideshare: near-duplicate of nyc-taxi-points (straight-line
 *    trajectories vs OSRM-routed); its archive still powers the cube/heatmap.
 */
export const CATALOG_EXCLUDED_IDS: string[] = [
  'satellites',
  'flight-paths',
  'nyc-taxi-paths',
  'nyc-taxi-heads',
  'nyc-rideshare',
  // The other nine nuScenes mini scenes. The cockpit SceneSwitcher lists every
  // `type:'av'` dataset, so all ten are reachable at /drive/<id> and switchable
  // in-cockpit; the /demos catalog shows the single headline card (nuscenes-0103)
  // rather than ten near-identical nuScenes cards.
  'nuscenes-0061',
  'nuscenes-0553',
  'nuscenes-0655',
  'nuscenes-0757',
  'nuscenes-0796',
  'nuscenes-0916',
  'nuscenes-1077',
  'nuscenes-1094',
  'nuscenes-1100',
  // The other five Argoverse 2 cities (the headline card is argoverse-02678d04,
  // Pittsburgh). Same treatment as nuScenes: every `type:'av'` dataset is
  // reachable at /drive/<id> + switchable in the cockpit SceneSwitcher, so the
  // /demos catalog shows one AV2 card rather than six near-identical ones.
  'argoverse-02a00399', // Miami
  'argoverse-0b5142c1', // Washington DC
  'argoverse-0bae3b5e', // Detroit
  'argoverse-25e5c600', // Palo Alto
  'argoverse-92b900b1', // Austin
  // The other four Waymo scenes (the headline card is waymo-sf-day, dense SF
  // daytime). Same treatment as nuScenes/AV2: every `type:'av'` dataset is
  // reachable at /drive/<id> + switchable in the cockpit, so the /demos catalog
  // shows one Waymo card rather than five near-identical ones.
  'waymo-phx-day',
  'waymo-phx-night',
  'waymo-sf-night',
  'waymo-phx-dusk-rain',
  // Camera-colored / surfel render VARIANTS of base AV scenes (same segment,
  // alternate LIDAR rendering). These are no longer separate scenes: the cockpit
  // folds them into a per-scene render-mode toggle (Points / Splat / Surfel) that
  // swaps to the variant's `-splat` / `-surfel` bundle. So they're catalog- AND
  // switcher-excluded — the headline card + switcher keep the base scene; the
  // toggle reaches the variant (legacy /drive/<id>-splat deep-links still work).
  'waymo-sf-day-splat',
  // Waymo oriented-surfel variants — all five scenes ship one; reached via the
  // cockpit's Surfel render-mode toggle, not a separate card (only sf-day was
  // listed originally).
  'waymo-sf-day-surfel',
  'waymo-phx-day-surfel',
  'waymo-phx-night-surfel',
  'waymo-sf-night-surfel',
  'waymo-phx-dusk-rain-surfel',
  'waymo-sf-day-surfel-adaptive', // local geometry-aware-decimation A/B experiment
  'waymo-sf-day-iso', // density iso-line render variant (--contours)
  // TRUE-3D density iso-line variants (--contours --contour-z-step), all 5 Waymo
  // scenes — reached via the cockpit's "Iso 3D" render-mode toggle, not a card.
  'waymo-sf-day-iso3d',
  'waymo-phx-day-iso3d',
  'waymo-phx-night-iso3d',
  'waymo-sf-night-iso3d',
  'waymo-phx-dusk-rain-iso3d',
  // FLAT high-XY-res density iso-lines (the "Iso-lines" overview pill), all 5
  // Waymo scenes (sf-day's was listed earlier).
  'waymo-phx-day-iso',
  'waymo-phx-night-iso',
  'waymo-sf-night-iso',
  'waymo-phx-dusk-rain-iso',
  // nuScenes camera-splat variants (`--colorize` bundles, makeColoredSplatVariant).
  'nuscenes-0061-splat',
  'nuscenes-0103-splat',
  'nuscenes-0553-splat',
  'nuscenes-0655-splat',
  'nuscenes-0757-splat',
  'nuscenes-0796-splat',
  'nuscenes-0916-splat',
  'nuscenes-1077-splat',
  'nuscenes-1094-splat',
  'nuscenes-1100-splat',
  // Argoverse 2 camera-splat variants (`--colorize` bundles).
  'argoverse-02678d04-splat',
  'argoverse-02a00399-splat',
  'argoverse-0b5142c1-splat',
  'argoverse-0bae3b5e-splat',
  'argoverse-25e5c600-splat',
  'argoverse-92b900b1-splat',
  // Argoverse 2 oriented-surfel variants (`--surfel` bundles) — each reached via
  // the cockpit's Surfel render-mode toggle on its city scene, not a separate
  // card (same treatment as the Waymo surfel variant). All six cities now ship a
  // surfel bundle; only Miami was listed here originally.
  'argoverse-02678d04-surfel', // Pittsburgh
  'argoverse-02a00399-surfel', // Miami
  'argoverse-0b5142c1-surfel', // Washington DC
  'argoverse-0bae3b5e-surfel', // Detroit
  'argoverse-25e5c600-surfel', // Palo Alto
  'argoverse-92b900b1-surfel', // Austin
  // Argoverse 2 TRUE-3D density iso-line variants (--contours --contour-z-step),
  // all six cities — reached via the cockpit's "Iso 3D" render-mode toggle.
  'argoverse-02678d04-iso3d', // Pittsburgh
  'argoverse-02a00399-iso3d', // Miami
  'argoverse-0b5142c1-iso3d', // Washington DC
  'argoverse-0bae3b5e-iso3d', // Detroit
  'argoverse-25e5c600-iso3d', // Palo Alto
  'argoverse-92b900b1-iso3d', // Austin
  // Argoverse 2 FLAT density iso-lines (the "Iso-lines" overview pill), all 6 cities.
  'argoverse-02678d04-iso', // Pittsburgh
  'argoverse-02a00399-iso', // Miami
  'argoverse-0b5142c1-iso', // Washington DC
  'argoverse-0bae3b5e-iso', // Detroit
  'argoverse-25e5c600-iso', // Palo Alto
  'argoverse-92b900b1-iso', // Austin
  // Scene-split "stage + actors" variants (makeStageVariant), AV2 + Waymo. Reached
  // via the cockpit render-mode toggle, not a catalog card (so catalog-excluded).
  // The 6 Argoverse stages SHIPPED (R2-synced); the Waymo stages stay local via
  // WAYMO_LOCAL_ONLY (no-redistribution). Either way the contract requires them
  // to be classified here.
  'argoverse-02678d04-stage', // Pittsburgh
  'argoverse-02a00399-stage', // Miami
  'argoverse-0b5142c1-stage', // Washington DC
  'argoverse-0bae3b5e-stage', // Detroit
  'argoverse-25e5c600-stage', // Palo Alto
  'argoverse-92b900b1-stage', // Austin
  'waymo-sf-day-stage',
  'waymo-sf-night-stage',
  'waymo-phx-day-stage',
  'waymo-phx-night-stage',
  'waymo-phx-dusk-rain-stage',
  // Additive-octree zoom-LOD variants (one archive, each return at a single home
  // zoom). Reached via the cockpit's "Zoom LOD" render-mode toggle, not a catalog
  // card — same treatment as the other render variants above. AV2 (6) + Waymo (5).
  'argoverse-02678d04-lod', // Pittsburgh
  'argoverse-02a00399-lod', // Miami
  'argoverse-0b5142c1-lod', // Washington DC
  'argoverse-0bae3b5e-lod', // Detroit
  'argoverse-25e5c600-lod', // Palo Alto
  'argoverse-92b900b1-lod', // Austin
  'waymo-sf-day-lod',
  'waymo-sf-night-lod',
  'waymo-phx-day-lod',
  'waymo-phx-night-lod',
  'waymo-phx-dusk-rain-lod',
];

const OSRM_NOTE =
  'Trips are routed through OSRM (OpenStreetMap road network). The processed ' +
  'OSRM graph is staged in scripts/data-generation/osrm-data/ — start it with ' +
  '`cd scripts/data-generation && ./setup-osrm.sh run` (Docker) before building.';

export const DEMO_META: Record<string, DemoMeta> = {
  // ── Earth & ocean ────────────────────────────────────────────────────────
  'ocean-drifters': {
    category: 'earth-ocean',
    tagline: '43 years of satellite-tracked surface buoys, shaded by sea-surface temperature.',
    techniqueTag: 'Trips · SST gradient · globe',
    about: [
      'Since 1979 the Global Drifter Program has deployed satellite-tracked surface buoys across the oceans. Each buoy reports its position and the surrounding water temperature as currents carry it. Their tracks trace ocean circulation: gyres, boundary currents, and the drift between them.',
      'Each ribbon is one buoy. Color is per-vertex sea-surface temperature: a track shifts from blue to red as the buoy enters warmer water. The full 43-year record streams as spatiotemporal tiles and plays in about two minutes.',
      'This demo is also a data story: "Adrift" walks through the program’s history on a scroll-driven globe.',
    ],
    dataSources: [
      {
        name: 'NOAA Global Drifter Program (AOML)',
        url: 'https://www.aoml.noaa.gov/phod/gdp/',
        license: 'Public domain (US Gov)',
        note: 'PMEL 6-hourly interpolated product; record used here ends Oct 2022.',
      },
    ],
    buildCommand:
      'stt-generate drifters --start 1979-01-01 --end 2022-11-01 \\\n' +
      '  --temporal-bucket 7d --max-zoom 4',
    buildNote:
      'The generator default is 2021-only; the explicit range pulls the full ' +
      '1979→2022 GDP record. Per-fix sea-surface temperature is emitted as ' +
      'per-vertex values to drive the color ramp.',
    techniques: [
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'Binary features (per-vertex values)', docPath: '/docs/api/binary-features' },
      { label: 'SpatiotemporalTileset', docPath: '/docs/api/spatiotemporal-tileset' },
    ],
    related: ['ecco-currents', 'ship-traffic', 'animal-migration'],
  },

  'ecco-currents': {
    category: 'earth-ocean',
    tagline: 'Virtual particles advected through NASA ECCO model currents — the modeled twin of the drifters.',
    techniqueTag: 'Trips · speed gradient · globe',
    about: [
      'The modeled companion to the drifter demo. NASA/JPL’s ECCO state estimate reconstructs global ocean circulation; here thousands of virtual particles are advected through its surface velocity fields for a year and rendered as ribbons.',
      'Each ribbon is shaded along its length by current speed: slow interior waters blue, fast western-boundary currents (Gulf Stream, Kuroshio, Agulhas) yellow to red. Played next to the drifters, it is a model-versus-observation comparison.',
    ],
    dataSources: [
      {
        name: 'NASA/JPL ECCO V4r4',
        url: 'https://ecco-group.org/',
        license: 'Open (NASA Earth science data)',
        note: 'Monthly-mean surface velocity fields (EVEL/NVEL), 2017.',
      },
    ],
    buildCommand:
      'python scripts/data-generation/ecco_advect.py \\\n' +
      '  --input <ecco-velocity-dir> --output ecco-currents.stt',
    buildNote:
      'A Python particle-advection preprocessor, not a Rust generator — see ' +
      'scripts/data-generation/ECCO.md for setup and the advection parameters.',
    techniques: [
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'Binary features (per-vertex values)', docPath: '/docs/api/binary-features' },
    ],
    related: ['ocean-drifters', 'ship-traffic'],
  },

  'earthquake-activity': {
    category: 'earth-ocean',
    tagline: 'Five years of global M4+ seismicity tracing the plate boundaries.',
    techniqueTag: 'Points · magnitude',
    about: [
      'Every magnitude-4.0+ earthquake recorded by the USGS between 2020 and 2024 — tens of thousands of events. Played back, they outline the tectonic plate boundaries: the Pacific Ring of Fire, the mid-Atlantic ridge, the Alpide belt through the Himalaya.',
      'Marker size scales with magnitude and color steps through magnitude bands, so M7+ events read large and dark red against the smaller M4s. A 30-day rolling window keeps the map legible across the five-year span.',
    ],
    dataSources: [
      {
        name: 'USGS Earthquake Catalog (ComCat)',
        url: 'https://earthquake.usgs.gov/earthquakes/search/',
        license: 'Public domain (US Gov)',
      },
    ],
    buildCommand: 'stt-generate earthquakes --output earthquakes-v2.stt',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'CategoryColorExtension', docPath: '/docs/api/category-color-extension' },
    ],
    related: ['wildfires', 'hurricanes'],
  },

  'earthquake-columns': {
    category: 'earth-ocean',
    tagline: 'The same seismic catalog, stood up as 3D columns — bar height is magnitude.',
    techniqueTag: 'Columns · 3D extrusion',
    about: [
      'The earthquake catalog from the points demo, rendered a second way: every event is an extruded column whose height is its magnitude. The columns give the Ring of Fire relief — dense spikes along the subduction zones, the largest quakes tallest.',
      'It reuses the same archive as the points demo — nothing was rebuilt; only the layer changed. `AnimatedColumnLayer` reads the numeric `magnitude` column as per-feature elevation, and the shared time filter fades columns in and out across a 30-day rolling window.',
    ],
    dataSources: [
      {
        name: 'USGS Earthquake Catalog (ComCat)',
        url: 'https://earthquake.usgs.gov/earthquakes/search/',
        license: 'Public domain (US Gov)',
      },
    ],
    buildCommand: 'stt-generate earthquakes --output earthquakes-v2.stt',
    buildNote:
      'Reuses the earthquake-activity archive — only the render layer differs ' +
      '(AnimatedColumnLayer with magnitude → column height). No rebuild needed.',
    techniques: [
      { label: 'AnimatedColumnLayer', docPath: '/docs/api/animated-column-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['earthquake-activity', 'hurricanes', 'wildfires'],
  },

  'storm-radar': {
    category: 'earth-ocean',
    tagline:
      'The 2020 Iowa derecho rebuilt from raw NEXRAD radar — reflectivity bands, storm cells, and tracks, all baked at build time.',
    techniqueTag: 'Radar · 3-layer composite',
    about: [
      'On 10 August 2020 a derecho — a long-lived line of thunderstorms — moved east across the Midwest, organizing into a bow echo and causing damage from eastern Nebraska through Iowa with 100+ mph winds. This demo reconstructs that afternoon from the raw NOAA NEXRAD Level II archive of three radar sites (Omaha, Des Moines, Quad Cities), mosaicked into one field.',
      'All processing happens at build time, in Rust. Each radar volume is decoded from its polar sweeps, every gate reprojected to lon/lat with the 4/3-earth beam model, the three sites max-combined onto a common grid per 5-minute scan, the grid contoured into filled NWS-palette reflectivity bands, and a SCIT-style tracker links storm cells across scans into tracks. The browser renders finished vector tiles.',
      'Three STT archives drive one composite render: contour bands (`AnimatedPolygonLayer`, colored by categorical `dbz_band`) are the precipitation field; storm-cell centroids (`AnimatedPointLayer`) mark the cores; cell tracks (`AnimatedTripsLayer`) trail behind each cell, shaded by intensity over time.',
    ],
    dataSources: [
      {
        name: 'NOAA NEXRAD Level II (Unidata AWS archive)',
        url: 'https://registry.opendata.aws/noaa-nexrad/',
        license: 'Public domain (US Gov)',
        note: 'Bucket unidata-nexrad-level2, sites KOAX / KDMX / KDVN, 2020-08-10.',
      },
    ],
    buildCommand:
      'stt-generate storms --sites KOAX,KDMX,KDVN --start-hour 16 --end-hour 22 --scan-stride 2',
    buildNote:
      'Downloads ~1–2 GB of Level II volumes from the public AWS bucket (no ' +
      'credentials) on first run, caching to --cache-dir; re-run with ' +
      '--no-download to rebuild tiles from the cache. Writes three archives: ' +
      'storm-field, storm-cells, storm-tracks.',
    techniques: [
      { label: 'AnimatedPolygonLayer', docPath: '/docs/api/animated-polygon-layer' },
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['hurricanes', 'wildfires', 'earthquake-activity'],
  },

  // ── Mobility ───────────────────────────────────────────────────────────
  'av-synthetic': {
    category: 'mobility',
    tagline:
      'A streetscape.gl-style cockpit for an autonomous-vehicle drive — LIDAR, tracked objects, the ego path, and CAN gauges.',
    techniqueTag: 'AV cockpit · 3-layer composite',
    about: [
      'Autonomous-vehicle logs are among the densest spatiotemporal data: a spinning LIDAR returns hundreds of thousands of 3D points per second, a perception stack tracks each car and pedestrian as an oriented 3D box, the vehicle records its pose, and the CAN bus streams speed, steering, and acceleration many times a second. This demo packages one 20-second drive as spatiotemporal tiles and replays it in a streetscape.gl-style (avs.auto) cockpit on a real basemap.',
      'Three STT archives compose into one render: an accumulated LIDAR point cloud (`AnimatedPointLayer`, colored by categorical `height_band`); the ego trajectory (`AnimatedTripsLayer`); and tracked objects as oriented extruded boxes (`AnimatedBoundingBoxLayer`, colored by class). The cockpit at `/drive/av-synthetic` adds a stream list, radial CAN-bus gauges, a timeline scrubber, and a camera inset, all on the same playback clock.',
      'This scene is synthetic — generated offline with no external download, so the cockpit is runnable without any data access. The same bundle layout is produced by adapters for real datasets (nuScenes, comma.ai, Argoverse 2), which georeference each scene’s local frame onto a documented lat/lon origin.',
    ],
    dataSources: [
      {
        name: 'Synthetic AV scene (generated offline)',
        url: 'https://avs.auto/',
        license: 'Synthetic — no external data',
        note: 'Procedurally generated by av_synthetic.py; same bundle layout the nuScenes / comma.ai / Argoverse adapters emit.',
      },
    ],
    buildCommand:
      'python scripts/data-generation/av_synthetic.py --out examples/showcase/public/data/av-synthetic',
    buildNote:
      'No external download or login. Writes a full AV scene bundle (scene.json, ' +
      'lidar/ego/objects STT archives, telemetry.json, cameras.json) under ' +
      'public/data/av-synthetic/. Open the cockpit at /drive/av-synthetic.',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'AnimatedColumnLayer', docPath: '/docs/api/animated-column-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['nyc-taxi-trips', 'ship-traffic', 'nyc-od-arcs'],
  },

  'nuscenes-0103': {
    category: 'mobility',
    tagline:
      'A real nuScenes drive — the fullest cockpit: LIDAR, tracked 3D boxes, CAN gauges, and a front camera in Boston.',
    techniqueTag: 'AV cockpit · all streams',
    about: [
      'nuScenes (Motional) is a reference multimodal autonomous-driving dataset: a 32-beam LIDAR, six cameras, radar, GPS/IMU, and the full CAN bus, with 1.4 million hand-annotated 3D boxes across Boston and Singapore. This is one 20-second v1.0-mini scene in Boston Seaport; all ten mini scenes (Boston + Singapore, day and night) are in the cockpit — switch between them from the scene picker.',
      'The cockpit at `/drive/nuscenes-0103` composes the accumulated LIDAR cloud — colored by per-point nuScenes-lidarseg semantic class (cars orange, people blue, road grey, canopy green) — the ego trail, tracked objects as oriented 3D boxes colored by class, radial CAN gauges (speed / steering / throttle / brake), and a front-camera inset, all on one playback clock, georeferenced onto a Boston basemap from the map’s documented origin.',
      'Built by `nuscenes_extract.py` from the login-gated v1.0-mini + CAN-bus expansion + map-expansion + lidarseg, with the LIDAR decimated to ~174k points and each return tagged with its semantic class.',
    ],
    dataSources: [
      {
        name: 'nuScenes (Motional)',
        url: 'https://www.nuscenes.org/nuscenes',
        license: 'CC BY-NC-SA 4.0',
        note: 'v1.0-mini (all 10 scenes), Boston Seaport + Singapore, plus the CAN-bus, ' +
          'map-expansion, and lidarseg extensions.',
      },
    ],
    buildCommand:
      'python scripts/data-generation/nuscenes_extract.py --dataroot ./nuscenes-data --version v1.0-mini --scene scene-0103 --out examples/showcase/public/data/nuscenes-0103',
    buildNote:
      'Requires a free (login-gated) nuScenes account: download v1.0-mini.tgz + can_bus.zip + ' +
      'the map-expansion + lidarseg-mini archives, unpack to ./nuscenes-data/, then extract ' +
      '(repeat --scene scene-XXXX for the other nine scenes). Open the cockpit at ' +
      '/drive/nuscenes-0103.',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'AnimatedColumnLayer', docPath: '/docs/api/animated-column-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['av-synthetic', 'argoverse-02678d04', 'comma-280-1641'],
  },

  'argoverse-02678d04': {
    category: 'mobility',
    tagline:
      'Real Argoverse 2 sensor logs across six US cities — LIDAR, tracked 3D boxes, HD-map lanes, camera + telemetry.',
    techniqueTag: 'AV cockpit · real LIDAR',
    about: [
      'Real autonomous-vehicle logs from Argoverse 2 — ~16-second drives captured by a 64-beam LIDAR rig with a full perception stack. One scene per AV2 city ships (Pittsburgh, Miami, Austin, Detroit, Palo Alto, Washington DC); switch between them in the cockpit. Every LIDAR return, tracked car / pedestrian / cyclist box, the HD map, and the ego pose are georeferenced from each city’s coordinate frame (via the AV2 devkit CRS) onto a real basemap and served as spatiotemporal tiles.',
      'The cockpit at `/drive/argoverse-02678d04` composes the full stream set on one playback clock: the accumulated LIDAR cloud (colored by height band), the ego trail, tracked objects as oriented 3D boxes, the HD-map substrate (lane boundaries + centerlines + drivable areas + crosswalks), a ring-camera inset, and a telemetry gauge panel. Argoverse logs carry no CAN bus, so speed / acceleration / yaw-rate / heading are derived from the ego pose.',
      'Built by `argoverse_extract.py` (driven by `argoverse_batch.sh`) from public sensor logs pulled with no auth from the Argoverse AWS Open Data bucket; each scene is decimated to ~190k LIDAR points and drops zero-point (occluded) GT boxes.',
    ],
    dataSources: [
      {
        name: 'Argoverse 2 Sensor Dataset',
        url: 'https://www.argoverse.org/av2.html',
        license: 'CC BY-NC-SA 4.0',
        note: 'One val-split log per city, s3://argoverse/datasets/av2/sensor (no login).',
      },
    ],
    buildCommand:
      'bash scripts/data-generation/argoverse_batch.sh   # 1 scene per AV2 city (6 total)',
    buildNote:
      'The batch driver selectively pulls each log (lidar + ego + annotations + map + ' +
      'one ring camera) with `aws s3 cp --no-sign-request`, extracts, and deletes the ' +
      'raw log. Open the cockpit at /drive/argoverse-02678d04 (switch cities in-cockpit).',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'AnimatedColumnLayer', docPath: '/docs/api/animated-column-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['av-synthetic', 'comma-280-1641', 'nuscenes-0103'],
  },

  'waymo-sf-day': {
    category: 'mobility',
    tagline:
      'Real Waymo Open Dataset perception scenes — 5-laser LIDAR, tracked 3D boxes with real velocity, camera + telemetry, across SF & Phoenix, day & night (+ rain).',
    techniqueTag: 'AV cockpit · real LIDAR',
    about: [
      'Real autonomous-vehicle segments from the Waymo Open Dataset — ~20-second drives captured by a 5-laser LIDAR rig (one 64-beam mid-range top sensor + four short-range) and a full perception stack. Five curated scenes ship — daytime San Francisco, daytime and night Phoenix, night San Francisco, and one dawn/dusk rain scene — switchable in the cockpit. Every LIDAR return, tracked vehicle / pedestrian / cyclist box (with Waymo’s per-box velocity), and the ego pose are served as spatiotemporal tiles.',
      'The cockpit at `/drive/waymo-sf-day` composes the streams on one playback clock: the accumulated LIDAR cloud (colored by height band), the ego trail, tracked objects as oriented 3D boxes with velocity arrows, a front-camera inset, and a telemetry gauge panel. Waymo Perception carries no CAN bus, so speed / acceleration / yaw-rate / heading are derived from the ego pose. Waymo discloses no georeferencing and the v2.0.1 release ships no HD map, so each scene is anchored to an approximate local frame on a neutral basemap.',
      'Built by `waymo_extract.py` (driven by `waymo_batch.sh`) from the modular Parquet release (v2.0.1): the components are read with pyarrow and the LIDAR range images are decoded to a point cloud in pure numpy — no TensorFlow / waymo-open-dataset library. Each scene is decimated to ~400k LIDAR points and drops zero-point (occluded) GT boxes.',
    ],
    dataSources: [
      {
        name: 'Waymo Open Dataset (Perception v2.0.1)',
        url: 'https://waymo.com/open/',
        license: 'Waymo Dataset License Agreement (non-commercial)',
        note: 'Curated validation-split segments, gs://waymo_open_dataset_v_2_0_1 (license-gated).',
      },
    ],
    buildCommand:
      'bash scripts/data-generation/waymo_batch.sh   # 5 curated scenes (SF/PHX, day/night, +rain)',
    buildNote:
      'Accept the Waymo Dataset License Agreement (non-commercial, no redistribution) ' +
      'at waymo.com/open, then `gcloud auth login`. The batch driver pulls only the ' +
      'components the cockpit needs per segment, decodes the range images in numpy, and ' +
      'builds the bundle. Open the cockpit at /drive/waymo-sf-day (switch scenes in-cockpit).',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'AnimatedColumnLayer', docPath: '/docs/api/animated-column-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['av-synthetic', 'argoverse-02678d04', 'nuscenes-0103'],
  },

  'comma-280-1641': {
    category: 'mobility',
    tagline:
      'A real comma.ai dashcam drive — GPS path + live CAN-bus gauges on California I-280.',
    techniqueTag: 'AV cockpit · CAN telemetry',
    about: [
      'comma.ai’s comma2k19 is 33 hours of California highway driving logged from a windshield device: GPS, a 9-axis IMU, the road camera, and every CAN-bus message the car emits. This scene is one 60-second segment on I-280 between San Francisco and San Jose, a steady ~76 mph cruise.',
      'Unlike the LIDAR scenes, a comma log has no point cloud and no perception boxes, so the cockpit at `/drive/comma-280-1641` shows the streams it has: the GPS ego trail, radial CAN gauges (speed, steering, acceleration) at the playhead, and the road-camera frame. The cockpit adapts to whatever streams a scene contains.',
      'Built by `comma_extract.py` from the public comma2k19 HuggingFace mirror — one segment’s ECEF poses (→ lat/lon), CAN speed / steering, and IMU acceleration. No 10 GB chunk needed.',
    ],
    dataSources: [
      {
        name: 'comma2k19 (comma.ai)',
        url: 'https://github.com/commaai/comma2k19',
        license: 'MIT',
        note: 'Segment 2018-08-02--16-41-38/17 on I-280; commaai/comma2k19 on HuggingFace.',
      },
    ],
    buildCommand:
      'python scripts/data-generation/comma_extract.py --demo-parquet <comma2k19 demo parquet> --row 6 --out examples/showcase/public/data/comma-280-1641',
    buildNote:
      'Pull one demo parquet from the commaai/comma2k19 HuggingFace mirror, then ' +
      'extract. Open the cockpit at /drive/comma-280-1641.',
    techniques: [
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['av-synthetic', 'argoverse-02678d04', 'ship-traffic'],
  },

  'nyc-od-arcs': {
    category: 'mobility',
    tagline: 'Every taxi trip as an arc from where it began to where it ended.',
    techniqueTag: 'Arcs · OD flows',
    about: [
      'A taxi trip is an origin→destination pair: a pickup point, a dropoff point, and the time between. Each trip is drawn as an arc bowed between the two — no route — animated in and out as its pickup→dropoff interval passes through a 30-minute window. Arcs run cyan at the origin to orange at the destination, so direction is legible.',
      'The geometry is the minimal case for the STT format: a 2-vertex LineString per feature. `AnimatedArcLayer` derives instanced source/target positions from the first and last vertex of each feature, so no special arc tile type is needed. The data here is synthetic (generated offline, no routing engine); the same `--od` generator builds real arcs from TLC trip records.',
    ],
    dataSources: [
      {
        name: 'NYC Taxi & Limousine Commission (schema)',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'Public (NYC TLC)',
        note: 'This demo uses SYNTHETIC trips generated offline; TLC is the schema/source the --od mode targets.',
      },
    ],
    buildCommand:
      'stt-generate nyc-rideshare --synthetic --num-trips 6000 --od --with-bearing \\\n' +
      '  --output nyc-od-arcs.stt',
    buildNote:
      'The --od mode emits one straight 2-vertex origin→destination LineString ' +
      'per trip — no OSRM routing — which AnimatedArcLayer reads as source/target.',
    techniques: [
      { label: 'AnimatedArcLayer', docPath: '/docs/api/animated-arc-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['nyc-taxi-flows', 'nyc-taxi-trips', 'nyc-od-quadbin'],
  },

  'bixi-flowmap': {
    category: 'mobility',
    tagline: 'A month of real Montréal BIXI trips as an origin→destination flowmap, animated by hourly demand.',
    techniqueTag: 'Flowmap · OD matrix',
    about: [
      'flowmap.gl popularized the origin→destination flowmap: one weighted arrow per station-pair, node circles sized by total flow. This demo adds time. Every directed BIXI station-pair for August 2024 carries an hourly trip-count series, so arrow widths vary with demand as the playhead scrubs the month: downtown fills on weekday mornings, the Plateau and the Lachine Canal on summer evenings and weekends.',
      'It uses the same geometry-once / animate-from-a-matrix approach as the taxi flow corridors: each OD pair is a single 2-vertex corridor carrying a `[2 × buckets]` `vertexValueMatrix`. `FlowmapLayer` draws it as a tapered arrow (via `FlowLinesLayer`), width from the active bucket, and sums incident flow at each dock for the node circles, so the tile loads once and only the playhead moves.',
      'Per-zoom aggregation is baked into the tiles: the build clusters stations into hubs per zoom (the hierarchical clustering flowmap.gl does at runtime, done once at build time), so low zooms show a few hub-to-hub corridors and full per-station detail returns as you zoom in. ~1.9M trips from BIXI Montréal open data, aggregated into directed OD corridors at hourly resolution. No thinning — clustering aggregates flow rather than dropping it, and every hourly bucket is kept for every corridor.',
    ],
    dataSources: [
      {
        name: 'BIXI Montréal — Open Data (trip history)',
        url: 'https://bixi.com/en/open-data/',
        license: 'BIXI open data licence',
        note: 'Real August 2024 trips (origin/destination station + timestamps).',
      },
      {
        name: 'BIXI GBFS (station locations)',
        url: 'https://gbfs.velobixi.com/gbfs/en/station_information.json',
        license: 'Public (GBFS)',
        note: 'Fallback station geometry for pre-2022 code-based trip files.',
      },
    ],
    buildCommand:
      'stt-generate bixi --input DonneesOuvertes2024.csv \\\n' +
      '  --from 2024-08-01 --to 2024-09-01 --bin 1h --min-trips 30 \\\n' +
      '  --cluster-radius 80 \\\n' +
      '  --output bixi-flowmap.stt',
    buildNote:
      'Aggregates real BIXI open-data trips into directed OD-pair corridors, ' +
      'each carrying an hourly vertexValueMatrix. Stations are clustered into ' +
      'hubs per zoom by default (tune with `--cluster-radius`; `--no-cluster` ' +
      'falls back to the legacy volume LOD). The CSV schema is auto-detected: ' +
      '2022+ embeds lat/lon per trip; pre-2022 resolves station codes via a ' +
      'Stations CSV or the public GBFS feed.',
    techniques: [
      { label: 'FlowmapLayer', docPath: '/docs/api/flowmap-layer' },
      { label: 'FlowLinesLayer (tapered arrows)', docPath: '/docs/api/flow-lines-layer' },
      { label: 'Binary features (vertex value matrix)', docPath: '/docs/api/binary-features' },
    ],
    related: ['bixi-flowmap-bundled', 'bixi-flowmap-baked', 'nyc-od-arcs', 'nyc-taxi-flows'],
  },

  'bixi-flowmap-bundled': {
    category: 'mobility',
    tagline: 'The BIXI flowmap with close corridors bundled into rivers on the GPU (KDEEB).',
    techniqueTag: 'GPU edge bundling · KDEEB',
    about: [
      'At an overview zoom, hundreds of station-pair arrows overlap into an unreadable tangle. Edge bundling is the standard fix: pull geometrically-close flows together so corridors heading the same way merge. This demo runs kernel-density edge bundling (KDEEB; Hurter & Telea 2012) entirely on the GPU.',
      'Each iteration splats every edge point into a density texture, advects the points up the density gradient (mean-shift toward neighbouring edges), resamples, and runs a 1D Laplacian smoothing pass. The kernel shrinks each iteration to tighten the bundles. It runs in float textures with ping-pong render passes, so the geometry never round-trips through the CPU and the bundling converges over the first ~15 frames.',
      'It reuses the same BIXI tiles as the unbundled flowmap — bundling is client-side, no separate build. The bundle is computed once per tile and kept on the GPU; only each ribbon’s width animates with hourly demand, sampled from the per-corridor vertexValueMatrix. Direction reads from the source→target color gradient. On a device that can’t additively blend into a float texture it falls back to straight arrows.',
    ],
    dataSources: [
      {
        name: 'BIXI Montréal — Open Data (trip history)',
        url: 'https://bixi.com/en/open-data/',
        license: 'BIXI open data licence',
        note: 'Real August 2024 trips (origin/destination station + timestamps).',
      },
      {
        name: 'KDEEB — Graph Bundling by Kernel Density Estimation (Hurter, Ersoy, Telea)',
        url: 'http://recherche.enac.fr/~hurter/KDEEB.html',
        license: 'Academic',
        note: 'The kernel-density bundling algorithm this layer ports to WebGL2.',
      },
    ],
    buildCommand:
      'stt-generate bixi --input bixi-2024.csv \\\n' +
      '  --from 2024-08-01 --to 2024-09-01 --bin 1h --min-trips 5 \\\n' +
      '  --cluster-radius 15 \\\n' +
      '  --output bixi-flowmap-dense',
    buildNote:
      'A denser build than the bixi-flowmap demo (min-trips 5, cluster-radius ' +
      '15) — thousands of corridors per overview tile, to load up the GPU ' +
      'bundler. The bundling itself is done at render time by ' +
      'BundledFlowmapLayer; tune it with `kernelRadius`, `bundlingIterations`, ' +
      '`smoothingStrength`, and `subdivisionPoints` on the layer.',
    techniques: [
      { label: 'BundledFlowmapLayer', docPath: '/docs/api/bundled-flowmap-layer' },
      { label: 'FlowmapLayer', docPath: '/docs/api/flowmap-layer' },
      { label: 'Binary features (vertex value matrix)', docPath: '/docs/api/binary-features' },
    ],
    related: ['bixi-flowmap', 'bixi-flowmap-baked', 'nyc-taxi-flows', 'nyc-od-arcs'],
  },
  'bixi-flowmap-baked': {
    category: 'mobility',
    tagline: 'The same edge bundling, baked into the tiles at build time.',
    techniqueTag: 'Baked edge bundling · KDEEB',
    about: [
      'Edge bundling merges geometrically-close corridors. The sister demo runs it on the GPU at render time; this one moves the whole computation into the build. A deterministic CPU port of KDEEB (Hurter & Telea 2012) bundles each zoom’s corridors once and writes the result into the tiles as multi-vertex polylines, so the client just draws the curve.',
      'Bundling is a global operation: the bundle a corridor joins depends on the whole edge set, so bundling tile-local subsets independently would seam. The generator bundles each zoom’s complete clustered hub-pair set with one density field, then emits whole (un-clipped) corridors banded to that zoom — the same per-zoom clustering the flowmap bakes, with the geometry pre-bundled. Determinism matters because the packs are content-addressed: KDEEB uses a uniform (non-random) step and a pinned density resolution, so a rebuild is byte-identical.',
      'Trade-off vs the live GPU demo: the bundle is fixed at build time (no interactive kernel tuning). In exchange: no per-frame relaxation, a bundle stable as you pan and zoom, reproducible output, and no `EXT_float_blend` requirement, so it renders on mobile GPUs where the live bundler falls back. Ribbon width still animates from the hourly vertexValueMatrix.',
    ],
    dataSources: [
      {
        name: 'BIXI Montréal — Open Data (trip history)',
        url: 'https://bixi.com/en/open-data/',
        license: 'BIXI open data licence',
        note: 'Real August 2024 trips (origin/destination station + timestamps).',
      },
      {
        name: 'KDEEB — Graph Bundling by Kernel Density Estimation (Hurter, Ersoy, Telea)',
        url: 'http://recherche.enac.fr/~hurter/KDEEB.html',
        license: 'Academic',
        note: 'The kernel-density bundling algorithm, ported to a deterministic CPU pass.',
      },
    ],
    buildCommand:
      'stt-generate bixi --input bixi-2024.csv \\\n' +
      '  --from 2024-08-01 --to 2024-09-01 --bin 1h \\\n' +
      '  --min-trips 5 --cluster-radius 15 \\\n' +
      '  --bake-bundling --bundle-points 24 \\\n' +
      '  --output bixi-flowmap-baked',
    buildNote:
      'Because bundling is baked there is no render-time edge budget, so this ' +
      'build keeps the WHOLE network — a relaxed trip floor (`--min-trips 5`, vs ' +
      '30 for the live demo) keeps the long tail of low-traffic corridors, which ' +
      'the layer renders as thin hairlines (`flowMinFlow≈0`, sub-pixel ' +
      '`widthMinPixels`) instead of dropping them. `--bake-bundling` relaxes each ' +
      'zoom’s clustered corridors with a CPU KDEEB and stores them as polylines ' +
      '(`--bundle-points` = control points per corridor, must match the layer’s ' +
      '`subdivisionPoints`; `--bundle-kernel`/`--bundle-iterations`/' +
      '`--bundle-smoothing` tune the bundle). Baked corridors are coordinate-heavy, ' +
      'so the build quantizes geometry to 1 m (invisible at these zooms) to roughly ' +
      'halve the wire size. The client renders with ' +
      '`BundledFlowmapLayer({ preBundled: true })` — no render-time bundling.',
    techniques: [
      { label: 'BundledFlowmapLayer', docPath: '/docs/api/bundled-flowmap-layer' },
      { label: 'FlowmapLayer', docPath: '/docs/api/flowmap-layer' },
      { label: 'Binary features (vertex value matrix)', docPath: '/docs/api/binary-features' },
    ],
    related: ['bixi-flowmap-bundled', 'bixi-flowmap', 'nyc-taxi-flows'],
  },

  'bixi-streets': {
    category: 'mobility',
    tagline: 'A month of BIXI trips routed onto Montréal’s bike network, per-hour ridership shaded onto each segment.',
    techniqueTag: 'Streets · pre-aggregated · gradient',
    about: [
      'The street-network companion to the BIXI flowmap: instead of straight origin→destination arcs, every trip is routed through OSRM on Montréal’s bicycle network — cycleways, the REV, the Lachine Canal path, shared streets — and its per-hour ridership is aggregated onto each road segment. The gradient shades each corridor by rider count, from dim side streets to bright arterials like de Maisonneuve and the REV at rush hour.',
      'It reuses the taxi-flow corridor pipeline end to end: OD pairs are routed once (counts already collapse millions of trips onto a bounded pair set), each routed segment is matched back to its OSM edge, and traversals accumulate per edge × per hour into one corridor feature carrying a per-vertex value matrix. The build attaches a road-class `min_zoom` so major arterials show in the overview and cycleways fill in on zoom-in. No thinning — aggregation is the visualization.',
    ],
    dataSources: [
      {
        name: 'BIXI Montréal — Open Data (trip history)',
        url: 'https://bixi.com/en/open-data/',
        license: 'BIXI open data licence',
        note: 'Real August 2024 trips (origin/destination station + timestamps).',
      },
      {
        name: 'OpenStreetMap (bicycle network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand:
      'stt-generate bixi --streets --input bixi-2024.csv \\\n' +
      '  --from 2024-08-01 --to 2024-09-01 --bin 1h --min-trips 30 \\\n' +
      '  --osm-pbf osrm-data/quebec-latest.osm.pbf \\\n' +
      '  --osrm-url http://localhost:5001 \\\n' +
      '  --output bixi-streets.stt',
    buildNote:
      'Routes BIXI OD pairs onto the OSM bicycle network and aggregates per-hour ' +
      'traversals into street corridors (the BIXI counterpart of `nyc-rideshare ' +
      '--flows`). Needs a local OSRM **bicycle** server for Québec — bring one up ' +
      'with `REGION=quebec PROFILE=bicycle scripts/data-generation/setup-osrm.sh` ' +
      '(defaults to port 5001 so it coexists with the NYC car server).',
    techniques: [
      { label: 'FlowCorridorLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'Binary features (vertex value matrix)', docPath: '/docs/api/binary-features' },
      { label: 'CLI: aggregation flags', docPath: '/docs/api/cli-reference' },
    ],
    related: ['bixi-flowmap', 'nyc-taxi-flows', 'bixi-flowmap-baked'],
  },

  'bixi-streets-flow': {
    category: 'mobility',
    tagline: 'The BIXI street network with direction: chevrons march along each cycleway toward the dominant travel direction.',
    techniqueTag: 'Streets · directional · chevrons',
    about: [
      'The directional cut of the BIXI street network. The heatmap sibling shades each corridor by rider count but not direction; this build keeps that per-hour brightness and adds direction. As trips route onto the bike network, each street edge tracks its net travel direction, and every corridor is pre-oriented toward the direction most riders take over the month.',
      'On top of the value matrix (which varies each corridor’s brightness with the hourly demand), a ChevronFlowExtension slides arrowhead chevrons along each segment in that direction — a fragment-shader overlay driven by the same playhead, so the geometry loads once and only a single phase uniform moves per frame. The REV, de Maisonneuve and the canal path read as directed flows, not just intensity.',
    ],
    dataSources: [
      {
        name: 'BIXI Montréal — Open Data (trip history)',
        url: 'https://bixi.com/en/open-data/',
        license: 'BIXI open data licence',
        note: 'Real August 2024 trips (origin/destination station + timestamps).',
      },
      {
        name: 'OpenStreetMap (bicycle network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand:
      'stt-generate bixi --streets --directional --input bixi-2024.csv \\\n' +
      '  --from 2024-08-01 --to 2024-09-01 --bin 1h --min-trips 30 \\\n' +
      '  --osm-pbf osrm-data/quebec-latest.osm.pbf \\\n' +
      '  --osrm-url http://localhost:5001 \\\n' +
      '  --output bixi-streets-flow.stt',
    buildNote:
      'Same routing as `bixi --streets`, plus `--directional`: it also sums each ' +
      'edge’s signed net flow and pre-orients every corridor toward its dominant ' +
      'direction so the client can march chevrons along the winding. Needs the ' +
      'same local OSRM **bicycle** server for Québec (`REGION=quebec ' +
      'PROFILE=bicycle scripts/data-generation/setup-osrm.sh`, port 5001).',
    techniques: [
      { label: 'FlowCorridorLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'ChevronFlowExtension', docPath: '/docs/api/animated-trips-layer' },
      { label: 'Binary features (vertex value matrix)', docPath: '/docs/api/binary-features' },
    ],
    related: ['bixi-streets', 'bixi-corridors', 'bixi-flowmap'],
  },

  'bixi-corridors': {
    category: 'mobility',
    tagline: 'BIXI trips bundled into a Sankey-like flow network — origin→destination lines merge onto shared trunks, widths animated by hourly demand.',
    techniqueTag: 'Flow network · Edge-Path Bundling · breathing width',
    about: [
      'An alternative to density edge bundling. Here flows merge rather than smear: stations cluster into hubs joined by a Delaunay proximity graph, and every trip is routed along the graph’s shortest path with cost length^k, so flows heading the same way collapse onto shared trunk lines. The result is a Sankey-like network — tributaries enter a trunk, ride it, and leave — with no street snapping.',
      'Each trunk’s width is the √ of the active hour’s travellers, so trunks widen where flows join in the morning peak and thin overnight. The two directions are drawn as side-by-side offset ribbons, so the morning inbound rush and the evening reverse read as asymmetric flows. Fully build-time and deterministic — no GPU bundler, no OSRM, no thinning.',
    ],
    dataSources: [
      {
        name: 'BIXI Montréal — Open Data (trip history)',
        url: 'https://bixi.com/en/open-data/',
        license: 'BIXI open data licence',
        note: 'Real August 2024 trips (origin/destination station + timestamps).',
      },
    ],
    buildCommand:
      'stt-generate bixi --flow-graph --input bixi-2024.csv \\\n' +
      '  --from 2024-08-01 --to 2024-09-01 --bin 1h --min-trips 20 \\\n' +
      '  --hub-radius 320 --bundle-k 3.2 --stroke-flow-ratio 0.2 \\\n' +
      '  --stroke-angle 70 --spline 7 --smooth 2 --ribbon-offset 14 \\\n' +
      '  --output bixi-corridors.stt',
    buildNote:
      'Builds an abstract Edge-Path-Bundling flow network (no streets, no OSRM): ' +
      'clusters stations into hubs (`--hub-radius`), Delaunay-connects them, and ' +
      'routes each OD flow along shortest paths weighted by `length^--bundle-k` so ' +
      'flows merge onto shared trunks, then Catmull-Rom-splines them (`--spline`) ' +
      'into flowing curves. The whole month animates at hourly resolution. Tune ' +
      'trunk boldness with `--hub-radius` and bundling strength with `--bundle-k`.',
    techniques: [
      { label: 'FlowStrokeLayer (breathing width)', docPath: '/docs/api/animated-trips-layer' },
      { label: 'Binary features (vertex value matrix)', docPath: '/docs/api/binary-features' },
      { label: 'CLI: aggregation flags', docPath: '/docs/api/cli-reference' },
    ],
    related: ['bixi-streets', 'bixi-flowmap-baked', 'bixi-flowmap'],
  },

  'bixi-points': {
    category: 'mobility',
    tagline: 'Every BIXI ride as a moving dot along its real OSRM-routed bike route — one per active trip.',
    techniqueTag: 'Moving heads',
    about: [
      'The moving-head companion to the BIXI street and flow demos. Instead of aggregating trips into corridors, each ride is routed once through OSRM on Montréal’s bicycle network and drawn as a single dot interpolated along its route at the playhead — one moving cyclist per active trip along the cycleways, the REV and the Lachine Canal path.',
      'It is the BIXI counterpart of the NYC taxi head-dots: the build emits one OSRM-routed LineString per trip with per-vertex timestamps (the per-edge duration shape stretched onto each ride’s start→end window), and AnimatedTripHeadsLayer interpolates each head every frame. No separate points dataset — the same archive can also render as trails. Identical dock pairs are routed once and re-timed per trip, so a whole day animates from a bounded set of routes.',
    ],
    dataSources: [
      {
        name: 'BIXI Montréal — Open Data (trip history)',
        url: 'https://bixi.com/en/open-data/',
        license: 'BIXI open data licence',
        note: 'Real 2024 trips (origin/destination station + start/end timestamps).',
      },
      {
        name: 'OpenStreetMap (bicycle network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand:
      'stt-generate bixi --paths --input bixi-2024.csv \\\n' +
      '  --from 2024-08-15 --to 2024-08-16 --max-trips 40000 \\\n' +
      '  --osrm-url http://localhost:5001 \\\n' +
      '  --output bixi-points.stt',
    buildNote:
      'Routes each individual BIXI trip on the OSM bicycle network and bakes ' +
      'per-vertex timestamps (the BIXI counterpart of `nyc-rideshare --paths`); ' +
      'AnimatedTripHeadsLayer animates a moving head-dot per ride. Needs a local ' +
      'OSRM **bicycle** server for Québec — bring one up with `REGION=quebec ' +
      'PROFILE=bicycle scripts/data-generation/setup-osrm.sh` (defaults to port ' +
      '5001). The build prints the exact archive time span to paste into the ' +
      'dataset’s `timeRange`.',
    techniques: [
      { label: 'AnimatedTripHeadsLayer', docPath: '/docs/api/animated-trip-heads-layer' },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['nyc-taxi-points', 'bixi-streets', 'bixi-flowmap'],
  },

  'gtfs-nl': {
    category: 'mobility',
    tagline:
      'Every scheduled train, bus, tram, metro and ferry in the Netherlands for one Friday — 121,031 journeys moving on the national timetable.',
    techniqueTag: 'Moving heads · schedule expansion',
    about: [
      'A whole country’s public transport as one animated timetable, at national scale. Every vehicle scheduled for Friday 2026-07-03 is a dot moving along its real route: intercity trains across the Randstad, night buses after midnight, ferries to the Wadden islands.',
      'No vehicle positions are recorded — the static GTFS feed is the data. The build expands the service calendar to one concrete day, then places each trip along its published route shape by matching the stop-time distances (`shape_dist_traveled`), interpolating per-vertex timestamps between consecutive stops (dwell included). 97.5% of trips carry exact shape-distance timing; the rest (shapeless trips) fall back to stop-to-stop lines.',
      'The archive holds all 121,031 trips with per-vertex timing; AnimatedTripHeadsLayer interpolates every active vehicle per frame. Zoom into Amsterdam or Utrecht Centraal at rush hour for dense platform activity, or zoom out for the whole network.',
    ],
    dataSources: [
      {
        name: 'OVapi / NDOV — Netherlands national GTFS',
        url: 'https://gtfs.ovapi.nl/nl/',
        license: 'CC0',
        note: 'Complete national timetable (42 agencies incl. NS, all city transit); refreshed daily.',
      },
    ],
    buildCommand:
      'stt-generate gtfs --feed data/gtfs-nl/feed --date 20260703 \\\n' +
      '  --output examples/showcase/public/data/gtfs-nl',
    buildNote:
      'Download + unzip https://gtfs.ovapi.nl/nl/gtfs-nl.zip first; the feed ' +
      'refreshes daily and only covers its published window, so pick a --date ' +
      'inside it. The build prints the exact archive time span to paste into ' +
      'the dataset’s `timeRange`.',
    techniques: [
      { label: 'AnimatedTripHeadsLayer', docPath: '/docs/api/animated-trip-heads-layer' },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['bixi-points', 'nyc-taxi-points'],
  },

  'nwm-rivers-2019': {
    category: 'earth-ocean',
    tagline: 'The continental river network through the 2019 flood year — modeled daily discharge on every order-4+ reach.',
    techniqueTag: 'Flow matrix · zoom-banded network',
    about: [
      'NOAA’s National Water Model simulates hourly streamflow for 2.7 million river reaches across the continental US. This demo reduces the 2019 retrospective to daily means and bakes it onto the USGS NHDPlus river network as a per-vertex × per-day value matrix — the bixi-streets recipe at continental scale. Each reach is scaled against its own annual low→high (robust 2nd–98th percentile in log space), so color reads how each river varies through the year rather than how much water it carries: a headwater creek’s snowmelt pulse lights up as vividly as the Mississippi’s crest, instead of the great rivers pinning the whole scale.',
      'The network itself is zoom-banded by Strahler stream order: the CONUS overview carries only order-6+ mainstems (merged into long runs along NHDPlus LevelPath/Hydroseq and resampled to ~2 px vertex spacing), and each zoom step adds smaller tributaries down to order 4 at z8. Geometry loads once per tile; playback is pure bucket selection, so scrubbing a year of national hydrology re-fetches nothing.',
      'The spring snowmelt pulse moves down the Missouri and upper Mississippi in March; 2019 was the wettest year on record across much of the basin.',
    ],
    dataSources: [
      {
        name: 'NOAA National Water Model v3.0 retrospective (1979–2023)',
        url: 'https://registry.opendata.aws/nwm-archive/',
        license: 'US Government open data — no restrictions',
        note: 'Hourly modeled streamflow, reduced here to daily means. This demo is a derived product, not original NOAA data.',
      },
      {
        name: 'USGS NHDPlusV2 flowline network',
        url: 'https://www.epa.gov/waterdata/nhdplus-national-data',
        license: 'US public domain',
        note: 'Reach geometry, stream order and mainstem topology (COMID join to NWM feature_id).',
      },
    ],
    buildCommand:
      'stt-generate nwm --window 2019 --bin 1d --value self-scaled \\\n' +
      '  --output examples/showcase/public/data/nwm-rivers-2019',
    buildNote:
      'Downloads ~11 GB of Zarr chunks from the NWM S3 bucket on first run ' +
      '(cached + resumable under data/nwm/); needs the NHDPlus flowline ' +
      'GeoParquet exported by scripts/data-generation (see the design doc ' +
      'docs/roadmap/nwm-rivers-demo-2026-07.md).',
    techniques: [
      { label: 'FlowCorridorLayer', docPath: '/docs/api/flow-corridor-layer' },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['nwm-rivers-flood-2019-03', 'bixi-streets'],
  },

  'nwm-rivers-flood-2019-03': {
    category: 'earth-ocean',
    tagline:
      'The March 2019 bomb-cyclone flood hour by hour — every reach colored by how far above its own normal it runs.',
    techniqueTag: 'Flow matrix · anomaly encoding',
    about: [
      'The hourly companion to the year-of-flow demo, scoped to March 2019 — the bomb cyclone that dropped rain on frozen snowpack and produced major flooding across Nebraska, Iowa and the Missouri basin. Same network and matrix machinery, but each reach is colored by log2(flow ÷ its own 2019 median): an anomaly encoding, not absolute discharge.',
      'The anomaly encoding is what makes the flood legible. On an absolute ramp the Mississippi always dominates; on the anomaly ramp a creek running fifty times its normal flow reads as bright as a mainstem. Normal flow is dim blue, high water yellow to orange, the extreme crest white as it propagates downstream over days.',
      'The per-reach medians come from the year demo’s daily reduce, so the two demos share their download cache and geometry pipeline end to end.',
    ],
    dataSources: [
      {
        name: 'NOAA National Water Model v3.0 retrospective (1979–2023)',
        url: 'https://registry.opendata.aws/nwm-archive/',
        license: 'US Government open data — no restrictions',
        note: 'Hourly modeled streamflow for March 2019. This demo is a derived product, not original NOAA data.',
      },
      {
        name: 'USGS NHDPlusV2 flowline network',
        url: 'https://www.epa.gov/waterdata/nhdplus-national-data',
        license: 'US public domain',
      },
    ],
    buildCommand:
      'stt-generate nwm --window 2019-03 --bin 1h --value log-anomaly \\\n' +
      '  --output examples/showcase/public/data/nwm-rivers-flood-2019-03',
    buildNote:
      'Run the nwm-rivers-2019 build first — the anomaly’s per-reach medians ' +
      'come from its cached daily reduce (then this build reuses every chunk).',
    techniques: [
      { label: 'FlowCorridorLayer', docPath: '/docs/api/flow-corridor-layer' },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['nwm-rivers-2019', 'storm-radar'],
  },

  'bixi-live': {
    category: 'mobility',
    tagline: 'Directional street-flow and moving riders on one clock: aggregate corridors under individual rides.',
    techniqueTag: 'Composite · directional flow + moving heads',
    about: [
      'A composite that layers two BIXI demos on a single playhead. Underneath is the directional street-network flow: every cycleway segment pre-oriented toward its dominant direction, with chevrons showing which way riders go and brightness following the hour’s ridership. On top, every ride from that day moves as a dot along its real OSRM-routed path — one bike per active trip.',
      'It reuses two already-built archives with no third build: the light, static-geometry flow-corridor archive (the `bixi-streets-flow` matrix) is the primary source that gates the clock; the heavier per-trip paths archive (`bixi-points`) rides on top as an optional governor source, streaming in continue-and-degrade so the substrate is instant and the riders fill in. Both are windowed to Thursday 2024-08-15, so the aggregate flow and the individual rides stay on the same day.',
      'The overlay is fully general — any `type: \'trips\'` flow demo gains moving heads by setting `headsOverlayUrl` to a per-trip paths archive; the painter order keeps the corridors as a backdrop and the riders on top.',
    ],
    dataSources: [
      {
        name: 'BIXI Montréal — Open Data (trip history)',
        url: 'https://bixi.com/en/open-data/',
        license: 'BIXI open data licence',
        note: 'Real 2024 trips; the flow matrix aggregates August, the riders are Aug 15.',
      },
      {
        name: 'OpenStreetMap (bicycle network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand:
      '# 1. directional flow corridors (the substrate)\n' +
      'stt-generate bixi --streets --directional --input bixi-2024.csv \\\n' +
      '  --from 2024-08-01 --to 2024-09-01 --bin 1h \\\n' +
      '  --osm-pbf osrm-data/quebec-latest.osm.pbf --osrm-url http://localhost:5001 \\\n' +
      '  --output bixi-streets-flow.stt\n' +
      '# 2. per-trip moving riders (the overlay)\n' +
      'stt-generate bixi --paths --input bixi-aug15.csv --max-trips 50000 \\\n' +
      '  --osrm-url http://localhost:5001 --output bixi-points.stt',
    buildNote:
      'No third build — this demo composites the two archives above on one ' +
      'playhead (flow corridors primary/required, moving heads optional overlay ' +
      'via `headsOverlayUrl`). Both need a local OSRM **bicycle** server for ' +
      'Québec (`REGION=quebec PROFILE=bicycle scripts/data-generation/setup-osrm.sh`).',
    techniques: [
      { label: 'FlowCorridorLayer (directional)', docPath: '/docs/api/animated-trips-layer' },
      { label: 'AnimatedTripHeadsLayer', docPath: '/docs/api/animated-trip-heads-layer' },
      { label: 'Multi-source playback', docPath: '/docs/api/time-controller' },
    ],
    related: ['bixi-points', 'bixi-streets-flow', 'nyc-flow-and-riders'],
  },

  'nyc-od-quadbin': {
    category: 'mobility',
    tagline: 'Trip density binned into CARTO Quadbin square cells, extruded by count.',
    techniqueTag: 'Quadbin summary · square cells',
    about: [
      'The summary tier renders a dataset too dense to draw feature-by-feature: the build aggregates points into cells and ships one row per cell. This demo uses the CARTO Quadbin scheme — a Z/X/Y square-cell grid — as the counterpart to the H3 hex summary. Each cell is extruded by the number of pickup/dropoff points inside it, so Midtown rises highest.',
      'The whole chain is STT-native: the Rust `stt-build --summary-tier quadbin` aggregator encodes each cell as a CARTO Quadbin u64, and `QuadbinSummaryLayer` decodes it to a quadkey for deck.gl’s QuadkeyLayer. The tileset dispatches to the aggregated tier inside its zoom band automatically — zoom in past it and the raw points take over.',
    ],
    dataSources: [
      {
        name: 'NYC Taxi & Limousine Commission (schema)',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'Public (NYC TLC)',
        note: 'Synthetic pickup/dropoff points generated offline; aggregated into Quadbin cells at build time.',
      },
    ],
    buildCommand:
      'stt-generate nyc-rideshare --synthetic --num-trips 12000 --skip-routing \\\n' +
      '  --output od-points.parquet\n' +
      'stt-build --input od-points.parquet --output nyc-od-quadbin \\\n' +
      '  --time-field timestamp --min-zoom 8 --max-zoom 14 \\\n' +
      '  --summary-tier quadbin --summary-min-zoom 8 --summary-max-zoom 12',
    buildNote:
      'The CARTO Quadbin aggregator bins points into square Z/X/Y cells (count ' +
      'per cell per time bucket); QuadbinSummaryLayer renders them via QuadkeyLayer.',
    techniques: [
      { label: 'QuadbinSummaryLayer', docPath: '/docs/api/quadbin-summary-layer' },
    ],
    related: ['nyc-taxi-od-summary', 'nyc-taxi-od-heatmap', 'nyc-od-arcs'],
  },

  hurricanes: {
    category: 'earth-ocean',
    tagline: 'Four Atlantic seasons of storm tracks from the IBTrACS best-track archive.',
    techniqueTag: 'Points · tracks',
    about: [
      'The IBTrACS archive merges every agency’s storm observations into a single best-track record. This demo plays the Atlantic basin from 2020 through 2023 — including the record-breaking 2020 season, which exhausted the storm-name alphabet and pushed into the Greek letters.',
      'Each storm advances as a chain of 6-hourly fixes moving westward off Africa, then curving up through the Caribbean and along the US seaboard. A two-week window keeps whole storm lifecycles on screen at once.',
    ],
    dataSources: [
      {
        name: 'NOAA NCEI IBTrACS',
        url: 'https://www.ncei.noaa.gov/products/international-best-track-archive',
        license: 'Public domain (US Gov)',
      },
    ],
    buildCommand: 'stt-generate hurricanes',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['earthquake-activity', 'wildfires'],
  },

  wildfires: {
    category: 'earth-ocean',
    tagline: 'US wildfire perimeters over four seasons, polygons sized by burn severity.',
    techniqueTag: 'Polygons · temporal',
    about: [
      'Final fire perimeters for every US wildfire over 1,000 acres from 2020 through 2023, from the National Interagency Fire Center. The 2020 season fills the West Coast — the August Complex, the first "gigafire" of the modern record, burned over a million acres.',
      'Unlike the point demos, these are real polygon geometries: perimeters are pre-tessellated at build time and stream in as GPU-ready triangles, colored by severity class from moderate to catastrophic.',
    ],
    dataSources: [
      {
        name: 'National Interagency Fire Center (NIFC)',
        url: 'https://data-nifc.opendata.arcgis.com/',
        license: 'Public domain (US Gov)',
      },
    ],
    buildCommand: 'stt-generate wildfires',
    techniques: [
      { label: 'AnimatedPolygonLayer', docPath: '/docs/api/animated-polygon-layer' },
      { label: 'TimeFilterExtension', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['earthquake-activity', 'hurricanes'],
  },

  // ── Mobility ─────────────────────────────────────────────────────────────
  'ship-traffic': {
    category: 'mobility',
    tagline: '16,000 vessels over 24 hours of AIS pings, each with a 30-minute comet wake.',
    techniqueTag: 'Points · wake trails',
    about: [
      'Every AIS transponder ping in US waters over one January day in 2023: nearly sixteen thousand vessels, from container ships in the Houston Ship Channel to fishing fleets in the Gulf and ferries on Puget Sound.',
      'Each vessel is a world-space dot with a 30-minute comet wake — past pings fade and shrink behind the moving head, so shipping lanes emerge without any line geometry. Dots are sized in meters, not pixels: zoom into a harbor and vessels grow to their physical footprint.',
    ],
    dataSources: [
      {
        name: 'NOAA / BOEM Marine Cadastre AIS',
        url: 'https://marinecadastre.gov/ais/',
        license: 'Public domain (US Gov)',
        note: 'January 9, 2023 — the demo config is pinned to this date.',
      },
    ],
    buildCommand: 'stt-generate ais --date 2023-01-09 --output ais-all-us.stt',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'TimeFilterExtension (wakes)', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['flights', 'ocean-drifters'],
  },

  flights: {
    category: 'mobility',
    tagline: 'A day of US air traffic — aircraft positions with 5-minute contrails, lifted by altitude.',
    techniqueTag: 'Points · 3D · wake trails',
    about: [
      'Twenty-four hours of aircraft positions over the United States from the OpenSky Network’s crowdsourced ADS-B receivers. The morning east-coast departures, the transcontinental flows, and the overnight lull play out in about a minute.',
      'Each aircraft is a point lifted to its actual altitude (pitch the camera to see the vertical structure of the airways), trailing a five-minute contrail — at jet speeds that wake is roughly 75 km long, showing route structure without any line geometry.',
    ],
    dataSources: [
      {
        name: 'OpenSky Network',
        url: 'https://opensky-network.org/',
        license: 'Free for research / non-commercial use',
        note: 'Historical state vectors, January 6, 2020.',
      },
    ],
    buildCommand: 'stt-generate flights --date 2020-01-06',
    buildNote: 'OpenSky historical dumps cover Mondays 2017–2020; pick a Monday.',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'TimeFilterExtension (wakes)', docPath: '/docs/api/time-filter-extension' },
    ],
    related: ['flight-trips', 'ship-traffic'],
  },

  'flight-trips': {
    category: 'mobility',
    tagline: 'The same day of air traffic as full 3-D trajectories with fading trails.',
    techniqueTag: 'Trips · 3D',
    about: [
      'The companion to the flights demo: the same day of OpenSky traffic, rendered as continuous 3-D trajectories rather than discrete pings. Each flight is a line through space and time — climb-out, cruise, and descent read as geometry when you pitch the camera.',
      'Trip lines interpolate the playhead position along per-vertex timestamps, so aircraft move smoothly between observations with a two-minute trail behind each one.',
    ],
    dataSources: [
      {
        name: 'OpenSky Network',
        url: 'https://opensky-network.org/',
        license: 'Free for research / non-commercial use',
      },
    ],
    buildNote:
      'Frozen archive (prebuilt from OpenSky ADS-B trajectories and transcoded ' +
      'to the packed format); no from-source recipe.',
    techniques: [
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['flights', 'nyc-taxi-trips'],
  },

  'nyc-taxi-trips': {
    category: 'mobility',
    tagline: 'Half a million OSRM-routed cab trips animated on the GPU as trails.',
    techniqueTag: 'Animated trails',
    about: [
      'Every yellow-cab trip from New Year’s Day 2015, routed through the Manhattan street network with OSRM so each trip follows real streets rather than straight pickup-to-dropoff lines. Per-segment timing comes from OSRM’s duration annotations, so cabs are slower through midtown and faster on the FDR.',
      'Animation runs entirely on the GPU: every vertex carries a timestamp, and a time-filter shader fades each trail in over the trailing window as the playhead advances — so half a million trips animate by updating one uniform, with no per-frame CPU work. The cyan trails fade toward their tails.',
    ],
    dataSources: [
      {
        name: 'NYC TLC Trip Record Data',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'NYC Open Data',
        note: 'January 2015 (pre-2017 records carry real coordinates).',
      },
      {
        name: 'OpenStreetMap (road network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand:
      'stt-generate nyc-rideshare --download 2015-01 --paths \\\n' +
      '  --max-trips 50000 --output nyc-taxi-paths.stt',
    buildNote: OSRM_NOTE,
    techniques: [
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['nyc-taxi-points', 'nyc-taxi-flows', 'nyc-taxi-cube'],
  },

  'nyc-taxi-points': {
    category: 'mobility',
    tagline: 'The same routed trips as moving head-dots — one cab per active trip.',
    techniqueTag: 'Moving heads',
    about: [
      'The same OSRM-routed trip archive as the trails demo, rendered as animated head positions instead of trails: one moving dot per active cab, interpolated along its route at the playhead. At street zoom the dots move through the grid.',
      'No separate "points" dataset exists — each cab’s head position is interpolated from the full trip geometry every frame and drawn as a circle, so this demo and the trails demo read from the same archive. One build, two renderings.',
    ],
    dataSources: [
      {
        name: 'NYC TLC Trip Record Data',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'NYC Open Data',
      },
      {
        name: 'OpenStreetMap (road network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand:
      'stt-generate nyc-rideshare --download 2015-01 --paths \\\n' +
      '  --max-trips 50000 --output nyc-taxi-paths.stt',
    buildNote: OSRM_NOTE,
    techniques: [
      { label: 'AnimatedTripHeadsLayer', docPath: '/docs/api/animated-trip-heads-layer' },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['nyc-taxi-trips', 'nyc-taxi-cube', 'nyc-taxi-flows'],
  },

  'nyc-taxi-flows': {
    category: 'mobility',
    tagline: 'Taxi volume pre-aggregated into 15-minute road-corridor flows.',
    techniqueTag: 'Trips · pre-aggregated · gradient',
    about: [
      'The overview companion to the per-trip demos: the same 500K routed trips, aggregated at build time into one feature per road corridor per 15-minute bin. Per-vertex values carry the traversal count, so the gradient shades each street by cab count — from dim side streets to bright arterials like Fifth Avenue and the FDR.',
      'This is the format’s answer to zoomed-out trajectory clutter: rather than thinning trips client-side, the build emits a purpose-built aggregate tier. The network updates once per bin as new counts appear and the previous bin fades.',
    ],
    dataSources: [
      {
        name: 'NYC TLC Trip Record Data',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'NYC Open Data',
      },
      {
        name: 'OpenStreetMap (road network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand:
      'stt-generate nyc-rideshare --flows --flow-bin 15m \\\n' +
      '  --from-intermediate nyc-taxi-paths-2015-01.parquet \\\n' +
      '  --output nyc-taxi-flows.stt',
    buildNote:
      '`--from-intermediate` re-aggregates the kept --paths intermediate ' +
      'without re-routing through OSRM.',
    techniques: [
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'Binary features (per-vertex values)', docPath: '/docs/api/binary-features' },
      { label: 'CLI: aggregation flags', docPath: '/docs/api/cli-reference' },
    ],
    related: ['nyc-taxi-trips', 'nyc-taxi-od-summary'],
  },

  'nyc-flow-and-riders': {
    category: 'mobility',
    tagline: 'Street-flow and moving cabs on one clock: aggregate corridors under individual trips.',
    techniqueTag: 'Composite · flow corridors + moving heads',
    about: [
      'A composite that layers two NYC taxi demos on a single playhead — the New York counterpart of the BIXI "Flow & Riders" view. Underneath is the pre-aggregated street-network flow: 500K routed trips baked into one feature per road corridor per 15-minute bin, shaded by an indigo→cyan→white ramp from dim side streets to bright arterials. On top, every trip moves as a neon-magenta dot along its real OSRM-routed path — one cab per active trip.',
      'It reuses two already-built archives with no third build: the light, static-geometry flow-corridor archive (`nyc-taxi-flows`) is the primary source that gates the clock; the heavier per-trip paths archive (`nyc-taxi-paths`) rides on top as an optional governor source, streaming in continue-and-degrade so the substrate is instant and the cabs fill in. Both are windowed to the same Jan 1–2 2015 span, so the aggregate flow and the individual trips stay on the same instant.',
      'The overlay is fully general — any `type: \'trips\'` flow demo gains moving heads by setting `headsOverlayUrl` to a per-trip paths archive; the painter order keeps the corridors as a backdrop and the riders on top. Unlike the BIXI version this archive is non-directional, so there are no chevrons — just the corridors and the moving cabs.',
    ],
    dataSources: [
      {
        name: 'NYC TLC Trip Record Data',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'NYC Open Data',
        note: 'Pre-2017 yellow-cab records (with coordinates); windowed to Jan 1–2 2015.',
      },
      {
        name: 'OpenStreetMap (road network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand:
      '# 1. flow corridors (the substrate)\n' +
      'stt-generate nyc-rideshare --flows --flow-bin 15m \\\n' +
      '  --from-intermediate nyc-taxi-paths-2015-01.parquet \\\n' +
      '  --output nyc-taxi-flows.stt\n' +
      '# 2. per-trip moving riders (the overlay)\n' +
      'stt-generate nyc-rideshare --download 2015-01 --paths \\\n' +
      '  --max-trips 50000 --output nyc-taxi-paths.stt',
    buildNote:
      'No third build — this demo composites the two archives above on one ' +
      'playhead (flow corridors primary/required, moving heads optional overlay ' +
      'via `headsOverlayUrl`). The `--paths`/`--flows` builds need a local OSRM ' +
      'server for New York (`scripts/data-generation/setup-osrm.sh`).',
    techniques: [
      { label: 'FlowCorridorLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'AnimatedTripHeadsLayer', docPath: '/docs/api/animated-trip-heads-layer' },
      { label: 'Multi-source playback', docPath: '/docs/api/time-controller' },
    ],
    related: ['nyc-taxi-flows', 'nyc-taxi-points', 'bixi-live'],
  },

  'nyc-taxi-cube': {
    category: 'mobility',
    tagline: 'Hägerstrand’s space-time cube: a million taxi samples stacked by timestamp into a 3D volume.',
    techniqueTag: 'Space-time cube',
    about: [
      'The classic of time geography: every pickup, en-route sample and dropoff from New Year’s morning 2015 is lifted to the altitude of its timestamp. Green pickup strata form at street level each minute, gold en-route threads climb between them (a steeper thread means slower traffic), and the night accumulates into a cube.',
      'The wireframe boxes are the tiling system made visible: each box is one spatiotemporal tile — a spatial footprint crossed with a temporal bucket — drawn as it streams in. The squash slider flattens the cube back to a map.',
    ],
    dataSources: [
      {
        name: 'NYC TLC Trip Record Data',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'NYC Open Data',
      },
      {
        name: 'OpenStreetMap (road network via OSRM)',
        url: 'https://www.openstreetmap.org/',
        license: 'ODbL',
      },
    ],
    buildCommand: 'stt-generate nyc-rideshare --download 2015-01 --max-trips 50000',
    buildNote: OSRM_NOTE,
    techniques: [
      { label: 'AnimatedPointLayer (cumulative)', docPath: '/docs/api/animated-point-layer' },
      { label: 'SpatiotemporalTileset', docPath: '/docs/api/spatiotemporal-tileset' },
    ],
    related: ['nyc-taxi-points', 'nyc-taxi-od-heatmap'],
  },

  'nyc-taxi-od-summary': {
    category: 'mobility',
    tagline: 'Pickups vs dropoffs as extruded H3 hexes — the build-side summary tier.',
    techniqueTag: 'H3 summary · extruded',
    about: [
      '1.36 million pickups and dropoffs binned into H3 hexagons at build time, with per-hex sums for each 30-minute slice. Toggle between pickups (green) and dropoffs (red) to see the flow reverse over the day: pickups in residential neighborhoods, dropoffs in midtown, then back again.',
      'This is the summary tier in isolation: instead of streaming raw points, the archive carries pre-aggregated hex densities that stay lightweight at any zoom. Extrusion height and color both encode trips per hex.',
    ],
    dataSources: [
      {
        name: 'NYC TLC Trip Record Data',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'NYC Open Data',
      },
    ],
    buildNote:
      'Frozen archive transcoded to the packed format; no from-source recipe. ' +
      'Summary tiers for new data are built with `stt-build --summary-tier`.',
    techniques: [
      { label: 'SpatiotemporalTileset (summary tier)', docPath: '/docs/api/spatiotemporal-tileset' },
      { label: 'CLI: --summary-tier', docPath: '/docs/api/cli-reference' },
    ],
    related: ['nyc-taxi-od-heatmap', 'nyc-taxi-flows', 'osm-nyc-changesets-summary'],
  },

  'nyc-taxi-od-heatmap': {
    category: 'mobility',
    tagline: 'Pickup and dropoff density as two screen-blended GPU heatmap channels.',
    techniqueTag: 'Heatmap · dual channel',
    about: [
      'The first hours of 2015 as two density fields: pickups green, dropoffs red, each accumulated into its own channel of a single GPU pass and composited with per-class screen blending, so overlaps layer rather than mixing to mud.',
      'A 30-minute window slides across the night: bar districts show green pickups at closing time while residential blocks show red dropoffs.',
    ],
    dataSources: [
      {
        name: 'NYC TLC Trip Record Data',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
        license: 'NYC Open Data',
      },
    ],
    buildCommand: 'stt-generate nyc-rideshare --download 2015-01 --max-trips 50000',
    buildNote: OSRM_NOTE,
    techniques: [
      { label: 'AnimatedHeatmapLayer (temporal)', docPath: '/docs/api/heatmap-time-layer' },
    ],
    related: ['nyc-taxi-od-summary', 'nyc-taxi-cube'],
  },

  'animal-migration': {
    category: 'mobility',
    tagline: 'A year of tracked animal movement from GBIF, colored by taxonomic class.',
    techniqueTag: 'Trips · categorical',
    about: [
      'Tracking studies aggregated by GBIF — albatrosses in the Southern Ocean, white storks between Europe and Africa, marine mammals along the coasts — with multi-year deployments folded into a single calendar year so the seasonal pattern reads as one cycle.',
      'Tracks are colored by coarse taxonomic class, resolved at build time against the GBIF backbone: birds cyan, mammals coral, fish teal. Four-day fading trails connect individual fixes into migration arcs.',
    ],
    dataSources: [
      {
        name: 'GBIF — Global Biodiversity Information Facility',
        url: 'https://www.gbif.org/',
        license: 'CC0 / CC-BY / CC-BY-NC (per study)',
      },
    ],
    buildCommand: 'stt-generate animals',
    techniques: [
      { label: 'AnimatedTripsLayer', docPath: '/docs/api/animated-trips-layer' },
      { label: 'CategoryColorExtension', docPath: '/docs/api/category-color-extension' },
    ],
    related: ['ocean-drifters', 'ship-traffic'],
  },

  // ── Built world & life ───────────────────────────────────────────────────
  'osm-nyc-draw': {
    category: 'built-life',
    tagline: '19 years of OpenStreetMap node creations in New York, each persisting once placed, colored by year.',
    techniqueTag: 'Cumulative points',
    about: [
      'Every tagged node ever created in OpenStreetMap’s New York City, appearing when a mapper first placed it and persisting after, so the map fills in over 19 years. Color encodes the creation year: the blue 2007–2009 TIGER-era imports, then warmer colors as later mapping fills in shops, benches, and hydrants.',
      'Cumulative playback is a different rendering problem from a sliding window: everything stays resident. Played tiles consolidate into large GPU slabs (a handful of draw calls instead of hundreds) while the shader handles the progressive reveal.',
    ],
    dataSources: [
      {
        name: 'OpenStreetMap full-history extract (Geofabrik)',
        url: 'https://osm-internal.download.geofabrik.de/',
        license: 'ODbL — © OpenStreetMap contributors',
        note: 'Full-history .osh.pbf extracts require an OSM login.',
      },
    ],
    buildCommand:
      'stt-generate osm-edits --source nodes --input <region.osh.pbf> \\\n' +
      '  --bounds 40.49,-74.27,40.92,-73.68 --tagged-only --summary-tier \\\n' +
      '  --output osm-nyc-nodes.stt',
    buildNote:
      'Needs a full-history extract (a current snapshot has no version ' +
      'history); Geofabrik’s history downloads are OSM-login-gated.',
    techniques: [
      { label: 'AnimatedPointLayer (cumulative)', docPath: '/docs/api/animated-point-layer' },
      { label: 'CategoryColorExtension', docPath: '/docs/api/category-color-extension' },
    ],
    related: ['osm-nyc-changesets-summary', 'osm-nyc-changesets-editors'],
  },

  'osm-nyc-changesets-summary': {
    category: 'built-life',
    tagline: 'Two decades of NYC mapping activity as H3 hex densities — edits or sessions.',
    techniqueTag: 'H3 summary',
    about: [
      'Every OpenStreetMap changeset touching New York City from 2007 to 2025, hex-binned by month. Toggle between total edits (the volume of work) and sessions (how many distinct sittings) — bulk imports spike the former, sustained community mapping the latter.',
      'Edit counts are heavily heavy-tailed (a single import changeset can carry tens of thousands of edits), so the demo renders a flat choropleth with a percentile-tuned color domain rather than extruding very tall columns.',
    ],
    dataSources: [
      {
        name: 'OpenStreetMap changeset dump',
        url: 'https://planet.openstreetmap.org/planet/',
        license: 'ODbL — © OpenStreetMap contributors',
        note: 'Public planet-wide dump (~6 GB compressed).',
      },
    ],
    buildCommand:
      'stt-generate osm-edits --source changesets \\\n' +
      '  --input changesets-latest.osm.bz2 \\\n' +
      '  --bounds 40.49,-74.27,40.92,-73.68 --max-bbox-deg 1.0 \\\n' +
      '  --summary-tier --output osm-nyc-changesets.stt',
    buildNote: 'The dump is public; the cost is a planet-wide parse (10–40 min, CPU-bound).',
    techniques: [
      { label: 'SpatiotemporalTileset (summary tier)', docPath: '/docs/api/spatiotemporal-tileset' },
      { label: 'CLI: --summary-tier', docPath: '/docs/api/cli-reference' },
    ],
    related: ['osm-nyc-draw', 'osm-nyc-changesets-editors', 'nyc-taxi-od-summary'],
  },

  'osm-nyc-changesets-editors': {
    category: 'built-life',
    tagline: 'The same changesets colored by editing tool — Potlatch to JOSM to iD to StreetComplete.',
    techniqueTag: 'Points · categorical',
    about: [
      'The tooling history of OpenStreetMap through one city: each changeset colored by the editor that made it. Purple Potlatch dominates the early years, JOSM blue runs throughout, the browser-based iD editor (green) arrives in 2013, and orange StreetComplete marks the mobile micro-mapping era.',
      'Same archive as the hex-density demo, rendered raw with a categorical palette — one build, two views.',
    ],
    dataSources: [
      {
        name: 'OpenStreetMap changeset dump',
        url: 'https://planet.openstreetmap.org/planet/',
        license: 'ODbL — © OpenStreetMap contributors',
      },
    ],
    buildCommand:
      'stt-generate osm-edits --source changesets \\\n' +
      '  --input changesets-latest.osm.bz2 \\\n' +
      '  --bounds 40.49,-74.27,40.92,-73.68 --max-bbox-deg 1.0 \\\n' +
      '  --summary-tier --output osm-nyc-changesets.stt',
    techniques: [
      { label: 'AnimatedPointLayer', docPath: '/docs/api/animated-point-layer' },
      { label: 'CategoryColorExtension', docPath: '/docs/api/category-color-extension' },
    ],
    related: ['osm-nyc-draw', 'osm-nyc-changesets-summary'],
  },
};

// ── Derived views ───────────────────────────────────────────────────────────

export interface CatalogEntry {
  dataset: Dataset;
  meta: DemoMeta;
}

export function getDemoMeta(id: string): DemoMeta | undefined {
  return DEMO_META[id];
}

/** Catalog entries grouped by category, in CATEGORY_ORDER / registry order. */
export function getCatalog(): Map<DemoCategory, CatalogEntry[]> {
  const grouped = new Map<DemoCategory, CatalogEntry[]>(
    CATEGORY_ORDER.map((c) => [c, []]),
  );
  // Iterate the runtime registry so catalog order tracks datasets.ts order.
  for (const dataset of datasets) {
    const meta = DEMO_META[dataset.id];
    if (meta) grouped.get(meta.category)!.push({ dataset, meta });
  }
  return grouped;
}

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  const dataset = getDatasetById(id);
  const meta = DEMO_META[id];
  return dataset && meta ? { dataset, meta } : undefined;
}

export function getRelated(id: string): CatalogEntry[] {
  const meta = DEMO_META[id];
  if (!meta) return [];
  return meta.related
    .map((rid) => getCatalogEntry(rid))
    .filter((e): e is CatalogEntry => Boolean(e));
}

// Re-exported so the contract test can assert the curated set stays covered.
export { SHIPPED_DATASET_IDS };
