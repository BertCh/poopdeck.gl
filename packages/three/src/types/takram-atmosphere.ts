// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Local declaration shim for `@takram/three-atmosphere` — the ONLY reason this
 * file exists is a TypeScript *resolution* mismatch, never a runtime one.
 *
 * WHY THIS IS NEEDED
 * ──────────────────
 * This package type-checks under `moduleResolution: NodeNext` (tsconfig.pkg.json).
 * `@takram/three-atmosphere` is `"type": "module"` and its shipped `.d.ts`
 * barrels re-export with EXTENSIONLESS specifiers (`export * from './accessors'`),
 * which NodeNext refuses to resolve. The net effect: a bare
 *   `import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'`
 * type-checks to "Module has no exported member 'AtmosphereContext'" even though
 * the runtime JS import resolves and works perfectly (verified: the bundler-mode
 * probe finds every member).
 *
 * Under `bundler` resolution the imports DO resolve, leaving only two node-API
 * *version-drift* errors — takram was built against a `three` build very close to
 * but not identical to 0.184, so `AtmosphereLightNode.update()` is typed `void`
 * (vs 0.184's `boolean | undefined`) and `AerialPerspectiveNode.setup()` returns
 * `unknown` (vs `Node`). Neither is a missing-runtime-API problem.
 *
 * THE FIX
 * ───────
 * Re-declare ONLY the members we actually call, typed against three@0.184's own
 * `three`/`three/webgpu` types where that is clean, and loosely (the light-node
 * constructor is typed as a plain `AnalyticLightNode` factory, the sky/aerial
 * nodes as `Node`) exactly where the drift would otherwise bite. We never call
 * `update()`/`setup()` ourselves — we only hand the light-node CLASS to
 * `renderer.library.addLight` — so their drifting return types are irrelevant.
 *
 * These are ambient module declarations (no top-level import/export — every
 * external type is referenced via inline `import('…')`), so they MERGE with the
 * (empty, resolution-failed) real module and supply the members NodeNext dropped.
 * Keep this minimal: add a member here only when the atmosphere factory uses it.
 *
 * FILE EXTENSION: this is a plain `.ts` (an ambient-declaration script), NOT a
 * `.d.ts`, on purpose — the repo `.gitignore` ignores declaration files under any
 * `src` directory (to drop EMITTED declarations), which would otherwise strand
 * this hand-written shim untracked and break the build on a fresh checkout. As a
 * `.ts` it is tracked and still included by tsconfig's `src` glob; it emits only
 * an empty `.js`.
 */

declare module '@takram/three-atmosphere/webgpu' {
  /**
   * The atmosphere's per-frame uniform bag. We touch only the ECEF direction /
   * matrix uniforms; every other field (`matrixECEFToWorld`, `cameraPositionECEF`,
   * …) auto-derives from `matrixWorldToECEF` via the context's own render hooks.
   */
  export class AtmosphereContext {
    constructor(parameters?: unknown, lutNode?: unknown);
    // These are takram `UniformNode`s at runtime; we only ever read/mutate their
    // `.value`, so we type just that (also sidesteps the `UniformNode` type-arg
    // arity drift between takram's build and three 0.184).
    /** World→ECEF transform — the alignment matrix we set (see atmosphere.ts). */
    matrixWorldToECEF: { value: import('three').Matrix4 };
    /** ECI→ECEF rotation for the star field (set per frame from the date). */
    matrixECIToECEF: { value: import('three').Matrix4 };
    /** Sun direction in ECEF (set per frame — this is what drives day/night). */
    sunDirectionECEF: { value: import('three').Vector3 };
    /** Moon direction in ECEF (set per frame for the night sky). */
    moonDirectionECEF: { value: import('three').Vector3 };
    /** Reference camera; falls back to the render camera when unset. */
    camera?: import('three').Camera;
    /** The datum ellipsoid (defaults to WGS84); loosely typed — geospatial is not shimmed. */
    ellipsoid: unknown;
    correctAltitude: boolean;
    dispose(): void;
  }

  /**
   * The sun/moon directional light. Instances ARE a `three` `DirectionalLight`
   * (takram extends it), so `scene.add(new AtmosphereLight())` and the
   * `addLight` `lightClass` slot both accept it.
   */
  export const AtmosphereLight: {
    new (
      distance?: number,
      body?: 'sun' | 'moon',
    ): import('three').DirectionalLight;
  };

  /**
   * The analytic light node paired with {@link AtmosphereLight} via
   * `renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)`. Typed as a
   * bare `AnalyticLightNode` factory so the `update()`/`setup()` return-type drift
   * (see file header) never surfaces — we only pass the class, never call it.
   */
  export const AtmosphereLightNode: {
    new (
      light?: import('three').DirectionalLight | null,
    ): import('three/webgpu').AnalyticLightNode<
      import('three').DirectionalLight
    >;
  };

  /** MRT view-Z accessor fed into `mrt({ output, viewZUnit })` for the pass. */
  export const viewZUnit: import('three/webgpu').Node;

  /** Aerial-perspective post node: composites inscattering/transmittance over the pass. */
  export function aerialPerspective(
    colorNode: import('three/webgpu').Node,
    depthNode: import('three/webgpu').Node,
    normalNode?: import('three/webgpu').Node | null,
    shadowLengthNode?: import('three/webgpu').Node | null,
  ): import('three/webgpu').Node;

  /** Physical sky node (camera scope) — usable as a background node. */
  export function sky(
    shadowLengthNode?: import('three/webgpu').Node | number | null,
  ): import('three/webgpu').Node;

  /** Physical sky node intended for `scene.backgroundNode`. */
  export function skyBackground(
    shadowLengthNode?: import('three/webgpu').Node | number | null,
  ): import('three/webgpu').Node;

  /** Image-based sky lighting node for `scene.environmentNode`. */
  export function skyEnvironment(
    size?: number,
  ): import('three/webgpu').Node<'vec3'>;
}

declare module '@takram/three-atmosphere' {
  /** Unit sun direction in ECEF for a given instant (mutates `result` if given). */
  export function getSunDirectionECEF(
    date: number | Date,
    result?: import('three').Vector3,
    observerECEF?: import('three').Vector3,
  ): import('three').Vector3;

  /** Unit moon direction in ECEF for a given instant (mutates `result` if given). */
  export function getMoonDirectionECEF(
    date: number | Date,
    result?: import('three').Vector3,
    observerECEF?: import('three').Vector3,
  ): import('three').Vector3;

  /** ECI→ECEF rotation matrix for a given instant (mutates `result` if given). */
  export function getECIToECEFRotationMatrix(
    date: number | Date,
    result?: import('three').Matrix4,
  ): import('three').Matrix4;
}
