// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `TextMaterial` — time-filtered map LABELS, the Three port of deck's
 * `AnimatedTextLayer`. Structurally this is {@link createIconMaterial} with a
 * glyph-layout offset in front of it: each instance is ONE CHARACTER's
 * camera-facing quad, sized in **screen pixels** (deck `TextLayer`'s default
 * `sizeUnits: 'pixels'`), rotated by a per-instance angle, and textured from a
 * shared SDF / bitmap font atlas {@link Texture} through a per-instance UV
 * sub-rectangle. All the typography — per-character advance layout, the
 * start/middle/end anchor, the top/center/bottom baseline, multi-line stacking —
 * is resolved on the CPU by `buildTextBuffers` and arrives here as two EM-space
 * vec2s (`sttGlyphOffset`, `sttGlyphExtent`), so the shader only rotates and
 * scales.
 *
 * VERTEX: the instance centre (the row's ANCHOR — identical for every glyph of a
 * label) goes to clip space (`MVP · center`); the quad corner (`[-1,1]²`) is
 * scaled by the glyph's half-extent, translated by the glyph's layout offset,
 * rotated by `angle` (radians, CCW from up), scaled to `sizePx` (EM units →
 * pixels) and converted to a clip offset via `2/viewport · w`, so a label is a
 * constant pixel size on screen at any depth (the same pixel→clip conversion as
 * {@link createIconMaterial}). `sizePx` is clamped to
 * `[sizeMinPixels, sizeMaxPixels]` and multiplied by the hard
 * {@link timeFilterVisibleNode} gate — an out-of-window label collapses every one
 * of its glyphs to a zero-area quad in the vertex stage (dies at assembly, no
 * fragment cost) instead of relying on an alpha-cutoff discard (deck.gl #7509).
 *
 * FRAGMENT: the UNROTATED corner maps to the glyph's atlas UV rect and samples
 * the atlas. Text glyphs are always MASK sprites — deck's `MultiIconLayer` forces
 * mask mode for text — so the per-instance tint supplies the COLOUR and the atlas
 * supplies the COVERAGE, whether that coverage is a bitmap alpha or (with
 * {@link TextMaterialOptions.sdf}) a signed distance run through a smoothstep for
 * resolution-independent edges. The time alpha (a `select()`) is recomputed in
 * the FRAGMENT stage from VARIED raw `start`/`end` — never wrapped in a
 * `varying()` (the codebase's recurring WGSL crash).
 *
 * NOT MODELLED (deliberately): background / border rectangles, the SDF outline
 * pass (`outlineColor`/`outlineWidth`), and per-label content-box clipping. Those
 * are three separate deck sublayers' worth of surface; the glyph pass is the one
 * that makes the kind render.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending } from 'three';
import type { Texture } from 'three';
import * as TSL from 'three/tsl';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec4,
  mix,
  select,
  saturate,
  max,
  modelViewMatrix,
  cameraProjectionMatrix,
  type UniformNode,
  type TSLNode,
} from './nodes.js';
import { srgbToWorking } from './color-space.js';
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  timeFilterVisibleNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterMode, TimeFilterParams } from './time-filter-math.js';
import {
  DataFilterUniforms,
  dataFilterVisibleNode,
  dataFilterAlphaNode,
  updateDataFilterUniforms,
  type DataFilterOptions,
} from './data-filter.js';

// Extra TSL builders not yet surfaced on the ./nodes seam (texture sampling +
// the per-instance rotation trig). Loosely typed like the ./nodes re-exports.
const texture = TSL.texture as unknown as (...a: any[]) => any;
const cos = TSL.cos as unknown as (...a: any[]) => any;
const sin = TSL.sin as unknown as (...a: any[]) => any;

/**
 * Text time-filter modes. deck's `AnimatedTextLayer` is window-only;
 * `cumulative` adds the "labels accumulate and persist" worldbuild look, and
 * `none` draws every label. `wake` and `trail` are deliberately absent: a comet
 * tail on a glyph is unreadable, and a per-vertex trail has no meaning for a
 * per-character instance.
 */
export type TextMode = Extract<
  TimeFilterMode,
  'window' | 'cumulative' | 'none'
>;

/** Live text uniforms: pixel-size clamp, opacity, and the canvas size in px. */
export class TextUniforms {
  readonly opacity: UniformNode = uniform(1);
  /** Global multiplier on every label's pixel size (deck `sizeScale`). */
  readonly sizeScale: UniformNode = uniform(1);
  readonly sizeMinPixels: UniformNode = uniform(0);
  readonly sizeMaxPixels: UniformNode = uniform(1e9);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
}

export interface TextMaterialOptions {
  /** Time-filter mode: window (raw), cumulative (labels persist), none. */
  mode: TextMode;
  /** The font-atlas texture (host provides the loaded atlas image). */
  atlas: Texture;
  /**
   * The atlas stores a signed distance field rather than a bitmap: the sampled
   * alpha is a distance, thresholded through a smoothstep so glyph edges stay
   * crisp at any zoom. @default false (a plain bitmap atlas — alpha IS coverage)
   */
  sdf?: boolean;
  /** SDF distance threshold that marks the glyph edge. @default 0.5 */
  sdfCutoff?: number;
  /** Half-width of the SDF smoothstep band, in distance units. @default 0.1 */
  sdfSmoothing?: number;
  /**
   * Discard fragments below this final alpha. Glyph coverage is the one place
   * this package uses a fragment discard by design (SDF-edge antialiasing); the
   * time cut is still a vertex-stage collapse. @default 0.05
   */
  alphaCutoff?: number;
  /**
   * Install the GPU column filter (deck `DataFilterExtension`): binds a
   * per-instance `sttFilterValue` attribute and gates each glyph by
   * `filterRange`/`filterSoftRange`. The builder repeats a label's value across
   * its glyphs, so an out-of-range LABEL collapses whole in the VERTEX stage
   * (alongside the time-window gate) and a `filterSoftRange` fades it in the
   * fragment `opacityNode`. Off (undefined) leaves the text path BYTE-IDENTICAL.
   * @default false
   */
  dataFilter?: boolean;
}

export interface TextMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  text: TextUniforms;
  mode: TextMode;
  /** Filter uniforms (`filterMin`…) when the material was built with `dataFilter`. */
  filter: DataFilterUniforms | null;
}

/**
 * `smoothstep(e0, e1, x)` as a node graph — `nodes.ts` exposes no `smoothstep`
 * builder, so it is composed from `saturate` + arithmetic exactly as
 * `data-filter.ts` does. EPS-guarded so a zero-width band (`sdfSmoothing: 0`)
 * degenerates to a hard step rather than a NaN.
 */
function smoothstepNode(e0: TSLNode, e1: TSLNode, x: TSLNode): TSLNode {
  const t = saturate(x.sub(e0).div(max(e1.sub(e0), float(1e-6))));
  return t.mul(t).mul(float(3).sub(t.mul(2)));
}

export function createTextMaterial(
  opts: TextMaterialOptions,
): TextMaterialBundle {
  const time = new TimeFilterUniforms();
  const text = new TextUniforms();

  // ── per-instance (per-GLYPH) attributes (set by the layer) ──────────────────
  const center = attribute('sttCenter', 'vec3'); // the ROW anchor, shared per label
  const glyphOffset = attribute('sttGlyphOffset', 'vec2'); // EM units, laid out on CPU
  const glyphExtent = attribute('sttGlyphExtent', 'vec2'); // EM units, quad half-extent
  const color = attribute('sttColor', 'vec4');
  const angle = attribute('sttAngle', 'float'); // radians, CCW from up
  const size = attribute('sttSize', 'float'); // on-screen EM size in pixels
  const uvRect = attribute('sttUvRect', 'vec4'); // [u0,v0,u1,v1]
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  // DataFilter: per-instance filter column (bound only when installed).
  const filterU = opts.dataFilter ? new DataFilterUniforms() : null;
  const filterValue = filterU ? attribute('sttFilterValue', 'float') : null;
  const corner = positionGeometry.xy; // [-1,1]²

  // ── VERTEX: place the glyph, rotate the label, size in pixels ────────────────
  // The corner spans the GLYPH's own box; the layout offset then moves that box
  // into place within the label. Both are EM units (1.0 = `sizePx` on screen).
  // Rotation is applied to the composed offset so the WHOLE label turns about its
  // anchor rather than each glyph spinning in place.
  const local = corner.mul(glyphExtent).add(glyphOffset);
  const c = cos(angle);
  const s = sin(angle);
  const rx = local.x.mul(c).sub(local.y.mul(s));
  const ry = local.x.mul(s).add(local.y.mul(c));

  const sizePx = TSL.clamp(
    size.mul(text.sizeScale),
    text.sizeMinPixels,
    text.sizeMaxPixels,
  );
  // HARD vertex-stage collapse: an out-of-window OR out-of-filter-range label
  // gets scale = 0, so every one of its glyph quads degenerates to a point (zero
  // area → no fragment cost; deck.gl #7509). The two gates multiply, so either one
  // collapses the label; not filtered ⇒ the filter gate is 1 (byte-identical).
  // The soft-band time / filter fades stay in the fragment `opacityNode` below.
  let visible = timeFilterVisibleNode(opts.mode, time, start, end);
  if (filterU && filterValue) {
    visible = visible.mul(dataFilterVisibleNode(filterU, filterValue));
  }
  const scale = sizePx.mul(visible);

  const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(center, 1)));
  // EM offset → pixels (× sizePx) → NDC (× 2/viewport) → clip (× w).
  const offX = rx.mul(scale).mul(float(2)).div(text.viewport.x).mul(clip.w);
  const offY = ry.mul(scale).mul(float(2)).div(text.viewport.y).mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(offX),
    clip.y.add(offY),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: atlas coverage × tint × time alpha ─────────────────────────────
  // The UNROTATED corner [-1,1]² maps to the glyph's atlas rect — the GEOMETRY was
  // rotated in clip space above, so the glyph stays upright in atlas space and
  // rotates on screen. corner∈[-1,1] → t∈[0,1]: u = mix(u0,u1,(x+1)/2); the atlas
  // v origin is the TOP and quad +y is up, so v = mix(v0,v1,(1-y)/2).
  const vColor = varying(color);
  const vUvRect = varying(uvRect);
  const vCorner = varying(corner);
  const vStart = varying(start);
  const vEnd = varying(end);

  const tx = vCorner.x.add(1).mul(0.5);
  const ty = float(1).sub(vCorner.y).mul(0.5);
  const sampleU = mix(vUvRect.x, vUvRect.z, tx);
  const sampleV = mix(vUvRect.y, vUvRect.w, ty);
  const tex = texture(opts.atlas, vec2(sampleU, sampleV));

  // Bitmap: the sampled alpha IS the coverage. SDF: it is a distance, thresholded
  // through a smoothstep band so the edge stays crisp under magnification.
  const cutoff = opts.sdfCutoff ?? 0.5;
  const smoothing = opts.sdfSmoothing ?? 0.1;
  const coverage = opts.sdf
    ? smoothstepNode(
        float(cutoff - smoothing),
        float(cutoff + smoothing),
        tex.a,
      )
    : tex.a;

  const fragAlpha = timeFilterAlphaNode(opts.mode, time, vStart, vEnd);
  let a = coverage.mul(vColor.a).mul(text.opacity).mul(fragAlpha);
  // Soft column-filter fade (vary the raw value; the alpha node is a mix()/step()
  // graph, never a select(), so it is varying-safe — like the time fade above).
  if (filterU && filterValue) {
    a = a.mul(dataFilterAlphaNode(filterU, varying(filterValue)));
  }

  // Text is a MASK sprite: the tint is the colour, the atlas is the coverage. The
  // sRGB→working conversion is LAST and colour-only (see ./color-space.ts).
  material.colorNode = srgbToWorking(vColor.xyz);
  material.opacityNode = a;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.05;

  return { material, time, text, mode: opts.mode, filter: filterU };
}

export interface TextUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  opacity?: number;
  sizeScale?: number;
  sizeMinPixels?: number;
  sizeMaxPixels?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize). */
  viewport?: [number, number];
  /** Column-filter props (no-op unless built with `dataFilter: true`). */
  dataFilter?: DataFilterOptions;
}

export function updateTextUniforms(
  bundle: TextMaterialBundle,
  v: TextUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  if (v.opacity !== undefined) bundle.text.opacity.value = v.opacity;
  if (v.sizeScale !== undefined) bundle.text.sizeScale.value = v.sizeScale;
  if (v.sizeMinPixels !== undefined)
    bundle.text.sizeMinPixels.value = v.sizeMinPixels;
  if (v.sizeMaxPixels !== undefined)
    bundle.text.sizeMaxPixels.value = v.sizeMaxPixels;
  if (v.viewport) bundle.text.viewport.value.set(v.viewport[0], v.viewport[1]);
  if (bundle.filter) updateDataFilterUniforms(bundle.filter, v.dataFilter);
}

// ── GPU id-buffer pick material (GPU picking catalog: text variant) ─────────────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Renders each glyph's flat
// per-instance id colour (`sttIdColor`, from `buildIdColors(mergedGlyphCount)`)
// into the picker's off-screen target. It reproduces the colour material's glyph
// VERTEX stage VERBATIM (same EM layout, same pixel sizing, same label rotation)
// and REUSES the identical vertex-stage collapse gates — the time-filter
// {@link timeFilterVisibleNode} AND the {@link dataFilterVisibleNode} column
// filter — so an out-of-window / off-filter label picks EXACTLY where (and only
// when) it is drawn. The id is written opaque at full intensity (never × alpha),
// so the decoded RGB is an exact 24-bit index.
//
// Unlike the colour material it does NOT sample the atlas: the whole glyph CELL
// is pickable, not just the inked strokes, which is what makes a click "on the
// label" land reliably (deck's `TextLayer` picks the character quads too). Since
// the builder gave every glyph of a row the SAME provenance entry, any of those
// cells resolves to the same FEATURE. Bind {@link updateTextUniforms} to sync its
// time / size / filter uniforms before the pass. The returned bundle is
// shape-compatible with {@link TextMaterialBundle}.

export interface TextIdMaterialOptions {
  /**
   * Time-filter mode — MUST match the colour material so the id quads size +
   * collapse identically. */
  mode: TextMode;
  /**
   * Install the GPU column filter collapse gate (mirrors the colour material's
   * `dataFilter`). @default false */
  dataFilter?: boolean;
  /**
   * Threshold on the recomputed time / filter alpha for the hard 0/1 id gate —
   * the colour material's `alphaCutoff` (so a barely-faded label isn't pickable).
   * @default 0.05 */
  alphaCutoff?: number;
}

/**
 * Build the text id material. `opts` mirror the colour material's gate options
 * (`mode`, `dataFilter`, `alphaCutoff`) so the pick pass matches the on-screen
 * labels; the colour-only options (`atlas`, `sdf`, `sdfCutoff`, `sdfSmoothing`)
 * are ignored (the id is a flat per-instance colour over the whole glyph cell).
 */
export function createTextIdMaterial(
  opts: TextIdMaterialOptions,
): TextMaterialBundle {
  const time = new TimeFilterUniforms();
  const text = new TextUniforms();
  const mode = opts.mode;
  const filterU = opts.dataFilter ? new DataFilterUniforms() : null;

  // Per-instance attributes: the SAME glyph-shaping attributes as the colour
  // material, plus the flat per-instance id colour. No `sttUvRect` and no
  // `sttColor` (the id never samples the atlas or the tint).
  const center = attribute('sttCenter', 'vec3');
  const glyphOffset = attribute('sttGlyphOffset', 'vec2');
  const glyphExtent = attribute('sttGlyphExtent', 'vec2');
  const angle = attribute('sttAngle', 'float'); // radians, CCW from up
  const size = attribute('sttSize', 'float'); // on-screen EM size in pixels
  const idColor = attribute('sttIdColor', 'vec3');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const filterValue = filterU ? attribute('sttFilterValue', 'float') : null;
  const corner = positionGeometry.xy; // [-1,1]²

  // ── VERTEX: reproduce the colour material's glyph placement VERBATIM ─────────
  const local = corner.mul(glyphExtent).add(glyphOffset);
  const c = cos(angle);
  const s = sin(angle);
  const rx = local.x.mul(c).sub(local.y.mul(s));
  const ry = local.x.mul(s).add(local.y.mul(c));

  const sizePx = TSL.clamp(
    size.mul(text.sizeScale),
    text.sizeMinPixels,
    text.sizeMaxPixels,
  );
  // SAME hard vertex-stage collapse gates as the colour material: an out-of-window
  // OR out-of-filter-range label collapses to zero-area quads (dies at assembly,
  // no fragment cost) so it never rasterises → is never pickable, matching the eye.
  let visible = timeFilterVisibleNode(mode, time, start, end);
  if (filterU && filterValue) {
    visible = visible.mul(dataFilterVisibleNode(filterU, filterValue));
  }
  const scale = sizePx.mul(visible);

  const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(center, 1)));
  const offX = rx.mul(scale).mul(float(2)).div(text.viewport.x).mul(clip.w);
  const offY = ry.mul(scale).mul(float(2)).div(text.viewport.y).mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(offX),
    clip.y.add(offY),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: flat per-instance id colour, opaque wherever the label is drawn
  // AND on-time AND in-range. The soft time / filter fades are `select()` / mix()
  // graphs recomputed here from VARIED raw inputs (never a varying-wrapped
  // select), then thresholded to a hard 0/1 alpha so a barely-faded label doesn't
  // register a partial-alpha id.
  material.colorNode = varying(idColor);
  const cutoff = opts.alphaCutoff ?? 0.05;
  let onGate: TSLNode = timeFilterAlphaNode(
    mode,
    time,
    varying(start),
    varying(end),
  ).greaterThan(float(cutoff));
  if (filterU && filterValue) {
    onGate = onGate.and(
      dataFilterAlphaNode(filterU, varying(filterValue)).greaterThan(
        float(cutoff),
      ),
    );
  }
  material.opacityNode = select(onGate, float(1), float(0));

  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.alphaTest = 0.5;

  return { material, time, text, mode, filter: filterU };
}
