/**
 * Shared test fixtures: the byte / promise / tile / layer-frame boilerplate
 * that used to be copy-pasted across the archive, scheduler, prefetch,
 * eviction and decode suites. One definition each so a divergence can't
 * silently creep between the copies.
 */

import {
  RecordBatch,
  type Schema,
  Table,
  type makeData,
  tableToIPC,
} from 'apache-arrow';
import type { BoundingBox, Tile, TileId } from '../../src/types';

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

/** Copy a Uint8Array's bytes into a standalone ArrayBuffer (drops any offset). */
export function bufferToArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ---------------------------------------------------------------------------
// Async settling
// ---------------------------------------------------------------------------

/** Await a single macrotask so queued fetch/decoder microtasks land. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Await `ms` of real time — the timed settle the coverage/eviction/prefetch
 * suites use to let async index builds and grace timers land. Default 25 ms
 * matches the common case; callers with tighter/looser needs pass an explicit
 * value.
 */
export const settle = (ms = 25): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Single-cell synthetic archive
// ---------------------------------------------------------------------------

/** World bounds shared by the single-cell tileset tests. */
export const BOUNDS: BoundingBox = {
  minLon: -180,
  minLat: -85,
  maxLon: 180,
  maxLat: 85,
};

/** Every synthetic tileset buckets sim-time at 1 s. */
export const BUCKET_MS = 1000;

/** A minimal decoded tile whose interval is [id.t, id.t + bucketMs]. */
export function fakeTile(id: TileId, bucketMs = BUCKET_MS): Tile {
  return {
    id,
    timeRange: { start: id.t, end: id.t + bucketMs },
    layers: [],
  } as unknown as Tile;
}

/**
 * Build a `getAvailableTiles(bounds, zoom, range)` for a single-cell archive:
 * one tile per bucket in [0, nBuckets) whose [t, t + BUCKET_MS] interval
 * overlaps the query range. `xFromBounds` derives the tile column (default: a
 * fixed x=0); pass a viewport-sensitive fn when a viewport change must change
 * the needed-tile set (e.g. west → x=0, east → x=1).
 */
export function makeAvailableTiles(
  nBuckets: number,
  xFromBounds: (b: BoundingBox) => number = () => 0,
): (
  b: BoundingBox,
  z: number,
  range: { start: number; end: number },
) => TileId[] {
  return (b, z, range) => {
    const x = xFromBounds(b);
    const ids: TileId[] = [];
    const first = Math.max(0, Math.floor(range.start / BUCKET_MS));
    const last = Math.min(nBuckets - 1, Math.floor(range.end / BUCKET_MS));
    for (let i = first; i <= last; i++) {
      const t = i * BUCKET_MS;
      if (t + BUCKET_MS >= range.start && t <= range.end)
        ids.push({ z, x, y: 0, t });
    }
    return ids;
  };
}

// ---------------------------------------------------------------------------
// Layer-frame builder ([u16 count][u16 nameLen][name][u32 ipcLen][ipc])
// ---------------------------------------------------------------------------

/** Wrap an already-serialized Arrow IPC stream in a single-layer tile frame. */
export function frameFromIpc(name: string, ipc: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const frame = new Uint8Array(2 + 2 + nameBytes.length + 4 + ipc.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, 1, true); // layer count (unaligned frame)
  view.setUint16(2, nameBytes.length, true);
  frame.set(nameBytes, 4);
  view.setUint32(4 + nameBytes.length, ipc.length, true);
  frame.set(ipc, 4 + nameBytes.length + 4);
  return frame;
}

/** Serialize (schema, structData) to an Arrow IPC stream, then frame it. */
export function frameLayer(
  name: string,
  schema: Schema,
  structData: ReturnType<typeof makeData>,
): Uint8Array {
  const ipc = tableToIPC(
    new Table([new RecordBatch(schema, structData as never)]),
    'stream',
  );
  return frameFromIpc(name, ipc);
}
