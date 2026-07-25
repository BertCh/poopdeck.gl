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
  makeData,
  RecordBatch,
  Schema,
  Struct,
  Table,
  tableFromIPC,
  Type as ArrowType,
  type Field,
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

/** One layer extracted from the payload frame. */
interface RawLayer {
  name: string;
  ipc: Uint8Array;
}

/** Top bit of the frame's leading u16: marks the 8-byte-aligned frame. */
const ALIGNED_FRAME_FLAG = 0x8000;

/** Parse the layer frame into its constituent Arrow IPC streams. */
function parseLayerFrame(payload: Uint8Array): RawLayer[] {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
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
  const rawCount = readU16();
  const aligned = (rawCount & ALIGNED_FRAME_FLAG) !== 0;
  const count = rawCount & ~ALIGNED_FRAME_FLAG;
  const layers: RawLayer[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = readU16();
    const name = new TextDecoder().decode(readBytes(nameLen));
    const ipcLen = readU32();
    // Aligned frames pad the IPC stream to an 8-byte boundary (relative to
    // the payload start); the pad is derived, never stored. Legacy frames
    // (flag unset) have no padding.
    if (aligned) pos += (8 - (pos & 7)) & 7;
    const ipc = readBytes(ipcLen);
    layers.push({ name, ipc });
  }
  return layers;
}

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

/** Extract interleaved positions + per-feature start indices from geometry. */
function extractGeometry(
  geomVec: Vector,
  kind: GeometryType,
  affine?: QuantAffine,
): {
  positions: Float64Array;
  startIndices?: Uint32Array;
  ringIndices?: Uint32Array;
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
  return { positions, startIndices, ringIndices, positionDimensions: 2 };
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

/**
 * Extract the per-vertex scalar column (`vertex_value`, a `List<Float32>`)
 * into a flat `Float32Array` aligned 1:1 with `positions`. Unlike vertex
 * times there's no delta/origin/step encoding — values are stored verbatim.
 * `NaN` entries mark vertices with no value (rendered with a fallback color).
 */
function extractVertexFloats(vec: Vector | null): Float32Array | undefined {
  if (!vec) return undefined;
  const data = chunk(vec);
  const offsets: Int32Array = data.valueOffsets;
  const childValues = data.children[0].values as Float32Array | Float64Array;
  const base = offsets[data.offset];
  const total = offsets[data.offset + data.length] - base;
  const out = new Float32Array(total);
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

/**
 * Resolve the per-tile metadata from a v1 layer's Arrow schema — the exact
 * reads `tableToBinaryFeatures` historically did inline, hoisted so v1 and
 * v2 converge on {@link ResolvedTileMeta} before extraction.
 */
function resolveMetaFromSchema(table: Table): ResolvedTileMeta {
  // Fast path: the builder can bake the global start-time min into schema
  // metadata (`stt:time_offset_ms`), letting the extractor skip the min-scan
  // pass over the whole start-time column. Absent (older tiles / builder not
  // yet emitting it) → undefined → the extractor's min-scan fallback.
  const baked = table.schema.metadata.get('stt:time_offset_ms');
  const timeOffset =
    baked != null && baked !== '' ? Number(BigInt(baked)) : undefined;

  const qa = new Map<string, { o: number; s: number }>();
  for (const field of table.schema.fields) {
    const qaRaw = field.metadata.get(STT_QUANT_ATTR_META_KEY);
    if (!qaRaw) continue;
    try {
      const parsed = JSON.parse(qaRaw);
      qa.set(field.name, { o: parsed.o, s: parsed.s });
    } catch (err) {
      // Malformed affine — record identity (o=0,s=1) so the column decodes
      // as raw fixed-point ints, mirroring the pre-resolve behavior.
      warnMalformedQuantMetaOnce(
        `${STT_QUANT_ATTR_META_KEY}:${field.name}`,
        `[stt] malformed ${STT_QUANT_ATTR_META_KEY} affine JSON on property ` +
          `column "${field.name}" — values will decode as raw fixed-point ints:`,
        err,
      );
      qa.set(field.name, { o: 0, s: 1 });
    }
  }

  // v3 layers carry the origin/step pair as schema metadata; v2 layers (and
  // v3 layers with the i64 fallback) leave them absent, which we treat as
  // (origin=0, step=1) so the delta-vs-absolute branch still produces
  // correct numbers (the Int64 path ignores both).
  return {
    timeOffset,
    vertexTimeOrigin: Number(
      table.schema.metadata.get('stt:vertex_time_origin_ms') ?? 0,
    ),
    vertexTimeStep: Number(
      table.schema.metadata.get('stt:vertex_time_step_ms') ?? 1,
    ),
    vertexValueBuckets: Number(
      table.schema.metadata.get('stt:vertex_value_buckets') ?? 0,
    ),
    qa,
  };
}

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

/**
 * Merge a v2 layer's decoded CORE and PROPS tables back into ONE table —
 * the v1-shaped record batch every consumer downstream of decode sees, so
 * the core/props section split stays invisible (design §4.1). Zero-copy:
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

/** Convert one Arrow RecordBatch table into deck.gl binary features. */
function tableToBinaryFeatures(
  table: Table,
  meta: ResolvedTileMeta,
): BinaryFeatures {
  const kind = geometryKind(table);
  const featureCount = table.numRows;

  // --- ids ---
  const idVec = table.getChild('id');
  const featureIds = new Uint32Array(featureCount);
  // The archive's `id` column is UInt64. For raw tiles, the lower 32 bits
  // are always sufficient (we generate IDs from a hash); for summary tiles
  // the ID IS the H3/quadbin cell index, which at H3 resolutions ≥ 7 does
  // not fit in 32 bits. We preserve the full BigUint64Array verbatim on
  // `featureIds64` so the H3SummaryLayer can recover the original cell.
  let featureIds64: BigUint64Array | undefined;
  if (idVec) {
    const raw = idVec.toArray() as BigUint64Array | Uint32Array;
    if (raw instanceof BigUint64Array) {
      // Copy so the slice into the Arrow buffer doesn't keep the IPC view
      // alive longer than the rest of the binary feature.
      featureIds64 = new BigUint64Array(raw);
    }
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
  const startTimes = new Float32Array(featureCount);
  const endTimes = new Float32Array(featureCount);
  for (let i = 0; i < featureCount; i++) {
    startTimes[i] = startRaw ? Number(startRaw[i]) - timeOffset : 0;
    endTimes[i] = endRaw ? Number(endRaw[i]) - timeOffset : 0;
  }

  // --- geometry ---
  const geomVec = table.getChild('geometry');
  if (!geomVec)
    throw new Error('STT tile layer is missing its geometry column');
  // Quantized tiles store i32 grid indices + an affine; reconstruct Float64
  // here so every downstream layer still sees standard lon/lat positions.
  const quantAffine = readQuantAffine(table);
  const { positions, startIndices, ringIndices, positionDimensions } =
    extractGeometry(geomVec, kind, quantAffine);

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

  return {
    featureCount,
    geometryType: kind,
    positionDimensions,
    positions,
    startIndices,
    ringIndices,
    // Grid resolution the (already dequantized) coordinates snapped to, so
    // edge consumers know how far a builder-emitted vertex may sit from the
    // exact line it was clipped against. Undefined for Float64 layers.
    coordQuantStep: quantAffine
      ? ([quantAffine.sx, quantAffine.sy] as [number, number])
      : undefined,
    featureIds,
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
  const isV2 =
    payload.byteLength >= 2 &&
    (payload[0] | (payload[1] << 8)) === FRAME_V2_ESCAPE;
  // Authority rule (spec §5.2): `manifest.formatVersion` is the
  // discriminator; the frame escape is defense-in-depth. A mixed-version
  // dataset is corrupt/misassembled and MUST fail loudly, not decode.
  const declared = options?.formatVersion;
  if (declared !== undefined) {
    if (declared === 1 && isV2) {
      throw new Error(
        `tile ${tileKey}: v2 layer frame reached through a formatVersion-1 manifest ` +
          '(mixed-version dataset — spec §5.2 authority rule)',
      );
    }
    if (declared === 2 && !isV2) {
      throw new Error(
        `tile ${tileKey}: v1 layer frame reached through a formatVersion-2 manifest ` +
          '(mixed-version dataset — spec §5.2 authority rule)',
      );
    }
  }

  if (isV2) {
    const rawLayers = parseLayerFrameV2(payload, tileKey, options?.templates);
    const layers: STTTileLayer[] = rawLayers.map((raw) => {
      const coreTable = tableFromIPC(raw.coreIpc);
      // Eager PROPS materialization (design §4.1 — this reader ships
      // eager-only): parse the PROPS batch now and merge its columns into
      // the core table's, so the section split is invisible downstream.
      // Both paths re-inject the TILE_META-hoisted metadata (v1 parity).
      const table = raw.propsIpc
        ? mergeCorePropsTables(
            coreTable,
            tableFromIPC(raw.propsIpc),
            raw.tileMeta,
            `tile ${tileKey} layer '${raw.name}'`,
          )
        : injectTileMetaIntoCoreTable(coreTable, raw.tileMeta);
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

  const rawLayers = parseLayerFrame(payload);
  const layers: STTTileLayer[] = rawLayers.map((raw) => {
    const table = tableFromIPC(raw.ipc);
    return {
      name: raw.name,
      extent: 0, // coordinates are real lon/lat; no quantization extent
      features: tableToBinaryFeatures(table, resolveMetaFromSchema(table)),
      // Standard GeoArrow extension name (e.g. `geoarrow.point`). Surfaced
      // so a GeoArrow-aware consumer can branch on it without looking at
      // the Arrow schema directly.
      geometryExtensionName: geometryExtensionName(table),
      // Coordinate quantization (`stt:quant`) makes the layer no longer
      // literal GeoArrow — the semantic signal `retainArrowIpc: 'auto'`
      // keys on.
      coordinatesQuantized: readQuantAffine(table) !== undefined,
      // Hold the underlying Arrow Table so `toGeoArrowTable()` is a
      // zero-copy hand-off into `@geoarrow/deck.gl-layers` / Lonboard.
      arrowTable: table,
      // Also hold the raw IPC bytes: the worker decode path strips the
      // non-cloneable Table before postMessage, and these bytes are what
      // `toGeoArrowTable()` rehydrates from on the main thread.
      arrowIpc: raw.ipc,
    };
  });
  return { id, timeRange, layers };
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
 * - `id` — the feature id; the full 64-bit value (bigint) when the archive
 *   needed one (e.g. H3 cell indices at res ≥ 7), else the 32-bit number.
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
    id: features.featureIds64
      ? features.featureIds64[index]
      : features.featureIds[index],
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
    // TWO streams (spliced core + props) — re-merge them, re-injecting the
    // layer's TILE_META (`layer.tileMeta` rides postMessage as plain JSON),
    // so the rehydrated table matches the inline-decoded shape exactly.
    table = tableFromIPC(layer.arrowIpc);
    if (layer.arrowIpcProps) {
      table = mergeCorePropsTables(
        table,
        tableFromIPC(layer.arrowIpcProps),
        layer.tileMeta ?? {},
        `STT layer '${layer.name}'`,
      );
    } else if (layer.tileMeta) {
      table = injectTileMetaIntoCoreTable(table, layer.tileMeta);
    }
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
