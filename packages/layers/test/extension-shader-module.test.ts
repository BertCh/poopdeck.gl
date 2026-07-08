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
import {
  ChevronFlowExtension,
  chevronUniforms,
} from '../src/extensions/chevron-flow-extension';
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
      categoryColor: {
        paletteSize: 1,
        useCategoryColor: 1.0,
        paletteTexture: fakeTexture,
      },
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
    expect(filterColor).toContain(
      'color = vec4(palette.rgb, palette.a * color.a);',
    );
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

describe('ChevronFlowExtension', () => {
  function getShaderObject(ext: ChevronFlowExtension) {
    return (ext.getShaders as any).call({}, ext);
  }

  it('injects a marching chevron into DECKGL_FILTER_COLOR that MULTIPLIES alpha', () => {
    // Must compose with the matrix/time alpha the host layer already produced —
    // a `color.a *= …` (never a replace) keeps FlowCorridorLayer's per-vertex
    // magnitude coloring and any prior TimeFilter fade intact.
    const inject = getShaderObject(new ChevronFlowExtension()).inject;
    const filterColor = inject['fs:DECKGL_FILTER_COLOR'] as string;
    // Default (no directionColor / perTripLight): the plain arrowhead-alpha multiply.
    expect(filterColor).toContain(
      'color.a *= mix(chevron.baseAlpha, 1.0, chevronHead);',
    );
    expect(filterColor).toContain('geometry.uv.y'); // along-path distance
    expect(filterColor).toContain('chevron.phase');
    // It reads the along-path varying, not a per-vertex attribute — direction
    // comes from geometry winding.
    expect(filterColor).not.toMatch(/color\s*=\s*vec4\(/);
  });

  it('returns a reference-stable shader object (one cache entry per instance)', () => {
    const ext = new ChevronFlowExtension();
    expect(getShaderObject(ext)).toBe(getShaderObject(ext));
  });

  it('declares the uniform block with explicit std140 layout', () => {
    expect((chevronUniforms as any).fs).toContain(
      'layout(std140) uniform chevronUniforms',
    );
  });

  it('applies option defaults and flows them to opts (for equals()/digest)', () => {
    expect(new ChevronFlowExtension().opts).toMatchObject({
      period: 6,
      speed: 0.0006,
      skew: 1.4,
      duty: 0.5,
      feather: 0.28,
      baseAlpha: 0.15,
      uniformSpacing: false,
      directionColor: false,
      directionOffsetDegrees: 0,
      perTripLight: false,
      perTripFloor: 0.22,
    });
    const a = new ChevronFlowExtension({ period: 8 });
    const b = new ChevronFlowExtension({ period: 6 });
    expect(a.equals(b)).toBe(false);
    expect(a.equals(new ChevronFlowExtension({ period: 8 }))).toBe(true);
    // uniformSpacing is part of opts, so it must distinguish instances (the
    // sublayer cache keys on the digest → a toggle must regenerate the shader).
    expect(
      new ChevronFlowExtension({ uniformSpacing: true }).equals(
        new ChevronFlowExtension({ uniformSpacing: false }),
      ),
    ).toBe(false);
  });

  it('uniformSpacing fits a whole number of chevrons per segment via vPathLength', () => {
    // Off (default): raw per-segment period — byte-identical to the marching
    // demos, so this option leaves them untouched. No segment-length plumbing.
    const off = getShaderObject(new ChevronFlowExtension());
    expect(off.inject['fs:DECKGL_FILTER_COLOR']).not.toContain('chevronSegLen');
    expect(off.inject['fs:#main-start']).toBeUndefined();

    // On: snap the period so an integer count of chevrons spans the segment,
    // landing a chevron edge on both ends (no truncation at joints).
    const on = getShaderObject(
      new ChevronFlowExtension({ uniformSpacing: true }),
    );
    const hook = on.inject['fs:DECKGL_FILTER_COLOR'] as string;
    expect(hook).toContain('floor(chevronSegLen / chevronPeriod + 0.5)'); // round to whole
    // Still just modulates alpha — the fit changes spacing, not the compositing.
    expect(hook).toContain(
      'color.a *= mix(chevron.baseAlpha, 1.0, chevronHead);',
    );
    // vPathLength is only in scope in main(), NOT in the DECKGL_FILTER_COLOR hook
    // function — so it must be read in fs:#main-start and bridged via a global,
    // never referenced inside the hook (that was the shader-compile bug).
    expect(hook).not.toContain('vPathLength');
    expect(on.inject['fs:#decl']).toContain('float chevronSegLen;');
    expect(on.inject['fs:#main-start']).toContain(
      'chevronSegLen = vPathLength;',
    );
  });

  it('uniformSpacing + perBucketDirection both contribute to fs:#decl (not overwritten)', () => {
    // A Record holds one string per inject key; when both features are on, the
    // direction-sign varying and the segment-length global must BOTH survive.
    const both = getShaderObject(
      new ChevronFlowExtension({
        uniformSpacing: true,
        perBucketDirection: true,
      }),
    );
    expect(both.inject['fs:#decl']).toContain('in float vChevronDir;');
    expect(both.inject['fs:#decl']).toContain('float chevronSegLen;');
    expect(both.inject['vs:#main-start']).toContain(
      'vChevronDir = instanceVertexTime;',
    );
    expect(both.inject['fs:#main-start']).toContain(
      'chevronSegLen = vPathLength;',
    );
  });

  it('directionColor blends FOUR cardinal colors smoothly forward↔reverse by direction', () => {
    // Off (default): no bearing varying, no rgb rewrite — chevrons inherit the
    // host color exactly as before.
    const off = getShaderObject(new ChevronFlowExtension());
    expect(off.inject['fs:DECKGL_FILTER_COLOR']).not.toContain('vChevronEN');
    expect(off.inject['fs:DECKGL_FILTER_COLOR']).not.toContain('color.rgb =');

    const on = getShaderObject(
      new ChevronFlowExtension({
        directionColor: true,
        directionColors: [
          [255, 0, 0], // N red
          [0, 255, 0], // E green
          [0, 0, 255], // S blue
          [255, 255, 0], // W yellow
        ],
      }),
    );
    // Vertex: the segment (east, north) vector is derived from the endpoints.
    expect(on.inject['vs:#decl']).toContain('out vec2 vChevronEN;');
    expect(on.inject['vs:#main-start']).toContain('instanceStartPositions');
    expect(on.inject['fs:#decl']).toContain('in vec2 vChevronEN;');
    const hook = on.inject['fs:DECKGL_FILTER_COLOR'] as string;
    // Cyclic-4 bearing hue inlined TWICE — forward (vChevronEN) and reverse
    // (-vChevronEN) — then blended by the continuous direction. (No fs:#decl
    // function; the atan appears for both the forward and reverse heading.)
    expect(hook).toContain('atan((vChevronEN).x, (vChevronEN).y)');
    expect(hook).toContain('atan((-vChevronEN).x, (-vChevronEN).y)');
    expect(hook).toContain('vec3(1.00000, 0.00000, 0.00000)'); // N red
    expect(hook).toContain('vec3(0.00000, 1.00000, 0.00000)'); // E green
    expect(hook).toContain('vec3(0.00000, 0.00000, 1.00000)'); // S blue
    expect(hook).toContain('vec3(1.00000, 1.00000, 0.00000)'); // W yellow
    // Smooth forward↔reverse blend by (dir+1)/2 → glides through neutral at dir=0.
    expect(hook).toContain(
      'vec3 arrowHue = mix(chevronHueRev, chevronHueFwd, (chevronDir + 1.0) * 0.5);',
    );
    expect(hook).toContain(
      'color.rgb = mix(color.rgb, arrowHue, chevronHead);',
    );
  });

  it('continuous signed direction morphs the arrow via signed skew (arrow→flat→arrow)', () => {
    const on = getShaderObject(
      new ChevronFlowExtension({ perBucketDirection: true }),
    );
    const hook = on.inject['fs:DECKGL_FILTER_COLOR'] as string;
    // Direction is a continuous clamped value, NOT a hard ±1.
    expect(hook).toContain('float chevronDir = clamp(vChevronDir, -1.0, 1.0);');
    // Signed skew (no along-flip) = the arrow→flat→arrow morph; march by sign(dir).
    expect(hook).toContain('float chevronAlong = geometry.uv.y;');
    expect(hook).toContain('abs(chevronAcross) * chevron.skew * chevronDir');
    expect(hook).toContain('chevron.phase * sign(chevronDir)');
    expect(hook).not.toContain('geometry.uv.y * chevronDir'); // no along-flip
  });

  it('directionColors defaults use a shared array reference (no equals() thrash)', () => {
    // deck's LayerExtension.equals compares opts arrays by reference; a fresh
    // default palette per construction would look "changed" every render.
    const a = new ChevronFlowExtension({ directionColor: true });
    const b = new ChevronFlowExtension({ directionColor: true });
    expect(a.opts.directionColors).toBe(b.opts.directionColors);
    expect(a.equals(b)).toBe(true);
  });

  it('perTripLight combines aggregate RGB + instant alpha with the cardinal hue', () => {
    // Off (default): plain host-alpha multiply, no two-signal combine.
    const off = getShaderObject(new ChevronFlowExtension());
    expect(off.inject['fs:DECKGL_FILTER_COLOR']).not.toContain(
      'chevronInstant',
    );
    expect(off.inject['fs:DECKGL_FILTER_COLOR']).toContain(
      'color.a *= mix(chevron.baseAlpha, 1.0, chevronHead);',
    );

    const on = getShaderObject(
      new ChevronFlowExtension({
        perTripLight: true,
        perTripFloor: 0.2,
        directionColor: true,
        perBucketDirection: true,
      }),
    );
    const hook = on.inject['fs:DECKGL_FILTER_COLOR'] as string;
    // INSTANT = the packed alpha; AGGREGATE luminance = the packed rgb.
    expect(hook).toContain('float chevronInstant = color.a;');
    expect(hook).toContain('dot(color.rgb, vec3(0.299, 0.587, 0.114))');
    // OPACITY recedes to the floor between trips and pops to full as one passes…
    expect(hook).toContain(
      'float chevronArrowAlpha = mix(0.2000, 1.0, chevronInstant);',
    );
    // …the hue is applied at FULL saturation (recession is carried by ALPHA only,
    // NOT by dimming the hue), and the track keeps the faint aggregate.
    expect(hook).toContain(
      'color.rgb = mix(color.rgb, arrowHue, chevronHead);',
    );
    expect(hook).toContain(
      'color.a = mix(chevronTrackAlpha, chevronArrowAlpha, chevronHead);',
    );
    expect(hook).not.toContain('arrowHue * chevronArrowBright'); // no brightness-multiply
    // No synthetic-highlight leftovers.
    expect(hook).not.toContain('highlightPhase');
    expect(hook).not.toContain('vChevronCumDist');
  });

  it('draw() reduces the play-head into a phase in [0, period)', () => {
    const ext = new ChevronFlowExtension({ period: 6, speed: 0.0006 });
    let captured: any = null;
    const fakeLayer = {
      props: { getTime: () => 1_722_470_400_000 }, // epoch-ms play-head
      setShaderModuleProps: (p: any) => {
        captured = p;
      },
    };
    (ext.draw as any).call(fakeLayer, null, ext);
    expect(captured).toBeTruthy();
    expect(captured.chevron.period).toBe(6);
    // The epoch-ms play-head would destroy f32 precision if passed raw; the
    // CPU-side modulo keeps it small and bounded.
    expect(captured.chevron.phase).toBeGreaterThanOrEqual(0);
    expect(captured.chevron.phase).toBeLessThan(6);
    expect(Number.isFinite(captured.chevron.phase)).toBe(true);
  });

  it('shader-module scalars flow through luma ShaderInputs (UBO not dropped)', () => {
    const shaderInputs = new ShaderInputs<{ chevron: Record<string, unknown> }>(
      { chevron: chevronUniforms as any },
      { disableWarnings: true },
    );
    shaderInputs.setProps({
      chevron: {
        phase: 2.5,
        period: 6,
        skew: 1.4,
        duty: 0.5,
        feather: 0.28,
        baseAlpha: 0.15,
      },
    });
    const values = shaderInputs.getUniformValues() as any;
    expect(values.chevron.phase).toBeCloseTo(2.5);
    expect(values.chevron.period).toBe(6);
    expect(values.chevron.baseAlpha).toBeCloseTo(0.15);
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
