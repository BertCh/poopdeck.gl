// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Tile decoding: turn an STT tile payload into deck.gl-ready binary features.
 *
 * A **formatVersion-1** tile payload is the *layer frame* produced by the
 * Rust builder:
 *
 * ```text
 * [u16 layerCount | ALIGNED_FRAME_FLAG]
 *   repeated: [u16 nameLen][name utf8][u32 ipcLen][pad to 8][Arrow IPC stream]
 * ```
 *
 * The leading u16's top bit (0x8000) marks the *aligned* frame: zero padding
 * after each `ipcLen` places every IPC stream at an 8-byte boundary relative
 * to the payload start, which is what lets apache-arrow wrap the stream's
 * buffers zero-copy (a misaligned stream silently copies every buffer). The
 * pad length is never stored — it is derived as `(8 - pos % 8) % 8` from the
 * position after `ipcLen`. Frames without the flag (all archives written
 * before the flag existed) carry no padding and parse exactly as before.
 *
 * A **formatVersion-2** payload opens with the `0xFFFF` escape (unreachable
 * in v1, whose aligned path caps the count at `0x7fff`) and carries the
 * sectioned, template-referencing frame of packed spec §5.2: per layer a
 * schema reference (inline section or 16-byte blake3-128 hash resolved
 * against the manifest's template registry), a skippable section TOC, the
 * canonical-JSON `TILE_META` section, and the Arrow IPC stream **tails**
 * (dictionary batches + record batch + EOS) for the CORE and optional PROPS
 * batches. The reader splices `concat(template, tail)` back into a stock
 * Arrow stream — see {@link decodeTile}'s options for the registry plumbing.
 *
 * Each layer's Arrow IPC stream holds one RecordBatch whose `geometry` column
 * is GeoArrow-encoded (interleaved f64 coordinates). We extract the underlying
 * typed-array buffers into {@link BinaryFeatures} — the columnar shape deck.gl
 * uploads straight to the GPU.
 */

import {
  Field,
  Float32,
  Int64,
  List,
  makeData,
  RecordBatch,
  Schema,
  Struct,
  Table,
  tableFromIPC,
  Type as ArrowType,
  type Data,
  type Vector,
} from 'apache-arrow';
import {
  type Tile,
  type TileId,
  type TileMetaJson,
  type TimeRange,
  type STTTileLayer,
  type BinaryFeatures,
  GeometryType,
} from './types.js';

// ─── Layer frame v2 (packed formatVersion 2, spec §5.2) ─────────────────────

/** Leading u16 escape of the v2 sectioned frame (spec §5.2). */
const FRAME_V2_ESCAPE = 0xffff;
/** `frame_version` byte of the v2 frame. */
const FRAME_V2_VERSION = 2;

// Section tag registry (unknown tags are SKIPPABLE via their TOC length).
const SECTION_INLINE_SCHEMA_CORE = 0x01;
const SECTION_TILE_META = 0x02;
const SECTION_CORE_BATCH = 0x03;
const SECTION_INLINE_SCHEMA_PROPS = 0x04;
const SECTION_PROPS_BATCH = 0x05;

// Per-layer schema reference kinds.
const REF_KIND_INLINE = 0;
const REF_KIND_TEMPLATE_HASH = 1;
const REF_KIND_NO_PROPS = 2;

/**
 * The columns `TILE_META.vq` may name — a CLOSED set, mirroring Rust's
 * `QUANTIZABLE_VERTEX_VALUE_COLUMNS`. Anything else in the map is a crafted or
 * corrupt section rather than an additive extension, because a `vq` entry
 * re-types the column it names.
 */
const QUANTIZABLE_VERTEX_VALUE_COLUMNS = [
  'vertex_value',
  'vertex_value_matrix',
];

/**
 * Reserved `UInt16` index in a quantized per-vertex value column meaning "this
 * vertex has no value" — the `Float32` shape's `NaN`, which `UInt16` cannot
 * represent. Mirrors Rust's `VERTEX_VALUE_QUANT_SENTINEL`.
 */
const VERTEX_VALUE_QUANT_SENTINEL = 0xffff;

/**
 * The dataset's schema-template registry: blake3-128 hex (32 lowercase hex
 * chars, the string form of the 16-byte hash a v2 frame embeds) → the raw
 * template bytes. Built (and hash-validated) from `manifest.schemas` at
 * archive open; v2 frames with `ref_kind 1` resolve against it. See packed
 * spec §3.2 and the worker-distribution contract in `tile-decoder.ts`.
 */
export type TemplateRegistry = Map<string, Uint8Array>;

/** Options for {@link decodeTile} (all optional — v1 decoding needs none). */
export interface DecodeTileOptions {
  /**
   * Schema-template registry for formatVersion-2 frames (`manifest.schemas`,
   * validated at open). Required to decode v2 frames that reference
   * templates by hash; self-contained v2 frames (inline schema sections)
   * and every v1 frame decode without it.
   */
  templates?: TemplateRegistry;
  /**
   * The dataset's declared `manifest.formatVersion`. When set, it is
   * enforced against the payload (spec §5.2 authority rule): a v2 frame
   * reached through a v1-declared manifest is a hard error, and vice versa
   * — the frame escape is defense-in-depth, never a negotiation channel.
   * Omitted (standalone `decodeTile` callers), the payload is sniffed.
   */
  formatVersion?: number;
}

/** One layer parsed out of a v2 frame: spliced IPC streams + TILE_META. */
interface RawLayerV2 {
  name: string;
  /** `concat(core template, CORE_BATCH tail)` — a stock Arrow IPC stream. */
  coreIpc: Uint8Array;
  /** As above for the PROPS batch; absent when `ref_kind_props = 2`. */
  propsIpc?: Uint8Array;
  tileMeta: TileMetaJson;
}

/** 16 raw hash bytes → 32 lowercase hex chars (the registry key form). */
function hashBytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++)
    hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Splice a schema template onto a `*_BATCH` section tail, with the normative
 * guards of spec §5.2.1: both parts MUST begin with the `0xFFFFFFFF`
 * encapsulation/continuation marker. Without the guard, stray zero bytes
 * parse as a legacy 4-byte end-of-stream and the tile silently decodes
 * EMPTY (arrow-rs) or silently loses zero-copy (arrow-js) — the exact
 * failure the spike proved, so it must be a loud, named error instead.
 */
function spliceIpc(
  template: Uint8Array,
  tail: Uint8Array,
  what: string,
): Uint8Array {
  const startsWithContinuation = (b: Uint8Array): boolean =>
    b.length >= 4 &&
    b[0] === 0xff &&
    b[1] === 0xff &&
    b[2] === 0xff &&
    b[3] === 0xff;
  if (!startsWithContinuation(template)) {
    throw new Error(
      `${what}: schema template does not start with an encapsulated Arrow message`,
    );
  }
  if (!startsWithContinuation(tail)) {
    throw new Error(
      `${what}: batch section does not start with the 0xFFFFFFFF continuation marker ` +
        '(corrupt or misaligned section — a stray-zero prefix would otherwise silently ' +
        'decode as an EMPTY tile)',
    );
  }
  const out = new Uint8Array(template.length + tail.length);
  out.set(template, 0);
  out.set(tail, template.length);
  return out;
}

/** Resolve a v2 layer's schema template: inline section or registry lookup. */
function resolveV2Template(
  refKind: number,
  hashHex: string | undefined,
  inline: Uint8Array | undefined,
  templates: TemplateRegistry | undefined,
  what: string,
): Uint8Array {
  if (refKind === REF_KIND_INLINE) {
    if (!inline) {
      throw new Error(`${what}: inline schema section missing from the frame`);
    }
    return inline;
  }
  // REF_KIND_TEMPLATE_HASH — the caller already rejected other kinds.
  if (!templates) {
    // NEVER a silent empty tile: a v2 hash reference without the registry is
    // a plumbing failure (decode reached before the manifest's registry was
    // distributed) and must say so by name.
    throw new Error(
      `${what}: frame references schema template ${hashHex} but no template registry ` +
        'is available — a formatVersion-2 dataset must be opened through its manifest ' +
        '(the registry is built from manifest.schemas at open and re-sent to every ' +
        'decode worker on spawn)',
    );
  }
  const template = templates.get(hashHex!);
  if (!template) {
    throw new Error(
      `${what}: schema template ${hashHex} is not in the dataset's registry ` +
        '(manifest.schemas is incomplete or the frame is corrupt)',
    );
  }
  return template;
}

/**
 * Validate a freshly-parsed `TILE_META` object against the spec §5.2.2 key
 * shapes. Parseable-but-malformed JSON (`t0` as a string, a `qa` affine as
 * an object, a one-element `vt`, …) would otherwise flow through
 * {@link resolveMetaFromTileMeta} into extraction as silent NaNs — wrong
 * times/values with no error anywhere. Unknown keys stay ignored (the
 * additive contract); the KNOWN keys must carry their declared shape.
 * `label` names the tile + layer, and every error names the offending key.
 */
function validateTileMeta(meta: unknown, label: string): TileMetaJson {
  const fail = (what: string, value: unknown): never => {
    throw new Error(
      `${label}: malformed TILE_META — ${what}, got ${JSON.stringify(value)}`,
    );
  };
  const isFinite_ = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);
  const isAffinePair = (v: unknown): v is [number, number] =>
    Array.isArray(v) && v.length === 2 && isFinite_(v[0]) && isFinite_(v[1]);

  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    fail('the section must be a JSON object', meta);
  }
  const m = meta as Record<string, unknown>;
  if (m.t0 !== undefined && !isFinite_(m.t0)) {
    fail("'t0' must be a finite number (Unix ms)", m.t0);
  }
  if (m.vt !== undefined && !isAffinePair(m.vt)) {
    fail("'vt' must be a [origin_ms, step_ms] pair of finite numbers", m.vt);
  }
  if (m.vb !== undefined && !isFinite_(m.vb)) {
    fail("'vb' must be a finite number", m.vb);
  }
  // Compact feature times. An unknown VALUE of a known key is a hard error,
  // not a silent misread: the `time-delta` manifest capability is the version
  // gate that keeps a reader from ever seeing one it does not understand.
  if (m.st !== undefined && m.st !== 'u32') {
    fail('\'st\' must be the string "u32"', m.st);
  }
  if (m.st === 'u32' && !isFinite_(m.t0)) {
    // With a u32 start column `t0` is the offsets' anchor — load-bearing, so
    // its absence has to fail here rather than decode every feature to 1970.
    fail("'st' = \"u32\" requires a finite 't0' anchor", m.t0);
  }
  if (m.et !== undefined && m.et !== 'dur32' && m.et !== 'zero') {
    fail('\'et\' must be the string "dur32" or "zero"', m.et);
  }
  // Per-vertex value quantization. Same shape rules as `qa`, plus a closed key
  // set: the affine RE-TYPES a named column, so applying one to a column
  // outside the two per-vertex value columns could only corrupt it.
  if (m.vq !== undefined) {
    if (m.vq === null || typeof m.vq !== 'object' || Array.isArray(m.vq)) {
      fail("'vq' must be an object of column → [o, s] pairs", m.vq);
    }
    for (const [column, affine] of Object.entries(m.vq as object)) {
      if (!QUANTIZABLE_VERTEX_VALUE_COLUMNS.includes(column)) {
        fail(
          `'vq' names column "${column}", which is not a per-vertex value column ` +
            `(this reader knows ${QUANTIZABLE_VERTEX_VALUE_COLUMNS.join(', ')})`,
          column,
        );
      }
      if (!isAffinePair(affine)) {
        fail(
          `'vq' affine for column "${column}" must be an [o, s] pair of finite numbers`,
          affine,
        );
      }
    }
  }
  if (m.sorted !== undefined && typeof m.sorted !== 'boolean') {
    fail("'sorted' must be a boolean", m.sorted);
  }
  if (m.qa !== undefined) {
    if (m.qa === null || typeof m.qa !== 'object' || Array.isArray(m.qa)) {
      fail("'qa' must be an object of column → [o, s] pairs", m.qa);
    }
    for (const [column, affine] of Object.entries(m.qa as object)) {
      if (!isAffinePair(affine)) {
        fail(
          `'qa' affine for column "${column}" must be an [o, s] pair of finite numbers`,
          affine,
        );
      }
    }
  }
  return m as TileMetaJson;
}

/**
 * Parse a v2 sectioned layer frame (spec §5.2) into per-layer spliced Arrow
 * IPC streams + TILE_META. `tileLabel` names the tile in every error.
 */
function parseLayerFrameV2(
  payload: Uint8Array,
  tileLabel: string,
  templates: TemplateRegistry | undefined,
): RawLayerV2[] {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  let pos = 0;
  const readU8 = () => {
    if (pos + 1 > payload.byteLength) {
      throw new Error(`${tileLabel}: v2 layer frame truncated`);
    }
    return payload[pos++];
  };
  const readU16 = () => {
    if (pos + 2 > payload.byteLength) {
      throw new Error(`${tileLabel}: v2 layer frame truncated`);
    }
    const v = view.getUint16(pos, true);
    pos += 2;
    return v;
  };
  const readU32 = () => {
    if (pos + 4 > payload.byteLength) {
      throw new Error(`${tileLabel}: v2 layer frame truncated`);
    }
    const v = view.getUint32(pos, true);
    pos += 4;
    return v;
  };
  const readBytes = (len: number) => {
    if (pos + len > payload.byteLength) {
      throw new Error(`${tileLabel}: v2 layer frame truncated`);
    }
    const slice = payload.subarray(pos, pos + len);
    pos += len;
    return slice;
  };
  /** Skip the derived pad to the next 8-byte boundary (never stored). */
  const skipPad = () => {
    readBytes((8 - (pos & 7)) & 7);
  };

  const escape = readU16();
  if (escape !== FRAME_V2_ESCAPE) {
    // Callers dispatch on the escape; this is belt-and-braces.
    throw new Error(`${tileLabel}: not a v2 layer frame`);
  }
  const frameVersion = readU8();
  if (frameVersion !== FRAME_V2_VERSION) {
    throw new Error(
      `${tileLabel}: unsupported layer-frame version ${frameVersion} (this reader knows v2)`,
    );
  }
  const flags = readU8();
  if (flags !== 0) {
    throw new Error(
      `${tileLabel}: reserved v2 layer-frame flags must be 0, got 0x${flags.toString(16)}`,
    );
  }
  const count = readU16();
  const layers: RawLayerV2[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = readU16();
    const name = new TextDecoder().decode(readBytes(nameLen));
    const label = `tile ${tileLabel} layer '${name}'`;

    const readRef = (what: string): { kind: number; hashHex?: string } => {
      const kind = readU8();
      if (kind === REF_KIND_TEMPLATE_HASH) {
        return { kind, hashHex: hashBytesToHex(readBytes(16)) };
      }
      if (kind === REF_KIND_INLINE || kind === REF_KIND_NO_PROPS) {
        return { kind };
      }
      throw new Error(
        `${label} ${what}: unknown schema ref_kind ${kind} (this reader knows 0..=2)`,
      );
    };
    const core = readRef('core');
    if (core.kind === REF_KIND_NO_PROPS) {
      throw new Error(
        `${label}: ref_kind_core 2 is invalid (every layer has a CORE batch)`,
      );
    }
    const props = readRef('props');

    const sectionCount = readU8();
    const toc: Array<{ tag: number; length: number }> = [];
    for (let s = 0; s < sectionCount; s++) {
      const tag = readU8();
      const length = readU32();
      toc.push({ tag, length });
    }
    skipPad();

    // Unknown tags land in the map like any other (harmlessly unused) —
    // skipping happens by never consulting them, exactly the additive
    // evolution the TOC exists for. Duplicates are frame corruption.
    const sections = new Map<number, Uint8Array>();
    for (const { tag, length } of toc) {
      const bytes = readBytes(length);
      skipPad();
      if (sections.has(tag)) {
        throw new Error(
          `${label}: duplicate section tag 0x${tag.toString(16)} in the TOC`,
        );
      }
      sections.set(tag, bytes);
    }

    // TILE_META: canonical JSON; unknown keys ignored (additive contract).
    let tileMeta: TileMetaJson = {};
    const tileMetaBytes = sections.get(SECTION_TILE_META);
    if (tileMetaBytes) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(tileMetaBytes));
      } catch (err) {
        throw new Error(
          `${label}: TILE_META JSON decode failed: ${(err as Error).message}`,
        );
      }
      // Shape gate (spec §5.2.2): reject malformed-but-parseable JSON HERE,
      // loudly and by key — never as downstream NaN times/values.
      tileMeta = validateTileMeta(parsed, label);
    }

    const coreTemplate = resolveV2Template(
      core.kind,
      core.hashHex,
      sections.get(SECTION_INLINE_SCHEMA_CORE),
      templates,
      `${label} core`,
    );
    const coreTail = sections.get(SECTION_CORE_BATCH);
    if (!coreTail) {
      throw new Error(`${label}: CORE_BATCH section missing`);
    }
    const coreIpc = spliceIpc(coreTemplate, coreTail, `${label} core`);

    let propsIpc: Uint8Array | undefined;
    if (props.kind === REF_KIND_NO_PROPS) {
      if (sections.has(SECTION_PROPS_BATCH)) {
        throw new Error(
          `${label}: PROPS_BATCH section present but ref_kind_props declares no props`,
        );
      }
    } else {
      const propsTemplate = resolveV2Template(
        props.kind,
        props.hashHex,
        sections.get(SECTION_INLINE_SCHEMA_PROPS),
        templates,
        `${label} props`,
      );
      const propsTail = sections.get(SECTION_PROPS_BATCH);
      if (!propsTail) {
        throw new Error(`${label}: PROPS_BATCH section missing`);
      }
      propsIpc = spliceIpc(propsTemplate, propsTail, `${label} props`);
    }

    layers.push({ name, coreIpc, propsIpc, tileMeta });
  }
  return layers;
}

/** Resolve the single `Data` chunk of a column (tiles have one batch). */
function chunk(vec: Vector): any {
  if (vec.data.length === 0) throw new Error('empty Arrow column');
  // A tile layer is always written as one record batch.
  return vec.data[0];
}

/** The GeoArrow extension-name metadata key (standard, cross-tool). */
const GEOARROW_EXT_KEY = 'ARROW:extension:name';

/**
 * Resolve the geometry kind for a layer.
 *
 * Reads the standard GeoArrow extension name from the `geometry` field's
 * metadata first — that's the key any GeoArrow-aware consumer
 * (`@geoarrow/deck.gl-layers`, Lonboard, geoarrow-rs) will inspect. Falls
 * back to the legacy schema-level `stt:geometry` metadata so v2 archives
 * (written before the field-level tag landed) still decode.
 */
function geometryExtensionName(table: Table): string {
  const geomField = table.schema.fields.find((f) => f.name === 'geometry');
  const fieldName = geomField?.metadata.get(GEOARROW_EXT_KEY);
  if (fieldName) return fieldName;
  return table.schema.metadata.get('stt:geometry') ?? '';
}

function geometryKind(table: Table): GeometryType {
  const name = geometryExtensionName(table);
  if (name === 'geoarrow.linestring') return GeometryType.LineString;
  if (name === 'geoarrow.polygon') return GeometryType.Polygon;
  return GeometryType.Point;
}

/**
 * Field-metadata key flagging a tile whose `xy` coordinate leaf is fixed-point
 * `i32` grid indices, not Float64 lon/lat. Mirrors `arrow_tile.rs`'s
 * `STT_QUANT_META_KEY`; its value is the reconstruction affine.
 */
const STT_QUANT_META_KEY = 'stt:quant';

/**
 * Field-metadata key flagging a *numeric property* column stored as fixed-point
 * integers (`value = o + q*s`) instead of Float64. Mirrors `arrow_tile.rs`'s
 * `STT_QUANT_ATTR_META_KEY`; lives on the property field (the sibling of the
 * geometry coordinate quantization).
 */
const STT_QUANT_ATTR_META_KEY = 'stt:qa';

/**
 * Warn-once dedupe for malformed quantization metadata (one warning per
 * metadata key / column, not one per tile — a corrupt archive decodes many
 * tiles). Mirrors the fallback warning in `tile-decoder.ts`.
 */
const warnedMalformedQuantMeta = new Set<string>();

function warnMalformedQuantMetaOnce(
  key: string,
  message: string,
  err: unknown,
): void {
  if (warnedMalformedQuantMeta.has(key)) return;
  warnedMalformedQuantMeta.add(key);
  console.warn(message, err);
}

/**
 * Test-only: clear the module-level "warned once" dedup set so a `beforeEach`
 * can isolate the "warns exactly once" assertions from any earlier case in the
 * same worker that tripped the same metadata key.
 */
export function _resetQuantWarnings(): void {
  warnedMalformedQuantMeta.clear();
}

/**
 * Coordinate-quantization affine (`lon = x0 + qx*sx`, `lat = y0 + qy*sy`). For
 * 3D point geometry the altitude axis (`z = z0 + qz*sz`) is present too; absent
 * for 2D coords.
 */
interface QuantAffine {
  x0: number;
  y0: number;
  sx: number;
  sy: number;
  z0?: number;
  sz?: number;
}

/** Read the quantization affine from the geometry field, or undefined (Float64). */
function readQuantAffine(table: Table): QuantAffine | undefined {
  const geomField = table.schema.fields.find((f) => f.name === 'geometry');
  const raw = geomField?.metadata.get(STT_QUANT_META_KEY);
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw);
    return { x0: o.x0, y0: o.y0, sx: o.sx, sy: o.sy, z0: o.z0, sz: o.sz };
  } catch (err) {
    warnMalformedQuantMetaOnce(
      STT_QUANT_META_KEY,
      `[stt] malformed ${STT_QUANT_META_KEY} affine JSON on the geometry field — ` +
        'coordinates will decode as raw fixed-point grid indices, not lon/lat:',
      err,
    );
    return undefined;
  }
}

/**
 * Read an interleaved coordinate run `[start, end)` out of a geometry leaf.
 * `dims` is the coordinate width (2 for `[lon,lat]`, 3 for `[lon,lat,alt]` point
 * clouds). Without an affine the leaf is already a `Float64Array` and we return
 * a zero-copy subarray; with one it's an `i32` grid-index array we dequantize
 * into a fresh `Float64Array` (`lon=x0+qx·sx`, `lat=y0+qy·sy`, `alt=z0+qz·sz`).
 */
function readCoordRun(
  leaf: ArrayLike<number>,
  start: number,
  end: number,
  dims: number,
  affine?: QuantAffine,
): Float64Array {
  if (!affine) return (leaf as Float64Array).subarray(start, end);
  const out = new Float64Array(end - start);
  const z0 = affine.z0 ?? 0;
  const sz = affine.sz ?? 1;
  for (let i = start, j = 0; i < end; i += dims, j += dims) {
    out[j] = affine.x0 + leaf[i] * affine.sx;
    out[j + 1] = affine.y0 + leaf[i + 1] * affine.sy;
    if (dims > 2) out[j + 2] = z0 + leaf[i + 2] * sz;
  }
  return out;
}

/**
 * Extract interleaved positions + per-feature start indices from geometry.
 *
 * `partVec` is the optional `part_offsets` column (`List<UInt32>`, per feature
 * the RING INDEX each of its parts starts at, relative to that feature's own
 * first ring). It is resolved HERE rather than beside the other reserved
 * columns because turning those ring indices into the `partIndices` contract —
 * global, layer-rebased VERTEX indices — needs the very offset buffers this
 * function already walks.
 */
function extractGeometry(
  geomVec: Vector,
  kind: GeometryType,
  affine?: QuantAffine,
  partVec?: Vector | null,
): {
  positions: Float64Array;
  startIndices?: Uint32Array;
  ringIndices?: Uint32Array;
  partIndices?: Uint32Array;
  positionDimensions: 2 | 3;
} {
  const geom = chunk(geomVec);

  if (kind === GeometryType.Point) {
    // FixedSizeList<Float64|Int32, 2|3>: the child buffer is interleaved coords.
    // 3-wide point clouds carry altitude as the 3rd coord (zero-copy 3D), so the
    // renderer never pads 2D→3D on the main thread.
    const dims = ((geom.type as any)?.listSize ?? 2) as 2 | 3;
    const coords: ArrayLike<number> = geom.children[0].values;
    const start = geom.offset * dims;
    return {
      positions: readCoordRun(
        coords,
        start,
        start + geom.length * dims,
        dims,
        affine,
      ),
      positionDimensions: dims,
    };
  }

  if (kind === GeometryType.LineString) {
    // LineString: List<FixedSizeList<Float64|Int32,2>>.
    const featureOffsets: Int32Array = geom.valueOffsets;
    const coordData = geom.children[0];
    const coords: ArrayLike<number> = coordData.children[0].values;
    const n = geom.length;
    const base = featureOffsets[geom.offset];
    const startIndices = new Uint32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      startIndices[i] = featureOffsets[geom.offset + i] - base;
    }
    const positions = readCoordRun(
      coords,
      base * 2,
      featureOffsets[geom.offset + n] * 2,
      2,
      affine,
    );
    return { positions, startIndices, positionDimensions: 2 };
  }

  // Polygon: List<List<FixedSizeList<Float64|Int32,2>>>. Two levels of offsets:
  //   featureOffsets : feature -> ring index
  //   ringOffsets    : ring    -> vertex index
  // We collapse to per-feature VERTEX offsets (`startIndices`) so the renderer
  // sees one flat run per feature — the shape every STT polygon fill path
  // expects. The ring breaks INSIDE a feature are also surfaced, rebased the
  // same way (`ringIndices`), because edge-walking consumers (extruded side
  // walls, per-ring outlines) otherwise stitch a spurious edge from the last
  // vertex of one ring to the first vertex of the next.
  const featureOffsets: Int32Array = geom.valueOffsets;
  const ringList = geom.children[0]; // List<FixedSizeList<Float64|Int32,2>>
  const ringOffsets: Int32Array = ringList.valueOffsets;
  const coordData = ringList.children[0];
  const coords: ArrayLike<number> = coordData.children[0].values;

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
  const ringIndices = new Uint32Array(lastRing - firstRing + 1);
  for (let r = firstRing; r <= lastRing; r++) {
    ringIndices[r - firstRing] = ringOffsets[r] - startVertex;
  }
  const positions = readCoordRun(
    coords,
    startVertex * 2,
    endVertex * 2,
    2,
    affine,
  );
  // MultiPolygon part boundaries. The wire column is per-feature RING indices;
  // `partIndices` is the same nested-offsets contract as `ringIndices` — global
  // vertex indices rebased to the layer's first vertex, with a total-count
  // terminator — so the two compose without the consumer re-deriving anything.
  let partIndices: Uint32Array | undefined;
  if (partVec) {
    const partData = chunk(partVec);
    const partOffsets: Int32Array = partData.valueOffsets;
    const partValues = partData.children[0].values as Uint32Array;
    const partBase = partOffsets[partData.offset];
    const totalParts =
      partOffsets[partData.offset + partData.length] - partBase;
    partIndices = new Uint32Array(totalParts + 1);
    let w = 0;
    for (let i = 0; i < n; i++) {
      // Ring index the feature starts at, so its own `[0]` maps back here.
      const featureFirstRing = featureOffsets[geom.offset + i];
      const begin = partOffsets[partData.offset + i] - partBase;
      const end = partOffsets[partData.offset + i + 1] - partBase;
      for (let p = begin; p < end; p++) {
        // `partValues[partBase + p]`, not `partValues[p]`: `p` is REBASED
        // (`- partBase`) while the child buffer is absolute — the same
        // `childValues[base + i]` convention `extractVertexTimes` and
        // `extractVertexFloats` use. Identical today (a single-batch IPC
        // table makes `partBase` 0) and wrong the moment the column arrives
        // as a sliced chunk.
        partIndices[w++] =
          ringOffsets[featureFirstRing + partValues[partBase + p]] -
          startVertex;
      }
    }
    partIndices[totalParts] = endVertex - startVertex;
  }
  return {
    positions,
    startIndices,
    ringIndices,
    partIndices,
    positionDimensions: 2,
  };
}

/**
 * Extract the per-vertex time column.
 *
 * The column is delta-coded against a per-layer `(origin, step)` — v1 schema
 * metadata / v2 `TILE_META.vt` — in one of two widths the encoder picks per
 * layer from its own temporal span, and the Arrow child type is
 * self-describing:
 *
 * - `List<UInt16>` — spans up to 65 535 * step (18.2 h at the 1 s default);
 * - `List<UInt32>` — up to 4 294 967 295 * step, i.e. **49.7 days at exact
 *   millisecond precision**, half the bytes the absolute fallback costs;
 * - `List<Int64>` — absolute timestamps, when even a u32 delta would need a
 *   step past the encoder's precision ceiling (and for layers with no `vt`).
 *
 * Either way we return one f32 relative to the tile-level `timeOffset` for
 * direct GPU upload.
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
    | Uint32Array
    | Int32Array;
  const base = offsets[data.offset];
  const total = offsets[data.offset + data.length] - base;
  const out = new Float32Array(total);
  // Branch once outside the loop so each tight loop stays monomorphic — one
  // arm per child-array type, never a union inside the loop.
  if (childValues instanceof BigInt64Array) {
    for (let i = 0; i < total; i++) {
      out[i] = Number(childValues[base + i]) - timeOffset;
    }
  } else if (childValues instanceof Uint32Array) {
    for (let i = 0; i < total; i++) {
      out[i] = origin + childValues[base + i] * step - timeOffset;
    }
  } else {
    for (let i = 0; i < total; i++) {
      out[i] = origin + childValues[base + i] * step - timeOffset;
    }
  }
  return out;
}

/**
 * Extract a per-vertex scalar column (`vertex_value` / `vertex_value_matrix`)
 * into a flat `Float32Array` aligned 1:1 with `positions`.
 *
 * ONE wire shape reaches here: a `List<Float32>` (or `Float64`) holding the
 * values verbatim, `NaN` marking a vertex with no value (rendered with a
 * fallback colour). Unlike vertex times there is no delta/origin/step.
 *
 * The `vertex-value-quant` capability's `List<UInt16>` shape never reaches
 * this function: {@link reinflateQuantizedVertexValues} has already turned it
 * back into `List<Float32>` at the TABLE level (where `toGeoArrowTable` sees
 * the same reconstruction), which is why there is no `TILE_META.vq` branch
 * here to keep in sync.
 */
function extractVertexFloats(vec: Vector | null): Float32Array | undefined {
  if (!vec) return undefined;
  const data = chunk(vec);
  const offsets: Int32Array = data.valueOffsets;
  const base = offsets[data.offset];
  const total = offsets[data.offset + data.length] - base;
  const out = new Float32Array(total);
  const childValues = data.children[0].values as Float32Array | Float64Array;
  for (let i = 0; i < total; i++) {
    out[i] = childValues[base + i];
  }
  return out;
}

/**
 * Per-tile-varying metadata, RESOLVED to one shape before extraction — the
 * convergence point of the two wire sources:
 *
 * - **v1**: Arrow schema/field metadata (`stt:time_offset_ms`,
 *   `stt:vertex_time_*`, `stt:vertex_value_buckets`, per-field `stt:qa`) via
 *   {@link resolveMetaFromSchema};
 * - **v2**: the frame's `TILE_META` section (`t0` / `vt` / `vb` / `qa` /
 *   `sorted`) via {@link resolveMetaFromTileMeta} — v2 templates carry only
 *   dataset-constant metadata, so the schema copies are ABSENT by design.
 *
 * `tableToBinaryFeatures` reads only this object, so the extraction paths
 * cannot fork between the two formats.
 */
interface ResolvedTileMeta {
  /**
   * Baked minimum feature start-time (Unix ms). `undefined` → the extractor
   * falls back to the exact min-scan over the start-time column (older v1
   * tiles / v2 tiles with no start-time column).
   */
  timeOffset?: number;
  /** Vertex-time u16-delta origin (ms). 0 when absolute Int64 vertex times. */
  vertexTimeOrigin: number;
  /** Vertex-time u16-delta step (ms). 1 when absolute Int64 vertex times. */
  vertexTimeStep: number;
  /** Bucket count of the vertex-value matrix; 0 = no matrix on this tile. */
  vertexValueBuckets: number;
  /** Attribute-quantization affines (`value = o + q*s`) per property column. */
  qa: Map<string, { o: number; s: number }>;
  /** v2 `TILE_META.sorted`: rows stable-sorted by `start_time`. v1: absent. */
  sorted?: boolean;
}

/*
 * Deliberately ABSENT from {@link ResolvedTileMeta}: `TILE_META.st`, `.et` and
 * `.vq`. Those three keys RE-TYPE a CORE column, and {@link reinflateCoreTable}
 * has already undone every one of them by the time a table reaches
 * `tableToBinaryFeatures` — so the extractor sees the classic `Int64` /
 * `List<Float32>` shapes and only the classic shapes. Re-reading them here is
 * how the two decode surfaces would drift apart again (and how an affine would
 * get applied twice).
 */

/**
 * Resolve the per-tile metadata from a v2 frame's `TILE_META` section.
 * Presence rules (spec §5.2.2): a key is present iff the feature is — an
 * absent `qa` column key means not-quantized, absent `t0` means no
 * start-time column (→ min-scan fallback yields 0 on an empty column),
 * absent `vt` means absolute Int64 vertex times.
 */
function resolveMetaFromTileMeta(meta: TileMetaJson): ResolvedTileMeta {
  const qa = new Map<string, { o: number; s: number }>();
  if (meta.qa) {
    for (const [name, affine] of Object.entries(meta.qa)) {
      qa.set(name, { o: affine[0], s: affine[1] });
    }
  }
  return {
    timeOffset: meta.t0,
    vertexTimeOrigin: meta.vt ? meta.vt[0] : 0,
    vertexTimeStep: meta.vt ? meta.vt[1] : 1,
    vertexValueBuckets: meta.vb ?? 0,
    qa,
    sorted: meta.sorted,
  };
}

/**
 * Mirror Rust's `{:.17e}` float formatting (`AttrQuant::to_json`): one
 * integer digit, 17 fractional digits, exponent with no `+` sign or zero
 * padding — full f64 round-trip precision, byte-identical to the v1
 * writer's field metadata so decode-side consumers can't tell the formats
 * apart even at the string level.
 */
function rustExp17(v: number): string {
  return v.toExponential(17).replace('e+', 'e');
}

/**
 * The schema-level metadata entries a v2 `TILE_META` re-injects, with the
 * exact v1 assembler formatting (integer `to_string()`); presence mirrors
 * the section's (an absent key stays absent, exactly like Rust's
 * `merge_v2_layer`). `sorted` has no v1 counterpart and is never injected.
 */
function tileMetaSchemaEntries(meta: TileMetaJson): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (meta.t0 !== undefined)
    entries.push(['stt:time_offset_ms', String(meta.t0)]);
  if (meta.vt) {
    entries.push(['stt:vertex_time_origin_ms', String(meta.vt[0])]);
    entries.push(['stt:vertex_time_step_ms', String(meta.vt[1])]);
  }
  if (meta.vb !== undefined)
    entries.push(['stt:vertex_value_buckets', String(meta.vb)]);
  return entries;
}

/**
 * Re-inject a hoisted attribute-quant affine onto its property field
 * (v1 `stt:qa` JSON shape `{"o":..,"s":..}`, byte-identical formatting).
 */
function withQaFieldMetadata(field: Field, qa: TileMetaJson['qa']): Field {
  const affine = qa?.[field.name];
  if (!affine) return field;
  return field.clone({
    metadata: new Map([
      ...field.metadata,
      [
        STT_QUANT_ATTR_META_KEY,
        `{"o":${rustExp17(affine[0])},"s":${rustExp17(affine[1])}}`,
      ],
    ]),
  });
}

// ─── TILE_META re-inflation (the TS mirror of Rust's merge_v2_layer) ────────

/** `2^32`, the u32 radix the BigInt-free i64 helpers below split on. */
const TWO_32 = 4294967296;

/**
 * Platform byte order, probed once at module load.
 *
 * Every platform this renderer targets (x86-64, ARM64, wasm32) is
 * little-endian; the probe exists only so the BigInt-free `i64` fast paths
 * ({@link readInt64AsNumbers}, {@link makeInt64Data},
 * {@link materializeFeatureIds}) can never silently read or write the wrong
 * half on a hypothetical big-endian host — each falls back to `BigInt` there.
 */
const LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

/**
 * Read an `Int64` column's values into exact JS numbers, WITHOUT boxing a
 * `BigInt` per element.
 *
 * On a little-endian host an `Int64` buffer viewed as `Uint32` reads
 * `[lo0, hi0, lo1, hi1, …]`, so `hi·2³² + lo` (with `hi` reinterpreted as a
 * signed int32 via `| 0`) reconstructs the value in pure float math — exact
 * for every `|v| < 2⁵³`, which every Unix-millisecond timestamp is by four
 * orders of magnitude. Measured over 200 k elements: **1.4 ns/elem** vs
 * 14.7 ns/elem for `Number(bigint)`, the conversion this replaces on the
 * decode hot path.
 *
 * `out.length` is the row count and wins over the column length, mirroring
 * {@link materializeFeatureIds}: a short column leaves the tail zero-filled
 * rather than `NaN`-filled.
 */
function readInt64AsNumbers(data: Data, out: Float64Array): void {
  const raw = data.values as unknown as BigInt64Array;
  const base = data.offset;
  const n = Math.min(out.length, Math.max(0, raw.length - base));
  if (LITTLE_ENDIAN) {
    // A BigInt64Array's byteOffset is 8-aligned by construction, so a u32
    // view over its buffer is always legal.
    const halves = new Uint32Array(
      raw.buffer as ArrayBuffer,
      raw.byteOffset,
      raw.length * 2,
    );
    for (let i = 0; i < n; i++) {
      const j = (base + i) * 2;
      out[i] = (halves[j + 1] | 0) * TWO_32 + halves[j];
    }
  } else {
    for (let i = 0; i < n; i++) out[i] = Number(raw[base + i]);
  }
}

/**
 * Materialize an `Int64` Arrow column from exact integer milliseconds — the
 * inverse of {@link readInt64AsNumbers}, and BigInt-free the same way (2.3
 * ns/elem vs 16.1 for `BigInt(v)`). Negative (pre-1970) timestamps fall out
 * of the `Math.floor` / remainder pair as correct two's complement.
 *
 * `nulls` carries the source column's validity buffer through unchanged
 * (Rust's `…nulls().cloned()`): the compact forms are declared non-null, but
 * a reader that DROPPED a validity buffer would silently turn a null time
 * into a real one, which is a worse failure than carrying a redundant one.
 */
function makeInt64Data(
  abs: Float64Array,
  nulls?: { nullBitmap: Uint8Array | null | undefined; nullCount: number },
): Data<Int64> {
  const n = abs.length;
  const values = new BigInt64Array(n);
  if (LITTLE_ENDIAN) {
    const halves = new Uint32Array(values.buffer);
    for (let i = 0; i < n; i++) {
      const v = abs[i];
      const hi = Math.floor(v / TWO_32);
      halves[i * 2] = v - hi * TWO_32;
      halves[i * 2 + 1] = hi;
    }
  } else {
    // `Math.trunc` because `BigInt()` THROWS on a non-integer: a crafted
    // TILE_META may carry a fractional `t0` (the section validator only
    // requires finite), and a decoder must not turn that into a RangeError.
    for (let i = 0; i < n; i++) values[i] = BigInt(Math.trunc(abs[i]));
  }
  return makeData({
    type: new Int64(),
    length: n,
    nullCount: nulls?.nullCount ?? 0,
    nullBitmap: nulls?.nullBitmap ?? undefined,
    data: values,
  });
}

/**
 * Re-inflate the compact feature-time columns declared by `TILE_META.st` /
 * `.et` into the absolute, non-null `Int64` `start_time` / `end_time` pair
 * every consumer of a decoded layer already expects — the TS mirror of Rust's
 * `reinflate_compact_times`, error messages included.
 *
 * This is the whole reason the compact encoding needs no downstream change:
 * the merged table is INDISTINGUISHABLE from a non-compact tile's, right down
 * to column order — a synthesized `end_time` (`et: "zero"`) is inserted
 * immediately after `start_time`, its canonical index, rather than appended.
 *
 * Operates on the CORE prefix, before property columns are appended, and is a
 * no-op for every archive built before the feature existed (both keys absent).
 */
function reinflateCompactTimes(
  fields: Field[],
  children: Data[],
  meta: TileMetaJson,
  what: string,
): void {
  if (meta.st === undefined && meta.et === undefined) return;
  const startIdx = fields.findIndex((f) => f.name === 'start_time');
  if (startIdx < 0) {
    throw new Error(
      `${what}: TILE_META declares a compact time encoding but the layer has ` +
        "no 'start_time' column",
    );
  }

  if (meta.st === 'u32') {
    // `t0` is the offsets' anchor — load-bearing, not an optimization.
    // `validateTileMeta` already rejected a tile that declares the form
    // without it; this is the belt to that braces.
    const t0 = meta.t0;
    if (t0 === undefined) {
      throw new Error(
        `${what}: TILE_META declares st="u32" (start_time as a u32 offset) ` +
          "but carries no 't0' anchor to reconstruct against",
      );
    }
    const data = children[startIdx];
    const offsets = data.values;
    if (!(offsets instanceof Uint32Array)) {
      throw new Error(
        `${what}: TILE_META declares st="u32" but 'start_time' is ${data.type}`,
      );
    }
    const n = data.length;
    const abs = new Float64Array(n);
    for (let i = 0; i < n; i++) abs[i] = t0 + offsets[data.offset + i];
    children[startIdx] = makeInt64Data(abs, data);
    fields[startIdx] = fields[startIdx].clone({ type: new Int64() });
  }

  const et = meta.et;
  if (et === undefined) return;
  // Both end forms are relative to the (now absolute) start column.
  const startData = children[startIdx];
  if (!(startData.values instanceof BigInt64Array)) {
    throw new Error(
      `${what}: TILE_META declares a compact 'end_time' but 'start_time' is ` +
        `${startData.type} (expected Int64 after re-inflation)`,
    );
  }

  if (et === 'zero') {
    if (fields.some((f) => f.name === 'end_time')) {
      throw new Error(
        `${what}: TILE_META declares et="zero" (the end_time column is ` +
          "omitted) but the layer carries an 'end_time' column",
      );
    }
    // `end === start` for every feature. Rust shares the start column here
    // (an `Arc` clone, free); this reader COPIES it, deliberately.
    // apache-arrow's JS IPC *writer* cannot serialize a record batch whose
    // two columns alias one `ArrayBuffer` — it double-counts the body length
    // and then writes the buffer once, so the stream is short and every
    // reader rejects it ("Expected to read N bytes for message body, but
    // only read M"). Since the whole point of this function is a table that
    // behaves EXACTLY like a non-compact one for generic consumers — Lonboard
    // writing Parquet, a `tableToIPC` hand-off — 8 bytes per feature is the
    // right trade for not handing out a table that cannot be re-serialized.
    const values = (startData.values as unknown as BigInt64Array).slice(
      startData.offset,
      startData.offset + startData.length,
    );
    fields.splice(
      startIdx + 1,
      0,
      new Field('end_time', new Int64(), fields[startIdx].nullable),
    );
    children.splice(
      startIdx + 1,
      0,
      makeData({
        type: new Int64(),
        length: startData.length,
        nullCount: startData.nullCount,
        nullBitmap: startData.nullBitmap,
        data: values,
      }),
    );
    return;
  }

  const endIdx = fields.findIndex((f) => f.name === 'end_time');
  if (endIdx < 0) {
    throw new Error(
      `${what}: TILE_META declares et="dur32" but the layer has no ` +
        "'end_time' column",
    );
  }
  const endData = children[endIdx];
  const durations = endData.values;
  if (!(durations instanceof Uint32Array)) {
    throw new Error(
      `${what}: TILE_META declares et="dur32" but 'end_time' is ${endData.type}`,
    );
  }
  if (endData.length !== startData.length) {
    throw new Error(
      `${what}: compact time columns disagree on length: start_time ` +
        `${startData.length} vs end_time ${endData.length}`,
    );
  }
  const n = startData.length;
  const abs = new Float64Array(n);
  readInt64AsNumbers(startData, abs);
  for (let i = 0; i < n; i++) abs[i] += durations[endData.offset + i];
  children[endIdx] = makeInt64Data(abs, endData);
  fields[endIdx] = fields[endIdx].clone({ type: new Int64() });
}

/**
 * Re-inflate the per-vertex value columns declared by `TILE_META.vq` from
 * their `UInt16` leaf back to the `List<Float32>` shape every consumer of a
 * decoded layer already expects (`value = o + q*s`, with the reserved
 * {@link VERTEX_VALUE_QUANT_SENTINEL} index becoming `NaN`) — the TS mirror
 * of Rust's `reinflate_quantized_vertex_values`, error messages included.
 *
 * The sibling of {@link reinflateCompactTimes}, and the reason the
 * quantization needs no downstream change: the merged table is
 * INDISTINGUISHABLE from a non-quantized tile's — same column, same position,
 * same Arrow type, same list offsets and null buffers.
 *
 * The leaf-type check is not decoration. A crafted or corrupt tile whose `vq`
 * names a column that actually shipped `Float32` would otherwise reinterpret
 * those bytes as `UInt16` indices and decode to plausible-looking garbage;
 * Rust refuses it loudly, and so must this reader.
 */
function reinflateQuantizedVertexValues(
  fields: Field[],
  children: Data[],
  meta: TileMetaJson,
  what: string,
): void {
  if (!meta.vq) return;
  for (const [name, affine] of Object.entries(meta.vq)) {
    // `validateTileMeta` has already closed the key set and pinned the pair
    // shape, so `name` is one of QUANTIZABLE_VERTEX_VALUE_COLUMNS here.
    const idx = fields.findIndex((f) => f.name === name);
    if (idx < 0) {
      throw new Error(
        `${what}: TILE_META.vq carries an affine for '${name}' but the layer ` +
          'has no such column',
      );
    }
    const data = children[idx];
    if (data.type.typeId !== ArrowType.List) {
      throw new Error(
        `${what}: TILE_META.vq declares '${name}' quantized but the column ` +
          `is ${data.type} (expected a List)`,
      );
    }
    const child = data.children[0];
    const leaf = child?.values;
    if (!(leaf instanceof Uint16Array)) {
      throw new Error(
        `${what}: TILE_META.vq declares '${name}' quantized but its list leaf ` +
          `is ${child?.type} (expected UInt16)`,
      );
    }
    const [o, s] = affine;
    // The LOGICAL extent, not `leaf.length`: an Arrow IPC buffer is padded to
    // an 8-byte boundary, so a `UInt16` leaf of 6 values arrives as an
    // 8-element view. Sizing the reconstruction off the raw view would leave
    // two phantom `0`s past the end of the column — invisible through the
    // list offsets, but visible to anything that reads the child buffer, and
    // a gratuitous difference from the non-quantized tile this is supposed to
    // be indistinguishable from.
    const end = Math.min(child.offset + child.length, leaf.length);
    // The sentinel is the format's `NaN` (no value at this vertex); every
    // other index is the affine applied in f64 and narrowed once, exactly
    // mirroring the encoder.
    const values = new Float32Array(end);
    for (let i = child.offset; i < end; i++) {
      const q = leaf[i];
      values[i] = q === VERTEX_VALUE_QUANT_SENTINEL ? NaN : o + q * s;
    }
    const inflatedChild = makeData({
      type: new Float32(),
      length: child.length,
      offset: child.offset,
      nullCount: child.nullCount,
      nullBitmap: child.nullBitmap,
      data: values,
    });
    const inflated = makeData({
      type: new List(new Field('item', new Float32(), true)),
      length: data.length,
      offset: data.offset,
      nullCount: data.nullCount,
      nullBitmap: data.nullBitmap,
      valueOffsets: data.valueOffsets,
      child: inflatedChild,
    });
    fields[idx] = fields[idx].clone({ type: inflated.type });
    children[idx] = inflated;
  }
}

/**
 * Undo every `TILE_META`-declared RE-TYPING of a CORE column, so the table
 * that leaves decode is the classic shape regardless of which compact
 * encodings the tile happened to use.
 *
 * Runs on the CORE table BEFORE the property columns are appended — exactly
 * where Rust's `merge_v2_layer` runs it — for two reasons: a synthesized
 * `end_time` has to land at its canonical index rather than after the
 * properties, and both consumers of the merged table (`tableToBinaryFeatures`
 * AND the public {@link toGeoArrowTable}) must see the same thing. Doing it
 * inside `tableToBinaryFeatures` instead would leave `toGeoArrowTable` —
 * documented as the hand-off to generic GeoArrow consumers
 * (`@geoarrow/deck.gl-layers`, Lonboard) — handing out a `UInt32`
 * milliseconds-since-`t0` `start_time`, no `end_time` at all, and a raw
 * `UInt16` `vertex_value`.
 *
 * Zero-copy and allocation-free for every tile that declares none of the
 * compact encodings (the returned table IS the input).
 */
function reinflateCoreTable(
  core: Table,
  meta: TileMetaJson,
  what: string,
): Table {
  const compactTimes = meta.st !== undefined || meta.et !== undefined;
  const quantVertexValues = meta.vq !== undefined;
  if (!compactTimes && !quantVertexValues) return core;
  const batch = core.batches[0];
  if (!batch || core.batches.length !== 1) {
    throw new Error(
      `${what}: expected exactly one record batch in the CORE stream ` +
        `(got ${core.batches.length})`,
    );
  }
  const fields = core.schema.fields.slice();
  const children = batch.data.children.slice();
  reinflateCompactTimes(fields, children, meta, what);
  reinflateQuantizedVertexValues(fields, children, meta, what);
  const schema = new Schema(
    fields,
    core.schema.metadata,
    core.schema.dictionaries,
  );
  const data = makeData({
    type: new Struct(fields),
    length: batch.numRows,
    nullCount: 0,
    children,
  });
  return new Table(schema, [new RecordBatch(schema, data)]);
}

/**
 * Rebuild ONE v2 layer's v1-shaped table: re-inflate the CORE column
 * re-typings, merge the PROPS columns back in, and re-inject the
 * `TILE_META`-hoisted schema metadata. The TS counterpart of Rust's
 * `merge_v2_layer`, and the single entry point both decode paths
 * ({@link decodeTile} inline, {@link toGeoArrowTable} worker-rehydrate) go
 * through — so neither can drift from the other.
 */
function mergeV2Layer(
  core: Table,
  props: Table | undefined,
  meta: TileMetaJson,
  what: string,
): Table {
  const inflated = reinflateCoreTable(core, meta, what);
  return props
    ? mergeCorePropsTables(inflated, props, meta, what)
    : injectTileMetaIntoCoreTable(inflated, meta);
}

/**
 * Merge a v2 layer's decoded CORE and PROPS tables back into ONE table —
 * the v1-shaped record batch every consumer downstream of decode sees, so
 * the core/props section split stays invisible. Zero-copy:
 * the merged batch reuses both source batches' column `Data` children.
 *
 * The merged schema carries the union of both schemas' (dataset-constant)
 * metadata PLUS the `TILE_META`-hoisted per-tile values re-injected with
 * the exact v1 formatting (per-field `stt:qa`, schema-level
 * `stt:time_offset_ms` / `stt:vertex_time_*` / `stt:vertex_value_buckets`)
 * — mirroring Rust's `merge_v2_layer`, so the `toGeoArrowTable()` hand-off
 * carries every `stt:*` key a v1 table does.
 */
function mergeCorePropsTables(
  core: Table,
  props: Table,
  meta: TileMetaJson,
  what: string,
): Table {
  if (props.numRows !== core.numRows) {
    throw new Error(
      `${what}: CORE/PROPS row counts disagree: ${core.numRows} vs ${props.numRows}`,
    );
  }
  const coreBatch = core.batches[0];
  const propsBatch = props.batches[0];
  if (
    !coreBatch ||
    !propsBatch ||
    core.batches.length !== 1 ||
    props.batches.length !== 1
  ) {
    throw new Error(
      `${what}: expected exactly one record batch per spliced stream ` +
        `(got ${core.batches.length} core / ${props.batches.length} props)`,
    );
  }
  // Attribute-quant affines only ever land on property columns (reserved
  // CORE columns are never attr-quantized), matching merge_v2_layer.
  const fields = [
    ...core.schema.fields,
    ...props.schema.fields.map((f) => withQaFieldMetadata(f, meta.qa)),
  ];
  const metadata = new Map([
    ...core.schema.metadata,
    ...props.schema.metadata,
    ...tileMetaSchemaEntries(meta),
  ]);
  // Dictionary columns only occur among property columns (reserved CORE
  // columns are never dictionaries), so the props schema's dictionary table
  // carries over unchanged; the per-column dictionaries themselves ride the
  // column `Data` and survive the merge regardless.
  const schema = new Schema(fields, metadata, props.schema.dictionaries);
  const data = makeData({
    type: new Struct(fields),
    length: coreBatch.numRows,
    nullCount: 0,
    children: [...coreBatch.data.children, ...propsBatch.data.children],
  });
  return new Table(schema, [new RecordBatch(schema, data)]);
}

/**
 * The no-props (`ref_kind_props = 2`) counterpart of the re-injection in
 * {@link mergeCorePropsTables}: rebuild the CORE table's schema with the
 * `TILE_META` schema-level keys folded in (Rust's `merge_v2_layer` runs the
 * same injection with `props = None`). Zero-copy — the record-batch `Data`
 * is reused; returns the input table untouched when there is nothing to
 * inject.
 */
function injectTileMetaIntoCoreTable(core: Table, meta: TileMetaJson): Table {
  const entries = tileMetaSchemaEntries(meta);
  if (entries.length === 0) return core;
  const metadata = new Map([...core.schema.metadata, ...entries]);
  const schema = new Schema(
    core.schema.fields,
    metadata,
    core.schema.dictionaries,
  );
  return new Table(
    schema,
    core.batches.map((b) => new RecordBatch(schema, b.data)),
  );
}

// ─── Feature ids ────────────────────────────────────────────────────────────

/**
 * Seed for the `featureIds` slot of a freshly built {@link BinaryFeatures}.
 * {@link defineLazyFeatureIds} replaces it with the memoising accessor before
 * the object escapes `tableToBinaryFeatures`, so the value is never
 * observable — it exists purely so the object literal satisfies the
 * (non-optional) field without a cast.
 */
const FEATURE_IDS_SEED = new Uint32Array(0);

/**
 * Materialise `BinaryFeatures.featureIds` — the **masked low 32 bits** of the
 * archive's UInt64 `id` column.
 *
 * THE CONTRACT, and the one thing every consumer has to know: this is
 * `id & 0xffffffff`, NOT a faithful stand-in for the id. Where the column
 * carries values above 2³² — H3 cell indices at resolution ≥ 7, and EVERY
 * Quadbin cell id (whose header and zoom bits live in the high half) — the
 * discriminating bits are simply gone and what remains is meaningless as an
 * identity. Those consumers must read {@link BinaryFeatures.featureIds64},
 * which is the column verbatim.
 *
 * The masking is load-bearing, not cosmetic. The obvious `Number(raw[i])`
 * rounds the u64 to the nearest f64 BEFORE the `Uint32Array` store applies
 * its own mod-2³², so above 2⁵³ the stored low half is not even a truncation
 * — it is garbage:
 *
 * ```text
 *   id                    true low 32   Number(id) stored
 *   0x872830828ffffff      687865855     687865856   H3 r7,  off by one
 *   0x8f2830828052d25      671427877     671427840   H3 r15, off by 37
 *   0x4CFFFFFFFFFFFFFF    4294967295             0   Quadbin, total loss
 * ```
 *
 * On a little-endian host the mask is free: a `BigUint64Array` reinterpreted
 * as u32 reads `[lo0, hi0, lo1, hi1, …]`, so the low halves are a stride-2
 * gather and no BigInt ever materialises. Measured over 1M ids: **0.8 ms**
 * for the gather, 8.7 ms for the correct-but-boxed
 * `Number(raw[i] & 0xffffffffn)`, 12.4 ms for the wrong `Number(raw[i])` this
 * replaces. A `BigUint64Array`'s `byteOffset` is 8-aligned by construction,
 * so the u32 view over its buffer is always legal.
 *
 * `count` is the tile's row count and wins over the column length: a short
 * column leaves the tail zero-filled, exactly as the old loop's
 * `Number(undefined) → NaN → 0` did.
 */
function materializeFeatureIds(
  raw: BigUint64Array | Uint32Array | undefined,
  count: number,
): Uint32Array {
  const out = new Uint32Array(count);
  if (!raw) return out; // no `id` column at all → zeros, as before
  const n = Math.min(count, raw.length);
  if (raw instanceof BigUint64Array) {
    if (LITTLE_ENDIAN) {
      const halves = new Uint32Array(
        raw.buffer,
        raw.byteOffset,
        raw.length * 2,
      );
      for (let i = 0; i < n; i++) out[i] = halves[i * 2];
    } else {
      // Big-endian fallback: the pair order is [hi, lo], so gather through
      // BigInt rather than guessing at the stride.
      for (let i = 0; i < n; i++) out[i] = Number(raw[i] & 0xffffffffn);
    }
  } else {
    // Already 32-bit (defensive — no shipped archive writes a u32 `id`): one
    // memcpy beats the per-element loop it replaces.
    out.set(raw.subarray(0, n));
  }
  return out;
}

/**
 * Install `featureIds` as a MEMOISING accessor on a decoded
 * {@link BinaryFeatures}, so the low-half mirror is only ever built for tiles
 * whose ids someone actually reads.
 *
 * Why bother: `featureIds` has no reader on the render path. No layer in
 * `@poopdeck.gl/layers`, `/three` or `/maplibre` touches it (the summary
 * layers read `featureIds64`; picking is by index), and its one consumer in
 * this package — {@link getFeatureProperties} — is a picking/tooltip path
 * that prefers `featureIds64` whenever it is present. Building it eagerly
 * spent a full pass over every feature of every tile for nothing.
 *
 * Why an ACCESSOR rather than simply omitting the field: `BinaryFeatures`
 * declares it non-optional and several decode-path tests read it straight off
 * decoded tiles, so it has to keep answering. Lazy-but-present is
 * transparent — reads, spreads, `Object.keys`, `JSON.stringify` and
 * structured clone all behave exactly as they did with a data property.
 *
 * What this does NOT buy, and why it is still shaped this way: the property
 * is `enumerable`, and structured clone reads every enumerable own property,
 * so a worker-decoded tile materialises its ids at `postMessage` time
 * regardless (this is deliberate — a NON-enumerable accessor is silently
 * DROPPED by the clone, which would strand `getFeatureProperties` on the main
 * thread with no id at all; both behaviours verified, not assumed). The
 * tileset likewise forces it via `estimateTileSize` → `forEachBufferView`.
 * Laziness therefore pays on the direct-`STTArchive` paths today (Node
 * tooling, `stt-optimize`, tests), and is the half of this change that keeps
 * working if `featureIds` is ever made genuinely optional — at which point
 * `forEachBufferView`'s existing `ArrayBuffer.isView` guard already skips it
 * with no edit.
 *
 * The getter self-replaces with a plain data property on first read, so
 * repeat access is a normal field load and the closure — which pins the id
 * column — becomes collectable. The setter exists so ordinary assignment
 * keeps working; an accessor without one throws in strict mode.
 */
function defineLazyFeatureIds(
  features: BinaryFeatures,
  raw: BigUint64Array | Uint32Array | undefined,
  count: number,
): void {
  const pin = (target: BinaryFeatures, value: Uint32Array): void => {
    Object.defineProperty(target, 'featureIds', {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  };
  Object.defineProperty(features, 'featureIds', {
    configurable: true,
    enumerable: true,
    get(this: BinaryFeatures): Uint32Array {
      const value = materializeFeatureIds(raw, count);
      pin(this, value);
      return value;
    },
    set(this: BinaryFeatures, value: Uint32Array): void {
      pin(this, value);
    },
  });
}

/**
 * Relativise an absolute Unix-ms time column against `timeOffset` for f32
 * upload — the shared body of the `start_time` and `end_time` extraction.
 *
 * The `Int64` arm never boxes a `BigInt` (see {@link readInt64AsNumbers}):
 * 1.4 ns/elem against 14.7 for the `Number(bigint)` loop it replaces, which
 * is what pays for re-inflating the compact columns to `Int64` in the first
 * place. Narrower integer columns (hand-built fixtures, an `id`-only tile)
 * fall through to the generic `Number()` arm, and a missing or short column
 * leaves the tail zero-filled rather than `NaN`-filled.
 */
function relativeTimes(
  raw: BigInt64Array | Uint32Array | undefined,
  count: number,
  timeOffset: number,
): Float32Array {
  const out = new Float32Array(count);
  if (!raw) return out;
  const n = Math.min(count, raw.length);
  if (raw instanceof BigInt64Array && LITTLE_ENDIAN) {
    const halves = new Uint32Array(
      raw.buffer as ArrayBuffer,
      raw.byteOffset,
      raw.length * 2,
    );
    for (let i = 0; i < n; i++) {
      out[i] = (halves[i * 2 + 1] | 0) * TWO_32 + halves[i * 2] - timeOffset;
    }
  } else {
    for (let i = 0; i < n; i++) out[i] = Number(raw[i]) - timeOffset;
  }
  return out;
}

/** Convert one Arrow RecordBatch table into deck.gl binary features. */
function tableToBinaryFeatures(
  table: Table,
  meta: ResolvedTileMeta,
): BinaryFeatures {
  const kind = geometryKind(table);
  const featureCount = table.numRows;

  // --- ids ---
  // The archive's `id` column is UInt64. For raw tiles the lower 32 bits are
  // enough (we generate ids from a hash); for summary tiers the ID IS the
  // H3/Quadbin cell index, which at H3 resolutions ≥ 7 — and for every
  // Quadbin cell — does not fit in 32 bits. `featureIds64` therefore keeps
  // the column VERBATIM and is the only correct source for those consumers;
  // `featureIds` is the masked low-half mirror, built lazily. See
  // {@link materializeFeatureIds} for the exact contract (and for why
  // `Number(raw[i])` was wrong, not merely lossy) and
  // {@link defineLazyFeatureIds} for why it is deferred.
  const idVec = table.getChild('id');
  const rawIds = idVec
    ? (idVec.toArray() as BigUint64Array | Uint32Array)
    : undefined;
  // Copy so the slice into the Arrow buffer doesn't keep the IPC view alive
  // longer than the rest of the binary feature.
  const featureIds64 =
    rawIds instanceof BigUint64Array ? new BigUint64Array(rawIds) : undefined;

  // --- times (relativised to timeOffset for f32 precision) ---
  // ONE shape reaches here: absolute Unix-ms `Int64` columns, both present.
  // The compact `TILE_META.st` / `.et` forms have already been re-inflated to
  // it by {@link reinflateCoreTable}, at the table level, so this extractor
  // and the public `toGeoArrowTable()` can never disagree about a tile's
  // times. (A hand-built fixture may still hand us a narrower integer column;
  // {@link relativeTimes} tolerates that.)
  const startRaw = table.getChild('start_time')?.toArray() as
    | BigInt64Array
    | Uint32Array
    | undefined;
  const endRaw = table.getChild('end_time')?.toArray() as
    | BigInt64Array
    | Uint32Array
    | undefined;
  let timeOffset = 0;
  // Fast path: the resolved meta carries the baked global start-time min
  // (v1 `stt:time_offset_ms` / v2 `TILE_META.t0`), letting us skip the
  // min-scan pass over the whole start-time column. Absent (older tiles /
  // no start-time column) → fall back to the exact same min-scan as before.
  if (meta.timeOffset !== undefined) {
    timeOffset = meta.timeOffset;
  } else if (startRaw && startRaw.length > 0) {
    let min = Number(startRaw[0]);
    for (let i = 1; i < startRaw.length; i++) {
      const v = Number(startRaw[i]);
      if (v < min) min = v;
    }
    timeOffset = min;
  }
  const startTimes = relativeTimes(startRaw, featureCount, timeOffset);
  const endTimes = relativeTimes(endRaw, featureCount, timeOffset);

  // --- geometry ---
  const geomVec = table.getChild('geometry');
  if (!geomVec)
    throw new Error('STT tile layer is missing its geometry column');
  // Quantized tiles store i32 grid indices + an affine; reconstruct Float64
  // here so every downstream layer still sees standard lon/lat positions.
  const quantAffine = readQuantAffine(table);
  const {
    positions,
    startIndices,
    ringIndices,
    partIndices,
    positionDimensions,
  } = extractGeometry(
    geomVec,
    kind,
    quantAffine,
    // MultiPolygon part boundaries. The column is emitted only when some
    // feature really is multi-part, so its ABSENCE means every feature is
    // single-part (and `partIndices` would just repeat `startIndices`).
    kind === GeometryType.Polygon ? table.getChild('part_offsets') : null,
  );

  // --- per-vertex times ---
  // The u16-delta origin/step pair rides the resolved meta (v1 schema
  // metadata / v2 TILE_META `vt`); absent → (origin=0, step=1) so the
  // delta-vs-absolute branch still produces correct numbers (the Int64
  // path ignores both).
  const vertexTimestamps = extractVertexTimes(
    table.getChild('vertex_time') ?? null,
    timeOffset,
    meta.vertexTimeOrigin,
    meta.vertexTimeStep,
  );

  // --- per-vertex scalar values (e.g. SST) ---
  // Always a raw Float32/Float64 leaf here: the `TILE_META.vq` UInt16 shape
  // was re-inflated at the table level (see `reinflateQuantizedVertexValues`).
  const vertexValues = extractVertexFloats(
    table.getChild('vertex_value') ?? null,
  );

  // --- per-vertex × per-bucket value matrix (static-geometry overview) ---
  // Each feature's list is its flat vertex-major matrix (vertex_count *
  // numBuckets). extractVertexFloats concatenates features in the same order
  // as `positions`, so the result is globally vertex-major:
  // matrix[globalVertex * numBuckets + bucket]. The renderer selects the
  // active bucket column from the playhead. The bucket count rides the
  // resolved meta (v1 schema metadata / v2 TILE_META `vb`); absent → 0
  // (no matrix on this tile).
  const vertexValueMatrix = extractVertexFloats(
    table.getChild('vertex_value_matrix') ?? null,
  );
  const vertexValueBuckets = meta.vertexValueBuckets;

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
      // Feature-local indices are UInt16 when they fit (the common case —
      // halves this column's wire bytes) or UInt32 for oversized features;
      // the Rust encoder picks per-layer and the Arrow schema is
      // self-describing, so branch on the runtime child type exactly like
      // extractVertexTimes already does for its UInt16-delta/Int64 split.
      const triValues = triData.children[0].values as Uint16Array | Uint32Array;
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
  const vectorProps: BinaryFeatures['vectorProps'] = {};
  const reserved = new Set([
    'id',
    'start_time',
    'end_time',
    'geometry',
    'vertex_time',
    'vertex_value',
    'vertex_value_matrix',
    'triangles',
    // Consumed by `extractGeometry` above into `partIndices`. Listing it here
    // is what keeps an ADDITIVE reserved column from being misread as a
    // property: the numeric branch below would otherwise hand a `List<UInt32>`
    // to `Number(raw[i])` and publish a `numericProps.part_offsets` of NaNs.
    'part_offsets',
  ]);
  for (const field of table.schema.fields) {
    if (reserved.has(field.name)) continue;
    const vec = table.getChild(field.name);
    if (!vec) continue;
    const typeId = (field.type as any).typeId;
    if (typeId === ArrowType.FixedSizeList) {
      // Interleaved GPU-ready vector column (FixedSizeList<Float32|UInt8, N>):
      // the renderer binds the contiguous child buffer straight to a deck.gl
      // instanced attribute with no per-point re-interleave. Hand back the
      // child run zero-copy (a subarray into the decoded Arrow buffer — it
      // shares the IPC buffer the worker transfers, so it survives postMessage).
      const size = (field.type as any).listSize as number;
      const data = chunk(vec);
      const childValues = data.children[0].values as Float32Array | Uint8Array;
      const start = data.offset * size;
      const end = start + featureCount * size;
      vectorProps[field.name] = {
        value: childValues.subarray(start, end),
        size,
      };
      continue;
    }
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
      // Arrow returns an empty (byteLength=0) `nullBitmap` for columns with
      // no nulls — it's truthy but every byte read yields undefined, so a
      // naive `validity && bit === 0` check marks EVERY row null and the
      // category filter (e.g. heatmap pickup/dropoff filter) rejects all
      // features. Mirror Arrow's own `nullable` check: only inspect bits
      // when the buffer actually has content.
      const validity = data.nullBitmap;
      const hasValidity = validity && validity.byteLength > 0;
      for (let i = 0; i < featureCount; i++) {
        if (
          hasValidity &&
          (validity[(i + data.offset) >> 3] &
            (1 << ((i + data.offset) & 7))) ===
            0
        ) {
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
      // Numeric: f64 column down-converted to f32 for GPU upload. A column
      // with an attribute-quant affine (v1 `stt:qa` field metadata / v2
      // TILE_META `qa`, both resolved into `meta.qa`) ships as fixed-point
      // ints (UInt16/Int32); reconstruct `value = o + q*s` — mirrors
      // `arrow_tile.rs`'s `AttrQuant`, the property-column sibling of the
      // geometry coordinate quantization above.
      const qaAffine = meta.qa.get(field.name);
      const raw = vec.toArray() as
        | Float64Array
        | Float32Array
        | Uint16Array
        | Int32Array;
      if (
        !qaAffine &&
        raw instanceof Float32Array &&
        raw.length === featureCount
      ) {
        // Already the GPU upload type and no fixed-point affine to undo: hand
        // the Arrow buffer straight through, skipping the f64→f32 copy loop.
        // (It shares the IPC buffer the worker transfers, like `positions`.)
        numericProps[field.name] = raw;
      } else {
        const arr = new Float32Array(featureCount);
        if (qaAffine) {
          const { o, s } = qaAffine;
          for (let i = 0; i < featureCount; i++)
            arr[i] = o + Number(raw[i]) * s;
        } else {
          for (let i = 0; i < featureCount; i++) arr[i] = Number(raw[i]);
        }
        numericProps[field.name] = arr;
      }
    }
  }

  const features: BinaryFeatures = {
    featureCount,
    geometryType: kind,
    positionDimensions,
    positions,
    startIndices,
    ringIndices,
    partIndices,
    // Grid resolution the (already dequantized) coordinates snapped to, so
    // edge consumers know how far a builder-emitted vertex may sit from the
    // exact line it was clipped against. Undefined for Float64 layers.
    coordQuantStep: quantAffine
      ? ([quantAffine.sx, quantAffine.sy] as [number, number])
      : undefined,
    // Placeholder only — `defineLazyFeatureIds` below swaps in the memoising
    // accessor before this object escapes the function.
    featureIds: FEATURE_IDS_SEED,
    featureIds64,
    startTimes,
    endTimes,
    timeOffset,
    vertexTimestamps,
    vertexValues,
    vertexValueMatrix,
    vertexValueBuckets,
    triangles,
    triangleOffsets,
    numericProps,
    categoricalProps,
    vectorProps,
    timesSorted: meta.sorted,
  };
  // Derive the mirror from our own `featureIds64` copy when we made one, so
  // the deferred closure does not additionally pin the Arrow IPC view. (The
  // u32 fallback closes over the Arrow view, which is the same retention
  // `positions` already has on point tiles — and that branch is unreachable
  // for every archive the builder writes.)
  defineLazyFeatureIds(features, featureIds64 ?? rawIds, featureCount);
  return features;
}

/**
 * Decode an uncompressed tile payload into a {@link Tile}.
 *
 * Accepts both layer-frame shapes: the v1 frame (aligned and legacy,
 * byte-for-byte the pre-v2 path) and the v2 sectioned frame (leading
 * `0xFFFF` escape). Decoding a v2 frame that references templates by hash
 * needs the dataset's registry via `options.templates` — see
 * {@link DecodeTileOptions}.
 *
 * @param payload   The decompressed layer-frame bytes.
 * @param id        The tile identity.
 * @param timeRange The tile's temporal span (from the archive directory).
 *                  Optional: the worker / loaders.gl decode paths do not have
 *                  the archive directory available. When omitted it is
 *                  defaulted to a zero-width range at the tile's own `t`
 *                  timestamp — callers that need the precise span (the
 *                  `Archive` reader) always pass it explicitly.
 * @param options   v2 decode plumbing (template registry + the manifest's
 *                  declared formatVersion for the §5.2 authority check).
 */
export function decodeTile(
  payload: Uint8Array,
  id: TileId,
  timeRange: TimeRange = { start: id.t, end: id.t },
  options?: DecodeTileOptions,
): Tile {
  const tileKey = `${id.z}/${id.x}/${id.y}/${id.t}`;
  // The frame escape is defense-in-depth against a payload that is not a
  // layer frame at all (a truncated range read, a 404 body). The manifest's
  // `formatVersion` remains the authoritative discriminator (spec §5.2).
  if (
    payload.byteLength < 2 ||
    (payload[0] | (payload[1] << 8)) !== FRAME_V2_ESCAPE
  ) {
    throw new Error(
      `tile ${tileKey}: payload is not a layer frame (missing the frame escape)`,
    );
  }

  {
    const rawLayers = parseLayerFrameV2(payload, tileKey, options?.templates);
    const layers: STTTileLayer[] = rawLayers.map((raw) => {
      const coreTable = tableFromIPC(raw.coreIpc);
      // Eager PROPS materialization (this reader ships eager-only):
      // parse the PROPS batch now and merge its columns into
      // the core table's, so the section split is invisible downstream.
      // `mergeV2Layer` also re-inflates the TILE_META-declared column
      // re-typings and re-injects the hoisted metadata (v1 parity).
      const table = mergeV2Layer(
        coreTable,
        raw.propsIpc ? tableFromIPC(raw.propsIpc) : undefined,
        raw.tileMeta,
        `tile ${tileKey} layer '${raw.name}'`,
      );
      return {
        name: raw.name,
        extent: 0, // coordinates are real lon/lat; no quantization extent
        features: tableToBinaryFeatures(
          table,
          resolveMetaFromTileMeta(raw.tileMeta),
        ),
        geometryExtensionName: geometryExtensionName(table),
        coordinatesQuantized: readQuantAffine(table) !== undefined,
        // The merged (core + props) table — the v1-shaped GeoArrow hand-off.
        arrowTable: table,
        // The spliced core/props streams: what the worker path transfers and
        // `toGeoArrowTable()` rehydrates (re-merging) on the main thread.
        arrowIpc: raw.coreIpc,
        arrowIpcProps: raw.propsIpc,
        // The parsed TILE_META (plain JSON, structured-cloneable) so the
        // worker-path rehydrate re-injects the same metadata (see above).
        tileMeta: raw.tileMeta,
      };
    });
    return { id, timeRange, layers };
  }
}

/**
 * Test-only: run one layer's decode over an already-parsed Arrow
 * {@link Table}, skipping the layer frame — the exact pipeline
 * {@link decodeTile} runs per layer ({@link mergeV2Layer} →
 * `tableToBinaryFeatures`).
 *
 * It exists because the Arrow IPC writer NORMALIZES away shapes the decode
 * paths nevertheless have to tolerate: it rebases a list column's
 * `valueOffsets` to start at 0 and re-slices the child buffer to match, so a
 * chunk whose child run does NOT start at 0 — the case the
 * `childValues[base + i]` convention exists for — is simply unreachable from
 * a serialized fixture. Building the column `Data` by hand is the only way to
 * pin it. NOT re-exported from the package index (`src/tile.ts` is not a
 * public entry point); nothing outside `test/` may import it.
 */
export function _decodeTableForTest(
  table: Table,
  meta: TileMetaJson = {},
): BinaryFeatures {
  return tableToBinaryFeatures(
    mergeV2Layer(table, undefined, meta, 'test layer'),
    resolveMetaFromTileMeta(meta),
  );
}

/**
 * Decode ONE feature's property columns into a plain JS object — the
 * event-driven counterpart to the columnar {@link BinaryFeatures} layout.
 * The render path never materializes per-feature objects (that's the whole
 * point of binary tiles); this exists for the rare, user-initiated reads:
 * deck.gl picking (`info.object`), tooltips, debugging.
 *
 * The object carries every numeric and categorical column at `index`
 * (categorical nulls — the `0xffff` sentinel — decode to `null`), plus the
 * reserved columns reconstructed from their GPU encodings:
 *
 * - `id` — the feature id, read from `featureIds64` (the verbatim u64 column)
 *   whenever the decoder produced one, so H3 / Quadbin cell ids come back as
 *   the exact `bigint`. Only when it is absent do we fall back to the
 *   `featureIds` mirror, which is the MASKED low 32 bits and therefore a
 *   valid identity solely for ids that fit in 32 bits — see
 *   {@link materializeFeatureIds}. This ordering is the reason a picking
 *   tooltip on a summary tier shows the real cell rather than a truncation.
 * - `start_time` / `end_time` — absolute Unix ms (`timeOffset + relative`).
 *   The relative times are stored as f32, so on datasets spanning years the
 *   reconstruction is quantized to tens of ms — fine for display.
 *
 * Reserved column names can never collide with dataset properties: the
 * decoder excludes them from `numericProps`/`categoricalProps`.
 *
 * Returns `null` for an out-of-range index (e.g. a stale picking buffer).
 */
export function getFeatureProperties(
  features: BinaryFeatures,
  index: number,
): Record<string, unknown> | null {
  if (!Number.isInteger(index) || index < 0 || index >= features.featureCount) {
    return null;
  }
  const props: Record<string, unknown> = {
    // `featureIds64` first — see the doc above. Reading it also avoids
    // FORCING the lazy `featureIds` accessor on summary tiles, where the
    // mirror would be built only to be discarded. The optional chain on the
    // mirror is defensive rather than decorative: hand-built BinaryFeatures
    // (synthetic layers, fixtures) legitimately omit both id columns, and an
    // `undefined` id beats a TypeError inside a picking callback.
    id: features.featureIds64
      ? features.featureIds64[index]
      : features.featureIds?.[index],
    start_time: features.timeOffset + features.startTimes[index],
    end_time: features.timeOffset + features.endTimes[index],
  };
  for (const [name, values] of Object.entries(features.numericProps)) {
    props[name] = values[index];
  }
  for (const [name, { value, size }] of Object.entries(
    features.vectorProps ?? {},
  )) {
    // Materialise the feature's component slice as a plain array (picking /
    // tooltip path only — the render path binds the contiguous buffer instead).
    props[name] = Array.from(value.subarray(index * size, index * size + size));
  }
  for (const [name, { indices, categories }] of Object.entries(
    features.categoricalProps,
  )) {
    const ci = indices[index];
    props[name] = ci === 0xffff ? null : categories[ci];
  }
  return props;
}

/**
 * Return an Arrow {@link Table} that is a valid GeoArrow record batch — i.e.
 * the `geometry` field carries the `ARROW:extension:name` metadata key with
 * a value of `geoarrow.point`, `geoarrow.linestring`, or `geoarrow.polygon`.
 *
 * Intended hand-off into `@geoarrow/deck.gl-layers`:
 *
 * ```ts
 * import { GeoArrowPathLayer } from '@geoarrow/deck.gl-layers';
 * const table = toGeoArrowTable(tile.layers[0]);
 * new GeoArrowPathLayer({ id: 'paths', data: table, getPath: table.getChild('geometry')! });
 * ```
 *
 * The returned `Table` shares buffers with the decoded tile — do not mutate
 * it or hold onto it past the tile's lifetime. If the layer was constructed
 * without a backing Arrow `Table` (e.g. synthetic test data) this throws.
 *
 * @see https://geoarrow.org/format.html
 */
export function toGeoArrowTable(layer: STTTileLayer): Table {
  let table = layer.arrowTable;
  if (!table && layer.arrowIpc) {
    // Worker-decoded tiles arrive without the (non-cloneable) Table but
    // with the layer's raw IPC bytes; rehydrate on first use and memoize
    // so repeat calls don't re-parse. v2 layers with property columns carry
    // TWO streams (spliced core + props) — re-merge them through the SAME
    // `mergeV2Layer` the inline decode uses, re-inflating the compact column
    // encodings and re-injecting the layer's TILE_META (`layer.tileMeta`
    // rides postMessage as plain JSON), so the rehydrated table matches the
    // inline-decoded shape exactly.
    table = mergeV2Layer(
      tableFromIPC(layer.arrowIpc),
      layer.arrowIpcProps ? tableFromIPC(layer.arrowIpcProps) : undefined,
      layer.tileMeta ?? {},
      `STT layer '${layer.name}'`,
    );
    layer.arrowTable = table;
  }
  if (!table) {
    if (layer.arrowIpcDropped) {
      throw new Error(
        `STT layer '${layer.name}': the raw Arrow IPC bytes were dropped to save ` +
          "memory (ArchiveOptions.retainArrowIpc, default 'auto') — construct the " +
          'archive with retainArrowIpc: true to keep them for toGeoArrowTable().',
      );
    }
    throw new Error(
      `STT layer '${layer.name}' has no backing Arrow Table — toGeoArrowTable() ` +
        'only works for layers produced by decodeTile().',
    );
  }
  // Older archives wrote the extension name into schema metadata
  // (`stt:geometry`) but left the geometry FIELD bare. GeoArrow consumers
  // look at the field, so patch it on the way out when needed. We rebuild
  // the schema rather than mutate it in place — `apache-arrow`'s Field
  // metadata is frozen on a Table instance shared across tiles.
  const geomIdx = table.schema.fields.findIndex((f) => f.name === 'geometry');
  if (geomIdx < 0) return table;
  const geomField = table.schema.fields[geomIdx];
  if (geomField.metadata.get(GEOARROW_EXT_KEY)) return table;
  const fallback = table.schema.metadata.get('stt:geometry');
  if (!fallback) return table;

  // Rebuild the Schema with a patched geometry field; reuse the existing
  // record-batch Data objects so this stays a zero-copy view.
  const patched = geomField.clone({
    metadata: new Map([...geomField.metadata, [GEOARROW_EXT_KEY, fallback]]),
  });
  const fields = table.schema.fields.slice();
  fields[geomIdx] = patched;
  const newSchema = new Schema(
    fields,
    table.schema.metadata,
    table.schema.dictionaries,
  );
  const newBatches = table.batches.map(
    (b) => new RecordBatch(newSchema, b.data),
  );
  return new Table(newSchema, newBatches);
}
