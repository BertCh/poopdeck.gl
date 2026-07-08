/**
 * Top-left scene selector for the AV cockpit — switches between every
 * `type: 'av'` dataset in the registry. Navigating updates the route param
 * (`/drive/:sceneId`), which the cockpit page re-resolves; a single-scene
 * registry renders just the current name (no dropdown).
 */
import React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { Dataset } from '../../types';

export interface SceneSwitcherProps {
  scenes: Dataset[];
  currentId: string;
  sceneName: string;
  /**
   * Single-row variant for the mobile top bar: drops the "AV Cockpit" eyebrow,
   * tightens the padding, and lets the control fill (and truncate within) its
   * flex slot. Desktop keeps the labelled two-line card.
   */
  compact?: boolean;
}

const SceneSwitcher: React.FC<SceneSwitcherProps> = ({
  scenes,
  currentId,
  sceneName,
  compact = false,
}) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Carry the control query string (render mode, toggles, density, …) across a
  // scene switch so view preferences persist; the cockpit re-validates each
  // param against the new scene and falls back to defaults where it doesn't fit.
  const goToScene = (id: string) =>
    navigate({ pathname: `/drive/${id}`, search: searchParams.toString() });

  return (
    <div
      className={`rounded-lg border border-white/10 bg-black/55 shadow-xl backdrop-blur-md ${
        compact ? 'px-2.5 py-1.5' : 'px-3 py-2'
      }`}
    >
      {!compact && (
        <div className="text-[10px] uppercase tracking-wider text-slate-400">
          AV Cockpit
        </div>
      )}
      {scenes.length > 1 ? (
        <select
          value={currentId}
          onChange={(e) => goToScene(e.target.value)}
          aria-label="Switch AV scene"
          className={`cursor-pointer bg-transparent font-medium text-slate-100 outline-none ${
            compact
              ? 'block w-full max-w-full truncate text-sm'
              : 'mt-1 text-sm'
          }`}
        >
          {scenes.map((s) => (
            <option
              key={s.id}
              value={s.id}
              className="bg-slate-900 text-slate-100"
            >
              {s.name}
            </option>
          ))}
        </select>
      ) : (
        <div
          className={`truncate font-medium text-slate-100 ${
            compact ? 'text-sm' : 'mt-1 text-sm'
          }`}
        >
          {sceneName}
        </div>
      )}
    </div>
  );
};

export default SceneSwitcher;
