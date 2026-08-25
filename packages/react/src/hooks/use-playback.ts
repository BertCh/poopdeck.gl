// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * usePlayback — the React playback-wiring hook for any surface that mounts a
 * live spatiotemporal / time-series map.
 *
 * Owns the TimeController + PlaybackGovernor lifecycle, the throttled UI clock,
 * speed / Auto-speed handling, and the tileset/buffer handoff that the renderer
 * layers call back into. Renderer-agnostic: feed it a time range + base speed,
 * wire the returned handlers into your layers, and drive any UI off the
 * returned reactive state.
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  PlaybackGovernor,
  TimeController,
  decideAutoSpeedMultiplier,
} from '@poopdeck.gl/playback';
import type {
  AutoSpeedPhase,
  BufferSource,
  BufferedRunway,
  PlaybackGovernorState,
} from '@poopdeck.gl/playback';
import type { OverviewPreloadResult } from '@poopdeck.gl/core';

// The governor's user-intent bit (`get paused()`). Narrow accessor kept as a
// helper so a single call site documents the intent semantics.
const governorPaused = (g: PlaybackGovernor): boolean => g.paused;

/**
 * Multi-source registration API: a renderer registers EVERY layer's tileset as a
 * classified governor source, keyed by the layer id, so the clock waits for
 * every *required* source — not just the field.
 * Optional overlays load coordinated but never gate. The governor re-probes all
 * sources itself on a buffer change, so the `runway` passed to
 * {@link SourceRegistry.onBufferChange} is advisory (it just kicks an immediate
 * re-evaluation).
 */
export interface SourceRegistry {
  registerSource: (
    id: string,
    tileset: BufferSource,
    opts?: { required?: boolean; weight?: number },
  ) => void;
  unregisterSource: (id: string) => void;
  onBufferChange: (id: string, runway: BufferedRunway) => void;
}

export interface PlaybackState {
  timeController: TimeController;
  governor: PlaybackGovernor | null;
  /** Loaded-tileset handle; the cube lattice polls getVisibleTiles off it. */
  tilesetRef: React.MutableRefObject<BufferSource | null>;
  /** 10Hz-throttled UI clock (slider/label/cube overlays — NOT the layers). */
  currentTime: number;
  isPlaying: boolean;
  /**
   * Parked at a non-looping range boundary — the media-element `ended` bit,
   * mirrored from the governor. Drives the transport bar's replay affordance;
   * `onPlayPause` from here restarts from the range start (the governor's
   * `requestPlay` implements the media replay convention).
   */
  ended: boolean;
  bufferState: PlaybackGovernorState;
  speedMultiplier: number;
  /**
   * Same value as `speedMultiplier`, under `PlaybackControls`' prop name —
   * together with the echoed `timeRange` this makes
   * `<PlaybackControls {...pb} />` just work.
   */
  currentSpeedMultiplier: number;
  /** The `timeRange` option echoed back (for spreading into PlaybackControls). */
  timeRange?: { start: number; end: number };
  autoSpeed: boolean;
  /** Live loop state (seeded from `UsePlaybackOptions.loop`). */
  loop: boolean;
  overviewPreload: OverviewPreloadResult | null;
  baseAnimationSpeed: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (multiplier: number) => void;
  onAutoSpeedSelect: () => void;
  /** Flip looping at the range end. Never moves the playhead. */
  onLoopToggle: () => void;
  /** Imperative play/pause for visibility-driven embeds. */
  play: () => void;
  pause: () => void;
  /**
   * Multi-source registration API: wire EACH layer's tileset into the governor
   * as a classified source (field/primary required, overlays optional) so the
   * clock waits for every required source.
   */
  registry: SourceRegistry;
  handleOverviewPreload: (result: OverviewPreloadResult) => void;
}

export interface UsePlaybackOptions {
  /** Full time span of the data (sim-ms). Drives the clock range + slider. */
  timeRange?: { start: number; end: number };
  /**
   * Wall-ms → sim-ms base rate at 1× (the controller's `speed`); multiplied by
   * the user's speed preset. Defaults to 1000 (1 real second = 1 sim second).
   */
  baseSpeed?: number;
  /** Loop at the range end (default true). */
  loop?: boolean;
  /**
   * Initial playhead (clamped into `timeRange` when both are given); defaults
   * to the range start. Mount-time only — a later `timeRange` change resets
   * the playhead to the new range start.
   */
  initialTime?: number;
  /**
   * Start in Auto-speed mode (the governor's buffer-aware multiplier) instead
   * of the fixed 1× preset. Mount-time SEED only, like `loop`: picking any
   * explicit preset still exits Auto, and `onAutoSpeedSelect` re-enters it.
   * @default false
   */
  initialAutoSpeed?: boolean;
}

export function usePlayback(options: UsePlaybackOptions = {}): PlaybackState {
  const {
    timeRange,
    baseSpeed,
    loop: initialLoop = true,
    initialTime,
    initialAutoSpeed = false,
  } = options;
  const rangeStart = timeRange?.start;
  const rangeEnd = timeRange?.end;
  const baseAnimationSpeed = baseSpeed ?? 1000;

  const [timeController] = useState(
    () =>
      new TimeController({
        initialTime: initialTime ?? rangeStart ?? Date.parse('2020-01-01'),
        speed: baseAnimationSpeed,
        loop: initialLoop,
        timeRange,
      }),
  );

  // Loop is a live user control (the transport bar exposes a toggle), so the
  // option only SEEDS it. Pushed to the clock in an effect rather than from the
  // click handler so the controller can never disagree with what the UI shows.
  const [loop, setLoop] = useState(initialLoop);
  useEffect(() => {
    timeController.setLoop(loop);
  }, [timeController, loop]);
  const handleLoopToggle = useCallback(() => setLoop((v) => !v), []);

  const [currentTime, setCurrentTime] = useState(timeController.getTime());
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState(1.0);
  const [autoSpeed, setAutoSpeed] = useState(initialAutoSpeed);

  // ── Playback governor (docs/roadmap/playback-and-loading.md) ───────────────
  // One governor per mounted demo, wrapping the shared TimeController: play /
  // pause / seek all route through it so playback gates on the tileset's
  // buffered runway (start gate, mid-playback stall, post-seek gate) instead
  // of advancing into unloaded time. The tileset arrives async via the
  // layer's onTilesetReady and is handed over with setSource below.
  //
  // The governor is created INSIDE an effect (not useState) so that React
  // StrictMode's dev-only mount→cleanup→remount cycle gets a fresh instance:
  // dispose() is terminal, and a useState-held instance would come back from
  // the simulated remount permanently dead (every call a silent no-op).
  // tilesetRef remembers the layer's one-shot onTilesetReady handover so a
  // governor created after it (or re-created by StrictMode) still gets the
  // source.
  const governorRef = useRef<PlaybackGovernor | null>(null);
  const tilesetRef = useRef<BufferSource | null>(null);
  const [governor, setGovernor] = useState<PlaybackGovernor | null>(null);
  useEffect(() => {
    const g = new PlaybackGovernor(timeController);
    governorRef.current = g;
    if (tilesetRef.current) g.setSource(tilesetRef.current);
    setGovernor(g);
    return () => {
      governorRef.current = null;
      g.dispose();
      setGovernor(null);
    };
  }, [timeController]);

  // Reflect the governor's machine state into React (state transitions are
  // rare — start/stall/seek — so no extra throttling is needed). The React
  // `isPlaying` mirror derives from the governor's intent bit (`paused`) on
  // every transition — external pauses (the clock clamping at a range end)
  // and the ended path both clear intent inside the governor, so they flow
  // through here without special-casing any particular state.
  const [bufferState, setBufferState] = useState<PlaybackGovernorState>('idle');
  // The governor's media-element `ended` bit. It is NOT part of
  // PlaybackGovernorState (a non-looping boundary stop leaves the machine
  // 'idle'), so it has to be mirrored from both the event that sets it and the
  // state transitions that clear it — play/seek both reset `endedAtBoundary`
  // inside the governor, and each of those emits 'statechange'.
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (!governor) return;
    setBufferState(governor.state);
    setIsPlaying(!governorPaused(governor));
    setEnded(governor.ended);
    const onStateChange = (state: PlaybackGovernorState) => {
      setBufferState(state);
      setIsPlaying(!governorPaused(governor));
      setEnded(governor.ended);
    };
    const onEnded = () => {
      setEnded(true);
      setIsPlaying(!governorPaused(governor));
    };
    governor.on('statechange', onStateChange);
    governor.on('ended', onEnded);
    return () => {
      governor.off('statechange', onStateChange);
      governor.off('ended', onEnded);
    };
  }, [governor]);

  // Track the range VALUE actually applied so the reset below runs only when
  // the range genuinely changes — `governor` must stay a dep (a range swap has
  // to drop the old source), but the governor's async arrival re-fires this
  // effect on mount with the same range, and an unguarded body would reset the
  // playhead to rangeStart, silently clobbering the constructor's
  // `initialTime`.
  const appliedRangeRef = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => {
    if (rangeStart != null && rangeEnd != null) {
      const prev = appliedRangeRef.current;
      if (prev && prev.start === rangeStart && prev.end === rangeEnd) return;
      const firstApply = prev == null;
      appliedRangeRef.current = { start: rangeStart, end: rangeEnd };
      // Drop the previous range's tileset before resetting the clock — the
      // layer finalizes it during its own re-init, and the governor must not
      // query a finalized source. The new tileset re-attaches via
      // onTilesetReady.
      tilesetRef.current = null;
      governor?.requestPause();
      governor?.setSource(null);
      timeController.setTimeRange({ start: rangeStart, end: rangeEnd });
      // The mount-time application honours `initialTime` (clamped into range)
      // and the `initialAutoSpeed` seed; a LATER range change is a dataset
      // swap and starts at the new range start on the fixed 1× preset — both
      // are mount-time concepts.
      const startAt =
        firstApply && initialTime != null
          ? Math.min(Math.max(initialTime, rangeStart), rangeEnd)
          : rangeStart;
      timeController.setTime(startAt);
      timeController.setSpeed(baseAnimationSpeed * speedMultiplier);
      setIsPlaying(false);
      setSpeedMultiplier(1.0);
      setAutoSpeed(firstApply ? initialAutoSpeed : false);
    }
    // speedMultiplier is read for the speed reset, and initialTime /
    // initialAutoSpeed only on the first application, but none are deps —
    // this effect must run only on range/speed/controller/governor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart, rangeEnd, baseAnimationSpeed, timeController, governor]);

  // Throttle the React `currentTime` state update during playback. The
  // TimeController ticks once per rAF (60Hz); the deck.gl layer reads time
  // directly from the controller via a getter in TimeFilterExtension.draw(),
  // so this React state is ONLY used to repaint the time slider and the
  // displayed-time label. Updating those at 60Hz forces a full page
  // re-render every frame, which made deck.gl receive a fresh `layers`
  // array prop on every tick and rerun layer matching + updateState on
  // every visible sublayer. The timeline animates between samples in CSS, so a
  // 10Hz UI clock remains smooth while cutting React/deck.gl prop-diff work to
  // one sixth of the render clock.
  const lastUiTickRef = useRef(0);
  useEffect(() => {
    lastUiTickRef.current = 0;
    const handleTimeUpdate = (time: number) => {
      const now = performance.now();
      if (now - lastUiTickRef.current < 100) return;
      lastUiTickRef.current = now;
      setCurrentTime(time);
    };
    // Subscribe to play-state as well so the slider snaps to the final time
    // when playback stops (the throttled tick may have skipped the last update).
    const handlePlayState = (playing: boolean) => {
      if (!playing) {
        lastUiTickRef.current = 0;
        setCurrentTime(timeController.getTime());
      }
    };
    timeController.on('tick', handleTimeUpdate);
    timeController.on('playState', handlePlayState);
    return () => {
      timeController.off('tick', handleTimeUpdate);
      timeController.off('playState', handlePlayState);
    };
  }, [timeController]);

  // Play/pause/toggle all read AND write intent on the governor (F7): branch
  // on `g.paused`, call requestPlay/requestPause, then mirror `!g.paused` back
  // into React. One source of truth — no optimistic state to drift from the
  // governor (and no stale-closure dependency on the `isPlaying` state).
  const play = useCallback(() => {
    const g = governorRef.current;
    if (!g) return;
    g.requestPlay();
    setIsPlaying(!governorPaused(g));
  }, []);

  const pause = useCallback(() => {
    const g = governorRef.current;
    if (!g) return;
    g.requestPause();
    setIsPlaying(!governorPaused(g));
  }, []);

  const handlePlayPause = useCallback(() => {
    const g = governorRef.current;
    if (!g) return;
    if (governorPaused(g)) {
      g.requestPlay();
    } else {
      g.requestPause();
    }
    setIsPlaying(!governorPaused(g));
  }, []);

  // Committed seek (keyboard arrows, jump-to-start). Drag-scrubbing previews
  // talk to the governor directly inside TimeControls.
  const handleSeek = useCallback((time: number) => {
    governorRef.current?.seekTo(time);
  }, []);

  const handleSpeedChange = useCallback(
    (multiplier: number) => {
      setAutoSpeed(false); // an explicit choice always exits Auto mode
      setSpeedMultiplier(multiplier);
      timeController.setSpeed(baseAnimationSpeed * multiplier);
    },
    [timeController, baseAnimationSpeed],
  );

  // ── Opt-in Auto speed (docs/roadmap/playback-and-loading.md) ───────────────
  // While Auto is selected, apply the governor's sustainable-speed suggestion
  // through the shared asymmetric policy (after hls.js
  // ABR's 0.95-down / 0.7-up): DOWNSHIFTS apply immediately with no deadband
  // — on the 5 s cadence AND the moment the governor enters a gate
  // ('waiting'), since a gate entry means the current speed is outrunning the
  // network right now; UPSHIFTS stay on the slow cadence behind a 25%
  // deadband. Suggestions snap to preset-like steps and clamp to
  // [0.25×, max preset]. Auto NEVER touches a user-chosen explicit speed —
  // it's its own mode; picking any preset exits.
  const speedMultiplierRef = useRef(speedMultiplier);
  useEffect(() => {
    speedMultiplierRef.current = speedMultiplier;
  }, [speedMultiplier]);
  useEffect(() => {
    if (!autoSpeed || !governor) return;
    const applySuggestion = (phase: AutoSpeedPhase) => {
      const suggestion = governor.getAutoSpeedSuggestion();
      if (suggestion == null) return; // unknown cost/throughput → hold current
      const next = decideAutoSpeedMultiplier(
        speedMultiplierRef.current,
        suggestion / baseAnimationSpeed,
        phase,
      );
      if (next == null) return;
      timeController.setSpeed(baseAnimationSpeed * next);
      setSpeedMultiplier(next);
    };
    applySuggestion('cadence');
    const intervalId = setInterval(() => applySuggestion('cadence'), 5000);
    const onWaiting = () => applySuggestion('waiting');
    governor.on('waiting', onWaiting);
    return () => {
      clearInterval(intervalId);
      governor.off('waiting', onWaiting);
    };
  }, [autoSpeed, governor, baseAnimationSpeed, timeController]);

  const handleAutoSpeedSelect = useCallback(() => setAutoSpeed(true), []);

  // Governor plumbing for the STT layers: each layer registers its own tileset
  // as a classified governor source. `tilesetRef` tracks the FIRST required
  // source so the cube lattice / overview pollers (which read one BufferSource)
  // still have a handle. The governor's removeSource/addSource are
  // re-evaluation points; on a buffer change we forward to notifyBufferChange
  // (the governor re-probes every source itself — the runway arg is advisory).
  const registry = useMemo<SourceRegistry>(
    () => ({
      registerSource: (id, tileset, opts) => {
        if (opts?.required !== false && tilesetRef.current == null) {
          tilesetRef.current = tileset;
        }
        governorRef.current?.addSource(id, tileset, opts);
      },
      unregisterSource: (id) => {
        governorRef.current?.removeSource(id);
      },
      onBufferChange: (_id, runway) =>
        governorRef.current?.notifyBufferChange(runway),
    }),
    [],
  );

  // ── Storyboard preview tier (docs/roadmap/playback-and-loading.md) ─────────
  // The layer preloads + pins the coarsest tiles across the full time range
  // (budget-gated per dataset) so scrubbing always shows a coarse preview.
  // The outcome surfaces as a one-line stat in the perf HUD.
  const [overviewPreload, setOverviewPreload] =
    useState<OverviewPreloadResult | null>(null);
  const handleOverviewPreload = useCallback(
    (result: OverviewPreloadResult) => setOverviewPreload(result),
    [],
  );
  useEffect(() => {
    // A range switch re-inits the tileset; the stale outcome must not
    // describe the new data's storyboard.
    setOverviewPreload(null);
  }, [rangeStart, rangeEnd]);

  return {
    timeController,
    governor,
    tilesetRef,
    currentTime,
    isPlaying,
    ended,
    bufferState,
    speedMultiplier,
    currentSpeedMultiplier: speedMultiplier,
    timeRange,
    autoSpeed,
    loop,
    overviewPreload,
    baseAnimationSpeed,
    onPlayPause: handlePlayPause,
    onSeek: handleSeek,
    onSpeedChange: handleSpeedChange,
    onAutoSpeedSelect: handleAutoSpeedSelect,
    onLoopToggle: handleLoopToggle,
    play,
    pause,
    registry,
    handleOverviewPreload,
  };
}
