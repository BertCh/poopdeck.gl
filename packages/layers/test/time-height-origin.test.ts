/**
 * Space-time-cube altitude anchor (`timeHeightOrigin`) — f32 arithmetic and the
 * precision guards around it.
 *
 * THE BUG THIS PINS. `heightOrigin` is relativized against the tile's
 * `timeOffset` exactly like `currentTime`, but its default used to be `0` — the
 * Unix EPOCH, not the dataset start — and every layer forwards
 * `this.props.timeHeightOrigin` verbatim. With a realistic `timeOffset ≈
 * 1.72e12` that made the `heightOrigin` uniform ≈ `-1.72e12`, and the shader's
 *
 *     heightMeters = (heightTime - heightOrigin) * heightScale
 *
 * then evaluated `heightTime - heightOrigin ≈ 1.72e12` IN f32, where the ULP is
 * 131,072: every feature within ~131 s collapsed onto one altitude and the whole
 * layer lifted ~8.6e10 m off the planet at `timeHeightScale: 0.05`. Total,
 * silent failure of the cube.
 *
 * THE FIX. `null` (and a literal `0`, which is the same non-request) resolve to
 * a RELATIVE origin of `0` — altitude 0 at the tile's own `timeOffset` — and an
 * explicit origin that is far enough away to cost real altitude precision warns
 * once per root layer.
 *
 * Also covers the warn-key fix: `assertRelTimeInRange` used to be called with
 * the constant key `'TimeFilterExtension'`, so ONE dataset tripping the 2^24
 * threshold muted the guard for every other dataset on the map forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimeFilterExtension } from '../src/extensions/time-filter-extension';
import { _resetRelTimeWarnings } from '@poopdeck.gl/core/time-filter';
import { _resetWarnOnce } from '../src/lib/log';

/** Round a value through a Float32Array, as a shader uniform/attribute does. */
function f32(value: number): number {
  const a = new Float32Array(1);
  a[0] = value;
  return a[0];
}

/**
 * The shader's lift, evaluated the way the GPU evaluates it: BOTH operands and
 * the difference live in f32.
 * `vs:DECKGL_FILTER_GL_POSITION` → `(heightTime - heightOrigin) * heightScale`.
 */
function shaderLiftMeters(
  relativeVertexTime: number,
  heightOriginUniform: number,
  heightScale: number,
): number {
  return f32(
    f32(f32(relativeVertexTime) - f32(heightOriginUniform)) * heightScale,
  );
}

/** Drive `TimeFilterExtension.draw()` and return the timeFilter uniform block. */
function drawUniforms(props: Record<string, unknown>, id = 'root') {
  const ext = new TimeFilterExtension();
  let captured: any;
  const layer = {
    id,
    root: undefined as any,
    props,
    // `draw()` reads the model set to decide whether a partial uniform push is
    // safe (a freshly-rebuilt model has to be handed the whole block). A stub
    // with no models never caches, so every call here takes the full-push path
    // and captures the complete uniform block — which is what these tests read.
    getModels: () => [],
    setShaderModuleProps: (u: any) => {
      captured = u;
    },
  };
  (ext.draw as any).call(layer, {}, ext);
  return captured.timeFilter;
}

// A realistic per-chunk tile offset (2024-05-20T12:00:00Z-ish) and a dataset
// whose first sample sits right on it.
const TILE_OFFSET = 1_716_206_400_000;
const HEIGHT_SCALE = 0.05; // metres of altitude per simulation ms

describe('timeHeightOrigin f32 arithmetic', () => {
  /** Distinct altitudes produced by one sample per second over `spanMs`. */
  function distinctAltitudes(origin: number, spanMs: number): number {
    const seen = new Set<number>();
    for (let dt = 0; dt <= spanMs; dt += 1_000) {
      seen.add(shaderLiftMeters(dt, origin, HEIGHT_SCALE));
    }
    return seen.size;
  }

  it('REGRESSION: an epoch origin collapses ~131 s of data onto one altitude', () => {
    // What the old default produced: heightOrigin = relativize(0, timeOffset).
    const brokenOrigin = 0 - TILE_OFFSET;
    // 121 samples, one per second over two minutes — the f32 ULP at 1.72e12 is
    // 131,072, so they land in at most two altitude buckets.
    expect(distinctAltitudes(brokenOrigin, 120_000)).toBeLessThanOrEqual(2);
    // …and the whole layer is ~8.6e10 m up.
    expect(
      Math.abs(shaderLiftMeters(0, brokenOrigin, HEIGHT_SCALE)),
    ).toBeGreaterThan(1e10);
  });

  it('the resolved default (relative origin 0) keeps millisecond structure', () => {
    const origin = drawUniforms({
      currentTime: TILE_OFFSET,
      timeOffset: TILE_OFFSET,
      timeHeightScale: HEIGHT_SCALE,
    }).heightOrigin;
    expect(origin).toBe(0);
    // Every one of the same 121 samples now gets its own altitude…
    expect(distinctAltitudes(origin, 120_000)).toBe(121);
    // …resolved down to a single millisecond…
    const a = shaderLiftMeters(0, origin, HEIGHT_SCALE);
    const b = shaderLiftMeters(1, origin, HEIGHT_SCALE);
    expect(b - a).toBeCloseTo(HEIGHT_SCALE, 6);
    // …with feet on the ground, not 86 million km up.
    expect(a).toBe(0);
  });

  it('a literal 0 is the same non-request as null (the chassis default)', () => {
    // Every STT layer forwards `this.props.timeHeightOrigin` verbatim and the
    // composite's own default is 0, so this is the path real layers take today.
    expect(
      drawUniforms({
        currentTime: TILE_OFFSET,
        timeOffset: TILE_OFFSET,
        timeHeightScale: HEIGHT_SCALE,
        timeHeightOrigin: 0,
      }).heightOrigin,
    ).toBe(0);
  });

  it('an explicit dataset start relativizes and stays exact across a chunk', () => {
    const datasetStart = TILE_OFFSET - 3_600_000; // one hour before this chunk
    const origin = drawUniforms({
      currentTime: TILE_OFFSET,
      timeOffset: TILE_OFFSET,
      timeHeightScale: HEIGHT_SCALE,
      timeHeightOrigin: datasetStart,
    }).heightOrigin;
    expect(origin).toBe(-3_600_000);
    // The chunk floats an hour's worth of altitude above the dataset origin,
    // and one millisecond still resolves — to within the f32 ULP at 3.6e6 ms
    // (0.25 ms ⇒ ~1 cm here), not the 131 s the epoch origin cost.
    const a = shaderLiftMeters(0, origin, HEIGHT_SCALE);
    const b = shaderLiftMeters(1, origin, HEIGHT_SCALE);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeCloseTo(HEIGHT_SCALE, 1);
    expect(a).toBeCloseTo(3_600_000 * HEIGHT_SCALE, 0);
  });

  it('is tile-invariant: two chunks agree on the altitude of one absolute time', () => {
    const datasetStart = TILE_OFFSET - 7_200_000;
    const absoluteTime = TILE_OFFSET + 1_000;
    const lift = (tileOffset: number) => {
      const origin = drawUniforms({
        currentTime: tileOffset,
        timeOffset: tileOffset,
        timeHeightScale: HEIGHT_SCALE,
        timeHeightOrigin: datasetStart,
      }).heightOrigin;
      return shaderLiftMeters(absoluteTime - tileOffset, origin, HEIGHT_SCALE);
    };
    expect(lift(TILE_OFFSET)).toBeCloseTo(lift(TILE_OFFSET - 3_600_000), 0);
  });
});

describe('timeHeightOrigin precision guard', () => {
  beforeEach(() => {
    _resetWarnOnce();
    _resetRelTimeWarnings();
  });

  it('warns once when the origin costs more than a metre of altitude', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // An origin 1.7e12 ms away (someone passing a raw epoch as "the start").
      drawUniforms({
        timeOffset: TILE_OFFSET,
        timeHeightScale: HEIGHT_SCALE,
        timeHeightOrigin: 1, // ~1.7e12 ms from the tile offset
      });
      const hits = warn.mock.calls.filter(([m]) =>
        String(m).includes('timeHeightOrigin'),
      );
      expect(hits.length).toBe(1);
      expect(String(hits[0][0])).toMatch(/quantizes to/);
      drawUniforms({
        timeOffset: TILE_OFFSET,
        timeHeightScale: HEIGHT_SCALE,
        timeHeightOrigin: 1,
      });
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes('timeHeightOrigin'))
          .length,
      ).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet for a legitimate multi-day origin (the 2^24 rule is not the test)', () => {
    // 3 days from the chunk offset — far past MAX_RELATIVE_TIME_MS (2^24), but
    // at a cube-appropriate height scale the f32 error is millimetres. A raw
    // 2^24 guard here would be a false positive on every wide-span dataset.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      drawUniforms({
        timeOffset: TILE_OFFSET,
        timeHeightScale: 0.0001,
        timeHeightOrigin: TILE_OFFSET - 3 * 86_400_000,
      });
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes('timeHeightOrigin'))
          .length,
      ).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when the cube is off (timeHeightScale 0)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      drawUniforms({ timeOffset: TILE_OFFSET, timeHeightOrigin: 1 });
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes('timeHeightOrigin'))
          .length,
      ).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('assertRelTimeInRange warn key is per-layer, not global', () => {
  beforeEach(() => {
    _resetWarnOnce();
    _resetRelTimeWarnings();
  });

  it('a second dataset still reports after the first has tripped the guard', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Dataset A legitimately runs a very wide window and trips 2^24 once.
      drawUniforms(
        { currentTime: TILE_OFFSET, timeOffset: 0 },
        'stt-dataset-a',
      );
      // Dataset B has a genuinely mismatched timeOffset — the exact bug the
      // guard exists to catch. With the old constant key it was silent forever.
      drawUniforms(
        { currentTime: TILE_OFFSET, timeOffset: 0 },
        'stt-dataset-b',
      );
      const hits = warn.mock.calls.filter(([m]) =>
        String(m).includes('stt/time-filter'),
      );
      expect(hits.length).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('still dedupes within one layer (no per-frame spam)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) {
        drawUniforms(
          { currentTime: TILE_OFFSET + i, timeOffset: 0 },
          'stt-dataset-a',
        );
      }
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes('stt/time-filter'))
          .length,
      ).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keys on the ROOT composite id, so per-tile sublayers share one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ext = new TimeFilterExtension();
      const root = { id: 'stt-quakes' };
      for (const tileId of ['tile-3-1-2', 'tile-3-1-3', 'tile-3-2-2']) {
        (ext.draw as any).call(
          {
            id: tileId,
            root,
            props: { currentTime: TILE_OFFSET, timeOffset: 0 },
            getModels: () => [],
            setShaderModuleProps: () => {},
          },
          {},
          ext,
        );
      }
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes('stt/time-filter'))
          .length,
      ).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
