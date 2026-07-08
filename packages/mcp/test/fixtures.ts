/**
 * Minimal packed-dataset `manifest.json` fixtures for `@poopdeck.gl/mcp`'s
 * tests — a plain JSON object matching the wire shape (see
 * `src/manifest.ts`'s `RawManifest`), written to a temp directory tree. No
 * dependency on `@poopdeck.gl/core` (this package never constructs an
 * `STTArchive` — see `manifest.ts`'s module doc).
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export function makeManifestJson(
  overrides: { metadata?: Record<string, unknown>; [key: string]: unknown } = {},
): unknown {
  const { metadata: metadataOverrides, ...topOverrides } = overrides;
  return {
    format: 'stt-packed',
    formatVersion: 2,
    capabilities: ['coord-quant'],
    compression: 'zstd',
    blobOrdering: 'hilbert3',
    directory: {
      key: 'index/aaaa.sttd',
      length: 4096,
      directoryVersion: 5,
      encoding: 'zstd',
      layout: 'paged',
      rootLength: 128,
      pageCount: 2,
      pageEntries: 4096,
    },
    packs: [
      { key: 'packs/aaaa.sttp', length: 1_000_000 },
      { key: 'packs/bbbb.sttp', length: 500_000 },
    ],
    ...topOverrides,
    metadata: {
      name: 'fixture-dataset',
      description: 'a synthetic fixture',
      attribution: '(c) test',
      bounds: { min_lon: -10, min_lat: -20, max_lon: 10, max_lat: 20 },
      time_range: { start: 0, end: 3_600_000 },
      min_zoom: 0,
      max_zoom: 12,
      tile_count: 100,
      feature_count: 5000,
      layers: ['default'],
      properties: { source: 'unit-test' },
      temporal_bucket_ms: 3_600_000,
      summary_tier: null,
      ...metadataOverrides,
    },
  };
}

/** Writes `datasets` (relative POSIX path -> manifest JSON) under a fresh temp directory; returns the root path. */
export async function writeFixtureDataRoot(datasets: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'stt-mcp-test-'));
  for (const [rel, manifest] of Object.entries(datasets)) {
    const dir = path.join(root, ...rel.split('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    // A couple of decoy sibling files/dirs a real packed dataset carries,
    // to make sure the scanner doesn't misfire on them.
    await mkdir(path.join(dir, 'packs'), { recursive: true });
    await writeFile(path.join(dir, 'packs', 'not-a-manifest.sttp'), 'binary-ish', 'utf8');
  }
  return root;
}

export async function cleanupDataRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/**
 * Writes `files` (docs-relative POSIX path -> markdown text) under a fresh temp
 * directory acting as a `docsRoot`; returns the root path. Use POSIX-relative
 * keys like `README.md` or `api/cli-reference.md`. Clean up with
 * {@link cleanupDataRoot}.
 */
export async function writeFixtureDocsRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'stt-mcp-docs-'));
  for (const [rel, text] of Object.entries(files)) {
    const segments = rel.split('/');
    const dir = path.join(root, ...segments.slice(0, -1));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(root, ...segments), text, 'utf8');
  }
  return root;
}
