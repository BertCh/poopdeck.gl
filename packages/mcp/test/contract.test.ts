/**
 * CONTRACT TESTS — gates that make doc/code drift impossible.
 *
 * Every assertion in this file exists because one of these four pairs has
 * silently diverged before, and nothing else in the suite would notice:
 *
 *   1. the tools `server.ts` actually registers  ⇄  the tool tables in
 *      `docs/api/stt-mcp.md`,
 *   2. the `--help` text `config.ts` prints      ⇄  the fenced block that doc
 *      reproduces under "## The `stt-mcp` command",
 *   3. the `STT_GENERATE_DATASETS` enum in `server.ts` (a HAND-COPY)  ⇄  the
 *      real clap subcommand enum in `crates/stt-generate/src/main.rs`,
 *   4. the corpus allow-list in `src/docs.ts` (what the server will SERVE)  ⇄
 *      the copy allow-list in `scripts/copy-docs.mjs` (what a published install
 *      actually SHIPS).
 *
 * These are deliberately strict. If one fails, the fix is to update whichever
 * side is stale — NOT to loosen the assertion.
 *
 * Paths are resolved from `import.meta.url`, never from `process.cwd()`, so the
 * gates hold whether vitest runs from the package dir or the repo root.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSttMcpServer } from '../src/server';
import { listCorpusDocs } from '../src/docs';
import { USAGE } from '../src/config';
import type { SttMcpConfig } from '../src/config';
import {
  makeManifestJson,
  writeFixtureDataRoot,
  cleanupDataRoot,
} from './fixtures';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/packages/mcp/test
const PKG_ROOT = path.resolve(HERE, '..'); // <repo>/packages/mcp
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..'); // <repo>

const SERVER_SRC = path.join(PKG_ROOT, 'src', 'server.ts');
const MCP_DOC = path.join(REPO_ROOT, 'docs', 'api', 'stt-mcp.md');
const COPY_DOCS_SCRIPT = path.join(PKG_ROOT, 'scripts', 'copy-docs.mjs');
const execFileAsync = promisify(execFile);
const GENERATE_MAIN_RS = path.join(
  REPO_ROOT,
  'crates',
  'stt-generate',
  'src',
  'main.rs',
);

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

/**
 * Boots a real `McpServer` over `InMemoryTransport` (same harness shape as
 * `server.test.ts`) and returns the live tool list. Introspecting the SDK's
 * own registry is the robust source of truth: it sees whatever
 * `createSttMcpServer` actually registered, including anything gated behind
 * `allowCli`.
 */
async function listRegisteredTools(
  allowCli: boolean,
): Promise<{ name: string; inputSchema: unknown }[]> {
  const root = await writeFixtureDataRoot({ fixture: makeManifestJson() });
  try {
    const config: SttMcpConfig = {
      dataRoot: root,
      // Non-existent docs root: the doc tools degrade to an empty corpus, and
      // nothing in this file depends on the corpus contents.
      docsRoot: path.join(root, '__no_docs__'),
      allowCli,
      transport: 'stdio',
      host: '127.0.0.1',
      port: 0,
    };
    const server = await createSttMcpServer(config);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'contract-test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        inputSchema: t.inputSchema as unknown,
      }));
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await cleanupDataRoot(root);
  }
}

/** Normalizes a block of CLI text for comparison: trailing whitespace per line, and leading/trailing blank lines, carry no meaning. */
function normalizeBlock(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** The slice of `docs/api/stt-mcp.md` between `## Tools` and the next `##` heading. */
function toolsSection(doc: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Tools');
  expect(
    start,
    'docs/api/stt-mcp.md must have a "## Tools" section',
  ).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## (?!#)/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * First-column tool names from every markdown table in a chunk of the doc.
 * A tool row's first cell is a single backticked snake_case identifier — the
 * `stt://…` resource table and the header/separator rows never match, so this
 * picks out exactly the tool rows.
 */
function toolNamesInTables(section: string): string[] {
  const names: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const first = line.split('|')[1]?.trim() ?? '';
    const m = /^`([a-z][a-z0-9_]*)`$/.exec(first);
    if (m) names.push(m[1]);
  }
  return names;
}

// --------------------------------------------------------------------------
// 1. TOOL-DOC PARITY
// --------------------------------------------------------------------------

describe('contract: registered tools ⇄ docs/api/stt-mcp.md', () => {
  let registered: string[];
  let doc: string;

  beforeAll(async () => {
    // `allowCli: true` so the three gated execution tools are visible too —
    // this must be the FULL tool surface, since the doc documents all of it.
    registered = (await listRegisteredTools(true)).map((t) => t.name).sort();
    doc = await readFile(MCP_DOC, 'utf8');
  });

  /**
   * DRIFT PREVENTED: a tool registered under a computed/aliased name that a
   * source scan of `registerTool('<literal>')` would miss. Every other
   * assertion here trusts the live registry; this one proves the registry and
   * the source literals still describe the same set, so a reader grepping
   * `registerTool(` in `server.ts` gets the truth.
   */
  it('every registered tool comes from a literal registerTool(<name>) call in server.ts', async () => {
    const src = await readFile(SERVER_SRC, 'utf8');
    const fromSource = [
      ...src.matchAll(/server\.registerTool\(\s*'([^']+)'/g),
    ].map((m) => m[1]);
    expect(
      new Set(fromSource).size,
      'duplicate registerTool name in server.ts',
    ).toBe(fromSource.length);
    expect(fromSource.sort()).toEqual(registered);
  });

  /**
   * DRIFT PREVENTED: a tool is added to `server.ts` and never documented — an
   * agent reading the reference has no idea it exists. Fails today for any
   * tool missing a row in the doc's tool tables.
   */
  it('every registered tool has a row in the doc tool tables', () => {
    const documented = new Set(toolNamesInTables(toolsSection(doc)));
    const undocumented = registered.filter((n) => !documented.has(n));
    expect(
      undocumented,
      `tools registered by server.ts but absent from the tool tables in ${MCP_DOC}`,
    ).toEqual([]);
  });

  /**
   * DRIFT PREVENTED: the reverse — a tool is renamed or removed in
   * `server.ts` and the doc keeps advertising the dead name, so an agent calls
   * a tool that does not exist.
   */
  it('every tool documented in the doc tool tables is really registered', () => {
    const documented = toolNamesInTables(toolsSection(doc));
    expect(
      new Set(documented).size,
      'duplicate tool row in the doc tables',
    ).toBe(documented.length);
    const phantom = documented.filter((n) => !registered.includes(n));
    expect(
      phantom,
      `tools documented in ${MCP_DOC} that no longer exist in server.ts`,
    ).toEqual([]);
  });

  /**
   * DRIFT PREVENTED: a tool moves across the `--allow-cli` boundary (or a new
   * one lands on the wrong side) while the doc keeps it filed under the old
   * heading. The doc's section headings are load-bearing security copy — a
   * tool documented as "always registered" that actually needs `--allow-cli`
   * (or worse, the inverse) misleads about what an ungated server exposes.
   */
  it('doc section headings match which tools survive without --allow-cli', async () => {
    const ungated = new Set(
      (await listRegisteredTools(false)).map((t) => t.name),
    );
    const section = toolsSection(doc);
    // Split into `### …` subsections, each with its own table.
    const chunks = section
      .split(/\n(?=### )/)
      .filter((c) => c.startsWith('### '));
    expect(
      chunks.length,
      'expected ### subsections under ## Tools',
    ).toBeGreaterThan(0);

    for (const chunk of chunks) {
      const heading = chunk.split('\n')[0];
      const tools = toolNamesInTables(chunk);
      if (tools.length === 0) continue;
      // Guard the classifier itself: an unrecognized heading phrasing must
      // fail loudly rather than silently skip the check below.
      const alwaysRegistered = /always registered/.test(heading);
      const cliOnly = /only registered with/.test(heading);
      expect(
        alwaysRegistered !== cliOnly,
        `heading must say exactly one of "always registered" / "only registered with": ${heading}`,
      ).toBe(true);
      for (const tool of tools) {
        expect(
          ungated.has(tool),
          `${tool} is under "${heading}" but ${ungated.has(tool) ? 'IS' : 'is NOT'} registered without --allow-cli`,
        ).toBe(alwaysRegistered);
      }
    }
  });
});

// --------------------------------------------------------------------------
// 2. HELP-BLOCK PARITY
// --------------------------------------------------------------------------

describe('contract: config.ts USAGE ⇄ the doc help block', () => {
  /**
   * DRIFT PREVENTED: a flag is added, removed, renamed, or re-described in
   * `config.ts`'s `USAGE` (what `stt-mcp --help` actually prints) while the
   * copy pasted into `docs/api/stt-mcp.md` rots. Readers then configure the
   * server from a help text that does not exist.
   *
   * The comparison is byte-exact on the body; only trailing whitespace and
   * surrounding blank lines are normalized away. Do NOT relax this to a
   * "contains the flag names" check — the descriptions and defaults are
   * exactly the part that goes stale.
   */
  it('the fenced block under "## The `stt-mcp` command" is verbatim USAGE', async () => {
    const doc = await readFile(MCP_DOC, 'utf8');
    const lines = doc.split('\n');
    const headingIdx = lines.findIndex(
      (l) => l.trim() === '## The `stt-mcp` command',
    );
    expect(
      headingIdx,
      'docs/api/stt-mcp.md must have a "## The `stt-mcp` command" section',
    ).toBeGreaterThanOrEqual(0);

    let open = -1;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^## (?!#)/.test(lines[i])) break; // ran into the next section
      if (lines[i].startsWith('```')) {
        open = i;
        break;
      }
    }
    expect(
      open,
      'expected a fenced code block right after that heading',
    ).toBeGreaterThan(headingIdx);

    const close = lines.findIndex((l, i) => i > open && /^```\s*$/.test(l));
    expect(close, 'unterminated fenced code block').toBeGreaterThan(open);

    const docHelp = lines.slice(open + 1, close).join('\n');
    expect(normalizeBlock(docHelp)).toBe(normalizeBlock(USAGE));
  });
});

// --------------------------------------------------------------------------
// 3. GENERATE-DATASET ENUM PARITY
// --------------------------------------------------------------------------

/**
 * heck's `to_kebab_case`, which is what clap's derive uses to turn a
 * `Subcommand` variant name into its CLI subcommand name.
 * `NycTaxiPoints` -> `nyc-taxi-points`, `DriftersHourly` -> `drifters-hourly`,
 * `Ais` -> `ais`, `OsmEdits` -> `osm-edits`.
 */
function variantToSubcommand(variant: string): string {
  return variant
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Extracts the top-level variant names of `enum Commands { … }` from
 * `crates/stt-generate/src/main.rs`.
 *
 * Scans characters rather than matching line shapes: variants come in both
 * tuple (`Earthquakes(datasets::earthquakes::Args)`) and struct
 * (`All { output_dir: PathBuf, … }`) form, and the `///` doc comments contain
 * parentheses and quotes. Comments and string literals are skipped, and only
 * text at brace-depth 1 is kept, so nested field lists and `#[arg(…)]`
 * attributes fall out.
 */
function parseRustSubcommandVariants(src: string): string[] {
  const enumIdx = src.indexOf('enum Commands {');
  if (enumIdx < 0)
    throw new Error('could not find `enum Commands {` in main.rs');
  let i = src.indexOf('{', enumIdx) + 1;

  let depth = 1;
  let out = '';
  let inString = false;
  let inLineComment = false;
  for (; i < src.length && depth > 0; i++) {
    const ch = src[i];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) out += ch;
  }
  if (depth !== 0) throw new Error('unbalanced braces parsing `enum Commands`');

  const variants: string[] = [];
  for (const raw of out.split(',')) {
    // Attribute bodies were dropped as nested `[…]`; a bare `#` may remain.
    const segment = raw.replace(/#/g, '').trim();
    if (segment === '') continue;
    // A segment we cannot read is a PARSER failure, not an empty result — fail
    // loudly rather than silently under-reporting the variant set.
    expect(
      /^[A-Z][A-Za-z0-9_]*$/.test(segment),
      `unparsed segment in enum Commands: ${JSON.stringify(segment)}`,
    ).toBe(true);
    variants.push(segment);
  }
  return variants;
}

describe('contract: STT_GENERATE_DATASETS ⇄ crates/stt-generate subcommands', () => {
  /**
   * DRIFT PREVENTED: `STT_GENERATE_DATASETS` in `server.ts` is a HAND-COPY of
   * the Rust `enum Commands`. A generator added to (or removed from)
   * `stt-generate` leaves the MCP tool advertising a stale zod enum — an agent
   * either cannot reach a real generator, or is offered one that makes
   * `stt-generate` exit with "unrecognized subcommand".
   *
   * Note on `'all'`: it is NOT a synthetic extra in the TS list — `Commands::All`
   * is a genuine clap subcommand (it fans out to the other generators), so the
   * two sets compare with plain equality, no special-casing.
   */
  it('the generate_dataset dataset enum equals the clap subcommand set', async () => {
    const rust = await readFile(GENERATE_MAIN_RS, 'utf8');
    const expected = parseRustSubcommandVariants(rust)
      .map(variantToSubcommand)
      .sort();

    // Read the enum off the LIVE tool schema (what an MCP client actually
    // sees), not off a regex over the TS array literal.
    const tools = await listRegisteredTools(true);
    const gen = tools.find((t) => t.name === 'generate_dataset');
    expect(
      gen,
      'generate_dataset must register with --allow-cli',
    ).toBeDefined();
    const schema = gen!.inputSchema as {
      properties?: { dataset?: { enum?: string[] } };
    };
    const actual = schema.properties?.dataset?.enum;
    expect(
      Array.isArray(actual),
      'generate_dataset.dataset must be a string enum in the published schema',
    ).toBe(true);

    expect([...actual!].sort()).toEqual(expected);
    // Both sides are 17 today (16 real generators + the `all` fan-out). The
    // literal count is a canary: it makes a same-size swap (one generator
    // renamed on one side only) obvious in the failure output above, and this
    // line obvious to update deliberately when a generator is really added.
    expect(expected).toHaveLength(17);
  });

  /**
   * DRIFT PREVENTED: someone adds `#[command(name = "…")]` or
   * `#[command(rename_all = "…")]` to a variant, at which point clap stops
   * deriving the subcommand name from the variant and the kebab-case
   * conversion above silently produces the WRONG expected set — turning the
   * test green on a real divergence.
   */
  it('no clap name/rename_all override invalidates the kebab-case derivation', async () => {
    const rust = await readFile(GENERATE_MAIN_RS, 'utf8');
    const start = rust.indexOf('#[derive(Subcommand)]');
    expect(
      start,
      'expected #[derive(Subcommand)] in main.rs',
    ).toBeGreaterThanOrEqual(0);
    const end = rust.indexOf('\n}', rust.indexOf('enum Commands {'));
    const block = rust.slice(start, end);
    expect(
      /#\[\s*(?:command|clap)\s*\([^\]]*\b(?:name|rename_all)\s*=/.test(block),
      'a clap name/rename_all override was added — variantToSubcommand() must be updated to match',
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 4. CORPUS ALLOW-LIST PARITY (server ⇄ bundler)
// --------------------------------------------------------------------------

describe('contract: src/docs.ts corpus ⇄ scripts/copy-docs.mjs bundle', () => {
  /**
   * DRIFT PREVENTED: `src/docs.ts` decides what the server will SERVE;
   * `scripts/copy-docs.mjs` decides what a published tarball actually SHIPS
   * (the bundled `<pkg>/docs/`, which is the default `docsRoot` for an
   * `npx`/global install). A file admitted by the former but skipped by the
   * latter reads fine in a dev checkout — where `docsRoot` is the repo's own
   * `docs/` — and is silently MISSING for every real user. That is exactly how
   * the `spec/*.json` schemas shipped broken once.
   *
   * Compared against the repo's real `docs/` tree rather than a fixture, so
   * this also catches a newly added published dir that only one side learned
   * about.
   */
  it('every corpus file the server admits is one the bundler copies', async () => {
    const REPO_DOCS = path.join(REPO_ROOT, 'docs');
    // What the server would serve out of the repo docs tree.
    const served = (await listCorpusDocs(REPO_DOCS)).map((d) => d.path).sort();
    expect(
      served.length,
      'expected a non-empty corpus under the repo docs/',
    ).toBeGreaterThan(0);

    // What the bundler would copy, by running the real script against the real
    // tree and reading back the bundle it produced.
    await execFileAsync(process.execPath, [COPY_DOCS_SCRIPT], {
      cwd: PKG_ROOT,
    });
    const bundled = (await listCorpusDocs(path.join(PKG_ROOT, 'docs')))
      .map((d) => d.path)
      .sort();

    const missing = served.filter((p) => !bundled.includes(p));
    expect(
      missing,
      'admitted by src/docs.ts but NOT copied by scripts/copy-docs.mjs — these would 404 for every published install',
    ).toEqual([]);
    // The reverse: shipping a file the server refuses to serve is dead weight
    // in the tarball and a sign the allow-lists disagree the other way.
    const extra = bundled.filter((p) => !served.includes(p));
    expect(
      extra,
      'copied by scripts/copy-docs.mjs but NOT admitted by src/docs.ts',
    ).toEqual([]);
  });

  /**
   * DRIFT PREVENTED: the JSON widening lands in `src/docs.ts` only. Pins the
   * `spec/*.json` schemas as genuinely present on BOTH sides, so the parity
   * assertion above cannot pass vacuously by both lists dropping them.
   */
  it('the spec/*.json schemas are really in the corpus', async () => {
    const served = (await listCorpusDocs(path.join(REPO_ROOT, 'docs'))).map(
      (d) => d.path,
    );
    for (const rel of [
      'spec/manifest.schema.json',
      'spec/scene.schema.json',
      'spec/tile-matrix-set.json',
      'spec/render-spec.json',
    ]) {
      expect(served, `${rel} must be a corpus member`).toContain(rel);
    }
  });
});
