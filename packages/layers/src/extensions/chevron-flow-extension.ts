// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * ChevronFlowExtension — directional chevrons along a PathLayer.
 *
 * Draws a repeating arrowhead ("›››") pattern over each rendered path segment,
 * so a corridor reads as *flowing* one way. It's a pure fragment-shader effect
 * over whatever color the host layer produced. Options layer on: `uniformSpacing`
 * (even, untruncated arrows), an optional `chevronSpeed` march, `directionColor`
 * (four cardinal colors by the segment's compass bearing), and `perTripLight`
 * (arrowheads flash as individual trips pass, driven by FlowCorridorLayer's
 * two-signal RGB-aggregate / alpha-instant packing). It composes with
 * {@link FlowCorridorLayer}'s per-vertex value-matrix coloring.
 *
 * DIRECTION comes from geometry winding, not from any per-vertex attribute: the
 * chevrons always point toward increasing vertex index. The BIXI street-flow
 * build (`bixi --streets --directional`) pre-orients every corridor so its
 * winding equals the month-dominant flow direction, which makes the chevrons
 * point the way riders actually go. On geometry that is NOT pre-oriented they
 * simply point along the digitization order.
 *
 * TWO CLOCKS, ONE SOURCE: the host `FlowCorridorLayer` re-expands its per-vertex
 * colors only ~5 Hz (on the play-head sub-step grid), but the chevron phase is a
 * single f32 uniform recomputed every `draw()` from the SAME play-head
 * (`getTime()`), so the arrows march smoothly at the deck redraw rate while the
 * color animation stays cheap. The phase is reduced mod `period` on the CPU so
 * the epoch-ms play-head never blows f32 precision in the uniform.
 *
 * Requires a host layer that forwards a `getTime` (or `currentTime`) prop — the
 * animated-trips family (and thus FlowCorridorLayer) does, via its
 * TimeFilterExtension plumbing. Add it through the public `extensions` prop:
 * deck's `composeExtensions` appends it to the corridor PathLayer, and the repo's
 * `extensionsDigest` keys the sublayer cache by constructor + options (not
 * reference), so a fresh `new ChevronFlowExtension(opts)` per render is free.
 *
 * PathLayer varyings used (deck.gl 9.x): the fragment receives
 * `geometry.uv = vPathPosition`, where `.x ∈ [-1, 1]` is the position across the
 * width (0 = center line) and `.y ∈ [0, L/width]` is the distance along the
 * CURRENT segment in units of line width. Per-segment (not whole-path) along is
 * fine here — every street segment gets its own chevrons.
 */

import { LayerExtension } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';

/** Tuning options for {@link ChevronFlowExtension}. All are static per demo. */
export interface ChevronFlowExtensionOptions {
  /**
   * Chevron spacing along the path, in units of line width (so it scales with
   * `widthMinPixels`/`widthMaxPixels`). Larger = more space between arrows.
   * @default 6
   */
  period?: number;
  /**
   * March speed: units of phase (in the same width-units as `period`) advanced
   * per second of play-head time. Because the phase rides the play-head, the
   * chevrons freeze when playback is paused and reverse when scrubbing back.
   * Tune to taste per demo.
   * @default 0.0006
   */
  speed?: number;
  /**
   * Arrowhead sharpness: how much the iso-band shears along the path per unit of
   * half-width. Larger makes a pointier "›"; 0 makes a straight dash.
   * @default 1.4
   */
  skew?: number;
  /**
   * Fraction of each period lit by the chevron band, in `[0, 1]`. Smaller =
   * thinner arrowheads with more dark gap between them.
   * @default 0.5
   */
  duty?: number;
  /**
   * Soft-edge width of the band's trailing edge, in `[0, 1]` (fraction of a
   * period). Larger = softer, more comet-like tails.
   * @default 0.28
   */
  feather?: number;
  /**
   * Alpha multiplier for the path BETWEEN chevrons: 0 shows chevrons only
   * (invisible track), 1 leaves the base line fully solid with a brightness
   * ripple. A small value keeps a dim continuous track under bright arrows.
   * @default 0.15
   */
  baseAlpha?: number;
  /**
   * PER-BUCKET direction. When true, the chevron direction is no longer fixed to
   * the geometry winding — instead each vertex carries a CONTINUOUS signed
   * direction `∈ [-1,1]` that FlowCorridorLayer derives from the SIGNED value
   * matrix (a rolling net-flow COHERENCE ratio). The shader morphs the arrow SHAPE
   * (">" at +1 → flat dash at 0 → "<" at -1), blends its cardinal HUE
   * forward↔reverse, and marches the way the arrows point — all SMOOTHLY, with no
   * hard flip, as a corridor's dominant flow reverses over the day. Adds NO new
   * vertex attribute — it reuses TimeFilterExtension's `instanceVertexTime` slot
   * (unused in flow-corridor window mode), staying under WebGL2's 16-attribute
   * ceiling. When off (default), direction is the static geometry winding.
   * @default false
   */
  perBucketDirection?: boolean;
  /**
   * UNIFORM SPACING. Fit a WHOLE number of chevrons into each rendered path
   * SEGMENT (using the base PathLayer's `vPathLength` varying) instead of the raw
   * `period`, which is measured per-segment and so restarts at every vertex.
   * Because the fitted period divides the segment exactly, a chevron edge lands
   * on both segment ends: arrows are never truncated at a joint, adjacent segments
   * meet edge-to-edge, and the density stays ~`1/period` per unit of path length
   * even on many-vertex corridors whose segments are shorter than one `period`
   * (the common case at an overview zoom). Intended for STATIC chevrons
   * (`speed: 0`); with a marching phase the per-segment fit makes the march step
   * at each joint. When off (default), spacing is the raw per-segment `period`.
   * @default false
   */
  uniformSpacing?: boolean;
  /**
   * DIRECTION COLOR. Tint the arrowheads by the compass bearing they point, using
   * FOUR colors placed at the cardinal directions (`directionColors` = N, E, S, W,
   * rotatable by `directionOffsetDegrees`) and blended cyclically around the
   * compass. The bearing is derived on the GPU from the segment endpoints
   * (`instanceStart/EndPositions`, no new attribute) and flipped by the per-bucket
   * direction sign, so a corridor's arrows recolor as its dominant flow reverses
   * over the day. Applied to the arrowheads only (via the chevron band). When off
   * (default), chevrons inherit the host color. @default false
   */
  directionColor?: boolean;
  /**
   * The four cardinal colors `[N, E, S, W]`, each `[r, g, b]` in 0–255, placed at
   * bearings `offset`, `offset+90`, `offset+180`, `offset+270` and interpolated
   * cyclically for in-between bearings. @default amber/green/teal/violet
   */
  directionColors?: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  /**
   * Compass-bearing offset (degrees) of the first color (`directionColors[0]`); 0
   * anchors it due North. Use 45 to place the four colors on the intercardinals
   * (NE/SE/SW/NW). @default 0
   */
  directionOffsetDegrees?: number;
  /**
   * PER-TRIP LIGHT. Two-signal corridor rendering driven by FlowCorridorLayer's
   * `chevronPerTripLight` packing: the incoming color's RGB carries a rolling-
   * window AGGREGATE (overall volume → the dim track), and its ALPHA carries an
   * INSTANTANEOUS per-trip flow signal. The arrowheads flash their cardinal
   * `directionColor` hue as individual trips pass (alpha → full), fading to
   * `perTripFloor` between; the track shows the aggregate. Replaces any synthetic
   * highlight. @default false
   */
  perTripLight?: boolean;
  /**
   * `perTripLight`: arrowhead OPACITY floor BETWEEN trip flashes, in `[0, 1]`. The
   * arrowhead alpha recedes toward the background at this floor and pops to full as
   * a trip passes (the hue stays saturated, so it reads whenever it shows). 0 =
   * arrows invisible between trips. @default 0.22
   */
  perTripFloor?: number;
}

type ChevronUniformProps = {
  phase: number;
  period: number;
  skew: number;
  duty: number;
  feather: number;
  baseAlpha: number;
};

// Shared default cardinal palette [N, E, S, W]. MODULE-level so every default
// construction reuses the SAME array reference: deck's `LayerExtension.equals`
// compares opts with `deepEqual(…, 1)`, which tests array values by reference at
// that depth, so a fresh literal per render would look "changed" and thrash the
// shader cache. Dataset-provided palettes are likewise stable module refs.
const DEFAULT_DIRECTION_COLORS: readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
] = [
  [255, 184, 77], // N — amber
  [95, 224, 140], // E — green
  [79, 227, 208], // S — teal
  [175, 124, 226], // W — violet
];

// std140 uniform block (WebGL2), mirroring the TimeFilterExtension convention.
const glslUniformBlock = `\
layout(std140) uniform chevronUniforms {
  float phase;
  float period;
  float skew;
  float duty;
  float feather;
  float baseAlpha;
} chevron;
`;

// Shader module for deck.gl 9.x — the block is declared in both stages so luma
// attaches it wherever the module is referenced (only the fragment reads it).
// Exported for shader-module regression tests (luma UBO plumbing).
export const chevronUniforms = {
  name: 'chevron',
  vs: glslUniformBlock,
  fs: glslUniformBlock,
  uniformTypes: {
    phase: 'f32',
    period: 'f32',
    skew: 'f32',
    duty: 'f32',
    feather: 'f32',
    baseAlpha: 'f32',
  },
} as const;

/**
 * A deck.gl {@link LayerExtension} that overlays marching directional chevrons
 * on a path layer. See the file docstring for how it composes with
 * FlowCorridorLayer and where the direction comes from.
 */
export class ChevronFlowExtension extends LayerExtension<Required<ChevronFlowExtensionOptions>> {
  static extensionName = 'ChevronFlowExtension';

  /**
   * Memoized shader-injection object — deck.gl calls `getShaders()` on every
   * sublayer construction, and a new object literal each time would thrash the
   * shader cache. Built once per extension instance (identity preserved across
   * every sublayer that shares it).
   */
  private cachedShaders: { modules: unknown[]; inject: Record<string, string> } | null = null;

  constructor(options: ChevronFlowExtensionOptions = {}) {
    super({
      period: options.period ?? 6,
      speed: options.speed ?? 0.0006,
      skew: options.skew ?? 1.4,
      duty: options.duty ?? 0.5,
      feather: options.feather ?? 0.28,
      baseAlpha: options.baseAlpha ?? 0.15,
      perBucketDirection: options.perBucketDirection ?? false,
      uniformSpacing: options.uniformSpacing ?? false,
      directionColor: options.directionColor ?? false,
      directionColors: options.directionColors ?? DEFAULT_DIRECTION_COLORS,
      directionOffsetDegrees: options.directionOffsetDegrees ?? 0,
      perTripLight: options.perTripLight ?? false,
      perTripFloor: options.perTripFloor ?? 0.22,
    });
  }

  getShaders(this: Layer, extension: ChevronFlowExtension) {
    if (extension.cachedShaders) return extension.cachedShaders;
    const perBucket = extension.opts.perBucketDirection;
    // `chevronDir` is now a CONTINUOUS signed direction ∈ [-1,1] (FlowCorridorLayer's
    // rolling coherence ratio): +1 = full forward ">", 0 = flat dash (no net
    // direction), -1 = full reverse "<". The shader morphs arrow SHAPE (signed
    // skew), HUE (forward↔reverse blend), and MARCH (sign(dir)) smoothly with it —
    // no hard flip. +1 static when perBucketDirection is off.
    const dirDecl = perBucket
      ? 'float chevronDir = clamp(vChevronDir, -1.0, 1.0);'
      : 'float chevronDir = 1.0;';
    const directionColor = extension.opts.directionColor;
    const perTripLight = extension.opts.perTripLight;
    // uniformSpacing: snap the period so a whole number of chevrons fits THIS
    // segment (see the option docstring). The base PathLayer varying `vPathLength`
    // = segment length in the same width-units as geometry.uv.y, so a fitted
    // period lands a chevron edge on both segment ends → no truncation at joints.
    // `vPathLength` is only in scope inside the fragment `main()`, NOT inside the
    // DECKGL_FILTER_COLOR hook function (which only receives `geometry`), so we
    // read it in `fs:#main-start` and bridge it into the hook via a global. The
    // fit line reads that global; max(…, 0.001) guards degenerate segments.
    const fitSpacing = extension.opts.uniformSpacing;
    const fit = fitSpacing
      ? `
          chevronPeriod = max(chevronSegLen / max(floor(chevronSegLen / chevronPeriod + 0.5), 1.0), 0.001);`
      : '';
    const needsSegLen = fitSpacing;
    // Accumulate injection points: perBucketDirection, uniformSpacing, and
    // directionColor may each contribute to fs:#decl/vs:#decl, and a Record holds
    // only one string per key, so build each point's pieces and join them.
    const fsDecl: string[] = [];
    const fsMainStart: string[] = [];
    const vsDecl: string[] = [];
    const vsMainStart: string[] = [];
    if (perBucket) {
      // Per-vertex direction sign → a varying, WITHOUT adding an attribute:
      // PathLayer already sits at WebGL2's 16-attribute ceiling (fp64 positions +
      // TimeFilter's three time attrs + colour/width), so a new `in` overflows the
      // link ("Too many attributes"). Instead we REUSE TimeFilterExtension's
      // `instanceVertexTime` slot — flow-corridor tiles run window mode, where it
      // is registered but never read (only trail mode reads it), so FlowCorridorLayer
      // repurposes it to carry the sign (see its prepareTile). We only declare the
      // OUT varying here; `instanceVertexTime` is already declared by TimeFilter's
      // vs:#decl (always present on this layer family), and all #decl injects
      // precede all #main-start injects, so it is in scope below.
      vsDecl.push('out float vChevronDir;');
      vsMainStart.push('vChevronDir = instanceVertexTime;');
      fsDecl.push('in float vChevronDir;');
    }
    if (needsSegLen) {
      // Global bridge: declared before the hook (fs:#decl) and set from the
      // in-scope varying at the top of main() (fs:#main-start), then read by the
      // uniformSpacing fit inside the DECKGL_FILTER_COLOR hook below.
      fsDecl.push('float chevronSegLen;');
      fsMainStart.push('chevronSegLen = vPathLength;');
    }
    // directionColor: FOUR cardinal colors blended cyclically by the segment's
    // compass bearing, then SMOOTHLY blended forward↔reverse by the continuous
    // direction. Colors + offset bake as GLSL constants. The segment's (east,
    // north) vector is computed once in the vertex shader and interpolated as
    // `vChevronEN`; the fragment builds the FORWARD-heading hue and the REVERSE
    // (-vChevronEN, i.e. bearing+180°) hue and lerps between them by (dir+1)/2 —
    // so the color glides forward → neutral (at the flat dir=0) → reverse with no
    // hard flip. `hueSetup` yields `vec3 arrowHue`. Default → white.
    let hueSetup = '          vec3 arrowHue = vec3(1.0);';
    if (directionColor) {
      const glVec3 = (c: readonly [number, number, number]) =>
        `vec3(${c.map((v) => (v / 255).toFixed(5)).join(', ')})`;
      const [cN, cE, cS, cW] = extension.opts.directionColors.map(glVec3);
      // Fraction-of-a-turn offset (wrapped to [0,1)) subtracted from the bearing.
      const offDeg = ((extension.opts.directionOffsetDegrees % 360) + 360) % 360;
      const offsetTurns = (offDeg / 360).toFixed(6);
      vsDecl.push('out vec2 vChevronEN;');
      // (east, north) segment vector. Endpoints are lng/lat degrees (LNGLAT layer);
      // Δlng is cos(lat)-scaled so the vector is metric (mercator is conformal →
      // the atan gives the true compass bearing). NOT normalized — atan2 is
      // scale-invariant.
      vsMainStart.push(
        `{
          vec2 sChevron = instanceStartPositions.xy;
          vec2 eChevron = instanceEndPositions.xy;
          vChevronEN = vec2(
            (eChevron.x - sChevron.x) * cos(radians((sChevron.y + eChevron.y) * 0.5)),
            eChevron.y - sChevron.y
          );
        }`,
      );
      fsDecl.push('in vec2 vChevronEN;');
      // Cyclic-4 cardinal hue for a heading vector, INLINED (not a fs:#decl
      // function — that GLSL-link pattern is unverified in this codebase) so the
      // forward + reverse headings each get their own block. bearing = atan(east,
      // north): 0=N, π/2=E, π=S, 3π/2=W. /(2π)=0.15915494. seg ∈ [0,4): N→E→S→W→N.
      const cyclic4 = (enExpr: string, out: string) => `
          {
            float seg = fract(atan((${enExpr}).x, (${enExpr}).y) * 0.15915494 - ${offsetTurns}) * 4.0;
            float f = fract(seg);
            if (seg < 1.0) ${out} = mix(${cN}, ${cE}, f);
            else if (seg < 2.0) ${out} = mix(${cE}, ${cS}, f);
            else if (seg < 3.0) ${out} = mix(${cS}, ${cW}, f);
            else ${out} = mix(${cW}, ${cN}, f);
          }`;
      hueSetup = `
          vec3 chevronHueFwd;${cyclic4('vChevronEN', 'chevronHueFwd')}
          vec3 chevronHueRev;${cyclic4('-vChevronEN', 'chevronHueRev')}
          // Smooth forward/reverse blend by the continuous direction: +1 = forward,
          // 0 = 50/50 neutral (the flat-dash transition), -1 = reverse.
          vec3 arrowHue = mix(chevronHueRev, chevronHueFwd, (chevronDir + 1.0) * 0.5);`;
    }
    // Tail: how the arrowhead colour + alpha are written from chevronHead.
    let tail: string;
    if (perTripLight) {
      // Two-signal combine (FlowCorridorLayer packing): color.rgb = AGGREGATE volume
      // ramp (faint track), color.a = INSTANT per-trip flash. The arrowhead OPACITY
      // recedes toward the background (perTripFloor) between trips and POPS to full
      // as a rider passes — recession is carried purely by ALPHA, so the hue stays
      // saturated (the smooth directional blend) and simply fades in/out. The track
      // stays faint, scaled by aggregate volume.
      const floor = Math.min(Math.max(extension.opts.perTripFloor, 0), 1).toFixed(4);
      tail = `${hueSetup}
          float chevronInstant = color.a;
          float chevronAggLum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
          float chevronArrowAlpha = mix(${floor}, 1.0, chevronInstant);
          float chevronTrackAlpha = chevron.baseAlpha * chevronAggLum;
          color.rgb = mix(color.rgb, arrowHue, chevronHead);
          color.a = mix(chevronTrackAlpha, chevronArrowAlpha, chevronHead);`;
    } else if (directionColor) {
      // Direction hue on the arrowheads; alpha still the host color's, band-masked.
      tail = `${hueSetup}
          color.rgb = mix(color.rgb, arrowHue, chevronHead);
          color.a *= mix(chevron.baseAlpha, 1.0, chevronHead);`;
    } else {
      // Plain: modulate the host alpha by the chevron band (original behavior).
      tail = '          color.a *= mix(chevron.baseAlpha, 1.0, chevronHead);';
    }
    const inject: Record<string, string> = {
      'fs:DECKGL_FILTER_COLOR': `
        // Reactive vector-field chevrons. geometry.uv = (across in [-1,1], along in
        // [0, L/width]). chevronDir in [-1,1] is the continuous signed net-flow
        // direction; the SIGNED SKEW morphs the arrowhead with it (">" at +1, a flat
        // perpendicular dash at 0, "<" at -1) while the march flows the way arrows point.
        {
          ${dirDecl}
          float chevronAlong = geometry.uv.y;
          float chevronAcross = geometry.uv.x;
          float chevronPeriod = max(chevron.period, 0.001);${fit}
          // Signed skew (NO along-flip) = smooth arrow -> flat line -> reversed arrow.
          // At dir=0 the shear vanishes -> chevronBand = fract(along/period) is
          // independent of across -> a straight perpendicular dash. March by
          // sign(chevronDir) (not dir) so the CPU mod-period phase stays an integer
          // multiple at its wrap -> seam-free; the lone flip lands on the flat zero-cross.
          float chevronS = chevronAlong
            + abs(chevronAcross) * chevron.skew * chevronDir
            - chevron.phase * sign(chevronDir);
          float chevronBand = fract(chevronS / chevronPeriod);
          // Sharp leading edge (band near 0) fading over duty, softened by feather.
          float chevronHead =
            1.0 - smoothstep(chevron.duty - chevron.feather, chevron.duty, chevronBand);
${tail}
        }
      `,
    };
    if (vsDecl.length) inject['vs:#decl'] = `\n        ${vsDecl.join('\n        ')}\n      `;
    if (vsMainStart.length)
      inject['vs:#main-start'] = `\n        ${vsMainStart.join('\n        ')}\n      `;
    if (fsDecl.length) inject['fs:#decl'] = `\n        ${fsDecl.join('\n        ')}\n      `;
    if (fsMainStart.length)
      inject['fs:#main-start'] = `\n        ${fsMainStart.join('\n        ')}\n      `;
    const shaders = { modules: [chevronUniforms], inject };
    extension.cachedShaders = shaders;
    return shaders;
  }

  draw(this: Layer, _params: unknown, extension: ChevronFlowExtension): void {
    const opts = extension.opts;
    // Read the play-head from the host layer (FlowCorridorLayer forwards
    // `getTime` via its TimeFilterExtension plumbing). `currentTime` is a static
    // fallback for hosts without a live clock.
    const props = this.props as { getTime?: (() => number) | null; currentTime?: number };
    const t = typeof props.getTime === 'function' ? props.getTime() : props.currentTime ?? 0;

    // Arrow-band march (width-units): the pattern slides by chevronSpeed. Static
    // when speed 0 (the default for direction/per-trip-light demos).
    const period = Math.max(opts.period, 0.001);
    // Reduce mod `period` on the CPU: the epoch-ms play-head (~1.7e12) would lose
    // all precision as an f32 uniform, but the shader only needs phase in
    // [0, period). Double math here is exact enough before the modulo.
    let phase = ((t / 1000) * opts.speed) % period;
    if (phase < 0) phase += period;

    const chevron: ChevronUniformProps = {
      phase,
      period,
      skew: opts.skew,
      duty: opts.duty,
      feather: opts.feather,
      baseAlpha: opts.baseAlpha,
    };
    this.setShaderModuleProps({ chevron });
  }
}
