import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router';
import type { Dataset } from '../../types';
import DemoViewer from './DemoViewer';
import { useDemoPlayback } from './useDemoPlayback';
import { PlaybackControls } from '@poopdeck.gl/react';
import { useReducedMotion } from '../../lib/reducedMotion';

/**
 * Framed live-map embed for the per-demo landing pages.
 *
 * Playback policy: the viewer mounts immediately — the paused first frame
 * (tiles at timeRange.start) doubles as a live "poster" with no asset
 * pipeline — but playback is visibility-driven: an IntersectionObserver
 * requests play once ≥40% of the frame is on screen and pauses below ~10%
 * (the reader has scrolled into the editorial body), which also stops
 * prefetch traffic while reading. An explicit user pause wins over the
 * observer until the user plays again. `prefers-reduced-motion` disables
 * autoplay entirely. The governor's start gate handles R2 buffering, so an
 * early play request never jank-skips the opening frames.
 *
 * On coarse pointers a transparent tap-shield keeps the map from hijacking
 * page scroll until the reader opts into interacting.
 */
/**
 * Where "open fullscreen" goes. `/demo/:id` is the FLAT deck viewer, which is
 * the wrong surface for the two composite types that have a purpose-built
 * fullscreen page: `av` scenes belong in the cockpit (`/drive/:id` — camera
 * inset, stream rail, telemetry charts, render-mode toggle) and the `worlds`
 * gallery belongs at `/worlds`. Hardcoding `/demo/${id}` here was the only
 * link into either, so both cockpit and gallery were unreachable by clicking.
 */
function fullscreenRoute(dataset: Dataset): { to: string; label: string } {
  if (dataset.type === 'av')
    return { to: `/drive/${dataset.id}`, label: 'Open cockpit' };
  // One `worlds` dataset (cosmos-drive-dreams) and the route selects a scenario,
  // not a dataset — so the bare gallery route, not `/worlds/${id}`.
  if (dataset.type === 'worlds')
    return { to: '/worlds', label: 'Open explorer' };
  return { to: `/demo/${dataset.id}`, label: 'Open fullscreen' };
}

const DemoEmbed: React.FC<{ dataset: Dataset }> = ({ dataset }) => {
  const playback = useDemoPlayback(dataset);
  const frameRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  // An explicit pause from the transport bar must not be undone by scrolling.
  const userPausedRef = useRef(false);
  const onPlayPause = useCallback(() => {
    userPausedRef.current = playback.isPlaying; // pausing → remember it
    playback.onPlayPause();
  }, [playback]);

  const { play, pause } = playback;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    if (reducedMotion) return; // reduce-motion disables visibility autoplay
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.4) {
          if (!userPausedRef.current) play();
        } else if (entry.intersectionRatio < 0.1) {
          pause();
        }
      },
      // Root null = viewport; works even though the page scrolls inside the
      // SiteChrome container (the embed's viewport visibility is what matters).
      { threshold: [0.1, 0.4] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [play, pause, dataset, reducedMotion]);

  // Coarse-pointer tap shield: the map would otherwise capture every touch
  // and trap page scroll. Desktop pointers get the full controller directly.
  const [coarsePointer] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse)').matches,
  );
  const [touchInteractive, setTouchInteractive] = useState(false);
  const interactive = !coarsePointer || touchInteractive;

  const fullscreen = fullscreenRoute(dataset);

  return (
    <div>
      <div
        ref={frameRef}
        className="relative rounded-lg overflow-hidden h-[320px] sm:h-[420px] lg:h-[520px]"
        style={{ background: 'var(--surface-sunken)' }}
      >
        <DemoViewer
          dataset={dataset}
          playback={playback}
          interactive={interactive}
        />

        {/* Open-fullscreen affordance, top-right over the map. */}
        <Link
          to={fullscreen.to}
          className="absolute top-3 right-3 px-2.5 py-1.5 rounded text-xs glass inline-flex items-center gap-1.5"
          style={{ color: 'rgba(255,255,255,0.9)' }}
          title="Open the fullscreen viewer"
        >
          {fullscreen.label}
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M7 17L17 7M9 7h8v8"
            />
          </svg>
        </Link>

        {/* Tap-to-interact shield (coarse pointers only). */}
        {coarsePointer && !touchInteractive && (
          <button
            type="button"
            className="absolute inset-0 w-full h-full flex items-end justify-center pb-4"
            style={{ background: 'transparent', border: 'none' }}
            onClick={() => setTouchInteractive(true)}
            aria-label="Tap to interact with the map"
          >
            <span
              className="px-3 py-1.5 rounded text-xs glass"
              style={{ color: 'rgba(255,255,255,0.9)' }}
            >
              Tap to explore the map
            </span>
          </button>
        )}
        {coarsePointer && touchInteractive && (
          <button
            type="button"
            className="absolute bottom-3 left-3 px-2.5 py-1.5 rounded text-xs glass"
            style={{ color: 'rgba(255,255,255,0.9)', border: 'none' }}
            onClick={() => setTouchInteractive(false)}
            aria-label="Release the map and resume page scrolling"
          >
            ✕ Done exploring
          </button>
        )}
      </div>

      {/* Slim transport bar under the frame — the same TimeControls as the
          fullscreen viewer, so scrubbing/speed behave identically. */}
      <div
        className="mt-3 rounded-md px-4 py-2.5"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--hairline)',
        }}
      >
        <PlaybackControls
          currentTime={playback.currentTime}
          timeRange={dataset.timeRange}
          isPlaying={playback.isPlaying}
          bufferState={playback.bufferState}
          governor={playback.governor}
          onPlayPause={onPlayPause}
          onSeek={playback.onSeek}
          onSpeedChange={playback.onSpeedChange}
          currentSpeedMultiplier={playback.speedMultiplier}
          targetPlaybackSeconds={dataset.targetPlaybackSeconds ?? 30}
          autoSpeed={playback.autoSpeed}
          onAutoSpeedSelect={playback.onAutoSpeedSelect}
          ended={playback.ended}
          loop={playback.loop}
          onLoopToggle={playback.onLoopToggle}
          // NO keyboardShortcuts: this is a scrolling page, so it deliberately
          // does not mount usePlaybackHotkeys — advertising keys that do
          // nothing here would be worse than saying nothing.
        />
      </div>
    </div>
  );
};

export default DemoEmbed;
