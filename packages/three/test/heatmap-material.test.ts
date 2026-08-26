// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Node-graph gate for the heatmap's two TSL passes.
 *
 * There is no WebGPU device in CI (`vitest.config.ts`), so the render-target
 * ping-pong itself is browser-verified. What IS checkable headlessly is the
 * SHAPE of the shipped graphs — a TSL graph is plain-old-data, introspectable
 * by walking `aNode`/`bNode`/`nodes`/`node` — and the shape is where this kind's
 * correctness lives:
 *
 *  1. **The ramp is applied per PIXEL, not per splat.** The splat material must
 *     carry NO colour ramp and NO colour-space conversion (it writes a density,
 *     a physical quantity); the ramp material must carry both, plus the density
 *     texture sample. A single-pass heatmap that samples the palette per point
 *     and additively blends the resulting COLOURS sums colours, not density, and
 *     blows out to white wherever anything overlaps.
 *  2. **The accumulation really is additive**, unoccluded, and its opacity is a
 *     hard `1` — `AdditiveBlending` multiplies the source by `srcAlpha`, so any
 *     softer alpha would silently attenuate the deposited density a second time.
 *  3. **The time gate is wired into the splat's VERTEX stage**, so an
 *     out-of-window point collapses to a zero-extent primitive and contributes
 *     exactly zero density.
 *  4. Both materials build, in every time-filter mode and both kernels.
 */

import { describe, it, expect } from 'vitest';
import { Texture, AdditiveBlending, NormalBlending, DoubleSide } from 'three';
import {
  createHeatmapMaterial,
  createHeatmapSplatMaterial,
  createHeatmapRampMaterial,
  updateHeatmapUniforms,
  HeatmapRampUniforms,
  HeatmapSplatUniforms,
  HEATMAP_ATTR,
  DEFAULT_SPLAT_FALLOFF,
  type HeatmapKernel,
} from '../src/tsl/heatmap-material';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import type { TimeFilterMode } from '../src/tsl/time-filter-math';
import { DEFAULT_HEATMAP_COLOR_RANGE } from '@poopdeck.gl/core';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MODES: TimeFilterMode[] = [
  'none',
  'window',
  'wake',
  'cumulative',
  'trail',
];
const KERNELS: HeatmapKernel[] = ['gaussian', 'epanechnikov'];

/**
 * Every `isNode` reachable from `root`. Walks own object/array properties (the
 * `aNode`/`bNode`/`cNode`/`condNode`/`nodes`/`node` links are plain fields),
 * skipping `parents` — three back-links nodes during a build and following
 * those would walk the whole graph upward.
 */
function nodesOf(root: unknown): any[] {
  const seen = new Set<unknown>();
  const found: any[] = [];
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (n.isNode === true) found.push(n);
    for (const key of Object.keys(n)) {
      if (key === 'parents') continue;
      const value = n[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(root);
  return found;
}

const classNames = (root: unknown): Set<string> =>
  new Set(nodesOf(root).map((n) => n.constructor.name));

/** Attribute names a graph reads (`AttributeNode._attributeName`). */
const attributeNames = (root: unknown): Set<string> =>
  new Set(
    nodesOf(root)
      .filter((n) => n.constructor.name === 'AttributeNode')
      .map((n) => n._attributeName as string),
  );

/** Whether a specific uniform node instance is wired into a graph. */
const reads = (root: unknown, uniformNode: unknown): boolean =>
  nodesOf(root).includes(uniformNode);

const splatOf = (mode: TimeFilterMode = 'window', kernel?: HeatmapKernel) =>
  createHeatmapSplatMaterial({ mode, kernel });
const rampOf = (colorRange?: any) =>
  createHeatmapRampMaterial({ densityTexture: new Texture(), colorRange });

describe('heatmap materials — both passes build', () => {
  for (const mode of MODES) {
    for (const kernel of KERNELS) {
      it(`splat + ramp build (mode: ${mode}, kernel: ${kernel})`, () => {
        const bundle = createHeatmapMaterial({
          mode,
          kernel,
          densityTexture: new Texture(),
        });
        expect(bundle.splat.material.vertexNode).toBeTruthy();
        expect(bundle.splat.material.colorNode).toBeTruthy();
        expect(bundle.splat.material.opacityNode).toBeTruthy();
        expect(bundle.ramp.material.vertexNode).toBeTruthy();
        expect(bundle.ramp.material.colorNode).toBeTruthy();
        expect(bundle.ramp.material.opacityNode).toBeTruthy();
        expect(bundle.splat.time).toBeInstanceOf(TimeFilterUniforms);
        expect(bundle.splat.splat).toBeInstanceOf(HeatmapSplatUniforms);
        expect(bundle.ramp.ramp).toBeInstanceOf(HeatmapRampUniforms);
        expect(bundle.splat.mode).toBe(mode);
        expect(bundle.splat.kernel).toBe(kernel);
      });
    }
  }

  it('defaults to the window kernel and the gaussian splat', () => {
    const bundle = createHeatmapMaterial({ densityTexture: new Texture() });
    expect(bundle.splat.mode).toBe('window');
    expect(bundle.splat.kernel).toBe('gaussian');
  });
});

describe('splat pass — additive accumulation, never a colour', () => {
  it('blends additively, unoccluded', () => {
    const { material } = splatOf();
    expect(material.blending).toBe(AdditiveBlending);
    expect(material.transparent).toBe(true);
    // Accumulation is order-independent: a splat must never depth-reject or
    // occlude another splat.
    expect(material.depthWrite).toBe(false);
    expect(material.depthTest).toBe(false);
    expect(material.side).toBe(DoubleSide);
  });

  it('writes a HARD opacity of 1 (AdditiveBlending scales by srcAlpha)', () => {
    const { material } = splatOf();
    const nodes = nodesOf(material.opacityNode);
    const constants = nodes.filter((n) => n.isConstNode === true);
    expect(constants.length).toBeGreaterThan(0);
    expect(constants.every((n) => n.value === 1)).toBe(true);
    // Nothing live may modulate it — no uniform, attribute or varying.
    expect(nodes.some((n) => n.isUniformNode === true)).toBe(false);
    expect(attributeNames(material.opacityNode).size).toBe(0);
  });

  it('never colour-space converts the density it accumulates', () => {
    // srgbToWorking is for COLOUR. The splat writes Σ kernel·weight into a
    // float target the ramp pass reads back verbatim; decoding it as sRGB would
    // bend the density curve before anything had been summed.
    for (const mode of MODES) {
      const { material } = splatOf(mode);
      expect(classNames(material.colorNode).has('ColorSpaceNode')).toBe(false);
    }
  });

  it('carries no colour ramp — the palette is a per-PIXEL concern', () => {
    // The whole two-pass design: if a ramp stop ever reached the splat graph,
    // overlapping points would sum COLOURS and blow out to white.
    const { material } = splatOf();
    const ramp = rampOf();
    const stopChannel = DEFAULT_HEATMAP_COLOR_RANGE[3][0] / 255;
    const constValues = (root: unknown) =>
      nodesOf(root)
        .filter((n) => n.isConstNode === true)
        .map((n) => n.value as number);
    expect(constValues(ramp.material.colorNode)).toContain(stopChannel);
    expect(constValues(material.colorNode)).not.toContain(stopChannel);
  });

  it('reads the merged splat attributes under their shipped names', () => {
    const { material } = splatOf();
    // Position + times gate the quad in the vertex stage…
    const vertexAttrs = attributeNames(material.vertexNode);
    expect(vertexAttrs.has(HEATMAP_ATTR.center)).toBe(true);
    expect(vertexAttrs.has(HEATMAP_ATTR.start)).toBe(true);
    expect(vertexAttrs.has(HEATMAP_ATTR.end)).toBe(true);
    // …and the weight scales the kernel in the fragment stage.
    expect(attributeNames(material.colorNode).has(HEATMAP_ATTR.weight)).toBe(
      true,
    );
  });
});

describe('splat pass — the time gate', () => {
  for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
    it(`gates the VERTEX stage on the playhead (mode: ${mode})`, () => {
      // The hard collapse multiplies the quad's half-size, so an out-of-window
      // point is a zero-extent primitive and deposits no density at all
      // (deck.gl #7509 — never a fragment discard).
      const bundle = splatOf(mode);
      expect(reads(bundle.material.vertexNode, bundle.time.currentTime)).toBe(
        true,
      );
      // …and the soft fade rides the accumulated weight in the fragment stage.
      expect(reads(bundle.material.colorNode, bundle.time.currentTime)).toBe(
        true,
      );
    });
  }

  it('wires NO time uniform at all in mode "none"', () => {
    const bundle = splatOf('none');
    expect(reads(bundle.material.vertexNode, bundle.time.currentTime)).toBe(
      false,
    );
    expect(reads(bundle.material.colorNode, bundle.time.currentTime)).toBe(
      false,
    );
  });

  it('varies the RAW start/end rather than the select()-based alpha', () => {
    // Wrapping a select() in a varying() is the package's recurring WGSL build
    // crash; the alpha is recomputed in the fragment stage from varied scalars.
    const { material } = splatOf('window');
    const varyings = nodesOf(material.colorNode).filter(
      (n) => n.constructor.name === 'VaryingNode',
    );
    expect(varyings.length).toBeGreaterThan(0);
    for (const v of varyings) {
      expect(classNames(v.node).has('ConditionalNode')).toBe(false);
    }
  });

  it('sizes the splat in PIXELS against the viewport uniform', () => {
    // Density is a screen quantity: a metric radius would dissolve the heatmap
    // on zoom-out instead of holding a constant kernel width.
    const bundle = splatOf();
    expect(reads(bundle.material.vertexNode, bundle.splat.viewport)).toBe(true);
    expect(reads(bundle.material.vertexNode, bundle.splat.radiusPixels)).toBe(
      true,
    );
  });
});

describe('ramp pass — one reduce, one ramp, per pixel', () => {
  it('samples the density texture in SCREEN space and converts colour last', () => {
    const bundle = rampOf();
    const names = classNames(bundle.material.colorNode);
    expect(names.has('TextureNode')).toBe(true); // the accumulated field
    expect(names.has('ScreenNode')).toBe(true); // screenUV
    expect(names.has('ColorSpaceNode')).toBe(true); // srgbToWorking, last
    // The composite owns no depth and must not occlude the scene under it.
    expect(bundle.material.transparent).toBe(true);
    expect(bundle.material.blending).toBe(NormalBlending);
    expect(bundle.material.depthWrite).toBe(false);
    expect(bundle.material.depthTest).toBe(false);
  });

  it('reads domain + threshold + opacity uniforms', () => {
    const bundle = rampOf();
    expect(reads(bundle.material.colorNode, bundle.ramp.domainMin)).toBe(true);
    expect(reads(bundle.material.colorNode, bundle.ramp.domainMax)).toBe(true);
    expect(reads(bundle.material.opacityNode, bundle.ramp.threshold)).toBe(
      true,
    );
    expect(reads(bundle.material.opacityNode, bundle.ramp.opacity)).toBe(true);
  });

  it('draws in clip space, so the pass is camera-independent', () => {
    const bundle = rampOf();
    // The quad's own corners ARE the clip position — no model/view/projection
    // node in the graph at all.
    const names = classNames(bundle.material.vertexNode);
    expect(names.has('ModelViewMatrixNode')).toBe(false);
    expect(attributeNames(bundle.material.vertexNode).has('position')).toBe(
      true,
    );
  });

  it('bakes the colour ramp: default OrRd, a custom range, and a single stop', () => {
    expect(rampOf().stops).toBe(DEFAULT_HEATMAP_COLOR_RANGE.length);
    expect(
      rampOf([
        [0, 0, 0, 255],
        [255, 255, 255, 255],
      ]).stops,
    ).toBe(2);
    // A degenerate one-stop ramp is a flat colour, not a divide-by-zero.
    const single = rampOf([[10, 20, 30, 255]]);
    expect(single.stops).toBe(1);
    expect(single.material.colorNode).toBeTruthy();
    // An empty range falls back to the shared default rather than rendering black.
    expect(rampOf([]).stops).toBe(DEFAULT_HEATMAP_COLOR_RANGE.length);
  });
});

describe('updateHeatmapUniforms — a per-frame PUSH, never a rebuild', () => {
  it('fans one values object out to both passes', () => {
    const bundle = createHeatmapMaterial({ densityTexture: new Texture() });
    const before = bundle.splat.material;
    updateHeatmapUniforms(bundle, {
      relativeCurrentTime: 4200,
      params: { windowHalf: 900, fadeIn: 100, fadeOut: 50 },
      radiusPixels: 44,
      intensity: 2.5,
      splatFalloff: 9,
      viewport: [800, 600],
      colorDomain: [2, 12],
      threshold: 0.2,
      opacity: 0.75,
    });
    expect(bundle.splat.time.currentTime.value).toBe(4200);
    expect(bundle.splat.time.windowHalf.value).toBe(900);
    expect(bundle.splat.time.fadeIn.value).toBe(100);
    expect(bundle.splat.splat.radiusPixels.value).toBe(44);
    expect(bundle.splat.splat.intensity.value).toBe(2.5);
    expect(bundle.splat.splat.splatFalloff.value).toBe(9);
    expect(bundle.splat.splat.viewport.value.x).toBe(800);
    expect(bundle.splat.splat.viewport.value.y).toBe(600);
    expect(bundle.ramp.ramp.domainMin.value).toBe(2);
    expect(bundle.ramp.ramp.domainMax.value).toBe(12);
    expect(bundle.ramp.ramp.threshold.value).toBe(0.2);
    expect(bundle.ramp.ramp.opacity.value).toBe(0.75);
    // Materials are never rebuilt by an update (three's nodeBuilderCache entry,
    // program and pipeline all survive).
    expect(bundle.splat.material).toBe(before);
  });

  it('restores the documented defaults for omitted values', () => {
    const bundle = createHeatmapMaterial({ densityTexture: new Texture() });
    updateHeatmapUniforms(bundle, { relativeCurrentTime: 0 });
    expect(bundle.splat.splat.radiusPixels.value).toBe(30);
    expect(bundle.splat.splat.intensity.value).toBe(1);
    expect(bundle.splat.splat.splatFalloff.value).toBe(DEFAULT_SPLAT_FALLOFF);
    expect(bundle.ramp.ramp.domainMin.value).toBe(0);
    expect(bundle.ramp.ramp.domainMax.value).toBe(1);
    expect(bundle.ramp.ramp.threshold.value).toBe(0.05);
    expect(bundle.ramp.ramp.opacity.value).toBe(1);
  });

  it('leaves the viewport alone when the host has not pushed one', () => {
    const bundle = createHeatmapMaterial({ densityTexture: new Texture() });
    bundle.splat.splat.viewport.value.set(1920, 1080);
    updateHeatmapUniforms(bundle, { relativeCurrentTime: 0 });
    expect(bundle.splat.splat.viewport.value.x).toBe(1920);
  });
});
