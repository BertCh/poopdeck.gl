#!/usr/bin/env node
/**
 * Doc-drift gate: every doc a source file names must exist, AND every `§`
 * section it names must exist inside that doc.
 *
 * Source comments in this repo carry their rationale by pointing at the design
 * doc that decided it. Roadmap docs get consolidated periodically, and both
 * consolidations so far left the citations behind — the last one stranded 39
 * source files, 31 of them pointing at a single deleted doc. A dead citation is
 * worse than no citation: the next reader burns time looking for a file that
 * was renamed, and the rationale is only recoverable from git history.
 *
 * The FILENAME half caught that. The ANCHOR half is why this file grew: a
 * consolidation can keep the filename and renumber the document underneath it,
 * which the filename check cannot see. `av-cockpit.md` was rewritten from
 * lettered subsections (§2a…§2f, §3c, §3d) to §1.1–§1.4, stranding 13 citations
 * across the layer and the extractors while the gate reported "all resolve".
 * A section citation is the load-bearing half anyway — `av_common.py:8` tells
 * extractor authors not to deviate from a *numbered section*.
 *
 * Two citation shapes are recognised, because both are already in the tree:
 * a full `docs/roadmap/<file>.md` path, and a bare `<file>.md §N` naming a doc
 * in one of the KNOWN_DIRS by filename alone (the bare form is what the AV
 * extractors use). A bare filename that matches nothing is ignored rather than
 * reported — source comments name plenty of unrelated .md files.
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
// Dirs whose docs may be cited by bare filename + §section. `spec` is included
// because consolidation MOVES contracts here (the roadmap README's "contract
// rule"), so citations land on spec pages and must stay checkable.
const KNOWN_DIRS = ['docs/roadmap', 'docs/spec'];
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
// Group 1 = optional known-dir prefix, 2 = filename, 3 = optional §section.
// A trailing sentence period is naturally excluded: `\.` must be followed by a
// digit, so `§7.` captures `7` and `§8.5.` captures `8.5`. A lettered anchor
// (`§3c`) IS captured, precisely so it can be reported as unresolved.
const CITATION = new RegExp(
  String.raw`(?:(${KNOWN_DIRS.join('|')})\/)?([A-Za-z0-9._-]+\.md)` +
    String.raw`(?:[ \t]*§[ \t]*(\d+(?:\.\d+)*[a-z]?))?`,
  'g',
);

/** filename → repo-relative path, for resolving the bare `<file>.md §N` form. */
const knownDocs = new Map();
for (const dir of KNOWN_DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs)) {
    if (name.endsWith('.md') && !knownDocs.has(name)) {
      knownDocs.set(name, `${dir}/${name}`);
    }
  }
}

/**
 * Numbered headings in a doc, e.g. `## 3. Foo` and `### 3.1 Bar` → {3, 3.1}.
 * Every ancestor is registered too, so citing `§9` resolves against a doc whose
 * only numbered heading is `§9.1` — citing the parent of a real section is a
 * legitimate reference to the whole section, not drift.
 *
 * A LETTERED leaf (`#### 8.5a Foo`) registers both itself and its numeric
 * parent, so `§8.5a` and `§8.5` both resolve. This half was missing while the
 * citation regex already captured `[a-z]?`: the asymmetry was deliberate back
 * when every lettered anchor in the tree was drift (the old `av-cockpit §3c`),
 * and it silently became wrong the moment a doc grew real `8.5a` / `8.5b`
 * subsections — a correct citation was reported as missing.
 */
const sectionCache = new Map();
function sectionIds(relPath) {
  let ids = sectionCache.get(relPath);
  if (ids) return ids;
  ids = new Set();
  for (const line of readFileSync(join(ROOT, relPath), 'utf8').split('\n')) {
    const m = /^#{1,6}[ \t]+(\d+(?:\.\d+)*)([a-z]?)(?![0-9A-Za-z])/.exec(line);
    if (!m) continue;
    const parts = m[1].split('.');
    for (let i = 1; i <= parts.length; i++)
      ids.add(parts.slice(0, i).join('.'));
    if (m[2]) ids.add(m[1] + m[2]);
  }
  sectionCache.set(relPath, ids);
  return ids;
}

function gitGrep() {
  try {
    // Two alternatives: the explicit path form, and a bare `<file>.md §N`.
    // The bare form is the one the AV extractors use, and grepping only the
    // path form is why 13 stranded `av-cockpit.md §2c`-style anchors sat
    // invisible behind a passing gate.
    return execFileSync(
      'git',
      [
        'grep',
        '-InE',
        String.raw`docs/(roadmap|spec)/[A-Za-z0-9._-]+\.md|[A-Za-z0-9._-]+\.md[ \t]*§`,
        '--',
        ...SCAN,
      ],
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
/** `doc §section` → sites, for citations whose FILE resolves but section does not. */
const badAnchors = new Map();
let citations = 0;
let anchorsChecked = 0;
for (const row of gitGrep().split('\n')) {
  if (!row) continue;
  const m = /^([^:]+):(\d+):([\s\S]*)$/.exec(row);
  if (!m) continue;
  const [, file, line, text] = m;
  for (const hit of text.matchAll(CITATION)) {
    const [, dir, doc, section] = hit;

    // Bare `<file>.md` with no §section carries no checkable claim beyond a
    // filename we may not own — only the explicit path form is a citation.
    if (!dir && !section) continue;
    citations += 1;

    // Resolve: explicit dir wins; otherwise the bare filename must name a doc
    // in a known dir, else it is some unrelated .md and not ours to police.
    const rel = dir ? `${dir}/${doc}` : knownDocs.get(doc);
    if (!rel) continue;

    if (!existsSync(join(ROOT, rel))) {
      if (!missing.has(rel)) missing.set(rel, []);
      const sites = missing.get(rel);
      if (!sites.some((s) => s.file === file && s.line === line)) {
        sites.push({ file, line });
      }
      continue;
    }

    if (!section) continue;
    anchorsChecked += 1;
    if (sectionIds(rel).has(section)) continue;
    const key = `${rel} §${section}`;
    if (!badAnchors.has(key)) badAnchors.set(key, []);
    const sites = badAnchors.get(key);
    if (!sites.some((s) => s.file === file && s.line === line)) {
      sites.push({ file, line });
    }
  }
}

if (missing.size === 0 && badAnchors.size === 0) {
  console.log(
    `roadmap citations: ${citations} checked (${anchorsChecked} with a §section), all resolve.`,
  );
  process.exit(0);
}

if (badAnchors.size > 0) {
  const n = [...badAnchors.values()].reduce((a, s) => a + s.length, 0);
  console.error(
    `roadmap citations: ${n} reference(s) to ${badAnchors.size} missing section(s).\n`,
  );
  for (const [key, sites] of [...badAnchors].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const [rel] = key.split(' §');
    const have = [...sectionIds(rel)].sort();
    console.error(`  ${key} — no such section (${sites.length} site(s))`);
    console.error(
      `      doc has: ${have.length ? have.join(', ') : '(no numbered headings)'}`,
    );
    for (const s of sites) console.error(`      ${s.file}:${s.line}`);
    console.error('');
  }
  console.error(
    'A consolidation can keep the filename and renumber the doc underneath it.\n' +
      'Repoint each citation at the section that absorbed the content, or drop the\n' +
      '§ and cite the document. Do not add a stub heading to silence this.\n',
  );
}

if (missing.size > 0) {
  const total = [...missing.values()].reduce((n, sites) => n + sites.length, 0);
  console.error(
    `roadmap citations: ${total} reference(s) to ${missing.size} missing doc(s).\n`,
  );
  for (const [rel, sites] of [...missing].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.error(`  ${rel} — does not exist (${sites.length} site(s))`);
    for (const s of sites) console.error(`      ${s.file}:${s.line}`);
    console.error('');
  }
  console.error(
    'Repoint each comment at the doc that absorbed the old one (see the retired-doc\n' +
      'mapping in docs/roadmap/README.md), or drop the citation. Do not re-create the\n' +
      'deleted file to silence this.',
  );
}
process.exit(1);
