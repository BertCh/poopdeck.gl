import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  buildTrackIndex,
  sampleTrack,
  sampleTracks,
  lerpAngle,
  lerpDim,
  type BoxTrackOptions,
  type BoxDefaults,
} from '../src/layers/box-tracks';
import {
  writeBoxEdges,
  FLOATS_PER_BOX,
  BOX_EDGES,
} from '../src/geometry/box-edges';
import type { RGBA } from '../src/lib/color';

const OPTS: BoxTrackOptions = {
  trackIdProperty: 'track_id',
  colorProperty: 'category',
  colorMapping: { car: [255, 158, 0, 235] } as Record<string, RGBA>,
  colorMappingDefault: [150, 160, 175, 220],
  labelProperty: 'category',
  headingProperty: 'heading',
  lengthProperty: 'length',
  widthProperty: 'width',
  heightProperty: 'height',
  speedProperty: 'speed',
};
const DEF: BoxDefaults = {
  length: 4,
  width: 2,
  height: 1.6,
  fadeIn: 0,
  fadeOut: 0,
};

/** A tile with `count` object snapshots; per-keyframe columns are parallel arrays. */
function objectTile(
  trackIds: string[],
  starts: number[],
  cols: {
    lon: number[];
    lat: number[];
    heading?: number[];
    category?: string[];
    speed?: number[];
  },
  timeOffset = 0,
): Tile {
  const count = trackIds.length;
  const positions = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = cols.lon[i];
    positions[i * 2 + 1] = cols.lat[i];
  }
  const trackCats = Array.from(new Set(trackIds));
  const catCats = cols.category ? Array.from(new Set(cols.category)) : [];
  const features: BinaryFeatures = {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(starts),
    endTimes: new Float32Array(starts),
    timeOffset,
    numericProps: {
      ...(cols.heading ? { heading: new Float32Array(cols.heading) } : {}),
      ...(cols.speed ? { speed: new Float32Array(cols.speed) } : {}),
      length: new Float32Array(count).fill(4),
      width: new Float32Array(count).fill(2),
      height: new Float32Array(count).fill(1.6),
    },
    categoricalProps: {
      track_id: {
        indices: new Uint16Array(trackIds.map((t) => trackCats.indexOf(t))),
        categories: trackCats,
      },
      ...(cols.category
        ? {
            category: {
              indices: new Uint16Array(
                cols.category.map((c) => catCats.indexOf(c)),
              ),
              categories: catCats,
            },
          }
        : {}),
    },
    vectorProps: {},
  };
  return {
    id: { z: 18, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'objects',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

describe('lerpAngle', () => {
  it('takes the short way across the ±π seam', () => {
    const a = (179 * Math.PI) / 180;
    const b = (-179 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    // Should be ~180°, not ~0°.
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.05);
  });
  it('degrades gracefully with NaN endpoints', () => {
    expect(lerpAngle(NaN, 1, 0.5)).toBe(1);
    expect(lerpAngle(1, NaN, 0.5)).toBe(1);
  });
});

describe('lerpDim', () => {
  it('falls back when both endpoints are NaN', () => {
    expect(lerpDim(NaN, NaN, 0.5, 7)).toBe(7);
    expect(lerpDim(2, NaN, 0.5, 7)).toBe(2);
  });
});

describe('buildTrackIndex + sampleTrack', () => {
  it('pools keyframes per track across tiles and interpolates position', () => {
    const t1 = objectTile(
      ['A'],
      [0],
      { lon: [-71], lat: [42], heading: [0], category: ['car'] },
      1000,
    );
    const t2 = objectTile(
      ['A'],
      [1000],
      { lon: [-71.001], lat: [42], heading: [0], category: ['car'] },
      1000,
    );
    const idx = buildTrackIndex([t1, t2], OPTS);
    expect(idx.size).toBe(1);
    const track = idx.get('A')!;
    expect(track.times).toEqual([1000, 2000]); // rebased to absolute, sorted
    expect(track.color).toEqual([255, 158, 0, 235]); // category 'car'
    // Halfway in time -> halfway in lon.
    const s = sampleTrack(track, 1500, DEF)!;
    expect(s.lon).toBeCloseTo(-71.0005, 6);
  });

  it('returns null outside the keyframe span', () => {
    const t1 = objectTile(['A'], [0], { lon: [-71], lat: [42] }, 1000);
    const t2 = objectTile(['A'], [1000], { lon: [-71], lat: [42] }, 1000);
    const idx = buildTrackIndex([t1, t2], OPTS);
    expect(sampleTrack(idx.get('A')!, 500, DEF)).toBeNull(); // before first (1000)
    expect(sampleTrack(idx.get('A')!, 5000, DEF)).toBeNull(); // after last (2000)
  });

  it('emits one active sample per active track', () => {
    const tile = objectTile(
      ['A', 'B'],
      [0, 0],
      { lon: [-71, -71.001], lat: [42, 42.001], category: ['car', 'car'] },
      1000,
    );
    const idx = buildTrackIndex([tile], OPTS);
    // singletons held ±200ms around 1000
    const samples = sampleTracks(idx, 1000, DEF);
    expect(samples.length).toBe(2);
  });

  it('applies fade in/out into the sample alpha', () => {
    const t1 = objectTile(['A'], [0], { lon: [-71], lat: [42] }, 1000);
    const t2 = objectTile(['A'], [1000], { lon: [-71], lat: [42] }, 1000);
    const idx = buildTrackIndex([t1, t2], OPTS);
    const fade: BoxDefaults = { ...DEF, fadeIn: 200, fadeOut: 200 };
    // 100ms after first keyframe (1000) -> alpha 0.5
    expect(sampleTrack(idx.get('A')!, 1100, fade)!.alpha).toBeCloseTo(0.5, 5);
  });
});

describe('writeBoxEdges', () => {
  it('writes 12 edges (24 verts) with axis-aligned corners at heading 0', () => {
    const out = new Float32Array(FLOATS_PER_BOX);
    const next = writeBoxEdges(out, 0, 0, 0, 0, 0, 4, 2, 1.6);
    expect(next).toBe(FLOATS_PER_BOX);
    expect(BOX_EDGES.length).toBe(12);
    // every x is ±2 (length/2), y is ±1 (width/2), z in {0,1.6}
    for (let i = 0; i < out.length; i += 3) {
      expect(Math.abs(out[i])).toBeCloseTo(2, 6);
      expect(Math.abs(out[i + 1])).toBeCloseTo(1, 6);
      expect(out[i + 2] === 0 || Math.abs(out[i + 2] - 1.6) < 1e-6).toBe(true);
    }
  });

  it('rotates the length axis toward +Y(north) at heading π/2', () => {
    const out = new Float32Array(FLOATS_PER_BOX);
    writeBoxEdges(out, 0, 0, 0, 0, Math.PI / 2, 4, 2, 1.6);
    // After 90° yaw, the ±length/2 footprint maps to ±2 along Y, ±1 along X.
    for (let i = 0; i < out.length; i += 3) {
      expect(Math.abs(out[i])).toBeCloseTo(1, 5); // x = ±width/2
      expect(Math.abs(out[i + 1])).toBeCloseTo(2, 5); // y = ±length/2
    }
  });

  it('offsets by the box centre', () => {
    const out = new Float32Array(FLOATS_PER_BOX);
    writeBoxEdges(out, 0, 100, 50, 5, 0, 4, 2, 1.6);
    // first vertex corner (-2,-1,0) + centre
    expect(out[0]).toBeCloseTo(98, 5);
    expect(out[1]).toBeCloseTo(49, 5);
    expect(out[2]).toBeCloseTo(5, 5);
  });
});
