/**
 * The f32 precision guard, scaled to the animated span.
 *
 * `assertRelTimeInRange` used to warn on a fixed 2^24 ms magnitude. That is an
 * absolute constant (~4.7 hours), so any dataset with a window wider than that
 * tripped it BY CONSTRUCTION — the quickstart's own documented 30-day
 * `timeWindow` printed the warning on its first render, and so did the live
 * showcase, both telling the reader to go and check a time offset that was
 * correct (DX review 2026-08-26, F5).
 *
 * These cases pin the replacement: silence when the quantization step cannot
 * be observed against the window being animated, and a warning that still
 * fires for the mismatch the guard exists to catch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  assertRelTimeInRange,
  f32QuantumAt,
  relativizeTime,
  MAX_RELATIVE_TIME_MS,
  _resetRelTimeWarnings,
} from '../src/render/time-filter.js';

const DAY = 86_400_000;

/** Run the guard and return the `[stt/time-filter]` warnings it emitted. */
function warningsFrom(fn: () => void): string[] {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes('[stt/time-filter]'));
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  _resetRelTimeWarnings();
});

describe('f32QuantumAt', () => {
  it('is 1 ms at the 2^24 contract boundary', () => {
    expect(f32QuantumAt(MAX_RELATIVE_TIME_MS)).toBe(2);
    expect(f32QuantumAt(MAX_RELATIVE_TIME_MS - 1)).toBe(1);
  });

  it('doubles each octave', () => {
    expect(f32QuantumAt(2 ** 25)).toBe(4);
    expect(f32QuantumAt(2 ** 26)).toBe(8);
  });

  it('matches the real Float32Array spacing', () => {
    for (const magnitude of [5e6, 8.76e7, 1.15e9, 1.7e12]) {
      const step = f32QuantumAt(magnitude);
      const stored = Math.fround(magnitude);
      // The next representable value up is exactly one step away.
      expect(Math.fround(stored + step)).not.toBe(stored);
      expect(Math.fround(stored + step / 4)).toBe(stored);
    }
  });

  it('is 0 below a millisecond of magnitude, and for non-finite input', () => {
    expect(f32QuantumAt(0)).toBe(0);
    expect(f32QuantumAt(0.5)).toBe(0);
    expect(f32QuantumAt(Number.NaN)).toBe(0);
    expect(f32QuantumAt(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('assertRelTimeInRange is silent on the documented path', () => {
  it('says nothing for the quickstart (30-day window, measured -87,598,707)', () => {
    // The exact relative time the DX review measured on the first render of
    // docs/intro/quickstart.md. Step here is 8 ms — half a 60 fps frame.
    const warnings = warningsFrom(() =>
      assertRelTimeInRange(-87_598_707, 'window', 'quickstart', 30 * DAY),
    );
    expect(f32QuantumAt(-87_598_707)).toBe(8);
    expect(warnings).toEqual([]);
  });

  it('says nothing for the live showcase (measured 1,150,859,376.877)', () => {
    // Step here is 128 ms — over a frame, but five parts in 100 million of a
    // 30-day window, so no feature's visibility moves by anything observable.
    const warnings = warningsFrom(() =>
      assertRelTimeInRange(1_150_859_376.877, 'window', 'showcase', 30 * DAY),
    );
    expect(f32QuantumAt(1_150_859_376.877)).toBe(128);
    expect(warnings).toEqual([]);
  });

  it('stays silent across a whole 30-day window swept from its own offset', () => {
    const warnings = warningsFrom(() => {
      for (let dt = -15 * DAY; dt <= 15 * DAY; dt += DAY / 4) {
        assertRelTimeInRange(dt, 'window', 'sweep', 30 * DAY);
      }
    });
    expect(warnings).toEqual([]);
  });

  it('never warns in cumulative mode, which spans years by design', () => {
    const warnings = warningsFrom(() =>
      assertRelTimeInRange(1.7e12, 'cumulative', 'cumulative', 0),
    );
    expect(warnings).toEqual([]);
  });
});

describe('assertRelTimeInRange still catches a real offset mismatch', () => {
  it('warns when a raw epoch reaches the shader as a relative time', () => {
    // `timeOffset: 0` against epoch-ms tile data — 131,072 ms of quantization,
    // against a one-hour window.
    const rel = relativizeTime(1_716_206_400_000, 0);
    const warnings = warningsFrom(() =>
      assertRelTimeInRange(rel, 'window', 'mismatch', 3_600_000),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/131072 ms in Float32/);
    expect(warnings[0]).toMatch(/3600000 ms window/);
    expect(warnings[0]).toMatch(/time offset does not match/);
  });

  it('warns when the step is a tenth of a percent of a narrow window', () => {
    // A 10-minute window with a step of 1024 ms: 0.17 % of the window, which
    // is over the fraction the guard calls expressible.
    const rel = 2 ** 33; // step = 2^10 = 1024 ms
    expect(f32QuantumAt(rel)).toBe(1024);
    const warnings = warningsFrom(() =>
      assertRelTimeInRange(rel, 'window', 'narrow', 600_000),
    );
    expect(warnings).toHaveLength(1);
  });

  it('falls back to the 2^24 magnitude rule when no span is supplied', () => {
    // With no span the historical magnitude rule applies — subject to the
    // one-frame floor, which in practice moves the first audible magnitude
    // from 2^24 (step 1 ms) up to 2^28 (step 32 ms). Everything between is a
    // sub-frame error nobody can observe, and saying so was the false positive
    // this guard was rewritten to stop.
    const over = warningsFrom(() =>
      assertRelTimeInRange(MAX_RELATIVE_TIME_MS * 16, 'window', 'no-span-over'),
    );
    expect(f32QuantumAt(MAX_RELATIVE_TIME_MS * 16)).toBe(32);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatch(/at millisecond resolution/);

    const under = warningsFrom(() =>
      assertRelTimeInRange(MAX_RELATIVE_TIME_MS / 2, 'window', 'no-span-under'),
    );
    expect(under).toEqual([]);

    // Squarely inside the old warn band, silent now: 1 ms of quantization.
    const subFrame = warningsFrom(() =>
      assertRelTimeInRange(MAX_RELATIVE_TIME_MS + 1, 'window', 'no-span-sub'),
    );
    expect(subFrame).toEqual([]);
  });

  it('dedupes per key, and a second dataset still reports', () => {
    const warnings = warningsFrom(() => {
      for (let i = 0; i < 5; i++) {
        assertRelTimeInRange(1.7e12 + i, 'window', 'dataset-a', 3_600_000);
      }
      assertRelTimeInRange(1.7e12, 'window', 'dataset-b', 3_600_000);
    });
    expect(warnings).toHaveLength(2);
  });
});

describe('the one-frame silence floor', () => {
  it('never warns while the step is under a 60 fps frame, whatever the span', () => {
    // Step 8 ms against a 1-second window: 0.8 % of the window on paper, but
    // under half a frame in absolute terms, so it cannot be observed.
    expect(f32QuantumAt(2 ** 26)).toBe(8);
    const warnings = warningsFrom(() =>
      assertRelTimeInRange(2 ** 26, 'window', 'sub-frame', 1000),
    );
    expect(warnings).toEqual([]);
  });
});
