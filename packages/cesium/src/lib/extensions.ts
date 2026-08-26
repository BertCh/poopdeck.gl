// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) **user extensions** for the CesiumJS backend — the
 * `userExtensions` capability: the seam by which a caller injects their own
 * shading or behaviour into a SHIPPED layer without forking it.
 *
 * An extension is a plain object with a `name` and either or both of two
 * optional hooks. They run inside the layer's per-frame loop, on the values the
 * layer has already resolved for one feature:
 *
 * ```text
 *   alpha(alpha, feature) → alpha     transform the RESOLVED opacity
 *   color(out,   alpha, feature)      transform the RESOLVED rgb, in place
 * ```
 *
 * `compileExtensions` folds a list into one {@link CompiledExtensions} the hot
 * loop can call, and returns `null` when there is nothing to do. It is wired
 * into the two files that own a per-frame colour write — `STTPointLayer` and
 * `STTBatchedPolylineLayer` — which between them back the `point`, `path`,
 * `line` and `arc` kinds (`STTPathLayer` / `STTArcLayer` inherit the
 * `extensions` option from `STTBatchedPolylineOptions` and forward it
 * untouched, so neither file needed changing).
 *
 * ## Why a VALUE hook, and not a shader hook
 * Each backend's extension seam follows its rendering model, and the three are
 * genuinely different shapes — this one is NOT a dialect of the other two:
 *
 * | backend  | model                       | extension seam                  |
 * |----------|-----------------------------|---------------------------------|
 * | deck     | luma programs it owns       | `LayerExtension`: GLSL `inject` |
 * | three    | TSL node graph              | a node hook spliced into it     |
 * | maplibre | one GLSL program per layer  | a `#pragma`-style chunk splice  |
 * | cesium   | **no shader of its own**    | this: a per-frame VALUE hook    |
 *
 * The last row is the whole argument. This package deleted `src/shaders.ts`;
 * every layer here animates on the CPU, writing a `Color` or four batch-table
 * bytes per feature per frame from a JS loop driven on `scene.preRender`. There
 * is no program of ours to splice into. The GLSL that actually draws these
 * features belongs to stock Cesium — `PointPrimitiveCollection`'s billboard
 * shader and `PolylineColorAppearance` — and swapping in a custom `Appearance`
 * to gain an injection point would forfeit the batching, the `scene.pick`
 * picking path and the batch-table animation that the rest of the package is
 * built on. Trading all of that for an injection seam would be a worse backend
 * with a better-sounding capability flag.
 *
 * So the seam is put where this backend's values are genuinely decided: the CPU
 * loop, one call per feature per frame, immediately after the layer has
 * resolved that feature's colour and opacity and immediately before it writes
 * them. That is a real hook into what is drawn — it moves the bytes that reach
 * the GPU — and it is honestly weaker than a shader hook. See
 * "What this deliberately does not do".
 *
 * ## ⚠ The oracle is composed with, never replaced
 * `test/time-filter-oracle.test.ts` is this package's conformance authority: it
 * asserts every alpha-computing layer derives its opacity from core's
 * `timeFilterAlpha`. An extension that COMPUTED the alpha would make that claim
 * false. So the contract is fixed and one-directional:
 *
 * ```text
 *   composed = hook( baseAlpha × timeFilterAlpha(mode, t, start, end, params) )
 * ```
 *
 * The hook receives the oracle's output as its argument. It never sees the
 * inputs, so it cannot re-derive the ramp, and a layer that stopped calling the
 * oracle would have nothing to pass it.
 *
 * ## The `lastAlpha` cache, and the ordering that keeps it honest
 * Both layers cache the last alpha they wrote and skip the write when this
 * frame's value matches — a feature fully inside or fully outside the window
 * then costs one compare instead of a GPU dirty. That cache survives here, but
 * only because of two decisions:
 *
 * 1. **The hooks run BEFORE the compare, and the compare tests the COMPOSED
 *    value.** The tempting optimisation is the other order — compare the
 *    oracle's alpha first and only call the hook for features that moved — and
 *    it is wrong. An extension's output can change while the oracle's does not
 *    (it reads a selection set, a hover id, a wall clock), and every such change
 *    would be silently dropped. Paying one hook call per feature per frame is
 *    the price of the cache being sound.
 *
 * 2. **The cache is keyed on alpha alone, so it is only valid while colour is
 *    constant per feature.** That holds for a stock layer and stops holding the
 *    moment a `color` hook exists: a hook cycling a hue at constant opacity
 *    would be written once and then frozen. So a `color` hook automatically
 *    clears {@link CompiledExtensions.skipUnchanged} and the layer writes every
 *    feature every frame.
 *
 * {@link CesiumLayerExtension.volatile} is the manual form of that switch. An
 * alpha-only hook does not need it — by (1) the layer already sees any change
 * the hook makes to the value it returns, and a change it does NOT make is a
 * write worth skipping. Set it when something OUTSIDE the layer also writes
 * these colours (an app that highlights a picked feature by assigning
 * `pointPrimitive.color` directly), because then `lastAlpha` no longer describes
 * what is on screen and the layer must re-assert its value each frame.
 *
 * ## Zero cost when empty
 * `compileExtensions(undefined | [] | [hookless…])` returns `null`, and each
 * layer stores that `null` in a field it checks once per feature. There is no
 * empty array to iterate, no identity function to call and no compiled object
 * to reach through: a layer with no extensions runs the loop it ran before this
 * file existed. `test/extensions.test.ts` pins both halves — the `null`, and the
 * unchanged write COUNT (i.e. the cache still fires).
 *
 * ## Allocation-free
 * The per-frame path allocates nothing. One {@link ExtensionFeature} scratch and
 * one {@link ExtensionOutput} scratch are owned by the compiled set and reused
 * for every feature of every frame; hooks receive scalars plus those scratches
 * and return a scalar or mutate in place. Hooks MUST NOT retain either object —
 * its fields belong to the next feature. (Same argument as the layers' shared
 * `Color` / `Uint8Array` scratches: JS is single-threaded and the frame loop
 * runs synchronously to completion.)
 *
 * ## What this deliberately does not do
 * - **No per-vertex or per-pixel reach.** One value per feature per frame is the
 *   ceiling, because that is what a batch-table colour and a `PointPrimitive`
 *   colour ARE. A gradient along an arc, a soft radial falloff, a dashed stroke
 *   — all things a GLSL splice can do — are out of reach here, and no amount of
 *   API shape fixes that. This is the same ceiling the package already documents
 *   for OD gradients collapsing to the source colour.
 * - **No geometry.** Positions are projected once when the tile set is
 *   published, not per frame; a hook cannot move a feature. (The layers that
 *   animate geometry rather than alpha — trips, trip heads, ego, mesh — are
 *   outside this seam entirely.)
 * - **Not deck's `LayerExtension`.** No `defaultProps`, no `getShaders`, no
 *   `getSubLayerProps`, no lifecycle, no picking override. Cloning that API onto
 *   a backend with no sublayers and no shaders would be a shell whose methods
 *   mostly could not be honoured.
 * - **No starter library of built-in extensions.** The capability is the hook;
 *   a bundled set of effects would be a second API surface with its own
 *   semantics to keep. The worked example below and the extensions authored in
 *   `test/extensions.test.ts` are the reference.
 * - **Not wired into all 23 layer kinds.** The four named above have it. The
 *   other kinds (column, icon, polygon, surfel, text, heatmap, hexbin, the
 *   summary tiers, the flow family) each own their own per-frame loop; adding
 *   the same three lines to each is mechanical, and deliberately not done here
 *   rather than done blind.
 * - **No error containment.** A hook that throws takes the frame down, loudly.
 *   A `try`/`catch` per feature per frame would cost real time to convert a
 *   visible crash into an invisible no-op.
 * - **No invalidation.** Hooks are evaluated when the playhead is driven. If
 *   yours reads state that changes while playback is PAUSED, drive the playhead
 *   again — the layer does not watch your state and cannot know it moved.
 *
 * ## Worked example
 * ```ts
 * let hoveredId: number | null = null;
 *
 * const focus: CesiumLayerExtension = {
 *   name: 'focus-hovered',
 *   // Nothing outside the layer writes these colours, and the alpha we return
 *   // changes whenever `hoveredId` does — so the cache stays sound and this
 *   // stays `false`. The `color` hook below clears it automatically anyway.
 *   volatile: false,
 *   alpha: (a, f) => (hoveredId === null || f.featureIndex === hoveredId ? a : a * 0.15),
 *   color: (out, _a, f) => {
 *     if (f.featureIndex !== hoveredId) return;
 *     out.r = 1; out.g = 0.85; out.b = 0.2;
 *   },
 * };
 *
 * new STTPointLayer(scene, { mode: 'window', extensions: [focus] });
 * ```
 */

import type { BinaryFeatures } from '@poopdeck.gl/core';

/**
 * The feature a hook is being asked about — a SHARED SCRATCH, refilled for
 * every feature of every frame. Read it inside the hook; never retain it.
 */
export interface ExtensionFeature {
  /** The layer that owns this compiled set (`STTPointLayer.id` etc.). Fixed. */
  readonly layerId: string;
  /**
   * The playhead, rebased to the layer's time origin (ms) — the exact value the
   * layer handed `timeFilterAlpha`, NOT the absolute epoch it was given.
   */
  time: number;
  /** The feature's active window, rebased to the same origin (ms). */
  start: number;
  end: number;
  /** Provenance: join to columns with `getFeatureProperties(binary, featureIndex)`. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** Mutable rgb, channels 0..1. A `color` hook writes into this in place. */
export interface ExtensionColor {
  r: number;
  g: number;
  b: number;
}

/** What {@link CompiledExtensions.apply} leaves for the layer to write. */
export interface ExtensionOutput extends ExtensionColor {
  alpha: number;
}

/**
 * One user extension. Both hooks are optional; an extension with neither is
 * legal and compiles away to nothing.
 *
 * Channels — `alpha` and the `color` hook's `r`/`g`/`b` — are all 0..1,
 * regardless of how the layer stores them internally (the batched polyline
 * layer keeps u8 and converts either side of the call, so one contract serves
 * both). Values are clamped to 0..1 after every hook; a non-finite return is
 * treated as 0, which blanks the channel rather than letting `NaN` reach a
 * `Uint8Array` write, where it would silently store a confident wrong byte.
 */
export interface CesiumLayerExtension {
  /**
   * Identity for this contract: it appears in {@link CompiledExtensions.names}
   * and in the duplicate diagnostic. Must be a non-empty string, and unique
   * within one layer's list — two entries under one name are the same extension
   * applied twice, which is the "merged two option objects" bug rather than an
   * intent, so it is refused at construction instead of silently squaring the
   * effect.
   */
  readonly name: string;
  /**
   * Force the layer to write every feature every frame, disabling the
   * alpha-keyed skip-if-unchanged cache. Implied by a `color` hook. Set it by
   * hand only when something outside the layer also writes these colours — see
   * the module header. @default false
   */
  readonly volatile?: boolean;
  /**
   * Transform the RESOLVED opacity. `alpha` is
   * `baseColorAlpha × timeFilterAlpha(...)` — the oracle's output, already
   * multiplied by the feature's base alpha. Return the new opacity (0..1).
   */
  alpha?(alpha: number, feature: Readonly<ExtensionFeature>): number;
  /**
   * Transform the RESOLVED colour, in place on `out`. Runs after EVERY `alpha`
   * hook in the list, so `alpha` here is the final composed opacity, whoever
   * produced it. Return value ignored.
   */
  color?(
    out: ExtensionColor,
    alpha: number,
    feature: Readonly<ExtensionFeature>,
  ): void;
}

/**
 * A list of extensions folded into the one object a per-frame loop calls.
 * Obtained from {@link compileExtensions}, which returns `null` when the list
 * has no hooks in it at all.
 */
export interface CompiledExtensions {
  /** Names of the extensions that contributed a hook, in application order. */
  readonly names: readonly string[];
  /** Does any extension transform alpha? */
  readonly hasAlpha: boolean;
  /** Does any extension transform colour? */
  readonly hasColor: boolean;
  /**
   * May the layer keep its alpha-keyed skip-if-unchanged cache? False when any
   * extension has a `color` hook or declares itself `volatile` — see the header.
   */
  readonly skipUnchanged: boolean;
  /** Call once per frame, before the feature loop, with the REBASED playhead. */
  beginFrame(time: number): void;
  /**
   * Compose the hooks over one feature's resolved values. Returns the compiled
   * set's own output scratch — read it immediately, do not retain it.
   *
   * @param alpha `baseColorAlpha × timeFilterAlpha(...)`, the oracle's output
   * @param r red 0..1
   * @param g green 0..1
   * @param b blue 0..1
   */
  apply(
    alpha: number,
    start: number,
    end: number,
    binary: BinaryFeatures,
    featureIndex: number,
    r: number,
    g: number,
    b: number,
  ): Readonly<ExtensionOutput>;
}

/**
 * Clamp to 0..1, mapping every non-finite value to 0.
 *
 * `NaN > 0` is false, so `NaN` falls out of the first branch as 0 — deliberate,
 * and the reason this is written as comparisons rather than `Math.min`/`max`
 * (which propagate `NaN`). A hook returning `NaN` blanks its feature, which is
 * visible on screen and quick to find; letting it through would reach
 * `Math.round(NaN × 255)` and store a 0 byte in one place and defeat the
 * `lastAlpha` compare (`NaN !== NaN`) in another, i.e. a silent per-frame
 * rewrite of an invisible feature.
 */
function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/** The concrete fold. Not exported — {@link compileExtensions} is the door. */
class ExtensionSet implements CompiledExtensions {
  readonly names: readonly string[];
  readonly hasAlpha: boolean;
  readonly hasColor: boolean;
  readonly skipUnchanged: boolean;

  /** Split once at construction so the hot loop never re-tests for a hook. */
  private readonly alphaHooks: ReadonlyArray<
    NonNullable<CesiumLayerExtension['alpha']>
  >;
  private readonly colorHooks: ReadonlyArray<
    NonNullable<CesiumLayerExtension['color']>
  >;

  /** The two per-frame scratches. Reused for every feature; never reallocated. */
  private readonly feature: ExtensionFeature;
  private readonly out: ExtensionOutput = { alpha: 0, r: 0, g: 0, b: 0 };

  constructor(active: readonly CesiumLayerExtension[], layerId: string) {
    this.names = active.map((e) => e.name);
    const alphaHooks: NonNullable<CesiumLayerExtension['alpha']>[] = [];
    const colorHooks: NonNullable<CesiumLayerExtension['color']>[] = [];
    let anyVolatile = false;
    for (const e of active) {
      // Bind each hook to its own extension so `this` inside a method-shorthand
      // hook is the object the caller wrote, not the compiled set.
      if (e.alpha) alphaHooks.push(e.alpha.bind(e));
      if (e.color) colorHooks.push(e.color.bind(e));
      if (e.volatile) anyVolatile = true;
    }
    this.alphaHooks = alphaHooks;
    this.colorHooks = colorHooks;
    this.hasAlpha = alphaHooks.length > 0;
    this.hasColor = colorHooks.length > 0;
    // A colour hook invalidates an alpha-keyed cache by construction; see the
    // module header's point (2).
    this.skipUnchanged = !this.hasColor && !anyVolatile;
    this.feature = {
      layerId,
      time: 0,
      start: 0,
      end: 0,
      // Placeholder until the first `apply`; never read before then, because a
      // hook only ever sees the scratch through an `apply` that just filled it.
      binary: undefined as unknown as BinaryFeatures,
      featureIndex: 0,
    };
  }

  beginFrame(time: number): void {
    this.feature.time = time;
  }

  apply(
    alpha: number,
    start: number,
    end: number,
    binary: BinaryFeatures,
    featureIndex: number,
    r: number,
    g: number,
    b: number,
  ): Readonly<ExtensionOutput> {
    const f = this.feature;
    f.start = start;
    f.end = end;
    f.binary = binary;
    f.featureIndex = featureIndex;

    // Pass 1 — alpha, in list order, each hook seeing the previous one's result.
    let a = alpha;
    for (const hook of this.alphaHooks) a = clamp01(hook(a, f));

    // Pass 2 — colour, seeded with what the layer resolved and given the FINAL
    // composed alpha. Clamped after each hook so every hook sees a legal colour.
    const out = this.out;
    out.alpha = a;
    out.r = r;
    out.g = g;
    out.b = b;
    for (const hook of this.colorHooks) {
      hook(out, a, f);
      out.r = clamp01(out.r);
      out.g = clamp01(out.g);
      out.b = clamp01(out.b);
    }
    // `out` is handed to colour hooks as an `ExtensionColor`, which hides
    // `alpha` from TypeScript but not from JavaScript. Re-assert it so a hook
    // that scribbles on the field cannot change an opacity it was not given.
    out.alpha = a;
    return out;
  }
}

/**
 * Fold a user's extension list into the object a layer's per-frame loop calls,
 * or `null` when there is nothing to call.
 *
 * `null` is the zero-cost case and it is deliberately the ONLY signal: callers
 * store it in a field and branch on `!== null` once per feature, so an empty
 * list costs nothing at all rather than costing an empty iteration. Extensions
 * carrying neither hook are dropped for the same reason — a caller assembling a
 * list from feature flags gets the fast path back when every flag is off.
 *
 * Throws on a blank or duplicated `name`. Both are caller bugs, and both are
 * cheap to raise here (once, at layer construction) and expensive to notice
 * later: a duplicate silently applies its transform twice.
 */
export function compileExtensions(
  extensions: readonly CesiumLayerExtension[] | undefined,
  layerId: string,
): CompiledExtensions | null {
  if (!extensions || extensions.length === 0) return null;

  // Validate over everything the caller passed, INCLUDING hookless entries: a
  // name collision is a bug whether or not the colliding entry does anything.
  const seen = new Set<string>();
  for (const e of extensions) {
    if (typeof e.name !== 'string' || e.name.length === 0) {
      throw new Error(
        `[${layerId}] every extension needs a non-empty \`name\` (got ${JSON.stringify(e.name)})`,
      );
    }
    if (seen.has(e.name)) {
      throw new Error(
        `[${layerId}] duplicate extension name "${e.name}" — two entries under one name apply the same transform twice`,
      );
    }
    seen.add(e.name);
  }

  const active = extensions.filter((e) => e.alpha || e.color);
  return active.length === 0 ? null : new ExtensionSet(active, layerId);
}
