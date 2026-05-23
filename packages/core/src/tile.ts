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

import { tableFromIPC, type Table, type Vector } from 'apache-arrow';
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

  // LineString: List<FixedSizeList<Float64,2>>.
  // Polygon: List<List<FixedSizeList<Float64,2>>> — flattened to feature-level
  // coordinate ranges (ring boundaries are not preserved in BinaryFeatures).
  const featureOffsets: Int32Array = geom.valueOffsets;
  let coordData = geom.children[0];
  if (kind === GeometryType.Polygon) {
    // Descend through the ring list to the coordinate list.
    coordData = coordData.children[0];
  }
  // coordData is now FixedSizeList<Float64,2>.
  const coords: Float64Array = coordData.children[0].values;

  // Translate the List offsets (in units of coordinate *pairs*) into
  // per-feature start indices, normalised so feature 0 starts at 0.
  const n = geom.length;
  const base = featureOffsets[geom.offset];
  const startIndices = new Uint32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    startIndices[i] = featureOffsets[geom.offset + i] - base;
  }
  const positions = coords.subarray(base * 2, featureOffsets[geom.offset + n] * 2);
  return { positions, startIndices };
}

/** Extract a `List<Int64>` per-vertex time column as a flat Float32Array. */
function extractVertexTimes(
  vec: Vector | null,
  timeOffset: number
): Float32Array | undefined {
  if (!vec) return undefined;
  const data = chunk(vec);
  const offsets: Int32Array = data.valueOffsets;
  const childValues: BigInt64Array = data.children[0].values;
  const base = offsets[data.offset];
  const total = offsets[data.offset + data.length] - base;
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    out[i] = Number(childValues[base + i]) - timeOffset;
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
  const vertexTimestamps = extractVertexTimes(
    table.getChild('vertex_time') ?? null,
    timeOffset
  );

  // --- properties ---
  const numericProps: Record<string, Float32Array> = {};
  const categoricalProps: BinaryFeatures['categoricalProps'] = {};
  const reserved = new Set([
    'id',
    'start_time',
    'end_time',
    'geometry',
    'vertex_time',
  ]);
  for (const field of table.schema.fields) {
    if (reserved.has(field.name)) continue;
    const vec = table.getChild(field.name);
    if (!vec) continue;
    if (field.type.toString().includes('Utf8')) {
      // Categorical: dictionary-encode the strings on decode.
      const categories: string[] = [];
      const lookup = new Map<string, number>();
      const indices = new Uint16Array(featureCount);
      for (let i = 0; i < featureCount; i++) {
        const s = vec.get(i);
        if (s == null) {
          indices[i] = 0xffff; // sentinel for "missing"
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
