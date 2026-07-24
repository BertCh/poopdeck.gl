#!/usr/bin/env node
/**
 * Publish-shape smoke test: pack every publishable package into a tarball
 * (pnpm rewrites workspace:* to concrete versions at pack time), install the
 * tarballs into scratch projects, and `import()` every `exports` subpath
 * under plain Node ESM resolution.
 *
 * Two scratch installs plus a tarball-shape check:
 *   (a) full   — all tarballs + every peer; imports every exports key of
 *                every package. Catches extensionless-ESM emit, missing dist
 *                files, and exports-map entries that point at nothing.
 *   (b) deck-free — core + playback + react tarballs with react/react-dom
 *                only (NO @deck.gl/*); imports the react barrel. Regression
 *                test for HoverPreview leaking deck.gl into the base import.
 *   (c) mcp shape — @poopdeck.gl/mcp is a CLI + docs bundle, not just a
 *                library; (a) cannot see either. Asserts the `stt-mcp` bin is
 *                present and executable in the tarball, and that the
 *                build-time docs corpus actually shipped.
 *
 * Run from the repo root after `pnpm turbo run build`: node scripts/smoke-pack.mjs
 */
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PACKAGES = [
  'core',
  'playback',
  'layers',
  'maplibre',
  'three',
  'cesium',
  'react',
  'mcp',
];

// Peers at the workspace's dev-pinned majors. Keep in sync with pnpm.overrides.
const PEERS = [
  '@deck.gl/core@9.3.2',
  '@deck.gl/layers@9.3.2',
  '@deck.gl/aggregation-layers@9.3.2',
  '@deck.gl/extensions@9.3.2',
  '@deck.gl/geo-layers@9.3.2',
  '@deck.gl/mesh-layers@9.3.2',
  '@deck.gl/react@9.3.2',
  '@luma.gl/core@9.3.3',
  '@luma.gl/engine@9.3.3',
  'three@0.184.0',
  'maplibre-gl@4',
  'cesium@1',
  'react@19.2.0',
  'react-dom@19.2.0',
  '@react-three/fiber@9',
  '@react-three/drei@10',
];

const sh = (cmd, cwd) =>
  execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });

function packAll(dest) {
  const tarballs = [];
  for (const p of PACKAGES) {
    sh(
      `pnpm pack --pack-destination ${JSON.stringify(dest)}`,
      join(ROOT, 'packages', p),
    );
  }
  for (const f of readdirSync(dest))
    if (f.endsWith('.tgz')) tarballs.push(join(dest, f));
  if (tarballs.length !== PACKAGES.length) {
    throw new Error(
      `expected ${PACKAGES.length} tarballs, found ${tarballs.length}`,
    );
  }
  return tarballs;
}

function scratchProject(dir, installs) {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }),
  );
  sh(
    `npm install --no-audit --no-fund --loglevel=error ${installs.map((i) => JSON.stringify(i)).join(' ')}`,
    dir,
  );
}

function importAllExports(dir, pkgNames) {
  const failures = [];
  for (const name of pkgNames) {
    const pj = JSON.parse(
      readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'),
    );
    for (const [key, target] of Object.entries(pj.exports ?? {})) {
      const spec = name + key.slice(1);
      try {
        if (key.endsWith('.css')) {
          // Asset subpaths (e.g. ./styles.css) are for bundlers, not Node's
          // import() — the gate here is that the exports entry points at a
          // real, non-empty file in the tarball.
          const rel = typeof target === 'string' ? target : target?.default;
          const st = statSync(join(dir, 'node_modules', name, rel));
          if (st.size === 0) throw new Error('empty asset file');
        } else {
          sh(
            `node --input-type=module -e "const m = await import(process.argv[1]); if (Object.keys(m).length === 0) throw new Error('empty namespace')" ${JSON.stringify(spec)}`,
            dir,
          );
        }
        console.log(`  ok   ${spec}`);
      } catch (e) {
        failures.push(spec);
        const line =
          String(e.stderr ?? e.message)
            .split('\n')
            .find((l) => /Error/.test(l)) ?? 'import failed';
        console.error(`  FAIL ${spec} — ${line.trim().slice(0, 140)}`);
      }
    }
  }
  return failures;
}

// @poopdeck.gl/mcp ships more than a library, and neither extra survives an
// import test: the package loads fine while `npx @poopdeck.gl/mcp` has no CLI
// (missing/non-executable bin) and get_doc / search_docs / stt://docs serve an
// empty corpus (missing docs/). The corpus is NOT in git — packages/mcp/
// scripts/copy-docs.mjs materialises it at build time — so a tarball packed
// from a half-built tree loses it silently. Both are asserted on the tarball.
//
// Corpus rule mirrors copy-docs.mjs (and `isCorpusRelPath` in packages/mcp/
// src/docs.ts): docs/README.md plus every DIRECT child of docs/{intro,
// architecture,spec,api,guides} whose extension that dir admits — `.md`
// everywhere, plus `.json` under docs/spec/ for the four normative
// machine-readable contracts (manifest.schema.json, scene.schema.json,
// render-spec.json, tile-matrix-set.json). docs/roadmap is excluded.
// The JSON half matters: it shipped broken once, and a `.md`-only expectation
// here would let a tarball built by an older copy-docs pass with the schemas
// silently missing.
const MCP_DOC_DIRS = ['intro', 'architecture', 'spec', 'api', 'guides'];
/** Dirs whose direct `*.json` children publish too (mirrors `JSON_DOC_DIRS`). */
const MCP_JSON_DOC_DIRS = ['spec'];
/** Union of every admitted extension — what counts as a doc when hunting strays. */
const MCP_DOC_EXTENSIONS = ['.md', '.json'];

/** Extensions bundled for a published dir — mirrors `allowedExtensions()`. */
function mcpDocExtensions(dir) {
  return MCP_JSON_DOC_DIRS.includes(dir) ? ['.md', '.json'] : ['.md'];
}

function expectedMcpDocs() {
  const want = ['docs/README.md'];
  for (const dir of MCP_DOC_DIRS) {
    const exts = mcpDocExtensions(dir);
    for (const name of readdirSync(join(ROOT, 'docs', dir))) {
      // `name.length > ext.length` so a bare ".md"/".json" dotfile is not a doc.
      if (exts.some((ext) => name.length > ext.length && name.endsWith(ext))) {
        want.push(`docs/${dir}/${name}`);
      }
    }
  }
  return want;
}

/** Map of `package/`-relative path → mode string for a packed tarball. */
function tarballEntries(tarball) {
  const entries = new Map();
  for (const line of sh(`tar -tzvf ${JSON.stringify(tarball)}`).split('\n')) {
    const m = /^(\S+)\s.*?\spackage\/(.+)$/.exec(line);
    if (m && !m[2].endsWith('/')) entries.set(m[2], m[1]);
  }
  return entries;
}

function checkMcpTarball(tarball) {
  const failures = [];
  const entries = tarballEntries(tarball);
  const pj = JSON.parse(
    readFileSync(join(ROOT, 'packages', 'mcp', 'package.json'), 'utf8'),
  );

  const bins = Object.entries(pj.bin ?? {});
  if (bins.length === 0) {
    failures.push('bin');
    console.error('  FAIL no `bin` entry in @poopdeck.gl/mcp package.json');
  }
  for (const [binName, rel] of bins) {
    const path = rel.replace(/^\.\//, '');
    const mode = entries.get(path);
    if (!mode) {
      failures.push(`bin ${binName}`);
      console.error(`  FAIL bin ${binName} — ${path} not in tarball`);
    } else if (mode[3] !== 'x') {
      failures.push(`bin ${binName}`);
      console.error(`  FAIL bin ${binName} — ${path} not executable (${mode})`);
    } else {
      console.log(`  ok   bin ${binName} → ${path} (${mode})`);
    }
  }

  const want = expectedMcpDocs();
  const missing = want.filter((d) => !entries.has(d));
  // Stale sweeps the SAME extension set in the other direction, so a `.json`
  // left behind by a rename (or one copied into a dir that only admits `.md`)
  // fails just as loudly as a missing one.
  const stale = [...entries.keys()].filter(
    (p) =>
      p.startsWith('docs/') &&
      MCP_DOC_EXTENSIONS.some((ext) => p.endsWith(ext)) &&
      !want.includes(p),
  );
  if (missing.length || stale.length) {
    failures.push('bundled docs');
    console.error(
      `  FAIL bundled docs — ${missing.length} missing, ${stale.length} stale of ${want.length} (rebuild @poopdeck.gl/mcp)`,
    );
    for (const d of missing.slice(0, 5)) console.error(`       missing ${d}`);
    for (const d of stale.slice(0, 5)) console.error(`       stale   ${d}`);
  } else {
    console.log(`  ok   bundled docs corpus (${want.length} files)`);
  }
  return failures;
}

const work = mkdtempSync(
  join(process.env.RUNNER_TEMP ?? tmpdir(), 'stt-smoke-'),
);
console.log(`workdir: ${work}`);
const tarballDir = join(work, 'tarballs');
sh(`mkdir -p ${JSON.stringify(tarballDir)}`);
const tarballs = packAll(tarballDir);

console.log('\n[a] full install — every exports subpath of every package');
const full = join(work, 'full');
sh(`mkdir -p ${JSON.stringify(full)}`);
scratchProject(full, [...tarballs, ...PEERS]);
const fullFailures = importAllExports(
  full,
  PACKAGES.map((p) => `@poopdeck.gl/${p}`),
);

console.log(
  '\n[b] deck-free install — react barrel must import without @deck.gl/*',
);
const deckFree = join(work, 'deck-free');
sh(`mkdir -p ${JSON.stringify(deckFree)}`);
const bTarballs = tarballs.filter(
  (t) => /(core|playback|react)-0\./.test(t) && !/three/.test(t),
);
scratchProject(deckFree, [...bTarballs, 'react@19.2.0', 'react-dom@19.2.0']);
let deckFreeFailed = false;
try {
  sh(
    `node --input-type=module -e "await import('@poopdeck.gl/react')"`,
    deckFree,
  );
  console.log('  ok   @poopdeck.gl/react (no deck.gl installed)');
} catch (e) {
  deckFreeFailed = true;
  console.error(
    `  FAIL @poopdeck.gl/react without deck.gl — ${String(e.stderr).split('\n')[0]}`,
  );
}

console.log('\n[c] mcp publish shape — stt-mcp bin + bundled docs corpus');
const mcpTarball = tarballs.find((t) => /[/-]mcp-\d/.test(t));
let mcpFailures = [];
if (!mcpTarball) {
  mcpFailures = ['tarball'];
  console.error('  FAIL @poopdeck.gl/mcp tarball not produced');
} else {
  mcpFailures = checkMcpTarball(mcpTarball);
}

if (fullFailures.length || deckFreeFailed || mcpFailures.length) {
  console.error(
    `\nsmoke-pack FAILED (${fullFailures.length} subpath failures${deckFreeFailed ? ' + deck-free regression' : ''}${mcpFailures.length ? ` + ${mcpFailures.length} mcp publish-shape failures` : ''})`,
  );
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
console.log('\nsmoke-pack PASSED');
