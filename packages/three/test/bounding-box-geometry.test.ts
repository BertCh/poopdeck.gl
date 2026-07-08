// Regression: the BoundingBoxLayer's edge + velocity LineSegments must ALWAYS
// carry a `position` attribute — even before any box is active. The WebGPU/TSL
// backend builds a material's vertex-attribute nodes the first time the object
// renders, and a geometry with no `position` makes that build throw, aborting
// the whole frame (the AV cockpit's blank TSL viewport). WebGL tolerated it.
import { describe, it, expect } from 'vitest';
import { LineSegments } from 'three';
import { BoundingBoxLayer } from '../src/layers/bounding-box-layer';

function hasPosition(obj: unknown): boolean {
  return (
    obj instanceof LineSegments &&
    obj.geometry.getAttribute('position') !== undefined
  );
}

describe('BoundingBoxLayer geometry seeding', () => {
  it('seeds a position attribute on the edges geometry at construction (0 active boxes)', () => {
    const layer = new BoundingBoxLayer({ id: 'objects' });
    const edges = layer.object.children.find((c) => c instanceof LineSegments);
    expect(edges).toBeDefined();
    expect(hasPosition(edges)).toBe(true);
  });

  it('seeds a position attribute on the velocity geometry too when showVelocity', () => {
    const layer = new BoundingBoxLayer({ id: 'objects', showVelocity: true });
    const lines = layer.object.children.filter(
      (c) => c instanceof LineSegments,
    );
    // edges + velocity
    expect(lines.length).toBe(2);
    for (const l of lines) expect(hasPosition(l)).toBe(true);
  });

  it('seeded geometry draws nothing (drawRange 0, hidden) until boxes arrive', () => {
    const layer = new BoundingBoxLayer({ id: 'objects', showVelocity: true });
    for (const l of layer.object.children) {
      if (l instanceof LineSegments) {
        expect(l.geometry.drawRange.count).toBe(0);
        // hidden so the WebGPU backend issues no 0-vertex draw call
        expect(l.visible).toBe(false);
      }
    }
  });
});
