export type DatasetType = 'point' | 'path' | 'heatmap' | 'polygon';

export interface DatasetLegendItem {
  color: string;
  label: string;
}

export interface DatasetLegend {
  title: string;
  items: DatasetLegendItem[];
}

export interface Dataset {
  id: string;
  name: string;
  description: string;
  url: string;
  type: DatasetType;
  timeRange: {
    start: number;
    end: number;
  };
  timeWindow: number;
  /** @deprecated Use targetPlaybackSeconds instead - animationSpeed is computed automatically */
  animationSpeed?: number;
  /** Target duration in seconds for one complete playthrough at 1x speed (default: 30) */
  targetPlaybackSeconds?: number;
  initialViewState: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
  };
  legend?: DatasetLegend;
}

/**
 * Calculate animation speed based on time range and target playback duration.
 * Returns the number of simulation milliseconds per real millisecond.
 */
export function calculateAnimationSpeed(dataset: Dataset): number {
  const timeRangeDuration = dataset.timeRange.end - dataset.timeRange.start;
  const targetSeconds = dataset.targetPlaybackSeconds ?? 30; // Default to 30 seconds
  const targetMs = targetSeconds * 1000;
  return timeRangeDuration / targetMs;
}



