/**
 * Exercises the documentation surface — the `stt://docs/<path>` resource and
 * the `get_doc` / `search_docs` tools — over an in-process MCP transport, plus
 * a direct unit check of the path-traversal guard. Uses the same fixture/harness
 * style as `server.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSttMcpServer } from '../src/server';
import { resolveDocPath } from '../src/docs';
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
  // A roadmap doc lives in the docs tree but is NOT part of the published corpus.
  'roadmap/secret-plan.md':
    '# Secret Plan\n\nInternal only — must never be served.\n',
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
      ]);
      // The roadmap doc is present on disk but must not be enumerated.
      expect(docNames).not.toContain('roadmap/secret-plan.md');
      // Multi-segment paths are percent-encoded into a single URI segment.
      const cliRef = resources.find((r) => r.name === 'api/cli-reference.md');
      expect(cliRef?.uri).toBe('stt://docs/api%2Fcli-reference.md');
      expect(cliRef?.title).toBe('CLI Reference');
      expect(cliRef?.mimeType).toBe('text/markdown');
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
      const result = await client.callTool({
        name: 'get_doc',
        arguments: { path: 'roadmap/secret-plan.md' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).not.toContain('Internal only');
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

  it('never matches inside a non-corpus doc', async () => {
    const { client, close } = await connectedClient(
      baseConfig(await emptyDataRoot(), await docsFixture()),
    );
    try {
      const result = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'Secret Plan' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.count).toBe(0);
    } finally {
      await close();
    }
  });
});

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
});
