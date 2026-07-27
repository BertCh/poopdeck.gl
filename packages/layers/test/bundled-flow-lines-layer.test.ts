/**
 * BundledFlowLinesLayer — GPU-resident bundled-ribbon primitive.
 *
 * Everything this layer does at draw time needs a device, so these tests cover
 * the device-free surface: the ribbon template, the instanced-attribute wiring,
 * the uniforms `draw()` publishes from the live playhead, and — since GLSL has
 * no runtime under vitest — the load-bearing shape of the vertex shader (the
 * picking-color encoding and the zero-flow width collapse).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@deck.gl/core', () => ({
  Layer: class {
    getShaders(opts: any) {
      return opts;
    }
  },
  project32: { name: 'project32' },
  picking: { name: 'picking' },
}));

vi.mock('@luma.gl/engine', () => ({
  Model: class {},
  Geometry: class {},
}));

import {
  BundledFlowLinesLayer,
  RIBBON_TEMPLATE_POSITIONS,
} from '../src/layers/internal/bundled-flow-lines-layer';

function vertexShader(): string {
  const layer = Object.create(BundledFlowLinesLayer.prototype);
  return layer.getShaders().vs as string;
}

describe('BundledFlowLinesLayer', () => {
  it('ribbon template is two triangles of (mix, side)', () => {
    expect(RIBBON_TEMPLATE_POSITIONS.length).toBe(12); // 6 verts × 2 components
    for (let v = 0; v < 6; v++) {
      const mix = RIBBON_TEMPLATE_POSITIONS[v * 2];
      const side = RIBBON_TEMPLATE_POSITIONS[v * 2 + 1];
      expect(mix === 0 || mix === 1).toBe(true);
      expect(side === 0 || side === 1).toBe(true);
    }
  });

  it('registers the two driving instanced attributes', () => {
    const added: Record<string, any> = {};
    const layer = Object.create(BundledFlowLinesLayer.prototype);
    layer.getAttributeManager = () => ({
      addInstanced: (attrs: Record<string, any>) => Object.assign(added, attrs),
    });
    layer.initializeState();
    expect(added.instanceEdgeIndex.accessor).toBe('getEdgeIndex');
    expect(added.instanceSegmentIndex.accessor).toBe('getSegmentIndex');
  });

  describe('picking', () => {
    it('encodes the pick color in BYTES — picking_setPickingColor normalizes', () => {
      // deck's picking module runs with `useByteColors: true`, so
      // picking_setPickingColor already divides by 255 (as it does for the
      // instancePickingColors attribute deck's own layers feed it). Dividing
      // here too wrote ~1.5e-5 for edge 0 into the 8-bit picking FBO — which
      // quantizes to [0,0,0], i.e. "nothing picked" — and sat right on
      // picking_isColorValid's 1e-5 threshold, with autoHighlight off by 255×.
      const vs = vertexShader();
      const encode = vs.slice(
        vs.indexOf('vec3 encodePick(int index)'),
        vs.indexOf('void main(void)'),
      );
      expect(encode).toMatch(/mod\(i, 256\.0\)/);
      expect(encode).not.toMatch(/\/\s*255\.0/);
    });

    it('feeds the EDGE index (not the segment) so info.index decodes a corridor', () => {
      expect(vertexShader()).toMatch(
        /picking_setPickingColor\(encodePick\(edge\)\)/,
      );
    });
  });

  it('collapses zero-flow edges to width 0 BEFORE the widthMinPixels clamp', () => {
    // The reference behaviour FlowLinesLayer now mirrors.
    const vs = vertexShader();
    expect(vs).toMatch(/if \(flow <= bundled\.minFlow\) return 0\.0;/);
  });

  it('samples the live playhead into a continuous bucket position', () => {
    const capture: any[] = [];
    const layer = Object.create(BundledFlowLinesLayer.prototype);
    layer.props = {
      bundler: { cosLat0: 0.5, originX: 1, originY: 2, scale: 4 },
      matrixTexture: {},
      segments: 23,
      numBuckets: 3,
      bucket0Abs: 0,
      bucketWidth: 1000,
      getCurrentTime: () => 1500,
      sourceColor: [0, 0, 0, 255],
      targetColor: [255, 255, 255, 255],
      widthScale: 1.1,
      minFlow: 0.25,
      widthMinPixels: 1,
      widthMaxPixels: 12,
      gap: 0.5,
    };
    layer.context = { renderPass: {} };
    layer.state = {
      model: {
        shaderInputs: { setProps: (p: any) => capture.push(p) },
        setBindings: () => {},
        draw: () => {},
      },
    };
    layer.draw();
    const u = capture[0].bundled;
    expect(u.bucketPos).toBeCloseTo(1.5); // no sub-step quantization
    expect(u.invScale).toBeCloseTo(0.25);
    expect(u.cosLat0).toBe(0.5);
  });

  it('documents that the compare:false clock closure never invalidates', () => {
    // Intentional (a fresh per-frame closure must not read as a prop change),
    // but the consequence — swapping the clock SOURCE is invisible to deck's
    // diff — has to stay written down next to the descriptor.
    const dp = BundledFlowLinesLayer.defaultProps as any;
    expect(dp.getCurrentTime.compare).toBe(false);
    expect(typeof dp.getCurrentTime.value).toBe('function');
  });
});
