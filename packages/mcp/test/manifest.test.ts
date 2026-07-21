import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  scanDatasets,
  describeDataset,
  resolveDatasetDir,
} from '../src/manifest';
import {
  makeManifestJson,
  writeFixtureDataRoot,
  cleanupDataRoot,
} from './fixtures';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await cleanupDataRoot(roots.pop()!);
});

async function fixtureRoot(datasets: Record<string, unknown>): Promise<string> {
  const root = await writeFixtureDataRoot(datasets);
  roots.push(root);
  return root;
}

describe('scanDatasets', () => {
  it('finds a flat dataset directory', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const datasets = await scanDatasets(root);
    expect(datasets).toHaveLength(1);
    expect(datasets[0].name).toBe('earthquakes');
    expect(datasets[0].path).toBe(path.join(root, 'earthquakes'));
    expect(datasets[0].format).toBe('stt-packed');
    expect(datasets[0].formatVersion).toBe(2);
    expect(datasets[0].boundingBox).toEqual({
      minLon: -10,
      minLat: -20,
      maxLon: 10,
      maxLat: 20,
    });
    expect(datasets[0].timeRange).toEqual({ start: 0, end: 3_600_000 });
    expect(datasets[0].hasSummaryTier).toBe(false);
  });

  it('finds nested AV-cockpit-style stream datasets one level deep', async () => {
    const root = await fixtureRoot({
      'scene-01/lidar': makeManifestJson({
        metadata: { name: 'scene-01-lidar' },
      }),
      'scene-01/objects': makeManifestJson({
        metadata: { name: 'scene-01-objects' },
      }),
    });
    const datasets = await scanDatasets(root);
    const names = datasets.map((d) => d.name).sort();
    expect(names).toEqual(['scene-01/lidar', 'scene-01/objects']);
  });

  it('does not descend into packs/ or index/', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    // writeFixtureDataRoot already drops a decoy packs/ dir; scanning must not
    // treat it (or anything inside it) as a dataset.
    const datasets = await scanDatasets(root);
    expect(datasets.map((d) => d.name)).toEqual(['earthquakes']);
  });

  it('surfaces summary-tier scheme when present', async () => {
    const root = await fixtureRoot({
      quadbin: makeManifestJson({
        metadata: {
          summary_tier: { scheme: 'quadbin', min_zoom: 8, max_zoom: 15 },
        },
      }),
    });
    const [d] = await scanDatasets(root);
    expect(d.hasSummaryTier).toBe(true);
    expect(d.summaryScheme).toBe('quadbin');
  });

  it('filters by case-insensitive substring search', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
      'nyc-taxi': makeManifestJson({ metadata: { name: 'nyc-taxi' } }),
    });
    const datasets = await scanDatasets(root, { search: 'TAXI' });
    expect(datasets.map((d) => d.name)).toEqual(['nyc-taxi']);
  });

  it('reports featureCount as undefined ("unknown") when it is 0 but the archive has packs', async () => {
    // ~99% of the shipped catalog carries stale archives whose feature_count
    // was never populated yet whose packs are non-empty — a literal 0 there
    // reads as "empty", which is wrong, so it must surface as undefined.
    const root = await fixtureRoot({
      stale: makeManifestJson({ metadata: { feature_count: 0 } }),
    });
    const [d] = await scanDatasets(root);
    expect(d.featureCount).toBeUndefined();
  });

  it('preserves a literal 0 featureCount for a genuinely empty archive (no packs, empty directory)', async () => {
    const root = await fixtureRoot({
      empty: makeManifestJson({
        packs: [],
        directory: { key: 'index/aaaa.sttd', length: 0, directoryVersion: 5 },
        metadata: { feature_count: 0 },
      }),
    });
    const [d] = await scanDatasets(root);
    expect(d.featureCount).toBe(0);
  });

  it('skips a directory with corrupt JSON rather than failing the whole scan', async () => {
    const root = await fixtureRoot({ good: makeManifestJson() });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.join(root, 'bad'), { recursive: true });
    await writeFile(
      path.join(root, 'bad', 'manifest.json'),
      '{not json',
      'utf8',
    );
    const datasets = await scanDatasets(root);
    expect(datasets.map((d) => d.name)).toEqual(['good']);
  });
});

describe('resolveDatasetDir', () => {
  it('resolves a plain name under the data root', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    expect(resolveDatasetDir(root, 'earthquakes')).toBe(
      path.resolve(root, 'earthquakes'),
    );
  });

  it('rejects path traversal outside the data root', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    expect(() => resolveDatasetDir(root, '../../etc')).toThrow(
      /outside --data-root/,
    );
    expect(() => resolveDatasetDir(root, '..')).toThrow(/outside --data-root/);
  });

  it('strips a trailing /manifest.json', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    expect(resolveDatasetDir(root, 'earthquakes/manifest.json')).toBe(
      path.resolve(root, 'earthquakes'),
    );
  });

  it('rejects a symlink inside --data-root that points outside it', async () => {
    // Lexically "escape" is contained (relative === "escape"); only
    // canonicalizing with realpath reveals it resolves to a sibling OUTSIDE
    // the data root. Build the tree under os.tmpdir() — never the shared fixtures.
    const base = await mkdtemp(path.join(tmpdir(), 'stt-mcp-symlink-'));
    roots.push(base); // cleaned by afterEach via cleanupDataRoot (rm -rf)
    const dataRoot = path.join(base, 'data-root');
    const outside = path.join(base, 'outside-secret');
    await mkdir(dataRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(dataRoot, 'escape'), 'dir');
    expect(() => resolveDatasetDir(dataRoot, 'escape')).toThrow(
      /outside --data-root/,
    );
  });

  it('allows a symlink inside --data-root that points to a contained sibling', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'stt-mcp-symlink-'));
    roots.push(base);
    const dataRoot = path.join(base, 'data-root');
    const real = path.join(dataRoot, 'real');
    await mkdir(real, { recursive: true });
    await symlink(real, path.join(dataRoot, 'alias'), 'dir');
    expect(resolveDatasetDir(dataRoot, 'alias')).toBe(
      path.resolve(dataRoot, 'alias'),
    );
  });

  it('allows a not-yet-existing leaf under a real, contained directory (ENOENT is fine)', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'stt-mcp-symlink-'));
    roots.push(base);
    const dataRoot = path.join(base, 'data-root');
    await mkdir(dataRoot, { recursive: true });
    expect(resolveDatasetDir(dataRoot, 'not-built-yet')).toBe(
      path.resolve(dataRoot, 'not-built-yet'),
    );
  });
});

describe('describeDataset', () => {
  it('returns the full parsed manifest, camelCased, with pack/byte totals', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({
        metadata: {
          name: 'earthquakes',
          description: 'quake catalog',
          temporal_lod: [{ bucket_ms: 86_400_000, max_zoom_level: 8 }],
        },
      }),
    });
    const d = await describeDataset(root, 'earthquakes');
    expect(d.name).toBe('earthquakes');
    expect(d.metadataName).toBe('earthquakes');
    expect(d.description).toBe('quake catalog');
    expect(d.capabilities).toEqual(['coord-quant']);
    expect(d.compression).toBe('zstd');
    expect(d.blobOrdering).toBe('hilbert3');
    expect(d.packCount).toBe(2);
    expect(d.totalPackBytes).toBe(1_500_000);
    expect(d.totalBytes).toBe(1_500_000 + 4096);
    expect(d.temporalLod).toEqual([{ bucketMs: 86_400_000, maxZoomLevel: 8 }]);
    expect(d.properties).toEqual({ source: 'unit-test' });
    expect(d.directory.pageCount).toBe(2);
  });

  it('derives `columns` from style_hints.properties when present', async () => {
    const root = await fixtureRoot({
      styled: makeManifestJson({
        metadata: {
          style_hints: {
            version: 1,
            properties: [
              {
                name: 'magnitude',
                min: 4,
                p50: 4.5,
                max: 8.2,
                suggested_domain: [4, 7],
              },
              { name: 'vessel_type', cardinality: 12 },
            ],
            layer_hint: 'points',
          },
        },
      }),
    });
    const d = await describeDataset(root, 'styled');
    expect(d.columns).toEqual([
      {
        name: 'magnitude',
        type: 'Number',
        min: 4,
        max: 8.2,
        suggestedDomain: [4, 7],
        cardinality: undefined,
      },
      {
        name: 'vessel_type',
        type: 'String',
        min: undefined,
        max: undefined,
        suggestedDomain: undefined,
        cardinality: 12,
      },
    ]);
    expect(d.styleHints?.layer_hint).toBe('points');
  });

  it('surfaces layer_hint from a minimal default-build style_hints block (no properties)', async () => {
    // Post-B1 every non-streaming build bakes a percentile-free style_hints
    // block carrying just layer_hint + suggested_playback_seconds.
    const root = await fixtureRoot({
      minimal: makeManifestJson({
        metadata: {
          style_hints: {
            version: 1,
            properties: [],
            suggested_playback_seconds: 30,
            layer_hint: 'paths',
          },
        },
      }),
    });
    const d = await describeDataset(root, 'minimal');
    expect(d.styleHints?.layer_hint).toBe('paths');
    expect(d.styleHints?.suggested_playback_seconds).toBe(30);
    // No per-property percentiles → no derived columns.
    expect(d.columns).toBeUndefined();
  });

  it('omits `columns` when there are no style hints', async () => {
    const root = await fixtureRoot({ plain: makeManifestJson() });
    const d = await describeDataset(root, 'plain');
    expect(d.columns).toBeUndefined();
  });

  it('surfaces the baked metadataName even when self-described as `.` (name is empty)', async () => {
    // Mirrors build_dataset/generate_dataset, which describe the fresh output
    // dir as `.` — the relative `name` is then "" but the manifest's own
    // `metadata.name` must still be reported (regression: it used to vanish).
    const root = await fixtureRoot({
      hurr: makeManifestJson({ metadata: { name: 'hurricanes-mcp-test' } }),
    });
    const d = await describeDataset(path.join(root, 'hurr'), '.');
    expect(d.name).toBe('');
    expect(d.metadataName).toBe('hurricanes-mcp-test');
  });

  it('leaves metadataName undefined when the manifest carries no name', async () => {
    const root = await fixtureRoot({
      anon: makeManifestJson({ metadata: { name: '' } }),
    });
    const d = await describeDataset(root, 'anon');
    expect(d.metadataName).toBeUndefined();
  });

  it('derives `columns` from summary_tier.columns when style_hints is absent', async () => {
    const root = await fixtureRoot({
      quadbin: makeManifestJson({
        metadata: {
          summary_tier: {
            scheme: 'quadbin',
            min_zoom: 8,
            max_zoom: 15,
            columns: [
              { name: 'trip_count', agg: 'sum' },
              { name: 'avg_speed', agg: 'mean' },
            ],
          },
        },
      }),
    });
    const d = await describeDataset(root, 'quadbin');
    expect(d.columns).toEqual([
      { name: 'trip_count', type: 'Number', agg: 'sum' },
      { name: 'avg_speed', type: 'Number', agg: 'mean' },
    ]);
  });

  it('prefers style_hints over summary_tier.columns when both are present', async () => {
    const root = await fixtureRoot({
      both: makeManifestJson({
        metadata: {
          style_hints: {
            version: 1,
            properties: [{ name: 'magnitude', min: 4, max: 8 }],
          },
          summary_tier: {
            scheme: 'quadbin',
            min_zoom: 8,
            max_zoom: 15,
            columns: [{ name: 'trip_count', agg: 'sum' }],
          },
        },
      }),
    });
    const d = await describeDataset(root, 'both');
    expect(d.columns).toEqual([
      {
        name: 'magnitude',
        type: 'Number',
        min: 4,
        max: 8,
        suggestedDomain: undefined,
        cardinality: undefined,
      },
    ]);
  });

  it('reports tileCount as undefined ("unknown") when it is 0 but the archive has packs', async () => {
    const root = await fixtureRoot({
      stale: makeManifestJson({ metadata: { tile_count: 0 } }),
    });
    const d = await describeDataset(root, 'stale');
    expect(d.tileCount).toBeUndefined();
  });

  it('throws a clear error for an unknown dataset name', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    await expect(describeDataset(root, 'nonexistent')).rejects.toThrow(
      /no readable manifest\.json/,
    );
  });
});
