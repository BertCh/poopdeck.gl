// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { rayObbHit, pickBoxes, type PickBox, type Vec3 } from '../src/lib/box-pick';

const box = (over: Partial<PickBox> = {}): PickBox => ({
  center: [0, 0, 0],
  heading: 0,
  halfExtents: [1, 1, 1],
  meta: { layerId: 'test', kind: 'object', category: 'car', trackId: 'a' },
  ...over,
});

describe('rayObbHit', () => {
  it('hits an axis-aligned box from above and returns the entry distance', () => {
    const t = rayObbHit([0, 0, 10], [0, 0, -1], box());
    expect(t).not.toBeNull();
    expect(t).toBeCloseTo(9, 6); // box top is at z=1, origin at z=10
  });

  it('misses when the ray passes outside the footprint', () => {
    expect(rayObbHit([5, 5, 10], [0, 0, -1], box())).toBeNull();
  });

  it('returns 0 when the origin is inside the box', () => {
    expect(rayObbHit([0, 0, 0], [1, 0, 0], box())).toBe(0);
  });

  it('returns null for a box entirely behind the ray', () => {
    // Ray points +z away from a box that is below the origin.
    expect(rayObbHit([0, 0, 10], [0, 0, 1], box())).toBeNull();
  });

  it('misses a slab the ray is parallel to and outside of', () => {
    // Ray along +x at z=5 (above the box, which spans z∈[-1,1]).
    expect(rayObbHit([-10, 0, 5], [1, 0, 0], box())).toBeNull();
  });

  it('respects yaw — a rotated long box is hit along its rotated long axis', () => {
    // heading=π/2 rotates the (length=4, width=1) footprint so the long axis
    // points along world Y. A point at world (0, 1.8) is inside; (1.8, 0) is not.
    const rotated = box({ heading: Math.PI / 2, halfExtents: [2, 0.5, 1] });
    expect(rayObbHit([0, 1.8, 10], [0, 0, -1], rotated)).not.toBeNull();
    expect(rayObbHit([1.8, 0, 10], [0, 0, -1], rotated)).toBeNull();
  });

  it('is unnormalised-direction aware (t in units of dir length)', () => {
    // dir length 2 → entry at t = 9/2 = 4.5.
    const t = rayObbHit([0, 0, 10], [0, 0, -2], box());
    expect(t).toBeCloseTo(4.5, 6);
  });
});

describe('pickBoxes', () => {
  it('returns the nearest hit with its metadata and world hit point', () => {
    const near = box({ center: [0, 0, 0], meta: { layerId: 'l', kind: 'object', trackId: 'near' } });
    const far = box({ center: [0, 0, -20], meta: { layerId: 'l', kind: 'object', trackId: 'far' } });
    const hit = pickBoxes([0, 0, 10], [0, 0, -1], [far, near]);
    expect(hit).not.toBeNull();
    expect(hit?.trackId).toBe('near');
    expect(hit?.worldPoint[2]).toBeCloseTo(1, 6); // entered the near box at z=1
  });

  it('returns null when nothing is hit', () => {
    const origin: Vec3 = [50, 50, 10];
    expect(pickBoxes(origin, [0, 0, -1], [box()])).toBeNull();
  });

  it('returns null for an empty box set', () => {
    expect(pickBoxes([0, 0, 10], [0, 0, -1], [])).toBeNull();
  });
});
