// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTTextLayer` against a stub `Scene` and a REAL Cesium `LabelCollection`.
 * Cesium loads fine under Node — what does not work is anything needing a live
 * WebGL context (a real Scene, a render pass, the glyph atlas bake). Collection
 * construction, `add`, the primitive setters and `removeAll` all work, so the
 * layer is exercised for real here; only the pixels are unverified.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Color, HorizontalOrigin, LabelStyle, VerticalOrigin } from 'cesium';
import type { Label, LabelCollection, Scene } from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { timeFilterAlpha } from '@poopdeck.gl/core/time-filter';
import { STTTextLayer } from '../src/cesium-text-layer';

// ── the ONE DOM touch Cesium's Label needs ──────────────────────────────────
// `new Label(...)` calls `parseFont`, which measures the CSS font shorthand by
// appending a real <div> and reading `getComputedStyle`. That is the whole DOM
// surface — no canvas, no WebGL — and Cesium memoizes the result per font
// string, so it happens once per distinct `font`. A four-method stand-in is
// enough to construct real Labels under vitest's `node` environment; the
// metrics it reports are never asserted on, only the fact that construction
// completes.
interface StubStyle {
  position: string;
  opacity: number;
  font: string;
}
const FONT_METRICS: Record<string, string> = {
  'line-height': 'normal',
  'font-family': 'sans-serif',
  'font-size': '14px',
  'font-style': 'normal',
  'font-weight': '600',
};
if (!('document' in globalThis)) {
  (globalThis as Record<string, unknown>).document = {
    createElement: (): { style: StubStyle } => ({
      style: { position: '', opacity: 1, font: '' },
    }),
    body: { appendChild(): void {}, removeChild(): void {} },
    defaultView: {
      getComputedStyle: (): { getPropertyValue(p: string): string } => ({
        getPropertyValue: (p: string): string => FONT_METRICS[p] ?? '',
      }),
    },
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────

function pointFeatures(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): BinaryFeatures {
  const featureCount = startTimes.length;
  return {
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
    ...partial,
  };
}

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features: pointFeatures(
          positions,
          startTimes,
          endTimes,
          partial,
          timeOffset,
        ),
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

function labelled(
  texts: string[],
  startTimes: number[],
  endTimes: number[],
  timeOffset = 0,
): Tile {
  const positions: number[] = [];
  for (let i = 0; i < texts.length; i++) positions.push(i, i + 1);
  return pointTile(
    positions,
    startTimes,
    endTimes,
    {
      categoricalProps: {
        name: {
          indices: new Uint16Array(texts.map((_, i) => i)),
          categories: texts,
        },
      },
    },
    timeOffset,
  );
}

interface StubScene {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  removeResult: { value: boolean };
  picked: { value: unknown };
}

function stubScene(): StubScene {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const removeResult = { value: true };
  const picked: { value: unknown } = { value: undefined };
  const scene = {
    primitives: {
      add<T>(p: T): T {
        added.push(p);
        return p;
      },
      remove(p: unknown): boolean {
        removed.push(p);
        return removeResult.value;
      },
    },
    pick(): unknown {
      return picked.value;
    },
  } as unknown as Scene;
  return { scene, added, removed, removeResult, picked };
}

function collectionOf(s: StubScene): LabelCollection {
  return s.added[0] as LabelCollection;
}

/**
 * Shadow a Label's colour accessors with counting stand-ins that COPY on write,
 * exactly like Cesium's own setters. The copy is load-bearing: the layer writes
 * one shared module-level scratch for every entry, so a stand-in that stored
 * the reference would report the last write for all of them.
 */
function countColorWrites(label: Label): { fill: number; outline: number } {
  const counts = { fill: 0, outline: 0 };
  const keys = ['fillColor', 'outlineColor'] as const;
  for (const key of keys) {
    const store = Color.clone(label[key], new Color());
    Object.defineProperty(label, key, {
      configurable: true,
      get: (): Color => store,
      set: (v: Color): void => {
        counts[key === 'fillColor' ? 'fill' : 'outline']++;
        Color.clone(v, store);
      },
    });
  }
  return counts;
}

const WHITE = { type: 'constant', color: [255, 255, 255, 255] } as const;

// ── tests ───────────────────────────────────────────────────────────────────

describe('STTTextLayer construction', () => {
  it('registers a LabelCollection into scene.primitives immediately', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene);
    expect(s.added).toHaveLength(1);
    expect(collectionOf(s).length).toBe(0);
    expect(layer.id).toBe('stt-cesium-text');
  });

  it('honours an explicit id', () => {
    const s = stubScene();
    expect(new STTTextLayer(s.scene, { id: 'annotations' }).id).toBe(
      'annotations',
    );
  });
});

describe('STTTextLayer.setTiles', () => {
  it('adds one Label per non-empty label, with the text from the column', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    layer.setTiles([labelled(['alpha', 'beta'], [0, 0], [100, 100])]);
    const c = collectionOf(s);
    expect(c.length).toBe(2);
    expect(c.get(0).text).toBe('alpha');
    expect(c.get(1).text).toBe('beta');
  });

  it('applies the shared font, per-feature scale, origins and pixel offset', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      font: '700 20px Inter, sans-serif',
      anchor: 'start',
      baseline: 'top',
      pixelOffset: [4, -6],
      scaleConstant: 0.75,
    });
    layer.setTiles([labelled(['a'], [0], [1])]);
    const label = collectionOf(s).get(0);
    expect(label.font).toBe('700 20px Inter, sans-serif');
    expect(label.scale).toBe(0.75);
    expect(label.horizontalOrigin).toBe(HorizontalOrigin.LEFT);
    expect(label.verticalOrigin).toBe(VerticalOrigin.TOP);
    expect(label.pixelOffset.x).toBe(4);
    expect(label.pixelOffset.y).toBe(-6);
  });

  it('maps every anchor/baseline pair onto Cesium origins', () => {
    const cases = [
      ['middle', 'center', HorizontalOrigin.CENTER, VerticalOrigin.CENTER],
      ['end', 'bottom', HorizontalOrigin.RIGHT, VerticalOrigin.BOTTOM],
    ] as const;
    for (const [anchor, baseline, h, v] of cases) {
      const s = stubScene();
      const layer = new STTTextLayer(s.scene, {
        textProperty: 'name',
        anchor,
        baseline,
      });
      layer.setTiles([labelled(['a'], [0], [1])]);
      expect(collectionOf(s).get(0).horizontalOrigin).toBe(h);
      expect(collectionOf(s).get(0).verticalOrigin).toBe(v);
    }
  });

  it('renders FILL without an outline mode and FILL_AND_OUTLINE with one', () => {
    const plain = stubScene();
    new STTTextLayer(plain.scene, { textProperty: 'name' }).setTiles([
      labelled(['a'], [0], [1]),
    ]);
    expect(collectionOf(plain).get(0).style).toBe(LabelStyle.FILL);

    const haloed = stubScene();
    new STTTextLayer(haloed.scene, {
      textProperty: 'name',
      outlineColor: { type: 'constant', color: [0, 0, 0, 255] },
      outlineWidth: 3,
    }).setTiles([labelled(['a'], [0], [1])]);
    expect(collectionOf(haloed).get(0).style).toBe(LabelStyle.FILL_AND_OUTLINE);
    expect(collectionOf(haloed).get(0).outlineWidth).toBe(3);
  });

  it('places labels at absolute ECEF metres (no RTC)', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    layer.setTiles([labelled(['a'], [0], [1])]);
    const p = collectionOf(s).get(0).position;
    expect(Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(6.3e6);
  });

  it('opts into disableDepthTestDistance only when alwaysOnTop is set', () => {
    const off = stubScene();
    new STTTextLayer(off.scene, { textProperty: 'name' }).setTiles([
      labelled(['a'], [0], [1]),
    ]);
    expect(collectionOf(off).get(0).disableDepthTestDistance).toBe(0);

    const on = stubScene();
    new STTTextLayer(on.scene, {
      textProperty: 'name',
      alwaysOnTop: true,
    }).setTiles([labelled(['a'], [0], [1])]);
    expect(collectionOf(on).get(0).disableDepthTestDistance).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('attaches the { layerId, binary, featureIndex } picking id to every label', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      id: 'annotations',
      textProperty: 'name',
    });
    const tile = labelled(['a', 'b'], [0, 0], [1, 1]);
    layer.setTiles([tile]);
    const id = collectionOf(s).get(1).id as {
      layerId: string;
      binary: BinaryFeatures;
      featureIndex: number;
    };
    expect(id.layerId).toBe('annotations');
    expect(id.featureIndex).toBe(1);
    expect(id.binary).toBe(tile.layers[0].features);
  });

  it('replaces the whole set on a rebuild', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    layer.setTiles([labelled(['a', 'b'], [0, 0], [1, 1])]);
    layer.setTiles([labelled(['c'], [0], [1])]);
    expect(collectionOf(s).length).toBe(1);
    expect(collectionOf(s).get(0).text).toBe('c');
  });

  it('BUILDS BEFORE TEARING DOWN: an empty result leaves the old labels standing', () => {
    // The transient between a viewport change and the first decoded tile of the
    // new set reports an empty selection; tearing down first turns that into a
    // blank frame.
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    layer.setTiles([labelled(['a', 'b'], [0, 0], [1, 1])]);
    layer.setTiles([]);
    expect(collectionOf(s).length).toBe(2);
    // A tile with features but no resolvable text is equally an empty BUILD.
    layer.setTiles([pointTile([0, 0], [0], [1])]);
    expect(collectionOf(s).length).toBe(2);
  });

  it('leaves the previous timeOrigin untouched when a rebuild is empty', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'window',
      timeFilter: { windowHalf: 50 },
      color: WHITE,
    });
    layer.setTiles([labelled(['a'], [500], [500], 10_000)]);
    layer.setTiles([]); // must NOT reset timeOrigin to 0
    layer.setTime(10_500);
    expect(collectionOf(s).get(0).fillColor.alpha).toBe(1);
  });
});

describe('STTTextLayer.setTime', () => {
  it('drives fill alpha through the shared timeFilterAlpha oracle', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'wake',
      timeFilter: { wakeLength: 900 },
      color: WHITE,
    });
    layer.setTiles([labelled(['a'], [100], [400])]);
    const label = collectionOf(s).get(0);
    for (const t of [0, 137, 400, 613, 1000]) {
      layer.setTime(t);
      const expected = timeFilterAlpha('wake', t, 100, 400, {
        wakeLength: 900,
      });
      if (expected === 0) expect(label.show).toBe(false);
      else expect(label.fillColor.alpha).toBeCloseTo(expected, 6);
    }
  });

  it('rebases the playhead onto the build timeOrigin', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'window',
      timeFilter: { windowHalf: 10 },
      color: WHITE,
    });
    layer.setTiles([labelled(['a'], [200], [200], 1_700_000_000_000)]);
    const label = collectionOf(s).get(0);
    layer.setTime(1_700_000_000_200);
    expect(label.fillColor.alpha).toBe(1);
    layer.setTime(1_700_000_000_500);
    expect(label.show).toBe(false);
  });

  it('multiplies the base fill alpha, not replaces it', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'none',
      color: { type: 'constant', color: [255, 255, 255, 128] },
    });
    layer.setTiles([labelled(['a'], [0], [1])]);
    layer.setTime(0);
    expect(collectionOf(s).get(0).fillColor.alpha).toBeCloseTo(128 / 255, 6);
  });

  it('preserves the base RGB while animating only alpha', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'window',
      timeFilter: { windowHalf: 500, fadeOut: 400 },
      color: { type: 'constant', color: [255, 128, 0, 255] },
    });
    layer.setTiles([labelled(['a'], [0], [0])]);
    layer.setTime(300);
    const c = collectionOf(s).get(0).fillColor;
    expect(c.red).toBe(1);
    expect(c.green).toBeCloseTo(128 / 255, 6);
    expect(c.blue).toBe(0);
    expect(c.alpha).toBeGreaterThan(0);
    expect(c.alpha).toBeLessThan(1);
  });

  it('animates fill and outline INDEPENDENTLY — no shared-scratch aliasing', () => {
    // Two colours per entry means two scratch objects; a single scratch aliased
    // into both properties would make the result depend on write order.
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'window',
      timeFilter: { windowHalf: 500, fadeOut: 400 },
      color: { type: 'constant', color: [255, 0, 0, 255] },
      outlineColor: { type: 'constant', color: [0, 0, 255, 51] },
    });
    layer.setTiles([labelled(['a'], [0], [0])]);
    layer.setTime(300);
    const label = collectionOf(s).get(0);
    expect(label.fillColor.red).toBe(1);
    expect(label.fillColor.blue).toBe(0);
    expect(label.outlineColor.red).toBe(0);
    expect(label.outlineColor.blue).toBe(1);
    // Same filter curve, each scaled by its OWN base alpha.
    const filter = label.fillColor.alpha; // base fill alpha is 1
    expect(label.outlineColor.alpha).toBeCloseTo(filter * (51 / 255), 6);
    expect(label.outlineColor.alpha).not.toBeCloseTo(label.fillColor.alpha, 3);
  });

  it('never writes outlineColor when the build has no outline mode', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'window',
      timeFilter: { windowHalf: 500, fadeOut: 400 },
      color: WHITE,
    });
    layer.setTiles([labelled(['a'], [0], [0])]);
    const counts = countColorWrites(collectionOf(s).get(0));
    layer.setTime(100);
    layer.setTime(200);
    expect(counts.fill).toBe(2);
    expect(counts.outline).toBe(0);
  });

  it('writes on the first frame and SKIPS unchanged alphas afterwards', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'cumulative',
      timeFilter: { fadeIn: 0 },
      color: WHITE,
    });
    layer.setTiles([labelled(['a'], [0], [1000])]);
    const counts = countColorWrites(collectionOf(s).get(0));
    layer.setTime(500); // alpha 1 — lastAlpha is NaN, so this must write
    expect(counts.fill).toBe(1);
    layer.setTime(600); // still alpha 1 — one compare, no write
    layer.setTime(700);
    expect(counts.fill).toBe(1);
  });

  it('writes ONE scratch per frame without aliasing entries together', () => {
    // Every entry shares one module-level scratch Color; the Cesium setter
    // clones, so distinct alphas must survive on distinct labels.
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'window',
      timeFilter: { windowHalf: 1000, fadeOut: 1000 },
      color: WHITE,
    });
    layer.setTiles([labelled(['a', 'b'], [0, 400], [0, 400])]);
    layer.setTime(400);
    const a = collectionOf(s).get(0).fillColor.alpha;
    const b = collectionOf(s).get(1).fillColor.alpha;
    expect(b).toBe(1);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  it('hides a fully filtered-out label and shows it again when it returns', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      textProperty: 'name',
      mode: 'window',
      timeFilter: { windowHalf: 50 },
      color: WHITE,
    });
    layer.setTiles([labelled(['a'], [500], [500])]);
    const label = collectionOf(s).get(0);
    layer.setTime(500);
    expect(label.show).toBe(true);
    layer.setTime(5000);
    expect(label.show).toBe(false);
    layer.setTime(500);
    expect(label.show).toBe(true);
    expect(label.fillColor.alpha).toBe(1);
  });

  it('is a no-op with no tiles', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    expect(() => layer.setTime(1234)).not.toThrow();
    expect(collectionOf(s).length).toBe(0);
  });
});

describe('STTTextLayer.pick', () => {
  it('returns the feature properties and source coordinate for its own labels', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, {
      id: 'annotations',
      textProperty: 'name',
    });
    const tile = labelled(['a', 'b'], [0, 0], [1, 1]);
    layer.setTiles([tile]);
    s.picked.value = { id: collectionOf(s).get(1).id };

    const hit = layer.pick(12, 34);
    if (!hit) throw new Error('expected a pick hit');
    expect(hit.layerId).toBe('annotations');
    expect(hit.index).toBe(1);
    expect(hit.screen).toEqual([12, 34]);
    expect(hit.coordinate?.[0]).toBeCloseTo(1, 12);
    expect(hit.coordinate?.[1]).toBeCloseTo(2, 12);
    expect((hit.object as Record<string, unknown>).name).toBe('b');
  });

  it('matches provenance, not position — dropped features shift the indices', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    // Feature 0 has a NULL category → dropped; the surviving label is
    // entries[0] but featureIndex 1.
    const tile = pointTile([0, 0, 5, 6], [0, 0], [1, 1], {
      categoricalProps: {
        name: { indices: new Uint16Array([65535, 0]), categories: ['kept'] },
      },
    });
    layer.setTiles([tile]);
    expect(collectionOf(s).length).toBe(1);
    s.picked.value = { id: collectionOf(s).get(0).id };
    const hit = layer.pick(1, 1);
    expect(hit?.index).toBe(1);
    expect(hit?.coordinate?.[0]).toBeCloseTo(5, 12);
  });

  it('returns null for a miss or for another layer id', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    layer.setTiles([labelled(['a'], [0], [1])]);

    s.picked.value = undefined;
    expect(layer.pick(0, 0)).toBeNull();
    s.picked.value = {};
    expect(layer.pick(0, 0)).toBeNull();
    s.picked.value = {
      id: { layerId: 'someone-else', binary: {}, featureIndex: 0 },
    };
    expect(layer.pick(0, 0)).toBeNull();
  });
});

describe('STTTextLayer.dispose', () => {
  it('removes the collection from scene.primitives and drops the entries', () => {
    const s = stubScene();
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    layer.setTiles([labelled(['a'], [0], [1])]);
    layer.dispose();
    expect(s.removed).toEqual([collectionOf(s)]);
    // Entries gone: a later setTime must not touch destroyed primitives.
    expect(() => layer.setTime(0)).not.toThrow();
  });

  it('destroys the collection itself when the scene did not remove it', () => {
    // PrimitiveCollection.remove destroys what it removes; if the collection
    // was never in (or is already gone from) the scene, its lazily built glyph
    // atlas would otherwise leak.
    const s = stubScene();
    s.removeResult.value = false;
    const layer = new STTTextLayer(s.scene, { textProperty: 'name' });
    layer.setTiles([labelled(['a'], [0], [1])]);
    const collection = collectionOf(s);
    layer.dispose();
    expect(collection.isDestroyed()).toBe(true);
  });
});

describe('STTTextLayer conformance', () => {
  it('computes alpha through the core time-filter oracle, by name', () => {
    // Mirrors the structural gate in time-filter-oracle.test.ts, which this
    // layer participates in: there is no shader path in this backend, so the
    // oracle import IS the conformance guarantee.
    const src = readFileSync(
      new URL('../src/cesium-text-layer.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/timeFilterAlpha/);
    expect(src).toMatch(/@poopdeck\.gl\/core\/time-filter/);
  });

  it('uses no Cesium Entity or DataSource', () => {
    const src = readFileSync(
      new URL('../src/cesium-text-layer.ts', import.meta.url),
      'utf8',
    );
    const cesiumImports = src.slice(
      src.indexOf('import {'),
      src.indexOf("} from 'cesium'"),
    );
    expect(cesiumImports).toMatch(/LabelCollection/);
    expect(cesiumImports).not.toMatch(/Entity|DataSource/);
  });
});
