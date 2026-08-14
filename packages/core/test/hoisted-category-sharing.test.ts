/**
 * The reader half of the writer's global dictionary hoist: a category list that
 * is stored ONCE on the wire must be resident ONCE in the client too.
 *
 * # The regression this suite pins
 *
 * The hoist moves a categorical column's whole category list out of every
 * tile's tail and into the shared PROPS schema template — a real 12 % wire win
 * on a 380 007-feature build. The reader did not follow: every tile rebuilt the
 * identical list into its own `string[]`, so `categoricalProps[col].categories`
 * cost `resident_tiles × categories`. Measured on a 14 653-category column, 400
 * resident tiles cost **264.4 MB** of heap against **6.7 MB** for the same data
 * un-hoisted — 39x, on tiles holding 408 features between them, with
 * `sharedArrayIdentityHits = 0`.
 *
 * Identity sharing is the fix, and identity is what these tests assert: not
 * "equal contents" (`toEqual` would pass on the broken reader) but `toBe` — the
 * SAME array instance.
 *
 * # And the trap the fix has to avoid
 *
 * A shared template hash proves two tiles were spliced onto the same template
 * BYTES, not that the dictionary came from those bytes. Under the other writer
 * split the DictionaryBatch rides the per-tile TAIL, and two tiles then share a
 * hash while carrying genuinely different category lists. Aliasing those would
 * be silent data corruption — every row of one tile relabelled with another
 * tile's categories. The last two tests are that case.
 */

import { describe, it, expect } from 'vitest';
import {
  Dictionary,
  Message,
  MessageHeader,
  Table,
  Uint16,
  Utf8,
  tableToIPC,
  vectorFromArray,
  Field,
  FixedSizeList,
  Float64,
  Int64,
  RecordBatch,
  Schema,
  Struct,
  Uint64,
  makeData,
} from 'apache-arrow';
import { decodeTile, type TemplateRegistry } from '../src/tile';
import type { TileId } from '../src/types';
import {
  buildV2Frame,
  REF_KIND_TEMPLATE_HASH,
  SECTION_CORE_BATCH,
  SECTION_PROPS_BATCH,
  splitIpcTemplate,
  templateHashBytes,
  templateHashHex,
} from './helpers/v2-frame';

/**
 * Split an Arrow IPC stream after its Schema **and every DictionaryBatch that
 * precedes the first RecordBatch** — the TS mirror of the Rust writer's
 * `split_ipc_after_dictionaries`, i.e. the HOISTED cut. Everything before the
 * boundary is dataset-constant and lives in `manifest.schemas`; everything
 * after is the per-tile tail.
 */
function splitIpcAfterDictionaries(ipc: Uint8Array): {
  template: Uint8Array;
  tail: Uint8Array;
} {
  const dv = new DataView(ipc.buffer, ipc.byteOffset, ipc.byteLength);
  let pos = 0;
  let boundary = 0;
  while (pos + 8 <= ipc.byteLength) {
    const metaLen = dv.getInt32(pos + 4, true);
    if (metaLen <= 0) break; // end-of-stream marker
    const msg = Message.decode(ipc.subarray(pos + 8, pos + 8 + metaLen));
    const next = pos + 8 + metaLen + Number(msg.bodyLength);
    if (
      msg.headerType === MessageHeader.Schema ||
      msg.headerType === MessageHeader.DictionaryBatch
    ) {
      boundary = next;
      pos = next;
      continue;
    }
    break; // the first RecordBatch ends the template
  }
  return { template: ipc.subarray(0, boundary), tail: ipc.subarray(boundary) };
}

/** Minimal CORE batch: id / start_time / end_time / point geometry. */
function coreIpc(n: number): Uint8Array {
  const coordValues = makeData({
    type: new Float64(),
    data: Float64Array.from({ length: n * 2 }, (_, i) =>
      i % 2 === 0 ? -122.4 : 37.7,
    ),
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
  const struct = makeData({
    type: new Struct(fields),
    length: n,
    nullCount: 0,
    children: [
      makeData({
        type: new Uint64(),
        length: n,
        data: BigUint64Array.from({ length: n }, (_, i) => BigInt(i)),
      }),
      makeData({
        type: new Int64(),
        length: n,
        data: BigInt64Array.from({ length: n }, () => 1_700_000_000_000n),
      }),
      makeData({
        type: new Int64(),
        length: n,
        data: BigInt64Array.from({ length: n }, () => 1_700_000_000_000n),
      }),
      geomData,
    ],
  });
  return tableToIPC(
    new Table([new RecordBatch(new Schema(fields), struct as never)]),
    'stream',
  );
}

/**
 * A PROPS batch whose `kind` column is a `Dictionary<Utf8, UInt16>` built from
 * `rows` (indices into `categories`).
 *
 * The dictionary id is PINNED to 0. Arrow-JS hands out ids from a process-wide
 * counter, and the id is encoded in the Schema message — so without pinning it,
 * two structurally identical props streams get different template bytes and
 * therefore different hashes, and the suite would be testing the counter rather
 * than the cache. The Rust writer's ids are deterministic; this reproduces that.
 */
function propsIpc(categories: string[], rows: number[]): Uint8Array {
  const kind = vectorFromArray(
    rows.map((i) => categories[i]),
    new Dictionary(new Utf8(), new Uint16(), 0),
  );
  return tableToIPC(new Table({ kind }), 'stream');
}

const templates: TemplateRegistry = new Map();

/**
 * Assemble a hash-referencing v2 frame from a props stream, cutting it at
 * `split`, and register both templates. Returns the frame bytes.
 */
function frameFor(
  props: Uint8Array,
  n: number,
  split: (ipc: Uint8Array) => { template: Uint8Array; tail: Uint8Array },
): Uint8Array {
  const core = splitIpcTemplate(coreIpc(n));
  const p = split(props);
  templates.set(templateHashHex(core.template), core.template);
  templates.set(templateHashHex(p.template), p.template);
  return buildV2Frame([
    {
      name: 'default',
      refCore: {
        kind: REF_KIND_TEMPLATE_HASH,
        hash: templateHashBytes(core.template),
      },
      refProps: {
        kind: REF_KIND_TEMPLATE_HASH,
        hash: templateHashBytes(p.template),
      },
      sections: [
        [SECTION_CORE_BATCH, core.tail],
        [SECTION_PROPS_BATCH, p.tail],
      ],
    },
  ]);
}

const CATS = ['car', 'bus', 'tram', 'ferry', 'bike'];
const idAt = (i: number): TileId => ({ z: 3, x: i, y: 0, t: 5000 });

function categoriesOf(frame: Uint8Array, id: TileId): string[] {
  const tile = decodeTile(frame, id, undefined, { templates });
  return tile.layers[0].features.categoricalProps.kind.categories;
}

describe('hoisted category tables are shared by identity across tiles', () => {
  it('gives every tile referencing one PROPS template the SAME array instance', () => {
    // Two tiles, different rows, one hoisted dictionary: identical template
    // bytes, so identical template hash.
    const a = frameFor(
      propsIpc(CATS, [0, 1, 2, 3, 4]),
      5,
      splitIpcAfterDictionaries,
    );
    const b = frameFor(
      propsIpc(CATS, [0, 1, 2, 3, 4]),
      5,
      splitIpcAfterDictionaries,
    );

    const first = categoriesOf(a, idAt(1));
    const second = categoriesOf(b, idAt(2));
    const third = categoriesOf(a, idAt(3));

    expect(first).toEqual(CATS);
    expect(second).toEqual(CATS);
    // The assertion that fails on the un-shared reader: ONE instance, not
    // three equal copies. `toEqual` passed before the fix; `toBe` is the point.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('shares nothing between two archives, because each registry owns its cache', () => {
    const frame = frameFor(
      propsIpc(CATS, [0, 1, 2, 3, 4]),
      5,
      splitIpcAfterDictionaries,
    );
    const other: TemplateRegistry = new Map(templates);
    const mine = categoriesOf(frame, idAt(4));
    const theirs = decodeTile(frame, idAt(5), undefined, { templates: other })
      .layers[0].features.categoricalProps.kind.categories;
    expect(theirs).toEqual(mine);
    expect(theirs).not.toBe(mine);
  });

  it('shares nothing without a template registry (the standalone decode path)', () => {
    // Inline-template frames carry their own template bytes per tile, so there
    // is nothing to key a share on — and `decodeTile` without `templates` is
    // exactly the pre-fix behaviour, unchanged.
    const core = splitIpcTemplate(coreIpc(5));
    const p = splitIpcAfterDictionaries(propsIpc(CATS, [0, 1, 2, 3, 4]));
    const inline = buildV2Frame([
      {
        name: 'default',
        refCore: { kind: 0 },
        refProps: { kind: 0 },
        sections: [
          [0x01, core.template],
          [SECTION_CORE_BATCH, core.tail],
          [0x04, p.template],
          [SECTION_PROPS_BATCH, p.tail],
        ],
      },
    ]);
    const one = decodeTile(inline, idAt(6)).layers[0].features.categoricalProps
      .kind.categories;
    const two = decodeTile(inline, idAt(7)).layers[0].features.categoricalProps
      .kind.categories;
    expect(two).toEqual(one);
    expect(two).not.toBe(one);
  });
});

describe('the share is confirmed by content, never assumed from the hash', () => {
  it('never aliases two TILE-LOCAL dictionaries that share a schema template', () => {
    // The un-hoisted cut: the DictionaryBatch rides the per-tile tail. Both
    // tiles have the same PROPS SCHEMA (so the same template hash) but
    // different category lists — the exact shape a hash-only cache corrupts.
    const busy = frameFor(propsIpc(CATS, [0, 1, 2]), 3, splitIpcTemplate);
    const quiet = frameFor(propsIpc(CATS, [3, 4]), 2, splitIpcTemplate);

    const a = categoriesOf(busy, idAt(8));
    const b = categoriesOf(quiet, idAt(9));
    expect(a).toEqual(['car', 'bus', 'tram']);
    expect(b).toEqual(['ferry', 'bike']);
    expect(b).not.toBe(a);
  });

  it('never aliases same-LENGTH tile-local dictionaries with different contents', () => {
    // Equal lengths defeat any cheap length-only guard, so the identity check
    // has to compare the dictionary's actual bytes.
    const left = frameFor(propsIpc(CATS, [0, 1]), 2, splitIpcTemplate);
    const right = frameFor(propsIpc(CATS, [2, 3]), 2, splitIpcTemplate);

    const a = categoriesOf(left, idAt(10));
    const b = categoriesOf(right, idAt(11));
    expect(a).toEqual(['car', 'bus']);
    expect(b).toEqual(['tram', 'ferry']);
    expect(b).not.toBe(a);

    // ...and the per-row decode is still right on both sides, which is what
    // aliasing would have silently broken.
    const decode = (frame: Uint8Array, id: TileId): (string | null)[] => {
      const f = decodeTile(frame, id, undefined, { templates }).layers[0]
        .features.categoricalProps.kind;
      return Array.from(f.indices).map((i) =>
        i === 0xffff ? null : f.categories[i],
      );
    };
    expect(decode(left, idAt(12))).toEqual(['car', 'bus']);
    expect(decode(right, idAt(13))).toEqual(['tram', 'ferry']);
  });

  it('re-orders never alias, and a re-ordered hoist is a different template', () => {
    // Under the hoisted cut the category BYTES are part of the template, so a
    // different list is a different template hash — the share is safe twice
    // over. Assert both halves: identity within a list, and no aliasing across.
    const full = frameFor(
      propsIpc(CATS, [0, 1, 2, 3, 4]),
      5,
      splitIpcAfterDictionaries,
    );
    const hoisted = categoriesOf(full, idAt(14));
    expect(hoisted).toEqual(CATS);
    expect(categoriesOf(full, idAt(15))).toBe(hoisted);

    const shuffled = ['bike', 'ferry', 'tram', 'bus', 'car'];
    const other = frameFor(
      propsIpc(shuffled, [0, 1, 2, 3, 4]),
      5,
      splitIpcAfterDictionaries,
    );
    const otherCats = categoriesOf(other, idAt(16));
    expect(otherCats).toEqual(shuffled);
    expect(otherCats).not.toBe(hoisted);
  });
});
