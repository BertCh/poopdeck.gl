import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { _GlobeView as GlobeView } from '@deck.gl/core';
import {
  SolidPolygonLayer,
  GeoJsonLayer,
  ScatterplotLayer,
  TextLayer,
} from '@deck.gl/layers';
import { AnimatedTripsLayer } from '@poopdeck.gl/layers';
import {
  TimeController,
  PlaybackGovernor,
  decideAutoSpeedMultiplier,
} from '@poopdeck.gl/playback';
import type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';
import { getDatasetById } from '../../datasets';
import { tileLoadingProps } from '../../types';
import { useReducedMotion } from '../../lib/reducedMotion';
import {
  ACTS,
  HERO_FOCUS,
  DAY,
  DATA_START,
  DATA_END,
  type GlobeFocus,
  type GlobeMarker,
} from '../../content/drifterStory';

// One full-sphere quad gives the globe a dark "ocean" body that also occludes
// the back-side tracks, so the drifter ribbons read as a planet rather than a
// transparent tangle of lines.
const EARTH_POLYGON: number[][][] = [
  [
    [-180, 90],
    [0, 90],
    [180, 90],
    [180, -90],
    [0, -90],
    [-180, -90],
  ],
];

const OCEAN_SPHERE: [number, number, number, number] = [9, 17, 33, 255];
const LAND_FILL: [number, number, number, number] = [27, 38, 59, 255];

// Idle globe-rotation rates (deg/sec, negative = westward). The continuous turn
// keeps `viewState` changing every frame so deck repaints and the trails stay
// animated. The dial: hero/planetary "spin" beats turn fastest, the "sweep"
// (twenty-six years in a minute) turns at a brisk middle pace, located beats
// barely drift.
const FAST_SPIN = -2.4; // hero / planetary beats
const SWEEP_SPIN = -1.6; // the array filling in — visibly rolling
const IDLE_SPIN = -0.8; // gentle drift on located beats

// ── Cross-dissolve across an era jump (the "flash" fix) ─────────────────────
// Scrolling between beats jumps the clock (e.g. 1985→1981, 2014→2010, or even a
// backward reset within the all-2016 currents tour once the playhead has drifted
// forward). Because the drifter trail is *time-filtered*, the destination era's
// tiles must be fetched before anything can render — and the old era's tiles
// hold no vertices in the new trail window, so there's nothing to bridge the
// gap. `getVisibleTiles()` therefore returns [] right after the jump and the
// layer blanks, then pops back when the new era streams in — read as a flash.
//
// Instead of blanking, we fade the globe out, commit the time jump at the
// trough (invisibly), HOLD black until the destination era is genuinely ready
// (or a timeout), then fade back in — so the eras cross-dissolve over a flying
// camera, reading as a deliberate scene cut. The fade is a GPU-composited CSS
// opacity on the deck container (not the layer's own `opacity` prop), so the
// layers and their per-tile caches are never recreated — the dissolve stays
// smooth. We trigger it ONLY when the jump fully clears the resident tile
// window (otherwise enough tiles overlap that nothing blanks — see the focus
// effect).
//
// "Ready" is now the PlaybackGovernor's post-seek gate: every era jump
// commits through governor.seekTo(), which flushes the old era's stale
// prefetch and re-gates playback on the destination's buffered runway
// (including the canplaythrough predictor, so a fast network releases a cold
// gate immediately instead of waiting for a speed-scaled runway). The fade
// holds black while the governor is gated and releases when it reaches
// 'playing'. A direct runway query (the pre-governor wait condition) and the
// original tile-load heuristic remain only as fallbacks for a paused beat or
// a core build without the buffering API.
const RIBBON_OPACITY = 0.9; // the drifter layer's own (intrinsic) opacity
const TARGET_OPACITY = 1; // globe-container opacity at rest (the fade rides 1→0→1)
const FADE_TAU = 0.12; // globe fade ease constant (s) — ~0.35s each direction
// Max hold at black before fading in regardless of readiness, so a stalled or
// errored load never leaves the globe dark. The governor's own escape hatch
// (maxStartWaitMs) is longer; this is the UX cap on the black hold — past it
// we reveal whatever has arrived and let the stall machinery take over.
const FADE_WAIT_MAX_MS = 2500;
// Runway required before fading back in when only the FALLBACK (direct
// runway query) is available: wall-ms × the beat's |speed| — the same
// start-gate sizing the PlaybackGovernor uses (player-buffering WS-B).
const FADE_GATE_WALL_MS = 2000;
// The runway query is cheap coverage-index bookkeeping, but there's no reason
// to run it per-rAF — throttle the wait-phase readiness check.
const FADE_GATE_CHECK_INTERVAL_MS = 150;

// ── Adaptive speed cap (player-buffering WS-D, story flavor) ────────────────
// The story has authored per-beat speeds but no speed UI, so it adapts
// automatically: while a beat plays, the clock is capped at the governor's
// sustainable-speed suggestion (measured network throughput ÷ byte cost of
// the upcoming horizon), expressed as a FRACTION of the beat's authored speed
// in [AUTO_CAP_MIN_FACTOR, 1]. On a fast network every beat plays exactly as
// authored (a fully-buffered horizon suggests Infinity, which clamps to 1);
// on a slow one the story gracefully slows instead of letting the playhead
// outrun loading (ribbons popping in) or stuttering through stall/resume
// cycles. The floor keeps the narrative moving — below it, the governor's
// honest stall takes over.
//
// The asymmetric up/down policy itself (downshift immediately, upshift only
// on the cadence and past a deadband, snap to displayable steps) is the
// shared `decideAutoSpeedMultiplier` — the same module every Auto-speed UI
// applies — parameterized with a story ladder instead of a local hysteresis
// fork (player-ergonomics review §5.3).
const AUTO_CAP_INTERVAL_MS = 3000;
const AUTO_CAP_MIN_FACTOR = 0.2;
// Cap-fraction rungs (× authored speed). Finer than the showcase preset row
// because everything here lives below 1×; 1 means "play as authored".
const AUTO_CAP_STEPS = [0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1] as const;
// Upshift deadband (replaces the old AUTO_CAP_HYSTERESIS): the ladder's
// tightest gap (0.65→0.8, +23%) must clear it, or recovery to the authored
// rate would stall one rung short on a healthy network.
const AUTO_CAP_UPSHIFT_DEADBAND = 0.2;

// Full temporal extent of the drifters archive (Unix ms), from the story
// content. Drift/spin beats play FORWARD from the beat's moment to DATA_END and
// then hold — no looping, no reset — so the drift just unfolds chronologically
// and reads as calm. Forward playback is also the always-smooth tile-loading
// direction (prefetch is aimed the way the head moves), so it never flashes.
const DATA_TIME_RANGE: { start: number; end: number } = { start: DATA_START, end: DATA_END };

// ── Tile-loading budget (shared recipe, story-wide ceiling) ──────────────────
// The tileset freezes its prefetch/concurrency options when it is created and
// the layer never re-threads them on prop updates, so we can't pass per-beat
// values — instead we compute ONE budget that covers the story's most
// demanding beat (longest trail window, fastest playback) and feed it through
// the same `tileLoadingProps` recipe DemoPage and the hero use. Before this,
// the story silently inherited the library defaults (30 sim-SECONDS of
// prefetch lookahead against beats that play sim-DAYS per real second, and 24
// concurrent requests vs the app-wide 12), so every bucket loaded reactively
// only when the playhead hit it — which is why the story streamed so much
// worse than the same dataset on /demo/ocean-drifters.
const ALL_STORY_FOCI: GlobeFocus[] = [
  HERO_FOCUS,
  ...ACTS.flatMap((act) => act.steps.map((step) => step.focus)),
];
const MAX_TRAIL_MS = Math.max(...ALL_STORY_FOCI.map((f) => (f.trailDays ?? 90) * DAY));
// Fastest beat's controller speed in sim-ms per real-ms (same math as
// applyFocusTime below).
const MAX_PLAYBACK_SPEED =
  Math.max(...ALL_STORY_FOCI.map((f) => f.speedDays ?? 8)) * (DAY / 1000);

const TONE: Record<NonNullable<GlobeMarker['tone']>, [number, number, number]> = {
  cool: [40, 180, 200],
  warm: [250, 200, 90],
  hot: [220, 74, 63],
  gold: [240, 193, 75],
};

/** Shortest-path angular ease (handles the ±180° longitude wrap). */
function easeAngle(cur: number, tgt: number, t: number): number {
  const d = ((tgt - cur + 540) % 360) - 180;
  return cur + d * t;
}

interface StoryGlobeProps {
  focus: GlobeFocus;
  /** When false, the globe pauses + the stage fades out (an interlude covers it). */
  active: boolean;
}

/**
 * A fixed, full-viewport deck.gl globe that the page scroll re-aims. The globe
 * never captures pointer events — the page scroll IS the interaction — so the
 * parent stage sets `pointer-events: none`. Time + camera are driven entirely
 * from the active {@link GlobeFocus}:
 *   • still  — paused snapshot at `focus.time`
 *   • drift  — gentle looping play in a window around `focus.time` (living trails)
 *   • sweep  — play across `focus.sweep` (the array filling in)
 *   • spin   — drift + a slow globe rotation (hero / planetary beats)
 */
const StoryGlobe: React.FC<StoryGlobeProps> = ({ focus, active }) => {
  const dataset = useMemo(() => getDatasetById('ocean-drifters'), []);

  // Reduce-motion turns the cinematic globe into a sequence of static frames:
  // no autoplay of the drifter trails, no continuous spin, no camera fly-in,
  // and no era cross-dissolve. Each beat snaps to its framing + moment instead.
  // A ref mirrors it so the focus/rAF effects can read the live value without
  // listing it as a dep (which would reset the clock mid-beat).
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const [timeController] = useState(
    () =>
      new TimeController({
        initialTime: focus.time,
        // No looping: each beat plays forward from its moment to the end of the
        // archive and then holds the final frame. A loop-wrap would teleport
        // time backward in one frame and snap the rendered trails to a disjoint
        // set; playing straight forward avoids that entirely and is also the
        // always-smooth tile-loading direction (prefetch follows the head), so
        // there's no flash. (`TimeController` also supports `bounce`, unused.)
        loop: false,
        speed: 1,
        tickThrottleMs: 0,
      }),
  );

  // Live camera + its easing target. We drive viewState ourselves every frame
  // (controller is disabled), so a single rAF loop both eases the camera and
  // guarantees per-frame redraws while a beat is animating.
  const camRef = useRef({ longitude: focus.lng, latitude: focus.lat, zoom: focus.zoom });
  const targetRef = useRef({ longitude: focus.lng, latitude: focus.lat, zoom: focus.zoom });
  // Idle rotation rate (deg/sec) for the *current* beat, set from its mode. The
  // hero/planetary "spin" beats turn fastest; the "sweep" (array filling in)
  // turns at a brisk middle pace so the planet visibly rolls as years pass;
  // located beats barely drift. (Negative = westward.)
  const spinRateRef = useRef(0);
  // Becomes true once the camera has arrived at a beat's target. After that the
  // globe rotates gently forever (never fully stops) so `viewState` keeps
  // changing every frame — which is what keeps deck repainting and the drifter
  // trails animating smoothly. Reset on every new focus so the next beat flies.
  const settledRef = useRef(false);
  const [viewState, setViewState] = useState<any>({
    globe: { ...camRef.current, pitch: 0, bearing: 0 },
  });

  // ── Globe cross-dissolve state (see the era-jump comment above). ───────────
  // `driftersOpacity` (the deck container's CSS opacity) is the only piece that
  // reaches React; everything else is rAF-local refs so the per-frame easing
  // never triggers a setState unless the (quantized) opacity actually moved.
  const [driftersOpacity, setDriftersOpacity] = useState(TARGET_OPACITY);
  const opacityRef = useRef(TARGET_OPACITY); // live eased value
  const opacityTargetRef = useRef(TARGET_OPACITY); // where it's easing toward
  const lastSetOpacityRef = useRef(TARGET_OPACITY); // throttle setState to real changes
  // Fade phase: idle → out (fading down) → wait (held black, loading) → in.
  const fadeStateRef = useRef<'idle' | 'out' | 'wait' | 'in'>('idle');
  // Focus whose time-jump is deferred to the fade trough.
  const pendingFocusRef = useRef<GlobeFocus | null>(null);
  // Wall-clock (performance.now) of the last commit + last tile load, so the
  // fade-in waits for the destination era to actually arrive.
  const jumpWallRef = useRef(0);
  const lastTileLoadRef = useRef(0);
  // The drifter layer's tileset (a BufferSource), handed over via
  // onTilesetReady. The wait phase queries its buffered runway to decide when
  // the destination era is genuinely ready; null until init (or on a core
  // build without the buffering API), in which case the legacy tile-load
  // heuristic takes over.
  const sourceRef = useRef<BufferSource | null>(null);
  // Throttle for the wait-phase runway query (no need to ask per-rAF).
  const lastGateCheckRef = useRef(0);
  // Whether the globe was already revealed on the previous focus — a within-act
  // beat change cross-dissolves; a first reveal (from an interlude, masked by
  // the stage's own CSS fade) applies immediately.
  const prevActiveRef = useRef(false);
  const mountedRef = useRef(false);
  // Render-synced mirror of `active` so the focus effect can read the current
  // value without listing `active` as a dep (which would re-fire it — and reset
  // the clock — every time an interlude merely covers the globe).
  const activeRef = useRef(active);
  activeRef.current = active;

  // ── Playback governor (player-buffering WS-B) ───────────────────────────────
  // The same machinery DemoPage uses, wrapping the story's TimeController.
  // Every beat's time jump commits through governor.seekTo() — which flushes
  // the old era's stale prefetch and gates resume on the destination's
  // buffered runway — and mid-beat the governor freezes the clock when the
  // runway drains instead of letting the playhead advance into unloaded time.
  // That advance-into-the-void was the story's core jank: the clock ran at the
  // authored rate regardless of what had loaded, so ribbons popped in and out
  // as R2 tiles chased the animation. While gated, the governor keeps the
  // loader's prefetch reaching ahead (setAnimationState), so a gate can fill
  // its own runway. Created INSIDE an effect (not useState) so StrictMode's
  // dev-only remount gets a fresh instance — dispose() is terminal (mirrors
  // DemoPage). The beat's authored speed is kept in a ref as the ceiling the
  // adaptive cap below never exceeds.
  const governorRef = useRef<PlaybackGovernor | null>(null);
  const authoredSpeedRef = useRef((focus.speedDays ?? 8) * (DAY / 1000));
  useEffect(() => {
    const g = new PlaybackGovernor(timeController);
    governorRef.current = g;
    // The tileset may already have arrived (StrictMode remount re-creates the
    // governor but not the layer) — re-attach it.
    if (sourceRef.current) g.setSource(sourceRef.current);
    return () => {
      governorRef.current = null;
      g.dispose();
    };
  }, [timeController]);

  const [coastlines, setCoastlines] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    fetch('/story/land-110m.geojson')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && setCoastlines(j))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The era-switching half of applying a focus: speed + time range + clock. This
  // is what jumps the clock (and thus the resident tile window), so it's the
  // part we defer to the fade trough when cross-dissolving. The camera aim is
  // applied separately and immediately (it never causes a flash).
  const applyFocusTime = useCallback(
    (f: GlobeFocus) => {
      // Per-beat `speedDays` plays at its authored rate — and resets the
      // adaptive cap's ceiling for the new beat. (The old global
      // PLAYBACK_SLOWDOWN ÷2 — added so R2 loading could keep up — is gone:
      // the governor gates/stalls honestly and the cap slows gracefully.)
      const speed = (f.speedDays ?? 8) * (DAY / 1000); // sim-ms per real-ms
      authoredSpeedRef.current = speed;
      timeController.setSpeed(speed);
      let target: number;
      if (f.mode === 'sweep' && f.sweep) {
        timeController.setTimeRange(f.sweep);
        target = f.sweep.start;
      } else if (f.mode === 'still') {
        timeController.setTimeRange({ start: f.time - 5 * DAY, end: f.time + 5 * DAY });
        target = f.time;
      } else {
        // drift / spin — play forward from the beat's moment to the end of the
        // archive, then hold. No loop, so no reset/snap; the drift simply unfolds
        // chronologically. (`start` only bounds the lower clamp, which forward
        // playback never reaches.)
        timeController.setTimeRange({ start: f.time, end: DATA_END });
        target = f.time;
      }
      // Commit the jump through the governor: flushes the old era's stale
      // prefetch (it must not compete with the destination for the request
      // pool) and — when playback is intended — re-gates on the new runway.
      const g = governorRef.current;
      if (g) g.seekTo(target);
      else timeController.setTime(target);
    },
    [timeController],
  );
  // rAF reads the latest applyFocusTime via a ref so the loop need not restart.
  const applyFocusTimeRef = useRef(applyFocusTime);
  applyFocusTimeRef.current = applyFocusTime;

  // ── Apply a focus: aim the camera now; switch the era now or via a fade. ────
  useEffect(() => {
    targetRef.current = { longitude: focus.lng, latitude: focus.lat, zoom: focus.zoom };
    spinRateRef.current =
      focus.mode === 'spin' ? FAST_SPIN : focus.mode === 'sweep' ? SWEEP_SPIN : IDLE_SPIN;
    settledRef.current = false; // fly to the new beat before resuming the gentle drift

    // How far the clock is about to jump from where it actually is right now,
    // and the resident tile window the destination beat will use. We only
    // cross-dissolve when the jump fully clears that window — i.e. NONE of the
    // currently-loaded buckets cover the new trail, so the layer would otherwise
    // blank entirely (e.g. 1985→1981, 2014→2010, 2010→2016). A smaller reset —
    // such as the slight backward nudge between the all-2016 currents beats once
    // the playhead has drifted forward — keeps enough overlap to avoid a visible
    // gap, so it applies instantly and the globe never blinks.
    const targetTime = focus.mode === 'sweep' && focus.sweep ? focus.sweep.start : focus.time;
    const jump = Math.abs(targetTime - timeController.getTime());
    const targetWindowMs = Math.max(
      dataset?.timeWindow ?? 200 * DAY,
      (focus.trailDays ?? 90) * DAY * 2,
    );

    // Cross-dissolve only for a real era jump while the globe is already on
    // screen. The first reveal out of an interlude is masked by the stage's own
    // 600ms CSS opacity fade, so it applies immediately.
    if (
      !reducedMotionRef.current &&
      mountedRef.current &&
      activeRef.current &&
      prevActiveRef.current &&
      jump > targetWindowMs
    ) {
      pendingFocusRef.current = focus; // commit at the fade trough
      fadeStateRef.current = 'out';
      opacityTargetRef.current = 0;
    } else {
      applyFocusTime(focus);
      pendingFocusRef.current = null;
      fadeStateRef.current = 'idle';
      opacityTargetRef.current = TARGET_OPACITY;
      opacityRef.current = TARGET_OPACITY;
      lastSetOpacityRef.current = TARGET_OPACITY;
      setDriftersOpacity(TARGET_OPACITY);
    }
    // Reduce-motion: the rAF easing loop is disabled, so snap the camera to the
    // beat's framing right here (instead of flying to it) and mark it settled.
    if (reducedMotionRef.current) {
      camRef.current = { longitude: focus.lng, latitude: focus.lat, zoom: focus.zoom };
      settledRef.current = true;
      setViewState({
        globe: { longitude: focus.lng, latitude: focus.lat, zoom: focus.zoom, pitch: 0, bearing: 0 },
      });
    }
    mountedRef.current = true;
    // Play/pause is reconciled by the `active` effect below.
  }, [focus, timeController, applyFocusTime, dataset]);

  // ── Pause when covered (saves GPU); resume per mode when revealed. ──────────
  // Intent routes through the governor so a resume is runway-gated (and a real
  // pause drops the loader to its paused budget) instead of free-running.
  useEffect(() => {
    const g = governorRef.current;
    // Reduce-motion: never autoplay — hold the paused snapshot at the beat's
    // moment (applyFocusTime already seeked the clock there).
    if (active && focus.mode !== 'still' && !reducedMotion) {
      if (g) g.requestPlay();
      else timeController.play();
    } else {
      if (g) g.requestPause();
      else timeController.pause();
      if (focus.mode === 'still') timeController.setTime(focus.time);
    }
    // Remember the revealed state for the next focus change: a within-act beat
    // change (was active, still active) cross-dissolves; a first reveal does not.
    prevActiveRef.current = active;
  }, [active, focus, timeController, reducedMotion]);

  // ── Adaptive speed cap (see the constants block above). ─────────────────────
  // Only adapts during steady 'playing' — never while a gate holds the clock
  // (the gate's own predictor decides readiness at the authored speed), so
  // every evaluation here is the 'cadence' phase: the story has no
  // gate-entry ('waiting') trigger by design. A null suggestion means cost or
  // throughput is genuinely unknown → hold the current rate (a fully-buffered
  // horizon now suggests Infinity, which clamps to the authored speed — the
  // old "null → drift back to authored" reading). The authored speed is the
  // base: prev/raw fractions are speed ÷ authored, and `applyFocusTime`'s
  // per-beat setSpeed(authored) resets the fraction to 1 for each new beat.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const g = governorRef.current;
      if (!g || g.state !== 'playing') return;
      const authored = authoredSpeedRef.current;
      if (authored <= 0) return;
      const suggestion = g.getAutoSpeedSuggestion();
      if (suggestion == null) return; // unknown cost/throughput → hold
      const current = timeController.getSpeed();
      const next = decideAutoSpeedMultiplier(
        current > 0 ? current / authored : 1,
        suggestion / authored,
        'cadence',
        {
          steps: AUTO_CAP_STEPS,
          minMultiplier: AUTO_CAP_MIN_FACTOR,
          maxMultiplier: 1,
          upshiftDeadband: AUTO_CAP_UPSHIFT_DEADBAND,
        },
      );
      if (next == null) return; // hold (same rung, or a damped upshift)
      timeController.setSpeed(authored * next);
    }, AUTO_CAP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, timeController]);

  // ── Single rAF loop: fly to the target, then keep a gentle rotation going. ──
  // The continuous (imperceptible) drift keeps `viewState` changing every frame,
  // which keeps deck.gl's React wrapper on its even, every-frame repaint clock —
  // so the time-based drifter trails animate smoothly instead of stuttering on a
  // frozen camera. `FAST_SPIN`/`IDLE_SPIN` are the dial: faster on the
  // hero/planetary "spin" beats, barely-there on located beats.
  useEffect(() => {
    // Reduce-motion: no easing/spin/cross-dissolve loop — the focus effect
    // snaps the camera and the clock holds a static frame.
    if (!active || reducedMotion) return;
    let raf = 0;
    let last: number | null = null;
    const tick = (now: number) => {
      const dt = last == null ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      const cur = camRef.current;
      const tgt = targetRef.current;
      const k = 1 - Math.exp(-dt / 0.6); // ease constant (tau ≈ 0.6s)

      // Have we essentially arrived at the beat's framing?
      const dLon = ((tgt.longitude - cur.longitude + 540) % 360) - 180;
      if (
        Math.abs(dLon) + Math.abs(tgt.latitude - cur.latitude) + Math.abs(tgt.zoom - cur.zoom) <
        0.25
      ) {
        settledRef.current = true;
      }

      let longitude: number;
      if (settledRef.current) {
        // Arrived → perpetual rotation at the beat's rate (also keeps deck's
        // paint cycle alive so the trails animate).
        longitude = ((cur.longitude + spinRateRef.current * dt + 540) % 360) - 180;
      } else {
        // Flying in.
        longitude = easeAngle(cur.longitude, tgt.longitude, k);
      }
      // lat/zoom always ease toward (and hold at) the target.
      const latitude = cur.latitude + (tgt.latitude - cur.latitude) * k;
      const zoom = cur.zoom + (tgt.zoom - cur.zoom) * k;

      camRef.current = { longitude, latitude, zoom };
      setViewState({ globe: { longitude, latitude, zoom, pitch: 0, bearing: 0 } });

      // ── Ribbon cross-dissolve across an era jump. ──────────────────────────
      let op = opacityRef.current;
      const ko = 1 - Math.exp(-dt / FADE_TAU);
      op += (opacityTargetRef.current - op) * ko;

      const phase = fadeStateRef.current;
      if (phase === 'out' && op <= 0.06) {
        // Trough reached → commit the deferred era jump while invisible, then
        // hold black until the new era's tiles arrive.
        op = 0;
        if (pendingFocusRef.current) {
          applyFocusTimeRef.current(pendingFocusRef.current);
          pendingFocusRef.current = null;
        }
        jumpWallRef.current = now;
        lastGateCheckRef.current = 0; // first readiness check runs immediately
        fadeStateRef.current = 'wait';
      } else if (phase === 'wait') {
        // Fade back in once the destination era is genuinely ready. The
        // governor's post-seek gate is the oracle: the trough's seekTo put it
        // in 'seeking' (or 'starting'/'buffering'), and 'playing' means the
        // gate passed — including its canplaythrough predictor, so a fast
        // network releases without waiting for a speed-scaled runway. When
        // the governor is idle (a 'still' beat, or intent dropped) fall back
        // to the direct runway query, then to the legacy "a tile loaded since
        // the jump" heuristic; a hard timeout backstops a stalled or errored
        // load so the globe is never left dark.
        if (now - lastGateCheckRef.current >= FADE_GATE_CHECK_INTERVAL_MS) {
          lastGateCheckRef.current = now;
          const governor = governorRef.current;
          const source = sourceRef.current;
          let ready: boolean;
          if (governor && governor.state !== 'idle') {
            ready = governor.state === 'playing';
          } else if (source) {
            const speed = timeController.getSpeed();
            const requiredSimMs = FADE_GATE_WALL_MS * Math.abs(speed);
            const runway = source.getBufferedRunway(
              timeController.getTime(),
              speed < 0 ? -1 : 1,
              requiredSimMs,
            );
            ready = runway.complete || runway.simMs >= requiredSimMs;
          } else {
            ready =
              lastTileLoadRef.current > jumpWallRef.current &&
              now - jumpWallRef.current > 180;
          }
          if (ready || now - jumpWallRef.current > FADE_WAIT_MAX_MS) {
            opacityTargetRef.current = TARGET_OPACITY;
            fadeStateRef.current = 'in';
          }
        }
      } else if (phase === 'in' && op >= TARGET_OPACITY - 0.01) {
        op = TARGET_OPACITY;
        fadeStateRef.current = 'idle';
      }
      opacityRef.current = op;
      // Push to React as a CSS opacity on the deck container (cheap — no layer
      // recreation). Quantize lightly so an at-rest globe (op === target) never
      // fires a setState, while a fade stays visually smooth.
      const q = Math.round(op * 100) / 100;
      if (q !== lastSetOpacityRef.current) {
        lastSetOpacityRef.current = q;
        setDriftersOpacity(q);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, timeController, reducedMotion]);

  const views = useMemo(() => [new GlobeView({ id: 'globe', resolution: 10 })], []);

  // Record tile arrivals (same clock as the rAF `now`) so the no-source
  // fallback of the cross-dissolve can fade back in when the destination era
  // starts streaming.
  const handleTileLoad = useCallback(() => {
    lastTileLoadRef.current = performance.now();
  }, []);

  // Capture the tileset (the BufferSource) once the layer finishes archive
  // init and hand it to the governor — this is what makes gating a real
  // runway signal instead of a tile-load guess. Defensive method check so a
  // core build without the buffering API keeps the legacy fallback.
  const handleTilesetReady = useCallback((tileset: BufferSource) => {
    const source =
      typeof tileset.getBufferedRunway === 'function' ? tileset : null;
    sourceRef.current = source;
    governorRef.current?.setSource(source);
  }, []);

  // Buffer-runway events route into the governor for immediate gate/stall
  // evaluation (instead of waiting for its 250 ms polling cadence).
  const handleBufferChange = useCallback((runway: BufferedRunway) => {
    governorRef.current?.notifyBufferChange(runway);
  }, []);

  // Trail length is purely an aesthetic choice per beat — NOT a data-limiting
  // lever. We deliberately do not clamp the time range or thin the data: the
  // whole point of the tile format is that the full archive streams. The tile
  // window simply tracks the trail (the loader needs ~2× the trail to keep the
  // comet's tail resident); the dataset's own 200-day window is the floor. With
  // forward-only playback the window slides ahead with the head and prefetch
  // follows, so no extra residency is needed to stay flash-free.
  const trailMs = (focus.trailDays ?? 90) * DAY;
  const windowMs = Math.max(dataset?.timeWindow ?? 200 * DAY, trailMs * 2);

  const layers = useMemo(() => {
    if (!dataset) return [];
    const g = dataset.tripGradient;
    const built: any[] = [
      new SolidPolygonLayer({
        id: 'story-earth',
        data: EARTH_POLYGON,
        getPolygon: (d: any) => d,
        stroked: false,
        filled: true,
        getFillColor: OCEAN_SPHERE,
      }),
    ];
    if (coastlines) {
      built.push(
        new GeoJsonLayer({
          id: 'story-land',
          data: coastlines,
          stroked: false,
          filled: true,
          getFillColor: LAND_FILL,
          parameters: { depthTest: false } as any,
        }),
      );
    }
    built.push(
      new AnimatedTripsLayer({
        id: 'story-drifters',
        data: dataset.url,
        currentTime: focus.time,
        timeController,
        // Same loading recipe as every other surface (see tileLoadingProps +
        // the story-wide budget constants above). The per-beat `timeWindow`
        // still threads live below — only the prefetch/concurrency budget has
        // to be the story-wide ceiling, because the tileset freezes it at
        // creation.
        ...tileLoadingProps(
          Math.max(dataset.timeWindow ?? 200 * DAY, MAX_TRAIL_MS * 2),
          MAX_PLAYBACK_SPEED,
        ),
        timeWindow: windowMs,
        timeRange: DATA_TIME_RANGE,
        useGlobalBounds: true,
        zoomOverride: 0,
        ...(g && {
          gradientProperty: g.property,
          gradientDomain: g.domain,
          gradientColorRamp: g.colors,
        }),
        ...(dataset.colorMappingDefault && { colorMappingDefault: dataset.colorMappingDefault }),
        tripWidth: 1.6,
        widthMinPixels: 1,
        widthMaxPixels: 3.5,
        trailLength: trailMs,
        fadeTrail: true,
        opacity: RIBBON_OPACITY,
        // The cross-dissolve is applied as CSS opacity on the deck container
        // (see the ERA_JUMP comment), NOT via this layer's `opacity` prop:
        // changing a layer prop recreates the instance every frame and wipes
        // this layer's per-tile prepared/gradient caches. `onTilesetReady`
        // hands the governor (and the fade gate) its runway oracle;
        // `onBufferChange` triggers immediate gate/stall evaluation;
        // `onTileLoad` only feeds the gate's no-source fallback.
        onTilesetReady: handleTilesetReady,
        onBufferChange: handleBufferChange,
        onTileLoad: handleTileLoad,
        pickable: false,
      }),
    );

    // Geographic anchor markers for "located" beats — a soft glow, a solid
    // core, and a label. Stable layer ids + data-only updates so scrolling
    // between beats never churns layer objects (empty data renders nothing).
    const markers = focus.markers ?? [];
    const rgb = (m: GlobeMarker) => TONE[m.tone ?? 'gold'];
    built.push(
      new ScatterplotLayer({
        id: 'story-marker-glow',
        data: markers,
        getPosition: (m: GlobeMarker) => [m.lng, m.lat],
        getRadius: 9,
        radiusUnits: 'pixels',
        getFillColor: (m: GlobeMarker) => [...rgb(m), 60] as any,
        stroked: false,
        updateTriggers: { getFillColor: markers },
        parameters: { depthTest: false } as any,
      }),
      new ScatterplotLayer({
        id: 'story-marker-core',
        data: markers,
        getPosition: (m: GlobeMarker) => [m.lng, m.lat],
        getRadius: 3.5,
        radiusUnits: 'pixels',
        getFillColor: (m: GlobeMarker) => [...rgb(m), 255] as any,
        stroked: true,
        getLineColor: [255, 255, 255, 230],
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        updateTriggers: { getFillColor: markers },
        parameters: { depthTest: false } as any,
      }),
      new TextLayer({
        id: 'story-marker-text',
        data: markers,
        getPosition: (m: GlobeMarker) => [m.lng, m.lat],
        getText: (m: GlobeMarker) => m.label,
        getSize: 13,
        getColor: [244, 241, 234, 255],
        getPixelOffset: [12, -2],
        getTextAnchor: 'start',
        getAlignmentBaseline: 'center',
        fontFamily: 'Newsreader, Georgia, serif',
        fontWeight: 500,
        outlineWidth: 3,
        outlineColor: [6, 10, 20, 220],
        fontSettings: { sdf: true },
        updateTriggers: { getText: markers },
        parameters: { depthTest: false } as any,
      }),
    );
    return built;
    // NOTE: driftersOpacity is deliberately NOT a dep — the cross-fade is CSS on
    // the container, so the layer instance (and its tile caches) stays stable.
  }, [
    dataset,
    coastlines,
    trailMs,
    windowMs,
    focus.markers,
    timeController,
    handleTileLoad,
    handleTilesetReady,
    handleBufferChange,
  ]);

  if (!dataset) return null;

  return (
    // `driftersOpacity` cross-dissolves the globe across an era jump (GPU-
    // composited, so the deck layers and their tile caches stay untouched). It
    // sits at TARGET_OPACITY at rest, so steady drift renders at full strength.
    <div className="map-viewport" style={{ opacity: driftersOpacity }}>
      <DeckGL
        views={views}
        viewState={viewState}
        controller={false}
        layers={layers}
        parameters={{ cull: true } as any}
        style={{ background: 'transparent' }}
      />
    </div>
  );
};

export default StoryGlobe;
