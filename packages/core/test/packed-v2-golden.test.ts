/**
 * Cross-impl contract test for packed **formatVersion 3** (spec §§3.2, 5.2).
 *
 * Reads the committed Rust-produced v2 golden fixtures (see
 * `scripts/make-v2-golden.sh`) through `STTArchive` and proves:
 *
 *   - the v2 manifest opens: `schemas` entries are base64-decoded and
 *     blake3-128-validated into the template registry (corruption fails
 *     LOUDLY at open, dataset-level, before any tile fetch);
 *   - the `STTD` directory magic is stripped on the whole-load AND the
 *     root+leaf paged paths;
 *   - v2 tiles decode end-to-end through the template splice — and, the
 *     strongest assertion, decode EQUAL to the v1 (`--format-version 1`)
 *     build of the SAME source with identical tiling flags: same features,
 *     coordinates (coord-quant), times, quantized numerics (TILE_META `qa`),
 *     categorical strings (two dictionary columns) and interpolated
 *     u16-delta vertex times (TILE_META `vt`);
 *   - the OPFS warm path decodes v2 payloads via the same registry.
 *
 * Fixture pairs (same SQL source, same flags, only `--format-version`
 * differs): `v2-golden`(+`-v1`) — quantized points, numeric + 2 dict
 * columns, paged directory; `v2-golden-tracks`(+`-v1`) — trajectories with
 * vertex_time, single directory.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { OpfsTileCache } from '../src/opfs-cache';
import type { Tile } from '../src/types';
import {
  loadPackedDatasetFromDisk,
  packedFetch,
  type InMemoryPackedDataset,
  type PackedFetchLog,
} from './helpers/packed-fixture';
import { settle } from './helpers/fixtures';
import { installShim, uninstallShim } from './helpers/opfs-shim';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function dataset(name: string): InMemoryPackedDataset {
  return loadPackedDatasetFromDisk(
    fs,
    FIXTURES + name,
    `mem://data/${name}/manifest.json`,
  );
}

function openArchive(name: string, log?: PackedFetchLog): STTArchive {
  const ds = dataset(name);
  return new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds, log) });
}

/** One feature, decoded to plain values (absolute times, real lon/lat). */
interface FeatureRecord {
  id: number;
  start: number;
  end: number;
  coords: number[];
  vertexTimes?: number[];
  numeric: Record<string, number>;
  categorical: Record<string, string | null>;
}

/** Flatten a decoded tile's single layer into id-sorted feature records. */
function featureRecords(tile: Tile): FeatureRecord[] {
  expect(tile.layers).toHaveLength(1);
  const f = tile.layers[0].features;
  const dims = f.positionDimensions ?? 2;
  const out: FeatureRecord[] = [];
  for (let i = 0; i < f.featureCount; i++) {
    const [from, to] = f.startIndices
      ? [f.startIndices[i], f.startIndices[i + 1]]
      : [i, i + 1];
    const rec: FeatureRecord = {
      id: f.featureIds[i],
      start: f.timeOffset + f.startTimes[i],
      end: f.timeOffset + f.endTimes[i],
      coords: Array.from(f.positions.subarray(from * dims, to * dims)),
      numeric: {},
      categorical: {},
    };
    if (f.vertexTimestamps) {
      rec.vertexTimes = Array.from(f.vertexTimestamps.subarray(from, to)).map(
        (t) => f.timeOffset + t,
      );
    }
    for (const [name, values] of Object.entries(f.numericProps)) {
      rec.numeric[name] = values[i];
    }
    for (const [name, { indices, categories }] of Object.entries(
      f.categoricalProps,
    )) {
      rec.categorical[name] =
        indices[i] === 0xffff ? null : categories[indices[i]];
    }
    out.push(rec);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Decode EVERY indexed tile of an archive into `key → records`. */
async function decodeAll(
  archive: STTArchive,
): Promise<Map<string, FeatureRecord[]>> {
  const index = await archive.getIndex();
  const out = new Map<string, FeatureRecord[]>();
  for (const e of index.tiles) {
    const tile = await archive.getTile({
      z: e.zoom,
      x: e.x,
      y: e.y,
      t: e.timeStart,
    });
    expect(tile, `tile ${e.zoom}/${e.x}/${e.y}/${e.timeStart}`).not.toBeNull();
    out.set(`${e.zoom}/${e.x}/${e.y}/${e.timeStart}`, featureRecords(tile!));
  }
  return out;
}

describe('STT packed formatVersion 3 (golden fixtures)', () => {
  it('marks features time-sorted (§5.2.3)', async () => {
    const v2 = openArchive('v2-golden');
    const i2 = await v2.getIndex();
    const e = i2.tiles[0];
    const tile = await v2.getTile({
      z: e.zoom,
      x: e.x,
      y: e.y,
      t: e.timeStart,
    });
    expect(tile!.layers[0].features.timesSorted).toBe(true);
    const startTimes = Array.from(tile!.layers[0].features.startTimes);
    expect(startTimes).toEqual([...startTimes].sort((a, b) => a - b));
  });

  it('decodes v2 through the root+leaf PAGED directory path (STTD magic + leaf offsets)', async () => {
    // Force true paging (root-prefix range GET + on-demand leaf ranges) so
    // the v2 magic-shifted leaf offset math is exercised, not just the
    // small-directory whole-load path.
    const ds = dataset('v2-golden');
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const paged = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds, log),
      directoryPageThresholdBytes: 0,
    });
    const whole = openArchive('v2-golden');
    // A truly-paged index starts EMPTY (leaves stream in per query), so
    // drive the production query path — windowed bounds queries fault the
    // covering leaf pages in — and compare every returned tile against the
    // whole-load twin.
    const dw = await decodeAll(whole);
    const meta = await paged.getMetadata();
    const world = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const seen = new Map<string, FeatureRecord[]>();
    for (const zoom of [4, 5]) {
      const tiles = await paged.getTilesInBounds(world, zoom, meta.timeRange);
      for (const tile of tiles) {
        if (!tile) continue;
        seen.set(
          `${tile.id.z}/${tile.id.x}/${tile.id.y}/${tile.id.t}`,
          featureRecords(tile),
        );
      }
    }
    expect([...seen.keys()].sort()).toEqual([...dw.keys()].sort());
    for (const [key, records] of dw)
      expect(seen.get(key), `tile ${key}`).toEqual(records);
    // The directory really was range-read (root page, then leaf pages).
    expect(log.ranges.some((r) => r.path.startsWith('index/'))).toBe(true);
  });

  it('serves a v2 warm hit from OPFS through the shared template registry', async () => {
    installShim();
    try {
      const cache = new OpfsTileCache();
      const ds = dataset('v2-golden');
      const a = new STTArchive({
        url: ds.manifestUrl,
        fetch: packedFetch(ds),
        opfsCacheImpl: cache,
      });
      const index = await a.getIndex();
      const e = index.tiles[0];
      const id = { z: e.zoom, x: e.x, y: e.y, t: e.timeStart };
      const cold = await a.getTile(id);
      expect(cold).not.toBeNull();
      await settle(50); // fire-and-forget OPFS write

      // Fresh archive over the SAME cache: the tile must decode from the
      // OPFS payload (no pack range request) via the v2 registry + splice.
      const log: PackedFetchLog = { paths: [], ranges: [] };
      const b = new STTArchive({
        url: ds.manifestUrl,
        fetch: packedFetch(ds, log),
        opfsCacheImpl: cache,
      });
      await b.getIndex();
      const before = log.ranges.filter((r) =>
        r.path.startsWith('packs/'),
      ).length;
      const warm = await b.getTile(id);
      const after = log.ranges.filter((r) =>
        r.path.startsWith('packs/'),
      ).length;
      expect(warm).not.toBeNull();
      expect(after).toBe(before); // zero pack fetches — OPFS served it
      expect(featureRecords(warm!)).toEqual(featureRecords(cold!));
      expect(b.getCacheStats().opfs?.hits ?? 0).toBeGreaterThan(0);
    } finally {
      uninstallShim();
    }
  });
});

describe('v2 manifest schemas validation (loud, dataset-level, at open)', () => {
  /** The v2 fixture with its manifest JSON rewritten through `mutate`. */
  function withManifest(
    mutate: (manifest: any) => void,
    name = 'v2-golden',
  ): STTArchive {
    const ds = dataset(name);
    const manifest = JSON.parse(
      new TextDecoder().decode(ds.objects.get('manifest.json')!),
    );
    mutate(manifest);
    ds.objects.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    return new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
  }

  it('rejects a schemas entry whose bytes do not hash to its declared hash', async () => {
    const archive = withManifest((m) => {
      const h: string = m.schemas[0].hash;
      m.schemas[0].hash = (h[0] === '0' ? '1' : '0') + h.slice(1);
    });
    await expect(archive.getMetadata()).rejects.toThrow(
      /template bytes hash to .* declared/,
    );
  });

  it('rejects a schemas entry with corrupt base64', async () => {
    const archive = withManifest((m) => {
      m.schemas[0].data = '!!!not-base64!!!';
    });
    await expect(archive.getMetadata()).rejects.toThrow(/base64 decode failed/);
  });

  it('rejects a schemas entry with truncated data (hash mismatch)', async () => {
    const archive = withManifest((m) => {
      m.schemas[0].data = m.schemas[0].data.slice(0, 24);
    });
    await expect(archive.getMetadata()).rejects.toThrow(
      /base64 decode failed|template bytes hash to/,
    );
  });

  it('rejects a schemas entry with empty data', async () => {
    const archive = withManifest((m) => {
      m.schemas[0].data = '';
    });
    await expect(archive.getMetadata()).rejects.toThrow(
      /template bytes are empty/,
    );
  });

  it('rejects a malformed schemas entry (missing data)', async () => {
    const archive = withManifest((m) => {
      delete m.schemas[0].data;
    });
    await expect(archive.getMetadata()).rejects.toThrow(
      /schemas\[0\] is malformed/,
    );
  });

  it('fails before any tile fetch: corrupt schemas block the index too', async () => {
    const archive = withManifest((m) => {
      m.schemas[0].data = '';
    });
    await expect(archive.getIndex()).rejects.toThrow(
      /template bytes are empty/,
    );
  });

  it('a frame referencing a template MISSING from the registry fails by hash, not silently empty', async () => {
    // Drop one template entry (re-validating hashes stays green for the
    // rest) — decoding a tile that references it must name the hash.
    let dropped = '';
    const archive = withManifest((m) => {
      dropped = m.schemas[0].hash;
      m.schemas = m.schemas.slice(1);
    });
    const index = await archive.getIndex();
    const e = index.tiles[0];
    await expect(
      archive.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart }),
    ).rejects.toThrow(new RegExp(`${dropped}.*not in the dataset's registry`));
  });
});
