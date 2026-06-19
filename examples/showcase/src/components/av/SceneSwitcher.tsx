/**
 * Top-left scene selector for the AV cockpit — switches between every
 * `type: 'av'` dataset in the registry. Navigating updates the route param
 * (`/drive/:sceneId`), which the cockpit page re-resolves; a single-scene
 * registry renders just the current name (no dropdown).
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import type { Dataset } from "../../types";

export interface SceneSwitcherProps {
  scenes: Dataset[];
  currentId: string;
  sceneName: string;
}

const SceneSwitcher: React.FC<SceneSwitcherProps> = ({
  scenes,
  currentId,
  sceneName,
}) => {
  const navigate = useNavigate();

  return (
    <div className="rounded-lg border border-white/10 bg-black/55 backdrop-blur-md px-3 py-2 shadow-xl">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        AV Cockpit
      </div>
      {scenes.length > 1 ? (
        <select
          value={currentId}
          onChange={(e) => navigate(`/drive/${e.target.value}`)}
          className="mt-1 bg-transparent text-sm font-medium text-slate-100 outline-none cursor-pointer"
        >
          {scenes.map((s) => (
            <option key={s.id} value={s.id} className="bg-slate-900 text-slate-100">
              {s.name}
            </option>
          ))}
        </select>
      ) : (
        <div className="mt-1 text-sm font-medium text-slate-100">{sceneName}</div>
      )}
    </div>
  );
};

export default SceneSwitcher;
