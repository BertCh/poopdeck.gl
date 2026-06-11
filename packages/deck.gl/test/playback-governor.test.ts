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
import { TimeController } from '../src/playback/time-controller';
import {
  PlaybackGovernor,
  type BufferSource,
  type BufferedRunway,
  type PlaybackGovernorState,
} from '../src/playback/playback-governor';

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
    costCalls: [] as Array<{ start: number; end: number }>,
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
    estimateCost(range) {
      state.costCalls.push(range);
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

  it('clamps an overrun playhead back to the buffered frontier and stalls THERE', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source });
    g.requestPlay();
    expect(g.state).toBe('playing');
    // play() ticked once at time 0 → frontier probed at 0 + 100_000.

    // The network goes silent (no buffer events!) and the loader reports no
    // further runway. The probe is tick-throttled, so the cached frontier is
    // what bounds the playhead.
    state.runwaySimMs = 0;
    tc.setTime(100_400); // a playback step past the frontier (≤ |speed| × 1s)
    expect(tc.getTime()).toBe(100_000); // snapped back to the frontier…
    expect(g.state).toBe('buffering'); // …and stalled ON loaded data
    expect(tc.isPlaying()).toBe(false);
  });

  it('never snaps back an external seek far past the frontier', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source });
    g.requestPlay();

    // Legacy code seeks the controller directly: overrun ≫ |speed| × 1s.
    tc.setTime(500_000);
    expect(tc.getTime()).toBe(500_000); // not clamped
    expect(g.state).toBe('playing');
  });

  it('detects a stall from the clock alone — no buffer events required', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source, lowWatermarkWallMs: 600 });
    g.requestPlay();
    expect(g.state).toBe('playing');

    // Runway drains below 600 wall-ms × 10 = 6000 sim-ms, but the network is
    // quiet: notifyBufferChange never fires. The next tick past the probe
    // throttle must catch it anyway.
    state.runwaySimMs = 5000;
    vi.advanceTimersByTime(250);
    tc.setTime(2000); // an ordinary playback tick
    expect(g.state).toBe('buffering');
    expect(tc.isPlaying()).toBe(false);
  });

  it('degraded resume creeps at the frontier instead of looping 8s freezes', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({
      source,
      startGateWallMs: 2000,
      lowWatermarkWallMs: 600,
      resumeFactor: 2,
      maxStartWaitMs: 4000,
    });
    g.requestPlay();
    expect(g.state).toBe('playing');

    // Honest stall: runway drains, gate (40_000 sim-ms) can't fill.
    state.runwaySimMs = 2000;
    vi.advanceTimersByTime(250);
    tc.setTime(3000);
    expect(g.state).toBe('buffering');

    // Escape hatch fires → degraded resume → creep mode.
    const ready = vi.fn();
    g.on('ready', ready);
    vi.advanceTimersByTime(4000);
    expect(g.state).toBe('playing');
    expect(ready).toHaveBeenCalledWith({ degraded: true });
    expect(g.isCreeping).toBe(true);
    // resume tick re-probed the frontier: 3000 + 2000 = 5000.

    // A buffer event below the watermark must NOT re-gate while creeping —
    // that re-gate loop (8s freeze, lurch, repeat) was the bad state.
    g.notifyBufferChange(runway(2000));
    expect(g.state).toBe('playing');

    // The clamp still pins the playhead at the frontier (data-arrival rate)…
    tc.setTime(5600);
    expect(tc.getTime()).toBe(5000);
    expect(g.state).toBe('playing'); // …without re-entering 'buffering'

    // Runway recovers past the resume gate → creep re-arms normal stalling.
    state.runwaySimMs = 50_000;
    vi.advanceTimersByTime(250);
    tc.setTime(5050);
    expect(g.isCreeping).toBe(false);

    // A later drain now stalls honestly again.
    state.runwaySimMs = 1000;
    vi.advanceTimersByTime(250);
    tc.setTime(5100);
    expect(g.state).toBe('buffering');
  });

  it('clamps at the frontier during backward playback', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    tc.setTime(1_000_000);
    tc.setSpeed(-10);
    const g = makeGovernor({ source });
    g.requestPlay();
    expect(g.state).toBe('playing');
    // Frontier probed at 1_000_000 − 100_000 = 900_000.

    state.runwaySimMs = 0;
    tc.setTime(899_600); // playback step past the backward frontier
    expect(tc.getTime()).toBe(900_000);
    expect(g.state).toBe('buffering');
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

  it('paused reflects user intent, not machine state, through gates', () => {
    const { source, state } = makeSource();
    const g = makeGovernor({ source, startGateWallMs: 2000 });
    expect(g.paused).toBe(true);

    g.requestPlay(); // runway 0 → gated, but the intent is "play"
    expect(g.state).toBe('starting');
    expect(g.paused).toBe(false);

    state.runwaySimMs = 100_000;
    g.notifyBufferChange(runway(100_000));
    expect(g.state).toBe('playing');
    expect(g.paused).toBe(false);

    // A mid-playback stall is not "paused" — the user still wants playback.
    state.runwaySimMs = 0;
    g.notifyBufferChange(runway(0));
    expect(g.state).toBe('buffering');
    expect(g.paused).toBe(false);

    g.requestPause();
    expect(g.paused).toBe(true);
    expect(g.state).toBe('idle');
  });

  describe('scrub hold (no gate may pass under a held thumb)', () => {
    it('a settle-commit mid-drag gates, but the clock stays frozen until endScrub', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source, startGateWallMs: 2000 });
      g.requestPlay();
      expect(g.state).toBe('playing');

      g.beginScrub();
      expect(tc.isPlaying()).toBe(false); // frozen for a stable preview

      // The UI's settle timer commits the rested position while the thumb is
      // still held (seekTo mid-drag).
      g.seekTo(50_000);
      expect(g.state).toBe('seeking');
      expect(state.flushes).toBe(1);
      expect(tc.getTime()).toBe(50_000);

      // The runway check WOULD pass (100_000 ≥ 20_000 sim-ms) on both the
      // buffer event and the eval cadence — but the clock must not start.
      g.notifyBufferChange(runway(100_000));
      vi.advanceTimersByTime(1000);
      expect(g.state).toBe('seeking');
      expect(tc.isPlaying()).toBe(false);

      // Release lifts the hold: the gate proceeds and playback resumes.
      g.endScrub(50_000);
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
      expect(tc.getTime()).toBe(50_000);
    });

    it('endScrub on the settle-committed position does not pay a second commit', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      g.beginScrub();
      g.seekTo(50_000); // settle commit: one flush
      expect(state.flushes).toBe(1);

      g.endScrub(50_000); // same position — just lift the hold
      expect(state.flushes).toBe(1); // NO duplicate flushPrefetch
      expect(tc.getTime()).toBe(50_000);
      expect(g.state).toBe('playing');
    });

    it('endScrub on a different position than the settle-commit commits normally', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      g.beginScrub();
      g.seekTo(50_000); // settle commit
      expect(state.flushes).toBe(1);

      g.endScrub(60_000); // the thumb moved again after the settle
      expect(state.flushes).toBe(2); // a real second commit
      expect(tc.getTime()).toBe(60_000);
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
    });

    it("a pre-existing 'starting' gate cannot pass mid-drag even with a full runway", () => {
      const { source, state } = makeSource();
      const g = makeGovernor({ source, startGateWallMs: 2000 });
      g.requestPlay(); // runway 0 → gated
      expect(g.state).toBe('starting');
      g.beginScrub();

      state.runwaySimMs = 1_000_000;
      g.notifyBufferChange(runway(1_000_000));
      vi.advanceTimersByTime(1000); // the eval cadence is held off too
      expect(g.state).toBe('starting');
      expect(tc.isPlaying()).toBe(false);

      // Release commits the final position and the gate opens normally.
      g.endScrub(123);
      expect(g.state).toBe('playing');
      expect(tc.getTime()).toBe(123);
      expect(tc.isPlaying()).toBe(true);
    });

    it('the maxStartWaitMs escape hatch is suspended mid-drag and re-based on release', () => {
      const { source } = makeSource();
      const g = makeGovernor({ source, startGateWallMs: 2000, maxStartWaitMs: 4000 });
      const ready = vi.fn();
      g.on('ready', ready);
      g.requestPlay(); // runway 0 → gated
      expect(g.state).toBe('starting');
      g.beginScrub();
      g.seekTo(10_000); // settle commit → 'seeking' gate, hatch clock running
      expect(g.state).toBe('seeking');

      // Hold the thumb far past maxStartWaitMs: degraded playback under a
      // held thumb is worse than a longer-held preview — the hatch must wait.
      vi.advanceTimersByTime(10_000);
      expect(g.state).toBe('seeking');
      expect(ready).not.toHaveBeenCalled();

      // Release on the settled position re-bases the hatch clock: no instant
      // degraded pass…
      g.endScrub(10_000);
      expect(g.state).toBe('seeking');
      expect(ready).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3_900);
      expect(g.state).toBe('seeking');

      // …it fires a full maxStartWaitMs after the release.
      vi.advanceTimersByTime(350);
      expect(g.state).toBe('playing');
      expect(ready).toHaveBeenCalledWith({ degraded: true });
    });
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

  it('estimateCost passes through to the source (and returns zeros without one)', () => {
    const g = makeGovernor({});
    expect(g.estimateCost({ start: 0, end: 100 })).toEqual({ bytes: 0, tiles: 0 });

    const { source, state } = makeSource();
    state.costBytes = 1234;
    state.costTiles = 7;
    g.setSource(source);
    expect(g.estimateCost({ start: 0, end: 100 })).toEqual({ bytes: 1234, tiles: 7 });
    expect(state.costCalls.at(-1)).toEqual({ start: 0, end: 100 }); // range forwarded verbatim
  });

  describe('getAutoSpeedSuggestion', () => {
    it('computes maxSustainable = throughput / bytesPerSimMs × 0.7', () => {
      const { source, state } = makeSource();
      // Horizon: 8000 wall-ms × speed 10 = 80000 sim-ms; cost 800000 bytes
      // → bytesPerSimMs = 10. Throughput 100 bytes/ms → 100/10 × 0.7 = 7.
      state.costBytes = 800_000;
      state.costTiles = 100;
      const g = makeGovernor({
        source,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      expect(g.getAutoSpeedSuggestion()).toBeCloseTo(7);
    });

    it('returns Infinity when the upcoming horizon has nothing left to load', () => {
      const { source, state } = makeSource();
      // Zero pending tiles ⇒ the network imposes no cap. Consumers clamp the
      // Infinity to their max step, so a fully-cached dataset rises to full
      // speed instead of freezing at whatever multiplier Auto last chose.
      state.costBytes = 0;
      state.costTiles = 0;
      const g = makeGovernor({
        source,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      expect(g.getAutoSpeedSuggestion()).toBe(Infinity);
    });

    it('returns null when tiles are pending but their byte sizes are unknown', () => {
      const { source, state } = makeSource();
      state.costTiles = 5;
      state.costBytes = 0; // the directory exposes no sizes — no honest math
      const g = makeGovernor({
        source,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      expect(g.getAutoSpeedSuggestion()).toBeNull();
    });

    it('returns null when throughput is unknown and no ETA is available', () => {
      const { source, state } = makeSource();
      state.costBytes = 1000;
      state.costTiles = 10;
      state.etaMs = null;
      const g = makeGovernor({ source });
      expect(g.getAutoSpeedSuggestion()).toBeNull();
    });

    it('falls back to ETA-implied throughput when no getThroughput is wired', () => {
      const { source, state } = makeSource();
      // bytes=800000 over horizonSimMs=80000 → bytesPerSimMs=10;
      // ETA 4000ms → implied throughput 200 bytes/ms → 200/10 × 0.7 = 14.
      state.costBytes = 800_000;
      state.costTiles = 100;
      state.etaMs = 4000;
      const g = makeGovernor({ source });
      expect(g.getAutoSpeedSuggestion()).toBeCloseTo(14);
    });

    it('returns null without a source or at zero speed', () => {
      const g = makeGovernor({});
      expect(g.getAutoSpeedSuggestion()).toBeNull();
      const { source, state } = makeSource();
      state.costBytes = 1000;
      state.costTiles = 10;
      g.setSource(source);
      tc.setSpeed(0);
      expect(g.getAutoSpeedSuggestion()).toBeNull();
    });
  });

  describe('loop wrap → seek semantics', () => {
    /** Rebuild tc as a looping clock with rAF frames captured for manual stepping. */
    function makeLoopingClock(initialTime: number) {
      const frames: Array<() => void> = [];
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      });
      tc.destroy();
      tc = new TimeController({
        initialTime,
        speed: 10,
        loop: true,
        timeRange: { start: 0, end: 100_000 },
      });
      return {
        /** Advance fake wall time and run all queued rAF frames. */
        frame(ms: number) {
          vi.advanceTimersByTime(ms);
          for (const cb of frames.splice(0, frames.length)) cb();
        },
      };
    }

    it('gates a wrap into unbuffered time at the PLAIN startup gate, not the resume gate', () => {
      const clock = makeLoopingClock(99_000);
      const { source, state } = makeSource();
      state.runwaySimMs = 1_000_000;
      const g = makeGovernor({ source, startGateWallMs: 2000, resumeFactor: 2 });
      g.requestPlay();
      expect(g.state).toBe('playing');

      // The loop start is NOT buffered; the playhead wraps on the next frame
      // (200 wall-ms × 10 = 2000 sim-ms past 99_000 → 101_000 → wraps to 0).
      state.runwaySimMs = 0;
      const flushesBefore = state.flushes;
      clock.frame(200);
      expect(tc.getTime()).toBe(0);
      expect(g.state).toBe('seeking'); // seek semantics — NOT 'buffering'
      expect(state.flushes).toBe(flushesBefore + 1); // stale prefetch flushed
      expect(tc.isPlaying()).toBe(false);

      // Gate is startup-sized (2000 wall-ms × 10 × 1 = 20_000 sim-ms). The
      // old behavior charged checkLowWatermark's resume gate (40_000).
      state.runwaySimMs = 20_000;
      g.notifyBufferChange(runway(20_000));
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
    });

    it('keeps a wrap into fully-buffered time seamless (gate passes synchronously)', () => {
      const clock = makeLoopingClock(99_000);
      const { source, state } = makeSource();
      state.runwaySimMs = 1_000_000;
      const g = makeGovernor({ source });
      g.requestPlay();

      clock.frame(200); // wraps; gate passes against the huge runway
      expect(tc.getTime()).toBe(0);
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
      // The seek gate was still ENTERED (frontier/prefetch reset) — it just
      // opened in the same tick.
      expect(states).toEqual(['starting', 'playing', 'seeking', 'playing']);

      // …and playback keeps advancing from the wrapped position.
      clock.frame(100);
      expect(tc.getTime()).toBeGreaterThan(0);
    });

  });

  describe("range end → 'ended' / replay semantics", () => {
    /** Rebuild tc as a clamping (non-loop) clock with rAF frames captured for manual stepping. */
    function makeClampingClock(initialTime: number, speed = 10) {
      const frames: Array<() => void> = [];
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      });
      tc.destroy();
      tc = new TimeController({
        initialTime,
        speed,
        loop: false,
        timeRange: { start: 0, end: 100_000 },
      });
      return {
        /** Advance fake wall time and run all queued rAF frames. */
        frame(ms: number) {
          vi.advanceTimersByTime(ms);
          for (const cb of frames.splice(0, frames.length)) cb();
        },
      };
    }

    it("parks as ended at a forward clamp; requestPlay replays from the range start", () => {
      const clock = makeClampingClock(99_000);
      const { source, state } = makeSource();
      state.runwaySimMs = 1_000_000;
      const g = makeGovernor({ source, startGateWallMs: 2000 });
      const ended = vi.fn();
      g.on('ended', ended);
      g.requestPlay();
      expect(g.state).toBe('playing');
      expect(g.ended).toBe(false);

      // 200 wall-ms × 10 = 2000 sim-ms past 99_000 → clamps at 100_000 and
      // the clock pauses itself.
      clock.frame(200);
      expect(tc.getTime()).toBe(100_000);
      expect(g.state).toBe('idle');
      expect(g.ended).toBe(true);
      expect(g.paused).toBe(true); // the clamp dropped user intent
      expect(ended).toHaveBeenCalledTimes(1);
      expect(ended).toHaveBeenCalledWith(100_000);

      // Replay convention: play at the end commits a seek to the range start.
      state.runwaySimMs = 0; // destination not buffered → the seek gate must hold
      const flushesBefore = state.flushes;
      g.requestPlay();
      expect(state.flushes).toBe(flushesBefore + 1); // committed seek flushed prefetch
      expect(g.state).toBe('seeking');
      expect(tc.getTime()).toBe(0);
      expect(g.ended).toBe(false);
      expect(g.paused).toBe(false);

      // The replay gate is the plain startup gate (2000 wall-ms × 10).
      state.runwaySimMs = 20_000;
      g.notifyBufferChange(runway(20_000));
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
    });

    it('replays from the range END when travelling in reverse', () => {
      const clock = makeClampingClock(1_000, -10);
      const { source, state } = makeSource();
      state.runwaySimMs = 1_000_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      expect(g.state).toBe('playing');

      clock.frame(200); // 1_000 − 2000 → clamps at the range start
      expect(tc.getTime()).toBe(0);
      expect(g.ended).toBe(true);
      expect(g.state).toBe('idle');

      g.requestPlay(); // reverse replay seeks to the range end
      expect(tc.getTime()).toBe(100_000);
      expect(g.state).toBe('playing'); // gate passed against the big runway
      expect(g.ended).toBe(false);
    });
  });

  describe('QoE counters', () => {
    it('records startupMs for the start gate and counts mid-playback stalls', () => {
      const { source, state } = makeSource();
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
        resumeFactor: 2,
      });

      g.requestPlay();
      expect(g.state).toBe('starting');
      expect(g.getQoeStats().startupMs).toBeNull();
      vi.advanceTimersByTime(500);
      state.runwaySimMs = 100_000;
      g.notifyBufferChange(runway(100_000));
      expect(g.state).toBe('playing');
      const afterStart = g.getQoeStats();
      expect(afterStart.startupMs).toBeGreaterThanOrEqual(500);
      expect(afterStart.stallCount).toBe(0);
      expect(afterStart.totalStallMs).toBe(0);

      // One honest stall, 1000 ms long.
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      expect(g.getQoeStats().stallCount).toBe(1);
      vi.advanceTimersByTime(1000);
      // In-progress stall time is visible mid-stall.
      expect(g.getQoeStats().totalStallMs).toBeGreaterThanOrEqual(1000);
      state.runwaySimMs = 100_000;
      g.notifyBufferChange(runway(100_000));
      expect(g.state).toBe('playing');

      const final = g.getQoeStats();
      expect(final.stallCount).toBe(1);
      expect(final.totalStallMs).toBeGreaterThanOrEqual(1000);
      expect(final.degradedResumeCount).toBe(0);
      expect(final.creepMs).toBe(0);
    });

    it('counts degraded resumes and accumulates creep wall time', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        resumeFactor: 2,
        maxStartWaitMs: 4000,
      });
      g.requestPlay();
      expect(g.state).toBe('playing');

      // Stall that can only resolve via the escape hatch.
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      vi.advanceTimersByTime(4000);
      expect(g.state).toBe('playing');
      expect(g.isCreeping).toBe(true);
      const degraded = g.getQoeStats();
      expect(degraded.degradedResumeCount).toBe(1);
      expect(degraded.stallCount).toBe(1);
      expect(degraded.totalStallMs).toBeGreaterThanOrEqual(4000);

      // Creep for 2 s, then recover past the resume gate.
      vi.advanceTimersByTime(2000);
      expect(g.getQoeStats().creepMs).toBeGreaterThanOrEqual(2000);
      state.runwaySimMs = 1_000_000;
      g.notifyBufferChange(runway(1_000_000));
      expect(g.isCreeping).toBe(false);
      expect(g.getQoeStats().creepMs).toBeGreaterThanOrEqual(2000);
    });

    it('publishes QoE snapshots on the telemetry playback channel', () => {
      (globalThis as unknown as { __sttProbe?: unknown }).__sttProbe = { enabled: true };
      try {
        const { source, state } = makeSource();
        state.runwaySimMs = 100_000;
        const g = makeGovernor({ source });
        g.requestPlay();
        state.runwaySimMs = 0;
        g.notifyBufferChange(runway(0));
        expect(g.state).toBe('buffering');

        const samples = (
          globalThis as unknown as {
            __sttProbe: { playback?: Array<Record<string, unknown>> };
          }
        ).__sttProbe.playback!;
        expect(samples.some((s) => s.event === 'ready')).toBe(true);
        expect(samples.some((s) => s.event === 'waiting')).toBe(true);
        const last = samples[samples.length - 1];
        expect(last.stallCount).toBe(1);
      } finally {
        delete (globalThis as unknown as { __sttProbe?: unknown }).__sttProbe;
      }
    });
  });

  it('on() returns an unsubscribe function', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 100_000;
    const g = makeGovernor({ source });
    const listener = vi.fn();
    const off = g.on('statechange', listener);
    off();
    g.requestPlay(); // starting → playing transitions fire statechange
    expect(g.state).toBe('playing');
    expect(listener).not.toHaveBeenCalled();
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
