// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * The PUBLISHED documentation corpus, surfaced to agents talking to the MCP
 * server (design record: `docs/roadmap/ai-suite.md`). The
 * corpus is exactly `docs/README.md`, every `*.md` DIRECTLY under
 * `docs/{intro,architecture,spec,api,guides}`, plus the machine-readable
 * `docs/spec/*.json` schemas — the prose set the showcase site renders
 * (`examples/showcase/src/docs/content.ts`) widened with the JSON contracts
 * (manifest / scene / tile-matrix-set / render-spec), which are the most
 * directly usable artifacts in the corpus for a machine reader and were
 * previously unreachable from every agent-facing surface. It deliberately
 * EXCLUDES `docs/roadmap/` (internal audits / design records).
 *
 * `docsRoot` points at a `docs/` directory: either the copy BUNDLED beside the
 * installed package (so an `npx`/global install works with no repo on disk —
 * see `scripts/copy-docs.mjs`) or the repo's own `docs/` in a dev checkout.
 * Reads only the corpus files; never anything outside it.
 */
import { promises as fs, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** The five doc directories whose direct `*.md` children are published (mirrors examples/showcase/src/docs/content.ts). */
export const PUBLISHED_DOC_DIRS = [
  'intro',
  'architecture',
  'spec',
  'api',
  'guides',
] as const;

/** The one published doc at the docs-root itself. */
export const ROOT_DOC = 'README.md';

/**
 * Published dirs that ALSO publish their direct `*.json` children. Only
 * `docs/spec/` qualifies: its JSON files are the normative machine-readable
 * contracts (JSON Schema for `manifest.json` / `scene.json`, the OGC-style
 * tile-matrix-set, the render-spec op-set). Every other dir stays `.md`-only,
 * so this widens the allow-list by exactly one dir × one extension.
 */
export const JSON_DOC_DIRS = ['spec'] as const;

/** Mime type served for each admitted corpus extension. */
export type DocMimeType = 'text/markdown' | 'application/json';

/**
 * Extensions admitted for a published dir. This is the ONLY place the
 * extension allow-list is spelled out — both the path guard
 * ({@link isCorpusRelPath}) and the directory listing ({@link listCorpusDocs})
 * go through it, so the served set and the readable set can never drift.
 */
function allowedExtensions(dir: string): readonly string[] {
  return (JSON_DOC_DIRS as readonly string[]).includes(dir)
    ? ['.md', '.json']
    : ['.md'];
}

/**
 * Mime type for a corpus-relative path. Call only on paths that have already
 * cleared {@link isCorpusRelPath}; anything not `.json` is markdown by
 * construction of the allow-list.
 */
export function docMimeType(rel: string): DocMimeType {
  return path.extname(rel).toLowerCase() === '.json'
    ? 'application/json'
    : 'text/markdown';
}

/** Default byte cap the `get_doc` tool applies before truncating (keeps a single doc well under a typical MCP client's response budget). */
export const DEFAULT_DOC_MAX_BYTES = 40_000;

const DEFAULT_SEARCH_LIMIT = 10;
/** Max snippets kept per matching doc (a few lines is enough to judge relevance). */
const MAX_SNIPPETS_PER_DOC = 3;
/** Max snippets across the WHOLE `search_docs` response — bounds the token cost regardless of how many docs match. */
const MAX_TOTAL_SNIPPETS = 24;
/** Single-line snippet text is clamped to this many characters so one long line can't blow the budget. */
const MAX_SNIPPET_CHARS = 200;

/** One corpus doc: its docs-root-relative POSIX path, a human title, and its mime type. */
export interface DocEntry {
  /** POSIX path relative to `docsRoot` (e.g. `api/cli-reference.md`) — the `path` every doc tool/resource takes. */
  path: string;
  title: string;
  /** `text/markdown` for `*.md`, `application/json` for the `spec/*.json` schemas. */
  mimeType: DocMimeType;
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
 * member of the published corpus: `README.md` at the root, or a DIRECT child of
 * one of {@link PUBLISHED_DOC_DIRS} whose extension that dir admits (`.md`
 * everywhere, plus `.json` under `spec/` — see {@link allowedExtensions}).
 * Nested paths and any other extension are rejected — this is the allow-list
 * that keeps `docs/roadmap/` (and any other sibling) unreadable through the
 * server.
 */
function isCorpusRelPath(rel: string): boolean {
  const posix = rel.split(path.sep).join('/');
  if (posix === ROOT_DOC) return true;
  const parts = posix.split('/');
  if (parts.length !== 2) return false;
  const [dir, name] = parts;
  if (!(PUBLISHED_DOC_DIRS as readonly string[]).includes(dir)) return false;
  // `name.length > ext.length` so a bare ".md"/".json" dotfile is not a doc.
  return allowedExtensions(dir).some(
    (ext) => name.length > ext.length && name.endsWith(ext),
  );
}

/**
 * Resolves an agent-supplied doc `path` against `docsRoot`, rejecting anything
 * that is not a published corpus file. `path` crosses a trust boundary (an LLM
 * tool-call / resource-URI argument), so containment is CHECKED, not assumed:
 *
 *  - absolute paths are rejected outright;
 *  - the resolved target must stay under `docsRoot` (lexical `..` check);
 *  - it must be a corpus member (see {@link isCorpusRelPath} — `.md`, plus
 *    `.json` under `spec/`; no other extension, no nested dirs, no
 *    `docs/roadmap/`);
 *  - a symlink INSIDE `docsRoot` pointing OUT is defeated by re-checking the
 *    canonicalized (`realpath`) prefixes.
 */
export function resolveDocPath(
  docsRoot: string,
  requestedPath: string,
): string {
  const requested = String(requestedPath);
  if (path.isAbsolute(requested)) {
    throw new Error(
      `doc path "${requested}" must be relative to the docs root (no absolute paths)`,
    );
  }
  const resolvedRoot = path.resolve(docsRoot);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`doc path "${requested}" resolves outside the docs root`);
  }
  if (!isCorpusRelPath(relative)) {
    throw new Error(
      `doc path "${requested}" is not a published doc — expected "${ROOT_DOC}", one of ` +
        `${PUBLISHED_DOC_DIRS.map((d) => `${d}/<file>.md`).join(', ')}, or ` +
        `${JSON_DOC_DIRS.map((d) => `${d}/<file>.json`).join(', ')}`,
    );
  }
  // Symlink-aware re-check: canonicalize the root and the target (or its nearest
  // existing ancestor, if the leaf does not exist) and confirm containment holds
  // through any symlink the lexical check above cannot see.
  const canonicalRoot = realpathOfNearestExisting(resolvedRoot);
  const canonicalResolved = realpathOfNearestExisting(resolved);
  const canonicalRelative = path.relative(canonicalRoot, canonicalResolved);
  if (
    canonicalRelative.startsWith('..') ||
    path.isAbsolute(canonicalRelative)
  ) {
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

/**
 * Admits one candidate directory entry to the corpus: returns its absolute path
 * when `rel` is a published corpus member that is REALLY a regular file inside
 * `root`, and `null` otherwise.
 *
 * This is what keeps the LISTING channel as narrow as the READ channel. The
 * listing (and `search_docs`, which is built on it) used to trust `readdir`
 * names alone, so two entries diverged from what `readDoc` would actually serve:
 *
 *  - a SYMLINK planted under a published dir pointing OUT of `docsRoot` was
 *    listed with the out-of-root file's title and its contents were searchable,
 *    even though {@link resolveDocPath} correctly refused to read it. Running
 *    the candidate through `resolveDocPath` applies the same canonicalized
 *    containment check to the listing;
 *  - a DIRECTORY named `foo.md` / `foo.json` was listed and then failed EISDIR
 *    on read. The `isFile()` check drops it, mirroring the same filter in
 *    `examples/showcase/src/docs/llms.ts`.
 *
 * `statSync` FOLLOWS symlinks deliberately: a link to a regular file that is
 * still inside `docsRoot` is readable through the guard, so it stays listed.
 */
function admitCorpusFile(root: string, rel: string): string | null {
  if (!isCorpusRelPath(rel)) return null;
  let abs: string;
  try {
    abs = resolveDocPath(root, rel);
  } catch {
    return null; // escapes the root through a symlink, or not published
  }
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null; // absent, or vanished between readdir and stat
  }
  return abs;
}

/**
 * Human title for a corpus file. Markdown uses its first `# ` H1, falling back
 * to the basename (unchanged behaviour).
 *
 * JSON has no heading, so the title is taken from the document's OWN top-level
 * `title` — every JSON Schema convention already puts a human label there
 * (`"STT packed-format manifest"`, `"STT scene bundle manifest (scene.json)"`),
 * which makes it the exact analogue of the markdown H1 and keeps the listing
 * authored-by-the-doc rather than invented here. Files without one (e.g.
 * `render-spec.json`, a plain contract document) fall back to a humanized
 * filename — `render-spec.json` → "Render Spec" — which reads far better in a
 * resource list than a raw basename, and is also the fallback for a JSON file
 * that fails to parse.
 */
async function docTitle(absPath: string, rel: string): Promise<string> {
  const isJson = docMimeType(rel) === 'application/json';
  try {
    const text = await fs.readFile(absPath, 'utf8');
    if (isJson) {
      const parsed: unknown = JSON.parse(text);
      const title = (parsed as { title?: unknown } | null)?.title;
      if (typeof title === 'string' && title.trim().length > 0) {
        return title.trim();
      }
    } else {
      const m = /^#\s+(.+?)\s*$/m.exec(text);
      if (m) return m[1].trim();
    }
  } catch {
    // unreadable, or malformed JSON — fall through to the filename
  }
  return isJson ? humanizeFileName(rel) : path.basename(rel);
}

/**
 * `spec/manifest.schema.json` → "Manifest Schema", `spec/tile-matrix-set.json`
 * → "Tile Matrix Set". Drops the `.json` extension, treats `.`/`-`/`_` as word
 * separators, and title-cases the words.
 */
function humanizeFileName(rel: string): string {
  const base = path.basename(rel, path.extname(rel));
  return (
    base
      .split(/[.\-_]+/)
      .filter((w) => w.length > 0)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ') || path.basename(rel)
  );
}

/**
 * Enumerates the published corpus files actually present under `docsRoot`, in a
 * stable order (`README.md` first, then {@link PUBLISHED_DOC_DIRS} in declared
 * order, files sorted within each — so `spec/`'s `.md` and `.json` interleave
 * alphabetically). Missing dirs are skipped silently. Membership is decided by
 * {@link admitCorpusFile}, which runs every candidate through the same
 * `resolveDocPath` guard the read path uses and additionally requires a regular
 * file — so everything listed is readable and everything readable is listed.
 */
export async function listCorpusDocs(docsRoot: string): Promise<DocEntry[]> {
  const root = path.resolve(docsRoot);
  const candidates: string[] = [ROOT_DOC];
  for (const dir of PUBLISHED_DOC_DIRS) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(root, dir));
    } catch {
      continue; // directory absent in this docsRoot — skip
    }
    for (const name of names.sort()) candidates.push(`${dir}/${name}`);
  }
  const entries: DocEntry[] = [];
  for (const rel of candidates) {
    const abs = admitCorpusFile(root, rel);
    if (abs === null) continue;
    const title = await docTitle(abs, rel);
    entries.push({ path: rel, title, mimeType: docMimeType(rel) });
  }
  return entries;
}

/**
 * Reads one corpus doc's raw text — markdown, or the JSON source of a
 * `spec/*.json` schema (path validated via {@link resolveDocPath}; use
 * {@link docMimeType} to label the result).
 */
export async function readDoc(
  docsRoot: string,
  requestedPath: string,
): Promise<string> {
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
 * Case-insensitive substring search across the whole corpus — markdown prose
 * and the `spec/*.json` schemas alike, so a property name like
 * `temporalBucketMs` is findable in the schema that defines it. Pure
 * in-process scan (no shell/grep). Returns per-doc results ranked by `score` (total
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
      // Deliberately re-enters the path guard rather than joining `root` and
      // `doc.path` directly: search must never surface bytes `get_doc` would
      // refuse to serve, even if the tree changed under us since the listing.
      text = await readDoc(root, doc.path);
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const snippets: DocSnippet[] = [];
    let score = 0;
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      const first = lower.indexOf(needle);
      if (first === -1) continue;
      let idx = first;
      while (idx !== -1) {
        score++;
        idx = lower.indexOf(needle, idx + needle.length);
      }
      if (snippets.length < MAX_SNIPPETS_PER_DOC) {
        snippets.push({ line: i + 1, text: clampSnippet(lines[i], first) });
      }
    }
    if (score > 0)
      results.push({ path: doc.path, title: doc.title, score, snippets });
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

/**
 * Trims `line` and clamps it to {@link MAX_SNIPPET_CHARS}, WINDOWED around the
 * match at `matchIndex` (an index into the untrimmed line) rather than simply
 * head-truncated. Markdown is prose-wrapped so the two are equivalent there,
 * but the `spec/*.json` schemas carry near-minified lines up to ~1kB — a
 * head-only clamp would hand back a snippet that does not contain the query.
 * Ellipses mark whichever side was cut, and the result is still hard-bounded,
 * so the response stays token-bounded for JSON exactly as it is for markdown.
 */
function clampSnippet(line: string, matchIndex: number): string {
  const text = line.trim();
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  // Re-base the match onto the trimmed text, then keep a little left context.
  const at = Math.max(0, matchIndex - (line.length - line.trimStart().length));
  const lead = Math.floor(MAX_SNIPPET_CHARS / 4);
  const start = Math.min(
    Math.max(0, at - lead),
    text.length - MAX_SNIPPET_CHARS,
  );
  const end = start + MAX_SNIPPET_CHARS;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
