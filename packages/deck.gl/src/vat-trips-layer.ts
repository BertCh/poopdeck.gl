// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * VatTripsLayer — Vertex-Animation-Texture trip rendering.
 *
 * Each active trajectory becomes ONE quad instance. Position-over-time is
 * baked into a 2D texture per tile and sampled by the vertex shader at the
 * current playhead. So GPU work scales as (active trips × 4 verts) and is
 * INDEPENDENT of how many vertices were on each trajectory.
 *
 * Contrast with `AnimatedTripsLayer`, which uploads every vertex of every
 * trajectory and uses a per-vertex time attribute to fade out past/future
 * segments — work scales with (trajectories × avg-path-length). At the
 * Sprint 2026-05 research-note 7 scale (100M+ vertex universe) that
 * upload simply can't fit; VAT is the path to that target.
 *
 * Tradeoffs at v1:
 *   - HEAD DOT ONLY. No trail. Add later via multi-sample in the VS or a
 *     second draw call with a strip.
 *   - Float32 positions in the texture. Precision-equivalent to a Float32
 *     attribute (the per-vertex lo/hi split that AnimatedTripsLayer uses for
 *     Float64 positions is not yet replicated here). Expect ~m-scale jitter
 *     at zoom ≥ 16 in dense urban grids.
 *   - Constant color. CategoryColorExtension wiring is a follow-up.
 *
 * Tile-side data dependencies: ZERO archive changes. Reads existing
 * `BinaryFeatures.positions` (Float64), `startIndices`, `startTimes`,
 * `endTimes`, and `vertexTimestamps` if present. Resampling happens at
 * tile-prepare time, cached on the PreparedTile.
 */

import { Layer, project32 } from '@deck.gl/core';
import type {
  Color,
  DefaultProps,
  Layer as DeckLayer,
  LayerContext,
  LayerProps,
} from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';
import type { Texture } from '@luma.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from './spatiotemporal-layer';
import { emit } from './telemetry';
import { warnOnce } from './log';
import { inheritedPropsDigest, updateTriggersDigest } from './style-digest';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@stt/core';

const DEBUG = false;

/** Default time-slot resolution. 64 samples ≈ 16 ms per slot for a 1 s trip. */
const DEFAULT_TIME_SLOTS = 64;

/**
 * WebGL2's MAX_TEXTURE_SIZE spec floor — every conforming WebGL2 backend
 * supports at least 8192 in each dimension, so we treat it as a hard limit
 * rather than querying at runtime.
 */
const MAX_TEXTURE_DIM = 8192;

/**
 * Safety net on trips per tile. With the 2D-packed layout the real GPU
 * ceiling is (MAX_TEXTURE_DIM / slots) × MAX_TEXTURE_DIM ≈ 1M trips at
 * slots=64, which would allocate ~1 GB per tile texture. This cap keeps
 * allocations bounded if a misconfigured dataset ever blows past what the
 * NYC taxi case actually needs (~25K peak).
 */
const MAX_TRIPS_PER_TILE = 131072;

/** Props added by {@link VatTripsLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link VatTripsLayerProps}). */
export interface _VatTripsLayerProps {
  /** Constant head-dot color (RGBA, 0-255). Used when `trailLength === 0`. */
  headColor?: Color;
  /** Head radius in pixels. Used when `trailLength === 0`. */
  headRadiusPixels?: number;
  /**
   * Units for head radius (`headRadius`/`headRadiusPixels`) and trail width
   * (`tripWidth`). 'pixels' (default) is the legacy screen-space behavior;
   * 'meters' makes sizes world-space so dots/ribbons scale with zoom (emerge
   * as you zoom in) like the maritime point layer's "render by space" look.
   */
  sizeUnits?: 'pixels' | 'meters';
  /**
   * Head radius value when `sizeUnits === 'meters'` (in meters). Falls back to
   * `headRadiusPixels` when unset. Clamped to [headRadiusMinPixels,
   * headRadiusMaxPixels] on screen.
   */
  headRadius?: number;
  /** Min on-screen head radius in pixels (meters mode clamp). Default 0. */
  headRadiusMinPixels?: number;
  /** Max on-screen head radius in pixels (meters mode clamp). Default unbounded. */
  headRadiusMaxPixels?: number;
  /**
   * Time-slot resolution of the VAT (samples per trajectory). Higher =
   * smoother motion / larger texture. 64 is the visual sweet spot for the
   * NYC taxi case; expose for callers with much-longer trips.
   */
  timeSlots?: number;
  /**
   * Trail length in ms. > 0 swaps the head-dot sublayer for the ribbon-trail
   * sublayer. The trail's leading vertex IS the head visually, so we render
   * the trail alone (no second head draw).
   */
  trailLength?: number;
  /**
   * Vertices per ribbon trail (one instance per active trip). Output VS work
   * is `activeTrips × (trailSamples + 1) × 2`. 16 is the sweet spot for the
   * NYC-taxi 10s-trail case — bumping to 32 is invisible at zoom ≥ 14.
   */
  trailSamples?: number;
  /** Ribbon color (RGBA, 0-255). */
  trailColor?: Color;
  /** Ribbon nominal width in pixels (clamped to widthMinPixels/widthMaxPixels). */
  tripWidth?: number;
  /** Minimum on-screen ribbon width in pixels. */
  widthMinPixels?: number;
  /** Maximum on-screen ribbon width in pixels. */
  widthMaxPixels?: number;
  /** Fade trail older→transparent. Default true. */
  fadeTrail?: boolean;
}

/** Complete props accepted by {@link VatTripsLayer}. */
export type VatTripsLayerProps = _VatTripsLayerProps & SpatioTemporalLayerProps;

const DEFAULT_HEAD_COLOR: Color = [253, 128, 93, 255];
const DEFAULT_TRAIL_COLOR: Color = [253, 128, 93, 255];

/** Default ribbon resolution. 16 samples = 17 quads = 34 verts per trip. */
const DEFAULT_TRAIL_SAMPLES = 16;

/* ─────────────────────────── Tile preparation ─────────────────────────── */

interface PreparedTile {
  tileKey: string;
  /**
   * 2D-packed RG32F texture (2 floats — lon, lat — per texel). Trips are tiled
   * `tripsPerRow` per texture row, each occupying `timeSlots` consecutive
   * texels. So a trip's texel lives at
   * `(row = floor(i / tripsPerRow), col = (i % tripsPerRow) * slots + k)`.
   * This lets a single 8192×8192 texture hold up to ~1M trips at slots=64,
   * vs the old 1-row-per-trip layout that capped out at 8192 trips.
   */
  positionsData: Float32Array;
  /** Reference-stable binary-data shape handed to the sublayer's `data` prop. */
  data: VatTripsSublayerData;
  /** Number of trips this tile renders. Same as data.length. */
  numTrips: number;
  /** Texture dimensions actually used. */
  width: number;
  height: number;
  /** Per-tile time base — currentTime is normalized into this frame on each draw. */
  timeOffset: number;
  /** Time-slot count per trip — also the column stride of one trip in the texture. */
  timeSlots: number;
  /** Number of trips packed into each texture row. */
  tripsPerRow: number;
  /**
   * Source tile + decoded columns — picking enrichment context, carried for
   * family parity. Inert today: VAT sublayers are hard-wired non-pickable
   * (their shaders have no picking symbols), so no pick can originate here.
   * Trip index === feature index (the safety cap truncates, never reorders),
   * so the mapping holds if picking ever lands.
   */
  tile: Tile;
  features: BinaryFeatures;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Resample `numSlots` evenly-spaced positions along each trip's [startTime,
 * endTime] window into `out`. When `vertexTimestamps` is present, samples
 * interpolate by actual time (so a trip that loitered then accelerated
 * shows that). Otherwise samples interpolate uniformly across vertex index.
 *
 * Writes into the 2D-packed layout: trip `i` lives at texture row
 * `floor(i / tripsPerRow)`, starting at column `(i % tripsPerRow) * numSlots`.
 */
function resamplePositions(
  binary: BinaryFeatures,
  numSlots: number,
  tripsPerRow: number,
  textureWidth: number,
  numTrips: number,
  out: Float32Array,
): void {
  const startIndices = binary.startIndices!;
  const positions = binary.positions; // Float64Array, interleaved lon/lat
  const dims = binary.positionDimensions ?? 2;
  const startTimes = binary.startTimes;
  const endTimes = binary.endTimes;
  const vt = binary.vertexTimestamps; // optional

  for (let i = 0; i < numTrips; i++) {
    const v0 = startIndices[i];
    const v1 = startIndices[i + 1];
    const numVerts = v1 - v0;
    const tStart = startTimes[i];
    const tEnd = endTimes[i];
    const tDur = tEnd - tStart;

    // 2D-packed texel base for this trip.
    const texRow = Math.floor(i / tripsPerRow);
    const texColBase = (i - texRow * tripsPerRow) * numSlots;
    const rowBase = texRow * textureWidth;

    // Pointer into the vertex list (advances monotonically across slots).
    let j = 0;

    for (let k = 0; k < numSlots; k++) {
      // Slot's absolute time within the trip's window.
      const slotT = numSlots > 1 ? (k / (numSlots - 1)) * tDur : 0;
      let lon: number;
      let lat: number;

      if (vt && numVerts >= 2) {
        // Time-driven interpolation: advance j to the segment containing slotT.
        const targetAbs = tStart + slotT;
        while (j < numVerts - 2 && vt[v0 + j + 1] < targetAbs) j++;
        const ta = vt[v0 + j];
        const tb = vt[v0 + j + 1];
        const denom = tb - ta;
        const frac = denom > 0 ? Math.max(0, Math.min(1, (targetAbs - ta) / denom)) : 0;
        const pa = (v0 + j) * dims;
        const pb = (v0 + j + 1) * dims;
        lon = positions[pa] * (1 - frac) + positions[pb] * frac;
        lat = positions[pa + 1] * (1 - frac) + positions[pb + 1] * frac;
      } else if (numVerts >= 2) {
        // Fallback: vertex-uniform interpolation (no per-vertex times).
        const vIdx = (k / Math.max(1, numSlots - 1)) * (numVerts - 1);
        const vfloor = Math.min(numVerts - 2, Math.floor(vIdx));
        const frac = vIdx - vfloor;
        const pa = (v0 + vfloor) * dims;
        const pb = (v0 + vfloor + 1) * dims;
        lon = positions[pa] * (1 - frac) + positions[pb] * frac;
        lat = positions[pa + 1] * (1 - frac) + positions[pb + 1] * frac;
      } else {
        // Degenerate: 0- or 1-vertex trip. Park it at the first vertex.
        const pa = v0 * dims;
        lon = positions[pa] ?? 0;
        lat = positions[pa + 1] ?? 0;
      }

      // RG32F: two floats per texel (lon, lat). The previous RGBA layout left
      // B/A permanently zero — wasted host alloc, VRAM, and texture-fetch
      // bandwidth. A future fp64-low / altitude pass would re-widen this.
      const off = (rowBase + texColBase + k) * 2;
      out[off] = lon;
      out[off + 1] = lat;
    }
  }
}

/* ─────────────────────────── Custom sublayer ─────────────────────────── */

/**
 * Single-tile draw call. Subclasses `Layer` (not ScatterplotLayer) because
 * we need to REPLACE the per-instance position attribute with a texture
 * sample — easier with a fresh shader than with injection into ScatterplotLayer.
 *
 * Per-instance buffers (`instanceTripRow`, `instanceStartTime`,
 * `instanceEndTime`) ride in on `data.attributes`, matching how
 * AnimatedTripsLayer's PathLayer sublayer consumes the TimeFilterExtension
 * attributes.
 */
interface VatTripsSublayerData {
  length: number;
  attributes: {
    instanceTripRow: { value: Float32Array; size: 1 };
    instanceStartTime: { value: Float32Array; size: 1 };
    instanceEndTime: { value: Float32Array; size: 1 };
  };
}

/**
 * Own props of the head-dot sublayer (upstream `_XxxLayerProps` convention).
 * `id`/`opacity`/`pickable`… come from {@link LayerProps} — they are NOT
 * re-declared as custom props here.
 */
type _VatTripsSublayerProps = {
  /** Per-tile instance buffers; null only before the composite supplies them. */
  data: VatTripsSublayerData | null;
  /** Baked VAT texel data; null only before the composite supplies it. */
  positionsTextureData: Float32Array | null;
  positionsTextureWidth: number;
  positionsTextureHeight: number;
  /** Samples-per-trip (column stride of one trip within a texture row). */
  timeSlots: number;
  /** Number of trips packed into each texture row. */
  tripsPerRow: number;
  headColor: Color;
  /** Head size value — pixels, or meters when `sizeInMeters` is true. */
  headRadiusPixels: number;
  /** When true, `headRadiusPixels` is meters; projected → pixels and clamped. */
  sizeInMeters: boolean;
  headRadiusMinPixels: number;
  headRadiusMaxPixels: number;
  timeOffset: number;
  /** Absolute Unix-ms playhead reader. Called on every draw. */
  getTime: () => number;
};

type VatTripsSublayerProps = _VatTripsSublayerProps & LayerProps;

// The shader assembler prepends `vatUniformsModule.vs` and the deck.gl
// `project32` decls, so we DO NOT redeclare the uniform block or sampler
// here — that would produce "redefinition" link errors.
const VAT_VS = /* glsl */ `\
#version 300 es
#define SHADER_NAME vat-trips-sublayer-vs

// Quad-corner geometry, unit square spanning the head dot's bounding rect.
in vec2 positions;

// Per-instance: [tripRow, startTime, endTime] in the tile's relative-ms frame.
in float instanceTripRow;
in float instanceStartTime;
in float instanceEndTime;

out vec4 vColor;
out vec2 vQuadUV;

void main() {
  // Cull whole quad if the playhead is outside this trip's window.
  if (vat.relativeTime < instanceStartTime || vat.relativeTime > instanceEndTime) {
    gl_Position = vec4(0.0, 0.0, 0.0, 0.0);
    vColor = vec4(0.0);
    vQuadUV = vec2(0.0);
    return;
  }

  // Map playhead → [0..1] progress → fractional slot index.
  float dur = max(instanceEndTime - instanceStartTime, 1e-6);
  float progress = clamp((vat.relativeTime - instanceStartTime) / dur, 0.0, 1.0);
  float slot = progress * (vat.timeSlots - 1.0);
  float s0 = floor(slot);
  float s1 = min(s0 + 1.0, vat.timeSlots - 1.0);
  float lerpFrac = slot - s0;

  // 2D-packed layout: derive (texRow, texCol) from the linear trip index so
  // we don't blow the MAX_TEXTURE_SIZE height limit for tiles with > 8K trips.
  float texRow = floor(instanceTripRow / vat.tripsPerRow);
  float tripCol = instanceTripRow - texRow * vat.tripsPerRow;
  float texColBase = tripCol * vat.timeSlots;

  // Sample both slots with nearest filtering, lerp manually. Avoids the
  // OES_texture_float_linear extension dependency.
  vec2 uv0 = vec2((texColBase + s0 + 0.5) / vat.texWidth, (texRow + 0.5) / vat.texHeight);
  vec2 uv1 = vec2((texColBase + s1 + 0.5) / vat.texWidth, (texRow + 0.5) / vat.texHeight);
  vec4 p0 = texture(vat_positionsTexture, uv0);
  vec4 p1 = texture(vat_positionsTexture, uv1);
  vec2 lngLat = mix(p0.xy, p1.xy, lerpFrac);

  // Project through the standard deck.gl pipeline so the head sits exactly
  // where the rest of the scene does. Use the 3-arg overload; the 4-arg
  // form expects an out vec4 (not vec3) as its last parameter.
  vec3 world = vec3(lngLat, 0.0);
  vec3 world64Low = vec3(0.0); // see file header for the fp64-split TODO.
  gl_Position = project_position_to_clipspace(world, world64Low, vec3(0.0));

  // Head size. Pixels by default; when sizeUnitsMeters is set, headRadiusPixels
  // carries a METER radius that we project to on-screen pixels and clamp, so the
  // dot scales with the world (emerges on zoom) like the maritime points.
  float headPx = vat.headRadiusPixels;
  if (vat.sizeUnitsMeters > 0.5) {
    headPx = clamp(
      project_size_to_pixel(vat.headRadiusPixels),
      vat.headRadiusMinPixels,
      vat.headRadiusMaxPixels
    );
  }
  vec2 offsetPx = positions * headPx;
  gl_Position.xy += project_pixel_size_to_clipspace(offsetPx);

  vColor = vec4(vat.headColor.rgb, vat.headColor.a);
  vQuadUV = positions; // unit-square coords, [-1, 1]
}
`;

const VAT_FS = /* glsl */ `\
#version 300 es
#define SHADER_NAME vat-trips-sublayer-fs
precision highp float;

in vec4 vColor;
in vec2 vQuadUV;
out vec4 fragColor;

void main() {
  // Disc with antialiased edge. dist == 1 at the quad's outer corner.
  float dist = length(vQuadUV);
  if (dist > 1.0) discard;
  float alpha = smoothstep(1.0, 0.85, dist);
  fragColor = vec4(vColor.rgb, vColor.a * alpha);
}
`;

/**
 * Shared uniform block for head + trail sublayers. The two shaders read
 * disjoint subsets of fields; GLSL allows referencing only some members of
 * a block, so we keep ONE block declaration (and one shader-module identity)
 * to avoid forking the cache.
 *
 * Trail-mode fields (`trailLength`, `trailSamples`, `tripWidthPixels`,
 * `widthMinPixels`, `widthMaxPixels`, `fadeTrail`, `trailColor`) are set to
 * zero/identity when the head sublayer is active and vice versa.
 */
const vatUniformsModule = {
  name: 'vat',
  vs: /* glsl */ `\
uniform vatUniforms {
  float relativeTime;
  float timeSlots;
  float tripsPerRow;
  float texWidth;
  float texHeight;
  float headRadiusPixels;
  vec4 headColor;
  float trailLength;
  float trailSamples;
  float tripWidthPixels;
  float widthMinPixels;
  float widthMaxPixels;
  float fadeTrail;
  vec4 trailColor;
  // World-space sizing: 0 = pixels (legacy), 1 = meters. When 1, the head/
  // trail size fields above carry meters and are projected → pixels in the VS.
  float sizeUnitsMeters;
  float headRadiusMinPixels;
  float headRadiusMaxPixels;
} vat;

uniform sampler2D vat_positionsTexture;
`,
  // The FS reads only varyings; the uniform block is intentionally absent
  // here. If a future fragment-fade-by-uniform variant lands, mirror the
  // `vs` declaration into `fs` so the FS can reference `vat.*`.
  fs: '',
  uniformTypes: {
    relativeTime: 'f32',
    timeSlots: 'f32',
    tripsPerRow: 'f32',
    texWidth: 'f32',
    texHeight: 'f32',
    headRadiusPixels: 'f32',
    headColor: 'vec4<f32>',
    trailLength: 'f32',
    trailSamples: 'f32',
    tripWidthPixels: 'f32',
    widthMinPixels: 'f32',
    widthMaxPixels: 'f32',
    fadeTrail: 'f32',
    trailColor: 'vec4<f32>',
    sizeUnitsMeters: 'f32',
    headRadiusMinPixels: 'f32',
    headRadiusMaxPixels: 'f32',
  },
};

/**
 * Stable shader-module list for both VAT sublayers. Hoisted to module scope
 * so getShaders() returns object-identity-stable references across every
 * sublayer construction — deck.gl keys its shader-pipeline cache on the
 * modules array identity, and rebuilding the list inside the getter would
 * spawn a fresh cache entry per tile.
 *
 * Deliberately OMITS the `picking` module. Both VAT sublayers are always
 * `pickable: false` and neither shader references any `picking_*` symbol, so
 * bundling picking only added the `instancePickingColors` attribute + picking
 * varyings to every model for nothing (the exact overhead NoPickingPathLayer
 * exists to strip on the PathLayer path). Mirrors the sibling
 * `HeatmapSplatSublayer`, which is also a bare `Layer` with `[project32, …]`.
 */
const VAT_SHADER_MODULES = [project32, vatUniformsModule];

// Upstream idiom: module-level const typed `DefaultProps<XxxProps>` then
// assigned to the static — keeps the emitted .d.ts portable (the inferred
// mapped type used to surface transitive-dep types, which motivated the
// previous `static defaultProps: any`). `opacity` is NOT re-declared: the
// base Layer's defaultProps already carry it.
const vatTripsSublayerDefaultProps: DefaultProps<VatTripsSublayerProps> = {
  data: { type: 'object', value: null, compare: false },
  positionsTextureData: { type: 'object', value: null, compare: false },
  positionsTextureWidth: { type: 'number', value: 0 },
  positionsTextureHeight: { type: 'number', value: 0 },
  timeSlots: { type: 'number', value: DEFAULT_TIME_SLOTS },
  tripsPerRow: { type: 'number', value: 1 },
  headColor: { type: 'color', value: DEFAULT_HEAD_COLOR },
  headRadiusPixels: { type: 'number', value: 4, min: 0 },
  sizeInMeters: { type: 'boolean', value: false },
  headRadiusMinPixels: { type: 'number', value: 0, min: 0 },
  headRadiusMaxPixels: { type: 'number', value: 1e9, min: 0 },
  timeOffset: { type: 'number', value: 0 },
  getTime: { type: 'function', value: () => 0, compare: false },
};

class VatTripsSublayer extends Layer<Required<_VatTripsSublayerProps>> {
  static layerName = 'VatTripsSublayer';
  static defaultProps = vatTripsSublayerDefaultProps;

  getShaders(): any {
    return super.getShaders({
      vs: VAT_VS,
      fs: VAT_FS,
      modules: VAT_SHADER_MODULES,
    });
  }

  initializeState(_context: LayerContext): void {
    // Register the three instance attributes by name. deck.gl pulls their
    // buffers from `data.attributes.<name>` because we pass the binary
    // data shape rather than per-row accessors.
    const attributeManager = this.getAttributeManager()!;
    attributeManager.addInstanced({
      instanceTripRow: { size: 1, type: 'float32', accessor: (d: any) => d },
      instanceStartTime: { size: 1, type: 'float32', accessor: (d: any) => d },
      instanceEndTime: { size: 1, type: 'float32', accessor: (d: any) => d },
    });
    this._buildModel();
    this._uploadTexture();
  }

  updateState(params: any): void {
    super.updateState(params);
    if (params.changeFlags.extensionsChanged) {
      (this.state as any).model?.destroy();
      this._buildModel();
      (this.state as any).positionsTexture?.destroy();
      this._uploadTexture();
      this.getAttributeManager()!.invalidateAll();
      return;
    }
    if (
      params.props.positionsTextureData !== params.oldProps.positionsTextureData ||
      params.props.positionsTextureWidth !== params.oldProps.positionsTextureWidth ||
      params.props.positionsTextureHeight !== params.oldProps.positionsTextureHeight
    ) {
      // Texture dims can grow when the prop hot-swaps — destroy + rebuild.
      (this.state as any).positionsTexture?.destroy();
      this._uploadTexture();
    }
  }

  finalizeState(context: LayerContext): void {
    // positionsTexture is layer-managed (base Layer knows nothing about it);
    // model destroy is idempotent, so the base pass over getModels() is safe.
    (this.state as any).model?.destroy();
    (this.state as any).positionsTexture?.destroy();
    // Base Layer.finalizeState does real work on this non-composite sublayer:
    // attributeManager.finalize() releases the instanced attribute buffers
    // and the resource manager unsubscribes — skipping it leaked GPU buffers
    // on every per-tile sublayer churn.
    super.finalizeState(context);
  }

  draw(_params: any): void {
    const { positionsTexture } = this.state as any;
    if (!positionsTexture) return;

    const absTime = this.props.getTime();
    const relTime = absTime - this.props.timeOffset;
    const color = this.props.headColor ?? DEFAULT_HEAD_COLOR;
    const rgba: [number, number, number, number] = [
      (color[0] ?? 0) / 255,
      (color[1] ?? 0) / 255,
      (color[2] ?? 0) / 255,
      ((color[3] ?? 255) / 255) * (this.props.opacity ?? 1),
    ];

    const model = (this.state as any).model;
    model.shaderInputs.setProps({
      vat: {
        relativeTime: relTime,
        timeSlots: this.props.timeSlots,
        tripsPerRow: this.props.tripsPerRow,
        texWidth: this.props.positionsTextureWidth,
        texHeight: this.props.positionsTextureHeight,
        headRadiusPixels: this.props.headRadiusPixels ?? 4,
        headColor: rgba,
        sizeUnitsMeters: this.props.sizeInMeters ? 1 : 0,
        headRadiusMinPixels: this.props.headRadiusMinPixels ?? 0,
        headRadiusMaxPixels: this.props.headRadiusMaxPixels ?? 1e9,
        // Trail-mode fields zero'd in head mode. The shared uniform block
        // declares them; leaving them unset on some drivers leaves stale
        // values from a previous trail-mode sublayer in the same renderpass.
        trailLength: 0,
        trailSamples: 0,
        tripWidthPixels: 0,
        widthMinPixels: 0,
        widthMaxPixels: 0,
        fadeTrail: 0,
        trailColor: [0, 0, 0, 0],
      },
    });
    model.setBindings({ vat_positionsTexture: positionsTexture });
    model.setInstanceCount(this.props.data?.length ?? 0);
    model.draw(this.context.renderPass);
  }

  private _buildModel(): void {
    // Unit-square triangle strip. [-1,1] coords are scaled to head pixels
    // in the VS so the same geometry covers any radius.
    const positions = new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      1, 1,
    ]);
    const model = new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-strip',
        attributes: {
          positions: { size: 2, value: positions },
        },
      }),
      isInstanced: true,
    });
    this.setState({ model });
  }

  private _uploadTexture(): void {
    const width = this.props.positionsTextureWidth;
    const height = this.props.positionsTextureHeight;
    const texelData = this.props.positionsTextureData;
    if (width === 0 || height === 0 || !texelData) return;
    const device = this.context.device;
    const tex: Texture = device.createTexture({
      width,
      height,
      format: 'rg32float',
      // Nearest filtering: we lerp manually in the VS so we don't need
      // OES_texture_float_linear (which isn't on every WebGL2 backend).
      sampler: {
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
    });
    // luma.gl expects a typed-array view of the texel bytes. RG32F is
    // 2 channels × 4 bytes; copyImageData accepts the Float32Array directly.
    tex.copyImageData({ data: texelData });
    this.setState({ positionsTexture: tex });
  }
}

/* ──────────────────────────── Trail sublayer ──────────────────────────── */

/**
 * Ribbon-trail sublayer. One INSTANCE per active trip; geometry is a
 * `(trailSamples + 1) × 2` triangle-strip whose vertices are positioned in
 * the VS by sampling the per-tile VAT texture at uniformly-time-spaced
 * points in `[playhead - trailLength, playhead]`.
 *
 * Visual: a width-extruded polyline trailing the head. Older vertices fade
 * toward zero alpha when `fadeTrail` is on.
 *
 * Why this beats AnimatedTripsLayer (PathLayer-based): PathLayer creates an
 * instance per SEGMENT and uses the full path geometry, so frame cost scales
 * with total segments × 6 verts even when only a fraction overlap the time
 * window. The VAT trail's cost scales with `activeTrips × (samples+1) × 2`,
 * independent of underlying path density. For NYC-taxi 500K trips/~10s
 * trail/16 samples that's ~850K verts/frame vs ~30M for PathLayer.
 */
const VAT_TRAIL_VS = /* glsl */ `\
#version 300 es
#define SHADER_NAME vat-trips-trail-sublayer-vs

// Per-instance: [tripRow, startTime, endTime] in the tile's relative-ms frame.
in float instanceTripRow;
in float instanceStartTime;
in float instanceEndTime;

out vec4 vColor;

// Sample the VAT texture at fractional slot index, manual nearest-pair lerp
// (no OES_texture_float_linear dependency).
vec2 vatSampleLerp(float tripRow, float slotF) {
  float s0 = floor(slotF);
  float s1 = min(s0 + 1.0, vat.timeSlots - 1.0);
  float lerpFrac = slotF - s0;
  float texRow = floor(tripRow / vat.tripsPerRow);
  float tripCol = tripRow - texRow * vat.tripsPerRow;
  float texColBase = tripCol * vat.timeSlots;
  vec2 uv0 = vec2((texColBase + s0 + 0.5) / vat.texWidth, (texRow + 0.5) / vat.texHeight);
  vec2 uv1 = vec2((texColBase + s1 + 0.5) / vat.texWidth, (texRow + 0.5) / vat.texHeight);
  vec4 p0 = texture(vat_positionsTexture, uv0);
  vec4 p1 = texture(vat_positionsTexture, uv1);
  return mix(p0.xy, p1.xy, lerpFrac);
}

void main() {
  // Derive (sample ordinal, ribbon side) from gl_VertexID. Even verts are
  // the left side (-1), odd are the right (+1). sOrd 0 = oldest tail,
  // sOrd trailSamples = head.
  int sOrd = gl_VertexID >> 1;
  float side = ((gl_VertexID & 1) == 0) ? -1.0 : 1.0;

  float samplesF = vat.trailSamples;
  float trailFrac = float(sOrd) / samplesF;  // 0..1, 0 = oldest
  float vertTimeIdeal = vat.relativeTime - (1.0 - trailFrac) * vat.trailLength;

  float tripStart = instanceStartTime;
  float tripEnd = instanceEndTime;

  // Whole-instance cull: head past trip end, or trail-start before trip start.
  // (Tail-clamping inside the window stays visible; this catches only the
  // case where the entire trail window doesn't overlap the trip at all.)
  if (vat.relativeTime < tripStart || vat.relativeTime - vat.trailLength > tripEnd) {
    gl_Position = vec4(0.0);
    vColor = vec4(0.0);
    return;
  }

  // Clamp the per-vertex time into [tripStart, tripEnd]; verts outside the
  // window get pinned to the boundary so the ribbon terminates cleanly.
  float vertTime = clamp(vertTimeIdeal, tripStart, tripEnd);
  float inWindow = (vertTimeIdeal >= tripStart && vertTimeIdeal <= tripEnd) ? 1.0 : 0.0;

  float tripDur = max(tripEnd - tripStart, 1e-6);
  float slotFCenter = (vertTime - tripStart) / tripDur * (vat.timeSlots - 1.0);
  float slotFPrev = max(slotFCenter - 0.5, 0.0);
  float slotFNext = min(slotFCenter + 0.5, vat.timeSlots - 1.0);

  vec2 pCenter = vatSampleLerp(instanceTripRow, slotFCenter);
  vec2 pPrev = vatSampleLerp(instanceTripRow, slotFPrev);
  vec2 pNext = vatSampleLerp(instanceTripRow, slotFNext);

  // Project all three to clip space (fp32 positions — same precision tradeoff
  // as the head sublayer; see file header for the fp64-split TODO).
  vec4 clipCenter = project_position_to_clipspace(vec3(pCenter, 0.0), vec3(0.0), vec3(0.0));
  vec4 clipPrev = project_position_to_clipspace(vec3(pPrev, 0.0), vec3(0.0), vec3(0.0));
  vec4 clipNext = project_position_to_clipspace(vec3(pNext, 0.0), vec3(0.0), vec3(0.0));

  // Screen-pixel-space tangent → perpendicular. Works under any pitch/zoom
  // because we let the perspective divide happen first and measure delta in
  // viewport pixels.
  vec2 ndcPrev = clipPrev.xy / clipPrev.w;
  vec2 ndcNext = clipNext.xy / clipNext.w;
  vec2 screenPrev = (ndcPrev * 0.5 + 0.5) * project.viewportSize;
  vec2 screenNext = (ndcNext * 0.5 + 0.5) * project.viewportSize;
  vec2 dirPx = screenNext - screenPrev;
  float dirLen = length(dirPx);
  vec2 dirN = (dirLen > 1e-3) ? (dirPx / dirLen) : vec2(1.0, 0.0);
  vec2 perpN = vec2(-dirN.y, dirN.x);

  // Width. Pixels by default; when sizeUnitsMeters is set, tripWidthPixels
  // carries a METER width that we project to on-screen pixels (world-space,
  // emerges on zoom). Min/max-pixel clamps apply in both modes.
  float rawWidth = (vat.sizeUnitsMeters > 0.5)
    ? project_size_to_pixel(vat.tripWidthPixels)
    : vat.tripWidthPixels;
  float widthPx = clamp(rawWidth, vat.widthMinPixels, vat.widthMaxPixels);
  vec2 offsetPx = perpN * side * widthPx * 0.5;

  gl_Position = clipCenter;
  // project_pixel_size_to_clipspace returns NDC-scale delta; multiply by .w
  // so the offset survives perspective divide as the requested pixel count.
  gl_Position.xy += project_pixel_size_to_clipspace(offsetPx) * gl_Position.w;

  // Color & alpha. fadeTrail = 0 → constant; fadeTrail = 1 → linear age fade.
  vec4 baseColor = vat.trailColor;
  float ageAlpha = mix(1.0, trailFrac, vat.fadeTrail);
  vColor = vec4(baseColor.rgb, baseColor.a * ageAlpha * inWindow);
}
`;

const VAT_TRAIL_FS = /* glsl */ `\
#version 300 es
#define SHADER_NAME vat-trips-trail-sublayer-fs
precision highp float;

in vec4 vColor;
out vec4 fragColor;

void main() {
  if (vColor.a <= 0.0) discard;
  fragColor = vColor;
}
`;

/** Own props of the ribbon-trail sublayer — see {@link _VatTripsSublayerProps}. */
type _VatTripsTrailSublayerProps = {
  /** Per-tile instance buffers; null only before the composite supplies them. */
  data: VatTripsSublayerData | null;
  /** Baked VAT texel data; null only before the composite supplies it. */
  positionsTextureData: Float32Array | null;
  positionsTextureWidth: number;
  positionsTextureHeight: number;
  timeSlots: number;
  tripsPerRow: number;
  trailColor: Color;
  trailLength: number;
  trailSamples: number;
  /** Ribbon width value — pixels, or meters when `sizeInMeters` is true. */
  tripWidth: number;
  /** When true, `tripWidth` is meters; projected → pixels and clamped. */
  sizeInMeters: boolean;
  widthMinPixels: number;
  widthMaxPixels: number;
  fadeTrail: boolean;
  timeOffset: number;
  getTime: () => number;
};

type VatTripsTrailSublayerProps = _VatTripsTrailSublayerProps & LayerProps;

// Same `DefaultProps`-typed-const idiom (and same no-`opacity` rationale) as
// vatTripsSublayerDefaultProps above.
const vatTripsTrailSublayerDefaultProps: DefaultProps<VatTripsTrailSublayerProps> = {
  data: { type: 'object', value: null, compare: false },
  positionsTextureData: { type: 'object', value: null, compare: false },
  positionsTextureWidth: { type: 'number', value: 0 },
  positionsTextureHeight: { type: 'number', value: 0 },
  timeSlots: { type: 'number', value: DEFAULT_TIME_SLOTS },
  tripsPerRow: { type: 'number', value: 1 },
  trailColor: { type: 'color', value: DEFAULT_TRAIL_COLOR },
  trailLength: { type: 'number', value: 10000, min: 1 },
  trailSamples: { type: 'number', value: DEFAULT_TRAIL_SAMPLES, min: 2 },
  tripWidth: { type: 'number', value: 4, min: 0 },
  sizeInMeters: { type: 'boolean', value: false },
  widthMinPixels: { type: 'number', value: 0, min: 0 },
  widthMaxPixels: { type: 'number', value: 100, min: 0 },
  fadeTrail: { type: 'boolean', value: true },
  timeOffset: { type: 'number', value: 0 },
  getTime: { type: 'function', value: () => 0, compare: false },
};

class VatTripsTrailSublayer extends Layer<Required<_VatTripsTrailSublayerProps>> {
  static layerName = 'VatTripsTrailSublayer';
  static defaultProps = vatTripsTrailSublayerDefaultProps;

  getShaders(): any {
    return super.getShaders({
      vs: VAT_TRAIL_VS,
      fs: VAT_TRAIL_FS,
      modules: VAT_SHADER_MODULES,
    });
  }

  initializeState(_context: LayerContext): void {
    const attributeManager = this.getAttributeManager()!;
    attributeManager.addInstanced({
      instanceTripRow: { size: 1, type: 'float32', accessor: (d: any) => d },
      instanceStartTime: { size: 1, type: 'float32', accessor: (d: any) => d },
      instanceEndTime: { size: 1, type: 'float32', accessor: (d: any) => d },
    });
    this._buildModel();
    this._uploadTexture();
  }

  updateState(params: any): void {
    super.updateState(params);
    if (params.changeFlags.extensionsChanged) {
      (this.state as any).model?.destroy();
      this._buildModel();
      (this.state as any).positionsTexture?.destroy();
      this._uploadTexture();
      this.getAttributeManager()!.invalidateAll();
      return;
    }
    if (
      params.props.positionsTextureData !== params.oldProps.positionsTextureData ||
      params.props.positionsTextureWidth !== params.oldProps.positionsTextureWidth ||
      params.props.positionsTextureHeight !== params.oldProps.positionsTextureHeight
    ) {
      (this.state as any).positionsTexture?.destroy();
      this._uploadTexture();
    }
    if (params.props.trailSamples !== params.oldProps.trailSamples) {
      (this.state as any).model?.destroy();
      this._buildModel();
    }
  }

  finalizeState(context: LayerContext): void {
    // See VatTripsSublayer.finalizeState — same leak, same fix.
    (this.state as any).model?.destroy();
    (this.state as any).positionsTexture?.destroy();
    super.finalizeState(context);
  }

  draw(_params: any): void {
    const { positionsTexture } = this.state as any;
    if (!positionsTexture) return;

    const absTime = this.props.getTime();
    const relTime = absTime - this.props.timeOffset;
    const color = this.props.trailColor ?? DEFAULT_TRAIL_COLOR;
    const rgba: [number, number, number, number] = [
      (color[0] ?? 0) / 255,
      (color[1] ?? 0) / 255,
      (color[2] ?? 0) / 255,
      ((color[3] ?? 255) / 255) * (this.props.opacity ?? 1),
    ];

    const model = (this.state as any).model;
    model.shaderInputs.setProps({
      vat: {
        relativeTime: relTime,
        timeSlots: this.props.timeSlots,
        tripsPerRow: this.props.tripsPerRow,
        texWidth: this.props.positionsTextureWidth,
        texHeight: this.props.positionsTextureHeight,
        // Head-mode fields zero'd in trail mode.
        headRadiusPixels: 0,
        headColor: [0, 0, 0, 0],
        trailLength: this.props.trailLength,
        trailSamples: this.props.trailSamples,
        tripWidthPixels: this.props.tripWidth,
        widthMinPixels: this.props.widthMinPixels,
        widthMaxPixels: this.props.widthMaxPixels,
        fadeTrail: this.props.fadeTrail ? 1 : 0,
        trailColor: rgba,
        sizeUnitsMeters: this.props.sizeInMeters ? 1 : 0,
        // Head-only clamps unused in trail mode.
        headRadiusMinPixels: 0,
        headRadiusMaxPixels: 0,
      },
    });
    model.setBindings({ vat_positionsTexture: positionsTexture });
    model.setInstanceCount(this.props.data?.length ?? 0);
    model.draw(this.context.renderPass);
  }

  private _buildModel(): void {
    const samples = this.props.trailSamples;
    // Vertex count: (samples + 1) ribbon spine points × 2 sides.
    const vertexCount = (samples + 1) * 2;
    // Geometry attribute is a no-op placeholder — VS derives everything from
    // gl_VertexID and the per-instance attrs. luma.gl needs *some* attribute
    // declared as the vertex driver, so we hand it a 1-component dummy.
    const dummy = new Float32Array(vertexCount);
    const model = new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-strip',
        attributes: {
          vertexIds: { size: 1, value: dummy },
        },
        vertexCount,
      }),
      isInstanced: true,
    });
    this.setState({ model });
  }

  private _uploadTexture(): void {
    const width = this.props.positionsTextureWidth;
    const height = this.props.positionsTextureHeight;
    const texelData = this.props.positionsTextureData;
    if (width === 0 || height === 0 || !texelData) return;
    const device = this.context.device;
    const tex: Texture = device.createTexture({
      width,
      height,
      format: 'rg32float',
      sampler: {
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
    });
    tex.copyImageData({ data: texelData });
    this.setState({ positionsTexture: tex });
  }
}

/* ─────────────────────────── Composite layer ─────────────────────────── */

/**
 * VAT trips composite.
 *
 * Sublayer short ids for `_subLayerProps` overrides: **`head`** (the
 * head-dot sublayer, active when `trailLength === 0`) and **`trail`** (the
 * ribbon-trail sublayer). Note both default sublayer classes are custom
 * texture-sampling layers — a `type` override must reimplement the VAT
 * texture contract. Sublayers are forced `pickable: false` (their shaders
 * carry no picking module); an explicit `_subLayerProps` pickable override
 * is honored per deck convention but will not produce usable picks.
 */
export class VatTripsLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_VatTripsLayerProps>
> {
  static layerName = 'VatTripsLayer';

  static defaultProps: DefaultProps<VatTripsLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    headColor: { type: 'color', value: DEFAULT_HEAD_COLOR },
    headRadiusPixels: { type: 'number', value: 4, min: 0 },
    sizeUnits: 'pixels',
    headRadius: { type: 'number', value: 0, min: 0 },
    headRadiusMinPixels: { type: 'number', value: 0, min: 0 },
    headRadiusMaxPixels: { type: 'number', value: 1e9, min: 0 },
    timeSlots: { type: 'number', value: DEFAULT_TIME_SLOTS, min: 2 },
    // Trail-mode props. trailLength === 0 keeps the historical head-dot mode.
    trailLength: { type: 'number', value: 0, min: 0 },
    trailSamples: { type: 'number', value: DEFAULT_TRAIL_SAMPLES, min: 2 },
    trailColor: { type: 'color', value: DEFAULT_TRAIL_COLOR },
    tripWidth: { type: 'number', value: 4, min: 0 },
    widthMinPixels: { type: 'number', value: 0, min: 0 },
    widthMaxPixels: { type: 'number', value: 100, min: 0 },
    fadeTrail: true,
  };

  private preparedTileCache = new Map<string, PreparedTile>();
  private sublayerCache = new Map<
    string,
    {
      layer: VatTripsSublayer | VatTripsTrailSublayer;
      preparedKey: PreparedTile;
      styleKey: string;
    }
  >();
  private lastStyleKey: string = '';
  /**
   * Tile-array identity from the previous render. When the parent layer hands
   * back the SAME `state.tiles` reference (no setState this render cycle) the
   * live tile set is unchanged by construction, so we skip the O(tiles+cache)
   * prune walks entirely. Mirrors `AnimatedTripsLayer.lastTilesRef` — VAT was
   * the only animated layer missing this guard, so prop-only re-renders during
   * playback paid the full prune scan every frame.
   */
  private lastTilesRef: Tile[] | null = null;
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  private computeStyleKey(): string {
    // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
    const head = this.props.headColor;
    const trail = this.props.trailColor;
    const trailing = this.props.trailLength > 0;
    return [
      // Mode discriminator: switching modes rebuilds every sublayer.
      trailing ? 'trail' : 'head',
      this.props.headRadiusPixels,
      this.props.sizeUnits,
      this.props.headRadius,
      this.props.headRadiusMinPixels,
      this.props.headRadiusMaxPixels,
      this.props.timeSlots,
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
      // plus the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      Array.isArray(head) ? head.join(',') : '',
      // Trail-only knobs. Including them in head mode is harmless — the
      // string compares stable when trailing === false.
      this.props.trailLength,
      this.props.trailSamples,
      this.props.tripWidth,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.fadeTrail,
      Array.isArray(trail) ? trail.join(',') : '',
    ].join('|');
  }

  renderLayers(): DeckLayer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune caches against the live tile set — but only when the tile array
    // reference actually changed. On a prop-only re-render (e.g. a style tweak
    // mid-playback) the parent returns the same `tiles` ref and the live set is
    // identical by construction, so the prune scan is pure waste.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tileLayer of tile.layers) live.add(makeTileKey(tile, tileLayer));
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      for (const key of this.sublayerCache.keys()) {
        if (!live.has(key)) this.sublayerCache.delete(key);
      }
      this.lastTilesRef = tiles;
    }

    const styleKey = this.computeStyleKey();
    if (styleKey !== this.lastStyleKey) {
      this.lastStyleKey = styleKey;
      this.sublayerCache.clear();
    }

    const sublayers: DeckLayer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer);
        if (!prepared) continue;
        const cached = this.sublayerCache.get(prepared.tileKey);
        if (
          cached &&
          cached.preparedKey === prepared &&
          cached.styleKey === styleKey
        ) {
          sublayers.push(cached.layer);
          continue;
        }
        const layer = this.buildSublayer(prepared);
        this.sublayerCache.set(prepared.tileKey, {
          layer,
          preparedKey: prepared,
          styleKey,
        });
        sublayers.push(layer);
      }
    }

    emit('renderLayers', {
      layer: 'VatTripsLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`VatTripsLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  /**
   * Build (or reuse the cached) per-tile VAT texture data + instance buffer.
   * Allocation is O(numTrips × timeSlots) per tile — runs once on first
   * sight of each tile and is reused for the lifetime of the tile in cache.
   */
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const tileKey = makeTileKey(tile, tileLayer);
    const slots = this.props.timeSlots ?? DEFAULT_TIME_SLOTS;
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.timeSlots === slots) {
      emit('tilePrepare', { layer: 'VatTripsLayer', tileKey, cached: true, ms: 0 });
      return cached;
    }

    const t0 = performance.now();
    const numTrips = Math.min(binary.featureCount, MAX_TRIPS_PER_TILE);
    if (numTrips < binary.featureCount) {
      warnOnce(
        `VatTripsLayer:cap:${tileKey}`,
        `[VatTripsLayer] tile ${tileKey} has ${binary.featureCount} trips; ` +
          `clamping to ${MAX_TRIPS_PER_TILE} (VatTripsLayer safety cap).`,
      );
    }

    // 2D-packed texture layout: pack up to `tripsPerRow` trips into each
    // texture row so we burn the full MAX_TEXTURE_DIM width budget instead
    // of leaving it idle. Height grows only as needed.
    const tripsPerRow = Math.max(1, Math.floor(MAX_TEXTURE_DIM / slots));
    const textureWidth = Math.min(numTrips, tripsPerRow) * slots;
    const textureHeight = Math.ceil(numTrips / tripsPerRow);

    // RG32F packing: 2 floats (lon, lat) per texel.
    const positionsData = new Float32Array(textureWidth * textureHeight * 2);
    resamplePositions(binary, slots, tripsPerRow, textureWidth, numTrips, positionsData);

    // Per-instance attribute buffers. We allocate a fresh tripRow array
    // (the others alias the tile's existing typed arrays, zero-copy).
    const tripRow = new Float32Array(numTrips);
    for (let i = 0; i < numTrips; i++) tripRow[i] = i;

    const data: VatTripsSublayerData = {
      length: numTrips,
      attributes: {
        instanceTripRow: { value: tripRow, size: 1 },
        // startTimes/endTimes are Float32Array on the tile — pass through
        // verbatim. They're relative to binary.timeOffset which matches
        // what the VS expects.
        instanceStartTime: {
          value:
            numTrips === binary.featureCount
              ? binary.startTimes
              : binary.startTimes.subarray(0, numTrips),
          size: 1,
        },
        instanceEndTime: {
          value:
            numTrips === binary.featureCount
              ? binary.endTimes
              : binary.endTimes.subarray(0, numTrips),
          size: 1,
        },
      },
    };

    const prepared: PreparedTile = {
      tileKey,
      positionsData,
      data,
      numTrips,
      width: textureWidth,
      height: textureHeight,
      timeOffset: binary.timeOffset,
      timeSlots: slots,
      tripsPerRow,
      tile,
      features: binary,
    };
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'VatTripsLayer',
      tileKey,
      cached: false,
      features: numTrips,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(
    prepared: PreparedTile,
  ): VatTripsSublayer | VatTripsTrailSublayer {
    // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
    const trailing = this.props.trailLength > 0;
    const sizeInMeters = this.props.sizeUnits === 'meters';

    if (trailing) {
      const color = (Array.isArray(this.props.trailColor)
        ? this.props.trailColor
        : DEFAULT_TRAIL_COLOR) as Color;
      // getSubLayerProps inheritance + user `_subLayerProps.trail` overrides.
      // pickable is forced false in sublayerProps (after inheritance, before
      // user overrides): the VAT shaders carry no picking module.
      const props = this.composeSubLayerProps('trail', prepared.tileKey, {
        data: prepared.data,
        dataComparator: (a: any, b: any) => a === b,
        pickable: false,
        positionsTextureData: prepared.positionsData,
        positionsTextureWidth: prepared.width,
        positionsTextureHeight: prepared.height,
        timeSlots: prepared.timeSlots,
        tripsPerRow: prepared.tripsPerRow,
        trailColor: color,
        trailLength: this.props.trailLength,
        trailSamples: this.props.trailSamples,
        tripWidth: this.props.tripWidth,
        sizeInMeters,
        widthMinPixels: this.props.widthMinPixels,
        widthMaxPixels: this.props.widthMaxPixels,
        fadeTrail: this.props.fadeTrail,
        timeOffset: prepared.timeOffset,
        getTime: this.boundGetTime,
        // opacity is not passed explicitly — getSubLayerProps inherits it.
        // Picking context (inert — see PreparedTile.tile), for family parity.
        tile: prepared.tile,
        sttFeatures: prepared.features,
      });
      const SubLayerClass = this.getSubLayerClass('trail', VatTripsTrailSublayer);
      return new SubLayerClass(props as any);
    }

    const color = (Array.isArray(this.props.headColor)
      ? this.props.headColor
      : DEFAULT_HEAD_COLOR) as Color;
    // getSubLayerProps inheritance + user `_subLayerProps.head` overrides.
    const props = this.composeSubLayerProps('head', prepared.tileKey, {
      data: prepared.data,
      // Identity comparator pairs with preparedTileCache: deck.gl short-
      // circuits the entire data-prop diff when the same reference comes back.
      dataComparator: (a: any, b: any) => a === b,
      pickable: false,
      positionsTextureData: prepared.positionsData,
      positionsTextureWidth: prepared.width,
      positionsTextureHeight: prepared.height,
      timeSlots: prepared.timeSlots,
      tripsPerRow: prepared.tripsPerRow,
      headColor: color,
      // In meters mode pass the meter radius (headRadius); else the pixel
      // value. The `||` chain is deliberate (headRadius defaults to 0 =
      // unset), unlike a dead `??` refetch.
      headRadiusPixels: sizeInMeters
        ? (this.props.headRadius || this.props.headRadiusPixels || 4)
        : this.props.headRadiusPixels,
      sizeInMeters,
      headRadiusMinPixels: this.props.headRadiusMinPixels,
      headRadiusMaxPixels: this.props.headRadiusMaxPixels,
      timeOffset: prepared.timeOffset,
      getTime: this.boundGetTime,
      // opacity is not passed explicitly — getSubLayerProps inherits it.
      // Picking context (inert — see PreparedTile.tile), for family parity.
      tile: prepared.tile,
      sttFeatures: prepared.features,
    });
    const SubLayerClass = this.getSubLayerClass('head', VatTripsSublayer);
    return new SubLayerClass(props as any);
  }
}
