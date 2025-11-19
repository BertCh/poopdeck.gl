export interface DatasetConfig {
  id: string;
  name: string;
  description: string;
  url: string;
  type: 'point' | 'path' | 'heatmap';
  timeRange: {
    start: number;
    end: number;
  };
  timeWindow: number;
  animationSpeed: number;
  initialViewState: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch?: number;
    bearing?: number;
  };
  legend?: {
    title: string;
    items: Array<{
      color: string;
      label: string;
    }>;
  };
}

/**
 * Calculate optimal animation speed for a dataset
 * Goal: Make the entire dataset play through in a comfortable viewing time (3-10 minutes)
 * 
 * @param timeRangeMs - Total time span of the dataset in milliseconds
 * @param targetPlaybackSeconds - Target playback duration in seconds (default: 360 = 6 minutes)
 * @returns Speed in milliseconds of data time per real-time second
 */
function calculateAnimationSpeed(
  timeRangeMs: number,
  targetPlaybackSeconds: number = 360
): number {
  // Calculate how much data time should pass per second of playback
  const speedMs = timeRangeMs / targetPlaybackSeconds;
  
  // Round to nice intervals for better UX
  if (speedMs < 1000) {
    // Sub-second intervals: round to nearest 100ms
    return Math.max(100, Math.round(speedMs / 100) * 100);
  } else if (speedMs < 60000) {
    // Sub-minute intervals: round to nearest second
    return Math.round(speedMs / 1000) * 1000;
  } else if (speedMs < 3600000) {
    // Sub-hour intervals: round to nearest minute
    return Math.round(speedMs / 60000) * 60000;
  } else if (speedMs < 86400000) {
    // Sub-day intervals: round to nearest hour
    return Math.round(speedMs / 3600000) * 3600000;
  } else {
    // Multi-day intervals: round to nearest day
    return Math.round(speedMs / 86400000) * 86400000;
  }
}

export const DATASETS: DatasetConfig[] = [
  (() => {
    const timeRange = {
      start: Date.parse('2023-01-01T00:00:00Z'),
      end: Date.parse('2024-12-31T23:59:59Z'),
    };
    return {
      id: 'earthquake-activity',
      name: 'Earthquake Activity',
      description: 'USGS seismic events (magnitude 4.0+) from Jan 2023 - Dec 2024',
      url: '/data/earthquakes.stt',
      type: 'point' as const,
      timeRange,
      timeWindow: 7 * 86400000, // 7 days
      animationSpeed: calculateAnimationSpeed(timeRange.end - timeRange.start, 300), // ~5 min playback for year-long data
      initialViewState: {
        longitude: -98.5,
        latitude: 39.8,
        zoom: 3,
        pitch: 0,
        bearing: 0,
      },
      legend: {
        title: 'Magnitude',
        items: [
          { color: '#FFEDA0', label: '< 5.0' },
          { color: '#FEB24C', label: '5.0 - 6.0' },
          { color: '#FC4E2A', label: '6.0 - 7.0' },
          { color: '#E31A1C', label: '7.0 - 8.0' },
          { color: '#800026', label: '≥ 8.0' },
        ],
      },
    };
  })(),
  (() => {
    const timeRange = {
      start: Date.parse('2023-01-01T00:00:00Z'),
      end: Date.parse('2023-01-07T23:59:59Z'),
    };
    return {
      id: 'ship-traffic',
      name: 'Maritime Traffic (AIS)',
      description: 'Real AIS data from NOAA Marine Cadastre - All US Waters, 7 days (Jan 1-7, 2023) - 8.9M positions, 23K vessels',
      url: '/data/ais-all-us.stt',
      type: 'point' as const,
      timeRange,
      timeWindow: 3600000 * 2, // 2 hours (matches hourly temporal resolution)
      animationSpeed: calculateAnimationSpeed(timeRange.end - timeRange.start, 240), // ~4 min playback for week-long data
      initialViewState: {
        longitude: -95.0,
        latitude: 37.0,
        zoom: 4,
        pitch: 0,
        bearing: 0,
      },
      legend: {
        title: 'Vessel Type',
        items: [
          { color: '#4A90E2', label: 'Cargo' },
          { color: '#F5A623', label: 'Tanker' },
          { color: '#50E3C2', label: 'Passenger' },
          { color: '#B8E986', label: 'Fishing' },
        ],
      },
    };
  })(),
  (() => {
    const timeRange = {
      start: Date.parse('2020-02-01T00:00:00Z'),
      end: Date.parse('2022-05-31T00:00:00Z'),
    };
    return {
      id: 'covid-cases',
      name: 'COVID-19 Cases',
      description: 'NYT county-level data (5 sample counties) from Feb 2020 - May 2022',
      url: '/data/covid-cases.stt',
      type: 'point' as const,
      timeRange,
      timeWindow: 86400000, // 1 day
      animationSpeed: calculateAnimationSpeed(timeRange.end - timeRange.start, 480), // ~8 min playback for multi-year data
      initialViewState: {
        longitude: -98.5,
        latitude: 39.8,
        zoom: 4,
        pitch: 0,
        bearing: 0,
      },
      legend: {
        title: 'Daily Cases',
        items: [
          { color: '#FED976', label: '< 100' },
          { color: '#FEB24C', label: '100 - 500' },
          { color: '#FD8D3C', label: '500 - 1,000' },
          { color: '#FC4E2A', label: '1,000 - 5,000' },
          { color: '#E31A1C', label: '5,000 - 10,000' },
          { color: '#B10026', label: '≥ 10,000' },
        ],
      },
    };
  })(),
  (() => {
    const timeRange = {
      start: Date.parse('2020-01-01T00:00:00Z'),
      end: Date.parse('2020-12-31T23:59:59Z'),
    };
    return {
      id: 'hurricanes',
      name: 'Hurricane Tracks',
      description: 'NOAA IBTrACS Atlantic hurricanes (Synthetic 2020 Composite)',
      url: '/data/hurricanes.stt',
      type: 'path' as const,
      timeRange,
      timeWindow: 21600000, // 6 hours
      animationSpeed: calculateAnimationSpeed(timeRange.end - timeRange.start, 540), // ~9 min playback for year-long data
      initialViewState: {
        longitude: -60.0,
        latitude: 25.0,
        zoom: 3,
        pitch: 0,
        bearing: 0,
      },
      legend: {
        title: 'Storm Status',
        items: [
          { color: '#00D084', label: 'Tropical Depression' },
          { color: '#FF6B35', label: 'Tropical Storm' },
          { color: '#4A90E2', label: 'Hurricane' },
          { color: '#BD10E0', label: 'Subtropical' },
          { color: '#9013FE', label: 'Extratropical' },
          { color: '#50E3C2', label: 'Disturbance' },
        ],
      },
    };
  })(),
  (() => {
    const timeRange = {
      start: Date.parse('2024-01-15T00:00:00Z'),
      end: Date.parse('2024-01-16T00:00:00Z'),
    };
    return {
      id: 'sf-taxis',
      name: 'San Francisco Taxis',
      description: 'Synthetic taxi trajectories in San Francisco',
      url: '/data/sf-taxis.stt',
      type: 'path' as const,
      timeRange,
      timeWindow: 60000, // 1 minute
      animationSpeed: calculateAnimationSpeed(timeRange.end - timeRange.start, 300), // ~5 min playback for 1 day
      initialViewState: {
        longitude: -122.4194,
        latitude: 37.7749,
        zoom: 12,
        pitch: 45,
        bearing: 0,
      },
      legend: {
        title: 'Status',
        items: [
          { color: '#00D084', label: 'Available' },
          { color: '#FF6B35', label: 'Occupied' },
          { color: '#4A90E2', label: 'Enroute' },
        ],
      },
    };
  })(),
  (() => {
    const timeRange = {
      start: Date.parse('2024-01-01T00:00:00Z'),
      end: Date.parse('2024-01-02T00:00:00Z'),
    };
    return {
      id: 'flights',
      name: 'Flight Traffic',
      description: 'Synthetic aircraft positions',
      url: '/data/flights.stt',
      type: 'point' as const,
      timeRange,
      timeWindow: 60000, // 1 minute
      animationSpeed: calculateAnimationSpeed(timeRange.end - timeRange.start, 300), // ~5 min playback for 1 day
      initialViewState: {
        longitude: -98.5,
        latitude: 39.8,
        zoom: 3,
        pitch: 0,
        bearing: 0,
      },
    };
  })(),
];

export function getDatasetById(id: string): DatasetConfig | undefined {
  return DATASETS.find((dataset) => dataset.id === id);
}
