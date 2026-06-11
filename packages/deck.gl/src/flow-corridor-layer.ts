// FlowCorridorLayer — animate a static-geometry overview whose per-vertex color
// is a TIME SERIES, not a single scalar.
//
// A flow-corridor tile stores its street geometry ONCE and carries a per-vertex
// × per-time-bucket value matrix (`BinaryFeatures.vertexValueMatrix`, flattened
// globally vertex-major; `vertexValueBuckets` columns). The geometry never
// re-uploads as the playhead advances; only the per-vertex COLOR changes.
//
// This subclass keeps all of AnimatedTripsLayer's tile caching / sublayer
// plumbing and overrides just two seams:
//
//   • `gradientValuesFor` — instead of the static `vertexValues` channel, select
//     (and linearly blend between) the active bucket columns from the matrix.
//   • `gradientStyleSuffix` — fold the quantized playhead position into the
//     prepared-tile `styleKey` so the CPU-expanded colors re-compute when the
//     playhead crosses a sub-step (and ONLY then — between sub-steps the cache
//     hits and nothing re-uploads).
//
// `_handleTimeUpdate` is overridden to force a `renderLayers()` pass (via
// `setState`, mirroring AnimatedHeatmapLayer) whenever the quantized position
// changes — the base trips layer is deliberately redraw-only on time, so this
// time-forced render is quarantined to this subclass.
//
// This is the "A1" renderer: the cross-fade is a CPU blend re-expanded at the
// sub-step rate (~`1/STEP` updates per bucket), which is cheap (a strided read +
// ramp map over the visible tiles' vertices, a handful of times per second) but
// not a per-frame GPU blend. The GPU texture-sampled "A2" path replaces this
// with a smooth, zero-per-frame-CPU two-sample lerp in the vertex shader.

import { AnimatedTripsLayer } from './animated-trips-layer';
import type { BinaryFeatures } from '@stt/core';

export class FlowCorridorLayer<
  ExtraPropsT extends {} = {},
> extends AnimatedTripsLayer<ExtraPropsT> {
  static layerName = 'FlowCorridorLayer';

  /**
   * Cross-fade granularity, in fractions of a bucket. 0.1 ⇒ 10 sub-steps per
   * bucket: the colors re-expand (and `renderLayers` fires) at most ~10× per
   * bucket crossing, which at the default ~1.9 s/bucket playback is ~5 Hz —
   * smooth to the eye without per-frame CPU work.
   */
  private static readonly STEP = 0.1;

  // Global bucket axis, cached from the first matrix tile seen. All flow tiles
  // share one axis (every corridor spans the whole range), so a single cache
  // serves the time-driven `setState` gate in `_handleTimeUpdate`.
  private _bucket0Abs = 0;
  private _bucketWidth = 0;
  private _numBuckets = 0;
  /** Last quantized sub-step we forced a render for (-1 = none yet). */
  private _lastStep = -1;

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
    // Quantize to the cross-fade grid so this matches the styleKey suffix.
    const stepped = Math.round(pos / FlowCorridorLayer.STEP) * FlowCorridorLayer.STEP;
    const b0 = Math.floor(stepped);
    const b1 = Math.min(b0 + 1, nb - 1);
    const f = stepped - b0;
    // Blend the two adjacent bucket columns into a per-vertex scalar; the base
    // class maps it through the gradient ramp into a per-vertex RGBA buffer.
    const out = new Float32Array(totalVerts);
    if (f <= 0) {
      for (let v = 0; v < totalVerts; v++) out[v] = matrix[v * nb + b0];
    } else {
      const g = 1 - f;
      for (let v = 0; v < totalVerts; v++) {
        const base = v * nb;
        out[v] = matrix[base + b0] * g + matrix[base + b1] * f;
      }
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
