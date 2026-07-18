// @poopdeck.gl/showcase
// SPDX-License-Identifier: MIT

/**
 * PainterlyExtension — relight and re-grade a class-tagged point cloud on the GPU.
 *
 * WHY THIS EXISTS. The `poopdeck-ship` cloud is baked in Blender, and Blender's
 * sampler writes `material.diffuse_color` into each point: a FLAT swatch, with no
 * shading, no fog, and no horizon light. The whole 360K-point cloud carries seven
 * distinct colours. None of the scene's lamps, volume fog, or view transform reach
 * the export. So the painterly grade cannot be baked — it has to happen here.
 *
 * The bake therefore ships STRUCTURE and this extension owns APPEARANCE:
 *
 *   bake  -> position, octahedral surface normal, class id, stable paint seed
 *   here  -> palette, lighting, fog, horizon glow, pigment jitter, point size
 *
 * All four of those per-point values ride in `point_rgba`, which under
 * `to_geoparquet.py --style-in-rgba` is NOT a colour:
 *
 *   r = class_id      g = paint_seed      b,a = octahedral unit normal
 *
 * A colour worth seven distinct values is not worth four bytes; a normal is. The
 * alternative — a `FixedSizeList<Float32,3>` normal column — measured 3.69 of
 * 8.36 compressed bytes per feature, 44% of the archive, and at 1x playback that
 * is the difference between streaming and stalling. So there is no normal column,
 * deck's `geometry.normal` is the constant [0,0,1], and this extension decodes
 * the real one itself.
 *
 * HOOK CHOICE. deck's PointCloudLayer runs `DECKGL_FILTER_COLOR` twice:
 *
 *   vertex   after lighting, with `geometry.normal` and `geometry.position` live
 *   fragment with `geometry.uv` = the point's unit disc coordinate
 *
 * We do palette + lighting + fog in the VERTEX hook (that is the only stage where
 * the surface normal exists) and only shape alpha in the FRAGMENT hook.
 *
 * COMPOSITION. deck concatenates same-hook injections in extension order, and
 * `SpatioTemporalLayer.composeExtensions` appends user extensions AFTER its
 * internal `TimeFilterExtension`. TimeFilter writes the temporal alpha in
 * `fs:DECKGL_FILTER_COLOR` (`if (vTimeAlpha <= 0.0) discard; color.a *= vTimeAlpha;`),
 * which therefore runs BEFORE our fragment code. So our fragment hook MULTIPLIES
 * alpha and never assigns it — assigning would erase the temporal fade and make
 * the cloud flash. (Our vertex hook may write `color.rgb` freely: TimeFilter
 * injects nothing into `vs:DECKGL_FILTER_COLOR`.)
 *
 * Install via the layer's top-level `extensions` prop. Do NOT pass it through
 * `_subLayerProps.pointCloud.extensions` — per deck's contract that REPLACES the
 * internal extension list, dropping TimeFilter entirely.
 */

import { LayerExtension } from '@deck.gl/core';

/** Class ids as emitted by `config/samples.json`, packed into the red channel. */
export const PC_CLASS = {
  hull: 1,
  deck: 2,
  mast: 3,
  rigging: 4,
  sail: 5,
  flag: 6,
  ocean: 7,
  foam: 8,
  other: 9,
  atmosphere: 10,
} as const;

export type Rgb = [number, number, number];

export interface PainterlyPalette {
  hull: Rgb;
  deck: Rgb;
  mast: Rgb;
  rigging: Rgb;
  sail: Rgb;
  flag: Rgb;
  ocean: Rgb;
  foam: Rgb;
  mist: Rgb;
}

export interface PainterlyOptions {
  palette: PainterlyPalette;
}

type PainterlyUniformProps = {
  fogDensity: number;
  fogR: number;
  fogG: number;
  fogB: number;
  keyX: number;
  keyY: number;
  keyZ: number;
  keyR: number;
  keyG: number;
  keyB: number;
  rimX: number;
  rimY: number;
  rimZ: number;
  rimR: number;
  rimG: number;
  rimB: number;
  rimPower: number;
  ambient: number;
  jitter: number;
  sizeScale: number;
};

export interface PainterlyExtensionProps {
  /** Fog thickness per metre of view distance. Turner dissolution. */
  painterlyFogDensity?: number;
  /** Colour the cloud dissolves into. Should match the page background. */
  painterlyFogColor?: Rgb;
  /** Direction TOWARD the cool storm key light, world space (x east, y north, z up). */
  painterlyKeyDir?: Rgb;
  painterlyKeyColor?: Rgb;
  /** Direction TOWARD the warm horizon glow. Aivazovsky. */
  painterlyRimDir?: Rgb;
  painterlyRimColor?: Rgb;
  painterlyRimPower?: number;
  painterlyAmbient?: number;
  /** Per-point multiplicative pigment variation, driven by the baked seed. */
  painterlyJitter?: number;
  painterlySizeScale?: number;
}

// std140. Scalars only: they pack identically under std140 and shared layouts, so
// there is no vec3 padding hazard to get wrong.
//
// ONE DECLARATION PER LINE. luma validates this block against `uniformTypes` by
// parsing it line-by-line; `float fogR; float fogG;` on one line is read as a
// single field and the layer fails to initialize with "Expected 20 fields, found
// 10". The field ORDER must also match `uniformTypes` exactly.
const glslUniformBlock = `\
layout(std140) uniform painterlyUniforms {
  float fogDensity;
  float fogR;
  float fogG;
  float fogB;
  float keyX;
  float keyY;
  float keyZ;
  float keyR;
  float keyG;
  float keyB;
  float rimX;
  float rimY;
  float rimZ;
  float rimR;
  float rimG;
  float rimB;
  float rimPower;
  float ambient;
  float jitter;
  float sizeScale;
} painterly;
`;

const painterlyUniforms = {
  name: 'painterly',
  vs: glslUniformBlock,
  fs: glslUniformBlock,
  uniformTypes: {
    fogDensity: 'f32',
    fogR: 'f32',
    fogG: 'f32',
    fogB: 'f32',
    keyX: 'f32',
    keyY: 'f32',
    keyZ: 'f32',
    keyR: 'f32',
    keyG: 'f32',
    keyB: 'f32',
    rimX: 'f32',
    rimY: 'f32',
    rimZ: 'f32',
    rimR: 'f32',
    rimG: 'f32',
    rimB: 'f32',
    rimPower: 'f32',
    ambient: 'f32',
    jitter: 'f32',
    sizeScale: 'f32',
  },
} as const;

const f = (v: number) => v.toFixed(5);
const vec3 = (c: Rgb) => `vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;

/**
 * Fragment-stage helper. Declared separately from the vertex helpers because a
 * function called from the fragment shader must be declared in `fs:#decl` — the
 * two stages are compiled independently, and a vertex-only definition fails with
 * "no matching overloaded function found".
 *
 * Foam and mist read as soft pigment; the ship must stay structurally articulate
 * (van de Velde), so its points keep a hard edge.
 */
const softnessGlsl = `
float painterly_softness(float cls) {
  if (cls > 9.5) return 1.0;   // atmosphere
  if (cls > 7.5) return 0.75;  // foam
  if (cls > 6.5) return 0.25;  // ocean -- a little, to knit the surface together
  return 0.0;                  // ship
}
`;

/**
 * Palette baked into the shader source rather than uploaded as a uniform array:
 * std140 pads each `vec3` in an array to 16 bytes, which is a footgun, and the
 * palette only changes when the art direction does. `getShaders()` is memoized
 * per extension instance, so this costs one shader compile.
 */
function paletteGlsl(p: PainterlyPalette): string {
  return `
// Inverse of sample_points.py's oct_encode. Two bytes per unit normal (~0.3 deg
// worst case), against 12 for a Float32 vector column — which measured 3.69 of
// 8.36 compressed B/feature, 44% of the whole archive.
vec3 painterly_octDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

vec3 painterly_baseColor(float cls) {
  if (cls < 1.5) return ${vec3(p.hull)};        // 1 hull
  if (cls < 2.5) return ${vec3(p.deck)};        // 2 deck
  if (cls < 3.5) return ${vec3(p.mast)};        // 3 mast
  if (cls < 4.5) return ${vec3(p.rigging)};     // 4 rigging
  if (cls < 5.5) return ${vec3(p.sail)};        // 5 sail
  if (cls < 6.5) return ${vec3(p.flag)};        // 6 flag
  if (cls < 7.5) return ${vec3(p.ocean)};       // 7 ocean
  if (cls < 8.5) return ${vec3(p.foam)};        // 8 foam
  if (cls < 9.5) return ${vec3(p.ocean)};       // 9 other -> read as sea
  return ${vec3(p.mist)};                       // 10 atmosphere
}

// Homer's broken strokes: rigging is a thread, foam is a paint mass, mist is a
// wide veil. Seed decorrelates neighbouring points so the cloud never looks
// like a regular sample grid.
float painterly_sizeFor(float cls, float seed) {
  float s = 1.0;
  if (cls < 1.5)      s = 1.05;  // hull
  else if (cls < 2.5) s = 1.0;   // deck
  else if (cls < 3.5) s = 1.0;   // mast
  else if (cls < 4.5) s = 0.55;  // rigging -- keep the standing rigging legible
  else if (cls < 5.5) s = 1.15;  // sail
  else if (cls < 6.5) s = 1.0;   // flag
  else if (cls < 7.5) s = 1.0;   // ocean
  else if (cls < 8.5) s = 1.9;   // foam
  else if (cls < 9.5) s = 1.0;   // other
  else                s = 4.2;   // mist veils
  return s * (0.75 + 0.5 * seed);
}

float painterly_alphaFor(float cls) {
  if (cls > 9.5) return 0.16;  // mist veils are barely there
  if (cls > 7.5) return 0.92;  // foam
  if (cls > 6.5) return 0.95;  // ocean
  return 1.0;
}
`;
}

// Defaults re-graded 2026-07 toward a Dutch storm-light key (see the ship demo's
// backdrop gradient in datasets.ts). The old grade sat too dark — a weak cool key
// over ambient 0.22 let the sea and shadowed hull sink into mud — and the horizon
// rim was a hot sunset orange that read as CG against the muted weather. This lifts
// the ambient (bright-overcast diffuse), strengthens and neutralises the sky key,
// pulls the rim to a restrained ochre light-break, and — the load-bearing change —
// matches the fog colour to the backdrop's luminous horizon band so distant rigging
// dissolves INTO the sky (Turner) rather than fading to black.
const defaultProps = {
  // A touch more density so the far masts genuinely dissolve into the horizon.
  painterlyFogDensity: { type: 'number', value: 0.007, min: 0 },
  // Warm-neutral haze matched to the backdrop's horizon band (~#242625), NOT the
  // old near-black. This is what makes ship-edge and sky read as one picture.
  painterlyFogColor: { type: 'array', value: [0.14, 0.15, 0.145] },
  // The sky IS the light source: steepen the key toward overhead, brighten and
  // neutralise it toward a cool overcast white.
  painterlyKeyDir: { type: 'array', value: [-0.3, 0.3, 0.9] },
  painterlyKeyColor: { type: 'array', value: [0.74, 0.79, 0.85] },
  // The warm horizon break (Aivazovsky / the ochre light on van de Velde's rocks),
  // aligned with the backdrop's radial break. Ochre-amber, not saturated sunset.
  painterlyRimDir: { type: 'array', value: [0.55, 0.82, 0.15] },
  painterlyRimColor: { type: 'array', value: [0.85, 0.55, 0.28] },
  painterlyRimPower: { type: 'number', value: 2.0, min: 0.1 },
  // Lift forms out of the mud — bright-overcast fill.
  painterlyAmbient: { type: 'number', value: 0.32, min: 0 },
  painterlyJitter: { type: 'number', value: 0.16, min: 0 },
  painterlySizeScale: { type: 'number', value: 1.0, min: 0 },
};

export class PainterlyExtension extends LayerExtension<PainterlyOptions> {
  static extensionName = 'PainterlyExtension';
  static defaultProps = defaultProps;

  private cachedShaders: {
    modules: unknown[];
    inject: Record<string, string>;
  } | null = null;

  constructor(options: PainterlyOptions) {
    super(options);
  }

  getShaders(this: unknown, extension: PainterlyExtension) {
    if (extension.cachedShaders) return extension.cachedShaders;

    extension.cachedShaders = {
      modules: [painterlyUniforms],
      inject: {
        // `painterly_cls` / `painterly_seed` are file-scope globals, NOT locals.
        // deck compiles each DECKGL_FILTER_* hook as a standalone function emitted
        // ABOVE the layer's own `in vec4 instanceColors;` declaration, so the hooks
        // cannot see the attribute (that is why TimeFilterExtension declares its own
        // `in float instanceStartTime;` here). Redeclaring instanceColors would
        // collide with PointCloudLayer's, so it is read once in `#main-start` --
        // which is inside main(), after the globals -- and parked here instead.
        'vs:#decl': `
          out float vPaintClass;
          out float vPaintSeed;
          float painterly_cls;
          float painterly_seed;
          vec3 painterly_normal;
          ${paletteGlsl(extension.opts.palette)}
        `,

        // First statement of main(): instanceColors is in scope here.
        //
        // The archive ships NO normal column, so deck's `geometry.normal` is the
        // constant [0,0,1]. The real normal is the .ba pair, octahedral-encoded.
        // project_normal() is what PointCloudLayer would have applied to a bound
        // `instanceNormals`, so this lands in the same common space.
        'vs:#main-start': `
          painterly_cls = floor(instanceColors.r * 255.0 + 0.5);
          painterly_seed = instanceColors.g;
          painterly_normal = project_normal(painterly_octDecode(instanceColors.ba));
          vPaintClass = painterly_cls;
          vPaintSeed = painterly_seed;
        `,

        // Runs before gl_Position, so geometry.position is not yet available --
        // only class and seed are needed here. `size` is deck's inout parameter
        // name for this hook (vec3, in pixels).
        'vs:DECKGL_FILTER_SIZE': `
          size *= painterly_sizeFor(painterly_cls, painterly_seed) * painterly.sizeScale;
        `,

        // The only stage with a surface normal. `color` arrives as the Gouraud-lit
        // instanceColors, which is meaningless here (those bytes are indices), so
        // rgb is rebuilt from scratch. Alpha is multiplied, not assigned.
        'vs:DECKGL_FILTER_COLOR': `
          {
            float cls = painterly_cls;
            float seed = painterly_seed;

            vec3 base = painterly_baseColor(cls);
            // Additive pigment variation. Multiplicative jitter vanishes on the
            // near-black hull (5,14,41), which is why Blender's baked
            // painterly_color_jitter was invisible.
            base += (seed - 0.5) * 2.0 * painterly.jitter * (0.35 + base);
            base = max(base, vec3(0.0));

            vec3 N = normalize(painterly_normal);
            vec3 keyDir = normalize(vec3(painterly.keyX, painterly.keyY, painterly.keyZ));
            vec3 rimDir = normalize(vec3(painterly.rimX, painterly.rimY, painterly.rimZ));

            // Wrapped diffuse: a hard terminator reads as CG on a point cloud.
            float key = max(dot(N, keyDir) * 0.5 + 0.5, 0.0);
            float rim = pow(max(dot(N, rimDir), 0.0), painterly.rimPower);

            vec3 lit = base * (painterly.ambient + key * vec3(painterly.keyR, painterly.keyG, painterly.keyB));
            lit += vec3(painterly.rimR, painterly.rimG, painterly.rimB) * rim * (0.35 + base);

            // Turner: dissolve into weather with view distance. geometry.position
            // and project.cameraPosition are both common space; project_size(1.0)
            // is common-units-per-metre, so the density uniform stays in 1/metres
            // and does not drift with zoom.
            float commonPerMeter = project_size(1.0);
            float distM = length(geometry.position.xyz - project.cameraPosition) / max(commonPerMeter, 1e-9);
            float fog = 1.0 - exp(-painterly.fogDensity * distM);
            lit = mix(lit, vec3(painterly.fogR, painterly.fogG, painterly.fogB), clamp(fog, 0.0, 1.0));

            // Alpha is REBUILT, not carried: the incoming color.a is
            // instanceColors.a * layer.opacity, and instanceColors.a is now a
            // normal byte. TimeFilterExtension still multiplies vTimeAlpha into
            // this in the fragment stage, so the temporal window survives.
            color = vec4(lit, layer.opacity * painterly_alphaFor(cls));
          }
        `,

        'fs:#decl': `
          in float vPaintClass;
          in float vPaintSeed;
          ${softnessGlsl}
        `,

        // TimeFilterExtension has already run here: it discarded out-of-window
        // fragments and did `color.a *= vTimeAlpha`. Multiply only.
        'fs:DECKGL_FILTER_COLOR': `
          {
            float soft = painterly_softness(vPaintClass);
            if (soft > 0.0) {
              float r2 = dot(geometry.uv, geometry.uv);
              color.a *= mix(1.0, exp(-3.0 * r2), soft);
            }
          }
        `,
      },
    };
    return extension.cachedShaders;
  }

  draw(this: any, _params: unknown, _extension: PainterlyExtension) {
    const {
      painterlyFogDensity,
      painterlyFogColor,
      painterlyKeyDir,
      painterlyKeyColor,
      painterlyRimDir,
      painterlyRimColor,
      painterlyRimPower,
      painterlyAmbient,
      painterlyJitter,
      painterlySizeScale,
    } = this.props as Required<PainterlyExtensionProps>;

    const props: PainterlyUniformProps = {
      fogDensity: painterlyFogDensity,
      fogR: painterlyFogColor[0],
      fogG: painterlyFogColor[1],
      fogB: painterlyFogColor[2],
      keyX: painterlyKeyDir[0],
      keyY: painterlyKeyDir[1],
      keyZ: painterlyKeyDir[2],
      keyR: painterlyKeyColor[0],
      keyG: painterlyKeyColor[1],
      keyB: painterlyKeyColor[2],
      rimX: painterlyRimDir[0],
      rimY: painterlyRimDir[1],
      rimZ: painterlyRimDir[2],
      rimR: painterlyRimColor[0],
      rimG: painterlyRimColor[1],
      rimB: painterlyRimColor[2],
      rimPower: painterlyRimPower,
      ambient: painterlyAmbient,
      jitter: painterlyJitter,
      sizeScale: painterlySizeScale,
    };
    this.setShaderModuleProps({ painterly: props });
  }
}
