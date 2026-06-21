// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * SplatPrimitiveLayer — the GPU primitive behind {@link SplatLayer}. One
 * instance = one **oriented anisotropic Gaussian surfel**: a flat elliptical
 * disk lying in its local surface frame, rendered with a soft radial Gaussian
 * falloff and a **soft temporal Gaussian** weight so it brightens at its sample
 * time and fades smoothly away from it.
 *
 * This is *surface splatting* (Pfister/Zwicker surfels, Zwicker "EWA Surface
 * Splatting"), not the screen-space volumetric Gaussian of 3DGS — the right
 * formalism when the primitives come from a surface scan (LIDAR k-NN covariance,
 * baked by `waymo_extract.py --surfel`) rather than a volumetric optimisation.
 * Because surfels are opaque-ish patches lying ON surfaces, we render them
 * **depth-tested with depth-write ON** and an alpha cutoff: the z-buffer gives
 * correct occlusion for free, so there is NO per-frame back-to-front sort (the
 * hard part of volumetric 3DGS). Soft rims below `alphaCutoff` are discarded so
 * they never write depth (no halo); the confident disk core does.
 *
 * ── INSTANCE GEOMETRY (object-space, not screen-space) ───────────────────────
 * Each instance is a hexagon (circumscribing the unit disk, ~13% less rasterised
 * area than a quad — see {@link HEX_CORNERS}) expanded in the surfel's tangent
 * plane:
 *   • `getQuaternion` (qx,qy,qz,qw) → a rotation matrix whose COLUMNS are the
 *     surfel's [tangent | bitangent | normal] in the render ENU frame (east,
 *     north, up — metres). The quad's `(u,v) ∈ [-1,1]²` corner is placed at
 *     `u·s_major·tangent + v·s_minor·bitangent` metres from the centre, so the
 *     disk is a true oriented ellipse in 3-space (it foreshortens correctly
 *     under the tilted cockpit camera — a billboard never would).
 *   • `getScale` (s_major,s_minor) are the in-plane ellipse half-extents in
 *     metres (the two larger eigen-extents of the local covariance), × the
 *     layer `sizeScale`.
 *   • the metre offset is mapped to deck common space via `project_size` and
 *     added to the projected centre — the standard deck world-offset idiom, so
 *     it composes with web-mercator (MapView; GlobeView is out of scope).
 *
 * ── SOFT TEMPORAL GAUSSIAN (the 4D term) ─────────────────────────────────────
 * Each surfel carries a sample time `μ_t` (`getStartTime`, RELATIVE to the
 * layer `timeOffset`, exactly like {@link TimeFilterExtension}). At play time
 * `t` its opacity is multiplied by `exp(-½·((t-μ_t)/σ)²)` with `σ =
 * temporalSigma`. This is the Spacetime-Gaussians temporal-opacity term: a
 * surfel is brightest at its sweep time and fades smoothly within ±~3σ, so the
 * cloud *evolves* as the playhead moves instead of hard-popping on a window
 * edge. Past 3σ the instance is collapsed to a degenerate clip position (zero
 * fragments), so off-time surfels cost nothing. The same f32-precision
 * discipline as TimeFilterExtension applies: both `t` and `μ_t` are relative to
 * `timeOffset`, so the subtraction is f32-exact.
 *
 * PICKING / SHADER HOOKS: like {@link FlowLinesLayer} this is a fully custom-
 * `Model` layer, so it calls the `picking` module functions DIRECTLY rather
 * than via deck's process-wide `DECKGL_FILTER_*` hooks (bundler-agnostic — see
 * the FlowLinesLayer docstring). The temporal Gaussian is therefore baked into
 * this shader rather than ridden in through TimeFilterExtension.
 */

import { Layer, project32, picking } from '@deck.gl/core';
import type {
  Color,
  DefaultProps,
  LayerProps,
  LayerDataSource,
  Accessor,
  UpdateParameters,
} from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';

/**
 * Disk envelope as a flat-top HEXAGON whose **inscribed circle is the unit
 * disk** (incircle radius 1 ⇒ circumradius 2/√3 ≈ 1.1547). `(u,v)` doubles as
 * the radial coordinate for the fragment Gaussian — `r² = u²+v²`, 0 at the disk
 * centre, 1 at the rim. Every fragment the disk actually paints (`r ≤ 1`) lies
 * inside the hexagon, so the visible result is pixel-identical to a quad — but
 * the rasterised envelope is `2√3 ≈ 3.46` vs the quad's `4`, i.e. **~13 % fewer
 * fragments enter the shader**, all of them previously-discarded `r² > 1`
 * corners. Pure overdraw win, zero fidelity cost.
 *
 * Vertices in triangle-strip order `0,1,5,2,4,3` (the standard zig-zag
 * triangulation of a convex hexagon → 4 triangles, 6 vertices).
 */
const HEX_R = 2 / Math.sqrt(3); // ≈1.1547 — circumradius for incircle = 1
const HEX_H = HEX_R / 2;        // R·cos60° = R/2 ≈ 0.5774
// flat-top hexagon corners at 0,60,…,300°, emitted in strip order 0,1,5,2,4,3.
// prettier-ignore
const HEX_CORNERS = [
   HEX_R,  0,      // v0  ( 1.1547,  0)
   HEX_H,  1,      // v1  ( 0.5774,  1)
   HEX_H, -1,      // v5  ( 0.5774, -1)
  -HEX_H,  1,      // v2  (-0.5774,  1)
  -HEX_H, -1,      // v4  (-0.5774, -1)
  -HEX_R,  0,      // v3  (-1.1547,  0)
];

/** std140 block: scalars only (each f32 is 4-byte aligned; std140-safe). */
const uniformBlock = /* glsl */ `\
layout(std140) uniform splatUniforms {
  float currentTime;     // play time RELATIVE to the layer timeOffset
  float temporalSigma;   // ms; soft temporal Gaussian width (static / non-cumulative)
  float sizeScale;       // multiplier on the baked surfel extents
  float falloff;         // radial Gaussian tightness (alpha *= exp(-falloff·r²))
  float alphaCutoff;     // discard fragments below this final alpha
  float cumulative;      // >0.5 ⇒ Worldbuild accreted reveal for STATIC surfels
  float revealFade;      // ms; reveal alpha ramp 0→1 for cumulative statics (0 ⇒ instant)
  float temporalSigmaDynamic; // ms; soft temporal Gaussian width for DYNAMIC surfels
  float elevationScale;  // multiplier on the raw instanceElevations (z metres)
  float useVertexColor;  // >0.5 ⇒ use instanceColors, else the fallback*  RGBA
  float fallbackR;       // fallback colour (0–1), used when useVertexColor < 0.5
  float fallbackG;
  float fallbackB;
  float fallbackA;
} splat;
`;

type SplatUniforms = {
  currentTime: number;
  temporalSigma: number;
  sizeScale: number;
  falloff: number;
  alphaCutoff: number;
  cumulative: number;
  revealFade: number;
  temporalSigmaDynamic: number;
  elevationScale: number;
  useVertexColor: number;
  fallbackR: number;
  fallbackG: number;
  fallbackB: number;
  fallbackA: number;
};

const splatUniforms = {
  name: 'splat',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    currentTime: 'f32',
    temporalSigma: 'f32',
    sizeScale: 'f32',
    falloff: 'f32',
    alphaCutoff: 'f32',
    cumulative: 'f32',
    revealFade: 'f32',
    temporalSigmaDynamic: 'f32',
    elevationScale: 'f32',
    useVertexColor: 'f32',
    fallbackR: 'f32',
    fallbackG: 'f32',
    fallbackB: 'f32',
    fallbackA: 'f32',
  },
} as const;

const vs = /* glsl */ `\
#version 300 es
#define SHADER_NAME splat-primitive-layer-vertex-shader

in vec2 positions;                 // hexagon corner (u,v); disk rim at r=1
in vec2 instancePositions;         // surfel centre [lng, lat] (2D; zero-copy geometry)
in vec2 instancePositions64Low;
in float instanceElevations;       // surfel altitude (m, raw); ×elevationScale here
in vec4 instanceQuaternions;       // surface frame [tangent|bitangent|normal]
in vec2 instanceScales;            // in-plane half-extents (m): [s_major, s_minor]
in vec4 instanceColors;            // rgba (0–1, unorm8); a = baked surfel confidence
in float instanceStartTimes;       // sample time μ_t (relative to timeOffset)
in float instanceIsDynamic;        // 1 ⇒ moving actor (motion smear); 0 ⇒ static world
in vec3 instancePickingColors;

out vec2 vUv;
out vec4 vColor;

// Quaternion → rotation matrix. Columns are the rotated basis vectors, so
// mat[0]=tangent, mat[1]=bitangent, mat[2]=normal (the build side packs them
// that way). q assumed unit-length (baked normalised).
mat3 quatToMat3(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  float x2 = x + x, y2 = y + y, z2 = z + z;
  float xx = x * x2, xy = x * y2, xz = x * z2;
  float yy = y * y2, yz = y * z2, zz = z * z2;
  float wx = w * x2, wy = w * y2, wz = w * z2;
  return mat3(
    1.0 - (yy + zz), xy + wz,        xz - wy,        // column 0: tangent
    xy - wz,         1.0 - (xx + zz), yz + wx,        // column 1: bitangent
    xz + wy,         yz - wx,         1.0 - (xx + yy) // column 2: normal
  );
}

void main(void) {
  // Reassemble the 3D centre from the 2D geometry + the raw elevation column
  // (both bound zero-copy; z is scaled here instead of on the CPU).
  vec3 center3 = vec3(instancePositions, instanceElevations * splat.elevationScale);
  vec3 center3Low = vec3(instancePositions64Low, 0.0);
  geometry.worldPosition = center3;
  geometry.pickingColor = instancePickingColors;
  picking_setPickingColor(geometry.pickingColor);

  // ── TEMPORAL WEIGHT (evaluated FIRST so off-time instances are culled before
  // the quaternion→matrix and double-precision centre projection below) ───────
  // Two regimes:
  //   • WORLDBUILD ACCRETED REVEAL — when cumulative is set AND this is a
  //     STATIC surfel (isDynamic < 0.5): the surfel APPEARS at its first-seen
  //     time μ_t and PERSISTS forever after (no symmetric collapse), so the
  //     static world "builds itself" as the playhead advances. revealFade,
  //     if >0, ramps its alpha 0→1 over that many ms after it appears; before
  //     μ_t it is hidden (age < 0).
  //   • SYMMETRIC GAUSSIAN — every other case (non-cumulative, OR a DYNAMIC
  //     surfel even under cumulative): the existing brightest-at-μ_t,
  //     fade-within-±~3σ term, using σ = temporalSigma for statics and
  //     temporalSigmaDynamic for dynamics. Moving actors therefore read as
  //     ghosted smears threading through the solid static world.
  // Backward-compat: cumulative=0 ⇒ the symmetric branch with σ=temporalSigma,
  // i.e. behaviour identical to the pre-Worldbuild shader.
  float age = splat.currentTime - instanceStartTimes;
  float timeWeight;
  if (splat.cumulative > 0.5 && instanceIsDynamic < 0.5) {
    if (age < 0.0) {                   // not yet first-seen — hidden
      gl_Position = vec4(0.0);
      vColor = vec4(0.0);
      vUv = vec2(0.0);
      return;
    }
    timeWeight = splat.revealFade > 0.0
      ? clamp(age / splat.revealFade, 0.0, 1.0)
      : 1.0;
  } else {
    float sigma = mix(splat.temporalSigma, splat.temporalSigmaDynamic, instanceIsDynamic);
    float dt = age / max(sigma, 1.0);
    timeWeight = exp(-0.5 * dt * dt);
    if (timeWeight < 0.0111) {         // beyond ~3σ — fully faded
      gl_Position = vec4(0.0);         // w=0 ⇒ clipped, no fragments
      vColor = vec4(0.0);
      vUv = vec2(0.0);
      return;
    }
  }

  // Project the surfel centre, keeping the common-space position so the
  // tangent-plane offset can be added there (the deck world-offset idiom).
  vec4 centerCommon;
  project_position_to_clipspace(center3, center3Low, vec3(0.0), centerCommon);

  mat3 frame = quatToMat3(instanceQuaternions);
  vec3 tangent = frame[0];
  vec3 bitangent = frame[1];

  // Quad corner → metre offset in the surfel's tangent plane → common space.
  vec2 uv = positions;
  vec3 offsetMeters =
      uv.x * instanceScales.x * splat.sizeScale * tangent
    + uv.y * instanceScales.y * splat.sizeScale * bitangent;
  vec3 offsetCommon = project_size(offsetMeters);

  vec4 posCommon = centerCommon;
  posCommon.xyz += offsetCommon;
  geometry.position = posCommon;
  gl_Position = project_common_position_to_clipspace(posCommon);

  vUv = uv;
  // Per-surfel camera colour (instanceColors) or the constant fallback. The
  // alpha carries the baked surfel confidence, modulated by layer opacity and
  // the temporal Gaussian.
  vec3 rgb = mix(vec3(splat.fallbackR, splat.fallbackG, splat.fallbackB),
                 instanceColors.rgb, step(0.5, splat.useVertexColor));
  float baseA = mix(splat.fallbackA, instanceColors.a, step(0.5, splat.useVertexColor));
  vColor = vec4(rgb, baseA * layer.opacity * timeWeight);
}
`;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME splat-primitive-layer-fragment-shader
precision highp float;

in vec2 vUv;
in vec4 vColor;
out vec4 fragColor;

void main(void) {
  // Inscribe the elliptical Gaussian in the quad: r² ∈ [0,1] over the disk.
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;                       // outside the disk
  float g = exp(-splat.falloff * r2);          // soft radial falloff
  float a = vColor.a * g;
  if (a < splat.alphaCutoff) discard;          // faint rims write no depth (no halo)
  fragColor = vec4(vColor.rgb, a);
  fragColor = picking_filterHighlightColor(fragColor);
  fragColor = picking_filterPickingColor(fragColor);
}
`;

/** Complete props for {@link SplatPrimitiveLayer}. */
export type SplatPrimitiveLayerProps<DataT = unknown> = _SplatPrimitiveLayerProps<DataT> &
  LayerProps;

/** Props added by {@link SplatPrimitiveLayer}. */
type _SplatPrimitiveLayerProps<DataT> = {
  data: LayerDataSource<DataT>;
  /** Surfel centre `[lng, lat]` (2D — altitude rides {@link getElevation}). */
  getPosition?: Accessor<DataT, [number, number]>;
  /** Surfel altitude (metres, raw); multiplied by {@link elevationScale} in the shader. */
  getElevation?: Accessor<DataT, number>;
  /**
   * Surface-frame quaternion `[qx,qy,qz,qw]` whose rotation-matrix columns are
   * the surfel's `[tangent|bitangent|normal]`.
   */
  getQuaternion?: Accessor<DataT, [number, number, number, number]>;
  /** In-plane half-extents `[s_major, s_minor]` in metres. */
  getScale?: Accessor<DataT, [number, number]>;
  /** Per-surfel RGBA (`a` = baked confidence). */
  getColor?: Accessor<DataT, Color>;
  /** Multiplier on the raw {@link getElevation} value. @default 1 */
  elevationScale?: number;
  /**
   * When false, every surfel uses {@link fallbackColor} instead of the per-surfel
   * `getColor` attribute (e.g. a colourless cloud). @default true
   */
  useVertexColor?: boolean;
  /** Constant RGBA (0–255) used when {@link useVertexColor} is false. */
  fallbackColor?: Color;
  /** Sample time `μ_t`, RELATIVE to {@link timeOffset}. */
  getStartTime?: Accessor<DataT, number>;
  /**
   * Per-surfel Worldbuild static/dynamic flag: `1` ⇒ a moving actor (gets the
   * symmetric motion-smear Gaussian even under {@link cumulative}); `0` ⇒ static
   * world. Absent ⇒ all static. @default 0
   */
  getIsDynamic?: Accessor<DataT, number>;

  /** Dynamic play-time getter (called every `draw`, so the layer stays cached). */
  getTime?: (() => number) | null;
  /** Layer time offset; the same value used to relativise `getStartTime`. */
  timeOffset?: number;
  /** Soft temporal Gaussian width for STATIC surfels (ms). @default 180 */
  temporalSigma?: number;
  /**
   * Worldbuild accreted reconstruction: when true, STATIC surfels
   * (`instanceIsDynamic < 0.5`) APPEAR at their `getStartTime` (the voxel's
   * first-seen time) and PERSIST forever after — the world builds itself as the
   * playhead advances — while DYNAMIC surfels keep the symmetric windowed
   * Gaussian (using {@link temporalSigmaDynamic}). When false the layer is the
   * plain symmetric-Gaussian splat (a single {@link temporalSigma}). @default false
   */
  cumulative?: boolean;
  /**
   * Reveal alpha-ramp duration (ms) for a STATIC surfel once it appears under
   * {@link cumulative} (`timeWeight = clamp(age / revealFade, 0, 1)`). `0` ⇒ it
   * pops to full alpha instantly. Ignored when `cumulative` is false. @default 0
   */
  revealFade?: number;
  /**
   * Soft temporal Gaussian width for DYNAMIC surfels (ms). Moving actors read as
   * ghosted motion smears at this width even under {@link cumulative}. `0`/unset
   * ⇒ falls back to {@link temporalSigma}. @default 0
   */
  temporalSigmaDynamic?: number;
  /** Multiplier on the baked surfel extents. @default 1 */
  sizeScale?: number;
  /** Radial Gaussian tightness (`alpha *= exp(-falloff·r²)`). @default 3 */
  falloff?: number;
  /** Discard fragments below this final alpha (keeps depth-write clean). @default 0.04 */
  alphaCutoff?: number;
};

const defaultProps: DefaultProps<SplatPrimitiveLayerProps> = {
  getPosition: { type: 'accessor', value: (d: any) => d.position },
  getElevation: { type: 'accessor', value: 0 },
  getQuaternion: { type: 'accessor', value: [0, 0, 0, 1] },
  getScale: { type: 'accessor', value: [1, 1] },
  getColor: { type: 'accessor', value: [255, 255, 255, 255] },
  elevationScale: { type: 'number', value: 1 },
  useVertexColor: { type: 'boolean', value: true },
  fallbackColor: { type: 'color', value: [200, 205, 215, 255] },
  getStartTime: { type: 'accessor', value: 0 },
  getIsDynamic: { type: 'accessor', value: 0 },
  getTime: { type: 'function', value: null, optional: true },
  timeOffset: { type: 'number', value: 0 },
  temporalSigma: { type: 'number', value: 180, min: 1 },
  cumulative: { type: 'boolean', value: false },
  revealFade: { type: 'number', value: 0, min: 0 },
  temporalSigmaDynamic: { type: 'number', value: 0, min: 0 },
  sizeScale: { type: 'number', value: 1, min: 0 },
  falloff: { type: 'number', value: 3, min: 0 },
  alphaCutoff: { type: 'number', value: 0.04, min: 0 },
};

/**
 * Instanced oriented-Gaussian-surfel layer. See the file docstring for the
 * geometry, the depth-tested (sort-free) blending, and the soft temporal term.
 */
export class SplatPrimitiveLayer<DataT = any, ExtraProps extends {} = {}> extends Layer<
  ExtraProps & Required<_SplatPrimitiveLayerProps<DataT>>
> {
  static layerName = 'SplatPrimitiveLayer';
  static defaultProps = defaultProps;

  declare state: {
    model?: Model;
  };

  getShaders() {
    return super.getShaders({ vs, fs, modules: [project32, picking, splatUniforms] });
  }

  getBounds(): [number[], number[]] | null {
    return this.getAttributeManager()?.getBounds(['instancePositions']) ?? null;
  }

  // Surfels are local metre-scale patches — never antimeridian-wrapped.
  get wrapLongitude(): boolean {
    return false;
  }

  initializeState(): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.addInstanced({
      instancePositions: {
        size: 2,
        type: 'float64',
        fp64: this.use64bitPositions(),
        transition: false,
        accessor: 'getPosition',
      },
      // Altitude rides its own zero-copy column (the tile geometry is 2D); the
      // shader recombines `xy` + `z·elevationScale` so positions stay zero-copy.
      instanceElevations: {
        size: 1,
        type: 'float32',
        accessor: 'getElevation',
        defaultValue: 0,
      },
      instanceQuaternions: {
        size: 4,
        type: 'float32',
        accessor: 'getQuaternion',
        defaultValue: [0, 0, 0, 1],
      },
      instanceScales: {
        size: 2,
        accessor: 'getScale',
        defaultValue: [1, 1],
      },
      instanceColors: {
        size: 4,
        type: 'unorm8',
        accessor: 'getColor',
        defaultValue: [255, 255, 255, 255],
      },
      instanceStartTimes: {
        size: 1,
        type: 'float32',
        accessor: 'getStartTime',
        defaultValue: 0,
      },
      // Worldbuild static/dynamic flag (0 static, 1 dynamic). Sourced from the
      // tile's `is_dynamic` numeric column; existing surfel tiles have no such
      // column, so the default 0 makes every surfel static (= legacy behaviour).
      instanceIsDynamic: {
        size: 1,
        type: 'float32',
        accessor: 'getIsDynamic',
        defaultValue: 0,
      },
    });
  }

  updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    if (params.changeFlags.extensionsChanged) {
      this.state.model?.destroy();
      this.state.model = this._getModel();
      this.getAttributeManager()!.invalidateAll();
    }
  }

  draw(): void {
    const model = this.state.model;
    if (!model) return;
    const { getTime, currentTime = 0, timeOffset = 0 } = this.props as unknown as {
      getTime?: (() => number) | null;
      currentTime?: number;
      timeOffset?: number;
    };
    const resolved = typeof getTime === 'function' ? getTime() : currentTime;
    // Relativise like TimeFilterExtension: both `currentTime` and the per-surfel
    // `instanceStartTimes` are offsets from `timeOffset`, so the subtraction is
    // f32-exact even though absolute epoch-ms are not.
    // Dynamic surfels smear at temporalSigmaDynamic; 0/unset ⇒ reuse temporalSigma
    // so a bundle that only sets temporalSigma behaves uniformly.
    const sigmaDynamic =
      this.props.temporalSigmaDynamic > 0
        ? this.props.temporalSigmaDynamic
        : this.props.temporalSigma;
    const fb = (this.props.fallbackColor ?? [200, 205, 215, 255]) as Color;
    const splatProps: SplatUniforms = {
      currentTime: resolved - timeOffset,
      temporalSigma: this.props.temporalSigma,
      sizeScale: this.props.sizeScale,
      falloff: this.props.falloff,
      alphaCutoff: this.props.alphaCutoff,
      cumulative: this.props.cumulative ? 1 : 0,
      revealFade: this.props.revealFade,
      temporalSigmaDynamic: sigmaDynamic,
      elevationScale: this.props.elevationScale ?? 1,
      useVertexColor: this.props.useVertexColor === false ? 0 : 1,
      fallbackR: (fb[0] ?? 200) / 255,
      fallbackG: (fb[1] ?? 205) / 255,
      fallbackB: (fb[2] ?? 215) / 255,
      fallbackA: (fb[3] ?? 255) / 255,
    };
    model.shaderInputs.setProps({ splat: splatProps });
    model.draw(this.context.renderPass);
  }

  protected _getModel(): Model {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-strip',
        attributes: {
          positions: { size: 2, value: new Float32Array(HEX_CORNERS) },
        },
      }),
      isInstanced: true,
      // Surface splatting: depth-test + depth-WRITE on (z-buffer gives correct
      // occlusion with NO sort), standard src-over alpha blend, two-sided disks.
      parameters: {
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
        cullMode: 'none',
        blend: true,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'src-alpha',
        blendColorDstFactor: 'one-minus-src-alpha',
        blendAlphaOperation: 'add',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one-minus-src-alpha',
      },
    });
  }
}
