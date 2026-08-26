// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `text` for CesiumJS: time-filtered map LABELS, one `Label` per Point feature,
 * animated on the CPU through the shared `timeFilterAlpha` oracle.
 *
 * ── WHAT IT RENDERS ─────────────────────────────────────────────────────────
 * One screen-space glyph run per feature, anchored at the feature's ABSOLUTE
 * f64 ECEF position (no RTC — `Cartesian3` is a CPU double triple, so there is
 * no f32 buffer to protect, and nothing here is placed by a model matrix, so
 * the local east-north-up rule is vacuous for this layer). Label TEXT comes
 * from a baked property COLUMN (the accessor-alias convention: every styling
 * input is a constant or a column name; there are no per-feature JS accessors
 * anywhere in this codebase). Colour is per feature via the shared
 * constant/categorical/ramp `FeatureColorMode`; size is a per-feature
 * multiplier on the layer's one shared CSS `font`.
 *
 * ── WHY `LabelCollection`, AND WHY THIS BACKEND IS THE SMALL ONE ────────────
 * Cesium has a first-class label primitive. `LabelCollection` takes a plain
 * `text` STRING per label and owns the SDF glyph atlas, the per-character quad
 * layout, the kerning and the baseline metrics itself. deck and three each
 * instance one quad PER CHARACTER in their own shaders, so both must carry the
 * flat UTF-32 machinery — a code-point buffer, per-row character offsets, a
 * pre-baked font atlas and a `characterSet` to bake it from. **None of that
 * exists in this backend, and its absence is a genuine simplification of the
 * same problem, not a shortcut or a reduced feature set.** `lib/labels.ts`
 * therefore stops at "resolve one string per feature" and hands it over.
 *
 * The consequence worth stating: the glyph atlas is built lazily by Cesium from
 * a 2-D canvas the first time a character is seen, so any font the browser can
 * resolve works with no bake step — but a label set that pulls in thousands of
 * distinct CJK code points pays that atlas cost at first sight, spread across
 * the frames in which the labels appear.
 *
 * ── ANIMATION ───────────────────────────────────────────────────────────────
 * Exactly the `STTPointLayer` shape — a per-frame `alpha = base × timeFilterAlpha(...)`
 * written into the primitive's colour — with one wrinkle: a label has TWO
 * animated colours, `fillColor` and (when an outline mode was supplied)
 * `outlineColor`. They get TWO distinct module-level scratch `Color`s rather
 * than one reused twice. Cesium's setters clone, so a single scratch written
 * sequentially would happen to work today; two scratches make the layer
 * independent of that write-order assumption and of the two colours' channels
 * ever differing. A label whose alpha reaches 0 is additionally `show`-toggled
 * off, so a fully-filtered-out label costs no glyph billboards at all
 * (`STTTripHeadsLayer` uses the same trick).
 *
 * There is NO shader path in this backend — `src/shaders.ts` was deleted and
 * comments elsewhere that speak of it in the present tense are stale. The CPU
 * loop IS the shipped path, and it is the same oracle every other backend runs,
 * so `text` is time-filter-conformant by construction.
 *
 * ── DOCUMENTED DEVIATIONS FROM deck's `AnimatedTextLayer` ───────────────────
 * These are declared, not silently approximated:
 *
 *  1. **Size is a MULTIPLIER, not a pixel size.** deck takes `getSize` in
 *     pixels against a fixed-size font atlas. Cesium takes a CSS `font`
 *     shorthand (`'600 14px sans-serif'`) plus a per-label `scale`. So
 *     `scaleProperty`/`scaleConstant` multiply the layer font: 11 px out of a
 *     14 px font is `scale` 0.786, and the caller does that division. Scaling a
 *     Cesium label far above 1 resamples its atlas entry and softens it;
 *     prefer a larger `font` with scales near 1.
 *  2. **No background pill.** deck's `getBackgroundColor` / `backgroundPadding`
 *     have a Cesium counterpart (`showBackground`/`backgroundColor`), but it is
 *     a THIRD colour that would have to be alpha-animated in lockstep with the
 *     other two. Omitted rather than half-shipped; use `outlineColor` as the
 *     legibility device, which is what the halo is for.
 *  3. **No per-label rotation.** deck's `getAngle` has no counterpart —
 *     Cesium's `Billboard` has `rotation`, `Label` does not. Unsupported, full
 *     stop.
 *  4. **No auto-wrap.** deck's `maxWidth`/`wordBreak` line-breaking is not
 *     implemented. Cesium renders an embedded `\n` as a real line break, so
 *     multi-line labels are expressed in the SOURCE column.
 *  5. **`outlineWidth` is Cesium's, in glyph pixels**, not deck's fraction of
 *     the font size.
 *  6. **No decluttering.** Overlapping labels overlap, exactly as in deck's
 *     `TextLayer` without a collision extension. Cesium's declutter belongs to
 *     3D-Tiles styling, not to a bare `LabelCollection`.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * No `Entity`/`DataSource` (raw primitives against `scene.primitives` is what
 * keeps picking, animation and lifecycle uniform across this package); no
 * camera reads or writes; no geometry math in this file at all — every
 * projection, colour and rebase decision lives in the Cesium-free
 * `lib/labels.ts` so it is unit-testable in plain Node.
 *
 * Rendering needs a live `Scene` (a browser canvas + WebGL); the collection
 * construction, the primitive writes and the pure builder are all testable in
 * Node, and are tested.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  VerticalOrigin,
  defined,
  type Label,
  type Scene,
} from 'cesium';
import {
  getFeatureProperties,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { FeatureColorMode } from './lib/feature-color.js';
import {
  buildLabelEntries,
  type LabelAnchor,
  type LabelBaseline,
} from './lib/labels.js';

export interface STTTextLayerOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;

  /**
   * Property column NAME drawn as each label's text (categorical → its own
   * category string; numeric → formatted). Absent/`null` falls back to
   * {@link textConstant}. There is no per-feature accessor form.
   */
  textProperty?: string | null;
  /** Text for every feature when {@link textProperty} does not resolve. @default '' */
  textConstant?: string;
  /**
   * Decimal places for a NUMERIC {@link textProperty}. `null` prints the
   * shortest string that round-trips the stored float32. @default null
   */
  textPrecision?: number | null;

  /** Glyph fill colour. @default constant near-white */
  color?: FeatureColorMode;
  /**
   * Glyph outline (halo) colour. `null` renders `LabelStyle.FILL` and skips the
   * second per-frame colour write entirely. @default null
   */
  outlineColor?: FeatureColorMode | null;
  /** Halo width in glyph pixels, used only when {@link outlineColor} is set. @default 2 */
  outlineWidth?: number;

  /**
   * Numeric column NAME giving each label's size MULTIPLIER on {@link font}
   * (see deviation 1 in the file header — this is not a pixel size).
   */
  scaleProperty?: string | null;
  /** Multiplier used when {@link scaleProperty} does not resolve. @default 1 */
  scaleConstant?: number;

  /** CSS font shorthand shared by every label. @default '600 14px sans-serif' */
  font?: string;
  /** Horizontal anchoring about the position (deck `getTextAnchor`). @default 'middle' */
  anchor?: LabelAnchor;
  /** Vertical alignment about the position (deck `getAlignmentBaseline`). @default 'center' */
  baseline?: LabelBaseline;
  /** Screen-space nudge `[x right, y DOWN]` in pixels (Cesium's sign convention). @default [0, 0] */
  pixelOffset?: readonly [number, number];
  /** Constant altitude lift in metres, to float labels clear of what they annotate. @default 0 */
  zLift?: number;
  /**
   * Draw labels through the globe and through terrain (Cesium
   * `disableDepthTestDistance = Infinity`). Useful for a sparse annotation set
   * you never want to lose; wrong for a dense one, where far-side labels then
   * read as near-side clutter. @default false
   */
  alwaysOnTop?: boolean;
}

interface LabelEntry {
  label: Label;
  /** Active window, relative to `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Base colours, pre-normalized to 0..1 by the builder so setTime never re-divides. */
  fillR: number;
  fillG: number;
  fillB: number;
  fillA: number;
  outlineR: number;
  outlineG: number;
  outlineB: number;
  outlineA: number;
  /** Last alpha written; `NaN` on the first frame so the first write always happens. */
  lastAlpha: number;
  lon: number;
  lat: number;
  binary: BinaryFeatures;
  featureIndex: number;
}

// TWO scratch Colors, reused for every per-frame write so setTime allocates
// nothing. Safe because JS is single-threaded and setTime runs synchronously to
// completion, and because Cesium's Label setters CLONE the value into the
// label's own `_fillColor`/`_outlineColor`. They must stay DISTINCT objects
// from that internal storage — mutating it in place would bypass the
// `Color.equals` dirty check and freeze the animation — and distinct from EACH
// OTHER, so that neither colour's write can depend on the order the two happen
// in (see the file header).
const SCRATCH_FILL = new Color();
const SCRATCH_OUTLINE = new Color();

const H_ORIGIN: Record<LabelAnchor, HorizontalOrigin> = {
  start: HorizontalOrigin.LEFT,
  middle: HorizontalOrigin.CENTER,
  end: HorizontalOrigin.RIGHT,
};

const V_ORIGIN: Record<LabelBaseline, VerticalOrigin> = {
  top: VerticalOrigin.TOP,
  center: VerticalOrigin.CENTER,
  bottom: VerticalOrigin.BOTTOM,
};

const DEFAULT_FONT = '600 14px sans-serif';

export class STTTextLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: LabelCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: STTTextLayerOptions;
  private timeOrigin = 0;
  private entries: LabelEntry[] = [];
  /** Whether the current build animates a second (outline) colour. */
  private hasOutline = false;

  constructor(scene: Scene, options: STTTextLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-text';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    // Constructed WITHOUT `{ scene }`: that option exists only to support
    // `heightReference` terrain clamping, which this layer does not use (it
    // places labels at absolute ECEF, lifted by `zLift`), and passing a Scene
    // in would couple construction to a live globe.
    this.collection = new LabelCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build labels from decoded tiles. Rebases all times to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    // Pure text/geometry/colour/rebase assembly lives in the Cesium-free
    // builder; this method only turns each FeatureLabel into a Cesium Label.
    const build = buildLabelEntries(tiles, {
      textProperty: this.opts.textProperty,
      textConstant: this.opts.textConstant,
      textPrecision: this.opts.textPrecision,
      color: this.opts.color,
      outlineColor: this.opts.outlineColor,
      scaleProperty: this.opts.scaleProperty,
      scaleConstant: this.opts.scaleConstant,
      zLift: this.opts.zLift,
    });
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitives are still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the new
    // set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous labels
    // is safe even when the emptiness is permanent: they sit at their true ECEF
    // positions, which the camera has by then left behind.
    if (build.labels.length === 0) return; // also leaves the prior timeOrigin untouched
    this.collection.removeAll();
    this.entries = [];
    this.timeOrigin = build.timeOrigin;
    this.hasOutline = build.hasOutline;

    const font = this.opts.font ?? DEFAULT_FONT;
    const style = build.hasOutline
      ? LabelStyle.FILL_AND_OUTLINE
      : LabelStyle.FILL;
    const outlineWidth = this.opts.outlineWidth ?? 2;
    const horizontalOrigin = H_ORIGIN[this.opts.anchor ?? 'middle'];
    const verticalOrigin = V_ORIGIN[this.opts.baseline ?? 'center'];
    const [offsetX, offsetY] = this.opts.pixelOffset ?? [0, 0];
    // One Cartesian2 per BUILD (not per frame): Cesium clones it into each
    // label, and it never changes afterwards.
    const pixelOffset = new Cartesian2(offsetX, offsetY);
    const disableDepthTestDistance = this.opts.alwaysOnTop
      ? Number.POSITIVE_INFINITY
      : 0;

    for (const fl of build.labels) {
      const label = this.collection.add({
        position: new Cartesian3(fl.x, fl.y, fl.z),
        text: fl.text,
        font,
        style,
        fillColor: new Color(fl.fillR, fl.fillG, fl.fillB, fl.fillA),
        outlineColor: new Color(
          fl.outlineR,
          fl.outlineG,
          fl.outlineB,
          fl.outlineA,
        ),
        outlineWidth,
        scale: fl.scale,
        horizontalOrigin,
        verticalOrigin,
        pixelOffset,
        disableDepthTestDistance,
        id: {
          layerId: this.id,
          binary: fl.binary,
          featureIndex: fl.featureIndex,
        },
      });
      this.entries.push({
        label,
        start: fl.start,
        end: fl.end,
        fillR: fl.fillR,
        fillG: fl.fillG,
        fillB: fl.fillB,
        fillA: fl.fillA,
        outlineR: fl.outlineR,
        outlineG: fl.outlineG,
        outlineB: fl.outlineB,
        outlineA: fl.outlineA,
        lastAlpha: NaN, // NaN !== anything → force the first setTime to write
        lon: fl.lon,
        lat: fl.lat,
        binary: fl.binary,
        featureIndex: fl.featureIndex,
      });
    }
  }

  /**
   * Advance to an absolute playhead time; recompute per-label alpha via the
   * shared oracle. Zero allocations (two module-level scratch `Color`s), and a
   * label whose alpha is unchanged since the last frame costs one compare
   * instead of a colour write plus a glyph rebind. A label at alpha 0 is
   * hidden outright, so a filtered-out label draws nothing at all.
   */
  setTime(absoluteMs: number): void {
    const cur = absoluteMs - this.timeOrigin;
    const fill = SCRATCH_FILL;
    const outline = SCRATCH_OUTLINE;
    for (const e of this.entries) {
      const filter = timeFilterAlpha(
        this.mode,
        cur,
        e.start,
        e.end,
        this.params,
      );
      const alpha = e.fillA * filter;
      if (alpha === e.lastAlpha) continue; // identical to the last write — nothing to dirty
      const wasHidden = e.lastAlpha === 0; // NaN === 0 is false, so frame 1 never re-shows
      e.lastAlpha = alpha;
      if (alpha === 0) {
        e.label.show = false; // no glyph billboards for a fully filtered-out label
        continue;
      }
      if (wasHidden) e.label.show = true;

      fill.red = e.fillR;
      fill.green = e.fillG;
      fill.blue = e.fillB;
      fill.alpha = alpha;
      e.label.fillColor = fill; // setter clones the scratch into the label's own _fillColor

      if (this.hasOutline) {
        // The halo fades on the SAME filter curve, scaled by its own base alpha
        // — a halo that outlived its glyph would read as a ghost outline.
        outline.red = e.outlineR;
        outline.green = e.outlineG;
        outline.blue = e.outlineB;
        outline.alpha = e.outlineA * filter;
        e.label.outlineColor = outline;
      }
    }
  }

  /** Hit-test → the shared `SttPickResult` (feature props joined via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | {
          id?: {
            layerId: string;
            binary: BinaryFeatures;
            featureIndex: number;
          };
        }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id)
      return null;
    const { binary, featureIndex } = picked.id;
    // The builder DROPS empty-texted features, so entries[i] is not
    // featureIndex i — provenance travels with the entry and is matched, never
    // recomputed from an index.
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
    // `PrimitiveCollection.remove` DESTROYS what it removes (destroyPrimitives
    // defaults to true), and `LabelCollection.destroy()` releases the lazily
    // built glyph atlas — the one GPU resource this layer indirectly owns and
    // the reason a plain `removeAll()` would not be enough. If the collection
    // was never in (or is already gone from) scene.primitives, `remove` returns
    // false and that atlas would leak, so destroy it ourselves.
    const removed = this.scene.primitives.remove(this.collection);
    if (!removed && !this.collection.isDestroyed()) this.collection.destroy();
    this.entries = [];
  }
}
