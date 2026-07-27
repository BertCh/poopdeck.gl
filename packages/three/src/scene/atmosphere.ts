// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Physically-based atmosphere / sky / day-night for the WebGPU (TSL) renderer,
 * wrapping `@takram/three-atmosphere`'s precomputed-scattering nodes into an
 * STT-shaped, **opt-in, default-OFF** helper. Enable it only on `'webgpu'`; the
 * WebGL2 fallback degrades gracefully (the atmosphere is simply absent).
 *
 * WHAT IT SETS UP (in priority order — biggest visual win first)
 * ─────────────────────────────────────────────────────────────
 *   1. Sky background   — `scene.backgroundNode = skyBackground()`
 *   2. Sun/moon light    — `AtmosphereLight` registered + added to the scene
 *   3. Environment IBL   — `scene.environmentNode = skyEnvironment()`
 *   4. Aerial perspective — a `pass → MRT → aerialPerspective` post pipeline that
 *      the caller renders THROUGH via {@link STTAtmosphere.render} instead of
 *      `renderer.render(scene, camera)`. Falls back to a plain render when aerial
 *      perspective is off or the atmosphere is disabled — so `render()` is always
 *      safe to call as the scene's single draw entry point.
 *
 * The sun position is driven by a `Date`, so wiring the playhead time through
 * {@link STTAtmosphere.update} makes the sky track the data's clock (dawn → dusk).
 *
 * ── ECEF FRAME ALIGNMENT (correctness-critical) ──────────────────────────────
 * Takram reads a `matrixWorldToECEF` uniform to relate the render world to the
 * Earth. STT and takram share the SAME ECEF axes — `+X` at (lon 0°, lat 0°),
 * `+Y` at (lon 90°E, lat 0°), `+Z` at the north pole (takram's `Geodetic.toECEF`
 * builds `(cos φ·cos λ, cos φ·sin λ, sin φ)`, identical to STT's `GlobeProjection`)
 * — so the matrix is a pure similarity transform, never an axis swap. See
 * {@link computeWorldToEcef}.
 */

import { Matrix4, Vector3, MathUtils } from 'three';
import type { Scene, Camera } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import {
  EARTH_RADIUS,
  type GeoAnchor,
  type Projection,
} from '../projection/local-enu.js';

const { degToRad } = MathUtils;

/** WGS84 first-eccentricity-squared (matches `@poopdeck.gl/core`'s GlobeProjection). */
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

// ─── Pure ECEF / date / option math (node-testable; no takram, no GPU) ─────────

/**
 * Geodetic lon/lat (degrees) + height (m) → WGS84 ECEF metres. Byte-for-byte the
 * same formula as `GlobeProjection`'s `'wgs84'` branch, so the anchor we hand the
 * atmosphere lands exactly where STT's globe data does.
 */
export function geodeticToEcef(
  longitudeDeg: number,
  latitudeDeg: number,
  heightM = 0,
  result = new Vector3(),
): Vector3 {
  const lon = degToRad(longitudeDeg);
  const lat = degToRad(latitudeDeg);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = EARTH_RADIUS / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return result.set(
    (n + heightM) * cosLat * Math.cos(lon),
    (n + heightM) * cosLat * Math.sin(lon),
    (n * (1 - WGS84_E2) + heightM) * sinLat,
  );
}

/**
 * The geodetic East/North/Up unit basis at a lon/lat, expressed in ECEF — the
 * same columns as takram's `Ellipsoid.getEastNorthUpVectors` (and STT's
 * `GlobeProjection.localFrame`) for a point on the surface.
 */
export function enuBasisEcef(
  longitudeDeg: number,
  latitudeDeg: number,
): { east: Vector3; north: Vector3; up: Vector3 } {
  const lon = degToRad(longitudeDeg);
  const lat = degToRad(latitudeDeg);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  return {
    east: new Vector3(-sinLon, cosLon, 0),
    north: new Vector3(-sinLat * cosLon, -sinLat * sinLon, cosLat),
    up: new Vector3(cosLat * cosLon, cosLat * sinLon, sinLat),
  };
}

/**
 * The world→ECEF matrix takram's atmosphere consumes, derived from STT's
 * projection so the sun/sky align with the earth.
 *
 *   • **Globe** (`GlobeProjection`): STT world coords ARE ECEF metres up to a
 *     uniform scale (world = ECEF·`radius/EARTH_RADIUS`), so world→ECEF is the
 *     inverse uniform scale `metersPerWorldUnit()` — the IDENTITY at the default
 *     radius. No rotation: the axes already coincide.
 *   • **Local ENU / mercator**: STT world is a Z-up ENU tangent frame at the
 *     anchor (X=East, Y=North, Z=Up). World→ECEF is that frame's placement: the
 *     `[East|North|Up]` basis (columns, matching STT's world axis order — the
 *     same as `Ellipsoid.getEastNorthUpFrame`, NOT `getNorthUpEastFrame`, which is
 *     for a Y-up world) translated to the anchor's ECEF position. The basis is
 *     orthonormal, so takram's `matrixECEFToWorld = transpose(matrixWorldToECEF)`
 *     stays a valid inverse-rotation for the sun/moon/star DIRECTIONS.
 */
export function computeWorldToEcef(
  projection: Projection,
  anchor?: GeoAnchor,
): Matrix4 {
  const a = anchor ?? projection.anchor;
  const m = new Matrix4();
  if (projection.kind === 'globe') {
    const mpwu = projection.metersPerWorldUnit(a.longitude, a.latitude);
    return m.makeScale(mpwu, mpwu, mpwu);
  }
  const origin = geodeticToEcef(a.longitude, a.latitude, 0);
  const { east, north, up } = enuBasisEcef(a.longitude, a.latitude);
  return m.makeBasis(east, north, up).setPosition(origin);
}

/**
 * Resolve the instant the sun/moon are positioned for. A `Date` is used verbatim;
 * a number is a playhead epoch-ms mapped through `getDate` (default `new Date(t)`)
 * so the sky can track the data's clock; `undefined` falls back to "now".
 */
export function resolveSunDate(
  input: Date | number | undefined,
  getDate?: (time: number) => Date,
): Date {
  if (input instanceof Date) return input;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return getDate ? getDate(input) : new Date(input);
  }
  return new Date();
}

/** Opt-in atmosphere knobs (each sub-feature defaults ON once the atmosphere is on). */
export interface AtmosphereOptions {
  /**
   * Override the lon/lat the local/mercator world→ECEF frame is anchored at.
   * Ignored for globe scenes (world is already ECEF). @default projection.anchor
   */
  anchor?: GeoAnchor;
  /** Map a playhead epoch-ms to the sun's `Date`. @default `(t) => new Date(t)` */
  getDate?: (time: number) => Date;
  /** Physical sky as the scene background. @default true */
  sky?: boolean;
  /** Image-based lighting from the sky (`scene.environmentNode`). @default true */
  environment?: boolean;
  /** Add the `AtmosphereLight` sun/moon directional light. @default true */
  light?: boolean;
  /** Compose aerial perspective (inscattering/transmittance) over the scene. @default true */
  aerialPerspective?: boolean;
  /** MSAA sample count for the render pass. @default 0 */
  samples?: number;
}

/** {@link AtmosphereOptions} with every sub-feature flag concretely resolved. */
export interface ResolvedAtmosphereOptions {
  sky: boolean;
  environment: boolean;
  light: boolean;
  aerialPerspective: boolean;
  samples: number;
  anchor?: GeoAnchor;
  getDate?: (time: number) => Date;
}

/**
 * Normalize the caller's `atmosphere` prop: `false`/`undefined` → `null`
 * (disabled), `true` → all defaults, an object → its fields over the defaults.
 * Pure + total, so the viewer/r3f enablement branch is unit-testable.
 */
export function resolveAtmosphereOptions(
  opts: boolean | AtmosphereOptions | undefined,
): ResolvedAtmosphereOptions | null {
  if (!opts) return null;
  const o = opts === true ? {} : opts;
  return {
    sky: o.sky ?? true,
    environment: o.environment ?? true,
    light: o.light ?? true,
    aerialPerspective: o.aerialPerspective ?? true,
    samples: o.samples ?? 0,
    anchor: o.anchor,
    getDate: o.getDate,
  };
}

// ─── Live GPU atmosphere (browser-verify; dynamic-imports takram + three/webgpu) ─

/** Options for {@link createSTTAtmosphere}. */
export interface CreateSTTAtmosphereOptions extends AtmosphereOptions {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: Camera;
  projection: Projection;
}

/**
 * The live atmosphere handle. `render()` is the scene's draw entry point (use it
 * INSTEAD of `renderer.render`); `update()` advances the sun/moon to a date or
 * playhead time; `setEnabled(false)` detaches everything and falls back to a
 * plain render; `dispose()` tears it down and restores the renderer/scene.
 */
export interface STTAtmosphere {
  /** True while the atmosphere is attached (sky/light/env active + aerial in `render`). */
  readonly enabled: boolean;
  /** Position the sun/moon for a `Date`, a playhead epoch-ms, or "now" (no arg). */
  update(dateOrTime?: Date | number): void;
  /** Draw the scene — through the aerial-perspective pipeline when enabled, else plain. */
  render(): void;
  /** Async twin of {@link render} (WebGPU submit awaited). */
  renderAsync(): Promise<void>;
  /** Attach (`true`) or detach (`false`) the atmosphere; a plain render is used while off. */
  setEnabled(enabled: boolean): void;
  /** Restore the renderer/scene to their pre-atmosphere state and free the context. */
  dispose(): void;
}

/**
 * Build the atmosphere for a WebGPU renderer + scene + camera. Async because it
 * DYNAMICALLY imports `@takram/three-atmosphere` (and `three/tsl` / `three/webgpu`)
 * so consumers who never enable the atmosphere don't pull takram into their bundle.
 *
 * Must run on a `WebGPURenderer` whose `init()` has resolved. On WebGL2 the caller
 * should skip this entirely and render normally.
 */
export async function createSTTAtmosphere(
  opts: CreateSTTAtmosphereOptions,
): Promise<STTAtmosphere> {
  const { renderer, scene, camera, projection } = opts;
  // `opts` is always an object here, so this never resolves to null.
  const cfg = resolveAtmosphereOptions(opts) as ResolvedAtmosphereOptions;

  const [
    {
      AtmosphereContext,
      AtmosphereLight,
      AtmosphereLightNode,
      aerialPerspective,
      skyBackground,
      skyEnvironment,
      viewZUnit,
    },
    { getSunDirectionECEF, getMoonDirectionECEF, getECIToECEFRotationMatrix },
    { pass, mrt, output, context },
    { PostProcessing },
  ] = await Promise.all([
    import('@takram/three-atmosphere/webgpu'),
    import('@takram/three-atmosphere'),
    import('three/tsl'),
    import('three/webgpu'),
  ]);

  // 1) Context + world→ECEF alignment. The remaining ECEF uniforms
  //    (matrixECEFToWorld / camera position / height) auto-derive from this one.
  const ctx = new AtmosphereContext();
  ctx.matrixWorldToECEF.value.copy(computeWorldToEcef(projection, cfg.anchor));

  // Publish the context to the renderer so the sky/light/aerial nodes can find it.
  const prevContextNode = renderer.contextNode;
  const ctxValue = {
    ...prevContextNode?.value,
    getAtmosphere: () => ctx,
  };
  const atmosphereContextNode = context(ctxValue);

  // 2) Sun/moon directional light (registered once on the renderer's node library).
  const light = cfg.light ? new AtmosphereLight() : null;
  if (light) renderer.library.addLight(AtmosphereLightNode, AtmosphereLight);

  // 1'/3) Sky background + environment IBL nodes (built once, attached on demand).
  const backgroundNode = cfg.sky ? skyBackground() : null;
  const environmentNode = cfg.environment ? skyEnvironment() : null;

  // 4) Aerial-perspective post pipeline (only when requested). The MRT feeds the
  //    linear view-Z the effect needs alongside the colour target.
  let post: InstanceType<typeof PostProcessing> | null = null;
  if (cfg.aerialPerspective) {
    const passNode = pass(scene, camera, { samples: cfg.samples }).setMRT(
      mrt({ output, viewZUnit }),
    );
    post = new PostProcessing(renderer);
    post.outputNode = aerialPerspective(
      passNode.getTextureNode('output'),
      passNode.getTextureNode('depth'),
    );
  }

  // Saved scene state so detach/dispose is a clean restore (default-OFF contract).
  const prevBackgroundNode = scene.backgroundNode;
  const prevEnvironmentNode = scene.environmentNode;

  let enabled = false;

  const attach = (): void => {
    renderer.contextNode = atmosphereContextNode;
    if (backgroundNode) scene.backgroundNode = backgroundNode;
    if (environmentNode) scene.environmentNode = environmentNode;
    if (light) scene.add(light);
    enabled = true;
  };

  const detach = (): void => {
    renderer.contextNode = prevContextNode;
    if (backgroundNode) scene.backgroundNode = prevBackgroundNode;
    if (environmentNode) scene.environmentNode = prevEnvironmentNode;
    if (light) scene.remove(light);
    enabled = false;
  };

  const update = (dateOrTime?: Date | number): void => {
    if (!enabled) return;
    const date = resolveSunDate(dateOrTime, cfg.getDate);
    getSunDirectionECEF(date, ctx.sunDirectionECEF.value);
    getMoonDirectionECEF(date, ctx.moonDirectionECEF.value);
    getECIToECEFRotationMatrix(date, ctx.matrixECIToECEF.value);
  };

  const render = (): void => {
    if (enabled && post) post.render();
    else renderer.render(scene, camera);
  };

  const renderAsync = async (): Promise<void> => {
    if (enabled && post) await post.renderAsync();
    else await renderer.renderAsync(scene, camera);
  };

  const setEnabled = (next: boolean): void => {
    if (next === enabled) return;
    if (next) attach();
    else detach();
  };

  // Attach immediately (the factory is opt-in — being called IS the opt-in).
  attach();
  update();

  return {
    get enabled(): boolean {
      return enabled;
    },
    update,
    render,
    renderAsync,
    setEnabled,
    dispose(): void {
      detach();
      ctx.dispose();
    },
  };
}
