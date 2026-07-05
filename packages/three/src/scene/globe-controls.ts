// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Ellipsoid-aware globe navigation for the STT Three engine — a thin adapter over
 * `3d-tiles-renderer`'s `GlobeControls`, offered as an alternative to
 * `OrbitControls`/`MapControls` for globe scenes. `GlobeControls` is horizon-aware
 * and zoom-to-cursor, and **auto-manages the camera near/far** each frame
 * (encapsulating the ellipsoid), so the earth-scale clip that `setGlobeClip`
 * bootstraps is refined automatically once the controls are live.
 *
 * **Opt-in, default-OFF.** Like {@link createStt3DTiles}, the `3d-tiles-renderer`
 * module is dynamically imported so non-users don't bundle it.
 *
 * ── Ellipsoid frame ──────────────────────────────────────────────────────────
 * `GlobeControls` relates the render world to the ellipsoid through an
 * `ellipsoidGroup`'s world matrix. When a {@link Stt3DTiles} handle is supplied we
 * reuse its already-aligned `group` (and `ellipsoid`), so navigation and the
 * tileset share one frame. Without tiles we build a bare group aligned to STT's
 * globe world via {@link alignTilesGroup} and let the controls default to a WGS84
 * ellipsoid — the same frame STT's `'wgs84'` `GlobeProjection` uses.
 *
 * The `(scene, camera, domElement)` constructor wires scene + camera + DOM
 * listeners without the deprecated `setTilesRenderer` path; we then bind the
 * ellipsoid group explicitly with `setEllipsoid`.
 */

import { Group } from 'three';
import type { Object3D, Camera } from 'three';
import type { GlobeControls } from '3d-tiles-renderer/three';
import type { GeoAnchor, Projection } from '../projection/local-enu.js';
import { alignTilesGroup, type Stt3DTiles } from './tiles-3d.js';

/** Options for {@link createSttGlobeControls}. */
export interface CreateSttGlobeControlsOptions {
  /** Scene containing the tileset (used for camera-height raycasting). */
  scene: Object3D;
  /** The camera the controls drive. */
  camera: Camera;
  /** The canvas element pointer/keyboard events attach to. */
  domElement: HTMLElement;
  /** STT's projection — the ECEF frame the ellipsoid group is aligned to when no `tiles` given. */
  projection: Projection;
  /** Reuse this tileset's aligned group + ellipsoid (share one frame with the tiles). */
  tiles?: Stt3DTiles | null;
  /** Anchor override for the ellipsoid-group alignment when no `tiles` is given. */
  anchor?: GeoAnchor;
  /** Inertial damping (matches the OrbitControls default used elsewhere). @default true */
  enableDamping?: boolean;
  /** Damping factor when `enableDamping`. @default 0.12 */
  dampingFactor?: number;
}

/** Live globe-controls handle. `update()` advances the controls (and, internally,
 *  the camera near/far); `dispose()` tears it down and removes an owned group. */
export interface SttGlobeControls {
  /** The underlying `GlobeControls` (for advanced tuning). */
  readonly controls: GlobeControls;
  /** Enable/disable input without disposing (e.g. while another gesture owns the pointer). */
  enabled: boolean;
  /** Advance the controls one frame; `deltaTime` is auto-timed when omitted. */
  update(deltaTime?: number): void;
  /** Dispose the controls and remove any group this adapter created. */
  dispose(): void;
}

/**
 * Construct + wire `GlobeControls` against STT's globe. Reuses a {@link Stt3DTiles}
 * handle's aligned group + ellipsoid when provided; otherwise builds a bare
 * ellipsoid group aligned to STT globe world (default WGS84 ellipsoid).
 */
export async function createSttGlobeControls(
  opts: CreateSttGlobeControlsOptions,
): Promise<SttGlobeControls> {
  const { scene, camera, domElement, projection, tiles } = opts;
  const { GlobeControls } = await import('3d-tiles-renderer/three');

  const controls = new GlobeControls(scene, camera, domElement);
  controls.enableDamping = opts.enableDamping ?? true;
  controls.dampingFactor = opts.dampingFactor ?? 0.12;

  let ownedGroup: Group | null = null;
  if (tiles) {
    // Share the tileset's already-aligned group + its (WGS84) ellipsoid.
    controls.setEllipsoid(tiles.tiles.ellipsoid, tiles.group);
  } else {
    // No tiles: a bare group aligned to STT globe world, default WGS84 ellipsoid.
    ownedGroup = new Group();
    ownedGroup.name = 'stt-globe-ellipsoid-frame';
    alignTilesGroup(ownedGroup, projection, opts.anchor);
    scene.add(ownedGroup);
    controls.setEllipsoid(null, ownedGroup);
  }

  return {
    controls,
    get enabled(): boolean {
      return controls.enabled;
    },
    set enabled(value: boolean) {
      controls.enabled = value;
    },
    update(deltaTime?: number): void {
      controls.update(deltaTime);
    },
    dispose(): void {
      controls.dispose();
      if (ownedGroup) ownedGroup.parent?.remove(ownedGroup);
    },
  };
}
