import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { _GlobeView as GlobeView } from '@deck.gl/core';
import {
  SolidPolygonLayer,
  GeoJsonLayer,
  ScatterplotLayer,
  TextLayer,
} from '@deck.gl/layers';
import { AnimatedTripsLayer, TimeController } from '@stt/deck.gl';
import { getDatasetById } from '../../datasets';
import { DAY, DATA_START, DATA_END, type GlobeFocus, type GlobeMarker } from '../../content/drifterStory';

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
// trough (invisibly), HOLD black until the new era's tiles actually load (or a
// timeout), then fade back in — so the eras cross-dissolve over a flying camera,
// reading as a deliberate scene cut. The fade is a GPU-composited CSS opacity on
// the deck container (not the layer's own `opacity` prop), so the layers and
// their per-tile caches are never recreated — the dissolve stays smooth. We
// trigger it ONLY when the jump fully clears the resident tile window (otherwise
// enough tiles overlap that nothing blanks — see the focus effect).
const RIBBON_OPACITY = 0.9; // the drifter layer's own (intrinsic) opacity
const TARGET_OPACITY = 1; // globe-container opacity at rest (the fade rides 1→0→1)
const FADE_TAU = 0.12; // globe fade ease constant (s) — ~0.35s each direction
// Max hold at black before fading in regardless of load. Caps the dark moment
// when the destination era is already cached (a scroll-back) and `onTileLoad`
// never fires; for the common uncached case the load signal fades in sooner.
const FADE_WAIT_MAX_MS = 850;

// Full temporal extent of the drifters archive (Unix ms), from the story
// content. Drift/spin beats play FORWARD from the beat's moment to DATA_END and
// then hold — no looping, no reset — so the drift just unfolds chronologically
// and reads as calm. Forward playback is also the always-smooth tile-loading
// direction (prefetch is aimed the way the head moves), so it never flashes.
const DATA_TIME_RANGE: { start: number; end: number } = { start: DATA_START, end: DATA_END };

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
      const speed = (f.speedDays ?? 8) * (DAY / 1000); // sim-ms per real-ms
      timeController.setSpeed(speed);
      if (f.mode === 'sweep' && f.sweep) {
        timeController.setTimeRange(f.sweep);
        timeController.setTime(f.sweep.start);
      } else if (f.mode === 'still') {
        timeController.setTimeRange({ start: f.time - 5 * DAY, end: f.time + 5 * DAY });
        timeController.setTime(f.time);
      } else {
        // drift / spin — play forward from the beat's moment to the end of the
        // archive, then hold. No loop, so no reset/snap; the drift simply unfolds
        // chronologically. (`start` only bounds the lower clamp, which forward
        // playback never reaches.)
        timeController.setTimeRange({ start: f.time, end: DATA_END });
        timeController.setTime(f.time);
      }
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
    mountedRef.current = true;
    // Play/pause is reconciled by the `active` effect below.
  }, [focus, timeController, applyFocusTime, dataset]);

  // ── Pause when covered (saves GPU); resume per mode when revealed. ──────────
  useEffect(() => {
    if (active && focus.mode !== 'still') {
      timeController.play();
    } else {
      timeController.pause();
      if (focus.mode === 'still') timeController.setTime(focus.time);
    }
    // Remember the revealed state for the next focus change: a within-act beat
    // change (was active, still active) cross-dissolves; a first reveal does not.
    prevActiveRef.current = active;
  }, [active, focus, timeController]);

  // ── Single rAF loop: fly to the target, then keep a gentle rotation going. ──
  // The continuous (imperceptible) drift keeps `viewState` changing every frame,
  // which keeps deck.gl's React wrapper on its even, every-frame repaint clock —
  // so the time-based drifter trails animate smoothly instead of stuttering on a
  // frozen camera. `FAST_SPIN`/`IDLE_SPIN` are the dial: faster on the
  // hero/planetary "spin" beats, barely-there on located beats.
  useEffect(() => {
    if (!active) return;
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
        fadeStateRef.current = 'wait';
      } else if (phase === 'wait') {
        // Fade back in once a tile has loaded since the jump (the new era is
        // streaming in) — with a short settle so several buckets batch — or a
        // hard timeout so a stalled/errored load never leaves it dark.
        const loaded =
          lastTileLoadRef.current > jumpWallRef.current && now - jumpWallRef.current > 180;
        if (loaded || now - jumpWallRef.current > FADE_WAIT_MAX_MS) {
          opacityTargetRef.current = TARGET_OPACITY;
          fadeStateRef.current = 'in';
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
  }, [active]);

  const views = useMemo(() => [new GlobeView({ id: 'globe', resolution: 10 })], []);

  // Record tile arrivals (same clock as the rAF `now`) so the cross-dissolve
  // can fade back in the moment the destination era starts streaming.
  const handleTileLoad = useCallback(() => {
    lastTileLoadRef.current = performance.now();
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
        // Judicious loading for a story: the real lever is GEOMETRY, not the
        // tile pipeline. We keep the proven hero defaults (prefetch ON with its
        // tiny ~30s look-ahead — disabling it left sublayers rendering against
        // not-yet-ready binary and tripped per-tile assertions) and instead cut
        // the per-frame vertex count: short, clamped trails (≤70d, vs the
        // 150–220d that hogged the dense global tile) and a tile window kept
        // just wide enough to cover the trail, so few temporal buckets are ever
        // resident at once.
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
        // this layer's per-tile prepared/gradient caches. `onTileLoad` only
        // feeds the fade-in gate (it waits for the destination era to stream in).
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
  }, [dataset, coastlines, trailMs, windowMs, focus.markers, timeController, handleTileLoad]);

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
