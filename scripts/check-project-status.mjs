#!/usr/bin/env node

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

function capture(text, pattern, label) {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) throw new Error(`could not read ${label}`);
  return value;
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} drifted: project-status=${JSON.stringify(actual)}, source=${JSON.stringify(expected)}`,
    );
  }
}

const cargo = read('Cargo.toml');
const rustVersion = capture(
  cargo,
  /^version = "([^"]+)"$/m,
  'Cargo workspace version',
);
const rustMsrv = capture(cargo, /^rust-version = "([^"]+)"$/m, 'Rust MSRV');
assertEqual(status.release.rust, rustVersion, 'Rust release');
assertEqual(status.toolchain.rust, rustMsrv, 'Rust MSRV');

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

const packSource = read('crates/stt-core/src/pack/mod.rs');
const directorySource = read('crates/stt-core/src/directory.rs');
const writeFormat = Number(
  capture(
    packSource,
    /pub const PACKED_FORMAT_VERSION: u32 = ([0-9]+);/,
    'packed format version',
  ),
);
const minFormat = Number(
  capture(
    packSource,
    /pub const MIN_PACKED_FORMAT_VERSION: u32 = ([0-9]+);/,
    'minimum packed format version',
  ),
);
const writeDirectory = Number(
  capture(
    directorySource,
    /pub const DIRECTORY_VERSION: u8 = ([0-9]+);/,
    'directory version',
  ),
);
const minDirectory = Number(
  capture(
    directorySource,
    /pub const MIN_DIRECTORY_VERSION: u8 = ([0-9]+);/,
    'minimum directory version',
  ),
);
assertEqual(status.archive.writes.formatVersion, writeFormat, 'writer format');
assertEqual(
  status.archive.writes.directoryVersion,
  writeDirectory,
  'writer directory',
);
assertEqual(
  status.archive.reads.formatVersions,
  range(minFormat, writeFormat),
  'reader format window',
);
assertEqual(
  status.archive.reads.directoryVersions,
  range(minDirectory, writeDirectory),
  'reader directory window',
);

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

const facadeCargo = read('crates/spatiotemporal-tiles/Cargo.toml');
const facadeCommands = [
  ...facadeCargo.matchAll(/^name = "(stt-[^"]+)"$/gm),
].map((match) => match[1]);
assertEqual(
  status.commands.map(({ name }) => name).sort(),
  facadeCommands.sort(),
  'published command inventory',
);
assertEqual(
  status.repositoryOnlyCommands.map(({ name }) => name),
  ['stt-generate'],
  'repository-only command inventory',
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
  assertEqual(actual.node, status.toolchain.node, `${actual.name} Node engine`);
}

const schemaPath = status.$schema;
if (basename(schemaPath) !== 'project-status.schema.json') {
  throw new Error(`unexpected project-status schema: ${schemaPath}`);
}
json(schemaPath.replace(/^\.\//, ''));

console.log(
  `project status: ${actualPackages.length} packages, ${facadeCommands.length} CLIs, format ${writeFormat}/directory ${writeDirectory}; all in sync`,
);
