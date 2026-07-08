import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/system-prompt';
import type { DatasetSummary } from '../src/manifest';

function dataset(overrides: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    name: 'earthquakes',
    path: '/data/earthquakes',
    format: 'stt-packed',
    formatVersion: 2,
    boundingBox: { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 },
    timeRange: { start: 0, end: 3_600_000 },
    minZoom: 0,
    maxZoom: 12,
    featureCount: 5000,
    hasSummaryTier: false,
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('mentions the catalog tools and handles an empty catalog', () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toContain('list_datasets');
    expect(prompt).toContain('No datasets found');
  });

  it('lists dataset names, bbox, zoom range, and summary tier', () => {
    const prompt = buildSystemPrompt([
      dataset({ name: 'earthquakes' }),
      dataset({
        name: 'nyc-od-quadbin',
        hasSummaryTier: true,
        summaryScheme: 'quadbin',
      }),
    ]);
    expect(prompt).toContain('`earthquakes`');
    expect(prompt).toContain('`nyc-od-quadbin`');
    expect(prompt).toContain('summary tier (quadbin)');
    expect(prompt).toContain('Available datasets (2):');
  });

  it('caps inline datasets and points to list_datasets for the rest', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      dataset({ name: `unique${i}` }),
    );
    const prompt = buildSystemPrompt(many);
    expect(prompt).toContain('and 10 more');
    expect(prompt).toContain('list_datasets');
  });

  it('collapses a large near-identical family to one line and keeps flagships visible', () => {
    const flagships = [
      'earthquakes',
      'drifters',
      'gtfs-nl',
      'nyc-taxi-yellow',
      'storm-radar',
    ];
    const argoverse = Array.from({ length: 342 }, (_, i) =>
      dataset({ name: `argoverse-scene-${String(i).padStart(4, '0')}` }),
    );
    // Alphabetically the argoverse-* names dominate the first 40 slots; the
    // flagships must still survive via family collapsing.
    const catalog = [
      ...argoverse,
      ...flagships.map((name) => dataset({ name })),
    ];
    const prompt = buildSystemPrompt(catalog);

    // Every flagship is individually visible.
    for (const name of flagships) expect(prompt).toContain(`\`${name}\``);

    // The argoverse family collapses to exactly one summarized line.
    expect(prompt).toContain('`argoverse-*`');
    expect(prompt).toContain('342 near-identical datasets');
    const argoverseLines = prompt
      .split('\n')
      .filter((l) => l.includes('argoverse'));
    expect(argoverseLines).toHaveLength(1);

    // Total catalog count is honest; no individual argoverse scene line leaks in.
    expect(prompt).toContain(`Available datasets (${catalog.length}):`);
    expect(prompt).not.toContain('argoverse-scene-0000');
  });

  it('keeps a small family printing individual lines (below the collapse threshold)', () => {
    const catalog = [
      dataset({ name: 'nyc-taxi-yellow' }),
      dataset({ name: 'nyc-taxi-green' }),
      dataset({ name: 'nyc-od-quadbin' }),
    ];
    const prompt = buildSystemPrompt(catalog);
    expect(prompt).toContain('`nyc-taxi-yellow`');
    expect(prompt).toContain('`nyc-taxi-green`');
    expect(prompt).toContain('`nyc-od-quadbin`');
    expect(prompt).not.toContain('`nyc-*`');
  });

  it('never prints "~0 features" for a zero or unknown feature count', () => {
    const undefinedCount = buildSystemPrompt([
      dataset({ name: 'no-count', featureCount: undefined }),
    ]);
    expect(undefinedCount).not.toContain('~0 features');
    expect(undefinedCount).not.toContain('0 features');
    expect(undefinedCount).toContain('`no-count`');

    // A literal 0 would also be nonsensical to surface; guard belt-and-braces.
    const zeroCount = buildSystemPrompt([
      dataset({ name: 'zero-count', featureCount: 0 }),
    ]);
    expect(zeroCount).not.toContain('~0 features');
  });
});
