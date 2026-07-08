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
import React, { useMemo, useState } from "react";
import { useParams, useLocation, Navigate, Link } from "react-router";
import { getDatasetById } from "../datasets";
import { getDemoMeta } from "../content/demoMeta";
import DemoViewer from "../components/demo/DemoViewer";
import DemoHoverPreview from "../components/demo/DemoHoverPreview";
import type { DemoCamera } from "../components/demo/previewBasemap";
import MaplibreRenderer from "../components/MaplibreRenderer";
import SttThreeGeoViewer, {
  datasetSupportsThree,
} from "../components/demo/SttThreeGeoViewer";
import { useDemoPlayback } from "../components/demo/useDemoPlayback";
import { usePlaybackHotkeys, PlaybackControls } from "@poopdeck.gl/react";

/** Dataset types the `@poopdeck.gl/maplibre` adapter can mount (see makeSttLayer). */
const MAPLIBRE_TYPES = new Set(["point", "path", "trips", "polygon", "heatmap"]);

/**
 * `PlaybackControls` is authored in the site's light editorial theme (dark ink
 * on a white surface). Floated over the dark map it needs the inverse palette,
 * so we remap its CSS custom properties on the wrapper instead of forking the
 * shared, published component. Values mirror the dark in-map chips already in
 * `DemoViewer` (cube/summary controls) and the app's cyan data accent.
 */
const DARK_CONTROL_THEME = {
  "--ink-900": "#f4f5f7",
  "--ink-700": "#d5d8de",
  "--ink-500": "#a0a7b4",
  "--ink-400": "#7b8494",
  "--surface": "#262a33",
  "--hairline": "rgba(255, 255, 255, 0.14)",
  "--accent": "#1fbad6",
  "--accent-soft": "rgba(31, 186, 214, 0.16)",
  "--page-bg": "#15171c",
} as React.CSSProperties;

const DemoPage: React.FC = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const location = useLocation();
  const selectedDataset = useMemo(
    () => getDatasetById(datasetId || ""),
    [datasetId],
  );

  const playback = useDemoPlayback(selectedDataset);

  // Video-player keyboard map (Space/K, ←/→, J/L, Home/End, ↑/↓, 0–9) —
  // fullscreen-only: the scrolling embed pages must not capture window keys.
  usePlaybackHotkeys(playback, selectedDataset?.timeRange);

  // Renderer toggle (deck.gl ↔ maplibre ↔ Three). The legacy `/maplibre/:id`
  // deep-links land directly on the maplibre renderer; the toggle keeps every
  // capable renderer reachable from either route. maplibre adapter is
  // mercator-only; the `@poopdeck.gl/three` (TSL/WebGPU) path handles the FLAT,
  // metro-scale geo demos (see `datasetSupportsThree`).
  const [renderer, setRenderer] = useState<"deck" | "maplibre" | "three">(
    location.pathname.startsWith("/maplibre/") ? "maplibre" : "deck",
  );
  const maplibreCapable =
    selectedDataset != null && MAPLIBRE_TYPES.has(selectedDataset.type);
  const threeCapable =
    selectedDataset != null && datasetSupportsThree(selectedDataset);

  // Live camera from the deck viewer — fed to the scrubber's hover preview so
  // the thumbnail mirrors what the user is looking at.
  const [camera, setCamera] = useState<DemoCamera | null>(null);

  if (!selectedDataset) return <Navigate to="/" replace />;
  const useMaplibre = renderer === "maplibre" && maplibreCapable;
  const useThree = renderer === "three" && threeCapable;
  const hasAltRenderer = maplibreCapable || threeCapable;

  // Catalog demos link back to their landing page; excluded ones to the grid.
  const backTarget = getDemoMeta(selectedDataset.id)
    ? `/demos/${selectedDataset.id}`
    : "/demos";

  // Push DemoViewer's top-left in-map chips (cube / summary toggle) below the
  // floating header so they don't collide. The header grows by one row when
  // the renderer toggle is present, so budget a little more for it.
  const headerInset = hasAltRenderer ? 148 : 112;

  return (
    <div className="h-full relative overflow-hidden" style={{ background: "#0a0d12" }}>
      {/* Full-bleed map — fills the whole surface; the chrome floats on top. */}
      <div className="absolute inset-0">
        {useMaplibre ? (
          <MaplibreRenderer
            key={selectedDataset.id}
            dataset={selectedDataset}
            timeController={playback.timeController}
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
            showPerfHud
            topLeftInset={headerInset}
            onCameraChange={setCamera}
          />
        )}
      </div>

      {/* Floating header (top-left): back link, title, description, and the
          optional renderer toggle — a dark frosted panel over the map. */}
      <div className="glass rounded-md absolute top-3 left-3 z-10 max-w-xs px-3.5 py-3">
        <Link
          to={backTarget}
          className="inline-flex items-center gap-1 text-xs mb-1.5 text-slate-400 transition-colors hover:text-cyan-300"
        >
          <span>←</span> {getDemoMeta(selectedDataset.id) ? "About this demo" : "Demos"}
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
                { id: "deck", label: "deck.gl", active: !useMaplibre && !useThree },
                ...(maplibreCapable
                  ? [{ id: "maplibre" as const, label: "MapLibre", active: useMaplibre }]
                  : []),
                ...(threeCapable
                  ? [{ id: "three" as const, label: "Three", active: useThree }]
                  : []),
              ] as { id: "deck" | "maplibre" | "three"; label: string; active: boolean }[]
            ).map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={r.active}
                onClick={() => setRenderer(r.id)}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                  r.active
                    ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-100"
                    : "border-white/15 text-slate-300 hover:bg-white/5"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Floating transport bar (bottom, centred). Dark frosted panel; the
          shared PlaybackControls is light-themed, so we remap its CSS vars to
          the dark palette on the wrapper (see DARK_CONTROL_THEME). */}
      <div
        className="glass rounded-md absolute bottom-3 left-3 right-3 z-10 mx-auto max-w-4xl px-4 py-3"
        style={DARK_CONTROL_THEME}
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
