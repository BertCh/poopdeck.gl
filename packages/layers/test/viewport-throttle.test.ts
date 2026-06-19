/**
 * SpatioTemporalLayer viewport-reselection throttle (motion-stutter fix).
 *
 * A controlled camera (the AV cockpit's ego-follow, or any drag/zoom) drives a
 * `viewportChanged` updateState on every animation frame. Unthrottled, that ran
 * a full `tileset.update()` / `selectAndLoadTiles()` per STT layer per frame.
 * `_updateTileset` now rate-limits the PURE-viewport path to a wall-clock floor
 * (≈10Hz) — still redrawing every frame, with one trailing pass so the settle
 * position reselects — while prop/data changes are never throttled.
 *
 * These drive `_updateTileset` directly (Object.create bypasses deck's
 * lifecycle), with `performance.now()` and `setTimeout` controlled so the
 * throttle window is deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpatioTemporalLayer } from '../src/layers/spatiotemporal-layer';

// The throttle window (MIN_VIEWPORT_TILESET_WALL_MS) is module-private; mirror it.
const WINDOW_MS = 100;

let clock = 0;

function makeLayer(update: ReturnType<typeof vi.fn>) {
  const layer: any = Object.create(SpatioTemporalLayer.prototype);
  layer.state = {
    tileset: {
      update,
      getVisibleTiles: () => [],
      getCacheStats: () => ({}),
    },
    frameNumber: 0,
  };
  layer.props = { currentTime: 0, timeWindow: 2000 };
  layer.context = {
    viewport: {
      id: 'v',
      width: 800,
      height: 600,
      zoom: 12,
      longitude: 0,
      latitude: 0,
      pitch: 0,
      bearing: 0,
    },
  };
  layer._lastViewportSelectWall = 0;
  layer._viewportSettleTimer = null;
  layer._lastTilesetUpdateTime = 0;
  layer._lastTileIdSet = new Set();
  layer._finalized = false;
  layer.setNeedsRedraw = vi.fn();
  layer.setState = function (s: any) {
    Object.assign(this.state, s);
  };
  // Isolate the throttle from the bounds/zoom/tile plumbing.
  layer.getViewportBounds = () => ({ minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 });
  layer.getZoomLevel = () => 6;
  layer.getEffectiveTimeWindow = () => 2000;
  layer._tilesChanged = () => false;
  layer._commitTileIdSet = () => {};
  layer._maybeFireViewportLoad = () => {};
  return layer;
}

const viewportChange = { viewportChanged: true, propsChanged: false, dataChanged: false };

describe('SpatioTemporalLayer viewport throttle', () => {
  beforeEach(() => {
    // Fake only the timers we use; leave `performance` to the explicit spy below
    // so the throttle's wall clock is fully controllable.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reselects once per window for a burst of viewport frames, then a trailing pass', () => {
    const update = vi.fn(() => 1);
    const layer = makeLayer(update);

    // 8 viewport-only frames in the same instant: only the leading edge selects.
    for (let i = 0; i < 8; i++) layer._updateTileset({ ...viewportChange });
    expect(update).toHaveBeenCalledTimes(1);
    // The 7 throttled frames each still request a redraw (camera stays smooth).
    expect(layer.setNeedsRedraw).toHaveBeenCalledTimes(7);
    // Exactly one trailing pass is pending.
    expect(layer._viewportSettleTimer).not.toBeNull();

    // Camera settles inside the window; the trailing timer reselects once.
    clock = 1000 + WINDOW_MS;
    vi.advanceTimersByTime(WINDOW_MS);
    expect(update).toHaveBeenCalledTimes(2);
    expect(layer._viewportSettleTimer).toBeNull();
  });

  it('does not throttle prop/data changes', () => {
    const update = vi.fn(() => 1);
    const layer = makeLayer(update);

    layer._updateTileset({ ...viewportChange }); // leading edge selects
    expect(update).toHaveBeenCalledTimes(1);

    // A prop change in the SAME instant must still reselect immediately.
    layer._updateTileset({
      viewportChanged: false,
      propsChanged: 'timeWindow',
      propsOrDataChanged: true,
      dataChanged: false,
    });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('the trailing pass bails if the layer was finalized', () => {
    const update = vi.fn(() => 1);
    const layer = makeLayer(update);

    layer._updateTileset({ ...viewportChange }); // selects (1)
    layer._updateTileset({ ...viewportChange }); // throttled → schedules trailing
    expect(layer._viewportSettleTimer).not.toBeNull();

    layer._finalized = true;
    clock = 1000 + WINDOW_MS;
    vi.advanceTimersByTime(WINDOW_MS);
    expect(update).toHaveBeenCalledTimes(1); // trailing bailed, no extra select
  });
});
