/**
 * Spatial tie-break in the shared request scheduler's tile priority
 * (MapLibre-inspired perf research 2026-07): among coalesced range-groups
 * already tied on cross-source EDF distance-to-playhead, the one nearest the
 * viewport center dispatches first (mirrors MapLibre's `coveringTiles()`
 * sorting ideal tiles by `distanceSq` from the camera-projected center). See
 * `groupSchedulerPriority` / `minDistanceToViewportCenter` in archive.ts.
 *
 * Three tiles at the SAME zoom and the SAME `timeStart` (so
 * `minDistanceToPlayhead` ties for all of them — a genuine EDF tie, not just
 * "no playhead threaded in") sit side by side on the x axis. `viewportCenter`
 * is set to the MIDDLE tile's geographic center, and the middle tile is
 * placed LAST in both the request array and the pack layout — so under the
 * pre-existing enqueue-order/byte-order tie-break it would dispatch LAST, not
 * first. With a single global concurrency slot, the scheduler can only ever
 * dispatch one range-group at a time, so `dispatchOrder`'s first entry
 * unambiguously reveals which tile actually won the tie.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { crc32c } from '../src/crc32c';
import { encodeDirectory } from '../src/directory';
import {
  configureSharedScheduler,
  resetSharedScheduler,
} from '../src/shared-scheduler';
import { bufferToArrayBuffer, flush } from './helpers/fixtures';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url));
const FIXTURE_BYTES = new Uint8Array(readFileSync(FIXTURE));

/**
 * Pull the fixture's first decodable blob + its metadata once, by parsing the
 * v4 header/directory directly (same offsets shared-scheduler-archive.test.ts
 * uses) — this test only needs ONE real decodable blob to reuse across
 * synthetic tiles, not the fixture's own tile layout.
 */
async function fixtureBlobAndMeta(): Promise<{ blob: Uint8Array; meta: any; e: any }> {
  const hv = new DataView(bufferToArrayBuffer(FIXTURE_BYTES));
  const indexOffset = Number(hv.getBigUint64(6, true));
  const indexLength = Number(hv.getBigUint64(14, true));
  const metaOff = Number(hv.getBigUint64(22, true));
  const metaLen = Number(hv.getBigUint64(30, true));
  const meta = JSON.parse(
    new TextDecoder().decode(FIXTURE_BYTES.subarray(metaOff, metaOff + metaLen)),
  );
  // Decode just enough of the v4 directory to grab one entry's (offset, length,
  // zoom, featureCount, uncompressedSize) — reuse the blob at that slice.
  const dir = FIXTURE_BYTES.subarray(indexOffset, indexOffset + indexLength);
  let pos = 0;
  const uvarint = (): bigint => {
    let r = 0n, s = 0n;
    for (;;) {
      const b = dir[pos++];
      r |= BigInt(b & 0x7f) << s;
      if ((b & 0x80) === 0) break;
      s += 7n;
    }
    return r;
  };
  const ivarint = (): bigint => {
    const v = uvarint();
    return (v >> 1n) ^ -(v & 1n);
  };
  const version = dir[pos++];
  if (version !== 4) throw new Error('expected v4 fixture directory');
  const n = Number(uvarint());
  const runCount = Number(uvarint());
  let pz = 0n, ph = 0n, px = 0n, py = 0n, pt = 0n;
  const keys: Array<{ zoom: number; featureCount: number }> = new Array(n);
  for (let i = 0; i < n; i++) {
    pz += ivarint(); ph += ivarint(); px += ivarint(); py += ivarint(); pt += ivarint();
    ivarint(); // duration
    const fc = Number(uvarint());
    const bp = uvarint();
    if (bp !== 0n) uvarint(); // temporalBucketMs
    keys[i] = { zoom: Number(pz), featureCount: fc };
  }
  let cursor = 0;
  let expected = 0n;
  let first: { offset: number; length: number; uncompressedSize: number; zoom: number; featureCount: number } | null = null;
  for (let r = 0; r < runCount; r++) {
    const runLen = Number(uvarint());
    const offFlag = uvarint();
    const offset = offFlag === 0n ? expected : uvarint();
    const length = Number(uvarint());
    const unc = Number(uvarint());
    pos += 4; // crc32c
    for (let k = 0; k < runLen; k++) {
      if (!first) {
        first = { offset: Number(offset), length, uncompressedSize: unc, zoom: keys[cursor].zoom, featureCount: keys[cursor].featureCount };
      }
      cursor++;
    }
    expected = offset + BigInt(length);
  }
  const blob = FIXTURE_BYTES.subarray(first!.offset, first!.offset + first!.length);
  return { blob, meta, e: first };
}

/** Web-Mercator tile-center lon/lat, computed independently of archive.ts's own formula. */
function tileCenterLonLat(z: number, x: number, y: number): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const merc = Math.PI * (1 - (2 * (y + 0.5)) / n);
  const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
  return { lon, lat };
}

/**
 * Build an in-memory packed dataset with one tile per (x,y) pair, ALL at the
 * same zoom/timeStart, one pack per tile (so coalesceGapBytes:0 makes every
 * tile its own range-group). Pack keys embed `x` so the gated fetch can tag
 * dispatches by which tile they belong to.
 */
function makeSpatialDataset(
  tiles: Array<{ x: number; y: number }>,
  zoom: number,
  timeStart: number,
  blob: Uint8Array,
  meta: any,
  e: any,
): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  const packRefs: Array<{ key: string; length: number }> = [];
  const entries: any[] = [];
  tiles.forEach((t, i) => {
    const key = `packs/x${t.x}.sttp`;
    objects.set(key, blob.slice());
    packRefs.push({ key, length: blob.length });
    entries.push({
      zoom,
      x: t.x,
      y: t.y,
      timeStart,
      timeEnd: timeStart,
      packId: i,
      offset: 0,
      length: blob.length,
      uncompressedSize: e.uncompressedSize,
      featureCount: e.featureCount,
      hilbert: i,
      // Real blob decoded through the verifying reader → true CRC-32C.
      crc32c: crc32c(blob),
    });
  });
  const dir = encodeDirectory(entries);
  objects.set('index/dir.sttd', dir);
  const manifest = {
    format: 'stt-packed',
    formatVersion: 1,
    compression: 'zstd',
    directory: { key: 'index/dir.sttd', length: dir.length, directoryVersion: 5 },
    packs: packRefs,
    metadata: meta,
  };
  objects.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  return objects;
}

interface Gate {
  gates: Array<() => void>;
  dispatchOrder: string[];
  inFlight: number;
}

/** A GATED fetch whose dispatch tag is the requested pack key (identifies WHICH tile). */
function gatedFetchByPath(objects: Map<string, Uint8Array>, manifestUrl: string, gate: Gate): typeof fetch {
  const slash = manifestUrl.lastIndexOf('/');
  const base = slash >= 0 ? manifestUrl.slice(0, slash + 1) : '';
  return (async (url: string, init?: RequestInit) => {
    const key = url.startsWith(base) ? url.slice(base.length) : url;
    const bytes = objects.get(key)!;
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => bufferToArrayBuffer(bytes) };
    }
    gate.dispatchOrder.push(key);
    gate.inFlight++;
    await new Promise<void>((resolve) => gate.gates.push(resolve));
    gate.inFlight--;
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    const contentRange = `bytes ${start}-${end}/${bytes.length}`;
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      headers: { get: (n: string) => (n.toLowerCase() === 'content-range' ? contentRange : null) },
      arrayBuffer: async () => bufferToArrayBuffer(slice),
    };
  }) as unknown as typeof fetch;
}

const flushMany = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await flush();
};

async function drainAll(gate: Gate, done: Promise<unknown>): Promise<void> {
  let finished = false;
  done.finally(() => {
    finished = true;
  });
  while (!finished) {
    const g = gate.gates.shift();
    if (g) g();
    await flush();
  }
  while (gate.gates.length > 0) {
    gate.gates.shift()!();
    await flush();
  }
}

describe('spatial tie-break in the shared scheduler', () => {
  beforeEach(() => resetSharedScheduler());
  afterEach(() => resetSharedScheduler());

  /**
   * With `maxRequests: 1`, `scheduler.scheduleRequest()` pumps SYNCHRONOUSLY on
   * every enqueue — so without care, the very first of several tiles to be
   * enqueued claims the sole slot immediately, before its competitors even
   * exist in the queue, regardless of priority. A genuine priority contest
   * needs at least two candidates ALREADY queued when a slot frees. This helper
   * occupies the one global slot with an unrelated "blocker" tile on a SEPARATE
   * archive/source first (so it can't be picked as a `bestPerSource` competitor
   * for the real archive), then lets the caller enqueue its real candidates
   * (which queue up together, since the slot is taken), then releases the
   * blocker so the NEXT dispatch is a fair priority comparison among them.
   */
  async function withBlockerSlot(
    gate: Gate,
    blob: Uint8Array,
    meta: unknown,
    e: unknown,
    enqueueReal: () => void,
  ): Promise<void> {
    const blockerUrl = 'mem://blocker/manifest.json';
    const blockerObjects = makeSpatialDataset([{ x: 0, y: 0 }], 1, 0, blob, meta, e);
    const blocker = new STTArchive({
      url: blockerUrl,
      fetch: gatedFetchByPath(blockerObjects, blockerUrl, gate),
      coalesceGapBytes: 0,
    });
    const blockerDone = blocker.getTiles([{ z: 1, x: 0, y: 0, t: 0 }]);
    // Give the blocker's fetch time to actually enter the gate (occupy the slot).
    await flushMany(5);
    expect(gate.dispatchOrder).toEqual(['packs/x0.sttp']);

    enqueueReal();
    // Give the real archive's getTiles() (getIndex + ensurePagesForTiles +
    // group-building, all async) time to reach scheduleRequest for every
    // candidate — safe to over-wait here, since the slot is genuinely occupied
    // so nothing can dispatch prematurely no matter how long this waits.
    await flushMany(10);

    // Release the blocker: the NEXT dispatch is now a real priority contest
    // among whichever real candidates are already queued.
    gate.gates.shift()!();
    await flushMany(5);
    await blockerDone;
  }

  it('the tile nearest viewportCenter dispatches first among EDF-tied range-groups', async () => {
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const ZOOM = 8;
    const Y = 100;
    const TIME_START = 0;
    // Middle tile placed LAST so byte-order/enqueue-order alone would dispatch
    // it last, not first — only the spatial tie-break can put it first.
    const tiles = [
      { x: 49, y: Y },
      { x: 51, y: Y },
      { x: 50, y: Y }, // middle — closest to viewportCenter below
    ];
    const url = 'mem://spatial/manifest.json';
    const objects = makeSpatialDataset(tiles, ZOOM, TIME_START, blob, meta, e);

    // Single global slot: the scheduler can only ever dispatch ONE range-group
    // at a time, so dispatchOrder is an exact priority-order trace.
    configureSharedScheduler({ enabled: true, maxRequests: 1 });

    const gate: Gate = { gates: [], dispatchOrder: [], inFlight: 0 };
    const archive = new STTArchive({
      url,
      fetch: gatedFetchByPath(objects, url, gate),
      coalesceGapBytes: 0,
    });

    const ids = tiles.map((t) => ({ z: ZOOM, x: t.x, y: t.y, t: TIME_START }));
    const center = tileCenterLonLat(ZOOM, 50, Y); // the middle tile's own center

    let p!: Promise<unknown>;
    await withBlockerSlot(gate, blob, meta, e, () => {
      p = archive.getTiles(ids, {
        // A real playhead exactly at each tile's timeStart makes
        // minDistanceToPlayhead identical (0) for all three — a genuine EDF tie.
        playheadTime: TIME_START,
        viewportCenter: center,
      });
    });

    await drainAll(gate, p);
    const r = (await p) as (unknown | null)[];
    expect(r.every((t) => t !== null)).toBe(true);

    // dispatchOrder[0] is the blocker; the middle tile (x=50) — spatially
    // closest to viewportCenter, but LAST in both the request array and pack
    // byte-order — dispatched NEXT, ahead of x=49 and x=51.
    expect(gate.dispatchOrder[1]).toBe('packs/x50.sttp');
  });

  it('without a viewportCenter, the spatial tie-break contributes nothing (order unaffected)', async () => {
    const { blob, meta, e } = await fixtureBlobAndMeta();
    const ZOOM = 8;
    const Y = 100;
    const TIME_START = 0;
    const tiles = [
      { x: 49, y: Y },
      { x: 51, y: Y },
      { x: 50, y: Y },
    ];
    const url = 'mem://spatial-none/manifest.json';
    const objects = makeSpatialDataset(tiles, ZOOM, TIME_START, blob, meta, e);
    configureSharedScheduler({ enabled: true, maxRequests: 1 });

    const gate: Gate = { gates: [], dispatchOrder: [], inFlight: 0 };
    const archive = new STTArchive({
      url,
      fetch: gatedFetchByPath(objects, url, gate),
      coalesceGapBytes: 0,
    });
    const ids = tiles.map((t) => ({ z: ZOOM, x: t.x, y: t.y, t: TIME_START }));

    // Same EDF tie (playheadTime set), but no viewportCenter this time.
    let p!: Promise<unknown>;
    await withBlockerSlot(gate, blob, meta, e, () => {
      p = archive.getTiles(ids, { playheadTime: TIME_START });
    });

    await drainAll(gate, p);
    const r = (await p) as (unknown | null)[];
    expect(r.every((t) => t !== null)).toBe(true);

    // With every term genuinely tied and no spatial term, dispatch order
    // (after the blocker) falls back to the scheduler's own FIFO tie-break —
    // enqueue order (x=49, x=51, x=50), NOT the middle tile first.
    expect(gate.dispatchOrder).toEqual([
      'packs/x0.sttp',
      'packs/x49.sttp',
      'packs/x51.sttp',
      'packs/x50.sttp',
    ]);
  });
});
