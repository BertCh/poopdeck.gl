/**
 * Shader-module-level regression tests for the extensions.
 *
 * The attribute-wiring suite asserts attribute NAMES only; it cannot catch
 * uniform-plumbing bugs. The big one this file guards: in luma.gl 9.3 a
 * shader module's `getUniforms` return value REPLACES the incoming props for
 * that `ShaderInputs.setProps` call (`@luma.gl/engine` shader-inputs.ts:
 * `module.getUniforms?.(moduleProps, oldUniforms) || moduleProps`). A
 * getUniforms that returns only the renamed texture binding silently drops
 * every scalar — the UBO stays zero-initialized and the GPU palette path is
 * dead code at runtime. We run the REAL luma ShaderInputs (no GPU needed)
 * against the real module, mimicking exactly what the extension's draw()
 * sends each frame.
 */

import { describe, it, expect, vi } from 'vitest';
import { ShaderInputs } from '@luma.gl/engine';
import {
  CategoryColorExtension,
  categoryColorUniforms,
} from '../src/extensions/category-color-extension';
import { TimeFilterExtension } from '../src/extensions/time-filter-extension';
import type { Color } from '@deck.gl/core';

function makeShaderInputs() {
  return new ShaderInputs<{ categoryColor: Record<string, unknown> }>(
    { categoryColor: categoryColorUniforms as any },
    // luma logs a warning per unknown module prop otherwise.
    { disableWarnings: true },
  );
}

describe('categoryColor shader module getUniforms (luma 9.3 replace semantics)', () => {
  it('flows the scalar uniforms through to the UBO values', () => {
    const shaderInputs = makeShaderInputs();
    const fakeTexture = { width: 4096, height: 1 };
    // Exactly the props CategoryColorExtension.draw() sets every frame.
    shaderInputs.setProps({
      categoryColor: {
        paletteSize: 7,
        useCategoryColor: 1.0,
        paletteTexture: fakeTexture,
      },
    });
    const values = shaderInputs.getUniformValues() as any;
    // The regression: these were dropped because getUniforms returned only
    // the texture binding, so `useCategoryColor > 0.5` never passed in GLSL.
    expect(values.categoryColor.useCategoryColor).toBe(1);
    expect(values.categoryColor.paletteSize).toBe(7);
  });

  it('renames paletteTexture to the GLSL sampler binding name', () => {
    const shaderInputs = makeShaderInputs();
    const fakeTexture = { width: 4096, height: 1 };
    shaderInputs.setProps({
      categoryColor: { paletteSize: 1, useCategoryColor: 1.0, paletteTexture: fakeTexture },
    });
    const bindings = shaderInputs.getBindingValues() as any;
    expect(bindings.categoryColor_paletteTexture).toBe(fakeTexture);
    // The unrenamed prop must NOT leak through as a (bogus) binding.
    expect(bindings.paletteTexture).toBeUndefined();
  });

  it('keeps previously-set scalars when a later setProps omits them', () => {
    // luma merges getUniforms output over the previous values, so partial
    // updates must not zero out the scalars.
    const shaderInputs = makeShaderInputs();
    shaderInputs.setProps({
      categoryColor: { paletteSize: 5, useCategoryColor: 1.0 },
    });
    shaderInputs.setProps({
      categoryColor: { paletteTexture: { width: 4096, height: 1 } },
    });
    const values = shaderInputs.getUniformValues() as any;
    expect(values.categoryColor.paletteSize).toBe(5);
    expect(values.categoryColor.useCategoryColor).toBe(1);
  });
});

describe('categoryColor palette sample alpha composition', () => {
  it('composes the palette color with the incoming temporal alpha', () => {
    // Extension order is [timeFilter, categoryColor]: the time filter writes
    // the fade/wake alpha into color.a BEFORE this inject runs. A palette
    // sample that replaces the whole vec4 silently destroys those fades on
    // every GPU-categorical layer — latent while the getUniforms bug kept
    // the branch dead, fatal the moment the scalars flow.
    const inject = (new CategoryColorExtension().getShaders as any).call(
      {},
      new CategoryColorExtension(),
    ).inject;
    const filterColor = inject['fs:DECKGL_FILTER_COLOR'] as string;
    expect(filterColor).toContain('color = vec4(palette.rgb, palette.a * color.a);');
    // The old replace-form must not come back.
    expect(filterColor).not.toMatch(/color\s*=\s*texture\(/);
  });
});

/**
 * Minimal fake luma device + deck layer: enough surface for the extension's
 * static-bound lifecycle methods (initializeState/updateState/finalizeState).
 */
function makeFakeDevice() {
  const created: Array<{ destroyed: boolean; writes: number }> = [];
  const device = {
    createTexture: vi.fn(() => {
      const tex = {
        destroyed: false,
        writes: 0,
        copyImageData(_opts: unknown) {
          this.writes++;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      created.push(tex);
      return tex;
    }),
  };
  return { device, created };
}

function makeFakeLayer(device: unknown, props: Record<string, unknown>) {
  return {
    props,
    state: {} as Record<string, unknown>,
    context: { device },
    setState(updates: Record<string, unknown>) {
      Object.assign(this.state, updates);
    },
    getAttributeManager: () => null,
  };
}

describe('CategoryColorExtension shared palette texture cache', () => {
  const PALETTE: Color[] = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ];

  function initLayer(device: unknown, props: Record<string, unknown>) {
    const ext = new CategoryColorExtension();
    const layer = makeFakeLayer(device, props);
    (ext.initializeState as any).call(layer, { device }, ext);
    return { ext, layer };
  }

  it('creates ONE texture per palette content, shared across layers', () => {
    const { device } = makeFakeDevice();
    const a = initLayer(device, { categoryPalette: PALETTE });
    const b = initLayer(device, { categoryPalette: PALETTE });
    expect(device.createTexture).toHaveBeenCalledTimes(1);
    expect(a.layer.state.paletteTexture).toBe(b.layer.state.paletteTexture);
  });

  it('does not rebind for a re-created but content-identical palette array', () => {
    const { device } = makeFakeDevice();
    const { ext, layer } = initLayer(device, { categoryPalette: PALETTE });
    const sameContent = PALETTE.map((c) => [...c] as Color);
    const oldProps = layer.props;
    layer.props = { categoryPalette: sameContent };
    (ext.updateState as any).call(
      layer,
      { props: layer.props, oldProps, context: { device } },
      ext,
    );
    expect(device.createTexture).toHaveBeenCalledTimes(1);
  });

  it('a palette content change binds a new texture and releases the old one', () => {
    const { device, created } = makeFakeDevice();
    const { ext, layer } = initLayer(device, { categoryPalette: PALETTE });
    const oldProps = layer.props;
    layer.props = { categoryPalette: [[0, 0, 255, 255]] as Color[] };
    (ext.updateState as any).call(
      layer,
      { props: layer.props, oldProps, context: { device } },
      ext,
    );
    expect(device.createTexture).toHaveBeenCalledTimes(2);
    expect(created[0].destroyed).toBe(true); // sole user moved off it
    expect(layer.state.paletteTexture).toBe(created[1]);
  });

  it('refcounts: the texture survives until the LAST layer finalizes', () => {
    const { device, created } = makeFakeDevice();
    const a = initLayer(device, { categoryPalette: PALETTE });
    const b = initLayer(device, { categoryPalette: PALETTE });
    (a.ext.finalizeState as any).call(a.layer, { device }, a.ext);
    expect(created[0].destroyed).toBe(false); // b still bound
    (b.ext.finalizeState as any).call(b.layer, { device }, b.ext);
    expect(created[0].destroyed).toBe(true);
  });

  it('a later layer with the destroyed palette content gets a fresh texture', () => {
    const { device, created } = makeFakeDevice();
    const a = initLayer(device, { categoryPalette: PALETTE });
    (a.ext.finalizeState as any).call(a.layer, { device }, a.ext);
    expect(created[0].destroyed).toBe(true);
    const b = initLayer(device, { categoryPalette: PALETTE });
    expect(device.createTexture).toHaveBeenCalledTimes(2);
    expect(b.layer.state.paletteTexture).toBe(created[1]);
  });
});

describe('TimeFilterExtension getShaders', () => {
  function getShaderObject(ext: TimeFilterExtension) {
    // getShaders only reads its `extension` arg (not `this`).
    return (ext.getShaders as any).call({}, ext);
  }

  it('returns a reference-stable object (one shader-cache entry per extension instance)', () => {
    const ext = new TimeFilterExtension();
    expect(getShaderObject(ext)).toBe(getShaderObject(ext));
  });

  it('collapses hidden features at the vertex stage, gated OFF in trail mode', () => {
    // Upstream DataFilterExtension parity: gl_Position = vec4(0.) for
    // filtered-out features so they rasterize zero fragments. Trail mode
    // fades per-VERTEX, so the collapse must be disabled there in-shader
    // (mode is a uniform, not a compile-time constant).
    const inject = getShaderObject(new TimeFilterExtension()).inject;
    const mainEnd = inject['vs:#main-end'] as string;
    expect(mainEnd).toContain('gl_Position = vec4(0.)');
    expect(mainEnd).toContain('vTimeAlpha <= 0.0');
    expect(mainEnd).toContain('timeFilter.trailLength <= 0.0');
  });

  it('declares the uniform blocks with explicit std140 layout', () => {
    const shaders = getShaderObject(new TimeFilterExtension());
    const moduleSrc = (shaders.modules as any[])[0].vs as string;
    expect(moduleSrc).toContain('layout(std140) uniform timeFilterUniforms');
    expect((categoryColorUniforms as any).fs).toContain(
      'layout(std140) uniform categoryColorUniforms',
    );
  });
});

describe('TimeFilterExtension constructor options', () => {
  it('passes options to super() so equals() distinguishes configurations', () => {
    // LayerExtension.equals compares this.opts; before the fix opts were
    // dropped and any two instances compared equal — deck would skip shader
    // regeneration once `mode` changes real behaviour.
    const a = new TimeFilterExtension({ mode: 'window' });
    const b = new TimeFilterExtension({ mode: 'trail' });
    const c = new TimeFilterExtension({ mode: 'window' });
    expect(a.equals(b)).toBe(false);
    expect(a.equals(c)).toBe(true);
    // Defaults applied: a bare instance is mode 'auto'.
    expect(new TimeFilterExtension().opts.mode).toBe('auto');
  });

  it('singleton identity short-circuit is unaffected', () => {
    const ext = new TimeFilterExtension({ mode: 'window' });
    expect(ext.equals(ext)).toBe(true);
  });
});
