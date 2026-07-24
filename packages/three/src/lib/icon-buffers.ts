// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of merged icon instance buffers — the icon analogue
 * of `point-buffers.ts`, feeding {@link createIconMaterial}. The Three port of
 * deck's `AnimatedIconLayer`: directional billboard markers, one instance per
 * Point feature, rotated by a per-feature heading/bearing column.
 *
 * Per instance we bake:
 *   • `centers`  vec3 world coords, RTC-relative to a shared `origin` (the layer
 *                writes `object.position = origin`). For the ENU/AV frame the
 *                origin is ~0 so it's a no-op; for mercator/globe it keeps the
 *                huge world magnitude in the f64 CPU transform.
 *   • `angles`   per-instance rotation in RADIANS. deck `IconLayer` measures
 *                `getAngle` in DEGREES, counter-clockwise from the icon's default
 *                (up) orientation — we convert once here so the shader just rotates.
 *   • `sizes`    per-instance on-screen size in pixels (the icon's full height;
 *                the material clamps to [sizeMinPixels, sizeMaxPixels]).
 *   • `uvRects`  vec4 `[u0, v0, u1, v1]` sub-rectangle of the atlas this icon
 *                samples (0..1 atlas texture coords), resolved from `iconMapping`
 *                against the atlas pixel dimensions. ALL features share one icon
 *                (binary tiles can't run a per-row `getIcon`), so this is constant
 *                across instances but baked per-instance to keep the shader simple
 *                and leave room for a future per-category icon.
 *   • `colors`   vec4 tint 0..1 (categorical / constant). For a `mask` icon the
 *                tint replaces the sprite colour; for an opaque icon it modulates.
 *   • `starts`/`ends`  per-feature `[startTime,endTime]` rebased to `timeOrigin`.
 *
 * The atlas anchor convention follows deck `IconLayer`: `anchorX`/`anchorY`
 * default to the icon centre (`width/2`, `height/2`). We translate the anchor into
 * a normalized `[-1,1]` quad offset so off-centre anchors (e.g. a pin tip) line up.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import type { Projection } from '../projection/local-enu.js';
import {
  resolveCategoryColor,
  type RGBA,
  type CategoricalColorSpec,
} from './color.js';
import { featureCategorySlot, type StablePalette } from './palette.js';
import { featureTileKey } from './id-pick.js';

const DEG2RAD = Math.PI / 180;

/**
 * One entry of an `iconMapping` — the sub-rectangle of the atlas a named icon
 * occupies (pixels), plus optional anchor. Mirrors deck.gl `IconLayer`'s mapping
 * shape (the `mask` flag is a render-time concern, not a buffer one, so it lives
 * on the material options, not here).
 */
export interface IconMappingEntry {
  /** Left edge of the icon in the atlas (pixels). */
  x: number;
  /** Top edge of the icon in the atlas (pixels). */
  y: number;
  /** Icon width (pixels). */
  width: number;
  /** Icon height (pixels). */
  height: number;
  /** Anchor X in icon pixels (default `width/2` — horizontal centre). */
  anchorX?: number;
  /** Anchor Y in icon pixels (default `height/2` — vertical centre). */
  anchorY?: number;
  mask?: boolean;
}

export type IconColorMode =
  | { type: 'constant'; color: RGBA }
  | ({ type: 'categorical' } & CategoricalColorSpec);

export interface IconBufferOptions {
  /** Atlas pixel dimensions — used to normalize the `iconMapping` rect to 0..1 UV. */
  atlasWidth: number;
  atlasHeight: number;
  /** Named sub-rectangles into the atlas. */
  iconMapping: Record<string, IconMappingEntry>;
  /** The single icon name (a key of `iconMapping`) used for every feature. */
  icon: string;

  /** Per-feature rotation: a numeric column name (degrees, CCW from up) or null. */
  angleProperty: string | null;
  /** Constant rotation (degrees) when `angleProperty` is null or absent. @default 0 */
  angleConstant?: number;

  /** Per-feature size: a numeric column name (pixels) or null. */
  sizeProperty: string | null;
  /** Constant on-screen size (pixels) when `sizeProperty` is null or absent. @default 12 */
  sizeConstant?: number;

  /** Tint colour resolution. */
  colorMode: IconColorMode;

  /** Altitude column (metres), per feature. @default null (use geometry z) */
  elevationProperty?: string | null;
  elevationScale?: number;

  /**
   * Numeric column feeding the GPU DataFilter (`sttFilterValue`, per icon
   * instance). When set, `filterValues` is emitted (0 where a tile lacks the
   * column, deck's constant fallback). @default null (no filter attribute)
   */
  filterProperty?: string | null;

  /**
   * GPU stable-palette path (deck `CategoryColorExtension`): when set, emit a
   * per-icon `categoryIndices` slot buffer for the palette-texture lookup — the
   * category LABEL is placed by `palette` (stable across tiles), NULL / missing →
   * the palette's null slot. The CPU-expanded `colors` (tint) still ride along
   * (the shader ignores them under the palette path). @default null
   */
  categoryIndex?: { property: string; palette: StablePalette } | null;
}

export interface IconBuffers {
  count: number;
  centers: Float32Array; // vec3, RTC-local
  angles: Float32Array; // float, RADIANS (CCW from up)
  sizes: Float32Array; // float, on-screen pixels
  uvRects: Float32Array; // vec4 [u0,v0,u1,v1] (0..1)
  /** Normalized anchor offset in [-1,1] quad space — `[ax, ay]` per instance. */
  anchors: Float32Array; // vec2
  colors: Float32Array; // vec4 0..1
  starts: Float32Array; // float relative to timeOrigin
  ends: Float32Array; // float relative to timeOrigin
  /** float, per-icon DataFilter value; 0-length when no `filterProperty`. */
  filterValues: Float32Array;
  /** float, per-icon stable palette slot; 0-length when no `categoryIndex`. */
  categoryIndices: Float32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-merged-instance provenance (the GPU picking-catalog identity buffer).
   * Merged icon instance `i` — the same `i` a GPU id-buffer pick decodes —
   * resolves via `provenance.resolve(i)` to its source `(tileKey, featureIndex)`.
   * Populated in the EXACT order instances are written (1 marker per Point
   * feature), so index alignment with the geometry is guaranteed. Empty when
   * `count === 0`. See `point-buffers.ts` (the template).
   */
  provenance: InstanceProvenance;
  /**
   * `tileKey` → the source layer's {@link BinaryFeatures}, so a resolved
   * provenance entry can be joined back to columns via
   * `getFeatureProperties(binary, featureIndex)`. Built from the SAME iteration
   * (and the same {@link featureTileKey}) as {@link provenance}, so keys align.
   */
  binaryByTileKey: Map<string, BinaryFeatures>;
}

function featureColor(b: BinaryFeatures, f: number, mode: IconColorMode): RGBA {
  if (mode.type === 'constant') return mode.color;
  const cat = b.categoricalProps[mode.property];
  const label =
    cat && cat.indices[f] !== 0xffff
      ? cat.categories[cat.indices[f]]
      : undefined;
  return resolveCategoryColor(label, mode.mapping, mode.fallback);
}

function collectPointLayers(tiles: Tile[]): {
  parts: Array<{ b: BinaryFeatures; tileKey: string }>;
  total: number;
} {
  const parts: Array<{ b: BinaryFeatures; tileKey: string }> = [];
  let total = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount || b.geometryType !== GeometryType.Point) continue;
      parts.push({ b, tileKey: featureTileKey(tile.id, tl.name) });
      total += b.featureCount;
    }
  }
  return { parts, total };
}

export function buildIconBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: IconBufferOptions,
): IconBuffers {
  const { parts, total } = collectPointLayers(tiles);
  const provenance = new InstanceProvenance();
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const empty = (): IconBuffers => ({
    count: 0,
    centers: new Float32Array(0),
    angles: new Float32Array(0),
    sizes: new Float32Array(0),
    uvRects: new Float32Array(0),
    anchors: new Float32Array(0),
    colors: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    filterValues: new Float32Array(0),
    categoryIndices: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
    provenance,
    binaryByTileKey,
  });
  if (total === 0) return empty();

  // ── Resolve the (single, shared) icon's UV rect + anchor offset once ─────────
  const entry = opts.iconMapping[opts.icon];
  // Atlas 0..1 UV rect. Atlas v origin is the TOP (image convention); the material
  // maps the quad's v∈[-1,1] back through this rect, so we pass top→v0, bottom→v1.
  let u0 = 0;
  let v0 = 0;
  let u1 = 1;
  let v1 = 1;
  // Normalized anchor offset in [-1,1] quad space. Default anchor = icon centre →
  // offset (0,0). An off-centre anchor shifts the quad so the anchor sits on the
  // feature position. +ax pushes the quad right, +ay pushes it up.
  let ax = 0;
  let ay = 0;
  if (entry && opts.atlasWidth > 0 && opts.atlasHeight > 0) {
    u0 = entry.x / opts.atlasWidth;
    v0 = entry.y / opts.atlasHeight;
    u1 = (entry.x + entry.width) / opts.atlasWidth;
    v1 = (entry.y + entry.height) / opts.atlasHeight;
    const anchorX = entry.anchorX ?? entry.width / 2;
    const anchorY = entry.anchorY ?? entry.height / 2;
    // Quad spans [-1,1]; the anchor in [0,width] maps to quad-x
    // `2·anchorX/width - 1`. We want the quad shifted so the anchor lands at the
    // origin, so the per-instance offset is the negation of that, in [-1,1].
    ax = -(2 * (anchorX / entry.width) - 1);
    // Atlas Y grows downward; quad/world Y grows upward. anchorY=0 (top) should
    // sit ABOVE the feature → +ay. So flip the sign relative to ax.
    ay = 2 * (anchorY / entry.height) - 1;
  }

  const elevScale = opts.elevationScale ?? 1;
  const angleConstant = opts.angleConstant ?? 0;
  const sizeConstant = opts.sizeConstant ?? 12;

  // RTC origin = first feature of the first layer, projected (absolute world).
  const first = parts[0].b;
  const fdims = first.positionDimensions ?? 2;
  const firstElev = opts.elevationProperty
    ? first.numericProps[opts.elevationProperty]
    : undefined;
  const firstAlt = firstElev
    ? firstElev[0] * elevScale
    : fdims > 2
      ? first.positions[2]
      : 0;
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    firstAlt,
  );
  const [ox, oy, oz] = origin;

  const centers = new Float32Array(total * 3);
  const angles = new Float32Array(total);
  const sizes = new Float32Array(total);
  const uvRects = new Float32Array(total * 4);
  const anchors = new Float32Array(total * 2);
  const colors = new Float32Array(total * 4);
  const starts = new Float32Array(total);
  const ends = new Float32Array(total);
  const wantFilter = !!opts.filterProperty;
  const filterValues = wantFilter
    ? new Float32Array(total)
    : new Float32Array(0);
  const catIndex = opts.categoryIndex ?? null;
  const categoryIndices = catIndex
    ? new Float32Array(total)
    : new Float32Array(0);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  let o = 0;
  for (const part of parts) {
    const b = part.b;
    binaryByTileKey.set(part.tileKey, b);
    const count = b.featureCount;
    const dims = b.positionDimensions ?? fdims;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const angleCol = opts.angleProperty
      ? b.numericProps[opts.angleProperty]
      : undefined;
    const sizeCol = opts.sizeProperty
      ? b.numericProps[opts.sizeProperty]
      : undefined;
    const filterCol =
      wantFilter && opts.filterProperty
        ? b.numericProps[opts.filterProperty]
        : undefined;
    const rebase = b.timeOffset - timeOrigin;

    for (let i = 0; i < count; i++) {
      // Provenance MUST be pushed in the same order instances are written (merged
      // index j = o + i), so a decoded GPU id aligns with this feature.
      provenance.push(part.tileKey, i);
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = elev
        ? elev[i] * elevScale
        : dims > 2
          ? b.positions[i * dims + 2]
          : 0;
      const [x, y, z] = projection.project(lon, lat, alt);
      const px = x - ox,
        py = y - oy,
        pz = z - oz;
      const j = o + i;
      centers[j * 3] = px;
      centers[j * 3 + 1] = py;
      centers[j * 3 + 2] = pz;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (pz < minZ) minZ = pz;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      if (pz > maxZ) maxZ = pz;

      angles[j] = (angleCol ? angleCol[i] : angleConstant) * DEG2RAD;
      sizes[j] = sizeCol ? sizeCol[i] : sizeConstant;

      uvRects[j * 4] = u0;
      uvRects[j * 4 + 1] = v0;
      uvRects[j * 4 + 2] = u1;
      uvRects[j * 4 + 3] = v1;

      anchors[j * 2] = ax;
      anchors[j * 2 + 1] = ay;

      const rgba = featureColor(b, i, opts.colorMode);
      colors[j * 4] = rgba[0] / 255;
      colors[j * 4 + 1] = rgba[1] / 255;
      colors[j * 4 + 2] = rgba[2] / 255;
      colors[j * 4 + 3] = (rgba[3] ?? 255) / 255;

      starts[j] = (b.startTimes ? b.startTimes[i] : 0) + rebase;
      ends[j] = (b.endTimes ? b.endTimes[i] : 0) + rebase;
      if (wantFilter) filterValues[j] = filterCol ? filterCol[i] : 0;
      if (catIndex)
        categoryIndices[j] = featureCategorySlot(
          b,
          i,
          catIndex.property,
          catIndex.palette,
        );
    }
    o += count;
  }

  return {
    count: total,
    centers,
    angles,
    sizes,
    uvRects,
    anchors,
    colors,
    starts,
    ends,
    filterValues,
    categoryIndices,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
  };
}

export type { RGBA };
