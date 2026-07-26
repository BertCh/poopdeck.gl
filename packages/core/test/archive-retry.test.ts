/**
 * Tests for loader hardening in STTArchive (player buffering WS-E):
 *
 * - transient range-request failures retry with backoff before surfacing;
 * - a coalesced group that still fails after retries falls back to per-tile
 *   fetches (single attempt each) so one bad range can't drop a whole batch;
 * - aborts propagate immediately and are NEVER retried;
 * - completed range responses feed the dual-EWMA throughput estimator.
 *
 * Served from the in-memory packed fixture with a fault-injecting fetch shim.
 */

import { describe, it, expect } from 'vitest';
import { STTArchive } from '../src/archive';
import type { TileId } from '../src/types';
import { packedFromGolden, packedFetch } from './helpers/packed-fixture';

const DATASET = packedFromGolden();

/** Is this request a Range request against a pack object? */
function isPackRange(url: string, init?: RequestInit): boolean {
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  return Boolean(range) && url.includes('packs/');
}

/**
 * Wrap the in-memory dataset fetch so the first `failFirst` pack-range
 * requests fail (HTTP 500 by default, or a thrown AbortError). Counts every
 * pack-range attempt in `counter.attempts`.
 */
function faultyFetch(
  counter: { attempts: number },
  failFirst: number,
  failure: 'http500' | 'abort' = 'http500',
): typeof fetch {
  const inner = packedFetch(DATASET);
  return (async (url: string, init?: RequestInit) => {
    if (isPackRange(url, init)) {
      counter.attempts++;
      if (counter.attempts <= failFirst) {
        if (failure === 'abort') {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
    }
    return inner(url, init);
  }) as unknown as typeof fetch;
}

/** Archive over the faulty shim with instant (but still real) retries. */
function faultyArchive(
  counter: { attempts: number },
  failFirst: number,
  failure: 'http500' | 'abort' = 'http500',
): STTArchive {
  return new STTArchive({
    url: DATASET.manifestUrl,
    fetch: faultyFetch(counter, failFirst, failure),
    retryDelaysMs: [0, 0], // keep the 2-retry semantics, skip the waiting
  });
}

/** Every tile id in the fixture's directory. */
async function allTileIds(archive: STTArchive): Promise<TileId[]> {
  const index = await archive.getIndex();
  return index.tiles.map((e) => ({
    z: e.zoom,
    x: e.x,
    y: e.y,
    t: e.timeStart,
  }));
}

describe('STTArchive range-request retry (WS-E)', () => {
  it('retries a transient failure and succeeds (failure → backoff → success)', async () => {
    const counter = { attempts: 0 };
    const archive = faultyArchive(counter, 2); // 2 failures, 3rd attempt OK
    const ids = await allTileIds(archive);
    expect(ids.length).toBeGreaterThan(0);

    const tiles = await archive.getTiles(ids);
    expect(tiles.length).toBe(ids.length);
    expect(tiles.every((t) => t !== null)).toBe(true);
    // The tiny fixture coalesces into ONE group: initial attempt + 2 retries.
    expect(counter.attempts).toBe(3);
  });

  it('feeds the throughput estimator from completed range responses', async () => {
    const counter = { attempts: 0 };
    const archive = faultyArchive(counter, 0); // healthy
    expect(archive.getThroughputEstimate()).toEqual({
      bytesPerMs: null,
      samples: 0,
    });

    await archive.getTiles(await allTileIds(archive));
    const estimate = archive.getThroughputEstimate();
    expect(estimate.samples).toBeGreaterThanOrEqual(1);
    expect(estimate.bytesPerMs).toBeGreaterThan(0);
  });

  it('falls back to per-tile fetches when the coalesced group exhausts retries', async () => {
    const counter = { attempts: 0 };
    const archive = faultyArchive(counter, 3); // group fails all 3 attempts
    const ids = await allTileIds(archive);

    const tiles = await archive.getTiles(ids);
    // Every tile still arrives — via individual member fetches.
    expect(tiles.every((t) => t !== null)).toBe(true);
    // 3 failed group attempts + one single-attempt fetch per member.
    expect(counter.attempts).toBe(3 + ids.length);
  });

  it('resolves (nulls, no throw) when even the per-tile fallback fails', async () => {
    const counter = { attempts: 0 };
    const archive = faultyArchive(counter, Number.MAX_SAFE_INTEGER);
    const ids = await allTileIds(archive);

    // A dead host degrades to "tiles missing", not a rejected batch — the
    // tileset surfaces per-tile errors for directory-known tiles itself.
    const tiles = await archive.getTiles(ids);
    expect(tiles.every((t) => t === null)).toBe(true);
    // Group attempts (3) then exactly ONE fallback attempt per member.
    expect(counter.attempts).toBe(3 + ids.length);
  });

  it('propagates aborts immediately — never retried', async () => {
    const counter = { attempts: 0 };
    const archive = faultyArchive(counter, Number.MAX_SAFE_INTEGER, 'abort');
    const ids = await allTileIds(archive);

    await expect(archive.getTiles(ids)).rejects.toMatchObject({
      name: 'AbortError',
    });
    // ONE attempt: no backoff retries, no per-tile fallback after an abort.
    expect(counter.attempts).toBe(1);
  });

  it('retries the single-tile getTile path too', async () => {
    const counter = { attempts: 0 };
    const archive = faultyArchive(counter, 2);
    const ids = await allTileIds(archive);

    const tile = await archive.getTile(ids[0]);
    expect(tile).not.toBeNull();
    expect(counter.attempts).toBe(3);
  });
});
