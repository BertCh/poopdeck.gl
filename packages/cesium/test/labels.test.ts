// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the PURE label builder (`src/lib/labels.ts`). Runs in plain
 * Node with no Cesium import at all — which is the point of keeping the module
 * Cesium-free, and is asserted directly by the purity gate at the bottom.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { NULL_CATEGORY_INDEX } from '@poopdeck.gl/core/style';
import {
  buildLabelEntries,
  formatNumericLabel,
  shortestFloat32String,
} from '../src/lib/labels';

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
  const features = pointFeatures(
    positions,
    startTimes,
    endTimes,
    partial,
    timeOffset,
  );
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

function categorical(
  indices: number[],
  categories: string[],
): BinaryFeatures['categoricalProps'][string] {
  return { indices: new Uint16Array(indices), categories };
}

describe('shortestFloat32String', () => {
  it('prints the shortest decimal that round-trips the stored float32', () => {
    // The whole reason this helper exists: numericProps are Float32Array, so
    // String(v) of the widened float64 renders 1.1 as 1.100000023841858.
    const stored = new Float32Array([1.1, 0.25, 123.456])[0];
    expect(String(stored)).not.toBe('1.1');
    expect(shortestFloat32String(stored)).toBe('1.1');
  });

  it('is exact for values with an exact float32 representation', () => {
    expect(shortestFloat32String(0.25)).toBe('0.25');
    expect(shortestFloat32String(0)).toBe('0');
    expect(shortestFloat32String(-8)).toBe('-8');
  });

  it('round-trips every candidate it returns', () => {
    const col = new Float32Array([1.1, 123.456, 3.14159, 1e-7, 6.02e23, -0.3]);
    for (const v of col) {
      expect(Math.fround(Number(shortestFloat32String(v)))).toBe(v);
    }
  });
});

describe('formatNumericLabel', () => {
  it('pins toFixed when a precision is given', () => {
    expect(formatNumericLabel(1.23456, 2)).toBe('1.23');
    expect(formatNumericLabel(1.23456, 0)).toBe('1');
  });

  it('falls back to the shortest round-tripping decimal without one', () => {
    const stored = new Float32Array([1.1])[0];
    expect(formatNumericLabel(stored, null)).toBe('1.1');
    expect(formatNumericLabel(stored, undefined)).toBe('1.1');
  });

  it('renders non-finite values as empty rather than drawing "NaN" on a map', () => {
    expect(formatNumericLabel(Number.NaN, null)).toBe('');
    expect(formatNumericLabel(Number.POSITIVE_INFINITY, 2)).toBe('');
  });
});

describe('buildLabelEntries', () => {
  it('returns an empty build with timeOrigin 0 when there is nothing to label', () => {
    const build = buildLabelEntries([]);
    expect(build.labels).toEqual([]);
    expect(build.timeOrigin).toBe(0);
    expect(build.hasOutline).toBe(false);
  });

  it('drops every feature when neither a column nor a constant resolves', () => {
    // A build with no text is legitimately empty — and that emptiness is what
    // makes the layer's bail-before-teardown rule observable.
    const tile = pointTile([0, 0, 10, 20], [0, 0], [100, 100]);
    expect(buildLabelEntries([tile]).labels).toHaveLength(0);
  });

  it('labels every feature from a categorical column, sharing strings by reference', () => {
    const categories = ['ferry', 'tanker'];
    const tile = pointTile([0, 0, 10, 20, 30, 40], [0, 0, 0], [1, 1, 1], {
      categoricalProps: { kind: categorical([0, 1, 0], categories) },
    });
    const { labels } = buildLabelEntries([tile], { textProperty: 'kind' });
    expect(labels.map((l) => l.text)).toEqual(['ferry', 'tanker', 'ferry']);
    // Same string object, not 3 copies — the reason a 100k-feature tile over
    // six classes costs six strings.
    expect(labels[0].text).toBe(categories[0]);
    expect(labels[2].text).toBe(categories[0]);
  });

  it('drops features whose category is NULL or out of range', () => {
    const tile = pointTile([0, 0, 10, 20, 30, 40], [0, 0, 0], [1, 1, 1], {
      categoricalProps: {
        kind: categorical([0, NULL_CATEGORY_INDEX, 7], ['ferry']),
      },
    });
    const { labels } = buildLabelEntries([tile], { textProperty: 'kind' });
    expect(labels).toHaveLength(1);
    // Provenance travels with the entry precisely BECAUSE indices shift.
    expect(labels[0].featureIndex).toBe(0);
  });

  it('formats a numeric column, honouring textPrecision', () => {
    const tile = pointTile([0, 0, 10, 20], [0, 0], [1, 1], {
      numericProps: { mag: new Float32Array([1.1, 4.25]) },
    });
    expect(
      buildLabelEntries([tile], { textProperty: 'mag' }).labels.map(
        (l) => l.text,
      ),
    ).toEqual(['1.1', '4.25']);
    expect(
      buildLabelEntries([tile], {
        textProperty: 'mag',
        textPrecision: 2,
      }).labels.map((l) => l.text),
    ).toEqual(['1.10', '4.25']);
  });

  it('drops a numeric feature whose value is a non-finite sentinel', () => {
    const tile = pointTile([0, 0, 10, 20], [0, 0], [1, 1], {
      numericProps: { mag: new Float32Array([Number.NaN, 4]) },
    });
    const { labels } = buildLabelEntries([tile], { textProperty: 'mag' });
    expect(labels).toHaveLength(1);
    expect(labels[0].featureIndex).toBe(1);
  });

  it('falls back to textConstant when the column is absent', () => {
    const tile = pointTile([0, 0, 10, 20], [0, 0], [1, 1]);
    const { labels } = buildLabelEntries([tile], {
      textProperty: 'missing',
      textConstant: '•',
    });
    expect(labels.map((l) => l.text)).toEqual(['•', '•']);
  });

  it('prefers a categorical column over a numeric one of the same name', () => {
    const tile = pointTile([0, 0], [0], [1], {
      categoricalProps: { v: categorical([0], ['CAT']) },
      numericProps: { v: new Float32Array([9]) },
    });
    expect(
      buildLabelEntries([tile], { textProperty: 'v' }).labels[0].text,
    ).toBe('CAT');
  });

  it('projects anchors to absolute WGS84 ECEF metres, with zLift applied', () => {
    const tile = pointTile([12.5, 41.9], [0], [1], {}, 0);
    const plain = buildLabelEntries([tile], { textConstant: 'x' }).labels[0];
    const [ex, ey, ez] = GLOBE.project(12.5, 41.9, 0);
    expect(plain.x).toBeCloseTo(ex, 6);
    expect(plain.y).toBeCloseTo(ey, 6);
    expect(plain.z).toBeCloseTo(ez, 6);
    // Not RTC-relative: the magnitude is an Earth radius, ~6.37e6 m.
    expect(Math.hypot(plain.x, plain.y, plain.z)).toBeGreaterThan(6.3e6);

    const lifted = buildLabelEntries([tile], {
      textConstant: 'x',
      zLift: 1000,
    }).labels[0];
    // The lift is along the GEODETIC normal, which on an ellipsoid is not the
    // radial direction — so measure the displacement, not the radius delta.
    expect(
      Math.hypot(lifted.x - plain.x, lifted.y - plain.y, lifted.z - plain.z),
    ).toBeCloseTo(1000, 6);
  });

  it('uses the geometry z of a 3-D tile, plus zLift', () => {
    const tile = pointTile([12.5, 41.9, 500], [0], [1], {
      positionDimensions: 3,
      positions: new Float64Array([12.5, 41.9, 500]),
    });
    const { labels } = buildLabelEntries([tile], {
      textConstant: 'x',
      zLift: 100,
    });
    const [ex, ey, ez] = GLOBE.project(12.5, 41.9, 600);
    expect(labels[0].x).toBeCloseTo(ex, 6);
    expect(labels[0].y).toBeCloseTo(ey, 6);
    expect(labels[0].z).toBeCloseTo(ez, 6);
  });

  it('rebases every layer onto the FIRST layer timeOffset', () => {
    const a = pointTile([0, 0], [10], [20], {}, 1000);
    const b = pointTile([1, 1], [10], [20], {}, 1500);
    const { labels, timeOrigin } = buildLabelEntries([a, b], {
      textConstant: 'x',
    });
    expect(timeOrigin).toBe(1000);
    expect(labels[0].start).toBe(10);
    expect(labels[0].end).toBe(20);
    expect(labels[1].start).toBe(510); // 10 + (1500 - 1000)
    expect(labels[1].end).toBe(520);
  });

  it('normalizes colours to 0..1 exactly once', () => {
    const tile = pointTile([0, 0], [0], [1], {});
    const { labels, hasOutline } = buildLabelEntries([tile], {
      textConstant: 'x',
      color: { type: 'constant', color: [255, 128, 0, 204] },
    });
    expect(hasOutline).toBe(false);
    expect(labels[0].fillR).toBe(1);
    expect(labels[0].fillG).toBeCloseTo(128 / 255, 12);
    expect(labels[0].fillB).toBe(0);
    expect(labels[0].fillA).toBeCloseTo(204 / 255, 12);
    // No outline mode → the channels are a placeholder the layer must not read.
    expect(labels[0].outlineA).toBe(0);
  });

  it('reports hasOutline and carries normalized outline channels', () => {
    const tile = pointTile([0, 0], [0], [1]);
    const { labels, hasOutline } = buildLabelEntries([tile], {
      textConstant: 'x',
      outlineColor: { type: 'constant', color: [0, 0, 0, 255] },
    });
    expect(hasOutline).toBe(true);
    expect(labels[0].outlineA).toBe(1);
  });

  it('drives colour through the categorical/ramp trichotomy', () => {
    const tile = pointTile([0, 0, 1, 1], [0, 0], [1, 1], {
      categoricalProps: { kind: categorical([0, 1], ['a', 'b']) },
      numericProps: { mag: new Float32Array([0, 10]) },
    });
    const cat = buildLabelEntries([tile], {
      textConstant: 'x',
      color: {
        type: 'categorical',
        property: 'kind',
        colorMapping: { a: [255, 0, 0, 255] },
        fallback: [0, 255, 0, 255],
      },
    }).labels;
    expect([cat[0].fillR, cat[0].fillG]).toEqual([1, 0]);
    expect([cat[1].fillR, cat[1].fillG]).toEqual([0, 1]);

    const ramp = buildLabelEntries([tile], {
      textConstant: 'x',
      color: {
        type: 'ramp',
        property: 'mag',
        domain: [0, 10],
        range: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
        fallback: [1, 2, 3, 255],
      },
    }).labels;
    expect(ramp[0].fillR).toBeCloseTo(0, 6);
    expect(ramp[1].fillR).toBeCloseTo(1, 6);
  });

  it('takes per-feature scale from a numeric column, falling back on non-finite', () => {
    const tile = pointTile([0, 0, 1, 1, 2, 2], [0, 0, 0], [1, 1, 1], {
      numericProps: { size: new Float32Array([0.5, 2, Number.NaN]) },
    });
    const { labels } = buildLabelEntries([tile], {
      textConstant: 'x',
      scaleProperty: 'size',
      scaleConstant: 1.25,
    });
    expect(labels.map((l) => l.scale)).toEqual([0.5, 2, 1.25]);
  });

  it('uses scaleConstant when no scale column resolves', () => {
    const tile = pointTile([0, 0], [0], [1]);
    const { labels } = buildLabelEntries([tile], {
      textConstant: 'x',
      scaleProperty: 'absent',
      scaleConstant: 3,
    });
    expect(labels[0].scale).toBe(3);
    expect(
      buildLabelEntries([tile], { textConstant: 'x' }).labels[0].scale,
    ).toBe(1);
  });

  it('carries the source lon/lat through for the pick coordinate', () => {
    const tile = pointTile([-73.6, 45.5], [0], [1]);
    const { labels } = buildLabelEntries([tile], { textConstant: 'x' });
    expect(labels[0].lon).toBeCloseTo(-73.6, 12);
    expect(labels[0].lat).toBeCloseTo(45.5, 12);
  });

  it('is PURE: the module imports nothing from cesium', () => {
    // The purity rule is what makes this builder unit-testable in plain Node;
    // a source-text gate is the only way to keep a future edit from quietly
    // reaching for a Cesium type.
    const src = readFileSync(
      new URL('../src/lib/labels.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"]cesium['"]/);
    expect(src).not.toMatch(/from\s+['"]@cesium\//);
  });

  it('builds NO UTF-32 code-point machinery — that is the backend simplification', () => {
    // deck and three instance one quad per character and so must carry a flat
    // code-point buffer + per-row offsets. Cesium's LabelCollection owns the
    // glyph atlas, so a FeatureLabel is a plain string. If this ever gains a
    // codePoints field, the header's claim has stopped being true.
    const tile = pointTile([0, 0], [0], [1]);
    const label = buildLabelEntries([tile], { textConstant: 'hi' }).labels[0];
    expect(typeof label.text).toBe('string');
    expect(Object.keys(label)).not.toContain('codePoints');
    expect(Object.keys(label)).not.toContain('charOffsets');
  });
});
