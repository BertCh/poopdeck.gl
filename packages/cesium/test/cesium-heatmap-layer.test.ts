// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTHeatmapLayer` against a real `PrimitiveCollection`, a real `Primitive`
 * and a real `Material` — all of which construct fine under Node; only the
 * texture UPLOAD needs a GPU, and that is the one step stubbed here (via the
 * `imageSource` seam, which also lets the test see the exact RGBA raster the
 * layer would have handed Cesium).
 *
 * Three things are worth more than the rest:
 *   - the ORDERING (accumulate, then ramp) survives the layer wiring, so two
 *     coincident points really are hotter than one on the shipped path;
 *   - `setTime` agrees with the `timeFilterAlpha` oracle across every mode and
 *     playhead, and an out-of-window feature contributes ZERO density;
 *   - `setTiles` builds before it tears down, so an empty selection cannot
 *     blank a frame.
 */

import { describe, expect, it } from 'vitest';
import {
  GeometryInstance,
  Primitive,
  PrimitiveCollection,
  type Material,
  type Scene,
} from 'cesium';
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
import { STTHeatmapLayer } from '../src/cesium-heatmap-layer.js';
import {
  accumulateDensity,
  buildHeatmapSamples,
  fieldGridForBounds,
  padHeatmapBounds,
} from '../src/lib/heatmap-field.js';

// Cesium's `Material` sniffs each uniform's type with a chain of BARE
// `instanceof` checks against DOM classes — `HTMLCanvasElement`,
// `HTMLImageElement`, `ImageBitmap`, `OffscreenCanvas` — with no `typeof`
// guard (engine `Material.js`, `getUniformType`). Any uniform that is not a
// number/string/boolean therefore makes merely CONSTRUCTING a Material throw a
// ReferenceError under `environment: 'node'`. Nothing below needs these classes
// to DO anything; they only have to exist so `instanceof` can answer false.
// This shims a Cesium implementation detail, not the code under test: the
// PrimitiveCollection, the Primitive, the GeometryInstance and the Material are
// all the real thing. `ImageData` is deliberately NOT shimmed, so the layer's
// default texture source correctly reports "headless" and skips the upload.
for (const name of [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'HTMLVideoElement',
  'ImageBitmap',
  'OffscreenCanvas',
]) {
  if (!(name in globalThis)) {
    (globalThis as unknown as Record<string, unknown>)[name] = class {};
  }
}

interface Stub {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  /** What the next `scene.pick` returns. */
  picked: { value: unknown };
}

function stubScene(): Stub {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const picked: { value: unknown } = { value: undefined };
  const scene = {
    primitives: {
      add<T>(p: T): T {
        added.push(p);
        return p;
      },
      remove(p: unknown): boolean {
        removed.push(p);
        return true;
      },
    },
    pick(): unknown {
      return picked.value;
    },
  } as unknown as Scene;
  return { scene, added, removed, picked };
}

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  timeOffset = 0,
  numericProps: Record<string, Float32Array> = {},
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
    numericProps,
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

const TIME_OFFSET = 1_700_000_000_000;

/** Two points 0.5 degrees apart, with different windows. */
function fixtureTile(): Tile {
  return pointTile(
    [0, 0, 0.5, 0.5, -0.5, -0.5],
    [0, 120, 500],
    [40, 300, 900],
    TIME_OFFSET,
  );
}

function collectionOf(stub: Stub): PrimitiveCollection {
  return stub.added[0] as PrimitiveCollection;
}

function firstPrimitive(stub: Stub): Primitive {
  return collectionOf(stub).get(0) as Primitive;
}

describe('STTHeatmapLayer — construction and lifecycle', () => {
  it('registers a PrimitiveCollection into scene.primitives immediately', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene);
    expect(stub.added).toHaveLength(1);
    expect(collectionOf(stub)).toBeInstanceOf(PrimitiveCollection);
    expect(layer.id).toBe('stt-cesium-heatmap');
  });

  it('honours an explicit id', () => {
    const stub = stubScene();
    expect(new STTHeatmapLayer(stub.scene, { id: 'heat' }).id).toBe('heat');
  });

  it('builds exactly one textured rectangle Primitive for the raster', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, { rebuildMs: 0 });
    layer.setTiles([fixtureTile()]);
    const collection = collectionOf(stub);
    expect(collection.length).toBe(1);
    const prim = firstPrimitive(stub);
    expect(prim).toBeInstanceOf(Primitive);
    const instance = prim.geometryInstances as GeometryInstance;
    expect(instance).toBeInstanceOf(GeometryInstance);
    expect((instance.id as { layerId: string }).layerId).toBe(
      'stt-cesium-heatmap',
    );
  });

  it('rasters over the PADDED extent of the samples', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, { rebuildMs: 0 });
    layer.setTiles([fixtureTile()]);
    layer.setTime(TIME_OFFSET);
    const field = layer.fieldSnapshot();
    const expected = padHeatmapBounds({
      west: -0.5,
      south: -0.5,
      east: 0.5,
      north: 0.5,
    });
    expect(field?.bounds).toEqual(expected);
    // ...and a raster sized by the same grid rule.
    expect({ width: field?.width, height: field?.height }).toEqual(
      fieldGridForBounds(expected, 256),
    );
  });

  it('accepts an explicit bounds override', () => {
    const stub = stubScene();
    const bounds = { west: -20, south: -10, east: 20, north: 10 };
    const layer = new STTHeatmapLayer(stub.scene, { rebuildMs: 0, bounds });
    layer.setTiles([fixtureTile()]);
    expect(layer.fieldSnapshot()?.bounds).toEqual(bounds);
  });

  it('BUILDS BEFORE IT TEARS DOWN: an empty selection leaves the old raster standing', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, { rebuildMs: 0 });
    layer.setTiles([fixtureTile()]);
    layer.setTime(TIME_OFFSET + 20);
    const before = layer.fieldSnapshot();
    const primBefore = firstPrimitive(stub);
    expect(before?.max).toBeGreaterThan(0);

    layer.setTiles([]); // a decode gap, not a real emptiness
    expect(collectionOf(stub).length).toBe(1);
    expect(firstPrimitive(stub)).toBe(primBefore);
    expect(layer.fieldSnapshot()).toBe(before);

    // And the previous timeOrigin survives, so the playhead does not jump.
    layer.setTime(TIME_OFFSET + 20);
    expect(layer.fieldSnapshot()?.max).toBeCloseTo(before?.max ?? 0, 6);
  });

  it('replaces the primitive and the material on a real rebuild', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, { rebuildMs: 0 });
    layer.setTiles([fixtureTile()]);
    const first = firstPrimitive(stub);
    const firstMaterial = (first.appearance as { material: Material }).material;

    layer.setTiles([pointTile([5, 5, 6, 6], [0, 0], [10, 10], TIME_OFFSET)]);
    expect(collectionOf(stub).length).toBe(1);
    expect(firstPrimitive(stub)).not.toBe(first);
    // The Material is OURS — the collection's teardown never frees it, so the
    // layer must, or every rebuild leaks a texture.
    expect(firstMaterial.isDestroyed()).toBe(true);
  });

  it('dispose removes the collection and destroys the material it owns', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, { rebuildMs: 0 });
    layer.setTiles([fixtureTile()]);
    const material = (firstPrimitive(stub).appearance as { material: Material })
      .material;

    layer.dispose();
    expect(stub.removed).toEqual([collectionOf(stub)]);
    expect(material.isDestroyed()).toBe(true);
    expect(layer.rasterSnapshot()).toBeNull();
    expect(layer.fieldSnapshot()).toBeNull();
    expect(layer.peakSnapshot()).toBeNull();
    expect(() => layer.setTime(TIME_OFFSET)).not.toThrow();
  });
});

describe('STTHeatmapLayer — density, not dots', () => {
  const at = (lon: number, lat: number, n: number): Tile => {
    const pos: number[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < n; i++) {
      pos.push(lon, lat);
      starts.push(0);
      ends.push(1000);
    }
    return pointTile(pos, starts, ends, TIME_OFFSET);
  };

  it('THE ORDERING INVARIANT, end to end: two coincident points are hotter than one', () => {
    const bounds = { west: -1, south: -1, east: 1, north: 1 };
    const build = (n: number): STTHeatmapLayer => {
      const stub = stubScene();
      const layer = new STTHeatmapLayer(stub.scene, {
        rebuildMs: 0,
        bounds,
        resolution: 64,
        radiusPixels: 8,
        colorDomain: [0, 2],
        threshold: 0,
      });
      layer.setTiles([at(0, 0, n)]);
      layer.setTime(TIME_OFFSET + 500);
      return layer;
    };
    const one = build(1);
    const two = build(2);
    expect(two.fieldSnapshot()!.max).toBeCloseTo(
      2 * one.fieldSnapshot()!.max,
      6,
    );

    // ...and the ramp reads that SUM, so the raster gets hotter too. (Summing
    // per-splat COLOURS instead would drive both channels toward white.)
    const peakRgba = (l: STTHeatmapLayer): number[] => {
      const r = l.rasterSnapshot()!;
      const f = l.fieldSnapshot()!;
      let best = 0;
      let bi = 0;
      for (let i = 0; i < f.values.length; i++) {
        if (f.values[i] > best) {
          best = f.values[i];
          bi = i;
        }
      }
      return Array.from(r.rgba.slice(bi * 4, bi * 4 + 4));
    };
    const hot = peakRgba(two);
    const warm = peakRgba(one);
    expect(hot[1]).toBeLessThan(warm[1]); // less green = further up the ramp
    expect(hot[3]).toBeGreaterThan(warm[3]);
    expect(hot[1]).toBeLessThan(40); // deep red, NOT blown out to white
  });

  it('gives an out-of-window feature exactly zero density', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, {
      rebuildMs: 0,
      mode: 'window',
      timeFilter: { windowHalf: 10 },
      resolution: 64,
    });
    layer.setTiles([fixtureTile()]);

    // The peak is reported at a CELL CENTRE, so it lands within half a cell of
    // the feature that produced it — here roughly 0.01 degrees.
    layer.setTime(TIME_OFFSET + 20); // only feature 0 (0..40) is in window
    const near = layer.peakSnapshot();
    expect(near?.lon).toBeCloseTo(0, 1);
    expect(near?.lat).toBeCloseTo(0, 1);

    layer.setTime(TIME_OFFSET + 700); // only feature 2 (500..900)
    const late = layer.peakSnapshot();
    expect(late?.lon).toBeCloseTo(-0.5, 1);

    layer.setTime(TIME_OFFSET + 5000); // nothing at all
    expect(layer.fieldSnapshot()?.max).toBe(0);
    expect(layer.peakSnapshot()).toBeNull();
    expect(layer.rasterSnapshot()!.rgba.every((v) => v === 0)).toBe(true);
  });

  it('weights density from a baked column', () => {
    const bounds = { west: -1, south: -1, east: 1, north: 1 };
    const tile = pointTile([0, 0], [0], [1000], TIME_OFFSET, {
      mag: new Float32Array([7]),
    });
    const heavy = new STTHeatmapLayer(stubScene().scene, {
      rebuildMs: 0,
      bounds,
      resolution: 64,
      weightProperty: 'mag',
    });
    heavy.setTiles([tile]);
    heavy.setTime(TIME_OFFSET + 500);

    const plain = new STTHeatmapLayer(stubScene().scene, {
      rebuildMs: 0,
      bounds,
      resolution: 64,
    });
    plain.setTiles([tile]);
    plain.setTime(TIME_OFFSET + 500);

    expect(heavy.fieldSnapshot()!.max).toBeCloseTo(
      7 * plain.fieldSnapshot()!.max,
      5,
    );
  });

  it('hands the RGBA raster to Cesium as a texture source, fresh per rebuild', () => {
    const stub = stubScene();
    const seen: { rgba: Uint8ClampedArray; width: number; height: number }[] =
      [];
    const layer = new STTHeatmapLayer(stub.scene, {
      rebuildMs: 0,
      resolution: 32,
      imageSource: (rgba, width, height) => {
        seen.push({ rgba, width, height });
        return { token: seen.length };
      },
    });
    layer.setTiles([fixtureTile()]);
    layer.setTime(TIME_OFFSET + 20);

    expect(seen.length).toBeGreaterThanOrEqual(2); // seed + first tick
    const last = seen[seen.length - 1];
    expect(last.rgba.length).toBe(last.width * last.height * 4);
    const material = (firstPrimitive(stub).appearance as { material: Material })
      .material;
    // A NEW identity every rebuild — Cesium only re-uploads when the uniform
    // reference changes, so a reused canvas would freeze the first frame's heat.
    expect(material.uniforms.image).toEqual({ token: seen.length });
  });

  it('still computes the field headlessly when no texture source is available', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, {
      rebuildMs: 0,
      resolution: 32,
      imageSource: () => undefined,
    });
    layer.setTiles([fixtureTile()]);
    layer.setTime(TIME_OFFSET + 20);
    expect(layer.fieldSnapshot()!.max).toBeGreaterThan(0);
    expect(layer.rasterSnapshot()!.rgba.some((v) => v > 0)).toBe(true);
  });
});

describe('STTHeatmapLayer — setTime agrees with the timeFilterAlpha oracle', () => {
  const MODES: { mode: TimeFilterMode; params: TimeFilterParams }[] = [
    { mode: 'window', params: { windowHalf: 400 } },
    { mode: 'window', params: { windowHalf: 400, fadeIn: 250, fadeOut: 150 } },
    { mode: 'wake', params: { wakeLength: 900 } },
    { mode: 'cumulative', params: { fadeIn: 0 } },
    { mode: 'cumulative', params: { fadeIn: 700 } },
    { mode: 'trail', params: { trailLength: 600, trailFade: 1 } },
    { mode: 'trail', params: { trailLength: 600, trailFade: 0.35 } },
    { mode: 'none', params: {} },
  ];
  // A coprime stride across and beyond every feature, PLUS the exact boundary
  // instants — the stride alone never lands ON a startTime, the only place
  // wake/trail reach alpha 1.
  const PLAYHEADS = [
    -300, 0, 40, 120, 173, 300, 419, 500, 665, 900, 911, 999, 1157, 1200, 1403,
    2000,
  ];
  // Must match the layer's own alpha quantisation: a fade smaller than 1/32
  // cannot move a byte of the ramped raster, and is treated as unchanged.
  const quantise = (a: number): number => Math.round(a * 32) / 32;

  const BOUNDS = { west: -1, south: -1, east: 1, north: 1 };
  const DENSITY = {
    bounds: BOUNDS,
    width: 64,
    height: 64,
    radiusPixels: 8,
  } as const;

  it('reproduces the oracle field for every mode and playhead', () => {
    const tiles = [fixtureTile()];
    const samples = buildHeatmapSamples(tiles).samples;

    for (const { mode, params } of MODES) {
      const layer = new STTHeatmapLayer(stubScene().scene, {
        rebuildMs: 0,
        mode,
        timeFilter: params,
        bounds: BOUNDS,
        resolution: 64,
        radiusPixels: 8,
      });
      layer.setTiles(tiles);

      for (const t of PLAYHEADS) {
        layer.setTime(TIME_OFFSET + t);
        const alphas = samples.map((s) =>
          quantise(timeFilterAlpha(mode, t, s.start, s.end, params)),
        );
        const expected = accumulateDensity(samples, alphas, {
          ...DENSITY,
          width: 64,
          height: 64,
        });
        const actual = layer.fieldSnapshot()!;
        expect(actual.max, `${mode} @ ${t}`).toBeCloseTo(expected.max, 5);
        expect(
          actual.values[actual.width * 32 + 32],
          `${mode} @ ${t}`,
        ).toBeCloseTo(expected.values[expected.width * 32 + 32], 5);
      }
    }
  });

  it('does not re-splat when no feature alpha moved', () => {
    const layer = new STTHeatmapLayer(stubScene().scene, {
      rebuildMs: 0,
      mode: 'window',
      timeFilter: { windowHalf: 400 },
      resolution: 64,
    });
    layer.setTiles([fixtureTile()]);
    layer.setTime(TIME_OFFSET + 200);
    const field = layer.fieldSnapshot();
    layer.setTime(TIME_OFFSET + 201); // same quantised alphas everywhere
    expect(layer.fieldSnapshot()).toBe(field); // identity: no rebuild happened
    layer.setTime(TIME_OFFSET + 900); // a real change
    expect(layer.fieldSnapshot()).not.toBe(field);
  });

  it('gates the CPU splat on a sim-time bucket', () => {
    let rebuilds = 0;
    const layer = new STTHeatmapLayer(stubScene().scene, {
      rebuildMs: 250,
      mode: 'window',
      timeFilter: { windowHalf: 50 },
      resolution: 32,
      imageSource: () => {
        rebuilds++;
        return undefined;
      },
    });
    layer.setTiles([fixtureTile()]);
    const seed = rebuilds;
    // 24 ticks, all inside bucket 0 (`round(t / 250) === 0` for t < 125).
    for (let t = 0; t < 120; t += 5) layer.setTime(TIME_OFFSET + t);
    expect(rebuilds - seed).toBeLessThanOrEqual(1); // one bucket, one splat
    layer.setTime(TIME_OFFSET + 900); // several buckets later
    expect(rebuilds - seed).toBeGreaterThan(1);
  });

  it('is inert before any tiles arrive', () => {
    const layer = new STTHeatmapLayer(stubScene().scene, { rebuildMs: 0 });
    expect(() => layer.setTime(TIME_OFFSET)).not.toThrow();
    expect(layer.fieldSnapshot()).toBeNull();
  });
});

describe('STTHeatmapLayer — picking', () => {
  it('resolves a hit to the peak contributor and the peak coordinate', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, {
      rebuildMs: 0,
      mode: 'window',
      timeFilter: { windowHalf: 10 },
      resolution: 64,
    });
    layer.setTiles([fixtureTile()]);
    layer.setTime(TIME_OFFSET + 700); // only feature 2 is in the window

    const instance = firstPrimitive(stub).geometryInstances as GeometryInstance;
    stub.picked.value = { id: instance.id };
    const result = layer.pick(12, 34);
    expect(result).not.toBeNull();
    expect(result?.layerId).toBe('stt-cesium-heatmap');
    expect(result?.index).toBe(2);
    expect(result?.screen).toEqual([12, 34]);
    expect(result?.coordinate?.[0]).toBeCloseTo(-0.5, 2);
    expect(result?.object).toBeDefined();
  });

  it('re-points the single pick id as the field changes', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, {
      rebuildMs: 0,
      mode: 'window',
      timeFilter: { windowHalf: 10 },
      resolution: 64,
    });
    layer.setTiles([fixtureTile()]);
    const instance = firstPrimitive(stub).geometryInstances as GeometryInstance;
    stub.picked.value = { id: instance.id };

    layer.setTime(TIME_OFFSET + 20);
    expect(layer.pick(1, 1)?.index).toBe(0);
    layer.setTime(TIME_OFFSET + 200);
    expect(layer.pick(1, 1)?.index).toBe(1);
  });

  it('returns null for a miss, a foreign layer, and an id-less pick', () => {
    const stub = stubScene();
    const layer = new STTHeatmapLayer(stub.scene, { rebuildMs: 0 });
    layer.setTiles([fixtureTile()]);

    stub.picked.value = undefined;
    expect(layer.pick(1, 1)).toBeNull();
    stub.picked.value = {};
    expect(layer.pick(1, 1)).toBeNull();
    stub.picked.value = {
      id: { layerId: 'someone-else', binary: null, featureIndex: 0 },
    };
    expect(layer.pick(1, 1)).toBeNull();
    stub.picked.value = {
      id: { layerId: layer.id, binary: null, featureIndex: 0 },
    };
    expect(layer.pick(1, 1)).toBeNull();
  });
});
