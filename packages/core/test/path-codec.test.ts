/**
 * The layer-frame `PATH_CODEC` section (tag 0x06, capability `path-codec`):
 * the decoder in `src/path-codec.ts` against the test-only reference encoder
 * in `helpers/path-codec-encoder.ts`, both written from the wire spec
 * (`stt:docs/roadmap/path-codec-wire-2026-11.md`).
 *
 * Three layers of evidence:
 *   1. round trips of both coordinate modes over the awkward inputs (empty and
 *      single-vertex features, unsorted and negative times, >32-bit varints,
 *      non-decimal doubles, TIME_VEL with its `dt0 <= 0` fallback), compared
 *      BIT-exactly;
 *   2. one must-throw case per spec §4 rejection, plus truncation and
 *      mutation fuzz (every failure a named `Error`, never an out-of-bounds
 *      read or a hang);
 *   3. full v2 frames: a codec layer decodes through `decodeTile` AND
 *      `toGeoArrowTable` to exactly what the same layer encoded the classic
 *      way (absolute `Int64` vertex times) decodes to.
 */

import { describe, it, expect } from 'vitest';
import {
  Field,
  FixedSizeList,
  Float64,
  Int32,
  Int64,
  List,
  RecordBatch,
  Schema,
  Struct,
  Table,
  Uint64,
  Utf8,
  makeData,
  tableToIPC,
  vectorFromArray,
  type Data,
} from 'apache-arrow';
import { decodePathCodec, SECTION_PATH_CODEC } from '../src/path-codec';
import { decodeTile, toGeoArrowTable } from '../src/tile';
import { collectTransferables } from '../src/tile-transferables';
import type { TileId } from '../src/types';
import {
  buildPathCodecFields,
  encodePathCodec,
  serializePathCodec,
  TAG_CONST_VEL,
  TAG_DELTA,
  TAG_TIME_VEL,
  type CodecEncodeOptions,
  type CodecFeatureInput,
  type PathCodecFields,
} from './helpers/path-codec-encoder';
import {
  buildV2Frame,
  splitIpcTemplate,
  tileMetaBytes,
  REF_KIND_INLINE,
  REF_KIND_NO_PROPS,
  SECTION_CORE_BATCH,
  SECTION_INLINE_SCHEMA_CORE,
  SECTION_INLINE_SCHEMA_PROPS,
  SECTION_PROPS_BATCH,
  SECTION_TILE_META,
} from './helpers/v2-frame';
import {
  bits,
  expectSameFeatures,
  expectSameTable,
} from './helpers/path-codec-compare';

const W = 'test layer';

function expectedOffsets(features: CodecFeatureInput[]): Int32Array {
  const out = new Int32Array(features.length + 1);
  features.forEach((f, i) => (out[i + 1] = out[i] + f.xy.length / 2));
  return out;
}

/** Encode, decode, and compare every output buffer exactly. */
function roundTrip(features: CodecFeatureInput[], opts: CodecEncodeOptions) {
  const bytes = encodePathCodec(features, opts);
  const out = decodePathCodec(
    bytes,
    {
      featureCount: features.length,
      hasTime: opts.hasTime,
      decimal: opts.decimal,
    },
    W,
  );
  const flatXY = features.flatMap((f) => Array.from(f.xy));
  expect(Array.from(out.offsets)).toEqual(
    Array.from(expectedOffsets(features)),
  );
  expect(out.vertexCount).toBe(flatXY.length / 2);
  if (opts.decimal) {
    expect(out.coords).toBeInstanceOf(Float64Array);
    expect(bits(out.coords as Float64Array)).toEqual(
      bits(Float64Array.from(flatXY)),
    );
  } else {
    expect(out.coords).toBeInstanceOf(Int32Array);
    expect(Array.from(out.coords)).toEqual(flatXY);
  }
  if (opts.hasTime) {
    const flatT = features.flatMap((f) => Array.from(f.t ?? []));
    expect(out.times).toBeInstanceOf(BigInt64Array);
    expect(Array.from(out.times!)).toEqual(flatT.map((t) => BigInt(t)));
  } else {
    expect(out.times).toBeUndefined();
  }
  return { bytes, out };
}

/** A smooth-ish track: lon/lat doubles at 1e-7, times every `dtMs`. */
function track(
  n: number,
  seed: number,
  t0 = 1_700_000_000_000,
  dtMs = 10_000,
): CodecFeatureInput {
  const xy: number[] = [];
  const t: number[] = [];
  let lon = -70 + seed * 0.37;
  let lat = 40 + seed * 0.11;
  for (let i = 0; i < n; i++) {
    lon += 0.0001 * (1 + Math.sin(i * 0.1 + seed));
    lat += 0.00007 * Math.cos(i * 0.13 + seed);
    xy.push(Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7);
    t.push(t0 + i * dtMs + (i % 3 === 0 ? 1000 : 0));
  }
  return { xy, t };
}

function toGrid(f: CodecFeatureInput): CodecFeatureInput {
  return {
    xy: Array.from(f.xy, (v, i) =>
      Math.round((v + (i % 2 === 0 ? 180 : 90)) / 1e-5),
    ),
    t: f.t,
  };
}

// ─── 1. Round trips ─────────────────────────────────────────────────────────

describe('path codec round trip', () => {
  const tracks = [track(50, 1), track(1, 2), track(2, 3), track(200, 4)];

  it('decimal mode, with and without TIME', () => {
    roundTrip(tracks, { decimal: true, hasTime: true });
    roundTrip(
      tracks.map((f) => ({ xy: f.xy })),
      { decimal: true, hasTime: false },
    );
  });

  it('world-grid mode, with and without TIME', () => {
    const grid = tracks.map(toGrid);
    roundTrip(grid, { decimal: false, hasTime: true });
    roundTrip(
      grid.map((f) => ({ xy: f.xy })),
      { decimal: false, hasTime: false },
    );
  });

  it('every predictor, forced, on every feature', () => {
    for (const tag of [TAG_DELTA, TAG_CONST_VEL, TAG_TIME_VEL]) {
      roundTrip(tracks, {
        decimal: true,
        hasTime: true,
        tags: tracks.map(() => tag),
      });
      roundTrip(tracks.map(toGrid), {
        decimal: false,
        hasTime: true,
        tags: tracks.map(() => tag),
      });
    }
  });

  it('empty features anywhere, including first, last and all', () => {
    const empty = { xy: [], t: [] };
    roundTrip([empty, tracks[0], empty, empty, tracks[1], empty], {
      decimal: true,
      hasTime: true,
    });
    roundTrip([empty, empty], { decimal: true, hasTime: true });
    roundTrip([empty], { decimal: false, hasTime: false });
    roundTrip([], { decimal: true, hasTime: true });
    roundTrip([], { decimal: false, hasTime: false });
  });

  it('single-vertex features (first vertex relative to the previous first)', () => {
    const singles = [0, 1, 2, 3, 4].map((i) => ({
      xy: [-70 + i * 0.5, 40 - i * 0.25],
      t: [1_700_000_000_000 - i * 7],
    }));
    roundTrip(singles, { decimal: true, hasTime: true });
    roundTrip(singles.map(toGrid), { decimal: false, hasTime: true });
  });

  it('unsorted and repeated times within a feature (TIME_VEL dt0 <= 0 fallback)', () => {
    const f: CodecFeatureInput = {
      xy: [0, 0, 10, 10, 20, 20, 35, 30, 50, 35, 70, 40, 80, 41],
      // dt0 = 0 at i=3, dt0 < 0 at i=4 and i=5, dt1 < 0 too
      t: [1000, 2000, 2000, 1500, 900, 5000, 5001],
    };
    const { bytes } = roundTrip([f], {
      decimal: false,
      hasTime: true,
      unit: 1,
      tags: [TAG_TIME_VEL],
    });
    // The predictor tag really is TIME_VEL on the wire.
    expect(
      buildPathCodecFields([f], {
        decimal: false,
        hasTime: true,
        unit: 1,
        tags: [TAG_TIME_VEL],
      }).tags,
    ).toEqual([TAG_TIME_VEL]);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('TIME_VEL rounds negative halves up (floor(x + 0.5)), not away from zero', () => {
    // At vertex 2: v = -5, dt1 = 1, dt0 = 2 → -2.5 → floor(-2.0) = -2. Rust's
    // `f64::round` (half away from zero) would predict -3 and drift by one.
    const f: CodecFeatureInput = {
      xy: [100, 0, 95, 0, 93, 0, 90, 0],
      t: [0, 2, 3, 5],
    };
    roundTrip([f], {
      decimal: false,
      hasTime: true,
      unit: 1,
      tags: [TAG_TIME_VEL],
    });
  });

  it('negative (pre-1970) times, with a coarse unit (floor quotient, r >= 0)', () => {
    const f: CodecFeatureInput = {
      xy: [1, 2, 3, 4, 5, 6, 7, 8],
      t: [-86_400_001, -1000, -1, 999],
    };
    for (const unit of [1, 1000, 86_400_000]) {
      roundTrip([f, f], { decimal: false, hasTime: true, unit });
    }
  });

  it('values that need varints far beyond 32 bits', () => {
    // qbase 0 with U = 1 makes the first dq a ~2^40 svarint; times at the
    // encoder's |t| < 2^52 edge make a 2^53 - 2 quotient step — the largest a
    // valid encoder can emit (its zigzag form needs 2^54).
    const big: CodecFeatureInput = {
      xy: [0, 0, 1, 1],
      t: [1_700_000_000_000, 1_700_000_000_001],
    };
    roundTrip([big], { decimal: false, hasTime: true, unit: 1, qbase: 0 });
    const extreme: CodecFeatureInput[] = [
      { xy: [0, 0], t: [2 ** 52 - 1] },
      { xy: [0, 0], t: [-(2 ** 52 - 1)] },
      { xy: [0, 0, 0, 0], t: [2 ** 52 - 1, -(2 ** 52 - 1)] },
    ];
    roundTrip(extreme, { decimal: false, hasTime: true, unit: 1 });
    // Decimal k just under the encoder's 2^50 bound, at e = 0.
    const wide: CodecFeatureInput = {
      xy: [2 ** 50 - 1, -(2 ** 50 - 1), -(2 ** 50 - 1), 2 ** 50 - 1, 0, 0],
    };
    roundTrip([wide], { decimal: true, hasTime: false, e: 0 });
    // World-grid extremes of Int32.
    const edges: CodecFeatureInput = {
      xy: [2 ** 31 - 1, -(2 ** 31), -(2 ** 31), 2 ** 31 - 1, 0, 0],
    };
    for (const tag of [TAG_DELTA, TAG_CONST_VEL]) {
      roundTrip([edges], { decimal: false, hasTime: false, tags: [tag] });
    }
  });

  it('decimal mode is bit-exact for -0, NaN payloads, ±Infinity and non-decimal doubles', () => {
    const nanPayload = new Float64Array(
      new BigUint64Array([0x7ff8_dead_beef_0001n]).buffer,
    )[0];
    const weird: CodecFeatureInput = {
      xy: [
        -0,
        0,
        NaN,
        nanPayload,
        Infinity,
        -Infinity,
        Math.PI,
        Math.E,
        1 / 3,
        -1e-300,
        Number.MAX_VALUE,
        Number.MIN_VALUE,
        0.1 + 0.2,
        -122.41941550000001,
      ],
      t: [0, 1, 2, 3, 4, 5, 6],
    };
    for (const e of [0, 3, 7, 15]) {
      const { out } = roundTrip([weird, track(5, 9)], {
        decimal: true,
        hasTime: true,
        e,
      });
      expect(Object.is((out.coords as Float64Array)[0], -0)).toBe(true);
    }
  });

  it('ignores the encoder choices it does not depend on (U, qbase, e)', () => {
    for (const unit of [1, 10, 1000, 60_000]) {
      for (const qbase of [0, -5, 123_456_789_012]) {
        roundTrip(tracks, { decimal: true, hasTime: true, unit, qbase });
      }
    }
  });
});

// ─── 2. Rejections (spec §4) ────────────────────────────────────────────────

/** A valid baseline section's fields, both flags set. */
function baseline(): PathCodecFields {
  return buildPathCodecFields([track(6, 1), { xy: [], t: [] }, track(4, 2)], {
    decimal: true,
    hasTime: true,
    unit: 1000,
  });
}

function decodeFields(
  f: PathCodecFields,
  expect_ = { featureCount: 3, hasTime: true, decimal: true },
) {
  return decodePathCodec(serializePathCodec(f), expect_, W);
}

function mustThrow(
  f: PathCodecFields,
  pattern: RegExp,
  expect_?: Parameters<typeof decodeFields>[1],
) {
  expect(() => decodeFields(f, expect_)).toThrow(pattern);
}

describe('path codec rejections', () => {
  it('the baseline decodes (so every rejection below is the one mutation)', () => {
    expect(() => decodeFields(baseline())).not.toThrow();
  });

  it('a wrong version', () => {
    mustThrow({ ...baseline(), version: 2 }, /version 2 is not supported/);
    mustThrow({ ...baseline(), version: 0 }, /version 0/);
  });

  it('a reserved flag bit', () => {
    for (let bit = 2; bit < 8; bit++) {
      const f = baseline();
      f.flags |= 1 << bit;
      mustThrow(f, /reserved flag bits/);
    }
  });

  it('flags that disagree with the schema', () => {
    mustThrow(baseline(), /TIME flag is set but the layer has no vertex_time/, {
      featureCount: 3,
      hasTime: false,
      decimal: true,
    });
    mustThrow(
      baseline(),
      /DECIMAL flag is set but the geometry leaf is Int32/,
      {
        featureCount: 3,
        hasTime: true,
        decimal: false,
      },
    );
    const noTime = buildPathCodecFields([{ xy: [1, 2] }], {
      decimal: false,
      hasTime: false,
    });
    mustThrow(noTime, /TIME flag is clear but the layer has a vertex_time/, {
      featureCount: 1,
      hasTime: true,
      decimal: false,
    });
    mustThrow(
      noTime,
      /DECIMAL flag is clear but the geometry leaf is Float64/,
      {
        featureCount: 1,
        hasTime: false,
        decimal: true,
      },
    );
  });

  it('an unknown predictor tag', () => {
    const f = baseline();
    f.tags[2] = 3;
    mustThrow(f, /unknown predictor tag 3 on feature 2/);
    f.tags[2] = 0xff;
    mustThrow(f, /unknown predictor tag 255/);
  });

  it('TIME_VEL on a layer without TIME', () => {
    const f = buildPathCodecFields([{ xy: [1, 2, 3, 4, 5, 6] }], {
      decimal: false,
      hasTime: false,
    });
    f.tags[0] = TAG_TIME_VEL;
    mustThrow(f, /TIME_VEL predictor on feature 0 of a layer without TIME/, {
      featureCount: 1,
      hasTime: false,
      decimal: false,
    });
  });

  it('feature_count that is not the CORE row count', () => {
    mustThrow(
      baseline(),
      /feature_count 3 does not match the CORE batch row count 4/,
      {
        featureCount: 4,
        hasTime: true,
        decimal: true,
      },
    );
    const f = baseline();
    f.featureCount = 2n;
    mustThrow(f, /feature_count 2 does not match/);
  });

  it('vertex_count that is not the sum of counts', () => {
    const over = baseline();
    over.counts[0] += 1n;
    mustThrow(over, /exceed vertex_count|sum to/);
    const under = baseline();
    under.counts[0] -= 1n;
    mustThrow(under, /sum to 9, not vertex_count 10/);
  });

  it('a vertex_count the section cannot hold (allocation bound)', () => {
    for (const vc of [1n << 31n, 1n << 40n, (1n << 53n) - 1n]) {
      const f = baseline();
      f.vertexCount = vc;
      mustThrow(f, /cannot fit/);
    }
  });

  it('a remainder r >= U', () => {
    const f = baseline();
    f.r[3] = 1000n;
    mustThrow(f, /time remainder 1000 is not below the unit 1000/);
  });

  it('a time unit of 0', () => {
    const f = baseline();
    f.unit = 0n;
    mustThrow(f, /unit U must be at least 1/);
  });

  it('a decimal exponent outside 0..=15', () => {
    const f = baseline();
    f.e = 16;
    mustThrow(f, /decimal exponent 16 is outside 0..=15/);
  });

  it('an exception index out of range', () => {
    const f = baseline();
    f.excIdx = [20n]; // 2 * vertex_count = 20 values → 0..=19
    f.excPatch = [[1n, 0n]];
    mustThrow(f, /exception index 20 is out of range/);
    const g = baseline();
    g.excIdx = [5n, 15n];
    g.excPatch = [
      [1n, 0n],
      [1n, 0n],
    ];
    mustThrow(g, /exception index 20 is out of range/);
  });

  it('exception indices that are not strictly increasing', () => {
    const f = baseline();
    f.excIdx = [3n, 0n];
    f.excPatch = [
      [1n, 0n],
      [1n, 0n],
    ];
    mustThrow(f, /not strictly increasing \(entry 1\)/);
  });

  it('an exc_count the section cannot hold', () => {
    const f = baseline();
    f.excCount = 21n;
    mustThrow(f, /exc_count 21 cannot fit/);
  });

  it('a patch half above 2^32 - 1', () => {
    for (const patch of [
      [1n << 32n, 0n],
      [0n, 1n << 32n],
    ] as Array<[bigint, bigint]>) {
      const f = baseline();
      f.excIdx = [0n];
      f.excPatch = [patch];
      mustThrow(f, /patch half above 2\^32 - 1/);
    }
  });

  it('a world-grid coordinate that does not fit Int32', () => {
    for (const v of [2 ** 31, -(2 ** 31) - 1]) {
      const f = buildPathCodecFields([{ xy: [0, 0] }], {
        decimal: false,
        hasTime: false,
      });
      f.res = [BigInt(v), 0n];
      mustThrow(f, /does not fit the Int32 grid/, {
        featureCount: 1,
        hasTime: false,
        decimal: false,
      });
    }
    // Reached through a predictor rather than a raw residual.
    const f = buildPathCodecFields(
      [{ xy: [2 ** 30, 0, 2 ** 31 - 1, 0, 0, 0] }],
      {
        decimal: false,
        hasTime: false,
        tags: [TAG_DELTA],
      },
    );
    f.tags[0] = TAG_CONST_VEL;
    f.res[4] = 0n;
    mustThrow(f, /does not fit the Int32 grid/, {
      featureCount: 1,
      hasTime: false,
      decimal: false,
    });
  });

  it('a decimal coordinate integer beyond 2^53 - 1', () => {
    const f = buildPathCodecFields([{ xy: [0, 0, 0, 0] }], {
      decimal: true,
      hasTime: false,
    });
    f.res = [1n << 52n, 0n, 1n << 52n, 0n]; // k = 2^52, then 2^53
    mustThrow(f, /does not fit the exact-double range/, {
      featureCount: 1,
      hasTime: false,
      decimal: true,
    });
  });

  it('a predictor beyond 2^53 - 1', () => {
    const f = buildPathCodecFields([{ xy: [0, 0, 0, 0, 0, 0] }], {
      decimal: true,
      hasTime: false,
      tags: [TAG_CONST_VEL],
    });
    // k0 = -2^52, k1 = 2^52 - 1 → v = 2^53 - 1, so the CONST_VEL pred is
    // 3·2^52 - 2.
    f.res = [-(1n << 52n), 0n, (1n << 53n) - 1n, 0n, 0n, 0n];
    mustThrow(f, /predictor exceeds 2\^53 - 1 at vertex 2/, {
      featureCount: 1,
      hasTime: false,
      decimal: true,
    });
  });

  it('a time beyond 2^53 - 1 (quotient, or q * U + r)', () => {
    const q = buildPathCodecFields([{ xy: [0, 0, 0, 0], t: [0, 0] }], {
      decimal: false,
      hasTime: true,
      unit: 1,
    });
    q.dq = [1n << 52n, (1n << 53n) - 1n];
    mustThrow(q, /time quotient exceeds 2\^53 - 1 at vertex 1/, {
      featureCount: 1,
      hasTime: true,
      decimal: false,
    });
    const t = buildPathCodecFields([{ xy: [0, 0], t: [0] }], {
      decimal: false,
      hasTime: true,
      unit: 1000,
    });
    t.dq = [1n << 50n];
    mustThrow(t, /q\*U \+ r exceeds 2\^53 - 1/, {
      featureCount: 1,
      hasTime: true,
      decimal: false,
    });
  });

  it('a TIME_VEL term beyond 2^53 - 1', () => {
    // v = 2^40, dt1 / dt0 = 2^20 - 1: the term is ~2^60 (an encoder would
    // never pick TIME_VEL here, |v * dt1| > 2^52).
    const f = buildPathCodecFields(
      [{ xy: [0, 0, 2 ** 40, 0, 2 ** 40, 0], t: [0, 1, 2 ** 20] }],
      { decimal: true, e: 0, hasTime: true, unit: 1, tags: [TAG_DELTA] },
    );
    f.tags[0] = TAG_TIME_VEL;
    mustThrow(f, /TIME_VEL term outside ±\(2\^53 - 1\) at vertex 2/, {
      featureCount: 1,
      hasTime: true,
      decimal: true,
    });
  });

  it('a varint value outside ±(2^53 - 1) (the integer bound)', () => {
    // ±2^53 (zigzag 2^54 / 2^54 - 1), one past, and far past.
    for (const v of [
      1n << 53n,
      -(1n << 53n),
      (1n << 53n) + 1n,
      -(1n << 53n) - 1n,
      1n << 62n,
    ]) {
      const f = buildPathCodecFields([{ xy: [0, 0] }], {
        decimal: true,
        hasTime: false,
      });
      f.res = [v, 0n];
      mustThrow(f, /svarint value outside ±\(2\^53 - 1\)/, {
        featureCount: 1,
        hasTime: false,
        decimal: true,
      });
    }
    // An unsigned field of 2^53.
    const f = baseline();
    f.unit = 1n << 53n;
    mustThrow(f, /varint 9007199254740992 exceeds 2\^53 - 1/);
  });

  it('an over-long varint', () => {
    const bytes = serializePathCodec(baseline());
    // version, flags, then feature_count: replace its byte with 11 continuation bytes.
    const bad = Uint8Array.from([
      bytes[0],
      bytes[1],
      ...new Array(10).fill(0x80),
      0x03,
      ...bytes.subarray(3),
    ]);
    expect(() =>
      decodePathCodec(
        bad,
        { featureCount: 3, hasTime: true, decimal: true },
        W,
      ),
    ).toThrow(/varint longer than 10 bytes/);
  });

  it('trailing bytes', () => {
    mustThrow({ ...baseline(), trailing: [0] }, /1 trailing byte\(s\)/);
    const g = buildPathCodecFields([{ xy: [1, 2] }], {
      decimal: false,
      hasTime: false,
    });
    mustThrow({ ...g, trailing: [1, 2, 3] }, /3 trailing byte\(s\)/, {
      featureCount: 1,
      hasTime: false,
      decimal: false,
    });
  });

  it('every truncation of a valid section', () => {
    for (const f of [
      baseline(),
      buildPathCodecFields([track(5, 3)].map(toGrid), {
        decimal: false,
        hasTime: true,
      }),
    ]) {
      const full = serializePathCodec(f);
      const expect_ = {
        featureCount: f.counts.length,
        hasTime: (f.flags & 1) !== 0,
        decimal: (f.flags & 2) !== 0,
      };
      expect(() => decodePathCodec(full, expect_, W)).not.toThrow();
      for (let n = 0; n < full.length; n++) {
        expect(() => decodePathCodec(full.subarray(0, n), expect_, W)).toThrow(
          /PATH_CODEC/,
        );
      }
    }
  });

  it('random corruption: decodes or throws a named error, never anything else', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    const sources = [
      serializePathCodec(baseline()),
      encodePathCodec([track(40, 5), track(3, 6)].map(toGrid), {
        decimal: false,
        hasTime: true,
      }),
    ];
    for (const src of sources) {
      const expect_ = {
        featureCount: src === sources[0] ? 3 : 2,
        hasTime: true,
        decimal: src === sources[0],
      };
      for (let k = 0; k < 2000; k++) {
        const b = src.slice();
        const flips = 1 + Math.floor(rand() * 3);
        for (let j = 0; j < flips; j++) {
          b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
        }
        try {
          const out = decodePathCodec(b, expect_, W);
          // A survivor is internally consistent.
          expect(out.offsets[expect_.featureCount]).toBe(out.vertexCount);
          expect(out.coords.length).toBe(out.vertexCount * 2);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).message).toMatch(/^test layer: PATH_CODEC /);
        }
      }
    }
  });
});

// ─── 3. Full layer frames ───────────────────────────────────────────────────

const tileId: TileId = { z: 3, x: 2, y: 1, t: 0 };
const QUANT = { x0: -180, y0: -90, sx: 1e-5, sy: 1e-5 };

interface LayerSpec {
  features: CodecFeatureInput[];
  decimal: boolean;
  hasTime: boolean;
}

/**
 * One layer's CORE schema + batch. `codec` empties `geometry` /
 * `vertex_time` (spec §3); otherwise they carry the data, `vertex_time` as
 * absolute `Int64`.
 */
function coreTable(spec: LayerSpec, codec: boolean): Table {
  const { features, decimal, hasTime } = spec;
  const n = features.length;
  const leafType = decimal ? new Float64() : new Int32();
  const coordType = new FixedSizeList(2, new Field('xy', leafType, false));
  const geomType = new List(new Field('vertices', coordType, false));
  const vtType = new List(new Field('item', new Int64(), false));
  const geomMeta = new Map([['ARROW:extension:name', 'geoarrow.linestring']]);
  if (!decimal) geomMeta.set('stt:quant', JSON.stringify(QUANT));

  const offsets = codec ? new Int32Array(n + 1) : expectedOffsets(features);
  const vc = offsets[n];
  const flatXY = codec ? [] : features.flatMap((f) => Array.from(f.xy));
  const flatT = codec ? [] : features.flatMap((f) => Array.from(f.t ?? []));
  const starts = features.map((f, i) =>
    f.t && f.t.length ? Math.min(...Array.from(f.t)) : 1_600_000_000_000 + i,
  );
  const ends = features.map((f, i) =>
    f.t && f.t.length ? Math.max(...Array.from(f.t)) : 1_600_000_000_000 + i,
  );

  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field('geometry', geomType, false, geomMeta),
  ];
  const children: Data[] = [
    makeData({
      type: new Uint64(),
      length: n,
      data: BigUint64Array.from(features, (_, i) => BigInt(1000 + i)),
    }),
    makeData({
      type: new Int64(),
      length: n,
      data: BigInt64Array.from(starts, (v) => BigInt(v)),
    }),
    makeData({
      type: new Int64(),
      length: n,
      data: BigInt64Array.from(ends, (v) => BigInt(v)),
    }),
    makeData({
      type: geomType,
      length: n,
      nullCount: 0,
      valueOffsets: offsets,
      child: makeData({
        type: coordType,
        length: vc,
        nullCount: 0,
        child: makeData({
          type: leafType,
          length: vc * 2,
          data: decimal ? Float64Array.from(flatXY) : Int32Array.from(flatXY),
        }),
      }),
    }) as Data,
  ];
  if (hasTime) {
    // The classic writer's shape: a zero-vertex feature's vertex_time is NULL
    // (spec §5.2.7 says a codec layer decodes to exactly that).
    const empty = codec
      ? []
      : features.flatMap((f, i) => (f.xy.length ? [] : [i]));
    const validity = new Uint8Array((n + 7) >> 3).fill(0xff);
    for (const i of empty) validity[i >> 3] &= ~(1 << (i & 7));
    fields.push(new Field('vertex_time', vtType, true));
    children.push(
      makeData({
        type: vtType,
        length: n,
        nullCount: empty.length,
        nullBitmap: empty.length ? validity : undefined,
        valueOffsets: offsets.slice(),
        child: makeData({
          type: new Int64(),
          length: vc,
          data: BigInt64Array.from(flatT, (v) => BigInt(v)),
        }),
      }),
    );
  }
  fields.push(new Field('speed', new Float64(), true));
  children.push(
    makeData({
      type: new Float64(),
      length: n,
      data: Float64Array.from(features, (_, i) => i * 1.5),
    }),
  );
  const schema = new Schema(fields);
  const data = makeData({ type: new Struct(fields), length: n, children });
  return new Table([new RecordBatch(schema, data)]);
}

function frame(
  spec: LayerSpec,
  codec: boolean,
  opts: {
    section?: Uint8Array;
    tileMeta?: Record<string, unknown>;
    /** Add a PROPS batch (see {@link propsTable}). */
    props?: boolean;
  } = {},
): Uint8Array {
  const ipc = tableToIPC(coreTable(spec, codec), 'stream');
  const { template, tail } = splitIpcTemplate(ipc);
  const starts = spec.features.flatMap((f) => Array.from(f.t ?? []));
  const tileMeta = opts.tileMeta ?? {
    t0: starts.length ? Math.min(...starts) : 1_600_000_000_000,
  };
  const sections: Array<[number, Uint8Array]> = [
    [SECTION_INLINE_SCHEMA_CORE, template],
    [SECTION_TILE_META, tileMetaBytes(tileMeta)],
    [SECTION_CORE_BATCH, tail],
  ];
  if (opts.props) {
    const props = splitIpcTemplate(
      tableToIPC(propsTable(spec.features.length), 'stream'),
    );
    sections.push(
      [SECTION_INLINE_SCHEMA_PROPS, props.template],
      [SECTION_PROPS_BATCH, props.tail],
    );
  }
  if (codec) {
    sections.push([
      SECTION_PATH_CODEC,
      opts.section ??
        encodePathCodec(spec.features, {
          decimal: spec.decimal,
          hasTime: spec.hasTime,
        }),
    ]);
  }
  return buildV2Frame([
    {
      name: 'tracks',
      refCore: { kind: REF_KIND_INLINE },
      refProps: { kind: opts.props ? REF_KIND_INLINE : REF_KIND_NO_PROPS },
      sections,
    },
  ]);
}

/**
 * A PROPS batch shaped like the real AIS / ADS-B builds': a string property
 * called `id` — the writer splits CORE from PROPS by position, so it rides
 * PROPS next to the reserved UInt64 CORE `id` — plus an ordinary numeric
 * property.
 */
function propsTable(n: number): Table {
  const ids = vectorFromArray(
    Array.from({ length: n }, (_, i) => `vessel-${i}`),
    new Utf8(),
  );
  const draught = vectorFromArray(
    Array.from({ length: n }, (_, i) => 2 + i * 0.25),
    new Float64(),
  );
  const fields = [
    new Field('id', new Utf8(), true),
    new Field('draught', new Float64(), true),
  ];
  const data = makeData({
    type: new Struct(fields),
    length: n,
    children: [ids.data[0], draught.data[0]],
  });
  return new Table([new RecordBatch(new Schema(fields), data)]);
}

describe('path codec in a v2 layer frame', () => {
  const tracks = [track(30, 1), { xy: [], t: [] }, track(1, 2), track(120, 3)];
  const specs: Record<string, LayerSpec> = {
    'decimal + time': { features: tracks, decimal: true, hasTime: true },
    'decimal, no time': {
      features: tracks.map((f) => ({ xy: f.xy })),
      decimal: true,
      hasTime: false,
    },
    'world grid + time': {
      features: tracks.map(toGrid),
      decimal: false,
      hasTime: true,
    },
    'world grid, no time': {
      features: tracks.map((f) => ({ xy: toGrid(f).xy })),
      decimal: false,
      hasTime: false,
    },
  };

  for (const [label, spec] of Object.entries(specs)) {
    it(`${label}: decodeTile and toGeoArrowTable match the classic layer`, () => {
      const plain = decodeTile(frame(spec, false), tileId);
      const coded = decodeTile(frame(spec, true), tileId);
      const lp = plain.layers[0];
      const lc = coded.layers[0];
      expectSameFeatures(lc.features, lp.features);
      expect(lc.coordinatesQuantized).toBe(lp.coordinatesQuantized);
      expect(lc.geometryExtensionName).toBe('geoarrow.linestring');
      expectSameTable(toGeoArrowTable(lc), toGeoArrowTable(lp));
      // World-grid positions went through the stt:quant affine.
      if (!spec.decimal) {
        const g = spec.features.flatMap((f) => Array.from(f.xy));
        expect(lc.features.positions[0]).toBe(QUANT.x0 + g[0] * QUANT.sx);
      }
      expect(lc.pathCodec).toBeInstanceOf(Uint8Array);
      expect(lp.pathCodec).toBeUndefined();
    });

    it(`${label}: the worker-path rehydrate rebuilds the codec columns`, () => {
      const coded = decodeTile(frame(spec, true), tileId);
      const plain = decodeTile(frame(spec, false), tileId);
      const layer = coded.layers[0];
      // What the worker posts: no Table, the IPC bytes + section instead.
      expect(collectTransferables(coded)).toContain(layer.pathCodec!.buffer);
      delete layer.arrowTable;
      expectSameTable(toGeoArrowTable(layer), toGeoArrowTable(plain.layers[0]));
    });
  }

  // Real archives carry a PROPS batch beside the codec CORE batch, and theirs
  // has a property column named like the reserved `id`: the merged table
  // keeps both columns (as Rust's merge_v2_layer does), which arrow-js's
  // RecordBatch would otherwise fold into one by name.
  for (const [label, spec] of Object.entries(specs)) {
    it(`${label}, with a PROPS batch: decodeTile, toGeoArrowTable and the rehydrate match`, () => {
      const plain = decodeTile(frame(spec, false, { props: true }), tileId);
      const coded = decodeTile(frame(spec, true, { props: true }), tileId);
      const lp = plain.layers[0];
      const lc = coded.layers[0];
      expect(lc.arrowIpcProps).toBeInstanceOf(Uint8Array);
      expectSameFeatures(lc.features, lp.features);
      expect(lc.features.numericProps.draught).toEqual(
        Float32Array.from(
          { length: spec.features.length },
          (_, i) => 2 + i * 0.25,
        ),
      );
      const table = toGeoArrowTable(lc);
      expectSameTable(table, toGeoArrowTable(lp));
      // Both `id` columns survive, in place, with their own types; lookup by
      // name is the reserved CORE one.
      expect(table.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual([
        'id:Uint64',
        'start_time:Int64',
        'end_time:Int64',
        `geometry:${table.schema.fields[3].type}`,
        ...(spec.hasTime ? ['vertex_time:List<Int64>'] : []),
        'speed:Float64',
        'id:Utf8',
        'draught:Float64',
      ]);
      expect(table.getChild('id')!.get(0)).toBe(1000n);
      expect(table.getChildAt(table.numCols - 2)!.get(1)).toBe('vessel-1');
      // Worker path: no Table, re-merged from the IPC bytes + section.
      delete lc.arrowTable;
      expectSameTable(toGeoArrowTable(lc), toGeoArrowTable(lp));
    });
  }

  it('the CORE batch of a codec layer really is empty on the wire', () => {
    const t = coreTable(specs['decimal + time'], true);
    expect(t.getChild('geometry')!.data[0].children[0].length).toBe(0);
    expect(t.getChild('vertex_time')!.data[0].children[0].length).toBe(0);
  });

  describe('schema agreement (rejected at the frame)', () => {
    const spec = specs['decimal + time'];
    it('flags vs. schema', () => {
      const section = encodePathCodec(
        spec.features.map((f) => ({ xy: f.xy })),
        { decimal: true, hasTime: false },
      );
      expect(() => decodeTile(frame(spec, true, { section }), tileId)).toThrow(
        /TIME flag is clear but the layer has a vertex_time column/,
      );
    });

    it("TILE_META 'vt' / 'vtf' on a codec layer", () => {
      for (const extra of [{ vt: [0, 1000] }, { vtf: 1000 }]) {
        expect(() =>
          decodeTile(
            frame(spec, true, {
              tileMeta: { t0: 1_700_000_000_000, ...extra },
            }),
            tileId,
          ),
        ).toThrow(/must not carry TILE_META 'vt' \/ 'vtf'/);
      }
    });

    it('a codec section next to non-empty CORE lists', () => {
      const ipc = tableToIPC(coreTable(spec, false), 'stream');
      const { template, tail } = splitIpcTemplate(ipc);
      const bytes = buildV2Frame([
        {
          name: 'tracks',
          refCore: { kind: REF_KIND_INLINE },
          refProps: { kind: REF_KIND_NO_PROPS },
          sections: [
            [SECTION_INLINE_SCHEMA_CORE, template],
            [SECTION_CORE_BATCH, tail],
            [
              SECTION_PATH_CODEC,
              encodePathCodec(spec.features, { decimal: true, hasTime: true }),
            ],
          ],
        },
      ]);
      expect(() => decodeTile(bytes, tileId)).toThrow(
        /CORE column 'geometry' must hold 4 empty lists/,
      );
    });

    it('a codec section on a point layer', () => {
      const coords = new FixedSizeList(
        2,
        new Field('xy', new Float64(), false),
      );
      const fields = [
        new Field(
          'geometry',
          coords,
          false,
          new Map([['ARROW:extension:name', 'geoarrow.point']]),
        ),
      ];
      const data = makeData({
        type: new Struct(fields),
        length: 1,
        children: [
          makeData({
            type: coords,
            length: 1,
            nullCount: 0,
            child: makeData({
              type: new Float64(),
              data: new Float64Array([1, 2]),
            }),
          }),
        ],
      });
      const ipc = tableToIPC(
        new Table([new RecordBatch(new Schema(fields), data)]),
        'stream',
      );
      const { template, tail } = splitIpcTemplate(ipc);
      const bytes = buildV2Frame([
        {
          name: 'points',
          refCore: { kind: REF_KIND_INLINE },
          refProps: { kind: REF_KIND_NO_PROPS },
          sections: [
            [SECTION_INLINE_SCHEMA_CORE, template],
            [SECTION_CORE_BATCH, tail],
            [
              SECTION_PATH_CODEC,
              encodePathCodec([{ xy: [1, 2] }], {
                decimal: true,
                hasTime: false,
              }),
            ],
          ],
        },
      ]);
      expect(() => decodeTile(bytes, tileId)).toThrow(
        /applies only to geoarrow.linestring layers, not geoarrow.point/,
      );
    });

    it('a corrupt section surfaces with the tile and layer named', () => {
      const section = encodePathCodec(spec.features, {
        decimal: true,
        hasTime: true,
      });
      section[0] = 9;
      expect(() => decodeTile(frame(spec, true, { section }), tileId)).toThrow(
        /^tile 3\/2\/1\/0 layer 'tracks': PATH_CODEC version 9 is not supported/,
      );
    });
  });
});
