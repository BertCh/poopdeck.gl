// Generate docs/spec/backend-capabilities.md from each backend's BackendDescriptor.
// Run: node scripts/gen-capabilities-doc.mjs  (after building core + the 4 backends).
// No automated check keeps the committed doc in sync — regenerate + diff by hand
// whenever a BackendDescriptor changes.
// Bundle with esbuild before running (the dist uses bundler-style extensionless
// imports): `pnpm --filter @poopdeck.gl/core exec esbuild scripts/gen-capabilities-doc.mjs
// --bundle --platform=node --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs` from repo root.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCapabilitiesMarkdown } from '../packages/core/dist/render/capabilities-doc.js';
import { deckBackend } from '../packages/layers/dist/backend-descriptor.js';
import { threeBackend } from '../packages/three/dist/backend-descriptor.js';
import { maplibreBackend } from '../packages/maplibre/dist/backend-descriptor.js';
import { cesiumBackend } from '../packages/cesium/dist/backend-descriptor.js';

const md = renderCapabilitiesMarkdown([
  deckBackend,
  threeBackend,
  maplibreBackend,
  cesiumBackend,
]);
writeFileSync(
  join(process.cwd(), 'docs/spec/backend-capabilities.md'),
  md + '\n',
);
console.log('wrote docs/spec/backend-capabilities.md');
