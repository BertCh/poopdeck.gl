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
//     adjacent buckets; with `persistenceMs`, a TRAILING-window MAX so a
//     highlight binned at trip START stays lit for the ride's duration. Under
//     `chevronPerTripLight`: a rolling-window MEAN (the AGGREGATE "overall
//     style over a granular period" signal) → the ramp RGB.
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

import type { DefaultProps, Layer } from '@deck.gl/core';
import { AnimatedTripsLayer } from './animated-trips-layer.js';
import type { AnimatedTripsLayerProps } from './animated-trips-layer.js';
import {
  bucketBlendAt,
  blendMatrixRow,
  trailingMaxMatrixRow,
} from '../../lib/vertex-value-blend.js';
import { warnOnce } from '../../lib/log.js';
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
  /**
   * TRAILING persistence window, ms of data time, for the default (non-
   * `chevronPerTripLight`) matrix path: each vertex holds the MAX of the
   * bucket signal over `[t − persistenceMs, t]` instead of the instantaneous
   * two-bucket blend. Generators bin a trip's whole route into its START
   * bucket, so without persistence a corridor's highlight fades one bucket
   * after departure while the ride (a moving-heads overlay) is still
   * traversing it. Set to the typical trip DURATION so the highlight stays
   * lit until riders arrive: rises over one bucket, holds for the window,
   * fades over one bucket. Time-CHUNKED archives clamp the window at each
   * chunk's first column (a brief reset at chunk boundaries); whole-range
   * corridor archives are unaffected. `0` disables.
   * @default 0
   */
  persistenceMs?: number;
}

/** Complete props accepted by {@link FlowCorridorLayer}. */
export type FlowCorridorLayerProps = _FlowCorridorLayerProps &
  AnimatedTripsLayerProps;

export class FlowCorridorLayer<
  ExtraPropsT extends {} = {},
> extends AnimatedTripsLayer<ExtraPropsT & Required<_FlowCorridorLayerProps>> {
  static layerName = 'FlowCorridorLayer';

  static defaultProps: DefaultProps<FlowCorridorLayerProps> = {
    ...AnimatedTripsLayer.defaultProps,
    // A corridor is TIMELESS static geometry animated by colour: it runs the
    // time filter in WINDOW mode (`timeBoundsForSublayer` feeds the corridor's
    // full [start,end]) and repurposes `instanceVertexTime` to carry the
    // chevron direction sign. Inheriting AnimatedTripsLayer's
    // `trailLength: 180_000` put the shader in TRAIL mode (precedence:
    // cumulative > wake > trail > window), where it reads that slot as a
    // relative vertex time — so once the relative playhead passed 180 s every
    // vertex satisfied `vertexTime < trailStart` and the ENTIRE corridor
    // network went blank for the rest of playback, silently. Every shipped
    // dataset config happened to remember `trailLength: 0`; this makes it the
    // class default. See the guard in `renderLayers` for the override case.
    trailLength: { type: 'number', value: 0, min: 0 },
    signedFlow: false,
    chevronPerTripLight: false,
    chevronAggregateWindowMs: { type: 'number', value: 240000, min: 0 },
    chevronInstantDomain: { type: 'number', value: 1.5, min: 0 },
    chevronInstantDecayMs: { type: 'number', value: 120000, min: 0 },
    chevronDirectionWindowMs: { type: 'number', value: 0, min: 0 },
    persistenceMs: { type: 'number', value: 0, min: 0 },
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

  // Bucket AXIS cached from the first matrix tile seen — used only to gate the
  // time-driven `setState` in `_handleTimeUpdate`. `bucketWidth` is the per-
  // bucket duration, which is UNIFORM across tiles (whole-range corridors AND
  // time-CHUNKED archives, where each chunk carries a slice of the same uniform
  // bin), so a single anchor + width gates the whole timeline. `bucket0Abs` is
  // an arbitrary-but-stable anchor (the first tile's start); only *relative*
  // sub-step changes matter for the gate, so its absolute value is irrelevant.
  // NOTE: `numBuckets` is the first tile's OWN column count — for a chunked
  // archive that is one chunk's worth, NOT the global timeline, so it must never
  // clamp the global gate (doing so froze animation once the playhead left the
  // anchor chunk). Per-tile bucket selection is done self-contained in
  // `posFromBinary`; this axis is purely the re-render trigger.
  //
  // Lives on `state` (not a class field) for the same reason as the tile caches
  // — deck's `_transferState` re-runs field initializers on the new instance —
  // and carries the `archiveKey` it was latched from, because `noteAxis` is
  // idempotent-forever: without the reset, swapping a 1-HOUR-bucket archive for
  // a 1-MINUTE-bucket one kept `bucketWidth = 3_600_000` and the colours
  // updated ~60× too slowly.
  private get axis(): {
    archiveKey: string;
    bucket0Abs: number;
    bucketWidth: number;
    numBuckets: number;
    /** Last quantized sub-step we forced a render for (-1 = none yet). */
    lastStep: number;
  } {
    const axis = this.stateSlot(FlowCorridorLayer.AXIS_SLOT, () => ({
      archiveKey: this.archiveKey(),
      bucket0Abs: 0,
      bucketWidth: 0,
      numBuckets: 0,
      lastStep: -1,
    }));
    const key = this.archiveKey();
    if (axis.archiveKey !== key) {
      axis.archiveKey = key;
      axis.bucket0Abs = 0;
      axis.bucketWidth = 0;
      axis.numBuckets = 0;
      axis.lastStep = -1;
    }
    return axis;
  }

  /**
   * `this.state` key the bucket axis lives under. Exposed so a test can
   * pre-anchor the axis on a bare instance without a magic string.
   * @internal
   */
  static readonly AXIS_SLOT = '_sttFlowCorridorAxis';

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
    if (nb <= 0 || !binary.startTimes || binary.startTimes.length === 0)
      return null;
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

  /**
   * Cache the global bucket axis from the first matrix tile. Idempotent WITHIN
   * one archive; the {@link axis} accessor clears it when the archive changes,
   * so a bin-width swap re-latches instead of animating at the old cadence.
   */
  private noteAxis(binary: BinaryFeatures): void {
    const axis = this.axis;
    if (axis.numBuckets > 0) return;
    const nb = binary.vertexValueBuckets ?? 0;
    if (nb <= 0 || !binary.startTimes || binary.startTimes.length === 0) return;
    const rel0 = binary.startTimes[0];
    const span = binary.endTimes[0] - rel0;
    if (span <= 0) return;
    axis.numBuckets = nb;
    axis.bucketWidth = span / nb;
    axis.bucket0Abs = binary.timeOffset + rel0;
  }

  /**
   * Corridor knobs that change what `prepareTile` bakes into the per-vertex
   * colour / direction buffers. Folded into BOTH tile caches by the base class
   * — before this, dragging a `persistenceMs` slider while PAUSED hit both and
   * returned the identical `PathLayer`, so the control read as dead until the
   * playhead crossed a half-bucket.
   */
  protected override subclassStyleKey(): string {
    return [
      super.subclassStyleKey(),
      this.props.signedFlow ? 1 : 0,
      this.props.chevronPerTripLight ? 1 : 0,
      this.props.chevronAggregateWindowMs,
      this.props.chevronInstantDomain,
      this.props.chevronInstantDecayMs,
      this.props.chevronDirectionWindowMs,
      this.props.persistenceMs,
    ].join(',');
  }

  override renderLayers(): Layer[] {
    // `trailLength` must stay 0 here (see defaultProps): a non-zero value puts
    // the shader in TRAIL mode, which reads `instanceVertexTime` — the slot
    // this class repurposes for the chevron direction sign — as a relative
    // vertex time, and blanks the whole network once the relative playhead
    // passes it.
    if (this.props.trailLength > 0) {
      warnOnce(
        'FlowCorridorLayer:trailLength',
        `[FlowCorridorLayer] trailLength: ${this.props.trailLength} — a flow ` +
          'corridor is static geometry animated by COLOUR and runs the time ' +
          'filter in window mode, so any trailLength > 0 switches the shader ' +
          'to trail mode' +
          (this.props.signedFlow
            ? ' and makes it read the signedFlow DIRECTION SIGNS carried on ' +
              'instanceVertexTime as vertex timestamps'
            : '') +
          '. The corridor network goes blank once the relative playhead passes ' +
          'trailLength. Leave trailLength at its FlowCorridorLayer default (0).',
      );
    }
    return super.renderLayers();
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
      const w =
        bucketWidth > 0 ? Math.round(this.aggregateWindowMs / bucketWidth) : 0;
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
    const stepped =
      Math.round(pos / FlowCorridorLayer.STEP) * FlowCorridorLayer.STEP;

    // TRAILING PERSISTENCE (persistenceMs > 0): hold each vertex at the MAX of
    // the bucket signal over [t − persistenceMs, t]. Trips are binned into their
    // START bucket by the generators, so the instantaneous blend fades a route's
    // highlight one bucket after departure — long before the moving-heads
    // overlay finishes the ride. See _FlowCorridorLayerProps.persistenceMs.
    const persistMs = this.props.persistenceMs ?? 0;
    if (persistMs > 0) {
      const bucketWidth = (binary.endTimes[0] - binary.startTimes[0]) / nb;
      const wBuckets = bucketWidth > 0 ? persistMs / bucketWidth : 0;
      if (wBuckets > 0) {
        const lo = Math.max(0, stepped - wBuckets);
        for (let v = 0; v < totalVerts; v++) {
          out[v] = trailingMaxMatrixRow(
            matrix,
            v * nb,
            nb,
            lo,
            stepped,
            signed,
          );
        }
        return out;
      }
    }

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
    if (
      !binary.startTimes ||
      !binary.endTimes ||
      binary.startTimes.length === 0
    )
      return;

    const pos = this.posFromBinary(binary, this.getCurrentTime()) ?? 0;
    const b0 = Math.round(pos); // nearest fine bucket
    const bucketWidth = (binary.endTimes[0] - binary.startTimes[0]) / nb;
    // Trailing exponential weights over the last K buckets (decay in buckets).
    const decayBuckets =
      bucketWidth > 0
        ? Math.max(this.instantDecayMs / bucketWidth, 1e-3)
        : 1e-3;
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
    const w =
      bucketWidth > 0 ? Math.round(this.directionWindowMs / bucketWidth) : 0;
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

  /**
   * Corridors run the time filter in WINDOW mode, and `timeBoundsForSublayer`
   * above hands `instanceEndTime` a real feature end. So the slot is NOT free
   * to carry per-vertex "next vertex" times — the base class's trail glide is
   * off here (and meaningless: corridor geometry is static, animated by the
   * value matrix rather than by a head sweeping along it).
   */
  protected override usesSegmentVertexTimes(): boolean {
    return false;
  }

  protected override _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    // Until a matrix tile has populated the axis there's nothing to animate;
    // the first tile's prepareTile will render correctly on load regardless.
    // (Reading through `this.axis` also clears a stale axis after a data swap,
    // so the gate can't keep ticking at the previous archive's bin width.)
    const axis = this.axis;
    if (axis.numBuckets <= 0 || axis.bucketWidth <= 0) return;
    // Global sub-step of the playhead against the uniform bin width. NOT clamped
    // to `axis.numBuckets` (that is one chunk's column count, not the timeline) —
    // clamping froze the re-render gate once the playhead left the anchor
    // chunk. Only whether `step` CHANGED matters; each visible tile then
    // re-expands its own active column via `posFromBinary` (clamped per-tile).
    const step = Math.round(
      (time - axis.bucket0Abs) / axis.bucketWidth / FlowCorridorLayer.STEP,
    );
    if (step !== axis.lastStep) {
      axis.lastStep = step;
      // setState (not setNeedsRedraw) re-runs renderLayers() → prepareTile,
      // whose `dynamicKey` now carries the new sub-step, so the active-column
      // blend re-expands into a fresh colour wrapper on the SAME `data` object.
      // Only that buffer re-uploads; the geometry is neither re-tessellated nor
      // re-split into fp64 hi/lo.
      this.setState({ flowStep: step });
    }
  }
}
