/**
 * Regression: deck's extension prop pass-through must not clobber the per-tile
 * wiring the chassis installs.
 *
 * `CompositeLayer.getSubLayerProps` (deck 9.3.2, core/lib/composite-layer.ts)
 * assigns in this order:
 *
 *   inherited  <  sublayerProps (ours)  <  _subLayerProps[id] (the user's)
 *                                       <  extension defaultProps, LAST
 *
 * The final step loops `this.props.extensions` — the user's RAW array, not the
 * deduped list `composeExtensions` returns — and `LayerExtension.getSubLayerProps`
 * copies every key of the extension class's `defaultProps` off the composite.
 * `create-props.ts` merges those defaults into the composite's props PROTOTYPE,
 * so `key in this.props` is always true and the copy always fires.
 *
 * Consequence before the fix: a user who followed the chassis docstring and
 * passed `extensions: [new TimeFilterExtension()]` at the top level got
 * `getTime: null` and `timeOffset: 0` on every per-tile sublayer. Absolute epoch
 * ms was then compared against tile-RELATIVE f32 time attributes and the layer
 * rendered blank — the exact failure `composeExtensions`' constructor dedupe
 * claimed to have fixed but never did (that only ever fixed double shader
 * injection).
 *
 * Uses the REAL `@deck.gl/core` — the whole point is the upstream assign order.
 */
import { describe, it, expect } from 'vitest';
import { AnimatedPointLayer } from '../src/layers/core/animated-point-layer';
import { TimeFilterExtension } from '../src/extensions/time-filter-extension';
import { CategoryColorExtension } from '../src/extensions/category-color-extension';

/** Reach the protected chassis helper the animated layers all build through. */
function compose(
  layer: any,
  shortId: string,
  sublayerProps: Record<string, any>,
): Record<string, any> {
  return layer.composeSubLayerProps(shortId, 'z/x/y/t', sublayerProps);
}

describe('extension pass-through does not clobber per-tile sublayer props', () => {
  const perTileGetTime = () => 1_700_000_050_000;

  it('keeps getTime/timeOffset when the user re-adds TimeFilterExtension', () => {
    const layer = new AnimatedPointLayer({
      id: 'probe',
      data: 'http://example.com/manifest.json',
      extensions: [new TimeFilterExtension()],
    } as any);

    const out = compose(layer, 'points', {
      getTime: perTileGetTime,
      timeOffset: 1_700_000_000_000,
      timeWindow: 1000,
    });

    // TimeFilterExtension.defaultProps declares all three, so all three were
    // overwritten before the fix (null / 0 / 0).
    expect(out.getTime).toBe(perTileGetTime);
    expect(out.timeOffset).toBe(1_700_000_000_000);
    expect(out.timeWindow).toBe(1000);
  });

  it('keeps categoryPalette when the user re-adds CategoryColorExtension', () => {
    const palette = [
      [1, 2, 3, 255],
      [4, 5, 6, 255],
    ];
    const layer = new AnimatedPointLayer({
      id: 'probe',
      data: 'http://example.com/manifest.json',
      extensions: [new CategoryColorExtension()],
    } as any);

    const out = compose(layer, 'points', { categoryPalette: palette });
    expect(out.categoryPalette).toBe(palette);
  });

  it('still lets the extension supply keys the caller did NOT set', () => {
    // The repair must not disable the pass-through — only re-assert precedence
    // for keys we (or the user) explicitly passed.
    const layer = new AnimatedPointLayer({
      id: 'probe',
      data: 'http://example.com/manifest.json',
      timeWindow: 4242,
      extensions: [new TimeFilterExtension()],
    } as any);

    const out = compose(layer, 'points', { getTime: perTileGetTime });
    expect(out.getTime).toBe(perTileGetTime);
    // Not passed in sublayerProps ⇒ the pass-through's value (read off the
    // composite) is the right answer.
    expect(out.timeWindow).toBe(4242);
  });

  it("_subLayerProps still outranks the layer's own value", () => {
    const userGetTime = () => 5;
    const layer = new AnimatedPointLayer({
      id: 'probe',
      data: 'http://example.com/manifest.json',
      extensions: [new TimeFilterExtension()],
      _subLayerProps: { points: { getTime: userGetTime } },
    } as any);

    const out = compose(layer, 'points', { getTime: perTileGetTime });
    expect(out.getTime).toBe(userGetTime);
  });

  it('is a no-op when no extensions are attached', () => {
    const layer = new AnimatedPointLayer({
      id: 'probe',
      data: 'http://example.com/manifest.json',
    } as any);
    const out = compose(layer, 'points', { getTime: perTileGetTime });
    expect(out.getTime).toBe(perTileGetTime);
  });
});
