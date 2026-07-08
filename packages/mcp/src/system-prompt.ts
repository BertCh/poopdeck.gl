// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * `buildSystemPrompt()` — renders the dataset catalog as a short,
 * model-readable block so an agent knows
 * what's available WITHOUT calling `list_datasets` first. Wired into the
 * server's `instructions` field at construction (`createSttMcpServer` in
 * `server.ts`) — MCP clients that surface server `instructions` in the
 * system prompt (Claude Desktop/Code do) get this for free.
 */
import type { DatasetSummary } from './manifest.js';

/** Catalog lines beyond this count collapse into a "+N more" line — keeps a large data-root's system-prompt footprint bounded; `list_datasets` always returns the full list. */
const MAX_INLINE_DATASETS = 40;

/**
 * A "family" of near-identical datasets sharing a stable name prefix (e.g. the
 * ~hundreds of `argoverse-*` AV LiDAR scene variants) with more than this many
 * members collapses to a SINGLE summarized line, so a handful of noisy families
 * can't crowd the distinctive flagship datasets out of the inline budget. A few
 * siblings still print individually — only genuinely large families collapse.
 */
const FAMILY_COLLAPSE_MIN = 5;

/**
 * A dataset's `name` is a POSIX-relative path (see {@link DatasetSummary.name}).
 * The family key is its leading token up to the first path/word separator
 * (`/`, `-`, `_`) — so both `argoverse/scene-0001` and `argoverse-0001` map to
 * the family `argoverse`, while separator-free names (`earthquakes`) are their
 * own singleton family. Deterministic: pure function of the name string.
 */
function familyKey(name: string): string {
  const m = /^([^/\-_]+)/.exec(name);
  return m && m[1].length > 0 ? m[1] : name;
}

function formatTimeRange(d: DatasetSummary): string {
  if (!d.timeRange) return 'no time range';
  const start = Number.isFinite(d.timeRange.start)
    ? new Date(d.timeRange.start).toISOString()
    : '?';
  const end = Number.isFinite(d.timeRange.end)
    ? new Date(d.timeRange.end).toISOString()
    : '?';
  return `${start} → ${end}`;
}

function formatBounds(d: DatasetSummary): string {
  if (!d.boundingBox) return 'no bounds';
  const { minLon, minLat, maxLon, maxLat } = d.boundingBox;
  return `[${minLon.toFixed(2)}, ${minLat.toFixed(2)}, ${maxLon.toFixed(2)}, ${maxLat.toFixed(2)}]`;
}

function formatOne(d: DatasetSummary): string {
  const zoom =
    d.minZoom !== undefined && d.maxZoom !== undefined
      ? `z${d.minZoom}-${d.maxZoom}`
      : 'z?';
  const summary = d.hasSummaryTier
    ? `, summary tier (${d.summaryScheme ?? 'unknown scheme'})`
    : '';
  // `featureCount` is `undefined` when the manifest doesn't know it (see
  // manifest.ts — a 0 alongside non-empty packs means "unknown", not zero). A
  // literal 0 is likewise not worth surfacing, so only print a positive count —
  // never "~0 features".
  const features =
    d.featureCount !== undefined && d.featureCount > 0
      ? `, ~${d.featureCount.toLocaleString('en-US')} features`
      : '';
  return `- \`${d.name}\`: ${formatTimeRange(d)}, bbox ${formatBounds(d)}, ${zoom}${features}${summary}`;
}

/**
 * Renders a short catalog block (name, temporal extent, bounding box, zoom
 * range, summary-tier scheme, feature count) for every dataset — capped at
 * {@link MAX_INLINE_DATASETS} lines, with large near-identical families
 * collapsed to one line each (see {@link FAMILY_COLLAPSE_MIN}) so flagship
 * datasets stay visible. Suitable for a server's `instructions` field or any
 * agent-facing system prompt that wants the catalog inline.
 */
export function buildSystemPrompt(datasets: DatasetSummary[]): string {
  const header = [
    'This MCP server exposes a catalog of SpatioTemporal Tiles (STT) datasets —',
    'packed, time-aware vector tile archives (points/paths/polygons/trips plus',
    'H3/Quadbin summary tiers) — for discovery and rendering via `@deck.gl/json`',
    'specs. Use `list_datasets`/`describe_dataset` for the authoritative,',
    'up-to-date catalog; `view_map` composes a renderable spec for one or more',
    'datasets by name. The STT documentation is also available: browse it as',
    '`stt://docs/<path>` resources, search it with `search_docs`, and read a',
    'page with `get_doc`.',
  ].join(' ');

  if (datasets.length === 0) {
    return `${header}\n\nNo datasets found under the configured --data-root.`;
  }

  // Group by family so a few huge near-identical families (e.g. hundreds of
  // `argoverse-*` scenes) don't dominate an alphabetical slice and bury the
  // distinctive flagship datasets. Insertion order is preserved for determinism.
  const families = new Map<string, DatasetSummary[]>();
  for (const d of datasets) {
    const key = familyKey(d.name);
    const bucket = families.get(key);
    if (bucket) bucket.push(d);
    else families.set(key, [d]);
  }

  // Small families render as individual dataset lines FIRST (so flagships always
  // land within the budget); large families collapse to one summary line each,
  // appended after, in first-appearance order.
  interface Entry {
    line: string;
    /** Number of datasets this line accounts for (1 for individual, N for a collapsed family). */
    count: number;
  }
  const individual: Entry[] = [];
  const collapsed: Entry[] = [];
  for (const [key, members] of families) {
    if (members.length >= FAMILY_COLLAPSE_MIN) {
      collapsed.push({
        line: `- \`${key}-*\` — ${members.length.toLocaleString('en-US')} near-identical datasets in this family; call \`list_datasets\` to enumerate.`,
        count: members.length,
      });
    } else {
      for (const d of members)
        individual.push({ line: formatOne(d), count: 1 });
    }
  }

  const entries = [...individual, ...collapsed];
  const shown = entries.slice(0, MAX_INLINE_DATASETS);
  const lines = shown.map((e) => e.line);
  const shownCount = shown.reduce((n, e) => n + e.count, 0);
  const omitted = datasets.length - shownCount;
  if (omitted > 0) {
    lines.push(
      `- …and ${omitted.toLocaleString('en-US')} more — call \`list_datasets\` for the full catalog.`,
    );
  }

  return [
    header,
    '',
    `Available datasets (${datasets.length}):`,
    ...lines,
  ].join('\n');
}
