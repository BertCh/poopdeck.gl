/**
 * Tile decoding: turn an STT tile payload into deck.gl-ready binary features.
 *
 * A tile payload is the *layer frame* produced by the Rust builder:
 *
 * ```text
 * [u16 layerCount]
 *   repeated: [u16 nameLen][name utf8][u32 ipcLen][Arrow IPC stream]
 * ```
 *
 * Each layer's Arrow IPC stream holds one RecordBatch whose `geometry` column
 * is GeoArrow-encoded (interleaved f64 coordinates). We extract the underlying
 * typed-array buffers into {@link BinaryFeatures} — the columnar shape deck.gl
 * uploads straight to the GPU.
 */

import { tableFromIPC, Type as ArrowType, type Table, type Vector } from 'apache-arrow';
import {
  type Tile,
  type TileId,
  type TimeRange,
  type Layer,
  type BinaryFeatures,
  GeometryType,
} from './types';

/** One layer extracted from the payload frame. */
interface RawLayer {
  name: string;
  ipc: Uint8Array;
}

/** Parse the layer frame into its constituent Arrow IPC streams. */
function parseLayerFrame(payload: Uint8Array): RawLayer[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let pos = 0;
  const readU16 = () => {
    const v = view.getUint16(pos, true);
    pos += 2;
    return v;
  };
  const readU32 = () => {
    const v = view.getUint32(pos, true);
    pos += 4;
    return v;
  };
  const readBytes = (len: number) => {
    if (pos + len > payload.byteLength) {
      throw new Error('STT tile payload truncated');
    }
    const slice = payload.subarray(pos, pos + len);
    pos += len;
    return slice;
  };

  if (payload.byteLength < 2) {
    throw new Error('STT tile payload too short for layer frame');
  }
  const count = readU16();
  const layers: RawLayer[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = readU16();
    const name = new TextDecoder().decode(readBytes(nameLen));
    const ipcLen = readU32();
    const ipc = readBytes(ipcLen);
    layers.push({ name, ipc });
  }
  return layers;
}

/** Resolve the single `Data` chunk of a column (tiles have one batch). */
function chunk(vec: Vector): any {
  if (vec.data.length === 0) throw new Error('empty Arrow column');
  // A tile layer is always written as one record batch.
  return vec.data[0];
}

/** The geometry kind a layer carries, from schema metadata. */
function geometryKind(table: Table): GeometryType {
  const meta = table.schema.metadata.get('stt:geometry') ?? '';
  if (meta === 'geoarrow.linestring') return GeometryType.LineString;
  if (meta === 'geoarrow.polygon') return GeometryType.Polygon;
  return GeometryType.Point;
}

/** Extract interleaved positions + per-feature start indices from geometry. */
function extractGeometry(
  geomVec: Vector,
  kind: GeometryType
): { positions: Float64Array; startIndices?: Uint32Array } {
  const geom = chunk(geomVec);

  if (kind === GeometryType.Point) {
    // FixedSizeList<Float64, 2>: the child buffer is the interleaved coords.
    const coords: Float64Array = geom.children[0].values;
    const start = geom.offset * 2;
    return { positions: coords.subarray(start, start + geom.length * 2) };
  }

  if (kind === GeometryType.LineString) {
    // LineString: List<FixedSizeList<Float64,2>>.
    const featureOffsets: Int32Array = geom.valueOffsets;
    const coordData = geom.children[0]; // FixedSizeList<Float64,2>
    const coords: Float64Array = coordData.children[0].values;
    const n = geom.length;
    const base = featureOffsets[geom.offset];
    const startIndices = new Uint32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      startIndices[i] = featureOffsets[geom.offset + i] - base;
    }
    const positions = coords.subarray(base * 2, featureOffsets[geom.offset + n] * 2);
    return { positions, startIndices };
  }

  // Polygon: List<List<FixedSizeList<Float64,2>>>. Two levels of offsets:
  //   featureOffsets : feature -> ring index
  //   ringOffsets    : ring    -> vertex index
  // We collapse to per-feature VERTEX offsets so the renderer sees one flat
  // run per feature. Ring boundaries inside a feature are not preserved in
  // BinaryFeatures — every existing STT polygon path treats `startIndices`
  // as feature-level vertex offsets.
  const featureOffsets: Int32Array = geom.valueOffsets;
  const ringList = geom.children[0]; // List<FixedSizeList<Float64,2>>
  const ringOffsets: Int32Array = ringList.valueOffsets;
  const coordData = ringList.children[0]; // FixedSizeList<Float64,2>
  const coords: Float64Array = coordData.children[0].values;

  const n = geom.length;
  const firstRing = featureOffsets[geom.offset];
  const lastRing = featureOffsets[geom.offset + n];
  const startVertex = ringOffsets[firstRing];
  const endVertex = ringOffsets[lastRing];
  const startIndices = new Uint32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const ringIdx = featureOffsets[geom.offset + i];
    startIndices[i] = ringOffsets[ringIdx] - startVertex;
  }
  const positions = coords.subarray(startVertex * 2, endVertex * 2);
  return { positions, startIndices };
}

/**
 * Extract the per-vertex time column.
 *
 * v3 layers carry the column as `List<UInt16>` deltas relative to a
 * per-layer `(origin, step)` recorded in schema metadata. v2 layers (and
 * v3 layers whose temporal span exceeds u16 * step) keep the absolute
 * `List<Int64>` shape. Either way we return one f32 relative to the
 * tile-level `timeOffset` for direct GPU upload.
 */
function extractVertexTimes(
  vec: Vector | null,
  timeOffset: number,
  origin: number,
  step: number,
): Float32Array | undefined {
  if (!vec) return undefined;
  const data = chunk(vec);
  const offsets: Int32Array = data.valueOffsets;
  const childValues = data.children[0].values as
    | BigInt64Array
    | Uint16Array
    | Int32Array;
  const base = offsets[data.offset];
  const total = offsets[data.offset + data.length] - base;
  const out = new Float32Array(total);
  // childValues is a BigInt64Array for the v2 absolute path and a
  // Uint16Array for the v3 delta path. Branch once outside the loop so
  // the tight loop stays monomorphic.
  if (childValues instanceof BigInt64Array) {
    for (let i = 0; i < total; i++) {
      out[i] = Number(childValues[base + i]) - timeOffset;
    }
  } else {
    for (let i = 0; i < total; i++) {
      out[i] = origin + childValues[base + i] * step - timeOffset;
    }
  }
  return out;
}

/** Convert one Arrow RecordBatch table into deck.gl binary features. */
function tableToBinaryFeatures(table: Table): BinaryFeatures {
  const kind = geometryKind(table);
  const featureCount = table.numRows;

  // --- ids ---
  const idVec = table.getChild('id');
  const featureIds = new Uint32Array(featureCount);
  if (idVec) {
    const raw = idVec.toArray() as BigUint64Array | Uint32Array;
    for (let i = 0; i < featureCount; i++) featureIds[i] = Number(raw[i]);
  }

  // --- times (relativised to timeOffset for f32 precision) ---
  const startRaw = table.getChild('start_time')?.toArray() as
    | BigInt64Array
    | undefined;
  const endRaw = table.getChild('end_time')?.toArray() as
    | BigInt64Array
    | undefined;
  let timeOffset = 0;
  if (startRaw && startRaw.length > 0) {
    let min = Number(startRaw[0]);
    for (let i = 1; i < startRaw.length; i++) {
      const v = Number(startRaw[i]);
      if (v < min) min = v;
    }
    timeOffset = min;
  }
  const startTimes = new Float32Array(featureCount);
  const endTimes = new Float32Array(featureCount);
  for (let i = 0; i < featureCount; i++) {
    startTimes[i] = startRaw ? Number(startRaw[i]) - timeOffset : 0;
    endTimes[i] = endRaw ? Number(endRaw[i]) - timeOffset : 0;
  }

  // --- geometry ---
  const geomVec = table.getChild('geometry');
  if (!geomVec) throw new Error('STT tile layer is missing its geometry column');
  const { positions, startIndices } = extractGeometry(geomVec, kind);

  // --- per-vertex times ---
  // v3 layers carry the origin/step pair as schema metadata; v2 layers
  // (and v3 layers with the i64 fallback) leave them absent, which we
  // treat as (origin=0, step=1) so the delta-vs-absolute branch still
  // produces correct numbers (Int64 path ignores both).
  const origin = Number(table.schema.metadata.get('stt:vertex_time_origin_ms') ?? 0);
  const step = Number(table.schema.metadata.get('stt:vertex_time_step_ms') ?? 1);
  const vertexTimestamps = extractVertexTimes(
    table.getChild('vertex_time') ?? null,
    timeOffset,
    origin,
    step,
  );

  // --- pre-baked triangle indices (MLT-style polygon meshes) ---
  // The Rust writer stores feature-LOCAL indices so we shift each feature's
  // run by its `startIndices[i]` to produce GLOBAL indices the renderer can
  // hand straight to deck.gl / WebGL. Absent → the renderer falls back to
  // its CPU earcut path at tile-arrival time.
  let triangles: Uint32Array | undefined;
  let triangleOffsets: Uint32Array | undefined;
  const hasTriangles =
    kind === GeometryType.Polygon &&
    table.schema.metadata.get('stt:has_triangles') === 'true';
  if (hasTriangles) {
    const triVec = table.getChild('triangles');
    if (triVec && startIndices) {
      const triData = chunk(triVec);
      const triOffsets: Int32Array = triData.valueOffsets;
      const triValues = triData.children[0].values as Uint32Array;
      const baseOff = triOffsets[triData.offset];
      const total = triOffsets[triData.offset + triData.length] - baseOff;
      triangles = new Uint32Array(total);
      triangleOffsets = new Uint32Array(featureCount + 1);
      // Walk every feature once, copying its slice with a per-feature shift
      // applied. `startIndices[i]` is in coordinate-pair units, which is
      // exactly what the triangle indices need to be shifted by.
      let writePos = 0;
      for (let i = 0; i < featureCount; i++) {
        triangleOffsets[i] = writePos;
        const begin = triOffsets[triData.offset + i] - baseOff;
        const end = triOffsets[triData.offset + i + 1] - baseOff;
        const shift = startIndices[i];
        for (let j = begin; j < end; j++) {
          triangles[writePos++] = triValues[j] + shift;
        }
      }
      triangleOffsets[featureCount] = writePos;
    }
  }

  // --- properties ---
  const numericProps: Record<string, Float32Array> = {};
  const categoricalProps: BinaryFeatures['categoricalProps'] = {};
  const reserved = new Set([
    'id',
    'start_time',
    'end_time',
    'geometry',
    'vertex_time',
    'triangles',
  ]);
  for (const field of table.schema.fields) {
    if (reserved.has(field.name)) continue;
    const vec = table.getChild(field.name);
    if (!vec) continue;
    const typeId = (field.type as any).typeId;
    const isDictionary =
      typeId === ArrowType.Dictionary ||
      String(field.type).startsWith('Dictionary');
    const isUtf8 = !isDictionary && field.type.toString().includes('Utf8');
    if (isDictionary) {
      // v3 categoricals are Dictionary<UInt16, Utf8>: lift the dictionary
      // indices and value table straight out of Arrow. No per-tile rebuild.
      const data = chunk(vec);
      const keys = data.values as Uint16Array | Uint8Array | Int32Array;
      const dictArray = (data as any).dictionary;
      const dictValues: string[] = [];
      const n = dictArray ? dictArray.length : 0;
      for (let i = 0; i < n; i++) dictValues.push(dictArray.get(i));
      const indices = new Uint16Array(featureCount);
      const validity = data.nullBitmap;
      for (let i = 0; i < featureCount; i++) {
        if (validity && (validity[(i + data.offset) >> 3] & (1 << ((i + data.offset) & 7))) === 0) {
          indices[i] = 0xffff;
        } else {
          // Widen narrower key types up to Uint16. Arrow stores keys as
          // whatever type the schema declared; v3 always uses UInt16, but
          // we tolerate the others for forward compatibility.
          indices[i] = Number(keys[i + data.offset]);
        }
      }
      categoricalProps[field.name] = { indices, categories: dictValues };
    } else if (isUtf8) {
      // v2 fallback: plain Utf8 column. Rebuild the dictionary here.
      const categories: string[] = [];
      const lookup = new Map<string, number>();
      const indices = new Uint16Array(featureCount);
      for (let i = 0; i < featureCount; i++) {
        const s = vec.get(i);
        if (s == null) {
          indices[i] = 0xffff;
          continue;
        }
        let idx = lookup.get(s);
        if (idx === undefined) {
          idx = categories.length;
          categories.push(s);
          lookup.set(s, idx);
        }
        indices[i] = idx;
      }
      categoricalProps[field.name] = { indices, categories };
    } else {
      // Numeric: f64 column down-converted to f32 for GPU upload.
      const raw = vec.toArray() as Float64Array | Float32Array;
      const arr = new Float32Array(featureCount);
      for (let i = 0; i < featureCount; i++) arr[i] = Number(raw[i]);
      numericProps[field.name] = arr;
    }
  }

  return {
    featureCount,
    geometryType: kind,
    positionDimensions: 2,
    positions,
    startIndices,
    featureIds,
    startTimes,
    endTimes,
    timeOffset,
    vertexTimestamps,
    triangles,
    triangleOffsets,
    numericProps,
    categoricalProps,
  };
}

/**
 * Decode an uncompressed tile payload into a {@link Tile}.
 *
 * @param payload   The decompressed layer-frame bytes.
 * @param id        The tile identity.
 * @param timeRange The tile's temporal span (from the archive directory).
 *                  Optional: the worker / loaders.gl decode paths do not have
 *                  the archive directory available. When omitted it is
 *                  defaulted to a zero-width range at the tile's own `t`
 *                  timestamp — callers that need the precise span (the
 *                  `Archive` reader) always pass it explicitly.
 */
export function decodeTile(
  payload: Uint8Array,
  id: TileId,
  timeRange: TimeRange = { start: id.t, end: id.t }
): Tile {
  const rawLayers = parseLayerFrame(payload);
  const layers: Layer[] = rawLayers.map((raw) => {
    const table = tableFromIPC(raw.ipc);
    return {
      name: raw.name,
      extent: 0, // coordinates are real lon/lat; no quantization extent
      features: tableToBinaryFeatures(table),
    };
  });
  return { id, timeRange, layers };
}
