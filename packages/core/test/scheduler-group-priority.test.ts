/**
 * Coalesced range-groups are DISPATCHED in priority order, not pack order
 * (docs/roadmap/tile-loading-3d-2026-07.md Wave 1, F10).
 *
 * Above `maxConcurrentRequests` the archive's runner loop pulls groups from a
 * cursor and waits for each to settle, so only that many groups are ever queued
 * on the shared scheduler at once — and the scheduler can only rank what is
 * queued. Pulling in pack/byte order therefore truncates the cross-source EDF
 * term ITSELF (not merely the sub-unit spatial tie-break, which
 * `spatial-scheduler-tiebreak.test.ts` covers with three entirely sub-cap
 * tiles): the bucket the play-head reaches next waits behind every group that
 * happens to sit earlier in the pack.
 *
 * Byte adjacency is exploited INSIDE a group — that is what coalescing is — so
 * the order of the groups carries no coalescing benefit and ranking them is
 * free. What must NOT change is the no-play-head case: page fetches and
 * play-head-less tile batches rank by their enqueue sequence, so a stable sort
 * has to leave them in byte order exactly as before.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { STTArchive } from '../src/archive';
import {
  packedFromGolden,
  OBJECT_MAGIC_LEN,
  directoryKey,
  directoryObject,
  packKey,
  packObject,
  packedFetch,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';
import { crc32c } from '../src/crc32c';
import { decodeDirectory, encodeDirectory } from '../src/directory';
import {
  configureSharedScheduler,
  resetSharedScheduler,
} from '../src/shared-scheduler';

/** One real, decodable blob + real metadata from the committed golden fixture. */
function fixtureBlobAndMeta(): {
  blob: Uint8Array;
  meta: any;
  entry: any;
} {
  const ds = packedFromGolden();
  const manifest = JSON.parse(
    new TextDecoder().decode(ds.objects.get('manifest.json')!),
  );
  const entries = decodeDirectory(
    ds.objects.get(manifest.directory.key)!.subarray(OBJECT_MAGIC_LEN),
  );
  const first = entries[0];
  const pack = ds.objects.get(manifest.packs[first.packId].key)!;
  return {
    blob: pack.subarray(first.offset, first.offset + first.length),
    meta: manifest.metadata,
    entry: first,
  };
}

let seq = 0;

/**
 * One tile per bucket, each in its OWN pack — so with `coalesceGapBytes: 0`
 * every tile is its own range-group and the pack key in the fetch URL names
 * which group dispatched.
 */
function makeDataset(
  buckets: number[],
  blob: Uint8Array,
  meta: any,
  template: any,
): InMemoryPackedDataset {
  const objects = new Map<string, Uint8Array>();
  const packRefs: Array<{ key: string; length: number }> = [];
  const entries = buckets.map((timeStart, i) => {
    const { bytes: basePack } = packObject([blob]);
    const bytes = new Uint8Array(basePack.length + 1);
    bytes.set(basePack);
    bytes[basePack.length] = i;
    const key = packKey(bytes);
    objects.set(key, bytes);
    packRefs.push({ key, length: bytes.length });
    return {
      zoom: 8,
      x: 128,
      y: 100,
      timeStart,
      timeEnd: timeStart + 1000,
      packId: i,
      offset: OBJECT_MAGIC_LEN,
      length: blob.length,
      uncompressedSize: template.uncompressedSize,
      featureCount: template.featureCount,
      hilbert: i,
      crc32c: crc32c(blob),
    };
  });
  const dirObject = directoryObject(encodeDirectory(entries));
  const dKey = directoryKey(dirObject);
  objects.set(dKey, dirObject);
  objects.set(
    'manifest.json',
    new TextEncoder().encode(
      JSON.stringify({
        format: 'stt-packed',
        formatVersion: 3,
        variants: [{ id: 0, kind: 'raw' }],
        compression: 'zstd',
        directory: {
          key: dKey,
          length: dirObject.length,
          directoryVersion: 6,
        },
        packs: packRefs,
        metadata: meta,
      }),
    ),
  );
  return { objects, manifestUrl: `mem://group-order-${seq++}/manifest.json` };
}

/** `packedFetch`, plus a trace of which pack each RANGE request addressed. */
function tracingFetch(
  ds: InMemoryPackedDataset,
  dispatched: string[],
): typeof fetch {
  const inner = packedFetch(ds);
  const manifest = JSON.parse(
    new TextDecoder().decode(ds.objects.get('manifest.json')!),
  );
  const labels = new Map<string, string>(
    manifest.packs.map((p: { key: string }, i: number) => [
      p.key,
      `packs/t${BUCKETS[i]}.sttp`,
    ]),
  );
  const slash = ds.manifestUrl.lastIndexOf('/');
  const base = ds.manifestUrl.slice(0, slash + 1);
  return (async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers?.Range) {
      const key = url.startsWith(base) ? url.slice(base.length) : url;
      dispatched.push(labels.get(key) ?? key);
    }
    return inner(url as never, init as never);
  }) as unknown as typeof fetch;
}

/**
 * Buckets in PACK order. The one nearest the play-head is deliberately LAST in
 * the pack, in the request array, and in every byte-order tie-break — so only
 * a genuine priority sort can put it first.
 */
const BUCKETS = [4000, 3000, 2000, 1000];

async function dispatchOrder(
  options: Parameters<STTArchive['getTiles']>[1],
): Promise<string[]> {
  const { blob, meta, entry } = fixtureBlobAndMeta();
  const ds = makeDataset(BUCKETS, blob, meta, entry);
  const dispatched: string[] = [];
  const archive = new STTArchive({
    url: ds.manifestUrl,
    fetch: tracingFetch(ds, dispatched),
    coalesceGapBytes: 0,
    // Below the group count, so the runner loop — not the plain
    // `Promise.all` fast path — is what schedules them.
    maxConcurrentRequests: 1,
  });
  const tiles = await archive.getTiles(
    BUCKETS.map((t) => ({ z: 8, x: 128, y: 100, t })),
    options,
  );
  expect(tiles.every((t) => t !== null)).toBe(true);
  return dispatched;
}

describe('coalesced group dispatch order above the per-archive cap', () => {
  beforeEach(() => resetSharedScheduler());
  afterEach(() => resetSharedScheduler());

  it('fetches the bucket nearest the play-head FIRST', async () => {
    // A budget above the group count so the per-archive cap of 1 is the only
    // thing serialising these — i.e. the runner's pull order IS the trace.
    configureSharedScheduler({ maxRequests: 8 });
    const order = await dispatchOrder({ playheadTime: 0 });
    expect(order).toEqual([
      'packs/t1000.sttp',
      'packs/t2000.sttp',
      'packs/t3000.sttp',
      'packs/t4000.sttp',
    ]);
  });

  it('keeps byte order when no play-head is threaded in', async () => {
    // Without a play-head the priority IS the enqueue sequence, so a stable
    // sort must be a no-op here — this is the case every directory-page fetch
    // takes, where byte order is exactly what should be preserved.
    configureSharedScheduler({ maxRequests: 8 });
    const order = await dispatchOrder(undefined);
    expect(order).toEqual([
      'packs/t4000.sttp',
      'packs/t3000.sttp',
      'packs/t2000.sttp',
      'packs/t1000.sttp',
    ]);
  });

  it('B3: the bucket CONTAINING the play-head ranks first, then the future, then the past', async () => {
    // The play-head is at 2500, inside the [2000, 3000] bucket, travelling
    // forward: that bucket is the frame being drawn (distance 0), 3000 and
    // 4000 are imminent, and only 1000 has been passed — pushed behind
    // everything by `minDistanceToPlayhead`'s BEHIND_OFFSET. Keying the
    // distance on `timeStart` alone used to rank the containing bucket as
    // "already passed", behind the frame 30 s away (audit B3 / NS-7).
    configureSharedScheduler({ maxRequests: 8 });
    const order = await dispatchOrder({
      playheadTime: 2500,
      playheadDirection: 1,
    });
    expect(order).toEqual([
      'packs/t2000.sttp',
      'packs/t3000.sttp',
      'packs/t4000.sttp',
      'packs/t1000.sttp',
    ]);
  });

  it('B3: the same holds travelling backward — containing bucket, then the past, then the future', async () => {
    configureSharedScheduler({ maxRequests: 8 });
    const order = await dispatchOrder({
      playheadTime: 2500,
      playheadDirection: -1,
    });
    expect(order).toEqual([
      'packs/t2000.sttp',
      'packs/t1000.sttp',
      'packs/t3000.sttp',
      'packs/t4000.sttp',
    ]);
  });
});
