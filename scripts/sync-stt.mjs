#!/usr/bin/env node
/**
 * Vendor-sync for the artifacts this repository consumes from the STT repo.
 *
 * The two repositories meet at the archive on disk (docs/roadmap/repo-split-2026-08.md
 * §1.1). STT authors the contract; poopdeck.gl implements a reader for it. Three
 * things therefore cross the seam, and all three are GENERATED UPSTREAM and
 * VENDORED HERE so this repo builds, tests and deploys with no network and no
 * sibling checkout:
 *
 *   1. `docs`     — the format/tiler documentation pages the published site
 *                   still has to serve. They keep their existing paths, so no
 *                   slug moves and no link breaks; `.stt-sync.json` is the only
 *                   record that they are upstream-owned. A synced file carries
 *                   NO marker in its body — a banner would corrupt the byte
 *                   comparison that makes this gate worth having.
 *   2. `vectors`  — the conformance golden fixtures. They are produced by the
 *                   RUST WRITER (upstream `conformance/make-vectors.sh`), so
 *                   they were always an STT artifact that happened to live in
 *                   the reader's test directory. They stay at
 *                   `packages/core/test/fixtures/` so no test path changes.
 *   3. `status`   — the `stt` block of `project-status.json`: what the reference
 *                   writer emits and what the CLIs are called. The showcase's
 *                   status page renders it without a network call.
 *
 * Source of truth, in order:
 *   - `STT_REPO=../spatiotemporal-tiles` — a local checkout. Fast, offline,
 *     and what you want while co-developing a format change.
 *   - otherwise, the tarball of `.stt-sync.json`'s pinned `ref` from GitHub.
 *     The ref is a full SHA, so the fetch is immutable and CDN-cacheable.
 *
 * Usage:
 *   node scripts/sync-stt.mjs            # rewrite the vendored copies
 *   node scripts/sync-stt.mjs --check    # compare only; exit 1 on drift (CI gate)
 *   node scripts/sync-stt.mjs --ref <sha>  # re-pin AND rewrite
 *
 * `--check` never passes silently: if it cannot reach a source it fails, on the
 * principle that a gate which cannot verify must not report success.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PIN_PATH = join(ROOT, '.stt-sync.json');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const refFlag = argv.indexOf('--ref');
const REF_OVERRIDE = refFlag >= 0 ? argv[refFlag + 1] : undefined;

if (!existsSync(PIN_PATH)) {
  console.error(`sync-stt: missing ${relative(ROOT, PIN_PATH)}`);
  process.exit(1);
}
const pin = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
const ref = REF_OVERRIDE ?? pin.ref;

if (CHECK && REF_OVERRIDE) {
  console.error('sync-stt: --check and --ref are mutually exclusive');
  process.exit(1);
}

// ─── Resolve a source tree ──────────────────────────────────────────────────

let source;
let sourceLabel;
let cleanup = () => {};

const local = process.env.STT_REPO;
if (local) {
  source = resolve(local);
  sourceLabel = `local checkout ${source}`;
  if (!existsSync(join(source, 'crates', 'stt-core'))) {
    console.error(
      `sync-stt: STT_REPO=${local} does not look like the STT repo ` +
        '(no crates/stt-core). Unset it to fetch the pinned ref instead.',
    );
    process.exit(1);
  }
} else {
  if (!ref || ref === 'UNPINNED') {
    console.error(
      'sync-stt: no STT_REPO and no pinned ref in .stt-sync.json.\n' +
        '  Set STT_REPO=../spatiotemporal-tiles, or pin a commit with --ref <sha>.',
    );
    process.exit(1);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'stt-sync-'));
  cleanup = () => rmSync(tmp, { recursive: true, force: true });
  const url = `https://codeload.github.com/${pin.repo}/tar.gz/${ref}`;
  try {
    execFileSync(
      'bash',
      [
        '-c',
        `curl -fsSL ${JSON.stringify(url)} | tar -xz -C ${JSON.stringify(tmp)}`,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
  } catch (err) {
    cleanup();
    console.error(
      `sync-stt: could not fetch ${url}\n  ${String(err.stderr ?? err).trim()}`,
    );
    process.exit(1);
  }
  const [only] = readdirSync(tmp);
  source = join(tmp, only);
  sourceLabel = `${pin.repo}@${ref.slice(0, 12)}`;
}

// ─── Walk helpers ───────────────────────────────────────────────────────────

/** Every file under `dir`, as paths relative to `dir`, sorted. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

const drift = [];
let synced = 0;

function compareOrCopy(srcFile, dstFile, label) {
  if (!existsSync(srcFile)) {
    drift.push(`${label}: MISSING UPSTREAM (${relative(source, srcFile)})`);
    return;
  }
  const want = readFileSync(srcFile);
  if (CHECK) {
    if (!existsSync(dstFile)) {
      drift.push(`${label}: missing locally`);
      return;
    }
    if (!readFileSync(dstFile).equals(want))
      drift.push(`${label}: differs from upstream`);
    return;
  }
  mkdirSync(dirname(dstFile), { recursive: true });
  const changed = !existsSync(dstFile) || !readFileSync(dstFile).equals(want);
  if (changed) {
    writeFileSync(dstFile, want);
    synced += 1;
  }
}

// ─── 1. Documentation ───────────────────────────────────────────────────────

for (const file of pin.docs) {
  compareOrCopy(join(source, file), join(ROOT, file), file);
}

// ─── 2. Conformance vectors ─────────────────────────────────────────────────

const vFrom = join(source, pin.vectors.from);
const vTo = join(ROOT, pin.vectors.to);
if (!existsSync(vFrom)) {
  drift.push(`${pin.vectors.from}: MISSING UPSTREAM`);
} else {
  const upstream = walk(vFrom);
  for (const rel of upstream) {
    compareOrCopy(join(vFrom, rel), join(vTo, rel), `${pin.vectors.to}/${rel}`);
  }
  // A file the reader still carries but the writer no longer produces is drift
  // in the direction the byte comparison cannot see.
  if (existsSync(vTo)) {
    const have = new Set(upstream);
    for (const rel of walk(vTo)) {
      if (have.has(rel) || rel.endsWith('/README.md') || rel === 'README.md')
        continue;
      if (CHECK)
        drift.push(`${pin.vectors.to}/${rel}: not produced upstream (stale)`);
      else {
        rmSync(join(vTo, rel));
        synced += 1;
      }
    }
  }
}

// ─── 3. The `stt` block of project-status.json ──────────────────────────────

const statusSrc = join(source, pin.status.from);
const statusDst = join(ROOT, pin.status.to);
if (!existsSync(statusSrc)) {
  drift.push(`${pin.status.from}: MISSING UPSTREAM`);
} else {
  const upstream = JSON.parse(readFileSync(statusSrc, 'utf8'));
  const block = {};
  for (const key of pin.status.keys)
    if (key in upstream) block[key] = upstream[key];
  const local = JSON.parse(readFileSync(statusDst, 'utf8'));
  const wantJson = JSON.stringify(block, null, 2);
  const haveJson = JSON.stringify(local.stt ?? null, null, 2);
  if (wantJson !== haveJson) {
    if (CHECK)
      drift.push(`${pin.status.to}: \`stt\` block differs from upstream`);
    else {
      local.stt = block;
      writeFileSync(statusDst, `${JSON.stringify(local, null, 2)}\n`);
      synced += 1;
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

cleanup();

if (CHECK) {
  if (drift.length) {
    console.error(
      `sync-stt: ${drift.length} vendored artifact(s) drifted from ${sourceLabel}\n`,
    );
    for (const d of drift) console.error(`  ${d}`);
    console.error(
      '\nThese files are authored in the STT repository. Do not edit them here.\n' +
        'Land the change upstream, then:  node scripts/sync-stt.mjs --ref <new-sha>',
    );
    process.exit(1);
  }
  console.log(
    `sync-stt: ${pin.docs.length} docs + conformance vectors + project status match ${sourceLabel}`,
  );
} else {
  if (drift.length) {
    console.error(`sync-stt: ${drift.length} problem(s) with ${sourceLabel}\n`);
    for (const d of drift) console.error(`  ${d}`);
    process.exit(1);
  }
  if (REF_OVERRIDE) {
    pin.ref = REF_OVERRIDE;
    writeFileSync(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`);
  }
  console.log(
    synced === 0
      ? `sync-stt: already up to date with ${sourceLabel}`
      : `sync-stt: updated ${synced} file(s) from ${sourceLabel}`,
  );
}
