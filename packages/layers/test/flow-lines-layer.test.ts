/**
 * FlowLinesLayer — tapered half-arrow primitive (flowmap.gl port).
 *
 * The geometry/shaders need a GPU device, so these tests cover the device-free
 * surface: the 9-vertex arrow template, the instanced-attribute wiring
 * (`initializeState`), and the default props. The deck.gl/luma imports are
 * mocked so the module loads without a real device.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@deck.gl/core', () => ({
  // FlowLinesLayer extends Layer; the test instances are built via
  // Object.create so the base ctor never runs.
  Layer: class {},
  project32: {},
  picking: {},
}));

vi.mock('@luma.gl/engine', () => ({
  Model: class {},
  Geometry: class {},
}));

import {
  FlowLinesLayer,
  ARROW_TEMPLATE_POSITIONS,
} from '../src/layers/internal/flow-lines-layer';

describe('FlowLinesLayer', () => {
  it('arrow template is 9 vertices (3 triangles) of (mix, perp, travel)', () => {
    expect(ARROW_TEMPLATE_POSITIONS.length).toBe(27); // 9 verts × 3 components
    // The .x (mix) of every vertex is 0 (source) or 1 (target).
    for (let v = 0; v < 9; v++) {
      const mix = ARROW_TEMPLATE_POSITIONS[v * 3];
      expect(mix === 0 || mix === 1).toBe(true);
    }
    // Half-arrow: every perpendicular offset is on one side (≥ 0).
    for (let v = 0; v < 9; v++) {
      expect(ARROW_TEMPLATE_POSITIONS[v * 3 + 1]).toBeGreaterThanOrEqual(0);
    }
    // The arrowhead flares to perp 2 and is pulled back along travel (−3).
    const maxPerp = Math.max(
      ...Array.from(
        { length: 9 },
        (_, v) => ARROW_TEMPLATE_POSITIONS[v * 3 + 1],
      ),
    );
    const minTravel = Math.min(
      ...Array.from(
        { length: 9 },
        (_, v) => ARROW_TEMPLATE_POSITIONS[v * 3 + 2],
      ),
    );
    expect(maxPerp).toBe(2);
    expect(minTravel).toBe(-3);
  });

  it('registers the instanced attributes (positions, width, endpoint offsets)', () => {
    const added: Record<string, any> = {};
    const fakeAM = {
      addInstanced: (attrs: Record<string, any>) => Object.assign(added, attrs),
    };
    const layer = Object.create(FlowLinesLayer.prototype);
    layer.getAttributeManager = () => fakeAM;
    layer.use64bitPositions = () => false;
    layer.initializeState();

    expect(added.instanceSourcePositions.accessor).toBe('getSourcePosition');
    expect(added.instanceTargetPositions.accessor).toBe('getTargetPosition');
    expect(added.instanceSourcePositions.size).toBe(3);
    // Width is a single per-instance pixel value.
    expect(added.instanceWidth.accessor).toBe('getWidth');
    expect(added.instanceWidth.size).toBe(1);
    // Endpoint insets are a vec2 [sourceInset, targetInset].
    expect(added.instanceEndpointOffsets.accessor).toBe('getEndpointOffsets');
    expect(added.instanceEndpointOffsets.size).toBe(2);
  });

  it('defaults: gap 0.5, endpoint offsets [0,0], colors present', () => {
    const dp = FlowLinesLayer.defaultProps as any;
    expect(dp.gap.value).toBe(0.5);
    expect(dp.getEndpointOffsets.value).toEqual([0, 0]);
    expect(dp.sourceColor.value).toHaveLength(4);
    expect(dp.targetColor.value).toHaveLength(4);
    expect(FlowLinesLayer.layerName).toBe('FlowLinesLayer');
  });
});
