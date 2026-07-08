import { describe, it, expect } from 'vitest';
import {
  buildViewMap,
  inferLayerType,
  resolveManifestUrl,
} from '../src/view-map';
import type { DatasetDescription } from '../src/manifest';

function dataset(
  overrides: Partial<DatasetDescription> = {},
): DatasetDescription {
  return {
    name: 'earthquakes',
    path: '/data/earthquakes',
    format: 'stt-packed',
    formatVersion: 2,
    boundingBox: { minLon: -10, minLat: -20, maxLon: 10, maxLat: 20 },
    timeRange: { start: 1_000, end: 2_000 },
    minZoom: 2,
    maxZoom: 12,
    featureCount: 100,
    hasSummaryTier: false,
    layers: ['default'],
    properties: {},
    capabilities: [],
    compression: 'zstd',
    directory: { key: 'index/x.sttd', length: 10, directoryVersion: 5 },
    packCount: 1,
    totalPackBytes: 10,
    totalBytes: 20,
    ...overrides,
  };
}

describe('inferLayerType', () => {
  it('prefers style_hints.layer_hint (confidence: hint)', () => {
    expect(
      inferLayerType(
        dataset({
          styleHints: { version: 1, properties: [], layer_hint: 'trips' },
        }),
      ),
    ).toEqual({
      type: 'AnimatedTripsLayer',
      confidence: 'hint',
    });
  });

  it('falls back to the summary-tier scheme (confidence: summary)', () => {
    expect(
      inferLayerType(dataset({ hasSummaryTier: true, summaryScheme: 'h3' })),
    ).toEqual({
      type: 'H3SummaryLayer',
      confidence: 'summary',
    });
    expect(
      inferLayerType(
        dataset({ hasSummaryTier: true, summaryScheme: 'quadbin' }),
      ),
    ).toEqual({
      type: 'QuadbinSummaryLayer',
      confidence: 'summary',
    });
  });

  it('blindly defaults to AnimatedPointLayer (confidence: default)', () => {
    expect(inferLayerType(dataset())).toEqual({
      type: 'AnimatedPointLayer',
      confidence: 'default',
    });
  });
});

describe('resolveManifestUrl', () => {
  it('uses the filesystem path when no publicBaseUrl is configured', () => {
    expect(resolveManifestUrl(dataset())).toBe(
      '/data/earthquakes/manifest.json',
    );
  });

  it('joins name onto publicBaseUrl when configured', () => {
    expect(resolveManifestUrl(dataset(), 'https://tiles.example.com/')).toBe(
      'https://tiles.example.com/earthquakes/manifest.json',
    );
  });
});

describe('buildViewMap', () => {
  it('builds one layer per dataset with the inferred @@type and manifest URL', () => {
    const { spec } = buildViewMap([dataset()], {
      publicBaseUrl: 'https://tiles.example.com',
    });
    expect(spec.layers).toHaveLength(1);
    const layer = spec.layers[0] as Record<string, unknown>;
    expect(layer['@@type']).toBe('AnimatedPointLayer');
    expect(layer.data).toBe(
      'https://tiles.example.com/earthquakes/manifest.json',
    );
    expect(layer.currentTime).toBe(1_000); // defaults to the first dataset's timeRange.start
  });

  it('honors an explicit layer override for every dataset', () => {
    const { spec } = buildViewMap(
      [dataset(), dataset({ name: 'other', path: '/data/other' })],
      {
        layer: 'AnimatedArcLayer',
        publicBaseUrl: 'https://tiles.example.com',
      },
    );
    expect((spec.layers[0] as any)['@@type']).toBe('AnimatedArcLayer');
    expect((spec.layers[1] as any)['@@type']).toBe('AnimatedArcLayer');
  });

  it('honors an explicit time and viewState', () => {
    const { spec } = buildViewMap([dataset()], {
      time: 5_000,
      viewState: { longitude: 1, latitude: 2, zoom: 9 },
    });
    expect((spec.layers[0] as any).currentTime).toBe(5_000);
    expect(spec.initialViewState).toMatchObject({
      longitude: 1,
      latitude: 2,
      zoom: 9,
    });
  });

  it('frames a single small-bbox dataset tightly from the bbox extent', () => {
    // bbox spans 20deg lon / 40deg lat -> zoom = floor(log2(360/40)) = floor(3.17) = 3
    const { spec } = buildViewMap([dataset()], {
      publicBaseUrl: 'https://tiles.example.com',
    });
    expect(spec.initialViewState.longitude).toBeCloseTo(0);
    expect(spec.initialViewState.latitude).toBeCloseTo(0);
    expect(spec.initialViewState.zoom).toBe(3);
  });

  it('zooms to the union extent (not the coarsest minZoom) across datasets', () => {
    // union bbox spans 20deg both axes -> zoom = floor(log2(360/20)) = floor(4.17) = 4
    const { spec } = buildViewMap(
      [
        dataset({
          boundingBox: { minLon: -10, minLat: -10, maxLon: 0, maxLat: 0 },
          minZoom: 4,
        }),
        dataset({
          boundingBox: { minLon: 0, minLat: 0, maxLon: 10, maxLat: 10 },
          minZoom: 2,
        }),
      ],
      { publicBaseUrl: 'https://tiles.example.com' },
    );
    expect(spec.initialViewState.longitude).toBeCloseTo(0);
    expect(spec.initialViewState.latitude).toBeCloseTo(0);
    expect(spec.initialViewState.zoom).toBe(4);
  });

  it('zooms out sensibly when disjoint datasets union to a wide bbox', () => {
    const { spec } = buildViewMap(
      [
        dataset({
          boundingBox: { minLon: -170, minLat: -10, maxLon: -160, maxLat: 0 },
        }),
        dataset({
          boundingBox: { minLon: 160, minLat: 0, maxLon: 170, maxLat: 10 },
        }),
      ],
      { publicBaseUrl: 'https://tiles.example.com' },
    );
    // union lon span 340deg -> zoom = floor(log2(360/340)) = floor(0.08) = 0
    expect(spec.initialViewState.zoom).toBe(0);
  });

  it('clamps the extent zoom to the data maxZoom for a degenerate (point) bbox', () => {
    const { spec } = buildViewMap(
      [
        dataset({
          boundingBox: { minLon: 5, minLat: 5, maxLon: 5, maxLat: 5 },
          maxZoom: 9,
        }),
      ],
      {
        publicBaseUrl: 'https://tiles.example.com',
      },
    );
    expect(spec.initialViewState.zoom).toBe(9);
  });

  it('warns when the geometry type is unknown (blind default)', () => {
    const { warnings } = buildViewMap([dataset()], {
      publicBaseUrl: 'https://tiles.example.com',
    });
    expect(
      warnings.some(
        (w) =>
          w.includes('geometry type is unknown') && w.includes('earthquakes'),
      ),
    ).toBe(true);
    expect(warnings.some((w) => w.includes('AnimatedPointLayer'))).toBe(true);
  });

  it('does NOT warn about geometry when a hint gives a positive signal', () => {
    const { warnings } = buildViewMap(
      [
        dataset({
          styleHints: { version: 1, properties: [], layer_hint: 'paths' },
        }),
      ],
      { publicBaseUrl: 'https://tiles.example.com' },
    );
    expect(warnings.some((w) => w.includes('geometry type is unknown'))).toBe(
      false,
    );
  });

  it('does NOT warn about geometry when the layer is explicitly forced', () => {
    const { warnings } = buildViewMap([dataset()], {
      layer: 'AnimatedPathLayer',
      publicBaseUrl: 'https://tiles.example.com',
    });
    expect(warnings.some((w) => w.includes('geometry type is unknown'))).toBe(
      false,
    );
  });

  it('warns once that filesystem-path manifest URLs are not browser-fetchable', () => {
    const { warnings } = buildViewMap([
      dataset(),
      dataset({ name: 'other', path: '/data/other' }),
    ]);
    const fsWarnings = warnings.filter((w) =>
      w.includes('local filesystem paths'),
    );
    expect(fsWarnings).toHaveLength(1);
    expect(fsWarnings[0]).toContain('--public-base-url');
  });

  it('does NOT warn about filesystem paths when a publicBaseUrl is set', () => {
    const { warnings } = buildViewMap([dataset()], {
      publicBaseUrl: 'https://tiles.example.com',
    });
    expect(warnings.some((w) => w.includes('local filesystem paths'))).toBe(
      false,
    );
  });

  it('produces a self-contained spec-preview HTML page (not a live map) embedding the spec JSON', () => {
    const { spec, html } = buildViewMap([dataset()], {
      publicBaseUrl: 'https://tiles.example.com',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('@deck.gl/json');
    expect(html).toContain('STT layer classes');
    expect(html).toContain('not a live map');
    expect(html).toContain(JSON.stringify(spec.initialViewState));
    // No live deck.Deck instantiation that would render an empty black canvas.
    expect(html).not.toContain('new deck.Deck');
  });

  it('surfaces advisories in the HTML preview', () => {
    const { html } = buildViewMap([dataset()]);
    expect(html).toContain('Advisories');
    expect(html).toContain('geometry type is unknown');
  });
});
