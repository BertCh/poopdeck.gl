#!/usr/bin/env node
/**
 * `project-status.json` is the repository's published claim about what it
 * ships. This gate proves every claim against the file that actually decides
 * it, so the status page can never quietly describe a previous release.
 *
 * Scope is deliberately HALF the old check. Before the repository split this
 * file also verified the Rust release, the MSRV, the packed-format/directory
 * version windows read out of `stt:crates/stt-core`, and the CLI inventory read
 * out of the facade's Cargo.toml. None of those sources are in this
 * repository any more. They are verified by the identical gate upstream, and
 * their conclusions arrive here as the vendored `stt` block — checked for
 * byte-equality with upstream by `scripts/sync-stt.mjs --check`, not
 * re-derived here from sources we do not have.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const status = json('project-status.json');
const rootPackage = json('package.json');

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} drifted: project-status=${JSON.stringify(actual)}, source=${JSON.stringify(expected)}`,
    );
  }
}

const [pnpmName, pnpmVersion] = rootPackage.packageManager.split('@');
assertEqual(pnpmName, 'pnpm', 'package manager name');
assertEqual(status.toolchain.pnpm, pnpmVersion, 'pnpm version');
assertEqual(
  status.toolchain.node,
  rootPackage.engines.node,
  'root Node engine',
);
assertEqual(
  status.toolchain.nodeMajor,
  Number(read('.node-version').trim()),
  '.node-version',
);
assertEqual(
  status.toolchain.nodeMajor,
  Number(read('.nvmrc').trim()),
  '.nvmrc',
);

const packageDirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const actualPackages = packageDirs.map((dir) => {
  const manifest = json(`packages/${dir}/package.json`);
  return {
    name: manifest.name,
    version: manifest.version,
    published: manifest.private !== true,
    node: manifest.engines?.node,
    // A package with a `bin` RUNS in Node, so it carries the repo's dev
    // toolchain floor. Everything else ships browser code whose `dist` never
    // executes under Node at all, and a floor above the current LTS lines
    // hard-fails any consumer or CI running `engine-strict=true` for nothing
    // (DX review 2026-08-26, F4).
    runsInNode: manifest.bin !== undefined,
    file: `packages/${dir}/package.json`,
  };
});
const declaredByName = new Map(
  status.packages.map((entry) => [entry.name, entry]),
);
assertEqual(
  [...declaredByName.keys()].sort(),
  actualPackages.map(({ name }) => name).sort(),
  'package inventory',
);
for (const actual of actualPackages) {
  const declared = declaredByName.get(actual.name);
  assertEqual(declared.version, actual.version, `${actual.name} version`);
  assertEqual(
    declared.published,
    actual.published,
    `${actual.name} publication status`,
  );
  assertEqual(
    actual.node,
    actual.runsInNode ? status.toolchain.node : status.toolchain.runtimeNode,
    `${actual.name} Node engine`,
  );
}

// The public release number is the fixed changeset group's number, and
// `packages/core` is its root (scripts/sync-versions.mjs relies on the same
// fact). Naming it here means a half-applied `changeset version` fails the
// gate rather than shipping a status page one release behind.
assertEqual(
  status.release.javascript,
  json('packages/core/package.json').version,
  'JavaScript release',
);

const schemaPath = status.$schema;
if (basename(schemaPath) !== 'project-status.schema.json') {
  throw new Error(`unexpected project-status schema: ${schemaPath}`);
}
json(schemaPath.replace(/^\.\//, ''));

// The vendored half is not re-derived here — it is byte-compared with upstream
// by `pnpm stt:check`. What this gate owes it is a reminder that it exists and
// has never been filled in.
if (status.stt === null) {
  console.warn(
    'project status: `stt` block is unsynced — run `pnpm stt:sync` (see .stt-sync.json)',
  );
}

console.log(
  `project status: ${actualPackages.length} packages at ${status.release.javascript}; all in sync`,
);
