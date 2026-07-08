import { defineConfig, type Plugin } from 'vite';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLlmsArtifacts } from './src/docs/llms';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Only the React Router *client* build ships static assets (into
// <buildDirectory>/client, default build/client). The framework also runs a
// server build (build/server) and a prerender pass; our post-build asset
// emitters must run ONLY for the client build, or they'd copy into the wrong
// dir / run several times.
function isClientBuild(outDir: string): boolean {
  return /[\\/]client$/.test(outDir);
}

// Files that live in public/ for local dev / dataset regeneration but are NOT
// referenced by the app at runtime. They stay on disk; this list only keeps
// them out of the production build so it isn't bloated by multi-GB unused
// datasets. Paths are relative to public/, with '/' separators.
const EXCLUDE_FROM_DIST = new Set([
  'data/satellites.geojson', // source for satellites.stt, not fetched at runtime
  'data/nyc-taxi-points.stt', // points demo reads nyc-taxi-paths.stt (VAT head) instead
  'data/nyc-taxi-points.new.parquet', // intermediate build artifact
  'data/nyc-taxi-points.new.stt', // empty regen artifact
  'data/earthquakes.stt', // superseded by earthquakes-v2.stt
  'data/earthquakes-summary.stt', // unused summary tier
  'data/land-110m.geojson', // unreferenced basemap geojson
]);

// Selectively copy public/ -> build/client/, skipping the unused files above
// (and OS junk). Replaces Vite's default whole-dir public copy (disabled below
// via build.copyPublicDir: false) — public/ is ~100 GB of local dataset trees,
// so a copy-then-prune would be untenable; we copy only what ships.
function excludeUnusedPublicFiles(): Plugin {
  const publicDir = path.join(rootDir, 'public');
  let outDir = '';
  return {
    name: 'exclude-unused-public-files',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      if (!isClientBuild(outDir)) return;
      if (!fs.existsSync(publicDir)) return;
      const clientDir = outDir;
      const skipped: string[] = [];
      fs.cpSync(publicDir, clientDir, {
        recursive: true,
        filter(src) {
          if (path.basename(src) === '.DS_Store') return false;
          const rel = path.relative(publicDir, src).split(path.sep).join('/');
          // All tile data is served from R2 (VITE_DATA_BASE_URL), never the site
          // origin — prune the whole data*/ staging trees (flat .stt + packed
          // <stem>/ dirs: manifest.json + index/*.sttd + packs/*.sttp) so the
          // deploy stays well under Cloudflare's per-asset (25 MiB) and total
          // limits. Dev server reads public/ directly, so local dev is
          // unaffected.
          for (const tree of ['data', 'data-publish', 'data-v2']) {
            if (rel === tree || rel.startsWith(`${tree}/`)) {
              if (rel === tree) skipped.push(`${tree}/ (entire tree)`);
              return false;
            }
          }
          // Tile archives (.stt) and intermediate build artifacts (.parquet) are
          // served from R2 (VITE_DATA_BASE_URL), never from the site origin, and
          // far exceed Cloudflare's 25 MiB-per-asset deploy limit — keep them
          // out. They remain in public/ for local dev.
          if (/\.(stt|parquet)$/i.test(rel)) {
            skipped.push(rel);
            return false;
          }
          if (rel && EXCLUDE_FROM_DIST.has(rel)) {
            skipped.push(rel);
            return false;
          }
          return true;
        },
      });
      if (skipped.length) {
        this.warn(
          `excluded ${skipped.length} unused public file(s) from build/client: ${skipped.join(', ')}`,
        );
      }
    },
  };
}

// Emit the llmstxt.org-style AI-agent doc surface into build/client/ after the
// build:
//   build/client/llms.txt        curated corpus map (links rewritten to abs URLs)
//   build/client/llms-full.txt   the whole published corpus concatenated
//   build/client/llms/<path>.md  a raw copy of every published doc
// Reads the repo docs/ dir and repo-root llms.txt, resolved relative to this
// config the same way src/docs/content.ts climbs to <repo>/docs. Pure logic
// lives in src/docs/llms.ts so it is unit-testable without a full vite build.
function emitLlmsDocs(): Plugin {
  const repoRoot = path.join(rootDir, '..', '..');
  const docsDir = path.join(repoRoot, 'docs');
  const llmsSourcePath = path.join(repoRoot, 'llms.txt');
  let outDir = '';
  return {
    name: 'emit-llms-docs',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      if (!isClientBuild(outDir)) return;
      if (!fs.existsSync(docsDir) || !fs.existsSync(llmsSourcePath)) {
        this.warn(`emit-llms-docs: missing docs/ or llms.txt; skipping`);
        return;
      }
      const clientDir = outDir;
      const { llmsTxt, llmsFull, docFiles } = generateLlmsArtifacts({
        docsDir,
        llmsSource: fs.readFileSync(llmsSourcePath, 'utf8'),
      });
      fs.mkdirSync(clientDir, { recursive: true });
      fs.writeFileSync(path.join(clientDir, 'llms.txt'), llmsTxt);
      fs.writeFileSync(path.join(clientDir, 'llms-full.txt'), llmsFull);
      for (const { path: rel, text } of docFiles) {
        const dest = path.join(clientDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
      }
      this.warn(
        `emit-llms-docs: wrote llms.txt, llms-full.txt, ${docFiles.length} llms/ docs`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    excludeUnusedPublicFiles(),
    emitLlmsDocs(),
  ],
  server: {
    port: 3000,
  },
  // A single `three` instance must back both r3f's reconciler and the engine's
  // WebGPURenderer — a duplicate copy breaks reconciliation and the renderer.
  // `react`/`react-dom`/r3f must ALSO be deduped: `@poopdeck.gl/three` ships its
  // own react in node_modules, and when its dist is served via `/@fs/` (not
  // pre-bundled) vite would otherwise bind a SECOND React instance → elements
  // created in the three package fail to render in the showcase tree with
  // "Objects are not valid as a React child" (mismatched element `$$typeof`).
  resolve: {
    dedupe: [
      'three',
      'react',
      'react-dom',
      '@react-three/fiber',
      '@react-three/drei',
    ],
  },
  optimizeDeps: {
    include: ['maplibre-gl', 'mapbox-gl'],
    exclude: ['brotli-wasm'],
    // three/webgpu + three/tsl use top-level await; esbuild dep pre-bundling
    // needs an esnext target to handle it.
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    target: 'esnext',
    copyPublicDir: false, // selective copy handled by excludeUnusedPublicFiles()
  },
  assetsInclude: ['**/*.wasm'],
});
