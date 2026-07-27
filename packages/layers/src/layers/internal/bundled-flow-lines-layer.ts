// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * BundledFlowLinesLayer — renders the bundled rivers produced by
 * {@link EdgeBundler} as fully **GPU-resident** ribbons. The bundled control
 * points never leave the GPU: each instance is one *segment* of one edge, and
 * the vertex shader `texelFetch`es that segment's two control points straight
 * from the bundler's position texture. Per-edge WIDTH is likewise sampled on the
 * GPU from a per-tile `vertexValueMatrix` texture at the live playhead bucket —
 * so the arrows swell and recede at 60 fps with zero per-frame CPU work and no
 * cross-fade quantization (the trade-off {@link FlowmapLayer} makes on the CPU).
 *
 * Geometry: a constant-width half-ribbon per segment (offset to one side by
 * `gap` so A→B and B→A sit side-by-side, like {@link FlowLinesLayer}), colored
 * by a source→target gradient along the whole edge — the gradient conveys
 * direction in place of a per-segment arrowhead, which reads better on dense
 * bundles. Instances are `edgeCount × (P − 1)` segments; the two driving
 * attributes are just the edge and segment indices.
 *
 * PICKING: like {@link FlowLinesLayer}, this is a custom-`Model` layer that
 * calls the `picking` module directly (no `DECKGL_FILTER_*` hooks). The pick
 * color is computed in the vertex shader from the EDGE index using deck's
 * standard encoding, so every segment of an edge shares one id and deck decodes
 * `info.index` back to the feature index that
 * {@link SpatioTemporalLayer.getPickingInfo} resolves against the tile columns.
 *
 * Coordinates: the bundler stores `u = (lon·cosLat0, lat)`; this shader undoes
 * the longitude scale (`lon = u.x / cosLat0`) and reuses deck's
 * `project_position_to_clipspace`, so it works in MapView and GlobeView alike.
 */

import { Layer, project32, picking } from '@deck.gl/core';
import type {
  Accessor,
  Color,
  DefaultProps,
  LayerProps,
  UpdateParameters,
} from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';
import type { Texture } from '@luma.gl/core';
import type { BundlePositions } from '../../lib/edge-bundler.js';

/**
 * Per-segment ribbon template, `(mix, side)`:
 *  • `mix` 0→1 walks from control point i to i+1 along the segment;
 *  • `side` 0/1 is the perpendicular offset (centerline → +width), a half-ribbon
 *    on one side of the centerline (the `gap` shifts the whole ribbon).
 * Two triangles (a parallelogram) per segment.
 */
// prettier-ignore
export const RIBBON_TEMPLATE_POSITIONS = [
  0, 0,
  0, 1,
  1, 1,
  0, 0,
  1, 1,
  1, 0,
];

// Block name MUST be `<moduleName>Uniforms` (module name is 'bundled' below) —
// luma derives the UBO binding name from the module name.
const uniformBlock = /* glsl */ `\
layout(std140) uniform bundledUniforms {
  vec4 sourceColor;
  vec4 targetColor;
  float cosLat0;
  float originX;
  float originY;
  float invScale;
  float gap;
  float segments;
  float widthScale;
  float minFlow;
  float widthMinPixels;
  float widthMaxPixels;
  float numBuckets;
  float bucketPos;
} bundled;

uniform sampler2D bundled_positionTexture;   // P × E control points (work space)
uniform sampler2D bundled_matrixTexture;     // numBuckets × E per-edge flow
`;

type BundledFlowUniforms = {
  sourceColor: [number, number, number, number];
  targetColor: [number, number, number, number];
  cosLat0: number;
  originX: number;
  originY: number;
  invScale: number;
  gap: number;
  segments: number;
  widthScale: number;
  minFlow: number;
  widthMinPixels: number;
  widthMaxPixels: number;
  numBuckets: number;
  bucketPos: number;
};

const bundledFlowUniforms = {
  name: 'bundled',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    sourceColor: 'vec4<f32>',
    targetColor: 'vec4<f32>',
    cosLat0: 'f32',
    originX: 'f32',
    originY: 'f32',
    invScale: 'f32',
    gap: 'f32',
    segments: 'f32',
    widthScale: 'f32',
    minFlow: 'f32',
    widthMinPixels: 'f32',
    widthMaxPixels: 'f32',
    numBuckets: 'f32',
    bucketPos: 'f32',
  },
} as const;

const vs = /* glsl */ `\
#version 300 es
#define SHADER_NAME bundled-flow-lines-layer-vertex-shader

in vec2 positions;            // ribbon template (mix, side)
in float instanceEdgeIndex;
in float instanceSegmentIndex;

out vec4 vColor;
out float vAcross;            // perpendicular position within the band [0,1]
out float vBandPx;            // ribbon width in px (for edge antialiasing)

// Reconstruct lon/lat from the bundler's work space (undo the WORK_SIZE-box
// normalization, then the cosLat correction), and project through deck.
vec4 projectU(vec2 work, out vec4 commonspace) {
  vec2 corrected = work * bundled.invScale + vec2(bundled.originX, bundled.originY);
  vec2 lngLat = vec2(corrected.x / bundled.cosLat0, corrected.y);
  return project_position_to_clipspace(vec3(lngLat, 0.0), vec3(0.0), vec3(0.0), commonspace);
}

// Per-edge width (px) from the flow matrix at the live bucket; 0 when inactive.
float edgeWidth(int edge) {
  float bucket = clamp(bundled.bucketPos, 0.0, bundled.numBuckets - 1.0);
  int b0 = int(floor(bucket));
  int b1 = min(b0 + 1, int(bundled.numBuckets) - 1);
  float f = bucket - float(b0);
  float flow = mix(
    texelFetch(bundled_matrixTexture, ivec2(b0, edge), 0).r,
    texelFetch(bundled_matrixTexture, ivec2(b1, edge), 0).r,
    f);
  if (flow <= bundled.minFlow) return 0.0;
  return clamp(bundled.widthScale * sqrt(flow), bundled.widthMinPixels, bundled.widthMaxPixels);
}

// deck's standard index→picking-color encoding (so info.index decodes to edge).
// Returns BYTE components (0..255), NOT 0..1: picking_setPickingColor divides
// by 255 itself (deck sets the picking module's useByteColors uniform true),
// exactly as it does for the instancePickingColors attribute deck's own layers
// feed it. Normalizing here as well quantized every id to [0,0,0] in the 8-bit
// picking FBO ("nothing picked") and put autoHighlight off by 255x.
vec3 encodePick(int index) {
  float i = float(index) + 1.0;
  return vec3(
    mod(i, 256.0),
    mod(floor(i / 256.0), 256.0),
    mod(floor(i / 65536.0), 256.0)
  );
}

void main(void) {
  int edge = int(instanceEdgeIndex + 0.5);
  int seg = int(instanceSegmentIndex + 0.5);
  float mixT = positions.x;   // 0 = this segment's start point, 1 = its end point
  float sideT = positions.y;

  // Each vertex sits EXACTLY on a control point (seg or seg+1). We offset it
  // along a MITER normal averaged from the point's two adjacent segments, so
  // consecutive ribbon quads share their offset vertices — a continuous ribbon
  // with no gaps on the outside of bends (the curved bundles have many).
  int lastIdx = int(bundled.segments + 0.5);           // P - 1
  int pIdx = seg + int(mixT + 0.5);
  int iPrev = max(pIdx - 1, 0);
  int iNext = min(pIdx + 1, lastIdx);

  vec2 uPrev = texelFetch(bundled_positionTexture, ivec2(iPrev, edge), 0).xy;
  vec2 uCur  = texelFetch(bundled_positionTexture, ivec2(pIdx,  edge), 0).xy;
  vec2 uNext = texelFetch(bundled_positionTexture, ivec2(iNext, edge), 0).xy;

  vec4 cPrev, cCur, cNext;
  vec4 clipPrev = projectU(uPrev, cPrev);
  vec4 clipCur  = projectU(uCur,  cCur);
  vec4 clipNext = projectU(uNext, cNext);

  // Screen-space incoming/outgoing directions at this control point.
  vec2 vp = project.viewportSize;
  vec2 dIn  = (clipCur.xy  - clipPrev.xy) * vp;
  vec2 dOut = (clipNext.xy - clipCur.xy)  * vp;
  float lIn = length(dIn), lOut = length(dOut);
  vec2 dirIn  = lIn  > 1e-4 ? dIn  / lIn  : (lOut > 1e-4 ? dOut / lOut : vec2(1.0, 0.0));
  vec2 dirOut = lOut > 1e-4 ? dOut / lOut : dirIn;

  vec2 pIn  = vec2(-dirIn.y,  dirIn.x);
  vec2 pOut = vec2(-dirOut.y, dirOut.x);
  vec2 mSum = pIn + pOut;
  float msl = length(mSum);
  vec2 miter = msl > 1e-3 ? mSum / msl : pOut;
  // Miter length keeps the ribbon width constant through a bend. A TIGHT limit
  // (≤1.5×) is essential: an unclamped miter shoots a long spike out of every
  // sharp bend in the bundled polyline. Past the limit the join bevels (a small
  // notch) instead of spiking.
  float ml = msl > 1e-3 ? min(1.0 / max(dot(miter, pOut), 0.6), 1.5) : 1.0;
  vec2 perp = miter * ml;

  float w = edgeWidth(edge);
  float perpPx = sideT * w + bundled.gap * w;
  vec3 offset = vec3(perp * perpPx, 0.0);

  gl_Position = clipCur + vec4(project_pixel_size_to_clipspace(offset.xy), 0.0, 0.0);

  // Direction-as-color: position along the WHOLE edge.
  float globalT = float(pIdx) / max(bundled.segments, 1.0);
  vColor = mix(bundled.sourceColor, bundled.targetColor, globalT);
  // Inactive edges (zero current flow) collapse to fully transparent.
  vColor.a = (w <= 0.0) ? 0.0 : vColor.a * layer.opacity;

  vAcross = sideT;
  vBandPx = w;

  picking_setPickingColor(encodePick(edge));
}
`;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME bundled-flow-lines-layer-fragment-shader
precision highp float;
in vec4 vColor;
in float vAcross;
in float vBandPx;
out vec4 fragColor;
void main(void) {
  if (vColor.a <= 0.0) discard;
  // ~1px edge antialiasing across the ribbon band (centered on the geometric
  // edge), so the bundled lines read crisp instead of hard-aliased.
  float edgePx = min(vAcross, 1.0 - vAcross) * vBandPx;
  float aa = clamp(edgePx + 0.5, 0.0, 1.0);
  fragColor = vec4(vColor.rgb, vColor.a * aa);
  fragColor = picking_filterHighlightColor(fragColor);
  fragColor = picking_filterPickingColor(fragColor);
}
`;

/** Complete props for {@link BundledFlowLinesLayer}. */
export type BundledFlowLinesLayerProps = _BundledFlowLinesLayerProps &
  LayerProps;

type _BundledFlowLinesLayerProps = {
  /**
   * Binary `data` of length `edgeCount × (P − 1)` carrying the driving
   * `instanceEdgeIndex` / `instanceSegmentIndex` attributes (built once per
   * bundle by the composite).
   */
  data: {
    length: number;
    attributes: Record<string, { value: Float32Array; size: number }>;
  };
  /**
   * The bundle whose `positionTexture` is bound every draw — either the live
   * {@link EdgeBundler} (still relaxing) or a baked {@link StaticBundle}.
   */
  bundler: BundlePositions | null;
  /** Per-edge flow matrix texture (`numBuckets × edgeCount`, R32F). */
  matrixTexture: Texture | null;
  /** Number of segments per edge (`P − 1`). */
  segments: number;
  /** Number of time buckets in the matrix. */
  numBuckets: number;
  /** Absolute time (ms) of bucket 0's left edge. */
  bucket0Abs: number;
  /** Bucket width in ms. */
  bucketWidth: number;
  /**
   * Live playhead accessor — read every draw so width animates without
   * setState. Declared `compare: false` (see `defaultProps`): the composite
   * hands over a fresh closure every render and a diffing comparator would
   * rebuild the layer on every frame. CONSEQUENCE: swapping in a genuinely
   * DIFFERENT clock source is invisible to deck's prop diff — nothing
   * invalidates, and the layer keeps calling the new closure only because it
   * reads `this.props.getCurrentTime` at draw time. If a caller ever needs a
   * clock swap to invalidate other state, bump a sibling version prop.
   */
  getCurrentTime: () => number;
  /** Per-segment edge index (binary attribute; declared so deck resolves it). */
  getEdgeIndex?: Accessor<unknown, number>;
  /** Per-segment within-edge index (binary attribute). */
  getSegmentIndex?: Accessor<unknown, number>;
  sourceColor?: Color;
  targetColor?: Color;
  widthScale?: number;
  minFlow?: number;
  widthMinPixels?: number;
  widthMaxPixels?: number;
  gap?: number;
};

const DEFAULT_SOURCE_COLOR: Color = [56, 196, 232, 235];
const DEFAULT_TARGET_COLOR: Color = [255, 142, 64, 245];

const defaultProps: DefaultProps<BundledFlowLinesLayerProps> = {
  bundler: { type: 'object', value: null, compare: false },
  matrixTexture: { type: 'object', value: null, compare: false },
  segments: { type: 'number', value: 1, min: 1 },
  numBuckets: { type: 'number', value: 1, min: 1 },
  bucket0Abs: { type: 'number', value: 0 },
  bucketWidth: { type: 'number', value: 1, min: 0 },
  // `compare: false` — a per-frame clock closure must never register as a prop
  // change. The trade-off (a real clock swap never invalidates) is documented
  // on the prop above.
  getCurrentTime: { type: 'function', value: () => 0, compare: false },
  getEdgeIndex: { type: 'accessor', value: 0 },
  getSegmentIndex: { type: 'accessor', value: 0 },
  sourceColor: { type: 'object', value: DEFAULT_SOURCE_COLOR, compare: true },
  targetColor: { type: 'object', value: DEFAULT_TARGET_COLOR, compare: true },
  widthScale: { type: 'number', value: 1.1, min: 0 },
  minFlow: { type: 'number', value: 0.25, min: 0 },
  widthMinPixels: { type: 'number', value: 1, min: 0 },
  widthMaxPixels: { type: 'number', value: 12, min: 0 },
  gap: { type: 'number', value: 0.5, min: 0 },
};

function toVec4(
  color: Color | undefined,
  fallback: Color,
): [number, number, number, number] {
  const c = (color ?? fallback) as unknown as number[];
  return [
    (c[0] ?? 0) / 255,
    (c[1] ?? 0) / 255,
    (c[2] ?? 0) / 255,
    (c[3] ?? 255) / 255,
  ];
}

/**
 * GPU-resident bundled-ribbon layer. See the file docstring for the geometry and
 * the fully-on-GPU width/position sampling.
 */
export class BundledFlowLinesLayer extends Layer<
  Required<_BundledFlowLinesLayerProps>
> {
  static layerName = 'BundledFlowLinesLayer';
  static defaultProps = defaultProps;

  declare state: { model?: Model };

  getShaders() {
    return super.getShaders({
      vs,
      fs,
      modules: [project32, picking, bundledFlowUniforms],
    });
  }

  // Bundled rivers are explicit per-segment geometry; no antimeridian wrap.
  get wrapLongitude(): boolean {
    return false;
  }

  initializeState(): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.addInstanced({
      instanceEdgeIndex: { size: 1, accessor: 'getEdgeIndex', defaultValue: 0 },
      instanceSegmentIndex: {
        size: 1,
        accessor: 'getSegmentIndex',
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
    const { bundler, matrixTexture } = this.props;
    if (!bundler || !matrixTexture) return;

    // Live playhead → continuous bucket position (no quantization).
    const time = this.props.getCurrentTime();
    let bucketPos =
      this.props.bucketWidth > 0
        ? (time - this.props.bucket0Abs) / this.props.bucketWidth
        : 0;
    const maxBucket = this.props.numBuckets - 1;
    if (bucketPos < 0) bucketPos = 0;
    if (bucketPos > maxBucket) bucketPos = maxBucket;

    const uniforms: BundledFlowUniforms = {
      sourceColor: toVec4(this.props.sourceColor, DEFAULT_SOURCE_COLOR),
      targetColor: toVec4(this.props.targetColor, DEFAULT_TARGET_COLOR),
      cosLat0: bundler.cosLat0,
      originX: bundler.originX,
      originY: bundler.originY,
      invScale: 1 / bundler.scale,
      gap: this.props.gap,
      segments: this.props.segments,
      widthScale: this.props.widthScale,
      minFlow: this.props.minFlow,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      numBuckets: this.props.numBuckets,
      bucketPos,
    };
    model.shaderInputs.setProps({ bundled: uniforms });
    // Bind the bundler's CURRENT ping-pong texture (it changes while bundling).
    model.setBindings({
      bundled_positionTexture: bundler.positionTexture,
      bundled_matrixTexture: matrixTexture,
    });
    model.draw(this.context.renderPass);
  }

  protected _getModel(): Model {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions: {
            size: 2,
            value: new Float32Array(RIBBON_TEMPLATE_POSITIONS),
          },
        },
      }),
      isInstanced: true,
    });
  }
}
