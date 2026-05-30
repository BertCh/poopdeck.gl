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

export const datasets: Dataset[] = [
  {
    id: 'nyc-taxi-od-summary',
    name: 'NYC Pickup vs Dropoff Hex Density',
    description:
      'H3 hex-bin density of 1.36M NYC taxi pickups and dropoffs (Jan 1-2, 2015). ' +
      'Toggle pickup vs dropoff.',
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
    description: 'OpenSky aircraft positions — 21K aircraft over 24h (Jan 6, 2020)',
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
    description: 'Synthetic flight tracks',
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
    description: '3D flight trajectories — 21K aircraft (Jan 6, 2020)',
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
    trailLength: 120000,
  },
  {
    id: 'hurricanes',
    name: 'Hurricane Tracks',
    description: 'IBTrACS hurricane tracks — Atlantic basin (2020-2023)',
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
    description: 'NYC TLC taxi pickups and dropoffs — 1M points (Jan 1, 2015, first 2.8h)',
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
    description: 'Density heatmap of NYC taxi pickups (green) vs dropoffs (red), Jan 1, 2015',
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
      'Animated NYC taxi vehicle positions — 500K trips (Jan 1-2, 2015)',
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
    description: 'NYC taxi trip paths — 500K trips (Jan 1-2, 2015)',
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
      'Animated NYC taxi trips — 500K trips (Jan 1-2, 2015)',
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
      'NYC taxi trips as moving point heads — 500K trips (Jan 1-2, 2015)',
    url: '/data/nyc-taxi-paths.stt',
    type: 'vat',
    timeRange: {
      start: 1420070400000,
      end: 1420213385000,
    },
    timeWindow: 20000,
    targetPlaybackSeconds: 6000,
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
    description: 'NOAA Marine Cadastre AIS — 15.9K vessels over 24h (Jan 9, 2023)',
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
    wakeLength: 3600000,    // 30-minute wake behind each ship
    wakeTailScale: 0.15,    // tail shrinks to 15% of head radius
    timeWindow: 5600000,    // 60-min loader window → 30-min past coverage
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
    description: 'NIFC wildfire perimeters — 1000+ acres (2020-2023)',
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
    name: 'Satellite Orbits',
    description: '~12,700 low-Earth-orbit satellites from CelesTrak over 24h (2024-06-21). Defaults to the globe; flip to flat at top-left.',
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
    targetPlaybackSeconds: 900, // 24h in ~15 min — slow enough to follow LEO streaks
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
    description:
      'Animal tracking studies from GBIF, coloured by taxonomic class; ' +
      'multi-year tracks folded into one year. Data: GBIF.org (CC0 / CC-BY / ' +
      'CC-BY-NC).',
    url: '/data/animals.stt',
    type: 'trips',
    timeRange: {
      start: Date.parse('2024-01-01T00:00:00Z'),
      end: Date.parse('2025-01-01T00:00:00Z'),
    },
    // Day-scale loader window (1-day temporal buckets); ~2× the trail so the
    // loader covers the past portion of each fading trail.
    timeWindow: 86400000 * 4,
    targetPlaybackSeconds: 210, // one folded year in ~3.5 min
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
    tripWidth: 1.5,
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
    description:
      'NOAA Global Drifter Program surface-buoy tracks, 1979→2022, coloured ' +
      'by sea-surface temperature. Data: NOAA AOML / PMEL (public domain).',
    url: '/data/drifters.stt',
    type: 'trips',
    useGlobe: true,
    timeRange: {
      start: 287884800000,  // 1979-02-15 — first fix in the GDP record
      end: 1667844000000,   // 2022-11-07 — last fix (PMEL interpolated product ends here)
    },
    // ~43 years compress into ~10 min, so sim-time races by; the loader window
    // is wide (weekly build buckets → ~30 buckets) and the trail long so each
    // comet tail still lasts a few real seconds.
    timeWindow: 86400000 * 200,
    targetPlaybackSeconds: 600, // 43 years of currents in ~10 min
    initialViewState: {
      longitude: -40,
      latitude: 25,
      zoom: 0.7,
      pitch: 0,
      bearing: 0,
    },
    colorProperty: 'temp_band',
    colorMapping: {
      cold:    [44, 90, 200, 235],
      cool:    [40, 180, 200, 235],
      mild:    [250, 210, 90, 235],
      warm:    [244, 140, 60, 235],
      hot:     [220, 50, 47, 235],
      unknown: [130, 130, 130, 170],
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
      items: [
        { color: '#2C5AC8', label: '< 5 °C' },
        { color: '#28B4C8', label: '5–15 °C' },
        { color: '#FAD25A', label: '15–22 °C' },
        { color: '#F48C3C', label: '22–27 °C' },
        { color: '#DC322F', label: '≥ 27 °C' },
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
    name: 'OSM Editing — NYC Draws Itself',
    description:
      'OpenStreetMap node creations in New York City, 2007→2025, coloured by ' +
      'year created. © OpenStreetMap contributors (ODbL).',
    url: '/data/osm-nyc-nodes.stt',
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
    targetPlaybackSeconds: 180, // ~19 years in 4 minutes
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
    // Tight pixel dots so millions of creations read as line-work, not blobs.
    radiusUnits: 'pixels',
    radiusScale: 1,
    radiusMinPixels: 1,
    radiusMaxPixels: 2,
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
    url: '/data/osm-nyc-changesets.stt',
    type: 'summary',
    timeRange: {
      start: Date.parse('2007-01-01T00:00:00Z'),
      end: Date.parse('2026-01-01T00:00:00Z'),
    },
    timeWindow: 86400000 * 30, // matches the 30-day temporal bucket
    targetPlaybackSeconds: 120,
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
    url: '/data/osm-nyc-changesets.stt',
    type: 'point',
    timeRange: {
      start: Date.parse('2007-01-01T00:00:00Z'),
      end: Date.parse('2026-01-01T00:00:00Z'),
    },
    timeWindow: 86400000 * 60, // 60-day rolling window of editing activity
    targetPlaybackSeconds: 120,
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
    radiusUnits: 'pixels',
    radiusScale: 1,
    radiusMinPixels: 2,
    radiusMaxPixels: 4,
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

export const DATASETS = datasets;

export function getDatasetById(id: string): Dataset | undefined {
  return datasets.find(d => d.id === id);
}

export const defaultDatasetId = 'earthquake-activity';
