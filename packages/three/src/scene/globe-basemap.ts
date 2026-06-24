// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Earth-sphere basemap — the backdrop for the globe demos (drifters / currents /
 * satellites / migration). A single `SphereGeometry` of {@link GlobeProjection}'s
 * radius, rendered with Three's standard MVP (no globe vertex shader — the
 * `GlobeProjection` already places data in real ECEF metres).
 *
 * ── Pole alignment ───────────────────────────────────────────────────────────
 * Three's `SphereGeometry` is built with its texture poles on ±Y, but our ECEF
 * frame puts the north pole on +Z (see `../projection/globe`). So the mesh is
 * rotated +90° about X, which carries +Y → +Z, lining the texture's north pole up
 * with the real north pole. The texture seam (lon ±180°) then lands on −X.
 *
 * ── Z-fighting ───────────────────────────────────────────────────────────────
 * Data on the surface sits at exactly `radius`. The sphere is inset slightly
 * (×{@link INSET}) so it never co-planar-fights the data drawn on top of it.
 *
 * The texture is optional: pass `opts.textureUrl` for an equirectangular earth
 * image (loaded async via `TextureLoader`); absent or on load failure the sphere
 * falls back to a solid colour, so no bundled asset is required.
 */

import {
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  TextureLoader,
  EquirectangularReflectionMapping,
  type Texture,
  type ColorRepresentation,
} from 'three';
import type { GlobeProjection } from '../projection/globe';

/** Inset factor so surface data (at exactly `radius`) doesn't z-fight the sphere. */
export const GLOBE_BASEMAP_INSET = 0.999;

export interface GlobeBasemapOptions {
  /** Latitude segments. @default 64 */
  widthSegments?: number;
  /** Longitude segments. @default 64 */
  heightSegments?: number;
  /** Solid fill colour (also the fallback when no texture loads). @default 0x0b1a2e */
  color?: ColorRepresentation;
  /** Equirectangular earth texture URL (loaded async). Solid colour if absent. */
  textureUrl?: string;
  /** Multiplied into `radius` to inset the sphere. @default {@link GLOBE_BASEMAP_INSET} */
  inset?: number;
  /**
   * Called once the texture finishes (or fails) loading, mainly so the host can
   * request a re-render. `texture` is null on failure.
   */
  onTextureLoad?: (texture: Texture | null) => void;
}

/**
 * Build the earth-sphere basemap as a single `Mesh` (named `stt-globe-basemap`),
 * ECEF-aligned (north pole on +Z) and inset under the surface data.
 */
export function makeGlobeBasemap(
  globe: Pick<GlobeProjection, 'radius'>,
  opts: GlobeBasemapOptions = {},
): Mesh {
  const inset = opts.inset ?? GLOBE_BASEMAP_INSET;
  const radius = globe.radius * inset;

  const geometry = new SphereGeometry(
    radius,
    opts.widthSegments ?? 64,
    opts.heightSegments ?? 64,
  );

  const material = new MeshBasicMaterial({
    color: opts.color ?? 0x0b1a2e,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'stt-globe-basemap';
  // ECEF north pole is +Z; SphereGeometry's texture poles are on ±Y → rotate
  // +90° about X so +Y maps to +Z.
  mesh.rotateX(Math.PI / 2);
  mesh.frustumCulled = false;

  if (opts.textureUrl) {
    new TextureLoader().load(
      opts.textureUrl,
      (texture) => {
        texture.mapping = EquirectangularReflectionMapping;
        material.map = texture;
        // Solid color tints the texture; reset to white so the image shows true.
        material.color.set(0xffffff);
        material.needsUpdate = true;
        opts.onTextureLoad?.(texture);
      },
      undefined,
      () => {
        // Graceful fallback: keep the solid colour.
        opts.onTextureLoad?.(null);
      },
    );
  }

  return mesh;
}
