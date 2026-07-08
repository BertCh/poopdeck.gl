/**
 * AnimatedTextLayer tests.
 *
 * The layer renders time-filtered map LABELS over binary POINT tiles. deck's
 * `TextLayer` cannot consume the binary attribute interface (it needs CPU string
 * ROWS + a FontAtlasManager), so this layer DECODES each tile's categorical
 * string column into a reference-stable full row array ONCE, then FILTERS that
 * set on the CPU against the playhead every frame (a row is visible while its
 * absolute `[startTime, endTime]` overlaps `[now ± timeWindow/2]`). Styling is
 * forwarded to the TextLayer sublayer as pass-throughs; per-feature color/size/
 * angle bake into the rows and ride simple `(d) => d.field` readers.
 *
 * These tests exercise `renderLayers()` directly (via Object.create, bypassing
 * CompositeLayer's lifecycle) with a deck.gl mock that captures the constructed
 * sublayer props. They pin: construction defaults, one sublayer per tile, the
 * decoded text/position rows, CPU time-window filtering, the constant + column
 * color/size/angle paths, the appear/disappear fade, the full style pass-through
 * surface, reference-stable data reuse, and the picking object shape.
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
function makeLabelTile(
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
      layer.props = {
        id: 'test',
        textProperty: 'text',
        getText: null,
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
        backgroundPadding: [0, 0, 0, 0],
        borderColor: [0, 0, 0, 255],
        borderWidth: 0,
        outlineColor: [0, 0, 0, 255],
        outlineWidth: 0,
        fontFamily: 'Monaco, monospace',
        fontWeight: 'normal',
        fontSettings: {},
        characterSet: 'auto',
        sizeScale: 1,
        sizeUnits: 'pixels',
        sizeMinPixels: 0,
        sizeMaxPixels: Number.MAX_SAFE_INTEGER,
        wordBreak: 'break-word',
        maxWidth: -1,
        billboard: true,
        fadeInDuration: 0,
        fadeOutDuration: 0,
        // A wide window so a single-timestamp feature is visible near its time.
        timeWindow: 2000,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer._currentTime = 0;
      layer.decodedCache = new Map();
      layer.visibleCache = new Map();
      layer.fadeCache = new Map();
      layer.lastTilesRef = null;
      layer.lastFrameTime = NaN;
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
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
    // getText / getPosition are CPU-row readers.
    expect(layers[0].props.getText(data[0])).toBe('alpha');
    expect(layers[0].props.getText(data[1])).toBe('beta');
    expect(layers[0].props.getPosition(data[1])).toEqual([1, 2, 0]);
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
    const data = layers[0].props.data;
    expect(layers[0].props.getText(data[0])).toBe('Montréal');
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
    const data = layers[0].props.data;
    expect(layers[0].props.getText(data[0])).toBe('via-alias');
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
    const data = layers[0].props.data;
    expect(layers[0].props.getText(data[0])).toBe('42');
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
    const data = render([tile], 5000)[0].props.data;
    expect(data.length).toBe(2);
    expect(data.map((d: any) => d.text)).toEqual(['now', 'soon']);
  });

  it('keeps a feature whose [start,end] span straddles the window', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, end: 10000, text: 'spanning' },
    ]);
    // now=5000, window [4000,6000] — the feature's [0,10000] overlaps.
    const data = render([tile], 5000)[0].props.data;
    expect(data.length).toBe(1);
    expect(data[0].text).toBe('spanning');
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
    const data = render([tile], 0, { color: [10, 20, 30, 255] })[0].props.data;
    expect(data[0].color).toEqual([10, 20, 30, 255]);
    // Constant color rides the reader too (fade folds into it per-frame).
    expect(
      render([tile], 0, { color: [10, 20, 30, 255] })[0].props.getColor(
        data[0],
      ),
    ).toEqual([10, 20, 30, 255]);
  });

  it('bakes per-category color via colorMapping when color names a column', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', category: 'road' },
      { lon: 1, lat: 0, t: 0, text: 'b', category: 'river' },
    ]);
    const data = render([tile], 0, {
      color: 'category',
      colorMapping: { road: [200, 200, 0, 255], river: [0, 120, 255, 255] },
    })[0].props.data;
    expect(data[0].color).toEqual([200, 200, 0, 255]);
    expect(data[1].color).toEqual([0, 120, 255, 255]);
  });

  it('uses colorMappingDefault for categories absent from colorMapping', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', category: 'trail' },
    ]);
    const data = render([tile], 0, {
      color: 'category',
      colorMapping: { road: [1, 2, 3, 255] },
      colorMappingDefault: [9, 9, 9, 255],
    })[0].props.data;
    expect(data[0].color).toEqual([9, 9, 9, 255]);
  });

  it('lets the getColor alias win over color', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const data = render([tile], 0, {
      color: [1, 1, 1, 255],
      getColor: [255, 0, 0, 255],
    })[0].props.data;
    expect(data[0].color).toEqual([255, 0, 0, 255]);
  });

  it('falls back to color when getColor is a function accessor', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const data = render([tile], 0, {
      color: [7, 8, 9, 255],
      getColor: () => [0, 0, 0, 255],
    })[0].props.data;
    expect(data[0].color).toEqual([7, 8, 9, 255]);
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
    const data = layer.props.data;
    expect(layer.props.getSize(data[0])).toBe(12);
    expect(layer.props.getSize(data[1])).toBe(24);
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
    expect(layer.props.getAngle(layer.props.data[1])).toBe(30);
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
    const data = render([tile], -600, {
      color: [80, 170, 255, 255],
      fadeInDuration: 800,
    })[0].props.data;
    expect(data[0].color[0]).toBe(80);
    expect(data[0].color[3]).toBeGreaterThan(100);
    expect(data[0].color[3]).toBeLessThan(160);
  });

  it('keeps full alpha when no fade is set (default)', () => {
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }]);
    const data = render([tile], 0, { color: [80, 170, 255, 255] })[0].props
      .data;
    expect(data[0].color[3]).toBe(255);
  });

  it('keeps the fade-mode rows array + objects reference-stable across frames (no glyph re-layout)', () => {
    // With fade active the alpha animates every frame, but the row ARRAY + row
    // OBJECT identity must stay stable while membership is unchanged — else
    // TextLayer re-runs its per-glyph `_updateText` (fires on any `data`-ref
    // change) every frame. Only the colour re-uploads, via the getColor trigger.
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
    const rows1 = s1.props.data;
    const row = rows1[0];
    const alpha1 = row.color[3]; // snapshot the primitive before the next frame
    expect(alpha1).toBeGreaterThan(100);
    expect(alpha1).toBeLessThan(160);

    layer._currentTime = -200; // fade-in complete → alpha ramps to full
    const s2 = (layer as any).renderLayers()[0];
    // Reference-stable: same rows array + same row object (TextLayer skips
    // _updateText), so the membership-keyed triggers are UNCHANGED.
    expect(s2.props.data).toBe(rows1);
    expect(s2.props.data[0]).toBe(row);
    expect(s2.props.updateTriggers.getText).toBe(
      s1.props.updateTriggers.getText,
    );
    expect(s2.props.updateTriggers.getPosition).toBe(
      s1.props.updateTriggers.getPosition,
    );
    // But the alpha ramped up in place and its updateTrigger changed (carries the
    // clock) so deck re-uploads only the colour.
    expect(s2.props.data[0].color[3]).toBeGreaterThan(alpha1);
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
    const row = s.props.data[0];
    // Per-row readers (not constants) when fade is active.
    expect(typeof s.props.getBackgroundColor).toBe('function');
    expect(typeof s.props.getBorderColor).toBe('function');
    const bg = s.props.getBackgroundColor(row);
    const bd = s.props.getBorderColor(row);
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
      borderColor: [1, 2, 3, 255],
      borderWidth: 2,
      outlineColor: [9, 9, 9, 255],
      outlineWidth: 4,
      fontFamily: 'Helvetica',
      fontWeight: 700,
      fontSettings: { sdf: true },
      characterSet: 'auto',
      sizeScale: 2,
      sizeUnits: 'meters',
      sizeMinPixels: 8,
      sizeMaxPixels: 64,
      wordBreak: 'break-all',
      maxWidth: 12,
      billboard: false,
    })[0];
    const p = layer.props;
    expect(p.getTextAnchor).toBe('start');
    expect(p.getAlignmentBaseline).toBe('bottom');
    expect(p.getPixelOffset).toEqual([4, -8]);
    expect(p.background).toBe(true);
    // Deprecated `backgroundColor` maps to the modern getBackgroundColor accessor.
    expect(p.getBackgroundColor).toEqual([10, 10, 10, 200]);
    expect(p.backgroundPadding).toEqual([2, 3, 2, 3]);
    expect(p.getBorderColor).toEqual([1, 2, 3, 255]);
    expect(p.getBorderWidth).toBe(2);
    expect(p.outlineColor).toEqual([9, 9, 9, 255]);
    expect(p.outlineWidth).toBe(4);
    expect(p.fontFamily).toBe('Helvetica');
    expect(p.fontWeight).toBe(700);
    expect(p.fontSettings).toEqual({ sdf: true });
    expect(p.characterSet).toBe('auto');
    expect(p.sizeScale).toBe(2);
    expect(p.sizeUnits).toBe('meters');
    expect(p.sizeMinPixels).toBe(8);
    expect(p.sizeMaxPixels).toBe(64);
    expect(p.wordBreak).toBe('break-all');
    expect(p.maxWidth).toBe(12);
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
    const first = (layer as any).renderLayers()[0].props.data;
    expect(first.map((d: any) => d.text)).toEqual(['a']);
    // Move the playhead so 'b' enters and 'a' leaves the window.
    layer._currentTime = 9000;
    const second = (layer as any).renderLayers()[0].props.data;
    expect(second).not.toBe(first);
    expect(second.map((d: any) => d.text)).toEqual(['b']);
  });

  // ── Caching / lifecycle ────────────────────────────────────────────────────

  it('reuses the decoded full-row set across renders (same styleKey)', () => {
    const layer = makeLayer();
    const tile = makeLabelTile([{ lon: 0, lat: 0, t: 0, text: 'a' }], {
      tileId: { z: 16, x: 1, y: 2, t: 0 },
    });
    layer.state = { tiles: [tile] };
    layer._currentTime = 0;
    (layer as any).renderLayers();
    const key = `16/1/2/0:layer0`;
    const firstDecoded = layer.decodedCache.get(key);
    expect(firstDecoded).toBeDefined();
    (layer as any).renderLayers();
    expect(layer.decodedCache.get(key)).toBe(firstDecoded);
  });

  it('re-decodes when a style prop that feeds the rows changes', () => {
    const tile = makeLabelTile([
      { lon: 0, lat: 0, t: 0, text: 'a', category: 'road' },
    ]);
    const a = render([tile], 0, { color: [1, 1, 1, 255] })[0].props.data;
    expect(a[0].color).toEqual([1, 1, 1, 255]);
    const b = render([tile], 0, {
      color: 'category',
      colorMapping: { road: [50, 60, 70, 255] },
    })[0].props.data;
    expect(b[0].color).toEqual([50, 60, 70, 255]);
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
    const rows = sublayer.props.sttRows;
    expect(rows.length).toBe(1);
    expect(rows[0].i).toBe(1); // original feature index

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
