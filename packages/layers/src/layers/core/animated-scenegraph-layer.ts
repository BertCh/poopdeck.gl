// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedScenegraphLayer — a full glTF SCENEGRAPH (node hierarchy, PBR
 * materials, per-node animation) instanced at each tracked object's interpolated
 * pose. It is to {@link AnimatedMeshLayer} exactly what deck's
 * `ScenegraphLayer` is to its `SimpleMeshLayer`: the same data, the same pose,
 * a heavier and more faithful render engine. The catalog mirrors deck's own
 * split rather than hiding it behind a mode flag.
 *
 * ── WHY IT EXISTS: authored assets, not primitives ───────────────────────────
 * This is the consumption end of an OpenUSD pipeline
 * ([openusd-integration-2026-07.md §8.5a](../../../../../docs/roadmap/openusd-integration-2026-07.md)):
 * author a vehicle / machine / building in Omniverse or any USD DCC, export it
 * to glTF, and drop it into the geospatial time scene at every tracked object's
 * pose. STT contributes the axis and the streaming; the asset contributes the
 * look. Nothing about this layer is USD-specific — it renders any glTF 2.0 — but
 * that is the workflow it was added for, and the constraints below are the ones
 * that pipeline actually hits.
 *
 * ── DATA + MOTION: inherited verbatim ────────────────────────────────────────
 * Everything upstream of the draw call is {@link AnimatedMeshLayer}'s: the AV
 * `objects/` point archive read as one POINT feature per tracked object per
 * keyframe, cross-tile pooling by `track_id`, binary-search + lerp, shortest-arc
 * heading, quaternion slerp via `quaternionColumn`, appear/disappear fade,
 * grow-only instance buffers, lazy pick rows, the geometry-kind guard. This
 * subclass overrides ONLY the engine seams, so the two layers are
 * interchangeable over one archive and one config — swap the class, keep the
 * props.
 *
 * ── RENDER: ScenegraphLayer (@deck.gl/mesh-layers) ───────────────────────────
 * `getPosition` / `getOrientation` / `getScale` / `getTranslation` /
 * `getTransformMatrix` / `getColor` / `sizeScale` are the SAME prop names deck's
 * ScenegraphLayer takes, so the inherited pose bake needs no translation. Added
 * here: {@link _AnimatedScenegraphLayerProps.scenegraph} (the asset — deck's own
 * prop name), {@link _AnimatedScenegraphLayerProps.scenegraphMapping} (the
 * per-category map), `_lighting`, `_imageBasedLightingEnvironment`,
 * `_animations`, `sizeMinPixels`, `sizeMaxPixels`, `getScene`, `getAnimator`,
 * `onFirstDraw`, plus {@link _AnimatedScenegraphLayerProps.scenegraphLoadOptions}
 * (see the note on that prop — the base's `loadOptions` is NOT available for
 * this).
 *
 * ── FOUR CONSTRAINTS, VERIFIED AGAINST deck 9.3.2 / luma 9.3.3 ───────────────
 * These are properties of deck's ScenegraphLayer, not of this wrapper. They are
 * written down here because each one silently changes what an authored asset
 * looks like in the browser versus in the DCC it came from.
 *
 *  1. **SKINNED GEOMETRY DOES NOT DEFORM.** `scenegraph-layer-vertex.glsl`
 *     declares `positions`, `texCoords` and `normals` only — no `JOINTS_0` /
 *     `WEIGHTS_0` — and `_getModelOptions()` injects deck's own vs/fs into every
 *     glTF model (`modelOptions: {...this.getShaders()}`), replacing the shader
 *     luma would have generated. luma.gl 9.3.3 itself HAS skinning; deck's
 *     instanced path does not reach it. A rigged pedestrian renders in bind
 *     pose. Bake deformation into per-node transforms, or use separate meshes.
 *  2. **RIGID PER-NODE ANIMATION DOES WORK** — `draw()` traverses the scenegraph
 *     with `worldMatrix` into a per-model `sceneModelMatrix` uniform and
 *     `GLTFAnimator` drives node TRS. Wheels spin, doors open, booms swing.
 *  3. **…BUT ON DECK'S CLOCK, NOT THE PLAYHEAD.** `draw()` calls
 *     `animator.setTime(context.timeline.getTime())`. That is deck's own
 *     timeline; STT drives `currentTime`. So `_animations` runs on wall-clock
 *     and does NOT rewind when the timeline is scrubbed, and it needs
 *     `_animate: true` on the Deck instance (which forces a continuous redraw —
 *     mind the `prefers-reduced-motion` gate). {@link _AnimatedScenegraphLayerProps._animations}
 *     warns once. Playhead-locked asset animation needs a `draw()` override and
 *     is deliberately not in this pass.
 *  4. **MATERIALS ARE FILTERED TWICE** on the USD route. Omniverse's
 *     `omni.kit.asset_converter` emits only OmniPBR / UsdPreviewSurface /
 *     `gltf.mdl` when exporting USD → glTF; then loaders.gl carries
 *     `KHR_draco_mesh_compression`, `KHR_texture_basisu`,
 *     `EXT_meshopt_compression`, `EXT_texture_webp` and `KHR_texture_transform`
 *     but has NO handler for `KHR_materials_clearcoat` / `_transmission` /
 *     `_sheen` / `_ior`, and deck hardcodes `useTangents: false`. Author to
 *     UsdPreviewSurface, stay on core metallic-roughness, and expect no
 *     tangent-space normal mapping.
 *
 * ── TWO THINGS THIS DOES BETTER THAN THE MESH SIBLING ────────────────────────
 *  • **Fades survive a textured asset.** SimpleMeshLayer lets a `texture` win
 *    over `getColor`, which kills the CPU appear/disappear alpha (the base layer
 *    warns about exactly this). ScenegraphLayer MULTIPLIES instead —
 *    `fragColor = vColor * pbr_filterColor(...)` in PBR mode,
 *    `vColor * texture(baseColorSampler, uv)` in flat+textured mode — so the
 *    fade, the per-category color and `opacity` all modulate a fully textured
 *    PBR asset. The inherited white default (`[255,255,255,255]`) is the
 *    identity for that multiply, which is why it is the right default here too.
 *  • **`scaleToDimensions` defaults to FALSE here.** The inherited default
 *    (`true`) fits a UNIT-sized model to each object's `[length, width, height]`
 *    box — correct for a normalized primitive, wrong for an authored asset,
 *    which arrives already in real metres via USD's `metersPerUnit`. Leaving the
 *    inherited default would silently squash every exported vehicle. Set it back
 *    to `true` if your asset really is unit-sized.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`scenegraph`**.
 */

import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import type { DefaultProps } from '@deck.gl/core';
import {
  AnimatedMeshLayer,
  type AnimatedMeshLayerProps,
  type EngineClass,
  type MeshSource,
} from './animated-mesh-layer.js';
import { warnOnce } from '../../lib/log.js';

/**
 * A glTF scenegraph source ScenegraphLayer accepts — a `.gltf`/`.glb` URL, an
 * already-parsed/post-processed glTF object, a luma.gl `ScenegraphNode`, or a
 * promise of one. Structurally loose for the same reason {@link MeshSource} is:
 * the value is forwarded, never inspected.
 */
export type ScenegraphSource = MeshSource;

/** Per-animation controls, matching deck's `_animations` shape. */
export interface ScenegraphAnimationConfig {
  /** Whether the animation is playing. */
  playing?: boolean;
  /** Start time of the animation. @default 0 */
  startTime?: number;
  /** Speed multiplier. @default 1 */
  speed?: number;
}

/** Props added by {@link AnimatedScenegraphLayer} (own props only). */
export interface _AnimatedScenegraphLayerProps {
  /**
   * The STATIC glTF scenegraph instanced at every tracked object's pose — a
   * `.gltf`/`.glb` URL, a parsed glTF, a luma.gl `ScenegraphNode`, or a promise
   * of one (deck `ScenegraphLayer`'s `scenegraph` prop, forwarded verbatim).
   * A per-LAYER prop, NOT a tile column.
   *
   * Falls back to the inherited `mesh` when unset, so a config written for
   * {@link AnimatedMeshLayer} drives this layer unchanged. When
   * {@link scenegraphMapping} is set this is the fallback for categories absent
   * from the map; with neither, the layer renders nothing and warns once.
   * @default null
   */
  scenegraph?: ScenegraphSource;

  /**
   * Per-CATEGORY scenegraph map, keyed by the raw `colorProperty` category
   * string — cars, pedestrians and cyclists each get their own asset. One
   * sublayer is emitted per category (the asset is a per-layer prop), each
   * falling back to {@link scenegraph}. Falls back to the inherited
   * `meshMapping` when unset.
   * @default null
   */
  scenegraphMapping?: Record<string, ScenegraphSource> | null;

  /**
   * Lighting mode — deck `ScenegraphLayer` `_lighting` pass-through. `'pbr'`
   * runs the glTF's metallic-roughness material through luma's PBR module (and
   * is what an authored asset expects); `'flat'` (deck's default, kept here)
   * draws the base color unlit, which is cheaper and reads better at gallery
   * zoom where a vehicle is a few pixels.
   * @default 'flat'
   */
  _lighting?: 'flat' | 'pbr';

  /**
   * Image-based lighting environment — deck pass-through. Requires
   * `_lighting: 'pbr'`; ignored otherwise (this layer warns once).
   * @default undefined
   */
  _imageBasedLightingEnvironment?: unknown;

  /**
   * (Experimental) glTF animation configuration, keyed by animation index, name,
   * or `'*'` for all — deck `_animations` pass-through.
   *
   * ⚠️ Two caveats, both verified against deck 9.3.2 and warned about once at
   * render time. (1) It runs on **deck's own `context.timeline`**, not the STT
   * playhead, so a scrub of the timeline does not rewind the asset's animation
   * and a paused playhead does not pause it. (2) It requires `_animate: true` on
   * the Deck instance to tick at all, which forces a continuous redraw loop —
   * gate that behind `prefers-reduced-motion` like any other animated surface.
   * Only per-node (TRS) animation plays; skinned deformation never does (see the
   * file header).
   * @default null
   */
  _animations?: Record<string, ScenegraphAnimationConfig> | null;

  /**
   * Minimum instance size in pixels — deck `sizeMinPixels` pass-through. Keeps
   * an asset legible when zoomed out; `0` lets it shrink to nothing.
   * @default 0
   */
  sizeMinPixels?: number;

  /**
   * Maximum instance size in pixels — deck `sizeMaxPixels` pass-through.
   * @default Number.MAX_SAFE_INTEGER
   */
  sizeMaxPixels?: number;

  /**
   * Build the luma.gl `GroupNode` from the resolved {@link scenegraph} — deck
   * `getScene` pass-through, forwarded only when set (deck's default handles
   * every ordinary glTF). Escape hatch for a hand-assembled scene.
   * @default null
   */
  getScene?: ((scenegraph: any, context: any) => any) | null;

  /**
   * Build the `GLTFAnimator` from the resolved {@link scenegraph} — deck
   * `getAnimator` pass-through, forwarded only when set.
   * @default null
   */
  getAnimator?: ((scenegraph: any, context: any) => any) | null;

  /**
   * Called after the layer's first successful draw — deck `onFirstDraw`
   * pass-through. Forwarded only when set.
   * @default null
   */
  onFirstDraw?: (() => void) | null;

  /**
   * Load options for the glTF fetch/parse, forwarded to the sublayer's
   * `loadOptions` — e.g. `{gltf: {decompressMeshes: true}}` for a Draco-
   * compressed export, or KTX2/Basis options for a supercompressed texture set.
   *
   * A DEDICATED prop because the base repurposes deck's `loadOptions` as
   * `SttLoadOptions` for archive HTTP (only `loadOptions.fetch` is consumed, and
   * it is deliberately not forwarded to sublayers), so glTF load options have no
   * inherited path down. Forwarded only when set.
   * @default null
   */
  scenegraphLoadOptions?: Record<string, unknown> | null;
}

/** Complete props accepted by {@link AnimatedScenegraphLayer}. */
export type AnimatedScenegraphLayerProps = _AnimatedScenegraphLayerProps &
  AnimatedMeshLayerProps;

/**
 * Animated glTF-scenegraph layer — one authored, PBR-lit, CPU-interpolated
 * asset per tracked object. See the file header for the inherited motion model
 * and for the four deck-level constraints an authored (e.g. USD-exported) asset
 * runs into.
 *
 * Sublayer short id for `_subLayerProps` overrides / `getSubLayerClass`:
 * **`scenegraph`**.
 */
export class AnimatedScenegraphLayer<
  ExtraPropsT extends {} = {},
> extends AnimatedMeshLayer<
  ExtraPropsT & Required<_AnimatedScenegraphLayerProps>
> {
  static layerName = 'AnimatedScenegraphLayer';

  static defaultProps: DefaultProps<AnimatedScenegraphLayerProps> = {
    ...AnimatedMeshLayer.defaultProps,
    // Permissive descriptors ({type:'object'}) hold an asset source / map /
    // function / null, which deck's typed validators would reject.
    scenegraph: { type: 'object', value: null, optional: true, compare: true },
    scenegraphMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    // deck's own default. 'pbr' is the faithful mode for an authored asset; the
    // cheap flat mode stays the default so swapping the class never silently
    // adds a PBR pass per instance.
    _lighting: 'flat',
    _imageBasedLightingEnvironment: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    _animations: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    sizeMinPixels: { type: 'number', value: 0, min: 0 },
    sizeMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    getScene: { type: 'object', value: null, optional: true, compare: true },
    getAnimator: { type: 'object', value: null, optional: true, compare: true },
    onFirstDraw: { type: 'object', value: null, optional: true, compare: true },
    scenegraphLoadOptions: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    // An authored asset carries real-world metres (USD `metersPerUnit`), so the
    // inherited unit-model-to-bbox fit would squash it. See the file header.
    scaleToDimensions: false,
  };

  // -------------------------------------------------------------------------
  // Engine seams (the whole override surface — see AnimatedMeshLayer's header)
  // -------------------------------------------------------------------------

  /** `scenegraph`/`scenegraphMapping` first, then the inherited `mesh`/`meshMapping`. */
  protected override resolveAssets(): {
    asset: MeshSource;
    mapping: Record<string, MeshSource> | null;
  } {
    const inherited = super.resolveAssets();
    return {
      asset: (this.props.scenegraph ?? inherited.asset) as MeshSource,
      mapping: this.props.scenegraphMapping ?? inherited.mapping,
    };
  }

  protected override missingAssetWarning(): [string, string] {
    return [
      'AnimatedScenegraphLayer:noScenegraph',
      '[AnimatedScenegraphLayer] no `scenegraph` (and no `scenegraphMapping` / ' +
        'inherited `mesh`) — nothing to render. Provide a glTF 2.0 `.gltf`/`.glb` ' +
        "via the `scenegraph` prop (a static per-layer prop, like IconLayer's " +
        'iconAtlas).',
    ];
  }

  protected override warnEngineCaveats(): void {
    // Deliberately NOT calling super: the inherited warning is about a `texture`
    // defeating getColor, which is a SimpleMeshLayer behaviour. ScenegraphLayer
    // multiplies getColor into the material, so fades work here (file header).
    if (this.props._animations) {
      warnOnce(
        'AnimatedScenegraphLayer:animationClock',
        "[AnimatedScenegraphLayer] `_animations` is driven by deck's own " +
          '`context.timeline`, NOT the STT playhead: glTF animation runs on ' +
          'wall-clock, does not rewind when the timeline is scrubbed, and does ' +
          'not stop when playback pauses. It also needs `_animate: true` on the ' +
          'Deck instance to tick at all (a continuous redraw loop — gate it ' +
          'behind prefers-reduced-motion). Per-node (TRS) animation plays; ' +
          'skinned deformation does not (deck injects its own vertex shader, ' +
          'which declares no JOINTS_0/WEIGHTS_0).',
      );
    }
    if (
      this.props._imageBasedLightingEnvironment &&
      this.props._lighting !== 'pbr'
    ) {
      warnOnce(
        'AnimatedScenegraphLayer:iblWithoutPbr',
        '[AnimatedScenegraphLayer] `_imageBasedLightingEnvironment` requires ' +
          "`_lighting: 'pbr'` — it is ignored in the default 'flat' mode.",
      );
    }
    // Props inherited from the mesh sibling that this engine has no concept of.
    // Silently dropping them would read as "my material/wireframe did nothing".
    const inert: string[] = [];
    if (this.props.texture) inert.push('texture');
    if (this.props.textureParameters) inert.push('textureParameters');
    if (this.props.wireframe) inert.push('wireframe');
    if (this.props._instanced === false) inert.push('_instanced');
    if (inert.length > 0) {
      warnOnce(
        'AnimatedScenegraphLayer:inertMeshProps',
        `[AnimatedScenegraphLayer] ${inert.join(', ')} ${
          inert.length === 1 ? 'is a' : 'are'
        } SimpleMeshLayer prop${inert.length === 1 ? '' : 's'} with no ` +
          'ScenegraphLayer equivalent and ha' +
          (inert.length === 1 ? 's' : 've') +
          ' no effect here. A glTF carries its own materials and textures; use ' +
          "`_lighting: 'pbr'` for material fidelity, or AnimatedMeshLayer for a " +
          'flat mesh + separate texture.',
      );
    }
  }

  protected override engineSubLayerId(): string {
    return 'scenegraph';
  }

  protected override engineClass(): EngineClass {
    return ScenegraphLayer as unknown as EngineClass;
  }

  protected override engineProps(asset: MeshSource): Record<string, unknown> {
    // NOTE: no `material` / `wireframe` / `texture` / `_instanced` — see
    // warnEngineCaveats. Optional pass-throughs are spread in only when set so
    // deck's own defaults stay in force (passing null would override them).
    return {
      scenegraph: asset,
      _lighting: this.props._lighting ?? 'flat',
      sizeMinPixels: this.props.sizeMinPixels ?? 0,
      sizeMaxPixels: this.props.sizeMaxPixels ?? Number.MAX_SAFE_INTEGER,
      ...(this.props._imageBasedLightingEnvironment
        ? {
            _imageBasedLightingEnvironment:
              this.props._imageBasedLightingEnvironment,
          }
        : {}),
      ...(this.props._animations
        ? { _animations: this.props._animations }
        : {}),
      ...(this.props.getScene ? { getScene: this.props.getScene } : {}),
      ...(this.props.getAnimator
        ? { getAnimator: this.props.getAnimator }
        : {}),
      ...(this.props.onFirstDraw
        ? { onFirstDraw: this.props.onFirstDraw }
        : {}),
      ...(this.props.scenegraphLoadOptions
        ? { loadOptions: this.props.scenegraphLoadOptions }
        : {}),
      // deck's `loaders` is already a base LayerProp (defaulted to [GLTFLoader]
      // by ScenegraphLayer itself), so it is not redeclared above — just passed
      // down when a caller set one, leaving deck's default in force otherwise.
      ...(this.props.loaders?.length ? { loaders: this.props.loaders } : {}),
    };
  }
}
