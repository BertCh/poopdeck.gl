import React from 'react';

interface LegendProps {
  legend: {
    title: string;
    items: Array<{ color: string; label: string }>;
  };
}

const Legend: React.FC<LegendProps> = ({ legend }) => {
  return (
    <div className="legend">
      <h3>{legend.title}</h3>
      {legend.items.map((item, index) => (
        <div key={index} className="legend-item">
          <div
            className="legend-color"
            style={{ backgroundColor: item.color }}
          />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
};

export default Legend;

