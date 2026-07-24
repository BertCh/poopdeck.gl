/**
 * Single-select filter chips for the scenario gallery.
 *
 * SINGLE-select, not checkboxes: the GPU DataFilter extension the STT layers
 * use supports one numeric column at a time (`filterSize: 1`), so two
 * simultaneous predicates would need a pre-baked combined column. Picking a
 * chip hides the non-matching worlds' geometry outright (the extension has no
 * dim mode) while their anchor dots stay faintly drawn, so the grid keeps its
 * shape and you can see what you filtered out.
 */
import React from 'react';
import { weatherCss, type WorldFilterChip } from './worldsTypes';

export interface FilterChipsProps {
  /** Scene-content predicates (pedestrians, density, counterfactuals). */
  chips: WorldFilterChip[];
  /** Per-weather predicates, generated from the index. */
  weatherChips: WorldFilterChip[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  /** Match counts by chip id, for the "n worlds" hint. */
  counts: Record<string, number>;
  total: number;
  className?: string;
}

const FilterChips: React.FC<FilterChipsProps> = ({
  chips,
  weatherChips,
  activeId,
  onSelect,
  counts,
  total,
  className,
}) => {
  const chip = (c: WorldFilterChip, accent?: string) => {
    const active = c.id === activeId;
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => onSelect(active ? null : c.id)}
        title={`${counts[c.id] ?? 0} of ${total} worlds`}
        className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
          active
            ? 'border-white/40 bg-white/15 text-white'
            : 'border-white/10 bg-black/40 text-slate-400 hover:border-white/25 hover:text-slate-100'
        }`}
        style={
          accent && active ? { borderColor: accent, color: accent } : undefined
        }
      >
        {c.label}
        <span className="ml-1.5 text-slate-500">{counts[c.id] ?? 0}</span>
      </button>
    );
  };

  return (
    <div
      className={`flex flex-wrap items-center justify-end gap-1.5 ${className ?? ''}`}
    >
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
          activeId === null
            ? 'border-white/40 bg-white/15 text-white'
            : 'border-white/10 bg-black/40 text-slate-400 hover:border-white/25 hover:text-slate-100'
        }`}
      >
        All worlds
        <span className="ml-1.5 text-slate-500">{total}</span>
      </button>
      {chips.map((c) => chip(c))}
      <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
      {weatherChips.map((c) => chip(c, weatherCss(c.id.replace(/^wx-/, ''))))}
    </div>
  );
};

export default FilterChips;
