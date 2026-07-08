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
    runwayCalls: [] as Array<{
      time: number;
      direction: 1 | -1;
      horizonSimMs?: number;
    }>,
    costCalls: [] as Array<{ start: number; end: number }>,
    interactiveCalls: [] as boolean[],
    /** Interleaved op log: 'flush' | 'interactive:true' | 'interactive:false'. */
    ops: [] as string[],
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
      state.ops.push('flush');
    },
    setInteractive(interactive: boolean) {
      state.interactiveCalls.push(interactive);
      state.ops.push(`interactive:${interactive}`);
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
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
      ],
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

  function makeGovernor(
    opts: ConstructorParameters<typeof PlaybackGovernor>[1] = {},
  ) {
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
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        maxStartWaitMs: 4000,
      });
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

  describe('scrub-LOD interactive signal (P0 — the bit reaches the loader)', () => {
    it('beginScrub broadcasts setInteractive(true) to ALL sources; endScrub clears it', () => {
      const a = makeSource();
      const b = makeSource();
      const g = makeGovernor();
      // Registration asserts the CURRENT bit (false outside a drag), so a
      // source carrying a stale `true` from an earlier lifecycle is synced.
      g.addSource('heavy', a.source, { required: true });
      g.addSource('overlay', b.source, { required: false }); // optional sources load too
      expect(a.state.interactiveCalls).toEqual([false]);
      expect(b.state.interactiveCalls).toEqual([false]);

      g.beginScrub();
      expect(g.isScrubbing).toBe(true);
      expect(a.state.interactiveCalls).toEqual([false, true]);
      expect(b.state.interactiveCalls).toEqual([false, true]);

      g.scrubTo(1234); // previews never re-broadcast
      expect(a.state.interactiveCalls).toEqual([false, true]);

      g.endScrub(1234);
      expect(g.isScrubbing).toBe(false);
      expect(a.state.interactiveCalls).toEqual([false, true, false]);
      expect(b.state.interactiveCalls).toEqual([false, true, false]);
    });

    it('clears the bit BEFORE the commit flush, so the loader restores its fine tier first (G7)', () => {
      const { source, state } = makeSource();
      const g = makeGovernor({ source }); // registration syncs the bit → false
      g.beginScrub();
      g.endScrub(5_000);
      expect(state.ops).toEqual([
        'interactive:false',
        'interactive:true',
        'interactive:false',
        'flush',
      ]);
    });

    it('fires scrubstart/scrubend exactly once per drag bracket (idempotent grabs)', () => {
      const { source } = makeSource();
      const g = makeGovernor({ source });
      const starts: number[] = [];
      const ends: number[] = [];
      g.on('scrubstart', (t) => starts.push(t));
      g.on('scrubend', (t) => ends.push(t));

      tc.setTime(7_000);
      g.beginScrub();
      g.beginScrub(); // a second grab of a held thumb is the same drag
      expect(starts).toEqual([7_000]);

      g.endScrub(9_000);
      expect(ends).toEqual([9_000]);

      // endScrub without a drag commits a seek but is NOT a scrub bracket.
      g.endScrub(11_000);
      expect(ends).toEqual([9_000]);
      expect(tc.getTime()).toBe(11_000);
    });

    it('a source registered mid-drag receives the interactive bit, and release clears it', () => {
      const early = makeSource();
      const late = makeSource();
      const g = makeGovernor();
      g.addSource('early', early.source);

      g.beginScrub();
      g.addSource('late', late.source);
      expect(late.state.interactiveCalls).toEqual([true]);

      g.endScrub(0);
      expect(late.state.interactiveCalls).toEqual([true, false]);
      expect(early.state.interactiveCalls).toEqual([false, true, false]);
    });

    it('removeSource mid-drag clears the bit on its way out (endScrub can no longer reach it)', () => {
      const kept = makeSource();
      const dropped = makeSource();
      const g = makeGovernor();
      g.addSource('kept', kept.source);
      g.addSource('dropped', dropped.source);

      g.beginScrub();
      expect(dropped.state.interactiveCalls).toEqual([false, true]);

      g.removeSource('dropped');
      // Cleared AT removal — without this the source stayed degraded forever.
      expect(dropped.state.interactiveCalls).toEqual([false, true, false]);

      g.endScrub(0);
      // The removed source hears nothing further; the kept one clears normally.
      expect(dropped.state.interactiveCalls).toEqual([false, true, false]);
      expect(kept.state.interactiveCalls).toEqual([false, true, false]);
    });

    it('removeSource outside a drag does not broadcast anything', () => {
      const { source, state } = makeSource();
      const g = makeGovernor();
      g.addSource('x', source);
      g.removeSource('x');
      expect(state.interactiveCalls).toEqual([false]); // registration sync only
    });

    it('setSource mid-drag clears the bit on every replaced source; the replacement gets true', () => {
      const old = makeSource();
      const next = makeSource();
      const g = makeGovernor();
      g.addSource('default', old.source);

      g.beginScrub();
      expect(old.state.interactiveCalls).toEqual([false, true]);

      g.setSource(next.source);
      expect(old.state.interactiveCalls).toEqual([false, true, false]); // swapped out → cleared
      expect(next.state.interactiveCalls).toEqual([true]); // current bit asserted at add

      g.endScrub(0);
      expect(old.state.interactiveCalls).toEqual([false, true, false]); // unreachable, unchanged
      expect(next.state.interactiveCalls).toEqual([true, false]);
    });

    it('dispose mid-drag stands every source down (the endScrub that would clear it never comes)', () => {
      const a = makeSource();
      const b = makeSource();
      const g = makeGovernor();
      g.addSource('a', a.source);
      g.addSource('b', b.source, { required: false });

      g.beginScrub();
      expect(a.state.interactiveCalls).toEqual([false, true]);

      g.dispose();
      expect(a.state.interactiveCalls).toEqual([false, true, false]);
      expect(b.state.interactiveCalls).toEqual([false, true, false]);

      // The disposed instance is inert — no further broadcasts on endScrub.
      g.endScrub(0);
      expect(a.state.interactiveCalls).toEqual([false, true, false]);
    });

    it('dispose outside a drag does not broadcast anything', () => {
      const { source, state } = makeSource();
      const g = makeGovernor({ source });
      g.dispose();
      expect(state.interactiveCalls).toEqual([false]); // registration sync only
    });

    it('tolerates sources without the optional setInteractive hook', () => {
      const { source } = makeSource();
      delete (source as { setInteractive?: unknown }).setInteractive;
      const g = makeGovernor({ source });
      expect(() => {
        g.beginScrub();
        g.endScrub(100);
      }).not.toThrow();
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
    expect(g.estimateCost({ start: 0, end: 100 })).toEqual({
      bytes: 0,
      tiles: 0,
    });

    const { source, state } = makeSource();
    state.costBytes = 1234;
    state.costTiles = 7;
    g.setSource(source);
    expect(g.estimateCost({ start: 0, end: 100 })).toEqual({
      bytes: 1234,
      tiles: 7,
    });
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
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        resumeFactor: 2,
      });
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

    it('parks as ended at a forward clamp; requestPlay replays from the range start', () => {
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
      (globalThis as unknown as { __sttProbe?: unknown }).__sttProbe = {
        enabled: true,
      };
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

  describe('multi-source registry (Phase 0 — N classified sources)', () => {
    /**
     * Mock source whose runway/complete/cost/eta and side-effect counters are
     * pokeable, and which records every setAnimationState / flushPrefetch so
     * broadcast behaviour is observable. (makeSource above predates
     * setAnimationState; this one carries it.)
     */
    function makeTrackedSource() {
      const state = {
        runwaySimMs: 0,
        complete: false,
        bytesPending: 0,
        ranges: [] as Array<{ start: number; end: number }>,
        costBytes: 0,
        costTiles: 0,
        etaMs: null as number | null,
        flushes: 0,
        animateCalls: [] as Array<{ isAnimating: boolean; speed?: number }>,
      };
      const source: BufferSource = {
        getBufferedRunway(_time, _direction, horizonSimMs) {
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
        setAnimationState(isAnimating, speed) {
          state.animateCalls.push({ isAnimating, speed });
        },
      };
      return { source, state };
    }

    it('gates on the MIN runway across two required sources (clock holds at the laggard)', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      const g = makeGovernor({ startGateWallMs: 2000 }); // gate = 2000 × 10 = 20_000 sim-ms
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });

      // A is well ahead, B lags below the gate → the clock holds at B.
      a.state.runwaySimMs = 100_000;
      b.state.runwaySimMs = 5_000;
      g.requestPlay();
      expect(g.state).toBe('starting');
      expect(tc.isPlaying()).toBe(false);

      // B catches up to the gate → both required ≥ gate → play.
      b.state.runwaySimMs = 20_000;
      g.notifyBufferChange(runway(20_000));
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
    });

    it('stalls when a required source drops below the watermark even if the other is full', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.runwaySimMs = 100_000;
      b.state.runwaySimMs = 100_000;
      const g = makeGovernor({ lowWatermarkWallMs: 600 }); // watermark = 600 × 10 = 6000 sim-ms
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('playing');

      // B drains under the watermark; A stays full → the laggard stalls the clock.
      b.state.runwaySimMs = 1_000;
      g.notifyBufferChange(runway(1_000));
      expect(g.state).toBe('buffering');
      expect(tc.isPlaying()).toBe(false);
    });

    it('an OPTIONAL source never gates — empty optional, full required → plays', () => {
      const required = makeTrackedSource();
      const optional = makeTrackedSource();
      required.state.runwaySimMs = 100_000;
      optional.state.runwaySimMs = 0; // bone dry, never complete
      optional.state.complete = false;
      const g = makeGovernor({
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
      });
      g.addSource('field', required.source, { required: true });
      g.addSource('overlay', optional.source, { required: false });

      g.requestPlay();
      expect(g.state).toBe('playing'); // the empty optional did not hold the gate
      expect(tc.isPlaying()).toBe(true);

      // The optical source staying empty must never trigger a mid-playback stall.
      optional.state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
    });

    it('with ZERO required sources (optional only) the clock never stalls', () => {
      const optional = makeTrackedSource();
      optional.state.runwaySimMs = 0;
      const g = makeGovernor({ startGateWallMs: 2000 });
      g.addSource('overlay', optional.source, { required: false });

      g.requestPlay();
      expect(g.state).toBe('playing'); // nothing gates ⇒ instant start
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('playing');
    });

    it('complete = AND over required: one incomplete required source keeps the gate honest', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      // A is complete (tiny runway), B is NOT complete and below the gate.
      a.state.runwaySimMs = 5;
      a.state.complete = true;
      b.state.runwaySimMs = 100; // < gate, not complete
      b.state.complete = false;
      const g = makeGovernor({ startGateWallMs: 2000 });
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });

      g.requestPlay();
      // A's completeness must NOT short-circuit the AND — B still gates.
      expect(g.state).toBe('starting');

      // Now B completes too → AND true → never gate → play.
      b.state.complete = true;
      g.notifyBufferChange(runway(100, true));
      expect(g.state).toBe('playing');
    });

    it('never gates when every required source is complete (AND of complete)', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.runwaySimMs = 5;
      a.state.complete = true;
      b.state.runwaySimMs = 5;
      b.state.complete = true;
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('playing');
    });

    it('getEtaMs = MAX estimateTimeToReadyMs across ALL sources (required + optional)', () => {
      const req = makeTrackedSource();
      const opt = makeTrackedSource();
      req.state.etaMs = 1_000;
      opt.state.etaMs = 5_000; // an optional source still counts toward the honest ETA
      const g = makeGovernor();
      g.addSource('req', req.source, { required: true });
      g.addSource('opt', opt.source, { required: false });
      expect(g.getEtaMs()).toBe(5_000);
    });

    it('estimateCost = SUM of bytes/tiles across ALL sources', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      const c = makeTrackedSource();
      a.state.costBytes = 100;
      a.state.costTiles = 1;
      b.state.costBytes = 250;
      b.state.costTiles = 3;
      c.state.costBytes = 5; // optional still summed
      c.state.costTiles = 1;
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      g.addSource('c', c.source, { required: false });
      expect(g.estimateCost({ start: 0, end: 100 })).toEqual({
        bytes: 355,
        tiles: 5,
      });
    });

    it('getAutoSpeedSuggestion = CONTENDED speed (aggregate pipe ÷ Σ demand), NOT the per-source min', () => {
      // Two comparably-heavy required sources SHARE one pipe. The old code
      // returned the min over each source's OPTIMISTIC full-pipe estimate
      // (each assuming it owned the whole link) → ~N× too fast → the network
      // can't feed it → stalls (the "racing ahead" failure mode). The correct
      // bound divides the ONE pipe across the SUM of both sources' demand.
      const fast = makeTrackedSource();
      const slow = makeTrackedSource();
      // horizon = 8000 × 10 = 80_000 sim-ms; aggregate throughput 100 bytes/ms.
      // Σbytes = 800_000 + 1_600_000 = 2_400_000 → bytesPerSimMs = 30.
      // CONTENDED = 100 / 30 × 0.7 ≈ 2.333…
      // The OPTIMISTIC per-source min would have been 3.5 (slow alone) — and
      // even that double-counts the pipe; the contended bound is lower still.
      fast.state.costBytes = 800_000;
      fast.state.costTiles = 100;
      slow.state.costBytes = 1_600_000;
      slow.state.costTiles = 100;
      const g = makeGovernor({
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      g.addSource('fast', fast.source, { required: true });
      g.addSource('slow', slow.source, { required: true });
      const suggestion = g.getAutoSpeedSuggestion()!;
      expect(suggestion).toBeCloseTo((100 / 30) * 0.7); // ≈ 2.333
      // Strictly slower than the optimistic per-source min (3.5) it replaced.
      expect(suggestion).toBeLessThan(3.5);
    });

    it('getAutoSpeedSuggestion: two comparably-heavy required sources halve the contended speed vs one', () => {
      // A second comparably-heavy required source roughly HALVES the sustainable
      // speed (Σ demand doubles over the same shared pipe) — the property the
      // per-source min got wrong (it stayed at the single-source speed).
      const oneHeavy = makeTrackedSource();
      oneHeavy.state.costBytes = 800_000;
      oneHeavy.state.costTiles = 100;
      const g1 = makeGovernor({
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      g1.addSource('a', oneHeavy.source, { required: true });
      const solo = g1.getAutoSpeedSuggestion()!; // 100 / 10 × 0.7 = 7
      g1.dispose();

      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.costBytes = 800_000;
      a.state.costTiles = 100;
      b.state.costBytes = 800_000; // a second, equally heavy required source
      b.state.costTiles = 100;
      governor = new PlaybackGovernor(tc, {
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      governor.addSource('a', a.source, { required: true });
      governor.addSource('b', b.source, { required: true });
      const contended = governor.getAutoSpeedSuggestion()!; // Σ=1_600_000 → 100/20×0.7 = 3.5
      expect(contended).toBeCloseTo(solo / 2); // exactly half — the contended bound
    });

    it('getAutoSpeedSuggestion: NO-getThroughput fallback is ALSO contended for multi-heavy sources', () => {
      // The PRODUCTION path: no consumer wires getThroughput on the governor, so
      // the ETA-implied fallback runs. Each source's estimateTimeToReadyMs is
      // bytes_i / sharedLinkRate over the SAME shared link, so the per-source
      // implied rates (bytes_i / eta_i) are all equal to that one link rate. The
      // fallback must recover that single rate and divide it across Σbytes — NOT
      // sum the rates (which would double-count the pipe by ~N and silently
      // reproduce the optimistic single-source speed, the multi-heavy bug).
      //
      // Shared link rate T = 100 bytes/ms. horizon = 8000 × 10 = 80_000 sim-ms.
      // Two EQUAL 800_000-byte sources, each eta = 800_000 / 100 = 8000ms.
      // Σbytes = 1_600_000 → bytesPerSimMs = 20. Contended = 100 / 20 × 0.7 = 3.5
      // (exactly the getThroughput path), NOT the old fallback's 7 (single speed).
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.costBytes = 800_000;
      a.state.costTiles = 100;
      a.state.etaMs = 8000; // 800_000 bytes / 100 bytes-per-ms shared link
      b.state.costBytes = 800_000;
      b.state.costTiles = 100;
      b.state.etaMs = 8000;
      const g = makeGovernor({}); // NO getThroughput — the live default
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      const contended = g.getAutoSpeedSuggestion()!;
      expect(contended).toBeCloseTo(3.5); // = (100 / 20) × 0.7 — matches the wired path
      expect(contended).toBeLessThan(7); // strictly under the single-source speed
    });

    it('getAutoSpeedSuggestion: NO-getThroughput fallback contends asymmetric multi-heavy sources', () => {
      // Asymmetric heavy sources over the SAME shared link (T = 100 bytes/ms).
      // A: 1_600_000 bytes, eta = 16_000ms. B: 800_000 bytes, eta = 8_000ms.
      // bytes_i / eta_i = 100 for both (the one link rate). Σbytes = 2_400_000
      // → bytesPerSimMs = 30. Contended = 100 / 30 × 0.7 ≈ 2.333 — NOT the old
      // fallback's Σbytes / maxEta = 2_400_000 / 16_000 = 150 → 150/30×0.7 = 3.5.
      const heavy = makeTrackedSource();
      const light = makeTrackedSource();
      heavy.state.costBytes = 1_600_000;
      heavy.state.costTiles = 200;
      heavy.state.etaMs = 16_000;
      light.state.costBytes = 800_000;
      light.state.costTiles = 100;
      light.state.etaMs = 8_000;
      const g = makeGovernor({}); // NO getThroughput
      g.addSource('heavy', heavy.source, { required: true });
      g.addSource('light', light.source, { required: true });
      const contended = g.getAutoSpeedSuggestion()!;
      expect(contended).toBeCloseTo((100 / 30) * 0.7); // ≈ 2.333
      expect(contended).toBeLessThan(3.5); // strictly under the old optimistic value
    });

    it('getAutoSpeedSuggestion returns Infinity only when ALL required sources are clear', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.costTiles = 0; // nothing to load
      b.state.costTiles = 0;
      const g = makeGovernor({
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      expect(g.getAutoSpeedSuggestion()).toBe(Infinity);

      // One source still has work → no longer uncapped.
      b.state.costTiles = 50;
      b.state.costBytes = 800_000;
      expect(g.getAutoSpeedSuggestion()).toBeCloseTo(7);
    });

    it('getAutoSpeedSuggestion returns null when a required source has pending tiles but unknown byte sizes (single-source contract under composition)', () => {
      // The single-source `sumBytes <= 0 ⇒ null` contract, generalized to N
      // sources. A bytes-blind required source (tiles > 0, bytes = 0 — the
      // directory exposes no sizes) ALONGSIDE a normal heavy source keeps
      // Σbytes positive, so the old code proceeded with an UNDER-COUNTED demand
      // and over-suggested speed. There is no honest combined Σbytes when any
      // required track's cost is unknown ⇒ null (mirrors the anyEtaBlind path).
      const blind = makeTrackedSource();
      const normal = makeTrackedSource();
      blind.state.costTiles = 5; // pending tiles…
      blind.state.costBytes = 0; // …but the directory exposes no byte sizes
      normal.state.costTiles = 100;
      normal.state.costBytes = 800_000; // a normal, sized peer keeps Σbytes > 0
      const g = makeGovernor({
        getThroughput: () => ({ bytesPerMs: 100, samples: 5 }),
      });
      g.addSource('blind', blind.source, { required: true });
      g.addSource('normal', normal.source, { required: true });
      // Without the fix this returned a (too-high) finite suggestion off the
      // under-counted Σbytes = 800_000 instead of null.
      expect(g.getAutoSpeedSuggestion()).toBeNull();

      // Sanity: once the blind source's sizes become known, the honest
      // contended math resumes (Σ = 1_600_000 → 100 / 20 × 0.7 = 3.5).
      blind.state.costBytes = 800_000;
      expect(g.getAutoSpeedSuggestion()).toBeCloseTo(3.5);
    });

    it('broadcasts setAnimationState(true) to ALL sources when a gate is entered', () => {
      const req = makeTrackedSource();
      const opt = makeTrackedSource();
      req.state.runwaySimMs = 0; // gate will hold, asserting animating-at-speed
      const g = makeGovernor({ startGateWallMs: 2000 });
      g.addSource('req', req.source, { required: true });
      g.addSource('opt', opt.source, { required: false });

      g.requestPlay();
      expect(g.state).toBe('starting');
      // Both the required AND the optional loader were told to keep reaching ahead.
      expect(req.state.animateCalls.at(-1)).toEqual({
        isAnimating: true,
        speed: 10,
      });
      expect(opt.state.animateCalls.at(-1)).toEqual({
        isAnimating: true,
        speed: 10,
      });
    });

    it('broadcasts setAnimationState(false) to ALL sources on a real pause', () => {
      const req = makeTrackedSource();
      const opt = makeTrackedSource();
      req.state.runwaySimMs = 100_000;
      const g = makeGovernor();
      g.addSource('req', req.source, { required: true });
      g.addSource('opt', opt.source, { required: false });
      g.requestPlay();
      expect(g.state).toBe('playing');

      g.requestPause();
      expect(req.state.animateCalls.at(-1)).toEqual({
        isAnimating: false,
        speed: 0,
      });
      expect(opt.state.animateCalls.at(-1)).toEqual({
        isAnimating: false,
        speed: 0,
      });
    });

    it('flushPrefetch on a committed seek reaches ALL sources', () => {
      const req = makeTrackedSource();
      const opt = makeTrackedSource();
      const g = makeGovernor();
      g.addSource('req', req.source, { required: true });
      g.addSource('opt', opt.source, { required: false });

      g.seekTo(12_345);
      expect(req.state.flushes).toBe(1);
      expect(opt.state.flushes).toBe(1); // the optional loader is flushed too
    });

    it('getSourceRunways probes each source at the playhead and identifies the gating source', () => {
      const fieldA = makeTrackedSource();
      const fieldB = makeTrackedSource();
      const overlay = makeTrackedSource();
      fieldA.state.runwaySimMs = 50_000;
      fieldA.state.bytesPending = 1_000;
      fieldB.state.runwaySimMs = 8_000; // the laggard among required → the gating source
      fieldB.state.bytesPending = 9_000;
      overlay.state.runwaySimMs = 1_000; // smaller, but OPTIONAL → never gates
      overlay.state.bytesPending = 2_000;
      tc.setTime(123_456);
      const g = makeGovernor();
      g.addSource('fieldA', fieldA.source, { required: true });
      g.addSource('fieldB', fieldB.source, { required: true });
      g.addSource('overlay', overlay.source, { required: false });

      const runways = g.getSourceRunways();
      // Correct shape, in registration order, one entry per source.
      expect(runways).toEqual([
        {
          id: 'fieldA',
          required: true,
          runwaySimMs: 50_000,
          complete: false,
          bytesPending: 1_000,
        },
        {
          id: 'fieldB',
          required: true,
          runwaySimMs: 8_000,
          complete: false,
          bytesPending: 9_000,
        },
        {
          id: 'overlay',
          required: false,
          runwaySimMs: 1_000,
          complete: false,
          bytesPending: 2_000,
        },
      ]);

      // The gating source is the required entry with the smallest runway among
      // the incomplete ones — fieldB, NOT the smaller-but-optional overlay.
      const gating = runways
        .filter((r) => r.required && !r.complete)
        .sort((x, y) => x.runwaySimMs - y.runwaySimMs)[0];
      expect(gating.id).toBe('fieldB');
    });

    it('getSourceRunways is a pure read (no flush, no animate, no state change) and probes at the playhead direction', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.runwaySimMs = 10_000;
      b.state.runwaySimMs = 20_000;
      tc.setSpeed(-10); // reverse travel
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: false });
      const stateBefore = g.state;

      // Probe many times — no side effects must accumulate.
      g.getSourceRunways();
      g.getSourceRunways();
      expect(a.state.flushes).toBe(0);
      expect(b.state.flushes).toBe(0);
      expect(a.state.animateCalls).toEqual([]);
      expect(b.state.animateCalls).toEqual([]);
      expect(g.state).toBe(stateBefore);

      // [] when no source is registered.
      g.removeSource('a');
      g.removeSource('b');
      expect(g.getSourceRunways()).toEqual([]);
    });

    it('getSourceRunways reflects a complete source', () => {
      const a = makeTrackedSource();
      a.state.runwaySimMs = 0;
      a.state.complete = true;
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      const [entry] = g.getSourceRunways();
      expect(entry.complete).toBe(true);
      // No required+incomplete entry ⇒ nothing currently gating.
      const gating = g
        .getSourceRunways()
        .filter((r) => r.required && !r.complete)
        .sort((x, y) => x.runwaySimMs - y.runwaySimMs)[0];
      expect(gating).toBeUndefined();
    });

    it('removeSource drops a laggard from the gate so the clock can play', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.runwaySimMs = 100_000;
      b.state.runwaySimMs = 0; // the laggard
      const g = makeGovernor({ startGateWallMs: 2000 });
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('starting'); // held by B

      g.removeSource('b'); // re-evaluates; now only A (full) gates
      expect(g.state).toBe('playing');
    });

    it('getBufferedRanges = intersection over required sources', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.ranges = [{ start: 0, end: 100 }];
      b.state.ranges = [{ start: 50, end: 150 }];
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      expect(g.getBufferedRanges()).toEqual([{ start: 50, end: 100 }]);
    });

    it('getBufferedRanges ignores OPTIONAL sources (required intersection only)', () => {
      const req = makeTrackedSource();
      const opt = makeTrackedSource();
      req.state.ranges = [{ start: 0, end: 100 }];
      opt.state.ranges = [{ start: 200, end: 300 }]; // disjoint — must not zero the bar
      const g = makeGovernor();
      g.addSource('req', req.source, { required: true });
      g.addSource('opt', opt.source, { required: false });
      expect(g.getBufferedRanges()).toEqual([{ start: 0, end: 100 }]);
    });

    it('getBufferedRanges does NOT forward maxRanges to per-source probes before intersecting', () => {
      // Deferred Wave-2 LOW fix: maxRanges must be applied ONCE on the combined
      // intersection, never to each per-source probe. A source whose own
      // getBufferedRanges honors maxRanges (sorted) would otherwise truncate
      // and drop a later range that WOULD have intersected a peer's — silently
      // shrinking the combined span. This mock honors maxRanges so the bug is
      // observable: if maxRanges=1 were forwarded, source `a` would return only
      // [0,100], its [200,300] dropped, and the [250,260] intersection lost.
      function maxRangesAwareSource(
        ranges: Array<{ start: number; end: number }>,
      ) {
        const s: BufferSource = {
          getBufferedRunway: () => runway(0),
          getBufferedRanges(opts) {
            const sorted = [...ranges].sort((x, y) => x.start - y.start);
            return opts?.maxRanges != null
              ? sorted.slice(0, opts.maxRanges)
              : sorted;
          },
          estimateCost: () => ({ bytes: 0, tiles: 0 }),
          estimateTimeToReadyMs: () => null,
          flushPrefetch: () => {},
        };
        return s;
      }
      const a = maxRangesAwareSource([
        { start: 0, end: 100 },
        { start: 200, end: 300 }, // would be dropped by a forwarded maxRanges:1
      ]);
      const b = maxRangesAwareSource([{ start: 250, end: 260 }]);
      const g = makeGovernor();
      g.addSource('a', a, { required: true });
      g.addSource('b', b, { required: true });
      // The surviving intersection [250,260] proves the second source range was
      // NOT truncated away before intersecting.
      expect(g.getBufferedRanges({ maxRanges: 1 })).toEqual([
        { start: 250, end: 260 },
      ]);
    });

    it('getBufferedRanges applies maxRanges once on the combined intersection (trailing slice)', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      // Three overlapping windows; the intersection yields three ranges, capped
      // to two by the trailing slice on the COMBINED result.
      a.state.ranges = [
        { start: 0, end: 100 },
        { start: 200, end: 300 },
        { start: 400, end: 500 },
      ];
      b.state.ranges = [
        { start: 10, end: 90 },
        { start: 210, end: 290 },
        { start: 410, end: 490 },
      ];
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      expect(g.getBufferedRanges()).toEqual([
        { start: 10, end: 90 },
        { start: 210, end: 290 },
        { start: 410, end: 490 },
      ]);
      expect(g.getBufferedRanges({ maxRanges: 2 })).toEqual([
        { start: 10, end: 90 },
        { start: 210, end: 290 },
      ]);
    });

    it('addSource ignores a source lacking the buffering API (warns, no throw)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const g = makeGovernor({ maxStartWaitMs: 1000 });
      g.addSource('bad', {} as unknown as BufferSource, { required: true });
      g.requestPlay();
      expect(g.state).toBe('starting');
      vi.advanceTimersByTime(1100); // degrades to the escape hatch
      expect(g.state).toBe('playing');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('setSource(badSource) ALWAYS re-evaluates even though the bad source is rejected', () => {
      // Deferred Phase-0 fix: setSource clears the registry then defers to
      // addSource, which returns early on a bad object (no getBufferedRunway)
      // BEFORE its own evaluateNow(). Pre-fix, replacing a source with a bad
      // one therefore emptied the registry without ever re-gating. setSource
      // must re-evaluate unconditionally. Spy on the (private) evaluateNow to
      // pin the contract directly: it fires exactly once on the rejected swap.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const g = makeGovernor({ startGateWallMs: 2000 });
      const evalSpy = vi.spyOn(
        g as unknown as { evaluateNow: () => void },
        'evaluateNow',
      );

      g.setSource({} as unknown as BufferSource);
      expect(warn).toHaveBeenCalled(); // the bad source was rejected…
      expect(evalSpy).toHaveBeenCalledTimes(1); // …but the swap STILL re-evaluated

      // A good source's success path re-evaluates TWICE (addSource's own
      // evaluateNow + setSource's unconditional one — cheap + idempotent, as
      // documented): 1 (bad swap) + 2 (good swap) = 3.
      const good = makeTrackedSource();
      good.state.runwaySimMs = 100_000;
      g.setSource(good.source);
      expect(evalSpy).toHaveBeenCalledTimes(3);
      g.requestPlay();
      expect(g.state).toBe('playing');
      evalSpy.mockRestore();
      warn.mockRestore();
    });

    it('setSource(badSource) replacing a GATING source leaves the gate live (escape hatch still fires)', () => {
      // End-to-end shape of the fix: a required source holds the start gate
      // (empty runway), then is replaced by a bad source. The registry empties
      // and the machine stays gated (nothing proves readiness), but the gate
      // is never stranded — the maxStartWaitMs escape hatch still resolves it.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const good = makeTrackedSource();
      good.state.runwaySimMs = 0; // holds the start gate
      const g = makeGovernor({ startGateWallMs: 2000, maxStartWaitMs: 4000 });
      g.setSource(good.source);
      g.requestPlay();
      expect(g.state).toBe('starting');

      g.setSource({} as unknown as BufferSource); // empties the registry, re-evaluates
      expect(warn).toHaveBeenCalled();
      expect(g.state).toBe('starting'); // still gated (no source proves readiness)

      vi.advanceTimersByTime(4000); // the escape hatch resolves the gate
      expect(g.state).toBe('playing');
      warn.mockRestore();
    });

    it('setSource back-compat: clears the registry then registers a required default', () => {
      const a = makeTrackedSource();
      const b = makeTrackedSource();
      a.state.runwaySimMs = 0; // would hold the gate
      b.state.runwaySimMs = 100_000;
      const g = makeGovernor({ startGateWallMs: 2000 });
      g.addSource('a', a.source, { required: true });

      // setSource replaces the whole registry with just B as 'default' required.
      g.setSource(b.source);
      g.requestPlay();
      expect(g.state).toBe('playing'); // A is gone; only B (full) gates

      // The old single-source side-effects still reach the default source.
      g.requestPause();
      expect(b.state.animateCalls.at(-1)).toEqual({
        isAnimating: false,
        speed: 0,
      });
      // A (removed by setSource) received no further broadcasts.
      const aBroadcastsAfterReplace = a.state.animateCalls.length;
      g.seekTo(7);
      expect(b.state.flushes).toBeGreaterThan(0);
      expect(a.state.animateCalls.length).toBe(aBroadcastsAfterReplace); // A is gone

      // setSource(null) empties the registry (no throw, no source resident).
      g.setSource(null);
      expect(g.getBufferedRanges()).toEqual([]);
      expect(g.estimateCost({ start: 0, end: 1 })).toEqual({
        bytes: 0,
        tiles: 0,
      });
    });

    describe('cold-start gate across N required sources (Phase 3 audit)', () => {
      it('play-from-cold releases the clock only once BOTH required sources reach the start gate', () => {
        // The Phase-0 combined min-gate already serves cold start: evaluateGate
        // folds min(runway)+AND(complete) over required, so the clock waits for
        // EVERY required source. No new cold-start machinery needed.
        const a = makeTrackedSource();
        const b = makeTrackedSource();
        a.state.runwaySimMs = 0; // both bone dry at cold start
        b.state.runwaySimMs = 0;
        const g = makeGovernor({ startGateWallMs: 2000 }); // gate = 20_000 sim-ms
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });

        g.requestPlay();
        expect(g.state).toBe('starting');
        expect(tc.isPlaying()).toBe(false);

        // A reaches the start gate but B is still dry → clock STILL held.
        a.state.runwaySimMs = 100_000;
        g.notifyBufferChange(runway(100_000));
        expect(g.state).toBe('starting');
        expect(tc.isPlaying()).toBe(false);

        // B finally reaches the gate → both required satisfied → clock releases.
        b.state.runwaySimMs = 20_000;
        g.notifyBufferChange(runway(20_000));
        expect(g.state).toBe('playing');
        expect(tc.isPlaying()).toBe(true);
      });

      it('cold-start throughput floor: a fast network passes the gate at empty buffer via predictsPlaythrough', () => {
        // The cold-start throughput FLOOR already exists: predictsPlaythrough
        // (PLAYTHROUGH_MIN_WALL_MS) lets a fast network start with ~zero
        // buffered runway, folded over ALL required sources (max ETA). No
        // separate floor was added.
        const a = makeTrackedSource();
        const b = makeTrackedSource();
        a.state.runwaySimMs = 0; // empty buffer…
        b.state.runwaySimMs = 0;
        a.state.etaMs = 10; // …but both predicted to download near-instantly
        b.state.etaMs = 10;
        const g = makeGovernor({ startGateWallMs: 2000 });
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });

        g.requestPlay();
        // Empty buffer, but the throughput-implied ETA is within the floor for
        // BOTH required sources → start immediately, no degraded escape hatch.
        expect(g.state).toBe('playing');
        expect(tc.isPlaying()).toBe(true);
      });

      it('cold-start holds when ONE required source is blind/slow even if the other is instant', () => {
        // predictsPlaythrough is conservative on a blind required source (null
        // ETA) and folds the MAX ETA, so a single slow/blind required source
        // keeps the cold gate closed — the floor never masks a laggard.
        const fast = makeTrackedSource();
        const blind = makeTrackedSource();
        fast.state.runwaySimMs = 0;
        fast.state.etaMs = 10; // instant
        blind.state.runwaySimMs = 0;
        blind.state.etaMs = null; // blind ⇒ conservative ⇒ no playthrough
        const g = makeGovernor({
          startGateWallMs: 2000,
          maxStartWaitMs: 60_000,
        });
        g.addSource('fast', fast.source, { required: true });
        g.addSource('blind', blind.source, { required: true });

        g.requestPlay();
        expect(g.state).toBe('starting'); // held by the blind required source
        expect(tc.isPlaying()).toBe(false);
      });
    });

    describe('cadence tolerance band (Phase 1 — W3C Bug 26436)', () => {
      it('two required sources with within-tolerance horizons do NOT spuriously stall while playing', () => {
        // speed 10; runwayToleranceMs 250 → tolerance = 2500 sim-ms.
        // Both sources sit comfortably above the watermark but their cadences
        // land their horizons 2000 sim-ms apart (< tolerance). A raw min would
        // pin the combined runway to the lower one; the band lifts the laggard
        // to the leader so neither false-stalls.
        const a = makeTrackedSource();
        const b = makeTrackedSource();
        a.state.runwaySimMs = 100_000;
        b.state.runwaySimMs = 100_000;
        const g = makeGovernor({
          startGateWallMs: 2000, // gate 20_000 sim-ms
          lowWatermarkWallMs: 600, // watermark 6_000 sim-ms
          runwayToleranceMs: 250, // band 2_500 sim-ms
        });
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });
        g.requestPlay();
        expect(g.state).toBe('playing');

        // The fastest-cadence source dips to 5_000 (BELOW the 6_000 watermark)
        // while its peer is still at 7_000 — i.e. only cadence jitter around a
        // healthy ~7_000 frontier (lead 7_000 − 5_000 = 2_000 ≤ 2_500 band).
        // A raw min(5_000) < 6_000 would stall; the band must coalesce to
        // 7_000 ≥ 6_000 and keep playing.
        a.state.runwaySimMs = 7_000;
        b.state.runwaySimMs = 5_000;
        g.notifyBufferChange(runway(5_000));
        expect(g.state).toBe('playing');
        expect(tc.isPlaying()).toBe(true);
      });

      it('a required source genuinely beyond tolerance below the watermark DOES still stall (no protection lost)', () => {
        const a = makeTrackedSource();
        const b = makeTrackedSource();
        a.state.runwaySimMs = 100_000;
        b.state.runwaySimMs = 100_000;
        const g = makeGovernor({
          startGateWallMs: 2000,
          lowWatermarkWallMs: 600, // watermark 6_000 sim-ms
          runwayToleranceMs: 250, // band 2_500 sim-ms
        });
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });
        g.requestPlay();
        expect(g.state).toBe('playing');

        // B genuinely starves: 1_000 is 99_000 below the leader (≫ band), so
        // it is NOT lifted, drags the combined runway to 1_000 < 6_000, and
        // stalls. The band must never mask real starvation.
        b.state.runwaySimMs = 1_000;
        g.notifyBufferChange(runway(1_000));
        expect(g.state).toBe('buffering');
        expect(tc.isPlaying()).toBe(false);
      });

      it('runwayToleranceMs = 0 reproduces the raw-min behavior (fractional gap stalls)', () => {
        const a = makeTrackedSource();
        const b = makeTrackedSource();
        a.state.runwaySimMs = 100_000;
        b.state.runwaySimMs = 100_000;
        const g = makeGovernor({
          startGateWallMs: 2000,
          lowWatermarkWallMs: 600, // watermark 6_000 sim-ms
          runwayToleranceMs: 0, // raw min/AND — no band
        });
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });
        g.requestPlay();
        expect(g.state).toBe('playing');

        // The SAME cadence jitter as the first test (lead 7_000, lag 5_000)
        // now stalls, because with a zero band the raw min(5_000) < 6_000.
        a.state.runwaySimMs = 7_000;
        b.state.runwaySimMs = 5_000;
        g.notifyBufferChange(runway(5_000));
        expect(g.state).toBe('buffering');
      });

      it('the band lifts the cached frontier so a within-tolerance peer is not clamped back', () => {
        // The per-tick clamp must use the BANDED frontier; otherwise the
        // playhead would be snapped back to a fractionally-behind cadence peer
        // even when the leader has data well ahead.
        const a = makeTrackedSource();
        const b = makeTrackedSource();
        a.state.runwaySimMs = 100_000; // leader: frontier at 0 + 100_000
        b.state.runwaySimMs = 98_000; // 2_000 behind ≤ 2_500 band → lifted
        const g = makeGovernor({
          startGateWallMs: 2000,
          lowWatermarkWallMs: 600,
          runwayToleranceMs: 250, // band 2_500 sim-ms
        });
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });
        g.requestPlay();
        expect(g.state).toBe('playing');
        // Frontier should be banded to the leader (100_000), not pinned to the
        // 98_000 peer: a playback step to 99_000 sits inside the leader's data
        // and must not be clamped/stalled.
        tc.setTime(99_000);
        expect(tc.getTime()).toBe(99_000); // not snapped back to 98_000
        expect(g.state).toBe('playing');
      });

      it('defaults runwayToleranceMs to the tick-probe scale (small fractional gap does not stall)', () => {
        // No runwayToleranceMs option → default 200 wall-ms → 2_000 sim-ms band
        // at speed 10. A 1_500 sim-ms gap below the watermark is jitter and
        // must not stall under the default.
        const a = makeTrackedSource();
        const b = makeTrackedSource();
        a.state.runwaySimMs = 100_000;
        b.state.runwaySimMs = 100_000;
        const g = makeGovernor({
          startGateWallMs: 2000,
          lowWatermarkWallMs: 600,
        });
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });
        g.requestPlay();
        expect(g.state).toBe('playing');

        // lead 7_000, lag 5_500 → gap 1_500 ≤ 2_000 default band → no stall.
        a.state.runwaySimMs = 7_000;
        b.state.runwaySimMs = 5_500;
        g.notifyBufferChange(runway(5_500));
        expect(g.state).toBe('playing');
      });

      it('a single required source is unaffected by the band (still gates honestly)', () => {
        // With one required source the leader IS the source, so the band is a
        // no-op: a genuine drop below the watermark still stalls.
        const a = makeTrackedSource();
        a.state.runwaySimMs = 100_000;
        const g = makeGovernor({
          lowWatermarkWallMs: 600,
          runwayToleranceMs: 250,
        });
        g.addSource('a', a.source, { required: true });
        g.requestPlay();
        expect(g.state).toBe('playing');

        a.state.runwaySimMs = 1_000; // below watermark, only source
        g.notifyBufferChange(runway(1_000));
        expect(g.state).toBe('buffering');
      });
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
