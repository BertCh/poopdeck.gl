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
  DEFAULT_TIME_WINDOW_BUCKETS,
  DEFAULT_TIME_WINDOW_MS,
  MIN_TRAIL_LENGTH_MS,
  type PlaybackMetadataInput,
  type PlaybackOverrides,
  type ResolvedPlaybackParams,
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

// ---------------------------------------------------------------------------
// BH-10 — the build-time `suggestedTimeWindowMs` hint.
//
// The writer measures the widest resident window a reference client can
// afford (`suggested_time_window_ms` on the wire, capped at 24 native
// buckets) and the reader consumes it as a DEFAULT. The whole point of the
// item is that this is BYTE-NEUTRAL on the reader side: an archive that
// carries no hint must resolve EXACTLY as it did before the field existed.
// ---------------------------------------------------------------------------

const T0 = META.timeRange!.start;

/** META, plus a build-time loader-window hint. */
function withWindowHint(
  suggestedTimeWindowMs: number | undefined,
  meta: PlaybackMetadataInput = META,
): PlaybackMetadataInput {
  return {
    ...meta,
    styleHints: { ...meta.styleHints, suggestedTimeWindowMs },
  };
}

describe('resolvePlaybackParams — suggestedTimeWindowMs precedence (BH-10 case 4)', () => {
  it('a hint beats the bucket-derived default', () => {
    const { onWarn, messages } = warnSink();
    // Without the hint this dataset resolves to bucket × 24 == span == 24h.
    expect(resolvePlaybackParams(META, {}, { onWarn }).timeWindow).toBe(
      24 * HOUR,
    );
    const r = resolvePlaybackParams(withWindowHint(6 * HOUR), {}, { onWarn });
    expect(r.timeWindow).toBe(6 * HOUR);
    expect(messages).toHaveLength(0); // a hint is a default, not a hazard
  });

  it('an authored timeWindow beats the hint (full override ?? hint ?? default chain)', () => {
    const meta = withWindowHint(6 * HOUR);
    // 1. override wins outright.
    expect(resolvePlaybackParams(meta, { timeWindow: 90_000 }).timeWindow).toBe(
      90_000,
    );
    // 2. no override → the hint.
    expect(resolvePlaybackParams(meta, {}).timeWindow).toBe(6 * HOUR);
    // 3. no override, no hint → bucket × DEFAULT_TIME_WINDOW_BUCKETS.
    expect(
      resolvePlaybackParams(withWindowHint(undefined), {}).timeWindow,
    ).toBe(Math.min(HOUR * DEFAULT_TIME_WINDOW_BUCKETS, 24 * HOUR));
  });

  it('a non-positive authored window still falls through to the hint, not past it', () => {
    const meta = withWindowHint(6 * HOUR);
    // `timeWindow: 0` is the documented "unset" escape hatch — it must land on
    // the hint, exactly as it lands on the bucket default when no hint exists.
    expect(resolvePlaybackParams(meta, { timeWindow: 0 }).timeWindow).toBe(
      6 * HOUR,
    );
    expect(resolvePlaybackParams(meta, { timeWindow: -1 }).timeWindow).toBe(
      6 * HOUR,
    );
  });

  it('the hint replaces the 24h ultimate fallback when the archive declares no bucket', () => {
    const r = resolvePlaybackParams({
      timeRange: { start: 0, end: 1_000 * DEFAULT_TIME_WINDOW_MS },
      styleHints: { suggestedTimeWindowMs: 3 * HOUR },
    });
    expect(r.timeWindow).toBe(3 * HOUR);
    expect(r.frameCount).toBe(0); // still no timestep
  });

  it('the hint is span-clamped like the bucket default (never wider than the data)', () => {
    // 6h archive, hint asks for 30h → clamped to the 6h span.
    const r = resolvePlaybackParams(
      withWindowHint(30 * HOUR, {
        timeRange: { start: T0, end: T0 + 6 * HOUR },
        temporalBucketMs: HOUR,
      }),
    );
    expect(r.timeWindow).toBe(6 * HOUR);
  });

  it('a nonsensical hint falls through to the bucket default exactly as an absent one would', () => {
    const baseline = resolvePlaybackParams(
      withWindowHint(undefined),
    ).timeWindow;
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolvePlaybackParams(withWindowHint(bad)).timeWindow).toBe(
        baseline,
      );
    }
  });

  it('the hint moves ONLY timeWindow — every other resolved field is untouched', () => {
    const plain = resolvePlaybackParams(META);
    const hinted = resolvePlaybackParams(withWindowHint(6 * HOUR));
    expect(hinted.timeWindow).toBe(6 * HOUR);
    expect({ ...hinted, timeWindow: plain.timeWindow }).toStrictEqual(plain);
    // In particular the duration hint keeps driving the speed (already flowed).
    expect(hinted.targetPlaybackSeconds).toBe(45);
  });

  it('stays the single pure resolver: identical inputs → identical outputs', () => {
    const meta = withWindowHint(6 * HOUR);
    const overrides: PlaybackOverrides = { wakeLength: HOUR, datasetId: 'd' };
    const a = resolvePlaybackParams(meta, overrides, { onWarn: () => {} });
    const b = resolvePlaybackParams(meta, overrides, { onWarn: () => {} });
    expect(a).toStrictEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // …and it did not mutate the hint block.
    expect(meta.styleHints).toStrictEqual({
      suggestedPlaybackSeconds: 45,
      suggestedTimeWindowMs: 6 * HOUR,
    });
  });
});

// ---------------------------------------------------------------------------
// BH-10 — the CROSS-PACKAGE SEAM, pinned from the reader side.
//
// The window hint crosses three layers, each with its own spelling of the same
// idea:
//
//   1. `stt_core::metadata::StyleHints::suggested_time_window_ms` (snake_case,
//      emitted by `stt-build --derived-playback-params`),
//   2. `parseStyleHints` in `@poopdeck.gl/core`'s `archive.ts` — the ONE hop
//      that renames it to `suggestedTimeWindowMs`,
//   3. this resolver, which reads that camelCase name as the loader-window
//      DEFAULT.
//
// A disagreement anywhere in that chain is SILENT: nothing throws, the field is
// simply dropped and every archive keeps the bucket-derived window forever.
// (That is exactly what shipped — hop 2 never listed the field, so the writer
// could emit it and no player would ever see it.) `@poopdeck.gl/playback`
// deliberately does not depend on `@poopdeck.gl/core`, so the seam is pinned
// from BOTH ends instead of by one import: hop 2's half lives in
// `packages/core/test/style-hints.test.ts` ("maps suggested_time_window_ms onto
// suggestedTimeWindowMs"), and hop 3's half is below — it observes which keys
// the resolver actually reads, so a rename on THIS side goes red here and a
// rename on the other side goes red there.
// ---------------------------------------------------------------------------

/** Records every property name the resolver reads off the hint block. */
function observedHints(
  hints: Record<string, unknown>,
): [PlaybackMetadataInput['styleHints'], string[]] {
  const read: string[] = [];
  const proxy = new Proxy(hints, {
    get(target, key, receiver) {
      if (typeof key === 'string') read.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  return [proxy as PlaybackMetadataInput['styleHints'], read];
}

describe('resolvePlaybackParams — the core-parser seam (BH-10 end-to-end)', () => {
  it('reads the hints under the exact camelCase names parseStyleHints writes', () => {
    const [styleHints, read] = observedHints({
      suggestedPlaybackSeconds: 45,
      suggestedTimeWindowMs: 6 * HOUR,
    });
    const r = resolvePlaybackParams({ ...META, styleHints });
    // The names the reader asked for ARE the names the parser emits. If either
    // side is renamed, one of these two assertions fails loudly instead of the
    // hint quietly never applying.
    expect(read).toContain('suggestedTimeWindowMs');
    expect(read).toContain('suggestedPlaybackSeconds');
    expect(r.timeWindow).toBe(6 * HOUR);
    expect(r.targetPlaybackSeconds).toBe(45);
  });

  it('a manifest that carries the field resolves to the hinted window', () => {
    // The shape `parseStyleHints` produces from a manifest whose `style_hints`
    // block carries `suggested_time_window_ms: 21600000` (the fixture pinned in
    // `packages/core/test/style-hints.test.ts`), handed to the resolver exactly
    // as `useArchiveMetadata` → `resolvePlaybackParams` hands it over.
    const parsed = {
      version: 1,
      properties: [],
      suggestedPlaybackSeconds: 45,
      suggestedTimeWindowMs: 21_600_000,
    };
    const r = resolvePlaybackParams({
      ...META,
      styleHints: parsed as PlaybackMetadataInput['styleHints'],
    });
    expect(r.timeWindow).toBe(21_600_000);
  });

  it('a manifest WITHOUT the field is byte-identical to the pre-hint resolution', () => {
    // Same manifest minus the one field — every resolved field must match the
    // no-hint answer exactly (this is the reader-side byte-neutrality claim,
    // stated per-field rather than only over the NO_HINT_PIN table).
    const parsed = {
      version: 1,
      properties: [],
      suggestedPlaybackSeconds: 45,
    };
    const withField = resolvePlaybackParams({
      ...META,
      styleHints: { ...parsed, suggestedTimeWindowMs: 21_600_000 },
    });
    const withoutField = resolvePlaybackParams({
      ...META,
      styleHints: parsed as PlaybackMetadataInput['styleHints'],
    });
    expect(withoutField).toStrictEqual(resolvePlaybackParams(META));
    expect(withoutField.timeWindow).toBe(24 * HOUR); // bucket × 24, span-clamped
    expect(withField.timeWindow).toBe(21_600_000);
  });

  it('does NOT read the raw snake_case wire name — the parser hop is mandatory', () => {
    // Guards against "fixing" a future seam break in the wrong layer by making
    // the resolver snake_case-tolerant. `parseStyleHints` builds a fresh object
    // from known keys, so an unrenamed wire key can never reach here anyway;
    // teaching the resolver two spellings of one field would give the ecosystem
    // two answers to the same question.
    const wireOnly = {
      suggested_time_window_ms: 6 * HOUR,
      suggested_playback_seconds: 60,
    } as unknown as PlaybackMetadataInput['styleHints'];
    const r = resolvePlaybackParams({ ...META, styleHints: wireOnly });
    expect(r.timeWindow).toBe(24 * HOUR); // bucket default, hint not applied
    expect(r.targetPlaybackSeconds).toBe(DEFAULT_TARGET_PLAYBACK_SECONDS);
  });
});

describe('resolvePlaybackParams — wake invariant over a hinted window (BH-10 case 5)', () => {
  it('lifts a hint-derived window to 2×wakeLength and warns', () => {
    const { onWarn, messages } = warnSink();
    const r = resolvePlaybackParams(
      withWindowHint(HOUR),
      { wakeLength: HOUR, datasetId: 'ship-traffic' },
      { onWarn },
    );
    // The hint said 1h; the wake invariant overrules it upward.
    expect(r.timeWindow).toBe(2 * HOUR);
    expect(r.wakeLength).toBe(HOUR);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ship-traffic');
    expect(messages[0]).toContain('wakeLength');
    // The warning quotes the pre-lift (hint-derived) value.
    expect(messages[0]).toContain(`${HOUR}ms is below`);
  });

  it('leaves a hint that already satisfies the invariant alone, silently', () => {
    const { onWarn, messages } = warnSink();
    const r = resolvePlaybackParams(
      withWindowHint(4 * HOUR),
      { wakeLength: HOUR },
      { onWarn },
    );
    expect(r.timeWindow).toBe(4 * HOUR);
    expect(messages).toHaveLength(0);
  });

  it('applies the invariant AFTER precedence, so it lifts an override and a hint alike', () => {
    const { onWarn } = warnSink();
    const overridden = resolvePlaybackParams(
      withWindowHint(4 * HOUR),
      { timeWindow: HOUR, wakeLength: HOUR },
      { onWarn },
    );
    const hinted = resolvePlaybackParams(
      withWindowHint(HOUR),
      { wakeLength: HOUR },
      { onWarn },
    );
    expect(overridden.timeWindow).toBe(2 * HOUR);
    expect(hinted.timeWindow).toBe(2 * HOUR);
  });
});

/**
 * BH-10 case 6 — REGRESSION PIN.
 *
 * Every row was RECORDED from the pre-BH-10 resolver (`git show
 * HEAD:packages/playback/src/derive-params.ts`, executed over exactly this
 * table) and must not move. No row carries a `suggestedTimeWindowMs`, so the
 * whole table is the proof of the item's byte-neutrality claim on the reader
 * side: absent hint ⇒ resolution identical to today, field-for-field.
 *
 * If a row goes red, the hint has leaked into the no-hint path — that is a
 * bug in the resolver, not a stale expectation. Do not re-bless it.
 */
const NO_HINT_PIN: {
  name: string;
  metadata: PlaybackMetadataInput;
  overrides: PlaybackOverrides;
  expected: ResolvedPlaybackParams;
}[] = [
  {
    name: 'empty input',
    metadata: {},
    overrides: {},
    expected: {
      timeRange: { start: 0, end: 0 },
      span: 0,
      baseSpeed: 0,
      targetPlaybackSeconds: 30,
      timeWindow: 86_400_000,
      frameCount: 0,
    },
  },
  {
    name: 'legacy hint block (duration only)',
    metadata: META,
    overrides: {},
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 1920,
      targetPlaybackSeconds: 45,
      timeWindow: 86_400_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'no style hints at all',
    metadata: { ...META, styleHints: undefined },
    overrides: {},
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 2880,
      targetPlaybackSeconds: 30,
      timeWindow: 86_400_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'no bucket, huge span → 24h fallback',
    metadata: { timeRange: { start: 0, end: 1_000 * 86_400_000 } },
    overrides: {},
    expected: {
      timeRange: { start: 0, end: 86_400_000_000 },
      span: 86_400_000_000,
      baseSpeed: 2_880_000,
      targetPlaybackSeconds: 30,
      timeWindow: 86_400_000,
      frameCount: 0,
    },
  },
  {
    name: 'no bucket, tiny span → span clamp',
    metadata: { timeRange: { start: 0, end: 60_000 } },
    overrides: {},
    expected: {
      timeRange: { start: 0, end: 60_000 },
      span: 60_000,
      baseSpeed: 2,
      targetPlaybackSeconds: 30,
      timeWindow: 60_000,
      frameCount: 0,
    },
  },
  {
    name: 'bucket×24 wider than span → span clamp',
    metadata: {
      timeRange: { start: T0, end: T0 + 6 * HOUR },
      temporalBucketMs: HOUR,
    },
    overrides: {},
    expected: {
      timeRange: { start: T0, end: T0 + 6 * HOUR },
      span: 21_600_000,
      baseSpeed: 720,
      targetPlaybackSeconds: 30,
      timeWindow: 21_600_000,
      frameCount: 6,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'bucket×24 narrower than span',
    metadata: {
      timeRange: { start: T0, end: T0 + 30 * 24 * HOUR },
      temporalBucketMs: HOUR,
    },
    overrides: {},
    expected: {
      timeRange: { start: T0, end: T0 + 30 * 24 * HOUR },
      span: 2_592_000_000,
      baseSpeed: 86_400,
      targetPlaybackSeconds: 30,
      timeWindow: 86_400_000,
      frameCount: 720,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'authored timeWindow',
    metadata: META,
    overrides: { timeWindow: 2 * HOUR },
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 1920,
      targetPlaybackSeconds: 45,
      timeWindow: 7_200_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'authored timeWindow = 0 falls through',
    metadata: META,
    overrides: { timeWindow: 0 },
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 1920,
      targetPlaybackSeconds: 45,
      timeWindow: 86_400_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'authored timeWindow negative falls through',
    metadata: META,
    overrides: { timeWindow: -5 },
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 1920,
      targetPlaybackSeconds: 45,
      timeWindow: 86_400_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'wake lift over an authored window',
    metadata: META,
    overrides: { timeWindow: HOUR, wakeLength: HOUR },
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 1920,
      targetPlaybackSeconds: 45,
      timeWindow: 7_200_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
      wakeLength: HOUR,
    },
  },
  {
    name: 'wake lift over the bucket default',
    metadata: {
      timeRange: { start: T0, end: T0 + 30 * 24 * HOUR },
      temporalBucketMs: HOUR,
    },
    overrides: { wakeLength: 20 * HOUR },
    expected: {
      timeRange: { start: T0, end: T0 + 30 * 24 * HOUR },
      span: 2_592_000_000,
      baseSpeed: 86_400,
      targetPlaybackSeconds: 30,
      timeWindow: 144_000_000,
      frameCount: 720,
      temporalBucketMs: HOUR,
      wakeLength: 72_000_000,
    },
  },
  {
    name: 'authored in-bounds subset range',
    metadata: META,
    overrides: { timeRange: { start: T0 + 4 * HOUR, end: T0 + 20 * HOUR } },
    expected: {
      timeRange: { start: T0 + 4 * HOUR, end: T0 + 20 * HOUR },
      span: 57_600_000,
      baseSpeed: 1280,
      targetPlaybackSeconds: 45,
      timeWindow: 57_600_000,
      frameCount: 16,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'authored spilling range → clamped to the overlap',
    metadata: META,
    overrides: { timeRange: { start: T0 + HOUR, end: T0 + 34 * HOUR } },
    expected: {
      timeRange: { start: T0 + HOUR, end: T0 + 24 * HOUR },
      span: 82_800_000,
      baseSpeed: 1840,
      targetPlaybackSeconds: 45,
      timeWindow: 82_800_000,
      frameCount: 23,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'authored disjoint range → archive extent',
    metadata: META,
    overrides: { timeRange: { start: 0, end: 500 } },
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 1920,
      targetPlaybackSeconds: 45,
      timeWindow: 86_400_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'no archive range + authored range',
    metadata: { temporalBucketMs: HOUR },
    overrides: { timeRange: { start: 10, end: 20 } },
    expected: {
      timeRange: { start: 10, end: 20 },
      span: 10,
      baseSpeed: 10 / 30 / 1000,
      targetPlaybackSeconds: 30,
      timeWindow: 10,
      frameCount: 1,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'zero span',
    metadata: { timeRange: { start: T0, end: T0 }, temporalBucketMs: HOUR },
    overrides: {},
    expected: {
      timeRange: { start: T0, end: T0 },
      span: 0,
      baseSpeed: 0,
      targetPlaybackSeconds: 30,
      timeWindow: 86_400_000,
      frameCount: 0,
      temporalBucketMs: HOUR,
    },
  },
  {
    name: 'declared bucket of 0',
    metadata: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      temporalBucketMs: 0,
    },
    overrides: {},
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 2880,
      targetPlaybackSeconds: 30,
      timeWindow: 86_400_000,
      frameCount: 0,
      temporalBucketMs: 0,
    },
  },
  {
    name: 'trail + wake pass-through',
    metadata: META,
    overrides: { trailLength: 90_000, wakeLength: 30_000 },
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 1920,
      targetPlaybackSeconds: 45,
      timeWindow: 86_400_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
      trailLength: 90_000,
      wakeLength: 30_000,
    },
  },
  {
    name: 'authored targetPlaybackSeconds',
    metadata: META,
    overrides: { targetPlaybackSeconds: 60 },
    expected: {
      timeRange: { start: T0, end: T0 + 24 * HOUR },
      span: 86_400_000,
      baseSpeed: 1440,
      targetPlaybackSeconds: 60,
      timeWindow: 86_400_000,
      frameCount: 24,
      temporalBucketMs: HOUR,
    },
  },
];

describe('resolvePlaybackParams — absent hint is byte-identical to pre-BH-10 (case 6)', () => {
  for (const { name, metadata, overrides, expected } of NO_HINT_PIN) {
    it(`pin: ${name}`, () => {
      const r = resolvePlaybackParams(metadata, overrides, {
        onWarn: () => {},
      });
      // toStrictEqual, so an accidentally-emitted `undefined` field fails too.
      expect(r).toStrictEqual(expected);
    });
  }

  it('covers every branch of the timeWindow decision', () => {
    // Sanity on the pin itself: it must exercise the override branch, the
    // bucket branch, the ultimate-24h branch, the span clamp and the wake lift.
    const windows = NO_HINT_PIN.map((c) => c.expected.timeWindow);
    expect(new Set(windows).size).toBeGreaterThanOrEqual(7);
    expect(NO_HINT_PIN).toHaveLength(20);
    // No row may carry a window hint — that is what makes it a no-hint pin.
    for (const c of NO_HINT_PIN) {
      expect(c.metadata.styleHints?.suggestedTimeWindowMs).toBeUndefined();
    }
  });

  it('keeps the resolved-field ORDER stable (JSON shape pin)', () => {
    const r = resolvePlaybackParams(META, {
      trailLength: 1,
      wakeLength: 2,
    });
    expect(Object.keys(r)).toEqual([
      'timeRange',
      'span',
      'baseSpeed',
      'targetPlaybackSeconds',
      'timeWindow',
      'frameCount',
      'temporalBucketMs',
      'trailLength',
      'wakeLength',
    ]);
  });
});

describe('resolvePlaybackParams — authored range semantics survive the hint (case 7)', () => {
  // "Authored range semantics" is a PINNED register entry. The existing
  // `timeRange reconciliation` suite above is its primary guard and is
  // deliberately left unmodified; these cases prove the new hint does not
  // reach into it.

  it('an in-bounds authored SUBSET is still respected verbatim, hint or not', () => {
    const { onWarn, messages } = warnSink();
    const subset = { start: T0 + 4 * HOUR, end: T0 + 20 * HOUR };
    const r = resolvePlaybackParams(
      withWindowHint(6 * HOUR),
      { timeRange: subset },
      { onWarn },
    );
    expect(messages).toHaveLength(0);
    expect(r.timeRange).toStrictEqual(subset);
    expect(r.span).toBe(16 * HOUR);
    expect(r.frameCount).toBe(16);
    // The hint only ever touches the loader window.
    expect(r.timeWindow).toBe(6 * HOUR);
  });

  it('an out-of-bounds authored range is still clamped to the overlap and warned about', () => {
    const { onWarn, messages } = warnSink();
    const spill = { start: T0 + HOUR, end: T0 + 34 * HOUR };
    const r = resolvePlaybackParams(
      withWindowHint(6 * HOUR),
      { timeRange: spill, datasetId: 'ship-traffic' },
      { onWarn },
    );
    expect(r.timeRange).toStrictEqual({
      start: T0 + HOUR,
      end: T0 + 24 * HOUR,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('clamping to');
  });

  it('a hint never narrows or widens the resolved timeRange', () => {
    const overrides: PlaybackOverrides = {
      timeRange: { start: T0 + 4 * HOUR, end: T0 + 20 * HOUR },
    };
    const plain = resolvePlaybackParams(META, overrides, { onWarn: () => {} });
    for (const w of [HOUR, 6 * HOUR, 999 * HOUR, undefined]) {
      const hinted = resolvePlaybackParams(withWindowHint(w), overrides, {
        onWarn: () => {},
      });
      expect(hinted.timeRange).toStrictEqual(plain.timeRange);
      expect(hinted.span).toBe(plain.span);
      expect(hinted.frameCount).toBe(plain.frameCount);
      expect(hinted.baseSpeed).toBe(plain.baseSpeed);
    }
  });
});
