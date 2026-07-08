/**
 * Build-time bundling of the repo's documentation markdown.
 *
 * The glob climbs out of the app root to `<repo>/docs` — this works in dev
 * because Vite's default `server.fs.allow` is the pnpm WORKSPACE root (via
 * searchForWorkspaceRoot), not the app root. If `server.fs.allow` is ever set
 * explicitly in vite.config.ts, the docs dirs must be added to it.
 *
 * The pattern is deliberately RESTRICTED to the five published dirs +
 * README: a bare `docs/**` would bundle roadmap/ and the internal audit docs
 * into shipped chunks even though no route serves them. The docs-manifest
 * contract test enforces glob ↔ manifest consistency.
 *
 * Lazy (no `eager`): Rollup emits one tiny chunk per markdown file, fetched
 * only when its page is visited.
 */

export const docModules = import.meta.glob(
  [
    '../../../../docs/README.md',
    '../../../../docs/{intro,architecture,spec,api,guides}/*.md',
  ],
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

const GLOB_PREFIX = '../../../../docs/';

/** Glob key → docs-relative file path ("api/cli-reference.md"). */
export function globKeyToFile(key: string): string {
  return key.startsWith(GLOB_PREFIX) ? key.slice(GLOB_PREFIX.length) : key;
}

/** Loader for a docs-relative markdown file, or undefined if not bundled. */
export function fileLoader(file: string): (() => Promise<string>) | undefined {
  return docModules[GLOB_PREFIX + file];
}

/** All bundled docs-relative file paths. */
export function bundledDocFiles(): string[] {
  return Object.keys(docModules).map(globKeyToFile);
}

/**
 * The manifest JSON schema is the one non-markdown doc page; a static `?raw`
 * import keeps it in the docs chunk (it's a few KB).
 */
export { default as manifestSchemaRaw } from '../../../../docs/spec/manifest.schema.json?raw';
