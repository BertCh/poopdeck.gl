/**
 * Cross-impl conformance for the `path-codec` capability (packed-format
 * §5.2.7): the Rust writer's `conformance/vectors/path-codec/` vectors, read
 * through this reader.
 *
 * The vectors are produced upstream (`stt:crates/stt-core/examples/make-path-codec-vectors.rs`)
 * and vendored into `fixtures/path-codec/` by `pnpm stt:sync`, like every
 * other conformance vector here. Until they are vendored this suite SKIPS,
 * with the reason in the skipped test's name, rather than passing vacuously.
 * `STT_CONFORMANCE_VECTORS=<upstream>/conformance/vectors` reads an upstream
 * checkout's copy in place instead.
 *
 * Four layers, mirroring the vector README:
 *
 *   - `sections.json` `valid[]`: each bare section decodes to its exact
 *     expected offsets, coordinates (IEEE bits / Int32) and times;
 *   - `sections.json` `reject[]`: each one throws a named PATH_CODEC error;
 *   - `tiles.json`: each whole payload decodes — through `decodeTile` and
 *     `toGeoArrowTable` — to exactly what its non-codec twin decodes to, and
 *     to the vector's own expected `geometry` / `vertex_time` columns;
 *   - `grid/`, `decimal/`: both archives open (the reader declares
 *     `path-codec`) and every tile decodes, codec layers included.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { decodePathCodec } from '../src/path-codec';
import { decodeTile, toGeoArrowTable } from '../src/tile';
import type { STTTileLayer, TileId } from '../src/types';
import {
  bits,
  expectSameFeatures,
  expectSameTable,
} from './helpers/path-codec-compare';
import {
  loadPackedDatasetFromDisk,
  packedFetch,
} from './helpers/packed-fixture';

const DIR = process.env.STT_CONFORMANCE_VECTORS
  ? path.join(path.resolve(process.env.STT_CONFORMANCE_VECTORS), 'path-codec')
  : fileURLToPath(new URL('./fixtures/path-codec/', import.meta.url));
const PRESENT = fs.existsSync(path.join(DIR, 'sections.json'));

interface ValidSection {
  name: string;
  section_hex: string;
  expected: {
    mode: 'grid' | 'decimal';
    counts: number[];
    coords: Array<[number | string, number | string]>;
    times: string[] | null;
  };
}
interface RejectSection {
  name: string;
  reason: string;
  section_hex: string;
}
interface LayerVector {
  name: string;
  rows: number;
  path_codec: boolean;
  columns: string[];
  geometry: {
    leaf: 'Int32' | 'Float64';
    offsets: number[];
    values: Array<number | string>;
  } | null;
  vertex_time: {
    offsets: number[];
    valid: boolean[];
    values: string[];
  } | null;
}
interface TileVector {
  name: string;
  payload_hex: string;
  twin_payload_hex: string;
  layers: LayerVector[];
}

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** A decimal coordinate's spelling: the big-endian hex of its u64 bits. */
const f64Bits = (h: string | number): bigint => BigInt(`0x${h}`);

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as T;
}

/**
 * A bare reject section has no CORE batch to agree with, so take the
 * expectation from the section itself (flags byte, `feature_count` varint):
 * only the section's own validity is under test.
 */
function selfExpectation(b: Uint8Array) {
  const flags = b.length > 1 ? b[1] : 0;
  let featureCount = 0;
  let mul = 1;
  for (let p = 2; p < b.length && p < 12; p++) {
    featureCount += (b[p] & 0x7f) * mul;
    if (b[p] < 0x80) break;
    mul *= 128;
  }
  return {
    featureCount,
    hasTime: (flags & 1) !== 0,
    decimal: (flags & 2) !== 0,
  };
}

/** Offsets of an Arrow list column's single chunk, rebased to its slice. */
function listOffsets(data: {
  valueOffsets: Int32Array;
  offset: number;
  length: number;
}) {
  return Array.from(
    data.valueOffsets.subarray(data.offset, data.offset + data.length + 1),
  );
}

/** The vector's own spelling of the decoded `geometry` / `vertex_time`. */
function expectColumns(layer: STTTileLayer, want: LayerVector): void {
  const table = toGeoArrowTable(layer);
  if (want.geometry) {
    const col = table.getChild('geometry')!;
    const data = col.data[0];
    expect(listOffsets(data as never)).toEqual(want.geometry.offsets);
    // LineString: List<FixedSizeList<2>>; a point layer is FixedSizeList<2>.
    const coords = data.children[0];
    const leaf = (coords.children[0] ?? coords).values as
      | Float64Array
      | Int32Array;
    if (want.geometry.leaf === 'Float64') {
      expect(leaf).toBeInstanceOf(Float64Array);
      expect(Array.from(bits(leaf as Float64Array))).toEqual(
        want.geometry.values.map(f64Bits),
      );
    } else {
      expect(leaf).toBeInstanceOf(Int32Array);
      expect(Array.from(leaf)).toEqual(want.geometry.values);
    }
    expect(col.nullCount).toBe(0);
  }
  if (want.vertex_time) {
    const col = table.getChild('vertex_time')!;
    const data = col.data[0];
    expect(listOffsets(data as never)).toEqual(want.vertex_time.offsets);
    expect(
      Array.from({ length: col.length }, (_, i) => col.isValid(i)),
    ).toEqual(want.vertex_time.valid);
    expect(Array.from(data.children[0].values as BigInt64Array)).toEqual(
      want.vertex_time.values.map((t) => BigInt(t)),
    );
  } else {
    expect(table.getChild('vertex_time')).toBeNull();
  }
}

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

describe('path-codec conformance vectors', () => {
  // Skipped, with the reason in its name, until the vectors exist.
  it.skipIf(!PRESENT)(
    `vectors are present at ${path.relative(process.cwd(), DIR)} (skipped: ` +
      'they arrive with `pnpm stt:sync` once upstream lands them, or set ' +
      'STT_CONFORMANCE_VECTORS to an upstream conformance/vectors directory)',
    () => {
      expect(PRESENT).toBe(true);
    },
  );

  describe.skipIf(!PRESENT)('sections.json', () => {
    const doc = PRESENT
      ? readJson<{ valid: ValidSection[]; reject: RejectSection[] }>(
          'sections.json',
        )
      : { valid: [], reject: [] };

    for (const v of doc.valid) {
      it(`valid: ${v.name} decodes to its expected values`, () => {
        const { mode, counts, coords, times } = v.expected;
        const out = decodePathCodec(
          hex(v.section_hex),
          {
            featureCount: counts.length,
            hasTime: times !== null,
            decimal: mode === 'decimal',
          },
          v.name,
        );
        const offsets = [0];
        for (const c of counts) offsets.push(offsets[offsets.length - 1] + c);
        expect(Array.from(out.offsets)).toEqual(offsets);
        expect(out.vertexCount).toBe(coords.length);
        const flat = coords.flat();
        if (mode === 'decimal') {
          expect(out.coords).toBeInstanceOf(Float64Array);
          expect(Array.from(bits(out.coords as Float64Array))).toEqual(
            flat.map(f64Bits),
          );
        } else {
          expect(out.coords).toBeInstanceOf(Int32Array);
          expect(Array.from(out.coords)).toEqual(flat);
        }
        if (times === null) {
          expect(out.times).toBeUndefined();
        } else {
          expect(Array.from(out.times!)).toEqual(times.map((t) => BigInt(t)));
        }
      });
    }

    for (const r of doc.reject) {
      it(`reject: ${r.name} (${r.reason})`, () => {
        const b = hex(r.section_hex);
        expect(() => decodePathCodec(b, selfExpectation(b), r.name)).toThrow(
          new RegExp(`^${r.name}: PATH_CODEC `),
        );
      });
    }
  });

  describe.skipIf(!PRESENT)('tiles.json', () => {
    const doc = PRESENT
      ? readJson<{ tiles: TileVector[] }>('tiles.json')
      : { tiles: [] };

    for (const v of doc.tiles) {
      it(`${v.name}: decodes equal to its non-codec twin and to the expected columns`, () => {
        const coded = decodeTile(hex(v.payload_hex), tileId);
        const twin = decodeTile(hex(v.twin_payload_hex), tileId);
        const names = v.layers.map((l) => l.name);
        expect(coded.layers.map((l) => l.name)).toEqual(names);
        expect(twin.layers.map((l) => l.name)).toEqual(names);
        v.layers.forEach((want, li) => {
          const layer = coded.layers[li];
          const ref = twin.layers[li];
          expect(layer.pathCodec !== undefined, `${want.name}`).toBe(
            want.path_codec,
          );
          expect(ref.pathCodec).toBeUndefined();
          expectSameFeatures(layer.features, ref.features);
          const table = toGeoArrowTable(layer);
          expectSameTable(table, toGeoArrowTable(ref));
          expect(table.numRows).toBe(want.rows);
          expect(table.schema.fields.map((f) => f.name)).toEqual(want.columns);
          expectColumns(layer, want);
        });
      });

      it(`${v.name}: the worker-path rehydrate rebuilds the same table`, () => {
        const coded = decodeTile(hex(v.payload_hex), tileId);
        const twin = decodeTile(hex(v.twin_payload_hex), tileId);
        coded.layers.forEach((layer, li) => {
          delete layer.arrowTable;
          expectSameTable(
            toGeoArrowTable(layer),
            toGeoArrowTable(twin.layers[li]),
          );
        });
      });
    }
  });

  describe.skipIf(!PRESENT)('archives', () => {
    for (const name of ['grid', 'decimal']) {
      it(`${name}/: opens and every tile decodes, codec layers included`, async () => {
        const dir = path.join(DIR, name);
        const mem = loadPackedDatasetFromDisk(
          fs,
          dir,
          `mem://conformance/path-codec/${name}/manifest.json`,
        );
        const archive = new STTArchive({
          url: mem.manifestUrl,
          fetch: packedFetch(mem),
          // Keep `pathCodec` on quantized layers too ('auto' drops it with
          // the IPC bytes), so the codec layers can be counted.
          retainArrowIpc: true,
        });
        const manifest = JSON.parse(
          fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
        );
        expect(manifest.capabilities).toContain('path-codec');
        const index = await archive.getIndex();
        let tiles = 0;
        let codecLayers = 0;
        for (const e of index.tiles.filter((t) => t.variantId === 0)) {
          const tile = await archive.getTile({
            z: e.zoom,
            x: e.x,
            y: e.y,
            t: e.timeStart,
          });
          expect(tile).not.toBeNull();
          tiles++;
          for (const layer of tile!.layers) {
            if (layer.pathCodec) codecLayers++;
            const f = layer.features;
            if (!f.startIndices) continue;
            const vc = f.startIndices[f.featureCount];
            expect(f.positions.length).toBe(vc * 2);
            if (f.vertexTimestamps) expect(f.vertexTimestamps.length).toBe(vc);
          }
        }
        expect(tiles).toBeGreaterThan(0);
        expect(codecLayers).toBeGreaterThan(0);
      });
    }
  });
});
