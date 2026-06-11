/**
 * Regression: explicitly-undefined own props must not shadow defaultProps.
 *
 * deck.gl resolves defaults through the props object's prototype chain, so
 * `new AnimatedPointLayer({ strokeColor: cfg.strokeColor })` with an absent
 * config field would normally SHADOW the default with `undefined` — the
 * showcase does exactly this, and the resulting `getLineColor: undefined` on
 * the slab ScatterplotLayers killed every cumulative demo (deck's attribute
 * updater asserts "accessor is not a function" on undefined). The base-class
 * constructor strips explicitly-undefined own keys so defaults apply.
 *
 * Uses the REAL @deck.gl/core (no fake harness): deck builds this.props
 * eagerly in the Layer constructor, no device required.
 */
import { describe, it, expect } from 'vitest';
import { AnimatedPointLayer } from '../src/layers/core/animated-point-layer';
import { AnimatedPathLayer } from '../src/layers/core/animated-path-layer';

describe('explicit-undefined props fall back to defaults', () => {
  it('strokeColor: undefined resolves to the defaultProps color', () => {
    const layer = new AnimatedPointLayer({
      id: 'pts',
      url: 'http://example.com/manifest.json',
      strokeColor: undefined,
    } as any);
    expect(layer.props.strokeColor).toEqual([0, 0, 0, 255]);
  });

  it('scalar style props with explicit undefined keep their defaults', () => {
    const layer = new AnimatedPointLayer({
      id: 'pts',
      url: 'http://example.com/manifest.json',
      radiusUnits: undefined,
      radiusScale: undefined,
      stroked: undefined,
      lineWidthMinPixels: undefined,
      cumulative: undefined,
    } as any);
    expect(layer.props.radiusUnits).toBe('pixels');
    expect(layer.props.radiusScale).toBe(1);
    expect(layer.props.stroked).toBe(false);
    expect(layer.props.lineWidthMinPixels).toBe(0);
    expect(layer.props.cumulative).toBe(false);
  });

  it('null-default props keep an explicit null (null means "none", not "default")', () => {
    const layer = new AnimatedPointLayer({
      id: 'pts',
      url: 'http://example.com/manifest.json',
      colorMapping: null,
      getLineColor: null,
    } as any);
    expect(layer.props.colorMapping).toBeNull();
    expect(layer.props.getLineColor).toBeNull();
  });

  it('defined values pass through untouched', () => {
    const layer = new AnimatedPathLayer({
      id: 'paths',
      url: 'http://example.com/manifest.json',
      pathWidth: 7,
      widthUnits: undefined,
    } as any);
    expect(layer.props.pathWidth).toBe(7);
    expect(layer.props.widthUnits).toBe('pixels');
  });
});
