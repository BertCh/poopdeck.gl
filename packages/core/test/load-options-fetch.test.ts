/**
 * `loadOptions.fetch` wiring (deck.gl ecosystem audit item 7).
 *
 * The deck.gl layer always passed `loadOptions` into STTArchive, but the
 * reader never consumed it. These tests lock in the loaders.gl convention:
 *
 * - OBJECT form: a RequestInit merged into EVERY request the archive makes
 *   (manifest, directory, pack ranges), with per-request fields — notably
 *   the Range header — always winning;
 * - FUNCTION form: a drop-in transport, with the explicitly-typed
 *   `options.fetch` taking precedence when both are set.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import type { TileId } from '../src/types';
import { packedFromSingleFile, packedFetch } from './helpers/packed-fixture';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/sample.stt', import.meta.url),
);
const DATASET = packedFromSingleFile(new Uint8Array(readFileSync(FIXTURE)));

interface LoggedRequest {
  url: string;
  init?: RequestInit;
}

/** The in-memory dataset fetch, recording every (url, init) it receives. */
function recordingFetch(log: LoggedRequest[]): typeof fetch {
  const inner = packedFetch(DATASET);
  return (async (url: string, init?: RequestInit) => {
    log.push({ url, init });
    return inner(url, init);
  }) as unknown as typeof fetch;
}

function headersOf(req: LoggedRequest): Record<string, string> {
  return (req.init?.headers as Record<string, string>) ?? {};
}

async function firstTileId(archive: STTArchive): Promise<TileId> {
  const index = await archive.getIndex();
  const e = index.tiles[0];
  return { z: e.zoom, x: e.x, y: e.y, t: e.timeStart };
}

describe('loadOptions.fetch — object (RequestInit) form', () => {
  it('merges headers + credentials into manifest, directory AND pack-range requests', async () => {
    const log: LoggedRequest[] = [];
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: recordingFetch(log),
      loadOptions: {
        fetch: {
          headers: { 'X-Stt-Auth': 'token-1' },
          credentials: 'include',
        },
      },
    });

    const tile = await archive.getTile(await firstTileId(archive));
    expect(tile).not.toBeNull();

    // Every request the archive made carries the caller's init.
    expect(log.length).toBeGreaterThanOrEqual(3); // manifest, directory, range
    for (const req of log) {
      expect(headersOf(req)['X-Stt-Auth']).toBe('token-1');
      expect(req.init?.credentials).toBe('include');
    }

    // The pack read is still a real Range request (status-206 path works).
    const rangeReq = log.find((r) => headersOf(r).Range);
    expect(rangeReq).toBeDefined();
    expect(headersOf(rangeReq!).Range).toMatch(/^bytes=\d+-\d+$/);
  });

  it('per-request fields win: a caller Range header cannot clobber the reader range math', async () => {
    // A global Range in loadOptions is pathological input — it (correctly)
    // rides every whole-object GET too, which would truncate the manifest.
    // Strip it for non-pack objects in the test shim so the assertion that
    // matters stays observable: on PACK reads the reader's own Range must
    // override the caller's.
    const log: LoggedRequest[] = [];
    const inner = recordingFetch(log);
    const stripWholeGetRange = (async (url: string, init?: RequestInit) => {
      if (!url.includes('packs/')) {
        const headers = { ...(init?.headers as Record<string, string>) };
        delete headers.Range;
        return inner(url, { ...init, headers });
      }
      return inner(url, init);
    }) as unknown as typeof fetch;

    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: stripWholeGetRange,
      loadOptions: {
        fetch: { headers: { Range: 'bytes=0-0', 'X-Stt-Auth': 'a' } },
      },
    });

    const tile = await archive.getTile(await firstTileId(archive));
    // The tile decoded — proof the real per-request Range reached the wire
    // (a bytes=0-0 read could never produce a decodable payload).
    expect(tile).not.toBeNull();
    const packReqs = log.filter((r) => r.url.includes('packs/'));
    expect(packReqs.length).toBeGreaterThan(0);
    for (const req of packReqs) {
      expect(headersOf(req).Range).not.toBe('bytes=0-0');
      expect(headersOf(req).Range).toMatch(/^bytes=\d+-\d+$/);
      expect(headersOf(req)['X-Stt-Auth']).toBe('a');
    }
  });
});

describe('loadOptions.fetch — function form', () => {
  it('is used as the transport when options.fetch is absent', async () => {
    const log: LoggedRequest[] = [];
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      loadOptions: { fetch: recordingFetch(log) },
    });
    const metadata = await archive.getMetadata();
    expect(metadata).toBeDefined();
    expect(log.length).toBeGreaterThan(0);
  });

  it('yields to an explicitly-typed options.fetch', async () => {
    const used: LoggedRequest[] = [];
    const ignored: LoggedRequest[] = [];
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: recordingFetch(used),
      loadOptions: { fetch: recordingFetch(ignored) },
    });
    await archive.getMetadata();
    expect(used.length).toBeGreaterThan(0);
    expect(ignored.length).toBe(0);
  });
});
