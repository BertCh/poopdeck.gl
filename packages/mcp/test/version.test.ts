/**
 * The version the server reports to MCP clients must be the version the
 * package actually ships. `src/version.ts` is generated from `package.json` by
 * `scripts/gen-version.mjs` (first step of `pnpm build`) and committed, so this
 * is the gate that catches a stale generated file — the failure it exists to
 * prevent is the one that shipped: a hand-written `PACKAGE_VERSION = '0.4.0'`
 * in `server.ts` while npm served 0.5.0, so every `initialize` response lied.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSttMcpServer } from '../src/server';
import { PACKAGE_VERSION } from '../src/version';

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function packageJsonVersion(): string {
  return JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
    .version;
}

describe('PACKAGE_VERSION', () => {
  it('matches package.json (regenerate with `node scripts/gen-version.mjs`)', () => {
    expect(PACKAGE_VERSION).toBe(packageJsonVersion());
  });

  it('is what an MCP client sees in the initialize response', async () => {
    const server = await createSttMcpServer({
      // A non-existent data/docs root is fine: construction only best-effort
      // scans it to seed the instructions block.
      dataRoot: path.join(PKG_ROOT, '__no_data__'),
      docsRoot: path.join(PKG_ROOT, '__no_docs__'),
      allowCli: false,
      transport: 'stdio',
      host: '127.0.0.1',
      port: 0,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'version-test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: 'stt-mcp',
        version: packageJsonVersion(),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
