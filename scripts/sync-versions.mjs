#!/usr/bin/env node
/**
 * Version sync for the files changesets does NOT touch.
 *
 * `changeset version` bumps every `@poopdeck.gl/*` package.json (they are a
 * `fixed` group, so they always move together) and stops there. Everything
 * else in the lockstep is a hand edit:
 *
 *   - the cargo workspace version in `Cargo.toml` — the bug this file exists
 *     to prevent. npm shipped 0.5.0 while crates.io sat at 0.4.0 because the
 *     bump was manual and nothing compared the two numbers.
 *   - the Claude Code plugin surface —
 *     `poopdeck-ai/.claude-plugin/plugin.json`, the marketplace entry, and the
 *     `metadata.version` in each skill's frontmatter — which rots silently,
 *     one release at a time.
 *
 * Canonical version = `packages/core/package.json` (the root of the fixed
 * group; every other @poopdeck.gl package carries the same number).
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

/**
 * The `[workspace.package]` table of a cargo manifest, as `{ start, text }`
 * (null if absent). Scoping to the table matters: `[workspace.dependencies]`
 * below it is full of `version = "…"` lines for third-party crates, and a
 * file-wide match would rewrite arrow or serde to our version number.
 */
function cargoWorkspacePackageTable(text) {
  const start = text.search(/^\[workspace\.package\][ \t]*$/m);
  if (start === -1) return null;
  const body = text.slice(start);
  // Search past the table header's own `[` for the next table header.
  const next = body.slice(1).search(/^\[/m);
  return { start, text: next === -1 ? body : body.slice(0, next + 1) };
}

const CARGO_VERSION_RE = /^(version[ \t]*=[ \t]*")([^"]*)(")/m;

/** `version = "x.y.z"` under `[workspace.package]` in a cargo manifest. */
function cargoWorkspaceVersionTarget(file) {
  return {
    file,
    read() {
      const table = existsSync(file)
        ? cargoWorkspacePackageTable(read(file))
        : null;
      const m = table && CARGO_VERSION_RE.exec(table.text);
      return [
        { label: 'workspace.package.version', value: m ? m[2] : undefined },
      ];
    },
    write(text, want) {
      const table = cargoWorkspacePackageTable(text);
      if (!table) return text;
      const next = table.text.replace(
        CARGO_VERSION_RE,
        (_m, head, _old, tail) => `${head}${want}${tail}`,
      );
      return (
        text.slice(0, table.start) +
        next +
        text.slice(table.start + table.text.length)
      );
    },
  };
}

/**
 * The `version = "x.y.z"` inside every internal path-dependency of a member
 * manifest — `stt-core = { path = "../stt-core", version = "0.6.0" }`.
 *
 * These are separate from `workspace.package.version` and are NOT optional
 * decoration: cargo requires a version alongside `path` for a dependency that
 * is published, and it is the version REQUIREMENT consumers resolve. Left at
 * the previous release they do not merely go stale — `cargo update -w` fails
 * outright ("failed to select a version for the requirement `stt-core =
 * ^0.5.0`, candidate versions found which didn't match: 0.6.0"), which is how
 * this gap surfaced during the 0.6.0 cut. Matching on the `path = "../…"` shape
 * keeps this to first-party crates; third-party pins are never touched.
 */
const CARGO_PATH_DEP_RE =
  /^([ \t]*[\w-]+[ \t]*=[ \t]*\{[^}\n]*\bpath[ \t]*=[ \t]*"\.\.[^"]*"[^}\n]*\bversion[ \t]*=[ \t]*")([^"]*)(")/gm;

function cargoPathDepTarget(file) {
  const names = (text) =>
    [...text.matchAll(CARGO_PATH_DEP_RE)].map(
      (m) => m[1].trim().split(/[ \t]*=/)[0],
    );
  return {
    file,
    read() {
      if (!existsSync(file)) return [];
      const text = read(file);
      const found = [...text.matchAll(CARGO_PATH_DEP_RE)];
      return found.map((m, i) => ({
        label: `dependencies.${names(text)[i]}.version`,
        value: m[2],
      }));
    },
    write(text, want) {
      return text.replace(
        CARGO_PATH_DEP_RE,
        (_m, head, _old, tail) => `${head}${want}${tail}`,
      );
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
    cargoWorkspaceVersionTarget(join(ROOT, 'Cargo.toml')),
    jsonVersionTarget(join(ROOT, 'poopdeck-ai/.claude-plugin/plugin.json'), [
      ['version'],
    ]),
    jsonVersionTarget(join(ROOT, '.claude-plugin/marketplace.json'), [
      ['metadata', 'version'],
      ['plugins', 0, 'version'],
    ]),
  ];
  // Every workspace member's internal path-deps, in a stable order.
  const cratesDir = join(ROOT, 'crates');
  if (existsSync(cratesDir)) {
    for (const entry of readdirSync(cratesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const manifest = join(cratesDir, entry.name, 'Cargo.toml');
      if (existsSync(manifest)) targets.push(cargoPathDepTarget(manifest));
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
