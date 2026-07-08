import { describe, it, expect } from 'vitest';
import {
  clampPreviewPitch,
  fitPreviewSize,
  previewZoom,
  staticBasemapUrl,
} from '../src/components/demo/previewBasemap';

describe('clampPreviewPitch', () => {
  it('defaults a missing pitch to 0', () => {
    expect(clampPreviewPitch(undefined)).toBe(0);
  });

  it('passes through an in-range tilt', () => {
    expect(clampPreviewPitch(45)).toBe(45);
  });

  it("caps at Mapbox Static's 60° ceiling (cube demos go to 85°)", () => {
    expect(clampPreviewPitch(85)).toBe(60);
  });

  it('floors negatives at 0', () => {
    expect(clampPreviewPitch(-10)).toBe(0);
  });
});

describe('staticBasemapUrl', () => {
  const cam = {
    longitude: -73.98,
    latitude: 40.75,
    zoom: 12.5,
    bearing: 30,
    pitch: 50,
  };

  it('encodes center/zoom/bearing/pitch and the rounded pixel size', () => {
    const url = staticBasemapUrl(cam, 248, 140, 'tok');
    expect(url).toBe(
      'https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/' +
        '-73.98,40.75,12.5,30,50/248x140@2x' +
        '?access_token=tok&attribution=false&logo=false',
    );
  });

  it('clamps the embedded pitch to 60 so it matches the preview camera', () => {
    const url = staticBasemapUrl({ ...cam, pitch: 85 }, 248, 140, 'tok');
    expect(url).toContain('-73.98,40.75,12.5,30,60/');
  });

  it("clamps zoom into Mapbox's [0,22] range", () => {
    expect(staticBasemapUrl({ ...cam, zoom: 30 }, 100, 100, 't')).toContain(
      ',22,',
    );
    expect(staticBasemapUrl({ ...cam, zoom: -5 }, 100, 100, 't')).toContain(
      ',0,',
    );
  });

  it('rounds fractional pixel sizes', () => {
    expect(staticBasemapUrl(cam, 247.6, 139.2, 't')).toContain('/248x139@2x');
  });

  it('defaults bearing/pitch to 0 when absent', () => {
    const url = staticBasemapUrl(
      { longitude: 0, latitude: 0, zoom: 1 },
      10,
      10,
      't',
    );
    expect(url).toContain('/0,0,1,0,0/');
  });
});

describe('fitPreviewSize', () => {
  it('falls back to 16:9 at maxW when the viewport size is unknown', () => {
    expect(fitPreviewSize(undefined, undefined, 264, 180)).toEqual({
      width: 264,
      height: 149,
    });
  });

  it("matches a landscape viewport's aspect ratio", () => {
    // 1600x900 (16:9) → width-bound at 264.
    expect(fitPreviewSize(1600, 900, 264, 180)).toEqual({
      width: 264,
      height: 149,
    });
  });

  it('becomes height-bound when the viewport is closer to square', () => {
    // 1000x900 → 264/(10/9)=237.6 height > 180, so clamp height, derive width.
    const { width, height } = fitPreviewSize(1000, 900, 264, 180);
    expect(height).toBe(180);
    expect(width).toBe(200); // 180 * (1000/900)
  });
});

describe('previewZoom', () => {
  it('is identity when the viewport width is unknown', () => {
    expect(previewZoom(12, 264, undefined)).toBe(12);
  });

  it('zooms OUT so the smaller card shows the same ground extent', () => {
    // Half the width → exactly one zoom level out.
    expect(previewZoom(12, 660, 1320)).toBeCloseTo(11, 10);
    // A quarter the width → two levels out.
    expect(previewZoom(12, 330, 1320)).toBeCloseTo(10, 10);
  });

  it('never zooms in for a smaller preview', () => {
    expect(previewZoom(12, 264, 1600)).toBeLessThan(12);
  });
});
