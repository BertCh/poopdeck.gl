// Cesium demo page (/cesium/:datasetId) — renders an STT dataset on a
// CesiumJS WGS84 globe via @poopdeck.gl/cesium, driven by the shared playback
// clock. Covers the backend's movement catalog (point / path / trips /
// trip-heads / arc — see CESIUM_SUPPORTED_TYPES); other dataset types
// redirect home until their Cesium layer exists.
//
// The transport is the shared default player (@poopdeck.gl/react's
// PlaybackControls + keyboard map) over the globe — the same one every other
// demo uses. Cesium's own animation/timeline widgets are already disabled in
// CesiumRenderer, so nothing here is locked to Cesium chrome.

import { useMemo } from 'react';
import { useParams, Navigate } from 'react-router';
import { PlaybackControls, usePlaybackHotkeys } from '@poopdeck.gl/react';
import { getDatasetById } from '../datasets';
import { useDemoPlayback } from '../components/demo/useDemoPlayback';
import CesiumRenderer from '../components/CesiumRenderer';
import { CESIUM_SUPPORTED_TYPES } from '../components/buildCesiumLayer';

export default function CesiumDemoPage() {
  const { datasetId } = useParams<{ datasetId: string }>();
  const dataset = useMemo(() => getDatasetById(datasetId || ''), [datasetId]);
  const playback = useDemoPlayback(dataset);
  // Fullscreen surface → wire the standard video-player keyboard map
  // (Space / arrows / speed). Inert while dataset?.timeRange is undefined.
  usePlaybackHotkeys(playback, dataset?.timeRange);

  if (!dataset || !CESIUM_SUPPORTED_TYPES.includes(dataset.type)) {
    return <Navigate to="/" replace />;
  }

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#05070d' }}>
      {/* The globe reads the playhead from Cesium's render loop (scene.preRender)
          via the shared TimeController — not a per-frame React prop. */}
      <CesiumRenderer
        dataset={dataset}
        timeController={playback.timeController}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: '12px 20px',
          background: 'var(--surface)',
          borderTop: '1px solid var(--hairline)',
        }}
      >
        <PlaybackControls
          currentTime={playback.currentTime}
          timeRange={dataset.timeRange}
          isPlaying={playback.isPlaying}
          bufferState={playback.bufferState}
          governor={playback.governor}
          onPlayPause={playback.onPlayPause}
          onSeek={playback.onSeek}
          onSpeedChange={playback.onSpeedChange}
          currentSpeedMultiplier={playback.speedMultiplier}
          targetPlaybackSeconds={dataset.targetPlaybackSeconds ?? 30}
          autoSpeed={playback.autoSpeed}
          onAutoSpeedSelect={playback.onAutoSpeedSelect}
        />
        {/* Hover preview is deck-only (needs the deck camera); omitted here. */}
      </div>
    </div>
  );
}
