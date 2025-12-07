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
  animationSpeed: number;
  initialViewState: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
  };
  legend?: DatasetLegend;
}



