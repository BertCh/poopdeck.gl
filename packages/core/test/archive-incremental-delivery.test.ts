/**
 * `STTArchive.getTiles` incremental delivery: each tile is handed to
 * `onTileReady` the moment ITS coalesced range group decodes — a fast group
 * must not wait for the batch's slowest range request to settle.
 *
 * Served from a two-pack dataset derived from the real Rust-built fixture:
 * the fixture's single tile is duplicated (shifted x, second pack object), so
 * one batch produces TWO range groups whose fetches can be gated
 * independently while still exercising the real decode path.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { decodeDirectory, encodeDirectory } from '../src/directory';
import type { Tile, TileId } from '../src/types';
import { packedFromSingleFile, packedFetch } from './helpers/packed-fixture';
import type { InMemoryPackedDataset } from './helpers/packed-fixture';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url));
const BASE = packedFromSingleFile(new Uint8Array(readFileSync(FIXTURE)));

/**
 * Derive a two-tile / two-pack dataset from the transcoded fixture: tile B is
 * tile A's blob byte-for-byte, registered at x+1 in its own pack object.
 */
function twoPackDataset(): { ds: InMemoryPackedDataset; idA: TileId; idB: TileId } {
  const manifest = JSON.parse(
    new TextDecoder().decode(BASE.objects.get('manifest.json')!),
  );
  const entries = decodeDirectory(BASE.objects.get(manifest.directory.key)!);
  expect(entries.length).toBe(1);
  const a = entries[0];
  const packBytes = BASE.objects.get(manifest.packs[a.packId].key)!;
  const blob = packBytes.subarray(a.offset, a.offset + a.length);

  const b = { ...a, x: a.x + 1, packId: 1, offset: 0 };
  const dir = encodeDirectory([a, b]);

  const objects = new Map<string, Uint8Array>();
  objects.set('packs/pack-a.sttp', packBytes);
  objects.set('packs/pack-b.sttp', blob);
  objects.set('index/directory.sttd', dir);
  objects.set(
    'manifest.json',
    new TextEncoder().encode(
      JSON.stringify({
        ...manifest,
        directory: { ...manifest.directory, key: 'index/directory.sttd', length: dir.length },
        packs: [
          { key: 'packs/pack-a.sttp', length: packBytes.length },
          { key: 'packs/pack-b.sttp', length: blob.length },
        ],
      }),
    ),
  );

  const toId = (e: typeof a): TileId => ({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
  return {
    ds: { objects, manifestUrl: BASE.manifestUrl },
    idA: toId(a),
    idB: toId(b),
  };
}

describe('STTArchive.getTiles incremental delivery', () => {
  it('delivers the fast range group via onTileReady before the gated group settles', async () => {
    const { ds, idA, idB } = twoPackDataset();
    const base = packedFetch(ds);
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const gatedFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('packs/pack-b')) await gate;
      return base(url, init);
    }) as typeof fetch;

    const archive = new STTArchive({ url: ds.manifestUrl, fetch: gatedFetch });

    const ready = vi.fn<[number, Tile], void>();
    let settled = false;
    const batch = archive
      .getTiles([idA, idB], { onTileReady: (i, t) => ready(i, t) })
      .then((tiles) => {
        settled = true;
        return tiles;
      });

    // Pack A's range group lands and decodes while pack B is still gated.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0]).toBe(0); // index into the input ids

    releaseGate();
    const tiles = await batch;

    // Every non-null result was delivered exactly once, same object identity.
    expect(tiles[0]).not.toBeNull();
    expect(tiles[1]).not.toBeNull();
    expect(ready).toHaveBeenCalledTimes(2);
    expect(ready.mock.calls[0][1]).toBe(tiles[0]);
    const second = ready.mock.calls.find((c) => c[0] === 1)!;
    expect(second[1]).toBe(tiles[1]);
  });
});
