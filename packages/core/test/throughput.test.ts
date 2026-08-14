/**
 * Tests for the dual-EWMA throughput estimator (player buffering WS-A).
 *
 * The estimator feeds `estimateTimeToReadyMs`: each completed coalesced
 * range response contributes one (bytes, elapsedMs) sample, two EWMAs with
 * 3 s / 9 s half-lives track the rate (duration-weighted, hls.js-style), and
 * the published estimate is min(fast, slow) — react fast to drops, rise
 * cautiously after recoveries.
 *
 * Plus the two estimator foundations the cost-oracle pass builds on:
 * dispersion (`stdDev` / `getConservativeRate`, the quantile-not-point-min the
 * governor gates on) and `LatencyEstimator` (time-to-first-byte, the L̂ half of
 * the request price L̂·θ̂).
 *
 * ## The hand-computation trick used throughout
 *
 * A duration-weighted EWMA folds a sample as
 * `est ← a^w·est + (1 − a^w)·v` with `a^halfLife = 0.5`, and publishes
 * `est / (1 − a^W)` for total weight `W`. Choose the sample duration EQUAL to
 * the half-life and every fold uses `a^w = 1/2` exactly, which telescopes to a
 * closed form with no floating-point guesswork:
 *
 *     get() after n samples = Σ_k 2^(k−1)·v_k / (2^n − 1)
 *
 * So samples (v1, v2, v3) publish (v1), (v1+2v2)/3, (v1+2v2+4v3)/7. Every
 * expected value below is written out in that form.
 */

import { describe, it, expect } from 'vitest';
import {
  ThroughputEstimator,
  LatencyEstimator,
  conservativeRateFromEstimate,
} from '../src/throughput';

/**
 * An estimator whose three averages share a 1000 ms half-life, driven with
 * 1000 ms samples — the closed form above. `fast === slow`, so the published
 * point estimate is just that mean and the dispersion is exactly comparable.
 */
function handComputable(): ThroughputEstimator {
  return new ThroughputEstimator({
    fastHalfLifeMs: 1000,
    slowHalfLifeMs: 1000,
    dispersionHalfLifeMs: 1000,
  });
}

/** Feed one 1000 ms sample at `rate` bytes/ms. */
function feedRate(est: ThroughputEstimator, rate: number): void {
  est.addSample(rate * 1000, 1000);
}

/** Deterministic LCG — no Math.random anywhere in these tests. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('ThroughputEstimator', () => {
  it('returns null until the first sample, then the measured rate', () => {
    const est = new ThroughputEstimator();
    expect(est.getEstimate()).toEqual({ bytesPerMs: null, samples: 0 });

    // One 1 MB transfer over 1000 ms = 1048.576 bytes/ms. With a single
    // sample the bias correction makes both EWMAs equal the sample rate.
    est.addSample(1024 * 1024, 1000);
    const { bytesPerMs, samples } = est.getEstimate();
    expect(samples).toBe(1);
    expect(bytesPerMs).toBeCloseTo((1024 * 1024) / 1000, 6);
  });

  it('ignores empty samples and clamps zero durations', () => {
    const est = new ThroughputEstimator();
    est.addSample(0, 100); // no bytes — not a signal
    est.addSample(-5, 100);
    expect(est.getEstimate().bytesPerMs).toBeNull();

    // A "0 ms" response must not publish an infinite rate.
    est.addSample(1000, 0);
    const { bytesPerMs } = est.getEstimate();
    expect(Number.isFinite(bytesPerMs!)).toBe(true);
    expect(bytesPerMs).toBeCloseTo(1000, 6); // clamped to 1 ms
  });

  it('reacts quickly to a throughput DROP (fast EWMA pulls min down)', () => {
    const est = new ThroughputEstimator();
    // Steady state: 10 s of transfers at 100 bytes/ms.
    for (let i = 0; i < 10; i++) est.addSample(100_000, 1000);
    expect(est.getEstimate().bytesPerMs).toBeCloseTo(100, 1);

    // Network degrades to 10 bytes/ms for 3 s (= one fast half-life).
    for (let i = 0; i < 3; i++) est.addSample(10_000, 1000);
    const after = est.getEstimate().bytesPerMs!;
    // The fast average has decayed ~halfway toward 10 (≈55); the slow one
    // lags far behind (≈81). min() publishes the pessimistic fast value.
    expect(after).toBeLessThan(60);
    expect(after).toBeGreaterThan(10);
  });

  it('rises CAUTIOUSLY after a recovery (slow EWMA holds min down)', () => {
    const est = new ThroughputEstimator();
    // Steady state: 10 s at 10 bytes/ms.
    for (let i = 0; i < 10; i++) est.addSample(10_000, 1000);
    expect(est.getEstimate().bytesPerMs).toBeCloseTo(10, 1);

    // One short burst at 100 bytes/ms must NOT be trusted yet: the slow
    // average barely moves, and min(fast, slow) publishes the slow one.
    est.addSample(50_000, 500);
    const after = est.getEstimate().bytesPerMs!;
    expect(after).toBeLessThan(30); // nowhere near the 100 burst rate
    expect(after).toBeGreaterThanOrEqual(10);
  });

  it('weights samples by transfer duration', () => {
    const a = new ThroughputEstimator();
    // Many tiny fast blips followed by one long slow transfer...
    for (let i = 0; i < 20; i++) a.addSample(1000, 10); // 100 B/ms, 10 ms each
    a.addSample(20_000, 2000); // 10 B/ms for 2 s
    // ...must land near the long transfer's rate, not the blips' (the 2 s
    // sample carries 10× the blips' combined weight).
    expect(a.getEstimate().bytesPerMs!).toBeLessThan(40);
  });
});

describe('ThroughputEstimator dispersion (stdDev)', () => {
  it('reports no stdDev key at all before the first sample', () => {
    const est = new ThroughputEstimator();
    const cold = est.getEstimate();
    // The cold estimate's SHAPE is part of the pre-dispersion contract
    // (archive-retry.test.ts asserts it with toEqual); adding a key here
    // would break callers that compare the whole object.
    expect(cold).toEqual({ bytesPerMs: null, samples: 0 });
    expect('stdDev' in cold).toBe(false);
    expect(est.getStdDev()).toBe(0);
  });

  it('matches hand-computed values on a 100 / 200 / 50 B/ms sequence', () => {
    const est = handComputable();

    // n = 1. mean = 100. The deviation is measured AFTER the fold, so a
    // first sample deviates from its own mean by zero.
    feedRate(est, 100);
    let e = est.getEstimate();
    expect(e.samples).toBe(1);
    expect(e.bytesPerMs!).toBeCloseTo(100, 9);
    expect(e.stdDev!).toBeCloseTo(0, 9);

    // n = 2. mean = (100 + 2·200)/3 = 500/3.
    //        dev₂ = (200 − 500/3)² = (100/3)² = 10000/9.
    //        disp = (1·0 + 2·10000/9)/3 = 20000/27.
    feedRate(est, 200);
    e = est.getEstimate();
    expect(e.samples).toBe(2);
    expect(e.bytesPerMs!).toBeCloseTo(500 / 3, 9);
    expect(e.stdDev!).toBeCloseTo(Math.sqrt(20000 / 27), 9);
    expect(e.stdDev!).toBeCloseTo(27.216_552_697, 6); // decimal cross-check

    // n = 3. mean = (100 + 2·200 + 4·50)/7 = 700/7 = 100.
    //        dev₃ = (50 − 100)² = 2500.
    //        disp = (1·0 + 2·10000/9 + 4·2500)/7 = 110000/63.
    feedRate(est, 50);
    e = est.getEstimate();
    expect(e.samples).toBe(3);
    expect(e.bytesPerMs!).toBeCloseTo(100, 9);
    expect(e.stdDev!).toBeCloseTo(Math.sqrt(110000 / 63), 9);
    expect(e.stdDev!).toBeCloseTo(41.785_544_7, 6); // decimal cross-check
  });

  it('is EXACTLY zero on a steady link, at every sample count', () => {
    // The cv ≈ 0 pin: a link whose sampled rate never varies must publish no
    // dispersion at all, so every conservative reading below degenerates to
    // today's point estimate and calm-link behavior is unchanged.
    const est = new ThroughputEstimator(); // production half-lives
    for (let i = 1; i <= 25; i++) {
      est.addSample(100_000, 1000); // always 100 B/ms
      const e = est.getEstimate();
      expect(e.stdDev!).toBeLessThan(1e-9);
      expect(e.bytesPerMs!).toBeCloseTo(100, 9);
    }
  });

  it('grows with jitter and shrinks again once the link settles', () => {
    const jittery = new ThroughputEstimator();
    const steady = new ThroughputEstimator();
    for (let i = 0; i < 12; i++) {
      // Same mean rate (100 B/ms), wildly different spread.
      jittery.addSample(i % 2 === 0 ? 180_000 : 20_000, 1000);
      steady.addSample(100_000, 1000);
    }
    expect(jittery.getEstimate().stdDev!).toBeGreaterThan(20);
    expect(steady.getEstimate().stdDev!).toBeLessThan(1e-9);

    // Settle the jittery link: dispersion decays back toward zero.
    const spread = jittery.getEstimate().stdDev!;
    for (let i = 0; i < 40; i++) jittery.addSample(100_000, 1000);
    expect(jittery.getEstimate().stdDev!).toBeLessThan(spread / 4);
  });

  it('leaves the point estimate untouched (pre-dispersion regression pin)', () => {
    // Same trace as the duration-weighting test above, run against both a
    // production estimator and a hand-computable one: bytesPerMs and samples
    // must read exactly as they did before dispersion existed.
    const a = new ThroughputEstimator();
    for (let i = 0; i < 20; i++) a.addSample(1000, 10);
    a.addSample(20_000, 2000);
    expect(a.getEstimate().bytesPerMs!).toBeLessThan(40);
    expect(a.getEstimate().samples).toBe(21);

    const b = handComputable();
    feedRate(b, 100);
    feedRate(b, 200);
    feedRate(b, 50);
    // (v₁ + 2v₂ + 4v₃)/7 — the closed form, unchanged by the third average.
    expect(b.getEstimate().bytesPerMs!).toBeCloseTo((100 + 400 + 200) / 7, 9);
  });
});

describe('ThroughputEstimator.getConservativeRate', () => {
  it('returns null before the first sample', () => {
    const est = new ThroughputEstimator();
    expect(est.getConservativeRate()).toBeNull();
    expect(est.getConservativeRate(0)).toBeNull();
    expect(est.getConservativeRate(3)).toBeNull();
    // A cold estimator is COLD, not "0 bytes/ms" — the caller must fall back,
    // not treat null as a measurement.
    est.addSample(100_000, 1000);
    expect(est.getConservativeRate()).not.toBeNull();
  });

  it('is max(0, min(fast,slow) − z·stdDev) on the hand-computed sequence', () => {
    const est = handComputable();
    feedRate(est, 100);
    feedRate(est, 200);
    feedRate(est, 50);

    const point = 100; // (100 + 2·200 + 4·50)/7
    const sd = Math.sqrt(110000 / 63); // ≈ 41.7855

    expect(est.getConservativeRate(0)).toBeCloseTo(point, 9);
    expect(est.getConservativeRate(1)!).toBeCloseTo(point - sd, 9);
    expect(est.getConservativeRate()!).toBeCloseTo(point - sd, 9); // z = 1 default
    expect(est.getConservativeRate(2)!).toBeCloseTo(point - 2 * sd, 9);
    // Floored at zero: never a negative rate, however wide the spread.
    expect(est.getConservativeRate(3)).toBe(0);
    expect(est.getConservativeRate(1000)).toBe(0);
  });

  it('never exceeds the point estimate, on any sample stream', () => {
    // Property check over a deterministic pseudo-random walk of rates and
    // durations, asserted after EVERY sample.
    const rand = lcg(0xc03f00d);
    const est = new ThroughputEstimator();
    for (let i = 0; i < 400; i++) {
      const rate = 1 + rand() * 500; // 1..501 B/ms
      const duration = 5 + Math.floor(rand() * 1500);
      est.addSample(rate * duration, duration);

      const point = est.getEstimate().bytesPerMs!;
      for (const z of [0, 0.5, 1, 2, 4]) {
        const cons = est.getConservativeRate(z)!;
        expect(cons).toBeLessThanOrEqual(point);
        expect(cons).toBeGreaterThanOrEqual(0);
      }
      // Monotone in z: more headroom is never a higher rate.
      expect(est.getConservativeRate(2)!).toBeLessThanOrEqual(
        est.getConservativeRate(1)!,
      );
    }
  });

  it('equals the point estimate on a calm link (the cv ≈ 0 kill switch)', () => {
    const est = new ThroughputEstimator();
    for (let i = 0; i < 30; i++) est.addSample(100_000, 1000);
    const point = est.getEstimate().bytesPerMs!;
    // Governor behavior on a steady link is today's behavior: the quantile
    // and the point min coincide.
    expect(est.getConservativeRate(1)!).toBeCloseTo(point, 9);
    expect(est.getConservativeRate(3)!).toBeCloseTo(point, 9);
  });

  it('clamps a hostile z instead of publishing an optimistic rate', () => {
    const est = handComputable();
    feedRate(est, 100);
    feedRate(est, 200);
    const point = est.getEstimate().bytesPerMs!;
    // Negative z would ADD headroom — clamped to 0, i.e. the point estimate.
    expect(est.getConservativeRate(-5)!).toBeCloseTo(point, 9);
    // Non-finite z falls back to the z = 1 default rather than NaN.
    expect(est.getConservativeRate(Number.NaN)!).toBeCloseTo(
      est.getConservativeRate(1)!,
      9,
    );
  });
});

describe('conservativeRateFromEstimate', () => {
  it('is the one definition of the rule, shared across package boundaries', () => {
    // The governor only ever sees a ThroughputEstimate (from its
    // `getThroughput()` callback), never the estimator — so it applies the
    // rule to the plain object and must land on the same number.
    const est = handComputable();
    feedRate(est, 100);
    feedRate(est, 200);
    feedRate(est, 50);
    const e = est.getEstimate();
    expect(conservativeRateFromEstimate(e, 1)).toBe(est.getConservativeRate(1));
    expect(conservativeRateFromEstimate(e, 2)).toBe(est.getConservativeRate(2));
  });

  it('passes null through and reads a missing stdDev as zero', () => {
    expect(
      conservativeRateFromEstimate({ bytesPerMs: null, samples: 0 }),
    ).toBeNull();
    // A producer that predates dispersion tracking ⇒ the point estimate,
    // unchanged. This is the fallback that keeps the incumbent path alive.
    expect(conservativeRateFromEstimate({ bytesPerMs: 42, samples: 3 })).toBe(
      42,
    );
    expect(
      conservativeRateFromEstimate({
        bytesPerMs: 42,
        samples: 3,
        stdDev: Number.NaN,
      }),
    ).toBe(42);
    expect(
      conservativeRateFromEstimate({ bytesPerMs: 42, samples: 3, stdDev: 10 }),
    ).toBe(32);
    expect(
      conservativeRateFromEstimate({ bytesPerMs: 42, samples: 3, stdDev: 99 }),
    ).toBe(0);
  });
});

describe('LatencyEstimator', () => {
  it('returns null before the first sample', () => {
    const est = new LatencyEstimator();
    expect(est.getLatencyMs()).toBeNull();
    expect(est.getSampleCount()).toBe(0);
  });

  it('publishes the first sample exactly (bias correction)', () => {
    const est = new LatencyEstimator();
    est.addSample(137);
    expect(est.getLatencyMs()!).toBeCloseTo(137, 9);
    expect(est.getSampleCount()).toBe(1);
  });

  it('matches hand-computed EWMA values (half-life = 1 sample)', () => {
    // With a one-sample half-life every fold uses a^w = 1/2, so the published
    // value is Σ 2^(k−1)·v_k / (2ⁿ − 1) — see the header note.
    const est = new LatencyEstimator({ halfLifeSamples: 1 });

    est.addSample(10);
    expect(est.getLatencyMs()!).toBeCloseTo(10, 9); // 10/1

    est.addSample(20);
    expect(est.getLatencyMs()!).toBeCloseTo((10 + 2 * 20) / 3, 9); // 16.6667

    est.addSample(40);
    expect(est.getLatencyMs()!).toBeCloseTo((10 + 2 * 20 + 4 * 40) / 7, 9); // 30
    expect(est.getLatencyMs()!).toBeCloseTo(30, 9);
    expect(est.getSampleCount()).toBe(3);
  });

  it('honours the half-life: a longer one reacts more slowly', () => {
    const quick = new LatencyEstimator({ halfLifeSamples: 1 });
    const slow = new LatencyEstimator({ halfLifeSamples: 16 });
    for (const est of [quick, slow]) {
      for (let i = 0; i < 8; i++) est.addSample(20); // warm edge
      for (let i = 0; i < 2; i++) est.addSample(220); // origin miss
    }
    // Both moved toward 220; the 1-sample half-life moved much further.
    expect(quick.getLatencyMs()!).toBeGreaterThan(slow.getLatencyMs()!);
    expect(quick.getLatencyMs()!).toBeGreaterThan(150);
    expect(slow.getLatencyMs()!).toBeLessThan(80);
  });

  it('converges on a sustained level and is NOT duration-weighted', () => {
    // One round trip costs one round trip whatever rode it, so a payload's
    // size can never enter here: the API takes ttfbMs only.
    const est = new LatencyEstimator();
    for (let i = 0; i < 60; i++) est.addSample(45);
    expect(est.getLatencyMs()!).toBeCloseTo(45, 9); // exact on a flat stream
    // 200 samples past the step = 25 half-lives, so the 155 ms of residual
    // decays to 155·2⁻²⁵ ≈ 5e-6.
    for (let i = 0; i < 200; i++) est.addSample(200);
    expect(est.getLatencyMs()!).toBeCloseTo(200, 4);
  });

  it('ignores measurement errors but keeps a genuine 0 ms', () => {
    const est = new LatencyEstimator();
    est.addSample(-1);
    est.addSample(Number.NaN);
    est.addSample(Number.POSITIVE_INFINITY);
    expect(est.getLatencyMs()).toBeNull();
    expect(est.getSampleCount()).toBe(0);

    est.addSample(0); // a cache hit at Date.now() resolution is real signal
    expect(est.getLatencyMs()).toBe(0);
    expect(est.getSampleCount()).toBe(1);
  });

  it('falls back to the default half-life for a nonsense option', () => {
    const bad = new LatencyEstimator({ halfLifeSamples: 0 });
    const def = new LatencyEstimator();
    for (let i = 0; i < 5; i++) {
      bad.addSample(10 * (i + 1));
      def.addSample(10 * (i + 1));
    }
    expect(bad.getLatencyMs()).toBe(def.getLatencyMs());
  });

  it('prices a request in bytes as L̂ × θ̂ (the shared exchange rate)', () => {
    // The warm-edge profile the coalesce-gap item quotes: L̂ ≈ 20 ms and
    // θ̂ ≈ 12.5 KB/ms ⇒ a request is worth ≈ 250 KB of over-fetch.
    const latency = new LatencyEstimator();
    for (let i = 0; i < 10; i++) latency.addSample(20);
    const throughput = new ThroughputEstimator();
    for (let i = 0; i < 10; i++) throughput.addSample(12_500 * 1000, 1000);

    const price =
      latency.getLatencyMs()! * throughput.getEstimate().bytesPerMs!;
    expect(price).toBeCloseTo(250_000, 3);
  });
});

describe('estimator determinism', () => {
  /** One scripted trace: mixed rates, durations, and TTFBs. */
  function runTrace(): {
    point: number[];
    stdDev: number[];
    conservative: number[];
    latency: number[];
  } {
    const rand = lcg(0x5eed_1234);
    const throughput = new ThroughputEstimator();
    const latency = new LatencyEstimator();
    const point: number[] = [];
    const stdDev: number[] = [];
    const conservative: number[] = [];
    const lat: number[] = [];

    for (let i = 0; i < 200; i++) {
      const duration = 10 + Math.floor(rand() * 900);
      const rate = 5 + rand() * 300;
      throughput.addSample(rate * duration, duration);
      latency.addSample(8 + rand() * 250);

      const e = throughput.getEstimate();
      point.push(e.bytesPerMs!);
      stdDev.push(e.stdDev!);
      conservative.push(throughput.getConservativeRate(1)!);
      lat.push(latency.getLatencyMs()!);
    }
    return { point, stdDev, conservative, latency: lat };
  }

  it('fixed injected samples ⇒ bit-identical outputs across re-runs', () => {
    const a = runTrace();
    const b = runTrace();
    // toEqual on number[] is exact equality per element — no tolerance. No
    // clock, no RNG, no iteration-order dependence reaches these values.
    expect(b.point).toEqual(a.point);
    expect(b.stdDev).toEqual(a.stdDev);
    expect(b.conservative).toEqual(a.conservative);
    expect(b.latency).toEqual(a.latency);
    expect(a.point).toHaveLength(200);
  });

  it('sample ORDER matters, so the trace is a real fingerprint', () => {
    // Guard against a degenerate "always equal" determinism test: the same
    // multiset of samples in a different order must NOT produce the same
    // numbers, or the check above would prove nothing.
    const forward = new ThroughputEstimator();
    const reverse = new ThroughputEstimator();
    const samples: Array<[number, number]> = [
      [100_000, 1000],
      [10_000, 500],
      [900_000, 2000],
      [5_000, 250],
    ];
    for (const [bytes, ms] of samples) forward.addSample(bytes, ms);
    for (const [bytes, ms] of [...samples].reverse()) {
      reverse.addSample(bytes, ms);
    }
    expect(forward.getEstimate().bytesPerMs).not.toBe(
      reverse.getEstimate().bytesPerMs,
    );
  });
});
