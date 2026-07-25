import type { CSSProperties } from 'react';
import DeckGL from '@deck.gl/react';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import type { BufferSource, BufferedRunway } from '@poopdeck.gl/layers';
import { usePlayback } from '@poopdeck.gl/react';

/** A live, hosted STT archive: global M4.0+ earthquakes, 2020-2024 (USGS). */
const DATA = 'https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json';

/** The archive's own span, from its `metadata.time_range` (Unix ms). */
const TIME_RANGE = { start: 1577836800000, end: 1735602989977 };

const DAY = 86_400_000;

export default function App() {
  // Clock + playback governor. The governor holds the playhead back until the
  // tiles it needs are buffered, so playback never runs into empty time.
  const pb = usePlayback({
    timeRange: TIME_RANGE,
    // sim-ms per wall-ms: play the whole five-year span in ~60 real seconds.
    baseSpeed: (TIME_RANGE.end - TIME_RANGE.start) / 60 / 1000,
  });

  const layer = new AnimatedPointLayer({
    id: 'earthquakes',
    // Point `data` at the manifest URL. The layer streams only the tiles the
    // viewport and playhead need, as HTTP range requests into the packs.
    data: DATA,
    timeController: pb.timeController,
    currentTime: TIME_RANGE.start,
    timeRange: TIME_RANGE,
    timeWindow: 30 * DAY, // each quake stays visible for 30 sim-days
    // Register the tileset with the governor so play/pause waits on the buffer.
    onTilesetReady: (t: BufferSource) =>
      pb.registry.registerSource('earthquakes', t),
    onBufferChange: (r: BufferedRunway) =>
      pb.registry.onBufferChange('earthquakes', r),
    // `radius` naming a column reads that column out of the tile.
    radius: 'magnitude',
    radiusUnits: 'pixels',
    radiusTransform: (m: number) => Math.max(2, (m - 4) * 1.5),
    radiusMaxPixels: 16,
    fillColor: [255, 156, 74, 235],
  });

  return (
    <>
      <DeckGL
        initialViewState={{ longitude: 140, latitude: 20, zoom: 2 }}
        controller
        layers={[layer]}
      />
      <div style={BAR}>
        <button onClick={pb.onPlayPause} style={BUTTON}>
          {pb.isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <input
          type="range"
          min={TIME_RANGE.start}
          max={TIME_RANGE.end}
          value={pb.currentTime}
          onChange={(e) => pb.onSeek(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <time style={{ width: '11ch', textAlign: 'right' }}>
          {new Date(pb.currentTime).toISOString().slice(0, 10)}
        </time>
      </div>
    </>
  );
}

const BAR: CSSProperties = {
  position: 'absolute',
  insetInline: 16,
  bottom: 16,
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  padding: '10px 14px',
  borderRadius: 10,
  background: 'rgba(8,12,22,0.82)',
  backdropFilter: 'blur(6px)',
};

const BUTTON: CSSProperties = {
  width: '7.5ch',
  padding: '5px 0',
  borderRadius: 6,
  border: '1px solid #2b3550',
  background: '#141c2e',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
};
