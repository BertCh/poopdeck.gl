// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `IconMaterial` — directional billboard markers, the Three port of deck's
 * `AnimatedIconLayer`. Each instance is a camera-facing quad (built in
 * `vertexNode` like {@link createPointMaterial}) BUT sized in **screen pixels**
 * (deck `STTIconLayer`'s default `sizeUnits: 'pixels'`), rotated by a per-instance
 * heading attribute, and textured from a shared icon-atlas {@link Texture} via a
 * per-instance UV sub-rectangle. The shared {@link timeFilterAlphaNode} gives the
 * same window / cumulative / wake animation as deck — `wake` mode adds a trailing
 * comet tail whose alpha fades AND whose quad size tapers toward the tail (via
 * {@link wakeSizeScaleNode} in the vertex stage), the icon analogue of the point
 * layer's ship-wake.
 *
 * VERTEX: the instance centre goes to clip space (`MVP · center`); the quad corner
 * (`[-1,1]²`) is rotated by `angle` (radians, CCW from up) and the optional anchor
 * offset, scaled to `sizePx/2` and converted to a clip offset via `2/viewport · w`
 * so the marker is a constant pixel size on screen at any depth (the same
 * pixel→clip conversion as {@link createWideLineMaterial}). `sizePx` is clamped to
 * `[sizeMinPixels, sizeMaxPixels]` and multiplied by the hard
 * {@link timeFilterVisibleNode} gate — an out-of-window instance collapses to a
 * zero-area quad in the vertex stage (dies at assembly, no fragment cost) instead
 * of relying on an alpha-cutoff fragment discard (deck.gl #7509).
 *
 * FRAGMENT: the rotated corner maps to the instance's atlas UV rect and samples
 * the atlas. For a `mask` icon the sampled alpha modulates the per-instance tint
 * (the tint REPLACES the sprite colour); for an opaque icon the sampled RGB is
 * modulated by the tint. The time alpha (a `select()`) is recomputed in the
 * FRAGMENT stage from VARIED raw `start`/`end` — never wrapped in a `varying()`
 * (the codebase's recurring WGSL crash; `mix()`/`step()` ARE varying-safe).
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
  modelViewMatrix,
  cameraProjectionMatrix,
  type UniformNode,
  type TSLNode,
} from './nodes.js';
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  timeFilterVisibleNode,
  wakeSizeScaleNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterMode, TimeFilterParams } from './time-filter-math.js';
import { glideSampleNode, GlideUniforms } from './motion-glide.js';
import { PaletteUniforms, paletteColorNode } from './palette.js';
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

/** Icon time-filter modes. deck `AnimatedIconLayer` is window-only; `cumulative`
 *  adds the "leave a marker trail" worldbuild look, and `wake` gives each marker a
 *  trailing comet tail (alpha fade + size taper toward the tail — the icon analogue
 *  of the point layer's ship-wake scan). `trail` is per-vertex (trips) so it stays
 *  out of the per-instance icon path. */
export type IconMode = Extract<
  TimeFilterMode,
  'window' | 'wake' | 'cumulative' | 'none'
>;

/** Live icon uniforms: pixel-size clamp, opacity, and the canvas size in px. */
export class IconUniforms {
  readonly opacity: UniformNode = uniform(1);
  /** Global multiplier on every instance's pixel size (deck `sizeScale`). */
  readonly sizeScale: UniformNode = uniform(1);
  readonly sizeMinPixels: UniformNode = uniform(0);
  readonly sizeMaxPixels: UniformNode = uniform(1e9);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
}

export interface IconMaterialOptions {
  /** Time-filter mode: window (raw), cumulative (markers persist), none. */
  mode: IconMode;
  /** The icon-atlas texture (host provides the loaded atlas image). */
  atlas: Texture;
  /**
   * `mask: true` icons are single-channel silhouettes — the sampled ALPHA gates
   * the per-instance tint (which supplies the colour). `false` icons are opaque
   * sprites whose sampled RGB is modulated by the tint. @default false
   */
  mask?: boolean;
  /** Discard fragments below this final alpha. @default 0.05 */
  alphaCutoff?: number;
  /**
   * Motion-glide (motionInterpolation). When set, BOTH the instance centre AND
   * its heading are read from the per-track keyframe texture (RGB = position,
   * A = heading in radians) and interpolated in the vertex stage from the shared
   * `currentTime` uniform — replacing the static `sttCenter` / `sttAngle`
   * attributes — so a directional marker GLIDES and turns smoothly between its
   * samples instead of popping. Off (undefined) leaves the static icon path
   * BYTE-IDENTICAL. The layer bakes the texture + `sttGlide*` locator attributes
   * via `assembleKeyframes({ withHeading: true, angleUnit: 'deg' })`.
   */
  glide?: { texture: Texture };
  /**
   * Install the GPU column filter (deck `DataFilterExtension`): binds a
   * per-instance `sttFilterValue` attribute and gates each marker by
   * `filterRange`/`filterSoftRange` — an out-of-range marker's quad collapses to
   * zero area in the VERTEX stage (alongside the time-window / wake collapse
   * gates), and a `filterSoftRange` fades it in the fragment `opacityNode`.
   * Composes with `glide`/`wake`/`colorPalette`. Off (undefined) leaves the icon
   * path BYTE-IDENTICAL. @default false
   */
  dataFilter?: boolean;
  /**
   * GPU stable categorical tint (deck `CategoryColorExtension`): when set, the
   * per-instance `sttColor` tint is REPLACED by a palette-texture sample indexed
   * by the per-instance `sttCategoryIndex` slot, so a vessel/aircraft category
   * tints the same colour in every tile and recolouring is a uniform/texture
   * swap. Composes with `glide` (position/heading ride a SEPARATE texture). Off
   * (undefined) leaves the constant/per-instance tint path BYTE-IDENTICAL.
   * @default undefined
   */
  colorPalette?: { texture: Texture };
}

export interface IconMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  icon: IconUniforms;
  mode: IconMode;
  /** Glide uniforms (`invTexWidth`) when the material was built with `glide`. */
  glide: GlideUniforms | null;
  /** Filter uniforms (`filterMin`…) when the material was built with `dataFilter`. */
  filter: DataFilterUniforms | null;
  /** Palette uniforms (`invWidth`) when the material was built with `colorPalette`. */
  palette: PaletteUniforms | null;
}

export function createIconMaterial(
  opts: IconMaterialOptions,
): IconMaterialBundle {
  const time = new TimeFilterUniforms();
  const icon = new IconUniforms();

  // ── per-instance attributes (set by the layer) ──────────────────────────────
  // Glide (motionInterpolation): centre + heading both glide from the keyframe
  // texture (RGB = position, A = heading rad); otherwise they're static attrs.
  const glideU = opts.glide ? new GlideUniforms() : null;
  const glideSample = glideU
    ? glideSampleNode(opts.glide!.texture, time.currentTime, glideU)
    : null;
  const center = glideSample ? glideSample.xyz : attribute('sttCenter', 'vec3');
  // Tint: GPU stable-palette sample (per-instance `sttCategoryIndex` slot) when a
  // palette texture is installed; otherwise the per-instance `sttColor` attr.
  const paletteU = opts.colorPalette ? new PaletteUniforms() : null;
  const color = paletteU
    ? paletteColorNode(opts.colorPalette!.texture, paletteU)
    : attribute('sttColor', 'vec4');
  const angle = glideSample ? glideSample.w : attribute('sttAngle', 'float'); // radians, CCW from up
  const size = attribute('sttSize', 'float'); // on-screen pixels (full height)
  const uvRect = attribute('sttUvRect', 'vec4'); // [u0,v0,u1,v1]
  const anchor = attribute('sttAnchor', 'vec2'); // [-1,1] quad-space offset
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  // DataFilter: per-instance filter column (bound only when installed).
  const filterU = opts.dataFilter ? new DataFilterUniforms() : null;
  const filterValue = filterU ? attribute('sttFilterValue', 'float') : null;
  const corner = positionGeometry.xy; // [-1,1]²

  // ── VERTEX: rotate the corner, size in pixels, expand in clip space ──────────
  // Apply the anchor offset first (in unrotated quad space), then rotate the whole
  // quad by `angle` so the anchor rides with the rotation (deck rotates about the
  // anchor). Rotation is CCW from up: a heading of 0 keeps the icon's up axis up.
  const c = cos(angle);
  const s = sin(angle);
  const local = corner.add(anchor); // [-1,1] offset by anchor
  const rx = local.x.mul(c).sub(local.y.mul(s));
  const ry = local.x.mul(s).add(local.y.mul(c));

  const sizePx = TSL.clamp(
    size.mul(icon.sizeScale),
    icon.sizeMinPixels,
    icon.sizeMaxPixels,
  );
  // HARD vertex-stage collapse: an out-of-window OR out-of-filter-range instance
  // gets half = 0, so the quad corners coincide at the centre (zero area → no
  // fragment cost; deck.gl #7509). The two gates multiply, so either one collapses
  // the marker; not filtered ⇒ the filter gate is 1 (byte-identical). The soft-band
  // time / filter fades stay in the fragment `opacityNode` below.
  let visible = timeFilterVisibleNode(opts.mode, time, start, end);
  if (filterU && filterValue) {
    visible = visible.mul(dataFilterVisibleNode(filterU, filterValue));
  }
  let half = sizePx.mul(0.5).mul(visible);
  // Wake tail SIZE taper (mirrors createPointMaterial): in wake mode the
  // vertex-stage time alpha — a `select()`, used DIRECTLY here, never wrapped in a
  // `varying()` (the recurring WGSL crash) — drives `wakeSizeScaleNode`, shrinking
  // the tail toward `wakeTailScale` while the head stays full size. Only wake
  // touches the size node, so the window / cumulative / none / glide path stays
  // BYTE-IDENTICAL. The complementary tail alpha fade is the mode's `wakeAlphaNode`,
  // already applied to `opacityNode` below via `timeFilterAlphaNode(opts.mode, …)`.
  if (opts.mode === 'wake') {
    const vertexAlpha = timeFilterAlphaNode(opts.mode, time, start, end);
    half = half.mul(wakeSizeScaleNode(time, vertexAlpha));
  }

  const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(center, 1)));
  // pixel half-offset (corner·half px) → NDC (×2/viewport) → clip (×w).
  const offX = rx.mul(half).mul(float(2)).div(icon.viewport.x).mul(clip.w);
  const offY = ry.mul(half).mul(float(2)).div(icon.viewport.y).mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(offX),
    clip.y.add(offY),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: atlas sample (rotated UV) × tint × time alpha ──────────────────
  // The UNROTATED corner [-1,1]² maps to the atlas rect — the GEOMETRY was rotated
  // in clip space above, so the sprite stays upright in atlas space and rotates on
  // screen. corner∈[-1,1] → t∈[0,1]: u = mix(u0,u1, (x+1)/2); atlas v origin is the
  // top, quad +y is up, so v = mix(v0,v1, (1-y)/2) (top row ↔ +y).
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

  const fragAlpha = timeFilterAlphaNode(opts.mode, time, vStart, vEnd);

  // mask: tint supplies colour, atlas alpha gates it. opaque: atlas RGB × tint.
  const rgb = opts.mask ? vColor.xyz : tex.xyz.mul(vColor.xyz);
  const baseA = opts.mask ? tex.a.mul(vColor.a) : tex.a.mul(vColor.a);
  let a = baseA.mul(icon.opacity).mul(fragAlpha);
  // Soft column-filter fade (vary the raw value; the alpha node is a mix()/step()
  // graph, never a select(), so it is varying-safe — like the time fade above).
  if (filterU && filterValue) {
    a = a.mul(dataFilterAlphaNode(filterU, varying(filterValue)));
  }

  material.colorNode = rgb;
  material.opacityNode = a;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.05;

  return {
    material,
    time,
    icon,
    mode: opts.mode,
    glide: glideU,
    filter: filterU,
    palette: paletteU,
  };
}

export interface IconUniformValues {
  relativeCurrentTime: number;
  /** Wake mode reads `params.wakeLength` / `params.wakeTailScale` (the latter is
   *  not on the base `TimeFilterParams`, mirroring `PointUniformValues`). */
  params?: TimeFilterParams & { wakeTailScale?: number };
  opacity?: number;
  sizeScale?: number;
  sizeMinPixels?: number;
  sizeMaxPixels?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize). */
  viewport?: [number, number];
  /** Column-filter props (no-op unless built with `dataFilter: true`). */
  dataFilter?: DataFilterOptions;
}

export function updateIconUniforms(
  bundle: IconMaterialBundle,
  v: IconUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  if (v.opacity !== undefined) bundle.icon.opacity.value = v.opacity;
  if (v.sizeScale !== undefined) bundle.icon.sizeScale.value = v.sizeScale;
  if (v.sizeMinPixels !== undefined)
    bundle.icon.sizeMinPixels.value = v.sizeMinPixels;
  if (v.sizeMaxPixels !== undefined)
    bundle.icon.sizeMaxPixels.value = v.sizeMaxPixels;
  if (v.viewport) bundle.icon.viewport.value.set(v.viewport[0], v.viewport[1]);
  if (bundle.filter) updateDataFilterUniforms(bundle.filter, v.dataFilter);
}

// ── GPU id-buffer pick material (GPU picking catalog: icon variant) ──────────────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Renders each marker's flat
// per-instance id colour (`sttIdColor`, from `buildIdColors(mergedCount)`) into the
// picker's off-screen target. It reproduces the colour material's billboard VERTEX
// stage VERBATIM (same pixel sizing + anchor rotation) and REUSES the identical
// vertex-stage collapse gates — the time-filter {@link timeFilterVisibleNode}, the
// wake tail-size taper ({@link wakeSizeScaleNode}), AND the marker
// {@link dataFilterVisibleNode} — so an out-of-window / off-filter / wake-tapered
// marker picks EXACTLY where (and only when) it is drawn. The id is written opaque
// at full intensity (never × alpha), so the decoded RGB is an exact 24-bit index;
// off-time / off-range fragments are discarded (opacity 0 + alphaTest) so they never
// win a pick. Unlike the colour material it does NOT sample the atlas — the whole
// marker quad is pickable (deck's `STTIconLayer` picks the bounding quad too). STATIC
// icon path only: the glide (motionInterpolation) path defers per-track picking (its
// provenance is empty), consistent with the point layer. Bind
// {@link updateIconUniforms} to sync its time / size / filter uniforms before the
// pass. The returned bundle is shape-compatible with {@link IconMaterialBundle}.

export interface IconIdMaterialOptions {
  /**
   * Time-filter mode — MUST match the colour material (after the reduced-motion
   * wake→window collapse) so the id quads size + collapse identically. */
  mode: IconMode;
  /**
   * Install the GPU marker filter collapse gate (mirrors the colour material's
   * `dataFilter`). @default false */
  dataFilter?: boolean;
  /**
   * Threshold on the recomputed time / filter alpha for the hard 0/1 id gate — the
   * colour material's `alphaCutoff` (so a barely-faded marker isn't pickable).
   * @default 0.05 */
  alphaCutoff?: number;
}

/**
 * Build the icon id material. `opts` mirror the colour material's gate options
 * (`mode`, `dataFilter`, `alphaCutoff`) so the pick pass matches the on-screen
 * markers; the colour-only options (`atlas`, `mask`, `glide`, `colorPalette`) are
 * ignored (the id is a flat per-instance colour, static path only).
 */
export function createIconIdMaterial(
  opts: IconIdMaterialOptions,
): IconMaterialBundle {
  const time = new TimeFilterUniforms();
  const icon = new IconUniforms();
  const mode = opts.mode;
  const filterU = opts.dataFilter ? new DataFilterUniforms() : null;

  // Per-instance attributes: the SAME billboard-shaping attributes as the colour
  // material (STATIC path — centre + heading are attributes, not the glide
  // texture), plus the flat per-instance id colour. No `sttUvRect` (the id never
  // samples the atlas — the whole marker quad is pickable).
  const center = attribute('sttCenter', 'vec3');
  const angle = attribute('sttAngle', 'float'); // radians, CCW from up
  const size = attribute('sttSize', 'float'); // on-screen pixels
  const anchor = attribute('sttAnchor', 'vec2'); // [-1,1] quad-space offset
  const idColor = attribute('sttIdColor', 'vec3');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const filterValue = filterU ? attribute('sttFilterValue', 'float') : null;
  const corner = positionGeometry.xy; // [-1,1]²

  // ── VERTEX: reproduce the colour material's billboard sizing VERBATIM ─────────
  const c = cos(angle);
  const s = sin(angle);
  const local = corner.add(anchor);
  const rx = local.x.mul(c).sub(local.y.mul(s));
  const ry = local.x.mul(s).add(local.y.mul(c));

  const sizePx = TSL.clamp(
    size.mul(icon.sizeScale),
    icon.sizeMinPixels,
    icon.sizeMaxPixels,
  );
  // SAME hard vertex-stage collapse gates as the colour material: an out-of-window
  // OR out-of-filter-range marker collapses to a zero-area quad (dies at assembly,
  // no fragment cost) so it never rasterises → is never pickable, matching the eye.
  let visible = timeFilterVisibleNode(mode, time, start, end);
  if (filterU && filterValue) {
    visible = visible.mul(dataFilterVisibleNode(filterU, filterValue));
  }
  let half = sizePx.mul(0.5).mul(visible);
  // Wake tail SIZE taper (same as the colour material): the vertex-stage time alpha
  // — a `select()`, used DIRECTLY here, never wrapped in a `varying()` — drives the
  // taper so the id quad matches the tapered marker. Only wake touches this node.
  if (mode === 'wake') {
    const vertexAlpha = timeFilterAlphaNode(mode, time, start, end);
    half = half.mul(wakeSizeScaleNode(time, vertexAlpha));
  }

  const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(center, 1)));
  const offX = rx.mul(half).mul(float(2)).div(icon.viewport.x).mul(clip.w);
  const offY = ry.mul(half).mul(float(2)).div(icon.viewport.y).mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(offX),
    clip.y.add(offY),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: flat per-instance id colour, opaque wherever the marker is drawn
  // AND on-time AND in-range. The soft time / filter fades are `select()` / mix()
  // graphs recomputed here from VARIED raw inputs (never a varying-wrapped select),
  // then thresholded to a hard 0/1 alpha so a barely-faded marker doesn't register a
  // partial-alpha id.
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

  return {
    material,
    time,
    icon,
    mode,
    glide: null,
    filter: filterU,
    palette: null,
  };
}
