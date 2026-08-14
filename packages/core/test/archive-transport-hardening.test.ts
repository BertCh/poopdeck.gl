/**
 * Transport-hardening tests for STTArchive:
 *
 * - per-transfer stall timeout (`transferTimeoutMs`): a TCP-stalled response
 *   aborts with a `TimeoutError` and is retried as a TRANSIENT failure,
 *   while caller aborts still propagate immediately;
 * - manifest + directory GETs ride the same jittered retry/backoff as pack
 *   range requests (they were single-attempt single points of failure);
 * - 206 response validation: a truncated body or mismatched `Content-Range`
 *   is a retryable failure, not silent corruption — same for a directory
 *   whose byte length disagrees with the manifest's `directory.length`;
 * - throughput sampling at busy-window granularity (one sample per window of
 *   overlapping transfers, not one per request — the concurrent pool made
 *   per-request samples each see ~link/N);
 * - failure-aware estimation: retry-path failures feed pessimistic samples
 *   so `getThroughputEstimate()` can't hold a stale optimistic rate on a
 *   dead network.
 *
 * Served from the in-memory packed fixture with fault-injecting fetch shims.
 */

import { describe, it, expect } from 'vitest';
import { STTArchive } from '../src/archive';
import type { TileId } from '../src/types';
import {
  packedFromGolden,
  packedFetch,
  type PackedFetchLog,
} from './helpers/packed-fixture';

const DATASET = packedFromGolden();

/** Is this request a Range request against a pack object? */
function isPackRange(url: string, init?: RequestInit): boolean {
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  return Boolean(range) && url.includes('packs/');
}

/** A promise that never settles — models a TCP-stalled response. */
function hangForever<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function waitForSignal(
  read: () => AbortSignal | undefined,
): Promise<AbortSignal> {
  for (let i = 0; i < 50; i++) {
    const signal = read();
    if (signal) return signal;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('transport was not reached');
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

describe('STTArchive transfer stall timeout', () => {
  it('aborts a never-resolving pack fetch with a TimeoutError after retries', async () => {
    const counter = { attempts: 0 };
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (isPackRange(url, init)) {
          counter.attempts++;
          return hangForever();
        }
        return inner(url, init);
      }) as unknown as typeof fetch,
      transferTimeoutMs: 25,
      retryDelaysMs: [0, 0],
    });
    const ids = await allTileIds(archive);

    const t0 = Date.now();
    await expect(archive.getTile(ids[0])).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    // Initial attempt + 2 retries, each cut off at the 25 ms watchdog —
    // nowhere near the seconds a real stall would otherwise hang.
    expect(counter.attempts).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('treats the timeout as transient: a stalled first attempt retries and succeeds', async () => {
    const counter = { attempts: 0 };
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (isPackRange(url, init)) {
          counter.attempts++;
          if (counter.attempts === 1) return hangForever();
        }
        return inner(url, init);
      }) as unknown as typeof fetch,
      transferTimeoutMs: 25,
      retryDelaysMs: [0, 0],
    });
    const ids = await allTileIds(archive);

    const tile = await archive.getTile(ids[0]);
    expect(tile).not.toBeNull();
    expect(counter.attempts).toBe(2);
  });

  it('caller abort still propagates immediately through a stalled transfer', async () => {
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (isPackRange(url, init)) return hangForever();
        return inner(url, init);
      }) as unknown as typeof fetch,
      transferTimeoutMs: 60_000, // watchdog far away — the abort must win
      retryDelaysMs: [0, 0],
    });
    const ids = await allTileIds(archive);

    const controller = new AbortController();
    const pending = archive.getTile(ids[0], { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('times out a stalled manifest GET (whole-object reads share the watchdog)', async () => {
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async () => hangForever()) as unknown as typeof fetch,
      transferTimeoutMs: 25,
      retryDelaysMs: [],
    });
    await expect(archive.getMetadata()).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });
});

describe('STTArchive manifest/directory retry (single points of failure)', () => {
  it('retries a transient manifest GET failure', async () => {
    const counter = { attempts: 0 };
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.endsWith('manifest.json')) {
          counter.attempts++;
          if (counter.attempts === 1) {
            return {
              ok: false,
              status: 500,
              statusText: 'Internal Server Error',
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
        }
        return inner(url, init);
      }) as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    const meta = await archive.getMetadata();
    expect(meta).toBeDefined();
    expect(counter.attempts).toBe(2);
  });

  it('retries a transient directory GET failure', async () => {
    const counter = { attempts: 0 };
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.includes('index/')) {
          counter.attempts++;
          if (counter.attempts === 1) {
            return {
              ok: false,
              status: 503,
              statusText: 'Service Unavailable',
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
        }
        return inner(url, init);
      }) as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    const index = await archive.getIndex();
    expect(index.tiles.length).toBeGreaterThan(0);
    expect(counter.attempts).toBe(2);
  });

  it('treats a truncated directory body as retryable, then surfaces it', async () => {
    const counter = { attempts: 0 };
    const inner = packedFetch(DATASET);
    const truncatingFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('index/')) {
        counter.attempts++;
        const whole = await (await inner(url, init)).arrayBuffer();
        // Drop the final byte: length now disagrees with manifest.directory.length.
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          arrayBuffer: async () => whole.slice(0, whole.byteLength - 1),
        };
      }
      return inner(url, init);
    }) as unknown as typeof fetch;
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: truncatingFetch,
      retryDelaysMs: [0, 0],
    });
    await expect(archive.getIndex()).rejects.toThrow(/directory truncated/i);
    // Truncation is transport-level, so all attempts were spent on it.
    expect(counter.attempts).toBe(3);
  });
});

describe('STTArchive 206 response validation', () => {
  it('retries a truncated 206 body and succeeds on the clean response', async () => {
    const counter = { attempts: 0 };
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        const response = await inner(url, init);
        if (isPackRange(url, init)) {
          counter.attempts++;
          if (counter.attempts === 1) {
            const whole = await response.arrayBuffer();
            return {
              ok: true,
              status: 206,
              statusText: 'Partial Content',
              headers: { get: () => null },
              arrayBuffer: async () => whole.slice(0, whole.byteLength - 1),
            };
          }
        }
        return response;
      }) as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    const ids = await allTileIds(archive);
    const tile = await archive.getTile(ids[0]);
    expect(tile).not.toBeNull();
    expect(counter.attempts).toBe(2);
  });

  it('retries a 206 whose Content-Range disagrees with the request', async () => {
    const counter = { attempts: 0 };
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        const response = await inner(url, init);
        if (isPackRange(url, init)) {
          counter.attempts++;
          if (counter.attempts === 1) {
            return {
              ...response,
              headers: {
                get: (n: string) =>
                  n.toLowerCase() === 'content-range'
                    ? 'bytes 999-1999/4000'
                    : null,
              },
            };
          }
        }
        return response;
      }) as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    const ids = await allTileIds(archive);
    const tile = await archive.getTile(ids[0]);
    expect(tile).not.toBeNull();
    expect(counter.attempts).toBe(2);
  });
});

describe('STTArchive throughput sampling', () => {
  it('samples at busy-window granularity, not per request', async () => {
    // Two getTiles batches in flight at once → two overlapping range
    // requests. The estimator must record ONE aggregate sample for the
    // whole busy window (per-request samples would each see ~link/N under
    // concurrency and underestimate the link by ~N×).
    const log: PackedFetchLog = { paths: [], ranges: [] };
    const inner = packedFetch(DATASET, log);
    const delayed = (async (url: string, init?: RequestInit) => {
      const response = await inner(url, init);
      if (isPackRange(url, init)) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return response;
    }) as unknown as typeof fetch;
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: delayed,
    });

    const ids = await allTileIds(archive);
    // Fire the second batch while the first's range request is still in
    // flight (the byte cache only fills once a response lands, so both
    // batches go to the network).
    await Promise.all([archive.getTiles(ids), archive.getTiles(ids)]);
    expect(log.ranges.length).toBe(2); // genuinely concurrent requests
    const estimate = archive.getThroughputEstimate();
    expect(estimate.samples).toBe(1); // ...but ONE aggregate sample
    expect(estimate.bytesPerMs).toBeGreaterThan(0);
  });

  it('decays the estimate when the network dies (failure-aware samples)', async () => {
    let dead = false;
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (dead && isPackRange(url, init)) return hangForever();
        return inner(url, init);
      }) as unknown as typeof fetch,
      transferTimeoutMs: 30,
      retryDelaysMs: [0, 0],
    });
    const ids = await allTileIds(archive);

    // Healthy batch primes the estimator.
    await archive.getTiles(ids);
    const healthy = archive.getThroughputEstimate();
    expect(healthy.bytesPerMs).toBeGreaterThan(0);

    // Network dies: the retry path must feed pessimistic samples instead of
    // leaving the last healthy rate frozen in place.
    dead = true;
    archive.clearCache();
    await expect(archive.getTile(ids[0])).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    const afterDeath = archive.getThroughputEstimate();
    expect(afterDeath.samples).toBeGreaterThan(healthy.samples);
    expect(afterDeath.bytesPerMs!).toBeLessThan(healthy.bytesPerMs!);
  });
});

describe('STTArchive abort-path rejection hygiene', () => {
  it('an already-aborted signal leaks no unhandled rejection from the raced transport', async () => {
    // Models the supersession race: the tileset aborts the controller while
    // the tile path is suspended (awaiting the manifest), so by the time the
    // range fetch is issued the signal is ALREADY aborted. Real fetch still
    // rejects on its own — that rejection must be adopted, not left floating
    // (it surfaced as an "AbortError: signal is aborted without reason"
    // pageerror during the drifters loop browser verify).
    const inner = packedFetch(DATASET);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (isPackRange(url, init)) {
          // Spec-conformant transport: reject asynchronously when the signal
          // is (or becomes) aborted.
          const signal = init?.signal;
          if (signal?.aborted) {
            return new Promise((_, reject) => {
              setTimeout(
                () =>
                  reject(
                    signal.reason ?? new DOMException('aborted', 'AbortError'),
                  ),
                0,
              );
            });
          }
        }
        return inner(url, init);
      }) as unknown as typeof fetch,
      retryDelaysMs: [],
    });
    const ids = await allTileIds(archive);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = new AbortController();
      controller.abort(); // bare abort, exactly like cancelSupersededRequests
      await expect(
        archive.getTiles(ids, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // Let the floating transport rejection (if any) reach the process hook.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('STTArchive lifetime cancellation', () => {
  it('finalize aborts an in-flight manifest fetch and is idempotent', async () => {
    let transportSignal: AbortSignal | undefined;
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (_url: string, init?: RequestInit) => {
        transportSignal = init?.signal ?? undefined;
        return hangForever();
      }) as unknown as typeof fetch,
      transferTimeoutMs: 60_000,
      retryDelaysMs: [1000],
    });

    const pending = archive.getMetadata();
    const signal = await waitForSignal(() => transportSignal);
    expect(signal.aborted).toBe(false);
    archive.finalize();
    archive.finalize();
    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(archive.getMetadata()).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('finalize aborts an in-flight directory fetch', async () => {
    const inner = packedFetch(packedFromGolden());
    let directorySignal: AbortSignal | undefined;
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.includes('index/')) {
          directorySignal = init?.signal ?? undefined;
          return hangForever();
        }
        return inner(url, init);
      }) as unknown as typeof fetch,
      transferTimeoutMs: 60_000,
      retryDelaysMs: [],
    });

    const pending = archive.getIndex();
    const signal = await waitForSignal(() => directorySignal);
    archive.finalize();
    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('composes caller and lifetime signals for pack ranges', async () => {
    const ds = packedFromGolden();
    const inner = packedFetch(ds);
    let rangeSignal: AbortSignal | undefined;
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: (async (url: string, init?: RequestInit) => {
        if (isPackRange(url, init)) {
          rangeSignal = init?.signal ?? undefined;
          return hangForever();
        }
        return inner(url, init);
      }) as unknown as typeof fetch,
      transferTimeoutMs: 60_000,
      retryDelaysMs: [],
    });
    const ids = await allTileIds(archive);
    const caller = new AbortController();
    const pending = archive.getTile(ids[0], { signal: caller.signal });
    const signal = await waitForSignal(() => rangeSignal);
    expect(signal).not.toBe(caller.signal);
    expect(signal.aborted).toBe(false);
    archive.finalize();
    expect(caller.signal.aborted).toBe(false);
    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
