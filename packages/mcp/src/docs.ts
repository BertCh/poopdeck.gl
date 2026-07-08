// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * The PUBLISHED documentation corpus, surfaced to agents talking to the MCP
 * server (design record: `docs/roadmap/ai-suite-skills-mcp-2026-07.md`). The
 * corpus is exactly `docs/README.md` plus every `*.md` DIRECTLY under
 * `docs/{intro,architecture,spec,api,guides}` — the same "published" set the
 * showcase site renders (`examples/showcase/src/docs/content.ts`). It
 * deliberately EXCLUDES `docs/roadmap/` (internal audits / design records).
 *
 * `docsRoot` points at a `docs/` directory: either the copy BUNDLED beside the
 * installed package (so an `npx`/global install works with no repo on disk —
 * see `scripts/copy-docs.mjs`) or the repo's own `docs/` in a dev checkout.
 * Reads only the corpus markdown files; never anything outside it.
 */
import { promises as fs, realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';

/** The five doc directories whose direct `*.md` children are published (mirrors examples/showcase/src/docs/content.ts). */
export const PUBLISHED_DOC_DIRS = ['intro', 'architecture', 'spec', 'api', 'guides'] as const;

/** The one published doc at the docs-root itself. */
export const ROOT_DOC = 'README.md';

/** Default byte cap the `get_doc` tool applies before truncating (keeps a single doc well under a typical MCP client's response budget). */
export const DEFAULT_DOC_MAX_BYTES = 40_000;

const DEFAULT_SEARCH_LIMIT = 10;
/** Max snippets kept per matching doc (a few lines is enough to judge relevance). */
const MAX_SNIPPETS_PER_DOC = 3;
/** Max snippets across the WHOLE `search_docs` response — bounds the token cost regardless of how many docs match. */
const MAX_TOTAL_SNIPPETS = 24;
/** Single-line snippet text is clamped to this many characters so one long line can't blow the budget. */
const MAX_SNIPPET_CHARS = 200;

/** One corpus doc: its docs-root-relative POSIX path, a human title, and its markdown mime type. */
export interface DocEntry {
  /** POSIX path relative to `docsRoot` (e.g. `api/cli-reference.md`) — the `path` every doc tool/resource takes. */
  path: string;
  title: string;
  mimeType: 'text/markdown';
}

export interface DocSnippet {
  /** 1-indexed line number of the match within the doc. */
  line: number;
  text: string;
}

export interface DocSearchResult {
  path: string;
  title: string;
  /** Number of substring occurrences of the query across the doc (higher = more relevant). */
  score: number;
  snippets: DocSnippet[];
}

/**
 * True when `rel` (a `docsRoot`-relative path, in either OS or POSIX form) is a
 * member of the published corpus: `README.md` at the root, or a DIRECT `*.md`
 * child of one of {@link PUBLISHED_DOC_DIRS}. Nested paths and non-`.md` files
 * are rejected — this is the allow-list that keeps `docs/roadmap/` (and any
 * other sibling) unreadable through the server.
 */
function isCorpusRelPath(rel: string): boolean {
  const posix = rel.split(path.sep).join('/');
  if (posix === ROOT_DOC) return true;
  const parts = posix.split('/');
  if (parts.length !== 2) return false;
  if (!parts[1].endsWith('.md')) return false;
  return (PUBLISHED_DOC_DIRS as readonly string[]).includes(parts[0]);
}

/**
 * Resolves an agent-supplied doc `path` against `docsRoot`, rejecting anything
 * that is not a published corpus file. `path` crosses a trust boundary (an LLM
 * tool-call / resource-URI argument), so containment is CHECKED, not assumed:
 *
 *  - absolute paths are rejected outright;
 *  - the resolved target must stay under `docsRoot` (lexical `..` check);
 *  - it must be a corpus member (see {@link isCorpusRelPath} — `.md` only, no
 *    nested dirs, no `docs/roadmap/`);
 *  - a symlink INSIDE `docsRoot` pointing OUT is defeated by re-checking the
 *    canonicalized (`realpath`) prefixes.
 */
export function resolveDocPath(docsRoot: string, requestedPath: string): string {
  const requested = String(requestedPath);
  if (path.isAbsolute(requested)) {
    throw new Error(`doc path "${requested}" must be relative to the docs root (no absolute paths)`);
  }
  const resolvedRoot = path.resolve(docsRoot);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`doc path "${requested}" resolves outside the docs root`);
  }
  if (!isCorpusRelPath(relative)) {
    throw new Error(
      `doc path "${requested}" is not a published doc — expected "${ROOT_DOC}" or one of ` +
        `${PUBLISHED_DOC_DIRS.map((d) => `${d}/<file>.md`).join(', ')}`,
    );
  }
  // Symlink-aware re-check: canonicalize the root and the target (or its nearest
  // existing ancestor, if the leaf does not exist) and confirm containment holds
  // through any symlink the lexical check above cannot see.
  const canonicalRoot = realpathOfNearestExisting(resolvedRoot);
  const canonicalResolved = realpathOfNearestExisting(resolved);
  const canonicalRelative = path.relative(canonicalRoot, canonicalResolved);
  if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
    throw new Error(`doc path "${requested}" resolves outside the docs root`);
  }
  return resolved;
}

/**
 * `fs.realpathSync` of `p`, or — when `p` (or a suffix) does not exist yet
 * (ENOENT) — of its nearest existing ancestor. A non-existent suffix cannot
 * hold a symlink (no inode), so canonicalizing the existing prefix suffices for
 * a containment check. Mirrors the same helper in `manifest.ts`.
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

/** Reads the first `# ` H1 heading of a markdown file for a human title, falling back to the file's basename. */
async function docTitle(absPath: string, rel: string): Promise<string> {
  try {
    const text = await fs.readFile(absPath, 'utf8');
    const m = /^#\s+(.+?)\s*$/m.exec(text);
    if (m) return m[1].trim();
  } catch {
    // fall through to the basename
  }
  return path.basename(rel);
}

/**
 * Enumerates the published corpus files actually present under `docsRoot`, in a
 * stable order (`README.md` first, then {@link PUBLISHED_DOC_DIRS} in declared
 * order, files sorted within each). Missing dirs are skipped silently.
 */
export async function listCorpusDocs(docsRoot: string): Promise<DocEntry[]> {
  const root = path.resolve(docsRoot);
  const rels: string[] = [];
  if (existsSync(path.join(root, ROOT_DOC))) rels.push(ROOT_DOC);
  for (const dir of PUBLISHED_DOC_DIRS) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(root, dir));
    } catch {
      continue; // directory absent in this docsRoot — skip
    }
    for (const name of names.sort()) {
      if (name.endsWith('.md')) rels.push(`${dir}/${name}`);
    }
  }
  const entries: DocEntry[] = [];
  for (const rel of rels) {
    const title = await docTitle(path.join(root, ...rel.split('/')), rel);
    entries.push({ path: rel, title, mimeType: 'text/markdown' });
  }
  return entries;
}

/** Reads one corpus doc's markdown text (path validated via {@link resolveDocPath}). */
export async function readDoc(docsRoot: string, requestedPath: string): Promise<string> {
  const abs = resolveDocPath(docsRoot, requestedPath);
  return fs.readFile(abs, 'utf8');
}

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * multibyte character (backs the cut up off any trailing continuation byte).
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, Math.min(maxBytes, buf.length));
  // Back off while the first EXCLUDED byte is a UTF-8 continuation byte (10xxxxxx),
  // i.e. the boundary lands mid-character — trim to the character start instead.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Case-insensitive substring search across the whole corpus. Pure in-process
 * scan (no shell/grep). Returns per-doc results ranked by `score` (total
 * occurrence count) then `path`, each carrying up to {@link MAX_SNIPPETS_PER_DOC}
 * matching lines; the response is bounded to {@link MAX_TOTAL_SNIPPETS} snippets
 * overall so it stays token-bounded regardless of match count. Deterministic.
 */
export async function searchDocs(
  docsRoot: string,
  query: string,
  options: { limit?: number } = {},
): Promise<DocSearchResult[]> {
  const needle = query.toLowerCase();
  if (needle.length === 0) return [];
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const root = path.resolve(docsRoot);
  const docs = await listCorpusDocs(root).catch(() => []);

  const results: DocSearchResult[] = [];
  for (const doc of docs) {
    let text: string;
    try {
      text = await fs.readFile(path.join(root, ...doc.path.split('/')), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const snippets: DocSnippet[] = [];
    let score = 0;
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      let idx = lower.indexOf(needle);
      if (idx === -1) continue;
      while (idx !== -1) {
        score++;
        idx = lower.indexOf(needle, idx + needle.length);
      }
      if (snippets.length < MAX_SNIPPETS_PER_DOC) {
        snippets.push({ line: i + 1, text: clampSnippet(lines[i].trim()) });
      }
    }
    if (score > 0) results.push({ path: doc.path, title: doc.title, score, snippets });
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const limited = results.slice(0, Math.max(0, limit));

  // Enforce the global snippet cap across the returned docs (score/path order is
  // already deterministic, so which snippets survive is deterministic too).
  let budget = MAX_TOTAL_SNIPPETS;
  for (const r of limited) {
    if (budget <= 0) {
      r.snippets = [];
      continue;
    }
    if (r.snippets.length > budget) r.snippets = r.snippets.slice(0, budget);
    budget -= r.snippets.length;
  }
  return limited;
}

function clampSnippet(line: string): string {
  return line.length > MAX_SNIPPET_CHARS ? `${line.slice(0, MAX_SNIPPET_CHARS)}…` : line;
}
