/**
 * SplatPrimitiveLayer GPU-state declaration.
 *
 * Surface splatting is sort-free ONLY because the disks are drawn depth-tested
 * with depth-write on and an alpha cutoff — the z-buffer does the occlusion
 * that volumetric 3DGS pays a per-frame back-to-front sort for.
 *
 * That state has to live in `defaultProps.parameters`, not in the `Model`
 * constructor: deck calls `applyModelParameters(this.getModels(), …,
 * layer.props.parameters)` before EVERY draw (`layer.ts`), and luma's
 * `Model.setParameters` REPLACES `model.parameters` wholesale — so a
 * constructor-time block is gone after frame 1. It only looked correct because
 * deck's WebGL global defaults happen to match; the contract breaks the moment
 * a caller sets `_subLayerProps.splats.parameters`, deck's defaults shift, or
 * the device is WebGPU.
 *
 * The shaders need a real device, so the deck/luma imports are mocked exactly
 * as in flow-lines-layer.test.ts — this asserts the device-free declaration.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@deck.gl/core', () => ({
  // The layer only extends Layer; nothing here constructs one.
  Layer: class {},
  project32: {},
  picking: {},
}));

vi.mock('@luma.gl/engine', () => {
  class FakeModel {
    static constructed: any[] = [];
    constructor(_device: unknown, props: any) {
      FakeModel.constructed.push(props);
    }
  }
  return { Model: FakeModel, Geometry: class {} };
});

import {
  SplatPrimitiveLayer,
  SPLAT_DRAW_PARAMETERS,
} from '../src/layers/internal/splat-primitive-layer';

describe('SplatPrimitiveLayer draw parameters', () => {
  it('declares depth-write + src-over blend + two-sided disks', () => {
    expect(SPLAT_DRAW_PARAMETERS).toMatchObject({
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
      cullMode: 'none',
      blend: true,
      blendColorOperation: 'add',
      blendColorSrcFactor: 'src-alpha',
      blendColorDstFactor: 'one-minus-src-alpha',
      blendAlphaOperation: 'add',
      blendAlphaSrcFactor: 'one',
      blendAlphaDstFactor: 'one-minus-src-alpha',
    });
  });

  it('publishes them as the `parameters` prop default (so every draw re-applies them)', () => {
    const declared = (SplatPrimitiveLayer as any).defaultProps.parameters;
    expect(declared).toBeDefined();
    expect(declared.value).toEqual(SPLAT_DRAW_PARAMETERS);
    // Deep-compare like deck's own `parameters` descriptor, so an
    // equal-valued object from a caller does not churn the pipeline.
    expect(declared.compare).toBe(2);
    // A distinct object from the exported const: deck may not mutate the
    // shared source of truth.
    expect(declared.value).not.toBe(SPLAT_DRAW_PARAMETERS);
  });

  it('does not re-declare them in the Model constructor (deck would wipe them anyway)', async () => {
    const { Model } = (await import('@luma.gl/engine')) as unknown as {
      Model: { constructed: any[] };
    };
    Model.constructed.length = 0;

    const layer: any = Object.create(SplatPrimitiveLayer.prototype);
    layer.props = { id: 'splat' };
    layer.context = { device: {} };
    layer.getAttributeManager = () => ({ getBufferLayouts: () => [] });
    layer.getShaders = () => ({});
    layer._getModel();

    expect(Model.constructed).toHaveLength(1);
    const modelProps = Model.constructed[0];
    expect(modelProps.isInstanced).toBe(true);
    // A constructor-time value would survive exactly one frame.
    expect(modelProps.parameters).toBeUndefined();
  });
});
