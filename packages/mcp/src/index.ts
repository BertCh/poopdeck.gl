// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * `@poopdeck.gl/mcp` — an open, self-hostable MCP (Model Context Protocol)
 * server for spatiotemporal tiles (design record:
 * `docs/roadmap/ai-suite-skills-mcp-2026-07.md`). Most consumers want the
 * `stt-mcp` CLI (see the README); this entry point is for embedding the
 * server programmatically (custom transports, tests) or reusing the
 * dataset-catalog helpers directly.
 */
export { createSttMcpServer } from './server.js';
export { buildSystemPrompt } from './system-prompt.js';
export {
  scanDatasets,
  describeDataset,
  readManifest,
  resolveDatasetDir,
} from './manifest.js';
export type {
  DatasetSummary,
  DatasetDescription,
  DatasetColumnSummary,
  RawManifest,
  BoundingBox,
  TimeRange,
} from './manifest.js';
export {
  listCorpusDocs,
  readDoc,
  resolveDocPath,
  searchDocs,
  truncateToBytes,
  PUBLISHED_DOC_DIRS,
  ROOT_DOC,
  DEFAULT_DOC_MAX_BYTES,
} from './docs.js';
export type { DocEntry, DocSnippet, DocSearchResult } from './docs.js';
export { buildViewMap, inferLayerType, resolveManifestUrl } from './view-map.js';
export type { ViewState, ViewMapOptions, ViewMapResult } from './view-map.js';
export { parseCliArgs, HelpRequested, USAGE } from './config.js';
export type { SttMcpConfig, TransportKind } from './config.js';
export { resolveBinary, run, tryParseJson } from './cli-runner.js';
export type { RunResult } from './cli-runner.js';
