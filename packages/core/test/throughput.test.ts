/**
 * Tests for the dual-EWMA throughput estimator (player buffering WS-A).
 *
 * The estimator feeds `estimateTimeToReadyMs`: each completed coalesced
 * range response contributes one (bytes, elapsedMs) sample, two EWMAs with
 * 3 s / 9 s half-lives track the rate (duration-weighted, hls.js-style), and
 * the published estimate is min(fast, slow) — react fast to drops, rise
 * cautiously after recoveries.
 */

import { describe, it, expect } from 'vitest';
import { ThroughputEstimator } from '../src/throughput';

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
