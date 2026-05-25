import { DatasetType } from './types';

const pointLayerExample = `import { AnimatedPointLayer, TimeController } from '@stt/deck.gl';

// Create a time controller for animation
const timeController = new TimeController({
  initialTime: Date.parse('2020-01-01'),
  speed: 86400000 / 60, // 1 day per minute
  loop: true,
});

// Create the animated point layer
const layer = new AnimatedPointLayer({
  id: 'earthquakes',
  data: '/data/earthquakes.stt',
  currentTime: timeController.getTime(),
  timeController,
  timeWindow: 86400000 * 30, // 30-day window
  fillColor: [255, 128, 0], // Orange points
  radius: 1000,
  radiusUnits: 'meters',
  radiusScale: 2,
  opacity: 0.8,
});`;

const pathLayerExample = `import { AnimatedPathLayer, TimeController } from '@stt/deck.gl';

const timeController = new TimeController({
  initialTime: 1578268800000,
  speed: 86400000 / 300, // 24 hours in 5 minutes
  loop: true,
});

const layer = new AnimatedPathLayer({
  id: 'flight-paths',
  data: '/data/flight-paths.stt',
  currentTime: timeController.getTime(),
  timeController,
  timeWindow: 600000, // 10 minute window
  pathColor: [79, 195, 247], // Cyan paths
  pathWidth: 3,
  widthUnits: 'pixels',
});`;

const tripsLayerExample = `import { AnimatedTripsLayer, TimeController } from '@stt/deck.gl';

const timeController = new TimeController({
  initialTime: 1420070400000, // 2015-01-01 00:00 UTC
  speed: 142985000 / 600, // 1.5 days in 10 minutes
  loop: true,
});

const layer = new AnimatedTripsLayer({
  id: 'taxi-trips',
  data: '/data/nyc-taxi-paths.stt',
  currentTime: timeController.getTime(),
  timeController,
  timeWindow: 300000, // 5 minute window
  tripColor: [253, 128, 93], // Warm orange
  tripWidth: 4,
  widthMinPixels: 2,
  widthMaxPixels: 8,
  trailLength: 60000, // 1 minute trail
  fadeTrail: true,
  capRounded: true,
  jointRounded: true,
});`;

const heatmapLayerExample = `import { HeatmapTimeLayer, TimeController } from '@stt/deck.gl';

const timeController = new TimeController({
  initialTime: Date.parse('2020-01-01'),
  speed: 86400000 / 120, // 1 day per 2 minutes
  loop: true,
});

const layer = new HeatmapTimeLayer({
  id: 'heatmap',
  data: '/data/activity.stt',
  currentTime: timeController.getTime(),
  timeController,
  timeWindow: 3600000, // 1 hour window
  radiusPixels: 30,
  intensity: 1,
  colorRange: [
    [255, 255, 178],
    [254, 204, 92],
    [253, 141, 60],
    [240, 59, 32],
    [189, 0, 38],
  ],
  weightProperty: 'magnitude',
});`;

const polygonLayerExample = `import { AnimatedPolygonLayer, TimeController } from '@stt/deck.gl';

const timeController = new TimeController({
  initialTime: 1590969600000,
  speed: 86400000 * 30 / 120, // 30 days per 2 minutes
  loop: true,
});

const layer = new AnimatedPolygonLayer({
  id: 'wildfires',
  data: '/data/wildfires.stt',
  currentTime: timeController.getTime(),
  timeController,
  timeWindow: 86400000 * 30, // 30 day window
  filled: true,
  stroked: false,
  fillColor: [255, 140, 0, 180],
  opacity: 0.8,
});`;

const satelliteGlobeExample = `import { AnimatedTripsLayer, TimeController } from '@stt/deck.gl';
import { _GlobeView as GlobeView } from '@deck.gl/core';

const timeController = new TimeController({
  initialTime: 1718928000000,
  speed: 86400000 / 600, // 24 hours in 10 minutes
  loop: true,
});

// Use GlobeView for orbital visualization
const view = new GlobeView({ id: 'globe', resolution: 10 });

const layer = new AnimatedTripsLayer({
  id: 'satellites',
  data: '/data/satellites.stt',
  currentTime: timeController.getTime(),
  timeController,
  timeWindow: 600000, // 10 minute window
  zoomOverride: 0, // Load all global tiles
  useGlobalBounds: true,
  tripColor: [79, 195, 247], // Cyan for satellites
  tripWidth: 1.5,
  trailLength: 1000,
  fadeTrail: true,
});`;

const summaryLayerExample = `import { H3SummaryLayer, TimeController } from '@stt/deck.gl';

// Summary-tier hexagons. The archive must have been built with
// stt-build --summary-tier h3.
const timeController = new TimeController({
  initialTime: Date.parse('2020-01-01'),
  speed: 86400000 / 60,
  loop: true,
});

const layer = new H3SummaryLayer({
  id: 'earthquake-summary',
  data: '/data/earthquakes-summary.stt',
  currentTime: timeController.getTime(),
  timeController,
  // 'count' is the implicit per-cell count column. Aggregated columns
  // are addressable as e.g. 'mean_magnitude', 'max_magnitude'.
  weightProperty: 'count',
  colorDomain: [1, 200],
  colorRange: [
    [255, 255, 204, 220],
    [254, 217, 142, 230],
    [254, 153,  41, 235],
    [217,  95,  14, 240],
    [153,  52,   4, 250],
    [102,  37,   6, 255],
  ],
  coverage: 0.94,
  opacity: 0.85,
});`;

const vatLayerExample = `import { VatTripsLayer, TimeController } from '@stt/deck.gl';

const timeController = new TimeController({
  initialTime: 1420070400000,
  speed: 142985000 / 600,
  loop: true,
});

// Vertex Animation Texture: one quad per active trip, positions baked
// into a per-tile 2D texture and sampled in the vertex shader. Scales
// independently of per-trip vertex count.
const layer = new VatTripsLayer({
  id: 'taxi-vat',
  data: '/data/nyc-taxi-paths.stt',
  currentTime: timeController.getTime(),
  timeController,
  timeWindow: 60000,
  headColor: [253, 128, 93, 255],
  headRadiusPixels: 4,
  timeSlots: 64,
});`;

const codeExamples: Record<DatasetType, string> = {
  point: pointLayerExample,
  path: pathLayerExample,
  trips: tripsLayerExample,
  vat: vatLayerExample,
  heatmap: heatmapLayerExample,
  polygon: polygonLayerExample,
  summary: summaryLayerExample,
};

const datasetSpecificExamples: Record<string, string> = {
  'satellites': satelliteGlobeExample,
  'satellite-trips-flat': satelliteGlobeExample,
};

export function getCodeExample(type: DatasetType, datasetId: string): string {
  // Check for dataset-specific example first
  if (datasetSpecificExamples[datasetId]) {
    return datasetSpecificExamples[datasetId];
  }
  // Fall back to type-based example
  return codeExamples[type] || tripsLayerExample;
}


