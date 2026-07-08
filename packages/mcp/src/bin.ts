#!/usr/bin/env node
// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * `stt-mcp` — the CLI entry point (package.json `bin`). Boots the
 * `@poopdeck.gl/mcp` server over stdio (default) or Streamable HTTP.
 */
import { createServer as createHttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSttMcpServer } from './server.js';
import { parseCliArgs, HelpRequested } from './config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof HelpRequested) {
      process.stdout.write(err.message);
      return;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const server = await createSttMcpServer(config);

  if (config.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stdout is the JSON-RPC wire — every log line goes to stderr.
    process.stderr.write(`stt-mcp: stdio transport connected (data-root: ${config.dataRoot})\n`);
    return;
  }

  // Streamable HTTP, stateless mode (no sessionIdGenerator): one transport
  // shared across requests, appropriate for a single local/dev client. A
  // multi-client production deployment should front this with a
  // session-aware reverse proxy or run one process per client — this CLI
  // targets the same "self-hostable, point an agent at it" use case as
  // stdio, just over a socket instead of a pipe.
  //
  // DNS-rebinding protection is REQUIRED here: the default 127.0.0.1 bind is
  // otherwise reachable from a browser via a rebinding attack, and with
  // --allow-cli that means browser-driven arbitrary file R/W + subprocess
  // spawn. The Host/Origin allow-lists come from config (bind host + loopback
  // aliases by default; extended via --allowed-host/--allowed-origin).
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
  });
  await server.connect(transport);

  const httpServer = createHttpServer((req, res) => {
    transport.handleRequest(req, res).catch((err: unknown) => {
      process.stderr.write(`stt-mcp: request handling failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });
  process.stderr.write(
    `stt-mcp: streamable HTTP transport listening on http://${config.host}:${config.port}/ (data-root: ${config.dataRoot})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`stt-mcp: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
