// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

/**
 * Network throughput estimation for the player buffering model (WS-A).
 *
 * Each completed coalesced range response contributes one `(bytes, elapsedMs)`
 * sample. Two exponentially-weighted moving averages with different half-lives
 * track the transfer rate, in the standard hls.js/Shaka style:
 *
 * - a FAST average (3 s half-life of wall time) that reacts quickly to
 *   throughput drops, and
 * - a SLOW average (9 s half-life) that rises cautiously after a recovery.
 *
 * The published estimate is `min(fast, slow)` — pessimistic by construction,
 * which is what a buffering governor wants: it reacts immediately when the
 * network degrades and only trusts an improvement once it has been sustained.
 *
 * Samples are weighted by their TRANSFER DURATION (a 900 ms response moves the
 * average ~9× more than a 100 ms one), so many tiny responses can't drown out
 * one long representative transfer.
 */

/** A point-in-time throughput estimate. */
export interface ThroughputEstimate {
  /**
   * Estimated sustainable transfer rate in bytes per millisecond
   * (`min(fast EWMA, slow EWMA)`), or `null` before the first sample.
   */
  bytesPerMs: number | null;
  /** Number of samples recorded so far. */
  samples: number;
}

/** Default fast half-life (ms of accumulated transfer time). */
const DEFAULT_FAST_HALF_LIFE_MS = 3000;
/** Default slow half-life (ms of accumulated transfer time). */
const DEFAULT_SLOW_HALF_LIFE_MS = 9000;
/**
 * Floor on a sample's duration. A cache-warm or same-host response can
 * complete in "0 ms" at Date.now() resolution; dividing by zero would
 * publish an infinite rate, so clamp to 1 ms (which also caps how much a
 * suspiciously instant response can inflate the average).
 */
const MIN_SAMPLE_DURATION_MS = 1;

/**
 * One duration-weighted EWMA (the hls.js `EWMA` formulation): each sample's
 * weight is its duration `w`, applied as `alpha^w`, where `alpha` is the
 * per-millisecond decay derived from the half-life. Early estimates are
 * bias-corrected by the total accumulated weight (`1 - alpha^totalWeight`)
 * so the first few samples aren't dragged toward zero.
 */
class Ewma {
  /** Per-ms decay factor: `alpha^halfLife = 0.5`. */
  private readonly alpha: number;
  private estimate = 0;
  private totalWeight = 0;

  constructor(halfLifeMs: number) {
    this.alpha = Math.exp(Math.log(0.5) / halfLifeMs);
  }

  add(value: number, weightMs: number): void {
    const adjAlpha = Math.pow(this.alpha, weightMs);
    this.estimate = adjAlpha * this.estimate + (1 - adjAlpha) * value;
    this.totalWeight += weightMs;
  }

  get(): number {
    // Bias correction for a short history (standard EWMA warm-up fix).
    const zeroFactor = 1 - Math.pow(this.alpha, this.totalWeight);
    return zeroFactor > 0 ? this.estimate / zeroFactor : this.estimate;
  }
}

/** Tunables for {@link ThroughputEstimator}; mostly useful in tests. */
export interface ThroughputEstimatorOptions {
  /** Half-life of the fast (drop-reactive) average. Default 3000 ms. */
  fastHalfLifeMs?: number;
  /** Half-life of the slow (rise-cautious) average. Default 9000 ms. */
  slowHalfLifeMs?: number;
}

/**
 * Dual-EWMA throughput estimator. Feed it one sample per completed range
 * response via {@link addSample}; read `min(fast, slow)` via
 * {@link getEstimate}. Self-contained — no clocks, no I/O.
 */
export class ThroughputEstimator {
  private readonly fast: Ewma;
  private readonly slow: Ewma;
  private sampleCount = 0;

  constructor(options: ThroughputEstimatorOptions = {}) {
    this.fast = new Ewma(options.fastHalfLifeMs ?? DEFAULT_FAST_HALF_LIFE_MS);
    this.slow = new Ewma(options.slowHalfLifeMs ?? DEFAULT_SLOW_HALF_LIFE_MS);
  }

  /**
   * Record one completed transfer. Non-positive byte counts are ignored;
   * durations are clamped to {@link MIN_SAMPLE_DURATION_MS}.
   */
  addSample(bytes: number, elapsedMs: number): void {
    if (!(bytes > 0) || !Number.isFinite(elapsedMs)) return;
    const duration = Math.max(elapsedMs, MIN_SAMPLE_DURATION_MS);
    const rate = bytes / duration; // bytes per ms
    this.fast.add(rate, duration);
    this.slow.add(rate, duration);
    this.sampleCount++;
  }

  /** Current estimate. `bytesPerMs` is `null` until at least one sample. */
  getEstimate(): ThroughputEstimate {
    if (this.sampleCount === 0) {
      return { bytesPerMs: null, samples: 0 };
    }
    return {
      bytesPerMs: Math.min(this.fast.get(), this.slow.get()),
      samples: this.sampleCount,
    };
  }
}
