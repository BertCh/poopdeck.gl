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
      'Since 1979 the Global Drifter Program has seeded the oceans with ' +
        'satellite-tracked surface buoys. Each buoy reports its position and ' +
        'the temperature of the water around it as currents carry it along — ' +
        'and together their tracks trace the circulatory system of the ocean: ' +
        'gyres, boundary currents, and the long slow drift between them.',
      'Every ribbon here is one buoy. Color is carried per vertex, so a track ' +
        'warms from blue to red as the buoy rides into warmer water — the Gulf ' +
        'Stream’s warm core reads orange while its poleward tail cools to ' +
        'blue. The full 43-year record streams as spatiotemporal tiles and ' +
        'plays in about two minutes.',
      'This demo is also a data story: "Adrift" walks through the program’s ' +
        'history on a scroll-driven globe.',
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
      'Where the drifter demo shows the ocean as buoys actually experienced ' +
        'it, this one shows the ocean as a model understands it. NASA/JPL’s ' +
        'ECCO state estimate reconstructs the global ocean circulation; here, ' +
        'thousands of virtual particles are advected through its surface ' +
        'velocity fields for a year and rendered as flowing ribbons.',
      'Each ribbon is shaded along its length by current speed: calm interior ' +
        'waters read deep blue while the swift western-boundary currents — the ' +
        'Gulf Stream, the Kuroshio, the Agulhas — flare yellow and red. Played ' +
        'next to the drifters, it is a model-versus-observation comparison you ' +
        'can watch.',
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
      'Every magnitude-4.0+ earthquake recorded by the USGS between 2020 and ' +
        '2024 — tens of thousands of events that, played back, draw the ' +
        'boundaries of the tectonic plates: the Pacific Ring of Fire, the ' +
        'mid-Atlantic ridge, the Alpide belt through the Himalaya.',
      'Marker size scales with magnitude and color steps through magnitude ' +
        'bands, so the rare M7+ events flash large and dark red against the ' +
        'steady background crackle of M4s. A 30-day rolling window keeps the ' +
        'map legible across the five-year sweep.',
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
      'This is the earthquake catalog from the points demo, rendered a second ' +
        'way: every event becomes an extruded column whose height is its ' +
        'magnitude. Where the point map reads as a flat scatter, the columns ' +
        'turn the Ring of Fire into a literal landscape — a forest of spikes ' +
        'rising along the subduction zones, the rare great quakes towering ' +
        'over the background M4 crackle.',
      'It reuses the exact same archive as the points demo — nothing was ' +
        'rebuilt. Only the layer changed: `AnimatedColumnLayer` reads the ' +
        'numeric `magnitude` column as per-feature elevation, and the shared ' +
        'time filter fades columns in and out across a 30-day rolling window. ' +
        'Tilt the camera and pan out to trace the plate boundaries in relief.',
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
      'On 10 August 2020 a derecho — a long-lived, fast-moving wall of ' +
        'thunderstorms — raced east across the Midwest, organizing into a ' +
        'classic bow echo and flattening crops and towns from eastern Nebraska ' +
        'through Iowa with 100+ mph winds. This demo reconstructs that afternoon ' +
        'from the raw NOAA NEXRAD Level II archive of three radar sites ' +
        '(Omaha, Des Moines, and the Quad Cities), mosaicked into one moving ' +
        'picture of the storm.',
      'Everything the browser would normally choke on happens at build time, in ' +
        'Rust. Each radar volume is decoded from its polar sweeps, every gate is ' +
        'reprojected to lon/lat with the standard 4/3-earth beam model, the three ' +
        'sites are max-combined onto a common grid per 5-minute scan, that grid ' +
        'is contoured into filled NWS-palette reflectivity bands, and a ' +
        "SCIT-style tracker links storm cells across scans into tracks. The " +
        'browser just renders finished vector tiles.',
      'Three STT archives drive one composite render: the contour bands ' +
        '(`AnimatedPolygonLayer`, colored by a categorical `dbz_band`) are the ' +
        'animated precipitation field; storm-cell centroids ' +
        '(`AnimatedPointLayer`) mark the hardest cores; and cell tracks ' +
        '(`AnimatedTripsLayer`) trail behind each cell, shaded by intensity over ' +
        'time — the storm drawing its own path across the map.',
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
      'Autonomous-vehicle logs are some of the densest spatiotemporal data ' +
        'there is: a spinning LIDAR returns hundreds of thousands of 3D points ' +
        'per second, a perception stack tracks every car and pedestrian as an ' +
        'oriented 3D box, the vehicle records its own pose, and the CAN bus ' +
        'streams speed, steering, and acceleration dozens of times a second. ' +
        'This demo packages one 20-second drive as spatiotemporal tiles and ' +
        'replays it the way Aurora/Uber’s open-source streetscape.gl (avs.auto) ' +
        'viewer does — on a real basemap, with a cockpit around it.',
      'Three STT archives compose into one render: an accumulated LIDAR point ' +
        'cloud (`AnimatedPointLayer`, colored by a categorical `height_band` so ' +
        'the ground reads cool and rooftops read warm); the ego trajectory ' +
        '(`AnimatedTripsLayer`); and tracked objects as oriented extruded boxes ' +
        '(`AnimatedBoundingBoxLayer`, colored by class). The bespoke cockpit at ' +
        '`/drive/av-synthetic` adds a stream list, radial CAN-bus gauges, a ' +
        'timeline scrubber, and a camera inset — all reading the same playback ' +
        'clock the layers animate on.',
      'This scene is synthetic — generated offline with no external download, so ' +
        'the whole cockpit is runnable today. The same bundle layout is produced ' +
        'by adapters for real datasets (nuScenes, comma.ai, Argoverse 2), which ' +
        'georeference each scene’s local map frame onto a documented lat/lon origin.',
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
      'nuScenes (Motional) is the reference multimodal autonomous-driving dataset: a ' +
        '32-beam LIDAR, six cameras, radar, GPS/IMU, and the full CAN bus, with 1.4 million ' +
        'hand-annotated 3D boxes across Boston and Singapore. This is one real 20-second ' +
        'mini-split scene in Boston Seaport — and all ten v1.0-mini scenes (Boston + Singapore, ' +
        'day and night) are wired into the cockpit: switch between them from the scene picker.',
      'The cockpit at `/drive/nuscenes-0103` composes the accumulated LIDAR cloud — colored by ' +
        'per-point nuScenes-lidarseg SEMANTIC class (cars orange, people blue, road grey, canopy ' +
        'green) rather than a height ramp — the ego trail, tracked objects as oriented 3D boxes ' +
        'colored by class, the radial CAN gauges (speed / steering / throttle / brake), and a ' +
        'front-camera inset — all on one playback clock, georeferenced onto a real Boston basemap ' +
        'from the map’s documented origin.',
      'Built by `nuscenes_extract.py` from the login-gated v1.0-mini + CAN-bus expansion + ' +
        'map-expansion + lidarseg, with the LIDAR decimated to ~174k points and each return ' +
        'tagged with its semantic class.',
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
      'These are real autonomous-vehicle logs from Argoverse 2 — ~16-second drives ' +
        'captured by a 64-beam LIDAR rig with a full perception stack. One scene per ' +
        'AV2 city ships (Pittsburgh, Miami, Austin, Detroit, Palo Alto, Washington DC); ' +
        'switch between them in the cockpit. Every LIDAR return, every tracked car / ' +
        'pedestrian / cyclist box, the HD map, and the ego pose are georeferenced from ' +
        'each city’s coordinate frame (via the AV2 devkit’s exact CRS) onto a real ' +
        'basemap and served as spatiotemporal tiles.',
      'The cockpit at `/drive/argoverse-02678d04` composes the full stream set on one ' +
        'shared playback clock: the accumulated LIDAR cloud (colored by height band), ' +
        'the ego trail, tracked objects as oriented 3D boxes, the HD-map substrate ' +
        '(lane boundaries + lane centerlines + drivable areas + crosswalks), a ' +
        'ring-camera inset, and a telemetry gauge panel. Argoverse logs carry no CAN ' +
        'bus, so speed / acceleration / yaw-rate / heading are DERIVED from the ego pose.',
      'Built by `argoverse_extract.py` (driven by `argoverse_batch.sh`) from public ' +
        'sensor logs pulled with no auth from the Argoverse AWS Open Data bucket; each ' +
        'scene is decimated to ~190k LIDAR points and drops zero-point (occluded) GT boxes.',
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
      'These are real autonomous-vehicle segments from the Waymo Open Dataset — ' +
        '~20-second drives captured by a 5-laser LIDAR rig (one 64-beam mid-range ' +
        'top sensor + four short-range) and a full perception stack. Five curated ' +
        'scenes ship — dense daytime San Francisco, daytime + night Phoenix, night ' +
        'San Francisco, and a rare dawn/dusk RAIN scene — switchable in the cockpit. ' +
        'Every LIDAR return, every tracked vehicle / pedestrian / cyclist box (with ' +
        'Waymo’s real per-box velocity), and the ego pose are served as spatiotemporal tiles.',
      'The cockpit at `/drive/waymo-sf-day` composes the streams on one shared ' +
        'playback clock: the accumulated LIDAR cloud (colored by height band), the ego ' +
        'trail, tracked objects as oriented 3D boxes with velocity arrows, a FRONT-camera ' +
        'inset, and a telemetry gauge panel. Waymo Perception carries no CAN bus, so ' +
        'speed / acceleration / yaw-rate / heading are DERIVED from the ego pose. Waymo ' +
        'discloses no georeferencing and the v2.0.1 release ships no HD map, so each ' +
        'scene is anchored to an approximate local frame on a neutral dark basemap — the ' +
        'lidar itself is the map.',
      'Built by `waymo_extract.py` (driven by `waymo_batch.sh`) from the *modular ' +
        'Parquet* release (v2.0.1): the components are read with pyarrow and the LIDAR ' +
        'range images are decoded to a point cloud in pure numpy — no TensorFlow / ' +
        'waymo-open-dataset library. Each scene is decimated to ~400k LIDAR points and ' +
        'drops zero-point (occluded) GT boxes.',
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
      'comma.ai’s comma2k19 is 33 hours of real California highway driving logged from ' +
        'a windshield device: GPS, a 9-axis IMU, the road camera, and every CAN-bus ' +
        'message the car emits. This scene is one 60-second segment on I-280 between ' +
        'San Francisco and San Jose — a steady ~76 mph cruise.',
      'Unlike the LIDAR scenes, a comma log has no point cloud and no perception boxes, ' +
        'so the cockpit at `/drive/comma-280-1641` shows the streams it does have: the ' +
        'GPS ego trail on the map, the radial CAN gauges (speed, steering, acceleration) ' +
        'reading the real telemetry at the playhead, and the road-camera frame. The ' +
        'cockpit adapts to whatever streams a scene contains.',
      'Built by `comma_extract.py` from the public comma2k19 HuggingFace mirror — one ' +
        'segment’s ECEF poses (→ lat/lon), CAN speed / steering, and IMU acceleration. ' +
        'No 10 GB chunk needed.',
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
      'A taxi trip is, at heart, a single origin→destination pair: a pickup ' +
        'point, a dropoff point, and the time in between. This demo draws each ' +
        'trip as an arc bowed between the two — no route, just the flow — and ' +
        'animates them in and out as their pickup→dropoff intervals slide ' +
        'under a 30-minute window. The arcs warm from cyan at the origin to ' +
        'orange at the destination, so direction reads at a glance.',
      'The geometry is the minimal case for the STT format: a 2-vertex ' +
        'LineString per feature. `AnimatedArcLayer` derives instanced ' +
        'source/target positions from the first and last vertex of each tile ' +
        'feature, so no special arc tile type is needed. The data here is ' +
        'synthetic (generated offline, no routing engine), but the same ' +
        '`--od` generator builds real arcs from TLC trip records.',
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
    tagline: 'A month of real Montréal BIXI trips as weighted flows that breathe with the commute.',
    techniqueTag: 'Flowmap · OD matrix',
    about: [
      'flowmap.gl popularized the origin→destination flowmap: one weighted ' +
        'arrow per station-pair, node circles sized by total flow. This demo ' +
        'gives it a fourth dimension — time. Every directed BIXI station-pair ' +
        'for August 2024 carries an hourly trip-count time series, so corridors ' +
        'swell and recede with demand as the playhead scrubs the month: ' +
        'downtown fills on weekday mornings, the Plateau and the Lachine Canal ' +
        'light up on summer evenings and weekends.',
      'It reuses the same geometry-once / animate-from-a-matrix trick as the ' +
        'taxi flow corridors: each OD pair is a single 2-vertex corridor ' +
        'carrying a `[2 × buckets]` `vertexValueMatrix`. `FlowmapLayer` draws ' +
        'it as a flowmap.gl-style **tapered arrow** (via `FlowLinesLayer`) — ' +
        'width from the active bucket — and sums incident flow at each dock for ' +
        'the node circles, so the tile loads once and only the playhead moves.',
      'The per-zoom aggregation is baked into the tiles: the build clusters ' +
        'stations into hubs per zoom (the same hierarchical clustering ' +
        'flowmap.gl does at runtime, done once at build time), so low zooms ' +
        'show a few fat hub-to-hub corridors and full per-station detail ' +
        'returns as you zoom in. The data is real: ~1.9M trips from BIXI ' +
        'Montréal open data, aggregated into directed OD corridors at hourly ' +
        'resolution. No thinning — clustering AGGREGATES flow rather than ' +
        'dropping it, and every hourly bucket is kept for every corridor.',
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
    tagline: 'The BIXI flowmap, with close corridors relaxed into smooth rivers on the GPU.',
    techniqueTag: 'GPU edge bundling · KDEEB',
    about: [
      'The origin→destination flowmap has a clutter problem: at an overview ' +
        'zoom, hundreds of station-pair arrows cross into an unreadable hairball. ' +
        'Edge bundling is the classic fix — pull geometrically-close flows ' +
        'together so corridors heading the same way merge into smooth rivers. ' +
        'This demo runs kernel-density edge bundling (KDEEB; Hurter & Telea ' +
        '2012) entirely on the GPU.',
      'KDEEB is the method behind the smooth bundles in the classic figures: ' +
        'each iteration splats every edge point into a density texture, then ' +
        'advects the points up the density gradient (toward where neighbouring ' +
        'edges already are — mean-shift), resamples, and runs a 1D Laplacian ' +
        'smoothing pass that removes the zig-zags. The kernel shrinks each ' +
        'iteration to tighten the bundles. It all lives in float textures with ' +
        'ping-pong render passes — the same texture-as-memory trick cosmos.gl ' +
        'uses — so the geometry never round-trips through the CPU, and you can ' +
        'watch the straight arrows settle into rivers over the first ~15 frames.',
      'It reuses the exact same BIXI tiles as the unbundled flowmap — bundling ' +
        'is purely client-side, no separate build. The bundle is a stable ' +
        'spatial skeleton, computed once per tile and kept resident on the GPU; ' +
        'only each ribbon’s WIDTH animates with the hourly demand, sampled ' +
        'on the GPU from the per-corridor vertexValueMatrix. Direction reads ' +
        'from the source→target color gradient along each river. On a device ' +
        'that can’t additively blend into a float texture it falls back to ' +
        'straight arrows.',
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
    tagline: 'The same edge bundling, but BAKED into the tiles at build time.',
    techniqueTag: 'Baked edge bundling · KDEEB',
    about: [
      'Edge bundling untangles a flowmap by pulling geometrically-close ' +
        'corridors into smooth rivers. The sister demo runs that on the GPU at ' +
        'render time; this one moves the entire computation into the build. A ' +
        'deterministic CPU port of KDEEB (Hurter & Telea 2012) bundles each ' +
        'zoom’s corridors once and writes the resulting rivers into the tiles as ' +
        'ordinary multi-vertex polylines — so the client just draws the curve.',
      'The key constraint is that bundling is a GLOBAL operation: the river a ' +
        'corridor joins depends on the whole edge set, so bundling tile-local ' +
        'subsets independently would seam. The generator sidesteps this by ' +
        'bundling each zoom’s complete clustered hub-pair set with one density ' +
        'field, then emitting whole (un-clipped) corridors banded to that single ' +
        'zoom — the same per-zoom clustering the flowmap already bakes, now with ' +
        'the geometry pre-relaxed. Determinism matters because the packs are ' +
        'content-addressed: KDEEB uses a uniform (non-random) step and a pinned ' +
        'density resolution, so a rebuild is byte-identical.',
      'What you trade vs the live GPU demo: the bundle is fixed at build time ' +
        '(no interactive kernel tuning). What you gain: no per-frame relaxation ' +
        'and no settling animation, a bundle that’s stable as you pan and zoom, ' +
        'reproducible output, and — because there’s no density splat — no ' +
        '`EXT_float_blend` requirement, so it renders on mobile GPUs the live ' +
        'bundler falls back on. Ribbon WIDTH still animates from the hourly ' +
        'vertexValueMatrix exactly as before.',
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
    tagline: 'A month of BIXI trips routed onto Montréal’s bike network — the cycleways riders actually use, lit by the hourly commute.',
    techniqueTag: 'Streets · pre-aggregated · gradient',
    about: [
      'The street-network companion to the BIXI flowmap: instead of straight ' +
        'origin→destination arcs, every trip is routed through OSRM on Montréal’s ' +
        'actual BICYCLE network — cycleways, the REV, the Lachine Canal path, and ' +
        'shared streets — and its per-hour ridership is baked onto each road ' +
        'segment. The gradient shades each corridor by how many riders rolled ' +
        'over it, so quiet side streets stay dim indigo while de Maisonneuve and ' +
        'the REV burn white-hot at rush hour.',
      'It reuses the taxi-flow corridor pipeline end to end: OD pairs are routed ' +
        'once (not per trip — counts already collapse millions of trips onto a ' +
        'bounded pair set), each routed segment is matched back to its OSM edge, ' +
        'and traversals accumulate per edge × per hour into one corridor feature ' +
        'carrying a per-vertex value matrix. The build attaches a road-class ' +
        '`min_zoom` so major arteries show in the overview and every cycleway ' +
        'fills in on zoom-in. No thinning — aggregation IS the visualization.',
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

  'nyc-od-quadbin': {
    category: 'mobility',
    tagline: 'Trip density binned into CARTO Quadbin square cells, extruded by count.',
    techniqueTag: 'Quadbin summary · square cells',
    about: [
      'The summary tier is how STT renders a dataset too dense to draw ' +
        'feature-by-feature: the build step aggregates points into cells and ' +
        'ships one row per cell. This demo uses the CARTO Quadbin scheme — a ' +
        'Z/X/Y square-cell grid — as the square-grid counterpart to the H3 ' +
        'hex summary. Each cell is extruded by the number of pickup/dropoff ' +
        'points that fall inside it, so Midtown rises into a block of towers.',
      'The whole chain is STT-native: the Rust `stt-build --summary-tier ' +
        'quadbin` aggregator encodes each cell as a CARTO Quadbin u64, and ' +
        '`QuadbinSummaryLayer` decodes it to a quadkey for deck.gl’s ' +
        'QuadkeyLayer. The tileset dispatches to the aggregated tier inside ' +
        'its zoom band automatically — zoom in past it and the raw points ' +
        'take over.',
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
      'The IBTrACS archive merges every agency’s storm observations into a ' +
        'single best-track record. This demo plays the Atlantic basin from ' +
        '2020 through 2023 — including the record-breaking 2020 season, which ' +
        'exhausted the storm-name alphabet and pushed into the Greek letters.',
      'Each storm advances as a chain of 6-hourly fixes sweeping westward off ' +
        'Africa, curving up through the Caribbean and along the US seaboard. A ' +
        'two-week window keeps whole storm lifecycles on screen at once.',
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
      'Final fire perimeters for every US wildfire over 1,000 acres from 2020 ' +
        'through 2023, from the National Interagency Fire Center. The 2020 ' +
        'season alone reads as a wall of flame down the West Coast — the ' +
        'August Complex, the first "gigafire" of the modern record, burned ' +
        'over a million acres.',
      'Unlike the point demos, these are real polygon geometries: perimeters ' +
        'are pre-tessellated at build time and stream in as GPU-ready ' +
        'triangles, colored by severity class from moderate to catastrophic.',
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
    tagline: '16,000 vessels over 24 hours — AIS pings with comet wakes tracing the shipping lanes.',
    techniqueTag: 'Points · wake trails',
    about: [
      'Every AIS transponder ping in US waters over one January day in 2023: ' +
        'nearly sixteen thousand vessels, from container ships threading the ' +
        'Houston Ship Channel to fishing fleets working the Gulf and ferries ' +
        'crossing Puget Sound.',
      'Each vessel renders as a world-space dot with a 30-minute comet wake — ' +
        'past pings fade and shrink behind the moving head, so shipping lanes ' +
        'emerge as braided streams without drawing a single line geometry. ' +
        'Dots are sized in meters, not pixels: zoom into a harbor and vessels ' +
        'grow to their physical footprint.',
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
      'Twenty-four hours of aircraft positions over the United States from ' +
        'the OpenSky Network’s crowdsourced ADS-B receivers. The morning ' +
        'east-coast departure banks, the transcontinental flows, and the ' +
        'red-eye lull all play out in about a minute.',
      'Each aircraft is a point lifted to its actual altitude (pitch the ' +
        'camera to see the vertical structure of the airways) trailing a ' +
        'five-minute contrail — at jet speeds that wake stretches roughly ' +
        '75 km, painting the route structure without any line geometry.',
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
      'The companion to the flights demo: the same day of OpenSky traffic, ' +
        'but rendered as continuous 3-D trajectories rather than discrete ' +
        'pings. Each flight is a line through space and time — climb-out, ' +
        'cruise, and descent read as geometry when you pitch the camera.',
      'Trip lines interpolate the playhead position along per-vertex ' +
        'timestamps, so aircraft glide smoothly between observations with a ' +
        'two-minute trail fading behind each one.',
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
    tagline: 'Half a million OSRM-routed cab trips animated on the GPU as flowing ribbons.',
    techniqueTag: 'Animated trails',
    about: [
      'Every yellow-cab trip from New Year’s Day 2015, routed through the ' +
        'actual Manhattan street network with OSRM so each trip follows real ' +
        'streets — not straight pickup-to-dropoff lines. Per-segment timing ' +
        'comes from OSRM’s duration annotations, so cabs slow through ' +
        'midtown and sprint up the FDR.',
      'Animation runs entirely on the GPU: every vertex carries a timestamp, ' +
        'and a time-filter shader fades each ribbon in over the trailing ' +
        'window as the playhead advances — so half a million trips animate by ' +
        'updating one uniform, with no per-frame CPU work. The cyan ribbons ' +
        'fade toward their tails like long-exposure headlights.',
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
    tagline: 'The same routed trips as moving head-dots — one glowing cab per active trip.',
    techniqueTag: 'Moving heads',
    about: [
      'The same OSRM-routed trip archive as the ribbons demo, rendered as ' +
        'animated head positions instead of trails: one moving dot per active ' +
        'cab, interpolated along its route at the playhead. At street zoom the ' +
        'dots flow through the grid like blood cells through capillaries.',
      'No separate "points" dataset exists — each cab’s head position is ' +
        'interpolated from the full trip geometry every frame and drawn as a ' +
        'plain circle, so both this demo and the ribbons read from the ' +
        'identical archive. One build, two renderings.',
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
    tagline: 'The street grid pulsing with taxi volume — trips pre-aggregated into 15-minute corridor flows.',
    techniqueTag: 'Trips · pre-aggregated · gradient',
    about: [
      'The overview companion to the per-trip demos: the same 500K routed ' +
        'trips, aggregated at build time into one feature per road corridor ' +
        'per 15-minute bin. Per-vertex values carry the traversal count, so ' +
        'the gradient shades each street by how many cabs rolled over it — ' +
        'side streets stay dim indigo while Fifth Avenue and the FDR burn ' +
        'white-hot.',
      'This is the format’s answer to the "zoomed-out trajectory soup" ' +
        'problem: rather than thinning trips client-side, the build emits a ' +
        'purpose-built aggregate tier. The whole network pulses once per bin ' +
        'as new counts light up and the previous bin fades.',
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

  'nyc-taxi-cube': {
    category: 'mobility',
    tagline: 'Hägerstrand’s space-time cube: a million taxi samples stack into a tower of city time.',
    techniqueTag: 'Space-time cube',
    about: [
      'The classic of time geography, rendered live: every pickup, en-route ' +
        'sample and dropoff from New Year’s morning 2015 lifts to the ' +
        'altitude of its timestamp. Green pickup strata form at street level ' +
        'each minute, gold en-route threads climb between them (steep thread ' +
        '= stuck in traffic), and the night accumulates into a glowing cube.',
      'The wireframe boxes are the tiling system made visible: each box is ' +
        'one spatiotemporal tile — a spatial footprint crossed with a ' +
        'temporal bucket — drawn as it streams in. The squash slider morphs ' +
        'the cube back down to a flat map.',
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
      '1.36 million pickups and dropoffs binned into H3 hexagons at build ' +
        'time, with per-hex sums for each 30-minute slice. Toggle between ' +
        'pickups (green) and dropoffs (red) to watch the morning flow ' +
        'reverse: people picked up in residential neighborhoods, dropped in ' +
        'midtown — then back again.',
      'This is the summary tier in isolation: instead of streaming raw ' +
        'points, the archive carries pre-aggregated hex densities that stay ' +
        'lightweight at any zoom. Extrusion height and color both encode ' +
        'trips per hex.',
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
    tagline: 'Pickup and dropoff density as stacked GPU heatmaps that never go muddy.',
    techniqueTag: 'Heatmap · dual channel',
    about: [
      'The first hours of 2015 as competing density fields: pickups splat ' +
        'green, dropoffs red, each class accumulated into its own channel of ' +
        'a single GPU pass and composited with per-class screen blending — so ' +
        'where the two overlap, the colors layer instead of muddying.',
      'A 30-minute window slides across the night, and the city’s pulse ' +
        'reads directly: bar districts glow green with pickups at closing ' +
        'time while residential blocks bloom red.',
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
      { label: 'HeatmapLayer (temporal)', docPath: '/docs/api/heatmap-time-layer' },
    ],
    related: ['nyc-taxi-od-summary', 'nyc-taxi-cube'],
  },

  'animal-migration': {
    category: 'mobility',
    tagline: 'A year of tracked animal movement from GBIF, colored by taxonomic class.',
    techniqueTag: 'Trips · categorical',
    about: [
      'Tracking studies aggregated by GBIF — albatrosses circling the ' +
        'Southern Ocean, white storks commuting between Europe and Africa, ' +
        'marine mammals working the coasts — with multi-year deployments ' +
        'folded into a single calendar year so the seasonal rhythm reads as ' +
        'one cycle.',
      'Tracks are colored by coarse taxonomic class, resolved at build time ' +
        'against the GBIF backbone: birds cyan, mammals coral, fish teal. ' +
        'Four-day fading trails turn individual fixes into migration arcs.',
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
    tagline: 'New York draws itself: 19 years of OpenStreetMap node creations, ink that never fades.',
    techniqueTag: 'Cumulative points',
    about: [
      'Every tagged node ever created in OpenStreetMap’s New York City, ' +
        'appearing at the moment a mapper first placed it and persisting — so ' +
        'the city literally draws itself over 19 years. Color encodes the ' +
        'creation year: the cool blue skeleton of the 2007–2009 TIGER-era ' +
        'imports, then waves of warmer color as successive mapping ' +
        'generations fill in shops, benches, and hydrants.',
      'Cumulative playback is a different rendering problem from a sliding ' +
        'window: everything stays resident. Played tiles consolidate into ' +
        'large GPU slabs (a handful of draw calls instead of hundreds) while ' +
        'the shader handles the progressive reveal.',
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
      'Every OpenStreetMap changeset touching New York City from 2007 to ' +
        '2025, hex-binned by month. Toggle between total edits (the volume of ' +
        'work) and sessions (how many distinct sittings) — bulk imports spike ' +
        'the former, sustained community mapping the latter.',
      'Edit counts are brutally heavy-tailed (a single import changeset can ' +
        'carry tens of thousands of edits), so the demo renders a flat ' +
        'choropleth with a percentile-tuned color domain rather than ' +
        'extruding 30-kilometer towers.',
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
      'The tooling history of OpenStreetMap, told through one city: each ' +
        'changeset colored by the editor that made it. Purple Potlatch edits ' +
        'dominate the early years, power-user JOSM blue runs throughout, the ' +
        'green tide of the browser-based iD editor arrives in 2013, and ' +
        'orange StreetComplete dots mark the mobile micro-mapping era.',
      'Same archive as the hex-density demo, rendered raw with a categorical ' +
        'palette — one build serving two stories.',
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
