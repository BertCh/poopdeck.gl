import { describe, it, expect } from 'vitest';
import {
  recommendPresentation,
  PRESENTATION_INTENTS,
  type PresentationContext,
} from '../src/presentation';
import type { DatasetDescription } from '../src/manifest';

const DAY = 86_400_000;
const HOUR = 3_600_000;

function dataset(
  overrides: Partial<DatasetDescription> = {},
): DatasetDescription {
  return {
    name: 'quakes',
    path: '/data/quakes',
    format: 'stt-packed',
    formatVersion: 2,
    boundingBox: { minLon: -10, minLat: -20, maxLon: 10, maxLat: 20 },
    timeRange: { start: 0, end: 30 * DAY },
    minZoom: 0,
    maxZoom: 12,
    featureCount: 1000,
    hasSummaryTier: false,
    layers: ['default'],
    properties: {},
    capabilities: [],
    compression: 'zstd',
    directory: { key: 'index/x.sttd', length: 10, directoryVersion: 5 },
    packCount: 1,
    totalPackBytes: 10,
    totalBytes: 20,
    temporalBucketMs: HOUR,
    ...overrides,
  };
}

const ctx = (over: Partial<PresentationContext> = {}): PresentationContext => ({
  baseLayerType: 'AnimatedPointLayer',
  framedZoom: 4,
  ...over,
});

describe('recommendPresentation — time window', () => {
  it('derives the window from the temporal bucket (the ecosystem default)', () => {
    const r = recommendPresentation(dataset(), ctx());
    // bucket * WINDOW_BUCKET_MULTIPLE(24) — MUST match the playback package's
    // DEFAULT_TIME_WINDOW_BUCKETS so view_map specs render with the same
    // window the runtime derives. Clamped to span.
    expect(r.props.timeWindow).toBe(HOUR * 24);
  });

  it('falls back to 24h when no bucket (matching the playback default)', () => {
    const r = recommendPresentation(
      dataset({ temporalBucketMs: undefined }),
      ctx(),
    );
    expect(r.props.timeWindow).toBe(DAY);
  });

  it('never exceeds the data span', () => {
    const r = recommendPresentation(
      dataset({ temporalBucketMs: HOUR, timeRange: { start: 0, end: 1000 } }),
      ctx(),
    );
    expect(r.props.timeWindow).toBe(1000);
  });

  it('an explicit timeWindow override always wins', () => {
    const r = recommendPresentation(dataset(), ctx(), { timeWindow: 42 });
    expect(r.props.timeWindow).toBe(42);
  });
});

describe('recommendPresentation — intent: density', () => {
  it('promotes to the summary layer + forces the summary tier when in range', () => {
    const r = recommendPresentation(
      dataset({
        hasSummaryTier: true,
        summaryScheme: 'h3',
        summaryTier: { scheme: 'h3', min_zoom: 0, max_zoom: 6 },
      }),
      ctx({ summaryLayerType: 'H3SummaryLayer', framedZoom: 4 }),
      { intent: 'density' },
    );
    expect(r.layerType).toBe('H3SummaryLayer');
    expect(r.props.tier).toBe('summary');
  });

  it('does not force the summary tier when framed above its zoom span', () => {
    const r = recommendPresentation(
      dataset({
        hasSummaryTier: true,
        summaryScheme: 'h3',
        summaryTier: { scheme: 'h3', min_zoom: 0, max_zoom: 6 },
      }),
      ctx({ summaryLayerType: 'H3SummaryLayer', framedZoom: 9 }),
      { intent: 'density' },
    );
    expect(r.layerType).toBe('H3SummaryLayer');
    expect(r.props.tier).toBeUndefined();
  });

  it('warns and keeps the base layer when there is no summary tier', () => {
    const r = recommendPresentation(dataset(), ctx(), { intent: 'density' });
    expect(r.layerType).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/summary\/H3 tier/);
  });

  it('does not point an explicitly locked non-summary layer at summary tiles', () => {
    const r = recommendPresentation(
      dataset({
        hasSummaryTier: true,
        summaryScheme: 'h3',
        summaryTier: { scheme: 'h3', min_zoom: 0, max_zoom: 6 },
      }),
      ctx({
        summaryLayerType: 'H3SummaryLayer',
        framedZoom: 4,
        layerLocked: true,
      }),
      { intent: 'density' },
    );
    expect(r.layerType).toBeUndefined();
    // tier:'summary' would fetch summary tiles into a point layer.
    expect(r.props.tier).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(
      /explicitly set to AnimatedPointLayer/,
    );
  });
});

describe('recommendPresentation — intent: tracking', () => {
  it('promotes a line layer to trips and widens the window', () => {
    const r = recommendPresentation(
      dataset(),
      ctx({ baseLayerType: 'AnimatedPathLayer' }),
      { intent: 'tracking' },
    );
    expect(r.layerType).toBe('AnimatedTripsLayer');
    expect(r.props.timeWindow).toBe(HOUR * 24 * 4); // TRACKING_WINDOW_FACTOR
  });

  it('never promotes an explicitly locked layer, and resolves props against it', () => {
    const r = recommendPresentation(
      dataset({
        columns: [{ name: 'speed', type: 'Number', min: 0, max: 40 }],
      }),
      ctx({ baseLayerType: 'AnimatedPathLayer', layerLocked: true }),
      { intent: 'tracking' },
    );
    expect(r.layerType).toBeUndefined();
    // Props are computed for the LOCKED path layer, which has no scalar
    // color-domain prop — trips-only gradient props must not leak onto it.
    expect(r.props.gradientProperty).toBeUndefined();
    expect(r.props.gradientDomain).toBeUndefined();
    // The intent still tunes the (layer-agnostic) window, and the caller is
    // told what the intent would have done.
    expect(r.props.timeWindow).toBe(HOUR * 24 * 4);
    expect(r.warnings.join('\n')).toMatch(
      /explicitly set to AnimatedPathLayer/,
    );
  });

  it('warns and keeps the base for non-line geometry', () => {
    const r = recommendPresentation(dataset(), ctx(), { intent: 'tracking' });
    expect(r.layerType).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/trajectory\/trail/);
  });
});

describe('recommendPresentation — color-by', () => {
  const withColumns = dataset({
    hasSummaryTier: true,
    summaryScheme: 'h3',
    summaryTier: {
      scheme: 'h3',
      min_zoom: 0,
      max_zoom: 6,
      columns: [{ name: 'magnitude', agg: 'mean' }],
    },
    columns: [
      { name: 'category', type: 'String', cardinality: 7 },
      { name: 'magnitude', type: 'Number', suggestedDomain: [1, 9.8] },
    ],
  });

  it('maps the auto-picked source column to its AGGREGATED summary-tile name on a summary layer', () => {
    const r = recommendPresentation(
      withColumns,
      ctx({ baseLayerType: 'H3SummaryLayer' }),
    );
    expect(r.colorBy).toBe('magnitude');
    // Summary tiles carry `<agg>_<source>` (summary.rs::output_column_name),
    // never the raw source name — a raw name would miss the tile's
    // numericProps and blank the layer.
    expect(r.props.weightProperty).toBe('mean_magnitude');
    // `mean` stays inside the source's measured domain, so it is usable.
    expect(r.props.colorDomain).toEqual([1, 9.8]);
  });

  it('keeps the cell-count default when the picked column is not aggregated into the summary tier', () => {
    const r = recommendPresentation(
      dataset({
        hasSummaryTier: true,
        summaryScheme: 'h3',
        summaryTier: { scheme: 'h3', min_zoom: 0, max_zoom: 6 },
        columns: [
          { name: 'magnitude', type: 'Number', suggestedDomain: [1, 9.8] },
        ],
      }),
      ctx({ baseLayerType: 'H3SummaryLayer' }),
    );
    // No weightProperty at all — the layer's always-present 'count' default
    // is strictly better than a column the tiles don't carry.
    expect(r.props.weightProperty).toBeUndefined();
  });

  it('does not emit a raw-domain colorDomain for a non-order-preserving aggregate (sum)', () => {
    const r = recommendPresentation(
      dataset({
        hasSummaryTier: true,
        summaryScheme: 'h3',
        summaryTier: {
          scheme: 'h3',
          min_zoom: 0,
          max_zoom: 6,
          columns: [{ name: 'magnitude', agg: 'sum' }],
        },
        columns: [
          { name: 'magnitude', type: 'Number', suggestedDomain: [1, 9.8] },
        ],
      }),
      ctx({ baseLayerType: 'H3SummaryLayer' }),
    );
    expect(r.props.weightProperty).toBe('sum_magnitude');
    // Per-cell sums exceed the per-feature measured domain — emitting it
    // would clip every dense cell to the top of the ramp.
    expect(r.props.colorDomain).toBeUndefined();
  });

  it('emits gradientProperty + gradientDomain on a trips layer', () => {
    const r = recommendPresentation(
      dataset({
        columns: [{ name: 'speed', type: 'Number', min: 0, max: 40 }],
      }),
      ctx({ baseLayerType: 'AnimatedTripsLayer' }),
    );
    expect(r.props.gradientProperty).toBe('speed');
    expect(r.props.gradientDomain).toEqual([0, 40]);
  });

  it('warns when color-by is requested on a layer with no scalar domain prop (points)', () => {
    const r = recommendPresentation(withColumns, ctx(), {
      colorBy: 'magnitude',
    });
    expect(r.props.weightProperty).toBeUndefined();
    expect(r.props.gradientProperty).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/no first-class/);
  });

  it('warns when color-by is requested but the named column is not measured', () => {
    const r = recommendPresentation(
      dataset({ columns: [] }),
      ctx({ baseLayerType: 'H3SummaryLayer' }),
      { colorBy: 'nope' },
    );
    // A summary layer cannot weight by a column its tiles don't carry — the
    // count default stays, with caveats explaining both gaps.
    expect(r.props.weightProperty).toBeUndefined();
    expect(r.props.colorDomain).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/no measured/);
  });

  it('still trusts an explicit unmeasured column on a native-tile weight layer (heatmap)', () => {
    const r = recommendPresentation(
      dataset({ columns: [] }),
      ctx({ baseLayerType: 'AnimatedHeatmapLayer' }),
      { colorBy: 'intensity' },
    );
    // Native tiles may carry properties the manifest never profiled — wire the
    // name (domain-less) and caveat, rather than refusing.
    expect(r.props.weightProperty).toBe('intensity');
    expect(r.props.colorDomain).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/no measured/);
  });

  it('rejects an explicit colorBy that names a categorical/text column', () => {
    const r = recommendPresentation(
      withColumns,
      ctx({ baseLayerType: 'H3SummaryLayer' }),
      { colorBy: 'category' },
    );
    // Wiring a String column as a weight property renders a silently blank
    // layer (the tile's numericProps lookup misses) — refuse it loudly.
    expect(r.props.weightProperty).toBeUndefined();
    expect(r.props.colorDomain).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/categorical\/text/);
  });

  it('an explicit colorBy overrides the auto pick', () => {
    const cols = dataset({
      columns: [
        { name: 'a', type: 'Number', suggestedDomain: [0, 1] },
        { name: 'b', type: 'Number', suggestedDomain: [5, 9] },
      ],
    });
    const r = recommendPresentation(
      cols,
      ctx({ baseLayerType: 'AnimatedHeatmapLayer' }),
      { colorBy: 'b' },
    );
    expect(r.props.weightProperty).toBe('b');
    expect(r.props.colorDomain).toEqual([5, 9]);
  });
});

describe('PRESENTATION_INTENTS', () => {
  it('is the pinned four-intent vocabulary', () => {
    expect([...PRESENTATION_INTENTS]).toEqual([
      'exploratory',
      'density',
      'tracking',
      'choropleth',
    ]);
  });
});
