// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTTextLayer` — time-filtered map LABELS over binary POINT tiles, the Three
 * port of deck's `AnimatedTextLayer`. One {@link createTextMaterial}
 * billboard-quad instance PER CHARACTER, sampling a caller-supplied SDF / bitmap
 * font atlas exactly the way {@link STTIconLayer} samples its icon atlas — this
 * layer IS the icon layer with a glyph-layout pass in front of it. Unlocks place
 * names, vessel/callsign labels, and numeric read-outs pinned to the data.
 *
 * ── NO PER-FEATURE ROW OBJECTS ───────────────────────────────────────────────
 * The data rule is inherited verbatim from the deck layer: each `(tile, layer)`
 * is decoded ONCE by `buildTextBuffers` into FLAT typed arrays — a UTF-32
 * code-point buffer plus per-row character offsets, RTC-relative xyz positions,
 * `[start,end]` times REBASED to `ctx.timeOrigin` (never absolute epoch-ms in an
 * f32), RGBA colours, optional size / angle / filter columns — and every glyph is
 * laid out from those. Nothing in this layer ever materializes a row object.
 *
 * ── PICKING PROVENANCE IS PER FEATURE, NOT PER GLYPH ─────────────────────────
 * This is the ONE place this kind's provenance rule differs from every other
 * layer in the package. Elsewhere a merged instance IS a feature; here a merged
 * instance is a CHARACTER, and every character of label `i` pushes the SAME
 * `(tileKey, i)` into the provenance buffer. A GPU id decoded from any glyph of a
 * label therefore resolves to that LABEL — picking the `W` of "Wellington" and
 * picking its final `n` return the identical `STTIdPickInfo`. `provenance.length`
 * is consequently the GLYPH count (which is also what `pick()` passes as
 * `featureCount`, since that bound is over merged INSTANCES).
 *
 * All tiles merge into one billboard-quad `InstancedBufferGeometry`; the GPU
 * time-filter handles per-frame visibility, and a label's glyphs all share the
 * row's `[start,end]` so a label appears and disappears whole. RTC: positions are
 * relative to a shared `origin` written to `object.position` so large
 * mercator/globe magnitudes stay in the f64 CPU transform (no-op in the ENU/AV
 * frame).
 *
 * Sizing is in **screen pixels** (deck `TextLayer`'s default `sizeUnits`), so the
 * host must push the drawing-buffer size via {@link setViewport} on resize.
 *
 * An absent {@link STTTextLayerOptions.atlas} draws NOTHING and warns ONCE (the
 * warn-once shape the flow-corridor / flow-stroke layers use) — there is no
 * font-atlas generator in this package, so a caller with no atlas has simply not
 * finished wiring the layer up. This is deliberately SOFTER than
 * {@link STTIconLayer}, whose `atlas` is a REQUIRED prop the type system rejects
 * you for omitting: an icon atlas is a handful of sprites a caller ships with the
 * app, while a font atlas is usually generated asynchronously, so the layer has
 * to survive the frames before it arrives.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { Texture } from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { InstanceProvenance, buildIdColors } from '@poopdeck.gl/core/picking';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad.js';
import {
  buildTextBuffers,
  type TextAlignmentBaseline,
  type TextAnchor,
  type TextColorMode,
  type TextGlyphMappingEntry,
} from '../lib/text-buffers.js';
import {
  createTextMaterial,
  createTextIdMaterial,
  updateTextUniforms,
  type TextMaterialBundle,
  type TextMode,
  type TextUniformValues,
} from '../tsl/text-material.js';
import type { RGBA } from '../lib/color.js';
import type { DataFilterRange } from '../tsl/data-filter.js';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

export interface STTTextLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** window (raw) | cumulative (labels persist) | none. @default 'window' */
  mode?: TextMode;

  // ── font atlas (host provides the loaded image + mapping) ────────────────────
  /**
   * The loaded font-atlas texture. Required to render anything — an absent atlas
   * draws NOTHING and warns once (this package ships no atlas generator).
   */
  atlas?: Texture | null;
  /** Pixel dimensions of the atlas — used to normalize `fontMapping` to 0..1 UV. */
  atlasWidth?: number;
  atlasHeight?: number;
  /** `character → {x, y, width, height, advance}` sub-rectangles into the atlas. */
  fontMapping?: Record<string, TextGlyphMappingEntry>;
  /** Atlas-pixel height of one EM (deck `fontSettings.fontSize`). @default 64 */
  fontHeight?: number;
  /** Line box height as a multiple of the EM (deck `lineHeight`). @default 1 */
  lineHeight?: number;
  /**
   * The atlas stores a signed distance field (deck `fontSettings.sdf`): glyph
   * edges are resolved through a smoothstep instead of a raw bitmap alpha.
   * @default false
   */
  sdf?: boolean;
  /** SDF distance threshold marking the glyph edge. @default 0.5 */
  sdfCutoff?: number;
  /** Half-width of the SDF smoothstep band. @default 0.1 */
  sdfSmoothing?: number;

  // ── the label text ───────────────────────────────────────────────────────────
  /**
   * Property column NAME drawn as each label. A categorical (string) column is
   * transcoded once per CATEGORY; a numeric column is formatted (see
   * {@link textPrecision}). @default 'text'
   */
  textProperty?: string | null;
  /**
   * Constant label for every feature when {@link textProperty} is null or absent
   * from a tile. @default '' (those rows draw nothing)
   */
  text?: string;
  /**
   * Decimal places for a NUMERIC {@link textProperty}. `null` prints the shortest
   * decimal string that round-trips the stored `float32`. @default null
   */
  textPrecision?: number | null;

  // ── anchoring / alignment (deck getTextAnchor / getAlignmentBaseline) ────────
  /** Horizontal anchor of the label about its position. @default 'middle' */
  textAnchor?: TextAnchor;
  /** Vertical alignment of the label about its position. @default 'center' */
  alignmentBaseline?: TextAlignmentBaseline;

  // ── size (on-screen pixels) ──────────────────────────────────────────────────
  /** Numeric column for per-feature pixel size. */
  sizeProperty?: string | null;
  /** Constant on-screen EM size (pixels). @default 32 */
  size?: number;
  /** Global multiplier on every label's size (deck `sizeScale`). @default 1 */
  sizeScale?: number;
  sizeMinPixels?: number;
  sizeMaxPixels?: number;

  // ── rotation ─────────────────────────────────────────────────────────────────
  /** Numeric column of label rotations in DEGREES (CCW from up). */
  angleProperty?: string | null;
  /** Constant rotation (degrees) when `angleProperty` is null/absent. @default 0 */
  angle?: number;

  // ── colour ───────────────────────────────────────────────────────────────────
  /** Categorical colour property; when null the constant `color` applies. */
  colorProperty?: string | null;
  /** `{ category → [r,g,b,a] 0–255 }` for categorical label colour. */
  colorMapping?: Record<string, RGBA>;
  /** Colour for null / unmapped categories, or the constant colour.
   *  @default [255, 255, 255, 255] */
  color?: RGBA;

  // ── DataFilter (deck DataFilterExtension) ──────────────────────────────────
  /**
   * Numeric column feeding the GPU label filter (`sttFilterValue`). The builder
   * repeats a label's value across its glyphs, so an out-of-range label collapses
   * WHOLE alongside the time gate; a `filterSoftRange` fades it. @default null
   */
  filterProperty?: string | null;
  /** Inclusive `[min,max]` hard range; `null` idles the filter. @default null */
  filterRange?: DataFilterRange | null;
  /** `[min,max]` inside {@link filterRange} fading instead of hard-clipping. @default null */
  filterSoftRange?: DataFilterRange | null;
  /** Enable/disable the label filter. @default true */
  filterEnabled?: boolean;

  // ── elevation ────────────────────────────────────────────────────────────────
  elevationProperty?: string | null;
  elevationScale?: number;

  // ── opacity / time params ────────────────────────────────────────────────────
  opacity?: number;
  alphaCutoff?: number;
  // Full-width `timeWindow` + `fadeIn/OutDuration` and the lower-level
  // `windowHalf`/`fadeIn`/`fadeOut` aliases come from ThreeTimeWindowOptions.
}

const DEFAULT_TEXT_COLOR: RGBA = [255, 255, 255, 255];

export class STTTextLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: TextMaterialBundle | null = null;
  private viewport: [number, number] = [1280, 720];
  private readonly opts: STTTextLayerOptions;

  // ── GPU id-buffer pick identity (merged GLYPH g → the LABEL's (tileKey, i)) ──
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  // Opt-in GPU id-buffer pick pass (lazily built on first pick; browser-verify).
  private idBundle: TextMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;
  /** One warning per layer for a missing atlas — never a per-tile log storm. */
  private warnedNoAtlas = false;

  constructor(options: STTTextLayerOptions = {}) {
    super();
    this.opts = options;
    this.id = options.id ?? 'text';
    this.object.name = this.id;
    // Labels are sized in SCREEN pixels, so the world-space bounding box (the
    // anchor points) understates the drawn extent — the same reason the icon
    // layer opts out of frustum culling.
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so pixel sizing is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  private colorMode(): TextColorMode {
    if (this.opts.colorProperty) {
      return {
        type: 'categorical',
        property: this.opts.colorProperty,
        mapping: this.opts.colorMapping ?? {},
        fallback: this.opts.color ?? DEFAULT_TEXT_COLOR,
      };
    }
    return { type: 'constant', color: this.opts.color ?? DEFAULT_TEXT_COLOR };
  }

  private resolveMode(): TextMode {
    return this.opts.mode ?? 'window';
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;

    // No atlas ⇒ draw nothing, warn once. Reset the pick identity FIRST so a
    // stale pick from a previous (atlased) frame resolves to null rather than to
    // a feature that is no longer on screen.
    const atlas = this.opts.atlas ?? null;
    if (!atlas) {
      this.provenance = new InstanceProvenance();
      this.binaryByTileKey = new Map();
      if (!this.warnedNoAtlas) {
        this.warnedNoAtlas = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[stt-three] STTTextLayer "${this.id}": no \`atlas\` texture supplied — ` +
            `labels will not render. Provide a font atlas + \`fontMapping\` ` +
            `(character → {x, y, width, height, advance}), as STTIconLayer requires ` +
            `for its icon atlas.`,
        );
      }
      this.disposeGeometry();
      this.object.geometry = makeBillboardQuadGeometry();
      this.object.visible = false;
      return;
    }

    const buf = buildTextBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      atlasWidth: this.opts.atlasWidth ?? 0,
      atlasHeight: this.opts.atlasHeight ?? 0,
      fontMapping: this.opts.fontMapping ?? {},
      fontHeight: this.opts.fontHeight,
      lineHeight: this.opts.lineHeight,
      // `?? 'text'` would swallow an EXPLICIT null, which both this option's
      // `string | null` type and `text`'s doc promise means "no column, draw the
      // constant" — only an UNSET prop falls back to the default column name.
      textProperty:
        this.opts.textProperty === undefined ? 'text' : this.opts.textProperty,
      textConstant: this.opts.text,
      textPrecision: this.opts.textPrecision ?? null,
      anchor: this.opts.textAnchor ?? 'middle',
      baseline: this.opts.alignmentBaseline ?? 'center',
      sizeProperty: this.opts.sizeProperty ?? null,
      sizeConstant: this.opts.size ?? 32,
      angleProperty: this.opts.angleProperty ?? null,
      angleConstant: this.opts.angle ?? 0,
      colorMode: this.colorMode(),
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      filterProperty: this.opts.filterProperty ?? null,
    });
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old feature).
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;

    this.disposeGeometry();
    if (buf.count === 0) {
      this.object.geometry = makeBillboardQuadGeometry();
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    const geometry = makeBillboardQuadGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute(
      'sttCenter',
      new InstancedBufferAttribute(buf.centers, 3),
    );
    geometry.setAttribute(
      'sttGlyphOffset',
      new InstancedBufferAttribute(buf.glyphOffsets, 2),
    );
    geometry.setAttribute(
      'sttGlyphExtent',
      new InstancedBufferAttribute(buf.glyphExtents, 2),
    );
    geometry.setAttribute(
      'sttColor',
      new InstancedBufferAttribute(buf.colors, 4),
    );
    geometry.setAttribute(
      'sttAngle',
      new InstancedBufferAttribute(buf.angles, 1),
    );
    geometry.setAttribute(
      'sttSize',
      new InstancedBufferAttribute(buf.sizes, 1),
    );
    geometry.setAttribute(
      'sttUvRect',
      new InstancedBufferAttribute(buf.uvRects, 4),
    );
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    // DataFilter: bind the per-glyph filter value when a filterProperty emitted one.
    if (buf.filterValues.length > 0) {
      geometry.setAttribute(
        'sttFilterValue',
        new InstancedBufferAttribute(buf.filterValues, 1),
      );
    }
    if (buf.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }

    const bundle = this.ensureBundle(atlas);
    this.object.geometry = geometry;
    this.object.material = bundle.material;
    this.pushUniforms(this.timeOrigin);
  }

  /**
   * The label material, built ONCE per layer (audit E5). Every input is fixed at
   * construction, so unlike the icon layer there is not even a structural variant
   * to flip. Disposing per `setTiles` would evict three's `nodeBuilderCache`
   * entry, program and pipeline — a shader rebuild per tile arrival. Only the
   * geometry churns.
   */
  private ensureBundle(atlas: Texture): TextMaterialBundle {
    if (this.bundle) return this.bundle;
    // The shader maps quad-top → atlas v0 (top-left origin). A TextureLoader
    // atlas defaults to flipY=true, which would mirror every glyph vertically —
    // enforce flipY=false to match the UV contract (same as STTIconLayer).
    if (atlas.flipY) {
      atlas.flipY = false;
      atlas.needsUpdate = true;
    }
    this.bundle = createTextMaterial({
      mode: this.resolveMode(),
      atlas,
      sdf: this.opts.sdf ?? false,
      sdfCutoff: this.opts.sdfCutoff,
      sdfSmoothing: this.opts.sdfSmoothing,
      alphaCutoff: this.opts.alphaCutoff,
      dataFilter: !!this.opts.filterProperty,
    });
    return this.bundle;
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    this.pushUniforms(absoluteTimeMs);
  }

  /** The uniform values for the given playhead — shared by the colour render and
   *  the id-pass so the pick pass gates on the SAME time / filter. */
  private textUniformValues(absoluteTimeMs: number): TextUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: resolveTimeWindow(this.opts, 0),
      opacity: this.opts.opacity ?? 1,
      sizeScale: this.opts.sizeScale ?? 1,
      sizeMinPixels: this.opts.sizeMinPixels ?? 0,
      sizeMaxPixels: this.opts.sizeMaxPixels ?? 1e9,
      viewport: this.viewport,
      // No-op unless the material was built with a filter.
      dataFilter: {
        filterEnabled: this.opts.filterEnabled,
        filterRange: this.opts.filterRange ?? null,
        filterSoftRange: this.opts.filterSoftRange ?? null,
      },
    };
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updateTextUniforms(this.bundle, this.textUniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: text variant) ───────────────────────────
  //
  // Two halves: `resolvePick` (pure, unit-tested — merged GLYPH index →
  // STTIdPickInfo via the provenance buffer, the shared `resolveIdPick` seam) and
  // `pick` (the opt-in GPU id-pass + readback, which needs a live WebGPU device
  // and is browser-verify only). Because the builder gave every glyph of a label
  // the same provenance entry, both halves resolve a hit on ANY character to the
  // LABEL's feature.

  /**
   * Resolve a merged GLYPH index (as decoded from a GPU id-buffer readback) to a
   * normalised {@link STTIdPickInfo} (`kind: 'text'`), or `null` for a miss.
   * Pure — the unit-tested seam; call it directly with a decoded index. Note the
   * index space: it counts CHARACTERS, while the resolved `featureIndex` counts
   * LABELS.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'text',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-glyph `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createTextIdMaterial({
        mode: this.resolveMode(),
        dataFilter: !!this.opts.filterProperty,
        alphaCutoff: this.opts.alphaCutoff,
      });
    }
    if (!this.idColorsPresent && this.provenance.length > 0) {
      const idColors = buildIdColors(this.provenance.length);
      this.object.geometry.setAttribute(
        'sttIdColor',
        new InstancedBufferAttribute(idColors, 3),
      );
      this.idColorsPresent = true;
    }
  }

  /**
   * GPU text pick — auto-registered into the r3f `PickController` (a CPU box miss
   * falls through to this). Renders this layer's glyphs with the flat id material
   * into `picker`'s off-screen target, reads back the merged-GLYPH id at CSS pixel
   * `(cssX, cssY)`, and resolves it through the provenance buffer to the LABEL it
   * belongs to. The `resolvePick` half is unit-tested; the render + readback needs
   * a live GPU device and is browser-verify per the package's test policy. The id
   * material reuses the SAME vertex collapse gates (time-filter + label filter),
   * so only labels drawn THIS frame are pickable, at their laid-out position.
   */
  async pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<STTIdPickInfo | null> {
    if (this.provenance.length === 0 || !this.object.visible) return null;
    this.ensurePickPass();
    const idBundle = this.idBundle;
    if (!idBundle) return null;
    // Sync the id material's gates to the live playhead so only labels visible
    // THIS frame are pickable, at their laid-out position.
    updateTextUniforms(idBundle, this.textUniformValues(this.currentTimeMs));

    const mesh = this.object;
    const renderMaterial = mesh.material;
    const index = await picker.pick(mesh, camera, cssX, cssY, {
      // The id bound is over merged INSTANCES, which for this kind are glyphs.
      featureCount: this.provenance.length,
      onBeforeRender: () => {
        mesh.material = idBundle.material;
      },
      onAfterRender: () => {
        mesh.material = renderMaterial;
      },
    });
    if (index == null) return null;
    return this.resolvePick(index, [cssX, cssY]);
  }

  /** Release the geometry (and the per-geometry pick attribute flag) only. */
  private disposeGeometry(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.idColorsPresent = false;
  }

  private disposeMaterials(): void {
    this.bundle?.material.dispose();
    this.bundle = null;
    this.idBundle?.material.dispose();
    this.idBundle = null;
  }

  dispose(): void {
    this.disposeGeometry();
    this.disposeMaterials();
  }
}
