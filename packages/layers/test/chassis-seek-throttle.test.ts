/**
 * B2 — a committed seek inside the layer's 100 ms wall throttle must still
 * reach the tileset (tile-loading audit 2026-08, G1).
 *
 * `_handleTimeUpdate` runs `tileset.update()` only when the playhead moved
 * more than `timeWindow/20` AND ≥ 100 ms of wall time passed since the last
 * pass. A seek issued by a PAUSED clock (the governor's `commitSeek` pauses
 * first, then `setTime`s) inside that window used to be dropped for good: no
 * later tick retried, so the tileset kept selecting for the pre-seek playhead
 * and the seek gate resolved only through its 8 s escape hatch. A drag
 * release re-sending the last preview value was dropped one step earlier, by
 * the tick handler's `|Δ| > 1` guard.
 *
 * Driven through the REAL `initializeState` tick handler over a fake
 * controller, with `performance.now()` and `setTimeout` controlled, mirroring
 * `viewport-throttle.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpatioTemporalLayer } from '../src/layers/spatiotemporal-layer';

const WALL_MS = 100; // MIN_TILESET_UPDATE_WALL_MS (module-private; mirrored)
const BUCKET_MS = 60_000;

let clock = 0;

class FakeController {
  playing = true;
  private handlers = new Map<string, Set<(...a: any[]) => void>>();
  isPlaying() {
    return this.playing;
  }
  getSpeed() {
    return 1;
  }
  on(event: string, cb: (...a: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(cb);
    return () => this.off(event, cb);
  }
  off(event: string, cb: (...a: any[]) => void) {
    this.handlers.get(event)?.delete(cb);
  }
  tick(time: number) {
    for (const cb of this.handlers.get('tick') ?? []) cb(time);
  }
}

function makeLayer() {
  const controller = new FakeController();
  const update = vi.fn(() => 0);
  const layer: any = Object.create(SpatioTemporalLayer.prototype);
  layer.props = {
    currentTime: 0,
    timeWindow: 1000, // threshold = 50 ms of sim; every seek here dwarfs it
    timeController: controller,
  };
  layer.state = {};
  layer.setState = function (s: any) {
    Object.assign(this.state, s);
  };
  layer.setNeedsRedraw = vi.fn();
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
  // Isolate the throttle from archive init and the bounds/zoom plumbing.
  layer._startArchiveInit = () => {};
  layer.getViewportBounds = () => ({
    minLon: 0,
    minLat: 0,
    maxLon: 1,
    maxLat: 1,
  });
  layer.getZoomLevel = () => 12;
  layer.getViewportTileCells = () => null;

  // The real subscription: creates the tick handler under test.
  layer.initializeState(layer.context);
  layer.state.tileset = {
    update,
    getVisibleTiles: () => [],
    getCacheStats: () => ({}),
  };
  return { layer, controller, update };
}

beforeEach(() => {
  clock = 1000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('B2: seek inside the tick-path wall throttle', () => {
  it('B2: a paused-clock seek 40 ms after a pass reaches the tileset within the window', () => {
    const { layer, controller, update } = makeLayer();
    const t0 = 100_000;
    controller.tick(t0);
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0] as any)[0].time).toBe(t0);

    // commitSeek: pause FIRST, then setTime → one tick on a paused clock.
    clock += 40;
    controller.playing = false;
    const target = t0 + 10 * BUCKET_MS;
    controller.tick(target);
    // Throttled — but a trailing pass is now armed for the remaining 60 ms.
    expect(update).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    clock += WALL_MS - 40;
    vi.advanceTimersByTime(WALL_MS - 40);
    expect(update).toHaveBeenCalledTimes(2);
    expect((update.mock.calls[1] as any)[0].time).toBe(target);
    expect(vi.getTimerCount()).toBe(0);
    expect(layer.state.lastTilesetUpdateTime).toBe(target);
  });

  it('B2: a drag release re-sending the last preview value while paused lands exactly one update', () => {
    const { controller, update } = makeLayer();
    controller.tick(100_000);
    expect(update).toHaveBeenCalledTimes(1);

    clock += 40;
    controller.playing = false;
    const preview = 130_000;
    controller.tick(preview); // last preview inside the window: throttled
    controller.tick(preview); // endScrub(value === _currentTime): used to be swallowed
    expect(update).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1); // coalesced to ONE pending pass

    clock += WALL_MS;
    vi.advanceTimersByTime(WALL_MS);
    expect(update).toHaveBeenCalledTimes(2);
    expect((update.mock.calls[1] as any)[0].time).toBe(preview);
    expect(
      update.mock.calls.filter((c: any) => c[0].time === preview),
    ).toHaveLength(1);
  });

  it('B2: while playing, the `|Δ| > 1` micro-update guard still applies', () => {
    const { controller, update, layer } = makeLayer();
    controller.tick(100_000);
    const handle = vi.spyOn(layer, '_handleTimeUpdate');
    controller.tick(100_000.5);
    expect(handle).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('B2: a tick that passes the throttle cancels the pending trailing pass', () => {
    const { controller, update } = makeLayer();
    controller.tick(100_000);
    clock += 40;
    controller.tick(200_000); // throttled → armed
    expect(vi.getTimerCount()).toBe(1);
    clock += WALL_MS;
    controller.tick(300_000); // passes on its own
    expect(update).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(WALL_MS);
    expect(update).toHaveBeenCalledTimes(2); // no redundant third pass
  });

  it('B2: teardown cancels an armed trailing pass', () => {
    const { layer, controller, update } = makeLayer();
    controller.tick(100_000);
    clock += 40;
    controller.playing = false;
    controller.tick(200_000);
    expect(vi.getTimerCount()).toBe(1);
    layer._cancelPendingUpdates();
    expect(vi.getTimerCount()).toBe(0);
    clock += WALL_MS;
    vi.advanceTimersByTime(WALL_MS);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
