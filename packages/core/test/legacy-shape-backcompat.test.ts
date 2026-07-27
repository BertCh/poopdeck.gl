/**
 * **Back-compatibility pin for the pre-compact-encoding wire shape.**
 *
 * The 2026-07 payload work added three *optional* encodings that re-type
 * columns a reader already knew:
 *
 *   - `TILE_META.st = "u32"` — `start_time` as a `UInt32` offset from `t0`
 *   - `TILE_META.et = "dur32" | "zero"` — `end_time` as a `UInt32` duration,
 *     or omitted entirely
 *   - `TILE_META.vq` — `vertex_value` / `vertex_value_matrix` as `UInt16`
 *     indices under an affine, `0xFFFF` meaning `NaN`
 *
 * plus the additive `part_offsets` CORE column. Every archive published before
 * that work — i.e. **every archive currently under
 * `examples/showcase/public/data/`** — carries NONE of those keys and MUST keep
 * decoding to exactly the same numbers. That is not a claim this file assumes;
 * it is the claim this file *demonstrates*, against real writer output.
 *
 * ## The corpus is FROZEN — do not regenerate it
 *
 * `test/fixtures/legacy-shape/` is deliberately **not** produced by any
 * generator script. Regenerating it with today's encoder would re-encode it
 * into the new compact shapes and silently turn this file into a test of the
 * new path — exactly the regression it exists to catch. It holds:
 *
 * | dataset    | provenance                                            | exercises |
 * |------------|-------------------------------------------------------|-----------|
 * | `flows/`   | 6-tile excerpt of the shipped `nyc-taxi-flows` archive | absolute `Int64` start/end, `List<UInt16>` delta `vertex_time` (`vt`), raw `List<Float32>` `vertex_value_matrix` (`vb`), `qa`, coord-quant, whole-load dir |
 * | `currents/`| 6-tile excerpt of the shipped `ecco-currents` archive  | raw `List<Float32>` `vertex_value` **with `NaN` holes**, ABSOLUTE `Int64` `vertex_time` (no `vt` key), per-feature start/end that genuinely differ |
 * | `points/`  | verbatim copy of the `v2-golden` fixture as committed  | instantaneous events (`end === start`, the shape `et:"zero"` now compresses), `qa`, two dictionary columns, **paged** directory |
 * | `tracks/`  | verbatim copy of the `v2-golden-tracks` fixture        | `List<UInt16>` delta `vertex_time` with a widened step, distinct start/end |
 *
 * The excerpts re-cut real blobs verbatim into a single pack + whole-load
 * directory (the same technique `helpers/packed-fixture.ts` uses for the
 * golden fixtures); the tile PAYLOAD bytes are untouched writer output.
 *
 * The first test walks the raw frames and *proves* the corpus predates the new
 * encodings — without it, a future regeneration would make every expectation
 * below pass for the wrong reason.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { unzstdSync } from '../src/compression';
import { getFeatureProperties } from '../src/tile';
import { GeometryType, type BinaryFeatures } from '../src/types';
import {
  loadPackedDatasetFromDisk,
  packedFetch,
} from './helpers/packed-fixture';

const FIXTURES = fileURLToPath(
  new URL('./fixtures/legacy-shape/', import.meta.url),
);

const DATASETS = ['flows', 'currents', 'points', 'tracks'] as const;
type DatasetName = (typeof DATASETS)[number];

function dataset(name: DatasetName) {
  return loadPackedDatasetFromDisk(
    fs,
    FIXTURES + name,
    `mem://legacy/${name}/manifest.json`,
  );
}

function openArchive(name: DatasetName): STTArchive {
  const ds = dataset(name);
  return new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
}

/**
 * Walk a v2 layer frame far enough to lift out each layer's TILE_META JSON.
 * A deliberately independent re-implementation of the section walk in
 * `src/tile.ts` — if the two disagree about where TILE_META lives, that is
 * itself a finding.
 */
function tileMetaOf(blob: Uint8Array): Array<Record<string, unknown> | null> {
  const raw = unzstdSync(blob);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  expect(dv.getUint16(0, true), 'v2 frame escape').toBe(0xffff);
  let p = 2;
  expect(raw[p++], 'frame_version').toBe(2);
  p++; // flags
  const layerCount = dv.getUint16(p, true);
  p += 2;
  const out: Array<Record<string, unknown> | null> = [];
  for (let l = 0; l < layerCount; l++) {
    const nameLen = dv.getUint16(p, true);
    p += 2 + nameLen;
    if (raw[p++] === 1) p += 16; // ref_kind_core (+ blake3-128 template hash)
    if (raw[p++] === 1) p += 16; // ref_kind_props
    const sectionCount = raw[p++];
    const toc: Array<{ tag: number; len: number }> = [];
    for (let s = 0; s < sectionCount; s++) {
      const tag = raw[p++];
      toc.push({ tag, len: dv.getUint32(p, true) });
      p += 4;
    }
    p = (p + 7) & ~7;
    let meta: Record<string, unknown> | null = null;
    for (const s of toc) {
      if (s.tag === 0x02) {
        meta = JSON.parse(new TextDecoder().decode(raw.subarray(p, p + s.len)));
      }
      p = (p + s.len + 7) & ~7;
    }
    out.push(meta);
  }
  return out;
}

/** Every tile of a dataset, as `(directory entry, decoded layers)`. */
async function decodeAll(name: DatasetName) {
  const archive = openArchive(name);
  const index = await archive.getIndex();
  const out: Array<{
    id: string;
    layer: string;
    features: BinaryFeatures;
  }> = [];
  for (const e of index.tiles) {
    const tile = await archive.getTile({
      z: e.zoom,
      x: e.x,
      y: e.y,
      t: e.timeStart,
    });
    expect(
      tile,
      `${name} ${e.zoom}/${e.x}/${e.y}@${e.timeStart}`,
    ).not.toBeNull();
    for (const layer of tile!.layers) {
      out.push({
        id: `${e.zoom}/${e.x}/${e.y}@${e.timeStart}`,
        layer: layer.name,
        features: layer.features,
      });
    }
  }
  return out;
}

/** Sum of the finite entries, rounded — a cheap whole-column digest. */
function finiteSum(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) s += a[i];
  return Math.round(s * 1e6) / 1e6;
}
function nanCount(a: Float32Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) n++;
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// 0. The corpus really is the OLD shape.
// ───────────────────────────────────────────────────────────────────────────

describe('legacy corpus provenance', () => {
  it('carries none of the new TILE_META keys, in any tile of any dataset', async () => {
    let tilesWalked = 0;
    for (const name of DATASETS) {
      const ds = dataset(name);
      const manifest = JSON.parse(
        new TextDecoder().decode(ds.objects.get('manifest.json')!),
      );
      const packs: Uint8Array[] = manifest.packs.map(
        (p: { key: string }) => ds.objects.get(p.key)!,
      );
      const index = await openArchive(name).getIndex();
      for (const e of index.tiles) {
        const blob = packs[e.packId ?? 0].subarray(
          e.offset,
          e.offset + e.length,
        );
        for (const meta of tileMetaOf(blob)) {
          if (!meta) continue;
          // The three keys this change introduced. `undefined` — not merely
          // falsy — because `et: "zero"` is a legal truthy value.
          expect(meta.st, `${name} ${e.zoom}/${e.x}/${e.y} st`).toBeUndefined();
          expect(meta.et, `${name} ${e.zoom}/${e.x}/${e.y} et`).toBeUndefined();
          expect(meta.vq, `${name} ${e.zoom}/${e.x}/${e.y} vq`).toBeUndefined();
        }
        tilesWalked++;
      }
    }
    expect(tilesWalked).toBe(18);
  });

  it('covers both container layouts and the shapes the new encodings target', async () => {
    const layoutOf = (name: DatasetName) =>
      JSON.parse(
        new TextDecoder().decode(dataset(name).objects.get('manifest.json')!),
      ).directory.layout;
    // `points` is paged, the rest whole-load — the splice + template registry
    // is reached through both container paths.
    expect(layoutOf('points')).toBe('paged');
    expect(layoutOf('flows')).toBeUndefined();

    // `points` is the instantaneous-event shape today's encoder would ship as
    // `et: "zero"` (end_time column omitted). Here the column is present and
    // absolute, and the reader must still produce end === start.
    const points = await decodeAll('points');
    for (const { features: f } of points) {
      expect(Array.from(f.endTimes)).toEqual(Array.from(f.startTimes));
    }
    // …and `currents` is the opposite shape: starts and ends genuinely differ
    // per feature, so `endTimes` cannot be an accidental copy of `startTimes`.
    const currents = await decodeAll('currents');
    expect(
      currents.some(({ features: f }) =>
        Array.from(f.endTimes).some((v, i) => v !== f.startTimes[i]),
      ),
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 1. The numbers. Captured from the reader BEFORE the compact-encoding work
//    landed; any drift here is a back-compat break, not a fixture update.
// ───────────────────────────────────────────────────────────────────────────

interface TileExpectation {
  id: string;
  layer: string;
  featureCount: number;
  geometryType: GeometryType;
  timeOffset: number;
  startTimes: number[];
  endTimes: number[];
  /** `vertexTimestamps`: [length, first six, finite sum]. */
  vt?: [number, number[], number];
  /** `vertexValues`: [length, first six (`'NaN'` for a hole), NaN count, finite sum]. */
  vv?: [number, Array<number | 'NaN'>, number, number];
  /** `vertexValueMatrix`: [length, buckets, finite sum]. */
  vvm?: [number, number, number];
  startIndices?: number[];
  numeric: string[];
  categorical: string[];
}

const EXPECTED: Record<DatasetName, TileExpectation[]> = {
  // nyc-taxi-flows — LineString, u16-delta vertex_time, Float32 value matrix.
  flows: [
    {
      id: '13/2412/3075@1420070400000',
      layer: 'default',
      featureCount: 1,
      geometryType: GeometryType.LineString,
      timeOffset: 1420070400000,
      startTimes: [0],
      endTimes: [143100000],
      vt: [2, [113288008, 143099600], 256387608],
      vvm: [318, 159, 2],
      startIndices: [0, 2],
      numeric: ['max_count', 'min_zoom'],
      categorical: [],
    },
    {
      id: '14/4831/6165@1420070400000',
      layer: 'default',
      featureCount: 1,
      geometryType: GeometryType.LineString,
      timeOffset: 1420070400000,
      startTimes: [0],
      endTimes: [143100000],
      vt: [3, [26054170, 29654542, 77675264], 133383976],
      vvm: [477, 159, 9],
      startIndices: [0, 3],
      numeric: ['max_count', 'min_zoom'],
      categorical: [],
    },
    {
      id: '14/4820/6166@1420070400000',
      layer: 'default',
      featureCount: 1,
      geometryType: GeometryType.LineString,
      timeOffset: 1420070400000,
      startTimes: [0],
      endTimes: [143100000],
      vt: [15, [0, 4756830, 10017954, 15391196, 20925164, 26534400], 772060074],
      vvm: [2385, 159, 2.5],
      startIndices: [0, 15],
      numeric: ['max_count', 'min_zoom'],
      categorical: [],
    },
    {
      id: '14/4823/6167@1420070400000',
      layer: 'default',
      featureCount: 2,
      geometryType: GeometryType.LineString,
      timeOffset: 1420070400000,
      startTimes: [0, 0],
      endTimes: [143100000, 143100000],
      vt: [16, [0, 6972386, 14722448, 18452204, 22207964, 37451256], 768090878],
      vvm: [2544, 159, 179],
      startIndices: [0, 7, 16],
      numeric: ['max_count', 'min_zoom'],
      categorical: [],
    },
    {
      id: '14/4834/6152@1420070400000',
      layer: 'default',
      featureCount: 2,
      geometryType: GeometryType.LineString,
      timeOffset: 1420070400000,
      startTimes: [0, 0],
      endTimes: [143100000, 143100000],
      vt: [
        23,
        [107141392, 119244832, 143100000, 0, 787916, 2006446],
        791576300,
      ],
      vvm: [3657, 159, 14.5],
      startIndices: [0, 3, 23],
      numeric: ['max_count', 'min_zoom'],
      categorical: [],
    },
    {
      id: '14/4836/6167@1420070400000',
      layer: 'default',
      featureCount: 8,
      geometryType: GeometryType.LineString,
      timeOffset: 1420070400000,
      startTimes: [0, 0, 0, 0, 0, 0, 0, 0],
      endTimes: [
        143100000, 143100000, 143100000, 143100000, 143100000, 143100000,
        143100000, 143100000,
      ],
      vt: [27, [0, 66085476, 89220720, 98728176, 143100000, 0], 1947899600],
      vvm: [4293, 159, 27],
      startIndices: [0, 5, 7, 10, 14, 17, 19, 24, 27],
      numeric: ['max_count', 'min_zoom'],
      categorical: [],
    },
  ],
  // ecco-currents — raw Float32 vertex_value with NaN holes, ABSOLUTE Int64
  // vertex_time (no `vt` key at all: the other delta branch).
  currents: [
    {
      id: '4/5/8@1502928000000',
      layer: 'default',
      featureCount: 3,
      geometryType: GeometryType.LineString,
      timeOffset: 1502928000000,
      startTimes: [0, 129600000, 132898160],
      endTimes: [426776928, 432000000, 222156544],
      vt: [
        7,
        [0, 402889856, 426772672, 129598720, 431993536, 132894720],
        1746299904,
      ],
      vv: [
        7,
        ['NaN', 'NaN', 'NaN', 'NaN', 'NaN', 0.5192004442214966],
        5,
        1.032312,
      ],
      startIndices: [0, 3, 5, 7],
      numeric: ['seed_lat', 'speed'],
      categorical: ['basin'],
    },
    {
      id: '4/8/1@1512432000000',
      layer: 'default',
      featureCount: 4,
      geometryType: GeometryType.LineString,
      timeOffset: 1512432000000,
      startTimes: [0, 0, 0, 0],
      endTimes: [129600000, 432000000, 432000000, 432000000],
      vt: [10, [0, 129598720, 0, 431993536, 0, 129598720], 1766332992],
      vv: [
        10,
        ['NaN', 'NaN', 'NaN', 'NaN', 0.07247576117515564, 0.07502933591604233],
        7,
        0.227117,
      ],
      startIndices: [0, 2, 4, 7, 10],
      numeric: ['seed_lat', 'speed'],
      categorical: ['basin'],
    },
    {
      id: '5/23/24@1492128000000',
      layer: 'default',
      featureCount: 4,
      geometryType: GeometryType.LineString,
      timeOffset: 1492128000000,
      startTimes: [0, 0, 0, 158426448],
      endTimes: [129600000, 432000000, 432000000, 432000000],
      vt: [10, [0, 129598720, 0, 129598720, 431993536, 0], 1914422272],
      vv: [
        10,
        [
          'NaN',
          'NaN',
          0.1299254149198532,
          0.1284707486629486,
          0.13457179069519043,
          'NaN',
        ],
        7,
        0.392968,
      ],
      startIndices: [0, 2, 5, 8, 10],
      numeric: ['seed_lat', 'speed'],
      categorical: ['basin'],
    },
    {
      id: '5/19/24@1497312000000',
      layer: 'default',
      featureCount: 3,
      geometryType: GeometryType.LineString,
      timeOffset: 1497312000000,
      startTimes: [0, 0, 0],
      endTimes: [129600000, 432000000, 432000000],
      vt: [7, [0, 129598720, 0, 411789056, 431993536, 0], 1405374848],
      vv: [
        7,
        [0.09136560559272766, 0.09606892615556717, 'NaN', 'NaN', 'NaN', 'NaN'],
        5,
        0.187435,
      ],
      startIndices: [0, 2, 5, 7],
      numeric: ['seed_lat', 'speed'],
      categorical: ['basin'],
    },
    {
      id: '5/22/4@1503792000000',
      layer: 'default',
      featureCount: 4,
      geometryType: GeometryType.LineString,
      timeOffset: 1503792000000,
      startTimes: [0, 0, 0, 412802400],
      endTimes: [129600000, 432000000, 432000000, 432000000],
      vt: [8, [0, 129598720, 0, 431993536, 0, 431993536], 1838376960],
      vv: [
        8,
        [0.07366237789392471, 0.07237571477890015, 'NaN', 'NaN', 'NaN', 'NaN'],
        6,
        0.146038,
      ],
      startIndices: [0, 2, 4, 6, 8],
      numeric: ['seed_lat', 'speed'],
      categorical: ['basin'],
    },
    {
      id: '5/17/24@1507680000000',
      layer: 'default',
      featureCount: 3,
      geometryType: GeometryType.LineString,
      timeOffset: 1507680000000,
      startTimes: [0, 0, 129600000],
      endTimes: [432000000, 432000000, 250653632],
      vt: [7, [0, 129598720, 431993536, 0, 431993536, 129598720], 1373832128],
      vv: [
        7,
        [
          0.13416601717472076,
          0.1340341866016388,
          0.1343049854040146,
          'NaN',
          'NaN',
          'NaN',
        ],
        4,
        0.402505,
      ],
      startIndices: [0, 3, 5, 7],
      numeric: ['seed_lat', 'speed'],
      categorical: ['basin'],
    },
  ],
  // v2-golden — instantaneous points, attr-quant + two dictionaries, paged.
  points: (
    [
      ['4/2/6@1767225600000', 1767225900000],
      ['4/2/6@1767229200000', 1767229500000],
      ['5/5/12@1767225600000', 1767225900000],
      ['5/5/12@1767229200000', 1767229500000],
    ] as const
  ).map(([id, timeOffset]) => ({
    id,
    layer: 'default',
    featureCount: 9,
    geometryType: GeometryType.Point,
    timeOffset,
    startTimes: [
      0, 300000, 600000, 900000, 1200000, 1500000, 1800000, 2100000, 2400000,
    ],
    endTimes: [
      0, 300000, 600000, 900000, 1200000, 1500000, 1800000, 2100000, 2400000,
    ],
    numeric: ['speed'],
    categorical: ['agency', 'kind'],
  })),
  // v2-golden-tracks — u16-delta vertex_time with a widened step.
  tracks: [
    {
      id: '5/5/12@1767225600000',
      layer: 'tracks',
      featureCount: 2,
      geometryType: GeometryType.LineString,
      timeOffset: 1767225600000,
      startTimes: [0, 300000],
      endTimes: [1800000, 2820000],
      vt: [7, [0, 600028, 1200012, 1799996, 299992, 1560020], 8280008],
      startIndices: [0, 4, 7],
      numeric: ['speed'],
      categorical: [],
    },
    {
      id: '5/5/12@1767229200000',
      layer: 'tracks',
      featureCount: 1,
      geometryType: GeometryType.LineString,
      timeOffset: 1767229320000,
      startTimes: [0],
      endTimes: [2340000],
      vt: [5, [0, 585036, 1170036, 1755036, 2340000], 5850108],
      startIndices: [0, 5],
      numeric: ['speed'],
      categorical: [],
    },
  ],
};

describe.each(DATASETS)('legacy archive back-compat: %s', (name) => {
  it('decodes to the exact pre-change times, vertex times and vertex values', async () => {
    const got = await decodeAll(name);
    const want = EXPECTED[name];
    expect(got.map((g) => `${g.id}:${g.layer}`)).toEqual(
      want.map((w) => `${w.id}:${w.layer}`),
    );

    for (let i = 0; i < want.length; i++) {
      const w = want[i];
      const f = got[i].features;
      const at = `${name} ${w.id}`;

      expect(f.featureCount, `${at} featureCount`).toBe(w.featureCount);
      expect(f.geometryType, `${at} geometryType`).toBe(w.geometryType);
      expect(f.timeOffset, `${at} timeOffset`).toBe(w.timeOffset);

      // The headline claim: the absolute-Int64 time columns still decode to
      // the same tile-relative Float32 values.
      expect(Array.from(f.startTimes), `${at} startTimes`).toEqual(
        w.startTimes,
      );
      expect(Array.from(f.endTimes), `${at} endTimes`).toEqual(w.endTimes);

      if (w.vt) {
        const [len, head, sum] = w.vt;
        expect(
          f.vertexTimestamps,
          `${at} vertexTimestamps present`,
        ).toBeDefined();
        expect(f.vertexTimestamps!.length, `${at} vertexTimestamps len`).toBe(
          len,
        );
        expect(
          Array.from(f.vertexTimestamps!.slice(0, head.length)),
          `${at} vertexTimestamps head`,
        ).toEqual(head);
        expect(
          finiteSum(f.vertexTimestamps!),
          `${at} vertexTimestamps sum`,
        ).toBe(sum);
      } else {
        expect(f.vertexTimestamps, `${at} vertexTimestamps`).toBeUndefined();
      }

      if (w.vv) {
        const [len, head, nans, sum] = w.vv;
        expect(f.vertexValues, `${at} vertexValues present`).toBeDefined();
        expect(f.vertexValues!.length, `${at} vertexValues len`).toBe(len);
        expect(
          Array.from(f.vertexValues!.slice(0, head.length)).map((v) =>
            Number.isNaN(v) ? 'NaN' : v,
          ),
          `${at} vertexValues head`,
        ).toEqual(head);
        // NaN is the raw-Float32 shape's "no value at this vertex". The
        // quantized shape encodes it as index 0xFFFF; on this path it must
        // survive as a literal NaN, not become 0 or the affine's origin.
        expect(nanCount(f.vertexValues!), `${at} vertexValues NaN count`).toBe(
          nans,
        );
        expect(finiteSum(f.vertexValues!), `${at} vertexValues sum`).toBe(sum);
      } else {
        expect(f.vertexValues, `${at} vertexValues`).toBeUndefined();
      }

      if (w.vvm) {
        const [len, buckets, sum] = w.vvm;
        expect(
          f.vertexValueMatrix,
          `${at} vertexValueMatrix present`,
        ).toBeDefined();
        expect(f.vertexValueMatrix!.length, `${at} vertexValueMatrix len`).toBe(
          len,
        );
        expect(f.vertexValueBuckets, `${at} vertexValueBuckets`).toBe(buckets);
        expect(
          finiteSum(f.vertexValueMatrix!),
          `${at} vertexValueMatrix sum`,
        ).toBe(sum);
      } else {
        expect(f.vertexValueMatrix, `${at} vertexValueMatrix`).toBeUndefined();
      }

      if (w.startIndices) {
        expect(Array.from(f.startIndices ?? []), `${at} startIndices`).toEqual(
          w.startIndices,
        );
      }

      // `part_offsets` did not exist when these were written, so every
      // feature is single-part and `partIndices` must stay ABSENT — the
      // signal downstream layers use to skip per-part work entirely.
      expect(f.partIndices, `${at} partIndices`).toBeUndefined();

      expect(Object.keys(f.numericProps ?? {}).sort(), `${at} numeric`).toEqual(
        w.numeric,
      );
      expect(
        Object.keys(f.categoricalProps ?? {}).sort(),
        `${at} categorical`,
      ).toEqual(w.categorical);
    }
  });

  it('reconstructs absolute feature times through getFeatureProperties', async () => {
    const got = await decodeAll(name);
    const want = EXPECTED[name];
    for (let i = 0; i < want.length; i++) {
      const f = got[i].features;
      for (let k = 0; k < f.featureCount; k++) {
        const props = getFeatureProperties(f, k)!;
        expect(props.start_time, `${name} ${want[i].id} #${k} start_time`).toBe(
          want[i].timeOffset + want[i].startTimes[k],
        );
        expect(props.end_time, `${name} ${want[i].id} #${k} end_time`).toBe(
          want[i].timeOffset + want[i].endTimes[k],
        );
      }
    }
  });
});
