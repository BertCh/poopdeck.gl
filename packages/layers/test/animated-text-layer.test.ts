/**
 * AnimatedTextLayer tests.
 *
 * The layer renders time-filtered map LABELS over binary POINT tiles. deck's
 * `TextLayer` DOES accept a binary payload — `_updateText` has an explicit
 * branch for `data = {length, startIndices, attributes: {getText: {value}}}` —
 * so this layer DECODES each tile into flat typed columns ONCE (positions,
 * absolute times, a per-CATEGORY colour table, a UTF-32 code-point buffer) and
 * then FILTERS membership on the CPU against the playhead every frame (a row is
 * visible while its absolute `[startTime, endTime]` overlaps
 * `[now ± timeWindow/2]`). Styling is forwarded to the TextLayer sublayer as
 * pass-throughs; per-feature colour/size/angle ride index-based accessors over
 * the flat columns — there are no per-feature row objects.
 *
 * These tests exercise `renderLayers()` directly (via Object.create, bypassing
 * CompositeLayer's lifecycle) with a deck.gl mock that captures the constructed
 * sublayer props. They pin: construction defaults, one sublayer per tile, the
 * decoded text/position columns, CPU time-window filtering, the constant +
 * column colour/size/angle paths, the appear/disappear fade, the full style
 * pass-through surface, reference-stable data + sublayer reuse, and the picking
 * object shape.
 *
 * The review-fix behaviours (binary getText payload shape, membership
 * signature + early-out, sorted-path binary search, per-category expansion,
 * sublayer-instance cache, float formatting, geometry guard) are pinned in
 * `animated-text-review-fixes.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

// ---------------------------------------------------------------------------
// deck.gl mocks — the TextLayer constructor just stashes its props.
// ---------------------------------------------------------------------------

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeTextLayer implements CapturedLayer {
    static layerName = 'TextLayer';
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { TextLayer: FakeTextLayer };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// NOTE: `@poopdeck.gl/core` is NOT mocked — the layer imports the real
// `getFeatureProperties` for picking enrichment (same as the sibling tests),
// which decodes a feature's binary columns into `{ id, start_time, end_time,
// ...numeric/categorical props }`.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a categorical {indices, categories} column from string values. */
function categorical(values: string[]): {
  indices: Uint16Array;
  categories: string[];
} {
  const categories: string[] = [];
  const map = new Map<string, number>();
  const indices = new Uint16Array(values.length);
  values.forEach((v, i) => {
    let idx = map.get(v);
    if (idx === undefined) {
      idx = categories.length;
      categories.push(v);
      map.set(v, idx);
    }
    indices[i] = idx;
  });
  return { indices, categories };
}

/** Read back the labels deck would derive from the binary `getText` payload. */
export function textsOf(layer: any): string[] {
  const { length, startIndices, attributes } = layer.props.data;
  const codes: Uint32Array = attributes.getText.value;
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const slice = Array.from(
      codes.subarray(startIndices[i], startIndices[i + 1]),
    );
    out.push(String.fromCodePoint(...slice));
  }
  return out;
}

/** Invoke an index-based accessor the way deck's attribute updater does. */
export function readAccessor(fn: any, index: number): any {
  return typeof fn === 'function' ? fn(undefined, { index, target: [] }) : fn;
}

interface LabelRow {
  lon: number;
  lat: number;
  /** Time RELATIVE to the tile timeOffset. */
  t: number;
  /** End time RELATIVE to the tile timeOffset (defaults to `t`). */
  end?: number;
  text?: string;
  category?: string;
  size?: number;
  angle?: number;
}

/** Build a fake point tile of label features. */
export function makeLabelTile(
  rows: LabelRow[],
  opts: {
    timeOffset?: number;
    tileId?: { z: number; x: number; y: number; t: number };
  } = {},
): Tile {
  const tile = makePointTile({
    positions: rows.map((r) => [r.lon, r.lat]),
    startTimes: rows.map((r) => r.t),
    endTimes: rows.map((r) => r.end ?? r.t),
    timeOffset: opts.timeOffset ?? 0,
    tileId: opts.tileId,
  });
  const f = tile.layers[0].features;
  if (rows.some((r) => r.text !== undefined)) {
    f.categoricalProps['text'] = categorical(rows.map((r) => r.text ?? ''));
  }
  if (rows.some((r) => r.category !== undefined)) {
    f.categoricalProps['category'] = categorical(
      rows.map((r) => r.category ?? ''),
    );
  }
  for (const col of ['size', 'angle'] as const) {
    if (rows.some((r) => r[col] !== undefined)) {
      f.numericProps[col] = new Float32Array(
        rows.map((r) => (r[col] ?? NaN) as number),
      );
    }
  }
  return tile;
}

/** The props the layer's constructor would have set from defaultProps. */
export const TEXT_LAYER_PROPS: Record<string, any> = {
  id: 'test',
  textProperty: 'text',
  getText: null,
  textPrecision: null,
  color: [0, 0, 0, 255],
  getColor: null,
  colorMapping: null,
  colorMappingDefault: [0, 0, 0, 0],
  size: 32,
  getSize: null,
  angle: 0,
  getAngle: null,
  getTextAnchor: 'middle',
  getAlignmentBaseline: 'center',
  getPixelOffset: [0, 0],
  background: false,
  backgroundColor: [255, 255, 255, 255],
  getBackgroundColor: null,
  backgroundPadding: [0, 0, 0, 0],
  backgroundBorderRadius: 0,
  borderColor: [0, 0, 0, 255],
  getBorderColor: null,
  borderWidth: 0,
  getBorderWidth: null,
  outlineColor: [0, 0, 0, 255],
  outlineWidth: 0,
  fontFamily: 'Monaco, monospace',
  fontWeight: 'normal',
  lineHeight: 1,
  fontSettings: {},
  characterSet: 'auto',
  sizeScale: 1,
  sizeUnits: 'pixels',
  sizeMinPixels: 0,
  sizeMaxPixels: Number.MAX_SAFE_INTEGER,
  wordBreak: 'break-word',
  maxWidth: -1,
  getContentBox: [0, 0, -1, -1],
  contentCutoffPixels: [0, 0],
  contentAlignHorizontal: 'none',
  contentAlignVertical: 'none',
  billboard: true,
  fadeInDuration: 0,
  fadeOutDuration: 0,
  // A wide window so a single-timestamp feature is visible near its time.
  timeWindow: 2000,
  opacity: 1,
  visible: true,
};

/** Initialise the instance fields CompositeLayer's lifecycle would have set. */
export function initTextLayerFields(layer: any): void {
  layer._currentTime = 0;
  layer.decodedCache = new Map();
  layer.visibleCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  layer.lastTilesRef = null;
  layer.lastFrameTime = NaN;
}

// ---------------------------------------------------------------------------
describe('AnimatedTextLayer', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let render: (tiles: Tile[], time: number, opts?: any) => any[];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-text-layer');
    LayerCtor = mod.AnimatedTextLayer as any;

    makeLayer = (opts = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — drive renderLayers
      // (and its decode/filter) directly.
      const layer = Object.create(LayerCtor.prototype);
      layer.props = { ...TEXT_LAYER_PROPS, ...opts };
      initTextLayerFields(layer);
      return layer;
    };

    render = (tiles, time, opts = {}) => {
      const layer = makeLayer(opts);
      layer.state = { tiles };
      layer._currentTime = time;
      return (layer as any).renderLayers();
    };
  });

  // ── Construction ─────────────────────────────────────────────────────────

  it('exposes the static layerName + own + base defaults', () => {
    expect(LayerCtor.layerName).toBe('AnimatedTextLayer');
    expect(LayerCtor.defaultProps.textProperty).toBe('text');
    expect(LayerCtor.defaultProps.getText.value).toBe(null);
    expect(LayerCtor.defaultProps.color.value).toEqual([0, 0, 0, 255]);
    expect(LayerCtor.defaultProps.size.value).toBe(32);
    expect(LayerCtor.defaultProps.angle.value).toBe(0);
    expect(LayerCtor.defaultProps.getTextAnchor).toBe('middle');
    expect(LayerCtor.defaultProps.getAlignmentBaseline).toBe('center');
    expect(LayerCtor.defaultProps.sizeUnits).toBe('pixels');
    expect(LayerCtor.defaultProps.sizeMaxPixels.value).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(LayerCtor.defaultProps.billboard).toBe(true);
    expect(LayerCtor.defaultProps.fontFamily).toBe('Monaco, monospace');
    expect(LayerCtor.defaultProps.wordBreak).toBe('break-word');
    expect(LayerCtor.defaultProps.maxWidth.value).toBe(-1);
    expect(LayerCtor.defaultProps.fadeInDuration.value).toBe(0);
    // Base defaults spread in.
    expect(LayerCtor.defaultProps.timeWindow).toBeDefined();
    expect(LayerCtor.defaultProps.tier).toBeDefined();
  });

  // ── One sublayer + decoded rows ────────────────────────────────────────────

  it('builds one TextLayer per tile with the decoded text rows', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'alpha' },
      { lon: 1, lat: 2, t: 0, text: 'beta' },
    ]);
    const layers = render([tile], 0);
    expect(layers.length).toBe(1);
    expect(layers[0].constructor.layerName).toBe('TextLayer');
    const data = layers[0].props.data;
    // deck's binary interface — NOT an array of CPU rows.
    expect(data.length).toBe(2);
    expect(data.attributes.getText.value).toBeInstanceOf(Uint32Array);
    expect(textsOf(layers[0])).toEqual(['alpha', 'beta']);
    expect(readAccessor(layers[0].props.getPosition, 1)).toEqual([1, 2, 0]);
  });

  it('reads a custom textProperty column', () => {
    const tile = makePointTile({
      positions: [[0, 0]],
      startTimes: [0],
      endTimes: [0],
      timeOffset: 0,
    });
    tile.layers[0].features.categoricalProps['name'] = categorical([
      'Montréal',
    ]);
    const layers = render([tile], 0, { textProperty: 'name' });
    expect(textsOf(layers[0])).toEqual(['Montréal']);
  });

  it('lets the getText alias win over textProperty (column name)', () => {
    const tile = makePointTile({
      positions: [[0, 0]],
      startTimes: [0],
      endTimes: [0],
      timeOffset: 0,
    });
    tile.layers[0].features.categoricalProps['label'] = categorical([
      'via-alias',
    ]);
    const layers = render([tile], 0, {
      textProperty: 'text',
      getText: 'label',
    });
    expect(textsOf(layers[0])).toEqual(['via-alias']);
  });

  it('stringifies a numeric text column', () => {
    const tile = makePointTile({
      positions: [[0, 0]],
      startTimes: [0],
      endTimes: [0],
      timeOffset: 0,
    });
    tile.layers[0].features.numericProps['depth'] = new Float32Array([42]);
    const layers = render([tile], 0, { textProperty: 'depth' });
    expect(textsOf(layers[0])).toEqual(['42']);
  });

  // ── CPU time-window filtering ──────────────────────────────────────────────

  it('filters rows to those whose [start,end] overlaps the playhead window', () => {
    // Window = 2000 → half = 1000. At now=5000 the window is [4000, 6000].
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'early' }, // [0,0] — outside
      { lon: 1, lat: 0, t: 5000, text: 'now' }, // inside
      { lon: 2, lat: 0, t: 5500, text: 'soon' }, // inside
      { lon: 3, lat: 0, t: 9000, text: 'late' }, // outside
    ]);
    const sub = render([tile], 5000)[0];
    expect(sub.props.data.length).toBe(2);
    expect(textsOf(sub)).toEqual(['now', 'soon']);
  });

  it('keeps a feature whose [start,end] span straddles the window', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, end: 10000, text: 'spanning' },
    ]);
    // now=5000, window [4000,6000] — the feature's [0,10000] overlaps.
    const sub = render([tile], 5000)[0];
    expect(textsOf(sub)).toEqual(['spanning']);
  });

  it('rebases relative tile times by timeOffset for the filter', () => {
    // rel t=0 with offset 5000 → absolute 5000; window at now=5000 contains it.
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'rebased' }], {
      timeOffset: 5000,
    });
    expect(render([tile], 5000)[0].props.data.length).toBe(1);
    // At now=0 the absolute time 5000 is outside [−1000, 1000] → no sublayer.
    expect(render([tile], 0)).toEqual([]);
  });

  it('emits no sublayer for a tile with no visible rows', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 100000, text: 'far' }]);
    expect(render([tile], 0)).toEqual([]);
  });

  // ── Color: constant, column, mapping ───────────────────────────────────────

  it('bakes a constant color into every row', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const sub = render([tile], 0, { color: [10, 20, 30, 255] })[0];
    expect(readAccessor(sub.props.getColor, 0)).toEqual([10, 20, 30, 255]);
  });

  it('bakes per-category color via colorMapping when color names a column', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', category: 'road' },
      { lon: 1, lat: 0, t: 0, text: 'b', category: 'river' },
    ]);
    const sub = render([tile], 0, {
      color: 'category',
      colorMapping: { road: [200, 200, 0, 255], river: [0, 120, 255, 255] },
    })[0];
    expect(readAccessor(sub.props.getColor, 0)).toEqual([200, 200, 0, 255]);
    expect(readAccessor(sub.props.getColor, 1)).toEqual([0, 120, 255, 255]);
  });

  it('uses colorMappingDefault for categories absent from colorMapping', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', category: 'trail' },
    ]);
    const sub = render([tile], 0, {
      color: 'category',
      colorMapping: { road: [1, 2, 3, 255] },
      colorMappingDefault: [9, 9, 9, 255],
    })[0];
    expect(readAccessor(sub.props.getColor, 0)).toEqual([9, 9, 9, 255]);
  });

  it('lets the getColor alias win over color', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const sub = render([tile], 0, {
      color: [1, 1, 1, 255],
      getColor: [255, 0, 0, 255],
    })[0];
    expect(readAccessor(sub.props.getColor, 0)).toEqual([255, 0, 0, 255]);
  });

  it('falls back to color when getColor is a function accessor', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const sub = render([tile], 0, {
      color: [7, 8, 9, 255],
      getColor: () => [0, 0, 0, 255],
    })[0];
    expect(readAccessor(sub.props.getColor, 0)).toEqual([7, 8, 9, 255]);
  });

  // ── Size / angle: constant vs column ───────────────────────────────────────

  it('forwards a constant size as a scalar getSize prop', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const layer = render([tile], 0, { size: 18 })[0];
    expect(layer.props.getSize).toBe(18);
  });

  it('binds a per-feature size column via a getSize reader', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', size: 12 },
      { lon: 1, lat: 0, t: 0, text: 'b', size: 24 },
    ]);
    const layer = render([tile], 0, { size: 'size' })[0];
    expect(typeof layer.props.getSize).toBe('function');
    expect(readAccessor(layer.props.getSize, 0)).toBe(12);
    expect(readAccessor(layer.props.getSize, 1)).toBe(24);
  });

  it('forwards a constant angle and binds a per-feature angle column', () => {
    const constTile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    expect(render([constTile], 0, { angle: 45 })[0].props.getAngle).toBe(45);

    const colTile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', angle: 90 },
      { lon: 1, lat: 0, t: 0, text: 'b', angle: 30 },
    ]);
    const layer = render([colTile], 0, { angle: 'angle' })[0];
    expect(typeof layer.props.getAngle).toBe('function');
    expect(readAccessor(layer.props.getAngle, 1)).toBe(30);
  });

  it('lets the getSize alias win over size', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    expect(render([tile], 0, { size: 10, getSize: 40 })[0].props.getSize).toBe(
      40,
    );
  });

  // ── Appear / disappear fade ────────────────────────────────────────────────

  it('ramps the row alpha over fadeInDuration as a label enters the window', () => {
    // Feature at abs t=0; at now=−600, window=2000 → windowEnd = 400. age =
    // windowEnd − start = 400. With a 800ms fade-in → alpha ≈ 0.5 → 255×0.5.
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', end: 10000 },
    ]);
    const sub = render([tile], -600, {
      color: [80, 170, 255, 255],
      fadeInDuration: 800,
    })[0];
    const c = readAccessor(sub.props.getColor, 0);
    expect(c[0]).toBe(80);
    expect(c[3]).toBeGreaterThan(100);
    expect(c[3]).toBeLessThan(160);
  });

  it('keeps full alpha when no fade is set (default)', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const sub = render([tile], 0, { color: [80, 170, 255, 255] })[0];
    expect(readAccessor(sub.props.getColor, 0)[3]).toBe(255);
  });

  it('keeps the binary data payload reference-stable across a fade frame (no glyph re-layout)', () => {
    // With a fade ACTIVELY ramping the alpha changes every frame, but the
    // `data` object (and therefore the glyph layout + the membership-keyed
    // triggers) must stay identical — else TextLayer re-runs `_updateText`
    // (which fires on any `data`-ref change) every frame.
    const layer = makeLayer({
      color: [80, 170, 255, 255],
      fadeInDuration: 800,
    });
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, end: 10000, text: 'a' },
    ]);
    layer.state = { tiles: [tile] };
    layer._currentTime = -600; // ~50% into the fade-in
    const s1 = (layer as any).renderLayers()[0];
    const data1 = s1.props.data;
    const alpha1 = readAccessor(s1.props.getColor, 0)[3];
    expect(alpha1).toBeGreaterThan(100);
    expect(alpha1).toBeLessThan(160);

    layer._currentTime = -200; // fade-in complete → alpha ramps to full
    const s2 = (layer as any).renderLayers()[0];
    expect(s2.props.data).toBe(data1);
    expect(s2.props.updateTriggers.getText).toBe(
      s1.props.updateTriggers.getText,
    );
    expect(s2.props.updateTriggers.getPosition).toBe(
      s1.props.updateTriggers.getPosition,
    );
    // The alpha ramped up and its updateTrigger changed (carries the clock) so
    // deck re-uploads only the colour.
    expect(readAccessor(s2.props.getColor, 0)[3]).toBeGreaterThan(alpha1);
    expect(s2.props.updateTriggers.getColor).not.toBe(
      s1.props.updateTriggers.getColor,
    );
  });

  it('fades the background + border colour in lock-step with the glyphs', () => {
    const layer = makeLayer({
      fadeInDuration: 800,
      background: true,
      backgroundColor: [200, 200, 200, 255],
      borderColor: [10, 20, 30, 240],
      borderWidth: 2,
    });
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, end: 10000, text: 'a' },
    ]);
    layer.state = { tiles: [tile] };
    layer._currentTime = -600; // ~50% into the fade-in
    const s = (layer as any).renderLayers()[0];
    // Per-row readers (not constants) while a row is actually ramping.
    expect(typeof s.props.getBackgroundColor).toBe('function');
    expect(typeof s.props.getBorderColor).toBe('function');
    const bg = readAccessor(s.props.getBackgroundColor, 0);
    const bd = readAccessor(s.props.getBorderColor, 0);
    // RGB preserved; alpha scaled by the ~0.5 ramp — matches the glyph fade,
    // instead of a solid rectangle popping while the text fades.
    expect(bg.slice(0, 3)).toEqual([200, 200, 200]);
    expect(bg[3]).toBeGreaterThan(100);
    expect(bg[3]).toBeLessThan(160); // 255 × ~0.5
    expect(bd.slice(0, 3)).toEqual([10, 20, 30]);
    expect(bd[3]).toBeGreaterThan(100);
    expect(bd[3]).toBeLessThan(140); // 240 × ~0.5
    // Background/border triggers carry the clock so they re-upload with the fade.
    expect(s.props.updateTriggers.getBackgroundColor).toBe(
      s.props.updateTriggers.getColor,
    );
    expect(s.props.updateTriggers.getBorderColor).toBe(
      s.props.updateTriggers.getColor,
    );
  });

  it('leaves getBackgroundColor/getBorderColor as constants when fade is off', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const s = render([tile], 0, {
      background: true,
      backgroundColor: [1, 2, 3, 255],
      borderColor: [4, 5, 6, 255],
    })[0];
    expect(s.props.getBackgroundColor).toEqual([1, 2, 3, 255]);
    expect(s.props.getBorderColor).toEqual([4, 5, 6, 255]);
  });

  // ── Full style pass-through surface ────────────────────────────────────────

  it('forwards the full TextLayer style surface as pass-throughs', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const layer = render([tile], 0, {
      getTextAnchor: 'start',
      getAlignmentBaseline: 'bottom',
      getPixelOffset: [4, -8],
      background: true,
      backgroundColor: [10, 10, 10, 200],
      backgroundPadding: [2, 3, 2, 3],
      backgroundBorderRadius: 6,
      borderColor: [1, 2, 3, 255],
      borderWidth: 2,
      outlineColor: [9, 9, 9, 255],
      outlineWidth: 4,
      fontFamily: 'Helvetica',
      fontWeight: 700,
      lineHeight: 1.4,
      fontSettings: { sdf: true },
      characterSet: 'ab',
      sizeScale: 2,
      sizeUnits: 'meters',
      sizeMinPixels: 8,
      sizeMaxPixels: 64,
      wordBreak: 'break-all',
      maxWidth: 12,
      getContentBox: [1, 2, 30, 40],
      contentCutoffPixels: [5, 6],
      contentAlignHorizontal: 'center',
      contentAlignVertical: 'end',
      billboard: false,
    })[0];
    const p = layer.props;
    expect(p.getTextAnchor).toBe('start');
    expect(p.getAlignmentBaseline).toBe('bottom');
    expect(p.getPixelOffset).toEqual([4, -8]);
    expect(p.background).toBe(true);
    // Legacy `backgroundColor` maps to the modern getBackgroundColor accessor.
    expect(p.getBackgroundColor).toEqual([10, 10, 10, 200]);
    expect(p.backgroundPadding).toEqual([2, 3, 2, 3]);
    expect(p.backgroundBorderRadius).toBe(6);
    expect(p.getBorderColor).toEqual([1, 2, 3, 255]);
    expect(p.getBorderWidth).toBe(2);
    expect(p.outlineColor).toEqual([9, 9, 9, 255]);
    expect(p.outlineWidth).toBe(4);
    expect(p.fontFamily).toBe('Helvetica');
    expect(p.fontWeight).toBe(700);
    expect(p.lineHeight).toBe(1.4);
    expect(p.fontSettings).toEqual({ sdf: true });
    // A pinned characterSet is forwarded verbatim (no derivation).
    expect(p.characterSet).toBe('ab');
    expect(p.sizeScale).toBe(2);
    expect(p.sizeUnits).toBe('meters');
    expect(p.sizeMinPixels).toBe(8);
    expect(p.sizeMaxPixels).toBe(64);
    expect(p.wordBreak).toBe('break-all');
    expect(p.maxWidth).toBe(12);
    expect(p.getContentBox).toEqual([1, 2, 30, 40]);
    expect(p.contentCutoffPixels).toEqual([5, 6]);
    expect(p.contentAlignHorizontal).toBe('center');
    expect(p.contentAlignVertical).toBe('end');
    expect(p.billboard).toBe(false);
  });

  it('inherits composite props (opacity/visible) through getSubLayerProps', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const layer = render([tile], 0, { opacity: 0.4, visible: true })[0];
    expect(layer.props.opacity).toBe(0.4);
    expect(layer.props.visible).toBe(true);
    // Sublayer id composes as `${parent.id}-text-${tileKey}`.
    expect(layer.props.id).toContain('text');
  });

  // ── Reference-stable data reuse ────────────────────────────────────────────

  it('returns the SAME data ref across frames while the membership is unchanged', () => {
    const layer = makeLayer();
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 5000, text: 'a' },
      { lon: 1, lat: 0, t: 5500, text: 'b' },
    ]);
    layer.state = { tiles: [tile] };
    layer._currentTime = 5000;
    const first = (layer as any).renderLayers()[0].props.data;
    // Same tiles ref + same visible window → identical `data` object.
    const second = (layer as any).renderLayers()[0].props.data;
    expect(second).toBe(first);
  });

  it('rebuilds the visible set when the window moves past a row boundary', () => {
    const layer = makeLayer();
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 5000, text: 'a' },
      { lon: 1, lat: 0, t: 9000, text: 'b' },
    ]);
    layer.state = { tiles: [tile] };
    layer._currentTime = 5000;
    const s1 = (layer as any).renderLayers()[0];
    expect(textsOf(s1)).toEqual(['a']);
    // Move the playhead so 'b' enters and 'a' leaves the window.
    layer._currentTime = 9000;
    const s2 = (layer as any).renderLayers()[0];
    expect(s2.props.data).not.toBe(s1.props.data);
    expect(textsOf(s2)).toEqual(['b']);
  });

  // ── Caching / lifecycle ────────────────────────────────────────────────────

  it('reuses the decoded columns across renders (same styleKey)', () => {
    const layer = makeLayer();
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }], {
      tileId: { z: 16, x: 1, y: 2, t: 0 },
    });
    layer.state = { tiles: [tile] };
    layer._currentTime = 0;
    (layer as any).renderLayers();
    const key = `16/1/2/0#0:layer0`;
    const firstDecoded = layer.decodedCache.get(key);
    expect(firstDecoded).toBeDefined();
    (layer as any).renderLayers();
    expect(layer.decodedCache.get(key)).toBe(firstDecoded);
  });

  it('re-decodes when a style prop that feeds the rows changes', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', category: 'road' },
    ]);
    const a = render([tile], 0, { color: [1, 1, 1, 255] })[0];
    expect(readAccessor(a.props.getColor, 0)).toEqual([1, 1, 1, 255]);
    const b = render([tile], 0, {
      color: 'category',
      colorMapping: { road: [50, 60, 70, 255] },
    })[0];
    expect(readAccessor(b.props.getColor, 0)).toEqual([50, 60, 70, 255]);
  });

  it('returns [] for an empty tile set', () => {
    expect(render([], 0)).toEqual([]);
  });

  // ── Picking ────────────────────────────────────────────────────────────────

  it('resolves info.object from the picked visible row back to its feature index', () => {
    // Row 0 is filtered out of the window; the visible-row hit must map back to
    // the ORIGINAL feature index, not the subset index.
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'hidden' }, // outside the window at now=5000
      { lon: 1, lat: 0, t: 5000, text: 'shown' }, // visible → subset index 0
    ]);
    const layer = makeLayer();
    layer.state = { tiles: [tile] };
    layer._currentTime = 5000;
    const sublayer = (layer as any).renderLayers()[0];
    const rowIndices = sublayer.props.sttRowIndices;
    expect(rowIndices.length).toBe(1);
    expect(rowIndices[0]).toBe(1); // original feature index

    const info: any = { index: 0 };
    const out = (layer as any).getPickingInfo({ info, sourceLayer: sublayer });
    expect(out.tile).toBe(tile);
    // Real getFeatureProperties decodes the ORIGINAL feature index (1) — the
    // 'text' categorical column resolves to that feature's value, not the
    // filtered subset index 0 ('shown', not 'hidden').
    expect(out.object.text).toBe('shown');
  });

  it('sets sourceTile but no object when nothing is hit', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const layer = makeLayer();
    layer.state = { tiles: [tile] };
    const sublayer = (layer as any).renderLayers()[0];
    const out = (layer as any).getPickingInfo({
      info: { index: -1 },
      sourceLayer: sublayer,
    });
    expect(out.sourceTile).toBe(tile);
    expect(out.object).toBeUndefined();
  });
});
