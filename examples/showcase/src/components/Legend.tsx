import React from 'react';

interface LegendProps {
  legend: {
    title: string;
    items: Array<{ color: string; label: string }>;
  };
}

const Legend: React.FC<LegendProps> = ({ legend }) => {
  return (
    <div className="rounded p-3" style={{ background: 'rgba(36, 39, 48, 0.95)', border: '1px solid #3A414C', minWidth: 140 }}>
      <h3 className="text-xs font-semibold mb-2" style={{ color: '#FFFFFF' }}>{legend.title}</h3>
      <div className="space-y-1.5">
        {legend.items.map((item, index) => (
          <div key={index} className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: item.color }} />
            <span className="text-[10px]" style={{ color: '#A0A7B4' }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Legend;
