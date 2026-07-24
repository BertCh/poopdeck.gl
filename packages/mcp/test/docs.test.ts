/**
 * Exercises the documentation surface — the `stt://docs/<path>` resource and
 * the `get_doc` / `search_docs` tools — over an in-process MCP transport, plus
 * a direct unit check of the path-traversal guard. Uses the same fixture/harness
 * style as `server.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSttMcpServer } from '../src/server';
import {
  resolveDocPath,
  docMimeType,
  listCorpusDocs,
  readDoc,
  searchDocs,
} from '../src/docs';
import type { SttMcpConfig } from '../src/config';
import {
  writeFixtureDocsRoot,
  writeFixtureDataRoot,
  cleanupDataRoot,
} from './fixtures';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await cleanupDataRoot(roots.pop()!);
});

/** A published-corpus fixture: README + one file in each of a couple of published dirs. */
const CORPUS: Record<string, string> = {
  'README.md':
    '# STT Docs\n\nWelcome to the SpatioTemporal Tiles documentation.\n',
  'api/cli-reference.md':
    '# CLI Reference\n\nThe `stt-build` command turns GeoParquet into a packed archive.\n' +
    'Run `stt-build --help` for the full flag surface.\n',
  'guides/ai-suite.md':
    '# AI Suite\n\nThe poopdeck-ai suite bundles an MCP server and skills.\n',
  // Machine-readable contracts — published, but ONLY from spec/.
  'spec/manifest.schema.json': `${JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'STT packed-format manifest',
      properties: { temporalBucketMs: { type: 'integer' } },
    },
    null,
    2,
  )}\n`,
  // No top-level `title` → exercises the humanized-filename fallback.
  'spec/render-spec.json': '{\n  "version": 1,\n  "ops": ["uniform"]\n}\n',
  // JSON OUTSIDE spec/ is not published — the widening is one dir, one ext.
  'api/notes.json': '{ "secret": "not published" }\n',
  // Neither is any other extension inside spec/.
  'spec/notes.txt': 'plain text — not published\n',
  // A roadmap doc lives in the docs tree but is NOT part of the published corpus.
  'roadmap/secret-plan.md':
    '# Secret Plan\n\nInternal only — must never be served.\n',
  'roadmap/secret.json': '{ "plan": "Internal only" }\n',
};

async function docsFixture(): Promise<string> {
  const root = await writeFixtureDocsRoot(CORPUS);
  roots.push(root);
  return root;
}

async function emptyDataRoot(): Promise<string> {
  const root = await writeFixtureDataRoot({});
  roots.push(root);
  return root;
}

function baseConfig(dataRoot: string, docsRoot: string): SttMcpConfig {
  return {
    dataRoot,
    docsRoot,
    allowCli: false,
    transport: 'stdio',
    host: '127.0.0.1',
    port: 0,
  };
}

async function connectedClient(
  config: SttMcpConfig,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createSttMcpServer(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const block = (result.content as any[]).find((c) => c.type === 'text');
  return block.text as string;
}

describe('docs resource — stt://docs/<path>', () => {
  it('lists the published corpus and excludes roadmap/', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const { resources } = await client.listResources();
      const docNames = resources
        .filter((r) => r.uri.startsWith('stt://docs/'))
        .map((r) => r.name)
        .sort();
      expect(docNames).toEqual([
        'README.md',
        'api/cli-reference.md',
        'guides/ai-suite.md',
        'spec/manifest.schema.json',
        'spec/render-spec.json',
      ]);
      // The roadmap docs are present on disk but must not be enumerated, and
      // JSON outside spec/ (or a non-allow-listed ext inside it) stays hidden.
      expect(docNames).not.toContain('roadmap/secret-plan.md');
      expect(docNames).not.toContain('roadmap/secret.json');
      expect(docNames).not.toContain('api/notes.json');
      expect(docNames).not.toContain('spec/notes.txt');
      // Multi-segment paths are percent-encoded into a single URI segment.
      const cliRef = resources.find((r) => r.name === 'api/cli-reference.md');
      expect(cliRef?.uri).toBe('stt://docs/api%2Fcli-reference.md');
      expect(cliRef?.title).toBe('CLI Reference');
      expect(cliRef?.mimeType).toBe('text/markdown');
    } finally {
      await close();
    }
  });

  it('lists the spec JSON schemas with a JSON mime type and a human title', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const { resources } = await client.listResources();
      const schema = resources.find(
        (r) => r.name === 'spec/manifest.schema.json',
      );
      expect(schema?.uri).toBe('stt://docs/spec%2Fmanifest.schema.json');
      expect(schema?.mimeType).toBe('application/json');
      // Title comes from the schema's own top-level `title`.
      expect(schema?.title).toBe('STT packed-format manifest');
      // …and falls back to a humanized filename when the JSON carries none.
      const renderSpec = resources.find(
        (r) => r.name === 'spec/render-spec.json',
      );
      expect(renderSpec?.mimeType).toBe('application/json');
      expect(renderSpec?.title).toBe('Render Spec');
    } finally {
      await close();
    }
  });

  it('reads one doc as markdown', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const read = await client.readResource({
        uri: 'stt://docs/api%2Fcli-reference.md',
      });
      expect(read.contents[0].mimeType).toBe('text/markdown');
      expect((read.contents[0] as any).text).toContain('stt-build');
    } finally {
      await close();
    }
  });

  it('reads a spec JSON schema verbatim', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const read = await client.readResource({
        uri: 'stt://docs/spec%2Fmanifest.schema.json',
      });
      const text = (read.contents[0] as any).text as string;
      // Served byte-for-byte, so an agent can JSON.parse it straight off.
      expect(JSON.parse(text).title).toBe('STT packed-format manifest');
      // The READ handler labels per entry via docMimeType(), matching what the
      // resource LIST advertised. A client that dispatches on mimeType would
      // otherwise be told this schema is markdown.
      expect(read.contents[0].mimeType).toBe('application/json');
    } finally {
      await close();
    }
  });
});

describe('get_doc tool', () => {
  it('returns the markdown content of a corpus doc', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const result = await client.callTool({
        name: 'get_doc',
        arguments: { path: 'api/cli-reference.md' },
      });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('The `stt-build` command');
    } finally {
      await close();
    }
  });

  it('returns a spec JSON schema as parseable JSON', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const result = await client.callTool({
        name: 'get_doc',
        arguments: { path: 'spec/manifest.schema.json' },
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(firstText(result));
      expect(parsed.title).toBe('STT packed-format manifest');
      expect(parsed.properties.temporalBucketMs.type).toBe('integer');
    } finally {
      await close();
    }
  });

  it('refuses a .json outside spec/ and a non-allow-listed ext inside it', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      for (const path of ['api/notes.json', 'spec/notes.txt']) {
        const result = await client.callTool({
          name: 'get_doc',
          arguments: { path },
        });
        expect([path, result.isError]).toEqual([path, true]);
        expect(firstText(result)).not.toContain('not published');
      }
    } finally {
      await close();
    }
  });

  it('rejects a relative path-traversal escape', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const result = await client.callTool({
        name: 'get_doc',
        arguments: { path: '../../etc/passwd' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/search_docs|stt:\/\/docs/);
    } finally {
      await close();
    }
  });

  it('rejects an absolute path', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const result = await client.callTool({
        name: 'get_doc',
        arguments: { path: '/etc/passwd' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('refuses to serve a non-corpus doc (roadmap/)', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      for (const path of ['roadmap/secret-plan.md', 'roadmap/secret.json']) {
        const result = await client.callTool({
          name: 'get_doc',
          arguments: { path },
        });
        expect([path, result.isError]).toEqual([path, true]);
        expect(firstText(result)).not.toContain('Internal only');
      }
    } finally {
      await close();
    }
  });

  it('truncates oversized content with a marker reporting the true length', async () => {
    // A doc larger than the requested maxBytes.
    const big = `# Big\n\n${'x'.repeat(5000)}\n`;
    const docsRoot = await writeFixtureDocsRoot({ 'guides/big.md': big });
    roots.push(docsRoot);
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), docsRoot),
    );
    try {
      const result = await client.callTool({
        name: 'get_doc',
        arguments: { path: 'guides/big.md', maxBytes: 100 },
      });
      const text = firstText(result);
      expect(text).toContain('...[truncated]');
      // Reports the true byte length of the full doc.
      expect(text).toContain(String(Buffer.byteLength(big, 'utf8')));
      // The visible body is bounded near the cap (marker aside).
      expect(text.length).toBeLessThan(big.length);
    } finally {
      await close();
    }
  });
});

describe('search_docs tool', () => {
  it('finds a known term and returns ranked snippets with line numbers', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const result = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'stt-build' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.count).toBeGreaterThanOrEqual(1);
      const hit = parsed.results.find(
        (r: any) => r.path === 'api/cli-reference.md',
      );
      expect(hit).toBeTruthy();
      expect(hit.score).toBeGreaterThanOrEqual(2); // "stt-build" appears twice
      expect(hit.snippets.length).toBeGreaterThan(0);
      expect(hit.snippets[0]).toHaveProperty('line');
      expect(hit.snippets[0].text.toLowerCase()).toContain('stt-build');
    } finally {
      await close();
    }
  });

  it('searches inside the spec JSON schemas', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const result = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'temporalBucketMs' },
      });
      const parsed = JSON.parse(firstText(result));
      const hit = parsed.results.find(
        (r: any) => r.path === 'spec/manifest.schema.json',
      );
      expect(hit).toBeTruthy();
      expect(hit.title).toBe('STT packed-format manifest');
      expect(hit.snippets[0].text).toContain('temporalBucketMs');
    } finally {
      await close();
    }
  });

  it('windows a snippet around the match on a near-minified JSON line', async () => {
    // A single ~1kB line (real spec/*.json lines reach ~988 chars) with the
    // needle far past the snippet cap: a head-only clamp would drop it.
    const filler = 'a'.repeat(600);
    const docsRoot = await writeFixtureDocsRoot({
      'spec/wide.json': `{"pad":"${filler}","needleProp":{"type":"integer"},"tail":"${filler}"}\n`,
    });
    roots.push(docsRoot);
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), docsRoot),
    );
    try {
      const result = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'needleProp' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.count).toBe(1);
      const snippet = parsed.results[0].snippets[0];
      expect(snippet.line).toBe(1);
      expect(snippet.text).toContain('needleProp');
      // Still hard-bounded (200 chars + the two ellipsis markers).
      expect(snippet.text.length).toBeLessThanOrEqual(202);
    } finally {
      await close();
    }
  });

  it('never matches inside a non-corpus doc', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      for (const query of ['Secret Plan', 'not published']) {
        const result = await client.callTool({
          name: 'search_docs',
          arguments: { query },
        });
        const parsed = JSON.parse(firstText(result));
        expect([query, parsed.count]).toEqual([query, 0]);
      }
    } finally {
      await close();
    }
  });
});

describe('docMimeType (unit)', () => {
  it('maps each admitted extension to its mime type', () => {
    expect(docMimeType('README.md')).toBe('text/markdown');
    expect(docMimeType('api/cli-reference.md')).toBe('text/markdown');
    expect(docMimeType('spec/manifest.schema.json')).toBe('application/json');
    expect(docMimeType('spec/tile-matrix-set.json')).toBe('application/json');
  });
});

describe('listCorpusDocs (unit)', () => {
  it('every listed entry is also readable through the path guard', async () => {
    const root = await docsFixture();
    const entries = await listCorpusDocs(root);
    expect(entries.length).toBe(5);
    for (const entry of entries) {
      expect(() => resolveDocPath(root, entry.path)).not.toThrow();
    }
  });

  /**
   * The listing/search channel must be exactly as narrow as the read channel.
   * Two entries used to slip past it because `readdir` names were trusted
   * without canonicalizing or stat-ing: a symlink under `spec/` pointing OUT of
   * the docs root (its target's H1/`title` became the listed title and its
   * contents were searchable, while `get_doc` correctly refused the same path)
   * and a DIRECTORY named `foo.md`/`foo.json` (listed, then EISDIR on read).
   */
  it('drops symlinks that escape the docs root and dirs named like docs', async () => {
    const root = await docsFixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'stt-mcp-outside-'));
    roots.push(outside);
    await writeFile(
      path.join(outside, 'hosts'),
      '# Host Database\n127.0.0.1\tlocalhost\n',
      'utf8',
    );
    await writeFile(
      path.join(outside, 'evil.json'),
      '{ "title": "Evil", "host": "localhost" }\n',
      'utf8',
    );
    // Both admitted extensions, planted in the one dir that publishes both.
    await symlink(path.join(outside, 'hosts'), path.join(root, 'spec/evil.md'));
    await symlink(
      path.join(outside, 'evil.json'),
      path.join(root, 'spec/evil.json'),
    );
    await mkdir(path.join(root, 'spec/adir.md'));
    await mkdir(path.join(root, 'spec/weird.json'));

    // Declared PUBLISHED_DOC_DIRS order (…, spec, api, guides), not alphabetical.
    const listed = (await listCorpusDocs(root)).map((d) => d.path);
    expect(listed).toEqual([
      'README.md',
      'spec/manifest.schema.json',
      'spec/render-spec.json',
      'api/cli-reference.md',
      'guides/ai-suite.md',
    ]);
    // The out-of-root bytes are not searchable either — this was the leak: the
    // read channel refused these paths while search returned their contents.
    expect(await searchDocs(root, 'localhost')).toEqual([]);
    // The symlinks are refused by the guard, the dirs by the read itself.
    for (const rel of ['spec/evil.md', 'spec/evil.json']) {
      await expect(readDoc(root, rel)).rejects.toThrow(
        /resolves outside the docs root/,
      );
    }
    for (const rel of ['spec/adir.md', 'spec/weird.json']) {
      await expect(readDoc(root, rel)).rejects.toThrow(/EISDIR/);
    }
  });
});

/** True when `rel` is rejected by the corpus allow-list (not by containment). */
function throwsNotPublished(root: string, rel: string): boolean {
  try {
    resolveDocPath(root, rel);
    return false;
  } catch (err) {
    return /not a published doc/.test((err as Error).message);
  }
}

describe('resolveDocPath (unit)', () => {
  it('accepts a corpus path and rejects traversal, absolutes, and non-corpus paths', () => {
    const root = '/docs';
    expect(resolveDocPath(root, 'api/cli-reference.md')).toBe(
      '/docs/api/cli-reference.md',
    );
    expect(resolveDocPath(root, 'README.md')).toBe('/docs/README.md');
    expect(() => resolveDocPath(root, '../../etc/passwd')).toThrow(
      /outside the docs root/,
    );
    expect(() => resolveDocPath(root, '/etc/passwd')).toThrow(/absolute/);
    expect(() => resolveDocPath(root, 'roadmap/secret-plan.md')).toThrow(
      /not a published doc/,
    );
    expect(() => resolveDocPath(root, 'api/nested/deep.md')).toThrow(
      /not a published doc/,
    );
    expect(() => resolveDocPath(root, 'api/notes.txt')).toThrow(
      /not a published doc/,
    );
  });

  it('accepts spec/*.json but nothing the widening did not admit', () => {
    const root = '/docs';
    expect(resolveDocPath(root, 'spec/manifest.schema.json')).toBe(
      '/docs/spec/manifest.schema.json',
    );
    expect(resolveDocPath(root, 'spec/tile-matrix-set.json')).toBe(
      '/docs/spec/tile-matrix-set.json',
    );
    // JSON is published from spec/ ONLY.
    for (const rel of [
      'api/manifest.schema.json',
      'guides/thing.json',
      'intro/thing.json',
      'architecture/thing.json',
      'roadmap/secret.json',
      'package.json',
    ]) {
      // `rel` is folded into the assertion so a failure names the offender.
      expect([rel, throwsNotPublished(root, rel)]).toEqual([rel, true]);
    }
    // Other extensions stay rejected inside spec/, nesting still rejected, and
    // a bare ".md"/".json" dotfile is not a doc.
    expect(() => resolveDocPath(root, 'spec/notes.txt')).toThrow(
      /not a published doc/,
    );
    expect(() => resolveDocPath(root, 'spec/schema.json.bak')).toThrow(
      /not a published doc/,
    );
    expect(() => resolveDocPath(root, 'spec/nested/deep.json')).toThrow(
      /not a published doc/,
    );
    expect(() => resolveDocPath(root, 'spec/.json')).toThrow(
      /not a published doc/,
    );
    expect(() => resolveDocPath(root, 'api/.md')).toThrow(
      /not a published doc/,
    );
    // Traversal is unaffected by the widening.
    expect(() => resolveDocPath(root, '../spec/manifest.schema.json')).toThrow(
      /outside the docs root/,
    );
    expect(() => resolveDocPath(root, 'spec/../../secrets.json')).toThrow(
      /outside the docs root/,
    );
    expect(() => resolveDocPath(root, '/etc/manifest.schema.json')).toThrow(
      /absolute/,
    );
  });
});
