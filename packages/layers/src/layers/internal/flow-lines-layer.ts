// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * FlowLinesLayer — a tapered **half-arrow** primitive, ported from
 * flowmap.gl's `FlowLinesLayer` (vis.gl) and adapted to STT's binary-tile
 * pipeline. One instance = one origin→destination flow.
 *
 * Each instance is a fixed 9-vertex template mesh (3 triangles) extruded in
 * the vertex shader into a straight shaft that tapers from the origin to a
 * triangular arrowhead at the destination. Geometry math (all in screen
 * pixels, mirroring deck.gl's own `LineLayer`):
 *  • the vertex is placed at `mix(source, target, positions.x)` on the
 *    centerline, then offset perpendicular by `positions.y · width` (shaft /
 *    arrowhead half-width) and along-travel by `positions.z · width`
 *    (arrowhead pull-back);
 *  • a constant `gap · width` perpendicular offset pushes the whole arrow to
 *    one side of the centerline, so the A→B and B→A flows of a pair sit
 *    side-by-side instead of overlapping (perpDir flips with direction);
 *  • per-instance `instanceEndpointOffsets` (pixels) inset the start/end along
 *    the line so the arrow begins/ends at the node-circle EDGE, not its center;
 *  • the along-travel + endpoint offsets are clamped to a fraction of the
 *    flow's pixel length so short flows don't self-overlap or overshoot.
 *
 * Unlike flowmap.gl (which feeds a normalized `instanceThickness∈[0,0.5]` ×
 * `thicknessUnit`), this layer takes **width directly per instance**
 * (`getWidth`, in `widthUnits`, default pixels) — the {@link FlowmapLayer}
 * already computes `widthScale·√flow` in pixels, so we keep that pipeline and
 * only swap the geometry from arc to arrow. A width of exactly **0 stays 0**
 * (`widthMinPixels` applies to ACTIVE flows only), which is what makes
 * FlowmapLayer's "below `minFlow` → invisible" animation work. Color is a
 * layer-uniform `mix(sourceColor → targetColor)` along the arrow (our colors
 * are constants, so no per-instance color attribute).
 *
 * PICKING / SHADER HOOKS: this is a fully custom-`Model` layer, so it calls the
 * `picking` module functions DIRECTLY (`picking_setPickingAttribute` +
 * `picking_setPickingColor` in the VS,
 * `picking_filterHighlightColor`/`picking_filterPickingColor` in the FS) rather
 * than going through deck's globally-registered `DECKGL_FILTER_*` shader hooks.
 * Deck wires picking through those hooks, but they live on a process-wide luma
 * `ShaderAssembler` singleton — which a bundler can DUPLICATE for a separately-
 * bundled package (e.g. a linked workspace lib), leaving the hooks undefined and
 * the shader failing to compile. Calling the module functions directly makes the
 * layer self-contained and bundler-agnostic. Trade-off: deck *extensions* that
 * inject into `DECKGL_FILTER_*` (DataFilter/TimeFilter/CategoryColor) do NOT
 * affect this layer's shaders — the injections are silently dropped, so the
 * composites STRIP `extensions` (with a one-time warning) instead of forwarding
 * an inert list; {@link FlowmapLayer} doesn't need them (its animation is CPU
 * matrix-width and its colors are constants).
 */

import { Layer, project32, picking } from '@deck.gl/core';
import type {
  Color,
  DefaultProps,
  LayerProps,
  LayerDataSource,
  Position,
  Accessor,
  UpdateParameters,
} from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';

/**
 * The 9-vertex (3-triangle) arrow template. Each vertex is
 * `(mix, perpendicular, alongTravel)` in WIDTH units:
 *  • `.x` lerp factor source(0) → target(1)
 *  • `.y` perpendicular offset (all ≥ 0 ⇒ a HALF arrow, one side of centerline)
 *  • `.z` along-travel offset (negative ⇒ pulled back toward the source)
 * Verts 1/2 (perp 2 / 1, travel −3) form the arrowhead flaring back from the
 * target tip; verts 3/4 sit at the source. Topology: triangle-list.
 */
// prettier-ignore
export const ARROW_TEMPLATE_POSITIONS = [
  1, 0, 0,
  1, 2, -3,
  1, 1, -3,
  1, 0, 0,
  1, 1, -3,
  0, 1, 0,
  1, 0, 0,
  0, 1, 0,
  0, 0, 0,
];

/**
 * deck's `UNIT` enum (`@deck.gl/core` `lib/constants.ts`), inlined so this
 * self-contained primitive needs no extra import to convert `widthUnits`.
 */
const UNIT: Record<'common' | 'meters' | 'pixels', number> = {
  common: 0,
  meters: 1,
  pixels: 2,
};

/** std140 uniform block — vec4 colors first (16-byte aligned), then scalars,
 * then the int (mirrors deck's own `lineUniforms` layout). */
const uniformBlock = /* glsl */ `\
layout(std140) uniform flowLinesUniforms {
  vec4 sourceColor;
  vec4 targetColor;
  float widthScale;
  float widthMinPixels;
  float widthMaxPixels;
  float gap;
  highp int widthUnits;
} flowLines;
`;

type FlowLinesUniforms = {
  sourceColor: [number, number, number, number];
  targetColor: [number, number, number, number];
  widthScale: number;
  widthMinPixels: number;
  widthMaxPixels: number;
  gap: number;
  widthUnits: number;
};

const flowLinesUniforms = {
  name: 'flowLines',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    sourceColor: 'vec4<f32>',
    targetColor: 'vec4<f32>',
    widthScale: 'f32',
    widthMinPixels: 'f32',
    widthMaxPixels: 'f32',
    gap: 'f32',
    widthUnits: 'i32',
  },
} as const;

const vs = /* glsl */ `\
#version 300 es
#define SHADER_NAME flow-lines-layer-vertex-shader

in vec3 positions;            // template (mix, perpendicular, alongTravel)
in vec3 instanceSourcePositions;
in vec3 instanceTargetPositions;
in vec3 instanceSourcePositions64Low;
in vec3 instanceTargetPositions64Low;
in float instanceWidth;       // widthUnits (default: pixels)
in vec2 instanceEndpointOffsets; // CSS pixels: [source inset, target inset]
in vec3 instancePickingColors;

out vec4 vColor;

void main(void) {
  geometry.worldPosition = instanceSourcePositions;
  geometry.worldPositionAlt = instanceTargetPositions;

  vec4 source_commonspace;
  vec4 target_commonspace;
  vec4 source = project_position_to_clipspace(instanceSourcePositions, instanceSourcePositions64Low, vec3(0.0), source_commonspace);
  vec4 target = project_position_to_clipspace(instanceTargetPositions, instanceTargetPositions64Low, vec3(0.0), target_commonspace);

  float mixT = positions.x;
  vec4 p = mix(source, target, mixT);
  geometry.position = mix(source_commonspace, target_commonspace, mixT);
  geometry.pickingColor = instancePickingColors;

  // Screen-space direction + length in CSS PIXELS. Unlike deck's own LineLayer
  // (which only normalize()s this delta) the MAGNITUDE is load-bearing here —
  // it bounds the arrowhead pull-back and the endpoint insets — so both
  // conversions have to be right:
  //  1. project_position_to_clipspace returns PRE-divide clip coords, so a
  //     perspective (pitched / globe) view needs the w divide before the delta
  //     means anything in NDC;
  //  2. project.viewportSize is in DEVICE pixels, while w, travelPx and
  //     instanceEndpointOffsets are CSS pixels — the unit
  //     project_pixel_size_to_clipspace consumes — so divide the DPR back out.
  vec2 cssPxPerNdc = project.viewportSize / (2.0 * project.devicePixelRatio);
  vec2 srcPx = (source.xy / max(source.w, 1e-4)) * cssPxPerNdc;
  vec2 tgtPx = (target.xy / max(target.w, 1e-4)) * cssPxPerNdc;
  vec2 deltaScreen = tgtPx - srcPx;
  float lenPx = max(length(deltaScreen), 1.0);
  vec2 flowDir = deltaScreen / lenPx;           // unit, source→target
  vec2 perpDir = vec2(-flowDir.y, flowDir.x);

  // Width → CSS pixels. A ZERO-width instance stays ZERO: widthMinPixels
  // applies to ACTIVE flows only, so FlowmapLayer's "flow below minFlow → width
  // 0 → invisible" contract survives the clamp (this IS the animation).
  // Mirrors BundledFlowLinesLayer's edgeWidth().
  float w = instanceWidth <= 0.0
    ? 0.0
    : clamp(
        project_size_to_pixel(instanceWidth * flowLines.widthScale, flowLines.widthUnits),
        flowLines.widthMinPixels,
        flowLines.widthMaxPixels);

  // Perpendicular: half-width (shaft / arrowhead) + a constant gap so the two
  // directions of a pair sit side-by-side (perpDir flips when direction flips).
  float perpPx = positions.y * w + flowLines.gap * w;
  // Along-travel arrowhead pull-back, clamped so short flows don't overshoot.
  float travelPx = clamp(positions.z * w, -0.8 * lenPx, 0.8 * lenPx);
  // Inset the start/end toward each other by the node-circle radii (pixels),
  // clamped so a short flow's arrowhead never crosses its origin.
  float endpointPx = mix(
    clamp(instanceEndpointOffsets.x, 0.0, 0.4 * lenPx),
   -clamp(instanceEndpointOffsets.y, 0.0, 0.4 * lenPx),
    mixT);

  vec3 offset = vec3(perpDir * perpPx + flowDir * (travelPx + endpointPx), 0.0);

  gl_Position = p + vec4(project_pixel_size_to_clipspace(offset.xy), 0.0, 0.0);

  // Picking: propagate the per-instance picking color AND the picking depth
  // ourselves, in deck's own order (the depth attribute writes .r first, the
  // color pass then writes .a). Deck normally injects these at
  // vs:DECKGL_FILTER_GL_POSITION / vs:DECKGL_FILTER_COLOR; see the file
  // docstring on why we don't use those hooks.
  picking_setPickingAttribute(gl_Position.z / gl_Position.w);
  picking_setPickingColor(geometry.pickingColor);

  vColor = mix(flowLines.sourceColor, flowLines.targetColor, mixT);
  vColor = vec4(vColor.rgb, vColor.a * layer.opacity);
}
`;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME flow-lines-layer-fragment-shader
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main(void) {
  fragColor = vColor;
  // Picking highlight + picking-FBO color, applied directly (see file docstring).
  fragColor = picking_filterHighlightColor(fragColor);
  fragColor = picking_filterPickingColor(fragColor);
}
`;

/** Complete props for {@link FlowLinesLayer}. */
export type FlowLinesLayerProps<DataT = unknown> = _FlowLinesLayerProps<DataT> &
  LayerProps;

/** Props added by {@link FlowLinesLayer}. */
type _FlowLinesLayerProps<DataT> = {
  data: LayerDataSource<DataT>;
  /** Origin position accessor (`[lng, lat]` / `[lng, lat, z]`). */
  getSourcePosition?: Accessor<DataT, Position>;
  /** Destination position accessor. */
  getTargetPosition?: Accessor<DataT, Position>;
  /**
   * Per-flow width in {@link widthUnits} (already scaled; not normalized).
   * A width of exactly `0` renders NOTHING — `widthMinPixels` does not lift it
   * (that is how {@link FlowmapLayer} hides sub-`minFlow` corridors).
   * @default 1
   */
  getWidth?: Accessor<DataT, number>;
  /**
   * Per-flow `[sourceInset, targetInset]` in CSS pixels — how far the arrow's
   * start/end are pulled in along the line so they land on the node-circle
   * edge rather than its center. @default [0, 0]
   */
  getEndpointOffsets?: Accessor<DataT, [number, number]>;
  /** Origin (tail) color. @default [0, 150, 255, 255] */
  sourceColor?: Color;
  /** Destination (arrowhead) color. @default [255, 127, 14, 255] */
  targetColor?: Color;
  /**
   * Units of `getWidth`, matching deck's `LineLayer.widthUnits`. `'pixels'`
   * keeps a constant on-screen thickness; `'meters'`/`'common'` scale with the
   * map. @default 'pixels'
   */
  widthUnits?: 'meters' | 'common' | 'pixels';
  /**
   * Multiplier applied to `getWidth` before the pixel clamp. Zero-width
   * (inactive) flows stay invisible whatever the scale. @default 1
   */
  widthScale?: number;
  /** Clamp width to at least this many pixels (ACTIVE flows only). @default 0 */
  widthMinPixels?: number;
  /** Clamp width to at most this many pixels. @default Number.MAX_SAFE_INTEGER */
  widthMaxPixels?: number;
  /**
   * Constant perpendicular separation between the two directions of a pair, in
   * units of the arrow width. @default 0.5
   */
  gap?: number;
};

const DEFAULT_SOURCE_COLOR: Color = [0, 150, 255, 255];
const DEFAULT_TARGET_COLOR: Color = [255, 127, 14, 255];

const defaultProps: DefaultProps<FlowLinesLayerProps> = {
  getSourcePosition: { type: 'accessor', value: (d: any) => d.sourcePosition },
  getTargetPosition: { type: 'accessor', value: (d: any) => d.targetPosition },
  getWidth: { type: 'accessor', value: 1 },
  getEndpointOffsets: { type: 'accessor', value: [0, 0] },
  sourceColor: { type: 'color', value: DEFAULT_SOURCE_COLOR },
  targetColor: { type: 'color', value: DEFAULT_TARGET_COLOR },
  widthUnits: 'pixels',
  widthScale: { type: 'number', value: 1, min: 0 },
  widthMinPixels: { type: 'number', value: 0, min: 0 },
  widthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
  gap: { type: 'number', value: 0.5, min: 0 },
};

/** Normalize a {@link Color} (0..255, optional alpha) to a 0..1 vec4. */
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
 * Instanced tapered-arrow layer. See the file docstring for the geometry.
 */
export class FlowLinesLayer<
  DataT = any,
  ExtraProps extends {} = {},
> extends Layer<ExtraProps & Required<_FlowLinesLayerProps<DataT>>> {
  static layerName = 'FlowLinesLayer';
  static defaultProps = defaultProps;

  declare state: {
    model?: Model;
  };

  getShaders() {
    return super.getShaders({
      vs,
      fs,
      modules: [project32, picking, flowLinesUniforms],
    });
  }

  getBounds(): [number[], number[]] | null {
    return (
      this.getAttributeManager()?.getBounds([
        'instanceSourcePositions',
        'instanceTargetPositions',
      ]) ?? null
    );
  }

  // Straight flows: each pair handled explicitly, no antimeridian wrap logic.
  get wrapLongitude(): boolean {
    return false;
  }

  initializeState(): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.addInstanced({
      instanceSourcePositions: {
        size: 3,
        type: 'float64',
        fp64: this.use64bitPositions(),
        transition: true,
        accessor: 'getSourcePosition',
      },
      instanceTargetPositions: {
        size: 3,
        type: 'float64',
        fp64: this.use64bitPositions(),
        transition: true,
        accessor: 'getTargetPosition',
      },
      instanceWidth: {
        size: 1,
        transition: true,
        accessor: 'getWidth',
        defaultValue: 1,
      },
      instanceEndpointOffsets: {
        size: 2,
        accessor: 'getEndpointOffsets',
        defaultValue: [0, 0],
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
    const flowLinesProps: FlowLinesUniforms = {
      sourceColor: toVec4(this.props.sourceColor, DEFAULT_SOURCE_COLOR),
      targetColor: toVec4(this.props.targetColor, DEFAULT_TARGET_COLOR),
      widthScale: this.props.widthScale,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      gap: this.props.gap,
      widthUnits: UNIT[this.props.widthUnits] ?? UNIT.pixels,
    };
    model.shaderInputs.setProps({ flowLines: flowLinesProps });
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
            size: 3,
            value: new Float32Array(ARROW_TEMPLATE_POSITIONS),
          },
        },
      }),
      isInstanced: true,
    });
  }
}
