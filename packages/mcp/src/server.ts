// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * `createSttMcpServer()` — builds the `@poopdeck.gl/mcp` `McpServer`: the
 * DISCOVERY tools always registered, and the EXECUTION tools registered only
 * when `config.allowCli` is set (design record:
 * `docs/roadmap/ai-suite.md`). A few consolidated tools
 * with rich Zod schemas rather than one tool per manifest field.
 */
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { SttMcpConfig } from './config.js';
import {
  describeDataset,
  resolveDatasetDir,
  scanDatasets,
  type DatasetDescription,
} from './manifest.js';
import {
  DEFAULT_DOC_MAX_BYTES,
  docMimeType,
  listCorpusDocs,
  readDoc,
  searchDocs,
  truncateToBytes,
} from './docs.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildViewMap } from './view-map.js';
import { PRESENTATION_INTENTS } from './presentation.js';
import {
  resolveBinary,
  run,
  tryParseJson,
  type RunResult,
} from './cli-runner.js';
// Generated from package.json at build time (scripts/gen-version.mjs) — a
// hand-written constant here sat at '0.4.0' while the package shipped 0.5.0,
// so every client was told the wrong version in `initialize`.
import { PACKAGE_VERSION } from './version.js';

/** One evidence-based advisor suggestion (recommend.rs / advisors::Advice). */
interface RecommendAdvice {
  flag: string;
  value?: string;
  why: string;
  projected?: string;
  /** Lossy/destructive levers are surfaced only — never auto-applied to a build. */
  lossy: boolean;
  /**
   * Non-lossy but still surfaced-only: the lever needs a human decision first
   * (e.g. spatial blob-ordering vs. time-playback buffering, or a prerequisite
   * data transform). Optional — an older stt-optimize omits it.
   */
  suggestion_only?: boolean;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Parsed output of `stt-optimize recommend` (recommend.rs::to_build_config).
 * The scalar recipe fields have always been present; `temporal_bucket_human`,
 * `dominant_type`, `advice`, and `command` are the enriched signals a current
 * `stt-optimize` emits — all optional so an older binary (which omits them)
 * still parses.
 */
interface RecommendConfig {
  input?: string;
  time_field?: string;
  min_zoom?: number;
  max_zoom?: number;
  temporal_bucket_ms?: number;
  temporal_bucket_human?: string;
  /** Dominant source geometry ("Point"/"LineString"/"Polygon"/…) for layer choice. */
  dominant_type?: string;
  confidence?: number;
  explanations?: string[];
  /** Evidence-based advisor suggestions (with `lossy`/`confidence` markers). */
  advice?: RecommendAdvice[];
  /** Ready-to-run `stt-build` command assembled by Rust (non-lossy advice appended). */
  command?: string;
}

function textResult(data: unknown, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
  if (isError) result.isError = true;
  return result;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * A `run()` result counts as a FAILURE when the child exited nonzero, timed
 * out, was aborted (client cancellation), or never spawned (`exitCode === null`
 * from an `error` event). Callers mirror this into `CallToolResult.isError` so
 * an MCP host treats a failed shell-out as an error, not a success payload.
 */
function runFailed(result: RunResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.aborted ||
    result.exitCode === null
  );
}

/** The `--sample` default applied to decode-dependent stats when the caller omits `sample` (keeps a full unsampled decode from blowing past the MCP client's 60s default timeout). */
const DEFAULT_STATS_SAMPLE = 256;

/** Max entries returned by the `stt://datasets/{name}` resource `list` callback (which can't page) — the full catalog is the `list_datasets` tool's job. */
const RESOURCE_LIST_CAP = 100;

/**
 * The `stt-generate` subcommands, in the CLI's kebab-case form (as clap derives
 * them). Each writes a single `.stt`, and most take dataset-specific flags
 * (dates, ranges, `--synthetic`, …) that the `generate_dataset` tool forwards
 * via `extraArgs`. Kept in sync with `stt-generate`'s `Commands` enum
 * (`tools/stt-generate/src/main.rs`) — `test/contract.test.ts` fails if this
 * hand-copy drifts. The `all` fan-out was dropped from the generator (it
 * re-spawned `current_exe()` for three of the datasets), so it is not offered
 * here: an agent that asked for it would only get clap's "unrecognized
 * subcommand".
 */
const STT_GENERATE_DATASETS = [
  'earthquakes',
  'ais',
  'flights',
  'hurricanes',
  'wildfires',
  'nyc-rideshare',
  'bixi',
  'gtfs',
  'nwm',
  'nyc-taxi-points',
  'satellites',
  'drifters',
  'drifters-hourly',
  'animals',
  'osm-edits',
  'storms',
] as const;

/** Normalizes the `view_map`/multi-dataset tools' `datasets: string | string[]` param. */
function asArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Builds the `McpServer`. Scans `config.dataRoot` ONCE at construction to
 * seed the `instructions` field (`buildSystemPrompt`) — every tool call
 * re-scans fresh (datasets on disk can change between calls; the
 * instructions block is a best-effort hint, not a cache).
 */
export async function createSttMcpServer(
  config: SttMcpConfig,
): Promise<McpServer> {
  const initialCatalog = await scanDatasets(config.dataRoot).catch(() => []);

  const server = new McpServer(
    {
      name: 'stt-mcp',
      version: PACKAGE_VERSION,
      title: 'SpatioTemporal Tiles',
    },
    {
      instructions: buildSystemPrompt(initialCatalog),
      capabilities: { tools: {}, resources: {} },
    },
  );

  registerDiscoveryTools(server, config);
  registerDocTools(server, config);
  registerAnalysisTools(server, config);
  registerInteractiveTools(server, config);
  registerResources(server, config);
  if (config.allowCli) registerExecutionTools(server, config);

  return server;
}

// ---------------------------------------------------------------------------
// DISCOVERY
// ---------------------------------------------------------------------------

function registerDiscoveryTools(server: McpServer, config: SttMcpConfig): void {
  server.registerTool(
    'list_datasets',
    {
      title: 'List datasets',
      description:
        'Scans --data-root for packed STT datasets (any directory containing a manifest.json) and ' +
        'returns one summary per dataset: name (pass this to describe_dataset/view_map/etc.), path, ' +
        'format/formatVersion, boundingBox, timeRange, minZoom/maxZoom, featureCount, and whether it ' +
        'carries a pre-aggregated summary tier (H3/Quadbin) for coarse-zoom rendering.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter on dataset name'),
      },
    },
    async ({ search }) => {
      const datasets = await scanDatasets(config.dataRoot, { search });
      return textResult({
        dataRoot: config.dataRoot,
        count: datasets.length,
        datasets,
      });
    },
  );

  server.registerTool(
    'describe_dataset',
    {
      title: 'Describe dataset',
      description:
        'Returns the FULL parsed manifest.json for one dataset: metadata (name/description/attribution), ' +
        'temporal block (time range, bucket size, LOD pyramid), capabilities, compression/blob-ordering, ' +
        'directory layout, pack count + total bytes, the summary tier (if any), style hints (if the ' +
        'archive was built with --style-hints — per-property percentiles/cardinality, the closest thing ' +
        'to a column schema this format exposes), and a suggested_domain-derived `columns` list. Reads ' +
        'only manifest.json — never fetches directory or pack bytes.',
      inputSchema: {
        name: z.string().describe('Dataset name, as returned by list_datasets'),
      },
    },
    async ({ name }) => {
      try {
        const description = await describeDataset(config.dataRoot, name);
        return textResult(description);
      } catch (err) {
        return errorResult(
          `describe_dataset(${JSON.stringify(name)}) failed: ${errMessage(err)}`,
        );
      }
    },
  );

  server.registerTool(
    'dataset_report',
    {
      title: 'Dataset report (stt-optimize inspect/doctor)',
      description: config.allowCli
        ? 'Runs `stt-optimize inspect` (per-zoom directory stats, dedup/compression ratios, per-column ' +
          'compressed cost) and `stt-optimize doctor` (severity-ranked findings + remediation flags), and ' +
          'optionally `order-audit` (measured blob-ordering range-read cost), against one dataset and ' +
          'returns their parsed JSON output. The decode-dependent stats are SAMPLED to 256 tiles by ' +
          "default (an unsampled full decode can exceed the MCP client's 60s timeout); pass `sample` to " +
          'change the cap, or `exact: true` for a precise full decode. Requires --allow-cli (enabled). ' +
          'Address the archive by `name` (under --data-root) or by an explicit `path` (mutually exclusive).'
        : 'Would run `stt-optimize inspect`/`doctor`/`order-audit` against one dataset, but this server ' +
          'was started WITHOUT --allow-cli — returns a manifest-only summary instead (see describe_dataset ' +
          'for the full manifest). Restart the server with --allow-cli to enable this tool.',
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe(
            'Dataset name under --data-root, as returned by list_datasets — mutually exclusive with `path`',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'Explicit filesystem path to a built archive directory/manifest.json (for archives outside --data-root) — mutually exclusive with `name`; requires --allow-cli',
          ),
        include: z
          .array(z.enum(['inspect', 'doctor', 'order-audit']))
          .optional()
          .describe(
            'Which stt-optimize subcommands to run (default: inspect + doctor)',
          ),
        sample: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Sample at most N tiles for the decode-dependent stats (default: 256; pass `exact` for a full decode)',
          ),
        exact: z
          .boolean()
          .optional()
          .describe(
            'Decode EVERY tile for precise stats (omits --sample) — slower; may exceed the client timeout on large datasets',
          ),
      },
    },
    async ({ name, path: explicitPath, include, sample, exact }, extra) => {
      if (!name && !explicitPath)
        return errorResult('dataset_report requires either `name` or `path`');
      // `name` and `path` are documented as mutually exclusive — reject both
      // rather than silently picking one.
      if (name && explicitPath)
        return errorResult(
          'dataset_report: `name` and `path` are mutually exclusive — pass exactly one (got both).',
        );
      // An explicit path escapes the --data-root sandbox; keep it behind the
      // same trust gate as the other CLI tools so a non-CLI server stays
      // confined to its catalog.
      if (explicitPath && !config.allowCli)
        return errorResult(
          'dataset_report: `path` (an explicit archive path outside --data-root) requires the server to be started with --allow-cli; use `name` for a dataset under --data-root.',
        );

      // Resolve+describe FIRST so a bad target reports a clear "not found"
      // (naming it) rather than being swallowed into the generic --allow-cli
      // hint below.
      let dir: string;
      let manifestSummary: DatasetDescription;
      try {
        if (explicitPath) {
          dir = archiveDirOf(explicitPath);
          manifestSummary = await describeExplicitPath(explicitPath);
        } else {
          dir = resolveDatasetDir(config.dataRoot, name!);
          manifestSummary = await describeDataset(config.dataRoot, name!);
        }
      } catch (err) {
        return errorResult(
          explicitPath
            ? `dataset_report: could not read archive at path "${explicitPath}": ${errMessage(err)}`
            : `dataset_report: dataset "${name}" not found under --data-root (${config.dataRoot}): ${errMessage(err)}`,
        );
      }

      if (!config.allowCli) {
        // Only reachable for `name` (an explicit `path` was rejected above).
        return textResult({
          name,
          path: dir,
          cliEnabled: false,
          message:
            'Enable --allow-cli on the stt-mcp server to run stt-optimize inspect/doctor.',
          manifestSummary,
        });
      }

      const subcommands =
        include && include.length > 0
          ? include
          : (['inspect', 'doctor'] as const);
      const effectiveSample = exact
        ? undefined
        : (sample ?? DEFAULT_STATS_SAMPLE);
      const appliedSampledDefault = !exact && sample === undefined;
      const bin = resolveBinary('stt-optimize', config.sttOptimizeBin, [
        config.dataRoot,
        process.cwd(),
      ]);
      const results: Record<string, unknown> = {};
      let anyFailed = false;
      for (const sub of subcommands) {
        const args = [sub, '--archive', dir, '--format', 'json'];
        // order-audit measures directory range-read cost, not decoded tiles — it has no --sample flag.
        if (effectiveSample !== undefined && sub !== 'order-audit')
          args.push('--sample', String(effectiveSample));
        const result = await run(bin, args, { signal: extra?.signal });
        if (!runFailed(result)) {
          results[sub] = tryParseJson(result.stdout) ?? {
            raw: result.stdout,
            stderr: result.stderr,
          };
        } else {
          anyFailed = true;
          results[sub] = {
            error: `stt-optimize ${sub} exited ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.aborted ? ' (aborted)' : ''}`,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            aborted: result.aborted,
            stderr: result.stderr,
            stdout: result.stdout,
          };
        }
      }
      const payload: Record<string, unknown> = {
        name,
        path: dir,
        cliEnabled: true,
        bin,
        ...results,
      };
      if (appliedSampledDefault) {
        payload.sampledDefault = DEFAULT_STATS_SAMPLE;
        payload.sampledNote = `Decode-dependent stats were sampled to ${DEFAULT_STATS_SAMPLE} tiles by default; pass \`exact: true\` for a precise full decode.`;
      }
      return textResult(payload, anyFailed);
    },
  );
}

// ---------------------------------------------------------------------------
// DOCS — always-on, read-only tools over the PUBLISHED documentation corpus
// (docs/README.md + docs/{intro,architecture,spec,api,guides}/*.md). These do
// NOT shell out (pure in-process file reads), so they are NOT gated behind
// allowCli — an agent (including a published npx install with no repo on disk,
// which reads the bundled <pkg>/docs) can discover and read STT docs directly.
// ---------------------------------------------------------------------------

function registerDocTools(server: McpServer, config: SttMcpConfig): void {
  server.registerTool(
    'get_doc',
    {
      title: 'Read a documentation page',
      description:
        'Returns the text of ONE published STT documentation page (docs/README.md, a *.md file under ' +
        'docs/{intro,architecture,spec,api,guides}, or one of the machine-readable docs/spec/*.json schemas, ' +
        'served verbatim so it can be JSON.parse-d), addressed by its docs-relative path (e.g. ' +
        '"api/cli-reference.md", "guides/ai-suite.md", "spec/manifest.schema.json"). Discover valid paths with search_docs or the ' +
        'stt://docs/<path> resource list. Oversized docs are truncated at `maxBytes` (default ' +
        `${DEFAULT_DOC_MAX_BYTES}) with a "...[truncated]" marker that reports the true byte length. Pure ` +
        'file read — never shells out.',
      inputSchema: {
        path: z
          .string()
          .describe(
            'Docs-relative path, e.g. "api/cli-reference.md" or "README.md" (no absolute paths, no "..")',
          ),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Truncate the doc to this many UTF-8 bytes (default: ${DEFAULT_DOC_MAX_BYTES})`,
          ),
      },
    },
    async ({ path: docPath, maxBytes }) => {
      let text: string;
      try {
        text = await readDoc(config.docsRoot, docPath);
      } catch (err) {
        return errorResult(
          `get_doc(${JSON.stringify(docPath)}) failed: ${errMessage(err)}. ` +
            'Discover valid doc paths with the search_docs tool or the stt://docs/<path> resource list.',
        );
      }
      const cap = maxBytes ?? DEFAULT_DOC_MAX_BYTES;
      const totalBytes = Buffer.byteLength(text, 'utf8');
      if (totalBytes <= cap) {
        return { content: [{ type: 'text', text }] };
      }
      const body = truncateToBytes(text, cap);
      const shownBytes = Buffer.byteLength(body, 'utf8');
      const marker = `\n\n...[truncated] — showing ${shownBytes} of ${totalBytes} bytes; pass a larger \`maxBytes\` for the full page.`;
      return { content: [{ type: 'text', text: body + marker }] };
    },
  );

  server.registerTool(
    'search_docs',
    {
      title: 'Search the documentation',
      description:
        'Case-insensitive substring search across the whole published STT documentation corpus (README + ' +
        'intro/architecture/spec/api/guides). Returns ranked results { path, title, score, snippets: ' +
        '[{ line, text }] } — a few matching lines per doc, ordered by score then path. Pure in-process ' +
        'scan (no shell/grep). Feed a returned `path` to get_doc (or read stt://docs/<path>) for the full ' +
        'page.',
      inputSchema: {
        query: z
          .string()
          .describe(
            'Keyword or phrase to search for (case-insensitive substring match)',
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max matching docs to return (default: 10)'),
      },
    },
    async ({ query, limit }) => {
      const results = await searchDocs(config.docsRoot, query, { limit });
      return textResult({ query, count: results.length, results });
    },
  );
}

// ---------------------------------------------------------------------------
// ANALYSIS — read-only stt-optimize shell-outs. Registered always for
// discoverability; each self-gates on allowCli (no non-CLI fallback exists,
// since these analyze source parquet / built archives the CLIs alone can read).
// ---------------------------------------------------------------------------

function registerAnalysisTools(server: McpServer, config: SttMcpConfig): void {
  server.registerTool(
    'recommend_build',
    {
      title: 'Recommend a build recipe (stt-optimize recommend)',
      description: config.allowCli
        ? 'Analyzes a SOURCE GeoParquet file (a raw input, NOT a built archive) with `stt-optimize ' +
          'recommend` and returns an evidence-backed build recipe: recommended min/max zoom, temporal ' +
          'bucket, a 0-100 confidence score, per-recommendation explanations, and a ready-to-run ' +
          '`stt-build` command. Call this BEFORE hand-writing an stt-build invocation. Requires ' +
          '--allow-cli (enabled).'
        : 'Would analyze a source GeoParquet with `stt-optimize recommend` to suggest an stt-build ' +
          'recipe, but this server was started WITHOUT --allow-cli. Restart with --allow-cli to enable.',
      inputSchema: {
        input: z
          .string()
          .describe(
            'Path to the source GeoParquet file (.parquet/.geoparquet) — a raw input, not a packed archive',
          ),
        timeField: z
          .string()
          .optional()
          .describe('Timestamp column name (default: "timestamp")'),
        timeFormat: z
          .enum(['iso8601', 'unix-ms', 'unix-sec'])
          .optional()
          .describe(
            'How to read an integer time column (Arrow timestamp/string columns are self-describing)',
          ),
        output: z
          .string()
          .optional()
          .describe(
            'Intended output directory, used only to render the suggested stt-build command (default: "out")',
          ),
      },
    },
    async ({ input, timeField, timeFormat, output }, extra) => {
      if (!config.allowCli) {
        return textResult({
          input,
          cliEnabled: false,
          message:
            'Enable --allow-cli on the stt-mcp server to run stt-optimize recommend.',
        });
      }
      const bin = resolveBinary('stt-optimize', config.sttOptimizeBin, [
        config.dataRoot,
        process.cwd(),
      ]);
      const args = ['recommend', '--input', input];
      if (timeField) args.push('--time-field', timeField);
      if (timeFormat) args.push('--time-format', timeFormat);
      const result = await run(bin, args, { signal: extra?.signal });
      const parsed = tryParseJson(result.stdout);
      if (runFailed(result) || !parsed || typeof parsed !== 'object') {
        return errorResult(
          `stt-optimize recommend exited ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.aborted ? ' (aborted)' : ''}\n${result.stderr || result.stdout}`,
        );
      }
      const rec = parsed as RecommendConfig;
      const outputDir = output ?? 'out';
      // Assemble the pasteable command locally: only this side knows the
      // caller's `output` dir and `timeFormat`, and the templater folds in the
      // recipe scalars (zooms, temporal bucket) plus the auto-applicable
      // advisor flags from `rec.advice`. Rust's own `rec.command` (same
      // filtering, input-stem output) still rides inside `recommendation` for
      // CLI parity.
      const suggestedCommand = buildSttBuildCommand(
        input,
        outputDir,
        timeField,
        timeFormat,
        rec,
      );
      const advice = rec.advice ?? [];
      return textResult({
        input,
        cliEnabled: true,
        bin,
        recommendation: rec,
        dominantType: rec.dominant_type,
        suggestedCommand,
        // The evidence the agent should weigh: auto-applicable levers are
        // already folded into suggestedCommand/buildDatasetArgs; lossy and
        // suggestion-only levers (quantization, feature budgets, caveated
        // orderings) are surfaced for a deliberate opt-in and are NEVER
        // auto-applied.
        evidence: advice.map((a) => ({
          ...a,
          autoApplied: adviceAutoApplies(a),
        })),
        // Structured, ready to hand straight to the `build_dataset` tool (same
        // param names/shape) — the machine-readable counterpart of suggestedCommand.
        buildDatasetArgs: buildDatasetArgsFromRecipe(
          input,
          outputDir,
          timeField,
          timeFormat,
          rec,
        ),
      });
    },
  );

  server.registerTool(
    'diff_datasets',
    {
      title: 'Diff two built datasets (stt-optimize diff)',
      description: config.allowCli
        ? 'Compares two BUILT packed archives (before/after) with `stt-optimize diff` and returns the ' +
          "parsed JSON — totals plus per-zoom and per-column byte/feature deltas. NOTE: the report's " +
          '`compressed_bytes` is a LOGICAL addressed-byte sum (deduplicated content-addressed bytes) and ' +
          'can show a shrink even when the archive physically GREW — compare beforePhysicalBytes/' +
          'afterPhysicalBytes (best-effort at-rest object bytes) for the real on-disk delta. The ' +
          'decode-dependent per-column stats are SAMPLED to 256 tiles by default; pass `sample` to change ' +
          'the cap or `exact: true` for a full decode. Use as a regression gate. Requires --allow-cli.'
        : 'Would compare two built archives with `stt-optimize diff`, but this server was started WITHOUT ' +
          '--allow-cli. Restart with --allow-cli to enable.',
      inputSchema: {
        before: z
          .string()
          .describe(
            'Dataset name (under --data-root) or explicit path to the BEFORE archive',
          ),
        after: z
          .string()
          .describe(
            'Dataset name (under --data-root) or explicit path to the AFTER archive',
          ),
        sample: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Sample at most N tiles for the decode-dependent per-column stats (default: 256; pass `exact` for a full decode)',
          ),
        exact: z
          .boolean()
          .optional()
          .describe(
            'Decode EVERY tile for precise per-column stats (omits --sample) — slower; may exceed the client timeout',
          ),
      },
    },
    async ({ before, after, sample, exact }, extra) => {
      if (!config.allowCli) {
        return textResult({
          cliEnabled: false,
          message:
            'Enable --allow-cli on the stt-mcp server to run stt-optimize diff.',
        });
      }
      let beforeDir: string;
      let afterDir: string;
      try {
        beforeDir = resolveArchiveArg(config.dataRoot, before);
        afterDir = resolveArchiveArg(config.dataRoot, after);
      } catch (err) {
        return errorResult(errMessage(err));
      }
      const bin = resolveBinary('stt-optimize', config.sttOptimizeBin, [
        config.dataRoot,
        process.cwd(),
      ]);
      const effectiveSample = exact
        ? undefined
        : (sample ?? DEFAULT_STATS_SAMPLE);
      const appliedSampledDefault = !exact && sample === undefined;
      const args = [
        'diff',
        '--before',
        beforeDir,
        '--after',
        afterDir,
        '--format',
        'json',
      ];
      if (effectiveSample !== undefined)
        args.push('--sample', String(effectiveSample));
      const result = await run(bin, args, { signal: extra?.signal });
      const report = tryParseJson(result.stdout);

      // The Rust report's compressed_bytes is a LOGICAL addressed-byte sum, and its
      // before_name/after_name come from archive metadata (not these args) — surface
      // the caller's own before/after plus a best-effort physical at-rest byte count.
      const beforePhysicalBytes = await describeDataset(beforeDir, '.')
        .then((d) => d.totalBytes)
        .catch(() => undefined);
      const afterPhysicalBytes = await describeDataset(afterDir, '.')
        .then((d) => d.totalBytes)
        .catch(() => undefined);

      return textResult(
        {
          bin,
          requestedBefore: { name: before, dir: beforeDir },
          requestedAfter: { name: after, dir: afterDir },
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          report: report ?? { raw: result.stdout },
          beforePhysicalBytes,
          afterPhysicalBytes,
          note:
            "stt-optimize diff's `compressed_bytes` is a LOGICAL addressed-byte sum (deduplicated " +
            'content-addressed bytes) and may differ in SIGN from the physical archive size — ' +
            "compare beforePhysicalBytes/afterPhysicalBytes for the actual bytes at rest. The report's " +
            'before_name/after_name are archive metadata, not the names/paths you passed (see requestedBefore/requestedAfter).',
          ...(appliedSampledDefault
            ? {
                sampledDefault: DEFAULT_STATS_SAMPLE,
                sampledNote: `Per-column stats were sampled to ${DEFAULT_STATS_SAMPLE} tiles by default; pass \`exact: true\` for a precise full decode.`,
              }
            : {}),
          stderr: result.stderr || undefined,
        },
        runFailed(result),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// RESOURCES — datasets as read-only, URI-addressable context (stt://datasets/<name>).
// Same payload as describe_dataset, but cacheable and enumerable by the client
// without a tool call (0 tokens until read).
// ---------------------------------------------------------------------------

function registerResources(server: McpServer, config: SttMcpConfig): void {
  server.registerResource(
    'dataset',
    new ResourceTemplate('stt://datasets/{name}', {
      // The SDK's ResourceTemplate `list` callback receives only `extra` (no
      // cursor param — it can't page), so a data-root with hundreds of datasets
      // would emit a single unbounded (~40k-token) list. Cap it; the
      // list_datasets tool (with its `search` filter) is the paging-capable path
      // to the full catalog.
      list: async () => {
        const datasets = await scanDatasets(config.dataRoot).catch(() => []);
        const capped = datasets.slice(0, RESOURCE_LIST_CAP);
        const truncated = datasets.length > capped.length;
        return {
          resources: capped.map((d) => ({
            uri: `stt://datasets/${encodeURIComponent(d.name)}`,
            name: d.name,
            title: d.name,
            mimeType: 'application/json',
            description:
              `STT dataset "${d.name}"` +
              (d.timeRange
                ? `, ${new Date(d.timeRange.start).toISOString()}…${new Date(d.timeRange.end).toISOString()}`
                : '') +
              (d.hasSummaryTier
                ? `, ${d.summaryScheme ?? 'summary'} tier`
                : ''),
          })),
          ...(truncated
            ? {
                _meta: {
                  truncated: true,
                  total: datasets.length,
                  returned: capped.length,
                  note: `Only the first ${RESOURCE_LIST_CAP} of ${datasets.length} datasets are listed here — use the list_datasets tool (with its \`search\` filter) for the full catalog.`,
                },
              }
            : {}),
        };
      },
    }),
    {
      title: 'STT dataset manifest',
      description:
        'The full parsed manifest.json for one packed STT dataset (same payload as the describe_dataset ' +
        'tool), addressable as stt://datasets/<name>. Read-only; reads manifest.json only.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const rawName = Array.isArray(variables.name)
        ? variables.name[0]
        : variables.name;
      const name = decodeURIComponent(String(rawName));
      const description = await describeDataset(config.dataRoot, name);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(description, null, 2),
          },
        ],
      };
    },
  );

  // Documentation corpus as read-only, URI-addressable context
  // (stt://docs/<path>). Mirrors the dataset resource above: the `list`
  // callback can't page, so cap it (search_docs is the paging-capable path).
  // The `<path>` is a single, percent-encoded segment (`/` → %2F), exactly like
  // the dataset resource's `<name>`, so a multi-segment doc path stays one
  // template variable.
  server.registerResource(
    'doc',
    new ResourceTemplate('stt://docs/{path}', {
      list: async () => {
        const docs = await listCorpusDocs(config.docsRoot).catch(() => []);
        const capped = docs.slice(0, RESOURCE_LIST_CAP);
        const truncated = docs.length > capped.length;
        return {
          resources: capped.map((d) => ({
            uri: `stt://docs/${encodeURIComponent(d.path)}`,
            name: d.path,
            title: d.title,
            mimeType: d.mimeType,
            description: `STT documentation: ${d.title} (${d.path})`,
          })),
          ...(truncated
            ? {
                _meta: {
                  truncated: true,
                  total: docs.length,
                  returned: capped.length,
                  note: `Only the first ${RESOURCE_LIST_CAP} of ${docs.length} docs are listed here — use the search_docs tool to find the rest.`,
                },
              }
            : {}),
        };
      },
    }),
    {
      title: 'STT documentation',
      description:
        'The published STT documentation corpus (README + intro/architecture/spec/api/guides prose, plus the ' +
        'machine-readable spec/*.json schemas), addressable as stt://docs/<path>. Read-only; also searchable ' +
        'via search_docs and readable via get_doc. Each entry carries its own mimeType in the resource list.',
      // Template-level default for the markdown majority; the read handler
      // labels each response with its actual per-entry type.
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const rawPath = Array.isArray(variables.path)
        ? variables.path.join('/')
        : variables.path;
      const requested = decodeURIComponent(String(rawPath));
      const text = await readDoc(config.docsRoot, requested);
      // Label per entry, not per template: the corpus is markdown PLUS the
      // `spec/*.json` schemas, and `docMimeType` is the same classifier
      // `listCorpusDocs` labels the resource list with — so list and read can
      // never disagree about what a given URI serves.
      return {
        contents: [{ uri: uri.href, mimeType: docMimeType(requested), text }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// INTERACTIVE
// ---------------------------------------------------------------------------

const viewStateShape = {
  longitude: z.number().optional(),
  latitude: z.number().optional(),
  zoom: z.number().optional(),
  pitch: z.number().optional(),
  bearing: z.number().optional(),
};

function registerInteractiveTools(
  server: McpServer,
  config: SttMcpConfig,
): void {
  server.registerTool(
    'view_map',
    {
      title: 'Compose a view_map spec',
      description:
        'Composes a @deck.gl/json-shaped deck spec ({layers: [{"@@type": ..., data: <manifest URL>, ' +
        '...}], initialViewState}) for one or more datasets, pointed at their manifest.json (as an ' +
        'absolute filesystem path, or under --public-base-url when configured). The @@type is inferred ' +
        'per dataset from its manifest style_hints.layer_hint (now baked on EVERY build) or summary-tier ' +
        'scheme. NOTE: archives built before layer_hint became a default carry none, so inference falls ' +
        'back to AnimatedPointLayer — for those, explicitly pass `layer` (AnimatedPathLayer / ' +
        'AnimatedTripsLayer / AnimatedPolygonLayer) or rebuild. Beyond the layer, an optional `intent` ' +
        '(density/tracking/flow/magnitude/choropleth/exploratory) — which can PROMOTE the layer to ' +
        'AnimatedArcLayer (flow) or AnimatedColumnLayer (magnitude) when the geometry supports it — plus ' +
        '`colorBy`/`timeWindow` drive a data-derived ' +
        'presentation (color domain from measured percentiles, visible window from the temporal grain, ' +
        'summary tier when framed coarse). Register these @@type names with @deck.gl/json (a ' +
        'JSONConfiguration carrying the STT layer classes) to actually instantiate the layers client-side. ' +
        'Address datasets by `datasets` (name(s) under --data-root) and/or `paths` (explicit archive ' +
        'path(s) outside --data-root; requires --allow-cli). ' +
        'Always returns the spec as text; when the client renders MCP resource content blocks, ALSO ' +
        'returns a best-effort self-contained HTML page (CDN deck.gl + @deck.gl/json). Unknown top-level keys are ' +
        'rejected (this schema is strict) so a misspelled param — e.g. `viewstate` for `viewState` — ' +
        'errors instead of being silently ignored.',
      // A STRICT Zod object (not a bare raw shape): the SDK strips unknown keys
      // from a non-strict shape, so a typo like `viewstate` would be silently
      // dropped (leaving zoom/camera at defaults). `.strict()` turns that into a
      // clear "Unrecognized key" validation error the agent can see and fix.
      inputSchema: z
        .object({
          datasets: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe(
              'One dataset name, or a list of names, as returned by list_datasets (under --data-root)',
            ),
          paths: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe(
              'Explicit filesystem path(s) to built archive directory/manifest.json, for archives OUTSIDE --data-root (e.g. a fresh build_dataset output). Requires --allow-cli.',
            ),
          layer: z
            .string()
            .optional()
            .describe(
              'Force this @@type for every dataset (overrides both inference and any intent-driven layer promotion)',
            ),
          intent: z
            .enum(PRESENTATION_INTENTS)
            .optional()
            .describe(
              'Desired presentation, biasing layer/color/tier/timeWindow: ' +
                '"density" (summary/H3 tier + count weighting), "tracking" (trips + longer trails), ' +
                '"flow" (origin→destination arcs, AnimatedArcLayer, on OD line geometry), ' +
                '"magnitude" (extruded 3D columns, AnimatedColumnLayer, on point geometry), ' +
                '"choropleth" (measure-driven color), or "exploratory" (neutral default). ' +
                'A layer promotion applies only when the geometry supports it (else the base layer ' +
                'is kept and an advisory explains why). `layer`/`colorBy`/`timeWindow` always override the bias.',
            ),
          colorBy: z
            .string()
            .optional()
            .describe(
              'Force the color-by property for every dataset (overrides the auto pick from measured columns). ' +
                'Only takes effect on layers with a scalar color domain (summary/heatmap: weightProperty; trips: gradientProperty).',
            ),
          timeWindow: z
            .number()
            .optional()
            .describe(
              'Force the visible time window in ms around currentTime (overrides the temporal-grain-derived default)',
            ),
          viewState: z.object(viewStateShape).partial().optional(),
          time: z
            .number()
            .optional()
            .describe('currentTime (Unix ms) applied to every layer'),
        })
        .strict(),
    },
    async ({
      datasets,
      paths,
      layer,
      intent,
      colorBy,
      timeWindow,
      viewState,
      time,
    }) => {
      const names = datasets ? asArray(datasets) : [];
      const explicitPaths = paths ? asArray(paths) : [];
      if (names.length === 0 && explicitPaths.length === 0) {
        return errorResult(
          'view_map requires `datasets` (name(s) under --data-root) and/or `paths` (explicit archive path(s)).',
        );
      }
      // An explicit path escapes the --data-root sandbox; gate it behind the
      // same trust requirement as the other CLI tools.
      if (explicitPaths.length > 0 && !config.allowCli) {
        return errorResult(
          'view_map: `paths` (explicit archive paths outside --data-root) require the server to be started with --allow-cli; use `datasets` for datasets under --data-root.',
        );
      }
      const resolved: DatasetDescription[] = [];
      const errors: string[] = [];
      for (const name of names) {
        try {
          resolved.push(await describeDataset(config.dataRoot, name));
        } catch (err) {
          errors.push(`${name}: ${errMessage(err)}`);
        }
      }
      for (const explicitPath of explicitPaths) {
        try {
          resolved.push(await describeExplicitPath(explicitPath));
        } catch (err) {
          errors.push(`${explicitPath}: ${errMessage(err)}`);
        }
      }
      if (resolved.length === 0) {
        return errorResult(
          `view_map: no datasets resolved.\n${errors.join('\n')}`,
        );
      }

      const { spec, html, warnings } = buildViewMap(resolved, {
        layer,
        intent,
        colorBy,
        timeWindow,
        viewState,
        time,
        publicBaseUrl: config.publicBaseUrl,
      });

      const content: CallToolResult['content'] = [
        { type: 'text', text: JSON.stringify(spec, null, 2) },
      ];
      try {
        const label = [...names, ...explicitPaths].join('+');
        content.push({
          type: 'resource',
          resource: {
            uri: `ui://stt-mcp/view-map/${encodeURIComponent(label)}.html`,
            mimeType: 'text/html',
            text: html,
          },
        });
      } catch {
        // HTML is best-effort only — the text spec above is always authoritative.
      }
      // Surface buildViewMap's caveats (layer-type inference fell back to a
      // default; a manifest URL most hosts can't actually fetch; etc.) so the
      // agent sees them rather than silently shipping a spec that won't render.
      if (warnings && warnings.length > 0) {
        content.push({
          type: 'text',
          text: `Warnings:\n${warnings.map((w) => `- ${w}`).join('\n')}`,
        });
      }
      if (errors.length > 0) {
        content.push({
          type: 'text',
          text: `Note: some datasets failed to resolve:\n${errors.join('\n')}`,
        });
      }
      return { content };
    },
  );

  server.registerTool(
    'set_time',
    {
      title: 'Set playback time',
      description:
        'This server has no live renderer to drive — this tool just returns the intended playback ' +
        'state as a structured intent for a client to apply (e.g. by re-calling view_map with the new ' +
        '`time`, or by driving its own STTPlayer/PlaybackGovernor instance).',
      inputSchema: {
        time: z.number().describe('Unix ms timestamp to seek to'),
      },
    },
    async ({ time }) => textResult({ intent: 'set_time', time }),
  );

  server.registerTool(
    'play_pause',
    {
      title: 'Play or pause',
      description:
        'This server has no live renderer to drive — this tool just returns the intended playback ' +
        'state as a structured intent for a client to apply.',
      inputSchema: {
        playing: z.boolean(),
        speed: z
          .number()
          .positive()
          .optional()
          .describe('Playback speed multiplier (default: client-chosen)'),
      },
    },
    async ({ playing, speed }) =>
      textResult({ intent: 'play_pause', playing, speed }),
  );
}

// ---------------------------------------------------------------------------
// EXECUTION (only registered when config.allowCli): build_dataset,
// validate_dataset, generate_dataset (stt-generate). These spawn a CLI that
// writes to disk / the network.
// ---------------------------------------------------------------------------

function registerExecutionTools(server: McpServer, config: SttMcpConfig): void {
  server.registerTool(
    'build_dataset',
    {
      title: 'Build a dataset (stt-build)',
      description:
        'Shells out to `stt-build` to construct a new packed STT dataset from a GeoParquet input. ' +
        'Long-running (no streaming — returns final stdout/stderr + the resulting manifest summary). ' +
        'Only registered because --allow-cli is enabled.',
      inputSchema: {
        input: z
          .string()
          .describe('Input GeoParquet file path (.parquet/.geoparquet)'),
        output: z.string().describe('Output packed-dataset directory'),
        timeField: z
          .string()
          .optional()
          .describe('Timestamp column name (default: "timestamp")'),
        timeFormat: z
          .enum(['iso8601', 'unix-ms', 'unix-sec'])
          .optional()
          .describe(
            'How to read an integer time column (Arrow timestamp/string columns are self-describing)',
          ),
        minZoom: z.number().int().min(0).max(24).optional(),
        maxZoom: z.number().int().min(0).max(24).optional(),
        temporalBucket: z
          .string()
          .optional()
          .describe('e.g. "1h", "6h", "1d", "30m" (default: "1h")'),
        summaryTier: z
          .enum(['h3', 'quadbin'])
          .optional()
          .describe('Emit a pre-aggregated summary tier'),
        styleHints: z
          .boolean()
          .optional()
          .describe('Bake per-property style hints (percentiles/cardinality)'),
        publish: z
          .boolean()
          .optional()
          .describe('Deploy-ready build (zstd level 19)'),
        name: z.string().optional().describe('Archive name (metadata)'),
        description: z
          .string()
          .optional()
          .describe('Archive description (metadata)'),
        attribution: z
          .string()
          .optional()
          .describe('Attribution text (metadata)'),
        extraArgs: z
          .array(z.string())
          .optional()
          .describe('Additional raw stt-build flags, passed through verbatim'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Kill the build after this many ms (default: 10 minutes)'),
      },
    },
    async (params, extra) => {
      const bin = resolveBinary('stt-build', config.sttBuildBin, [
        config.dataRoot,
        process.cwd(),
      ]);
      const args: string[] = [
        '--input',
        params.input,
        '--output',
        params.output,
      ];
      if (params.timeField) args.push('--time-field', params.timeField);
      if (params.timeFormat) args.push('--time-format', params.timeFormat);
      if (params.minZoom !== undefined)
        args.push('--min-zoom', String(params.minZoom));
      if (params.maxZoom !== undefined)
        args.push('--max-zoom', String(params.maxZoom));
      if (params.temporalBucket)
        args.push('--temporal-bucket', params.temporalBucket);
      if (params.summaryTier) args.push('--summary-tier', params.summaryTier);
      if (params.styleHints) args.push('--style-hints');
      if (params.publish) args.push('--publish');
      if (params.name) args.push('--name', params.name);
      if (params.description) args.push('--description', params.description);
      if (params.attribution) args.push('--attribution', params.attribution);
      if (params.extraArgs) args.push(...params.extraArgs);

      const result = await run(bin, args, {
        timeoutMs: params.timeoutMs ?? 600_000,
        signal: extra?.signal,
      });

      let manifestSummary: unknown;
      if (result.exitCode === 0) {
        try {
          // `describeDataset(dataRoot, name)` resolves `path.resolve(dataRoot, name)`;
          // passing the build's own output dir as `dataRoot` with name `'.'`
          // resolves back to that exact directory regardless of trailing
          // slashes/relative-vs-absolute form.
          manifestSummary = await describeDataset(params.output, '.');
        } catch (err) {
          manifestSummary = {
            error: `build succeeded but could not read the resulting manifest: ${errMessage(err)}`,
          };
        }
      }

      return textResult(
        {
          bin,
          args,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          manifestSummary,
        },
        runFailed(result),
      );
    },
  );

  server.registerTool(
    'validate_dataset',
    {
      title: 'Validate a dataset (stt-validate)',
      description:
        'Shells out to `stt-validate` (content addressing, directory structure, per-tile CRC, schema/ ' +
        'column contract, temporal-bound sanity) against a dataset and returns its parsed JSON report. ' +
        'Only registered because --allow-cli is enabled.',
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe(
            'Dataset name (as returned by list_datasets) — mutually exclusive with `path`',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'Explicit filesystem path to a dataset directory/manifest.json/.sttb — mutually exclusive with `name`',
          ),
        sample: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Sample at most N tiles for the decode-dependent checks'),
        skipDecode: z
          .boolean()
          .optional()
          .describe(
            'Skip the per-tile Arrow decode (header/integrity/index/hash checks only)',
          ),
        failFast: z
          .boolean()
          .optional()
          .describe('Stop after the first failing tile'),
      },
    },
    async (
      { name, path: explicitPath, sample, skipDecode, failFast },
      extra,
    ) => {
      if (!name && !explicitPath)
        return errorResult('validate_dataset requires either `name` or `path`');
      // `name` and `path` are documented as mutually exclusive — reject both
      // rather than silently dropping `path` (the previously ignored one).
      if (name && explicitPath) {
        return errorResult(
          'validate_dataset: `name` and `path` are mutually exclusive — pass exactly one (got both).',
        );
      }
      let archive: string;
      try {
        archive = name
          ? resolveDatasetDir(config.dataRoot, name)
          : explicitPath!;
      } catch (err) {
        return errorResult(errMessage(err));
      }

      const bin = resolveBinary('stt-validate', config.sttValidateBin, [
        config.dataRoot,
        process.cwd(),
      ]);
      const args = [archive, '--json'];
      if (sample !== undefined) args.push('--sample', String(sample));
      if (skipDecode) args.push('--skip-decode');
      if (failFast) args.push('--fail-fast');

      const result = await run(bin, args, { signal: extra?.signal });
      const parsed = tryParseJson(result.stdout);
      return textResult(
        {
          bin,
          archive,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          report: parsed ?? { raw: result.stdout },
          stderr: result.stderr || undefined,
        },
        runFailed(result),
      );
    },
  );

  server.registerTool(
    'generate_dataset',
    {
      title: 'Generate a reference dataset (stt-generate)',
      description:
        'Shells out to `stt-generate <dataset>` to DOWNLOAD and build one of the bundled reference/showcase ' +
        'datasets (earthquakes, hurricanes, drifters, gtfs, nwm, satellites, …) into a packed `.stt`. ' +
        'Network-bound and long-running. One dataset per call — most take source-specific flags ' +
        '(e.g. `--date YYYY-MM-DD`, `--start`/`--end`, `--synthetic`) — forward them ' +
        'through `extraArgs`; run `stt-generate <dataset> --help` for the exact set. To build a `.stt` from ' +
        'YOUR OWN data, use `build_dataset` (stt-build) instead. Only registered because --allow-cli is enabled.',
      inputSchema: {
        dataset: z
          .enum(STT_GENERATE_DATASETS)
          .describe(
            'Which bundled generator to run (the stt-generate subcommand)',
          ),
        output: z
          .string()
          .optional()
          .describe(
            'Output path for the generated `.stt`. Omit to use the generator default.',
          ),
        extraArgs: z
          .array(z.string())
          .optional()
          .describe(
            'Dataset-specific flags passed verbatim, e.g. ["--date","2024-01-01"], ["--synthetic","--num-trips","1000"], ["--skip-existing"]',
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Kill the generation after this many ms (default: 15 minutes — these download source data)',
          ),
      },
    },
    async ({ dataset, output, extraArgs, timeoutMs }, extra) => {
      const bin = resolveBinary('stt-generate', config.sttGenerateBin, [
        config.dataRoot,
        process.cwd(),
      ]);
      const args: string[] = [dataset];
      // Every subcommand takes `--output <file.stt>` (the old `all` fan-out,
      // which took `--output-dir`, no longer exists in the generator).
      if (output) args.push('--output', output);
      if (extraArgs) args.push(...extraArgs);

      const result = await run(bin, args, {
        timeoutMs: timeoutMs ?? 900_000,
        signal: extra?.signal,
      });

      let manifestSummary: unknown;
      if (result.exitCode === 0 && output) {
        try {
          manifestSummary = await describeDataset(output, '.');
        } catch (err) {
          manifestSummary = {
            note: `generation succeeded but could not read the resulting manifest: ${errMessage(err)}`,
          };
        }
      }

      return textResult(
        {
          bin,
          dataset,
          args,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          manifestSummary,
        },
        runFailed(result),
      );
    },
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Formats a millisecond duration as stt-build's `--temporal-bucket` grammar (`1d`/`6h`/`30m`/`45s`; falls back to `<n>ms`). */
function msToHumanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '1h';
  const units: Array<[number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [size, suffix] of units) {
    if (ms % size === 0) return `${ms / size}${suffix}`;
  }
  return `${ms}ms`;
}

/** Minimal POSIX-shell quoting for the human-readable `suggestedCommand` string (display only — never executed). */
function shellQuote(value: string): string {
  return /[^\w@%+=:,./-]/.test(value)
    ? `'${value.replace(/'/g, `'\\''`)}'`
    : value;
}

/**
 * Auto-apply gate shared by the command templater, `buildDatasetArgs`, and the
 * `autoApplied` evidence stamp: lossy levers degrade data and suggestion-only
 * levers carry a tradeoff the user must decide — neither ever rides the
 * automatic path.
 */
function adviceAutoApplies(a: RecommendAdvice): boolean {
  return !a.lossy && !a.suggestion_only;
}

/**
 * Renders the `stt-build` command a `recommend_build` recipe implies (canonical
 * flags: `--min-zoom`/`--max-zoom`/`--temporal-bucket`), with the recipe's
 * auto-applicable advisor flags (blob-ordering, temporal-LOD, publish, …)
 * appended in advisor order.
 */
function buildSttBuildCommand(
  input: string,
  output: string,
  timeField: string | undefined,
  timeFormat: string | undefined,
  rec: RecommendConfig,
): string {
  const parts = [
    'stt-build',
    '-i',
    shellQuote(input),
    '-o',
    shellQuote(output),
  ];
  if (timeField) parts.push('-t', shellQuote(timeField));
  if (timeFormat) parts.push('--time-format', timeFormat);
  if (rec.min_zoom !== undefined)
    parts.push('--min-zoom', String(rec.min_zoom));
  if (rec.max_zoom !== undefined)
    parts.push('--max-zoom', String(rec.max_zoom));
  if (rec.temporal_bucket_ms)
    parts.push('--temporal-bucket', msToHumanDuration(rec.temporal_bucket_ms));
  parts.push('--style-hints');
  for (const a of rec.advice ?? []) {
    if (!adviceAutoApplies(a) || a.flag === '--style-hints') continue;
    parts.push(a.flag);
    if (a.value) parts.push(shellQuote(a.value));
  }
  return parts.join(' ');
}

/** Flags whose presence in the advice implies the dataset carries color-by-worthy
 *  attributes, so full `--style-hints` percentile profiling is worth requesting. */
const STYLE_HINT_SIGNAL_FLAGS = new Set([
  '--style-hints',
  '--summary-tier',
  '--min-zoom-field',
  '--quantize-attrs-auto',
]);

/**
 * Folds the recipe's NON-LOSSY advisor flags into `build_dataset`-tool params
 * (`--publish`→`publish`, `--summary-tier`→`summaryTier`, `--style-hints`→
 * `styleHints`) and passes any other reversible flag through `extraArgs`
 * verbatim (e.g. `--blob-ordering`, `--temporal-lod`, `--adaptive-temporal`).
 * LOSSY levers (quantization, feature budgets) are deliberately skipped — they
 * degrade data and stay a human opt-in. Also decides whether full percentile
 * `styleHints` is worth requesting: yes whenever the advice signals attribute
 * richness (or the advice is absent, preserving the old always-on behavior for
 * an older stt-optimize) — `layer_hint` itself now ships in every manifest by
 * default, so this flag is only about color-by percentiles.
 */
function applyAdviceToBuildArgs(
  out: Record<string, unknown>,
  advice: RecommendAdvice[] | undefined,
): void {
  if (advice === undefined) {
    out.styleHints = true; // legacy stt-optimize: no advice array to reason from.
    return;
  }
  const extra: string[] = [];
  let styleHints = advice.some((a) => STYLE_HINT_SIGNAL_FLAGS.has(a.flag));
  for (const a of advice) {
    // Never auto-apply a data-degrading or suggestion-only lever — the latter
    // is non-lossy but carries a tradeoff (playback-vs-layout, prerequisite
    // transform) only the user can decide.
    if (!adviceAutoApplies(a)) continue;
    switch (a.flag) {
      case '--publish':
        out.publish = true;
        break;
      case '--style-hints':
        styleHints = true;
        break;
      case '--summary-tier':
        if (a.value === 'h3' || a.value === 'quadbin')
          out.summaryTier = a.value;
        break;
      default:
        extra.push(a.flag);
        if (a.value) extra.push(a.value);
    }
  }
  if (styleHints) out.styleHints = true;
  if (extra.length > 0) out.extraArgs = extra;
}

/**
 * Structured `build_dataset`-tool arguments derived from a `recommend_build`
 * recipe — same param names/shape the `build_dataset` tool takes, so an agent
 * can pass this object straight through without re-parsing the human-readable
 * `suggestedCommand` string. Keys are omitted when the recipe left them unset.
 */
function buildDatasetArgsFromRecipe(
  input: string,
  output: string,
  timeField: string | undefined,
  timeFormat: string | undefined,
  rec: RecommendConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = { input, output };
  if (timeField) out.timeField = timeField;
  if (timeFormat) out.timeFormat = timeFormat;
  if (rec.min_zoom !== undefined) out.minZoom = rec.min_zoom;
  if (rec.max_zoom !== undefined) out.maxZoom = rec.max_zoom;
  if (rec.temporal_bucket_ms)
    out.temporalBucket = msToHumanDuration(rec.temporal_bucket_ms);
  applyAdviceToBuildArgs(out, rec.advice);
  return out;
}

/**
 * Resolves a `diff_datasets` before/after arg: a dataset name under
 * `--data-root` resolves with path-traversal containment; an explicit
 * absolute/outside path falls through as-is (acceptable — `diff` is read-only
 * and only reachable with `--allow-cli`).
 */
function resolveArchiveArg(dataRoot: string, value: string): string {
  try {
    return resolveDatasetDir(dataRoot, value);
  } catch {
    return value;
  }
}

/**
 * Strips a trailing `/manifest.json` (callers may pass either the archive
 * directory or the manifest file itself) and returns the archive directory.
 */
function archiveDirOf(explicitPath: string): string {
  return explicitPath.replace(/[/\\]manifest\.json$/, '');
}

/**
 * Describes an archive addressed by an explicit filesystem `path` (outside
 * `--data-root`). Passing the archive dir as `dataRoot` with name `.` resolves
 * back to that exact directory, reusing `describeDataset`'s containment check
 * against itself (always trivially contained). Callers MUST gate this on
 * `config.allowCli` — an explicit path escapes the `--data-root` sandbox, so it
 * carries the same trust requirement as the other CLI-gated tools.
 */
function describeExplicitPath(
  explicitPath: string,
): Promise<DatasetDescription> {
  return describeDataset(archiveDirOf(explicitPath), '.');
}
