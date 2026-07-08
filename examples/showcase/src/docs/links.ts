/**
 * Rewrites raw markdown hrefs (written for GitHub browsing of `docs/`) into
 * site links:
 *
 *  - `./sibling.md`, `../spec/foo.md`  → internal `/docs/<slug>` routes
 *  - `./spec/manifest.schema.json`     → the rendered `/docs/spec/manifest-schema` page
 *  - `../../packages/**`, anything escaping docs/ → GitHub blob URLs (branch master)
 *  - `https://…`, `#fragment`          → passed through
 */
import { GITHUB_BLOB_BASE } from './manifest';

export type RewrittenLink =
  | { kind: 'internal'; to: string }
  | { kind: 'external'; href: string }
  | { kind: 'hash'; hash: string };

/** POSIX-style resolve of `href` against a base directory ("docs/api"). */
function resolvePath(baseDir: string, href: string): string {
  const out: string[] = [];
  for (const part of `${baseDir}/${href}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * @param href        raw markdown href
 * @param currentFile docs-relative path of the page being rendered
 *                    (e.g. "api/animated-point-layer.md")
 */
export function rewriteHref(href: string, currentFile: string): RewrittenLink {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    // http(s):, mailto:, etc.
    return { kind: 'external', href };
  }
  if (href.startsWith('#')) {
    return { kind: 'hash', hash: href.slice(1) };
  }

  const [pathPart, fragment = ''] = href.split('#');
  const hashSuffix = fragment ? `#${fragment}` : '';

  const slash = currentFile.lastIndexOf('/');
  const baseDir = `docs/${slash === -1 ? '' : currentFile.slice(0, slash)}`;
  const resolved = resolvePath(baseDir, pathPart);

  if (resolved === 'docs/spec/manifest.schema.json') {
    return { kind: 'internal', to: `/docs/spec/manifest-schema${hashSuffix}` };
  }

  if (resolved.startsWith('docs/') && resolved.endsWith('.md')) {
    const slug = resolved.slice('docs/'.length, -'.md'.length);
    if (slug === 'README')
      return { kind: 'internal', to: `/docs${hashSuffix}` };
    return { kind: 'internal', to: `/docs/${slug}${hashSuffix}` };
  }

  // Source files (../../packages/**.ts), roadmap docs, or any other repo
  // path: send to GitHub rather than a dead route.
  return { kind: 'external', href: GITHUB_BLOB_BASE + resolved };
}
