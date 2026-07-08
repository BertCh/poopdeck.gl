import React from 'react';
import type { DatasetLegend } from '../types';

interface LegendProps {
  legend: DatasetLegend;
}

const Legend: React.FC<LegendProps> = ({ legend }) => {
  const hasRamps = legend.ramps && legend.ramps.length > 0;
  const hasItems = legend.items && legend.items.length > 0;

  return (
    <div
      className="rounded p-3"
      style={{
        background: 'rgba(36, 39, 48, 0.95)',
        border: '1px solid #3A414C',
        minWidth: 160,
      }}
    >
      <h3 className="text-xs font-semibold mb-2" style={{ color: '#FFFFFF' }}>
        {legend.title}
      </h3>

      {hasRamps && (
        <div className="space-y-2 mb-2">
          {legend.ramps!.map((ramp, idx) => (
            <div key={idx}>
              <div className="text-[10px] mb-1" style={{ color: '#A0A7B4' }}>
                {ramp.label}
              </div>
              <div
                className="h-2 rounded-sm"
                style={{
                  background: `linear-gradient(to right, ${ramp.colors.join(', ')})`,
                  border: '1px solid #3A414C',
                }}
              />
              <div className="flex justify-between mt-0.5">
                <span className="text-[9px]" style={{ color: '#6A7485' }}>
                  low
                </span>
                <span className="text-[9px]" style={{ color: '#6A7485' }}>
                  high
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {hasItems && (
        <div className="space-y-1.5">
          {legend.items!.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-sm shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-[10px]" style={{ color: '#A0A7B4' }}>
                {item.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Legend;
