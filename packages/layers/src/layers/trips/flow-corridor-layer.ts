// FlowCorridorLayer — animate a static-geometry overview whose per-vertex color
// is a TIME SERIES, not a single scalar.
//
// A flow-corridor tile stores its street geometry ONCE and carries a per-vertex
// × per-time-bucket value matrix (`BinaryFeatures.vertexValueMatrix`, flattened
// globally vertex-major; `vertexValueBuckets` columns). The geometry never
// re-uploads as the playhead advances; only the per-vertex COLOR changes.
//
// This subclass keeps all of AnimatedTripsLayer's tile caching / sublayer
// plumbing and overrides a few seams:
//
//   • `gradientValuesFor` — instead of the static `vertexValues` channel, select
//     the active bucket column(s) from the matrix. Default: blend the two
//     adjacent buckets. Under `chevronPerTripLight`: a rolling-window MEAN (the
//     AGGREGATE "overall style over a granular period" signal) → the ramp RGB.
//   • `finalizeGradientColorBuffer` — under `chevronPerTripLight`, pack a SECOND
//     per-vertex signal (INSTANTANEOUS per-trip flow, a short trailing decay of
//     the nearest fine bucket) into the color's ALPHA byte, so the chevron shader
//     can "light up" arrows as individual trips pass — no extra GPU attribute.
//   • `gradientStyleSuffix` — fold the quantized playhead position into the
//     prepared-tile `styleKey` so both signals re-expand together when the
//     playhead crosses a sub-step (and ONLY then).
//   • `chevronDirectionsFor` — per-vertex CONTINUOUS signed net-flow direction
//     ∈ [-1,1] (a rolling directional-COHERENCE ratio) carried in the reused
//     `instanceVertexTime` slot; the shader morphs arrow shape/hue/march smoothly
//     with it (">" → flat dash → "<"), no hard flip.
//
// `_handleTimeUpdate` forces a `renderLayers()` pass (via `setState`) whenever
// the quantized position changes — the base trips layer is redraw-only on time.
//
// This is the "A1" renderer: the CPU blend re-expands at the sub-step rate
// (~`1/STEP` updates per bucket). The aspirational GPU "A2" two-sample lerp is
// not implemented.

import type { DefaultProps } from '@deck.gl/core';
import { AnimatedTripsLayer } from './animated-trips-layer.js';
import type { AnimatedTripsLayerProps } from './animated-trips-layer.js';
import { bucketBlendAt, blendMatrixRow } from '../../lib/vertex-value-blend.js';
import type { BinaryFeatures } from '@poopdeck.gl/core';

/** Props added by {@link FlowCorridorLayer} (own props only — compose with
 * {@link AnimatedTripsLayerProps} via {@link FlowCorridorLayerProps}). */
export interface _FlowCorridorLayerProps {
  /**
   * The value matrix is SIGNED (per-bucket direction encoding from
   * `bixi --streets --per-bucket-direction`): |value| is the volume (drives
   * colour) and the sign is the bucket's travel direction (drives the chevron
   * flip). Off → the matrix is plain magnitude.
   * @default false
   */
  signedFlow?: boolean;
  /**
   * Two-signal per-trip effect (dual-set with
   * `ChevronFlowExtension({ perTripLight: true })`): the gradient ramp shows a
   * rolling-window AGGREGATE and the color's ALPHA byte carries the
   * INSTANTANEOUS per-trip flow, so chevrons "light up" as individual trips
   * pass.
   * @default false
   */
  chevronPerTripLight?: boolean;
  /** AGGREGATE rolling-window HALF-span in ms of data time. @default 240000 (±4 min). */
  chevronAggregateWindowMs?: number;
  /** INSTANT normalization top (trailing-sum value that reads as a full flash). @default 1.5 */
  chevronInstantDomain?: number;
  /** INSTANT trailing-decay time constant in ms of data time. @default 120000 (2 min). */
  chevronInstantDecayMs?: number;
  /**
   * CONTINUOUS-DIRECTION rolling-window HALF-span, ms of data time. `0`
   * (default) inherits {@link chevronAggregateWindowMs} so direction and
   * volume share a temporal resolution.
   * @default 0
   */
  chevronDirectionWindowMs?: number;
}

/** Complete props accepted by {@link FlowCorridorLayer}. */
export type FlowCorridorLayerProps = _FlowCorridorLayerProps & AnimatedTripsLayerProps;

export class FlowCorridorLayer<ExtraPropsT extends {} = {}> extends AnimatedTripsLayer<
  ExtraPropsT & Required<_FlowCorridorLayerProps>
> {
  static layerName = 'FlowCorridorLayer';

  static defaultProps: DefaultProps<FlowCorridorLayerProps> = {
    ...AnimatedTripsLayer.defaultProps,
    signedFlow: false,
    chevronPerTripLight: false,
    chevronAggregateWindowMs: { type: 'number', value: 240000, min: 0 },
    chevronInstantDomain: { type: 'number', value: 1.5, min: 0 },
    chevronInstantDecayMs: { type: 'number', value: 120000, min: 0 },
    chevronDirectionWindowMs: { type: 'number', value: 0, min: 0 },
  };

  /**
   * Cross-fade granularity, in fractions of a bucket. 0.5 ⇒ 2 sub-steps per
   * bucket. At the FINE (1-min) buckets `chevronPerTripLight` targets, a smaller
   * STEP would re-expand the two per-vertex signals ~24×/bucket (heavy CPU);
   * 0.5 keeps that near the coarse-bucket cost (~5 Hz wall) while the aggregate
   * is pre-smoothed by its rolling window and the instant flash rides a trailing
   * decay, so neither looks steppy. Drop toward 0.25 if the aggregate fade reads
   * steppy on the target hardware.
   */
  private static readonly STEP = 0.5;

  // Global bucket axis, cached from the first matrix tile seen. All flow tiles
  // share one axis (every corridor spans the whole range), so a single cache
  // serves the time-driven `setState` gate in `_handleTimeUpdate`.
  private _bucket0Abs = 0;
  private _bucketWidth = 0;
  private _numBuckets = 0;
  /** Last quantized sub-step we forced a render for (-1 = none yet). */
  private _lastStep = -1;

  /** See {@link _FlowCorridorLayerProps.signedFlow}. */
  private get signedFlow(): boolean {
    return !!this.props.signedFlow;
  }

  /**
   * True under the two-signal per-trip effect (`chevronPerTripLight` prop,
   * dual-set with `ChevronFlowExtension({ perTripLight: true })`): `gradientValuesFor`
   * emits a rolling-window AGGREGATE (→ ramp RGB) and `finalizeGradientColorBuffer`
   * packs the INSTANTANEOUS per-trip flow into the color's ALPHA byte.
   */
  private get perTripLight(): boolean {
    return !!this.props.chevronPerTripLight;
  }

  /** AGGREGATE rolling-window HALF-span in ms of data time. */
  private get aggregateWindowMs(): number {
    return this.props.chevronAggregateWindowMs ?? 240000;
  }

  /** INSTANT normalization top (trailing-sum value that reads as a full flash). */
  private get instantDomain(): number {
    const d = this.props.chevronInstantDomain ?? 1.5;
    return d > 0 ? d : 1.5;
  }

  /** INSTANT trailing-decay time constant in ms of data time. */
  private get instantDecayMs(): number {
    return this.props.chevronInstantDecayMs ?? 120000;
  }

  /**
   * CONTINUOUS-DIRECTION rolling-window HALF-span, ms of data time. The signed
   * net-flow coherence that drives the smooth chevron direction is averaged over
   * this window; defaults to the aggregate window so direction and volume share a
   * temporal resolution (the AGGREGATE dominates direction).
   */
  private get directionWindowMs(): number {
    const d = this.props.chevronDirectionWindowMs;
    return d && d > 0 ? d : this.aggregateWindowMs;
  }

  /**
   * Continuous bucket position in `[0, numBuckets - 1]` for an absolute time,
   * computed directly from a tile's `BinaryFeatures` (self-contained so the two
   * prepare-time hooks always agree within a frame). `null` when the tile
   * carries no usable matrix axis.
   */
  private posFromBinary(binary: BinaryFeatures, time: number): number | null {
    const nb = binary.vertexValueBuckets ?? 0;
    if (nb <= 0 || !binary.startTimes || binary.startTimes.length === 0) return null;
    const rel0 = binary.startTimes[0]; // relative to timeOffset (0 for flows)
    const span = binary.endTimes[0] - rel0;
    if (span <= 0) return null;
    const width = span / nb;
    const rel = time - binary.timeOffset - rel0;
    let pos = rel / width;
    if (pos < 0) pos = 0;
    const max = nb - 1;
    if (pos > max) pos = max;
    return pos;
  }

  /** Cache the global bucket axis from the first matrix tile (idempotent). */
  private noteAxis(binary: BinaryFeatures): void {
    if (this._numBuckets > 0) return;
    const nb = binary.vertexValueBuckets ?? 0;
    if (nb <= 0 || !binary.startTimes || binary.startTimes.length === 0) return;
    const rel0 = binary.startTimes[0];
    const span = binary.endTimes[0] - rel0;
    if (span <= 0) return;
    this._numBuckets = nb;
    this._bucketWidth = span / nb;
    this._bucket0Abs = binary.timeOffset + rel0;
  }

  protected override gradientValuesFor(
    binary: BinaryFeatures,
    totalVerts: number,
  ): Float32Array | undefined {
    const nb = binary.vertexValueBuckets ?? 0;
    const matrix = binary.vertexValueMatrix;
    // Not a matrix tile (or malformed) — fall back to the static scalar channel.
    if (nb <= 0 || !matrix || matrix.length < totalVerts * nb) {
      return super.gradientValuesFor(binary, totalVerts);
    }
    this.noteAxis(binary);
    const pos = this.posFromBinary(binary, this.getCurrentTime()) ?? 0;
    const signed = this.signedFlow;
    const out = new Float32Array(totalVerts);

    // AGGREGATE: a rolling-window MEAN of |value| centered on the playhead — the
    // "accumulated style over a granular period" signal that drives the ramp
    // colour (the INSTANT flash rides the alpha byte in finalizeGradientColorBuffer).
    if (this.perTripLight) {
      const bucketWidth = (binary.endTimes[0] - binary.startTimes[0]) / nb;
      const w = bucketWidth > 0 ? Math.round(this.aggregateWindowMs / bucketWidth) : 0;
      const c = Math.round(pos); // window center = nearest bucket
      const lo = Math.max(0, c - w);
      const hi = Math.min(nb - 1, c + w);
      const count = hi - lo + 1;
      for (let v = 0; v < totalVerts; v++) {
        const base = v * nb;
        let sum = 0;
        for (let b = lo; b <= hi; b++) sum += Math.abs(matrix[base + b]);
        out[v] = sum / count;
      }
      return out;
    }

    // DEFAULT: blend the two adjacent bucket columns into a per-vertex scalar; the
    // base class maps it through the gradient ramp into a per-vertex RGBA buffer.
    // When the matrix is SIGNED (per-bucket direction), the sign carries travel
    // direction — colour is the VOLUME, so blend ABSOLUTE values (blending signed
    // values would dip through zero at a flip and dim a busy corridor). The
    // chevron reads the sign separately in chevronDirectionsFor().
    const stepped = Math.round(pos / FlowCorridorLayer.STEP) * FlowCorridorLayer.STEP;
    const blend = bucketBlendAt(stepped, nb);
    for (let v = 0; v < totalVerts; v++) {
      out[v] = blendMatrixRow(matrix, v * nb, blend, signed);
    }
    return out;
  }

  /**
   * INSTANTANEOUS per-trip flow → the color's ALPHA byte (0–255, read as [0,1] by
   * the normalized attribute). A short trailing exponential decay of the NEAREST
   * fine bucket's |value|, so a segment "flashes then fades" as a rider passes.
   * Computed directly from the matrix (no cross-frame state); no-op unless
   * `chevronPerTripLight` and a usable matrix. The RGB (aggregate ramp) is left
   * untouched.
   */
  protected override finalizeGradientColorBuffer(
    colors: Uint8Array,
    binary: BinaryFeatures,
    totalVerts: number,
  ): void {
    if (!this.perTripLight) return;
    const nb = binary.vertexValueBuckets ?? 0;
    const matrix = binary.vertexValueMatrix;
    if (nb <= 0 || !matrix || matrix.length < totalVerts * nb) return;
    if (!binary.startTimes || !binary.endTimes || binary.startTimes.length === 0) return;

    const pos = this.posFromBinary(binary, this.getCurrentTime()) ?? 0;
    const b0 = Math.round(pos); // nearest fine bucket
    const bucketWidth = (binary.endTimes[0] - binary.startTimes[0]) / nb;
    // Trailing exponential weights over the last K buckets (decay in buckets).
    const decayBuckets = bucketWidth > 0 ? Math.max(this.instantDecayMs / bucketWidth, 1e-3) : 1e-3;
    const kMax = Math.min(nb - 1, Math.max(1, Math.ceil(decayBuckets * 3)));
    const weights = new Float32Array(kMax + 1);
    for (let k = 0; k <= kMax; k++) weights[k] = Math.exp(-k / decayBuckets);
    const invDomain = 1 / this.instantDomain;

    for (let v = 0; v < totalVerts; v++) {
      const base = v * nb;
      let sum = 0;
      for (let k = 0; k <= kMax; k++) {
        const b = b0 - k;
        if (b < 0) break;
        sum += weights[k] * Math.abs(matrix[base + b]);
      }
      let norm = sum * invDomain;
      if (norm < 0) norm = 0;
      else if (norm > 1) norm = 1;
      colors[v * 4 + 3] = Math.round(norm * 255);
    }
  }

  protected override chevronDirectionsFor(
    binary: BinaryFeatures,
    totalVerts: number,
  ): Float32Array | undefined {
    if (!this.signedFlow) return undefined;
    const nb = binary.vertexValueBuckets ?? 0;
    const matrix = binary.vertexValueMatrix;
    if (nb <= 0 || !matrix || matrix.length < totalVerts * nb) return undefined;
    this.noteAxis(binary);
    const pos = this.posFromBinary(binary, this.getCurrentTime()) ?? 0;
    // CONTINUOUS signed direction ∈ [-1, 1] carried in the reused instanceVertexTime
    // slot → vChevronDir. A DIRECTIONAL-COHERENCE ratio over a rolling window:
    // Σ(signed net flow) / Σ|value|. It is intrinsically in [-1,1] (|Σsigned| ≤
    // Σ|value|) — needs no data-scale knob — and glides SMOOTHLY through 0 at
    // balanced/reversing periods instead of the old hard ±1 bucket flip. The shader
    // morphs the arrow SHAPE (">"→flat dash→"<"), blends its cardinal HUE
    // forward↔reverse, and marches the way arrows point — so the AGGREGATE (not the
    // instant flash) dominates direction. Low-volume corridors where the ratio is
    // noisy are exactly the ones receded to perTripFloor, so the noise is invisible.
    // (Collapses to ±1 on a coarse matrix where the window rounds to one bucket —
    // the smooth morph needs the FINE 1-min archive.)
    const bucketWidth = (binary.endTimes[0] - binary.startTimes[0]) / nb;
    const w = bucketWidth > 0 ? Math.round(this.directionWindowMs / bucketWidth) : 0;
    const c = Math.round(pos); // window center = nearest bucket
    const lo = Math.max(0, c - w);
    const hi = Math.min(nb - 1, c + w);
    const out = new Float32Array(totalVerts);
    for (let v = 0; v < totalVerts; v++) {
      const base = v * nb;
      let net = 0;
      let vol = 0;
      for (let b = lo; b <= hi; b++) {
        const m = matrix[base + b];
        net += m;
        vol += Math.abs(m);
      }
      out[v] = vol > 1e-6 ? net / vol : 0;
    }
    return out;
  }

  protected override gradientStyleSuffix(binary: BinaryFeatures): string {
    const nb = binary.vertexValueBuckets ?? 0;
    if (nb <= 0 || !binary.vertexValueMatrix) return '';
    this.noteAxis(binary);
    const pos = this.posFromBinary(binary, this.getCurrentTime()) ?? 0;
    const step = Math.round(pos / FlowCorridorLayer.STEP);
    return `:fp${step}`;
  }

  protected override timeBoundsForSublayer(
    binary: BinaryFeatures,
  ): { start: number; end: number } | null {
    // A flow corridor is timeless — its geometry exists across the WHOLE range,
    // colored by the active bucket. Feed the window-mode time filter the
    // feature's full [start,end] (relative to timeOffset; every corridor spans
    // bucket0→range_end) so it never hides the network. Without this the
    // instanceStartTime/instanceEndTime attributes default to 0 and the window
    // hides every corridor once the playhead passes windowHalf.
    if (
      !binary.vertexValueBuckets ||
      !binary.startTimes ||
      binary.startTimes.length === 0 ||
      !binary.endTimes
    ) {
      return null;
    }
    return { start: binary.startTimes[0], end: binary.endTimes[0] };
  }

  protected override _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    // Until a matrix tile has populated the axis there's nothing to animate;
    // the first tile's prepareTile will render correctly on load regardless.
    if (this._numBuckets <= 0 || this._bucketWidth <= 0) return;
    let pos = (time - this._bucket0Abs) / this._bucketWidth;
    if (pos < 0) pos = 0;
    const max = this._numBuckets - 1;
    if (pos > max) pos = max;
    const step = Math.round(pos / FlowCorridorLayer.STEP);
    if (step !== this._lastStep) {
      this._lastStep = step;
      // setState (not setNeedsRedraw) re-runs renderLayers() → prepareTile,
      // whose styleKey now carries the new sub-step, so the active-column blend
      // re-expands. Only the per-vertex color buffer re-uploads; geometry stays.
      this.setState({ flowStep: step });
    }
  }
}
