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

import {
  buildV2Frame,
  splitIpcTemplate,
  tileMetaBytes,
  REF_KIND_INLINE,
  REF_KIND_NO_PROPS,
  SECTION_CORE_BATCH,
  SECTION_INLINE_SCHEMA_CORE,
  SECTION_TILE_META,
} from './v2-frame.js';

// ---------------------------------------------------------------------------
// Layer-frame builder
// ---------------------------------------------------------------------------

/**
 * Wrap an already-serialized Arrow IPC stream in a single-layer tile frame.
 *
 * Emits a SELF-CONTAINED frame: the layer's schema rides inline in an
 * `INLINE_SCHEMA_CORE` section rather than being referenced by template hash,
 * so the frame decodes without a dataset template registry — the same shape
 * `stt-serve` emits. All property columns stay in the core batch (`NO_PROPS`),
 * which is what these fixtures' single-batch Arrow tables already express.
 */
export function frameFromIpc(
  name: string,
  ipc: Uint8Array,
  tileMeta?: Record<string, unknown>,
): Uint8Array {
  const { template, tail } = splitIpcTemplate(ipc);
  const sections: Array<[number, Uint8Array]> = [
    [SECTION_INLINE_SCHEMA_CORE, template],
  ];
  // Per-tile metadata is HOISTED into its own section, the way the Rust
  // encoder emits it — the decoder reads quantization affines and time
  // offsets from here, not from the Arrow schema.
  if (tileMeta && Object.keys(tileMeta).length > 0) {
    sections.push([SECTION_TILE_META, tileMetaBytes(tileMeta)]);
  }
  sections.push([SECTION_CORE_BATCH, tail]);
  return buildV2Frame([
    {
      name,
      refCore: { kind: REF_KIND_INLINE },
      refProps: { kind: REF_KIND_NO_PROPS },
      sections,
    },
  ]);
}

/**
 * Derive the TILE_META a real encoder would hoist out of this schema: the
 * per-field `stt:qa` affines and the schema-level time/vertex-time offsets.
 */
function tileMetaFromSchema(schema: Schema): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const qa: Record<string, [number, number]> = {};
  for (const f of schema.fields) {
    const raw = f.metadata?.get('stt:qa');
    if (raw === undefined) continue;
    try {
      const { o, s } = JSON.parse(raw);
      qa[f.name] = [o, s];
    } catch {
      // A deliberately malformed affine: pass it through verbatim so the
      // decoder's warn-once fallback is what the test exercises.
      qa[f.name] = raw as unknown as [number, number];
    }
  }
  if (Object.keys(qa).length > 0) meta.qa = qa;
  const t0 = schema.metadata?.get('stt:time_offset_ms');
  if (t0 !== undefined) meta.t0 = Number(t0);
  const vtO = schema.metadata?.get('stt:vertex_time_origin_ms');
  const vtS = schema.metadata?.get('stt:vertex_time_step_ms');
  if (vtO !== undefined && vtS !== undefined)
    meta.vt = [Number(vtO), Number(vtS)];
  const vb = schema.metadata?.get('stt:vertex_value_buckets');
  if (vb !== undefined) meta.vb = Number(vb);
  return meta;
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
  return frameFromIpc(name, ipc, tileMetaFromSchema(schema));
}
