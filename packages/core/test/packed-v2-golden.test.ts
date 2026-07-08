/**
 * Cross-impl contract test for packed **formatVersion 2** (spec §§3.2, 5.2).
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

/** The v2 ↔ v1 same-source equivalence, per fixture pair. */
async function expectPairEquivalent(
  v2Name: string,
  v1Name: string,
): Promise<void> {
  const v2 = openArchive(v2Name);
  const v1 = openArchive(v1Name);

  // Same logical directory: identical (z,x,y,t) → (span, featureCount).
  const [i2, i1] = [await v2.getIndex(), await v1.getIndex()];
  const describeEntries = (tiles: typeof i1.tiles) =>
    tiles
      .map(
        (e) =>
          `${e.zoom}/${e.x}/${e.y}/${e.timeStart}-${e.timeEnd}#${e.featureCount}`,
      )
      .sort();
  expect(describeEntries(i2.tiles)).toEqual(describeEntries(i1.tiles));

  // Same decoded features, tile by tile. v2 rows are stable-sorted by
  // start_time (§5.2.3) while the frozen v1 writer keeps placement order,
  // so records compare id-sorted.
  const [d2, d1] = [await decodeAll(v2), await decodeAll(v1)];
  expect([...d2.keys()].sort()).toEqual([...d1.keys()].sort());
  for (const [key, records1] of d1) {
    expect(d2.get(key), `tile ${key}`).toEqual(records1);
  }
}

describe('STT packed formatVersion 2 (golden fixtures)', () => {
  it('opens the v2 manifest: registry built, metadata folded, version surfaced', async () => {
    const archive = openArchive('v2-golden');
    const meta = await archive.getMetadata();
    expect(meta.version).toBe(2);
    expect(meta.name).toBe('v2-golden');
  });

  it('quantized points + numeric + two dictionary columns: v2 decode == v1 decode of the same source', async () => {
    await expectPairEquivalent('v2-golden', 'v2-golden-v1');
  });

  it('trajectories with u16-delta vertex_time (TILE_META vt): v2 decode == v1 decode', async () => {
    await expectPairEquivalent('v2-golden-tracks', 'v2-golden-tracks-v1');
  });

  it('rehydrates a worker-shaped v2 layer (core+props re-merge) in toGeoArrowTable', async () => {
    // The worker decode path strips the non-cloneable Table and ships the
    // spliced core + props IPC streams; simulate that shape from an
    // inline-decoded tile and prove the lazy rehydrate re-merges them.
    const { toGeoArrowTable } = await import('../src/tile');
    const archive = openArchive('v2-golden-tracks'); // unquantized → IPC retained
    const index = await archive.getIndex();
    const e = index.tiles[0];
    const tile = await archive.getTile({
      z: e.zoom,
      x: e.x,
      y: e.y,
      t: e.timeStart,
    });
    const layer = tile!.layers[0];
    const direct = toGeoArrowTable(layer);
    const workerShaped = { ...layer, arrowTable: undefined };
    const rehydrated = toGeoArrowTable(workerShaped);
    expect(rehydrated.numRows).toBe(direct.numRows);
    expect(rehydrated.schema.fields.map((f) => f.name)).toEqual(
      direct.schema.fields.map((f) => f.name),
    );
    // Property columns survive the re-merge (the v2 section split must be
    // invisible to GeoArrow consumers).
    expect(rehydrated.getChild('speed')).not.toBeNull();
    // The TILE_META re-injection survives too: `layer.tileMeta` rides the
    // worker boundary as plain JSON, so the rehydrated schema carries the
    // SAME stt:* keys as the inline-decoded table (t0 + the vt pair here).
    expect(Object.fromEntries(rehydrated.schema.metadata)).toEqual(
      Object.fromEntries(direct.schema.metadata),
    );
    expect(rehydrated.schema.metadata.get('stt:time_offset_ms')).toBeDefined();
    expect(
      rehydrated.schema.metadata.get('stt:vertex_time_origin_ms'),
    ).toBeDefined();
    expect(
      rehydrated.schema.metadata.get('stt:vertex_time_step_ms'),
    ).toBeDefined();
  });

  it('re-injects TILE_META into the GeoArrow hand-off: v2 schema metadata == the v1 fixture (merge_v2_layer parity)', async () => {
    const { toGeoArrowTable } = await import('../src/tile');
    // retainArrowIpc: true — the quantized pair's layers otherwise drop
    // their backing tables under the default 'auto' policy.
    const open = (name: string): STTArchive => {
      const ds = dataset(name);
      return new STTArchive({
        url: ds.manifestUrl,
        fetch: packedFetch(ds),
        retainArrowIpc: true,
      });
    };
    const pairs: Array<[string, string]> = [
      ['v2-golden', 'v2-golden-v1'], // per-field stt:qa (quantize-attrs-auto)
      ['v2-golden-tracks', 'v2-golden-tracks-v1'], // stt:time_offset_ms + stt:vertex_time_*
    ];
    for (const [v2Name, v1Name] of pairs) {
      const [v2, v1] = [open(v2Name), open(v1Name)];
      const [i2, i1] = [await v2.getIndex(), await v1.getIndex()];
      const key = (e: (typeof i1.tiles)[number]) =>
        `${e.zoom}/${e.x}/${e.y}/${e.timeStart}`;
      const v1ByKey = new Map(i1.tiles.map((e) => [key(e), e]));
      expect(i2.tiles.length).toBeGreaterThan(0);
      for (const e2 of i2.tiles) {
        const e1 = v1ByKey.get(key(e2));
        expect(e1, `v1 twin of tile ${key(e2)}`).toBeDefined();
        const t2 = await v2.getTile({
          z: e2.zoom,
          x: e2.x,
          y: e2.y,
          t: e2.timeStart,
        });
        const t1 = await v1.getTile({
          z: e1!.zoom,
          x: e1!.x,
          y: e1!.y,
          t: e1!.timeStart,
        });
        const g2 = toGeoArrowTable(t2!.layers[0]);
        const g1 = toGeoArrowTable(t1!.layers[0]);
        // Schema-level metadata: the TILE_META-hoisted keys
        // (stt:time_offset_ms / stt:vertex_time_* / stt:vertex_value_buckets)
        // must be re-injected with the exact v1 strings, alongside the
        // dataset-constant keys the templates already carry.
        expect(
          Object.fromEntries(g2.schema.metadata),
          `tile ${key(e2)} (${v2Name}) schema metadata`,
        ).toEqual(Object.fromEntries(g1.schema.metadata));
        // Field-level metadata: per-field stt:qa (v1 JSON shape) plus the
        // GeoArrow extension / stt:quant tags. Everything compares
        // byte-exact EXCEPT the stt:qa affine numbers: the v2 wire's
        // canonical-JSON floats sit ~1 ulp off the v1 strings' doubles, so
        // Rust's own merge_v2_layer output has the same drift vs the v1
        // fixture — qa compares numerically, same-key-set + same shape.
        const fieldMeta = (t: typeof g1, dropQa: boolean) =>
          Object.fromEntries(
            t.schema.fields.map((f) => {
              const m = Object.fromEntries(f.metadata);
              if (dropQa) delete m['stt:qa'];
              return [f.name, m];
            }),
          );
        expect(
          fieldMeta(g2, true),
          `tile ${key(e2)} (${v2Name}) field metadata`,
        ).toEqual(fieldMeta(g1, true));
        for (const f1 of g1.schema.fields) {
          const qa1 = f1.metadata.get('stt:qa');
          const qa2 = g2.schema.fields
            .find((f) => f.name === f1.name)
            ?.metadata.get('stt:qa');
          expect(
            qa2 === undefined,
            `tile ${key(e2)} field ${f1.name} stt:qa presence`,
          ).toBe(qa1 === undefined);
          if (!qa1 || !qa2) continue;
          const [p1, p2] = [JSON.parse(qa1), JSON.parse(qa2)];
          for (const k of ['o', 's'] as const) {
            const tol = Math.max(Math.abs(p1[k]) * 1e-13, Number.MIN_VALUE);
            expect(
              Math.abs(p2[k] - p1[k]),
              `tile ${key(e2)} field ${f1.name} qa.${k}`,
            ).toBeLessThanOrEqual(tol);
          }
        }
      }
    }
  });

  it('marks v2 features time-sorted (§5.2.3) and leaves v1 unflagged', async () => {
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

    const v1 = openArchive('v2-golden-v1');
    const i1 = await v1.getIndex();
    const e1 = i1.tiles[0];
    const tile1 = await v1.getTile({
      z: e1.zoom,
      x: e1.x,
      y: e1.y,
      t: e1.timeStart,
    });
    expect(tile1!.layers[0].features.timesSorted).toBeUndefined();
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

  it('rejects a formatVersion-1 manifest carrying a schemas table', async () => {
    const archive = withManifest((m) => {
      m.schemas = [{ hash: '0'.repeat(32), data: 'AAAA' }];
    }, 'v2-golden-v1');
    await expect(archive.getMetadata()).rejects.toThrow(
      /must not carry a schemas table/,
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

describe('mixed-version datasets fail loudly (authority rule §5.2)', () => {
  function withManifest(
    mutate: (manifest: any) => void,
    name: string,
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

  it('v1 objects declared as formatVersion 2 → loud STTD-magic error at index load', async () => {
    const archive = withManifest((m) => {
      m.formatVersion = 2;
    }, 'v2-golden-tracks-v1');
    await expect(archive.getIndex()).rejects.toThrow(/missing STTD magic/);
  });

  it('v2 objects declared as formatVersion 1 → loud error (never misparse)', async () => {
    const archive = withManifest((m) => {
      m.formatVersion = 1;
      delete m.schemas; // a v1 manifest may not carry the table at all
    }, 'v2-golden-tracks');
    // The v2 `.sttd` magic prelude is not a valid v1 directory — the open
    // fails loudly at index decode rather than serving garbage entries.
    await expect(archive.getIndex()).rejects.toThrow();
  });
});
