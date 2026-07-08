// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * Packed-format `manifest.json` parsing + data-root scanning for the MCP
 * `list_datasets`/`describe_dataset` tools (design record:
 * `docs/roadmap/ai-suite-skills-mcp-2026-07.md`).
 *
 * Deliberately does NOT depend on `@poopdeck.gl/core`'s `STTArchive` (which is
 * a fetch-oriented reader meant for HTTP range requests against packs/
 * directory objects). This server only ever needs the manifest JSON's
 * metadata block — never a directory or pack byte — so a plain
 * `fs.readFile` + `JSON.parse` is the whole job, keeping this package's only
 * dependencies `@modelcontextprotocol/sdk` + `zod` (ground rule: this package
 * MUST NOT add `@poopdeck.gl/core` as a dependency).
 *
 * Field mapping mirrors the Rust `stt_core::metadata::Metadata` /
 * `stt_core::pack::Manifest` structs (`crates/stt-core/src/metadata.rs`,
 * `crates/stt-core/src/pack.rs`) and `packages/core/src/archive.ts`'s
 * `getMetadata()` — snake_case on the wire, camelCase in the returned
 * summaries here.
 */
import { promises as fs, realpathSync } from 'node:fs';
import * as path from 'node:path';

/** Raw `manifest.json` shape (snake_case metadata, as written by stt-build/stt-core). */
export interface RawManifest {
  format: string;
  formatVersion: number;
  capabilities?: string[];
  compression: string;
  blobOrdering?: string;
  directory: {
    key: string;
    length: number;
    directoryVersion: number;
    encoding?: string;
    layout?: string;
    rootLength?: number;
    pageCount?: number;
    pageEntries?: number;
  };
  packs: Array<{ key: string; length: number }>;
  metadata: {
    name?: string;
    description?: string;
    attribution?: string;
    bounds?: { min_lon: number; min_lat: number; max_lon: number; max_lat: number };
    time_range?: { start: number; end: number };
    min_zoom?: number;
    max_zoom?: number;
    tile_count?: number;
    feature_count?: number;
    layers?: string[];
    properties?: Record<string, string>;
    temporal_bucket_ms?: number;
    summary_tier?: {
      scheme: string;
      min_zoom: number;
      max_zoom: number;
      cell_resolution_per_zoom?: number[];
      columns?: Array<{ name: string; agg: string }>;
      layer_name?: string;
      sub_buckets?: number;
    } | null;
    temporal_lod?: Array<{ bucket_ms: number; max_zoom_level: number }>;
    style_hints?: {
      version: number;
      properties: Array<{
        name: string;
        min?: number;
        p50?: number;
        p90?: number;
        p95?: number;
        p97?: number;
        p99?: number;
        max?: number;
        suggested_domain?: [number, number];
        cardinality?: number;
      }>;
      suggested_playback_seconds?: number;
      layer_hint?: string;
    };
  };
}

export interface BoundingBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

/** `list_datasets` catalog entry — one per directory carrying a `manifest.json`. */
export interface DatasetSummary {
  /** POSIX-style path relative to `--data-root`; the `name` param every other tool takes. */
  name: string;
  /** Absolute filesystem path to the dataset directory. */
  path: string;
  format: string;
  formatVersion: number;
  boundingBox?: BoundingBox;
  timeRange?: TimeRange;
  minZoom?: number;
  maxZoom?: number;
  featureCount?: number;
  hasSummaryTier: boolean;
  summaryScheme?: string;
}

/** Best-effort per-property "column" entry — see {@link DatasetDescription.columns}. */
export interface DatasetColumnSummary {
  name: string;
  type: 'Number' | 'String';
  min?: number;
  max?: number;
  suggestedDomain?: [number, number];
  cardinality?: number;
  /** Aggregation function (`sum`/`mean`/`count`/…) when the column was derived from a `summary_tier` schema rather than `style_hints`. */
  agg?: string;
}

/** `describe_dataset` result — the full parsed manifest, camelCased. */
export interface DatasetDescription extends DatasetSummary {
  description?: string;
  attribution?: string;
  tileCount?: number;
  layers: string[];
  properties: Record<string, string>;
  temporalBucketMs?: number;
  temporalLod?: Array<{ bucketMs: number; maxZoomLevel: number }>;
  capabilities: string[];
  compression: string;
  blobOrdering?: string;
  directory: {
    key: string;
    length: number;
    directoryVersion: number;
    encoding?: string;
    layout?: string;
    rootLength?: number;
    pageCount?: number;
    pageEntries?: number;
  };
  packCount: number;
  totalPackBytes: number;
  /** `directory.length + sum(packs[].length)` — the at-rest object bytes this dataset occupies. */
  totalBytes: number;
  summaryTier?: RawManifest['metadata']['summary_tier'];
  styleHints?: RawManifest['metadata']['style_hints'];
  /**
   * Best-effort per-property "schema" — derived from `metadata.style_hints.properties`
   * (build-time measured percentiles/cardinality) when present, otherwise
   * from `metadata.summary_tier.columns` (the aggregated measures of a
   * quadbin/h3 rollup, surfaced with their `agg` function) when the dataset
   * is a summary tier. The packed format does NOT carry a first-class
   * per-column type schema at the manifest layer (only `metadata.layers`,
   * layer names) — the Arrow IPC
   * `schemas` table (formatVersion 2) has the real column types but is a
   * base64-encoded Arrow IPC prefix, not decoded here (would require an
   * Arrow JS dependency this package deliberately avoids). Absent when the
   * archive was built without `--style-hints` and carries no schema
   * templates a human/agent would find legible without a schema decoder.
   */
  columns?: DatasetColumnSummary[];
  /** Number of formatVersion-2 Arrow schema templates in the manifest, if any (not decoded — see `columns`). */
  schemaTemplateCount?: number;
}

const MANIFEST_FILE = 'manifest.json';
/** Directory names never worth descending into while scanning for `manifest.json` (packs/index hold thousands of opaque blob files; never a nested dataset). */
const SKIP_DIR_NAMES = new Set(['packs', 'index', 'node_modules', '.git']);

/** Reads and JSON-parses one dataset directory's `manifest.json`. Throws with a clear message if missing/invalid. */
export async function readManifest(datasetDir: string): Promise<RawManifest> {
  const manifestPath = path.join(datasetDir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(
      `no readable manifest.json at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw) as RawManifest;
  } catch (err) {
    throw new Error(
      `${manifestPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** POSIX-joined path of `dir` relative to `root` (stable across platforms — this is the `name` every tool takes). */
function toPosixRelative(root: string, dir: string): string {
  const rel = path.relative(root, dir);
  return rel.split(path.sep).join('/');
}

/**
 * Recursively finds every directory under `root` that directly contains a
 * `manifest.json`, without descending further once one is found (a dataset
 * directory's only children are its own `packs/`/`index/`, which are also
 * name-skipped as an optimization). Bounded by `maxDepth` so a misconfigured
 * `--data-root` (e.g. pointed at the whole repo) can't run away — AV-cockpit
 * bundles nest one level deep (`<scene-id>/<stream>/manifest.json`), so the
 * default of 6 is generous headroom, not a tight fit.
 */
async function findManifestDirs(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable/vanished directory — skip silently, same as an empty one
  }
  if (entries.some((e) => e.isFile() && e.name === MANIFEST_FILE)) {
    out.push(dir);
    return;
  }
  if (depth >= maxDepth) return;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
    await findManifestDirs(root, path.join(dir, entry.name), depth + 1, maxDepth, out);
  }
}

/**
 * Coerces a wire count to `undefined` ("unknown") when it is falsy (0 or
 * missing) but the archive plainly has content (non-empty packs or a
 * non-empty directory blob). ~99% of the shipped catalog carries stale
 * archives whose `feature_count`/`tile_count` was never populated at build
 * time yet whose packs are non-empty — reporting a literal `0` there reads as
 * "empty dataset", which is wrong. A genuine, trustworthy `0` essentially
 * never occurs for a built archive, so mapping 0-with-content to `undefined`
 * is the correct disambiguation. An empty archive (no packs, empty directory)
 * keeps its literal value.
 */
function normalizeContentCount(count: number | undefined, hasContent: boolean): number | undefined {
  if (!count && hasContent) return undefined;
  return count;
}

/** True when the archive carries real payload bytes (any pack, or a non-empty directory blob). */
function hasArchiveContent(manifest: RawManifest): boolean {
  return manifest.packs.length > 0 || manifest.directory.length > 0;
}

function summarize(dataRoot: string, datasetDir: string, manifest: RawManifest): DatasetSummary {
  const m = manifest.metadata ?? {};
  return {
    name: toPosixRelative(dataRoot, datasetDir),
    path: datasetDir,
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    boundingBox: m.bounds
      ? {
          minLon: m.bounds.min_lon,
          minLat: m.bounds.min_lat,
          maxLon: m.bounds.max_lon,
          maxLat: m.bounds.max_lat,
        }
      : undefined,
    timeRange: m.time_range ? { start: m.time_range.start, end: m.time_range.end } : undefined,
    minZoom: m.min_zoom,
    maxZoom: m.max_zoom,
    featureCount: normalizeContentCount(m.feature_count, hasArchiveContent(manifest)),
    hasSummaryTier: !!m.summary_tier,
    summaryScheme: m.summary_tier?.scheme,
  };
}

/**
 * Scans `dataRoot` for packed datasets (any directory containing a
 * `manifest.json`), returning one {@link DatasetSummary} per hit. Optional
 * `search` substring-filters on `name` (case-insensitive) — the ONLY param
 * `list_datasets` takes.
 */
export async function scanDatasets(
  dataRoot: string,
  options: { search?: string; maxDepth?: number } = {},
): Promise<DatasetSummary[]> {
  const dirs: string[] = [];
  await findManifestDirs(dataRoot, dataRoot, 0, options.maxDepth ?? 6, dirs);
  dirs.sort();

  const summaries: DatasetSummary[] = [];
  for (const dir of dirs) {
    try {
      const manifest = await readManifest(dir);
      summaries.push(summarize(dataRoot, dir, manifest));
    } catch {
      // A directory that raced a build (partially-written manifest.json) or
      // carries a corrupt one is skipped rather than failing the whole scan —
      // describe_dataset on it will surface the real parse error if asked for directly.
      continue;
    }
  }

  if (!options.search) return summaries;
  const needle = options.search.toLowerCase();
  return summaries.filter((d) => d.name.toLowerCase().includes(needle));
}

/**
 * Resolves a `name` (as returned by {@link scanDatasets}, or `'.'`/`''` for
 * `dataRoot` itself) to an absolute dataset directory under `dataRoot`,
 * rejecting path traversal — `name` is agent-supplied input crossing a
 * trust boundary (an LLM tool-call argument), so containment is checked,
 * not assumed. Resolving to `dataRoot` exactly (`relative === ''`) is
 * allowed — only escaping ABOVE `dataRoot` is rejected.
 *
 * Containment is checked twice: first lexically (fast, catches `..` traversal),
 * then against the canonicalized (`fs.realpathSync`) paths so a symlink placed
 * INSIDE `--data-root` that points OUTSIDE it cannot slip past the lexical
 * check and then get read. When the leaf does not exist yet (a not-yet-built
 * dataset dir), the nearest existing ancestor is canonicalized instead — a
 * still-to-be-created path under a real, contained directory is fine.
 */
export function resolveDatasetDir(dataRoot: string, name: string): string {
  const cleaned = name.replace(/\/manifest\.json$/, '').replace(/^\/+/, '');
  const resolvedRoot = path.resolve(dataRoot);
  const resolved = path.resolve(resolvedRoot, cleaned);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`dataset name "${name}" resolves outside --data-root (${dataRoot})`);
  }
  // Symlink-aware re-check: canonicalize both the data root and the resolved
  // target (or its nearest existing ancestor, when the leaf does not exist
  // yet) and confirm the target is STILL contained. This defeats a symlink
  // inside --data-root that the lexical check above cannot see through.
  const canonicalRoot = realpathOfNearestExisting(resolvedRoot);
  const canonicalResolved = realpathOfNearestExisting(resolved);
  const canonicalRelative = path.relative(canonicalRoot, canonicalResolved);
  if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
    throw new Error(`dataset name "${name}" resolves outside --data-root (${dataRoot})`);
  }
  return resolved;
}

/**
 * `fs.realpathSync` of `p`, or — when `p` (or a suffix of it) does not exist
 * yet (ENOENT) — of its nearest existing ancestor. The non-existent suffix
 * cannot contain a symlink (it has no inode), so canonicalizing the existing
 * prefix is sufficient for a containment check. Any non-ENOENT error
 * propagates.
 */
function realpathOfNearestExisting(p: string): string {
  let current = p;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return realpathSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return current; // reached filesystem root
      current = parent;
    }
  }
}

function buildColumns(manifest: RawManifest): DatasetColumnSummary[] | undefined {
  // Prefer `style_hints.properties` (build-time measured percentiles/cardinality)
  // when present — the richest column signal the manifest carries.
  const props = manifest.metadata.style_hints?.properties;
  if (props && props.length > 0) {
    return props.map((p) => ({
      name: p.name,
      type: p.cardinality !== undefined ? 'String' : 'Number',
      min: p.min,
      max: p.max,
      suggestedDomain: p.suggested_domain,
      cardinality: p.cardinality,
    }));
  }
  // No `style_hints` (no shipped manifest has them) but a `summary_tier` schema
  // IS present: derive a legible column list from its aggregated columns so
  // summary datasets (quadbin/h3 rollups) still expose their measures. The
  // values are aggregations (`sum`/`mean`/`count`/…), so `Number` is the
  // sensible type; the aggregation function is surfaced on `agg`.
  const summaryColumns = manifest.metadata.summary_tier?.columns;
  if (summaryColumns && summaryColumns.length > 0) {
    return summaryColumns.map((c) => ({
      name: c.name,
      type: 'Number',
      agg: c.agg,
    }));
  }
  return undefined;
}

/**
 * Full parsed-manifest description for `describe_dataset` — metadata, schema
 * hints, temporal block, capabilities, directory layout, pack/byte totals.
 * Reads only `manifest.json` (never a directory or pack object).
 */
export async function describeDataset(dataRoot: string, name: string): Promise<DatasetDescription> {
  const dir = resolveDatasetDir(dataRoot, name);
  const manifest = await readManifest(dir);
  const summary = summarize(dataRoot, dir, manifest);
  const m = manifest.metadata ?? {};
  const totalPackBytes = manifest.packs.reduce((sum, p) => sum + p.length, 0);

  return {
    ...summary,
    description: m.description,
    attribution: m.attribution,
    tileCount: normalizeContentCount(m.tile_count, hasArchiveContent(manifest)),
    layers: m.layers ?? [],
    properties: m.properties ?? {},
    temporalBucketMs: m.temporal_bucket_ms,
    temporalLod: m.temporal_lod?.map((l) => ({ bucketMs: l.bucket_ms, maxZoomLevel: l.max_zoom_level })),
    capabilities: manifest.capabilities ?? [],
    compression: manifest.compression,
    blobOrdering: manifest.blobOrdering,
    directory: manifest.directory,
    packCount: manifest.packs.length,
    totalPackBytes,
    totalBytes: totalPackBytes + manifest.directory.length,
    summaryTier: m.summary_tier ?? undefined,
    styleHints: m.style_hints,
    columns: buildColumns(manifest),
    schemaTemplateCount: (manifest as any).schemas?.length,
  };
}
