// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * OGC 3D Tiles for the STT Three engine — real terrain, Google Photorealistic
 * Tiles, and Cesium Ion assets streamed by `3d-tiles-renderer` and co-registered
 * with STT's ECEF globe world. **Opt-in, default-OFF**: nothing here runs unless a
 * host calls {@link createSTT3DTiles}, so no existing scene changes.
 *
 * `3d-tiles-renderer` is renderer-agnostic — it adds a standard `THREE.Group` of
 * `Mesh`es (`tiles.group`) to the scene and you pump `tiles.update()` each frame.
 * Under `WebGPURenderer` those standard meshes auto-convert to node materials, so
 * this works on both the WebGPU and WebGL2 paths with no special handling. Like
 * the atmosphere helper, the `3d-tiles-renderer` (and DRACO) modules are
 * **dynamically imported** inside the factory so consumers who never enable 3D
 * tiles don't pull them into their bundle.
 *
 * ── ECEF FRAME ALIGNMENT (make-or-break for overlay registration) ────────────
 * 3D Tiles (Google Photorealistic, Cesium World Terrain, …) are authored in
 * **WGS84 ECEF metres** on the ellipsoid, with the same axes STT uses (+X at
 * lon 0°/lat 0°, +Y at lon 90°E, +Z at the north pole). STT's `GlobeProjection`
 * places data at ECEF metres × `radius/EARTH_RADIUS`, so co-registering the tiles
 * is a single **uniform scale** on `tiles.group` (the IDENTITY at the default
 * radius) — no rotation, no offset. {@link alignTilesGroup} derives that transform
 * by INVERTING the shared `computeWorldToEcef` (one source of truth for the ECEF
 * frame, tested in `atmosphere.test.ts`), so a local-ENU / mercator scene also
 * places tiles correctly (the whole ellipsoid is rotated/translated so the anchor
 * lands at the local Z-up origin).
 *
 * ⚠ **The globe projection MUST use the `'wgs84'` datum** to co-register. STT's
 * `GlobeProjection` DEFAULTS to `'sphere'` (a sphere of `radius`, not the WGS84
 * ellipsoid), which mis-registers against the tiles' ellipsoid by up to ~20 km at
 * mid-latitudes. {@link createSTT3DTiles} warns (once) if it sees the sphere datum.
 */

import { Matrix4 } from 'three';
import type { Scene, Camera, Group, Object3D, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { TilesRenderer } from '3d-tiles-renderer/three';
import type { GeoAnchor, Projection } from '../projection/local-enu.js';
import { GlobeProjection } from '../projection/globe.js';
import { computeWorldToEcef } from './atmosphere.js';

// ─── Source resolution (pure; no 3d-tiles-renderer import) ──────────────────────

/**
 * Where the tileset comes from — exactly one of:
 *  - `{ url }` — a plain `tileset.json` URL (self-hosted, any OGC 3D Tiles set).
 *  - `{ google }` — Google Photorealistic 3D Tiles (the plugin sets the URL from
 *    the API token; you omit the url).
 *  - `{ ion }` — a Cesium Ion asset (assetId `1` = Cesium World Terrain, `2` = Bing
 *    aerial, `96188` = OSM buildings, …) keyed by an Ion access token.
 */
export type STT3DTilesSource =
  | { url: string }
  | { google: { apiToken: string; autoRefreshToken?: boolean } }
  | {
      ion: {
        apiToken: string;
        assetId: string | number;
        autoRefreshToken?: boolean;
      };
    };

/** {@link STT3DTilesSource} normalized to a discriminated, defaults-filled shape. */
export type ResolvedTilesSource =
  | { kind: 'url'; url: string }
  | { kind: 'google'; apiToken: string; autoRefreshToken: boolean }
  | {
      kind: 'ion';
      apiToken: string;
      assetId: string | number;
      autoRefreshToken: boolean;
    };

/**
 * Validate + normalize a {@link STT3DTilesSource} into the plugin/URL wiring the
 * factory needs. Pure + total (throws on a malformed source), so the source →
 * plugin decision is unit-testable without importing `3d-tiles-renderer`.
 */
export function resolveTilesSource(
  source: STT3DTilesSource,
): ResolvedTilesSource {
  if ('google' in source) {
    const { apiToken, autoRefreshToken } = source.google;
    if (!apiToken)
      throw new Error(
        'createSTT3DTiles: a { google } source requires an apiToken',
      );
    return {
      kind: 'google',
      apiToken,
      autoRefreshToken: autoRefreshToken ?? true,
    };
  }
  if ('ion' in source) {
    const { apiToken, assetId, autoRefreshToken } = source.ion;
    if (!apiToken)
      throw new Error(
        'createSTT3DTiles: an { ion } source requires an apiToken',
      );
    if (assetId === undefined || assetId === null || assetId === '') {
      throw new Error(
        'createSTT3DTiles: an { ion } source requires an assetId',
      );
    }
    return {
      kind: 'ion',
      apiToken,
      assetId,
      autoRefreshToken: autoRefreshToken ?? true,
    };
  }
  if ('url' in source && source.url) return { kind: 'url', url: source.url };
  throw new Error(
    'createSTT3DTiles: source must be one of { url } | { google } | { ion }',
  );
}

// ─── Option resolution (pure) ───────────────────────────────────────────────────

/** Opt-in 3D-tiles knobs (each defaults to a sensible value once tiles are on). */
export interface STT3DTilesOptions {
  /** The tileset source (url / google / ion). */
  source: STT3DTilesSource;
  /** Cross-fade tiles in/out as LOD changes (TilesFadePlugin). @default true */
  fade?: boolean;
  /** Recompress vertex attributes to compact types (TileCompressionPlugin). @default true */
  compression?: boolean;
  /** Screen-space-error target — lower loads more/higher-detail tiles. @default 16 */
  errorTarget?: number;
  /** Cap the tile tree depth. @default unlimited (library default). */
  maxDepth?: number;
  /**
   * Override the lon/lat the local/mercator ECEF frame is anchored at. Ignored for
   * globe scenes (STT globe world is already ECEF). @default projection.anchor
   */
  anchor?: GeoAnchor;
  /**
   * Base path/URL of a Draco decoder (e.g. a hosted `.../draco/` dir). Registers a
   * `GLTFExtensionsPlugin` with a `DRACOLoader` — **required for Google
   * Photorealistic Tiles** (their glTF is Draco-compressed) and any Draco tileset.
   * Omit for uncompressed tiles.
   */
  dracoDecoderPath?: string;
}

/** {@link STT3DTilesOptions} with every knob concretely resolved (source excluded). */
export interface ResolvedSTT3DTilesOptions {
  fade: boolean;
  compression: boolean;
  errorTarget: number;
  maxDepth?: number;
  anchor?: GeoAnchor;
  dracoDecoderPath?: string;
}

/**
 * Fill the {@link STT3DTilesOptions} defaults (fade + compression on, SSE target
 * 16 — matching `3d-tiles-renderer`'s own default). Pure, so option resolution is
 * unit-testable.
 */
export function resolveSTT3DTilesOptions(
  opts: STT3DTilesOptions,
): ResolvedSTT3DTilesOptions {
  return {
    fade: opts.fade ?? true,
    compression: opts.compression ?? true,
    errorTarget: opts.errorTarget ?? 16,
    maxDepth: opts.maxDepth,
    anchor: opts.anchor,
    dracoDecoderPath: opts.dracoDecoderPath,
  };
}

// ─── ECEF ⇄ world alignment (pure math; node-testable) ──────────────────────────

/**
 * The ECEF-metres → STT-world transform for a projection — the INVERSE of the
 * shared `computeWorldToEcef` (so the ECEF frame is defined in exactly one place):
 *  - **Globe**: a pure uniform scale `radius/EARTH_RADIUS` (= 1 / metersPerWorldUnit),
 *    the IDENTITY at the default radius.
 *  - **Local ENU / mercator**: places the whole ellipsoid so the anchor's ECEF sits
 *    at the local Z-up world origin (rotation + translation, scale 1).
 */
export function ecefToWorldMatrix(
  projection: Projection,
  anchor?: GeoAnchor,
): Matrix4 {
  return computeWorldToEcef(projection, anchor).invert();
}

/**
 * Apply {@link ecefToWorldMatrix} to a tileset group's position/quaternion/scale so
 * its ECEF-metre meshes co-register with STT world coordinates. Returns the applied
 * matrix (for tests). Decomposes into PRS (rather than forcing `matrix`) so the
 * group's `matrixAutoUpdate` stays true and `GlobeControls` reads a live
 * `ellipsoidGroup.matrixWorld`.
 */
export function alignTilesGroup(
  group: Object3D,
  projection: Projection,
  anchor?: GeoAnchor,
): Matrix4 {
  const m = ecefToWorldMatrix(projection, anchor);
  m.decompose(group.position, group.quaternion, group.scale);
  group.updateMatrixWorld(true);
  return m;
}

/** One-time warning if a globe scene is on the sphere datum (tiles would float ~20 km off). */
let warnedSphereDatum = false;
function warnIfSphereDatum(projection: Projection): void {
  if (warnedSphereDatum) return;
  if (projection instanceof GlobeProjection && projection.datum === 'sphere') {
    warnedSphereDatum = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[stt-three] createSTT3DTiles: 3D Tiles are WGS84-ellipsoid ECEF, but this ' +
        'GlobeProjection uses the "sphere" datum — tiles will mis-register with STT ' +
        'globe data by up to ~20 km at mid-latitudes. Build the projection with ' +
        '`new GlobeProjection(anchor, radius, { datum: "wgs84" })` to co-register.',
    );
  }
}

// ─── Live tileset factory (browser-verify; dynamic-imports 3d-tiles-renderer) ────

/** Options for {@link createSTT3DTiles}. */
export interface CreateSTT3DTilesOptions extends STT3DTilesOptions {
  /** The active renderer (WebGPU or the WebGL2 fallback). */
  renderer: WebGPURenderer;
  /** The scene the tileset group is added to (and drawn as part of). */
  scene: Scene;
  /** The camera whose frustum + resolution drive LOD selection. */
  camera: Camera;
  /** STT's projection — the ECEF frame the tiles are aligned to. */
  projection: Projection;
}

/**
 * Live 3D-tiles handle. `update()` pumps one LOD/streaming step (call each frame
 * AFTER the camera matrix is current); the tileset is drawn as part of the scene
 * by the host's normal `render`, so it composes with the atmosphere pipeline for
 * free. `dispose()` removes the group and frees all tiles + plugins.
 */
export interface STT3DTiles {
  /** The tileset's `THREE.Group` (already added to the scene, aligned to STT world). */
  readonly group: Group;
  /** The underlying vanilla `TilesRenderer` — register more plugins, add listeners, tune. */
  readonly tiles: TilesRenderer;
  /** Pump one LOD/streaming update. Call each frame after the camera matrix updates. */
  update(): void;
  /** Set the SSE reference resolution explicitly (CSS px). */
  setResolution(width: number, height: number): void;
  /** Set the SSE reference resolution from the renderer's drawing size (call on resize). */
  setResolutionFromRenderer(): void;
  /** Remove the group from the scene and dispose the tileset. */
  dispose(): void;
}

/**
 * Build a 3D-tiles overlay for a renderer + scene + camera, aligned to STT's ECEF
 * globe world. Registers the right auth plugin for the source plus the util
 * plugins (compression, fade, and — when `dracoDecoderPath` is set — a Draco glTF
 * loader). Adds `tiles.group` to the scene; `dispose()` removes it.
 *
 * Works under `WebGPURenderer` and the WebGL2 fallback alike (the tileset is
 * standard meshes). Live tile fetching/rendering needs network + a GPU + (for
 * google/ion) an API token, so it is browser-verified, not tested here.
 */
export async function createSTT3DTiles(
  opts: CreateSTT3DTilesOptions,
): Promise<STT3DTiles> {
  const { renderer, scene, camera, projection } = opts;
  const cfg = resolveSTT3DTilesOptions(opts);
  const src = resolveTilesSource(opts.source);

  const [
    { TilesRenderer },
    {
      GoogleCloudAuthPlugin,
      CesiumIonAuthPlugin,
      TilesFadePlugin,
      TileCompressionPlugin,
      GLTFExtensionsPlugin,
    },
    dracoMod,
  ] = await Promise.all([
    import('3d-tiles-renderer/three'),
    import('3d-tiles-renderer/three/plugins'),
    cfg.dracoDecoderPath
      ? import('three/addons/loaders/DRACOLoader.js')
      : Promise.resolve(null),
  ]);

  const tiles: TilesRenderer =
    src.kind === 'url' ? new TilesRenderer(src.url) : new TilesRenderer();
  tiles.errorTarget = cfg.errorTarget;
  if (cfg.maxDepth !== undefined) tiles.maxDepth = cfg.maxDepth;

  // Parse plugins first (registered before the auth plugin kicks off the fetch):
  // a Draco glTF loader (needed by Google Photorealistic), then attribute
  // recompression, then the load/unload cross-fade.
  if (dracoMod) {
    const dracoLoader = new dracoMod.DRACOLoader();
    dracoLoader.setDecoderPath(cfg.dracoDecoderPath!);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));
  }
  if (cfg.compression) tiles.registerPlugin(new TileCompressionPlugin());
  if (cfg.fade) tiles.registerPlugin(new TilesFadePlugin());

  // Auth/source plugin last (google/ion resolve the root URL + start fetching).
  if (src.kind === 'google') {
    tiles.registerPlugin(
      new GoogleCloudAuthPlugin({
        apiToken: src.apiToken,
        autoRefreshToken: src.autoRefreshToken,
      }),
    );
  } else if (src.kind === 'ion') {
    tiles.registerPlugin(
      new CesiumIonAuthPlugin({
        apiToken: src.apiToken,
        assetId: String(src.assetId),
        autoRefreshToken: src.autoRefreshToken,
      }),
    );
  }

  tiles.setCamera(camera);
  // setResolutionFromRenderer is typed for WebGLRenderer but only reads renderer
  // .getSize(), which WebGPURenderer also implements — so the cast is safe.
  tiles.setResolutionFromRenderer(camera, renderer as unknown as WebGLRenderer);

  // Co-register ECEF-metre tiles with STT world (see file header); warn if the
  // globe scene is on the sphere datum (tiles would float ~20 km off).
  alignTilesGroup(tiles.group, projection, cfg.anchor);
  warnIfSphereDatum(projection);

  scene.add(tiles.group);

  return {
    group: tiles.group,
    tiles,
    update(): void {
      tiles.update();
    },
    setResolution(width: number, height: number): void {
      tiles.setResolution(camera, width, height);
    },
    setResolutionFromRenderer(): void {
      tiles.setResolutionFromRenderer(
        camera,
        renderer as unknown as WebGLRenderer,
      );
    },
    dispose(): void {
      scene.remove(tiles.group);
      tiles.dispose();
    },
  };
}
