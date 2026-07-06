/**
 * Packed-manifest parse + validation suite.
 *
 * All reader-side manifest validation lives here: the format discriminator,
 * the pack table, folded metadata, the format/directory version gates
 * (conformance reader-MUSTs), and clear errors for malformed or non-packed
 * manifests. Two fixtures feed this: a hand-built minimal single-tile dataset
 * (`buildPackedDataset`) for the parse/error cases, and the transcoded real
 * Rust fixture (`packedFromSingleFile`) for the version-gate cases. The full
 * Rust↔TS decode contract lives in `archive.test.ts` (transcoded fixture) and
 * `packed-golden.test.ts` (real Rust-produced packed dataset).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { encodeDirectory } from '../src/directory';
import { packedFromSingleFile, packedFetch } from './helpers/packed-fixture';
import { bufferToArrayBuffer } from './helpers/fixtures';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url));
const FIXTURE_BYTES = new Uint8Array(readFileSync(FIXTURE));

/**
 * Build a minimal in-memory packed dataset (one tile, one pack, no compression)
 * with an overridable manifest, and a `fetch` shim serving it. The single tile
 * carries a 1-byte raw payload — enough for metadata/index assertions; the
 * tile-decode path is covered elsewhere.
 */
function buildPackedDataset(manifestOverrides: Record<string, unknown> = {}): {
  url: string;
  fetch: typeof fetch;
} {
  const blob = new Uint8Array([0x42]);
  const dir = encodeDirectory([
    {
      zoom: 5, x: 1, y: 2, timeStart: 0, timeEnd: 1,
      packId: 0, offset: 0, length: blob.length, uncompressedSize: blob.length,
      featureCount: 1, hilbert: 0, crc32c: 0,
    },
  ]);
  const objects = new Map<string, Uint8Array>();
  objects.set('packs/p0.sttp', blob);
  objects.set('index/dir.sttd', dir);
  const manifest = {
    format: 'stt-packed',
    formatVersion: 1,
    compression: 'none',
    directory: { key: 'index/dir.sttd', length: dir.length, directoryVersion: 5 },
    packs: [{ key: 'packs/p0.sttp', length: blob.length }],
    metadata: {
      name: 'test',
      bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
      time_range: { start: 0, end: 1 },
      min_zoom: 5,
      max_zoom: 5,
      temporal_bucket_ms: 1000,
    },
    ...manifestOverrides,
  };
  objects.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));

  const url = 'mem://data/test/manifest.json';
  const base = 'mem://data/test/';
  const fetchFn = (async (u: string, init?: RequestInit) => {
    const key = u.startsWith(base) ? u.slice(base.length) : u;
    const bytes = objects.get(key);
    if (!bytes) {
      return { ok: false, status: 404, statusText: 'Not Found', arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => bufferToArrayBuffer(bytes) };
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    return { ok: true, status: 206, statusText: 'Partial Content', arrayBuffer: async () => bufferToArrayBuffer(slice) };
  }) as unknown as typeof fetch;
  return { url, fetch: fetchFn };
}

describe('packed-format manifest', () => {
  it('parses a packed manifest and folds the metadata in', async () => {
    const { url, fetch } = buildPackedDataset();
    const archive = new STTArchive({ url, fetch });
    const meta = await archive.getMetadata();
    expect(meta.name).toBe('test');
    // `version` surfaces the manifest schema version (formatVersion).
    expect(meta.version).toBe(1);
    expect(meta.minZoom).toBe(5);
    expect(meta.temporalBucketMs).toBe(1000);
  });

  it('exposes pack ids on the decoded directory', async () => {
    const { url, fetch } = buildPackedDataset();
    const archive = new STTArchive({ url, fetch });
    const index = await archive.getIndex();
    expect(index.tiles.length).toBe(1);
    expect(index.tiles[0].packId).toBe(0);
  });

  it('rejects a manifest whose format is not stt-packed', async () => {
    const { url, fetch } = buildPackedDataset({ format: 'something-else' });
    const archive = new STTArchive({ url, fetch });
    await expect(archive.getMetadata()).rejects.toThrow(/packed manifest/i);
  });

  it('rejects a manifest that is not valid JSON', async () => {
    // Serve raw non-JSON bytes for manifest.json.
    const url = 'mem://data/bad/manifest.json';
    const fetchFn = (async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bufferToArrayBuffer(new Uint8Array([0x53, 0x54, 0x54, 0x04])),
      };
    }) as unknown as typeof fetch;
    const archive = new STTArchive({ url, fetch: fetchFn });
    await expect(archive.getMetadata()).rejects.toThrow(/manifest/i);
  });

  it('rejects a manifest missing the directory pointer or pack table', async () => {
    const { url, fetch } = buildPackedDataset({ directory: undefined, packs: undefined });
    const archive = new STTArchive({ url, fetch });
    await expect(archive.getMetadata()).rejects.toThrow(/directory pointer or pack table/i);
  });

  it('rejects a tile that references a non-existent pack', async () => {
    // A directory entry referencing packId 5 with only one pack present.
    const blob = new Uint8Array([0x42]);
    const dir = encodeDirectory([
      {
        zoom: 5, x: 1, y: 2, timeStart: 0, timeEnd: 1,
        packId: 5, offset: 0, length: blob.length, uncompressedSize: blob.length,
        featureCount: 1, hilbert: 0, crc32c: 0,
      },
    ]);
    const objects = new Map<string, Uint8Array>();
    objects.set('packs/p0.sttp', blob);
    objects.set('index/dir.sttd', dir);
    objects.set(
      'manifest.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 'stt-packed',
          formatVersion: 1,
          compression: 'none',
          directory: { key: 'index/dir.sttd', length: dir.length, directoryVersion: 5 },
          packs: [{ key: 'packs/p0.sttp', length: blob.length }],
          metadata: { name: 't', min_zoom: 5, max_zoom: 5, temporal_bucket_ms: 1000 },
        }),
      ),
    );
    const base = 'mem://data/badpack/';
    const fetchFn = (async (u: string, init?: RequestInit) => {
      const key = u.startsWith(base) ? u.slice(base.length) : u;
      const bytes = objects.get(key)!;
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
      if (!m) return { ok: true, status: 200, arrayBuffer: async () => bufferToArrayBuffer(bytes) };
      const slice = bytes.subarray(Number(m[1]), Math.min(Number(m[2]), bytes.length - 1) + 1);
      return { ok: true, status: 206, arrayBuffer: async () => bufferToArrayBuffer(slice) };
    }) as unknown as typeof fetch;
    const archive = new STTArchive({ url: base + 'manifest.json', fetch: fetchFn });
    const index = await archive.getIndex();
    const e = index.tiles[0];
    await expect(
      archive.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart }),
    ).rejects.toThrow(/pack 5/);
  });
});

describe('manifest version gates (conformance reader-MUST)', () => {
  /** The fixture dataset with its manifest JSON rewritten through `mutate`. */
  function datasetWithManifest(mutate: (manifest: any) => void): STTArchive {
    const dataset = packedFromSingleFile(FIXTURE_BYTES);
    const manifest = JSON.parse(
      new TextDecoder().decode(dataset.objects.get('manifest.json')!),
    );
    mutate(manifest);
    dataset.objects.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    return new STTArchive({ url: dataset.manifestUrl, fetch: packedFetch(dataset) });
  }

  it('rejects an unrecognized format', async () => {
    const archive = datasetWithManifest((m) => {
      m.format = 'stt-packed-v2';
    });
    await expect(archive.getMetadata()).rejects.toThrow(/not a packed manifest/);
  });

  it('rejects an unrecognized formatVersion', async () => {
    // 2 is now implemented (packed v2, spec §5.2) — the gate moves to 3.
    const archive = datasetWithManifest((m) => {
      m.formatVersion = 3;
    });
    await expect(archive.getMetadata()).rejects.toThrow(/unsupported formatVersion 3/);
  });

  it('rejects a missing formatVersion', async () => {
    const archive = datasetWithManifest((m) => {
      delete m.formatVersion;
    });
    await expect(archive.getMetadata()).rejects.toThrow(/unsupported formatVersion/);
  });

  it('rejects an unrecognized directoryVersion', async () => {
    const archive = datasetWithManifest((m) => {
      m.directory.directoryVersion = 4;
    });
    await expect(archive.getIndex()).rejects.toThrow(/unsupported directoryVersion 4/);
  });

  it('rejects a missing directoryVersion', async () => {
    const archive = datasetWithManifest((m) => {
      delete m.directory.directoryVersion;
    });
    await expect(archive.getIndex()).rejects.toThrow(/unsupported directoryVersion/);
  });

  it('rejects a manifest declaring a capability this reader does not implement', async () => {
    // Only the UNKNOWN entry is named — coord-quant is implemented. A
    // capability re-types existing columns, so proceeding would silently
    // misdecode; conformance requires the loud refusal at open.
    const archive = datasetWithManifest((m) => {
      m.capabilities = ['coord-quant', 'from-the-future'];
    });
    await expect(archive.getMetadata()).rejects.toThrow(
      /capabilities this reader does not implement: from-the-future \(/,
    );
  });

  it('accepts a manifest declaring only implemented capabilities', async () => {
    const archive = datasetWithManifest((m) => {
      m.capabilities = ['coord-quant', 'attr-quant', 'elevation-fold'];
    });
    const meta = await archive.getMetadata();
    expect(meta.version).toBe(1);
  });

  it('accepts the golden formatVersion=1 / directoryVersion=5 manifest', async () => {
    const archive = datasetWithManifest(() => {});
    const meta = await archive.getMetadata();
    expect(meta.version).toBe(1);
    const index = await archive.getIndex();
    expect(index.tiles.length).toBeGreaterThan(0);
  });
});
