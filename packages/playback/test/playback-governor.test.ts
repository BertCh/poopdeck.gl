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
import { decideAutoSpeedMultiplier, SPEED_STEPS } from '../src/auto-speed';
import {
  computeProgressiveFillWeights,
  computeRunwayShedWeights,
  legacyRunwayShedWeight,
  type ProgressiveFillProbe,
} from '../src/fairness';

/** Mutable mock BufferSource: tests poke `runwaySimMs`/`complete` directly. */
function makeSource() {
  const state = {
    runwaySimMs: 0,
    complete: false,
    /** B8: the loader wrote the next tile off as permanently unavailable. */
    blockedPermanently: false,
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
        // Only present when set, so the default mock still exercises the
        // flag-absent (pre-B8 loader) path.
        ...(state.blockedPermanently ? { blockedPermanently: true } : {}),
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

  it('G8: never hatches into a source-less playing — the hatch is timed from the first registration', () => {
    // Re-blessed from "starts degraded after maxStartWaitMs even with no
    // source" (audit G8 / CS-9): embed autoplay calls requestPlay before the
    // tileset registers, and a hatch fired against an EMPTY registry
    // free-runs the clock into the timeline with no clamp. With no source
    // there is nothing to be degraded ABOUT, so the hatch waits for one.
    const g = makeGovernor({ maxStartWaitMs: 4000 });
    const ready = vi.fn();
    g.on('ready', ready);

    g.requestPlay();
    expect(g.state).toBe('starting');
    vi.advanceTimersByTime(9000);
    expect(g.state).toBe('starting'); // no source ⇒ no hatch, however long
    expect(tc.isPlaying()).toBe(false);
    expect(ready).not.toHaveBeenCalled();

    // The first registration starts the hatch clock — not the requestPlay
    // 9 s ago — so an incomplete runway holds the gate for a FULL
    // maxStartWaitMs from here.
    const { source, state } = makeSource();
    state.runwaySimMs = 0;
    g.addSource('a', source, { required: true });
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

    it('B5: a wrap does not flush a loop-aware source (one that accepts the loop window) — its post-wrap runway is the one it just warmed', () => {
      const clock = makeLoopingClock(99_000);
      const { source, state } = makeSource();
      state.runwaySimMs = 1_000_000;
      const loopWindows: Array<{ start: number; end: number } | null> = [];
      source.setLoopWindow = (range) => {
        loopWindows.push(range);
      };
      const g = makeGovernor({ source, startGateWallMs: 2000 });
      g.requestPlay();
      expect(g.state).toBe('playing');

      state.runwaySimMs = 0;
      const flushesBefore = state.flushes;
      clock.frame(200); // wraps 101_000 → 0
      expect(tc.getTime()).toBe(0);
      expect(g.state).toBe('seeking'); // the gate still re-checks the frontier
      // …but the loop-aware source keeps its in-flight lookahead across the
      // wrap: no flush. (A plain source is still flushed — see the previous
      // case, whose fake has no setLoopWindow.)
      expect(state.flushes).toBe(flushesBefore);
      expect(loopWindows.length).toBeGreaterThan(0);
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

      it('cold-start throughput floor: a fast network passes the gate on a THIN buffer via predictsPlaythrough — never on an EMPTY one (G3-4a)', () => {
        // The cold-start throughput FLOOR already exists: predictsPlaythrough
        // (PLAYTHROUGH_MIN_WALL_MS) lets a fast network start with a thin
        // buffered runway, folded over ALL required sources (max ETA). No
        // separate floor was added. Since the tile-loading audit (G3-4a) it
        // needs the head's own data FIRST: with nothing resident the gate
        // holds however fast the link reads — HAVE_ENOUGH_DATA implies
        // HAVE_CURRENT_DATA. (This test pinned the empty-buffer pass before.)
        const a = makeTrackedSource();
        const b = makeTrackedSource();
        a.state.runwaySimMs = 0; // empty buffer…
        b.state.runwaySimMs = 0;
        a.state.etaMs = 10; // …though both predicted to download near-instantly
        b.state.etaMs = 10;
        const g = makeGovernor({ startGateWallMs: 2000 });
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });

        g.requestPlay();
        expect(g.state).toBe('starting'); // empty: the predictor may not release
        expect(tc.isPlaying()).toBe(false);
        // One probe interval of runway under the head (200 ms × 10 — the
        // floor for a source that declares no bucket) and the same ETAs start
        // it immediately, no degraded escape hatch.
        a.state.runwaySimMs = 2000;
        b.state.runwaySimMs = 2000;
        g.notifyBufferChange(runway(2000));
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

  describe('run-ahead fairness + dynamic weights (Phase 2 — §5–6)', () => {
    /**
     * Mock source carrying the two Phase 2 hooks
     * (setPrefetchRunAheadLimit/setBandwidthWeight), each recorded per call
     * so cap/weight traffic — and the write THROTTLE — are observable.
     */
    function makeFairSource() {
      const state = {
        runwaySimMs: 0,
        complete: false,
        bytesPending: 0,
        etaMs: null as number | null,
        capCalls: [] as Array<number | null>,
        weightCalls: [] as number[],
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
          return [];
        },
        estimateCost() {
          return { bytes: 0, tiles: 0 };
        },
        estimateTimeToReadyMs() {
          return state.etaMs;
        },
        flushPrefetch() {},
        setPrefetchRunAheadLimit(simMs) {
          state.capCalls.push(simMs);
        },
        setBandwidthWeight(weight) {
          state.weightCalls.push(weight);
        },
      };
      return { source, state };
    }

    // Defaults throughout: speed 10, runwayToleranceMs 200 → slack =
    // max(200, RUN_AHEAD_SLACK_WALL_MS 3000) × 10 = 30_000 sim-ms.

    it('caps the leader at laggard + slack, frees the laggard, and fills weights by byte need', () => {
      const leader = makeFairSource();
      const laggard = makeFairSource();
      leader.state.runwaySimMs = 200_000;
      laggard.state.runwaySimMs = 50_000; // above the 20_000 gate → plays
      const g = makeGovernor();
      g.addSource('leader', leader.source, { required: true });
      g.addSource('laggard', laggard.source, { required: true });

      g.requestPlay();
      expect(g.state).toBe('playing');
      // cap = laggard 50_000 + slack 30_000; the laggard itself runs free.
      // (Unchanged by BH-3 — the cap lever is verbatim.)
      expect(leader.state.capCalls).toEqual([80_000]);
      expect(laggard.state.capCalls).toEqual([null]);
      // WEIGHTS (BH-3 progressive filling, replacing the 1/x shed — whose
      // 80_000/230_000 answer for this exact vector is still pinned, on the
      // named fallback, in the `legacyRunwayShedWeight` unit test below):
      // fill target = lead 200_000 − slack 30_000 = 170_000. These mocks have
      // no byte channel (estimateCost → 0 bytes) so β = 1 for both.
      //   N_leader  = max(0, 170_000 − 200_000) = 0        → floor 0.25 × base
      //   N_laggard = 170_000 − 50_000 = 120_000 (the max)  → 4 × base
      expect(leader.state.weightCalls).toEqual([0.25]);
      expect(laggard.state.weightCalls).toEqual([4]);
    });

    it('an OPTIONAL source ahead of the required laggard is capped but still never gates the clock', () => {
      const required = makeFairSource();
      const overlay = makeFairSource();
      required.state.runwaySimMs = 50_000; // the laggard — and the only gate
      overlay.state.runwaySimMs = 200_000; // optional, far ahead: dead weight
      const g = makeGovernor();
      g.addSource('field', required.source, { required: true });
      g.addSource('overlay', overlay.source, { required: false });

      g.requestPlay();
      expect(g.state).toBe('playing'); // required ≥ gate; the overlay never gated
      // The overlay is capped at the required laggard's frontier + slack…
      expect(overlay.state.capCalls).toEqual([80_000]);
      expect(required.state.capCalls).toEqual([null]);
      // …but its weight stays base (optional sources never shed).
      expect(overlay.state.weightCalls).toEqual([]);

      // required:false semantics unchanged: the overlay draining to zero
      // never stalls the clock (a capped source behind the laggard is also
      // unaffected — the cap only limits run-AHEAD).
      overlay.state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
    });

    it('throttles writes: unchanged runways re-send nothing; >20% cap moves re-send', () => {
      const leader = makeFairSource();
      const laggard = makeFairSource();
      leader.state.runwaySimMs = 200_000;
      laggard.state.runwaySimMs = 50_000;
      const g = makeGovernor();
      g.addSource('leader', leader.source, { required: true });
      g.addSource('laggard', laggard.source, { required: true });
      g.requestPlay();
      expect(leader.state.capCalls).toEqual([80_000]);
      expect(leader.state.weightCalls).toHaveLength(1);

      // Identical runways probed again (buffer events while playing) → memo hit.
      // The fairness pass rides the frontier probe, and buffer events are
      // coalesced onto it at the 200 ms probe cadence (audit G6): step one
      // interval before each event so every event below is actually probed.
      vi.advanceTimersByTime(200);
      g.notifyBufferChange(runway(50_000));
      vi.advanceTimersByTime(200);
      g.notifyBufferChange(runway(50_000));
      expect(leader.state.capCalls).toEqual([80_000]);
      expect(laggard.state.capCalls).toEqual([null]); // null never re-broadcast
      expect(leader.state.weightCalls).toHaveLength(1);

      // A small laggard advance (cap 80_000 → 82_000, +2.5% ≤ 20%) is jitter.
      laggard.state.runwaySimMs = 52_000;
      vi.advanceTimersByTime(200);
      g.notifyBufferChange(runway(52_000));
      expect(leader.state.capCalls).toEqual([80_000]);

      // A real advance (cap → 120_000, +50% > 20%) re-sends.
      laggard.state.runwaySimMs = 90_000;
      vi.advanceTimersByTime(200);
      g.notifyBufferChange(runway(90_000));
      expect(leader.state.capCalls).toEqual([80_000, 120_000]);
    });

    it('multiSourceFairness: false disables both hooks entirely (kill switch)', () => {
      const leader = makeFairSource();
      const laggard = makeFairSource();
      leader.state.runwaySimMs = 200_000;
      laggard.state.runwaySimMs = 50_000;
      const g = makeGovernor({ multiSourceFairness: false });
      g.addSource('leader', leader.source, { required: true });
      g.addSource('laggard', laggard.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('playing'); // gating itself is untouched
      g.notifyBufferChange(runway(50_000));
      g.requestPause();
      expect(leader.state.capCalls).toEqual([]);
      expect(laggard.state.capCalls).toEqual([]);
      expect(leader.state.weightCalls).toEqual([]);
      expect(laggard.state.weightCalls).toEqual([]);
    });

    it('deactivation on pause clears leader caps to null and restores base weights', () => {
      const leader = makeFairSource();
      const laggard = makeFairSource();
      leader.state.runwaySimMs = 200_000;
      laggard.state.runwaySimMs = 50_000;
      const g = makeGovernor();
      g.addSource('leader', leader.source, { required: true });
      g.addSource('laggard', laggard.source, { required: true });
      g.requestPlay();
      expect(leader.state.capCalls).toEqual([80_000]);

      g.requestPause();
      // The leader's cap lifts and BOTH sources' base weights are restored:
      // under progressive filling the laggard is gained to 4 × base (it is the
      // one that has to buy bytes), so the one-shot restore has to walk it
      // back too — the cap side is unchanged (it was already free).
      expect(leader.state.capCalls).toEqual([80_000, null]);
      expect(leader.state.weightCalls.at(-1)).toBe(1);
      expect(laggard.state.capCalls).toEqual([null]);
      expect(laggard.state.weightCalls).toEqual([4, 1]);
    });

    it('removing the LAGGARD deactivates fairness — peers shed their stale caps', () => {
      const leader = makeFairSource();
      const laggard = makeFairSource();
      leader.state.runwaySimMs = 200_000;
      laggard.state.runwaySimMs = 50_000;
      const g = makeGovernor();
      g.addSource('leader', leader.source, { required: true });
      g.addSource('laggard', laggard.source, { required: true });
      g.requestPlay();
      expect(leader.state.capCalls).toEqual([80_000]);

      g.removeSource('laggard');
      // The cap pinned to the departed laggard's floor is lifted; with one
      // source left fairness stays down (no self-capping).
      expect(leader.state.capCalls).toEqual([80_000, null]);
      expect(leader.state.weightCalls.at(-1)).toBe(1);
    });

    it('applies on the GATED eval cadence too (leaders capped while a laggard buffers)', () => {
      const leader = makeFairSource();
      const laggard = makeFairSource();
      leader.state.runwaySimMs = 200_000;
      laggard.state.runwaySimMs = 0; // holds the start gate
      const g = makeGovernor();
      g.addSource('leader', leader.source, { required: true });
      g.addSource('laggard', laggard.source, { required: true });

      g.requestPlay();
      expect(g.state).toBe('starting');
      // The gate's own immediate evaluation already capped the leader at
      // laggard 0 + slack 30_000 — while frozen, the leader must not keep
      // extending runway the laggard's refill then competes with.
      expect(leader.state.capCalls).toEqual([30_000]);
      expect(laggard.state.capCalls).toEqual([null]);

      // The laggard refills past the gate on the next eval tick → playing,
      // and the cap tracks the new floor (50_000 + 30_000, a >20% move).
      laggard.state.runwaySimMs = 50_000;
      vi.advanceTimersByTime(250);
      expect(g.state).toBe('playing');
      expect(leader.state.capCalls).toEqual([30_000, 80_000]);
    });

    it('fairness never engages for a single source or an all-complete required set', () => {
      const solo = makeFairSource();
      solo.state.runwaySimMs = 200_000;
      const g = makeGovernor();
      g.addSource('solo', solo.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('playing');
      g.notifyBufferChange(runway(200_000));
      expect(solo.state.capCalls).toEqual([]); // <2 sources → never capped
      expect(solo.state.weightCalls).toEqual([]);

      // Second source, but every required source is COMPLETE → no laggard →
      // fairness stays down (nothing left to be fair about).
      const peer = makeFairSource();
      peer.state.runwaySimMs = 5;
      peer.state.complete = true;
      solo.state.complete = true;
      g.addSource('peer', peer.source, { required: true });
      g.notifyBufferChange(runway(5, true));
      expect(solo.state.capCalls).toEqual([]);
      expect(peer.state.capCalls).toEqual([]);
    });

    it('laggard identity has hysteresis: a near-tied peer stays co-laggard until it clears the EXIT band', () => {
      const a = makeFairSource();
      const b = makeFairSource();
      a.state.runwaySimMs = 50_000;
      b.state.runwaySimMs = 56_000; // within ENTER band (0.25 × 30_000 = 7_500)
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      g.requestPlay();
      // Both are co-laggards → both run free; neither is capped.
      expect(a.state.capCalls).toEqual([null]);
      expect(b.state.capCalls).toEqual([null]);

      // b creeps ahead but stays inside the EXIT band (0.5 × 30_000 =
      // 15_000): membership is sticky, no cap flap. (One probe interval per
      // event — buffer events are coalesced onto the frontier probe, G6.)
      b.state.runwaySimMs = 60_000;
      vi.advanceTimersByTime(200);
      g.notifyBufferChange(runway(50_000));
      expect(b.state.capCalls).toEqual([null]);

      // Clearing the EXIT band finally reclassifies b as a leader.
      b.state.runwaySimMs = 70_000;
      vi.advanceTimersByTime(200);
      g.notifyBufferChange(runway(50_000));
      expect(b.state.capCalls).toEqual([null, 80_000]);
      expect(a.state.capCalls).toEqual([null]); // the true laggard never flapped
    });

    it('addSource replacing an id drops its throttle memos — the replacement is re-capped, not silently free', () => {
      const leader = makeFairSource();
      const laggard = makeFairSource();
      leader.state.runwaySimMs = 200_000;
      laggard.state.runwaySimMs = 50_000;
      const g = makeGovernor();
      g.addSource('leader', leader.source, { required: true });
      g.addSource('laggard', laggard.source, { required: true });
      g.requestPlay();
      expect(leader.state.capCalls).toEqual([80_000]);

      // Same id, NEW source object (a layer remount swapping its tileset).
      // Without the memo purge the write throttle would treat it as already
      // capped at 80_000 and re-weighted, and send it nothing.
      const replacement = makeFairSource();
      replacement.state.runwaySimMs = 200_000;
      g.addSource('leader', replacement.source, { required: true });
      vi.advanceTimersByTime(200); // next frontier probe (G6 coalescing)
      g.notifyBufferChange(runway(50_000));
      expect(replacement.state.capCalls).toEqual([80_000]);
      // Same fill as the first case: the replacement is the leader, its need
      // is already met, so it takes the 0.25 × base floor.
      expect(replacement.state.weightCalls).toEqual([0.25]);
    });

    it('an EXTERNAL pause (direct timeController.pause) lifts caps exactly like requestPause', () => {
      const leader = makeFairSource();
      const laggard = makeFairSource();
      leader.state.runwaySimMs = 200_000;
      laggard.state.runwaySimMs = 50_000;
      const g = makeGovernor();
      g.addSource('leader', leader.source, { required: true });
      g.addSource('laggard', laggard.source, { required: true });
      g.requestPlay();
      expect(leader.state.capCalls).toEqual([80_000]);

      // Every non-looping range-end clamp routes through this path; a parked
      // demo must not keep its loaders capped and de-weighted indefinitely.
      tc.pause();
      expect(g.state).toBe('idle');
      expect(leader.state.capCalls).toEqual([80_000, null]);
      expect(leader.state.weightCalls.at(-1)).toBe(1);
    });
  });

  /**
   * BH-3 — fair-share weights denominated in BYTES (§11.3).
   *
   * The incumbent `1/x` shed compared RUNWAYS while the constrained resource is
   * BYTES: two sources the same sim-distance behind the leader were handed the
   * same share even when one needed ten times the bytes to close the gap. The
   * progressive fill prices each deficit through the source's own byte density
   * β and hands out share proportional to that need, which equalizes
   * time-to-gate instead of sim-time runway.
   *
   * Everything AROUND the formula is verbatim and is re-asserted by the Phase 2
   * suite above: laggard identification, the enter/exit hysteresis bands, the
   * cap writes, the 20% weight deadband, and the one-shot restore.
   */
  describe('byte-aware fair-share weights (BH-3 — §11.3 progressive filling)', () => {
    const fillProbe = (
      id: string,
      runwaySimMs: number,
      betaBytesPerSimMs = 1,
      baseWeight = 1,
    ): ProgressiveFillProbe => ({
      id,
      runwaySimMs,
      betaBytesPerSimMs,
      baseWeight,
    });

    describe('computeProgressiveFillWeights (pure)', () => {
      it('with equal β reproduces the qualitative order of the incumbent shed (laggard ≥ leaders)', () => {
        const probes = [
          fillProbe('leader', 200_000),
          fillProbe('middle', 120_000),
          fillProbe('laggard', 50_000),
        ];
        const fill = computeProgressiveFillWeights(probes, 30_000);
        const shed = computeRunwayShedWeights(probes, 30_000);
        // Both policies order the same way — the fill is a re-pricing of the
        // shed, not a reversal of it.
        for (const [heavier, lighter] of [
          ['laggard', 'middle'],
          ['middle', 'leader'],
        ] as const) {
          expect(fill.get(heavier)!).toBeGreaterThan(fill.get(lighter)!);
          expect(shed.get(heavier)!).toBeGreaterThan(shed.get(lighter)!);
        }
        // Fill target = lead 200_000 − slack 30_000 = 170_000.
        //   N_laggard = 120_000 (max) → 4 × base
        //   N_middle  =  50_000       → 4 × 50/120 = 1.666… × base
        //   N_leader  =       0       → floor 0.25 × base
        expect(fill.get('laggard')).toBe(4);
        expect(fill.get('middle')).toBeCloseTo((4 * 50_000) / 120_000, 10);
        expect(fill.get('leader')).toBe(0.25);
      });

      it('a laggard whose bytes are 10× denser gets ~10× the share of an equal-runway peer', () => {
        // The whole point of β: same sim-distance behind, ten times the bytes
        // to buy, so ten times the byte-share — which the runway-only shed
        // cannot express (it hands both peers the identical weight).
        const probes = [
          fillProbe('leader', 200_000, 1),
          fillProbe('heavy', 50_000, 10),
          fillProbe('light', 50_000, 1),
        ];
        const fill = computeProgressiveFillWeights(probes, 0);
        expect(fill.get('heavy')! / fill.get('light')!).toBeCloseTo(10, 10);
        expect(fill.get('heavy')).toBe(4);
        expect(fill.get('light')).toBeCloseTo(0.4, 10);
        // The incumbent shed is blind to the difference — the regression this
        // item exists to fix.
        const shed = computeRunwayShedWeights(probes, 0);
        expect(shed.get('heavy')).toBe(shed.get('light'));
      });

      it('clamps bind at 0.25 / 4 × base, and the laggard is never shed below base', () => {
        // 'sliver' needs 1/100th of the laggard's bytes: its proportional share
        // (4 × 0.01 = 0.04) is below the floor, so the floor binds.
        const fill = computeProgressiveFillWeights(
          [
            fillProbe('laggard', 0, 1, 2), // base 2
            fillProbe('sliver', 99_000, 1, 2),
            fillProbe('leader', 100_000, 1, 2),
          ],
          0,
        );
        expect(fill.get('laggard')).toBe(2 * 4); // ceiling × base
        expect(fill.get('sliver')).toBe(2 * 0.25); // floor × base
        expect(fill.get('leader')).toBe(2 * 0.25);
        // The laggard is the one buying bytes: it is gained, never shed.
        expect(fill.get('laggard')!).toBeGreaterThanOrEqual(2);
      });

      it('degenerates to base weights — no shed at all — when there is nothing to redistribute', () => {
        // Empty vector: nothing to say.
        expect(computeProgressiveFillWeights([], 30_000).size).toBe(0);
        // One source: it IS the leader, so its need is zero.
        expect(
          computeProgressiveFillWeights([fillProbe('solo', 50_000, 1, 3)], 0),
        ).toEqual(new Map([['solo', 3]]));
        // Every source inside the slack band of the leader — the near-tie that
        // must not produce weight traffic.
        const nearTie = computeProgressiveFillWeights(
          [fillProbe('a', 50_000), fillProbe('b', 56_000)],
          30_000,
        );
        expect([...nearTie.values()]).toEqual([1, 1]);
        // A complete source leaking in (unbounded runway) is not a licence to
        // guess: fall back to base for everybody.
        const leaked = computeProgressiveFillWeights(
          [fillProbe('done', Infinity), fillProbe('real', 10)],
          0,
        );
        expect([...leaked.values()]).toEqual([1, 1]);
      });

      it('reads a bytes-blind β as 1 — the fill degrades to a runway-only shed, never to a guess', () => {
        const blind = computeProgressiveFillWeights(
          [fillProbe('leader', 200_000, 0), fillProbe('laggard', 50_000, -3)],
          30_000,
        );
        const unit = computeProgressiveFillWeights(
          [fillProbe('leader', 200_000, 1), fillProbe('laggard', 50_000, 1)],
          30_000,
        );
        expect(blind).toEqual(unit);
      });

      it('is deterministic and independent of probe order', () => {
        const probes = [
          fillProbe('a', 50_000, 2),
          fillProbe('b', 120_000, 1),
          fillProbe('c', 200_000, 7),
        ];
        const once = computeProgressiveFillWeights(probes, 30_000);
        const twice = computeProgressiveFillWeights(probes, 30_000);
        const shuffled = computeProgressiveFillWeights(
          [probes[2], probes[0], probes[1]],
          30_000,
        );
        expect(twice).toEqual(once);
        // Same weights, whatever order the registry happened to iterate in.
        for (const id of ['a', 'b', 'c']) {
          expect(shuffled.get(id)).toBe(once.get(id));
        }
      });

      it('keeps the incumbent 1/x shed available as the named one-release fallback', () => {
        // The exact answer the governor used to write for the canonical
        // leader-200k / laggard-50k / slack-30k vector, pinned here so the
        // rollback path stays measured rather than merely present.
        expect(legacyRunwayShedWeight(200_000, 50_000, 30_000)).toBeCloseTo(
          80_000 / 230_000,
          10,
        );
        expect(legacyRunwayShedWeight(50_000, 50_000, 30_000)).toBe(1);
        // Clamped both ways, exactly as before.
        expect(legacyRunwayShedWeight(1e12, 0, 1)).toBe(0.25);
        expect(legacyRunwayShedWeight(0, 1e12, 1)).toBe(4);
      });
    });

    describe('governor integration (scripted estimateCost)', () => {
      /**
       * Fairness mock with a scripted byte channel: `bytesPerCost` is what
       * `estimateCost` reports for any range, so β = bytesPerCost / Δ and the
       * RATIO between sources is what the fill actually consumes.
       */
      function makeByteSource(bytesPerCost: number) {
        const state = {
          runwaySimMs: 0,
          complete: false,
          bytesPerCost,
          costCalls: [] as Array<{ start: number; end: number }>,
          capCalls: [] as Array<number | null>,
          weightCalls: [] as number[],
        };
        const source: BufferSource = {
          getBufferedRunway(_time, _direction, horizonSimMs) {
            return {
              simMs: state.runwaySimMs,
              bytesPending: 0,
              horizonSimMs: horizonSimMs ?? state.runwaySimMs,
              complete: state.complete,
            };
          },
          getBufferedRanges() {
            return [];
          },
          estimateCost(range) {
            state.costCalls.push(range);
            return { bytes: state.bytesPerCost, tiles: 0 };
          },
          estimateTimeToReadyMs() {
            return null;
          },
          flushPrefetch() {},
          setPrefetchRunAheadLimit(simMs) {
            state.capCalls.push(simMs);
          },
          setBandwidthWeight(weight) {
            state.weightCalls.push(weight);
          },
        };
        return { source, state };
      }

      // Defaults throughout: speed 10, slack = max(200, 3000) × 10 = 30_000.

      it('routes 10× the share to the equal-runway source whose bytes are 10× denser', () => {
        const leader = makeByteSource(30_000);
        const heavy = makeByteSource(300_000); // β = 10 bytes / sim-ms
        const light = makeByteSource(30_000); // β = 1 byte / sim-ms
        leader.state.runwaySimMs = 200_000;
        heavy.state.runwaySimMs = 50_000;
        light.state.runwaySimMs = 50_000;
        const g = makeGovernor();
        g.addSource('leader', leader.source, { required: true });
        g.addSource('heavy', heavy.source, { required: true });
        g.addSource('light', light.source, { required: true });

        g.requestPlay();
        expect(g.state).toBe('playing');
        // β is measured over Δ = max(bucket, slack) = 30_000 sim-ms starting at
        // each source's OWN frontier (playhead 0 + its runway).
        expect(heavy.state.costCalls).toEqual([{ start: 50_000, end: 80_000 }]);
        expect(leader.state.costCalls).toEqual([
          { start: 200_000, end: 230_000 },
        ]);
        // Fill target 170_000: N_heavy = 10 × 120_000, N_light = 120_000.
        expect(heavy.state.weightCalls).toEqual([4]);
        expect(light.state.weightCalls).toEqual([0.4]);
        expect(leader.state.weightCalls).toEqual([0.25]);
        // The CAP lever is untouched by BH-3: both co-laggards run free, the
        // leader is pinned at laggard + slack.
        expect(heavy.state.capCalls).toEqual([null]);
        expect(light.state.capCalls).toEqual([null]);
        expect(leader.state.capCalls).toEqual([80_000]);
      });

      it('memoizes β per frontier bucket — one estimateCost per source per bucket, not per probe', () => {
        const leader = makeByteSource(30_000);
        const laggard = makeByteSource(300_000);
        leader.state.runwaySimMs = 200_000;
        laggard.state.runwaySimMs = 50_000;
        const g = makeGovernor();
        g.addSource('leader', leader.source, { required: true });
        g.addSource('laggard', laggard.source, { required: true });
        g.requestPlay();
        expect(laggard.state.costCalls).toHaveLength(1);

        // Three more probes inside the same 30_000 sim-ms frontier bucket: the
        // directory walk is not repeated (the BH-3 cost bound). One probe
        // interval per event — buffer events are coalesced onto the frontier
        // probe (G6), and this test is about what a PROBE costs.
        laggard.state.runwaySimMs = 51_000;
        vi.advanceTimersByTime(200);
        g.notifyBufferChange(runway(51_000));
        laggard.state.runwaySimMs = 52_000;
        vi.advanceTimersByTime(200);
        g.notifyBufferChange(runway(52_000));
        expect(laggard.state.costCalls).toHaveLength(1);

        // Crossing into the next bucket re-measures — the frontier moved
        // somewhere the old density no longer describes.
        laggard.state.runwaySimMs = 95_000;
        vi.advanceTimersByTime(200);
        g.notifyBufferChange(runway(95_000));
        expect(laggard.state.costCalls).toHaveLength(2);
      });

      it('respects the 20% weight deadband and never writes optional or complete sources', () => {
        const leader = makeByteSource(30_000);
        const mid = makeByteSource(30_000);
        const laggard = makeByteSource(30_000);
        const overlay = makeByteSource(30_000);
        leader.state.runwaySimMs = 200_000;
        mid.state.runwaySimMs = 110_000;
        laggard.state.runwaySimMs = 50_000;
        overlay.state.runwaySimMs = 50_000;
        const g = makeGovernor();
        g.addSource('leader', leader.source, { required: true });
        g.addSource('mid', mid.source, { required: true });
        g.addSource('laggard', laggard.source, { required: true });
        g.addSource('overlay', overlay.source, { required: false });

        g.requestPlay();
        // Fill target 170_000 → N = {leader 0, mid 60_000, laggard 120_000}.
        expect(mid.state.weightCalls).toEqual([2]);
        expect(laggard.state.weightCalls).toEqual([4]);
        // An OPTIONAL source never sheds and never gains, however far behind
        // it is — unchanged by BH-3.
        expect(overlay.state.weightCalls).toEqual([]);

        // mid drifts to a 2.1667 weight: +8.3% is inside the deadband, so the
        // scheduler hears nothing. (One probe interval per event — buffer
        // events are coalesced onto the frontier probe, G6.)
        mid.state.runwaySimMs = 105_000;
        vi.advanceTimersByTime(200);
        g.notifyBufferChange(runway(50_000));
        expect(mid.state.weightCalls).toEqual([2]);

        // A real move (weight → 3.667, +83%) re-sends.
        mid.state.runwaySimMs = 60_000;
        vi.advanceTimersByTime(200);
        g.notifyBufferChange(runway(50_000));
        expect(mid.state.weightCalls).toHaveLength(2);
        expect(mid.state.weightCalls[1]).toBeCloseTo(
          (4 * 110_000) / 120_000,
          6,
        );

        // Completing a source takes it out of the fill entirely: no further
        // weight traffic for it.
        const before = mid.state.weightCalls.length;
        mid.state.complete = true;
        vi.advanceTimersByTime(200);
        g.notifyBufferChange(runway(50_000));
        expect(mid.state.weightCalls).toHaveLength(before);
      });

      it('produces NO weight traffic at all on a near-tie (the fill deadbands inside the slack band)', () => {
        // The same near-tie the cap hysteresis protects: both sources inside
        // one slack of the leader, so neither has any byte need and neither is
        // written. Identity cannot flap when nothing is sent.
        const a = makeByteSource(30_000);
        const b = makeByteSource(300_000); // 10× denser, still no need
        a.state.runwaySimMs = 50_000;
        b.state.runwaySimMs = 56_000;
        const g = makeGovernor();
        g.addSource('a', a.source, { required: true });
        g.addSource('b', b.source, { required: true });
        g.requestPlay();
        expect(a.state.weightCalls).toEqual([]);
        expect(b.state.weightCalls).toEqual([]);

        b.state.runwaySimMs = 60_000;
        g.notifyBufferChange(runway(50_000));
        expect(a.state.weightCalls).toEqual([]);
        expect(b.state.weightCalls).toEqual([]);
      });

      it('is deterministic: identical probe sequences produce identical weight sequences', () => {
        const script = [200_000, 150_000, 90_000, 60_000];
        const run = (): number[][] => {
          const leader = makeByteSource(30_000);
          const laggard = makeByteSource(120_000);
          leader.state.runwaySimMs = 400_000;
          laggard.state.runwaySimMs = script[0];
          const g = new PlaybackGovernor(tc, {});
          g.addSource('leader', leader.source, { required: true });
          g.addSource('laggard', laggard.source, { required: true });
          g.requestPlay();
          for (const r of script.slice(1)) {
            laggard.state.runwaySimMs = r;
            g.notifyBufferChange(runway(r));
          }
          g.dispose();
          return [leader.state.weightCalls, laggard.state.weightCalls];
        };
        const first = run();
        tc.setTime(0);
        const second = run();
        expect(second).toEqual(first);
        // …and it actually exercised the fill (otherwise this pins nothing).
        expect(first[0].length + first[1].length).toBeGreaterThan(0);
      });
    });
  });

  /**
   * BH-4 — the cadence tolerance band derived PER SOURCE from declared
   * temporal buckets (§11.2), instead of one global wall-ms constant.
   *
   * `τ_i = max(Δ_i, Δ_leader) + 200 ms × |speed|`. The residue is the probe
   * staleness — and is exactly the incumbent default — so a derived band is
   * never narrower than today's, and a source that declares nothing lands back
   * on today's band bit-for-bit.
   */
  describe('per-source cadence tolerance τ (BH-4 — §11.2)', () => {
    /**
     * Mock source that may or may not declare a temporal bucket (sim-ms).
     *
     * HONOURS `horizonSimMs` the way the core tileset does (audit B7 / G2):
     * the probe horizon is floored at the declared bucket and the reported
     * runway is capped at that horizon. The previous mock echoed
     * `runwaySimMs` regardless of the horizon, which made every test below
     * that reasons about the watermark probe vacuous — the real tileset
     * never reports a watermark-probed leader past `max(watermark, Δ)`.
     *
     * Also TIME-AWARE like the coverage index: `runwaySimMs` is the
     * contiguous reach measured from time 0 (every test here parks the
     * clock there), and a probe at `t` reads `reach − t`. The B6 clamp
     * re-probes AT the cached frontier, where a time-blind echo would read
     * the whole runway again and push the frontier out by a second fold.
     */
    function makeCadenceSource(bucketMs: number | null) {
      const state = { runwaySimMs: 0, complete: false };
      const source: BufferSource = {
        getBufferedRunway(time, direction, horizonSimMs) {
          const horizon =
            horizonSimMs === undefined
              ? Infinity
              : Math.max(horizonSimMs, bucketMs ?? 0);
          const ahead =
            direction > 0 ? state.runwaySimMs - time : state.runwaySimMs + time;
          const simMs = Math.min(Math.max(0, ahead), horizon);
          return {
            simMs,
            bytesPending: 0,
            horizonSimMs: Number.isFinite(horizon) ? horizon : simMs,
            complete: state.complete,
          };
        },
        getBufferedRanges() {
          return [];
        },
        estimateCost() {
          return { bytes: 0, tiles: 0 };
        },
        estimateTimeToReadyMs() {
          return null;
        },
        flushPrefetch() {},
      };
      if (bucketMs !== null) {
        source.getTemporalBucketMs = () => bucketMs;
      }
      return { source, state };
    }

    const HOUR = 3_600_000;
    const MINUTE = 60_000;

    /**
     * Drive a two-source composite to the point where the fold decides, and
     * report whether the clock survived. `playing` means the band lifted the
     * lagging source to the leader; `buffering` means it did not.
     */
    function foldStalls(
      opts: {
        speed: number;
        leadSimMs: number;
        lagSimMs: number;
        leadBucketMs: number | null;
        lagBucketMs: number | null;
      } & Partial<ConstructorParameters<typeof PlaybackGovernor>[1]>,
    ): boolean {
      const { speed, leadSimMs, lagSimMs, leadBucketMs, lagBucketMs, ...rest } =
        opts;
      tc.pause();
      tc.setTime(0);
      tc.setSpeed(speed);
      const lead = makeCadenceSource(leadBucketMs);
      const lag = makeCadenceSource(lagBucketMs);
      // Start both comfortably past the gate, exactly as the Phase 1 cadence
      // tests do, so the composite is PLAYING before the runways are moved to
      // the vector under test.
      lead.state.runwaySimMs = 10_000_000;
      lag.state.runwaySimMs = 10_000_000;
      const g = makeGovernor({
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
        ...rest,
      });
      g.addSource('lead', lead.source, { required: true });
      g.addSource('lag', lag.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('playing');
      lead.state.runwaySimMs = leadSimMs;
      lag.state.runwaySimMs = lagSimMs;
      g.notifyBufferChange(runway(lagSimMs));
      const stalled = g.state === 'buffering';
      // One governor per vector: a live one left subscribed would fight the
      // next case for the shared clock.
      g.dispose();
      governor = null;
      return stalled;
    }

    it('B7: at the watermark a coarse laggard under the watermark stalls even against a healthy fine-bucket leader', () => {
      // Re-blessed (audit B7 / G2). This used to assert NO stall: "a ~1 h gap
      // to a minute-bucketed peer is pure quantization". But the watermark
      // probe caps the leader at max(600, Δ_L) = 60_000 — it is PINNED at the
      // probe horizon and says nothing about how far ahead it really is — so
      // the derived band τ = max(1 h, 1 min) + 200 cannot be measured against
      // it. The laggard's own 500 sim-ms is what gates: its next hour is not
      // resident and is needed in 0.5 wall-s; playing on would render the
      // hole (overlay pop). The band falls back to the wall default (200),
      // which the 59_500 gap clears → honest stall.
      expect(
        foldStalls({
          speed: 1,
          leadSimMs: 1_000_000,
          lagSimMs: 500, // below the 600 sim-ms watermark on a raw min
          leadBucketMs: MINUTE,
          lagBucketMs: HOUR,
        }),
      ).toBe(true);
    });

    it('B7: a starved required laggard trips the low watermark on a bucket-coarse composite (storm-4d shape)', () => {
      // The audit's verification vector: Δ = 300 s on both sources, speed 285
      // (one bucket ≈ 1.05 wall-s ≥ 0.4 s), watermark = 600 × 285 = 171_000
      // sim-ms. The watermark probe caps the leader at max(171_000, 300_000)
      // = 300_000; the unauthored band τ = 300_000 + 57_000 used to lift a
      // laggard at ZERO to the leader (gap 300_000 ≤ 357_000) → min 300_000 ≥
      // watermark → the clock played through the laggard's missing bucket.
      expect(
        foldStalls({
          speed: 285,
          leadSimMs: 10_000_000,
          lagSimMs: 0,
          leadBucketMs: 300_000,
          lagBucketMs: 300_000,
        }),
      ).toBe(true);
    });

    it('…and the SAME composite stalls under the incumbent constant too (the undeclared fold is untouched)', () => {
      // Nothing declared: band 200 sim-ms at speed 1. The watermark probe
      // caps the leader at 600, so the only gap the fold can see is
      // `600 − lag`; 300 is outside the band → raw min 300 < 600 → stall.
      // (A lag of 500 sits INSIDE the incumbent band and is lifted — that is
      // the documented Phase 1 sub-probe-interval absorption, unchanged.)
      expect(
        foldStalls({
          speed: 1,
          leadSimMs: 1_000_000,
          lagSimMs: 300,
          leadBucketMs: null,
          lagBucketMs: null,
        }),
      ).toBe(true);
      expect(
        foldStalls({
          speed: 1,
          leadSimMs: 1_000_000,
          lagSimMs: 500,
          leadBucketMs: null,
          lagBucketMs: null,
        }),
      ).toBe(false);
    });

    it('B7: does not mask a genuine laggard between two FINE-bucket sources (the over-absorb guard, now with a horizon-honouring mock)', () => {
      // Both at 1 min, speed 10: the watermark probe (6_000) is floored at the
      // bucket, so the leader reports min(100_000, 60_000) = 60_000 and the
      // gap is 59_000 — INSIDE the old τ = 60_000 + 200 × 10 = 62_000. The
      // horizon-blind mock this test used to run on echoed 100_000 (gap
      // 99_000 > τ), which is why it passed while the product masked the
      // laggard. The leader is pinned at the probe horizon, so the band falls
      // back to 2_000 and the 1_000 sim-ms laggard stalls.
      expect(
        foldStalls({
          speed: 10,
          leadSimMs: 100_000,
          lagSimMs: 1_000,
          leadBucketMs: MINUTE,
          lagBucketMs: MINUTE,
        }),
      ).toBe(true);
      // Re-blessed: the LEADER declaring an hourly cadence does not excuse a
      // minute-bucketed laggard with 100 wall-ms of runway — the leader's
      // coarseness says nothing about the laggard's starvation, and at the
      // watermark the leader is pinned at its probe cap anyway.
      expect(
        foldStalls({
          speed: 10,
          leadSimMs: 100_000,
          lagSimMs: 1_000,
          leadBucketMs: HOUR,
          lagBucketMs: MINUTE,
        }),
      ).toBe(true);
    });

    it('still absorbs coarse-bucket quantization where the leader is measurable: the frontier fold', () => {
      // The derived band's legitimate job survives on the frontier path,
      // where the probe has no requested horizon (the source's own generous
      // default) and the leader's runway is therefore real information:
      // a 1 h-bucketed laggard 999_500 sim-ms behind a minute-bucketed leader
      // is lifted to the leader (τ = 3_600_200), so the per-tick clamp does
      // not snap the playhead back to the coarse peer's frontier.
      tc.pause();
      tc.setTime(0);
      tc.setSpeed(1);
      const lead = makeCadenceSource(MINUTE);
      const lag = makeCadenceSource(HOUR);
      lead.state.runwaySimMs = 10_000_000;
      lag.state.runwaySimMs = 10_000_000;
      const g = makeGovernor({ startGateWallMs: 0, lowWatermarkWallMs: 0 });
      g.addSource('lead', lead.source, { required: true });
      g.addSource('lag', lag.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('playing');
      lead.state.runwaySimMs = 1_000_000;
      lag.state.runwaySimMs = 500;
      vi.advanceTimersByTime(200); // invalidate the throttled frontier probe
      tc.setTime(0);
      tc.setTime(900); // ≤ |speed| × 1 s past the laggard's own 500 frontier
      expect(tc.getTime()).toBe(900); // lifted to the leader — no snap
      expect(g.state).toBe('playing');
      g.dispose();
      governor = null;
    });

    it('treats a declared temporalBucketMs of 0 as UNDECLARED — the wall default, never τ = 0', () => {
      // An archive that never set temporalBucketMs reports 0. Falling to τ = 0
      // would re-introduce the raw-min false stall the band exists to prevent.
      // Default band at speed 10 = 2_000 sim-ms.
      expect(
        foldStalls({
          speed: 10,
          leadSimMs: 7_000,
          lagSimMs: 5_500, // gap 1_500 ≤ 2_000 → jitter, no stall
          leadBucketMs: 0,
          lagBucketMs: 0,
        }),
      ).toBe(false);
      expect(
        foldStalls({
          speed: 10,
          leadSimMs: 7_000,
          // The watermark probe caps the leader at 6_000, so the visible gap
          // is 2_500 > 2_000 → genuine, stalls. (4_000 would sit exactly ON
          // the band edge against the capped leader.)
          lagSimMs: 3_500,
          leadBucketMs: 0,
          lagBucketMs: 0,
        }),
      ).toBe(true);
    });

    it('an AUTHORED runwayToleranceMs still wins globally, including 0 → exact raw min', () => {
      // Authored 0 pins the raw min even though both sources declare hourly
      // buckets that would otherwise absorb the entire gap.
      expect(
        foldStalls({
          speed: 10,
          leadSimMs: 100_000,
          lagSimMs: 1_000,
          leadBucketMs: HOUR,
          lagBucketMs: HOUR,
          runwayToleranceMs: 0,
        }),
      ).toBe(true);
      // An authored (small) band likewise: 250 wall-ms → 2_500 sim-ms, which
      // the 99_000 gap clears.
      expect(
        foldStalls({
          speed: 10,
          leadSimMs: 100_000,
          lagSimMs: 1_000,
          leadBucketMs: HOUR,
          lagBucketMs: HOUR,
          runwayToleranceMs: 250,
        }),
      ).toBe(true);
      // …and a generous authored band absorbs it, cadences notwithstanding.
      expect(
        foldStalls({
          speed: 10,
          leadSimMs: 100_000,
          lagSimMs: 1_000,
          leadBucketMs: null,
          lagBucketMs: null,
          runwayToleranceMs: 20_000, // 200_000 sim-ms
        }),
      ).toBe(false);
    });

    /**
     * Read the FOLDED runway without a private accessor: park the clock past
     * every plausible frontier (inside the one-wall-second overrun bound the
     * per-tick clamp honours) and let the clamp snap it back. It snaps to
     * `playhead + fold`, and the playhead is re-zeroed first.
     */
    function readFoldedSimMs(probeSimMs: number): number {
      vi.advanceTimersByTime(200); // invalidate the throttled frontier probe
      tc.setTime(0);
      tc.setTime(probeSimMs);
      return tc.getTime();
    }

    it('honours the safety bound r̂ ≤ min r_i + max τ_i, deterministically, over randomized vectors', () => {
      // Deterministic pseudo-random vectors (mulberry32) — a property sweep
      // with no wall clock and no RNG in the product path.
      let seed = 0x9e3779b9;
      const rand = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const BUCKETS = [null, 0, 500, 3_000];
      const PROBE = 8_000; // above every reachable fold, inside the 10_000 clamp

      for (let trial = 0; trial < 40; trial++) {
        const specs = [0, 1, 2].map(() => ({
          bucketMs: BUCKETS[Math.floor(rand() * BUCKETS.length)],
          runwaySimMs: 1_000 + Math.floor(rand() * 5_000),
        }));
        tc.pause();
        tc.setTime(0);
        tc.setSpeed(10);
        const built = specs.map((s) => {
          const src = makeCadenceSource(s.bucketMs);
          src.state.runwaySimMs = s.runwaySimMs;
          return src;
        });
        const g = makeGovernor({
          startGateWallMs: 0,
          lowWatermarkWallMs: 0, // never stall: we are reading the fold, not gating
        });
        built.forEach((s, i) =>
          g.addSource(`s${i}`, s.source, { required: true }),
        );
        g.requestPlay();
        expect(g.state).toBe('playing');

        const folded = readFoldedSimMs(PROBE);
        const minRunway = Math.min(...specs.map((s) => s.runwaySimMs));
        // τ_i is at most (max declared bucket) + the probe residue 200 × 10.
        const declared = Math.max(...specs.map((s) => s.bucketMs ?? 0), 0);
        const maxTau = declared > 0 ? declared + 2_000 : 2_000;
        // One-sided robustness: the band may lift, but never past the safety
        // bound — and it never reports LESS than the honest min.
        expect(folded).toBeGreaterThanOrEqual(minRunway);
        expect(folded).toBeLessThanOrEqual(minRunway + maxTau);
        // Determinism: the same vector folds to the same number, repeatedly.
        expect(readFoldedSimMs(PROBE)).toBe(folded);
        g.dispose();
        governor = null;
      }
    });

    it('is NOT monotone in every r_i — a property of the lift structure itself, not of BH-4', () => {
      // Worth pinning because the plan asserts monotonicity: it does not hold,
      // and it did not hold BEFORE this item either. Any lift of the form
      // "raise a source to the leader when it is within a band" breaks it, so
      // the counterexample below uses a CONSTANT authored band and no declared
      // cadences at all — i.e. the incumbent fold, verbatim.
      tc.pause();
      tc.setTime(0);
      tc.setSpeed(10);
      const a = makeCadenceSource(null);
      const b = makeCadenceSource(null);
      a.state.runwaySimMs = 5_000;
      b.state.runwaySimMs = 5_000;
      const g = makeGovernor({
        startGateWallMs: 0,
        lowWatermarkWallMs: 0,
        runwayToleranceMs: 200, // authored: band 2_000 sim-ms at speed 10
      });
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      g.requestPlay();

      a.state.runwaySimMs = 1_000;
      b.state.runwaySimMs = 2_500; // gap 1_500 ≤ 2_000 → a is lifted to b
      expect(readFoldedSimMs(8_000)).toBe(2_500);

      // Raising b — strictly MORE data — pushes it out of a's band, so a is no
      // longer lifted and the fold falls back to a's honest runway.
      b.state.runwaySimMs = 4_000;
      expect(readFoldedSimMs(8_000)).toBe(1_000);
      // The safety bound still holds throughout; that is the invariant the
      // fold actually guarantees.
    });
  });

  /**
   * BH-7 (governor half) — pushing the LOOP WINDOW to every source.
   *
   * The tileset owns the loop-modular eviction arithmetic; the governor owns
   * knowing where the boundary is. Everything here is about the push: when it
   * happens, when it must NOT happen, and that a source without the optional
   * method is exactly as it was.
   */
  describe('loop window plumbing (BH-7 — §9.4)', () => {
    function makeLoopSource(withHook = true) {
      const state = {
        runwaySimMs: 500_000,
        complete: false,
        loopCalls: [] as Array<{ start: number; end: number } | null>,
      };
      const source: BufferSource = {
        getBufferedRunway(_time, _direction, horizonSimMs) {
          return {
            simMs: state.runwaySimMs,
            bytesPending: 0,
            horizonSimMs: horizonSimMs ?? state.runwaySimMs,
            complete: state.complete,
          };
        },
        getBufferedRanges() {
          return [];
        },
        estimateCost() {
          return { bytes: 0, tiles: 0 };
        },
        estimateTimeToReadyMs() {
          return null;
        },
        flushPrefetch() {},
      };
      if (withHook) {
        source.setLoopWindow = (range) => {
          state.loopCalls.push(range && { ...range });
        };
      }
      return { source, state };
    }

    it('pushes the looping range on source registration', () => {
      tc.setTimeRange({ start: 1_000, end: 9_000 });
      tc.setLoop(true);
      const a = makeLoopSource();
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      expect(a.state.loopCalls).toEqual([{ start: 1_000, end: 9_000 }]);
    });

    it('never touches setLoopWindow when the clock is not looping (zero regression)', () => {
      tc.setTimeRange({ start: 1_000, end: 9_000 }); // a range, but no loop
      const a = makeLoopSource();
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.requestPlay();
      g.notifyBufferChange(runway(500_000));
      g.seekTo(4_000);
      g.requestPause();
      expect(a.state.loopCalls).toEqual([]);
    });

    it('pushes on a loop-mode change and clears to null when looping stops', () => {
      tc.setTimeRange({ start: 0, end: 10_000 });
      const a = makeLoopSource();
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      expect(a.state.loopCalls).toEqual([]);

      // The clock announces neither setLoop nor setTimeRange, so the sync is
      // explicit (or picked up by the next evaluation).
      tc.setLoop(true);
      g.syncLoopWindows();
      expect(a.state.loopCalls).toEqual([{ start: 0, end: 10_000 }]);

      // Idempotent: the same window is not re-pushed, however many
      // evaluations run.
      g.syncLoopWindows();
      g.requestPlay();
      g.notifyBufferChange(runway(500_000));
      expect(a.state.loopCalls).toHaveLength(1);

      // A moved range is a new window.
      tc.setTimeRange({ start: 0, end: 20_000 });
      g.syncLoopWindows();
      expect(a.state.loopCalls).toEqual([
        { start: 0, end: 10_000 },
        { start: 0, end: 20_000 },
      ]);

      // Loop off → the boundary is gone; the source must stop rotating.
      tc.setLoop(false);
      g.syncLoopWindows();
      expect(a.state.loopCalls.at(-1)).toBeNull();
      g.syncLoopWindows();
      expect(a.state.loopCalls).toHaveLength(3); // and not re-cleared
    });

    it('pushes the range on a wrap — the strongest evidence the clock loops', () => {
      tc.setTimeRange({ start: 0, end: 10_000 });
      const a = makeLoopSource();
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('playing');
      // Loop enabled without announcement, then the clock wraps.
      tc.setLoop(true);
      a.state.loopCalls.length = 0;
      tc.setTime(12_000); // overshoot; emit the wrap the clock would emit
      (tc as unknown as { notifyWrapListeners(): void }).notifyWrapListeners();
      expect(a.state.loopCalls).toEqual([{ start: 0, end: 10_000 }]);
    });

    it('lifts the window from a departing source and from a swapped registry', () => {
      tc.setTimeRange({ start: 0, end: 10_000 });
      tc.setLoop(true);
      const a = makeLoopSource();
      const b = makeLoopSource();
      const g = makeGovernor();
      g.addSource('a', a.source, { required: true });
      g.addSource('b', b.source, { required: true });
      expect(a.state.loopCalls).toHaveLength(1);

      g.removeSource('a');
      expect(a.state.loopCalls.at(-1)).toBeNull();

      // setSource clears the registry: the outgoing source stands down, the
      // incoming one is told the window on the way in.
      const c = makeLoopSource();
      g.setSource(c.source);
      expect(b.state.loopCalls.at(-1)).toBeNull();
      expect(c.state.loopCalls).toEqual([{ start: 0, end: 10_000 }]);

      // Disposal likewise — loaders outlive the governor.
      g.dispose();
      expect(c.state.loopCalls.at(-1)).toBeNull();
    });

    it('degrades silently for a source without setLoopWindow (feature-detected)', () => {
      tc.setTimeRange({ start: 0, end: 10_000 });
      tc.setLoop(true);
      const legacy = makeLoopSource(false); // no hook at all
      const modern = makeLoopSource();
      const g = makeGovernor();
      expect(() => {
        g.addSource('legacy', legacy.source, { required: true });
        g.addSource('modern', modern.source, { required: true });
        g.requestPlay();
        g.notifyBufferChange(runway(500_000));
        g.removeSource('legacy');
      }).not.toThrow();
      // The source that CAN hear it still does — one source's gap does not
      // suppress the push for the rest.
      expect(modern.state.loopCalls).toEqual([{ start: 0, end: 10_000 }]);
      expect(g.state).toBe('playing');
    });
  });

  /**
   * P0-2 — ScrubQoeStats, accumulated between the governor's own
   * `scrubstart`/`scrubend` events.
   *
   * These are the §11.6 measurements the scrub-LOD keep-vs-delete decision
   * hinges on. Everything here is OBSERVATION: the drag bracket's behaviour
   * (preview-never-gates, the restore-on-release invariant) is measured, never
   * altered — the assertions below re-check the incumbent behaviour alongside
   * the counters.
   */
  describe('scrub QoE counters (P0-2)', () => {
    interface ProbeBag {
      enabled?: boolean;
      scrub?: Array<Record<string, unknown>>;
      requests?: Array<Record<string, unknown>>;
      [k: string]: unknown;
    }
    const readBag = (): ProbeBag | undefined =>
      (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
    const setBag = (bag: ProbeBag | undefined): void => {
      if (bag === undefined) {
        delete (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
      } else {
        (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe = bag;
      }
    };
    afterEach(() => setBag(undefined));

    it('reads all-zero before the first drag (a harness may read it blind)', () => {
      const { source } = makeSource();
      const g = makeGovernor({ source });
      expect(g.getScrubQoeStats()).toEqual({
        timeToFirstPixelMs: null,
        freshFrameFraction: 0,
        bytesDuringScrub: 0,
        settleMs: null,
        tierSwitchCount: 0,
      });
    });

    it('counts a clean drag as exactly two tier switches (degrade + restore)', () => {
      const { source, state } = makeSource();
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(1000);
      g.endScrub(1000);
      expect(g.getScrubQoeStats().tierSwitchCount).toBe(2);
      // The incumbent broadcast is unchanged — the counter shadows it. (The
      // leading `false` is addSource's registration-time bit sync, which
      // predates the drag and is deliberately not counted.)
      expect(state.interactiveCalls).toEqual([false, true, false]);
    });

    it('counts an extra tier switch when a source joins mid-drag', () => {
      const { source } = makeSource();
      const g = makeGovernor({ source });
      g.beginScrub();
      const late = makeSource();
      g.addSource('late', late.source, { required: false });
      g.endScrub(0);
      // grab + join + release: three visible tier assertions in one drag.
      expect(g.getScrubQoeStats().tierSwitchCount).toBe(3);
      expect(late.state.interactiveCalls).toEqual([true, false]);
    });

    it('reports timeToFirstPixel 0 when the first preview lands on resident data', () => {
      const { source, state } = makeSource();
      state.ranges = [{ start: 0, end: 10_000 }];
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(5000);
      expect(g.getScrubQoeStats().timeToFirstPixelMs).toBe(0);
      expect(g.getScrubQoeStats().freshFrameFraction).toBe(1);
    });

    it('measures timeToFirstPixel when data lands under a resting thumb', () => {
      const { source, state } = makeSource();
      state.ranges = [];
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(5000);
      expect(g.getScrubQoeStats().timeToFirstPixelMs).toBeNull();

      // The thumb rests; no further scrubTo will land. Only arriving data can
      // close the span — that is why notifyBufferChange re-probes coverage.
      vi.advanceTimersByTime(500);
      state.ranges = [{ start: 4000, end: 6000 }];
      g.notifyBufferChange(runway(2000));
      expect(g.getScrubQoeStats().timeToFirstPixelMs).toBe(500);
    });

    it('leaves timeToFirstPixel null when the drag never reaches coverage', () => {
      const { source, state } = makeSource();
      state.ranges = [{ start: 0, end: 100 }];
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(50_000);
      vi.advanceTimersByTime(400);
      g.scrubTo(60_000);
      g.endScrub(60_000);
      const stats = g.getScrubQoeStats();
      expect(stats.timeToFirstPixelMs).toBeNull();
      expect(stats.freshFrameFraction).toBe(0);
    });

    it('reports the fraction of preview positions showing current-instant data', () => {
      const { source, state } = makeSource();
      state.ranges = [{ start: 0, end: 1000 }];
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(500); // fresh
      g.scrubTo(5000); // not resident
      g.scrubTo(900); // fresh
      g.endScrub(900);
      expect(g.getScrubQoeStats().freshFrameFraction).toBeCloseTo(2 / 3, 10);
    });

    it('settles at 0 when the release does not gate (full detail was resident)', () => {
      const { source, state } = makeSource();
      state.ranges = [{ start: 0, end: 10_000 }];
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(2000);
      g.endScrub(2000); // intent is not "playing" → no post-seek gate
      expect(g.state).toBe('idle');
      expect(g.getScrubQoeStats().settleMs).toBe(0);
    });

    it('measures settle-to-full-detail across the post-release gate', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 1_000_000;
      const g = makeGovernor({ source, startGateWallMs: 2000 });
      g.requestPlay();
      expect(g.state).toBe('playing');

      g.beginScrub();
      g.scrubTo(50_000);
      // Release onto a position with no runway: the commit gates on the FINE
      // tier (the preview-only contract), which is what settleMs measures.
      state.runwaySimMs = 0;
      g.endScrub(50_000);
      expect(g.state).toBe('seeking');
      // Still pending: reported as elapsed-so-far, like totalStallMs.
      vi.advanceTimersByTime(750);
      expect(g.getScrubQoeStats().settleMs).toBe(750);

      state.runwaySimMs = 1_000_000;
      g.notifyBufferChange(runway(1_000_000));
      expect(g.state).toBe('playing');
      expect(g.getScrubQoeStats().settleMs).toBe(750);

      // A LATER stall opens a new gate but must not reopen the closed span.
      vi.advanceTimersByTime(1000);
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      expect(g.getScrubQoeStats().settleMs).toBe(750);
    });

    it('windows bytesDuringScrub over the core `requests` channel', () => {
      setBag({ enabled: true });
      const { source } = makeSource();
      const g = makeGovernor({ source });

      // A request that completed BEFORE the drag opened.
      readBag()!.requests = [
        { key: 'pre', bytes: 1000, dispatchedAt: 1, completedAt: 5 },
      ];
      vi.advanceTimersByTime(100);
      g.beginScrub();
      const dragStart = performance.now();
      vi.advanceTimersByTime(50);
      readBag()!.requests!.push(
        // Inside the window — counted.
        {
          key: 'a',
          bytes: 700,
          dispatchedAt: dragStart + 10,
          completedAt: dragStart + 20,
        },
        {
          key: 'b',
          bytes: 300,
          dispatchedAt: dragStart + 15,
          completedAt: dragStart + 40,
        },
        // Superseded while queued: it moved no bytes, so it must not count.
        {
          key: 'cancelled',
          bytes: 999,
          dispatchedAt: 0,
          completedAt: dragStart + 25,
        },
      );
      expect(g.getScrubQoeStats().bytesDuringScrub).toBe(1000);
      g.endScrub(0);

      // The window closes at release: later traffic is not the drag's cost.
      readBag()!.requests!.push({
        key: 'after',
        bytes: 5000,
        dispatchedAt: performance.now() + 10,
        completedAt: performance.now() + 20,
      });
      expect(g.getScrubQoeStats().bytesDuringScrub).toBe(1000);
    });

    it('reports 0 bytes (never throws) with no probe, or malformed samples', () => {
      const { source } = makeSource();
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(10);
      expect(g.getScrubQoeStats().bytesDuringScrub).toBe(0);
      g.endScrub(10);

      setBag({
        enabled: true,
        requests: [null, 'nope', { bytes: 'x' }] as never,
      });
      g.beginScrub();
      expect(() => g.getScrubQoeStats()).not.toThrow();
      expect(g.getScrubQoeStats().bytesDuringScrub).toBe(0);
      g.endScrub(10);
    });

    it('publishes the bracket on the telemetry `scrub` channel', () => {
      setBag({ enabled: true });
      const { source, state } = makeSource();
      state.ranges = [{ start: 0, end: 10_000 }];
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(3000);
      vi.advanceTimersByTime(30);
      g.endScrub(3000);

      const samples = readBag()!.scrub!;
      expect(samples).toHaveLength(2);
      expect(samples[0].event).toBe('scrubstart');
      const end = samples[1];
      expect(end.event).toBe('scrubend');
      // The window is what P0-5 slices the `requests` channel with.
      expect(end.startedAtWall).toBe(samples[0].startedAtWall);
      expect(end.endedAtWall as number).toBeGreaterThan(
        end.startedAtWall as number,
      );
      // …carrying the five ScrubQoeStats fields inline.
      expect(end.tierSwitchCount).toBe(2);
      expect(end.freshFrameFraction).toBe(1);
      expect(end.timeToFirstPixelMs).toBe(0);
      expect(end.settleMs).toBe(0);
      expect(end.bytesDuringScrub).toBe(0);
    });

    it('emits nothing on the `scrub` channel when the probe is off', () => {
      const { source } = makeSource();
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(1);
      g.endScrub(1);
      expect(readBag()).toBeUndefined();
      // The counters still accumulate — they are plain fields, not probe state.
      expect(g.getScrubQoeStats().tierSwitchCount).toBe(2);
    });

    it('windows per drag: a second grab starts a fresh bracket', () => {
      const { source, state } = makeSource();
      state.ranges = [{ start: 0, end: 10_000 }];
      const g = makeGovernor({ source });

      g.beginScrub();
      g.scrubTo(100);
      g.scrubTo(200);
      g.endScrub(200);
      expect(g.getScrubQoeStats().freshFrameFraction).toBe(1);
      expect(g.getScrubQoeStats().tierSwitchCount).toBe(2);

      state.ranges = [];
      g.beginScrub();
      g.scrubTo(90_000);
      const during = g.getScrubQoeStats();
      expect(during.freshFrameFraction).toBe(0); // not the previous drag's 1
      expect(during.tierSwitchCount).toBe(1); // grab only; release pending
      expect(during.settleMs).toBeNull();
    });

    it('treats a re-grab of a held thumb as the SAME bracket (idempotent)', () => {
      const { source, state } = makeSource();
      state.ranges = [{ start: 0, end: 10_000 }];
      const g = makeGovernor({ source });
      g.beginScrub();
      g.scrubTo(100);
      g.beginScrub(); // no-op: already dragging
      g.scrubTo(200);
      g.endScrub(200);
      expect(g.getScrubQoeStats().tierSwitchCount).toBe(2);
      expect(state.interactiveCalls).toEqual([false, true, false]);
    });

    it('ignores previews issued outside a drag', () => {
      const { source, state } = makeSource();
      state.ranges = [{ start: 0, end: 10_000 }];
      const g = makeGovernor({ source });
      g.scrubTo(500); // no bracket open
      expect(g.getScrubQoeStats().tierSwitchCount).toBe(0);
      expect(g.getScrubQoeStats().freshFrameFraction).toBe(0);
    });
  });

  /**
   * The `playback.state` snapshot: the governor half of the trace-recorder
   * contract.
   *
   * `tools/bench/src/policy-record.mjs` reads
   * `snapshots['tileset.viewport'] ?? snapshots['playback.state']` and refuses
   * to write a trace when NEITHER exists. This is the fallback (temporal-only —
   * the governor has no camera), and it is also where `frame-cost.mjs` reads
   * the O1 stallCount / totalStallMs acceptance cells from: the `playback`
   * CHANNEL only emits on transitions, so a measurement window containing none
   * would otherwise report "no data" for a run that simply never stalled.
   */
  describe('playback.state snapshot (trace contract + QoE readout)', () => {
    interface ProbeBag {
      enabled?: boolean;
      playback?: Array<Record<string, unknown>>;
      scrub?: Array<Record<string, unknown>>;
      snapshots?: Record<string, Record<string, unknown>>;
      [k: string]: unknown;
    }
    const readBag = (): ProbeBag | undefined =>
      (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
    const setBag = (bag: ProbeBag | undefined): void => {
      if (bag === undefined) {
        delete (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
      } else {
        (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe = bag;
      }
    };
    const readState = (): Record<string, unknown> | undefined =>
      readBag()?.snapshots?.['playback.state'];
    afterEach(() => setBag(undefined));

    it('GUARD: probe off ⇒ a full play/stall cycle never creates the bag', () => {
      expect(readBag()).toBeUndefined();
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      // Not merely "no snapshot" — nothing was allocated at all. getQoeStats()
      // builds an object per call, so the gate has to be BEFORE the payload.
      expect(readBag()).toBeUndefined();
    });

    it('GUARD: enabled:false ⇒ no snapshots object is created', () => {
      setBag({ enabled: false });
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      g.notifyBufferChange(runway(100_000));
      expect(readBag()!.snapshots).toBeUndefined();
      expect(Object.keys(readBag()!)).toEqual(['enabled']);
    });

    it('publishes the trajectory fields the recorder reads', () => {
      setBag({ enabled: true });
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      tc.setTime(4321);
      g.notifyBufferChange(runway(100_000));

      const snap = readState()!;
      expect(snap).toBeDefined();
      expect(snap.state).toBe('playing');
      expect(snap.playheadMs).toBe(4321);
      expect(snap.speed).toBe(10);
      expect(snap.direction).toBe(1);
      expect(snap.animating).toBe(true);
    });

    it('reports direction -1 for reverse playback', () => {
      setBag({ enabled: true });
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      tc.setSpeed(-10);
      g.notifyBufferChange(runway(100_000));
      expect(readState()!.direction).toBe(-1);
    });

    it('stays `animating` THROUGH a gate, where the clock is frozen', () => {
      setBag({ enabled: true });
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      expect(tc.isPlaying()).toBe(false); // clock IS frozen
      const snap = readState()!;
      // …but every source has just been re-asserted animating-at-speed, so a
      // replay that keyed eviction grace off clock motion would see a paused
      // session at the moment the loader is reaching hardest.
      expect(snap.animating).toBe(true);
      expect(snap.state).toBe('buffering');
    });

    it('goes quiet (animating false) once intent is paused', () => {
      setBag({ enabled: true });
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      g.requestPause();
      expect(readState()!.animating).toBe(false);
    });

    it('carries the QoE counters, matching getQoeStats() exactly', () => {
      setBag({ enabled: true });
      const { source, state } = makeSource();
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
        resumeFactor: 2,
      });
      g.requestPlay();
      vi.advanceTimersByTime(500);
      state.runwaySimMs = 100_000;
      g.notifyBufferChange(runway(100_000));
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0)); // one honest stall
      expect(g.state).toBe('buffering');
      vi.advanceTimersByTime(1000);
      state.runwaySimMs = 100_000;
      g.notifyBufferChange(runway(100_000));

      const snap = readState()!;
      const stats = g.getQoeStats();
      expect(snap.stallCount).toBe(1);
      expect(snap.stallCount).toBe(stats.stallCount);
      expect(snap.totalStallMs).toBe(stats.totalStallMs);
      expect(snap.startupMs).toBe(stats.startupMs);
      expect(snap.degradedResumeCount).toBe(stats.degradedResumeCount);
      expect(snap.creepMs).toBe(stats.creepMs);
      // G2: the audit's canonical names ride the same snapshot.
      expect(snap.stallMs).toBe(stats.totalStallMs);
      expect(snap.frontierSnapBacks).toBe(stats.frontierSnapBacks);
      expect(snap.seekCount).toBe(stats.seekCount);
      expect(snap.gateEntriesByReason).toEqual(stats.gateEntriesByReason);
      expect(snap.gateEntriesByReason).toEqual({
        starting: 1,
        buffering: 1,
        seeking: 0,
      });
    });

    it('republishes on the buffer pulse, with no state transition at all', () => {
      setBag({ enabled: true });
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      const transitions = readBag()!.playback!.length;

      tc.setTime(1000);
      g.notifyBufferChange(runway(100_000));
      expect(readState()!.playheadMs).toBe(1000);
      tc.setTime(2000);
      g.notifyBufferChange(runway(100_000));
      expect(readState()!.playheadMs).toBe(2000);
      // The state machine stayed silent throughout — this is the case a
      // channel-only reader misses.
      expect(g.state).toBe('playing');
      expect(readBag()!.playback!.length).toBe(transitions);
    });

    it('is a latest-value snapshot, not a ring (bounded memory)', () => {
      setBag({ enabled: true });
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      for (let i = 0; i < 5000; i++) {
        tc.setTime(i);
        g.notifyBufferChange(runway(100_000));
      }
      expect(Array.isArray(readBag()!.snapshots!['playback.state'])).toBe(
        false,
      );
      expect(readState()!.playheadMs).toBe(4999);
    });

    it('emits the scrub channel through the TYPED union (no cast)', () => {
      setBag({ enabled: true });
      const { source } = makeSource();
      const g = makeGovernor({ source });
      g.beginScrub();
      g.endScrub(0);
      // `scrub` used to reach the bag through an `as unknown as` cast at the
      // call site because the channel union did not name it. Same bag, same
      // ring — now type-checked.
      const samples = readBag()!.scrub!;
      expect(samples.map((s) => s.event)).toEqual(['scrubstart', 'scrubend']);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M5 / CO-3 — fluid feasibility + the jitter re-fit of the gate constants.
  // ──────────────────────────────────────────────────────────────────────────

  /** Bucket width the profile mocks below pretend the archive was built with. */
  const BUCKET_MS = 20_000;

  /**
   * Mock BufferSource that ALSO exposes the CO-1 byte-density profile, so the
   * governor's fluid feasibility check can be driven from a scripted density
   * curve. `buckets` is the whole dataset; the mock windows it to the queried
   * range with the same bucket-intersection rule the core tileset uses.
   */
  function makeProfileSource(
    buckets: Array<{ start: number; missing: number }> = [],
  ) {
    const state = {
      runwaySimMs: 0,
      complete: false,
      etaMs: null as number | null,
      costBytes: 0,
      costTiles: 0,
      buckets,
      /** false ⇒ the source returns `null` (blind byte channel / no index). */
      profileEnabled: true,
      profileCalls: [] as Array<{ start: number; end: number }>,
      /** Range-dependent cost — the density curve auto-speed prices. */
      costForRange: null as
        | ((range: { start: number; end: number }) => {
            bytes: number;
            tiles: number;
          })
        | null,
    };
    const source: BufferSource = {
      getBufferedRunway(_time, _direction, horizonSimMs) {
        return {
          simMs: state.runwaySimMs,
          bytesPending: 0,
          horizonSimMs: horizonSimMs ?? state.runwaySimMs,
          complete: state.complete,
        };
      },
      getBufferedRanges() {
        return [];
      },
      estimateCost(range) {
        return state.costForRange
          ? state.costForRange(range)
          : { bytes: state.costBytes, tiles: state.costTiles };
      },
      estimateTimeToReadyMs() {
        return state.etaMs;
      },
      flushPrefetch() {},
      getByteDensityProfile(range) {
        state.profileCalls.push(range);
        if (!state.profileEnabled) return null;
        const bucketStarts: number[] = [];
        const missingBytes: number[] = [];
        for (const b of state.buckets) {
          if (b.start > range.end) continue;
          if (b.start + BUCKET_MS < range.start) continue;
          bucketStarts.push(b.start);
          missingBytes.push(b.missing);
        }
        return { bucketStarts, missingBytes };
      },
    };
    return { source, state };
  }

  describe('fluid feasibility check (M5/CO-3)', () => {
    /**
     * The item's centrepiece: flat density for two windows, a wall in window
     * three. Playhead 0, speed 10, gate window 20_000 sim-ms.
     */
    const CLIFF = [
      { start: 0, missing: 1_000 },
      { start: 20_000, missing: 1_000 },
      { start: 40_000, missing: 5_000_000 },
    ];
    /** Runway 5_000 sim-ms at speed 10 = 500 wall-ms of budget. */
    const RUNWAY = 5_000;
    /** ≤ max(500, PLAYTHROUGH_MIN_WALL_MS) ⇒ today's predictor says "go". */
    const PASSING_ETA = 400;

    function armCliffSource() {
      const s = makeProfileSource(CLIFF);
      s.state.runwaySimMs = RUNWAY;
      s.state.etaMs = PASSING_ETA;
      return s;
    }

    it('the byte cliff: the one-window predictor passes, the fluid check refuses', () => {
      // (a) INCUMBENT path (kill switch pinned off): one ETA against the runway
      //     — the whole window folded into one number, so the wall two windows
      //     out is invisible. The gate opens.
      const incumbentSource = armCliffSource();
      const incumbent = makeGovernor({
        source: incumbentSource.source,
        startGateWallMs: 2000,
        fluidFeasibility: false,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      incumbent.requestPlay();
      expect(incumbent.state).toBe('playing');
      expect(incumbentSource.state.profileCalls).toHaveLength(0);
      incumbent.dispose();

      // (b) FLUID path, same source, same runway, same ETA: cumulative missing
      //     bytes through the cliff (5_002_000) exceed rate × deadline
      //     (100 × (500 + 3500) = 400_000), so the gate does NOT open.
      let rate = 100;
      const fluidSource = armCliffSource();
      const g = makeGovernor({
        source: fluidSource.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: rate, samples: 5, stdDev: 0 }),
      });
      g.requestPlay();
      expect(g.state).toBe('starting');
      expect(fluidSource.state.profileCalls.length).toBeGreaterThan(0);

      // …and it keeps refusing until the RATE covers the cliff. The cliff needs
      // ≥ 5_002_000 / 4000 = 1250.5 bytes/ms; 1200 is still short.
      rate = 1200;
      g.notifyBufferChange(runway(RUNWAY));
      expect(g.state).toBe('starting');

      rate = 2000;
      g.notifyBufferChange(runway(RUNWAY));
      expect(g.state).toBe('playing');
    });

    it('charges each bucket at its own deadline, not the window end (near bytes still pass)', () => {
      // The same total bytes as the cliff, but spread evenly across the three
      // buckets, fits every deadline — the fluid check is a schedule test, not
      // a sum test.
      const flat = makeProfileSource([
        { start: 0, missing: 20_000 },
        { start: 20_000, missing: 100_000 },
        { start: 40_000, missing: 200_000 },
      ]);
      flat.state.runwaySimMs = RUNWAY;
      flat.state.etaMs = null; // the incumbent path would REFUSE (blind ETA)
      const g = makeGovernor({
        source: flat.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      g.requestPlay();
      expect(g.state).toBe('playing');
    });

    it('any required source WITHOUT the profile routes to the incumbent path, unchanged', () => {
      // Mixed source sets degrade cleanly: the feature-detect fails fast and no
      // profile is even requested from the source that has one.
      const withProfile = armCliffSource();
      const withoutProfile = makeSource();
      withoutProfile.state.runwaySimMs = RUNWAY;
      withoutProfile.state.etaMs = PASSING_ETA;
      const g = makeGovernor({
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      g.addSource('profiled', withProfile.source, { required: true });
      g.addSource('legacy', withoutProfile.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('playing'); // incumbent verdict, cliff unseen
      expect(withProfile.state.profileCalls).toHaveLength(0);
    });

    it('a null profile (blind byte channel) routes to the incumbent path', () => {
      const s = armCliffSource();
      s.state.profileEnabled = false;
      const g = makeGovernor({
        source: s.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      g.requestPlay();
      expect(g.state).toBe('playing');
      expect(s.state.profileCalls.length).toBeGreaterThan(0); // it DID ask
    });

    it('a cold (or absent) throughput estimator routes to the incumbent path', () => {
      const cold = armCliffSource();
      const g1 = makeGovernor({
        source: cold.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: null, samples: 0 }),
      });
      g1.requestPlay();
      expect(g1.state).toBe('playing');
      g1.dispose();

      const unwired = armCliffSource();
      const g2 = makeGovernor({
        source: unwired.source,
        startGateWallMs: 2000,
      });
      g2.requestPlay();
      expect(g2.state).toBe('playing');
    });

    it('the complete-runway short-circuit is unchanged (no predictor runs at all)', () => {
      const s = armCliffSource();
      s.state.complete = true;
      const g = makeGovernor({
        source: s.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      g.requestPlay();
      expect(g.state).toBe('playing');
      expect(s.state.profileCalls).toHaveLength(0);
    });

    it('zero required sources never stall, cliff or no cliff', () => {
      const optional = makeProfileSource(CLIFF);
      optional.state.runwaySimMs = 0;
      const g = makeGovernor({
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      g.addSource('overlay', optional.source, { required: false });
      g.requestPlay();
      expect(g.state).toBe('playing');
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('playing');
    });

    it('spends the CONSERVATIVE rate: dispersion narrows what the cliff can absorb', () => {
      // Same point rate (2000) in both runs. With no dispersion it clears the
      // cliff; with stdDev 800 the z=1 lower bound is 1200 — under the 1250.5
      // the cliff needs — and the gate holds.
      const calm = armCliffSource();
      const g1 = makeGovernor({
        source: calm.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 2000, samples: 9, stdDev: 0 }),
      });
      g1.requestPlay();
      expect(g1.state).toBe('playing');
      g1.dispose();

      const jittery = armCliffSource();
      const g2 = makeGovernor({
        source: jittery.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 2000, samples: 9, stdDev: 800 }),
      });
      g2.requestPlay();
      expect(g2.state).toBe('starting');
      g2.dispose();

      // z = 0 pins the point estimate — the documented incumbent reading.
      const pinned = armCliffSource();
      const g3 = makeGovernor({
        source: pinned.source,
        startGateWallMs: 2000,
        conservativeRateZ: 0,
        getThroughput: () => ({ bytesPerMs: 2000, samples: 9, stdDev: 800 }),
      });
      g3.requestPlay();
      expect(g3.state).toBe('playing');
    });

    it('reads backwards playback from the bucket the playhead enters FIRST', () => {
      // Travelling backwards from 100_000: the near buckets are the HIGH ones,
      // and the cliff at 40_000 is the far one. Mirrors the forward case
      // exactly (same distances, same verdict).
      tc.destroy();
      tc = new TimeController({ initialTime: 100_000, speed: -10 });
      const s = makeProfileSource([
        { start: 40_000, missing: 5_000_000 },
        { start: 60_000, missing: 1_000 },
        { start: 80_000, missing: 1_000 },
      ]);
      s.state.runwaySimMs = RUNWAY;
      s.state.etaMs = PASSING_ETA;
      const g = makeGovernor({
        source: s.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      g.requestPlay();
      expect(g.state).toBe('starting');
      expect(s.state.profileCalls.at(-1)!.end).toBe(100_000); // window behind
    });

    it('merges boundaries ACROSS sources: two halves that each fit, together do not', () => {
      // 250_000 at the same deadline from each of two required sources. The
      // deadline's budget is 400_000 bytes, so either alone fits and the pair
      // does not — the composite is priced as one pipe, once.
      const half = () => {
        const s = makeProfileSource([{ start: 40_000, missing: 250_000 }]);
        s.state.runwaySimMs = RUNWAY;
        s.state.etaMs = null; // proves the FLUID path is the one answering
        return s;
      };
      const a = half();
      const solo = makeGovernor({
        source: a.source,
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      solo.requestPlay();
      expect(solo.state).toBe('playing');
      solo.dispose();

      const b = half();
      const c = half();
      const g = makeGovernor({
        startGateWallMs: 2000,
        getThroughput: () => ({ bytesPerMs: 100, samples: 5, stdDev: 0 }),
      });
      g.addSource('b', b.source, { required: true });
      g.addSource('c', c.source, { required: true });
      g.requestPlay();
      expect(g.state).toBe('starting');
    });

    it('is deterministic: the same scripted trace yields identical QoE counters', () => {
      function runTrace() {
        const s = armCliffSource();
        let rate = 100;
        const g = new PlaybackGovernor(tc, {
          source: s.source,
          startGateWallMs: 2000,
          getThroughput: () => ({ bytesPerMs: rate, samples: 5, stdDev: 0 }),
        });
        const seen: PlaybackGovernorState[] = [];
        g.on('statechange', (st) => seen.push(st));
        g.requestPlay();
        vi.advanceTimersByTime(300);
        rate = 2000;
        g.notifyBufferChange(runway(RUNWAY));
        vi.advanceTimersByTime(300);
        rate = 100;
        s.state.runwaySimMs = 0;
        g.notifyBufferChange(runway(0));
        const out = { seen, qoe: g.getQoeStats() };
        g.dispose();
        return out;
      }
      const first = runTrace();
      tc.pause();
      tc.setTime(0);
      const second = runTrace();
      expect(second.seen).toEqual(first.seen);
      expect(second.qoe.stallCount).toBe(first.qoe.stallCount);
      expect(second.qoe.totalStallMs).toBe(first.qoe.totalStallMs);
      expect(second.qoe.startupMs).toBe(first.qoe.startupMs);
    });
  });

  describe('gate SHAPE under the jitter re-fit (M5/CO-3 guard)', () => {
    // cv = stdDev / bytesPerMs = 1 ⇒ dispersionScale = clamp(1 + 2·1, 1, 3) = 3.
    const calm = () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 });
    const jittery = () => ({ bytesPerMs: 100, samples: 9, stdDev: 100 });

    it('scales the EFFECTIVE watermark only, and never up into the start gate', () => {
      const a = makeGovernor({ getThroughput: calm });
      expect(a.getThroughputDispersionCv()).toBe(0);
      expect(a.effectiveLowWatermarkWallMs).toBe(600); // configured default
      a.dispose();

      const b = makeGovernor({ getThroughput: jittery });
      expect(b.getThroughputDispersionCv()).toBe(1);
      // 600 × 3 = 1800, held under the 2000 start gate — the two thresholds
      // stay two thresholds.
      expect(b.effectiveLowWatermarkWallMs).toBe(1800);
      expect(b.effectiveLowWatermarkWallMs).toBeLessThan(2000);
      b.dispose();

      // The k knob is bounded and 0 pins the incumbent constant.
      const c = makeGovernor({ getThroughput: jittery, dispersionK: 0 });
      expect(c.effectiveLowWatermarkWallMs).toBe(600);
      c.dispose();

      // Ceiling binds even at absurd jitter (cv = 10 ⇒ scale clamps at 3).
      const d = makeGovernor({
        getThroughput: () => ({ bytesPerMs: 100, samples: 9, stdDev: 1000 }),
      });
      expect(d.effectiveLowWatermarkWallMs).toBe(1800);
    });

    it('leaves the START GATE untouched by dispersion', () => {
      // Gate = 2000 × 10 = 20_000 sim-ms, on a jittery link exactly as on a
      // calm one: only the watermark is re-fit.
      const { source, state } = makeSource();
      state.etaMs = null; // no predictor rescue
      state.runwaySimMs = 19_999;
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        getThroughput: jittery,
      });
      g.requestPlay();
      expect(g.state).toBe('starting');
      state.runwaySimMs = 20_000;
      g.notifyBufferChange(runway(20_000));
      expect(g.state).toBe('playing');
    });

    it('start gate, watermark and resumeFactor stay THREE distinct behaviours', () => {
      const { source, state } = makeSource();
      state.etaMs = null;
      state.runwaySimMs = 100_000;
      const g = makeGovernor({
        source,
        startGateWallMs: 2000, // gate      = 20_000 sim-ms
        lowWatermarkWallMs: 600, // watermark = 18_000 sim-ms at cv = 1
        resumeFactor: 2, // resume    = 40_000 sim-ms
        getThroughput: jittery,
      });
      g.requestPlay();
      expect(g.state).toBe('playing');

      // (1) 19_000 sits BETWEEN the effective watermark (18_000) and the start
      //     gate (20_000): playing continues. The re-fit did not collapse the
      //     two thresholds into one.
      state.runwaySimMs = 19_000;
      g.notifyBufferChange(runway(19_000));
      expect(g.state).toBe('playing');

      // (2) Under the effective watermark ⇒ stall.
      state.runwaySimMs = 17_999;
      g.notifyBufferChange(runway(17_999));
      expect(g.state).toBe('buffering');

      // (3) Resume is the THIRD behaviour: the plain start gate (20_000) is not
      //     enough — resumeFactor × gate is.
      state.runwaySimMs = 20_000;
      g.notifyBufferChange(runway(20_000));
      expect(g.state).toBe('buffering');
      state.runwaySimMs = 40_000;
      g.notifyBufferChange(runway(40_000));
      expect(g.state).toBe('playing');
    });

    /**
     * WATERMARK RE-FIT ONLY — read the scope before trusting the name.
     *
     * `makeSource()` deliberately does NOT expose `getByteDensityProfile`, so
     * the fluid check bails at its feature-detect and BOTH runs below take the
     * incumbent one-window predictor. What this pins is therefore exactly one
     * thing: the dispersion re-fit of the low watermark is INERT at cv ≈ 0.
     *
     * It does NOT pin the fluid check against the incumbent — a profile-less
     * source can't. That is the sibling block,
     * "calm-link parity WITH a byte-density profile", immediately below.
     */
    it('the watermark re-fit is inert at cv ≈ 0 (no profile ⇒ both runs are the incumbent path)', () => {
      // Guard the scope claim in the doc comment: the moment `makeSource()`
      // grows a byte-density profile this test silently changes meaning (it
      // would start comparing two FLUID runs). Fail loudly instead.
      expect(makeSource().source.getByteDensityProfile).toBeUndefined();

      /** One scripted runway trace; returns the state sequence it produced. */
      function trace(opts: ConstructorParameters<typeof PlaybackGovernor>[1]) {
        const { source, state } = makeSource();
        state.etaMs = null;
        state.runwaySimMs = 100_000;
        const g = new PlaybackGovernor(tc, { ...opts, source });
        const seen: PlaybackGovernorState[] = [];
        g.on('statechange', (s) => seen.push(s));
        g.requestPlay();
        for (const simMs of [50_000, 10_000, 7_000, 45_000, 5_000, 60_000]) {
          state.runwaySimMs = simMs;
          g.notifyBufferChange(runway(simMs));
        }
        const out = { seen, stalls: g.getQoeStats().stallCount };
        g.dispose();
        return out;
      }

      const today = trace({ startGateWallMs: 2000, lowWatermarkWallMs: 600 });
      const calmLink = trace({
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
        getThroughput: calm,
      });
      expect(calmLink.seen).toEqual(today.seen);
      expect(calmLink.stalls).toBe(today.stalls);

      // The pin is live, not vacuous: a jittery link stalls where the calm one
      // did not (10_000 and 7_000 sim-ms are above the 6_000 calm watermark and
      // below the 18_000 jittery one).
      const jitteryLink = trace({
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
        getThroughput: jittery,
      });
      expect(jitteryLink.stalls).toBeGreaterThan(today.stalls);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M5 / CO-3 — THE calm-link regression pin, on the DEFAULT-ON production
  // path: a source that DOES expose `getByteDensityProfile`.
  //
  // Sibling of "the watermark re-fit is inert at cv ≈ 0" above, which uses a
  // profile-less `makeSource()` and therefore compares two runs of the
  // INCUMBENT predictor. This block compares the FLUID check against the
  // incumbent on one identical trace, which is the section's central contract:
  // the new path must reproduce today's verdicts wherever today's verdicts
  // were right.
  // ──────────────────────────────────────────────────────────────────────────

  describe('calm-link parity WITH a byte-density profile (M5/CO-3 pin)', () => {
    /**
     * Calm, cliff-free, MONOTONE-DECREASING density covering the whole fluid
     * horizon: 60_000 wall-ms × speed 10 = 600_000 sim-ms ⇒ 31 buckets of
     * 20_000. 10_000 B in the nearest bucket easing to 4_000 in the farthest —
     * no step anywhere, max/min = 2.5.
     */
    const CALM = Array.from({ length: 31 }, (_, i) => ({
      start: i * BUCKET_MS,
      missing: 10_000 - 200 * i,
    }));

    /** Same curve with a wall dropped into the THIRD bucket (t = 40_000). */
    const WALLED = CALM.map((b, i) =>
      i === 2 ? { ...b, missing: 5_000_000 } : b,
    );

    /**
     * A SELF-CONSISTENT source: every channel the two predictors can ask is
     * derived from ONE bucket table through ONE intersection rule, and the ETA
     * is the honest `estimateCost(range).bytes / rate` a real tileset returns.
     * Without that the two predictors would be answering about different data
     * and any agreement between them would be an accident.
     */
    function makeCalmSource(
      buckets: Array<{ start: number; missing: number }>,
      readRate: () => number,
    ) {
      const state = {
        runwaySimMs: 0,
        complete: false,
        /** Ranges the FLUID path asked for — empty ⇒ it never ran. */
        profileRanges: [] as Array<{ start: number; end: number }>,
        /** Ranges the INCUMBENT path asked for. */
        etaRanges: [] as Array<{ start: number; end: number }>,
      };
      // The core tileset's rule, verbatim: a bucket counts when it overlaps the
      // query at all. Used by BOTH channels so they can never disagree.
      const hit = (range: { start: number; end: number }) =>
        buckets.filter(
          (b) => b.start <= range.end && b.start + BUCKET_MS >= range.start,
        );
      const bytesIn = (range: { start: number; end: number }) =>
        hit(range).reduce((n, b) => n + b.missing, 0);
      const source: BufferSource = {
        getBufferedRunway(_time, _direction, horizonSimMs) {
          return {
            simMs: state.runwaySimMs,
            bytesPending: 0,
            horizonSimMs: horizonSimMs ?? state.runwaySimMs,
            complete: state.complete,
          };
        },
        getBufferedRanges() {
          return [];
        },
        estimateCost(range) {
          return { bytes: bytesIn(range), tiles: hit(range).length };
        },
        estimateTimeToReadyMs(range) {
          state.etaRanges.push(range);
          return bytesIn(range) / readRate();
        },
        flushPrefetch() {},
        getByteDensityProfile(range) {
          state.profileRanges.push(range);
          const window = hit(range);
          return {
            bucketStarts: window.map((b) => b.start),
            missingBytes: window.map((b) => b.missing),
          };
        },
      };
      return { source, state };
    }

    /**
     * Playhead 0, speed 10 ⇒ start gate 20_000, watermark 6_000, resume gate
     * 40_000 sim-ms. Every step's rate sits well clear of BOTH predictors'
     * thresholds, so the scripted verdicts are the same on either path:
     *
     *   runway  rate   incumbent needs   fluid needs   verdict
     *   ------------------------------------------------------------------
     *    5_000     1   ≥  39.6 B/ms      ≥ 20.0        both refuse  (gate)
     *    5_000   200   ≥  39.6           ≥ 20.0        both pass    (gate)
     *   12_000   200   — above the watermark, no predictor runs
     *    4_000   200   ≥  25.0           ≥ 25.0        both rescue  (watermark)
     *    4_000     5   ≥  25.0           ≥ 25.0        both refuse  → stall
     *   20_000     5   ≥  14.7           ≥  9.9        both refuse  (resume)
     *   20_000   300   ≥  14.7           ≥  9.9        both pass    (resume)
     *    3_000     1   ≥  33.3           ≥ 33.3        both refuse  → stall
     *   40_000     1   — runway alone clears the resume gate
     */
    const SCRIPT: Array<{ runwaySimMs: number; rate: number }> = [
      { runwaySimMs: 5_000, rate: 200 },
      { runwaySimMs: 12_000, rate: 200 },
      { runwaySimMs: 4_000, rate: 200 },
      { runwaySimMs: 4_000, rate: 5 },
      { runwaySimMs: 20_000, rate: 5 },
      { runwaySimMs: 20_000, rate: 300 },
      { runwaySimMs: 3_000, rate: 1 },
      { runwaySimMs: 40_000, rate: 1 },
    ];

    function runScript(opts: {
      buckets: Array<{ start: number; missing: number }>;
      fluidFeasibility: boolean;
    }) {
      tc.pause();
      tc.setTime(0);
      let rate = 1; // the opening gate evaluation runs at this rate
      const { source, state } = makeCalmSource(opts.buckets, () => rate);
      const g = new PlaybackGovernor(tc, {
        source,
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
        resumeFactor: 2,
        fluidFeasibility: opts.fluidFeasibility,
        getThroughput: () => ({ bytesPerMs: rate, samples: 9, stdDev: 0 }),
      });
      const seen: PlaybackGovernorState[] = [];
      g.on('statechange', (s) => seen.push(s));
      state.runwaySimMs = 5_000;
      g.requestPlay();
      // Per-STEP states, not just the transition sequence. The order of
      // transitions alone is too coarse a pin: a predictor that opens the gate
      // one step late and stalls one step early emits the SAME sequence (an
      // early mutant of this test passed exactly that way).
      const perStep: PlaybackGovernorState[] = [g.state];
      for (const step of SCRIPT) {
        rate = step.rate;
        state.runwaySimMs = step.runwaySimMs;
        g.notifyBufferChange(runway(step.runwaySimMs));
        perStep.push(g.state);
      }
      const qoe = g.getQoeStats();
      const out = {
        seen,
        perStep,
        finalState: g.state,
        stalls: qoe.stallCount,
        totalStallMs: qoe.totalStallMs,
        startupMs: qoe.startupMs,
        profileRanges: state.profileRanges,
        etaRanges: state.etaRanges,
      };
      g.dispose();
      return out;
    }

    /** One gate evaluation at a fixed rate; returns the state it settled in. */
    function openingGate(opts: {
      buckets: Array<{ start: number; missing: number }>;
      fluidFeasibility: boolean;
      rate: number;
    }) {
      tc.pause();
      tc.setTime(0);
      const { source, state } = makeCalmSource(opts.buckets, () => opts.rate);
      const g = new PlaybackGovernor(tc, {
        source,
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
        resumeFactor: 2,
        fluidFeasibility: opts.fluidFeasibility,
        getThroughput: () => ({
          bytesPerMs: opts.rate,
          samples: 9,
          stdDev: 0,
        }),
      });
      state.runwaySimMs = 5_000; // 5_000 < the 20_000 gate ⇒ predictor decides
      g.requestPlay();
      const settled = g.state;
      g.dispose();
      return settled;
    }

    it('reproduces the incumbent gate/watermark transition sequence exactly', () => {
      const incumbent = runScript({
        buckets: CALM,
        fluidFeasibility: false,
      });
      const fluid = runScript({ buckets: CALM, fluidFeasibility: true });

      // The verdicts are pinned as LITERALS, step by step, not merely
      // cross-compared — so a change that moves BOTH paths the same way still
      // fails here, and so does a change that only shifts WHEN a transition
      // happens (which a bare transition sequence cannot see).
      expect(incumbent.perStep).toEqual([
        'starting', //  5_000 @   1 — gate held
        'playing', //   5_000 @ 200 — gate opened by the predictor
        'playing', //  12_000 @ 200 — clear of the watermark
        'playing', //   4_000 @ 200 — under it, predictor rescues
        'buffering', //  4_000 @   5 — rate collapses ⇒ stall 1
        'buffering', // 20_000 @   5 — half the resume gate, still too slow
        'playing', //  20_000 @ 300 — predictor clears the resume gate
        'buffering', //  3_000 @   1 — dry and slow ⇒ stall 2
        'playing', //  40_000 @   1 — runway alone clears the resume gate
      ]);
      expect(incumbent.seen).toEqual([
        'starting',
        'playing',
        'buffering',
        'playing',
        'buffering',
        'playing',
      ]);
      expect(incumbent.stalls).toBe(2);

      // …and the fluid path reproduces them, step for step.
      expect(fluid.perStep).toEqual(incumbent.perStep);
      expect(fluid.seen).toEqual(incumbent.seen);
      expect(fluid.finalState).toBe(incumbent.finalState);
      expect(fluid.stalls).toBe(incumbent.stalls);
      expect(fluid.totalStallMs).toBe(incumbent.totalStallMs);
      expect(fluid.startupMs).toBe(incumbent.startupMs);

      // The two runs really did take DIFFERENT code paths — this is the check
      // the profile-less sibling test cannot make, and its absence is what let
      // a dead pin look alive. The kill-switch run never asks for a profile;
      // the default run asks on every gate/watermark evaluation.
      expect(incumbent.profileRanges).toHaveLength(0);
      expect(incumbent.etaRanges.length).toBeGreaterThan(0);
      expect(fluid.profileRanges.length).toBeGreaterThan(0);

      // And it asked over the horizon the item specifies: 60_000 wall-ms ×
      // |speed| 10 = 600_000 sim-ms ahead of the playhead, NOT the gate window.
      expect(fluid.profileRanges[0]).toEqual({ start: 0, end: 600_000 });
      for (const range of fluid.profileRanges) {
        expect(range.end - range.start).toBe(600_000);
      }
    });

    it('never refuses where the incumbent passes, at any rate on this density', () => {
      // The residual, ONE-DIRECTIONAL difference. On a monotone non-increasing
      // density the fluid check is the LOOSER of the two at the start gate: the
      // incumbent charges the whole gate window against the runway's wall time
      // (19_800 B ⇒ ≥ 39.6 B/ms), while the fluid check gives the second bucket
      // its own later deadline and only needs ≥ 20 B/ms. So calm links can only
      // gain — no rate exists where the new path stalls and the old one did not.
      for (const rate of [1, 5, 12, 19, 20, 25, 30, 39, 40, 100, 300]) {
        const incumbent = openingGate({
          buckets: CALM,
          fluidFeasibility: false,
          rate,
        });
        const fluid = openingGate({
          buckets: CALM,
          fluidFeasibility: true,
          rate,
        });
        if (incumbent === 'playing') expect(fluid).toBe('playing');
      }

      // The sweep is not vacuous: the band between the two thresholds is real
      // and is entered by the rates above. 30 B/ms clears 20 and misses 39.6.
      expect(
        openingGate({ buckets: CALM, fluidFeasibility: false, rate: 30 }),
      ).toBe('starting');
      expect(
        openingGate({ buckets: CALM, fluidFeasibility: true, rate: 30 }),
      ).toBe('playing');
    });

    it('the same harness DIVERGES on a byte wall — the calm pin can fail', () => {
      // Anti-vacuity for the pin above. Identical source, identical trace step,
      // identical rate: only the density changes. At 200 B/ms the incumbent
      // sees 19_800 B in the gate window and opens; the fluid check sees
      // 5_019_800 B due 3_500 wall-ms out (needing ≥ 1_254.95 B/ms) and holds.
      // If the fluid verdict were NOT the one in force, this would read
      // 'playing' and the equality assertions above would be worthless.
      expect(
        openingGate({ buckets: WALLED, fluidFeasibility: false, rate: 200 }),
      ).toBe('playing');
      expect(
        openingGate({ buckets: WALLED, fluidFeasibility: true, rate: 200 }),
      ).toBe('starting');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M5 / CO-4 — auto-speed evaluates the full candidate ladder.
  // ──────────────────────────────────────────────────────────────────────────

  describe('getAutoSpeedSuggestion — ladder evaluation (M5/CO-4)', () => {
    /**
     * Build a range-priced source from a piecewise-constant density curve
     * (bytes per sim-ms). This is what the single-point path cannot see: a
     * faster candidate sweeps a LONGER window and meets a segment the current
     * speed's window never reaches.
     */
    function densitySource(
      segments: Array<{ until: number; bytesPerSimMs: number }>,
    ) {
      const cumulative = (t: number): number => {
        let acc = 0;
        let prev = 0;
        for (const seg of segments) {
          const hi = Math.min(t, seg.until);
          if (hi > prev) acc += (hi - prev) * seg.bytesPerSimMs;
          prev = seg.until;
          if (t <= seg.until) return acc;
        }
        const tail = segments[segments.length - 1];
        return acc + Math.max(0, t - tail.until) * tail.bytesPerSimMs;
      };
      const s = makeProfileSource();
      s.state.costForRange = (range) => {
        const bytes = cumulative(range.end) - cumulative(range.start);
        return { bytes, tiles: bytes > 0 ? Math.ceil(bytes / 1000) : 0 };
      };
      return s;
    }

    /** Flat 10 B/sim-ms, then a wall from 16_000 to 24_000, then flat again. */
    const SPIKE_CURVE = [
      { until: 16_000, bytesPerSimMs: 10 },
      { until: 24_000, bytesPerSimMs: 10_000 },
      { until: Infinity, bytesPerSimMs: 10 },
    ];

    it('holds below a density spike the CURRENT-speed horizon never reaches', () => {
      tc.setSpeed(1); // base 1× — candidate m ⇔ speed m
      const s = densitySource(SPIKE_CURVE);
      const throughput = () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 });

      // MYOPIC: one window at speed 1 = [0, 8_000] — 80_000 bytes at 10 B/sim-ms
      // → 100/10 × 0.7 = 7. Auto would snap to 7× and drive straight into the
      // 16_000–24_000 wall.
      const myopic = makeGovernor({
        source: s.source,
        getThroughput: throughput,
      });
      expect(myopic.getAutoSpeedSuggestion()).toBeCloseTo(7);
      expect(
        decideAutoSpeedMultiplier(
          1,
          myopic.getAutoSpeedSuggestion()!,
          'cadence',
        ),
      ).toBe(6);
      myopic.dispose();

      // LADDER: every candidate ≥ 3× sweeps into the wall and is refused; 2×
      // ([0, 16_000], still flat) is the largest feasible step.
      const g = makeGovernor({
        source: s.source,
        baseSpeed: 1,
        getThroughput: throughput,
      });
      const suggestion = g.getAutoSpeedSuggestion()!;
      expect(suggestion).toBe(2);
      expect(suggestion).toBeLessThan(7);
      // And the consumer's snap lands ON the feasible step, not past it.
      expect(decideAutoSpeedMultiplier(1, suggestion, 'cadence')).toBe(2);
    });

    it('pre-empts a storm-cell entry visible only inside the top candidate window', () => {
      tc.setSpeed(1);
      // Flat all the way to 60_000, wall beyond. Only the 8× and 10×
      // candidates' windows (64_000 / 80_000 sim-ms) reach it.
      const s = densitySource([
        { until: 60_000, bytesPerSimMs: 10 },
        { until: Infinity, bytesPerSimMs: 100_000 },
      ]);
      const g = makeGovernor({
        source: s.source,
        baseSpeed: 1,
        getThroughput: () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 }),
      });
      const suggestion = g.getAutoSpeedSuggestion()!;
      // 6× (48_000 sim-ms) is the largest candidate still clear of the cell.
      expect(suggestion).toBe(6);
    });

    it('returns Infinity when nothing is pending at the top candidate', () => {
      tc.setSpeed(1);
      const s = makeProfileSource();
      s.state.costBytes = 0;
      s.state.costTiles = 0;
      const g = makeGovernor({
        source: s.source,
        baseSpeed: 1,
        getThroughput: () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 }),
      });
      expect(g.getAutoSpeedSuggestion()).toBe(Infinity);
    });

    it('returns null when an evaluated candidate’s range is bytes-blind', () => {
      tc.setSpeed(1);
      const s = makeProfileSource();
      s.state.costTiles = 5; // tiles pending…
      s.state.costBytes = 0; // …sizes unknown ⇒ no honest demand
      const g = makeGovernor({
        source: s.source,
        baseSpeed: 1,
        getThroughput: () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 }),
      });
      expect(g.getAutoSpeedSuggestion()).toBeNull();
    });

    it('returns null when a candidate is ETA-blind and no throughput is wired', () => {
      tc.setSpeed(1);
      const s = makeProfileSource();
      s.state.costBytes = 1_000;
      s.state.costTiles = 10;
      s.state.etaMs = null;
      const g = makeGovernor({ source: s.source, baseSpeed: 1 });
      expect(g.getAutoSpeedSuggestion()).toBeNull();
    });

    it('keeps the multi-heavy contract: N equal sources ⇒ 1/N the speed', () => {
      tc.setSpeed(1);
      const throughput = () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 });
      const one = makeProfileSource();
      one.state.costBytes = 800_000;
      one.state.costTiles = 100;
      const g1 = makeGovernor({
        source: one.source,
        baseSpeed: 1,
        getThroughput: throughput,
      });
      const solo = g1.getAutoSpeedSuggestion()!;
      g1.dispose();

      const a = makeProfileSource();
      const b = makeProfileSource();
      for (const s of [a, b]) {
        s.state.costBytes = 800_000;
        s.state.costTiles = 100;
      }
      governor = new PlaybackGovernor(tc, {
        baseSpeed: 1,
        getThroughput: throughput,
      });
      governor.addSource('a', a.source, { required: true });
      governor.addSource('b', b.source, { required: true });
      expect(governor.getAutoSpeedSuggestion()!).toBeCloseTo(solo / 2);
    });

    it('feasibility is monotone down the ladder for non-decreasing densities', () => {
      tc.setSpeed(1);
      // A deterministic sweep of non-decreasing density curves: whatever the
      // ladder answers, every candidate at or below it must also be feasible.
      for (const step of [1, 3, 7, 25, 120]) {
        const s = densitySource([
          { until: 20_000, bytesPerSimMs: step },
          { until: 50_000, bytesPerSimMs: step * 4 },
          { until: Infinity, bytesPerSimMs: step * 16 },
        ]);
        const g = new PlaybackGovernor(tc, {
          source: s.source,
          baseSpeed: 1,
          getThroughput: () => ({ bytesPerMs: 5_000, samples: 9, stdDev: 0 }),
        });
        const answer = g.getAutoSpeedSuggestion()!;
        g.dispose();
        expect(answer).not.toBeNull();
        // Re-price every candidate at or below the answer with the same math
        // the governor uses; each must be sustainable at its own window.
        for (const m of SPEED_STEPS.filter((x) => x <= answer)) {
          const horizon = 8000 * m;
          const { bytes } = s.source.estimateCost({ start: 0, end: horizon });
          const sustainable = (5_000 / (bytes / horizon)) * 0.7;
          expect(sustainable).toBeGreaterThanOrEqual(m);
        }
      }
    });

    it('is deterministic across re-runs with a fixed estimator and curve', () => {
      tc.setSpeed(1);
      const throughput = () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 });
      const readings: number[][] = [];
      for (let run = 0; run < 2; run++) {
        const s = densitySource(SPIKE_CURVE);
        const g = new PlaybackGovernor(tc, {
          source: s.source,
          baseSpeed: 1,
          getThroughput: throughput,
        });
        const seq: number[] = [];
        for (const t of [0, 4_000, 12_000, 30_000]) {
          tc.setTime(t);
          seq.push(g.getAutoSpeedSuggestion()!);
        }
        g.dispose();
        readings.push(seq);
      }
      expect(readings[1]).toEqual(readings[0]);
    });

    it('without baseSpeed, the single-point computation is preserved bit-for-bit', () => {
      // The regression pin: no base speed ⇒ no candidates expressible ⇒ the
      // incumbent one-measurement path, unchanged.
      tc.setSpeed(1);
      const throughput = () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 });
      const a = densitySource(SPIKE_CURVE);
      const noBase = makeGovernor({
        source: a.source,
        getThroughput: throughput,
      });
      expect(noBase.getAutoSpeedSuggestion()).toBeCloseTo(7);
      noBase.dispose();

      // …and the explicit kill switch does the same with a base speed present.
      const b = densitySource(SPIKE_CURVE);
      const pinned = makeGovernor({
        source: b.source,
        baseSpeed: 1,
        ladderEvaluation: false,
        getThroughput: throughput,
      });
      expect(pinned.getAutoSpeedSuggestion()).toBeCloseTo(7);
    });

    it('reads a mutable base speed through the function form', () => {
      tc.setSpeed(1);
      let base: number | null = null;
      const s = densitySource(SPIKE_CURVE);
      const g = makeGovernor({
        source: s.source,
        baseSpeed: () => base,
        getThroughput: () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 }),
      });
      expect(g.getAutoSpeedSuggestion()).toBeCloseTo(7); // null base ⇒ incumbent
      base = 1;
      expect(g.getAutoSpeedSuggestion()).toBe(2); // ladder engages live
    });

    it('shrinks the safety factor as measured dispersion grows', () => {
      tc.setSpeed(1);
      const s = makeProfileSource();
      s.state.costBytes = 800_000; // 8_000 sim-ms window at speed 1 → 100 B/sim-ms
      s.state.costTiles = 100;
      const calm = makeGovernor({
        source: s.source,
        getThroughput: () => ({ bytesPerMs: 100, samples: 9, stdDev: 0 }),
      });
      const calmValue = calm.getAutoSpeedSuggestion()!;
      calm.dispose();

      // cv = 0.5 ⇒ scale = clamp(1 + 2·0.5, 1, 3) = 2 ⇒ η = 0.35.
      const jittery = makeGovernor({
        source: s.source,
        getThroughput: () => ({ bytesPerMs: 100, samples: 9, stdDev: 50 }),
      });
      expect(jittery.getAutoSpeedSuggestion()!).toBeCloseTo(calmValue / 2);
      jittery.dispose();

      // dispersionK: 0 pins the incumbent 0.7.
      const pinned = makeGovernor({
        source: s.source,
        dispersionK: 0,
        getThroughput: () => ({ bytesPerMs: 100, samples: 9, stdDev: 50 }),
      });
      expect(pinned.getAutoSpeedSuggestion()!).toBeCloseTo(calmValue);
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

  /**
   * Tile-loading audit 2026-08 (docs/roadmap/tile-loading-audit-2026-08.md
   * §2, governor side): B6 re-probe before clamp, B8 permanent blocks, G2
   * QoE counters, G6 probe coalescing, G8/CS-9 source-less hatch. B7 lives
   * in the BH-4 block above, next to the mock it repairs.
   */
  describe('tile-loading audit 2026-08 (B6 / B8 / G2 / G6 / G8)', () => {
    /**
     * A source whose runway is a function of the probe TIME, like the real
     * coverage index: contiguous data through `reach`, so a probe past the
     * reach reads zero. The horizon-blind `makeSource` cannot distinguish a
     * re-probe at the frontier from one at the overrun playhead; this can.
     */
    function makeReachSource(reachSimMs: number) {
      const state = { reach: reachSimMs, complete: false, probes: 0 };
      const source: BufferSource = {
        getBufferedRunway(time, direction, horizonSimMs) {
          state.probes++;
          const ahead = direction > 0 ? state.reach - time : time - state.reach;
          const simMs = Math.max(0, Math.min(ahead, horizonSimMs ?? Infinity));
          return {
            simMs,
            bytesPending: 0,
            horizonSimMs: horizonSimMs ?? simMs,
            complete: state.complete,
          };
        },
        getBufferedRanges() {
          return [];
        },
        estimateCost() {
          return { bytes: 0, tiles: 0 };
        },
        estimateTimeToReadyMs() {
          return null;
        },
        flushPrefetch() {},
      };
      return { source, state };
    }

    it('B6: a frontier that advanced between two probes neither gates nor snaps the clock back', () => {
      // The audit's G3 vector: play with 100_000 of runway; the bucket lands
      // 150 wall-ms later (inside the 200 ms probe interval, no buffer event);
      // the playhead crosses the CACHED frontier. Before: a spurious
      // one-frame stall + a backward snap of one frame × |speed|.
      const src = makeReachSource(100_000);
      const g = makeGovernor({ source: src.source });
      g.requestPlay();
      expect(g.state).toBe('playing'); // frontier probed at 0 → 100_000
      vi.advanceTimersByTime(150);
      src.state.reach = 200_000; // the bucket landed; nobody told the governor
      tc.setTime(100_400);
      expect(tc.getTime()).toBe(100_400); // no snap…
      expect(g.state).toBe('playing'); // …no gate
      expect(g.getQoeStats().stallCount).toBe(0);
      expect(g.getQoeStats().frontierSnapBacks).toBe(0);
    });

    it('B6: the re-probe is taken AT the cached frontier, so a confirmed frontier still snaps the clock back onto loaded data', () => {
      // A re-probe at the OVERRUN playhead would read runway 0 there and set
      // the frontier to the playhead itself — a stall in the void, the exact
      // thing the clamp exists to prevent. The probe must ask "did data land
      // past the frontier I know about?", i.e. probe at the frontier.
      const src = makeReachSource(100_000);
      const g = makeGovernor({ source: src.source });
      g.requestPlay();
      vi.advanceTimersByTime(150);
      tc.setTime(100_400);
      expect(tc.getTime()).toBe(100_000); // snapped to the TRUE frontier
      expect(g.state).toBe('buffering');
      expect(g.getQoeStats().frontierSnapBacks).toBe(1);
      expect(g.getQoeStats().gateEntriesByReason.buffering).toBe(1);
    });

    it('B6: creep pins on the cached frontier without counting a snap-back (pins are the design, not a defect)', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source, maxStartWaitMs: 4000 });
      g.requestPlay();
      state.runwaySimMs = 2000;
      vi.advanceTimersByTime(250);
      tc.setTime(3000);
      expect(g.state).toBe('buffering');
      vi.advanceTimersByTime(4000); // hatch → creep
      expect(g.isCreeping).toBe(true);
      const before = g.getQoeStats().frontierSnapBacks;
      tc.setTime(5600);
      expect(tc.getTime()).toBe(5000); // pinned
      expect(g.getQoeStats().frontierSnapBacks).toBe(before);
    });

    it('G6: notifyBufferChange coalesces frontier walks to one per probe interval per source', () => {
      // N = 5 required sources × 20 buffer events in 100 wall-ms. Each event
      // used to walk EVERY source's runway at the frontier horizon (100
      // probes); the bound is one walk per 200 ms interval per source, plus
      // the walk the interval boundary itself may trigger.
      const N = 5;
      const sources = Array.from({ length: N }, () => makeSource());
      for (const s of sources) s.state.runwaySimMs = 10_000_000;
      const g = makeGovernor({ startGateWallMs: 2000 });
      sources.forEach((s, i) =>
        g.addSource(`s${i}`, s.source, { required: true }),
      );
      g.requestPlay();
      expect(g.state).toBe('playing');
      for (const s of sources) s.state.runwayCalls.length = 0;

      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(5);
        g.notifyBufferChange(runway(10_000_000));
      }
      // Frontier walks probe at the source's DEFAULT horizon (undefined);
      // the watermark check's capped probes are the honest part and are not
      // bounded here.
      let frontierProbes = 0;
      for (const s of sources) {
        frontierProbes += s.state.runwayCalls.filter(
          (c) => c.horizonSimMs === undefined,
        ).length;
      }
      expect(frontierProbes).toBeLessThanOrEqual(N * Math.ceil(100 / 200) + N);
    });

    it('G6: coalescing never blinds the stall check — a drained runway on a coalesced event still gates', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      vi.advanceTimersByTime(50); // inside the probe interval
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
    });

    it('G8: addSource re-bases the hatch clock only when it fills an EMPTY registry', () => {
      // A second source registered into a live gate must not extend the
      // hatch: the first source's gate has been held since requestPlay.
      const a = makeSource();
      const b = makeSource();
      const g = makeGovernor({ maxStartWaitMs: 4000 });
      g.addSource('a', a.source, { required: true });
      g.requestPlay();
      vi.advanceTimersByTime(3000);
      g.addSource('b', b.source, { required: true });
      vi.advanceTimersByTime(1100);
      expect(g.state).toBe('playing'); // hatched 4 s after requestPlay
      expect(g.getQoeStats().degradedResumeCount).toBe(1);
    });

    it('G8: a legacy source without the buffering API still arms the hatch (the documented degrade)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const g = makeGovernor({ maxStartWaitMs: 1000 });
      g.requestPlay();
      vi.advanceTimersByTime(5000);
      expect(g.state).toBe('starting'); // nothing offered yet
      g.addSource('legacy', {} as unknown as BufferSource);
      vi.advanceTimersByTime(900);
      expect(g.state).toBe('starting'); // timed from the offer, not requestPlay
      vi.advanceTimersByTime(200);
      expect(g.state).toBe('playing');
      warn.mockRestore();
    });

    it('B8: a runway flagged blockedPermanently (complete:false) is treated as buffered for gating and counted once per flip', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 0;
      state.blockedPermanently = true; // the next tile 404s forever
      const g = makeGovernor({ source, startGateWallMs: 2000 });
      g.requestPlay();
      expect(g.state).toBe('playing'); // nothing will ever arrive — do not wait
      expect(tc.isPlaying()).toBe(true);
      expect(g.getQoeStats().blockedPermanentlyCount).toBe(1);
      // Edge-triggered: re-probing the same blocked runway is not a new event.
      g.notifyBufferChange(runway(0));
      vi.advanceTimersByTime(250);
      tc.setTime(2500);
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().blockedPermanentlyCount).toBe(1);
      // The block clears (a retry landed data) and the runway is honestly
      // thin → the watermark gates again; a later block is a second event.
      state.blockedPermanently = false;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      state.blockedPermanently = true;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().blockedPermanentlyCount).toBe(2);
    });

    it('B8: a blocked runway with complete:true is just complete — no double count', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 0;
      state.complete = true;
      state.blockedPermanently = true;
      const g = makeGovernor({ source });
      g.requestPlay();
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().blockedPermanentlyCount).toBe(0);
    });

    it('G2: every QoE counter increments on its own transition', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        lowWatermarkWallMs: 600,
        resumeFactor: 2,
      });
      expect(g.getQoeStats()).toMatchObject({
        stallCount: 0,
        stallMs: 0,
        totalStallMs: 0,
        startupMs: null,
        degradedResumeCount: 0,
        seekCount: 0,
        seekSettleMsP50: null,
        gateEntriesByReason: { starting: 0, buffering: 0, seeking: 0 },
        frontierSnapBacks: 0,
        blockedPermanentlyCount: 0,
      });

      g.requestPlay();
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().gateEntriesByReason.starting).toBe(1);

      // Three committed seeks with settle times 300 / 0 / 100 ms → p50 100.
      state.runwaySimMs = 0;
      g.seekTo(50_000);
      expect(g.state).toBe('seeking');
      expect(g.getQoeStats().seekCount).toBe(1);
      expect(g.getQoeStats().gateEntriesByReason.seeking).toBe(1);
      expect(g.getQoeStats().seekSettleMsP50).toBeNull(); // nothing settled yet
      vi.advanceTimersByTime(300);
      state.runwaySimMs = 100_000;
      g.notifyBufferChange(runway(100_000));
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().seekSettleMsP50).toBe(300);
      g.seekTo(60_000); // cached: settles synchronously (0 ms)
      expect(g.state).toBe('playing');
      state.runwaySimMs = 0;
      g.seekTo(70_000);
      vi.advanceTimersByTime(100);
      state.runwaySimMs = 100_000;
      g.notifyBufferChange(runway(100_000));
      expect(g.getQoeStats().seekCount).toBe(3);
      expect(g.getQoeStats().seekSettleMsP50).toBe(100);

      // One honest stall: stallMs mirrors totalStallMs, buffering entries
      // mirror stallCount.
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      vi.advanceTimersByTime(1000);
      const mid = g.getQoeStats();
      expect(mid.stallCount).toBe(1);
      expect(mid.stallMs).toBe(mid.totalStallMs);
      expect(mid.stallMs).toBeGreaterThanOrEqual(1000);
      expect(mid.gateEntriesByReason.buffering).toBe(1);
      state.runwaySimMs = 100_000;
      g.notifyBufferChange(runway(100_000));
      expect(g.state).toBe('playing');

      // A frontier snap-back: a fresh probe reads exactly one watermark of
      // runway (6_000 — passes the check), then the network goes silent and
      // the clock overruns that frontier inside the probe interval.
      state.runwaySimMs = 6_000;
      vi.advanceTimersByTime(250);
      const probedAt = tc.getTime() + 10;
      tc.setTime(probedAt); // fresh probe → frontier = probedAt + 6_000
      expect(g.state).toBe('playing');
      state.runwaySimMs = 0;
      tc.setTime(probedAt + 6_400);
      expect(tc.getTime()).toBe(probedAt + 6_000);
      expect(g.state).toBe('buffering');
      const end = g.getQoeStats();
      expect(end.frontierSnapBacks).toBe(1);
      expect(end.stallCount).toBe(2);
      expect(end.gateEntriesByReason).toEqual({
        starting: 1,
        buffering: 2,
        seeking: 3,
      });
    });

    it('G2: a loop wrap is not a seek (seekCount) but is a seeking gate entry', () => {
      const frames: Array<() => void> = [];
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      });
      tc.destroy();
      tc = new TimeController({
        initialTime: 99_000,
        speed: 10,
        loop: true,
        timeRange: { start: 0, end: 100_000 },
      });
      const { source, state } = makeSource();
      state.runwaySimMs = 1_000_000;
      const g = makeGovernor({ source });
      g.requestPlay();
      vi.advanceTimersByTime(200); // 2_000 sim-ms past 99_000 → wraps
      for (const cb of frames.splice(0, frames.length)) cb();
      expect(tc.getTime()).toBe(0); // wrapped
      expect(g.getQoeStats().seekCount).toBe(0);
      expect(g.getQoeStats().gateEntriesByReason.seeking).toBe(1);
    });
  });

  describe('tile-loading audit 2026-08 (G3-4: a gate must not pass onto nothing)', () => {
    /**
     * Resident data through `reach` — a probe past it reads zero, like the
     * real coverage index — AND a buffered-ranges bar that says so (unless
     * `bare`). The two channels G3-4b joins.
     */
    function makeRangeSource(reachSimMs: number, bare = false) {
      const state = { reach: reachSimMs, complete: false };
      const source: BufferSource = {
        getBufferedRunway(time, direction, horizonSimMs) {
          const ahead = direction > 0 ? state.reach - time : time - state.reach;
          const simMs = Math.max(0, Math.min(ahead, horizonSimMs ?? Infinity));
          return {
            simMs,
            bytesPending: 0,
            horizonSimMs: horizonSimMs ?? simMs,
            complete: state.complete,
          };
        },
        getBufferedRanges() {
          return bare ? [] : [{ start: 0, end: state.reach }];
        },
        estimateCost() {
          return { bytes: 0, tiles: 0 };
        },
        estimateTimeToReadyMs() {
          return null;
        },
        flushPrefetch() {},
      };
      return { source, state };
    }

    it('G3-4a: the canplaythrough predictor never releases a gate with NOTHING under the head, however cheap the remainder reads', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 0;
      state.etaMs = 0; // a warm estimator over a stale rate: "free"
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        maxStartWaitMs: 60_000,
      });
      g.requestPlay();
      expect(g.state).toBe('starting');
      expect(tc.isPlaying()).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(g.state).toBe('starting');
      // Just under the floor (one probe interval: 200 ms × 10) still holds…
      state.runwaySimMs = 1999;
      g.notifyBufferChange(runway(1999));
      expect(g.state).toBe('starting');
      // …at the floor the same ETA releases it, honestly.
      state.runwaySimMs = 2000;
      g.notifyBufferChange(runway(2000));
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().degradedResumeCount).toBe(0);
    });

    it('G3-4a: the floor is one BUCKET when the source declares one shorter than the probe interval', () => {
      const { source, state } = makeSource();
      source.getTemporalBucketMs = () => 500; // < 2000 (200 ms × 10)
      state.runwaySimMs = 499;
      state.etaMs = 0;
      const g = makeGovernor({
        source,
        startGateWallMs: 2000,
        maxStartWaitMs: 60_000,
      });
      g.requestPlay();
      expect(g.state).toBe('starting');
      state.runwaySimMs = 500;
      g.notifyBufferChange(runway(500));
      expect(g.state).toBe('playing');
    });

    it('G3-4a: the watermark stall is not talked out of by the predictor when the runway is dry', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      state.etaMs = 0; // "instant" — which used to veto the stall
      const g = makeGovernor({ source });
      g.requestPlay();
      expect(g.state).toBe('playing');
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      expect(g.getQoeStats().stallCount).toBe(1);
    });

    it('G3-4b: a zero-runway probe anchors the frontier BEHIND the head, so the clamp snaps back onto loaded data instead of stalling in the void', () => {
      // Play with 100_000 of runway. The probe interval elapses, and on the
      // very tick that re-probes the head has already crossed the frontier
      // (one frame past it, as a fast clock does). The fresh probe AT the
      // head reads zero. Before: `bufferedUntil = head`, a `buffering` gate
      // frozen 400 sim-ms into unloaded data, and every later pass played on
      // from there. After: the frontier is the end of resident data, the
      // clock snaps to it, and the gate holds THERE.
      const src = makeRangeSource(100_000);
      const g = makeGovernor({ source: src.source });
      g.requestPlay();
      expect(g.state).toBe('playing');
      vi.advanceTimersByTime(250); // > TICK_PROBE_INTERVAL_MS: the next tick re-probes
      tc.setTime(100_400);
      expect(tc.getTime()).toBe(100_000);
      expect(g.state).toBe('buffering');
      const q = g.getQoeStats();
      expect(q.frontierSnapBacks).toBe(1);
      expect(q.gateEntriesByReason.buffering).toBe(1);
      expect(q.gateHoldsByReason.buffering).toBe(1);
    });

    it('G3-4b: with nothing resident behind the head the frontier stays AT the head — a gate, no snap', () => {
      const src = makeRangeSource(100_000, true);
      const g = makeGovernor({ source: src.source });
      g.requestPlay();
      vi.advanceTimersByTime(250);
      tc.setTime(100_400);
      expect(tc.getTime()).toBe(100_400);
      expect(g.state).toBe('buffering');
      expect(g.getQoeStats().frontierSnapBacks).toBe(0);
    });

    it('G3-4b: a crossing INSIDE the probe interval still re-probes at the cached frontier (B6 unchanged)', () => {
      const src = makeRangeSource(100_000);
      const g = makeGovernor({ source: src.source });
      g.requestPlay();
      vi.advanceTimersByTime(150);
      src.state.reach = 200_000; // landed, unannounced
      tc.setTime(100_400);
      expect(tc.getTime()).toBe(100_400);
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().frontierSnapBacks).toBe(0);
    });

    it('G3-4c: a gate that passes synchronously is an ENTRY but not a HOLD; a real stall is both', () => {
      const { source, state } = makeSource();
      state.runwaySimMs = 100_000;
      const g = makeGovernor({ source });
      expect(g.getQoeStats().gateHoldsByReason).toEqual({
        starting: 0,
        buffering: 0,
        seeking: 0,
      });
      g.requestPlay(); // resident: passes inside enterGate
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().gateEntriesByReason.starting).toBe(1);
      expect(g.getQoeStats().gateHoldsByReason.starting).toBe(0);
      g.seekTo(50_000); // cached: synchronous
      expect(g.state).toBe('playing');
      expect(g.getQoeStats().gateEntriesByReason.seeking).toBe(1);
      expect(g.getQoeStats().gateHoldsByReason.seeking).toBe(0);
      // A real stall: entry AND hold.
      state.runwaySimMs = 0;
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      expect(g.getQoeStats().gateEntriesByReason.buffering).toBe(1);
      expect(g.getQoeStats().gateHoldsByReason.buffering).toBe(1);
      state.runwaySimMs = 100_000;
      g.notifyBufferChange(runway(100_000));
      expect(g.state).toBe('playing');
      // A held seek.
      state.runwaySimMs = 0;
      g.seekTo(70_000);
      expect(g.state).toBe('seeking');
      expect(g.getQoeStats().gateEntriesByReason.seeking).toBe(2);
      expect(g.getQoeStats().gateHoldsByReason.seeking).toBe(1);
    });

    it('G3-4c: gateHoldsByReason rides the playback.state snapshot beside gateEntriesByReason', () => {
      interface ProbeBag {
        enabled?: boolean;
        snapshots?: Record<string, Record<string, unknown>>;
        [k: string]: unknown;
      }
      const bag: ProbeBag = { enabled: true };
      (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe = bag;
      try {
        const { source, state } = makeSource();
        state.runwaySimMs = 100_000;
        const g = makeGovernor({ source });
        g.requestPlay();
        state.runwaySimMs = 0;
        g.notifyBufferChange(runway(0));
        expect(g.state).toBe('buffering');
        const snap = bag.snapshots?.['playback.state'];
        expect(snap).toBeDefined();
        expect(snap!.gateEntriesByReason).toEqual({
          starting: 1,
          buffering: 1,
          seeking: 0,
        });
        expect(snap!.gateHoldsByReason).toEqual({
          starting: 0,
          buffering: 1,
          seeking: 0,
        });
      } finally {
        delete (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
      }
    });
  });
  /**
   * The watermark and the resume gate measure the same question over DIFFERENT
   * windows (600 wall-ms vs resumeFactor × 2000), and reach it through
   * different predicates (`predictsPlaythrough`, the escape hatch, a probe
   * capped at its own horizon). They can therefore disagree — and a stall the
   * resume gate re-opens on the spot is not a stall, it is a pause + a play
   * per tick. In a React host each of those is a state update whose render
   * draws deck.gl, which ticks the clock, which re-decides… until React aborts
   * the chain with "Maximum update depth exceeded".
   */
  describe('anti-flap: never stall into a state the resume gate would re-open', () => {
    /**
     * A source whose answer depends on the HORIZON it is asked about: thin and
     * incomplete inside the watermark window, complete once the probe reaches
     * the resume gate's. Stands in for every real way the two checks can
     * disagree; the governor's contract is the same whatever the cause.
     */
    function makeDisagreeingSource(completeAtOrAboveSimMs: number) {
      const calls: number[] = [];
      const source: BufferSource = {
        getBufferedRunway(_time, _direction, horizonSimMs) {
          const horizon = horizonSimMs ?? Infinity;
          calls.push(horizon);
          return horizon >= completeAtOrAboveSimMs
            ? {
                simMs: horizon,
                bytesPending: 0,
                horizonSimMs: horizon,
                complete: true,
              }
            : {
                simMs: 0,
                bytesPending: 1_000,
                horizonSimMs: horizon,
                complete: false,
              };
        },
        getBufferedRanges: () => [],
        estimateCost: () => ({ bytes: 0, tiles: 0 }),
        estimateTimeToReadyMs: () => null, // blind ⇒ the predictor never releases
        flushPrefetch: () => {},
      };
      return { source, calls };
    }

    it('keeps playing (no pause, no state churn) when the resume gate would pass', () => {
      // Start gate 2000 × 10 = 20000 sim-ms; resume gate 2× that; watermark
      // 600 × 10 = 6000. The source is complete from 20000 up, so both gates
      // pass and only the watermark's own probe reads a dry runway.
      const { source } = makeDisagreeingSource(20_000);
      const g = makeGovernor({ source });
      const playStates: boolean[] = [];
      tc.on('playState', (playing) => playStates.push(playing));

      g.requestPlay();
      expect(g.state).toBe('playing');
      expect(playStates).toEqual([true]); // the start gate's own resume

      // Every buffer event runs the watermark check; none may stall.
      for (let i = 0; i < 25; i++) g.notifyBufferChange(runway(0));
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
      expect(playStates).toEqual([true]); // ← the flap: pause/play per event
      expect(states).toEqual(['starting', 'playing']);
    });

    it('says so once when the disagreement is standing, not marginal', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { source } = makeDisagreeingSource(20_000);
        const g = makeGovernor({ source });
        g.requestPlay();
        for (let i = 0; i < 60; i++) g.notifyBufferChange(runway(0));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('resume gate');
      } finally {
        warn.mockRestore();
      }
    });

    it('still stalls when the resume gate would NOT pass (the honest case)', () => {
      // Complete only far beyond the resume gate (40000) ⇒ no disagreement.
      const { source } = makeDisagreeingSource(10_000_000);
      const g = makeGovernor({ source, maxStartWaitMs: 1_000_000 });
      // A runway that clears the start gate, then collapses.
      const opening = makeSource();
      opening.state.runwaySimMs = 100_000;
      g.setSource(opening.source);
      g.requestPlay();
      expect(g.state).toBe('playing');

      g.setSource(source); // now every probe reads dry
      g.notifyBufferChange(runway(0));
      expect(g.state).toBe('buffering');
      expect(tc.isPlaying()).toBe(false);
    });
  });
  describe('inert sources (a torn-down loader must not hold the clock)', () => {
    /**
     * A source that can be switched to INERT — the shape a finalized
     * `SpatioTemporalTileset` takes: its tile registry is cleared but its
     * coverage index survives, so it answers "runway 0, never complete"
     * forever while reporting `isInert() === true`.
     */
    function makeInertibleSource() {
      const state = { runwaySimMs: 100_000, complete: false, inert: false };
      const source: BufferSource = {
        getBufferedRunway(_time, _direction, horizonSimMs) {
          const simMs = state.inert ? 0 : state.runwaySimMs;
          return {
            simMs,
            bytesPending: 0,
            horizonSimMs: horizonSimMs ?? simMs,
            complete: state.inert ? false : state.complete,
          };
        },
        getBufferedRanges: () => [],
        estimateCost: () => ({ bytes: 0, tiles: 0 }),
        estimateTimeToReadyMs: () => null,
        flushPrefetch: () => {},
        isInert: () => state.inert,
      };
      return { source, state };
    }

    it('drops an inert required source so its bone-dry runway stops gating', () => {
      const dead = makeInertibleSource();
      const live = makeInertibleSource();
      const g = makeGovernor({
        startGateWallMs: 2000,
        maxStartWaitMs: 1_000_000,
      });
      g.addSource('dead', dead.source, { required: true });
      g.addSource('live', live.source, { required: true });
      live.state.runwaySimMs = 100_000;

      // The renderer swapped datasets: the old loader is finalized but never
      // unregistered, so the min-gate now folds a source that can never fill.
      dead.state.inert = true;
      dead.state.runwaySimMs = 0;

      g.requestPlay();
      expect(g.state).toBe('playing');
      expect(tc.isPlaying()).toBe(true);
      expect(g.getSourceRunways().map((s) => s.id)).toEqual(['live']);
    });

    it('unjams a gate that a source went inert UNDER', () => {
      const dead = makeInertibleSource();
      const live = makeInertibleSource();
      const g = makeGovernor({
        startGateWallMs: 2000,
        maxStartWaitMs: 1_000_000,
      });
      g.addSource('dead', dead.source, { required: true });
      g.addSource('live', live.source, { required: true });
      dead.state.runwaySimMs = 0; // below the 20_000 sim-ms gate
      live.state.runwaySimMs = 100_000;

      g.requestPlay();
      expect(g.state).toBe('starting'); // held at the laggard

      dead.state.inert = true;
      g.notifyBufferChange(runway(100_000));
      expect(g.state).toBe('playing');
      expect(g.getSourceRunways().map((s) => s.id)).toEqual(['live']);
    });

    it('leaves sources without the optional isInert method alone', () => {
      const { source, state } = makeSource(); // no isInert on this mock
      const g = makeGovernor({
        startGateWallMs: 2000,
        maxStartWaitMs: 1_000_000,
      });
      g.addSource('plain', source, { required: true });
      state.runwaySimMs = 0;

      g.requestPlay();
      expect(g.state).toBe('starting');
      expect(g.getSourceRunways().map((s) => s.id)).toEqual(['plain']);
    });
  });
});
