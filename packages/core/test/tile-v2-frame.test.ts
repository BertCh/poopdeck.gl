/**
 * Layer frame v2 (packed spec §5.2) — decoder unit suite over TS-synthesized
 * frames. Covers what the committed Rust fixtures can't hit case-by-case:
 * the normative splice guards (§5.2.1 — stray zeros MUST error loudly, never
 * decode as a silently-EMPTY tile), unknown-tag TOC skipping, TILE_META
 * sourcing (t0/qa/sorted + fallbacks), inline vs hash-referencing schema
 * refs and their registry failure modes, the §5.2 authority rule, and the
 * empty-bucket tile (0 rows with a dictionary column — the shape the Rust
 * writer emits per `crates/stt-core/tests/v1_golden.rs`; stt-build's tiler
 * never emits empty tiles, so this path is synthesized here).
 *
 * Cross-impl truth for REAL writer bytes lives in packed-v2-golden.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  Dictionary,
  Field,
  FixedSizeList,
  Float64,
  Int64,
  RecordBatch,
  Schema,
  Struct,
  Table,
  Uint16,
  Uint64,
  Utf8,
  makeData,
  makeVector,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';
import { decodeTile, type TemplateRegistry } from '../src/tile';
import { GeometryType, type TileId } from '../src/types';
import { frameFromIpc } from './helpers/fixtures';
import {
  buildV2Frame,
  REF_KIND_INLINE,
  REF_KIND_NO_PROPS,
  REF_KIND_TEMPLATE_HASH,
  SECTION_CORE_BATCH,
  SECTION_INLINE_SCHEMA_CORE,
  SECTION_INLINE_SCHEMA_PROPS,
  SECTION_PROPS_BATCH,
  SECTION_TILE_META,
  splitIpcTemplate,
  templateHashBytes,
  templateHashHex,
  tileMetaBytes,
  type V2LayerSpec,
} from './helpers/v2-frame';

const tileId: TileId = { z: 3, x: 1, y: 2, t: 5000 };
const TILE_KEY = '3/1/2/5000';

/** Core batch: id / start_time / end_time / Float64 point geometry. */
function coreIpc(n: number, baseTime = 1_700_000_000_000): Uint8Array {
  const coordValues = makeData({
    type: new Float64(),
    data: Float64Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? -122.4 + i : 37.7)),
  });
  const geomData = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: n,
    nullCount: 0,
    child: coordValues,
  });
  const fields = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field(
      'geometry',
      geomData.type,
      false,
      new Map([['ARROW:extension:name', 'geoarrow.point']]),
    ),
  ];
  const schema = new Schema(fields);
  const struct = makeData({
    type: new Struct(fields),
    length: n,
    nullCount: 0,
    children: [
      makeData({
        type: new Uint64(),
        length: n,
        data: BigUint64Array.from({ length: n }, (_, i) => BigInt(100 + i)),
      }),
      makeData({
        type: new Int64(),
        length: n,
        data: BigInt64Array.from({ length: n }, (_, i) => BigInt(baseTime + i * 1000)),
      }),
      makeData({
        type: new Int64(),
        length: n,
        data: BigInt64Array.from({ length: n }, (_, i) => BigInt(baseTime + i * 1000 + 500)),
      }),
      geomData,
    ],
  });
  return tableToIPC(new Table([new RecordBatch(schema, struct as never)]), 'stream');
}

/**
 * Props batch: quantized-UInt16 `speed` (affine rides TILE_META `qa`, NOT
 * the schema — v2 templates are dataset-constant) + dictionary `kind`.
 */
function propsIpc(n: number): Uint8Array {
  const cats = ['car', 'bus', 'tram'];
  const speed = makeVector(Uint16Array.from({ length: n }, (_, i) => i * 10));
  const kind = vectorFromArray(
    Array.from({ length: n }, (_, i) => cats[i % cats.length]),
    new Dictionary(new Utf8(), new Uint16()),
  );
  return tableToIPC(new Table({ speed, kind }), 'stream');
}

/** Standard inline-schema single-layer frame (the self-contained mode). */
function inlineFrame(
  n = 3,
  overrides: Partial<{
    tileMeta: Uint8Array | null;
    coreTail: Uint8Array;
    coreTemplate: Uint8Array;
    extraSections: Array<[number, Uint8Array]>;
    refProps: V2LayerSpec['refProps'];
    propsSections: boolean;
  }> = {},
): Uint8Array {
  const core = splitIpcTemplate(coreIpc(n));
  const props = splitIpcTemplate(propsIpc(n));
  const meta =
    overrides.tileMeta === undefined
      ? tileMetaBytes({
          qa: { speed: [0, 0.25] },
          sorted: true,
          t0: 1_700_000_000_000,
        })
      : overrides.tileMeta;
  const sections: Array<[number, Uint8Array]> = [
    [SECTION_INLINE_SCHEMA_CORE, overrides.coreTemplate ?? core.template],
  ];
  if (meta !== null) sections.push([SECTION_TILE_META, meta]);
  sections.push([SECTION_CORE_BATCH, overrides.coreTail ?? core.tail]);
  const withProps = overrides.propsSections ?? true;
  if (withProps) {
    sections.push([SECTION_INLINE_SCHEMA_PROPS, props.template]);
    sections.push([SECTION_PROPS_BATCH, props.tail]);
  }
  for (const extra of overrides.extraSections ?? []) sections.push(extra);
  return buildV2Frame([
    {
      name: 'default',
      refCore: { kind: REF_KIND_INLINE },
      refProps: overrides.refProps ?? (withProps ? { kind: REF_KIND_INLINE } : { kind: REF_KIND_NO_PROPS }),
      sections,
    },
  ]);
}

/** Prefix `bytes` with `count` zero bytes (the spike's stray-zero hazard). */
function zeroPrefixed(bytes: Uint8Array, count = 4): Uint8Array {
  const out = new Uint8Array(bytes.length + count);
  out.set(bytes, count);
  return out;
}

describe('layer frame v2: decode', () => {
  it('decodes an inline-schema frame without any registry (points + props)', () => {
    const tile = decodeTile(inlineFrame(3), tileId);
    expect(tile.layers).toHaveLength(1);
    const f = tile.layers[0].features;
    expect(f.featureCount).toBe(3);
    expect(f.geometryType).toBe(GeometryType.Point);
    // t0 sourced from TILE_META (no schema copy exists in v2).
    expect(f.timeOffset).toBe(1_700_000_000_000);
    expect(Array.from(f.startTimes)).toEqual([0, 1000, 2000]);
    // qa affine sourced from TILE_META: value = 0 + q*0.25 over q = i*10.
    expect(Array.from(f.numericProps.speed)).toEqual([0, 2.5, 5]);
    // PROPS merge is invisible: categorical rides the same BinaryFeatures.
    const kind = f.categoricalProps.kind;
    const decoded = Array.from(kind.indices).map((i) => kind.categories[i]);
    expect(decoded).toEqual(['car', 'bus', 'tram']);
    // §5.2.3 sortedness flag.
    expect(f.timesSorted).toBe(true);
    // The GeoArrow hand-off table is the MERGED core+props shape.
    expect(tile.layers[0].arrowTable!.numRows).toBe(3);
    expect(tile.layers[0].arrowTable!.schema.fields.map((x) => x.name)).toEqual([
      'id', 'start_time', 'end_time', 'geometry', 'speed', 'kind',
    ]);
    expect(tile.layers[0].arrowIpcProps).toBeInstanceOf(Uint8Array);
    // TILE_META re-injection (merge_v2_layer parity): the hand-off schema
    // carries the v1 stt:* keys — schema-level t0 and per-field stt:qa in
    // the exact v1 formatting (Rust {:.17e}).
    const schema = tile.layers[0].arrowTable!.schema;
    expect(schema.metadata.get('stt:time_offset_ms')).toBe('1700000000000');
    expect(
      schema.fields.find((f) => f.name === 'speed')!.metadata.get('stt:qa'),
    ).toBe('{"o":0.00000000000000000e0,"s":2.50000000000000000e-1}');
    // The parsed TILE_META rides the layer (worker rehydrate parity).
    expect(tile.layers[0].tileMeta).toEqual({
      qa: { speed: [0, 0.25] },
      sorted: true,
      t0: 1_700_000_000_000,
    });
  });

  it('decodes a hash-referencing frame through the template registry, identically to inline', () => {
    const core = splitIpcTemplate(coreIpc(3));
    const props = splitIpcTemplate(propsIpc(3));
    const templates: TemplateRegistry = new Map([
      [templateHashHex(core.template), core.template],
      [templateHashHex(props.template), props.template],
    ]);
    const frame = buildV2Frame([
      {
        name: 'default',
        refCore: { kind: REF_KIND_TEMPLATE_HASH, hash: templateHashBytes(core.template) },
        refProps: { kind: REF_KIND_TEMPLATE_HASH, hash: templateHashBytes(props.template) },
        sections: [
          [SECTION_TILE_META, tileMetaBytes({ qa: { speed: [0, 0.25] }, sorted: true, t0: 1_700_000_000_000 })],
          [SECTION_CORE_BATCH, core.tail],
          [SECTION_PROPS_BATCH, props.tail],
        ],
      },
    ]);
    const viaHash = decodeTile(frame, tileId, undefined, { templates });
    const viaInline = decodeTile(inlineFrame(3), tileId);
    const a = viaHash.layers[0].features;
    const b = viaInline.layers[0].features;
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.numericProps.speed)).toEqual(Array.from(b.numericProps.speed));
    expect(a.categoricalProps.kind.categories).toEqual(b.categoricalProps.kind.categories);
  });

  it('decodes the empty-bucket tile: 0 rows with the dictionary column intact', () => {
    const tile = decodeTile(inlineFrame(0, { tileMeta: tileMetaBytes({ sorted: true }) }), tileId);
    const f = tile.layers[0].features;
    expect(f.featureCount).toBe(0);
    expect(f.positions.length).toBe(0);
    // The dictionary column survives at n=0 — schema-complete, no rows.
    expect(f.categoricalProps.kind).toBeDefined();
    expect(f.categoricalProps.kind.indices.length).toBe(0);
    expect(f.numericProps.speed.length).toBe(0);
  });

  it('falls back to the start-time min-scan when TILE_META is absent', () => {
    const tile = decodeTile(inlineFrame(3, { tileMeta: null }), tileId);
    const f = tile.layers[0].features;
    // min-scan over start_time (base 1_700_000_000_000) — same offset as
    // the baked path, derived instead of declared.
    expect(f.timeOffset).toBe(1_700_000_000_000);
    expect(f.timesSorted).toBeUndefined();
    // No qa key → the UInt16 speed column decodes as raw fixed-point ints.
    expect(Array.from(f.numericProps.speed)).toEqual([0, 10, 20]);
  });

  it('skips unknown section tags via the TOC (additive evolution)', () => {
    const frame = inlineFrame(3, {
      extraSections: [[0x7f, Uint8Array.from([9, 9, 9, 9, 9])]],
    });
    const tile = decodeTile(frame, tileId);
    expect(tile.layers[0].features.featureCount).toBe(3);
  });
});

describe('layer frame v2: splice guards (§5.2.1 — never a silent empty tile)', () => {
  it('rejects a CORE_BATCH section with a stray-zero prefix, naming the tile', () => {
    const core = splitIpcTemplate(coreIpc(3));
    const frame = inlineFrame(3, { coreTail: zeroPrefixed(core.tail) });
    expect(() => decodeTile(frame, tileId)).toThrow(
      new RegExp(`tile ${TILE_KEY} layer 'default' core.*0xFFFFFFFF continuation`),
    );
  });

  it('rejects a corrupt (zeroed) schema template, naming the tile', () => {
    const core = splitIpcTemplate(coreIpc(3));
    expect(() =>
      decodeTile(inlineFrame(3, { coreTemplate: zeroPrefixed(core.template) }), tileId),
    ).toThrow(new RegExp(`tile ${TILE_KEY} layer 'default' core.*template`));
  });

  it('splices exactly the TOC-declared lengths (a well-formed frame with trailing junk after the last pad still decodes)', () => {
    // The frame builder pads to 8 after the last section; append garbage
    // beyond it — the TOC-driven walk must never read past declared lengths.
    const frame = inlineFrame(3);
    const withJunk = new Uint8Array(frame.length + 16);
    withJunk.set(frame, 0);
    withJunk.fill(0xab, frame.length);
    const tile = decodeTile(withJunk, tileId);
    expect(tile.layers[0].features.featureCount).toBe(3);
  });
});

describe('layer frame v2: registry failure modes (never silently empty)', () => {
  function hashFrame(): { frame: Uint8Array; coreTemplate: Uint8Array } {
    const core = splitIpcTemplate(coreIpc(2));
    return {
      coreTemplate: core.template,
      frame: buildV2Frame([
        {
          name: 'default',
          refCore: { kind: REF_KIND_TEMPLATE_HASH, hash: templateHashBytes(core.template) },
          refProps: { kind: REF_KIND_NO_PROPS },
          sections: [[SECTION_CORE_BATCH, core.tail]],
        },
      ]),
    };
  }

  it('errors descriptively when NO registry is available', () => {
    const { frame } = hashFrame();
    expect(() => decodeTile(frame, tileId)).toThrow(/no template registry is available/);
    expect(() => decodeTile(frame, tileId)).toThrow(new RegExp(TILE_KEY));
  });

  it('errors descriptively when the referenced hash is absent from the registry', () => {
    const { frame, coreTemplate } = hashFrame();
    const templates: TemplateRegistry = new Map([['00'.repeat(16), coreTemplate]]);
    expect(() => decodeTile(frame, tileId, undefined, { templates })).toThrow(
      new RegExp(`${templateHashHex(coreTemplate)}.*not in the dataset's registry`),
    );
  });
});

describe('layer frame v2: malformed frames', () => {
  it('rejects a non-zero reserved flags byte', () => {
    const core = splitIpcTemplate(coreIpc(1));
    const frame = buildV2Frame(
      [{ name: 'x', refCore: { kind: REF_KIND_INLINE }, refProps: { kind: REF_KIND_NO_PROPS },
         sections: [[SECTION_INLINE_SCHEMA_CORE, core.template], [SECTION_CORE_BATCH, core.tail]] }],
      { flags: 1 },
    );
    expect(() => decodeTile(frame, tileId)).toThrow(/reserved v2 layer-frame flags/);
  });

  it('rejects an unknown frame_version', () => {
    const frame = buildV2Frame([], { frameVersion: 3 });
    expect(() => decodeTile(frame, tileId)).toThrow(/unsupported layer-frame version 3/);
  });

  it('rejects an unknown schema ref_kind', () => {
    const frame = Uint8Array.from(inlineFrame(1));
    // Byte layout: escape(2) version(1) flags(1) count(2) nameLen(2) name(7)
    // → ref_kind_core at offset 15 for name 'default'.
    frame[15] = 7;
    expect(() => decodeTile(frame, tileId)).toThrow(/unknown schema ref_kind 7/);
  });

  it('rejects ref_kind_core = 2 (every layer has a CORE batch)', () => {
    const frame = Uint8Array.from(inlineFrame(1));
    frame[15] = REF_KIND_NO_PROPS;
    expect(() => decodeTile(frame, tileId)).toThrow(/ref_kind_core 2 is invalid/);
  });

  it('rejects a duplicate section tag', () => {
    const core = splitIpcTemplate(coreIpc(1));
    const frame = buildV2Frame([
      { name: 'default', refCore: { kind: REF_KIND_INLINE }, refProps: { kind: REF_KIND_NO_PROPS },
        sections: [
          [SECTION_INLINE_SCHEMA_CORE, core.template],
          [SECTION_CORE_BATCH, core.tail],
          [SECTION_CORE_BATCH, core.tail],
        ] },
    ]);
    expect(() => decodeTile(frame, tileId)).toThrow(/duplicate section tag 0x3/);
  });

  it('rejects a PROPS_BATCH section under ref_kind_props = 2', () => {
    const props = splitIpcTemplate(propsIpc(1));
    const frame = inlineFrame(1, {
      propsSections: false,
      refProps: { kind: REF_KIND_NO_PROPS },
      extraSections: [[SECTION_PROPS_BATCH, props.tail]],
    });
    expect(() => decodeTile(frame, tileId)).toThrow(/PROPS_BATCH section present but ref_kind_props/);
  });

  it('rejects a frame with no CORE_BATCH section', () => {
    const core = splitIpcTemplate(coreIpc(1));
    const frame = buildV2Frame([
      { name: 'default', refCore: { kind: REF_KIND_INLINE }, refProps: { kind: REF_KIND_NO_PROPS },
        sections: [[SECTION_INLINE_SCHEMA_CORE, core.template]] },
    ]);
    expect(() => decodeTile(frame, tileId)).toThrow(/CORE_BATCH section missing/);
  });

  it('rejects malformed TILE_META JSON, naming the layer', () => {
    const frame = inlineFrame(1, { tileMeta: new TextEncoder().encode('{nope') });
    expect(() => decodeTile(frame, tileId)).toThrow(/layer 'default': TILE_META JSON decode failed/);
  });

  it('rejects a truncated frame instead of over-reading', () => {
    const frame = inlineFrame(2);
    expect(() => decodeTile(frame.subarray(0, 40), tileId)).toThrow(/truncated/);
  });

  describe('TILE_META shape validation (spec §5.2.2 — parseable-but-malformed must throw, never NaN)', () => {
    /** Decode a frame whose TILE_META is the given (valid JSON) value. */
    const decodeWithMeta = (metaJson: string) => () =>
      decodeTile(inlineFrame(1, { tileMeta: new TextEncoder().encode(metaJson) }), tileId);
    const named = (keyPattern: string) =>
      new RegExp(`tile ${TILE_KEY} layer 'default': malformed TILE_META — ${keyPattern}`);

    it('rejects a non-object section (valid JSON, wrong shape)', () => {
      expect(decodeWithMeta('[1,2]')).toThrow(named('the section must be a JSON object'));
      expect(decodeWithMeta('null')).toThrow(named('the section must be a JSON object'));
      expect(decodeWithMeta('42')).toThrow(named('the section must be a JSON object'));
    });

    it("rejects a non-finite / non-numeric 't0'", () => {
      expect(decodeWithMeta('{"t0":"soon"}')).toThrow(named("'t0' must be a finite number"));
      // 1e999 is valid JSON that parses to Infinity — finite-or-absent.
      expect(decodeWithMeta('{"t0":1e999}')).toThrow(named("'t0' must be a finite number"));
    });

    it("rejects a malformed 'vt' (wrong arity, wrong element types, non-array)", () => {
      expect(decodeWithMeta('{"vt":[0]}')).toThrow(named("'vt' must be a \\[origin_ms, step_ms\\] pair"));
      expect(decodeWithMeta('{"vt":[0,"1"]}')).toThrow(named("'vt' must be a \\[origin_ms, step_ms\\] pair"));
      expect(decodeWithMeta('{"vt":{"origin":0,"step":1}}')).toThrow(named("'vt' must be a \\[origin_ms, step_ms\\] pair"));
    });

    it("rejects a non-finite / non-numeric 'vb'", () => {
      expect(decodeWithMeta('{"vb":"16"}')).toThrow(named("'vb' must be a finite number"));
    });

    it("rejects a non-boolean 'sorted'", () => {
      expect(decodeWithMeta('{"sorted":"true"}')).toThrow(named("'sorted' must be a boolean"));
    });

    it("rejects a malformed 'qa' (non-object, or affines that are not [finite, finite] pairs)", () => {
      expect(decodeWithMeta('{"qa":[["speed",0,1]]}')).toThrow(named("'qa' must be an object"));
      expect(decodeWithMeta('{"qa":{"speed":{"o":0,"s":1}}}')).toThrow(
        named(`'qa' affine for column "speed" must be an \\[o, s\\] pair`),
      );
      expect(decodeWithMeta('{"qa":{"speed":[0]}}')).toThrow(
        named(`'qa' affine for column "speed" must be an \\[o, s\\] pair`),
      );
      expect(decodeWithMeta('{"qa":{"speed":[0,1e999]}}')).toThrow(
        named(`'qa' affine for column "speed" must be an \\[o, s\\] pair`),
      );
    });

    it('still ignores unknown keys (the additive contract is untouched)', () => {
      const tile = decodeTile(
        inlineFrame(1, {
          tileMeta: new TextEncoder().encode('{"future_key":{"deep":[1,2]},"t0":1700000000000}'),
        }),
        tileId,
      );
      expect(tile.layers[0].features.timeOffset).toBe(1_700_000_000_000);
    });
  });

  it('rejects CORE/PROPS row-count disagreement', () => {
    const core = splitIpcTemplate(coreIpc(3));
    const props = splitIpcTemplate(propsIpc(2));
    const frame = buildV2Frame([
      { name: 'default', refCore: { kind: REF_KIND_INLINE }, refProps: { kind: REF_KIND_INLINE },
        sections: [
          [SECTION_INLINE_SCHEMA_CORE, core.template],
          [SECTION_CORE_BATCH, core.tail],
          [SECTION_INLINE_SCHEMA_PROPS, props.template],
          [SECTION_PROPS_BATCH, props.tail],
        ] },
    ]);
    expect(() => decodeTile(frame, tileId)).toThrow(/row counts disagree: 3 vs 2/);
  });
});

describe('layer frame v2: authority rule (§5.2)', () => {
  it('hard-errors on a v2 frame reached through a v1-declared manifest', () => {
    expect(() => decodeTile(inlineFrame(1), tileId, undefined, { formatVersion: 1 })).toThrow(
      /v2 layer frame reached through a formatVersion-1 manifest/,
    );
  });

  it('hard-errors on a v1 frame reached through a v2-declared manifest', () => {
    const v1Frame = frameFromIpc('default', coreIpc(1));
    expect(() => decodeTile(v1Frame, tileId, undefined, { formatVersion: 2 })).toThrow(
      /v1 layer frame reached through a formatVersion-2 manifest/,
    );
  });

  it('decodes normally when the declared version matches the frame', () => {
    expect(decodeTile(inlineFrame(1), tileId, undefined, { formatVersion: 2 }).layers).toHaveLength(1);
    const v1Frame = frameFromIpc('default', coreIpc(1));
    expect(decodeTile(v1Frame, tileId, undefined, { formatVersion: 1 }).layers).toHaveLength(1);
  });
});
