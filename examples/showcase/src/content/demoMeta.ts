/**
 * Editorial metadata for the demo catalog (`/demos`) and per-demo landing
 * pages (`/demos/:id`).
 *
 * Curation contract: a dataset appears in the catalog IF AND ONLY IF it has an
 * entry here. The runtime `Dataset` registry (`src/datasets.ts`) is untouched —
 * excluded datasets still resolve by id and render at `/demo/:id`; they just
 * aren't surfaced. `test/demo-meta-contract.test.ts` enforces the invariants
 * (ids resolve, doc links exist on disk, related ids are catalog members, the
 * deliberately-excluded set stays excluded and every excluded id is real).
 *
 * Catalog SIZE is part of the curation. The catalog had grown to 48 cards over
 * ~16 distinct source datasets — NYC-taxi contributed nine and BIXI eight, and
 * the taglines admitted it ("The same routed trips as moving head-dots", "The
 * same edge bundling, baked into the tiles"). Twelve cards now carry one card
 * per idea; the other cuts of the same archive are named and LINKED from the
 * headline demo's prose (`about` renders inline markdown — see
 * `components/InlineProse.tsx`) and stream unchanged from `/demo/:id`. Adding a
 * 13th means arguing that it shows something none of the twelve does.
 */

import { datasets, getDatasetById, SHIPPED_DATASET_IDS } from '../datasets';
import type { Dataset } from '../types';

export type DemoCategory = 'earth-ocean' | 'mobility' | 'built-life';

export const CATEGORY_ORDER: DemoCategory[] = [
  'earth-ocean',
  'mobility',
  'built-life',
];

export const CATEGORY_LABELS: Record<DemoCategory, string> = {
  'earth-ocean': 'Earth & ocean',
  mobility: 'Mobility',
  'built-life': 'Built world & life',
};

export const CATEGORY_BLURBS: Record<DemoCategory, string> = {
  'earth-ocean':
    'Currents, quakes and storms — the planet observed and modeled from a single supercell up to 43 years of ocean drift.',
  mobility:
    'Ships, autonomous-vehicle sensor logs, a national timetable and half a million taxi trips — dense trajectory data at street to continental scale.',
  'built-life':
    'Two decades of OpenStreetMap editing — the mapped world, drawn one node at a time.',
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
  // (The ten `nuscenes-*-splat` ids used to be listed here. They never existed:
  // nuScenes is NOT in COLORED_SPLAT_BASE_IDS — its `--colorize` bundles were
  // never built — so `makeColoredSplatVariant` never derived them and the
  // exclusions named nothing. The contract test now asserts every excluded id
  // resolves to a real dataset, so a stale entry fails instead of rotting.)
  // Argoverse 2 camera-splat variants (`--colorize` bundles, makeColoredSplatVariant).
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
  // Sweep (`--scan`) and Worldbuild (`--worldbuild`) render-mode variants. Until
  // 2026-07-28 `HELD_BACK_AV_MODES` dropped these from the registry outright, so
  // they never reached this contract; that gate is now remote-only (dev serves
  // public/data and renders them), which makes them ordinary render-mode
  // variants — reached via the cockpit toggle, never a catalog card.
  'argoverse-02678d04-scan', // Pittsburgh
  'argoverse-02a00399-scan', // Miami
  'argoverse-0b5142c1-scan', // Washington DC
  'argoverse-0bae3b5e-scan', // Detroit
  'argoverse-25e5c600-scan', // Palo Alto
  'argoverse-92b900b1-scan', // Austin
  'argoverse-02678d04-world', // Pittsburgh
  'waymo-sf-day-world',

  // ── The 2026-07 cut from 48 cards to 12 ───────────────────────────────────
  // None of these lost their data or their route: every one still streams at
  // /demo/<id>, and the headline card that kept its slot links to it by name in
  // its `about` prose. What they lost is a catalog card, because the card was
  // making the same point twice.

  // Weather: severe-weather-2024 IS these feeds — "five NOAA feeds on one
  // 72-hour clock" — so shipping three of the five again as their own cards
  // sold the same archives twice. storm-radar is a second radar composite
  // beside storm-4d-greenfield's volumetric one.
  'goes-glm-lightning',
  'mrms-precip',
  'hrrr-wind',
  'storm-radar',
  // The other two cuts of the Greenfield/CONUS radar volume. Both are un-gated
  // again as of the 2026-07-31 fleet republish, so storm-4d-greenfield's prose
  // link to storm-3d-conus is restored. Note what enforces this: the
  // demo-meta contract test fails a prose link into a gated demo, so gating
  // either one again means removing the link in the same pass.
  'storm-3d-conus',
  'storm-4d-isolines',
  // Same USGS catalog as earthquake-activity, rendered as time-as-height
  // columns; the technique has its own card in nyc-taxi-cube.
  'earthquake-columns',
  // Point/track event catalogs that render exactly like earthquake-activity
  // (AnimatedPointLayer + magnitude/category ramp), linked from its prose.
  'hurricanes',
  'wildfires',
  // The rain→flood pair: nwm-rivers-2019 is the river-discharge overlay that
  // rain-flood-2019 composites, so they were two cards for one composite.
  // rain-flood-2019 is ALSO archive-gated (its rainfall-2019 stem 404s on R2).
  'nwm-rivers-2019',
  'rain-flood-2019',

  // AV: five cockpit cards for one cockpit. The SceneSwitcher already lists
  // every `type:'av'` dataset, so all of these are one click apart INSIDE
  // /drive — a catalog card per source only duplicated the switcher.
  // argoverse-02678d04 is the headline and links the rest.
  'av-synthetic',
  'nuscenes-0103',
  'waymo-sf-day',
  'comma-280-1641',

  // NYC taxi: nine cards over three archives. nyc-taxi-trips (the routed
  // trails) and nyc-taxi-cube (the space-time cube — a genuinely different
  // rendering problem) keep their slots; the rest are other cuts of the same
  // January 2015 TLC data and are linked from nyc-taxi-trips' prose.
  'nyc-taxi-points',
  'nyc-taxi-flows',
  'nyc-taxi-od-summary',
  'nyc-taxi-od-heatmap',
  'nyc-od-arcs',
  'nyc-od-quadbin',
  'nyc-flow-and-riders',

  // BIXI: eight cards, all Montréal bike-share, several explicitly billed as
  // "the same ... " as another. Linked from nyc-taxi-trips' prose alongside the
  // taxi cuts, since they demonstrate the same flow/corridor techniques.
  'bixi-flowmap',
  'bixi-flowmap-bundled',
  'bixi-flowmap-baked',
  'bixi-streets',
  'bixi-streets-flow',
  'bixi-corridors',
  'bixi-points',
  'bixi-live',

  // Transit: gtfs-nl is the headline. gtfs-ch is the same generator on a
  // different feed AND its archive 404s on tiles.poopdeck.gl (gated in
  // LOCAL_ONLY_DATASETS), so a card would have pointed at nothing.
  'gtfs-ch',

  // Aviation: the maritime/aviation pair renders identically; ship-traffic
  // keeps the slot and links both flight cuts.
  'flights',
  'flight-trips',
  // Same globe-scale trips technique as ocean-drifters, which links it.
  'animal-migration',

  // OSM: the changeset pair beside osm-nyc-draw's node history — all three were
  // the entire "Built world & life" category. osm-nyc-draw links both.
  'osm-nyc-changesets-summary',
  'osm-nyc-changesets-editors',
];

const OSRM_NOTE =
  'Trips are routed through OSRM (OpenStreetMap road network). The processed ' +
  'OSRM graph is staged in scripts/data-generation/osrm-data/ — start it with ' +
  '`cd scripts/data-generation && ./setup-osrm.sh run` (Docker) before building.';

export const DEMO_META: Record<string, DemoMeta> = {
  // ── Earth & ocean ────────────────────────────────────────────────────────
  'ocean-drifters': {
    category: 'earth-ocean',
    tagline:
      '43 years of satellite-tracked surface buoys, shaded by sea-surface temperature.',
    techniqueTag: 'Trips · SST gradient · globe',
    about: [
      'Since 1979 the Global Drifter Program has deployed satellite-tracked surface buoys across the oceans. Each buoy reports its position and the surrounding water temperature as currents carry it. Their tracks trace ocean circulation: gyres, boundary currents, and the drift between them.',
      'Each ribbon is one buoy. Color is per-vertex sea-surface temperature: a track shifts from blue to red as the buoy enters warmer water. The full 43-year record streams as spatiotemporal tiles and plays in about two minutes.',
      'This demo is also a data story: ["Adrift"](/story/drifters) walks through the program’s history on a scroll-driven globe. A year of [tracked animal migration](/demo/animal-migration) plays the same way, on a different traveler.',
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
      {
        label: 'AnimatedTripsLayer',
        docPath: '/docs/api/animated-trips-layer',
      },
      {
        label: 'Binary features (per-vertex values)',
        docPath: '/docs/api/binary-features',
      },
      {
        label: 'SpatioTemporalTileset',
        docPath: '/docs/api/spatiotemporal-tileset',
      },
    ],
    related: ['ecco-currents', 'ship-traffic'],
  },

  'ecco-currents': {
    category: 'earth-ocean',
    tagline:
      'Virtual particles advected through NASA ECCO model currents — the modeled twin of the drifters.',
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
      {
        label: 'AnimatedTripsLayer',
        docPath: '/docs/api/animated-trips-layer',
      },
      {
        label: 'Binary features (per-vertex values)',
        docPath: '/docs/api/binary-features',
      },
    ],
    related: ['ocean-drifters', 'ship-traffic'],
  },

  'earthquake-activity': {
    category: 'earth-ocean',
    tagline:
      'Five years of global M4+ seismicity tracing the plate boundaries.',
    techniqueTag: 'Points · magnitude',
    about: [
      'Every magnitude-4.0+ earthquake recorded by the USGS between 2020 and 2024 — tens of thousands of events. Played back, they outline the tectonic plate boundaries: the Pacific Ring of Fire, the mid-Atlantic ridge, the Alpide belt through the Himalaya.',
      'Marker size scales with magnitude and color steps through magnitude bands, so M7+ events read large and dark red against the smaller M4s. A 30-day rolling window keeps the map legible across the five-year span.',
      'Two sibling event catalogs are built the same way and stream from the fullscreen viewer: [global hurricane tracks](/demo/hurricanes) and [a year of VIIRS wildfire detections](/demo/wildfires). The same quakes also render as [time-as-height columns](/demo/earthquake-columns).',
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
      {
        label: 'AnimatedPointLayer',
        docPath: '/docs/api/animated-point-layer',
      },
      {
        label: 'CategoryColorExtension',
        docPath: '/docs/api/category-color-extension',
      },
    ],
    related: ['severe-weather-2024', 'storm-4d-greenfield'],
  },

  'severe-weather-2024': {
    category: 'earth-ocean',
    tagline:
      'Five NOAA feeds on one 72-hour clock — wind, precipitation, storm cells, surface fronts, and lightning over the late-May 2024 outbreak.',
    techniqueTag: 'Weather suite · 7-layer composite',
    about: [
      'The whole weather suite on one continental map and one playhead: 19–22 May 2024, the prolonged late-May severe-weather sequence whose 21 May outbreak produced the Greenfield, Iowa EF4. Five independent public NOAA datasets, each built by its own adapter, are streamed together and coordinated by the playback governor.',
      'Bottom to top: HRRR 500 mb steering wind as a dense drifting field of cool-blue particles — thousands of dots gliding with the mid-tropospheric flow the storms ride, so the drift runs with the cells; deliberately low-contrast so it reads as background context beneath the storms rather than competing with them; the MRMS national reflectivity mosaic as moving dBZ isoband polygons — the precipitation field, cross-dissolving between scans — with storm-cell centroids and SCIT cell tracks over it; the WPC surface frontal analysis as the synoptic skeleton above the field, drawn in the full classic notation — spline-smoothed cold, warm, occluded and stationary fronts with their filled triangle and semicircle pips riding the advancing side (derived by matching each front against the next analysis), the stationary ones alternating the classic red/blue with pips on opposite sides, plus dashed troughs — redrawn every three hours and cross-dissolved between analyses; and every GOES-16 GLM lightning flash as an additive splat, flickering individually and stacking into a glow where convection concentrates. All seven archives register as required governor sources, so the shared clock waits for every stream — no layer runs dry and vanishes while the others keep animating — with each widening its own loader window.',
      'It is the payoff of the suite: you watch the wind organize, the fronts march east with the rain bands breaking out along them, the cells and their tracks light up the convective cores, and the lightning flare along the leading edge — cause and effect, one clock. Each feed also plays on its own in the fullscreen viewer: [the GLM lightning](/demo/goes-glm-lightning), [the MRMS precipitation field](/demo/mrms-precip), [the HRRR steering wind](/demo/hrrr-wind) and [the Iowa derecho radar composite](/demo/storm-radar).',
    ],
    dataSources: [
      {
        name: 'NOAA HRRR 500 mb wind (AWS Open Data)',
        url: 'https://registry.opendata.aws/noaa-hrrr-bdp-pds/',
        license: 'Public domain (US Gov)',
        note: 'hourly 500 mb UGRD/VGRD → advected steering-flow drift particles.',
      },
      {
        name: 'NOAA MRMS reflectivity mosaic (AWS Open Data)',
        url: 'https://registry.opendata.aws/noaa-mrms-pds/',
        license: 'Public domain (US Gov)',
        note: '1 km composite reflectivity → dBZ bands + cells + tracks.',
      },
      {
        name: 'NOAA GOES-16 GLM lightning (AWS Open Data)',
        url: 'https://registry.opendata.aws/noaa-goes/',
        license: 'Public domain (US Gov)',
        note: 'L2 LCFA flashes → additive flash points.',
      },
      {
        name: 'NWS/WPC coded surface bulletins (IEM AFOS archive)',
        url: 'https://mesonet.agron.iastate.edu/wx/afos/',
        license: 'Public domain (US Gov)',
        note: '3-hourly hi-res (0.1°) CODSUS frontal analyses → smoothed front polylines.',
      },
    ],
    buildCommand:
      'python glm_lightning.py … && python mrms_weather.py … && python hrrr_advect.py … && python wpc_fronts.py …',
    buildNote:
      'Assembles seven archives built by the four weather adapters (goes-glm-' +
      'lightning, mrms-precip-field/-cells/-tracks, hrrr-wind, wpc-fronts + ' +
      "its -pips companion) into one type:'weather' composite. Rebuild any " +
      'layer independently.',
    techniques: [
      {
        label: 'AnimatedPolygonLayer',
        docPath: '/docs/api/animated-polygon-layer',
      },
      {
        label: 'AnimatedTripsLayer',
        docPath: '/docs/api/animated-trips-layer',
      },
      {
        label: 'AnimatedTripHeadsLayer',
        docPath: '/docs/api/animated-trip-heads-layer',
      },
      {
        label: 'AnimatedPointLayer',
        docPath: '/docs/api/animated-point-layer',
      },
      {
        label: 'AnimatedPathLayer',
        docPath: '/docs/api/animated-path-layer',
      },
    ],
    related: ['storm-4d-greenfield', 'earthquake-activity', 'ecco-currents'],
  },
  'storm-4d-greenfield': {
    category: 'earth-ocean',
    tagline:
      'One supercell as a true 4D object — the Greenfield, Iowa EF4 as a volumetric radar cloud with warnings, winds, outages and lightning on one clock.',
    techniqueTag: 'Storm 4D · 10-layer volumetric composite',
    about: [
      'Where the severe-weather suite shows the whole continent for 72 hours, this demo goes deep on one storm: the supercell that produced the Greenfield, Iowa EF4 of 21 May 2024. Instead of flattening the radar to a 2D mosaic, every NEXRAD Level II gate from the Des Moines radar (KDMX, 78 km away) is kept as a 3D point — placed at the altitude the 4/3-earth beam model says the beam sampled — so the storm becomes a time-animated volumetric cloud you can orbit and dive through. A render-mode toggle switches the volume between NWS reflectivity bands and dealiased radial velocity, where the mesocyclone reads as bright inbound green pixels beside bright outbound red — the couplet.',
      'The timeline is the story: the SPC particularly-dangerous-situation tornado watch at 18:10 UTC, touchdown near Villisca at 19:57, and the crossing of Greenfield around 20:26–20:32. Rated EF4 at 185 mph from the damage survey, the tornado was also sampled by a Doppler-on-Wheels mobile radar, which measured 263–271 mph winds at 44 m above ground — analyzed to roughly 309–318 mph instantaneous near the surface, making it only the third tornado ever radar-measured above 300 mph. Five people died. NOAA’s experimental Warn-on-Forecast system (WoFS) had highlighted the Greenfield area with roughly 75 minutes of lead time; the NWS Des Moines warnings rise here as translucent wireframe prisms the moment they were issued, shrinking with each SVS update and vanishing on expiry.',
      'Around the volume, the context arrives in painter order: county power outages grow as dark-red columns behind the storm, the GOES-16 C13 cloud-top "anvil canopy" floats at its brightness-temperature height, multi-level HRRR winds thread the scene at four pressure levels, one-minute ASOS stations gust beneath it, local storm reports strike the ground trailing the radar, GLM lightning flickers additively, and the 18Z Omaha radiosonde climbs through the whole scene as a tiny bright trail. All ten archives ride one playhead behind the playback governor, and every altitude-bearing layer shares a single 4× vertical exaggeration so the scene never lies about relative heights.',
      'A wider cut of the same idea streams from the fullscreen viewer: [the continental MRMS volume](/demo/storm-3d-conus) trades this one radar’s gate detail for every storm in CONUS at once.',
    ],
    dataSources: [
      {
        name: 'NOAA NEXRAD Level II — KDMX (Unidata AWS archive)',
        url: 'https://registry.opendata.aws/noaa-nexrad/',
        license: 'Public domain (US Gov)',
        note: 'Bucket unidata-nexrad-level2, 2024-05-21 17:30 → 05-22 03:00Z; all sweeps, dealiased velocity (Py-ART).',
      },
      {
        name: 'NOAA GOES-16 ABI C13 + GLM (AWS Open Data)',
        url: 'https://registry.opendata.aws/noaa-goes/',
        license: 'Public domain (US Gov)',
        note: 'ABI-L2-CMIPC brightness temperature → anvil isobands; GLM L2 LCFA flashes (reused goes-glm-lightning archive).',
      },
      {
        name: 'NOAA HRRR pressure-level winds (AWS Open Data)',
        url: 'https://registry.opendata.aws/noaa-hrrr-bdp-pds/',
        license: 'Public domain (US Gov)',
        note: '850/700/500/250 mb UGRD/VGRD via .idx byte-range subsetting → multi-level particle trips.',
      },
      {
        name: 'NWS warnings, storm reports & 1-min ASOS (IEM archives)',
        url: 'https://mesonet.agron.iastate.edu/',
        license: 'Public domain (US Gov)',
        note: 'VTEC storm-based warning polygons (with SVS phases), local storm reports, and one-minute ASOS observations.',
      },
      {
        name: 'SPC filtered storm reports',
        url: 'https://www.spc.noaa.gov/climo/reports/',
        license: 'Public domain (US Gov)',
        note: '240521 filtered reports, cross-checked against the IEM LSR feed.',
      },
      {
        name: 'DOE/ORNL EAGLE-I power outages',
        url: 'https://figshare.com/articles/dataset/The_Environment_for_Analysis_of_Geo-Located_Energy_Information_s_Recorded_Electricity_Outages_2014-2022/24237376',
        license: 'CC BY 4.0',
        note: 'County-level customers-out at 15-min cadence, filtered to Iowa + border counties.',
      },
      {
        name: 'NWS radiosonde — OAX 18Z special launch (U. Wyoming archive)',
        url: 'https://weather.uwyo.edu/upperair/sounding.html',
        license: 'Public domain (US Gov)',
        note: 'The 2024-05-21 18Z Omaha special sounding, drift-integrated from its wind profile.',
      },
    ],
    buildCommand:
      'python nexrad_volume.py --start 2024-05-21T17:30Z --end 2024-05-22T03:00Z --out-dir examples/showcase/public/data',
    buildNote:
      'Ten archives on one clock: nexrad_volume.py builds the storm4d-volume ' +
      'gate cloud (plus the storm4d-couplet shear markers) with Py-ART ' +
      'dealiasing; the companion storm4d generators in scripts/data-generation ' +
      'build storm4d-warnings, storm4d-reports, storm4d-stations, ' +
      'storm4d-outages, storm4d-cloudtop, storm4d-wind3d (multi-level ' +
      'hrrr_advect extension) and storm4d-sounding; goes-glm-lightning is the ' +
      'existing continental archive, subset by the demo time range at render ' +
      '— no rebuild. Exact schemas + knobs: docs/roadmap/storm-4d-greenfield' +
      '-2026-07.md §9.',
    techniques: [
      {
        label: 'AnimatedPointLayer',
        docPath: '/docs/api/animated-point-layer',
      },
      {
        label: 'AnimatedPolygonLayer',
        docPath: '/docs/api/animated-polygon-layer',
      },
      {
        label: 'AnimatedPathLayer',
        docPath: '/docs/api/animated-path-layer',
      },
      {
        label: 'TimeFilterExtension',
        docPath: '/docs/api/time-filter-extension',
      },
      {
        label: 'DataFilterExtension',
        docPath: '/docs/api/data-filter-extension',
      },
      {
        label: 'PlaybackGovernor',
        docPath: '/docs/api/playback-governor',
      },
    ],
    related: ['severe-weather-2024', 'earthquake-activity'],
  },
  // ── Mobility ───────────────────────────────────────────────────────────
  'cosmos-drive-dreams': {
    category: 'mobility',
    tagline:
      '300 world-model driving scenarios side by side, every agent animating at once — click one to watch its generated video play in sync with its own geometry.',
    techniqueTag: 'Scenario gallery · vector ⇄ generated video',
    about: [
      'A gallery of 300 ten-second driving scenarios from NVIDIA’s Cosmos-Drive-Dreams, laid out on a synthetic grid and all playing simultaneously on one looping clock. Each cell is a complete scene — HD-map lanes and crosswalks, the ego trajectory, and every tracked vehicle and pedestrian as an oriented 3D box — streamed from four cross-scenario tile archives rather than 300 separate ones, which is what makes hundreds of worlds animating at once affordable in a browser.',
      'The premise is that the vector scene is the authoritative artifact and the world model supplies one photoreal manifestation of it. Selecting a world in [the gallery](/worlds) flies the camera into its cell and plays the Cosmos-generated video for that exact scenario locked to the same playhead driving the geometry — scrub the timeline and the video follows frame for frame. Because the generated corpus renders each scenario under a different condition, the grid reads as a mosaic of weather: filter to every rainy world, every snowy one, or the handful of scenarios that exist in more than one generated reality at once.',
      'Built by `cosmos_drive_dreams.py`, which pulls the per-clip label tars from Hugging Face, rebases every clip onto a shared epoch and its own grid cell (STT tiles are geographic, so each scenario’s local metre frame is anchored to a cell on an equatorial lattice with the basemap hidden), and streams the generated videos straight out of the dataset’s split tar archive without ever storing the 40 GB part. Three "hero" scenarios also carry their full LiDAR sweep, streamed only when you fly into them.',
    ],
    dataSources: [
      {
        name: 'NVIDIA PhysicalAI Cosmos-Drive-Dreams',
        url: 'https://huggingface.co/datasets/nvidia/PhysicalAI-Autonomous-Vehicle-Cosmos-Drive-Dreams',
        license: 'CC BY 4.0',
        note: 'Scenario annotations (HD map, boxes, ego pose, LiDAR) and Cosmos-generated videos © NVIDIA, redistributed with attribution.',
      },
    ],
    buildCommand:
      'python scripts/data-generation/cosmos_drive_dreams.py   # ~300 scenarios + videos',
    buildNote:
      'Phased and resumable (index → videos → select → download → transform → build → ' +
      'sidecar → cleanup). The videos phase streams one part of the generated-video ' +
      'tar and keeps only the MP4s it wants; scenario selection then follows video ' +
      'coverage. Open the gallery at [/worlds](/worlds).',
    techniques: [
      {
        label: 'AnimatedTripsLayer',
        docPath: '/docs/api/animated-trips-layer',
      },
      {
        label: 'AnimatedPathLayer',
        docPath: '/docs/api/animated-path-layer',
      },
      {
        label: 'AnimatedPolygonLayer',
        docPath: '/docs/api/animated-polygon-layer',
      },
      {
        label: 'DataFilterExtension',
        docPath: '/docs/api/data-filter-extension',
      },
    ],
    related: ['argoverse-02678d04', 'nyc-taxi-trips'],
  },

  'argoverse-02678d04': {
    category: 'mobility',
    tagline:
      'Real Argoverse 2 sensor logs across six US cities — LIDAR, tracked 3D boxes, HD-map lanes, camera + telemetry.',
    techniqueTag: 'AV cockpit · real LIDAR',
    about: [
      'Real autonomous-vehicle logs from Argoverse 2 — ~16-second drives captured by a 64-beam LIDAR rig with a full perception stack. One scene per AV2 city ships (Pittsburgh, Miami, Austin, Detroit, Palo Alto, Washington DC); switch between them in the cockpit. Every LIDAR return, tracked car / pedestrian / cyclist box, the HD map, and the ego pose are georeferenced from each city’s coordinate frame (via the AV2 devkit CRS) onto a real basemap and served as spatiotemporal tiles.',
      'The cockpit at [/drive/argoverse-02678d04](/drive/argoverse-02678d04) composes the full stream set on one playback clock: the accumulated LIDAR cloud (colored by height band), the ego trail, tracked objects as oriented 3D boxes, the HD-map substrate (lane boundaries + centerlines + drivable areas + crosswalks), a ring-camera inset, and a telemetry gauge panel. Argoverse logs carry no CAN bus, so speed / acceleration / yaw-rate / heading are derived from the ego pose.',
      'Built by `argoverse_extract.py` (driven by `argoverse_batch.sh`) from public sensor logs pulled with no auth from the Argoverse AWS Open Data bucket; each scene is decimated to ~190k LIDAR points and drops zero-point (occluded) GT boxes.',
      'The same cockpit drives three other sensor sources — [nuScenes Boston/Singapore](/drive/nuscenes-0103), [a comma.ai dashcam log](/drive/comma-280-1641) and [a synthetic reference drive](/drive/av-synthetic) — all reachable from the scene rail without leaving the page.',
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
      'raw log. Open the cockpit at [/drive/argoverse-02678d04](/drive/argoverse-02678d04) ' +
      '(switch cities in-cockpit).',
    techniques: [
      {
        label: 'AnimatedPointLayer',
        docPath: '/docs/api/animated-point-layer',
      },
      {
        label: 'AnimatedTripsLayer',
        docPath: '/docs/api/animated-trips-layer',
      },
      {
        label: 'AnimatedColumnLayer',
        docPath: '/docs/api/animated-column-layer',
      },
      {
        label: 'TimeFilterExtension',
        docPath: '/docs/api/time-filter-extension',
      },
    ],
    related: ['cosmos-drive-dreams', 'nyc-taxi-trips'],
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
      {
        label: 'AnimatedTripHeadsLayer',
        docPath: '/docs/api/animated-trip-heads-layer',
      },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['nyc-taxi-trips', 'ship-traffic'],
  },

  'ship-traffic': {
    category: 'mobility',
    tagline:
      '16,000 vessels over 24 hours of AIS pings, each with a 30-minute comet wake.',
    techniqueTag: 'Points · wake trails',
    about: [
      'Every AIS transponder ping in US waters over one January day in 2023: nearly sixteen thousand vessels, from container ships in the Houston Ship Channel to fishing fleets in the Gulf and ferries on Puget Sound.',
      'Each vessel is a world-space dot with a 30-minute comet wake — past pings fade and shrink behind the moving head, so shipping lanes emerge without any line geometry. Dots are sized in meters, not pixels: zoom into a harbor and vessels grow to their physical footprint.',
      'The air-traffic twin of this demo — [a day of US flights](/demo/flights) as moving heads, or [the same day as full trajectories](/demo/flight-trips) — streams from the fullscreen viewer.',
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
      {
        label: 'AnimatedPointLayer',
        docPath: '/docs/api/animated-point-layer',
      },
      {
        label: 'TimeFilterExtension (wakes)',
        docPath: '/docs/api/time-filter-extension',
      },
    ],
    related: ['ocean-drifters', 'gtfs-nl'],
  },

  'nyc-taxi-trips': {
    category: 'mobility',
    tagline:
      'Half a million OSRM-routed cab trips animated on the GPU as trails.',
    techniqueTag: 'Animated trails',
    about: [
      'Every yellow-cab trip from New Year’s Day 2015, routed through the Manhattan street network with OSRM so each trip follows real streets rather than straight pickup-to-dropoff lines. Per-segment timing comes from OSRM’s duration annotations, so cabs are slower through midtown and faster on the FDR.',
      'Animation runs entirely on the GPU: every vertex carries a timestamp, and a time-filter shader fades each trail in over the trailing window as the playhead advances — so half a million trips animate by updating one uniform, with no per-frame CPU work. The cyan trails fade toward their tails.',
      'The same archive is cut several other ways in the fullscreen viewer: [the trip heads alone](/demo/nyc-taxi-points), [the pre-aggregated OD corridors](/demo/nyc-taxi-flows), [origin–destination arcs](/demo/nyc-od-arcs) and [a Quadbin OD summary](/demo/nyc-od-quadbin). Montréal’s bike-share network gets the same treatment across [a bundled flow map](/demo/bixi-flowmap), [street-routed corridors](/demo/bixi-streets) and [a live feed](/demo/bixi-live).',
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
      {
        label: 'AnimatedTripsLayer',
        docPath: '/docs/api/animated-trips-layer',
      },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['nyc-taxi-cube', 'gtfs-nl', 'osm-nyc-draw'],
  },

  'nyc-taxi-cube': {
    category: 'mobility',
    tagline:
      'Hägerstrand’s space-time cube: a million taxi samples stacked by timestamp into a 3D volume.',
    techniqueTag: 'Space-time cube',
    about: [
      'The classic of time geography: every pickup, en-route sample and dropoff from New Year’s morning 2015 is lifted to the altitude of its timestamp. Green pickup strata form at street level each minute, gold en-route threads climb between them (a steeper thread means slower traffic), and the night accumulates into a cube.',
      'The wireframe boxes are the tiling system made visible: each box is one spatiotemporal tile — a spatial footprint crossed with a temporal bucket — drawn as it streams in. The squash slider flattens the cube back to a map. The same night also renders flat as [an origin–destination heatmap](/demo/nyc-taxi-od-heatmap).',
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
      'stt-generate nyc-rideshare --download 2015-01 --max-trips 50000',
    buildNote: OSRM_NOTE,
    techniques: [
      {
        label: 'AnimatedPointLayer (cumulative)',
        docPath: '/docs/api/animated-point-layer',
      },
      {
        label: 'SpatioTemporalTileset',
        docPath: '/docs/api/spatiotemporal-tileset',
      },
    ],
    related: ['nyc-taxi-trips', 'osm-nyc-draw'],
  },

  // ── Built world & life ───────────────────────────────────────────────────
  'osm-nyc-draw': {
    category: 'built-life',
    tagline:
      '19 years of OpenStreetMap node creations in New York, each persisting once placed, colored by year.',
    techniqueTag: 'Cumulative points',
    about: [
      'Every tagged node ever created in OpenStreetMap’s New York City, appearing when a mapper first placed it and persisting after, so the map fills in over 19 years. Color encodes the creation year: the blue 2007–2009 TIGER-era imports, then warmer colors as later mapping fills in shops, benches, and hydrants.',
      'Cumulative playback is a different rendering problem from a sliding window: everything stays resident. Played tiles consolidate into large GPU slabs (a handful of draw calls instead of hundreds) while the shader handles the progressive reveal.',
      'The changeset side of the same history streams from the fullscreen viewer: [an H3 activity summary](/demo/osm-nyc-changesets-summary) aggregates every edit into hex cells, and [the same edits colored by editor](/demo/osm-nyc-changesets-editors) shows JOSM, iD and the import bots taking turns.',
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
      {
        label: 'AnimatedPointLayer (cumulative)',
        docPath: '/docs/api/animated-point-layer',
      },
      {
        label: 'CategoryColorExtension',
        docPath: '/docs/api/category-color-extension',
      },
    ],
    related: ['nyc-taxi-cube', 'nyc-taxi-trips'],
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

/**
 * Every registry dataset WITHOUT a catalog card, grouped by `Dataset['type']`.
 *
 * The curation above is an editorial judgement about the public site — one card
 * per idea. It is not a judgement that the other ~140 registry entries stopped
 * working, and on a local checkout (where `public/data` holds every archive)
 * having no way to reach them but hand-typed URLs was just a missing surface.
 * `DemosCatalog` renders this under the cards when `DEV_FULL_INDEX` is set.
 *
 * Grouped by `type` rather than `DemoCategory` for the obvious reason: category
 * lives in DEMO_META, and by definition nothing here has one. `type` is on the
 * `Dataset` itself, and it keeps the ~110 AV render-variants (`type: 'av'`) in
 * one block instead of interleaving them with the dozen genuinely distinct
 * demos someone is actually looking for here.
 */
export function getUncataloguedByType(): Map<Dataset['type'], Dataset[]> {
  const grouped = new Map<Dataset['type'], Dataset[]>();
  for (const dataset of datasets) {
    if (DEMO_META[dataset.id]) continue;
    const bucket = grouped.get(dataset.type);
    if (bucket) bucket.push(dataset);
    else grouped.set(dataset.type, [dataset]);
  }
  return grouped;
}

// Re-exported so the contract test can assert the curated set stays covered.
export { SHIPPED_DATASET_IDS };
