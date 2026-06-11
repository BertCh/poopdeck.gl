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
    'Ships, aircraft and half a million taxi trips — dense trajectory data at street to continental scale.',
  'built-life':
    'Two decades of OpenStreetMap editing and a year of animal migration — the mapped and the living world.',
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
  /** Technique chip on cards, e.g. "Trips · gradient", "VAT", "H3 summary". */
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
 *  - nyc-taxi-vat: exact duplicate of nyc-taxi-points (same archive/config).
 *  - nyc-rideshare: near-duplicate of nyc-taxi-points (straight-line
 *    trajectories vs OSRM-routed); its archive still powers the cube/heatmap.
 */
export const CATALOG_EXCLUDED_IDS: string[] = [
  'satellites',
  'flight-paths',
  'nyc-taxi-paths',
  'nyc-taxi-vat',
  'nyc-rideshare',
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
    techniqueTag: 'VAT trails',
    about: [
      'Every yellow-cab trip from New Year’s Day 2015, routed through the ' +
        'actual Manhattan street network with OSRM so each trip follows real ' +
        'streets — not straight pickup-to-dropoff lines. Per-segment timing ' +
        'comes from OSRM’s duration annotations, so cabs slow through ' +
        'midtown and sprint up the FDR.',
      'Animation runs entirely on the GPU via vertex-animation textures ' +
        '(VAT): trip positions for all visible cabs are sampled from a texture ' +
        'each frame, so half a million trips animate without the CPU touching ' +
        'a vertex. The cyan ribbons fade toward their tails like long-exposure ' +
        'headlights.',
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
      { label: 'SpatioTemporalLayer (VAT)', docPath: '/docs/api/spatiotemporal-layer' },
      { label: 'TimeController', docPath: '/docs/api/time-controller' },
    ],
    related: ['nyc-taxi-points', 'nyc-taxi-flows', 'nyc-taxi-cube'],
  },

  'nyc-taxi-points': {
    category: 'mobility',
    tagline: 'The same routed trips as moving head-dots — one glowing cab per active trip.',
    techniqueTag: 'VAT heads',
    about: [
      'The same OSRM-routed trip archive as the ribbons demo, rendered as ' +
        'animated head positions instead of trails: one moving dot per active ' +
        'cab, interpolated along its route on the GPU. At street zoom the ' +
        'dots flow through the grid like blood cells through capillaries.',
      'No separate "points" dataset exists — the vertex-animation texture ' +
        'samples the full trip geometry at the playhead, so both this demo ' +
        'and the ribbons read from the identical archive. One build, two ' +
        'renderings.',
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
      { label: 'SpatioTemporalLayer (VAT)', docPath: '/docs/api/spatiotemporal-layer' },
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

  'animal-migration': {
    category: 'built-life',
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
