/**
 * Fullscreen demo viewer (`/demo/:id`, plus the legacy `/maplibre/:id`
 * alias). The map surface and playback wiring live in shared pieces —
 * `DemoViewer` and `useDemoPlayback` — so the per-demo landing-page embed
 * renders the identical demo; this page is just the fullscreen shell around
 * them (header, viewport frame, bottom transport bar).
 */
import React, { useMemo } from "react";
import { useParams, Navigate, Link } from "react-router-dom";
import { getDatasetById } from "../datasets";
import { getDemoMeta } from "../content/demoMeta";
import DemoViewer from "../components/demo/DemoViewer";
import { useDemoPlayback } from "../components/demo/useDemoPlayback";
import TimeControls from "../components/TimeControls";

const DemoPage: React.FC = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const selectedDataset = useMemo(
    () => getDatasetById(datasetId || ""),
    [datasetId],
  );

  const playback = useDemoPlayback(selectedDataset);

  if (!selectedDataset) return <Navigate to="/" replace />;

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
          <DemoViewer
            dataset={selectedDataset}
            playback={playback}
            showPerfHud
          />
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
