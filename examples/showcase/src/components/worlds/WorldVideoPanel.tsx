/**
 * The Cosmos-generated video for the selected world, locked to the STT playhead.
 *
 * This is the demo's thesis in one component: the vector scene is authoritative
 * and the world model supplies a photoreal manifestation of it, so the two must
 * agree frame for frame. The sync follows `CameraInset`'s pattern (drive media
 * off `TimeController` events rather than React state) with three differences a
 * video needs:
 *
 *   • NORMALIZED mapping. The generated clip is 121 frames of unspecified frame
 *     rate covering one chunk of the source clip, so we map by POSITION in the
 *     loop (`(t - start) / span × video.duration`) rather than assuming any
 *     particular fps. A duration we haven't read yet (`loadedmetadata` pending)
 *     simply defers the first seek.
 *   • FREE-RUN with drift correction. Seeking every tick would thrash the
 *     decoder, so the video plays on its own clock and we only re-seek when it
 *     drifts past {@link DRIFT_TOLERANCE_S}; `playbackRate` is matched to the
 *     sim/real ratio so drift accumulates slowly.
 *   • LOOP + SCRUB. A `wrap` event snaps hard (the loop boundary is a
 *     discontinuity, not drift), and because `tick` also fires on seeks, scrubbing
 *     while paused steps the video frame by frame.
 *
 * Under reduced motion the element never auto-plays; it still tracks the
 * playhead, so scrubbing shows frames without motion happening on its own.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { TimeController } from '@poopdeck.gl/playback';
import {
  resolveWorldAsset,
  variantKey,
  videoVariants,
  weatherCss,
  type WorldScenario,
} from './worldsTypes';

/** Re-seek only past this much drift (seconds of video time). */
const DRIFT_TOLERANCE_S = 0.25;

export interface WorldVideoPanelProps {
  scenario: WorldScenario;
  worldsBase: string;
  timeController: TimeController;
  timeRange: { start: number; end: number };
  /** Active `chunk|weather` key; falls back to the first available variant. */
  variant?: string | null;
  onVariantChange: (key: string) => void;
  reducedMotion: boolean;
}

const WorldVideoPanel: React.FC<WorldVideoPanelProps> = ({
  scenario,
  worldsBase,
  timeController,
  timeRange,
  variant,
  onVariantChange,
  reducedMotion,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [broken, setBroken] = useState(false);

  const variants = useMemo(() => videoVariants(scenario), [scenario]);
  const active = useMemo(() => {
    if (!variants.length) return null;
    return variants.find((v) => variantKey(v) === variant) ?? variants[0];
  }, [variants, variant]);

  const src = active ? resolveWorldAsset(worldsBase, active.path) : null;

  useEffect(() => {
    setBroken(false);
  }, [src]);

  // Depend on the PRIMITIVES, not the `timeRange` object: the parent builds it
  // inline from worlds.json, so a fresh identity every render would tear this
  // effect down and re-seek the video on each one.
  const rangeStart = timeRange.start;
  const rangeEnd = timeRange.end;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || !active) return;

    // The loop IS the generated window: every world's geometry was built for
    // exactly the 121 source frames its video covers (see
    // `cosmos_drive_dreams.transform_clip`), so position in the loop maps
    // straight onto position in the video with nothing left over.
    const winSpan = Math.max(1, rangeEnd - rangeStart);

    const targetFor = (t: number): number | null => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return null;
      const frac = Math.min(1, Math.max(0, (t - rangeStart) / winSpan));
      return frac * duration;
    };

    const sync = (t: number, hard: boolean) => {
      const target = targetFor(t);
      if (target === null) return;
      if (hard || Math.abs(video.currentTime - target) > DRIFT_TOLERANCE_S) {
        try {
          video.currentTime = target;
        } catch {
          /* seeking before the element is ready — the next tick retries */
        }
      }
    };

    const applyRate = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      // Sim-ms per wall-ms × (video seconds / sim seconds of this window).
      const simPerWall = timeController.getSpeed();
      const rate = (simPerWall / 1000) * (duration / (winSpan / 1000));
      video.playbackRate = Math.min(4, Math.max(0.25, rate || 1));
    };

    const onMeta = () => {
      applyRate();
      sync(timeController.getTime(), true);
      if (!reducedMotion && timeController.isPlaying()) {
        void video.play().catch(() => undefined);
      }
    };
    video.addEventListener('loadedmetadata', onMeta);
    if (video.readyState >= 1) onMeta();

    const offTick = timeController.on('tick', (t: number) => sync(t, false));
    const offWrap = timeController.on('wrap', (t: number) => sync(t, true));
    const offPlay = timeController.on('playState', (playing: boolean) => {
      applyRate();
      if (playing && !reducedMotion) void video.play().catch(() => undefined);
      else video.pause();
    });

    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      offTick();
      offWrap();
      offPlay();
      video.pause();
    };
  }, [src, active, timeController, rangeStart, rangeEnd, reducedMotion]);

  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-black/60 shadow-xl">
      <div className="flex items-center justify-between border-b border-white/10 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-400">
        <span>Cosmos generation</span>
        {active && (
          <span style={{ color: weatherCss(active.weather) }}>
            {active.weather.replace(/_/g, ' ')}
          </span>
        )}
      </div>
      <div className="flex aspect-video items-center justify-center bg-slate-900/80">
        {src && !broken ? (
          <video
            ref={videoRef}
            src={src}
            muted
            playsInline
            preload="auto"
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="text-[10px] text-slate-600">
            {broken ? 'video unavailable' : 'no generation for this world'}
          </span>
        )}
      </div>
      {variants.length > 1 && (
        <div className="flex flex-wrap gap-1 border-t border-white/10 px-2 py-1.5">
          {variants.map((v) => {
            const key = variantKey(v);
            const isActive = active && variantKey(active) === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onVariantChange(key)}
                className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                  isActive
                    ? 'bg-white/15 text-white'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
                style={isActive ? { color: weatherCss(v.weather) } : undefined}
              >
                {v.weather.replace(/_/g, ' ')}
                <span className="ml-1 text-slate-600">·{v.chunk}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default WorldVideoPanel;
