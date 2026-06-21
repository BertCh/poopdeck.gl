// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Minimal ground context for the local-frame AV scene: a dark plane + a metric
 * grid. Deliberately not a slippy basemap — the AV cockpit runs in a local ENU
 * frame and the data is the subject; real raster tiles are a later wave.
 *
 * The world is Z-up (see `../projection/local-enu`), so the plane (a
 * `PlaneGeometry`, natively in the XY plane with +Z normal) sits flat correctly,
 * and the `GridHelper` (natively XZ) is rotated 90° about X into XY.
 */

import {
  Group,
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  GridHelper,
  DoubleSide,
} from 'three';

export interface GroundOptions {
  /** Side length in metres. @default 400 */
  size?: number;
  /** Grid divisions (cells = size/divisions metres). @default 40 (10 m cells) */
  divisions?: number;
  /** Ground fill colour. @default 0x0a0d14 */
  groundColor?: number;
  /** Grid line colour. @default 0x161c2b */
  gridColor?: number;
  /** Centre cross colour. @default 0x2a3550 */
  gridCenterColor?: number;
  /** Ground height in metres. @default 0 */
  z?: number;
  /** Ground fill opacity. @default 0.92 */
  opacity?: number;
}

/** Build a dark ground plane + metric grid as one `Group` (named `stt-ground`). */
export function makeGround(opts: GroundOptions = {}): Group {
  const size = opts.size ?? 400;
  const divisions = opts.divisions ?? 40;
  const z = opts.z ?? 0;

  const group = new Group();
  group.name = 'stt-ground';

  const plane = new Mesh(
    new PlaneGeometry(size, size),
    new MeshBasicMaterial({
      color: opts.groundColor ?? 0x0a0d14,
      side: DoubleSide,
      transparent: true,
      opacity: opts.opacity ?? 0.92,
      depthWrite: false, // never occlude the cloud above it
    }),
  );
  // Drop the fill a hair below the grid so the grid lines read on top.
  plane.position.z = z - 0.05;
  group.add(plane);

  const grid = new GridHelper(
    size,
    divisions,
    opts.gridCenterColor ?? 0x2a3550,
    opts.gridColor ?? 0x161c2b,
  );
  grid.rotateX(Math.PI / 2); // XZ → XY for the Z-up frame
  grid.position.z = z;
  group.add(grid);

  return group;
}
