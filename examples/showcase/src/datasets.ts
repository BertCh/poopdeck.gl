/**
 * Dataset configurations for the spatiotemporal tiles showcase
 * 
 * Animation speed is now computed automatically based on targetPlaybackSeconds
 * to ensure consistent playback experience across all datasets.
 */

import { Dataset } from './types';

export const datasets: Dataset[] = [
  {
    id: 'nyc-taxi-od-summary',
    name: 'NYC Pickup vs Dropoff Hex Density',
    description:
      'Server-aggregated H3 hex bins of 1.36M real TLC taxi pickup + dropoff ' +
      'events (Jan 1-2 2015). Toggle between pickup and dropoff density — ' +
      'each frame is a 30-min slice, aggregated server-side at build time.',
    url: '/data/nyc-taxi-od-summary.stt',
    type: 'summary',
    timeRange: {
      start: 1420070400000, // 2015-01-01 00:00:00 UTC
      end: 1420213385000,   // 2015-01-02 15:43:05 UTC
    },
    timeWindow: 1800000, // 30 min — matches the archive's temporal bucket
    targetPlaybackSeconds: 90,
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
    name: 'Earthquake Activity',
    description: 'USGS earthquake archive — global M4.0+ events, 2020-01 → 2024-12',
    url: '/data/earthquakes-v2.stt',
    type: 'point',
    timeRange: {
      start: Date.parse('2020-01-01T00:00:00Z'),
      end: Date.parse('2024-12-31T23:59:59Z'),
    },
    timeWindow: 86400000 * 30, // 30 day window for multi-year data
    targetPlaybackSeconds: 120, // ~5 years plays in ~2 min
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
    id: 'flights',
    name: 'Flight Traffic',
    description: 'Real OpenSky data - 3.96M points, 21K aircraft, 24 hours (Jan 6, 2020)',
    url: '/data/flights.stt',
    type: 'point',
    timeRange: {
      start: 1578268800000,  // 2020-01-06 00:00 UTC
      end: 1578355190000,    // 2020-01-06 23:59 UTC
    },
    timeWindow: 150000, // 15 minute window for 24-hour dataset
    targetPlaybackSeconds: 360, // 24 hours plays in 3 minutes
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
  },
  {
    id: 'flight-paths',
    name: 'Flight Paths',
    description: 'Synthetic linestring tracks for migrated-format demo',
    url: '/data/lines-v2.stt',
    type: 'path',
    timeRange: {
      start: 1600000000000,
      end: 1726272000000,
    },
    timeWindow: 86400000 * 30,
    targetPlaybackSeconds: 60,
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
    name: 'Flight Trips (3D)',
    description: 'Animated 3D flight trajectories - 21K aircraft moving along routes',
    url: '/data/adsb-paths.stt',
    type: 'trips',
    timeRange: {
      start: 1578268800000,  // 2020-01-06 00:00:00 UTC
      end: 1578354650000,    // 2020-01-06 23:50:50 UTC
    },
    timeWindow: 3600000, // 1 hour window for trips
    targetPlaybackSeconds: 600, // 24 hours plays in 10 minutes
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
    trailLength: 60000,
  },
  {
    id: 'hurricanes',
    name: 'Hurricane Tracks',
    description: 'IBTrACS historical hurricane data (Atlantic basin, 2000-2020)',
    url: '/data/hurricanes.stt',
    type: 'point',
    timeRange: {
      start: Date.parse('2020-05-16T18:00:00.000Z'),
      end: Date.parse('2023-11-17T21:00:00.000Z'),
    },
    timeWindow: 86400000 * 14, // 2 week window for multi-year hurricane data
    targetPlaybackSeconds: 120, // ~3.5 years plays in 2 min
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
    description: 'Real NYC TLC trips — 1M pickup/dropoff points (Jan 1 2015, first 2.8h, OSRM per-segment speeds)',
    url: '/data/nyc-rideshare.stt',
    type: 'point',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC (first chronological trip)
      end:   1420080391000,  // 2015-01-01 02:46:31 UTC (50K-trip cap)
    },
    timeWindow: 15000, // 15s window for a 2.8h dataset
    targetPlaybackSeconds: 120, // ~2.8h plays in 2 minutes
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
    radiusUnits: 'pixels',
    radiusScale: 1,
    radiusMinPixels: 1.5,
    radiusMaxPixels: 3,
  },
  {
    id: 'nyc-taxi-od-heatmap',
    name: 'NYC Pickups vs Dropoffs',
    description: 'Density heatmap of taxi pickup (green) vs dropoff (red) hotspots — same TLC trips dataset, split by status (Jan 1 2015, 50K-trip sample)',
    url: '/data/nyc-rideshare.stt',
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
    targetPlaybackSeconds: 120,
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
    description:
      'Vehicle positions interpolated along OSRM-routed taxi paths — 500K trips ' +
      'at ~15s temporal cadence (Jan 1-2, 2015). Derived in-place from ' +
      'nyc-taxi-paths.stt for smooth moving-vehicle animation.',
    url: '/data/nyc-taxi-points.stt',
    type: 'point',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC
      end: 1420213385000,    // 2015-01-02 13:43:05 UTC
    },
    // Match the sampling cadence: the Rust generator emits one interpolated
    // sample every 15s along each trip, so a 15s window catches ~one sample
    // per car per frame. Each vehicle renders as a single point that
    // teleports forward at each sample boundary instead of stacking 2-3
    // overlapping copies (which is what a wider window would do).
    timeWindow: 15000,
    targetPlaybackSeconds: 600, // 1.5 days plays in 10 min
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 14,
      pitch: 45,
      bearing: -15,
    },
    legend: {
      title: 'Trip Status',
      items: [
        { color: '#4CAF50', label: 'Pickup' },
        { color: '#2196F3', label: 'En Route' },
        { color: '#FF5722', label: 'Dropoff' },
      ],
    },
    colorProperty: 'status',
    // Lower alpha so the thousands of overlapping vehicles blend into a
    // density field rather than stacking into opaque blobs.
    colorMapping: {
      pickup: [76, 175, 80, 180],
      enroute: [33, 150, 243, 140],
      dropoff: [255, 87, 34, 180],
    },
    colorMappingDefault: [120, 120, 120, 140],
    // No radiusProperty → DemoPage falls back to a 1000m × radiusScale fixed
    // disc, which at NYC zoom 14 renders as a ~200px blob. Switch to pixels
    // and clamp tight: each vehicle is a 2-3px dot regardless of zoom.
    radiusUnits: 'pixels',
    radiusScale: 1,
    radiusMinPixels: 1.5,
    radiusMaxPixels: 3,
  },
  {
    id: 'nyc-taxi-paths',
    name: 'NYC Taxi Paths',
    description: 'Real TLC trip paths with OSRM routing - 500K trips (Jan 1-2, 2015)',
    url: '/data/nyc-taxi-paths.stt',
    type: 'path',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC
      end: 1420213385000,    // 2015-01-02 13:43:05 UTC
    },
    timeWindow: 60000, // 1 min window for 1.5 day dataset
    targetPlaybackSeconds: 600, // 1.5 days plays in 10 minutes
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
    id: 'nyc-taxi-trips',
    name: 'NYC Taxi Trips',
    description:
      'Animated taxi trips with OSRM routing — 500K trips (Jan 1-2, 2015). Rendered via VAT-trail: one ribbon-strip instance per active trip with positions sampled from a per-tile texture in the vertex shader. Frame cost is independent of per-trajectory vertex count, closing the ~15× perf gap the PathLayer renderer had on this dataset.',
    url: '/data/nyc-taxi-paths.stt',
    type: 'vat',
    timeRange: {
      start: 1420070400000,  // 2015-01-01 00:00:00 UTC
      end: 1420213385000,    // 2015-01-02 13:43:05 UTC
    },
    // Tile-load window: trail is 10s, so 20s comfortably covers the trail plus
    // a margin for tiles arriving slightly ahead of the playhead.
    timeWindow: 20000,
    targetPlaybackSeconds: 60000, // 2 minutes
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
    // VAT-trail config — mirrors the previous PathLayer styling.
    vatTrailColor: [31, 186, 214, 255],
    vatTrailLength: 12500,
    vatTrailSamples: 16,
    vatTripWidth: 3,
    widthMinPixels: 2,
    widthMaxPixels: 8,
    vatFadeTrail: true,
    vatTimeSlots: 64,
  },
  {
    id: 'nyc-taxi-vat',
    name: 'NYC Taxi (VAT)',
    description:
      'Same 500K-trip archive rendered via Vertex Animation Textures — one head per active trip; GPU work is independent of per-trip vertex count.',
    url: '/data/nyc-taxi-paths.stt',
    type: 'vat',
    timeRange: {
      start: 1420070400000,
      end: 1420213385000,
    },
    timeWindow: 15000,
    targetPlaybackSeconds: 60000,
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
    vatHeadColor: [253, 128, 93, 255],
    vatHeadRadiusPixels: 4,
    vatTimeSlots: 64,
  },
  {
    id: 'ship-traffic',
    name: 'US Maritime Traffic',
    description: 'Real AIS data from NOAA Marine Cadastre - 1.29M points, 15.9K vessels, 24 hours (Jan 9, 2023)',
    url: '/data/ais-all-us.stt',
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
    wakeLength: 1800000,    // 30-minute wake behind each ship
    wakeTailScale: 0.15,    // tail shrinks to 15% of head radius
    timeWindow: 3600000,    // 60-min loader window → 30-min past coverage
    targetPlaybackSeconds: 180, // 24 hours plays in 3 minutes
    // Pixel-radius head dot. Meters-based default rendered sub-pixel at
    // zoom 4 — invisible wakes. A 4 px head shrinks to ~0.6 px at the
    // trailing edge, the classic comet-tail look.
    radiusUnits: 'pixels',
    radiusScale: 1,
    radiusMaxPixels: 4,
    initialViewState: {
      longitude: -95,
      latitude: 30,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
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
    description: 'NIFC wildfire perimeters (1000+ acres, 2020-2023) - polygon data',
    url: '/data/wildfires.stt',
    type: 'polygon',
    timeRange: {
      start: 1590969600000, // 2020-06-01T00:00:00Z
      end: 1702339200000,   // 2023-12-11T00:00:00Z
    },
    timeWindow: 86400000 * 30, // 30 day window for multi-year data
    targetPlaybackSeconds: 120, // ~3.5 years plays in 2 minutes
    initialViewState: {
      longitude: -115,
      latitude: 40,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
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
    name: 'Satellite Orbits (Globe)',
    description: 'All active satellites from CelesTrak - 13,506 orbits on 3D globe',
    url: '/data/satellites.stt',
    type: 'trips', // Use trips layer for animated satellite movement
    useGlobe: true, // Render on 3D globe for orbital visualization
    timeRange: {
      start: 1718928000000, // 2024-06-21T00:00:00Z
      end: 1719014400000,   // 2024-06-22T00:00:00Z (24 hours)
    },
    // Time window controls which segments are loaded/visible
    // For LEO satellites with ~90 min orbits and ~40 min segments, use larger window
    timeWindow: 600000, // 10 minute window - loads segments overlapping this range
    targetPlaybackSeconds: 600, // 24 hours plays in 10 minutes for smooth animation
    initialViewState: {
      longitude: 0,
      latitude: 20,
      zoom: 0.5,
      pitch: 0,
      bearing: 0
    },
    legend: {
      title: "Orbit Type",
      items: [
        { color: "#4FC3F7", label: "LEO (Low Earth Orbit)" },
        { color: "#FFB74D", label: "MEO (Medium Earth Orbit)" },
        { color: "#81C784", label: "GEO (Geostationary)" },
        { color: "#E57373", label: "HEO (High Earth Orbit)" }
      ]
    },
    zoomOverride: 0,
    useGlobalBounds: true,
    tripColor: [31, 186, 214, 255],
    tripWidth: 1.5,
    widthMinPixels: 1,
    widthMaxPixels: 3,
    trailLength: 1000,
  },
  {
    id: 'satellite-trips-flat',
    name: 'Satellite Orbits (Flat Map)',
    description: 'All active satellites from CelesTrak - 13,506 animated orbits on flat projection',
    url: '/data/satellites.stt',
    type: 'trips', // Use trips layer for animated satellite movement
    timeRange: {
      start: 1718928000000, // 2024-06-21T00:00:00Z
      end: 1719014400000,   // 2024-06-22T00:00:00Z (24 hours)
    },
    // Time window controls which segments are loaded/visible
    // For LEO satellites with ~90 min orbits and ~40 min segments, use larger window
    timeWindow: 600000, // 10 minute window - loads segments overlapping this range
    targetPlaybackSeconds: 600, // 24 hours plays in 10 minutes for smooth animation
    initialViewState: {
      longitude: 0,
      latitude: 0,
      zoom: 1.2,
      pitch: 0,
      bearing: 0
    },
    legend: {
      title: "Orbit Type",
      items: [
        { color: "#4FC3F7", label: "LEO (Low Earth Orbit)" },
        { color: "#FFB74D", label: "MEO (Medium Earth Orbit)" },
        { color: "#81C784", label: "GEO (Geostationary)" },
        { color: "#E57373", label: "HEO (High Earth Orbit)" }
      ]
    },
    zoomOverride: 0,
    useGlobalBounds: true,
    tripColor: [31, 186, 214, 255],
    tripWidth: 1.5,
    widthMinPixels: 1,
    widthMaxPixels: 3,
    trailLength: 300000,
  },
];

export const DATASETS = datasets;

export function getDatasetById(id: string): Dataset | undefined {
  return datasets.find(d => d.id === id);
}

export const defaultDatasetId = 'earthquake-activity';
