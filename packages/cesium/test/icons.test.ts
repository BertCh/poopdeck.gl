// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `src/lib/icons.ts` — the PURE (Cesium-free) sprite builder behind
 * `STTIconLayer`. Plain Node, no Scene, no GPU: that is the point of keeping
 * every geometry/colour/atlas computation out of the layer.
 *
 * The three atlas helpers get the closest scrutiny, because none of them fails
 * loudly when wrong: `atlasSubRegion`'s y-flip silently addresses the wrong ROW
 * of a sprite sheet, `spriteScale` silently renders at the wrong size, and
 * `anchorPixelOffset` silently plants the sprite beside its coordinate.
 */

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { NULL_CATEGORY_INDEX } from '@poopdeck.gl/core/style';
import {
  DEFAULT_ICON,
  anchorPixelOffset,
  atlasSubRegion,
  buildIconEntries,
  spriteScale,
  type IconMappingEntry,
} from '../src/lib/icons';

// Byte-identical to the builder's own GLOBE: `project` is anchor-independent,
// so an independently constructed one is the right oracle for its output.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

function pointFeatures(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): BinaryFeatures {
  const featureCount = startTimes.length;
  return {
    featureCount,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
}

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features: pointFeatures(
          positions,
          startTimes,
          endTimes,
          partial,
          timeOffset,
        ),
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

/** A 32×48 sprite in the top-left corner of a 256-px-tall atlas. */
const SPRITE: IconMappingEntry = { x: 0, y: 0, width: 32, height: 48 };

describe('atlasSubRegion', () => {
  it('flips y from deck top-left to Cesium bottom-left, keeping x and the size', () => {
    // A sprite whose TOP is 0 px down in a 256-tall atlas has its BOTTOM edge
    // 256 - 48 = 208 px up from the atlas floor.
    expect(atlasSubRegion(SPRITE, 256)).toEqual({
      x: 0,
      y: 208,
      width: 32,
      height: 48,
    });
  });

  it('flips an interior sprite about the atlas mid-line', () => {
    const entry: IconMappingEntry = { x: 64, y: 100, width: 32, height: 32 };
    expect(atlasSubRegion(entry, 256)).toEqual({
      x: 64,
      y: 124, // 256 - (100 + 32)
      width: 32,
      height: 32,
    });
  });

  it('sends a bottom-row sprite to y = 0 (and not to a negative row)', () => {
    const bottom: IconMappingEntry = { x: 0, y: 208, width: 32, height: 48 };
    expect(atlasSubRegion(bottom, 256).y).toBe(0);
  });

  it('round-trips: flipping twice about the same atlas height is the identity', () => {
    const once = atlasSubRegion(SPRITE, 256);
    const twice = atlasSubRegion({ ...SPRITE, y: once.y }, 256);
    expect(twice.y).toBe(SPRITE.y);
  });
});

describe('spriteScale', () => {
  it('defaults to the height basis — `size` becomes the rendered height', () => {
    expect(spriteScale(SPRITE, 24)).toBeCloseTo(24 / 48, 12);
  });

  it('measures the width instead under the width basis', () => {
    expect(spriteScale(SPRITE, 24, 'width')).toBeCloseTo(24 / 32, 12);
  });

  it('returns 0 (never Infinity) for a degenerate sprite', () => {
    expect(spriteScale({ x: 0, y: 0, width: 0, height: 0 }, 24)).toBe(0);
    expect(spriteScale({ x: 0, y: 0, width: 32, height: 0 }, 24)).toBe(0);
    // The width basis is only degenerate when the WIDTH is zero.
    expect(spriteScale({ x: 0, y: 0, width: 32, height: 0 }, 24, 'width')).toBe(
      24 / 32,
    );
  });
});

describe('anchorPixelOffset', () => {
  it("is [0, 0] for deck's default (centre) anchor — the common case costs nothing", () => {
    expect(anchorPixelOffset(SPRITE, 1)).toEqual([0, 0]);
    expect(
      anchorPixelOffset({ ...SPRITE, anchorX: 16, anchorY: 24 }, 3),
    ).toEqual([0, 0]);
  });

  it('pushes a bottom-anchored sprite UP in Cesium screen space (+y is down)', () => {
    // anchorY = height ⇒ the sprite hangs above its position (a map pin).
    // centre − anchor = 24 − 48 = −24 sprite px ⇒ −24 screen px at scale 1.
    const pin = { ...SPRITE, anchorY: 48 };
    expect(anchorPixelOffset(pin, 1)).toEqual([0, -24]);
  });

  it('scales the offset by the billboard scale, since it is in SCREEN pixels', () => {
    const pin = { ...SPRITE, anchorY: 48 };
    expect(anchorPixelOffset(pin, 0.5)).toEqual([0, -12]);
    expect(anchorPixelOffset(pin, 2)).toEqual([0, -48]);
  });

  it('handles a left-edge anchor on the x axis', () => {
    expect(anchorPixelOffset({ ...SPRITE, anchorX: 0 }, 1)).toEqual([16, 0]);
  });
});

describe('buildIconEntries', () => {
  it('returns an empty build (timeOrigin 0) when there are no Point features', () => {
    const line = pointTile([0, 0, 1, 1], [0], [1], {
      geometryType: GeometryType.LineString,
    });
    const build = buildIconEntries([line]);
    expect(build.icons).toEqual([]);
    expect(build.timeOrigin).toBe(0);
  });

  it('projects each feature to WGS84 ECEF and carries lon/lat + provenance', () => {
    const tile = pointTile([10, 45, -30, -12], [0, 5], [10, 15]);
    const build = buildIconEntries([tile]);
    expect(build.icons).toHaveLength(2);

    const e0 = GLOBE.project(10, 45, 0);
    expect(build.icons[0].x).toBeCloseTo(e0[0], 6);
    expect(build.icons[0].y).toBeCloseTo(e0[1], 6);
    expect(build.icons[0].z).toBeCloseTo(e0[2], 6);
    expect(build.icons[0].lon).toBe(10);
    expect(build.icons[0].lat).toBe(45);
    expect(build.icons[0].binary).toBe(tile.layers[0].features);
    expect(build.icons[0].featureIndex).toBe(0);
    expect(build.icons[1].featureIndex).toBe(1);
  });

  it('uses geometry z, and lifts by zLift on top of it', () => {
    const tile = pointTile([0, 0, 500], [0], [1], {
      positionDimensions: 3,
      positions: new Float64Array([0, 0, 500]),
    });
    // At (0, 0) the +X axis carries the whole altitude.
    const base = GLOBE.project(0, 0, 0)[0];
    expect(buildIconEntries([tile]).icons[0].x).toBeCloseTo(base + 500, 6);
    expect(buildIconEntries([tile], { zLift: 250 }).icons[0].x).toBeCloseTo(
      base + 750,
      6,
    );
  });

  it('tints WHITE by default — the identity for a texture multiply', () => {
    const i = buildIconEntries([pointTile([0, 0], [0], [1])]).icons[0];
    expect([i.r, i.g, i.b, i.a]).toEqual([1, 1, 1, 1]);
  });

  it('normalizes a constant tint to 0..1 exactly once', () => {
    const i = buildIconEntries([pointTile([0, 0], [0], [1])], {
      color: { type: 'constant', color: [10, 20, 30, 40] },
    }).icons[0];
    expect(i.r).toBeCloseTo(10 / 255, 12);
    expect(i.g).toBeCloseTo(20 / 255, 12);
    expect(i.b).toBeCloseTo(30 / 255, 12);
    expect(i.a).toBeCloseTo(40 / 255, 12);
  });

  it('resolves a categorical tint per feature', () => {
    const tile = pointTile([0, 0, 1, 1], [0, 0], [1, 1], {
      categoricalProps: {
        kind: { indices: new Uint16Array([0, 1]), categories: ['a', 'b'] },
      },
    });
    const build = buildIconEntries([tile], {
      color: {
        type: 'categorical',
        property: 'kind',
        colorMapping: { a: [255, 0, 0, 255], b: [0, 255, 0, 255] },
        fallback: [1, 2, 3, 4],
      },
    });
    expect(build.icons[0].r).toBe(1);
    expect(build.icons[0].g).toBe(0);
    expect(build.icons[1].g).toBe(1);
    expect(build.icons[1].r).toBe(0);
  });

  it('defaults every sprite to `marker`, and to an explicit `icon` when given', () => {
    expect(buildIconEntries([pointTile([0, 0], [0], [1])]).icons[0].icon).toBe(
      DEFAULT_ICON,
    );
    expect(
      buildIconEntries([pointTile([0, 0], [0], [1])], { icon: 'plane' })
        .icons[0].icon,
    ).toBe('plane');
  });

  it("selects the sprite from a categorical column, past deck's one-icon limit", () => {
    const tile = pointTile([0, 0, 1, 1, 2, 2], [0, 0, 0], [1, 1, 1], {
      categoricalProps: {
        vessel: {
          indices: new Uint16Array([0, 1, NULL_CATEGORY_INDEX]),
          categories: ['tanker', 'tug'],
        },
      },
    });
    const icons = buildIconEntries([tile], {
      iconProperty: 'vessel',
      icon: 'unknown',
    }).icons;
    expect(icons.map((i) => i.icon)).toEqual(['tanker', 'tug', 'unknown']);
  });

  it('falls back to the constant sprite when the tile lacks the column', () => {
    const icons = buildIconEntries([pointTile([0, 0], [0], [1])], {
      iconProperty: 'vessel',
      icon: 'unknown',
    }).icons;
    expect(icons[0].icon).toBe('unknown');
  });

  it('resolves size from a constant, a column, sizeScale and both clamps', () => {
    const plain = pointTile([0, 0], [0], [1]);
    expect(buildIconEntries([plain]).icons[0].size).toBe(12); // default
    expect(buildIconEntries([plain], { size: 20 }).icons[0].size).toBe(20);
    expect(
      buildIconEntries([plain], { size: 20, sizeScale: 1.5 }).icons[0].size,
    ).toBe(30);

    const sized = pointTile([0, 0, 1, 1], [0, 0], [1, 1], {
      numericProps: { mag: new Float32Array([4, 100]) },
    });
    const icons = buildIconEntries([sized], {
      sizeProperty: 'mag',
      sizeScale: 2,
      sizeMinPixels: 10,
      sizeMaxPixels: 64,
    }).icons;
    expect(icons[0].size).toBe(10); // 4 × 2 = 8, clamped UP to the minimum
    expect(icons[1].size).toBe(64); // 100 × 2 = 200, clamped DOWN to the maximum
  });

  it('treats a non-finite size cell as a HOLE and falls back to the constant', () => {
    const tile = pointTile([0, 0], [0], [1], {
      numericProps: { mag: new Float32Array([Number.NaN]) },
    });
    const i = buildIconEntries([tile], { sizeProperty: 'mag', size: 7 })
      .icons[0];
    expect(i.size).toBe(7);
  });

  it('converts rotation from degrees CCW (deck getAngle) to radians', () => {
    const plain = pointTile([0, 0], [0], [1]);
    expect(buildIconEntries([plain]).icons[0].rotation).toBe(0);
    expect(
      buildIconEntries([plain], { angle: 90 }).icons[0].rotation,
    ).toBeCloseTo(Math.PI / 2, 12);

    const heading = pointTile([0, 0, 1, 1], [0, 0], [1, 1], {
      numericProps: { cog: new Float32Array([180, Number.NaN]) },
    });
    const icons = buildIconEntries([heading], {
      angleProperty: 'cog',
      angle: 45,
    }).icons;
    expect(icons[0].rotation).toBeCloseTo(Math.PI, 6);
    // The NaN cell falls back to the constant, NOT to a NaN rotation (which
    // would drop the quad from the draw entirely).
    expect(icons[1].rotation).toBeCloseTo((45 * Math.PI) / 180, 12);
  });

  it('rebases later layers onto the FIRST layer time origin', () => {
    const a = pointTile([0, 0], [100], [200], {}, 1_000);
    const b = pointTile([1, 1], [50], [150], {}, 4_000);
    const build = buildIconEntries([a, b]);
    expect(build.timeOrigin).toBe(1_000);
    expect(build.icons[0].start).toBe(100);
    expect(build.icons[0].end).toBe(200);
    // 4000 − 1000 = 3000 ms of rebase carried onto the second tile's times.
    expect(build.icons[1].start).toBe(3_050);
    expect(build.icons[1].end).toBe(3_150);
  });

  it('skips non-Point layers inside an otherwise Point tile', () => {
    const tile = pointTile([0, 0], [0], [1]);
    tile.layers.push({
      name: 'lines',
      extent: 0,
      features: pointFeatures([0, 0, 1, 1], [0], [1], {
        geometryType: GeometryType.LineString,
        startIndices: new Uint32Array([0, 2]),
      }),
      geometryExtensionName: 'geoarrow.linestring',
    });
    expect(buildIconEntries([tile]).icons).toHaveLength(1);
  });
});
