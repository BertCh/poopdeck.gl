/**
 * Whole-archive oracle for the path codec, on real data.
 *
 * Build one source twice with `stt-build`: once with `--path-codec`, once
 * without it but with `--vertex-time-precision 1` (the codec is exact, the
 * default build truncates vertex times). Every tile of the two archives must
 * decode to the same `BinaryFeatures`: positions by bit pattern, vertex times,
 * feature times and start indices by value.
 *
 * Opt-in, because the archives are too large to vendor:
 *
 *   STT_PATH_CODEC_ARCHIVE=<codec dir> STT_PATH_CODEC_REFERENCE=<reference dir> \
 *     pnpm --filter @poopdeck.gl/core exec vitest run test/path-codec-archive-equivalence.test.ts
 *
 * The Rust twin is `stt:crates/stt-core/examples/path-codec-equivalence.rs`.
 *
 * Why `vertexTimestamps` can be compared exactly, and where that stops: the
 * codec layer's are `fround(t - t0)` (one rounding), the reference's
 * feature-anchored (`vtf`) arm is `fround(fround(start - t0) + delta * step)`
 * — its anchor is the already-Float32 `startTimes[row]`. The two agree
 * exactly while every `start - t0` is an integer Float32 holds exactly,
 * i.e. below 2^24 ms (~4.66 h) inside a tile; past that the reference
 * double-rounds and a mismatch of an ulp would be the reference's rounding,
 * not a codec defect. Every tile of the AIS and ADS-B pairs is inside it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { STTArchive } from '../src/archive';
import type { TileId } from '../src/types';
import {
  loadPackedDatasetFromDisk,
  packedFetch,
} from './helpers/packed-fixture';

const CODEC = process.env.STT_PATH_CODEC_ARCHIVE;
const REFERENCE = process.env.STT_PATH_CODEC_REFERENCE;

function open(dir: string, name: string): STTArchive {
  const mem = loadPackedDatasetFromDisk(
    fs,
    dir,
    `mem://e2e/${name}/manifest.json`,
  );
  return new STTArchive({
    url: mem.manifestUrl,
    fetch: packedFetch(mem),
    retainArrowIpc: true,
    // Each tile is decoded, compared and dropped; a small cache keeps two
    // 66 K-tile archives within a bounded footprint.
    maxCacheBytes: 64 * 1024 * 1024,
  });
}

const WORLD = { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 };
const ALL_TIME = {
  start: -Number.MAX_SAFE_INTEGER,
  end: Number.MAX_SAFE_INTEGER,
};

/**
 * Every raw tile id of the archive, through the reader's own query path: a
 * paged directory loads its leaf pages on demand, so `getIndex().tiles` holds
 * only what has been paged in (nothing, on a fresh open). A world-bounds,
 * all-time query per zoom — and per temporal-LOD tier, when the archive has
 * any — pages every leaf in and lists every tile, on both directory layouts.
 */
async function allTileIds(archive: STTArchive): Promise<TileId[]> {
  const meta = await archive.getMetadata();
  const ids: TileId[] = [];
  for (let z = meta.minZoom; z <= meta.maxZoom; z++) {
    ids.push(...(await archive.getTileIdsInBounds(WORLD, z, ALL_TIME)));
    for (const lod of meta.temporalLod ?? []) {
      if (lod.bucketMs === meta.temporalBucketMs) continue;
      ids.push(
        ...(await archive.getTileIdsInBoundsForTemporalLod(
          WORLD,
          z,
          ALL_TIME,
          lod.bucketMs,
        )),
      );
    }
  }
  const key = (id: TileId) =>
    `${id.z}/${id.x}/${id.y}/${id.t}/${id.bucketMs ?? ''}`;
  return [...new Map(ids.map((id) => [key(id), id])).values()].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
}

function sameBits(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  const x = new BigUint64Array(a.buffer, a.byteOffset, a.length);
  const y = new BigUint64Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

describe.skipIf(!CODEC || !REFERENCE)(
  'path codec: a real archive decodes like its non-codec twin',
  () => {
    it('every tile, every layer', async () => {
      const codec = open(CODEC!, 'codec');
      const reference = open(REFERENCE!, 'reference');
      const [ci, ri] = await Promise.all([
        allTileIds(codec),
        allTileIds(reference),
      ]);
      expect(ci.length).toBe(ri.length);
      expect(ci).toEqual(ri);

      let tiles = 0;
      let codecLayers = 0;
      let vertices = 0;
      for (const id of ci) {
        const [a, b] = await Promise.all([
          codec.getTile(id),
          reference.getTile(id),
        ]);
        const where = `z${id.z}/${id.x}/${id.y}@${id.t}${id.bucketMs ? `/${id.bucketMs}` : ''}`;
        expect(a, `${where}`).not.toBeNull();
        expect(b, `${where}`).not.toBeNull();
        expect(a!.layers.length, `${where}`).toBe(b!.layers.length);
        tiles++;
        for (let li = 0; li < a!.layers.length; li++) {
          const fa = a!.layers[li].features;
          const fb = b!.layers[li].features;
          if (a!.layers[li].pathCodec) codecLayers++;
          expect(b!.layers[li].pathCodec, `${where}`).toBeUndefined();
          expect(fa.featureCount, `${where}`).toBe(fb.featureCount);
          expect(fa.timeOffset, `${where}`).toBe(fb.timeOffset);
          // Arrays are compared with a boolean so a mismatch does not make
          // vitest print millions of values.
          expect(
            sameBits(
              fa.positions as Float64Array,
              fb.positions as Float64Array,
            ),
            `${where}`,
          ).toBe(true);
          for (const key of [
            'startIndices',
            'vertexTimestamps',
            'startTimes',
            'endTimes',
          ] as const) {
            const x = fa[key];
            const y = fb[key];
            expect(x === undefined, `${where} ${key}`).toBe(y === undefined);
            if (!x || !y) continue;
            let same = x.length === y.length;
            for (let i = 0; same && i < x.length; i++)
              same = Object.is(x[i], y[i]);
            expect(same, `${where} ${key}`).toBe(true);
          }
          if (fa.startIndices) vertices += fa.startIndices[fa.featureCount];
        }
      }
      expect(tiles).toBeGreaterThan(0);
      expect(codecLayers).toBeGreaterThan(0);
      console.log(
        `${tiles} tiles, ${codecLayers} codec layers, ${vertices} vertices: identical`,
      );
    }, 1_800_000);
  },
);
