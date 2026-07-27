/**
 * Phone-width chrome for the scenario explorer (below Tailwind's `md`
 * breakpoint via {@link useIsMobile}). The desktop layout floats a title card,
 * a wide chip rail and a 320px side panel around the edges, which on a ~390px
 * screen would bury the gallery entirely. This collapses to:
 *
 *   • a slim top bar (back · title · world count);
 *   • a horizontally scrollable chip rail under it;
 *   • the selected world as a bottom sheet (video + prompt + counts);
 *   • the shared timeline pinned to the bottom.
 *
 * The deck is identical to desktop — only the chrome differs. Containers are
 * `pointer-events-none` so their transparent gutters never steal a map pan or
 * pinch; the interactive blocks opt back in. Same idiom as AvMobileChrome.
 */
import React from 'react';
import { Link } from 'react-router';
import Timeline from '../av/Timeline';
import WorldSidePanel from './WorldSidePanel';
import FilterChips from './FilterChips';
import type {
  WorldFilterChip,
  WorldScenario,
  WorldsIndex,
} from './worldsTypes';
import type { WorldsDataset } from '../../types';

export interface WorldsMobileChromeProps {
  dataset: WorldsDataset;
  worlds: WorldsIndex | null;
  worldsBase: string;
  /** The page's `usePlayback` state (spread straight into the Timeline). */
  playback: any;
  selected: WorldScenario | null;
  chips: WorldFilterChip[];
  weatherChips: WorldFilterChip[];
  activeChipId: string | null;
  chipCounts: Record<string, number>;
  onChipSelect: (id: string | null) => void;
  variant: string | null;
  onVariantChange: (key: string) => void;
  onClose: () => void;
  reducedMotion: boolean;
}

const WorldsMobileChrome: React.FC<WorldsMobileChromeProps> = ({
  dataset,
  worlds,
  worldsBase,
  playback,
  selected,
  chips,
  weatherChips,
  activeChipId,
  chipCounts,
  onChipSelect,
  variant,
  onVariantChange,
  onClose,
  reducedMotion,
}) => {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
      {/* Top bar */}
      <div
        className="pointer-events-auto flex items-center gap-2 border-b border-white/10 bg-black/70 px-3 py-2 backdrop-blur-md"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        <Link
          to="/demos"
          className="text-xs text-slate-400"
          aria-label="Back to demos"
        >
          ←
        </Link>
        <span className="truncate text-xs font-medium text-slate-100">
          Scenario Explorer
        </span>
        {worlds && (
          <span className="ml-auto text-[10px] text-slate-500">
            {worlds.scenarios.length} worlds
          </span>
        )}
      </div>

      {/* Chip rail */}
      {worlds && (
        <div className="pointer-events-auto overflow-x-auto px-2 py-1.5">
          <FilterChips
            chips={chips}
            weatherChips={weatherChips}
            activeId={activeChipId}
            onSelect={onChipSelect}
            counts={chipCounts}
            total={worlds.scenarios.length}
            className="flex-nowrap justify-start"
          />
        </div>
      )}

      <div className="flex-1" />

      {/* Selected world sheet */}
      {worlds && selected && (
        <div className="pointer-events-auto px-2 pb-1">
          <WorldSidePanel
            scenario={selected}
            worlds={worlds}
            worldsBase={worldsBase}
            timeController={playback.timeController}
            variant={variant}
            onVariantChange={onVariantChange}
            onClose={onClose}
            reducedMotion={reducedMotion}
            objectColors={dataset.avObjectColors}
            className="max-h-[52vh] w-full"
          />
        </div>
      )}

      {/* Transport */}
      <div
        className="pointer-events-auto px-2 pb-2"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <Timeline
          {...playback}
          timeRange={playback.timeRange ?? dataset.timeRange}
          targetPlaybackSeconds={dataset.targetPlaybackSeconds ?? 4}
        />
      </div>
    </div>
  );
};

export default WorldsMobileChrome;
