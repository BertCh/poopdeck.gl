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
import { STTArchive } from '../src/archive';
import { decodeDirectory, encodeDirectory } from '../src/directory';
import { InlineTileDecoder, type DecodeArgs } from '../src/tile-decoder';
import type { Tile, TileId } from '../src/types';
import {
  OBJECT_MAGIC_LEN,
  directoryKey,
  directoryObject,
  packKey,
  packObject,
  packedFromGolden,
  packedFetch,
} from './helpers/packed-fixture';
import type { InMemoryPackedDataset } from './helpers/packed-fixture';

const BASE = packedFromGolden();

/**
 * Derive a two-tile / two-pack dataset from the transcoded fixture: tile B is
 * tile A's blob byte-for-byte, registered at x+1 in its own pack object.
 */
function twoPackDataset(): {
  ds: InMemoryPackedDataset;
  idA: TileId;
  idB: TileId;
} {
  const manifest = JSON.parse(
    new TextDecoder().decode(BASE.objects.get('manifest.json')!),
  );
  const entries = decodeDirectory(
    BASE.objects.get(manifest.directory.key)!.subarray(OBJECT_MAGIC_LEN),
  );
  // Any single entry will do — this fixture only needs one real blob to
  // duplicate into a second pack.
  const src = entries[0];
  const srcPack = BASE.objects.get(manifest.packs[src.packId].key)!;
  const blob = srcPack.subarray(src.offset, src.offset + src.length);

  // Two single-blob pack objects, each with its own STTP prelude, so both
  // entries sit at the same object-absolute offset.
  const { bytes: packA, offsets: offA } = packObject([blob]);
  const { bytes: basePackB } = packObject([blob]);
  const packB = new Uint8Array(basePackB.length + 1);
  packB.set(basePackB);
  packB[basePackB.length] = 1;
  const a = { ...src, packId: 0, offset: offA[0] };
  const b = { ...a, x: a.x + 1, packId: 1 };
  const dir = directoryObject(encodeDirectory([a, b]));

  const objects = new Map<string, Uint8Array>();
  const pKeyA = packKey(packA);
  const pKeyB = packKey(packB);
  const dKey = directoryKey(dir);
  objects.set(pKeyA, packA);
  objects.set(pKeyB, packB);
  objects.set(dKey, dir);
  objects.set(
    'manifest.json',
    new TextEncoder().encode(
      JSON.stringify({
        ...manifest,
        directory: {
          ...manifest.directory,
          key: dKey,
          length: dir.length,
        },
        packs: [
          { key: pKeyA, length: packA.length },
          { key: pKeyB, length: packB.length },
        ],
      }),
    ),
  );

  const toId = (e: typeof a): TileId => ({
    z: e.zoom,
    x: e.x,
    y: e.y,
    t: e.timeStart,
  });
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
    const manifest = JSON.parse(
      new TextDecoder().decode(ds.objects.get('manifest.json')!),
    );
    const gatedPackKey = manifest.packs[1].key;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const gatedFetch: typeof fetch = (async (
      url: string,
      init?: RequestInit,
    ) => {
      if (url.includes(gatedPackKey)) await gate;
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

/**
 * M6 / BH-5 — the archive threads the fetch stage's scheduler priority into
 * every decode, so the decode pool orders by the same scale the network stage
 * selected on instead of by arrival.
 *
 * This pins the ARCHIVE end of the seam: what value reaches `DecodeArgs`. The
 * pool's behaviour ON those values (priority order, SJF tie-break) is pinned in
 * `tile-decoder.test.ts`; in Node there is no `Worker`, so the archive's own
 * decoder is the inline one and has no queue to observe.
 */
describe('STTArchive decode-priority continuity (M6 / BH-5)', () => {
  /** Wraps the real inline decoder and records the priority it was handed. */
  class RecordingDecoder extends InlineTileDecoder {
    readonly seen: Array<{ z: number; priority: number | undefined }> = [];
    decode(args: DecodeArgs): Promise<Tile> {
      this.seen.push({ z: args.id.z, priority: args.priority });
      return super.decode(args);
    }
  }

  const collectPriorities = async (
    fetchPriority?: 'high' | 'low' | 'auto',
  ): Promise<Array<number | undefined>> => {
    const { ds, idA, idB } = twoPackDataset();
    const decoder = new RecordingDecoder();
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
      decoder,
    });
    const tiles = await archive.getTiles([idA, idB], { fetchPriority });
    expect(tiles.every((t) => t !== null)).toBe(true);
    return decoder.seen.map((s) => s.priority);
  };

  it('hands every network-path decode a finite priority (never undefined)', async () => {
    const priorities = await collectPriorities();
    expect(priorities).toHaveLength(2);
    for (const p of priorities) {
      expect(typeof p).toBe('number');
      expect(Number.isFinite(p as number)).toBe(true);
    }
  });

  it('prefetch-tier decodes carry a strictly LESS urgent priority than normal-tier ones', async () => {
    // Lower value = more urgent (Cesium semantics). The archive's tier base is
    // what separates the classes, so a saturated decode pool serves the
    // play-head's tiles before the prefetch runway's — the continuity the FIFO
    // queue used to throw away.
    const normal = (await collectPriorities()) as number[];
    const prefetch = (await collectPriorities('low')) as number[];
    expect(Math.max(...normal)).toBeLessThan(Math.min(...prefetch));
  });
});
