/**
 * Dataset configurations for the spatiotemporal tiles showcase.
 *
 * Playback speed is derived per dataset from targetPlaybackSeconds; see
 * calculateAnimationSpeed in types.ts.
 */

import { Dataset, ColorRGBA } from './types';

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
    description:
      'The global M4.0+ catalog rendered as extruded columns — bar height is ' +
      'magnitude. Same archive as the points demo, AnimatedColumnLayer.',
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
    description:
      '~5.8K synthetic NYC taxi trips drawn as origin→destination arcs, ' +
      'animated by pickup→dropoff time. AnimatedArcLayer.',
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
    // origin→destination station-pair flows. FlowmapLayer animates each arc's
    // width from a per-hour vertexValueMatrix + sizes node circles by incident
    // flow — the tile spans the whole month, so it loads once and animates from
    // the matrix as the playhead scrubs the daily commute rhythm.
    id: 'bixi-flowmap',
    name: 'Montréal BIXI — OD Flowmap',
    sources: ['bixi'],
    description:
      'A month of real BIXI bike-share trips (August 2024) as a flowmap.gl-style ' +
      'animated origin→destination flowmap — station-pair arcs swell and recede ' +
      "with hourly demand and node circles pulse with each dock's traffic. " +
      'FlowmapLayer.',
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
    initialViewState: {
      longitude: -73.578,
      latitude: 45.518,
      zoom: 12.2,
      pitch: 40,
      bearing: -10,
    },
    flowSourceColor: [56, 196, 232, 235], // origin — cool cyan
    flowTargetColor: [255, 142, 64, 245], // destination — warm orange
    flowWidthScale: 1.1,
    flowWidthMaxPixels: 14,
    flowArcHeight: 0.5,
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
    description:
      'Taxi volume pulsing through the street grid — 500K trips aggregated ' +
      'into 15-minute road-segment flows. The pre-aggregated overview ' +
      'companion to the per-trip paths demos. Source: NYC TLC.',
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
    description:
      'Time as height: a million taxi position samples from New Year’s ' +
      'morning 2015 stack into a cube as the night unfolds — green pickups, ' +
      'red dropoffs, gold en-route trails climbing between them. Wireframe ' +
      'boxes are STT’s space-time tiles streaming in. Source: NYC TLC.',
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
    id: 'satellites',
    name: 'Satellite Orbits',
    description: '~12,700 low-Earth-orbit satellites from CelesTrak over 24h (2026-05-31). Defaults to the globe; flip to flat at top-left.',
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
    description:
      'Virtual particles advected through NASA ECCO surface currents, shaded ' +
      'by current speed. The modeled companion to the drifter tracks. ' +
      'Source: NASA/JPL ECCO V4r4.',
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

export const datasets: Dataset[] = rawDatasets.map((d) => ({
  ...d,
  url: resolveDataUrl(d.url),
}));

export const DATASETS = datasets;

export function getDatasetById(id: string): Dataset | undefined {
  return datasets.find(d => d.id === id);
}

export const defaultDatasetId = 'earthquake-activity';

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
