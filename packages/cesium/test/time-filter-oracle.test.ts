// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * Pins Cesium's SHIPPED time-filter path to the core oracle.
 *
 * Cesium is the one backend with no shader of its own: `STTPointLayer.setTime`
 * and `STTBatchedPolylineLayer.setTime` (and therefore `STTPathLayer` /
 * `STTArcLayer`) call `core/time-filter`'s `timeFilterAlpha` directly and write
 * the result into a Cesium colour. That makes conformance trivially true TODAY
 * — and trivially easy to lose: a local `wakeAlpha` copy, an inlined ramp, or a
 * "small" clamp added for one demo would drift silently, because nothing else
 * in this package compares the two. (`test/shaders.test.ts` covers the
 * GENERATED GLSL, which no layer renders with; it says nothing about this.)
 *
 * So these tests drive the layers' real update path — `setTiles` then
 * `setTime` — and read the alpha back off the Cesium object the layer wrote,
 * asserting it equals `timeFilterAlpha(mode, …)` for every mode across a dense
 * sweep. They are not re-deriving the alpha math; core's own tests do that.
 * They assert only that Cesium still ROUTES through it.
 *
 * Node harness: the layers need a `Scene` only for `scene.primitives`, so a
 * stub with `add`/`remove` is enough to capture what the layer built (same
 * argument `camera-apply.test.ts` makes for a real `Camera` under Node). The
 * point layer's `PointPrimitiveCollection` is genuinely constructible under
 * Node and stores real `Color`s. The polyline layer's batch table is NOT — it
 * exists only after a real render — so the captured `Primitive` is given a
 * ready flag and a byte-copying attribute stand-in, which is exactly the
 * contract `getGeometryInstanceAttributes` has with `setTime`.
 */

import { describe, it, expect } from 'vitest';
import { PointPrimitiveCollection, type Primitive, type Scene } from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { STTPointLayer } from '../src/cesium-point-layer';
import { STTBatchedPolylineLayer } from '../src/batched-polyline-layer';
import { buildPathPolylines } from '../src/lib/polylines';

// ─── Fixtures (same shape as points.test.ts / polylines.test.ts) ─────────────

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

/** A `Scene` stub that only records what the layer hands `scene.primitives`. */
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

// ─── The mode matrix every assertion below sweeps ────────────────────────────

/** Every mode the layers accept, with in-contract params. `none` ⇒ constant 1. */
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

/** Tile-relative feature times, and the absolute playheads to sweep. */
const TIME_OFFSET = 1_700_000_000_000;
const STARTS = [0, 120, 500, 999];
const ENDS = [40, 300, 900, 1200];
/**
 * Absolute playheads: a coprime stride across (and beyond) every feature, plus
 * the exact boundary instants. The stride alone never lands ON a `startTime`,
 * which is the only place `wake`/`trail` reach alpha 1 — see the non-vacuity
 * test below, which is what caught that.
 */
const PLAYHEADS: number[] = [];
for (let t = -600; t <= 1800; t += 37) PLAYHEADS.push(TIME_OFFSET + t);
for (const s of STARTS) PLAYHEADS.push(TIME_OFFSET + s); // age 0: wake/trail head
for (const e of ENDS) PLAYHEADS.push(TIME_OFFSET + e);
for (const s of STARTS) PLAYHEADS.push(TIME_OFFSET + s + 900); // wake tail exactly

describe('STTPointLayer.setTime derives alpha from the core oracle', () => {
  it('writes exactly `timeFilterAlpha` into every point, for every mode', () => {
    for (const { mode, params } of MODES) {
      const { scene, added } = stubScene();
      const layer = new STTPointLayer(scene, { mode, timeFilter: params });
      layer.setTiles([
        pointTile([0, 0, 1, 1, 2, 2, 3, 3], STARTS, ENDS, TIME_OFFSET),
      ]);
      const collection = added[0] as PointPrimitiveCollection;
      expect(collection.length).toBe(STARTS.length);

      for (const absoluteMs of PLAYHEADS) {
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        for (let i = 0; i < STARTS.length; i++) {
          // Base categorical alpha is the default grey's 255/255 == 1, so the
          // written alpha IS the oracle's value — no tolerance needed. If the
          // layer ever inlines its own ramp, this goes red on the first
          // fractional sample rather than only at the extremes.
          expect(collection.get(i).color.alpha).toBe(
            timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params),
          );
        }
      }
    }
  });

  it('multiplies the oracle alpha by the base colour alpha, and nothing else', () => {
    // The one transform the layer is allowed to apply on top of the oracle.
    const { scene, added } = stubScene();
    const layer = new STTPointLayer(scene, {
      mode: 'window',
      timeFilter: { windowHalf: 400, fadeIn: 250 },
      colorMappingDefault: [10, 20, 30, 128],
    });
    layer.setTiles([pointTile([0, 0], [200], [600], TIME_OFFSET)]);
    const collection = added[0] as PointPrimitiveCollection;
    const base = 128 / 255;
    for (const absoluteMs of PLAYHEADS) {
      layer.setTime(absoluteMs);
      expect(collection.get(0).color.alpha).toBe(
        base *
          timeFilterAlpha('window', absoluteMs - TIME_OFFSET, 200, 600, {
            windowHalf: 400,
            fadeIn: 250,
          }),
      );
    }
  });

  it('rebases the playhead through the build timeOrigin, not the raw epoch', () => {
    // A layer that forgot the rebase would still "use the oracle" while feeding
    // it absolute ms — every feature permanently dark. Two tiles with different
    // timeOffsets pin that the second one's alpha tracks its own times.
    const { scene, added } = stubScene();
    const layer = new STTPointLayer(scene, {
      mode: 'wake',
      timeFilter: { wakeLength: 1000 },
    });
    layer.setTiles([
      pointTile([0, 0], [0], [100], TIME_OFFSET),
      pointTile([1, 1], [0], [100], TIME_OFFSET + 3000),
    ]);
    const collection = added[0] as PointPrimitiveCollection;
    layer.setTime(TIME_OFFSET + 3500);
    // Feature 1 is rebased to start 3000 → age 500 → half-lit.
    expect(collection.get(1).color.alpha).toBe(
      timeFilterAlpha('wake', 3500, 3000, 3100, { wakeLength: 1000 }),
    );
    expect(collection.get(1).color.alpha).toBe(0.5);
    // Feature 0 started 3500 ms ago — past the 1000 ms wake.
    expect(collection.get(0).color.alpha).toBe(0);
  });
});

describe('STTBatchedPolylineLayer.setTime derives alpha from the core oracle', () => {
  /**
   * Stand in for the GPU batch table. `getGeometryInstanceAttributes` exists
   * only after a real render, and `setTime` bails on `!primitive.ready` — so the
   * captured `Primitive` gets an own `ready` (shadowing the prototype getter)
   * and a per-instance attribute object whose `color` setter COPIES, exactly
   * like Cesium's. Copying matters: the layer writes one shared scratch
   * `Uint8Array` for every entry, so a stand-in that stored the reference would
   * report the last write for all of them.
   */
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

  it('writes exactly `round(255 · timeFilterAlpha)` per instance, for every mode', () => {
    for (const { mode, params } of MODES) {
      const { scene, added } = stubScene();
      const layer = new STTBatchedPolylineLayer(scene, 'lines', {
        mode,
        timeFilter: params,
      });
      layer.setPolylines(
        buildPathPolylines([
          lineTile(
            [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0],
            [0, 2, 4, 6, 8],
            STARTS,
            ENDS,
            TIME_OFFSET,
          ),
        ]),
      );
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
          // Batch-table colours are u8, so the ONLY licensed loss between the
          // oracle and the byte is the layer's own `Math.round(alpha * 255)`.
          expect(bytes[i]).toBe(
            Math.round(
              255 * timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params),
            ),
          );
        }
      }
    }
  });
});

describe('the oracle is the only alpha definition in the package', () => {
  /**
   * A structural backstop for the sweeps above, which can only police a layer
   * someone remembered to instantiate here. Every module with a per-frame
   * `setTime` must either import the oracle or be an explicitly reasoned
   * exception — so a NEW animated layer cannot quietly grow its own alpha.
   *
   * Deliberately an import check, not a regex hunt for `1 - age / length`: any
   * such pattern match is one local alias away from being evaded, and would
   * read as protection it does not provide. What this DOES catch is the
   * realistic drift — a layer added without the oracle in scope at all.
   */
  const EXEMPT_SETTIME: Readonly<Record<string, string>> = {
    'cesium-trips-layer.ts':
      'animates GEOMETRY: trims each trip to the trail window via core `trimTrail`',
    'cesium-trip-heads-layer.ts':
      'animates POSITION: lerps each head along its trip, no alpha',
    'cesium-path-layer.ts':
      'delegates setTime to STTBatchedPolylineLayer (covered by the sweep above)',
    'cesium-arc-layer.ts':
      'delegates setTime to STTBatchedPolylineLayer (covered by the sweep above)',
    // Added by the non-deck parity campaign.
    'cesium-bounding-box-layer.ts':
      'animates POSE: emits one interpolated instance per ACTIVE track, so visibility is implicit (an inactive track is simply not emitted) and there is no alpha to derive',
    'cesium-ego-layer.ts':
      'animates POSE: one marker at the interpolated ego pose, shown only while the play head lies inside the track span — implicit visibility, no alpha',
    'cesium-mesh-layer.ts':
      'animates POSE: one interpolated glTF Model per ACTIVE track, so visibility is implicit (an inactive track is not emitted) and there is no alpha to derive',
    'cesium-iso-layer.ts':
      'delegates setTime to its composed STTBatchedPolylineLayer buckets (covered by the sweep above)',
  };

  /**
   * Alpha-computing layers whose oracle agreement is proven in their OWN test
   * file rather than by a sweep in this one.
   *
   * The `checked` assertion below is the real gate — it fails the moment a new
   * animated layer appears. Bumping that number without recording WHERE the new
   * layer is proven would turn the gate into a rubber stamp, so every non-swept
   * entry names its proof. A file listed here with no such test is a lie this
   * map makes visible instead of hiding.
   */
  const PROVEN_IN_OWN_SUITE: Readonly<Record<string, string>> = {
    'cesium-column-layer.ts': 'test/cesium-column-layer.test.ts',
    'cesium-flow-corridor-layer.ts': 'test/cesium-flow-corridor-layer.test.ts',
    'cesium-flow-stroke-layer.ts': 'test/cesium-flow-stroke-layer.test.ts',
    'cesium-flowmap-layer.ts': 'test/cesium-flowmap-layer.test.ts',
    'cesium-h3-summary-layer.ts': 'test/cesium-h3-summary-layer.test.ts',
    'cesium-heatmap-layer.ts': 'test/cesium-heatmap-layer.test.ts',
    'cesium-hexbin-layer.ts': 'test/cesium-hexbin-layer.test.ts',
    'cesium-icon-layer.ts': 'test/cesium-icon-layer.test.ts',
    'cesium-point-cloud-layer.ts': 'test/cesium-point-cloud-layer.test.ts',
    'cesium-polygon-layer.ts': 'test/cesium-polygon-layer.test.ts',
    'cesium-quadbin-summary-layer.ts':
      'test/cesium-quadbin-summary-layer.test.ts',
    'cesium-surfel-layer.ts': 'test/cesium-surfel-layer.test.ts',
    'cesium-text-layer.ts': 'test/cesium-text-layer.test.ts',
  };

  it('every layer with a per-frame setTime routes alpha through core/time-filter', () => {
    const sources = import.meta.glob('../src/**/*.ts', {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10); // glob really loaded

    const offenders: string[] = [];
    // Exempt files claiming to DELEGATE must actually delegate — if
    // `cesium-path-layer` ever grows its own alpha loop, the exemption is no
    // longer true. Collected by name so a failure says which file broke.
    const notDelegating: string[] = [];
    let checked = 0;
    for (const [path, src] of Object.entries(sources)) {
      if (!/\bsetTime\s*\(/.test(src)) continue;
      const file = path.slice(path.lastIndexOf('/') + 1);
      if (file in EXEMPT_SETTIME) {
        if (
          EXEMPT_SETTIME[file].startsWith('delegates') &&
          !/setTime\([^)]*\)[^{]*\{\s*this\.\w+\.setTime\(/.test(src)
        ) {
          notDelegating.push(file);
        }
        continue;
      }
      checked++;
      const importsOracle =
        /from\s+'@poopdeck\.gl\/core\/time-filter'/.test(src) &&
        /\btimeFilterAlpha\b/.test(src);
      if (!importsOracle) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    expect(notDelegating).toEqual([]);
    // Two swept in THIS file (the point layer and the batched polyline layer)
    // plus the three the parity campaign added, each proven in its own suite —
    // see PROVEN_IN_OWN_SUITE. A sixth would mean an untested animated layer.
    expect(checked).toBe(2 + Object.keys(PROVEN_IN_OWN_SUITE).length);
  });

  it('every layer claiming proof elsewhere really has that proof', () => {
    // The companion to the count above: PROVEN_IN_OWN_SUITE is only worth
    // anything if the files it names exist AND actually pin the layer to the
    // oracle. Without this, adding a line to that map would be enough to make
    // the count pass — which is exactly the rubber stamp the map exists to
    // prevent.
    const suites = import.meta.glob('./*.test.ts', {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>;
    for (const [layer, suitePath] of Object.entries(PROVEN_IN_OWN_SUITE)) {
      const key = './' + suitePath.replace(/^test\//, '');
      const src = suites[key];
      expect(
        src,
        `${layer} claims proof in ${suitePath}, which does not exist`,
      ).toBeDefined();
      expect(
        /from\s+'@poopdeck\.gl\/core\/time-filter'/.test(src ?? '') &&
          /\btimeFilterAlpha\b/.test(src ?? ''),
        `${suitePath} must actually assert against timeFilterAlpha to back ${layer}`,
      ).toBe(true);
    }
  });
});

describe('the sweeps are not vacuous', () => {
  it('every mode contributes fractional alphas over the fixture times', () => {
    // Without this, a fixture drift that put every feature permanently outside
    // every window would leave the assertions above comparing 0 to 0 forever.
    for (const { mode, params } of MODES) {
      if (mode === 'none') continue; // constant 1 by definition
      let fractional = 0;
      let zero = 0;
      let full = 0;
      for (const absoluteMs of PLAYHEADS) {
        const cur = absoluteMs - TIME_OFFSET;
        for (let i = 0; i < STARTS.length; i++) {
          const a = timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params);
          if (a === 0) zero++;
          else if (a === 1) full++;
          else fractional++;
        }
      }
      expect(zero, `${mode} never fully hidden`).toBeGreaterThan(0);
      expect(full, `${mode} never fully lit`).toBeGreaterThan(0);
      // A ramp exists only where a fade is POSITIVE (fadeIn: 0 is a hard
      // pop-in, deliberately in the matrix) or the mode ramps by construction.
      const ramps =
        (params.fadeIn ?? 0) > 0 ||
        (params.fadeOut ?? 0) > 0 ||
        mode === 'wake' ||
        mode === 'trail';
      if (ramps)
        expect(fractional, `${mode} never mid-ramp`).toBeGreaterThan(0);
    }
  });
});
