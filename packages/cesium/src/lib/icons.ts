// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of per-feature billboard SPRITES from decoded
 * Point tiles — the CPU builder behind `STTIconLayer.setTiles`, and the
 * Cesium-side twin of three's `lib/icon-buffers.ts` and maplibre's icon
 * geometry adapter. Kernel-built, mirroring `lib/points.ts`:
 *
 *   - positions → `core/geo` `GlobeProjection({datum:'wgs84'})` (Cesium's frame),
 *                 absolute f64 ECEF metres, geometry z + `zLift`
 *   - colour    → {@link featureColor} (constant / categorical / ramp), channels
 *                 pre-normalized to 0..1 so the per-frame `setTime` colour write
 *                 never re-divides by 255
 *   - sprite    → a name per feature, from a CATEGORICAL column when
 *                 `iconProperty` is given, else the constant `icon`
 *   - size      → a numeric column or a constant, × `sizeScale`, clamped
 *   - rotation  → a numeric column or a constant, in DEGREES counter-clockwise
 *                 from the sprite's default (up) orientation — deck
 *                 `IconLayer.getAngle` semantics — converted to RADIANS here so
 *                 the layer hands Cesium's `Billboard.rotation` a ready value
 *   - times     → rebased to the first Point layer's `timeOffset`, the scene-wide
 *                 origin convention every layer in this package shares
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * Everything above is ATLAS-INDEPENDENT: it resolves without knowing which
 * pixels a sprite occupies, so a caller can build once and re-address a
 * different atlas. The three functions that DO need the atlas —
 * {@link atlasSubRegion}, {@link spriteScale}, {@link anchorPixelOffset} — are
 * still pure arithmetic over a plain `iconMapping` entry and live here rather
 * than in the layer, because the package rule is that all geometry maths is
 * unit-testable without a `Scene`. None of them imports Cesium; they return
 * plain numbers the layer feeds to `BoundingRectangle` / `Cartesian2`.
 *
 * No atlas LOADING happens here either (that is I/O, and it is the layer's),
 * and no time filtering (that is the `core/time-filter` oracle's, per frame).
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { NULL_CATEGORY_INDEX, type RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';
import { collectPointLayers } from './points.js';

/**
 * One entry of an `iconMapping`: the sub-rectangle of the atlas a named sprite
 * occupies, in ATLAS PIXELS measured from the TOP-left, plus its anchor. This
 * is deck.gl `IconLayer`'s mapping shape verbatim, so ONE mapping object serves
 * the deck, three, maplibre and Cesium backends unchanged — which is why the
 * top-left convention is kept here even though Cesium's `imageSubRegion` counts
 * from the bottom-left (see {@link atlasSubRegion}).
 */
export interface IconMappingEntry {
  /** Left edge of the sprite in the atlas, in pixels. */
  x: number;
  /** Top edge of the sprite in the atlas, in pixels (measured DOWN from the top). */
  y: number;
  /** Sprite width in pixels. */
  width: number;
  /** Sprite height in pixels. */
  height: number;
  /** Horizontal anchor within the sprite, in sprite pixels. @default width / 2 */
  anchorX?: number;
  /** Vertical anchor within the sprite, in sprite pixels from its TOP. @default height / 2 */
  anchorY?: number;
  /**
   * deck's silhouette flag. Accepted for mapping compatibility and otherwise
   * unused: Cesium multiplies a billboard's texture by its `color` for every
   * sprite, so a single-channel mask is tinted by the same code path as an
   * opaque sprite and needs no separate branch.
   */
  mask?: boolean;
}

/**
 * A sprite rectangle in ATLAS PIXELS measured from the BOTTOM-left — the frame
 * Cesium's `Billboard.setImageSubRegion` documents. A plain object, not a
 * `BoundingRectangle`: this module never imports Cesium.
 */
export interface AtlasSubRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One renderable sprite: absolute ECEF position + resolved sprite/size/rotation. */
export interface FeatureIcon {
  /** Absolute ECEF position (metres), x/y/z. */
  x: number;
  y: number;
  z: number;
  /** Base tint channels pre-normalized to 0..1. Alpha animates as `a × timeFilterAlpha`. */
  r: number;
  g: number;
  b: number;
  a: number;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Resolved sprite NAME — a key the caller looks up in its `iconMapping`. */
  icon: string;
  /** Resolved on-screen size (the sprite's rendered extent along `sizeBasis`). */
  size: number;
  /** Resolved rotation in RADIANS, counter-clockwise from the sprite's up orientation. */
  rotation: number;
  /** Source lon/lat (degrees) — the picking coordinate. */
  lon: number;
  lat: number;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built sprite set, rebased to one scene-wide time origin. */
export interface IconBuild {
  icons: FeatureIcon[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
}

export interface IconBuildOptions {
  /** Per-feature tint. @default constant opaque white (identity modulation) */
  color?: FeatureColorMode;
  /** Sprite name used for every feature `iconProperty` does not resolve. @default 'marker' */
  icon?: string;
  /**
   * Categorical column NAME selecting the sprite per feature (a vessel class, an
   * aircraft type). NULL entries, and tiles missing the column, fall back to
   * {@link icon} — this backend goes past deck's single-constant-icon limit,
   * which exists there only because binary tiles cannot run a per-row `getIcon`.
   */
  iconProperty?: string;
  /** Constant size along `sizeBasis`. @default 12 */
  size?: number;
  /** Numeric column NAME driving per-feature size. Non-finite values fall back to {@link size}. */
  sizeProperty?: string;
  /** Multiplier applied to {@link size} and to a {@link sizeProperty} column. @default 1 */
  sizeScale?: number;
  /** Lower clamp on the resolved size. @default 0 */
  sizeMinPixels?: number;
  /** Upper clamp on the resolved size. @default Number.MAX_SAFE_INTEGER */
  sizeMaxPixels?: number;
  /** Constant rotation in DEGREES, counter-clockwise from up. @default 0 */
  angle?: number;
  /** Numeric column NAME driving per-feature rotation in degrees (AIS `cog`, aircraft heading). */
  angleProperty?: string;
  /** Constant altitude lift in metres (lifts sprites clear of the ellipsoid). @default 0 */
  zLift?: number;
}

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum matters).
// Byte-identical to the point/polyline builders' GLOBE; `project` is
// anchor-independent, so the duplication costs nothing and keeps each builder
// self-contained.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

/**
 * deck's icon tint default. WHITE, not the grey the point/polyline builders
 * default to: an icon's colour comes from its own pixels, and the tint is a
 * MULTIPLIER — anything but white would dim every shipped sprite.
 */
const DEFAULT_TINT: RGBA255 = [255, 255, 255, 255];

/** Sprite name used when neither `iconProperty` nor an explicit `icon` resolves. */
export const DEFAULT_ICON = 'marker';

const DEG2RAD = Math.PI / 180;

/**
 * Translate an `iconMapping` rect (pixels from the atlas's TOP-left, deck's
 * convention) into the frame Cesium's `Billboard.setImageSubRegion` documents:
 * pixels from the atlas's BOTTOM-left. Only the origin of the y axis moves —
 * the rect keeps its size and its left edge.
 *
 * This flip is the ONE place the two conventions meet. Getting it wrong does
 * not fail loudly; it silently addresses the wrong row of a sprite sheet, which
 * is exactly why it is a named, tested function rather than an expression
 * inlined at the `add()` call site.
 */
export function atlasSubRegion(
  entry: IconMappingEntry,
  atlasHeight: number,
): AtlasSubRegion {
  return {
    x: entry.x,
    y: atlasHeight - (entry.y + entry.height),
    width: entry.width,
    height: entry.height,
  };
}

/**
 * The `Billboard.scale` that renders `entry` at `size` on screen. Cesium scales
 * a billboard by a single factor over its NATIVE image size, so the requested
 * size is divided by whichever sprite dimension `basis` measures — `'height'`
 * (deck's `sizeBasis` default) makes `size` the rendered height and lets a wide
 * sprite grow past it, `'width'` does the converse. A degenerate (zero-extent)
 * sprite scales to 0 rather than to `Infinity`.
 */
export function spriteScale(
  entry: IconMappingEntry,
  size: number,
  basis: 'height' | 'width' = 'height',
): number {
  const native = basis === 'width' ? entry.width : entry.height;
  return native > 0 ? size / native : 0;
}

/**
 * The `Billboard.pixelOffset` that puts an off-centre anchor on the feature's
 * geographic position, in Cesium's screen frame (+x right, +y DOWN).
 *
 * A Cesium billboard with CENTER/CENTER origin draws its sprite CENTRED on the
 * position, so the sprite must be pushed by the anchor→centre vector, scaled to
 * screen pixels by the same `scale` the billboard renders at. deck's anchor
 * defaults (`width/2`, `height/2`) are exactly the centre, so the common case
 * returns `[0, 0]` and the offset costs nothing.
 *
 * ⚠ Cesium adds `pixelOffset` AFTER rotating the quad and never rotates the
 * offset itself, so a non-centre anchor does not orbit the position the way
 * deck's does under a non-zero rotation. Documented in the layer header.
 */
export function anchorPixelOffset(
  entry: IconMappingEntry,
  scale: number,
): [number, number] {
  const ax = entry.anchorX ?? entry.width / 2;
  const ay = entry.anchorY ?? entry.height / 2;
  return [(entry.width / 2 - ax) * scale, (entry.height / 2 - ay) * scale];
}

/** Read numeric column `prop` for feature `f`, falling back on absence or NaN. */
function numericAt(
  b: BinaryFeatures,
  prop: string | undefined,
  f: number,
  fallback: number,
): number {
  if (!prop) return fallback;
  const col = b.numericProps[prop];
  if (!col) return fallback;
  const v = col[f];
  // A non-finite cell is a HOLE, not a size/heading of NaN: a NaN scale would
  // collapse the sprite and a NaN rotation would drop it from the draw entirely.
  return Number.isFinite(v) ? v : fallback;
}

/** Resolve feature `f`'s sprite name from categorical column `prop`. */
function iconAt(
  b: BinaryFeatures,
  prop: string | undefined,
  f: number,
  fallback: string,
): string {
  if (!prop) return fallback;
  const cat = b.categoricalProps[prop];
  if (!cat) return fallback; // this tile lacks the column — constant sprite
  const idx = cat.indices[f];
  if (idx === NULL_CATEGORY_INDEX) return fallback;
  return cat.categories[idx] ?? fallback;
}

/**
 * Build one sprite per Point feature (geometry z used when the tile is 3-D).
 * Times are rebased to the first Point layer's `timeOffset`. Returns an empty
 * build (`timeOrigin: 0`) when there are no Point features — the layer checks
 * `icons.length` before adopting `timeOrigin`, so an empty rebuild leaves the
 * previous origin untouched.
 */
export function buildIconEntries(
  tiles: Tile[],
  opts: IconBuildOptions = {},
): IconBuild {
  const pointLayers = collectPointLayers(tiles);
  if (pointLayers.length === 0) return { icons: [], timeOrigin: 0 };

  const timeOrigin = pointLayers[0].timeOffset;
  const colorMode: FeatureColorMode = opts.color ?? {
    type: 'constant',
    color: DEFAULT_TINT,
  };
  const iconName = opts.icon ?? DEFAULT_ICON;
  const sizeConstant = opts.size ?? 12;
  const sizeScale = opts.sizeScale ?? 1;
  const sizeMin = opts.sizeMinPixels ?? 0;
  const sizeMax = opts.sizeMaxPixels ?? Number.MAX_SAFE_INTEGER;
  const angleConstant = opts.angle ?? 0;
  const zLift = opts.zLift ?? 0;
  const icons: FeatureIcon[] = [];

  for (const b of pointLayers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;

    for (let i = 0; i < b.featureCount; i++) {
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = (dims > 2 ? b.positions[i * dims + 2] : 0) + zLift;
      const [x, y, z] = GLOBE.project(lon, lat, alt);
      const rgba = featureColor(b, i, colorMode);
      const size = Math.min(
        sizeMax,
        Math.max(
          sizeMin,
          numericAt(b, opts.sizeProperty, i, sizeConstant) * sizeScale,
        ),
      );
      icons.push({
        x,
        y,
        z,
        // Normalize the tint ONCE here so the per-frame setTime colour write
        // never re-divides by 255 (same contract as `buildPointEntries`).
        r: rgba[0] / 255,
        g: rgba[1] / 255,
        b: rgba[2] / 255,
        a: (rgba[3] ?? 255) / 255,
        start: b.startTimes[i] + rebase,
        end: b.endTimes[i] + rebase,
        icon: iconAt(b, opts.iconProperty, i, iconName),
        size,
        // Degrees → radians once, here: `Billboard.rotation` is radians CCW and
        // deck's `getAngle` is degrees CCW, so the two agree after this one
        // conversion and the layer performs no trigonometry at all.
        rotation: numericAt(b, opts.angleProperty, i, angleConstant) * DEG2RAD,
        lon,
        lat,
        binary: b,
        featureIndex: i,
      });
    }
  }

  return { icons, timeOrigin };
}
