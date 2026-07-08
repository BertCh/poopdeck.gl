#!/usr/bin/env node
/**
 * Publish-shape smoke test: pack every publishable package into a tarball
 * (pnpm rewrites workspace:* to concrete versions at pack time), install the
 * tarballs into scratch projects, and `import()` every `exports` subpath
 * under plain Node ESM resolution.
 *
 * Two scratch installs:
 *   (a) full   — all tarballs + every peer; imports every exports key of
 *                every package. Catches extensionless-ESM emit, missing dist
 *                files, and exports-map entries that point at nothing.
 *   (b) deck-free — core + playback + react tarballs with react/react-dom
 *                only (NO @deck.gl/*); imports the react barrel. Regression
 *                test for HoverPreview leaking deck.gl into the base import.
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

if (fullFailures.length || deckFreeFailed) {
  console.error(
    `\nsmoke-pack FAILED (${fullFailures.length} subpath failures${deckFreeFailed ? ' + deck-free regression' : ''})`,
  );
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
console.log('\nsmoke-pack PASSED');
