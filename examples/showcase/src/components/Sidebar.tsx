import React from "react";
import { DatasetConfig } from "../datasets";

interface SidebarProps {
  datasets: DatasetConfig[];
  selectedDatasetId: string;
  onDatasetChange: (datasetId: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  datasets,
  selectedDatasetId,
  onDatasetChange,
}) => {
  // Group datasets by type
  const groupedDatasets = React.useMemo(() => {
    const groups: Record<string, DatasetConfig[]> = {
      point: [],
      path: [],
      heatmap: [],
      polygon: [],
    };

    datasets.forEach((dataset) => {
      groups[dataset.type].push(dataset);
    });

    return groups;
  }, [datasets]);

  const typeLabels: Record<string, string> = {
    point: "Point Visualizations",
    path: "Path & Trajectory",
    heatmap: "Density Heatmaps",
    polygon: "Area Coverage",
  };

  // selectedDataset is available for future use (e.g., showing stats)
  // const selectedDataset = datasets.find((d) => d.id === selectedDatasetId);

  return (
    <div className="sidebar">
      <h1>STT Showcase</h1>
      <p className="subtitle">
        Interactive demonstrations of SpatioTemporal Tiles
      </p>

      {Object.entries(groupedDatasets).map(([type, typeDatasets]) => {
        if (typeDatasets.length === 0) return null;

        return (
          <div key={type} className="dataset-section">
            <h2>{typeLabels[type]}</h2>
            {typeDatasets.map((dataset) => (
              <button
                key={dataset.id}
                className={`dataset-button ${
                  dataset.id === selectedDatasetId ? "active" : ""
                }`}
                onClick={() => onDatasetChange(dataset.id)}
              >
                <span className="title">{dataset.name}</span>
                <span className="description">{dataset.description}</span>
              </button>
            ))}
          </div>
        );
      })}

      {/* Stats section commented out - not part of DatasetConfig
      {selectedDataset?.stats && (
        <div className="stats">
          <div className="stats-row">
            <span className="stats-label">Features:</span>
            <span>{selectedDataset.stats.totalFeatures.toLocaleString()}</span>
          </div>
          <div className="stats-row">
            <span className="stats-label">Frames:</span>
            <span>{selectedDataset.stats.totalFrames.toLocaleString()}</span>
          </div>
          <div className="stats-row">
            <span className="stats-label">File Size:</span>
            <span>{selectedDataset.stats.fileSize}</span>
          </div>
        </div>
      )}
      */}
    </div>
  );
};

export default Sidebar;
