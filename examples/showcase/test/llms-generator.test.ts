/**
 * llmstxt.org doc-surface generator contract.
 *
 * Exercises the pure generator (src/docs/llms.ts) against the REAL repo docs/
 * and repo-root llms.txt, pinning the web-facing link rewriting and corpus
 * emit so a broken URL scheme or a missing published doc is a loud failure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
      'https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/ai-suite.md',
    );
  });
});

describe('llms-full.txt corpus concatenation', () => {
  it('is non-empty and includes a known cli-reference heading', () => {
    expect(llmsFull.length).toBeGreaterThan(0);
    expect(llmsFull).toContain('# api/cli-reference.md');
    expect(llmsFull).toContain('# CLI Reference');
  });

  it('includes the spec JSON schemas inside a ```json fence', () => {
    expect(llmsFull).toContain('# spec/manifest.schema.json');
    // The schema body follows its heading in a fenced block, so the
    // concatenation stays valid markdown and the boundary is unambiguous.
    expect(llmsFull).toMatch(/# spec\/manifest\.schema\.json\n\n```json\n\{/);
    expect(llmsFull).toContain(
      '"$id": "https://poopdeck.gl/spec/manifest.schema.json"',
    );
    expect(llmsFull).toContain('# spec/scene.schema.json');
    expect(llmsFull).toContain('# spec/tile-matrix-set.json');
  });
});

describe('llms/ raw doc copies', () => {
  it('emits dist/llms/api/cli-reference.md and README', () => {
    const paths = new Set(docFiles.map((d) => d.path));
    expect(paths.has('llms/api/cli-reference.md')).toBe(true);
    expect(paths.has('llms/README.md')).toBe(true);
  });

  it('mirrors every docs/spec/*.json schema verbatim', () => {
    const onDisk = readdirSync(docsDir + '/spec')
      .filter((n) => n.endsWith('.json'))
      .sort();
    expect(onDisk.length).toBeGreaterThan(0);
    const emitted = docFiles
      .filter((d) => d.path.endsWith('.json'))
      .map((d) => d.path)
      .sort();
    expect(emitted).toEqual(onDisk.map((n) => `llms/spec/${n}`));

    const manifest = docFiles.find(
      (d) => d.path === 'llms/spec/manifest.schema.json',
    );
    // Byte-identical to the source, so the mirror is directly JSON.parse-able.
    expect(manifest?.text).toBe(
      readFileSync(`${docsDir}/spec/manifest.schema.json`, 'utf8'),
    );
    expect(JSON.parse(manifest!.text).title).toBe('STT packed-format manifest');
  });

  it('publishes JSON from spec/ only — every other dir stays markdown', () => {
    const strays = docFiles.filter(
      (d) => !d.path.endsWith('.md') && !d.path.startsWith('llms/spec/'),
    );
    expect(strays).toEqual([]);
  });
});
