#!/usr/bin/env node
/**
 * Doc-drift gate: every `docs/roadmap/<file>.md` a source file names must exist.
 *
 * Source comments in this repo carry their rationale by pointing at the design
 * doc that decided it. Roadmap docs get consolidated periodically, and both
 * consolidations so far left the citations behind — the last one stranded 39
 * source files, 31 of them pointing at a single deleted doc. A dead citation is
 * worse than no citation: the next reader burns time looking for a file that
 * was renamed, and the rationale is only recoverable from git history.
 *
 * Scope is deliberately the SOURCE trees, not `docs/` itself: the roadmap
 * README keeps a retired-doc mapping table (old name → the doc that absorbed
 * it), so naming a deleted file there is correct, not drift.
 *
 * Uses `git grep` — it is C-fast, skips binaries, and already honors
 * .gitignore, so node_modules/ and dist/ never enter the scan.
 *
 * Usage: node .github/scripts/check-roadmap-citations.mjs   # exit 1 on drift
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const ROADMAP = join(ROOT, 'docs/roadmap');
const SCAN = [
  'crates',
  'packages',
  'examples',
  'tools',
  'scripts',
  'poopdeck-ai',
  '.github',
  // This file names docs/roadmap/README.md in its own failure message; without
  // the exclude, the checker reports itself the day that README is renamed.
  ':!.github/scripts/check-roadmap-citations.mjs',
];

// Filenames are lowercase-hyphen by convention, but README.md is cited too.
const CITATION = /docs\/roadmap\/([A-Za-z0-9._-]+\.md)/g;

function gitGrep() {
  try {
    return execFileSync(
      'git',
      ['grep', '-InE', 'docs/roadmap/[A-Za-z0-9._-]+\\.md', '--', ...SCAN],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    // git grep exits 1 with no output when nothing matched; anything else is a
    // real failure and must not be swallowed into a passing gate.
    if (err.status === 1 && !err.stdout) return '';
    throw err;
  }
}

/** `file:line:text` → one entry per distinct doc named on that line. */
const missing = new Map();
let citations = 0;
for (const row of gitGrep().split('\n')) {
  if (!row) continue;
  const m = /^([^:]+):(\d+):([\s\S]*)$/.exec(row);
  if (!m) continue;
  const [, file, line, text] = m;
  for (const hit of text.matchAll(CITATION)) {
    citations += 1;
    const doc = hit[1];
    if (existsSync(join(ROADMAP, doc))) continue;
    if (!missing.has(doc)) missing.set(doc, []);
    const sites = missing.get(doc);
    if (!sites.some((s) => s.file === file && s.line === line)) {
      sites.push({ file, line });
    }
  }
}

if (missing.size === 0) {
  console.log(`roadmap citations: ${citations} checked, all resolve.`);
  process.exit(0);
}

const total = [...missing.values()].reduce((n, sites) => n + sites.length, 0);
console.error(
  `roadmap citations: ${total} reference(s) to ${missing.size} missing doc(s).\n`,
);
for (const [doc, sites] of [...missing].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  console.error(
    `  docs/roadmap/${doc} — does not exist (${sites.length} site(s))`,
  );
  for (const s of sites) console.error(`      ${s.file}:${s.line}`);
  console.error('');
}
console.error(
  'Repoint each comment at the doc that absorbed the old one (see the retired-doc\n' +
    'mapping in docs/roadmap/README.md), or drop the citation. Do not re-create the\n' +
    'deleted file to silence this.',
);
process.exit(1);
