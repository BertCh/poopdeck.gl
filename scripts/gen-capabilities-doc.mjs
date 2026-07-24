// Generate docs/spec/backend-capabilities.md from each backend's BackendDescriptor.
// Run from the repo root, after the packages are built (`pnpm turbo run build`) —
// this imports the four backends' dist/:
//   node scripts/gen-capabilities-doc.mjs           rewrite the committed doc
//   node scripts/gen-capabilities-doc.mjs --check   byte-compare, write nothing
// `--check` is the CI gate (the `typescript` job runs it right after the turbo
// build), so a BackendDescriptor edit that is not followed by a regeneration now
// fails the build instead of silently rotting the doc.
// The doc is machine-generated end to end and the comparison is byte-exact: do
// NOT hand-edit or re-align its tables — regenerate instead. oxfmt DOES format
// markdown and would re-align them into a permanent standoff with this gate, so
// the doc is listed in `.oxfmtrc.json`'s ignorePatterns; keep that entry if the
// path ever moves.
// No bundling step is needed: every package's dist emits extensioned ESM
// imports, so plain `node` resolves the graph. (An earlier esbuild --bundle
// incantation documented here worked around extensionless dist imports that no
// longer exist.)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCapabilitiesMarkdown } from '../packages/core/dist/render/capabilities-doc.js';
import { deckBackend } from '../packages/layers/dist/backend-descriptor.js';
import { threeBackend } from '../packages/three/dist/backend-descriptor.js';
import { maplibreBackend } from '../packages/maplibre/dist/backend-descriptor.js';
import { cesiumBackend } from '../packages/cesium/dist/backend-descriptor.js';

const DOC_REL = 'docs/spec/backend-capabilities.md';
const DOC_PATH = join(process.cwd(), DOC_REL);
// Enough hunks to see the shape of the drift without burying the CI log when a
// line insert shifts every following line.
const MAX_HUNKS = 30;

const md =
  renderCapabilitiesMarkdown([
    deckBackend,
    threeBackend,
    maplibreBackend,
    cesiumBackend,
  ]) + '\n';

if (process.argv.includes('--check')) {
  let committed;
  try {
    committed = readFileSync(DOC_PATH, 'utf8');
  } catch (e) {
    console.error(`${DOC_REL} is missing — run this script without --check.`);
    console.error(String(e.message ?? e));
    process.exit(1);
  }
  if (committed === md) {
    console.log(`OK ${DOC_REL} matches the BackendDescriptors`);
    process.exit(0);
  }

  const have = committed.split('\n');
  const want = md.split('\n');
  const hunks = [];
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    if (have[i] !== want[i]) hunks.push(i);
  }

  console.error(`${DOC_REL} is STALE — it does not match the descriptors.`);
  console.error(`--- ${DOC_REL} (committed)`);
  console.error('+++ renderCapabilitiesMarkdown (generated)');
  for (const i of hunks.slice(0, MAX_HUNKS)) {
    console.error(`@@ line ${i + 1} @@`);
    if (have[i] !== undefined) console.error(`- ${have[i]}`);
    if (want[i] !== undefined) console.error(`+ ${want[i]}`);
  }
  if (hunks.length > MAX_HUNKS) {
    console.error(`… ${hunks.length - MAX_HUNKS} further differing lines`);
  }
  console.error(
    `\nFix: node scripts/gen-capabilities-doc.mjs && git add ${DOC_REL}`,
  );
  process.exit(1);
}

writeFileSync(DOC_PATH, md);
console.log(`wrote ${DOC_REL}`);
