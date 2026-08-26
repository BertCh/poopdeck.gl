/**
 * Iso-contour adapter — LINESTRING tiles whose every visual property is driven
 * by ONE number per feature: the LEVEL the contour traces. The home of the
 * `isoLines` kind.
 *
 * ── WHAT IT RENDERS ─────────────────────────────────────────────────────────
 * A contour map: the 500 hPa height lines of a synoptic chart, the 20/30/40
 * dBZ rings of a storm cell, bathymetric depth curves, a temperature analysis.
 * Geometrically these are ordinary polylines — this class draws them with
 * {@link STTLineLayer}'s instanced segment quads, unchanged. What it adds is
 * the styling grammar a contour map actually has, and that a plain line layer
 * cannot express:
 *
 *  - **Colour from the level**, through a continuous ramp across the level
 *    DOMAIN (`levelProperty` + `colorRange`), not through a categorical
 *    palette. A contour's level is a quantity, not a category.
 *  - **Major-interval emphasis** (`majorInterval`): the levels that fall on
 *    the labelled interval draw heavier (`majorWidthScale`) and the ones
 *    between them draw lighter (`minorOpacity`) — the index-contour convention
 *    every printed contour map uses to stay readable at density.
 *  - **Width from the level** (`widthByLevel` + `widthRange`), optional and
 *    off by default, for charts that grade line weight with magnitude.
 *
 * All three are evaluated in the SHADER, from the `shaders/iso-ramp.glsl.ts`
 * kernel, off uniforms.
 *
 * ── WHY UNIFORMS AND NOT BAKED PER-FEATURE COLOURS ──────────────────────────
 * This is the whole design point, and it is why the kind exists as a class
 * instead of as `colorProperty` advice.
 *
 * The level DOMAIN is a LAYER-WIDE quantity, and it WIDENS as tiles stream in.
 * A tileset is not delivered at once: the first tile to land might carry only
 * the 500–520 dam band, and a tile that arrives three seconds later carries
 * 480–560. If colours were baked into a per-feature buffer at tile upload —
 * which is exactly what {@link STTLineLayer.colorProperty} does, correctly, for
 * CATEGORIES — every tile already resident would keep the colours it was
 * assigned under the narrow domain, and the same 500 hPa contour would render
 * two visibly different colours in two adjacent tiles. Fixing it after the
 * fact would mean invalidating and re-uploading every GPU cache on every
 * domain widening: an O(resident tiles) rebuild triggered by network timing.
 *
 * So the level goes to the GPU as a raw per-instance `aLevel` attribute and
 * the domain goes as `uLevelDomain`. Widening the domain restyles every
 * resident tile in the SAME frame, at the cost of one `uniform2f`, with no
 * cache touched. `majorInterval`, `minorOpacity`, `widthRange` and `opacity`
 * ride the same mechanism, which is what makes them live knobs (a slider a
 * user drags) rather than rebuild triggers.
 *
 * The layer widens the domain itself as it observes tiles, unless the caller
 * PINS it with `levelDomain` — a pinned domain is the right answer whenever
 * the legend is fixed (a published chart's colour key cannot move because a
 * tile arrived).
 *
 * ── WHY THIS IS A SUBCLASS AND NOT A SECOND RENDERER ────────────────────────
 * A contour is a LineString. `STTLineLayer` already extrudes one instanced
 * screen-space quad per consecutive vertex pair, subdivides those chords on
 * globe frames, expands per-feature columns across each feature's own segment
 * count, sizes in metres or pixels, compiles all four shared time kernels, and
 * expands pick ids per feature — for polylines of any vertex count. None of
 * that is re-implemented here, exactly as {@link STTPathLayer} re-implements
 * none of it: the geometry cache is built by `super.buildTileGpuCache` and
 * this class only APPENDS the level buffer to it, and the vertex source is
 * `buildLineVertexSource` with one additional compile-time flag (`iso`) that
 * splices the ramp kernel in. With the flag off, that builder emits the byte
 * for byte identical source it always did — asserted in `test/iso-layer.test.ts`.
 *
 * The one thing this class does own is its DRAW: the level attribute, the ramp
 * uniforms and its own program-cache key (`iso:<pass>:<mode>[:filter]`, which
 * can never collide with the line kind's `line[:pick]:<mode>`) all have to be
 * bound somewhere, and `STTLineLayer`'s draw path is private. That duplication
 * is uniform uploads and attribute binds — never the extrusion math, never the
 * projection variants, never the time kernels, never the pick-id expansion.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *  - **It does not CONTOUR anything.** No marching squares, no field
 *    interpolation. The archive carries contours as LineStrings with a level
 *    column; extracting isolines from a raster is the producer's job
 *    (`stt-build`), where the field actually lives. A GPU-side contourer would
 *    need the scalar field resident, which a vector tile does not carry.
 *  - **It does not label.** Inline level labels along the contour ("500")
 *    are the defining feature of a printed chart and they are TEXT — a glyph
 *    atlas, a placement solver and a collision pass. That is the icon/text
 *    kind's machinery, not this one's.
 *  - **It does not quantise the ramp.** deck's summary layers bucket a ramp
 *    into `colorRange.length` steps; contours are ALREADY a quantisation of
 *    the field, and bucketing them again discards the one continuous signal a
 *    contour map has left. The ramp lerps (see `shaders/iso-ramp.glsl.ts`).
 *  - **It does not fill between contours.** Banded fills are polygons and
 *    belong to the polygon kind; this kind draws the curves.
 *  - **Joints, caps, `widthMinPixels`/`widthMaxPixels`** — inherited gaps from
 *    the shared line renderer, listed in {@link STTPathLayer}'s header. Fixing
 *    them belongs in the shared extrusion, which is why they are not forked
 *    into a special case here.
 *
 * Everything else the kind owes is inherited intact: all four time-filter
 * modes from `shaders/time-window.glsl.ts` with the standard degradation, the
 * DataFilter branch, `widthUnits: 'meters'` metric sizing resolved per tile at
 * that tile's centre latitude, globe chord subdivision, and id-FBO picking
 * whose alpha gates exactly match the visual pass — including the iso ones, so
 * a contour dimmed away by `minorOpacity` or `opacity` is unpickable as well
 * as invisible.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import {
  expandPickIdColors,
  toRgba01,
  type DrawContext,
  type RGBA,
  type RGBA8,
  type STTTimeFilterMode,
  type TileGpuCache,
  type TimeModeLoadKnobs,
} from '../base-layer.js';
import {
  STTLineLayer,
  buildLineVertexSource,
  resolveRevealTrailLength,
  type LineCompiledMode,
  type LineVertexVariant,
  type STTLineLayerOptions,
} from './line-layer.js';
import { createHostFrame, type HostFrame } from '../lib/host-adapter.js';
import {
  resolveTimeUniformLocations,
  resolveWakeTailScaleUniformLocation,
  type TimeUniformLocations,
  type WakeTailScaleUniformLocation,
} from '../shaders/time-window.glsl.js';
import {
  expandFilterValues,
  resolveDataFilterUniformLocations,
  resolveFilterTransformSizeUniformLocation,
  type DataFilterUniformLocations,
  type FilterTransformSizeUniformLocation,
} from '../shaders/data-filter.glsl.js';
import {
  MAX_ISO_RAMP_STOPS,
  fitIsoRamp,
  resolveIsoRampUniformLocations,
  type IsoRampUniformLocations,
} from '../shaders/iso-ramp.glsl.js';

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's own name.
 */
export type IsoTimeFilterMode = STTTimeFilterMode;

/**
 * What the SHADER compiles for this kind: the four time-filter modes plus
 * `'reveal'`. Re-exported from the line renderer under the iso kind's name —
 * the same union, because it is the same program builder.
 */
export type IsoCompiledMode = LineCompiledMode;

/** Compile-time shader configuration — see {@link LineVertexVariant}. */
export type IsoVertexVariant = LineVertexVariant;

/**
 * Default contour width in {@link STTIsoLayerOptions.widthUnits}.
 *
 * Deliberately THINNER than either the OD-line (2) or path (3) default. A
 * contour map's whole visual argument is the SHAPE of a dense family of
 * curves, and at 20 contours crossing a viewport a 3 px stroke is 60 px of ink
 * that closes up the gaps the reader is meant to see. Hierarchy comes from
 * {@link STTIsoLayerOptions.majorInterval} instead: the index contours get
 * {@link DEFAULT_MAJOR_WIDTH_SCALE}× this, which is the printed-chart
 * convention (a heavy labelled line every N levels, hairlines between).
 */
export const DEFAULT_ISO_WIDTH = 1.25;

/** Multiplier applied to contours on the major interval. @see DEFAULT_ISO_WIDTH */
export const DEFAULT_MAJOR_WIDTH_SCALE = 2.25;

/** Opacity of contours BETWEEN major intervals, when emphasis is enabled. */
export const DEFAULT_MINOR_OPACITY = 0.55;

/**
 * Default level ramp: 5-stop viridis (0–255 RGBA), the same perceptually
 * uniform ramp the rest of the stack reaches for. Sequential, not diverging:
 * a contour family's level is usually a magnitude, and a diverging default
 * would invent a meaningless zero crossing in the middle of the domain. A
 * caller with a signed field (anomalies, vorticity) passes their own.
 */
export const DEFAULT_ISO_RAMP: ReadonlyArray<RGBA8> = [
  [68, 1, 84, 255],
  [59, 82, 139, 255],
  [33, 145, 140, 255],
  [94, 201, 98, 255],
  [253, 231, 37, 255],
];

/**
 * Options for {@link STTIsoLayer}. The line renderer's whole option surface
 * (this kind IS that renderer, configured for contours), plus the level
 * grammar and a contour-oriented `width` default.
 */
export interface STTIsoLayerOptions extends STTLineLayerOptions {
  /**
   * Numeric property carrying each contour's LEVEL — the value of the field
   * the curve traces (500, 20, -30…). Unset (or absent from a tile) renders
   * the tile as a plain line layer: flat colour, flat width, no emphasis. It
   * never blanks, exactly as a missing DataFilter column never blanks.
   */
  levelProperty?: string;
  /**
   * PIN the level domain to `[min, max]` instead of widening it from the tile
   * stream. Pin it whenever the legend is fixed — a published chart's colour
   * key cannot move because a tile arrived late. Unset, the layer starts empty
   * and widens as tiles land, restyling every resident tile from the uniform.
   */
  levelDomain?: [number, number];
  /**
   * Ramp stops sampled across the level domain, 0–255 or 0–1 RGBA (detected
   * the way every colour option here is). Lerped, not bucketed. Longer than
   * {@link MAX_ISO_RAMP_STOPS} is RESAMPLED, never truncated.
   * @default DEFAULT_ISO_RAMP
   */
  colorRange?: ReadonlyArray<RGBA8 | RGBA>;
  /**
   * Level spacing of the INDEX contours — the ones a chart draws heavy and
   * labels (60 for 500 hPa heights in dam, 10 for a 2 m isotherm analysis).
   * `0` (the default) disables emphasis entirely: every contour draws at the
   * base width and full opacity.
   * @default 0
   */
  majorInterval?: number;
  /** Width multiplier for contours on {@link majorInterval}. @default 2.25 */
  majorWidthScale?: number;
  /**
   * Opacity of the contours BETWEEN major intervals. Only applied when
   * `majorInterval > 0` — with emphasis off, dimming every line would just be
   * a second opacity control.
   * @default 0.55
   */
  minorOpacity?: number;
  /** Interpolate width across the domain via {@link widthRange}. @default false */
  widthByLevel?: boolean;
  /**
   * `[atDomainMin, atDomainMax]` width, in `widthUnits`, used when
   * {@link widthByLevel} is on. @default [1, 3]
   */
  widthRange?: [number, number];
  /**
   * Layer-wide opacity multiplier, composed onto the time and filter alphas in
   * the shader (and therefore onto the PICK gate too).
   * @default 1
   */
  opacity?: number;
  /**
   * Contour width in `widthUnits`, and the base the level grammar modulates.
   *
   * DEFAULT DRIFT vs. the `line` kind's 2 and the `path` kind's 3:
   * {@link DEFAULT_ISO_WIDTH} — see its docs for why a contour family wants a
   * hairline base with emphasis on top.
   * @default 1.25
   */
  width?: number;
}

/**
 * Assemble an iso vertex shader — {@link buildLineVertexSource} with the `iso`
 * flag forced on. Exported under this kind's own name so a test or a host can
 * address it without pretending there are two implementations of the segment
 * extrusion, the projection variants or the time kernels. There is one.
 */
export function buildIsoVertexSource(
  shader: { prelude: string; define: string },
  variant: IsoVertexVariant = {},
): string {
  return buildLineVertexSource(shader, { ...variant, iso: true });
}

/**
 * Resolve the compiled time-filter mode — the package's standard degradation
 * rule, under the iso kind's name, and identical to the path kind's for the
 * identical reason: this class inherits the line renderer's window-derived
 * default lengths (`timeWindow / 2`, positive for any real window), so the
 * template's "infer from the knobs when the mode is unset" branch would put
 * EVERY iso layer into wake mode by construction. An unset mode is `'window'`.
 *
 * Exported so the prop-default tests can hold the layer to the rule rather
 * than to a restatement of the layer's own code.
 */
export function resolveIsoTimeFilterMode(
  mode: IsoTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): IsoTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  return 'window';
}

/** Trail and reveal are the per-VERTEX modes (line-layer's `usesVertexTimes`). */
function usesVertexTimes(mode: LineCompiledMode): boolean {
  return mode === 'trail' || mode === 'reveal';
}

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha);
  }
`;

// Flat, opaque, unblended: the readback must recover the id byte triple
// exactly. The `vAlpha` discard is what makes time-, range- and LEVEL-dimmed
// geometry unpickable rather than an invisible hit box.
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vIdColor, 1.0);
  }
`;

interface IsoProgramHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation,
    IsoRampUniformLocations {
  program: WebGLProgram;
  aCorner: number;
  aPosA: number;
  aPosB: number;
  /** -1 in trail/reveal mode (those programs read `aVertexTimeAB` instead). */
  aTime: number;
  /** -1 outside the per-VERTEX modes (trail, reveal). */
  aVertexTimeAB: number;
  aColor: number;
  aWidth: number;
  /** Per-instance contour level. */
  aLevel: number;
  /** -1 on the visual variants. */
  aIdColor: number;
  /** -1 unless the DataFilter branch was compiled in. */
  aFilterValue: number;
  /** null on prelude-built variants (they project via `u_projection_*`). */
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uWidthScale: WebGLUniformLocation | null;
  uUseFeatureWidth: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

/**
 * The line renderer's per-tile cache (its own type is module-private there;
 * this is the same shape) plus the level column. Nothing about the GEOMETRY
 * differs — `super.buildTileGpuCache` builds all of it and this class appends.
 */
interface IsoGpuCache extends TileGpuCache {
  posABuffer: WebGLBuffer;
  posBBuffer: WebGLBuffer;
  instanceCount: number;
  colorBuffer?: WebGLBuffer;
  widthBuffer?: WebGLBuffer;
  vertexTimeBuffer?: WebGLBuffer;
  filterBuffer?: WebGLBuffer;
  hasFilterColumn: boolean;
  featureCount: number;
  featureSegmentCounts: Uint32Array;
  vaoVariant?: string;
  vaoMode?: LineCompiledMode;
  /** Per-instance level, expanded across each feature's segments. */
  levelBuffer?: WebGLBuffer;
  /** False when the tile lacked the column — that tile renders as a plain line. */
  hasLevelColumn: boolean;
}

/** Hand-built test DrawContexts may omit `frame`; treat them as legacy hosts. */
const FALLBACK_LEGACY_FRAME: HostFrame = createHostFrame();

/**
 * MapLibre custom layer that renders STT iso-contour tiles — polylines styled
 * by the level they trace.
 *
 * ```ts
 * const layer = new STTIsoLayer({
 *   id: 'heights',
 *   url: '/data/gfs-500hPa.stt',
 *   currentTime: Date.now(),
 *   timeWindow: 3 * 3600_000,
 *   levelProperty: 'height_dam',
 *   majorInterval: 60,        // index contours every 60 dam, drawn heavy
 * });
 * map.addLayer(layer);
 * ```
 *
 * See the module header for why the level styling lives in uniforms.
 */
export class STTIsoLayer extends STTLineLayer {
  protected isoOpts: {
    levelProperty?: string;
    majorInterval: number;
    majorWidthScale: number;
    minorOpacity: number;
    widthByLevel: boolean;
    widthRange: [number, number];
    opacity: number;
  };

  /**
   * The live level domain. Widens from the tile stream unless PINNED by the
   * `levelDomain` option — see the module header for why this is a uniform.
   */
  private levelDomain: [number, number] = [0, 1];
  private readonly levelDomainPinned: boolean;
  /** False until the first tile carrying the column has been observed. */
  private levelDomainSeen = false;

  /** Ramp stops as 0–1 RGBA, flattened for one `uniform4fv`. */
  private rampFlat: Float32Array;
  private rampCount: number;

  /** A named `filterProperty` is what compiles the filter branch in. */
  private readonly isoFilterCompiled: boolean;
  /**
   * Program-cache keys, `iso:<pass>:<mode>[:filter]`, memoized against the
   * compiled mode they were built for. Every mode-flipping setter the line
   * renderer owns (`setTimeFilterMode`, `setTimeWindow`, `setRevealTrail`,
   * `setReducedMotion`) is therefore picked up without overriding any of them:
   * the mode IS the cache key of the key.
   */
  private keyedMode?: LineCompiledMode;
  private mainKey = '';
  private pickKey = '';
  /** Reused variant — the source builder reads it and never retains it. */
  private readonly isoVariantScratch: IsoVertexVariant = {
    mode: 'window',
    filter: false,
    pick: false,
    iso: true,
  };

  constructor(opts: STTIsoLayerOptions) {
    // The width default is applied AFTER the spread, never before: a caller
    // forwarding React props as `{...base, width: props.width}` hands us an
    // explicit `width: undefined` as an own key, and only `??` still lets that
    // reach the default.
    super({ ...opts, width: opts.width ?? DEFAULT_ISO_WIDTH });
    this.isoOpts = {
      levelProperty: opts.levelProperty,
      majorInterval: opts.majorInterval ?? 0,
      majorWidthScale: opts.majorWidthScale ?? DEFAULT_MAJOR_WIDTH_SCALE,
      minorOpacity: opts.minorOpacity ?? DEFAULT_MINOR_OPACITY,
      widthByLevel: opts.widthByLevel ?? false,
      widthRange: opts.widthRange ?? [1, 3],
      opacity: opts.opacity ?? 1,
    };
    this.levelDomainPinned = opts.levelDomain !== undefined;
    if (opts.levelDomain) {
      this.levelDomain = [opts.levelDomain[0], opts.levelDomain[1]];
      this.levelDomainSeen = true;
    }
    this.isoFilterCompiled = !!this.filterOpts.filterProperty;
    const ramp = fitIsoRamp(
      (opts.colorRange ?? DEFAULT_ISO_RAMP).map((c) => toRgba01(c as RGBA)),
    );
    this.rampCount = Math.max(1, Math.min(ramp.length, MAX_ISO_RAMP_STOPS));
    this.rampFlat = new Float32Array(this.rampCount * 4);
    for (let i = 0; i < this.rampCount; i++) {
      this.rampFlat.set(ramp[i], i * 4);
    }
  }

  /**
   * The RESOLVED time-mode knobs the tile-LOAD window is sized against.
   *
   * The line renderer DEFAULTS both tail lengths off `timeWindow` and DEGRADES
   * the mode, so the base's raw-option-bag reading reports `undefined` where
   * the shader is running a resolved value; report what compiled. `'reveal'`
   * is not in the base's vocabulary and is not this kind's business — it falls
   * through to the inherited answer.
   */
  protected timeModeLoadKnobs(): TimeModeLoadKnobs {
    const mode = this.lineOpts.timeFilterMode;
    if (mode === 'reveal') return super.timeModeLoadKnobs();
    return {
      mode,
      wakeLength: this.lineOpts.wakeLength,
      trailLength: this.lineOpts.trailLength,
    };
  }

  /**
   * PIN the level domain (or re-pin it). A uniform, so this restyles every
   * resident tile on the next frame without touching a single GPU cache —
   * the property that makes a domain slider viable at all.
   */
  setLevelDomain(min: number, max: number): void {
    this.levelDomain = [min, max];
    this.levelDomainSeen = true;
    this.isoRepaint();
  }

  /** The live level domain, `[min, max]`. */
  getLevelDomain(): [number, number] {
    return [this.levelDomain[0], this.levelDomain[1]];
  }

  /** Major-interval emphasis. `0` disables it. Uniform-only, no rebuild. */
  setMajorInterval(interval: number): void {
    this.isoOpts.majorInterval = interval;
    this.isoRepaint();
  }

  /** Layer-wide opacity, composed onto the visual AND pick alpha gates. */
  setOpacity(opacity: number): void {
    this.isoOpts.opacity = opacity;
    this.isoRepaint();
  }

  private isoRepaint(): void {
    if (this.opts.autoRepaint) this.map?.triggerRepaint();
  }

  /**
   * Widen the domain to cover this tile's levels.
   *
   * This is the counterpart of the header's argument: the widening happens at
   * tile-upload time, but it changes only a UNIFORM, so tiles already resident
   * pick the new domain up on the very next frame with no rebuild. Returns
   * nothing and repaints only when the domain actually moved — a tile fully
   * inside the known range is free.
   *
   * NaN levels are skipped rather than poisoning the domain: one bad row would
   * otherwise make `uLevelDomain` NaN and blank every contour in the layer.
   */
  private observeLevels(levels: Float32Array, featureCount: number): void {
    if (this.levelDomainPinned) return;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < featureCount; i++) {
      const v = levels[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) return; // nothing finite in this tile
    const prevMin = this.levelDomain[0];
    const prevMax = this.levelDomain[1];
    const nextMin = this.levelDomainSeen ? Math.min(prevMin, min) : min;
    const nextMax = this.levelDomainSeen ? Math.max(prevMax, max) : max;
    this.levelDomainSeen = true;
    if (nextMin === prevMin && nextMax === prevMax) return;
    this.levelDomain = [nextMin, nextMax];
    this.isoRepaint();
  }

  /**
   * The line renderer's cache, plus this kind's per-instance level buffer.
   *
   * The geometry — mercator projection, globe chord subdivision, the per-
   * segment instance expansion, the time / colour / width / DataFilter columns
   * — is `super`'s, entirely. This method only expands the LEVEL column across
   * the same `featureSegmentCounts` the parent already computed (the shared
   * `expandFilterValues` walk, which is what keeps ids, filters and levels
   * joined to one feature order) and appends the buffer to `extraBuffers` so
   * the base's unload sweep frees it.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): IsoGpuCache | null {
    const base = super.buildTileGpuCache(gl, tile, layer) as IsoGpuCache | null;
    if (!base) return null;
    base.hasLevelColumn = false;
    const prop = this.isoOpts.levelProperty;
    if (!prop) return base;
    const levels = this.getNumericProperty(layer.features, prop);
    // Length-checked, not presence-checked: a column SHORTER than the feature
    // count would read `undefined` past the end and bake NaN levels — a whole
    // tile of contours pinned to the ramp's first stop. A short or missing
    // column renders the tile as a plain line, never blank.
    if (!levels || levels.length < base.featureCount) return base;
    const expanded = expandFilterValues(
      levels,
      base.featureSegmentCounts,
      base.instanceCount,
    );
    const levelBuffer = this.uploadArrayBuffer(gl, expanded);
    (base.extraBuffers ??= []).push(levelBuffer);
    base.levelBuffer = levelBuffer;
    base.hasLevelColumn = true;
    this.observeLevels(levels, base.featureCount);
    return base;
  }

  /**
   * Fetch (or link) the program for this frame's host variant, the active time
   * mode and this pass. The base cache appends the host variant name, so the
   * mode + pass + filter axes must all be in OUR key — and the `iso:` prefix
   * is what keeps this kind's programs from colliding with the line kind's in
   * the shared cache.
   */
  private isoProgramFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
    pick: boolean,
  ): IsoProgramHandles {
    const mode = this.lineOpts.timeFilterMode;
    if (this.keyedMode !== mode) {
      this.keyedMode = mode;
      const suffix = `${mode}${this.isoFilterCompiled ? ':filter' : ''}`;
      this.mainKey = `iso:main:${suffix}`;
      this.pickKey = `iso:pick:${suffix}`;
    }
    const key = pick ? this.pickKey : this.mainKey;
    return this.getOrCreateProgram(gl, key, frame, (glc, shader) => {
      const variant = this.isoVariantScratch;
      variant.mode = mode;
      variant.filter = this.isoFilterCompiled;
      variant.pick = pick;
      const program = this.linkProgram(
        glc,
        buildIsoVertexSource(shader, variant),
        pick ? ID_FS_SOURCE : FS_SOURCE,
      );
      return {
        program,
        aCorner: glc.getAttribLocation(program, 'aCorner'),
        aPosA: glc.getAttribLocation(program, 'aPosA'),
        aPosB: glc.getAttribLocation(program, 'aPosB'),
        aTime: glc.getAttribLocation(program, 'aTime'),
        aVertexTimeAB: glc.getAttribLocation(program, 'aVertexTimeAB'),
        aColor: glc.getAttribLocation(program, 'aColor'),
        aWidth: glc.getAttribLocation(program, 'aWidth'),
        aLevel: glc.getAttribLocation(program, 'aLevel'),
        aIdColor: glc.getAttribLocation(program, 'aIdColor'),
        aFilterValue: glc.getAttribLocation(program, 'aFilterValue'),
        uMatrix: glc.getUniformLocation(program, 'uMatrix'),
        uViewport: glc.getUniformLocation(program, 'uViewport'),
        uWidth: glc.getUniformLocation(program, 'uWidth'),
        uWidthScale: glc.getUniformLocation(program, 'uWidthScale'),
        uUseFeatureWidth: glc.getUniformLocation(program, 'uUseFeatureWidth'),
        uUseFeatureColor: glc.getUniformLocation(program, 'uUseFeatureColor'),
        uColor: glc.getUniformLocation(program, 'uColor'),
        ...resolveTimeUniformLocations(glc, program),
        ...resolveWakeTailScaleUniformLocation(glc, program),
        ...resolveDataFilterUniformLocations(glc, program),
        ...resolveFilterTransformSizeUniformLocation(glc, program),
        ...resolveIsoRampUniformLocations(glc, program),
      };
    });
  }

  /** Upload the active mode's time uniforms (only those exist in the program). */
  private setIsoTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IsoProgramHandles,
    cache: IsoGpuCache,
    ctx: DrawContext,
  ): void {
    // Tile-relative, the convention every time kernel here compares in.
    const relTime = ctx.currentTime - cache.timeOffset;
    switch (this.lineOpts.timeFilterMode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uWakeLength, this.lineOpts.wakeLength);
        gl.uniform1f(h.uWakeTailScale, this.lineOpts.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(h.uTrailLength, this.lineOpts.trailLength);
        gl.uniform1f(h.uFadeTrail, this.lineOpts.fadeTrail);
        break;
      case 'reveal':
        gl.uniform1f(h.uCurrentTime, relTime);
        gl.uniform1f(
          h.uTrailLength,
          resolveRevealTrailLength(this.lineOpts.revealDuration),
        );
        gl.uniform1f(h.uFadeTrail, this.lineOpts.fadeTrail);
        break;
      default: {
        gl.uniform1f(h.uWindowStart, ctx.windowStart);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
        const { fadeIn, fadeOut } = this.resolveFadeDurations();
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
      }
    }
  }

  /**
   * The level grammar, all of it, as uniforms — the same call in both passes,
   * so the pick gate can never be more permissive than the visual one.
   *
   * `uUseLevel` is per TILE (this tile carried the column AND the program kept
   * the attribute) and is what makes a column-less tile fall back to flat
   * colour and flat width instead of collapsing to the ramp's first stop.
   */
  private setIsoUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IsoProgramHandles,
    c: IsoGpuCache,
  ): void {
    const o = this.isoOpts;
    gl.uniform4fv(h.uIsoRamp, this.rampFlat);
    gl.uniform1f(h.uIsoRampCount, this.rampCount);
    gl.uniform2f(h.uLevelDomain, this.levelDomain[0], this.levelDomain[1]);
    gl.uniform1f(h.uUseLevel, c.levelBuffer && h.aLevel >= 0 ? 1 : 0);
    gl.uniform1f(h.uMajorInterval, o.majorInterval);
    gl.uniform1f(h.uMajorWidthScale, o.majorWidthScale);
    gl.uniform1f(h.uMinorOpacity, o.minorOpacity);
    gl.uniform1f(h.uWidthByLevel, o.widthByLevel ? 1 : 0);
    gl.uniform2f(h.uWidthRange, o.widthRange[0], o.widthRange[1]);
    gl.uniform1f(h.uOpacity, o.opacity);
  }

  /**
   * `uWidthScale` for one tile: the raw option in `'pixels'`, and additionally
   * metres→device-px at THIS tile's centre latitude and the map's FRACTIONAL
   * zoom in `'meters'` (`ctx.zoom` is floored, which would step metric widths
   * by a factor of 2 per zoom level). Folded into the scale so the constant
   * `uWidth`, the per-feature `aWidth` and the level-ramped width are all
   * metric with no extra uniform and no shader branch.
   */
  private isoWidthScaleFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const { widthScale, widthUnits } = this.lineOpts;
    if (widthUnits !== 'meters') return widthScale;
    return widthScale * this.metricPixelScale(gl, tile, ctx);
  }

  /** Per-instance attribute binds shared by the visual and id passes. */
  private bindIsoInstanceAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: IsoProgramHandles,
    c: IsoGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, c.posABuffer);
    gl.enableVertexAttribArray(h.aPosA);
    gl.vertexAttribPointer(h.aPosA, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aPosA, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, c.posBBuffer);
    gl.enableVertexAttribArray(h.aPosB);
    gl.vertexAttribPointer(h.aPosB, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aPosB, 1);

    if (usesVertexTimes(this.lineOpts.timeFilterMode)) {
      if (c.vertexTimeBuffer && h.aVertexTimeAB >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.vertexTimeBuffer);
        gl.enableVertexAttribArray(h.aVertexTimeAB);
        gl.vertexAttribPointer(h.aVertexTimeAB, 2, gl.FLOAT, false, 0, 0);
        this.instSupport.vertexAttribDivisor(h.aVertexTimeAB, 1);
      }
    } else if (h.aTime >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.timeBuffer);
      gl.enableVertexAttribArray(h.aTime);
      gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aTime, 1);
    }

    if (c.widthBuffer && h.aWidth >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.widthBuffer);
      gl.enableVertexAttribArray(h.aWidth);
      gl.vertexAttribPointer(h.aWidth, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aWidth, 1);
    }
    if (c.levelBuffer && h.aLevel >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.levelBuffer);
      gl.enableVertexAttribArray(h.aLevel);
      gl.vertexAttribPointer(h.aLevel, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aLevel, 1);
    }
    if (c.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 1);
    }
  }

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const h = this.isoProgramFor(gl, frame, false);
    const c = cache as IsoGpuCache;

    gl.useProgram(h.program);
    if (frame.shader.prelude) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uWidth, this.lineOpts.width);
    gl.uniform1f(h.uWidthScale, this.isoWidthScaleFor(gl, tile, ctx));
    gl.uniform4fv(h.uColor, this.rgba01Uniform('Color', this.lineOpts.color));
    this.setIsoTimeUniforms(gl, h, c, ctx);
    this.setIsoUniforms(gl, h, c);
    if (this.isoFilterCompiled) {
      this.uploadDataFilterUniforms(gl, h, c.hasFilterColumn);
    }
    gl.uniform1f(h.uUseFeatureColor, c.colorBuffer && h.aColor >= 0 ? 1 : 0);
    gl.uniform1f(h.uUseFeatureWidth, c.widthBuffer && h.aWidth >= 0 ? 1 : 0);

    // A VAO records attribute LOCATIONS of the program it was built against —
    // a host-variant OR mode flip is a different program either way, so a
    // mismatched VAO is dropped and re-recorded (the buffers stay valid).
    if (
      c.vao &&
      (c.vaoVariant !== frame.shader.variantName ||
        c.vaoMode !== this.lineOpts.timeFilterMode)
    ) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
    const quad = this.getUnitQuad(gl);
    this.bindVaoOrSetup(c, () => {
      // Per-vertex quad corner (divisor 0).
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(h.aCorner);
      gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aCorner, 0);

      // Per-instance attributes (divisor 1).
      this.bindIsoInstanceAttributes(gl, h, c);

      if (c.colorBuffer && h.aColor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colorBuffer);
        gl.enableVertexAttribArray(h.aColor);
        gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        this.instSupport.vertexAttribDivisor(h.aColor, 1);
      }
    });
    c.vaoVariant = frame.shader.variantName;
    c.vaoMode = this.lineOpts.timeFilterMode;

    // 4 verts per quad × N segment instances, TRIANGLE_STRIP. No gl_VertexID,
    // so this links on WebGL1 + ANGLE_instanced_arrays too.
    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      c.instanceCount,
    );
  }

  /**
   * Draw this tile into the id-pick FBO, painting feature `i` the flat colour
   * `encodePickId(idBase + i)`.
   *
   * Built from the SAME vertex source as the visual pass — same projection
   * variant, same time mode, same DataFilter branch, same ISO branch with the
   * same ramp/emphasis/opacity uniforms — so the pickable area is exactly the
   * quad the user sees and every alpha gate matches. A minor contour faded to
   * zero by `minorOpacity`, or the whole layer faded by `opacity`, discards
   * here as well as there.
   *
   * Ids are per FEATURE while instances are SEGMENTS, so the id colours are
   * expanded through the cache's per-feature segment counts — the parent's map,
   * not a second one. The buffer is rebuilt each pick and freed immediately:
   * `idBase` shifts with whatever tiles are loaded, and picks are rare.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const frame = ctx.frame ?? FALLBACK_LEGACY_FRAME;
    const h = this.isoProgramFor(gl, frame, true);
    const c = cache as IsoGpuCache;

    const perFeature = this.buildPickIdColors(c.featureCount, idBase);
    const idBuffer = this.uploadArrayBuffer(
      gl,
      expandPickIdColors(perFeature, c.featureSegmentCounts, c.instanceCount),
    );

    gl.useProgram(h.program);
    if (frame.shader.prelude) {
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(h.uWidth, this.lineOpts.width);
    gl.uniform1f(h.uWidthScale, this.isoWidthScaleFor(gl, tile, ctx));
    this.setIsoTimeUniforms(gl, h, c, ctx);
    this.setIsoUniforms(gl, h, c);
    if (this.isoFilterCompiled) {
      this.uploadDataFilterUniforms(gl, h, c.hasFilterColumn);
    }
    gl.uniform1f(h.uUseFeatureWidth, c.widthBuffer && h.aWidth >= 0 ? 1 : 0);

    // Raw attribute binds (no VAO): picking is a rare user-initiated pass and
    // the id buffer is per-pass, so a cached VAO would just go stale.
    const quad = this.getUnitQuad(gl);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(h.aCorner);
    gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aCorner, 0);

    this.bindIsoInstanceAttributes(gl, h, c);

    gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
    gl.enableVertexAttribArray(h.aIdColor);
    gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aIdColor, 1);

    this.instSupport.drawArraysInstanced(
      0x0005 /* TRIANGLE_STRIP */,
      0,
      4,
      c.instanceCount,
    );

    // Leave the default-VAO attribute slate clean (every divisor back at 0) so
    // the next visual frame's VAO recording starts from a known state, then
    // drop the one-shot id buffer.
    for (const loc of [
      h.aCorner,
      h.aPosA,
      h.aPosB,
      h.aTime,
      h.aVertexTimeAB,
      h.aWidth,
      h.aLevel,
      h.aFilterValue,
      h.aIdColor,
    ]) {
      if (loc < 0) continue;
      this.instSupport.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
    gl.deleteBuffer(idBuffer);
  }
}
