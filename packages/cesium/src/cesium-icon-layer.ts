// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `icon` for CesiumJS: time-filtered billboard SPRITES cut from ONE
 * caller-supplied texture atlas — the backend's answer to deck's `IconLayer`,
 * and the only kind here whose output is a picture rather than a shape.
 *
 * ── What it renders ─────────────────────────────────────────────────────────
 * One `Billboard` per Point feature in a `BillboardCollection`. Every billboard
 * shares the SAME `image` (the atlas) and differs only by `imageSubRegion` —
 * the sub-rectangle its sprite occupies. That is the whole reason an atlas
 * exists: Cesium's collection re-batches whenever a billboard's IMAGE changes,
 * so N distinct image URLs would mean N texture bindings and a rebuild per
 * frame, whereas N sub-regions of one image is a single texture and a single
 * draw. Per feature the layer resolves:
 *
 *   - position  → `lib/icons.ts` `buildIconEntries` → `core/geo`
 *                 `GlobeProjection({datum:'wgs84'})` → absolute f64 ECEF metres
 *                 (Cesium's native frame; no RTC, no model matrix, so there is
 *                 no local-frame rotation to get wrong)
 *   - sprite    → a NAME (constant, or a categorical column via `iconProperty`)
 *                 looked up in `iconMapping`, then {@link atlasSubRegion} for
 *                 the deck-top-left → Cesium-bottom-left flip
 *   - size      → {@link spriteScale}: `Billboard.scale` is a factor over the
 *                 sprite's NATIVE pixels, so the requested on-screen size is
 *                 divided by the sprite's own height (or width, `sizeBasis`)
 *   - anchor    → {@link anchorPixelOffset}: a non-centre anchor becomes a
 *                 `pixelOffset`, because Cesium billboards have only nine
 *                 discrete origins, not deck's continuous anchor
 *   - rotation  → `Billboard.rotation`, radians CCW, converted in the builder
 *   - tint      → `Billboard.color`, which Cesium MULTIPLIES into the texture;
 *                 white (the default) is the identity, and a `mask: true`
 *                 sprite is tinted by that same multiply with no second path
 *   - time      → `core/time-filter` `timeFilterAlpha`, per frame on the CPU,
 *                 written into the tint's alpha exactly as `STTPointLayer`
 *                 animates its `PointPrimitive` (there is no shader hook in
 *                 this backend — `src/shaders.ts` no longer exists)
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *  - **No atlas loading, packing or bundled sprite sheet.** The caller passes a
 *    ready `atlas` (URL or image) and its `iconMapping`. deck can auto-pack an
 *    atlas from an `getIcon → {url}` accessor at runtime; doing that here would
 *    mean owning image I/O, a packer and a GPU texture inside a layer whose
 *    every other input is a decoded tile. With NOTHING supplied it draws
 *    NOTHING and warns ONCE, rather than inventing a placeholder sprite that
 *    would look like real data.
 *  - **No per-feature icon URL.** One atlas per layer, by construction (above).
 *    Use two layers for two atlases.
 *  - **`sizeUnits: 'pixels'` only.** Cesium's `sizeInMeters` is a per-billboard
 *    flag we deliberately do not expose: mixing it with `spriteScale`'s
 *    pixel-denominated maths would make `size` mean two different things.
 *  - **No `billboard.width/height` override.** Setting either detaches the
 *    sprite's aspect from the atlas; `scale` keeps it.
 *
 * ── Documented deviations from deck's `IconLayer` ───────────────────────────
 *  1. `getAngle` rotates the quad about the billboard's CENTRE. Cesium applies
 *     `pixelOffset` AFTER the rotation and never rotates the offset itself, so
 *     with BOTH a non-centre anchor and a non-zero rotation the sprite spins
 *     about its centre instead of orbiting its anchor. Centre-anchored sprites
 *     (deck's default, and every rotating heading/COG sprite we ship) are
 *     unaffected.
 *  2. `alphaCutoff` has no equivalent: Cesium billboards are alpha-BLENDED, and
 *     the layer's whole animation is alpha, so a cutoff would fight the fade.
 *     Sprites needing a hard edge should ship a hard-edged texture.
 *  3. A sprite whose name is absent from `iconMapping` is SKIPPED (and named in
 *     one warning), where deck draws nothing silently. Skipping keeps a typo in
 *     a categorical column from addressing an arbitrary rectangle of the atlas.
 *
 * Rendering needs a live Cesium `Scene`; the pure sprite maths is in
 * `lib/icons.ts` and fully unit-tested without one.
 */

import {
  BillboardCollection,
  BoundingRectangle,
  Cartesian2,
  Cartesian3,
  Color,
  HorizontalOrigin,
  VerticalOrigin,
  defined,
  type Billboard,
  type Scene,
} from 'cesium';
import { getFeatureProperties, type Tile } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { FeatureColorMode } from './lib/feature-color.js';
import {
  anchorPixelOffset,
  atlasSubRegion,
  buildIconEntries,
  spriteScale,
  type IconMappingEntry,
} from './lib/icons.js';

/** Anything Cesium's `Billboard.image` accepts as a texture source. */
export type IconAtlas = string | HTMLImageElement | HTMLCanvasElement;

export interface STTIconLayerOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;

  // ── the atlas (both required to draw anything) ─────────────────────────────
  /**
   * The sprite sheet EVERY billboard samples: a URL Cesium loads, or an
   * already-decoded image/canvas. One per layer — see the header.
   */
  atlas?: IconAtlas;
  /** `name → sub-rectangle` in ATLAS PIXELS from the TOP-left (deck's shape). */
  iconMapping?: Record<string, IconMappingEntry>;
  /**
   * Atlas height in pixels, needed for the top-left → bottom-left flip. Omit
   * it when `atlas` is an image or canvas — its `naturalHeight` (else `height`)
   * is read instead. REQUIRED when `atlas` is a URL, because the layer never
   * loads the image itself and so cannot measure it; supplying it always wins
   * over what the image reports.
   */
  atlasHeight?: number;

  // ── sprite selection / styling (forwarded to the pure builder) ─────────────
  /** Per-feature tint, MULTIPLIED into the sprite. @default constant white */
  color?: FeatureColorMode;
  /** Sprite name for every feature `iconProperty` does not resolve. @default 'marker' */
  icon?: string;
  /** Categorical column selecting the sprite per feature. */
  iconProperty?: string;
  /** Constant on-screen size along `sizeBasis`, in pixels. @default 12 */
  size?: number;
  /** Numeric column driving per-feature size. */
  sizeProperty?: string;
  /** Multiplier on `size` / the `sizeProperty` column. @default 1 */
  sizeScale?: number;
  /** Lower clamp on the resolved size. @default 0 */
  sizeMinPixels?: number;
  /** Upper clamp on the resolved size. @default Number.MAX_SAFE_INTEGER */
  sizeMaxPixels?: number;
  /** Which sprite dimension `size` measures. @default 'height' (deck's default) */
  sizeBasis?: 'height' | 'width';
  /** Constant rotation, DEGREES counter-clockwise from up. @default 0 */
  angle?: number;
  /** Numeric column driving rotation in degrees (AIS `cog`, aircraft heading). */
  angleProperty?: string;
  /** Constant altitude lift in metres. @default 0 */
  zLift?: number;

  // ── Cesium-side presentation ──────────────────────────────────────────────
  /** Billboard origin. @default HorizontalOrigin.CENTER (what `anchorPixelOffset` assumes) */
  horizontalOrigin?: HorizontalOrigin;
  /** Billboard origin. @default VerticalOrigin.CENTER */
  verticalOrigin?: VerticalOrigin;
  /**
   * Distance (metres) inside which the depth test is skipped, so a sprite is
   * not swallowed by terrain it sits on. `Number.POSITIVE_INFINITY` always
   * draws on top. @default undefined (Cesium's normal depth test)
   */
  disableDepthTestDistance?: number;
  /**
   * Called instead of `console.warn` when the layer cannot draw (no atlas /
   * mapping) or has to skip sprites. Pass a no-op to silence — but do not
   * silence it while you are still wondering why the map is empty.
   */
  onWarn?: (message: string) => void;
}

/** The pick id attached to every billboard — the package-wide shape. */
interface BillboardId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface IconEntry {
  bb: Billboard;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // base tint channels, pre-normalized to 0..1 by the builder
  g: number;
  b: number;
  a: number; // base tint alpha, multiplied by the time-filter alpha
  lastAlpha: number; // last alpha written; skip the setter when unchanged
  lon: number;
  lat: number;
  binary: BinaryFeatures;
  featureIndex: number;
}

// One shared scratch per mutable Cesium type, reused for every per-frame write
// so setTime allocates nothing. Safe because JS is single-threaded and setTime
// runs synchronously to completion, and because `Billboard.color`'s setter
// COPIES the value out (Color.clone into the billboard's own `_color`). The
// scratch MUST stay a DISTINCT object from that internal storage: the setter
// compares by value to decide whether to dirty the GPU buffer, so mutating
// `_color` in place would bypass the dirty check and freeze the animation.
const SCRATCH_COLOR = new Color();

export class STTIconLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: BillboardCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: STTIconLayerOptions;
  private timeOrigin = 0;
  private entries: IconEntry[] = [];
  /** Latched so the "nothing to draw with" warning fires ONCE, not per tile load. */
  private warnedNoAtlas = false;
  /** Sprite names already reported missing — one warning per name, ever. */
  private readonly warnedSprites = new Set<string>();

  constructor(scene: Scene, options: STTIconLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-icons';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.collection = new BillboardCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build sprites from decoded tiles. Rebases all times to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    // Pure geometry/colour/sprite/rebase assembly lives in the Cesium-free
    // builder; this method only turns each FeatureIcon into a Billboard.
    const build = buildIconEntries(tiles, {
      color: this.opts.color,
      icon: this.opts.icon,
      iconProperty: this.opts.iconProperty,
      size: this.opts.size,
      sizeProperty: this.opts.sizeProperty,
      sizeScale: this.opts.sizeScale,
      sizeMinPixels: this.opts.sizeMinPixels,
      sizeMaxPixels: this.opts.sizeMaxPixels,
      angle: this.opts.angle,
      angleProperty: this.opts.angleProperty,
      zLift: this.opts.zLift,
    });
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitives are still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the new
    // set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous sprites
    // is safe even when the emptiness is permanent: they sit at their true ECEF
    // positions, which the camera has by then left behind.
    if (build.icons.length === 0) return; // also leaves the prior timeOrigin untouched

    // Same rule, second gate: without an atlas there is nothing to rebuild
    // WITH, so return before the teardown rather than after it. (The collection
    // is necessarily empty in that case — a layer with no atlas never added a
    // billboard — so "hold the old geometry" costs nothing and the branch reads
    // identically to the one above.)
    const atlas = this.resolveAtlas();
    if (!atlas) return;

    this.collection.removeAll();
    this.entries = [];
    this.timeOrigin = build.timeOrigin;

    const basis = this.opts.sizeBasis ?? 'height';
    const hOrigin = this.opts.horizontalOrigin ?? HorizontalOrigin.CENTER;
    const vOrigin = this.opts.verticalOrigin ?? VerticalOrigin.CENTER;
    const missing: string[] = [];

    for (const fi of build.icons) {
      const entry = atlas.mapping[fi.icon];
      if (!entry) {
        // Skip rather than guess: an unmapped name would otherwise address an
        // arbitrary rectangle of the atlas and render a slice of a NEIGHBOURING
        // sprite, which looks like data and is not.
        if (!this.warnedSprites.has(fi.icon)) {
          this.warnedSprites.add(fi.icon);
          missing.push(fi.icon);
        }
        continue;
      }
      const sub = atlasSubRegion(entry, atlas.height);
      const scale = spriteScale(entry, fi.size, basis);
      const [ox, oy] = anchorPixelOffset(entry, scale);
      const bb = this.collection.add({
        position: new Cartesian3(fi.x, fi.y, fi.z),
        image: atlas.image,
        imageSubRegion: new BoundingRectangle(
          sub.x,
          sub.y,
          sub.width,
          sub.height,
        ),
        scale,
        rotation: fi.rotation,
        color: new Color(fi.r, fi.g, fi.b, fi.a),
        pixelOffset: new Cartesian2(ox, oy),
        horizontalOrigin: hOrigin,
        verticalOrigin: vOrigin,
        disableDepthTestDistance: this.opts.disableDepthTestDistance,
        id: {
          layerId: this.id,
          binary: fi.binary,
          featureIndex: fi.featureIndex,
        } satisfies BillboardId,
      });
      this.entries.push({
        bb,
        start: fi.start,
        end: fi.end,
        r: fi.r,
        g: fi.g,
        b: fi.b,
        a: fi.a,
        lastAlpha: NaN, // NaN !== anything → force the first setTime to write
        lon: fi.lon,
        lat: fi.lat,
        binary: fi.binary,
        featureIndex: fi.featureIndex,
      });
    }

    if (missing.length > 0) {
      this.warn(
        `no iconMapping entry for sprite(s) ${missing
          .map((n) => `'${n}'`)
          .join(', ')} — those features were skipped`,
      );
    }
  }

  /**
   * Advance to an absolute playhead time; recompute each sprite's tint alpha via
   * the shared oracle. Reuses one scratch `Color` (zero allocations per frame)
   * and skips sprites whose alpha is unchanged since the last frame, so a
   * feature fully in or fully out of the window costs one compare rather than a
   * setter call and a GPU dirty. Identical math to every other backend — there
   * is no shader path in this one.
   */
  setTime(absoluteMs: number): void {
    const cur = absoluteMs - this.timeOrigin;
    const c = SCRATCH_COLOR;
    for (const e of this.entries) {
      const alpha =
        e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      if (alpha === e.lastAlpha) continue; // tint identical to last write — nothing to dirty
      e.lastAlpha = alpha;
      c.red = e.r;
      c.green = e.g;
      c.blue = e.b;
      c.alpha = alpha;
      e.bb.color = c; // setter copies the scratch into the billboard's own _color
    }
  }

  /** Hit-test → the shared `SttPickResult` (feature props joined via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | { id?: BillboardId }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id)
      return null;
    const { binary, featureIndex } = picked.id;
    const entry = this.entries.find(
      (e) => e.binary === binary && e.featureIndex === featureIndex,
    );
    return {
      object: getFeatureProperties(binary, featureIndex),
      index: featureIndex,
      layerId: this.id,
      coordinate: entry ? [entry.lon, entry.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  dispose(): void {
    // `primitives.remove` DESTROYS the collection (destroyPrimitives defaults
    // to true), releasing the texture atlas Cesium built internally from our
    // image — `removeAll()` alone would not. If the collection was already
    // detached (remove → false) we still owe that destroy, so do it by hand.
    // The caller's `atlas` image/URL is NOT ours and is never touched.
    const removed = this.scene.primitives.remove(this.collection);
    if (!removed && !this.collection.isDestroyed()) this.collection.destroy();
    this.entries = [];
  }

  /**
   * The atlas triple (`image`, `mapping`, `height`), or `null` — warning ONCE —
   * when the caller gave the layer nothing to draw with. Height comes from the
   * image itself when it is decoded; a URL cannot be measured without loading
   * it, which this layer deliberately does not do, so `atlasHeight` is required
   * there (and an explicit `atlasHeight` always wins, for a caller drawing into
   * a canvas larger than the region its mapping covers).
   */
  private resolveAtlas(): {
    image: IconAtlas;
    mapping: Record<string, IconMappingEntry>;
    height: number;
  } | null {
    const { atlas, iconMapping } = this.opts;
    // `naturalHeight` FIRST: an <img> that has never been laid out reports
    // `height` 0, and one sized by CSS reports the LAYOUT height — neither is
    // the pixel grid an `iconMapping` is measured against. A canvas has no
    // `naturalHeight`, so it falls through to `height`, which for a canvas IS
    // its pixel height.
    const measured =
      typeof atlas === 'object' && atlas !== null
        ? (atlas as HTMLImageElement).naturalHeight || atlas.height || 0
        : 0;
    const height = this.opts.atlasHeight ?? measured;
    if (atlas && iconMapping && height > 0) {
      return { image: atlas, mapping: iconMapping, height };
    }
    if (!this.warnedNoAtlas) {
      this.warnedNoAtlas = true;
      const why: string[] = [];
      if (!atlas) why.push('no `atlas`');
      if (!iconMapping) why.push('no `iconMapping`');
      if (atlas && iconMapping && height <= 0)
        why.push('no `atlasHeight` (required when `atlas` is a URL)');
      this.warn(
        `${why.join(' and ')} — drawing nothing. An icon layer needs a sprite sheet and the mapping that addresses it.`,
      );
    }
    return null;
  }

  private warn(message: string): void {
    const sink = this.opts.onWarn;
    if (sink) sink(message);
    else console.warn(`[${this.id}] ${message}`);
  }
}
