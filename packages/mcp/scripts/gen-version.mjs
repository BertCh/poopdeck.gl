#!/usr/bin/env node
// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * Generates `src/version.ts` from this package's own `package.json` version —
 * the number the server reports in its MCP `initialize` response (`serverInfo`).
 *
 * Why a GENERATED CONSTANT rather than reading `package.json` at runtime: the
 * version has to be correct in two very different layouts — `src/server.ts`
 * under vitest (which resolves the TS sources directly) and `dist/server.js` in
 * a published/`npx` install — and any relative `readFileSync('../package.json')`
 * that survives both is one bundling step away from resolving to the WRONG
 * package.json (or to nothing). A compiled-in constant has no runtime path
 * resolution to get wrong, and no filesystem read on the server's startup path.
 *
 * Runs FIRST in `pnpm build` (before `tsc`), and `prepublishOnly` runs the same
 * build, so a published tarball can never carry a stale number. The generated
 * file is COMMITTED so a fresh checkout typechecks and tests before anything is
 * built; `test/version.test.ts` fails if the two ever drift (which is exactly
 * how `PACKAGE_VERSION` sat at a hand-written '0.4.0' while the package shipped
 * 0.5.0 — every client was told the wrong version).
 *
 * Usage:
 *   node scripts/gen-version.mjs            # rewrite src/version.ts in place
 *   node scripts/gen-version.mjs --check    # report drift, exit 1 (CI gate)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const PKG_JSON = path.join(PKG_ROOT, 'package.json');
const OUT = path.join(PKG_ROOT, 'src', 'version.ts');

const version = JSON.parse(readFileSync(PKG_JSON, 'utf8')).version;
if (typeof version !== 'string' || version.length === 0) {
  process.stderr.write('gen-version: package.json has no version\n');
  process.exit(1);
}

const text = `// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

// GENERATED FILE — do not edit by hand.
// Regenerate with \`node scripts/gen-version.mjs\` (runs automatically as the
// first step of \`pnpm build\`, and \`prepublishOnly\` runs that build).
// Source of truth: this package's package.json \`version\`.

/** Version reported to MCP clients in the \`initialize\` response (\`serverInfo.version\`). */
export const PACKAGE_VERSION = '${version}';
`;

const current = (() => {
  try {
    return readFileSync(OUT, 'utf8');
  } catch {
    return undefined;
  }
})();

if (process.argv.includes('--check')) {
  if (current === text) {
    process.stdout.write(
      `gen-version: src/version.ts is up to date (${version})\n`,
    );
    process.exit(0);
  }
  process.stderr.write(
    `gen-version: src/version.ts is STALE — package.json says ${version}. ` +
      'Run `node scripts/gen-version.mjs` (or `pnpm build`) and commit the result.\n',
  );
  process.exit(1);
}

if (current === text) {
  process.stdout.write(`gen-version: src/version.ts already at ${version}\n`);
} else {
  writeFileSync(OUT, text);
  process.stdout.write(`gen-version: wrote src/version.ts (${version})\n`);
}
