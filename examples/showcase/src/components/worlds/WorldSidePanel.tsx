/**
 * Detail panel for the selected world: its generated video (clock-synced), the
 * prompt that produced it, what's actually in the scene, and provenance.
 *
 * Deliberately reads as a "specimen card" — the gallery's claim is that each
 * cell is a real, inspectable scenario rather than a thumbnail, so the panel
 * shows the counts that came out of the geometry (agents by class) next to the
 * text prompt the world model was given.
 */
import React from 'react';
import type { TimeController } from '@poopdeck.gl/playback';
import WorldVideoPanel from './WorldVideoPanel';
import {
  weatherCss,
  type WorldScenario,
  type WorldsIndex,
} from './worldsTypes';
import type { ColorRGBA } from '../../types';

export interface WorldSidePanelProps {
  scenario: WorldScenario;
  worlds: WorldsIndex;
  worldsBase: string;
  timeController: TimeController;
  variant: string | null;
  onVariantChange: (key: string) => void;
  onClose: () => void;
  reducedMotion: boolean;
  objectColors?: Record<string, ColorRGBA>;
  className?: string;
}

function rgba(c: ColorRGBA | undefined): string {
  if (!c) return 'rgba(150,160,175,0.85)';
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})`;
}

const WorldSidePanel: React.FC<WorldSidePanelProps> = ({
  scenario,
  worlds,
  worldsBase,
  timeController,
  variant,
  onVariantChange,
  onClose,
  reducedMotion,
  objectColors,
  className,
}) => {
  const counts = Object.entries(scenario.counts).sort((a, b) => b[1] - a[1]);
  const durationS = (scenario.timeRange.end - scenario.timeRange.start) / 1000;

  return (
    <div
      className={`flex flex-col gap-3 overflow-y-auto rounded-lg border border-white/10 bg-black/70 p-3 shadow-2xl backdrop-blur-md ${
        className ?? 'w-80'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-slate-200">
              {scenario.id}
            </span>
            {scenario.hero && (
              <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-cyan-300">
                LiDAR
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[10px] text-slate-500">
            row {scenario.row} · col {scenario.col} · {durationS.toFixed(1)}s
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-xs text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Back to all worlds"
        >
          ✕
        </button>
      </div>

      <WorldVideoPanel
        scenario={scenario}
        worldsBase={worldsBase}
        timeController={timeController}
        timeRange={{
          start: worlds.t0,
          end: worlds.t0 + worlds.durationMs,
        }}
        variant={variant}
        onVariantChange={onVariantChange}
        reducedMotion={reducedMotion}
      />

      {scenario.caption && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
            Generation prompt
          </div>
          <p className="text-xs leading-relaxed text-slate-300">
            {scenario.caption}
          </p>
        </div>
      )}

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            Agents in scene
          </span>
          <span className="text-xs text-slate-300">{scenario.agentCount}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {counts.map(([category, n]) => (
            <span
              key={category}
              className="rounded border px-1.5 py-0.5 text-[10px]"
              style={{
                borderColor: rgba(objectColors?.[category]),
                color: rgba(objectColors?.[category]),
              }}
            >
              {category} · {n}
            </span>
          ))}
          {counts.length === 0 && (
            <span className="text-[10px] text-slate-600">
              no tracked agents
            </span>
          )}
        </div>
      </div>

      <div className="border-t border-white/10 pt-2 text-[10px] leading-relaxed text-slate-500">
        <div>
          Manifestation:{' '}
          <span style={{ color: weatherCss(scenario.weather) }}>
            {scenario.weather ? scenario.weather.replace(/_/g, ' ') : '—'}
          </span>
        </div>
        <div className="mt-1 break-all font-mono text-[9px] text-slate-600">
          {scenario.clip} · frames {scenario.chunk * worlds.videoFrames}–
          {(scenario.chunk + 1) * worlds.videoFrames - 1}
        </div>
        <div className="mt-1">
          <a
            href={worlds.datasetUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-200"
          >
            {worlds.dataset}
          </a>{' '}
          · {worlds.license}
        </div>
      </div>
    </div>
  );
};

export default WorldSidePanel;
