/**
 * derive-params — the single source of truth that turns archive metadata
 * (+ authored overrides) into deterministic playback params. These tests pin
 * the FORMULA and the reconciliation-warning behaviour the whole ecosystem
 * (showcase, MCP view_map, external integrators) now depends on.
 */

import { describe, it, expect } from 'vitest';
import {
  resolvePlaybackParams,
  deriveFrameCount,
  deriveTrailLength,
  deriveViewStateFromBounds,
  DEFAULT_TARGET_PLAYBACK_SECONDS,
  DEFAULT_TIME_WINDOW_MS,
  MIN_TRAIL_LENGTH_MS,
  type PlaybackMetadataInput,
} from '../src/derive-params';

const HOUR = 3_600_000;

// A representative 24-hour dataset at a 1-hour native timestep.
const META: PlaybackMetadataInput = {
  timeRange: { start: 1_000_000_000_000, end: 1_000_000_000_000 + 24 * HOUR },
  temporalBucketMs: HOUR,
  minZoom: 4,
  maxZoom: 12,
  bounds: { minLon: -74, minLat: 40.5, maxLon: -73.7, maxLat: 40.9 },
  styleHints: { suggestedPlaybackSeconds: 45 },
};

/** Collect warnings instead of hitting the console. */
function warnSink() {
  const messages: string[] = [];
  return { onWarn: (m: string) => messages.push(m), messages };
}

describe('deriveFrameCount', () => {
  it('is ceil(span / bucket)', () => {
    expect(deriveFrameCount({ start: 0, end: 24 * HOUR }, HOUR)).toBe(24);
    // A partial final bucket still counts as a frame.
    expect(deriveFrameCount({ start: 0, end: 24 * HOUR + 1 }, HOUR)).toBe(25);
  });

  it('returns 0 when the timestep is unknown or the span is non-positive', () => {
    expect(deriveFrameCount({ start: 0, end: 24 * HOUR }, undefined)).toBe(0);
    expect(deriveFrameCount({ start: 0, end: 24 * HOUR }, 0)).toBe(0);
    expect(deriveFrameCount({ start: 100, end: 100 }, HOUR)).toBe(0);
    expect(deriveFrameCount({ start: 100, end: 50 }, HOUR)).toBe(0);
  });
});

describe('deriveTrailLength', () => {
  it('is max(timeWindow / 4, floor), mirroring MaplibreRenderer', () => {
    expect(deriveTrailLength(4 * HOUR)).toBe(HOUR);
    // Below the floor, clamps up.
    expect(deriveTrailLength(10_000)).toBe(MIN_TRAIL_LENGTH_MS);
  });
});

describe('resolvePlaybackParams — metadata-only', () => {
  it('derives every field from the archive with no overrides', () => {
    const r = resolvePlaybackParams(META);
    expect(r.timeRange).toEqual(META.timeRange);
    expect(r.span).toBe(24 * HOUR);
    expect(r.frameCount).toBe(24);
    expect(r.temporalBucketMs).toBe(HOUR);
    // suggestedPlaybackSeconds (45) drives the speed.
    expect(r.targetPlaybackSeconds).toBe(45);
    expect(r.baseSpeed).toBeCloseTo((24 * HOUR) / 45 / 1000, 6);
    // bucket * 24 = 24h == span → clamped to span.
    expect(r.timeWindow).toBe(24 * HOUR);
    // No authored aesthetics invented.
    expect(r.trailLength).toBeUndefined();
    expect(r.wakeLength).toBeUndefined();
  });

  it('falls back to DEFAULT_TARGET_PLAYBACK_SECONDS with no hint', () => {
    const r = resolvePlaybackParams({ ...META, styleHints: undefined });
    expect(r.targetPlaybackSeconds).toBe(DEFAULT_TARGET_PLAYBACK_SECONDS);
    expect(DEFAULT_TARGET_PLAYBACK_SECONDS).toBe(30);
  });

  it('uses the 24h window fallback when no bucket is declared', () => {
    const r = resolvePlaybackParams({
      timeRange: { start: 0, end: 1_000 * DEFAULT_TIME_WINDOW_MS },
    });
    expect(r.timeWindow).toBe(DEFAULT_TIME_WINDOW_MS);
    expect(r.frameCount).toBe(0); // unknown timestep
  });

  it('never throws and degrades safely on empty input', () => {
    const r = resolvePlaybackParams();
    expect(r.timeRange).toEqual({ start: 0, end: 0 });
    expect(r.span).toBe(0);
    expect(r.baseSpeed).toBe(0);
    expect(r.targetPlaybackSeconds).toBe(DEFAULT_TARGET_PLAYBACK_SECONDS);
    expect(r.frameCount).toBe(0);
  });
});

describe('resolvePlaybackParams — override precedence', () => {
  it('lets overrides beat the archive-derived defaults', () => {
    const r = resolvePlaybackParams(META, {
      targetPlaybackSeconds: 60,
      timeWindow: 2 * HOUR,
      trailLength: 90_000,
    });
    expect(r.targetPlaybackSeconds).toBe(60);
    expect(r.baseSpeed).toBeCloseTo((24 * HOUR) / 60 / 1000, 6);
    expect(r.timeWindow).toBe(2 * HOUR);
    expect(r.trailLength).toBe(90_000);
  });

  it('skips a nonsensical zero target so baseSpeed never goes infinite', () => {
    const r = resolvePlaybackParams(META, { targetPlaybackSeconds: 0 });
    expect(r.targetPlaybackSeconds).toBe(45); // falls through to the hint
    expect(Number.isFinite(r.baseSpeed)).toBe(true);
  });

  it('does not mutate its inputs (purity)', () => {
    const meta = structuredClone(META);
    const overrides = { targetPlaybackSeconds: 60, datasetId: 'x' };
    resolvePlaybackParams(meta, overrides);
    expect(meta).toEqual(META);
    expect(overrides).toEqual({ targetPlaybackSeconds: 60, datasetId: 'x' });
  });
});

describe('resolvePlaybackParams — timeRange reconciliation', () => {
  const M_START = META.timeRange!.start;
  const M_END = META.timeRange!.end;

  it('(a) respects an in-bounds authored SUBSET verbatim, no warning', () => {
    const { onWarn, messages } = warnSink();
    // A deliberate editorial sub-window well inside the archive extent
    // (the nyc-rideshare / osm-changesets pattern).
    const subset = { start: M_START + 4 * HOUR, end: M_END - 4 * HOUR };
    const r = resolvePlaybackParams(META, { timeRange: subset }, { onWarn });
    expect(messages).toHaveLength(0);
    expect(r.timeRange).toEqual(subset); // authored subset is honoured
    // span / frameCount are computed from the RESOLVED (subset) range.
    expect(r.span).toBe(16 * HOUR);
    expect(r.frameCount).toBe(16);
    expect(r.baseSpeed).toBeCloseTo((16 * HOUR) / 45 / 1000, 6);
  });

  it('(e) respects an authored range within tolerance of the archive, no warning', () => {
    const { onWarn, messages } = warnSink();
    // Nudged by half a bucket — inside tol, so treated as ~equal.
    const nudged = { start: M_START + HOUR / 2, end: M_END - HOUR / 2 };
    const r = resolvePlaybackParams(META, { timeRange: nudged }, { onWarn });
    expect(messages).toHaveLength(0);
    expect(r.timeRange).toEqual(nudged); // authored (not archive) is returned
  });

  it('(b) clamps the END when the authored range spills past the archive, and warns', () => {
    const { onWarn, messages } = warnSink();
    const spill = { start: M_START + HOUR, end: M_END + 10 * HOUR };
    const r = resolvePlaybackParams(
      META,
      { timeRange: spill, datasetId: 'ship-traffic' },
      { onWarn },
    );
    expect(r.timeRange).toEqual({ start: M_START + HOUR, end: M_END });
    // span / frameCount reflect the CLAMPED range, not the authored one.
    expect(r.span).toBe(23 * HOUR);
    expect(r.frameCount).toBe(23);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ship-traffic');
    expect(messages[0]).toContain('clamping to');
    // Both ranges named in the message.
    expect(messages[0]).toContain(String(M_END));
    expect(messages[0]).toContain(String(M_END + 10 * HOUR));
  });

  it('(c) clamps the START when the authored range begins before the archive, and warns', () => {
    const { onWarn, messages } = warnSink();
    const early = { start: M_START - 10 * HOUR, end: M_END - HOUR };
    const r = resolvePlaybackParams(
      META,
      { timeRange: early, datasetId: 'osm-nyc-draw' },
      { onWarn },
    );
    expect(r.timeRange).toEqual({ start: M_START, end: M_END - HOUR });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('osm-nyc-draw');
    expect(messages[0]).toContain('clamping to');
  });

  it('(d) falls back to the archive extent when there is no overlap, and warns', () => {
    const { onWarn, messages } = warnSink();
    const disjoint = { start: 0, end: 500 }; // entirely before the archive
    const r = resolvePlaybackParams(
      META,
      { timeRange: disjoint, datasetId: 'ecco-currents' },
      { onWarn },
    );
    expect(r.timeRange).toEqual(META.timeRange); // full archive extent
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ecco-currents');
    expect(messages[0]).toContain('archive extent');
  });

  it('adopts the authored range verbatim when the archive has none', () => {
    const { onWarn, messages } = warnSink();
    const authored = { start: 10, end: 20 };
    const r = resolvePlaybackParams(
      { temporalBucketMs: HOUR },
      { timeRange: authored },
      { onWarn },
    );
    expect(messages).toHaveLength(0);
    expect(r.timeRange).toEqual(authored);
  });
});

describe('resolvePlaybackParams — wake invariant', () => {
  it('bumps timeWindow up to 2×wakeLength and warns', () => {
    const { onWarn, messages } = warnSink();
    // ship-traffic shape: wake longer than half the rolling window.
    const r = resolvePlaybackParams(
      META,
      { timeWindow: HOUR, wakeLength: HOUR, datasetId: 'ship-traffic' },
      { onWarn },
    );
    expect(r.timeWindow).toBe(2 * HOUR);
    expect(r.wakeLength).toBe(HOUR);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ship-traffic');
    expect(messages[0]).toContain('wakeLength');
  });

  it('leaves a safe window untouched and stays silent', () => {
    const { onWarn, messages } = warnSink();
    const r = resolvePlaybackParams(
      META,
      { timeWindow: 4 * HOUR, wakeLength: HOUR },
      { onWarn },
    );
    expect(r.timeWindow).toBe(4 * HOUR);
    expect(messages).toHaveLength(0);
  });
});

describe('deriveViewStateFromBounds', () => {
  it('centres on the extent and fits a reasonable zoom', () => {
    const vs = deriveViewStateFromBounds(META.bounds!, {
      minZoom: META.minZoom,
      maxZoom: META.maxZoom,
    });
    expect(vs.longitude).toBeCloseTo(-73.85, 6);
    expect(vs.latitude).toBeCloseTo(40.7, 6);
    expect(vs.zoom).toBeGreaterThanOrEqual(META.minZoom!);
    expect(vs.zoom).toBeLessThanOrEqual(META.maxZoom!);
    // A ~0.3° metro extent is a city-scale zoom, not whole-globe.
    expect(vs.zoom).toBeGreaterThan(8);
  });

  it('is deterministic', () => {
    const a = deriveViewStateFromBounds(META.bounds!);
    const b = deriveViewStateFromBounds(META.bounds!);
    expect(a).toEqual(b);
  });

  it('falls back to a point zoom for a zero-area extent (clamped to maxZoom)', () => {
    const vs = deriveViewStateFromBounds(
      { minLon: 5, minLat: 5, maxLon: 5, maxLat: 5 },
      { maxZoom: 10 },
    );
    expect(vs.longitude).toBe(5);
    expect(vs.latitude).toBe(5);
    expect(vs.zoom).toBe(10); // DEFAULT_POINT_ZOOM (11) clamped to maxZoom
  });
});
