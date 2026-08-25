import React, { useState } from 'react';
import type { DatasetLegend } from '../types';

interface LegendProps {
  legend: DatasetLegend;
  /**
   * Render as a tap-to-open chip instead of a permanently-parked card. A
   * legend for a many-item dataset is 200×220px of opaque panel; on a phone
   * that is a tenth of the map, permanently, for a reference the reader
   * consults once. Collapsed it is a single pill carrying the first swatch,
   * and it expands UPWARD so it grows away from the transport bar below it.
   */
  collapsible?: boolean;
}

/** The one swatch that best stands for the legend — the pill's colour cue. */
function leadColor(legend: DatasetLegend): string | undefined {
  const ramp = legend.ramps?.[0]?.colors;
  if (ramp?.length) return ramp[ramp.length - 1];
  return legend.items?.[0]?.color;
}

const LegendBody: React.FC<LegendProps> = ({ legend }) => {
  const hasRamps = legend.ramps && legend.ramps.length > 0;
  const hasItems = legend.items && legend.items.length > 0;

  return (
    <>
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
    </>
  );
};

const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(36, 39, 48, 0.95)',
  border: '1px solid #3A414C',
  minWidth: 160,
};

const Legend: React.FC<LegendProps> = ({ legend, collapsible = false }) => {
  const [open, setOpen] = useState(false);

  if (!collapsible) {
    return (
      <div className="rounded p-3" style={PANEL_STYLE}>
        <h3 className="text-xs font-semibold mb-2" style={{ color: '#FFFFFF' }}>
          {legend.title}
        </h3>
        <LegendBody legend={legend} />
      </div>
    );
  }

  const swatch = leadColor(legend);

  // Column-reverse so the panel stacks ABOVE the pill: the chip keeps its
  // position while the card grows up the map rather than pushing itself off
  // the bottom edge (or under the transport bar).
  return (
    <div className="flex flex-col-reverse items-end gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        // Titles run long ("Sea-surface temperature"), and a pill that spans
        // the phone gutter is the panel it was supposed to replace.
        className="flex max-w-[60vw] items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-[11px] text-slate-300 backdrop-blur-md"
      >
        {swatch && (
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: swatch }}
          />
        )}
        <span className="truncate">{legend.title}</span>
        <span aria-hidden className="shrink-0" style={{ color: '#6A7485' }}>
          {open ? '▾' : '▴'}
        </span>
      </button>
      {open && (
        <div
          className="max-h-[45vh] overflow-y-auto overscroll-contain rounded p-3"
          style={PANEL_STYLE}
        >
          <LegendBody legend={legend} />
        </div>
      )}
    </div>
  );
};

export default Legend;
