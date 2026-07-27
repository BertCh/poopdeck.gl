/**
 * AnimatedTextLayer — review-fix regressions.
 *
 * Each block pins ONE finding from the layers review:
 *  4. the fade colour signature advances only while a row is ACTUALLY ramping,
 *     not merely because a fade duration is configured;
 *  5. membership is summarized by a cheap primitive signature with an early-out,
 *     and a `timesSorted` tile takes a two-boundary binary search;
 *  6. the categorical dictionary expands per CATEGORY (colour table +
 *     transcoded label) and the exact glyph set is derived once per tile;
 *  7. the sublayer consumes deck's BINARY `getText` interface (code points +
 *     startIndices), sharing the decoded buffer zero-copy for a contiguous run;
 *  8. sublayer INSTANCES are cached, so an unchanged frame reconstructs nothing;
 * 10. the upstream prop gaps (lineHeight, backgroundBorderRadius, content box /
 *     cutoff / alignment) and the accessor-name aliases are wired;
 * 12. numeric labels print the shortest float32 round-trip, not `1.100000023841858`;
 * 13. a non-point tile layer is skipped rather than misread.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile, makePathTile } from './fake-tile';

vi.mock('@deck.gl/layers', () => {
  class FakeTextLayer {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

interface Row {
  t: number;
  end?: number;
  text?: string;
}

function labelTile(
  rows: Row[],
  opts: { sorted?: boolean; tileId?: any } = {},
): any {
  const tile = makePointTile({
    positions: rows.map((_, i) => [i * 0.01, 0]),
    startTimes: rows.map((r) => r.t),
    endTimes: rows.map((r) => r.end ?? r.t),
    timeOffset: 0,
    tileId: opts.tileId,
  });
  const f = tile.layers[0].features;
  f.categoricalProps['text'] = categorical(rows.map((r) => r.text ?? 'x'));
  if (opts.sorted) f.timesSorted = true;
  return tile;
}

function textsOf(layer: any): string[] {
  const { length, startIndices, attributes } = layer.props.data;
  const codes: Uint32Array = attributes.getText.value;
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    out.push(
      String.fromCodePoint(
        ...Array.from(codes.subarray(startIndices[i], startIndices[i + 1])),
      ),
    );
  }
  return out;
}

function readAccessor(fn: any, index: number): any {
  return typeof fn === 'function' ? fn(undefined, { index, target: [] }) : fn;
}

const BASE_PROPS: Record<string, any> = {
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
  timeWindow: 2000,
  opacity: 1,
  visible: true,
};

describe('AnimatedTextLayer review fixes', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-text-layer');
    LayerCtor = mod.AnimatedTextLayer as any;
    makeLayer = (opts = {}) => {
      const layer = Object.create(LayerCtor.prototype);
      layer.props = { ...BASE_PROPS, ...opts };
      layer._currentTime = 0;
      layer.decodedCache = new Map();
      layer.visibleCache = new Map();
      layer.sublayerCache = new Map();
      layer.lastLayerPropsKey = '';
      layer.lastTilesRef = null;
      layer.lastFrameTime = NaN;
      return layer;
    };
  });

  const render = (layer: any, tiles: any[], time: number) => {
    layer.state = { tiles };
    layer._currentTime = time;
    return layer.renderLayers();
  };

  // ── 7. binary getText interface ──────────────────────────────────────────

  describe('MED — the sublayer consumes deck’s BINARY getText interface', () => {
    it('hands TextLayer {length, startIndices, attributes.getText} — not CPU rows', () => {
      const layer = makeLayer();
      const tile = labelTile([
        { t: 0, text: 'ab' },
        { t: 0, text: 'cde' },
      ]);
      const sub = render(layer, [tile], 0)[0];
      const data = sub.props.data;
      expect(Array.isArray(data)).toBe(false);
      expect(data.length).toBe(2);
      expect(data.startIndices).toBeInstanceOf(Uint32Array);
      expect(Array.from(data.startIndices)).toEqual([0, 2, 5]);
      const codes = data.attributes.getText.value;
      expect(codes).toBeInstanceOf(Uint32Array);
      expect(Array.from(codes)).toEqual(
        [...'abcde'].map((c) => c.codePointAt(0)),
      );
      // `getText` itself is NOT an accessor — deck derives it from the buffer.
      expect(sub.props.getText).toBeUndefined();
    });

    it('shares the decoded code-point buffer zero-copy for a contiguous visible run', () => {
      const layer = makeLayer();
      const tile = labelTile(
        [
          { t: 0, text: 'aa' },
          { t: 0, text: 'bb' },
        ],
        { tileId: { z: 3, x: 1, y: 1, t: 0 } },
      );
      const sub = render(layer, [tile], 0)[0];
      const decoded = layer.decodedCache.get('3/1/1/0:layer0');
      expect(sub.props.data.attributes.getText.value.buffer).toBe(
        decoded.codePoints.buffer,
      );
    });

    it('compacts a NON-contiguous visible subset into a fresh buffer', () => {
      const layer = makeLayer();
      // Window 2000 → half 1000. At now=0 only rows 0 and 2 overlap.
      const tile = labelTile([
        { t: 0, text: 'aa' },
        { t: 50000, text: 'zz' },
        { t: 500, text: 'cc' },
      ]);
      const sub = render(layer, [tile], 0)[0];
      expect(textsOf(sub)).toEqual(['aa', 'cc']);
      expect(Array.from(sub.props.data.startIndices)).toEqual([0, 2, 4]);
      const decoded = layer.decodedCache.get('0/0/0/0:layer0');
      expect(sub.props.data.attributes.getText.value.buffer).not.toBe(
        decoded.codePoints.buffer,
      );
    });

    it('drops zero-length labels (they draw nothing and break deck’s binary slicer)', () => {
      const layer = makeLayer();
      const tile = labelTile([
        { t: 0, text: '' },
        { t: 0, text: 'here' },
      ]);
      const sub = render(layer, [tile], 0)[0];
      expect(textsOf(sub)).toEqual(['here']);
      // The empty leading row would have made startIndices[1] === 0, which
      // deck's `startIndices[i + 1] || characterCount` reads as "absent".
      expect(sub.props.data.startIndices[1]).toBeGreaterThan(0);
    });
  });

  // ── 5. membership signature + early-out + sorted search ──────────────────

  describe('MED — cheap membership signature with an early-out', () => {
    it('reuses the SAME visible payload (and sublayer) when membership is unchanged', () => {
      const layer = makeLayer();
      const tile = labelTile([
        { t: 5000, end: 6000, text: 'a' },
        { t: 5100, end: 6000, text: 'b' },
      ]);
      const first = render(layer, [tile], 5000)[0];
      // A different playhead that keeps exactly the same rows visible.
      const second = render(layer, [tile], 5050)[0];
      expect(second).toBe(first);
      expect(second.props.data).toBe(first.props.data);
    });

    it('uses a contiguous-run token, not a per-index concatenation, as the signature', () => {
      const layer = makeLayer();
      const tile = labelTile([
        { t: 0, text: 'a' },
        { t: 0, text: 'b' },
        { t: 0, text: 'c' },
      ]);
      render(layer, [tile], 0);
      const vis = layer.visibleCache.get('0/0/0/0:layer0');
      expect(vis.sig).toBe('r0:3');
      // Non-contiguous membership falls back to count/first/last + a hash — a
      // bounded primitive, never an O(rows) string.
      const gappy = labelTile([
        { t: 0, text: 'a' },
        { t: 50000, text: 'b' },
        { t: 0, text: 'c' },
      ]);
      const l2 = makeLayer();
      render(l2, [gappy], 0);
      expect(l2.visibleCache.get('0/0/0/0:layer0').sig).toMatch(/^s2:0:2:\d+$/);
    });

    it('rebuilds when membership actually changes', () => {
      const layer = makeLayer();
      const tile = labelTile([
        { t: 0, text: 'a' },
        { t: 5000, text: 'b' },
      ]);
      const first = render(layer, [tile], 0)[0];
      const second = render(layer, [tile], 5000)[0];
      expect(second).not.toBe(first);
      expect(textsOf(first)).toEqual(['a']);
      expect(textsOf(second)).toEqual(['b']);
    });

    it('takes the two-boundary binary search on a timesSorted tile, matching the full scan', () => {
      const rows: Row[] = [];
      for (let i = 0; i < 200; i++) rows.push({ t: i * 100, text: `l${i}` });
      const sortedTile = labelTile(rows, { sorted: true });
      const scanTile = labelTile(rows);
      expect(sortedTile.layers[0].features.timesSorted).toBe(true);
      expect(scanTile.layers[0].features.timesSorted).toBeUndefined();

      for (const now of [0, 5000, 10000, 19900, 30000]) {
        const a = render(makeLayer(), [sortedTile], now);
        const b = render(makeLayer(), [scanTile], now);
        expect(a.length).toBe(b.length);
        if (a.length) expect(textsOf(a[0])).toEqual(textsOf(b[0]));
      }
    });

    it('widens the sorted lower bound by the tile’s longest duration', () => {
      // A long-lived row sorted FIRST still overlaps a much later window; a
      // naive `startTime >= windowStart` bound would drop it.
      const rows: Row[] = [{ t: 0, end: 100000, text: 'banner' }];
      for (let i = 1; i < 50; i++) rows.push({ t: i * 1000, text: `l${i}` });
      const sorted = labelTile(rows, { sorted: true });
      const scan = labelTile(rows);
      const a = render(makeLayer(), [sorted], 30000);
      const b = render(makeLayer(), [scan], 30000);
      expect(textsOf(a[0])).toEqual(textsOf(b[0]));
      expect(textsOf(a[0])).toContain('banner');
    });
  });

  // ── 8. sublayer-instance cache ───────────────────────────────────────────

  describe('MED — sublayer instances are cached', () => {
    it('returns the identical TextLayer instance across an unchanged frame', () => {
      const layer = makeLayer();
      const tile = labelTile([{ t: 0, end: 100000, text: 'a' }]);
      const first = render(layer, [tile], 0)[0];
      const second = render(layer, [tile], 1)[0];
      expect(second).toBe(first);
      expect(second.props.getPosition).toBe(first.props.getPosition);
      expect(second.props.updateTriggers).toBe(first.props.updateTriggers);
    });

    it('rebuilds every sublayer when a layer-level style prop changes', () => {
      const layer = makeLayer();
      const tile = labelTile([{ t: 0, end: 100000, text: 'a' }]);
      const first = render(layer, [tile], 0)[0];
      layer.props.sizeScale = 3;
      const second = render(layer, [tile], 0)[0];
      expect(second).not.toBe(first);
      expect(second.props.sizeScale).toBe(3);
    });

    it('drops cache entries for tiles that leave the visible set', () => {
      const layer = makeLayer();
      const a = labelTile([{ t: 0, end: 100000, text: 'a' }], {
        tileId: { z: 1, x: 0, y: 0, t: 0 },
      });
      const b = labelTile([{ t: 0, end: 100000, text: 'b' }], {
        tileId: { z: 1, x: 1, y: 0, t: 0 },
      });
      render(layer, [a, b], 0);
      expect(layer.sublayerCache.size).toBe(2);
      render(layer, [a], 0);
      expect(layer.sublayerCache.size).toBe(1);
    });
  });

  // ── 4. fade signature churn ──────────────────────────────────────────────

  describe('MED — the fade colour signature tracks ACTUAL ramping', () => {
    it('keeps the colour trigger (and the sublayer) stable while fade is merely configured', () => {
      const layer = makeLayer({
        // Configured but never engaged: every row sits at fade === 1 under a
        // window far wider than the ramp — the case a prop-level
        // `fadeIn > 0 || fadeOut > 0` flag churned every frame.
        fadeInDuration: 300,
        fadeOutDuration: 300,
        timeWindow: 2000,
      });
      const tile = labelTile([{ t: 0, end: 1e6, text: 'a' }]);
      const first = render(layer, [tile], 5000)[0];
      const second = render(layer, [tile], 5001)[0];
      expect(second).toBe(first);
      expect(first.props.updateTriggers.getColor).toBe(
        first.props.updateTriggers.getText,
      );
      // …and the background/border stay CONSTANTS, not per-row sweeps.
      expect(typeof first.props.getBackgroundColor).not.toBe('function');
      expect(typeof first.props.getBorderColor).not.toBe('function');
      expect(readAccessor(first.props.getColor, 0)[3]).toBe(255);
    });

    it('advances the colour trigger while a row is genuinely mid-ramp', () => {
      const layer = makeLayer({ fadeInDuration: 800, color: [1, 2, 3, 255] });
      const tile = labelTile([{ t: 0, end: 1e6, text: 'a' }]);
      const first = render(layer, [tile], -600)[0];
      expect(first.props.updateTriggers.getColor).not.toBe(
        first.props.updateTriggers.getText,
      );
      expect(readAccessor(first.props.getColor, 0)[3]).toBeLessThan(255);
      const second = render(layer, [tile], -500)[0];
      expect(second).not.toBe(first);
      expect(second.props.updateTriggers.getColor).not.toBe(
        first.props.updateTriggers.getColor,
      );
    });

    it('settles back to a constant signature once the ramp completes', () => {
      const layer = makeLayer({ fadeInDuration: 800, color: [1, 2, 3, 255] });
      const tile = labelTile([{ t: 0, end: 1e6, text: 'a' }]);
      render(layer, [tile], -600); // mid-ramp
      const done = render(layer, [tile], 5000)[0];
      expect(done.props.updateTriggers.getColor).toBe(
        done.props.updateTriggers.getText,
      );
      expect(readAccessor(done.props.getColor, 0)[3]).toBe(255);
      // …and stays put on the next frame.
      expect(render(layer, [tile], 5001)[0]).toBe(done);
    });
  });

  // ── 6. per-category expansion + derived character set ────────────────────

  describe('MED — the categorical dictionary expands per CATEGORY', () => {
    it('resolves the colour mapping per distinct value — cost independent of feature count', () => {
      /** Decode `n` features over the SAME 2 categories, counting map reads. */
      const run = (n: number) => {
        const tile = makePointTile({
          positions: Array.from({ length: n }, (_, i) => [i * 0.001, 0]),
          startTimes: new Array(n).fill(0),
          endTimes: new Array(n).fill(0),
          timeOffset: 0,
        });
        const kinds = Array.from({ length: n }, (_, i) =>
          i % 2 ? 'river' : 'road',
        );
        tile.layers[0].features.categoricalProps['text'] = categorical(
          Array.from({ length: n }, (_, i) => `l${i}`),
        );
        tile.layers[0].features.categoricalProps['kind'] = categorical(kinds);
        let reads = 0;
        const mapping = new Proxy(
          { road: [1, 2, 3, 255], river: [4, 5, 6, 255] } as Record<
            string,
            any
          >,
          {
            get(t, k) {
              if (typeof k === 'string' && k in t) reads++;
              return (t as any)[k];
            },
          },
        );
        const layer = makeLayer({ color: 'kind', colorMapping: mapping });
        const sub = render(layer, [tile], 0)[0];
        return { reads, sub };
      };

      const small = run(6);
      const large = run(600);
      // The colour table is built from `cat.categories`, so the lookup count is
      // a function of the CATEGORY count, not the row count. (The style digest
      // reads the map once per key too — hence "equal", not "exactly 2".)
      expect(large.reads).toBe(small.reads);
      expect(small.reads).toBeLessThanOrEqual(4);
      expect(readAccessor(large.sub.props.getColor, 0)).toEqual([1, 2, 3, 255]);
      expect(readAccessor(large.sub.props.getColor, 1)).toEqual([4, 5, 6, 255]);
      expect(readAccessor(large.sub.props.getColor, 599)).toEqual([
        4, 5, 6, 255,
      ]);
    });

    it('derives the EXACT glyph set from the tile’s categories and keeps the reference stable', () => {
      const layer = makeLayer();
      const tile = labelTile([
        { t: 0, end: 1e6, text: 'ab' },
        { t: 0, end: 1e6, text: 'bc' },
      ]);
      const first = render(layer, [tile], 0)[0];
      expect(first.props.characterSet).toEqual(['a', 'b', 'c']);
      // A stable reference is load-bearing: deck's `_updateFontAtlas` compares
      // `characterSet` by IDENTITY, and its own 'auto' hands over a fresh Set
      // on every membership change (bumping styleVersion → full re-layout).
      const second = render(layer, [tile], 1)[0];
      expect(second.props.characterSet).toBe(first.props.characterSet);
    });

    it('forwards a pinned characterSet verbatim (no derivation)', () => {
      const layer = makeLayer({ characterSet: ['x', 'y'] });
      const tile = labelTile([{ t: 0, text: 'ab' }]);
      const sub = render(layer, [tile], 0)[0];
      expect(sub.props.characterSet).toEqual(['x', 'y']);
    });

    it('rebuilds when a pinned characterSet Set is swapped for a different one', () => {
      // A Set has no own enumerable keys, so a generic structural digest
      // collapses every Set to `{}` — the swap would never reach deck.
      const layer = makeLayer({ characterSet: new Set(['a', 'b']) });
      const tile = labelTile([{ t: 0, end: 1e6, text: 'ab' }]);
      const first = render(layer, [tile], 0)[0];
      layer.props.characterSet = new Set(['a', 'b', 'c']);
      const second = render(layer, [tile], 0)[0];
      expect(second).not.toBe(first);
      expect(Array.from(second.props.characterSet)).toEqual(['a', 'b', 'c']);
    });
  });

  // ── 12. numeric label formatting ─────────────────────────────────────────

  describe('LOW — numeric labels avoid float32 noise', () => {
    it('prints the shortest string that round-trips the stored float32', () => {
      const tile = makePointTile({
        positions: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        startTimes: [0, 0, 0],
        endTimes: [0, 0, 0],
        timeOffset: 0,
      });
      tile.layers[0].features.numericProps['v'] = new Float32Array([
        1.1, 0.3, 42,
      ]);
      // Sanity: the naive String(v) is exactly the noise this fixes.
      expect(String(new Float32Array([1.1])[0])).toBe('1.100000023841858');
      const sub = render(makeLayer({ textProperty: 'v' }), [tile], 0)[0];
      expect(textsOf(sub)).toEqual(['1.1', '0.3', '42']);
    });

    it('honours an explicit textPrecision', () => {
      const tile = makePointTile({
        positions: [[0, 0]],
        startTimes: [0],
        endTimes: [0],
        timeOffset: 0,
      });
      tile.layers[0].features.numericProps['v'] = new Float32Array([1.1]);
      const sub = render(
        makeLayer({ textProperty: 'v', textPrecision: 2 }),
        [tile],
        0,
      )[0];
      expect(textsOf(sub)).toEqual(['1.10']);
    });

    it('renders nothing for a non-finite value', () => {
      const tile = makePointTile({
        positions: [
          [0, 0],
          [1, 0],
        ],
        startTimes: [0, 0],
        endTimes: [0, 0],
        timeOffset: 0,
      });
      tile.layers[0].features.numericProps['v'] = new Float32Array([NaN, 7]);
      const sub = render(makeLayer({ textProperty: 'v' }), [tile], 0)[0];
      expect(textsOf(sub)).toEqual(['7']);
    });
  });

  // ── 10. prop gaps + accessor aliases ─────────────────────────────────────

  describe('MED — upstream prop gaps and accessor-name aliases', () => {
    it('forwards lineHeight (upstream default 1) so multi-line labels are stylable', () => {
      expect(LayerCtor.defaultProps.lineHeight.value).toBe(1);
      const tile = labelTile([{ t: 0, text: 'a' }]);
      const sub = render(makeLayer({ lineHeight: 1.6 }), [tile], 0)[0];
      expect(sub.props.lineHeight).toBe(1.6);
    });

    it('forwards backgroundBorderRadius, content box, cutoff and alignment', () => {
      const tile = labelTile([{ t: 0, text: 'a' }]);
      const sub = render(
        makeLayer({
          backgroundBorderRadius: [1, 2, 3, 4],
          getContentBox: [0, 0, 100, 40],
          contentCutoffPixels: [12, 8],
          contentAlignHorizontal: 'start',
          contentAlignVertical: 'center',
        }),
        [tile],
        0,
      )[0];
      expect(sub.props.backgroundBorderRadius).toEqual([1, 2, 3, 4]);
      expect(sub.props.getContentBox).toEqual([0, 0, 100, 40]);
      expect(sub.props.contentCutoffPixels).toEqual([12, 8]);
      expect(sub.props.contentAlignHorizontal).toBe('start');
      expect(sub.props.contentAlignVertical).toBe('center');
    });

    it('lets the upstream accessor names win over the legacy background/border props', () => {
      const tile = labelTile([{ t: 0, text: 'a' }]);
      const sub = render(
        makeLayer({
          backgroundColor: [1, 1, 1, 255],
          getBackgroundColor: [9, 8, 7, 255],
          borderColor: [2, 2, 2, 255],
          getBorderColor: [6, 5, 4, 255],
          borderWidth: 1,
          getBorderWidth: 5,
        }),
        [tile],
        0,
      )[0];
      expect(sub.props.getBackgroundColor).toEqual([9, 8, 7, 255]);
      expect(sub.props.getBorderColor).toEqual([6, 5, 4, 255]);
      expect(sub.props.getBorderWidth).toBe(5);
    });

    it('warns once and falls back when an alias holds a function accessor', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tile = labelTile([{ t: 0, text: 'a' }]);
      const sub = render(
        makeLayer({
          backgroundColor: [3, 3, 3, 255],
          getBackgroundColor: () => [0, 0, 0, 0],
        }),
        [tile],
        0,
      )[0];
      expect(sub.props.getBackgroundColor).toEqual([3, 3, 3, 255]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('never forwards the deprecated upstream `backgroundColor` prop name', () => {
      const tile = labelTile([{ t: 0, text: 'a' }]);
      const sub = render(
        makeLayer({ background: true, backgroundColor: [5, 5, 5, 255] }),
        [tile],
        0,
      )[0];
      expect(sub.props.backgroundColor).toBeUndefined();
      expect(sub.props.getBackgroundColor).toEqual([5, 5, 5, 255]);
    });
  });

  // ── 13. geometry guard ───────────────────────────────────────────────────

  describe('geometry guard', () => {
    it('skips a LineString tile layer instead of anchoring labels on vertices', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tile = makePathTile({
        paths: [
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        ],
        startTimes: [0],
        endTimes: [1000],
        timeOffset: 0,
      });
      tile.layers[0].features.categoricalProps['text'] = categorical(['a']);
      const layer = makeLayer();
      expect(render(layer, [tile], 0)).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
