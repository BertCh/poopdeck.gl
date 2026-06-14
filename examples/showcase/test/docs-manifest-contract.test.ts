/**
 * Docs nav manifest ↔ content glob contract.
 *
 * The /docs section is driven by an explicit manifest (`src/docs/manifest.ts`)
 * over a deliberately RESTRICTED `import.meta.glob` (`src/docs/content.ts`).
 * This test pins the two together so adding/removing/moving a doc file is a
 * loud failure instead of a silently missing page (or, worse, an internal
 * roadmap/audit doc silently shipped in the bundle).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  docSections,
  flatDocEntries,
  EXCLUDED_DOC_FILES,
  getPrevNext,
} from '../src/docs/manifest';
import { bundledDocFiles } from '../src/docs/content';
import { rewriteHref } from '../src/docs/links';
import { extractHeadings } from '../src/docs/headings';

const bundled = new Set(bundledDocFiles());
const manifestFiles = flatDocEntries
  .filter((e) => e.kind !== 'json')
  .map((e) => e.file);

describe('docs manifest ↔ glob contract', () => {
  it('every manifest markdown entry is bundled by the content glob', () => {
    for (const file of manifestFiles) {
      expect(bundled.has(file), `manifest file ${file} not in glob`).toBe(true);
    }
  });

  it('every bundled file is either routed or explicitly excluded', () => {
    const routed = new Set([...manifestFiles, ...EXCLUDED_DOC_FILES]);
    for (const file of bundled) {
      expect(routed.has(file), `bundled docs/${file} is unrouted and not in EXCLUDED_DOC_FILES`).toBe(true);
    }
  });

  it('the glob does NOT bundle internal docs (roadmap, audits)', () => {
    for (const file of bundled) {
      expect(file.startsWith('roadmap/'), `internal doc bundled: ${file}`).toBe(false);
      expect(/audit|sota-eval|upstream-library/.test(file), `internal doc bundled: ${file}`).toBe(false);
    }
  });

  it('json entries resolve to files on disk', () => {
    for (const e of flatDocEntries.filter((x) => x.kind === 'json')) {
      const p = fileURLToPath(new URL(`../../../docs/${e.file}`, import.meta.url));
      expect(existsSync(p), `${e.file} missing on disk`).toBe(true);
    }
  });

  it('slugs are unique and mirror their file paths', () => {
    const slugs = flatDocEntries.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const e of flatDocEntries) {
      if (e.kind === 'json') continue;
      expect(e.file, `${e.slug} should mirror its file path`).toBe(`${e.slug}.md`);
    }
  });

  it('prev/next chain covers the flattened order', () => {
    const first = flatDocEntries[0];
    const last = flatDocEntries[flatDocEntries.length - 1];
    expect(getPrevNext(first.slug).prev).toBeUndefined();
    expect(getPrevNext(last.slug).next).toBeUndefined();
    expect(getPrevNext(flatDocEntries[1].slug).prev?.slug).toBe(first.slug);
  });

  it('every section has at least one entry', () => {
    for (const s of docSections) {
      expect(s.entries.length, `section ${s.id}`).toBeGreaterThan(0);
    }
  });
});

describe('docs link rewriting', () => {
  it('rewrites sibling and cross-section .md links to /docs routes', () => {
    expect(rewriteHref('./animated-path-layer.md', 'api/animated-point-layer.md')).toEqual({
      kind: 'internal',
      to: '/docs/api/animated-path-layer',
    });
    expect(rewriteHref('../spec/stt-packed-format.md', 'api/cli-reference.md')).toEqual({
      kind: 'internal',
      to: '/docs/spec/stt-packed-format',
    });
    expect(rewriteHref('./api/cli-reference.md', 'README.md')).toEqual({
      kind: 'internal',
      to: '/docs/api/cli-reference',
    });
  });

  it('routes the manifest schema to its rendered page', () => {
    expect(rewriteHref('./spec/manifest.schema.json', 'README.md')).toEqual({
      kind: 'internal',
      to: '/docs/spec/manifest-schema',
    });
    expect(rewriteHref('./manifest.schema.json', 'spec/stt-packed-format.md')).toEqual({
      kind: 'internal',
      to: '/docs/spec/manifest-schema',
    });
  });

  it('sends repo-source links escaping docs/ to GitHub (branch master)', () => {
    const r = rewriteHref('../../packages/layers/src/animated-point-layer.ts', 'api/animated-point-layer.md');
    expect(r.kind).toBe('external');
    expect((r as { href: string }).href).toBe(
      'https://github.com/BertCh/spatiotemporal-tiles/blob/master/packages/layers/src/animated-point-layer.ts',
    );
  });

  it('passes through absolute URLs and fragments', () => {
    expect(rewriteHref('https://geoarrow.org/format.html', 'api/binary-features.md')).toEqual({
      kind: 'external',
      href: 'https://geoarrow.org/format.html',
    });
    expect(rewriteHref('#usage', 'api/binary-features.md')).toEqual({
      kind: 'hash',
      hash: 'usage',
    });
  });

  it('preserves fragments on internal links', () => {
    expect(rewriteHref('./concepts.md#temporal-lod', 'intro/concepts.md')).toEqual({
      kind: 'internal',
      to: '/docs/intro/concepts#temporal-lod',
    });
  });
});

describe('toc extraction', () => {
  it('extracts h2/h3 outside fences with github slugs', () => {
    const raw = [
      '# Title',
      '## Usage',
      '```bash',
      '## not a heading',
      '```',
      '### With `code` span',
      '## Usage', // duplicate → -1 suffix
    ].join('\n');
    expect(extractHeadings(raw)).toEqual([
      { level: 2, text: 'Usage', id: 'usage' },
      { level: 3, text: 'With code span', id: 'with-code-span' },
      { level: 2, text: 'Usage', id: 'usage-1' },
    ]);
  });
});
