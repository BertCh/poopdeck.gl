// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTH3SummaryLayer` — the summary-tier cell kind.
 *
 * The pure cell kernel (u64 → ring → ECEF, the ramp, the extrusion) is covered
 * exhaustively in `summary-cells.test.ts`. What is proven HERE is the half that
 * file cannot reach:
 *   - the h3-js INJECTION contract (the constructor refuses to guess), and
 *   - that per-frame alpha comes from the shared `core/time-filter` oracle.
 *
 * `time-filter-oracle.test.ts`'s `PROVEN_IN_OWN_SUITE` map points at this file
 * for this layer, and its companion case asserts this file really does assert
 * against `timeFilterAlpha` — so weakening the sweep below breaks the
 * package-level gate too, not just this file.
 */

import { describe, it, expect } from 'vitest';
import { Primitive, type Scene } from 'cesium';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { STTH3SummaryLayer } from '../src/cesium-h3-summary-layer';
import type { H3CellToBoundary } from '../src/lib/summary-cells';

const TIME_OFFSET = 1_700_000_000_000;
const STARTS = [0, 120, 500, 999];
const ENDS = [40, 300, 900, 1200];

/** A synthetic boundary — deliberately NOT h3-js; the seam is the point. */
const cellToBoundary: H3CellToBoundary = (index: string) => {
  const lon = (parseInt(index, 16) % 100) * 0.1 - 122;
  const lat = 37.5;
  const d = 0.05;
  return [
    [lat - d, lon - d],
    [lat - d, lon + d],
    [lat + d, lon + d],
    [lat + d, lon - d],
  ];
};

function summaryTile(n: number, timeOffset = TIME_OFFSET): Tile {
  const features: BinaryFeatures = {
    featureCount: n,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(n * 2),
    featureIds: new Uint32Array(n),
    featureIds64: BigUint64Array.from(
      // BigInt arithmetic, not Number: a 60-bit H3 index has a 128 ms ULP as
      // a double, so `BigInt(0x8928308280fffff + i)` handed every row the SAME
      // cell id and the per-cell assertions below tested one cell four times.
      Array.from({ length: n }, (_, i) => 0x8928308280fffffn + BigInt(i)),
    ),
    startTimes: new Float32Array(STARTS.slice(0, n)),
    endTimes: new Float32Array(ENDS.slice(0, n)),
    timeOffset,
    numericProps: {
      count: new Float32Array(
        Array.from({ length: n }, (_, i) => (i + 1) * 10),
      ),
    },
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'summary',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
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

/** The batch-table stand-in; the `color` setter must COPY (one shared scratch). */
function armPrimitive(prim: Primitive): Map<unknown, Uint8Array> {
  const store = new Map<unknown, Uint8Array>();
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    const bytes = new Uint8Array(4);
    store.set(id, bytes);
    return {
      get color(): Uint8Array {
        return bytes;
      },
      set color(v: Uint8Array) {
        bytes.set(v);
      },
    } as never;
  };
  return store;
}

describe('the h3-js injection contract', () => {
  it('THROWS without cellToBoundary rather than importing h3-js or guessing', () => {
    const { scene } = stubScene();
    expect(() => new STTH3SummaryLayer(scene)).toThrow(
      /`cellToBoundary` option is required/,
    );
  });

  it('constructs with an injected resolver', () => {
    const { scene } = stubScene();
    expect(
      () => new STTH3SummaryLayer(scene, { cellToBoundary }),
    ).not.toThrow();
  });

  it('this package never imports h3-js', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    const manifest = pkg.default as Record<string, Record<string, string>>;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
    ]) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain('h3-js');
    }
  });
});

describe('STTH3SummaryLayer.setTime derives alpha from the core oracle', () => {
  const MODES: ReadonlyArray<{
    mode: TimeFilterMode;
    params: TimeFilterParams;
  }> = [
    { mode: 'window', params: { windowHalf: 400 } },
    { mode: 'window', params: { windowHalf: 400, fadeIn: 250, fadeOut: 150 } },
    { mode: 'wake', params: { wakeLength: 900 } },
    { mode: 'cumulative', params: { fadeIn: 700 } },
    { mode: 'trail', params: { trailLength: 600, trailFade: 1 } },
    { mode: 'none', params: {} },
  ];

  const PLAYHEADS: number[] = [];
  for (let t = -600; t <= 1800; t += 37) PLAYHEADS.push(TIME_OFFSET + t);
  for (const s of STARTS)
    PLAYHEADS.push(TIME_OFFSET + s, TIME_OFFSET + s + 900);
  for (const e of ENDS) PLAYHEADS.push(TIME_OFFSET + e);

  it('writes exactly `round(255 · timeFilterAlpha)` per cell, for every mode', () => {
    for (const { mode, params } of MODES) {
      const { scene, added } = stubScene();
      const layer = new STTH3SummaryLayer(scene, {
        cellToBoundary,
        mode,
        timeFilter: params,
      });
      layer.setTiles([summaryTile(4)]);
      const prim = added[0] as Primitive;
      const store = armPrimitive(prim);

      for (const absoluteMs of PLAYHEADS) {
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        const bytes = [...store.entries()]
          .sort(
            (a, b) =>
              (a[0] as { featureIndex: number }).featureIndex -
              (b[0] as { featureIndex: number }).featureIndex,
          )
          .map(([, v]) => v[3]);
        expect(bytes).toHaveLength(STARTS.length);
        for (let i = 0; i < STARTS.length; i++) {
          expect(bytes[i]).toBe(
            Math.round(
              255 * timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params),
            ),
          );
        }
      }
    }
  });

  it('is not vacuous: the sweep produces 0, 1 and a fractional alpha', () => {
    const seen = new Set<string>();
    for (const absoluteMs of PLAYHEADS) {
      const a = timeFilterAlpha(
        'window',
        absoluteMs - TIME_OFFSET,
        STARTS[1],
        ENDS[1],
        { windowHalf: 400, fadeIn: 250, fadeOut: 150 },
      );
      seen.add(a === 0 ? 'zero' : a === 1 ? 'one' : 'frac');
    }
    expect(seen).toEqual(new Set(['zero', 'one', 'frac']));
  });
});

describe('lifecycle', () => {
  it('keeps the standing primitive when a rebuild yields no cells', () => {
    const { scene, added } = stubScene();
    const layer = new STTH3SummaryLayer(scene, { cellToBoundary });
    layer.setTiles([summaryTile(3)]);
    expect(added).toHaveLength(1);
    const bare = summaryTile(1);
    delete bare.layers[0].features.featureIds64;
    layer.setTiles([bare]);
    // Build-before-teardown: no second primitive, and the first still stands.
    expect(added).toHaveLength(1);
  });
});
