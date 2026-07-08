// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * `stt-mcp` server configuration: CLI flags + environment fallbacks. Kept as
 * a plain parser (no `commander`/`yargs` dependency — this package's only
 * dependencies are `@modelcontextprotocol/sdk` + `zod`, per the campaign's
 * ground rules) since the flag surface is small and fixed.
 */
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type TransportKind = 'stdio' | 'http';

export interface SttMcpConfig {
  /** Directory scanned for packed datasets (subdirs containing `manifest.json`). */
  dataRoot: string;
  /** Directory holding the published documentation corpus (a `docs/` tree — see `docs.ts`); bundled beside the package for offline/npx use. */
  docsRoot: string;
  /** Enables the EXECUTION tool family (`build_dataset`, `validate_dataset`, `generate_dataset`) and the CLI shell-out for `dataset_report`/`recommend_build`/`diff_datasets`. Off by default. */
  allowCli: boolean;
  /** `stdio` (default — spawned by an MCP client) or `http` (Streamable HTTP, stateless). */
  transport: TransportKind;
  /** HTTP transport only. */
  host: string;
  /** HTTP transport only. */
  port: number;
  /** Base URL datasets are served from, for `view_map`'s manifest URLs (e.g. `https://tiles.example.com`). Omit to fall back to raw filesystem paths. */
  publicBaseUrl?: string;
  /** Override for the `stt-optimize` binary (default: resolved from `target/release/` or `PATH`). */
  sttOptimizeBin?: string;
  /** Override for the `stt-build` binary. */
  sttBuildBin?: string;
  /** Override for the `stt-validate` binary. */
  sttValidateBin?: string;
  /** Override for the `stt-generate` binary (reference-dataset generator). */
  sttGenerateBin?: string;
  /**
   * HTTP transport only. Allow-list of `Host` header values (`host:port`) accepted by the
   * DNS-rebinding guard. Defaults to the bind host plus `127.0.0.1`/`localhost` on the bind port;
   * `--allowed-host` flags ADD to this list.
   */
  allowedHosts?: string[];
  /**
   * HTTP transport only. Allow-list of `Origin` header values accepted by the DNS-rebinding guard.
   * Defaults to `http://` origins for each default host; `--allowed-origin` flags ADD to this list.
   */
  allowedOrigins?: string[];
}

/**
 * The sane default `Host` allow-list for the DNS-rebinding guard: the bind host plus the
 * loopback aliases, each on the bind port, so a normal local client keeps working without flags.
 */
function defaultAllowedHosts(host: string, port: number): string[] {
  const hosts = new Set<string>();
  for (const h of [host, '127.0.0.1', 'localhost']) {
    hosts.add(`${h}:${port}`);
  }
  return [...hosts];
}

/** Default `Origin` allow-list: an `http://` origin for each default host. */
function defaultAllowedOrigins(host: string, port: number): string[] {
  return defaultAllowedHosts(host, port).map((h) => `http://${h}`);
}

/** examples/showcase/public/data relative to this package's own install location — the repo's default dataset catalog. */
function defaultDataRoot(): string {
  if (process.env.STT_DATA_ROOT) return process.env.STT_DATA_ROOT;
  // Resolve relative to CWD, not `import.meta.url` — an installed
  // `stt-mcp` has no `examples/` tree beside it; CWD is the natural place
  // to look when no `--data-root`/env override is given, mirroring how the
  // showcase's own dev server is always launched from the repo root.
  return path.resolve(process.cwd(), 'examples/showcase/public/data');
}

/**
 * Default location of the published documentation corpus, in precedence order:
 *   (a) a `docs/` dir BUNDLED beside the installed package (resolved from
 *       `import.meta.url` to the package root, `<pkg>/docs`) — written at build
 *       time by `scripts/copy-docs.mjs`, so an `npx`/global install serves docs
 *       with no repo on disk;
 *   (b) else `<cwd>/docs` — the repo root during dev, the natural place to look;
 *   (c) else the repo layout relative to this package's own source
 *       (`<repo>/packages/mcp` → `<repo>/docs`), for a source/monorepo checkout
 *       where neither of the above exists yet.
 * `$STT_DOCS_ROOT` overrides all three, mirroring `$STT_DATA_ROOT`.
 */
function defaultDocsRoot(): string {
  if (process.env.STT_DOCS_ROOT) return process.env.STT_DOCS_ROOT;
  // `<pkg>/dist/config.js` (built) or `<pkg>/src/config.ts` (dev) → `<pkg>`.
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundled = path.join(pkgRoot, 'docs'); // (a)
  if (existsSync(bundled)) return bundled;
  const cwdDocs = path.resolve(process.cwd(), 'docs'); // (b)
  if (existsSync(cwdDocs)) return cwdDocs;
  return path.resolve(pkgRoot, '..', '..', 'docs'); // (c) <repo>/packages/mcp → <repo>/docs
}

const USAGE = `stt-mcp — MCP server for spatiotemporal tiles (@poopdeck.gl/mcp)

Usage: stt-mcp [options]

  --data-root <dir>          Directory scanned for packed datasets
                              (default: $STT_DATA_ROOT, else
                              ./examples/showcase/public/data)
  --docs-root <dir>          Directory holding the published docs corpus,
                              served via stt://docs/<path> resources and the
                              search_docs/get_doc tools (default:
                              $STT_DOCS_ROOT, else the docs/ bundled beside the
                              package, else ./docs)
  --allow-cli                Enable shell-out tools (build_dataset,
                              validate_dataset, generate_dataset, and the
                              CLI mode of
                              dataset_report/recommend_build/diff_datasets).
                              Off by default.
  --transport <stdio|http>   Transport to serve (default: stdio)
  --host <host>              HTTP transport bind host (default: 127.0.0.1)
  --port <port>              HTTP transport bind port (default: 3900)
  --allowed-host <host>      Add a Host header value (host:port) to the
                              DNS-rebinding allow-list (repeatable). The bind
                              host plus 127.0.0.1/localhost on the bind port
                              are always allowed.
  --allowed-origin <origin>  Add an Origin header value to the DNS-rebinding
                              allow-list (repeatable).
  --public-base-url <url>    Base URL datasets are served from, used by
                              view_map to build manifest URLs
  --stt-optimize-bin <path>  Override the stt-optimize binary path
  --stt-build-bin <path>     Override the stt-build binary path
  --stt-validate-bin <path>  Override the stt-validate binary path
  --stt-generate-bin <path>  Override the stt-generate binary path
  -h, --help                 Show this help

Security: the HTTP transport enforces DNS-rebinding protection using the
Host/Origin allow-lists above. Binding a non-localhost --host together with
--allow-cli exposes browser-driven arbitrary file read/write and subprocess
spawn — only do so on a trusted, access-controlled network.
`;

export class HelpRequested extends Error {}

/** Parses `process.argv.slice(2)`-style args into a config, applying env/default fallbacks. */
export function parseCliArgs(argv: string[]): SttMcpConfig {
  const config: SttMcpConfig = {
    dataRoot: defaultDataRoot(),
    docsRoot: defaultDocsRoot(),
    allowCli: false,
    transport: 'stdio',
    host: '127.0.0.1',
    port: 3900,
  };

  // Collected separately so the final allow-lists = defaults (host/port aware) ∪ user flags.
  const userAllowedHosts: string[] = [];
  const userAllowedOrigins: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i++;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    switch (arg) {
      case '--data-root':
        config.dataRoot = path.resolve(next());
        break;
      case '--docs-root':
        config.docsRoot = path.resolve(next());
        break;
      case '--allow-cli':
        config.allowCli = true;
        break;
      case '--transport': {
        const v = next();
        if (v !== 'stdio' && v !== 'http') throw new Error(`--transport must be "stdio" or "http", got ${JSON.stringify(v)}`);
        config.transport = v;
        break;
      }
      case '--host':
        config.host = next();
        break;
      case '--port':
        config.port = Number(next());
        if (!Number.isFinite(config.port)) throw new Error('--port must be a number');
        break;
      case '--allowed-host':
        userAllowedHosts.push(next());
        break;
      case '--allowed-origin':
        userAllowedOrigins.push(next());
        break;
      case '--public-base-url':
        config.publicBaseUrl = next();
        break;
      case '--stt-optimize-bin':
        config.sttOptimizeBin = next();
        break;
      case '--stt-build-bin':
        config.sttBuildBin = next();
        break;
      case '--stt-validate-bin':
        config.sttValidateBin = next();
        break;
      case '--stt-generate-bin':
        config.sttGenerateBin = next();
        break;
      case '-h':
      case '--help':
        throw new HelpRequested(USAGE);
      default:
        throw new Error(`unrecognized argument: ${arg}\n\n${USAGE}`);
    }
  }

  // Finalize the DNS-rebinding allow-lists now that host/port are known. User flags ADD to the
  // sane defaults so the normal local client works out of the box without any allow-list flags.
  config.allowedHosts = [...new Set([...defaultAllowedHosts(config.host, config.port), ...userAllowedHosts])];
  config.allowedOrigins = [...new Set([...defaultAllowedOrigins(config.host, config.port), ...userAllowedOrigins])];

  return config;
}

export { USAGE };
