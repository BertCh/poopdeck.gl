import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { CubeInLineView } from '../src/components/demo/CubeInLine.tsx';
import {
  profileIdFromUrl,
  type DensityProfile,
} from '../src/lib/densityProfile.ts';

// A tiny time-deep fixture on a 4×4×4 grid: a couple of space columns carrying
// long timelines. Exercises the view without any network fetch.
const fixture = (over: Partial<DensityProfile> = {}): DensityProfile => ({
  id: 'drifters',
  label: 'Test drifters',
  zoom: 4,
  spaceBits: 2,
  timeBins: 4,
  tileCount: 1234,
  totalBytes: 5_000_000,
  featureCount: 88_000,
  bucketMs: 3_600_000,
  timeRange: { start: 0, end: 4 * 3_600_000 },
  bounds: { minLon: -10, minLat: -5, maxLon: 10, maxLat: 5 },
  spaceExtent: { x0: 0, y0: 0, x1: 1, y1: 1 }, // narrow space …
  tbSpan: 63, // … deep time → shapeOf === "time-deep"
  autoChoice: 'spatial',
  nativeSeeks: { spatial: 3, hilbert3: 20, morton3: 40, time: 30 },
  cube: [
    [0, 0, 0, 5, 800],
    [0, 0, 1, 6, 820],
    [0, 0, 2, 4, 790],
    [0, 0, 3, 7, 810],
    [1, 0, 0, 3, 700],
    [1, 0, 2, 2, 690],
    [3, 3, 1, 9, 950],
    [3, 3, 3, 8, 900],
  ],
  ...over,
});

describe('CubeInLineView', () => {
  it('renders the laid-down line, heatmap, walk labels and the auto anchor', () => {
    const html = renderToString(
      React.createElement(CubeInLineView, { profile: fixture() }),
    );
    expect(html).toContain('range read');
    expect(html).toContain('2D Hilbert + time');
    expect(html).toContain('3D Hilbert');
    expect(html).toContain('time-major');
    expect(html).toContain('auto');
    expect(html).toContain('time-deep'); // pole for the drifters id
    expect(html).toContain('space (Hilbert order)');
  });

  it('flags when the auto heuristic disagrees with the measured best', () => {
    // auto picks hilbert3, but spatial has the fewest adjacency breaks here.
    const html = renderToString(
      React.createElement(CubeInLineView, {
        profile: fixture({
          autoChoice: 'hilbert3',
          nativeSeeks: { spatial: 3, hilbert3: 20, morton3: 40, time: 30 },
        }),
      }),
    );
    expect(html).toContain('can disagree');
  });

  it('profileIdFromUrl pulls the archive stem from a flat manifest url', () => {
    expect(profileIdFromUrl('/data/nyc-rideshare/manifest.json')).toBe(
      'nyc-rideshare',
    );
    // AV scenes are nested one level deeper (/data/<id>/lidar/manifest.json) and
    // emit NO density sidecar, so they must resolve to null — otherwise the
    // "Under the hood" panel fetches /density/<id>.json, 404s, and throws on
    // every AV demo detail page.
    expect(
      profileIdFromUrl('/data/argoverse-1/lidar/manifest.json'),
    ).toBeNull();
    expect(profileIdFromUrl('https://example.com/remote.json')).toBeNull();
  });

  it('does not throw for any dataset id / autoChoice combination', () => {
    for (const id of [
      'drifters',
      'nyc-rideshare',
      'gtfs-nl',
      'gtfs-ch',
      'flights',
      'unknown',
    ]) {
      for (const autoChoice of [
        'spatial',
        'hilbert3',
        'morton3',
        'time',
      ] as const) {
        expect(() =>
          renderToString(
            React.createElement(CubeInLineView, {
              profile: fixture({ id, autoChoice }),
            }),
          ),
        ).not.toThrow();
      }
    }
  });
});
