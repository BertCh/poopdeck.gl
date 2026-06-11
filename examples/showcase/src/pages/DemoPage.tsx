/**
 * Fullscreen demo viewer (`/demo/:id`, plus the legacy `/maplibre/:id`
 * alias). The map surface and playback wiring live in shared pieces —
 * `DemoViewer` and `useDemoPlayback` — so the per-demo landing-page embed
 * renders the identical demo; this page is just the fullscreen shell around
 * them (header, viewport frame, bottom transport bar).
 */
import React, { useMemo, useState } from "react";
import { useParams, useLocation, Navigate, Link } from "react-router-dom";
import { getDatasetById } from "../datasets";
import { getDemoMeta } from "../content/demoMeta";
import DemoViewer from "../components/demo/DemoViewer";
import MaplibreRenderer from "../components/MaplibreRenderer";
import { useDemoPlayback } from "../components/demo/useDemoPlayback";
import TimeControls from "../components/TimeControls";

/** Dataset types the `@stt/maplibre` adapter can mount (see makeSttLayer). */
const MAPLIBRE_TYPES = new Set(["point", "path", "trips", "polygon", "heatmap"]);

const DemoPage: React.FC = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const location = useLocation();
  const selectedDataset = useMemo(
    () => getDatasetById(datasetId || ""),
    [datasetId],
  );

  const playback = useDemoPlayback(selectedDataset);

  // Renderer toggle (deck.gl ↔ maplibre). The legacy `/maplibre/:id`
  // deep-links land directly on the maplibre renderer; the toggle keeps
  // both reachable from either route. maplibre adapter is mercator-only.
  const [renderer, setRenderer] = useState<"deck" | "maplibre">(
    location.pathname.startsWith("/maplibre/") ? "maplibre" : "deck",
  );
  const maplibreCapable =
    selectedDataset != null && MAPLIBRE_TYPES.has(selectedDataset.type);

  if (!selectedDataset) return <Navigate to="/" replace />;
  const useMaplibre = renderer === "maplibre" && maplibreCapable;

  // Catalog demos link back to their landing page; excluded ones to the grid.
  const backTarget = getDemoMeta(selectedDataset.id)
    ? `/demos/${selectedDataset.id}`
    : "/demos";

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: "var(--page-bg)" }}
    >
      {/* Header */}
      <div
        className="shrink-0 px-5 py-4"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        <Link
          to={backTarget}
          className="inline-flex items-center gap-1 text-xs mb-2 transition-colors"
          style={{ color: "var(--ink-500)" }}
          onMouseOver={(e) => (e.currentTarget.style.color = "var(--accent)")}
          onMouseOut={(e) => (e.currentTarget.style.color = "var(--ink-500)")}
        >
          <span>←</span> {getDemoMeta(selectedDataset.id) ? "About this demo" : "Demos"}
        </Link>
        <h1
          className="font-display text-base font-semibold leading-tight"
          style={{ color: "var(--ink-900)" }}
        >
          {selectedDataset.name}
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--ink-500)" }}>
          {selectedDataset.description}
        </p>
      </div>

      {/* Map Viewport */}
      <div className="flex-1 min-h-0 p-3 lg:p-5">
        <div className="w-full h-full rounded-lg overflow-hidden relative">
          {useMaplibre ? (
            <MaplibreRenderer
              key={selectedDataset.id}
              dataset={selectedDataset}
              timeController={playback.timeController}
            />
          ) : (
            <DemoViewer
              dataset={selectedDataset}
              playback={playback}
              showPerfHud
            />
          )}
          {maplibreCapable && (
            <button
              onClick={() =>
                setRenderer((r) => (r === "deck" ? "maplibre" : "deck"))
              }
              className="absolute top-3 left-3 z-10 px-2.5 py-1 rounded text-xs font-medium transition-colors"
              style={{
                background: "var(--surface)",
                color: "var(--ink-500)",
                border: "1px solid var(--hairline)",
              }}
              title="Swap the rendering library for the same tileset"
            >
              Renderer: {useMaplibre ? "MapLibre" : "deck.gl"}
            </button>
          )}
        </div>
      </div>

      {/* Bottom Controls */}
      <div
        className="shrink-0"
        style={{ background: "var(--surface)", borderTop: "1px solid var(--hairline)" }}
      >
        <div className="px-5 py-3">
          <TimeControls
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
          />
        </div>
      </div>
    </div>
  );
};

export default DemoPage;
