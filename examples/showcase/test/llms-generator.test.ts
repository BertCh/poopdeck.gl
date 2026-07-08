/**
 * llmstxt.org doc-surface generator contract.
 *
 * Exercises the pure generator (src/docs/llms.ts) against the REAL repo docs/
 * and repo-root llms.txt, pinning the web-facing link rewriting and corpus
 * emit so a broken URL scheme or a missing published doc is a loud failure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateLlmsArtifacts } from '../src/docs/llms';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const docsDir = fileURLToPath(new URL('../../../docs', import.meta.url));
const llmsSource = readFileSync(`${repoRoot}llms.txt`, 'utf8');

const { llmsTxt, llmsFull, docFiles } = generateLlmsArtifacts({
  docsDir,
  llmsSource,
});

describe('llms.txt link rewriting', () => {
  it('rewrites published corpus links to absolute /llms/ URLs', () => {
    expect(llmsTxt).toContain('https://poopdeck.gl/llms/api/cli-reference.md');
  });

  it('leaves no bare relative docs/ markdown links', () => {
    expect(llmsTxt).not.toMatch(/\]\(docs\//);
  });

  it('maps a roadmap (unpublished) doc link to a GitHub blob URL', () => {
    expect(llmsTxt).toContain(
      'https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/ai-suite-skills-mcp-2026-07.md',
    );
  });
});

describe('llms-full.txt corpus concatenation', () => {
  it('is non-empty and includes a known cli-reference heading', () => {
    expect(llmsFull.length).toBeGreaterThan(0);
    expect(llmsFull).toContain('# api/cli-reference.md');
    expect(llmsFull).toContain('# CLI Reference');
  });
});

describe('llms/ raw doc copies', () => {
  it('emits dist/llms/api/cli-reference.md and README', () => {
    const paths = new Set(docFiles.map((d) => d.path));
    expect(paths.has('llms/api/cli-reference.md')).toBe(true);
    expect(paths.has('llms/README.md')).toBe(true);
  });
});
