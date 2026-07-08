#!/usr/bin/env node
// Throwaway MCP client harness for evaluating @poopdeck.gl/mcp.
// Drives the built server (dist/bin.js) over stdio via the official SDK client.
//
// Usage:
//   node mcp-harness.mjs [--allow-cli] [--data-root <dir>] <command> [args...]
//
// Commands:
//   list-tools                      -> JSON array of {name, description, inputSchema}
//   list-resources                  -> resources/list
//   list-resource-templates         -> resources/templates/list
//   list-prompts                    -> prompts/list
//   instructions                    -> server initialize `instructions` block
//   call <tool> [jsonArgs]          -> tools/call result (jsonArgs default {})
//   read-resource <uri>             -> resources/read
//
// Everything prints a single JSON object to stdout: {ok, ...} or {ok:false, error}.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SERVER = path.join(HERE, 'dist', 'bin.js');
const DEFAULT_DATA_ROOT = path.join(
  REPO_ROOT,
  'examples',
  'showcase',
  'public',
  'data',
);

function fail(msg, extra) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: String(msg), ...extra }, null, 2) + '\n',
  );
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  let allowCli = false;
  let dataRoot = DEFAULT_DATA_ROOT;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allow-cli') allowCli = true;
    else if (argv[i] === '--data-root') dataRoot = path.resolve(argv[++i]);
    else rest.push(argv[i]);
  }
  const [command, ...cmdArgs] = rest;
  if (!command) fail('no command given');

  const serverArgs = [SERVER, '--data-root', dataRoot];
  if (allowCli) serverArgs.push('--allow-cli');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'stt-mcp-harness', version: '0.0.0' },
    { capabilities: {} },
  );

  const stderrChunks = [];
  const t0 = process.hrtime.bigint();
  try {
    await client.connect(transport);
    if (transport.stderr)
      transport.stderr.on('data', (c) => stderrChunks.push(c.toString()));

    const initInstructions = client.getInstructions?.() ?? null;
    let out;

    switch (command) {
      case 'list-tools': {
        const r = await client.listTools();
        out = {
          tools: r.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
        break;
      }
      case 'list-resources':
        out = await client.listResources();
        break;
      case 'list-resource-templates':
        out = await client.listResourceTemplates();
        break;
      case 'list-prompts':
        out = await client.listPrompts().catch((e) => ({ error: String(e) }));
        break;
      case 'instructions':
        out = { instructions: initInstructions };
        break;
      case 'call': {
        const [tool, jsonArgs] = cmdArgs;
        if (!tool) fail('call requires a tool name');
        let args = {};
        if (jsonArgs) {
          try {
            args = JSON.parse(jsonArgs);
          } catch (e) {
            fail(`bad JSON args: ${e.message}`);
          }
        }
        const started = process.hrtime.bigint();
        const r = await client.callTool({ name: tool, arguments: args });
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        out = {
          tool,
          args,
          isError: r.isError ?? false,
          durationMs: Math.round(ms),
          content: r.content,
          structuredContent: r.structuredContent,
        };
        break;
      }
      case 'read-resource': {
        const [uri] = cmdArgs;
        if (!uri) fail('read-resource requires a uri');
        out = await client.readResource({ uri });
        break;
      }
      default:
        fail(`unknown command: ${command}`);
    }

    const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
    await client.close();
    process.stdout.write(
      JSON.stringify(
        { ok: true, command, totalMs: Math.round(totalMs), ...out },
        null,
        2,
      ) + '\n',
    );
  } catch (err) {
    fail(err instanceof Error ? (err.stack ?? err.message) : err, {
      serverStderr: stderrChunks.join('').slice(-2000),
    });
  }
}

main();
