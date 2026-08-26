#!/usr/bin/env node
/**
 * Version sync for the files changesets does NOT touch.
 *
 * `changeset version` is expected to bump every public `@poopdeck.gl/*`
 * package.json (they are a `fixed` group), but this script verifies that
 * assumption too. Everything else in the lockstep is a hand edit:
 *
 *   - the Claude Code plugin surface —
 *     `poopdeck-ai/.claude-plugin/plugin.json`, the marketplace entry, and the
 *     `metadata.version` in each skill's frontmatter — which rots silently,
 *     one release at a time.
 *
 * Canonical version = `packages/core/package.json` (the root of the fixed
 * group; every other public @poopdeck.gl package carries the same number).
 * Private packages are deliberately excluded: for example, the frozen Cesium
 * backend remains at its last published version while workspace development
 * continues.
 *
 * The cargo half of this gate moved out with the repository split. It existed
 * because npm once shipped 0.5.0 while crates.io sat at 0.4.0 — two registries,
 * one manual bump, nothing comparing them. That failure mode is now
 * structurally impossible rather than merely gated: the two stacks release
 * independently and are related by the archive's `formatVersion`, not by a
 * shared version number (docs/roadmap/repo-split-2026-08.md §2.3).
 *
 * Usage:
 *   node scripts/sync-versions.mjs            # rewrite the stragglers in place
 *   node scripts/sync-versions.mjs --check    # report drift, exit 1 (CI gate)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CHECK = process.argv.slice(2).includes('--check');

const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, 'utf8');

/** The number every other file must agree with. */
function canonicalVersion() {
  const pj = JSON.parse(read(join(ROOT, 'packages/core/package.json')));
  if (typeof pj.version !== 'string' || !pj.version) {
    throw new Error('packages/core/package.json has no version');
  }
  return pj.version;
}

// ---------------------------------------------------------------------------
// Targets. `read()` returns one `{ label, value }` per version field the file
// owns; `write(text, want)` returns the new file text. Edits are surgical
// (anchored on the version key) rather than a parse → re-serialize round trip,
// so formatting, quote style, and key order survive.
// ---------------------------------------------------------------------------

/** `"version": "x.y.z"` at a known JSON path, e.g. ['metadata','version']. */
function jsonVersionTarget(file, paths) {
  return {
    file,
    read() {
      const doc = JSON.parse(read(file));
      return paths.map((path) => {
        let node = doc;
        for (const key of path) node = node?.[key];
        return { label: path.join('.'), value: node };
      });
    },
    write(text, want) {
      // Replace the version literal on each matched key. All version keys in
      // these two files are the plugin version, so a global key-anchored
      // replace is exact.
      return text.replace(
        /("version"\s*:\s*")[^"]*(")/g,
        (_m, a, b) => a + want + b,
      );
    },
  };
}

/** `metadata:\n  version: 'x.y.z'` inside a SKILL.md YAML frontmatter block. */
const SKILL_VERSION_RE =
  /^(metadata:\n[ \t]+version:[ \t]*)(['"]?)([^\n'"]*)\2/m;

function skillVersionTarget(file) {
  return {
    file,
    read() {
      const m = SKILL_VERSION_RE.exec(frontmatter(read(file)));
      return [{ label: 'metadata.version', value: m ? m[3] : undefined }];
    },
    write(text, want) {
      const fm = frontmatter(text);
      if (!SKILL_VERSION_RE.test(fm)) return text;
      const next = fm.replace(
        SKILL_VERSION_RE,
        (_m, head, quote) => `${head}${quote}${want}${quote}`,
      );
      return text.replace(fm, next);
    },
  };
}

/** The text between the leading `---` fence and its closer (empty if absent). */
function frontmatter(text) {
  if (!text.startsWith('---\n')) return '';
  const end = text.indexOf('\n---', 4);
  return end === -1 ? '' : text.slice(4, end + 1);
}

function collectTargets() {
  const targets = [
    jsonVersionTarget(join(ROOT, 'poopdeck-ai/.claude-plugin/plugin.json'), [
      ['version'],
    ]),
    jsonVersionTarget(join(ROOT, '.claude-plugin/marketplace.json'), [
      ['metadata', 'version'],
      ['plugins', 0, 'version'],
    ]),
  ];
  // Verify changesets' fixed-group promise rather than assuming it. Private
  // workspace packages may intentionally have a different lifecycle/version.
  const packagesDir = join(ROOT, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const manifest = join(packagesDir, entry.name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(read(manifest));
      if (
        pkg.private === true ||
        !String(pkg.name).startsWith('@poopdeck.gl/')
      ) {
        continue;
      }
      targets.push(jsonVersionTarget(manifest, [['version']]));
    }
  }
  const skillsDir = join(ROOT, 'poopdeck-ai/skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const skill = join(skillsDir, entry.name, 'SKILL.md');
      if (existsSync(skill)) targets.push(skillVersionTarget(skill));
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------

const want = canonicalVersion();
console.log(`canonical version: ${want}  (packages/core/package.json)\n`);

let drift = 0;
let updated = 0;
let failed = 0;
for (const target of collectTargets()) {
  const stale = target.read().filter((f) => f.value !== want);
  const where = rel(target.file);

  if (stale.length === 0) {
    console.log(`  ok      ${where}`);
    continue;
  }
  drift += stale.length;
  const detail = stale
    .map((f) => `${f.label}=${f.value ?? '<missing>'}`)
    .join(', ');

  if (CHECK) {
    console.error(`  DRIFT   ${where} — ${detail} (want ${want})`);
    continue;
  }
  const text = read(target.file);
  const next = target.write(text, want);
  if (next === text) {
    failed += 1;
    console.error(
      `  FAILED  ${where} — ${detail}; no version field to rewrite`,
    );
    continue;
  }
  writeFileSync(target.file, next);
  updated += stale.length;
  console.log(`  wrote   ${where} — ${detail} → ${want}`);
}

if (CHECK) {
  if (drift > 0) {
    console.error(
      `\nsync-versions: ${drift} stale version field(s). Run \`node scripts/sync-versions.mjs\` and commit.`,
    );
    process.exit(1);
  }
  console.log('\nsync-versions: all in sync');
} else {
  console.log(
    `\nsync-versions: ${updated} field(s) updated, ${failed} unwritable`,
  );
  if (failed > 0) process.exit(1);
}
