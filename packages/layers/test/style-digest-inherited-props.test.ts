/**
 * `inheritedPropsDigest` — the cache-invalidation contract the animated layers
 * fold into their hand-rolled sublayer keys.
 *
 * The digest must cover EVERY prop `CompositeLayer.getSubLayerProps()` forwards
 * into a sublayer, because those values are baked into cached sublayer
 * instances at construction time: anything missing would only ever apply to
 * newly built tiles. Audited against the installed deck.gl 9.3.2
 * `composite-layer.ts`, which forwards opacity, pickable, visible, parameters,
 * getPolygonOffset, highlightedObjectIndex, autoHighlight, highlightColor,
 * coordinateSystem, coordinateOrigin, wrapLongitude, positionFormat,
 * modelMatrix, extensions, fetch and operation — plus `_subLayerProps[id]`,
 * the `updateTriggers` seed, and each extension's `getSubLayerProps`
 * pass-through.
 */

import { describe, it, expect } from 'vitest';
import { inheritedPropsDigest } from '../src/lib/style-digest';

/** Baseline with every forwarded prop present, so each test flips exactly one. */
const BASE = {
  opacity: 1,
  pickable: true,
  visible: true,
  parameters: { depthTest: true },
  getPolygonOffset: null,
  highlightedObjectIndex: -1,
  autoHighlight: false,
  highlightColor: [0, 0, 128, 128],
  coordinateSystem: 1,
  coordinateOrigin: [0, 0, 0],
  wrapLongitude: false,
  positionFormat: 'XY',
  modelMatrix: null,
  extensions: [],
  fetch: null,
  operation: 'draw',
  _subLayerProps: null,
  updateTriggers: undefined,
} as Record<string, any>;

/** Every key upstream `getSubLayerProps` destructures off the composite props. */
const FORWARDED_PROPS: [key: string, changedValue: unknown][] = [
  ['opacity', 0.5],
  ['pickable', false],
  ['visible', false],
  ['parameters', { depthTest: false }],
  ['getPolygonOffset', () => [0, 0]],
  ['highlightedObjectIndex', 4],
  ['autoHighlight', true],
  ['highlightColor', [255, 0, 0, 255]],
  ['coordinateSystem', 2],
  ['coordinateOrigin', [1, 2, 3]],
  ['wrapLongitude', true],
  ['positionFormat', 'XYZ'],
  ['modelMatrix', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
  ['fetch', () => null],
  ['operation', 'mask'],
  ['_subLayerProps', { points: { radiusScale: 3 } }],
];

describe('inheritedPropsDigest', () => {
  it.each(FORWARDED_PROPS)('changes when `%s` changes', (key, value) => {
    const before = inheritedPropsDigest(BASE);
    const after = inheritedPropsDigest({ ...BASE, [key]: value });
    expect(after).not.toBe(before);
  });

  it('is stable for an equal-valued, freshly-allocated props object', () => {
    const a = inheritedPropsDigest({
      ...BASE,
      highlightColor: [0, 0, 128, 128],
      coordinateOrigin: [0, 0, 0],
      parameters: { depthTest: true },
    });
    const b = inheritedPropsDigest({
      ...BASE,
      highlightColor: [0, 0, 128, 128],
      coordinateOrigin: [0, 0, 0],
      parameters: { depthTest: true },
    });
    expect(a).toBe(b);
  });

  it('changes when the extension LIST changes', () => {
    class Brushing {}
    const before = inheritedPropsDigest(BASE);
    const after = inheritedPropsDigest({
      ...BASE,
      extensions: [new Brushing()],
    });
    expect(after).not.toBe(before);
  });

  it('changes when a prop an extension PASSES THROUGH changes', () => {
    // `LayerExtension.getSubLayerProps` copies each key of the extension
    // class's defaultProps off the COMPOSITE's props, so `filterRange` reaches
    // every sublayer even though the composite declares nothing about it.
    // Digesting the extension list alone would miss this.
    class DataFilterExtension {
      static defaultProps = { filterRange: null, getFilterValue: null };
    }
    const extensions = [new DataFilterExtension()];
    const before = inheritedPropsDigest({
      ...BASE,
      extensions,
      filterRange: [0, 10],
    });
    const after = inheritedPropsDigest({
      ...BASE,
      extensions,
      filterRange: [0, 20],
    });
    expect(after).not.toBe(before);
  });

  it('ignores extension defaultProps keys the composite does not carry', () => {
    class Ext {
      static defaultProps = { neverSet: 1 };
    }
    const a = inheritedPropsDigest({ ...BASE, extensions: [new Ext()] });
    const b = inheritedPropsDigest({ ...BASE, extensions: [new Ext()] });
    expect(a).toBe(b);
  });

  it('changes when `updateTriggers` bumps (deck’s canonical rebuild signal)', () => {
    const before = inheritedPropsDigest({
      ...BASE,
      updateTriggers: { getFillColor: 1 },
    });
    const after = inheritedPropsDigest({
      ...BASE,
      updateTriggers: { getFillColor: 2 },
    });
    expect(after).not.toBe(before);
  });

  it('tolerates a sparse props object (nothing set)', () => {
    expect(() => inheritedPropsDigest({})).not.toThrow();
    expect(inheritedPropsDigest({})).toBe(inheritedPropsDigest({}));
  });
});
