/**
 * Fullscreen demo viewer (`/demo/:id`, plus the legacy `/maplibre/:id`
 * alias). The map surface and playback wiring live in shared pieces —
 * `DemoViewer` and `useDemoPlayback` — so the per-demo landing-page embed
 * renders the identical demo; this page is just the fullscreen shell around
 * them.
 *
 * Layout: the map is full-bleed (fills the whole surface, no frame) and the
 * chrome floats *on top of* it — a title/description panel top-left and the
 * transport bar bottom-centre — matching the AV cockpit and the in-map
 * legend/cube chips. This inverts the old "map inset inside page chrome"
 * frame into "UI inside the map".
 */
import React, {
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams, useLocation, Navigate, Link } from 'react-router';
import { getDatasetById } from '../datasets';
import { getDemoMeta } from '../content/demoMeta';
import DemoViewer from '../components/demo/DemoViewer';
import DemoHoverPreview from '../components/demo/DemoHoverPreview';
import type { DemoCamera } from '../components/demo/previewBasemap';
import {
  MAPLIBRE_RENDERABLE_TYPES,
  datasetSupportsThree,
} from '../lib/rendererEligibility';
import { useDemoPlayback } from '../components/demo/useDemoPlayback';
import { usePlaybackHotkeys, PlaybackControls } from '@poopdeck.gl/react';
// The site's own reduced-motion hook, as every other animated surface here uses
// (`@poopdeck.gl/react` re-exports an equivalent one, but it is a symlinked
// workspace package that Vite PRE-BUNDLES; that cache is not invalidated when
// the package's dist is rebuilt, so importing a newly-added export from it
// breaks this lazily-loaded route until `node_modules/.vite` is cleared).
import { useReducedMotion } from '../lib/reducedMotion';

/** Idle time before the floating transport fades out during playback. */
const CHROME_IDLE_MS = 3000;

const MaplibreRenderer = React.lazy(
  () => import('../components/MaplibreRenderer'),
);
const SttThreeGeoViewer = React.lazy(
  () => import('../components/demo/SttThreeGeoViewer'),
);

/**
 * `PlaybackControls` is authored in the site's light editorial theme (dark ink
 * on a white surface). Floated over the dark map it needs the inverse palette,
 * so we remap its CSS custom properties on the wrapper instead of forking the
 * shared, published component. Values mirror the dark in-map chips already in
 * `DemoViewer` (cube/summary controls) and the app's cyan data accent.
 */
const DARK_CONTROL_THEME = {
  '--ink-900': '#f4f5f7',
  '--ink-700': '#d5d8de',
  '--ink-500': '#a0a7b4',
  '--ink-400': '#7b8494',
  '--surface': '#262a33',
  '--hairline': 'rgba(255, 255, 255, 0.14)',
  '--accent': '#1fbad6',
  '--accent-soft': 'rgba(31, 186, 214, 0.16)',
  '--page-bg': '#15171c',
} as React.CSSProperties;

const DemoPage: React.FC = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const location = useLocation();
  // Keep benchmark diagnostics opt-in in production. The HUD activates layer
  // snapshots and a frame sampler; normal visitors should pay neither cost.
  const showPerfHud =
    import.meta.env.DEV || new URLSearchParams(location.search).has('perf');
  const selectedDataset = useMemo(
    () => getDatasetById(datasetId || ''),
    [datasetId],
  );

  const playback = useDemoPlayback(selectedDataset);

  // Video-player keyboard map (Space/K, ←/→, J/L, ,/., Home/End, </>, 0–9) —
  // fullscreen-only: the scrolling embed pages must not capture window keys.
  // Speed is on </> (not ↑/↓) and ←/→ yield to a focused map canvas, so the
  // deck/maplibre/Cesium arrow-key pan underneath still works.
  usePlaybackHotkeys(playback, selectedDataset?.timeRange);

  // Renderer toggle (deck.gl ↔ maplibre ↔ Three). The legacy `/maplibre/:id`
  // deep-links land directly on the maplibre renderer; the toggle keeps every
  // capable renderer reachable from either route. maplibre adapter is
  // mercator-only; the `@poopdeck.gl/three` (TSL/WebGPU) path handles the FLAT,
  // metro-scale geo demos (see `datasetSupportsThree`).
  const [renderer, setRenderer] = useState<'deck' | 'maplibre' | 'three'>(
    location.pathname.startsWith('/maplibre/') ? 'maplibre' : 'deck',
  );
  // One radio GROUP name per mounted page — native radios are grouped by name,
  // and a hardcoded one would join two mounted demos into a single group.
  const rendererGroup = useId();
  const maplibreCapable =
    selectedDataset != null &&
    MAPLIBRE_RENDERABLE_TYPES.has(selectedDataset.type);
  const threeCapable =
    selectedDataset != null && datasetSupportsThree(selectedDataset);

  // Live camera from the deck viewer — fed to the scrubber's hover preview so
  // the thumbnail mirrors what the user is looking at.
  const [camera, setCamera] = useState<DemoCamera | null>(null);

  // ── Idle-hide the floating transport (video-player convention) ─────────────
  // The bar sits ON the map, so during playback it is permanently spending map
  // real estate. Fade it out after CHROME_IDLE_MS of no input and bring it
  // straight back on any pointer/key/focus activity. Only ever while PLAYING —
  // a paused map keeps its controls, which is what a user who stopped to look
  // at something expects. It also never fades out from under a hovering
  // pointer or a keyboard user inside the bar.
  const reducedMotion = useReducedMotion();
  const transportRef = useRef<HTMLDivElement | null>(null);
  const [transportIdle, setTransportIdle] = useState(false);
  const isPlaying = playback.isPlaying;
  useEffect(() => {
    if (!isPlaying) {
      setTransportIdle(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      setTransportIdle(false);
      timer = setTimeout(() => {
        const bar = transportRef.current;
        const busy =
          bar != null &&
          (bar.matches(':hover') || bar.contains(document.activeElement));
        if (busy) arm();
        else setTransportIdle(true);
      }, CHROME_IDLE_MS);
    };
    arm();
    const opts = { passive: true } as const;
    window.addEventListener('pointermove', arm, opts);
    window.addEventListener('pointerdown', arm, opts);
    window.addEventListener('wheel', arm, opts);
    window.addEventListener('keydown', arm);
    window.addEventListener('focusin', arm);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', arm);
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('wheel', arm);
      window.removeEventListener('keydown', arm);
      window.removeEventListener('focusin', arm);
    };
  }, [isPlaying]);

  if (!selectedDataset) return <Navigate to="/" replace />;
  const useMaplibre = renderer === 'maplibre' && maplibreCapable;
  const useThree = renderer === 'three' && threeCapable;
  const hasAltRenderer = maplibreCapable || threeCapable;

  // Catalog demos link back to their landing page; excluded ones to the grid.
  const backTarget = getDemoMeta(selectedDataset.id)
    ? `/demos/${selectedDataset.id}`
    : '/demos';

  // Push DemoViewer's top-left in-map chips (cube / summary toggle) below the
  // floating header so they don't collide. The header grows by one row when
  // the renderer toggle is present, so budget a little more for it.
  const headerInset = hasAltRenderer ? 148 : 112;

  return (
    <div
      className="h-full relative overflow-hidden"
      style={{ background: '#0a0d12' }}
    >
      {/* Full-bleed map — fills the whole surface; the chrome floats on top. */}
      <div className="absolute inset-0">
        <Suspense
          fallback={
            <div className="w-full h-full" style={{ background: '#0a0d12' }} />
          }
        >
          {useMaplibre ? (
            <MaplibreRenderer
              key={selectedDataset.id}
              dataset={selectedDataset}
              timeController={playback.timeController}
              registry={playback.registry}
            />
          ) : useThree ? (
            <SttThreeGeoViewer
              key={selectedDataset.id}
              dataset={selectedDataset}
              playback={playback}
              topLeftInset={headerInset}
            />
          ) : (
            <DemoViewer
              dataset={selectedDataset}
              playback={playback}
              showPerfHud={showPerfHud}
              topLeftInset={headerInset}
              onCameraChange={setCamera}
            />
          )}
        </Suspense>
      </div>

      {/* Floating header (top-left): back link, title, description, and the
          optional renderer toggle — a dark frosted panel over the map. */}
      <div className="glass rounded-md absolute top-3 left-3 z-10 max-w-xs px-3.5 py-3">
        <Link
          to={backTarget}
          className="inline-flex items-center gap-1 text-xs mb-1.5 text-slate-400 transition-colors hover:text-cyan-300"
        >
          <span>←</span>{' '}
          {getDemoMeta(selectedDataset.id) ? 'About this demo' : 'Demos'}
        </Link>
        <h1 className="font-display text-base font-semibold leading-tight text-slate-100">
          {selectedDataset.name}
        </h1>
        <p className="text-xs mt-1 leading-snug text-slate-400 line-clamp-2">
          {selectedDataset.description}
        </p>
        {hasAltRenderer && (
          <div
            className="mt-2.5 inline-flex gap-1.5"
            role="radiogroup"
            aria-label="Renderer"
            title="Swap the rendering library for the same tileset"
          >
            {(
              [
                {
                  id: 'deck',
                  label: 'deck.gl',
                  active: !useMaplibre && !useThree,
                },
                ...(maplibreCapable
                  ? [
                      {
                        id: 'maplibre' as const,
                        label: 'MapLibre',
                        active: useMaplibre,
                      },
                    ]
                  : []),
                ...(threeCapable
                  ? [{ id: 'three' as const, label: 'Three', active: useThree }]
                  : []),
              ] as {
                id: 'deck' | 'maplibre' | 'three';
                label: string;
                active: boolean;
              }[]
            ).map((r) => (
              // A REAL radio, not a button with role="radio": the native input
              // brings arrow-key traversal of the group and the checked state
              // for free, which the button version had to fake and never wired.
              // The input is visually hidden, so the ring lives on the label.
              <label
                key={r.id}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors cursor-pointer focus-within:ring-2 focus-within:ring-cyan-300/70 ${
                  r.active
                    ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
                    : 'border-white/15 text-slate-300 hover:bg-white/5'
                }`}
              >
                <input
                  type="radio"
                  name={rendererGroup}
                  className="sr-only"
                  checked={r.active}
                  onChange={() => setRenderer(r.id)}
                />
                {r.label}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Floating transport bar (bottom, centred). Dark frosted panel; the
          shared PlaybackControls is light-themed, so we remap its CSS vars to
          the dark palette on the wrapper (see DARK_CONTROL_THEME). */}
      <div
        ref={transportRef}
        className="glass rounded-md absolute bottom-3 left-3 right-3 z-10 mx-auto max-w-4xl px-4 py-3"
        style={{
          ...DARK_CONTROL_THEME,
          opacity: transportIdle ? 0 : 1,
          // Must not eat pointer events from the map once invisible.
          pointerEvents: transportIdle ? 'none' : 'auto',
          transform:
            transportIdle && !reducedMotion ? 'translateY(8px)' : undefined,
          transition: reducedMotion
            ? undefined
            : 'opacity 220ms ease, transform 220ms ease',
        }}
      >
        <PlaybackControls
          currentTime={playback.currentTime}
          timeRange={selectedDataset.timeRange}
          isPlaying={playback.isPlaying}
          bufferState={playback.bufferState}
          governor={playback.governor}
          onPlayPause={playback.onPlayPause}
          onSeek={playback.onSeek}
          onSpeedChange={playback.onSpeedChange}
          currentSpeedMultiplier={playback.speedMultiplier}
          targetPlaybackSeconds={selectedDataset.targetPlaybackSeconds ?? 30}
          autoSpeed={playback.autoSpeed}
          onAutoSpeedSelect={playback.onAutoSpeedSelect}
          ended={playback.ended}
          loop={playback.loop}
          onLoopToggle={playback.onLoopToggle}
          // This page mounts usePlaybackHotkeys, so the bar may advertise keys
          // and offer the shortcuts panel.
          keyboardShortcuts
          // Hover preview is deck-only (it needs the deck camera/render path);
          // the maplibre + Three renderers don't feed a deck camera, so omit it.
          renderPreview={
            useMaplibre || useThree
              ? undefined
              : (time) => (
                  <DemoHoverPreview
                    key={selectedDataset.id}
                    dataset={selectedDataset}
                    camera={camera}
                    time={time}
                  />
                )
          }
        />
      </div>
    </div>
  );
};

export default DemoPage;
