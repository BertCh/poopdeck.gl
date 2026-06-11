/**
 * Shared playback wiring for every surface that mounts a live demo map: the
 * fullscreen viewer (`/demo/:id`), the per-demo landing-page embed
 * (`/demos/:id`), and — eventually — the home hero.
 *
 * Owns the TimeController + PlaybackGovernor lifecycle, the throttled UI
 * clock, speed/auto-speed handling, and the tileset/buffer handoff that the
 * STT layers call back into. Extracted verbatim from DemoPage so the embed
 * and the fullscreen page cannot drift apart.
 */
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  PlaybackGovernor,
  TimeController,
  decideAutoSpeedMultiplier,
} from "@stt/deck.gl";
import type {
  AutoSpeedPhase,
  BufferSource,
  BufferedRunway,
  OverviewPreloadResult,
  PlaybackGovernorState,
} from "@stt/deck.gl";
import type { Dataset } from "../../types";
import { calculateAnimationSpeed } from "../../types";

// The governor's user-intent bit (`get paused()`, the F7 intent exposure) is
// newer than the showcase's built @stt/deck.gl dist may be — the showcase
// typechecks against dist/*.d.ts, not src. Narrow assertion until the dist is
// rebuilt; the runtime member is always present on the source build.
const governorPaused = (g: PlaybackGovernor): boolean =>
  (g as PlaybackGovernor & { paused: boolean }).paused;

export interface DemoPlayback {
  timeController: TimeController;
  governor: PlaybackGovernor | null;
  /** Loaded-tileset handle; the cube lattice polls getVisibleTiles off it. */
  tilesetRef: React.MutableRefObject<BufferSource | null>;
  /** 20Hz-throttled UI clock (slider/label/cube overlays — NOT the layers). */
  currentTime: number;
  isPlaying: boolean;
  bufferState: PlaybackGovernorState;
  speedMultiplier: number;
  autoSpeed: boolean;
  overviewPreload: OverviewPreloadResult | null;
  baseAnimationSpeed: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (multiplier: number) => void;
  onAutoSpeedSelect: () => void;
  /** Imperative play/pause for visibility-driven embeds. */
  play: () => void;
  pause: () => void;
  /** STT layer plumbing — pass through as layer props. */
  handleTilesetReady: (tileset: BufferSource) => void;
  handleBufferChange: (runway: BufferedRunway) => void;
  handleOverviewPreload: (result: OverviewPreloadResult) => void;
}

export function useDemoPlayback(
  selectedDataset: Dataset | undefined,
): DemoPlayback {
  const baseAnimationSpeed = useMemo(() => {
    if (!selectedDataset) return 1000;
    return calculateAnimationSpeed(selectedDataset);
  }, [selectedDataset]);

  const [timeController] = useState(
    () =>
      new TimeController({
        initialTime:
          selectedDataset?.timeRange.start || Date.parse("2020-01-01"),
        speed: baseAnimationSpeed,
        loop: true,
        timeRange: selectedDataset?.timeRange,
      }),
  );

  const [currentTime, setCurrentTime] = useState(timeController.getTime());
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState(1.0);
  const [autoSpeed, setAutoSpeed] = useState(false);

  // ── Playback governor (player-buffering WS-B) ──────────────────────────────
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
  const [bufferState, setBufferState] = useState<PlaybackGovernorState>("idle");
  useEffect(() => {
    if (!governor) return;
    setBufferState(governor.state);
    setIsPlaying(!governorPaused(governor));
    const onStateChange = (state: PlaybackGovernorState) => {
      setBufferState(state);
      setIsPlaying(!governorPaused(governor));
    };
    governor.on("statechange", onStateChange);
    return () => governor.off("statechange", onStateChange);
  }, [governor]);

  useEffect(() => {
    if (selectedDataset) {
      const newSpeed = calculateAnimationSpeed(selectedDataset);
      // Drop the previous dataset's tileset before resetting the clock — the
      // layer finalizes it during its own re-init, and the governor must not
      // query a finalized source. The new tileset re-attaches via
      // onTilesetReady.
      tilesetRef.current = null;
      governor?.requestPause();
      governor?.setSource(null);
      timeController.setTimeRange(selectedDataset.timeRange);
      timeController.setTime(selectedDataset.timeRange.start);
      timeController.setSpeed(newSpeed * speedMultiplier);
      setIsPlaying(false);
      setSpeedMultiplier(1.0);
      setAutoSpeed(false);
    }
    // speedMultiplier is read for the speed reset but deliberately not a dep —
    // this effect must run only on dataset/controller/governor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDataset, timeController, governor]);

  // Throttle the React `currentTime` state update during playback. The
  // TimeController ticks once per rAF (60Hz); the deck.gl layer reads time
  // directly from the controller via a getter in TimeFilterExtension.draw(),
  // so this React state is ONLY used to repaint the time slider and the
  // displayed-time label. Updating those at 60Hz forces a full page
  // re-render every frame, which made deck.gl receive a fresh `layers`
  // array prop on every tick and rerun layer matching + updateState on
  // every visible sublayer. 20Hz is visually indistinguishable for the
  // UI and cuts React/deck.gl prop-diff work to a third.
  const lastUiTickRef = useRef(0);
  useEffect(() => {
    lastUiTickRef.current = 0;
    const handleTimeUpdate = (time: number) => {
      const now = performance.now();
      if (now - lastUiTickRef.current < 50) return;
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
    timeController.on("tick", handleTimeUpdate);
    timeController.on("playState", handlePlayState);
    return () => {
      timeController.off("tick", handleTimeUpdate);
      timeController.off("playState", handlePlayState);
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

  // ── Opt-in Auto speed (player-buffering WS-D) ──────────────────────────────
  // While Auto is selected, apply the governor's sustainable-speed suggestion
  // through the shared asymmetric policy (player-buffering §2, after hls.js
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
    applySuggestion("cadence");
    const intervalId = setInterval(() => applySuggestion("cadence"), 5000);
    const onWaiting = () => applySuggestion("waiting");
    governor.on("waiting", onWaiting);
    return () => {
      clearInterval(intervalId);
      governor.off("waiting", onWaiting);
    };
  }, [autoSpeed, governor, baseAnimationSpeed, timeController]);

  const handleAutoSpeedSelect = useCallback(() => setAutoSpeed(true), []);

  // Governor plumbing for the STT layers: the tileset (the BufferSource)
  // arrives async after archive init; buffer-runway events route into the
  // governor for immediate gate/stall evaluation.
  const handleTilesetReady = useCallback((tileset: BufferSource) => {
    tilesetRef.current = tileset;
    governorRef.current?.setSource(tileset);
  }, []);
  const handleBufferChange = useCallback(
    (runway: BufferedRunway) => governorRef.current?.notifyBufferChange(runway),
    [],
  );

  // ── Storyboard preview tier (player-buffering WS-C4) ───────────────────────
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
    // A dataset switch re-inits the tileset; the stale outcome must not
    // describe the new dataset's storyboard.
    setOverviewPreload(null);
  }, [selectedDataset]);

  return {
    timeController,
    governor,
    tilesetRef,
    currentTime,
    isPlaying,
    bufferState,
    speedMultiplier,
    autoSpeed,
    overviewPreload,
    baseAnimationSpeed,
    onPlayPause: handlePlayPause,
    onSeek: handleSeek,
    onSpeedChange: handleSpeedChange,
    onAutoSpeedSelect: handleAutoSpeedSelect,
    play,
    pause,
    handleTilesetReady,
    handleBufferChange,
    handleOverviewPreload,
  };
}
