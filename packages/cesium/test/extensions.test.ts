// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * The conformance case behind `capabilities.userExtensions` for the Cesium
 * backend, plus the regression guards for the four constraints that make the
 * hook harder than it looks. Every one of them is a way a hook could LOOK
 * present while being useless or dishonest:
 *
 * 1. **The oracle stays the oracle.** `test/time-filter-oracle.test.ts` asserts
 *    every alpha-computing layer derives opacity from core's `timeFilterAlpha`.
 *    An extension that COMPUTED the alpha instead would make that claim false
 *    while every test here still passed. So the sweep below records what the
 *    hook is HANDED and requires it to be exactly the oracle's output — for
 *    every mode, at every playhead — and separately requires the written value
 *    to be exactly `hook(oracle(…))`.
 * 2. **The skip-if-unchanged cache must survive, and must not silently eat
 *    changes.** The layers cache the last alpha they wrote. A colour hook at
 *    constant opacity, or an alpha hook keyed on something other than the
 *    playhead, is exactly the input that cache gets wrong — both are driven
 *    here, at a FIXED playhead, where a stale cache means a frozen feature.
 * 3. **The per-frame path allocates nothing.** The scratch identities handed to
 *    hooks are collected into a `Set` and required to be one object.
 * 4. **An empty list is free.** Not "cheap" — `null`, byte-identical written
 *    values, and an identical WRITE COUNT (i.e. the cache still fires).
 *
 * And the case that makes the flag honest at all: a hook must be able to change
 * WHAT IS DRAWN. These tests read back off the real Cesium `PointPrimitive`
 * colour and the real batch-table bytes the layer wrote, not off the extension.
 *
 * Node harness: the same one `time-filter-oracle.test.ts` documents — a `Scene`
 * stub with `primitives.add/remove`, a genuinely constructible
 * `PointPrimitiveCollection`, and a byte-copying stand-in for the polyline batch
 * table (which exists only after a real GPU render).
 */

import { describe, it, expect } from 'vitest';
import {
  Color,
  PointPrimitiveCollection,
  type PointPrimitive,
  type Primitive,
  type Scene,
} from 'cesium';
import { GeometryType, getFeatureProperties } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { STTPointLayer } from '../src/cesium-point-layer';
import { STTPathLayer } from '../src/cesium-path-layer';
import { STTArcLayer } from '../src/cesium-arc-layer';
import { STTBatchedPolylineLayer } from '../src/batched-polyline-layer';
import { buildPathPolylines } from '../src/lib/polylines';
import {
  compileExtensions,
  type CesiumLayerExtension,
  type ExtensionColor,
  type ExtensionFeature,
} from '../src/lib/extensions';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TIME_OFFSET = 1_700_000_000_000;
const STARTS = [0, 120, 500, 999];
const ENDS = [40, 300, 900, 1200];

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  timeOffset = 0,
): Tile {
  const featureCount = startTimes.length;
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(startTimes.map((_, i) => i)),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    // A real column, so the provenance test can prove the hook's `binary` +
    // `featureIndex` join back to properties rather than merely being non-null.
    numericProps: { mag: new Float32Array(startTimes.map((_, i) => 10 + i)) },
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

function lineTile(
  positions: number[],
  startIndices: number[],
  startTimes: number[],
  endTimes: number[],
  timeOffset = 0,
): Tile {
  const featureCount = startIndices.length - 1;
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    startIndices: new Uint32Array(startIndices),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'lines',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  };
}

/** Four 2-vertex lines whose times match `STARTS`/`ENDS`. */
const LINE_TILE = (): Tile =>
  lineTile(
    [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0],
    [0, 2, 4, 6, 8],
    STARTS,
    ENDS,
    TIME_OFFSET,
  );

/** What `STTPathLayer` and `STTArcLayer` have in common for this file's purposes. */
interface WrappedPolylineLayer {
  setTiles(tiles: Tile[]): void;
  setTime(absoluteMs: number): void;
}

function stubScene(): { scene: Scene; added: unknown[] } {
  const added: unknown[] = [];
  const scene = {
    primitives: {
      add<T>(p: T): T {
        added.push(p);
        return p;
      },
      remove(): boolean {
        return true;
      },
    },
  } as unknown as Scene;
  return { scene, added };
}

/**
 * The batch-table stand-in, extended with a per-instance WRITE COUNTER. The
 * copying setter is not decoration: the layer writes one shared scratch
 * `Uint8Array` for every entry, so a stand-in storing the reference would report
 * the last write for all of them.
 */
function armPrimitive(prim: Primitive): {
  bytesFor(featureIndex: number): Uint8Array;
  writes(): number;
} {
  const store = new Map<number, Uint8Array>();
  let writes = 0;
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    const bytes = new Uint8Array(4);
    store.set((id as { featureIndex: number }).featureIndex, bytes);
    return {
      get color(): Uint8Array {
        return bytes;
      },
      set color(v: Uint8Array) {
        writes++;
        bytes.set(v);
      },
    } as never;
  };
  return {
    bytesFor(featureIndex: number): Uint8Array {
      const b = store.get(featureIndex);
      if (!b) throw new Error(`no batch-table bytes for ${featureIndex}`);
      return b;
    },
    writes: () => writes,
  };
}

/**
 * Count `PointPrimitive.color` assignments by shadowing the PROTOTYPE accessor
 * with an own property that forwards. Cesium's real setter still runs, so the
 * primitive's `_color` and its dirty-check behave exactly as in production.
 */
function countPointColorWrites(pp: PointPrimitive): () => number {
  let writes = 0;
  const desc = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(pp) as object,
    'color',
  );
  if (!desc?.get || !desc.set) {
    throw new Error('PointPrimitive.color is no longer a prototype accessor');
  }
  const protoGet = desc.get;
  const protoSet = desc.set;
  Object.defineProperty(pp, 'color', {
    configurable: true,
    get(): Color {
      return protoGet.call(pp) as Color;
    },
    set(v: Color) {
      writes++;
      protoSet.call(pp, v);
    },
  });
  return () => writes;
}

/** The mode matrix, mirroring `time-filter-oracle.test.ts`. */
const MODES: ReadonlyArray<{
  mode: TimeFilterMode;
  params: TimeFilterParams;
}> = [
  { mode: 'window', params: { windowHalf: 400 } },
  { mode: 'window', params: { windowHalf: 400, fadeIn: 250, fadeOut: 150 } },
  { mode: 'wake', params: { wakeLength: 900 } },
  { mode: 'cumulative', params: { fadeIn: 0 } },
  { mode: 'cumulative', params: { fadeIn: 700 } },
  { mode: 'trail', params: { trailLength: 600, trailFade: 1 } },
  { mode: 'trail', params: { trailLength: 600, trailFade: 0.35 } },
  { mode: 'none', params: {} },
];

const PLAYHEADS: number[] = [];
for (let t = -600; t <= 1800; t += 37) PLAYHEADS.push(TIME_OFFSET + t);
for (const s of STARTS) PLAYHEADS.push(TIME_OFFSET + s);
for (const e of ENDS) PLAYHEADS.push(TIME_OFFSET + e);

// ─── compileExtensions: the compile-away contract ────────────────────────────

describe('compileExtensions', () => {
  it('returns null for absent, empty, and hookless lists — the zero-cost case', () => {
    // `null` is the ONLY zero-cost signal the layers branch on. An empty
    // compiled object would still cost a property read and an empty loop per
    // feature per frame, and would make the "no extensions changes nothing"
    // claim a matter of the compiler's mood rather than of the source.
    expect(compileExtensions(undefined, 'l')).toBeNull();
    expect(compileExtensions([], 'l')).toBeNull();
    expect(compileExtensions([{ name: 'inert' }], 'l')).toBeNull();
    expect(
      compileExtensions([{ name: 'a' }, { name: 'b', volatile: true }], 'l'),
    ).toBeNull();
  });

  it('compiles hooks in list order and reports what it found', () => {
    const set = compileExtensions(
      [
        { name: 'dim', alpha: (a) => a * 0.5 },
        { name: 'inert' },
        { name: 'tint', color: (out) => void (out.r = 1) },
      ],
      'l',
    );
    expect(set).not.toBeNull();
    // Hookless entries are dropped: a caller assembling a list from feature
    // flags gets the fast path back when every flag is off.
    expect(set?.names).toEqual(['dim', 'tint']);
    expect(set?.hasAlpha).toBe(true);
    expect(set?.hasColor).toBe(true);
  });

  it('refuses a duplicate name, including a hookless one', () => {
    // Two entries under one name apply the same transform twice — the "merged
    // two option objects" bug. Raised once, at layer construction, instead of
    // silently squaring the effect on every frame. Validation runs over the
    // WHOLE list, so a hookless collision is still a collision.
    expect(() =>
      compileExtensions(
        [
          { name: 'dim', alpha: (a) => a * 0.5 },
          { name: 'dim', alpha: (a) => a * 0.5 },
        ],
        'pts',
      ),
    ).toThrow(/duplicate extension name "dim"/);
    expect(() =>
      compileExtensions(
        [{ name: 'dim', alpha: (a) => a }, { name: 'dim' }],
        'pts',
      ),
    ).toThrow(/duplicate extension name/);
  });

  it('refuses a blank or non-string name', () => {
    expect(() => compileExtensions([{ name: '' }], 'pts')).toThrow(
      /non-empty `name`/,
    );
    expect(() =>
      compileExtensions(
        [{ name: undefined as unknown as string, alpha: (a) => a }],
        'pts',
      ),
    ).toThrow(/non-empty `name`/);
  });

  it('throws from the LAYER constructor, not from the first frame', () => {
    const { scene } = stubScene();
    expect(
      () =>
        new STTPointLayer(scene, {
          extensions: [{ name: 'x', alpha: (a) => a }, { name: 'x' }],
        }),
    ).toThrow(/duplicate extension name "x"/);
  });
});

// ─── The oracle is composed with, never replaced ─────────────────────────────

describe('an extension composes ON TOP of core/time-filter, never in place of it', () => {
  it('hands the hook exactly `timeFilterAlpha`, for every mode and playhead', () => {
    // The direct statement of the constraint: whatever the extension does, the
    // number it is GIVEN is the oracle's. A layer that computed its own ramp and
    // passed that in would fail here even if the written value still looked
    // plausible.
    for (const { mode, params } of MODES) {
      const seen: number[] = [];
      const { scene } = stubScene();
      const layer = new STTPointLayer(scene, {
        mode,
        timeFilter: params,
        extensions: [
          {
            name: 'record',
            alpha(a) {
              seen.push(a);
              return a;
            },
          },
        ],
      });
      layer.setTiles([
        pointTile([0, 0, 1, 1, 2, 2, 3, 3], STARTS, ENDS, TIME_OFFSET),
      ]);

      for (const absoluteMs of PLAYHEADS) {
        seen.length = 0;
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        expect(seen).toEqual(
          STARTS.map((s, i) => timeFilterAlpha(mode, cur, s, ENDS[i], params)),
        );
      }
    }
  });

  it('writes exactly `hook(timeFilterAlpha(…))` into the point primitive', () => {
    for (const { mode, params } of MODES) {
      const { scene, added } = stubScene();
      const layer = new STTPointLayer(scene, {
        mode,
        timeFilter: params,
        extensions: [{ name: 'half', alpha: (a) => a * 0.5 }],
      });
      layer.setTiles([
        pointTile([0, 0, 1, 1, 2, 2, 3, 3], STARTS, ENDS, TIME_OFFSET),
      ]);
      const collection = added[0] as PointPrimitiveCollection;

      for (const absoluteMs of PLAYHEADS) {
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        for (let i = 0; i < STARTS.length; i++) {
          expect(collection.get(i).color.alpha).toBe(
            0.5 * timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params),
          );
        }
      }
    }
  });

  it('writes exactly `round(255 · hook(timeFilterAlpha(…)))` into the batch table', () => {
    for (const { mode, params } of MODES) {
      const { scene, added } = stubScene();
      const layer = new STTBatchedPolylineLayer(scene, 'lines', {
        mode,
        timeFilter: params,
        extensions: [{ name: 'half', alpha: (a) => a * 0.5 }],
      });
      layer.setPolylines(buildPathPolylines([LINE_TILE()]));
      const table = armPrimitive(added[0] as Primitive);

      for (const absoluteMs of PLAYHEADS) {
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        for (let i = 0; i < STARTS.length; i++) {
          expect(table.bytesFor(i)[3]).toBe(
            Math.round(
              255 *
                0.5 *
                timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params),
            ),
          );
        }
      }
    }
  });

  it('hands the hook the oracle value already multiplied by the base alpha', () => {
    // The one transform the layer applies before the hook — stated explicitly so
    // it cannot drift into being applied twice, or after.
    const seen: number[] = [];
    const { scene, added } = stubScene();
    const layer = new STTPointLayer(scene, {
      mode: 'window',
      timeFilter: { windowHalf: 400, fadeIn: 250 },
      colorMappingDefault: [10, 20, 30, 128],
      extensions: [
        {
          name: 'record',
          alpha(a) {
            seen.push(a);
            return a;
          },
        },
      ],
    });
    layer.setTiles([pointTile([0, 0], [200], [600], TIME_OFFSET)]);
    const collection = added[0] as PointPrimitiveCollection;
    const base = 128 / 255;

    for (const absoluteMs of PLAYHEADS) {
      seen.length = 0;
      layer.setTime(absoluteMs);
      const expected =
        base *
        timeFilterAlpha('window', absoluteMs - TIME_OFFSET, 200, 600, {
          windowHalf: 400,
          fadeIn: 250,
        });
      expect(seen).toEqual([expected]);
      expect(collection.get(0).color.alpha).toBe(expected);
    }
  });

  it('a hook that ignores its argument still leaves the oracle in the path', () => {
    // The adversarial reading of "compose": an extension is free to discard the
    // oracle's value for its own. That does NOT make the layer's conformance
    // claim false — the layer still called the oracle and still handed the
    // result over, which is what the claim is about. Pinned so the distinction
    // is on the record rather than assumed.
    const seen: number[] = [];
    const { scene, added } = stubScene();
    const layer = new STTPointLayer(scene, {
      mode: 'wake',
      timeFilter: { wakeLength: 900 },
      extensions: [
        {
          name: 'constant',
          alpha(a) {
            seen.push(a);
            return 0.42;
          },
        },
      ],
    });
    layer.setTiles([pointTile([0, 0], [200], [600], TIME_OFFSET)]);
    const collection = added[0] as PointPrimitiveCollection;
    layer.setTime(TIME_OFFSET + 650);
    expect(seen).toEqual([
      timeFilterAlpha('wake', 650, 200, 600, { wakeLength: 900 }),
    ]);
    expect(collection.get(0).color.alpha).toBeCloseTo(0.42, 6);
  });
});

// ─── It changes what is drawn ────────────────────────────────────────────────

describe('an extension changes what is actually drawn', () => {
  it('repaints the real Cesium PointPrimitive colour', () => {
    const { scene, added } = stubScene();
    const layer = new STTPointLayer(scene, {
      mode: 'none',
      colorMappingDefault: [200, 205, 215, 255],
      extensions: [
        {
          name: 'by-index',
          color(out, _a, f) {
            out.r = f.featureIndex / 10;
            out.g = 0.25;
            out.b = 0.75;
          },
        },
      ],
    });
    layer.setTiles([
      pointTile([0, 0, 1, 1, 2, 2, 3, 3], STARTS, ENDS, TIME_OFFSET),
    ]);
    const collection = added[0] as PointPrimitiveCollection;
    layer.setTime(TIME_OFFSET + 500);
    for (let i = 0; i < STARTS.length; i++) {
      const c = collection.get(i).color;
      expect(c.red).toBeCloseTo(i / 10, 6);
      expect(c.green).toBeCloseTo(0.25, 6);
      expect(c.blue).toBeCloseTo(0.75, 6);
      expect(c.alpha).toBe(1); // mode 'none'
    }
  });

  it('repaints the real batch-table bytes, and round-trips u8 exactly', () => {
    // The polyline layer stores u8 and the hook contract is 0..1, so an identity
    // colour hook must be a true identity. It is only exact because the layer
    // ROUNDS on the way back — a Uint8Array store truncates, and 200/255×255 is
    // 199.999…, which would bleed a channel per frame.
    const { scene, added } = stubScene();
    const identity = new STTBatchedPolylineLayer(scene, 'lines', {
      mode: 'none',
      extensions: [{ name: 'identity', color: () => {} }],
    });
    identity.setPolylines(buildPathPolylines([LINE_TILE()]));
    const table = armPrimitive(added[0] as Primitive);
    identity.setTime(TIME_OFFSET + 500);
    // The builder's default grey.
    expect([...table.bytesFor(0)]).toEqual([200, 205, 215, 255]);

    const { scene: s2, added: a2 } = stubScene();
    const tinted = new STTBatchedPolylineLayer(s2, 'lines', {
      mode: 'none',
      extensions: [
        {
          name: 'tint',
          color(out) {
            out.r = 1;
            out.g = 0;
            out.b = 0.5;
          },
        },
      ],
    });
    tinted.setPolylines(buildPathPolylines([LINE_TILE()]));
    const t2 = armPrimitive(a2[0] as Primitive);
    tinted.setTime(TIME_OFFSET + 500);
    expect([...t2.bytesFor(0)]).toEqual([255, 0, 128, 255]);
  });

  it('reaches STTPathLayer and STTArcLayer with no wiring of their own', () => {
    // `extensions` lives on STTBatchedPolylineOptions, which STTPathLayerOptions
    // extends and STTArcLayerOptions extends via Omit<…,'arcType'>; both wrappers
    // hand their whole options object to the batched layer. This asserts that
    // inheritance is real rather than assumed — if either wrapper ever starts
    // picking option keys by hand, the seam silently disappears from two kinds.
    const wrappers: Array<
      (s: Scene, e: CesiumLayerExtension[]) => WrappedPolylineLayer
    > = [
      (s, e) => new STTPathLayer(s, { mode: 'none', extensions: e }),
      (s, e) => new STTArcLayer(s, { mode: 'none', extensions: e, samples: 4 }),
    ];
    for (const make of wrappers) {
      const { scene, added } = stubScene();
      const layer = make(scene, [{ name: 'quarter', alpha: (a) => a * 0.25 }]);
      layer.setTiles([LINE_TILE()]);
      const table = armPrimitive(added[0] as Primitive);
      layer.setTime(TIME_OFFSET + 500);
      expect(table.bytesFor(0)[3]).toBe(Math.round(255 * 0.25));
    }
  });
});

// ─── Composition order ───────────────────────────────────────────────────────

describe('composition order', () => {
  it('chains alpha hooks in list order', () => {
    const set = compileExtensions(
      [
        { name: 'half', alpha: (a) => a * 0.5 },
        { name: 'plus', alpha: (a) => a + 0.1 },
      ],
      'l',
    );
    set?.beginFrame(0);
    const b = {} as BinaryFeatures;
    // 1 → 0.5 → 0.6. The other order would be 1.1 → clamped 1 → 0.5.
    expect(set?.apply(1, 0, 1, b, 0, 0, 0, 0).alpha).toBeCloseTo(0.6, 6);
  });

  it('runs every colour hook after every alpha hook, and shows them the final alpha', () => {
    const seen: number[] = [];
    const set = compileExtensions(
      [
        {
          name: 'paint',
          color(out, a) {
            seen.push(a);
            out.r = a;
          },
        },
        { name: 'dim', alpha: (a) => a * 0.25 },
      ],
      'l',
    );
    set?.beginFrame(0);
    const out = set?.apply(1, 0, 1, {} as BinaryFeatures, 0, 0, 0, 0);
    // `paint` is FIRST in the list but still sees 0.25, not 1: the fold is two
    // passes, not an interleave. A per-extension interleave would hand it 1 and
    // make the colour depend on list position for no reason a caller could see.
    expect(seen).toEqual([0.25]);
    expect(out?.r).toBeCloseTo(0.25, 6);
    expect(out?.alpha).toBeCloseTo(0.25, 6);
  });

  it('keeps `this` bound to the extension object inside a method-shorthand hook', () => {
    const ext = {
      name: 'stateful',
      factor: 0.5,
      alpha(this: { factor: number }, a: number): number {
        return a * this.factor;
      },
    };
    const set = compileExtensions([ext], 'l');
    set?.beginFrame(0);
    expect(set?.apply(1, 0, 1, {} as BinaryFeatures, 0, 0, 0, 0).alpha).toBe(
      0.5,
    );
  });
});

// ─── Clamping and sanitising ─────────────────────────────────────────────────

describe('clamping', () => {
  const b = {} as BinaryFeatures;

  it('clamps alpha to 0..1 and maps non-finite to 0', () => {
    const cases: Array<[number, number]> = [
      [5, 1],
      [-1, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 1],
      [Number.NEGATIVE_INFINITY, 0],
      [0.25, 0.25],
    ];
    for (const [returned, expected] of cases) {
      const set = compileExtensions(
        [{ name: 'x', alpha: () => returned }],
        'l',
      );
      set?.beginFrame(0);
      expect(set?.apply(1, 0, 1, b, 0, 0, 0, 0).alpha, `${returned}`).toBe(
        expected,
      );
    }
  });

  it('clamps every colour channel the same way', () => {
    const set = compileExtensions(
      [
        {
          name: 'wild',
          color(out) {
            out.r = 4;
            out.g = -2;
            out.b = Number.NaN;
          },
        },
      ],
      'l',
    );
    set?.beginFrame(0);
    const out = set?.apply(1, 0, 1, b, 0, 0.5, 0.5, 0.5);
    expect([out?.r, out?.g, out?.b]).toEqual([1, 0, 0]);
  });

  it('never lets a badly-behaved hook reach a Uint8Array unclamped', () => {
    // The concrete failure the clamp exists to stop: 255 × 4 = 1020, which a
    // Uint8Array store wraps to 252 — a confidently wrong, fully opaque colour
    // rather than an obviously broken one.
    const { scene, added } = stubScene();
    const layer = new STTBatchedPolylineLayer(scene, 'lines', {
      mode: 'none',
      extensions: [
        {
          name: 'overflow',
          alpha: () => 4,
          color(out) {
            out.r = 4;
            out.g = -1;
            out.b = Number.NaN;
          },
        },
      ],
    });
    layer.setPolylines(buildPathPolylines([LINE_TILE()]));
    const table = armPrimitive(added[0] as Primitive);
    layer.setTime(TIME_OFFSET + 500);
    expect([...table.bytesFor(0)]).toEqual([255, 0, 0, 255]);
  });

  it('ignores a colour hook that scribbles on the output alpha', () => {
    // The colour scratch IS the output object, so `alpha` is hidden from
    // TypeScript but reachable from JavaScript. The fold re-asserts it.
    const set = compileExtensions(
      [
        {
          name: 'sneaky',
          color(out) {
            (out as unknown as { alpha: number }).alpha = 0.99;
          },
        },
      ],
      'l',
    );
    set?.beginFrame(0);
    expect(set?.apply(0.25, 0, 1, b, 0, 0, 0, 0).alpha).toBe(0.25);
  });
});

// ─── The skip-if-unchanged cache ─────────────────────────────────────────────

describe('the lastAlpha skip-if-unchanged cache', () => {
  /** Two points permanently inside the window: the oracle alpha never moves. */
  function staticPointLayer(extensions: CesiumLayerExtension[]): {
    layer: STTPointLayer;
    collection: PointPrimitiveCollection;
    writes: () => number;
  } {
    const { scene, added } = stubScene();
    const layer = new STTPointLayer(scene, { mode: 'none', extensions });
    layer.setTiles([
      pointTile([0, 0, 1, 1], [0, 0], [1000, 1000], TIME_OFFSET),
    ]);
    const collection = added[0] as PointPrimitiveCollection;
    const counters = [
      countPointColorWrites(collection.get(0)),
      countPointColorWrites(collection.get(1)),
    ];
    return {
      layer,
      collection,
      writes: () => counters.reduce((n, c) => n + c(), 0),
    };
  }

  it('stays ON for an alpha-only, non-volatile extension', () => {
    expect(
      compileExtensions([{ name: 'half', alpha: (a) => a * 0.5 }], 'l')
        ?.skipUnchanged,
    ).toBe(true);
    const { layer, writes } = staticPointLayer([
      { name: 'half', alpha: (a) => a * 0.5 },
    ]);
    for (let f = 0; f < 5; f++) layer.setTime(TIME_OFFSET + 500);
    expect(writes()).toBe(2); // one per point, on the first frame only
  });

  it('still catches an alpha hook keyed on something other than the playhead', () => {
    // The ordering constraint, stated as behaviour. `dim` changes with NO change
    // in the playhead and no change in the oracle's output. Composing after the
    // compare — the tempting optimisation — would skip this feature forever.
    let dim = 1;
    const { layer, collection, writes } = staticPointLayer([
      { name: 'external', alpha: (a) => a * dim },
    ]);
    layer.setTime(TIME_OFFSET + 500);
    expect(collection.get(0).color.alpha).toBe(1);
    dim = 0.3;
    layer.setTime(TIME_OFFSET + 500); // same instant, different answer
    expect(collection.get(0).color.alpha).toBeCloseTo(0.3, 6);
    expect(writes()).toBe(4); // both points, both frames
  });

  it('turns OFF automatically for a colour hook — the cache cannot see a colour move', () => {
    // The load-bearing case. Alpha is pinned at 1 by `mode: 'none'`, so an
    // alpha-keyed cache would write frame 1 and freeze; the hue would never
    // move again. This is why `hasColor` clears `skipUnchanged` rather than
    // waiting for the caller to declare it.
    expect(
      compileExtensions([{ name: 'hue', color: () => {} }], 'l')?.skipUnchanged,
    ).toBe(false);

    let phase = 0;
    const { layer, collection, writes } = staticPointLayer([
      {
        name: 'pulse',
        color(out) {
          out.r = phase;
        },
      },
    ]);
    const reds: number[] = [];
    for (const p of [0, 0.25, 0.5, 0.75]) {
      phase = p;
      layer.setTime(TIME_OFFSET + 500); // the SAME instant every time
      reds.push(collection.get(0).color.red);
    }
    for (let i = 0; i < reds.length; i++) {
      expect(reds[i]).toBeCloseTo([0, 0.25, 0.5, 0.75][i], 6);
    }
    expect(writes()).toBe(8); // 2 points × 4 frames — nothing skipped
  });

  it('turns OFF for an explicitly `volatile` alpha-only extension', () => {
    // What the flag is FOR: something outside the layer also writes these
    // colours (an app highlighting a picked feature by assigning
    // `pointPrimitive.color`), so `lastAlpha` no longer describes the screen and
    // the layer has to re-assert its value.
    expect(
      compileExtensions([{ name: 'v', volatile: true, alpha: (a) => a }], 'l')
        ?.skipUnchanged,
    ).toBe(false);

    const cached = staticPointLayer([{ name: 'q', alpha: (a) => a }]);
    cached.layer.setTime(TIME_OFFSET + 500);
    cached.collection.get(0).color = new Color(1, 0, 0, 1); // an outsider scribbles
    cached.layer.setTime(TIME_OFFSET + 500);
    expect(cached.collection.get(0).color.red).toBe(1); // not restored

    const forced = staticPointLayer([
      { name: 'q', volatile: true, alpha: (a) => a },
    ]);
    forced.layer.setTime(TIME_OFFSET + 500);
    forced.collection.get(0).color = new Color(1, 0, 0, 1);
    forced.layer.setTime(TIME_OFFSET + 500);
    expect(forced.collection.get(0).color.red).toBeCloseTo(200 / 255, 6);
  });

  it('holds the same way on the batched polyline layer', () => {
    const { scene, added } = stubScene();
    const layer = new STTBatchedPolylineLayer(scene, 'lines', {
      mode: 'none',
      extensions: [{ name: 'still', alpha: (a) => a }],
    });
    layer.setPolylines(buildPathPolylines([LINE_TILE()]));
    const table = armPrimitive(added[0] as Primitive);
    for (let f = 0; f < 5; f++) layer.setTime(TIME_OFFSET + 500);
    expect(table.writes()).toBe(4); // four lines, first frame only

    const { scene: s2, added: a2 } = stubScene();
    const painting = new STTBatchedPolylineLayer(s2, 'lines', {
      mode: 'none',
      extensions: [{ name: 'hue', color: () => {} }],
    });
    painting.setPolylines(buildPathPolylines([LINE_TILE()]));
    const t2 = armPrimitive(a2[0] as Primitive);
    for (let f = 0; f < 5; f++) painting.setTime(TIME_OFFSET + 500);
    expect(t2.writes()).toBe(20); // 4 lines × 5 frames
  });
});

// ─── Allocation-free, and the provenance a hook is given ─────────────────────

describe('the per-frame path is allocation-free', () => {
  it('hands every hook the SAME feature scratch and returns the SAME output', () => {
    const features = new Set<object>();
    const outputs = new Set<object>();
    const set = compileExtensions(
      [
        {
          name: 'watch',
          alpha(a, f) {
            features.add(f);
            return a;
          },
          color(_out, _a, f) {
            features.add(f);
          },
        },
      ],
      'l',
    );
    const b = {} as BinaryFeatures;
    for (let frame = 0; frame < 3; frame++) {
      set?.beginFrame(frame);
      for (let i = 0; i < 50; i++) {
        outputs.add(set?.apply(1, 0, 1, b, i, 0, 0, 0) as object);
      }
    }
    // 300 hook calls across 3 frames, one object each. A fresh context or a
    // fresh tuple per feature would be 150 and 150.
    expect(features.size).toBe(1);
    expect(outputs.size).toBe(1);
  });

  it('gives the hook the REBASED playhead and joinable provenance', () => {
    // `time` is what the oracle got, not the absolute epoch — a hook comparing
    // it against `start`/`end` (the only times it is given) would otherwise be
    // comparing a 1.7e12 epoch against a 3-digit offset.
    const seen: Array<{
      time: number;
      start: number;
      end: number;
      layerId: string;
      props: Record<string, unknown> | null;
    }> = [];
    const { scene } = stubScene();
    const layer = new STTPointLayer(scene, {
      id: 'pts',
      mode: 'none',
      extensions: [
        {
          name: 'inspect',
          alpha(a, f: Readonly<ExtensionFeature>) {
            seen.push({
              time: f.time,
              start: f.start,
              end: f.end,
              layerId: f.layerId,
              props: getFeatureProperties(f.binary, f.featureIndex),
            });
            return a;
          },
        },
      ],
    });
    layer.setTiles([
      pointTile([0, 0, 1, 1, 2, 2, 3, 3], STARTS, ENDS, TIME_OFFSET),
    ]);
    layer.setTime(TIME_OFFSET + 777);

    expect(seen).toHaveLength(STARTS.length);
    for (let i = 0; i < STARTS.length; i++) {
      expect(seen[i].time).toBe(777);
      expect(seen[i].start).toBe(STARTS[i]);
      expect(seen[i].end).toBe(ENDS[i]);
      expect(seen[i].layerId).toBe('pts');
      expect(seen[i].props?.mag).toBe(10 + i);
    }
  });

  it('rebases through the layer origin across tiles with different timeOffsets', () => {
    const seen: number[] = [];
    const { scene } = stubScene();
    const layer = new STTPointLayer(scene, {
      mode: 'none',
      extensions: [
        {
          name: 'inspect',
          alpha(a, f) {
            seen.push(f.start);
            return a;
          },
        },
      ],
    });
    layer.setTiles([
      pointTile([0, 0], [0], [100], TIME_OFFSET),
      pointTile([1, 1], [0], [100], TIME_OFFSET + 3000),
    ]);
    layer.setTime(TIME_OFFSET + 3500);
    // Second tile's feature is rebased onto the first tile's origin.
    expect(seen).toEqual([0, 3000]);
  });
});

// ─── An empty list is free ───────────────────────────────────────────────────

describe('an empty extension list is a zero-cost no-op on the hot loop', () => {
  /**
   * The compiled field the hot loop branches on. Private by design, read here
   * because it IS the claim: the loop cannot reach the extension machinery at
   * all, rather than reaching an empty one cheaply.
   */
  function compiled(layer: object): unknown {
    return (layer as { ext: unknown }).ext;
  }

  it('leaves every layer holding a null compiled set', () => {
    const { scene } = stubScene();
    expect(compiled(new STTPointLayer(scene, {}))).toBeNull();
    expect(compiled(new STTPointLayer(scene, { extensions: [] }))).toBeNull();
    expect(
      compiled(new STTPointLayer(scene, { extensions: [{ name: 'inert' }] })),
    ).toBeNull();
    expect(compiled(new STTBatchedPolylineLayer(scene, 'l', {}))).toBeNull();
    expect(
      compiled(new STTBatchedPolylineLayer(scene, 'l', { extensions: [] })),
    ).toBeNull();
    // The wrappers delegate; the null lives on the batched layer each one owns.
    const batchOf = (l: object): object => (l as { batch: object }).batch;
    expect(
      compiled(batchOf(new STTPathLayer(scene, { extensions: [] }))),
    ).toBeNull();
    expect(
      compiled(batchOf(new STTArcLayer(scene, { extensions: [] }))),
    ).toBeNull();
  });

  it('writes byte-identical alphas to a layer that has no extensions option', () => {
    for (const { mode, params } of MODES) {
      const bare = stubScene();
      const empty = stubScene();
      const a = new STTPointLayer(bare.scene, { mode, timeFilter: params });
      const b = new STTPointLayer(empty.scene, {
        mode,
        timeFilter: params,
        extensions: [],
      });
      const tile = (): Tile[] => [
        pointTile([0, 0, 1, 1, 2, 2, 3, 3], STARTS, ENDS, TIME_OFFSET),
      ];
      a.setTiles(tile());
      b.setTiles(tile());
      const ca = bare.added[0] as PointPrimitiveCollection;
      const cb = empty.added[0] as PointPrimitiveCollection;

      for (const absoluteMs of PLAYHEADS) {
        a.setTime(absoluteMs);
        b.setTime(absoluteMs);
        for (let i = 0; i < STARTS.length; i++) {
          expect(cb.get(i).color.alpha).toBe(ca.get(i).color.alpha);
        }
      }
    }
  });

  it('writes the same NUMBER of times — the cache still fires', () => {
    // Equal values would also hold if the empty list had quietly disabled the
    // skip and rewritten identical bytes every frame. The count is what
    // separates "same result" from "same work".
    function writeCount(extensions?: CesiumLayerExtension[]): number {
      const { scene, added } = stubScene();
      const layer = new STTBatchedPolylineLayer(scene, 'lines', {
        mode: 'window',
        timeFilter: { windowHalf: 400 },
        extensions,
      });
      layer.setPolylines(buildPathPolylines([LINE_TILE()]));
      const table = armPrimitive(added[0] as Primitive);
      for (const absoluteMs of PLAYHEADS) layer.setTime(absoluteMs);
      return table.writes();
    }
    const bare = writeCount(undefined);
    expect(writeCount([])).toBe(bare);
    expect(writeCount([{ name: 'inert' }])).toBe(bare);
    // Non-vacuity: the cache is genuinely skipping most frames here.
    expect(bare).toBeGreaterThan(0);
    expect(bare).toBeLessThan(PLAYHEADS.length * STARTS.length);
  });
});

// ─── The documented limits, asserted rather than only claimed ────────────────

describe('the documented limits of the value hook', () => {
  it('is one value per FEATURE — a hook cannot vary along a polyline', () => {
    // The ceiling this backend already documents for OD gradients: a batch-table
    // colour is one entry per instance, so every vertex of a line shares it.
    // Asserted here so the header's claim is testable rather than rhetorical.
    const { scene, added } = stubScene();
    const layer = new STTBatchedPolylineLayer(scene, 'lines', {
      mode: 'none',
      extensions: [
        {
          name: 'tint',
          color(out, _a, f) {
            out.r = f.featureIndex / 8;
          },
        },
      ],
    });
    layer.setPolylines(buildPathPolylines([LINE_TILE()]));
    const table = armPrimitive(added[0] as Primitive);
    layer.setTime(TIME_OFFSET + 500);
    // One byte per instance — there is no per-vertex slot to assert against.
    expect(table.bytesFor(2)[0]).toBe(Math.round((2 / 8) * 255));
    expect(table.bytesFor(2)).toHaveLength(4);
  });

  it('lets a throwing hook take the frame down rather than swallowing it', () => {
    // Deliberate: a try/catch per feature per frame would convert a visible
    // crash into an invisible no-op, at real cost.
    const { scene } = stubScene();
    const layer = new STTPointLayer(scene, {
      mode: 'none',
      extensions: [
        {
          name: 'boom',
          alpha(): number {
            throw new Error('hook failed');
          },
        },
      ],
    });
    layer.setTiles([pointTile([0, 0], [0], [1000], TIME_OFFSET)]);
    expect(() => layer.setTime(TIME_OFFSET + 500)).toThrow('hook failed');
  });

  it('cannot move a feature — geometry is baked when the tile set is published', () => {
    // The other half of the header's honesty: this seam reaches colour and
    // opacity, and nothing else. Positions are projected once per tile set, so a
    // hook scribbling on the scratch it is handed cannot displace anything.
    const { scene, added } = stubScene();
    const layer = new STTPointLayer(scene, {
      mode: 'none',
      extensions: [
        {
          name: 'would-move-it-if-it-could',
          color(out: ExtensionColor, _a, f: Readonly<ExtensionFeature>) {
            out.r = 1;
            // A hook is given provenance, not geometry: there is no position on
            // the scratch to write, and the columns it can reach are read-only
            // decoded tile buffers.
            expect((f as unknown as { x?: number }).x).toBeUndefined();
          },
        },
      ],
    });
    layer.setTiles([pointTile([12, 34], [0], [1000], TIME_OFFSET)]);
    const collection = added[0] as PointPrimitiveCollection;
    const before = collection.get(0).position.clone();
    layer.setTime(TIME_OFFSET + 500);
    expect(collection.get(0).position.equals(before)).toBe(true);
    expect(collection.get(0).color.red).toBe(1);
  });
});
