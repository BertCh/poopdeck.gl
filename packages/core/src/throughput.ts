// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

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
 *
 * A third, duration-weighted average tracks DISPERSION (squared deviations of
 * the sampled rate from the slow average), so consumers can ask for a
 * quantile-style lower bound — `max(0, min(fast, slow) − z·stdDev)` — instead
 * of the point min. A perfectly steady link reports exactly zero dispersion,
 * so every conservative reading degenerates to today's point estimate and
 * calm-link behavior is unchanged (see {@link getConservativeRate}).
 *
 * This module also carries {@link LatencyEstimator} — the per-request
 * time-to-first-byte EWMA. Latency and throughput together give the bytes
 * value of one round trip (`L̂ × θ̂`), which is the exchange rate the range
 * coalescer and the temporal-tier cost model both price requests in.
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
  /**
   * Standard deviation of the sampled rate around the slow average, in bytes
   * per millisecond. Present from the first sample onward; absent (and to be
   * read as 0) before it, and from any producer that predates dispersion
   * tracking. Exactly `0` for a link whose sampled rate never varies.
   */
  stdDev?: number;
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
  /**
   * Half-life of the dispersion (squared-deviation) average. Defaults to the
   * slow half-life: dispersion is a long-horizon property of the link, and
   * sharing the slow horizon keeps `cv = stdDev / rate` comparable to the
   * average it divides.
   */
  dispersionHalfLifeMs?: number;
}

/**
 * Apply the conservative-rate rule to an already-published estimate:
 * `max(0, bytesPerMs − z·stdDev)`.
 *
 * This is the single definition of the rule. {@link ThroughputEstimator}
 * delegates to it, and consumers that only ever see a {@link ThroughputEstimate}
 * across a package boundary (the playback governor receives one from a
 * `getThroughput()` callback, never the estimator itself) call it directly so
 * the two sides can never drift apart.
 *
 * Honesty contract: `null` in ⇒ `null` out — a cold estimator is never
 * papered over with a guess. A missing `stdDev` (a producer that predates
 * dispersion tracking) is read as 0, which returns the point estimate
 * unchanged, so the incumbent behavior is the fallback by construction.
 *
 * `z` is clamped to `[0, ∞)` (non-finite ⇒ 1), which makes
 * `conservativeRateFromEstimate(e, z) <= e.bytesPerMs` hold unconditionally.
 */
export function conservativeRateFromEstimate(
  estimate: ThroughputEstimate,
  z = 1,
): number | null {
  const point = estimate.bytesPerMs;
  if (point === null || !Number.isFinite(point)) return null;
  const zClamped = Number.isFinite(z) ? Math.max(0, z) : 1;
  const stdDev =
    typeof estimate.stdDev === 'number' && Number.isFinite(estimate.stdDev)
      ? Math.max(0, estimate.stdDev)
      : 0;
  return Math.max(0, point - zClamped * stdDev);
}

/**
 * Dual-EWMA throughput estimator. Feed it one sample per completed range
 * response via {@link addSample}; read `min(fast, slow)` via
 * {@link getEstimate}. Self-contained — no clocks, no I/O.
 */
export class ThroughputEstimator {
  private readonly fast: Ewma;
  private readonly slow: Ewma;
  /**
   * Duration-weighted average of SQUARED deviations of the sampled rate from
   * the slow average. Deviations are measured against the slow average
   * evaluated AFTER the sample is folded in, which is what makes a steady
   * link report exactly zero — including on its very first sample, where a
   * before-the-fold reference would have charged the whole rate as deviation.
   */
  private readonly dispersion: Ewma;
  private sampleCount = 0;

  constructor(options: ThroughputEstimatorOptions = {}) {
    const slowHalfLifeMs = options.slowHalfLifeMs ?? DEFAULT_SLOW_HALF_LIFE_MS;
    this.fast = new Ewma(options.fastHalfLifeMs ?? DEFAULT_FAST_HALF_LIFE_MS);
    this.slow = new Ewma(slowHalfLifeMs);
    this.dispersion = new Ewma(options.dispersionHalfLifeMs ?? slowHalfLifeMs);
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
    // Dispersion rides the same sample and the same weight as the averages
    // it describes, so a long transfer moves the spread as much as it moves
    // the mean.
    const deviation = rate - this.slow.get();
    this.dispersion.add(deviation * deviation, duration);
    this.sampleCount++;
  }

  /** Current estimate. `bytesPerMs` is `null` until at least one sample. */
  getEstimate(): ThroughputEstimate {
    if (this.sampleCount === 0) {
      // No `stdDev` key at all before the first sample: the cold estimate's
      // shape is unchanged from the pre-dispersion contract.
      return { bytesPerMs: null, samples: 0 };
    }
    return {
      bytesPerMs: Math.min(this.fast.get(), this.slow.get()),
      samples: this.sampleCount,
      stdDev: this.getStdDev(),
    };
  }

  /**
   * Standard deviation of the sampled rate around the slow average, in bytes
   * per ms; `0` before the first sample and for a link whose rate never
   * varies.
   */
  getStdDev(): number {
    if (this.sampleCount === 0) return 0;
    const variance = this.dispersion.get();
    return variance > 0 ? Math.sqrt(variance) : 0;
  }

  /**
   * A quantile-style lower bound on the rate rather than the point min:
   * `max(0, min(fast, slow) − z·stdDev)`, `null` before the first sample.
   *
   * Use this where a wrong-but-optimistic rate costs a stall (feasibility
   * gates, watermarks, speed ladders). `z` is the number of standard
   * deviations of headroom; it is clamped to `[0, ∞)` so the result is never
   * above the point estimate, and `z = 0` reproduces the point estimate
   * exactly. On a steady link `stdDev` is 0, so every reading here is
   * bit-for-bit `getEstimate().bytesPerMs` — the incumbent behavior.
   */
  getConservativeRate(z = 1): number | null {
    if (this.sampleCount === 0) return null;
    return conservativeRateFromEstimate(this.getEstimate(), z);
  }
}

/** Default half-life of the latency EWMA, in SAMPLES (not milliseconds). */
const DEFAULT_LATENCY_HALF_LIFE_SAMPLES = 8;

/** Tunables for {@link LatencyEstimator}; mostly useful in tests. */
export interface LatencyEstimatorOptions {
  /**
   * Half-life of the latency average expressed in samples: after this many
   * newer requests, an older observation carries half its original weight.
   * Default 8.
   */
  halfLifeSamples?: number;
}

/**
 * Per-request latency (time-to-first-byte) estimator.
 *
 * Unlike {@link ThroughputEstimator}, samples are NOT duration-weighted: a
 * round trip costs one round trip whether the response that followed it was
 * 5 KB or 5 MB, so every observation carries weight 1 and the half-life is
 * counted in samples. That keeps `L̂` a property of the link's round trip and
 * not of the payloads that happened to ride it.
 *
 * `L̂ × θ̂` (this estimator times the throughput estimator) is the byte value
 * of one request — the exchange rate that prices a request against the bytes
 * it would take to avoid it.
 *
 * Self-contained: no clocks, no I/O, no RNG. The caller stamps the elapsed
 * time and feeds it in, so a fixed sample sequence is a fixed output sequence.
 */
export class LatencyEstimator {
  private readonly ewma: Ewma;
  private sampleCount = 0;

  constructor(options: LatencyEstimatorOptions = {}) {
    const halfLife =
      options.halfLifeSamples ?? DEFAULT_LATENCY_HALF_LIFE_SAMPLES;
    this.ewma = new Ewma(
      Number.isFinite(halfLife) && halfLife > 0
        ? halfLife
        : DEFAULT_LATENCY_HALF_LIFE_SAMPLES,
    );
  }

  /**
   * Record one request's time-to-first-byte, in milliseconds. Negative and
   * non-finite observations are ignored (they are measurement errors, not
   * signal); a genuine 0 ms — a cache hit at `Date.now()` resolution — is a
   * real observation and is kept.
   */
  addSample(ttfbMs: number): void {
    if (!Number.isFinite(ttfbMs) || ttfbMs < 0) return;
    this.ewma.add(ttfbMs, 1);
    this.sampleCount++;
  }

  /**
   * Current latency estimate in milliseconds, or `null` before the first
   * sample. `null` means COLD, never "fast" — callers must fall back to their
   * static default rather than treat a cold estimator as a zero round trip.
   */
  getLatencyMs(): number | null {
    if (this.sampleCount === 0) return null;
    return this.ewma.get();
  }

  /** Number of samples recorded so far (diagnostics; `0` ⇒ cold). */
  getSampleCount(): number {
    return this.sampleCount;
  }
}
