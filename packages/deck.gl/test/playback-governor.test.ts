/**
 * PlaybackGovernor tests: start gate, low-watermark stall + resume hysteresis,
 * pause-during-buffering stickiness, scrub preview vs. seek commit, the
 * maxStartWaitMs escape hatch, and auto-speed math.
 *
 * The governor sits on a real TimeController (rAF stubbed out) and a plain
 * mock BufferSource. Timers + performance.now run on vitest fake timers so
 * gate cadence and escape hatches can be stepped deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimeController } from '../src/time-controller';
import {
  PlaybackGovernor,
  type BufferSource,
  type BufferedRunway,
  type PlaybackGovernorState,
} from '../src/playback-governor';

/** Mutable mock BufferSource: tests poke `runwaySimMs`/`complete` directly. */
function makeSource() {
  const state = {
    runwaySimMs: 0,
    complete: false,
    bytesPending: 0,
    ranges: [] as Array<{ start: number; end: number }>,
    costBytes: 0,
    costTiles: 0,
    etaMs: null as number | null,
    flushes: 0,
    runwayCalls: [] as Array<{ time: number; direction: 1 | -1; horizonSimMs?: number }>,
  };
  const source: BufferSource = {
    getBufferedRunway(time, direction, horizonSimMs) {
      state.runwayCalls.push({ time, direction, horizonSimMs });
      return {
        simMs: state.runwaySimMs,
        bytesPending: state.bytesPending,
        horizonSimMs: horizonSimMs ?? state.runwaySimMs,
        complete: state.complete,
      };
    },
    getBufferedRanges() {
      return state.ranges;
    },
    estimateCost() {
      return { bytes: state.costBytes, tiles: state.costTiles };
    },
    estimateTimeToReadyMs() {
      return state.etaMs;
    },
    flushPrefetch() {
      state.flushes++;
    },
  };
  return { source, state };
}

function runway(simMs: number, complete = false): BufferedRunway {
  return { simMs, bytesPending: 0, horizonSimMs: simMs, complete };
}

describe('PlaybackGovernor', () => {
  let tc: TimeController;
  let governor: PlaybackGovernor | null;
  let states: PlaybackGovernorState[];

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    tc = new TimeController({ initialTime: 0, speed: 10 }); // 10 sim-ms per wall-ms
    governor = null;
    states = [];
  });

  afterEach(() => {
    governor?.dispose();
    tc.destroy();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function makeGovernor(opts: ConstructorParameters<typeof PlaybackGovernor>[1] = {}) {
    governor = new PlaybackGovernor(tc, opts);
    governor.on('statechange', (s) => states.push(s));
    return governor;
  }

  it('starts idle and passes the start gate when the runway covers startGateWallMs × |speed|', () => {
    const { source, state } = makeSource();
    const g = makeGovernor({ source, startGateWallMs: 2000 });

    // Required runway: 2000 wall-ms × 10 = 20000 sim-ms.
    state.runwaySimMs = 19_999;
    g.requestPlay();
    expect(g.state).toBe('starting');
    expect(tc.isPlaying()).toBe(false);

    state.runwaySimMs = 20_000;
    vi.advanceTimersByTime(250); // one eval tick
    expect(g.state).toBe('playing');
    expect(tc.isPlaying()).toBe(true);
    expect(states).toEqual(['starting', 'playing']);
  });

  it('passes the gate immediately when the runway is already sufficient', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source });
    const ready = vi.fn();
    g.on('ready', ready);

    g.requestPlay();
    expect(g.state).toBe('playing');
    expect(tc.isPlaying()).toBe(true);
    expect(ready).toHaveBeenCalledWith({ degraded: false });
  });

  it('never gates on a complete runway (dataset end / everything loaded)', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 5; // tiny…
    state.complete = true; // …but complete
    const g = makeGovernor({ source });
    g.requestPlay();
    expect(g.state).toBe('playing');
  });

  it('reacts immediately to notifyBufferChange while gated', () => {
    const { source, state } = makeSource();
    const g = makeGovernor({ source, startGateWallMs: 2000 });
    g.requestPlay();
    expect(g.state).toBe('starting');

    state.runwaySimMs = 50_000;
    g.notifyBufferChange(runway(50_000));
    expect(g.state).toBe('playing'); // no 250ms wait
  });

  it('starts degraded after maxStartWaitMs even with no source', () => {
    const g = makeGovernor({ maxStartWaitMs: 4000 });
    const ready = vi.fn();
    g.on('ready', ready);

    g.requestPlay();
    expect(g.state).toBe('starting');
    vi.advanceTimersByTime(3900);
    expect(g.state).toBe('starting');
    vi.advanceTimersByTime(200);
    expect(g.state).toBe('playing');
    expect(tc.isPlaying()).toBe(true);
    expect(ready).toHaveBeenCalledWith({ degraded: true });
  });

  it('stalls below the low watermark and resumes at resumeFactor × start gate', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({
      source,
      startGateWallMs: 2000,
      lowWatermarkWallMs: 600,
      resumeFactor: 2,
    });
    const waiting = vi.fn();
    g.on('waiting', waiting);
    g.requestPlay();
    expect(g.state).toBe('playing');

    // Runway drains under 600 wall-ms × 10 = 6000 sim-ms → stall.
    state.runwaySimMs = 5000;
    g.notifyBufferChange(runway(5000));
    expect(g.state).toBe('buffering');
    expect(tc.isPlaying()).toBe(false);
    expect(waiting).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'buffering' }),
    );

    // Above the start gate (20000) but below the resume gate (40000) → still buffering.
    state.runwaySimMs = 25_000;
    g.notifyBufferChange(runway(25_000));
    expect(g.state).toBe('buffering');

    // Above the resume gate → playing.
    state.runwaySimMs = 40_000;
    g.notifyBufferChange(runway(40_000));
    expect(g.state).toBe('playing');
    expect(tc.isPlaying()).toBe(true);
  });

  it('never stalls when the runway is complete', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source });
    g.requestPlay();

    state.runwaySimMs = 0;
    state.complete = true;
    g.notifyBufferChange(runway(0, true));
    expect(g.state).toBe('playing');
    expect(tc.isPlaying()).toBe(true);
  });

  it('pause during buffering sticks — a later runway recovery must not resume', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source });
    g.requestPlay();

    state.runwaySimMs = 0;
    g.notifyBufferChange(runway(0));
    expect(g.state).toBe('buffering');

    g.requestPause();
    expect(g.state).toBe('idle');

    state.runwaySimMs = 1_000_000;
    g.notifyBufferChange(runway(1_000_000));
    vi.advanceTimersByTime(2000);
    expect(g.state).toBe('idle');
    expect(tc.isPlaying()).toBe(false);
  });

  it('scrub is preview-only; endScrub commits (flush + gate)', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source, startGateWallMs: 2000 });
    g.requestPlay();
    expect(g.state).toBe('playing');

    g.beginScrub();
    expect(tc.isPlaying()).toBe(false); // clock frozen for a stable preview
    expect(g.state).toBe('playing'); // no machine-state change

    g.scrubTo(123_456);
    expect(tc.getTime()).toBe(123_456);
    expect(state.flushes).toBe(0); // preview never touches the loader

    state.runwaySimMs = 0; // destination not buffered
    g.endScrub(200_000);
    expect(state.flushes).toBe(1); // stale prefetch flushed on commit
    expect(tc.getTime()).toBe(200_000);
    expect(g.state).toBe('seeking');
    expect(tc.isPlaying()).toBe(false);

    // Post-seek gate is the PLAIN start gate (20000 sim-ms), not resume-sized.
    state.runwaySimMs = 20_000;
    g.notifyBufferChange(runway(20_000));
    expect(g.state).toBe('playing');
    expect(tc.isPlaying()).toBe(true);
  });

  it('seekTo while paused commits time and stays idle', () => {
    const { source, state } = makeSource();
    const g = makeGovernor({ source });
    g.seekTo(42);
    expect(tc.getTime()).toBe(42);
    expect(g.state).toBe('idle');
    expect(state.flushes).toBe(1);
    expect(tc.isPlaying()).toBe(false);
  });

  it('queries the runway in the direction of playback', () => {
    const { source, state } = makeSource();
    tc.setSpeed(-10);
    const g = makeGovernor({ source });
    g.requestPlay();
    expect(state.runwayCalls.at(-1)?.direction).toBe(-1);
  });

  it('an external TimeController pause while playing drops user intent', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source });
    g.requestPlay();
    expect(g.state).toBe('playing');

    tc.pause(); // e.g. the clock clamped at a non-looping range end
    expect(g.state).toBe('idle');

    // A buffer recovery must not resurrect playback.
    g.notifyBufferChange(runway(1_000_000));
    expect(g.state).toBe('idle');
    expect(tc.isPlaying()).toBe(false);
  });

  it('rejects a source missing the buffering API and degrades to the escape hatch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = makeGovernor({ maxStartWaitMs: 1000 });
    g.setSource({} as unknown as BufferSource);
    g.requestPlay();
    expect(g.state).toBe('starting');
    vi.advanceTimersByTime(1100);
    expect(g.state).toBe('playing');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('getBufferedRanges passes through (and returns [] without a source)', () => {
    const { source, state } = makeSource();
    state.ranges = [{ start: 0, end: 100 }];
    const g = makeGovernor({});
    expect(g.getBufferedRanges()).toEqual([]);
    g.setSource(source);
    expect(g.getBufferedRanges()).toEqual([{ start: 0, end: 100 }]);
  });

  describe('getAutoSpeedSuggestion', () => {
    it('computes maxSustainable = throughput / bytesPerSimMs × 0.7', () => {
      const { source, state } = makeSource();
      // Horizon: 8000 wall-ms × speed 10 = 80000 sim-ms; cost 800000 bytes
      // → bytesPerSimMs = 10. Throughput 100 bytes/ms → 100/10 × 0.7 = 7.
      state.costBytes = 800_000;
      const g = makeGovernor({
        source,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      expect(g.getAutoSpeedSuggestion()).toBeCloseTo(7);
    });

    it('returns null when the upcoming horizon is fully buffered (zero cost)', () => {
      const { source, state } = makeSource();
      state.costBytes = 0;
      const g = makeGovernor({
        source,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      expect(g.getAutoSpeedSuggestion()).toBeNull();
    });

    it('returns null when throughput is unknown and no ETA is available', () => {
      const { source, state } = makeSource();
      state.costBytes = 1000;
      state.etaMs = null;
      const g = makeGovernor({ source });
      expect(g.getAutoSpeedSuggestion()).toBeNull();
    });

    it('falls back to ETA-implied throughput when no getThroughput is wired', () => {
      const { source, state } = makeSource();
      // bytes=800000 over horizonSimMs=80000 → bytesPerSimMs=10;
      // ETA 4000ms → implied throughput 200 bytes/ms → 200/10 × 0.7 = 14.
      state.costBytes = 800_000;
      state.etaMs = 4000;
      const g = makeGovernor({ source });
      expect(g.getAutoSpeedSuggestion()).toBeCloseTo(14);
    });

    it('returns null without a source or at zero speed', () => {
      const g = makeGovernor({});
      expect(g.getAutoSpeedSuggestion()).toBeNull();
      const { source, state } = makeSource();
      state.costBytes = 1000;
      g.setSource(source);
      tc.setSpeed(0);
      expect(g.getAutoSpeedSuggestion()).toBeNull();
    });
  });

  it('dispose stops timers and detaches from the controller', () => {
    const { source } = makeSource();
    const g = makeGovernor({ source, maxStartWaitMs: 1000 });
    g.requestPlay();
    expect(g.state).toBe('starting');
    g.dispose();
    vi.advanceTimersByTime(5000); // escape hatch must NOT fire post-dispose
    expect(g.state).toBe('starting'); // frozen — no further transitions
    expect(tc.isPlaying()).toBe(false);
  });
});
