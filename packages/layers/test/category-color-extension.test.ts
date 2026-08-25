/**
 * CategoryColorExtension — per-draw cost (tile-loading audit 2026-08).
 *
 * The extension is installed on EVERY animated layer, categorical or not,
 * and `draw()` runs once per model per frame — one call per visible tile.
 * It used to push the full uniform block (three values that never move on
 * the common layer) through `setShaderModuleProps` on every one of those
 * calls, and `appendNullCategorySlot` minted a fresh palette array per tile
 * prepare, so `colorListDigest`'s per-reference memo missed every time.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CategoryColorExtension,
  appendNullCategorySlot,
} from '../src/extensions/category-color-extension';
import { colorListDigest } from '../src/lib/style-digest';

function host(props: Record<string, any>) {
  const ext = new CategoryColorExtension();
  const push = vi.fn();
  const models = [{}];
  const paletteTexture = { id: 'tex' };
  const layer = {
    props,
    state: { paletteTexture } as Record<string, unknown>,
    getModels: () => models,
    setShaderModuleProps: push,
  };
  const draw = () => (ext.draw as any).call(layer, {}, ext);
  return { layer, push, models, paletteTexture, draw };
}

describe('CategoryColorExtension draw() push cache', () => {
  it('pushes the full block once per model set, then nothing while unchanged', () => {
    const { push, paletteTexture, draw } = host({
      categoryPalette: [[1, 2, 3, 255]],
      useCategoryColor: false,
    });
    draw();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].categoryColor).toEqual({
      paletteSize: 1,
      useCategoryColor: 0,
      paletteTexture,
    });
    for (let i = 0; i < 20; i++) draw();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('an uncategorical layer costs exactly one push for its lifetime', () => {
    const { push, draw } = host({});
    for (let i = 0; i < 20; i++) draw();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].categoryColor.useCategoryColor).toBe(0);
  });

  it('pushes only the value that changed on the same model set', () => {
    const { layer, push, draw } = host({
      categoryPalette: [[1, 2, 3, 255]],
      useCategoryColor: false,
    });
    draw();
    layer.props = { ...layer.props, useCategoryColor: true };
    draw();
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[1][0].categoryColor).toEqual({
      useCategoryColor: 1,
    });
    draw();
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('a rebound palette texture is pushed alone; a model swap forces the full block', () => {
    const { layer, push, models, draw } = host({
      categoryPalette: [[1, 2, 3, 255]],
      useCategoryColor: true,
    });
    draw();
    const tex2 = { id: 'tex2' };
    layer.state.paletteTexture = tex2;
    draw();
    expect(push.mock.calls[1][0].categoryColor).toEqual({
      paletteTexture: tex2,
    });
    models[0] = {};
    draw();
    expect(push).toHaveBeenCalledTimes(3);
    expect(Object.keys(push.mock.calls[2][0].categoryColor).sort()).toEqual([
      'paletteSize',
      'paletteTexture',
      'useCategoryColor',
    ]);
  });
});

describe('appendNullCategorySlot memo', () => {
  it('returns the same array for the same palette + default, so the digest memo hits', () => {
    const palette = [
      [1, 2, 3, 255],
      [4, 5, 6, 255],
    ] as any;
    const a = appendNullCategorySlot(palette, [9, 9, 9, 255]);
    const b = appendNullCategorySlot(palette, [9, 9, 9, 255]);
    expect(b).toBe(a);
    expect(a).toHaveLength(3);
    expect(a[2]).toEqual([9, 9, 9, 255]);
    const digestSpy = vi.spyOn(JSON, 'stringify');
    colorListDigest(a);
    const calls = digestSpy.mock.calls.length;
    colorListDigest(b);
    expect(digestSpy.mock.calls.length).toBe(calls); // WeakMap hit, no re-serialise
    digestSpy.mockRestore();
  });

  it('keys the default slot by CONTENT, and a later in-place mutation cannot alias into the cache', () => {
    const palette = [[1, 2, 3, 255]] as any;
    const def = [9, 9, 9, 255] as any;
    const a = appendNullCategorySlot(palette, def);
    def[0] = 0;
    expect(a[1]).toEqual([9, 9, 9, 255]);
    const b = appendNullCategorySlot(palette, def);
    expect(b).not.toBe(a);
    expect(b[1]).toEqual([0, 9, 9, 255]);
    expect(appendNullCategorySlot(palette)).toHaveLength(2);
    expect(appendNullCategorySlot(palette)[1]).toEqual([0, 0, 0, 0]);
  });
});
