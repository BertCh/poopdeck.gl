/**
 * llmstxt.org-style documentation surface generator.
 *
 * Pure, filesystem-driven logic for emitting the AI-agent doc surface into the
 * Vite `dist/` output (wired from vite.config.ts via a `closeBundle` plugin):
 *
 *  - `llms.txt`      — the curated corpus map (repo-root `llms.txt` with its
 *                      relative markdown links rewritten to absolute URLs).
 *  - `llms-full.txt` — the entire published corpus concatenated.
 *  - `llms/<path>.md`— a raw copy of every published doc.
 *
 * The PUBLISHED corpus mirrors `content.ts`: `docs/README.md` plus every
 * `*.md` directly under the five published dirs below. `docs/roadmap/` and any
 * other internal docs are excluded (links to them fall back to GitHub blob
 * URLs). Kept here (not in content.ts) because this runs in plain Node during
 * the build and reads from disk with `fs`, whereas content.ts uses Vite's
 * `import.meta.glob`; the dir list is the shared source of truth.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Public origin the built site is served from. */
export const LLMS_SITE_ORIGIN = 'https://poopdeck.gl';

/** GitHub blob base for repo files that are NOT in the published web corpus. */
export const LLMS_GITHUB_BLOB_BASE =
  'https://github.com/BertCh/spatiotemporal-tiles/blob/main/';

/**
 * Published doc dirs (direct `*.md` children only). Mirrors the glob in
 * `content.ts` (`docs/{intro,architecture,spec,api,guides}/*.md` + README).
 */
export const PUBLISHED_DOC_DIRS = [
  'intro',
  'architecture',
  'spec',
  'api',
  'guides',
] as const;

export interface CorpusDoc {
  /** Path relative to `docs/`, e.g. "api/cli-reference.md" or "README.md". */
  file: string;
  /** Raw file contents. */
  text: string;
}

export interface LlmsArtifacts {
  /** Rewritten corpus map → dist/llms.txt */
  llmsTxt: string;
  /** Concatenated published corpus → dist/llms-full.txt */
  llmsFull: string;
  /** Raw doc copies; `path` is relative to dist (e.g. "llms/README.md"). */
  docFiles: { path: string; text: string }[];
}

/** Read the published corpus off disk, sorted by docs-relative path. */
export function collectCorpus(docsDir: string): CorpusDoc[] {
  const docs: CorpusDoc[] = [];

  const readme = path.join(docsDir, 'README.md');
  if (fs.existsSync(readme)) {
    docs.push({ file: 'README.md', text: fs.readFileSync(readme, 'utf8') });
  }

  for (const dir of PUBLISHED_DOC_DIRS) {
    const abs = path.join(docsDir, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(abs, name);
      if (!fs.statSync(full).isFile()) continue;
      docs.push({
        file: `${dir}/${name}`,
        text: fs.readFileSync(full, 'utf8'),
      });
    }
  }

  return docs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

const MD_LINK = /\]\(([^)\s]+)\)/g;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/** Split a markdown link target into its path and (optional) `#fragment`. */
function splitFragment(target: string): [string, string] {
  const i = target.indexOf('#');
  return i === -1 ? [target, ''] : [target.slice(0, i), target.slice(i)];
}

/** Rewrite one relative link target to an absolute URL (or leave absolute). */
function rewriteTarget(target: string, publishedFiles: Set<string>): string {
  if (ABSOLUTE.test(target) || target.startsWith('#')) return target;
  const [pathPart, frag] = splitFragment(target);
  if (pathPart.startsWith('docs/')) {
    const rel = pathPart.slice('docs/'.length);
    if (publishedFiles.has(rel)) {
      return `${LLMS_SITE_ORIGIN}/llms/${rel}${frag}`;
    }
    // Under docs/ but not published (e.g. roadmap/) → GitHub blob.
    return `${LLMS_GITHUB_BLOB_BASE}${pathPart}${frag}`;
  }
  // Repo-root file (AGENTS.md, poopdeck-ai/README.md, …) → GitHub blob.
  return `${LLMS_GITHUB_BLOB_BASE}${pathPart}${frag}`;
}

/**
 * Rewrite every relative markdown link in `source` to an absolute URL. Links
 * into the published corpus point at the web copies (`/llms/<path>`); all other
 * repo links point at GitHub blob URLs; already-absolute links are untouched.
 */
export function rewriteLlmsLinks(
  source: string,
  publishedFiles: Set<string>,
): string {
  return source.replace(
    MD_LINK,
    (_m, target: string) => `](${rewriteTarget(target, publishedFiles)})`,
  );
}

/** In-order list of published docs linked from the corpus map (deduped). */
function linkedOrder(source: string, publishedFiles: Set<string>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const m of source.matchAll(MD_LINK)) {
    const [pathPart] = splitFragment(m[1]);
    if (!pathPart.startsWith('docs/')) continue;
    const rel = pathPart.slice('docs/'.length);
    if (publishedFiles.has(rel) && !seen.has(rel)) {
      seen.add(rel);
      order.push(rel);
    }
  }
  return order;
}

/**
 * Concatenate the published corpus into one document: a title/intro header,
 * then per doc a `--- / # <path> / <raw contents>` block. Docs appear in the
 * order they are linked from the corpus map first, then any remaining published
 * docs in alphabetical path order.
 */
export function buildLlmsFull(source: string, corpus: CorpusDoc[]): string {
  const byFile = new Map(corpus.map((d) => [d.file, d]));
  const publishedFiles = new Set(byFile.keys());

  const ordered: string[] = linkedOrder(source, publishedFiles);
  const seen = new Set(ordered);
  for (const d of corpus) {
    if (!seen.has(d.file)) ordered.push(d.file);
  }

  const parts: string[] = [
    '# poopdeck.gl / SpatioTemporal Tiles (STT) — full documentation',
    '',
    '> The complete published STT documentation corpus, concatenated for LLM',
    '> ingestion. See https://poopdeck.gl/llms.txt for the curated map and',
    '> https://poopdeck.gl/llms/<path> for individual files.',
  ];

  for (const file of ordered) {
    const doc = byFile.get(file);
    if (!doc) continue;
    parts.push('', '---', '', `# ${file}`, '', doc.text.replace(/\n+$/, ''));
  }

  return `${parts.join('\n')}\n`;
}

/**
 * Build all three llms artifacts from the repo `docs/` dir and the repo-root
 * `llms.txt` source text. Pure over its inputs (aside from reading `docsDir`),
 * so it is unit-testable without a full Vite build.
 */
export function generateLlmsArtifacts(opts: {
  docsDir: string;
  llmsSource: string;
}): LlmsArtifacts {
  const corpus = collectCorpus(opts.docsDir);
  const publishedFiles = new Set(corpus.map((d) => d.file));

  return {
    llmsTxt: rewriteLlmsLinks(opts.llmsSource, publishedFiles),
    llmsFull: buildLlmsFull(opts.llmsSource, corpus),
    docFiles: corpus.map((d) => ({ path: `llms/${d.file}`, text: d.text })),
  };
}
