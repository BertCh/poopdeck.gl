/**
 * Path geometry adapter — multi-vertex LINESTRING polylines that ink themselves
 * in along their own length. The maplibre analogue of deck's
 * `AnimatedPathLayer`, and the home of the `path` kind.
 *
 * ── WHAT IT RENDERS ─────────────────────────────────────────────────────────
 * A tile of LINESTRING features with an arbitrary vertex count per feature —
 * routes, flight tracks, lane centrelines, iso-contours, GPS traces. Each
 * feature contributes `vertexCount - 1` screen-space thick segments, and (with
 * `revealTrail`) the whole polyline is progressively DRAWN up to the play head:
 * the segments behind the frontier are complete, the frontier segment is drawn
 * PARTIALLY — its far endpoint interpolated to wherever the play head sits
 * inside it — and the segments ahead are not drawn at all. The per-vertex times
 * that place the frontier come from the tile's baked `vertexTimestamps` when it
 * has them, and otherwise from the shared cumulative-DISTANCE kernel
 * (`@poopdeck.gl/core/trips` `synthesizeVertexTimes`), so a 100 km leg takes
 * proportionally longer to ink than a 100 m stub — never from vertex INDEX,
 * which would flash the long leg past at the stub's rate.
 *
 * ── WHY THIS IS A SUBCLASS AND NOT A SECOND RENDERER ────────────────────────
 * An OD line is a 2-vertex LineString; a path is THE SAME PRIMITIVE with more
 * vertices. `STTLineLayer` never had a 2-vertex assumption anywhere: it walks
 * `startIndices` per feature, emits one instanced quad per consecutive vertex
 * PAIR, subdivides those chords on globe frames, expands the per-FEATURE colour
 * / width / DataFilter columns across each feature's own segment count, and
 * expands pick ids the same way. It also already carries deck
 * `AnimatedPathLayer`'s reveal machinery verbatim (`revealTrail` /
 * `revealDuration` / `fadeTrail` / `reducedMotion`, the `sttRevealSpan` kernel,
 * the interpolated frontier endpoint, the per-INSTANCE geometry collapse) —
 * because there was no `path` class to put it on.
 *
 * So the `path` kind was never a capability gap in this backend; it was a
 * NAMING gap. The descriptor said `path: unsupported` and simultaneously
 * claimed `pathReveal` on `line`, with a comment conceding the feature belongs
 * to the path kind. This class is that honesty fix: it gives the kind its name,
 * its deck-parity defaults, and the one behaviour the line layer really was
 * missing (below) — and it does NOT fork a second copy of the shader assembly,
 * the reveal math, the globe subdivision or the pick expansion. Every one of
 * those is inherited, so a fix to either kind is a fix to both, which is the
 * whole point of not forking.
 *
 * Deck draws the same conclusion from the other side: its `AnimatedLineLayer`
 * (the `line` kind) is WINDOW-MODE ONLY — no wake, no trail, no reveal — while
 * `AnimatedPathLayer` (the `path` kind) is where progressive reveal lives.
 *
 * ── WHAT THIS CLASS CHANGES ─────────────────────────────────────────────────
 *  1. **`width` defaults to 3, not 2.** Verbatim from deck's
 *     `DEFAULT_PATH_WIDTH`, and a deliberate drift from the OD-line default
 *     the way deck drifts (`AnimatedLineLayer.width` 1 → `AnimatedPathLayer.
 *     pathWidth` 3): in the `'pixels'` units both kinds default to, a hairline
 *     path all but disappears on a HiDPI display, and a path is usually the
 *     subject of the map rather than a connector drawn between two dots.
 *     Everything else deck's two layers spell differently is spelled the SAME
 *     in deck (colour, palette, width units, width scale, fade durations,
 *     `revealTrail: false`, `revealDuration: 0`, `fadeTrail: true`,
 *     `reducedMotion: false`) — so re-defaulting any of those here would invent
 *     a divergence deck does not have, and this class deliberately does not.
 *
 *  2. **The reveal's tile-LOAD window** — {@link STTPathLayer.timeModeLoadKnobs}.
 *     This is the one REAL gap. The reveal shader lights every vertex within
 *     `revealDuration` ms behind the play head (or, at `revealDuration: 0`,
 *     every vertex it has ever passed), but tile SELECTION was still sized off
 *     `timeWindow` alone: `STTLineLayer` never overrode `timeModeLoadKnobs`, so
 *     the base read the RAW option bag, found `timeFilterMode: undefined` and
 *     no explicit lengths, inferred plain window mode and widened by nothing.
 *     A 60 s reveal over a 5 s window therefore had its tail evicted out from
 *     under it while the shader was still asking for it — the tiles behind the
 *     head unload and the "drawn" ink vanishes, which reads as flicker rather
 *     than as missing data. deck's `AnimatedPathLayer.getEffectiveTimeWindow`
 *     widens to `2 × revealDuration` for exactly this reason; the override here
 *     is the port, expressed through the base hook so it composes as a `Math.max`
 *     floor with `tileLoadTimeWindow` instead of fighting it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *  - **Joints and caps.** Every segment is an independent extruded quad, so a
 *    wide multi-vertex path shows a notch at each interior joint where deck's
 *    `PathLayer` would mitre or round one (`jointRounded` / `capRounded` /
 *    `miterLimit`). Invisible at the default 3 px, obvious at 20. Closing it
 *    needs the neighbour-of-neighbour vertex per instance and a joint wedge —
 *    a change to the SHARED extrusion in `buildLineVertexSource`, which would
 *    benefit both kinds and belongs there, not in a fork here.
 *  - **`elevationProperty` / `elevationMapping` / height-graded opacity.** deck
 *    lifts a whole path to a per-feature altitude for stacked contour reliefs.
 *    The shared line vertex source is 2d content projected through
 *    `projectTile` (z overwritten for horizon clipping); a real lift needs
 *    `projectTileFor3D` + `buildElevatedProjection` + a `'3d'` renderingMode.
 *    Also a shared-renderer change, also not forked here.
 *  - **`widthMinPixels` / `widthMaxPixels`.** No clamp exists on the shared
 *    width path; a metric width shrinks without floor as you zoom out.
 *  - **`pathType: 'loop'`.** Ring closure is a tessellator concept; this
 *    backend emits one quad per vertex pair and closes nothing.
 *
 * Everything else the kind owes — all four time-filter modes from the shared
 * `shaders/time-window.glsl.ts` kernels with the standard degradation, the
 * DataFilter branch, `widthUnits: 'meters'`, globe chord subdivision and id-FBO
 * picking whose gates exactly match the visual pass — is inherited intact.
 */

import {
  STTLineLayer,
  buildLineVertexSource,
  REVEAL_PERSIST_TRAIL_MS,
  resolveRevealTrailLength,
  type LineCompiledMode,
  type LineVertexVariant,
  type STTLineLayerOptions,
} from './line-layer.js';
import type { STTTimeFilterMode, TimeModeLoadKnobs } from '../base-layer.js';

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's own name.
 */
export type PathTimeFilterMode = STTTimeFilterMode;

/**
 * What the SHADER compiles for this kind: the four time-filter modes plus
 * `'reveal'`. Re-exported from the line renderer under the path kind's name —
 * the same union, because it is the same program builder.
 */
export type PathCompiledMode = LineCompiledMode;

/** Compile-time shader configuration — see {@link LineVertexVariant}. */
export type PathVertexVariant = LineVertexVariant;

/**
 * Default path width in {@link STTPathLayerOptions.widthUnits}. Verbatim from
 * deck `AnimatedPathLayer`'s `DEFAULT_PATH_WIDTH`, and deliberately WIDER than
 * the OD-line kind's 2 — see the module header, point 1.
 */
export const DEFAULT_PATH_WIDTH = 3;

/**
 * Options for {@link STTPathLayer}. Structurally the line renderer's option
 * surface (this kind IS that renderer, configured for paths), with `width`
 * redeclared to carry the path-oriented default.
 */
export interface STTPathLayerOptions extends STTLineLayerOptions {
  /**
   * Path width, in {@link STTLineLayerOptions.widthUnits}. Ignored when
   * `widthProperty` is set (it becomes that column's fallback).
   *
   * DEFAULT DRIFT vs. the `line` kind's 2: {@link DEFAULT_PATH_WIDTH} (3),
   * deck's `AnimatedPathLayer` default. deck drifts the same way and for the
   * same reason (`AnimatedLineLayer` 1 → `AnimatedPathLayer` 3): a hairline in
   * screen pixels all but disappears on a HiDPI display, and a path is usually
   * the subject of the map rather than a connector between two dots.
   *
   * @default 3
   */
  width?: number;
}

/**
 * Assemble a path vertex shader.
 *
 * This IS {@link buildLineVertexSource} — an alias, not a wrapper and not a
 * copy. Exported under the path kind's name so the descriptor conformance gate
 * (and any host reproducing a program key) can address the path kind by its own
 * vocabulary without either backend pretending there are two implementations of
 * the extrusion, the projection variants, the time kernels or the reveal
 * clipping. A path's shader differs from an OD line's in exactly nothing: both
 * are one instanced quad per consecutive vertex pair.
 */
export const buildPathVertexSource = buildLineVertexSource;

/**
 * Resolve the compiled time-filter mode from the option surface — the package's
 * standard degradation rule, under the path kind's name.
 *
 * `'wake'` / `'trail'` degrade to `'window'` when their length knob is
 * non-positive, because both kernels return 0 for a degenerate length and a
 * mode kept in that state would draw nothing at all (deck's
 * `TimeFilterExtension` enters those branches only for a positive length and
 * otherwise falls through to its window branch).
 *
 * ONE DELIBERATE DIFFERENCE from the template rule: an UNSET mode resolves to
 * `'window'` here rather than inferring `wake`/`trail` from the length knobs.
 * The template's inference assumes the knobs are OFF unless a caller set them;
 * this kind inherits the line renderer's window-derived DEFAULTS, where both
 * lengths default to `timeWindow / 2` (> 0 for any real window), so an
 * inferring branch would put EVERY path layer into wake mode by construction.
 * deck arrives at the same place from the other side: `AnimatedPathLayer` ships
 * no wake/trail props at all, so an unset mode there is window by definition.
 *
 * Exported so the prop-default tests can hold the layer to it rather than to a
 * restatement of the layer's own code.
 */
export function resolvePathTimeFilterMode(
  mode: PathTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): PathTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  return 'window';
}

/**
 * MapLibre custom layer that renders STT path tiles — multi-vertex LineString
 * polylines, optionally revealed progressively along their own length.
 *
 * ```ts
 * const layer = new STTPathLayer({
 *   id: 'routes',
 *   url: '/data/flights.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 60_000,
 *   revealTrail: true,      // ink each path in as the play head crosses it
 *   revealDuration: 30_000, // …and erase 30 s behind the head
 * });
 * map.addLayer(layer);
 * setInterval(() => layer.setCurrentTime(Date.now()), 16);
 * ```
 *
 * See the module header for what this adds to {@link STTLineLayer} and, just as
 * importantly, for what it deliberately shares with it.
 */
export class STTPathLayer extends STTLineLayer {
  /** Gate for {@link warnRevealPersistLoadWindow} — one warning per layer. */
  private revealPersistWarned = false;

  constructor(opts: STTPathLayerOptions) {
    // The default is applied AFTER the spread, never before it: a caller
    // forwarding React props as `{...base, width: props.width}` hands us an
    // explicit `width: undefined` as an own key, and `??` is what still lets
    // that reach the default. (A `{width: 3, ...opts}` spread would not.)
    super({ ...opts, width: opts.width ?? DEFAULT_PATH_WIDTH });
  }

  /**
   * The RESOLVED time-mode knobs the tile-LOAD window is sized against.
   *
   * Overridden for two reasons the base's raw-option-bag default cannot cover:
   *
   *  1. This kind's lengths are DEFAULTED and its mode DEGRADED (both off
   *     `timeWindow`, in the line renderer's `resolveTimeConfig`), so the raw
   *     option bag says `undefined` where the shader is actually running a
   *     resolved value. Reporting the resolved pair is what the base hook's
   *     contract asks for.
   *  2. Path reveal is a fifth compiled mode the base vocabulary has no name
   *     for, and it is the case that was actually broken: the reveal shader
   *     lights `revealDuration` ms of history behind the head while selection
   *     was sized on `timeWindow` alone, so the tiles holding that history were
   *     evicted while the shader still wanted them.
   *
   * Reveal maps onto the base vocabulary exactly:
   *
   *  - a FINITE `revealDuration` is a `'trail'` of that length ⇒ `2 ×
   *    revealDuration` of symmetric load window (the loader's window straddles
   *    the head, so only half of it lies in the past). deck's
   *    `AnimatedPathLayer.getEffectiveTimeWindow` widens by the same factor.
   *  - `revealDuration: 0` (PERSIST — keep every vertex the head has passed) is
   *    `'cumulative'`: same shape, same requirement, and the base already sizes
   *    cumulative against the dataset's own `timeRange` (`2 × span`, which from
   *    ANY head position reaches back to the range start). deck cannot do this
   *    — its reveal is not its cumulative mode — and warns instead; here the
   *    mechanism already exists, so persist gets a correct finite answer
   *    WHENEVER the caller supplied `timeRange`, and the warning is kept for
   *    when they did not (nothing else can bound "forever").
   *
   * Every widening is a FLOOR composed by `Math.max`, so an explicit
   * `tileLoadTimeWindow` can only raise the result, never be undercut by it.
   */
  protected timeModeLoadKnobs(): TimeModeLoadKnobs {
    const o = this.lineOpts;
    const mode = o.timeFilterMode;
    if (mode !== 'reveal') {
      // The DEGRADED mode and the RESOLVED lengths — what the shader compiled,
      // not what the caller typed.
      return {
        mode,
        wakeLength: o.wakeLength,
        trailLength: o.trailLength,
      };
    }
    // `resolveRevealTrailLength` is the shader's own answer; a finite duration
    // comes back verbatim, and persist comes back as the 250-year sentinel,
    // which is precisely the value no load window can (or should) chase.
    const trailLength = resolveRevealTrailLength(o.revealDuration);
    if (trailLength !== REVEAL_PERSIST_TRAIL_MS) {
      return { mode: 'trail', trailLength };
    }
    if (this.opts.timeRange) return { mode: 'cumulative' };
    this.warnRevealPersistLoadWindow();
    return { mode: 'window' };
  }

  /**
   * Persistence is a SHADER property, not a tile-residency one. With
   * `revealDuration: 0` and neither a `timeRange` (which would let the base
   * size the window like `'cumulative'`) nor an explicit `tileLoadTimeWindow`,
   * nothing bounds how far back the loader must keep tiles resident — so the
   * revealed ink WILL disappear mid-playback once the head is more than
   * `timeWindow / 2` past a feature. Say so once, with the two ways out. deck's
   * `AnimatedPathLayer` warns at the same point for the same reason.
   */
  private warnRevealPersistLoadWindow(): void {
    if (this.revealPersistWarned) return;
    const load = this.opts.tileLoadTimeWindow;
    if (load !== undefined && load > 0) return;
    this.revealPersistWarned = true;
    console.warn(
      `[${this.id}] revealTrail with revealDuration:0 persists the revealed ` +
        `path in the SHADER, but tile selection still follows timeWindow — a ` +
        `feature more than timeWindow/2 behind the play head has its tile ` +
        `evicted and its "persisted" ink vanishes mid-playback. Pass ` +
        `timeRange (the loader then keeps the whole played-through range, as ` +
        `in cumulative mode) or set tileLoadTimeWindow to the span you want ` +
        `to keep on screen; the render window is unaffected either way.`,
    );
  }
}
