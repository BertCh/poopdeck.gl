// FlowStrokeLayer — coherent merged DIRECTED corridors whose WIDTH breathes with
// the active hour's traveller count, drawn as twin offset ribbons.
//
// Built for the `bixi-corridors` demo (`stt-generate bixi --merged-paths`). Each
// corridor is one LineString in travel-direction vertex order carrying a
// per-vertex × per-hour volume matrix (`BinaryFeatures.vertexValueMatrix`). Like
// its parent {@link FlowCorridorLayer} it animates per-vertex COLOR by
// selecting/blending the active time-bucket column; on top of that it adds:
//
//   • WIDTH (`widthsFor`): per PATH (deck's PathLayer width is uniform along a
//     path), width = (corridor's busiest-vertex volume at the active, blended
//     bucket) ** `widthExponent`, so corridors swell at rush hour and thin
//     overnight. Corridors at/under `minFlow` collapse to width 0 — the same
//     "inactive → invisible" pulse FlowmapLayer uses. The width recomputes
//     exactly when the inherited `gradientStyleSuffix` changes (the playhead
//     crosses a sub-step); the geometry never re-uploads.
//
//   • OFFSET (`extraTripsExtensions` + `extraTripsSubLayerProps`): a
//     `PathStyleExtension({offset:true})` shifts each path perpendicular by
//     `offsetWidths × width`. Because A→B and B→A are SEPARATE strokes traversing
//     a shared two-way street in OPPOSITE vertex order, a constant offset lands
//     them on opposite sides — the twin ribbons that expose directional asymmetry
//     (inbound vs outbound rush). One-way pairs already sit on different streets.

import { PathStyleExtension } from '@deck.gl/extensions';
import type { DefaultProps } from '@deck.gl/core';
import { FlowCorridorLayer } from './flow-corridor-layer';
import type { FlowCorridorLayerProps } from './flow-corridor-layer';
import type { BinaryFeatures } from '@poopdeck.gl/core';

export type FlowStrokeLayerProps = {
  /**
   * Width = (active-bucket peak volume) ** `widthExponent`, before `widthScale`
   * and `widthMin/MaxPixels`. 0.5 (√) is area-proportional and the cartographic
   * default; lower flattens the busy/quiet contrast, higher exaggerates it.
   */
  widthExponent?: number;
  /** Corridors whose active-bucket peak volume is ≤ this render at width 0
   * (invisible) — the per-hour pulse. */
  minFlow?: number;
  /** Constant perpendicular offset, in multiples of the rendered width, applied
   * to every corridor (twin-ribbon separation). 0 disables the offset. */
  offsetWidths?: number;
};

export class FlowStrokeLayer<ExtraPropsT extends {} = {}> extends FlowCorridorLayer<
  ExtraPropsT & Required<FlowStrokeLayerProps>
> {
  static layerName = 'FlowStrokeLayer';

  static defaultProps: DefaultProps<FlowCorridorLayerProps & FlowStrokeLayerProps> = {
    ...FlowCorridorLayer.defaultProps,
    widthExponent: { type: 'number', value: 0.5, min: 0 },
    minFlow: { type: 'number', value: 0, min: 0 },
    offsetWidths: { type: 'number', value: 0.6 },
  };

  /** Stable singletons — deck caches compiled shader pipelines per extension
   * set, so the extension array reference must not change across renders. */
  private readonly _offsetExtension = new PathStyleExtension({ offset: true });
  private readonly _extensions: unknown[] = [this._offsetExtension];

  /** PER-VERTEX width = (active-bucket volume at that vertex) ** widthExponent
   * (0 when ≤ minFlow), so the trunk breathes with the hour AND tapers along its
   * length. Length `totalVerts`, aligned 1:1 with positions like the gradient
   * getColor buffer (PathLayer's stroke-width attribute is per-segment-instanced,
   * so a per-feature buffer under-sizes the draw). Reuses the parent's bucket
   * blend so width and colour stay in sync. */
  protected override widthsFor(
    binary: BinaryFeatures,
    featureCount: number,
  ): Float32Array | undefined {
    const nb = binary.vertexValueBuckets ?? 0;
    if (nb <= 0 || !binary.vertexValueMatrix || !binary.startIndices) return undefined;
    const totalVerts = binary.startIndices[featureCount];
    // Active-bucket (quantized + blended) per-vertex traveller counts — exactly
    // the values the inherited gradient colours the corridor with.
    const perVertex = this.gradientValuesFor(binary, totalVerts);
    if (!perVertex || perVertex.length < totalVerts) return undefined;

    const exp = this.props.widthExponent;
    const minFlow = this.props.minFlow;
    const widths = new Float32Array(totalVerts);
    for (let v = 0; v < totalVerts; v++) {
      const val = perVertex[v];
      widths[v] = val > minFlow ? Math.pow(val, exp) : 0;
    }
    return widths;
  }

  protected override extraTripsExtensions(): unknown[] {
    return this.props.offsetWidths ? this._extensions : super.extraTripsExtensions();
  }

  // Only drop the (idle) CategoryColorExtension when the PathStyleExtension offset
  // is actually installed — that trade frees a WebGL attribute slot for the offset
  // attribute. With offset disabled (the geometry-baked twin-ribbon path), keep
  // the base extension set so the sublayer matches the proven FlowCorridorLayer
  // shader layout exactly.
  protected override includeCategoryColorExtension(): boolean {
    return !this.props.offsetWidths;
  }

  protected override extraTripsSubLayerProps(): Record<string, unknown> {
    return this.props.offsetWidths
      ? { getOffset: this.props.offsetWidths }
      : super.extraTripsSubLayerProps();
  }
}
