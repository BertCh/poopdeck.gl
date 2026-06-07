import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Files that live in public/ for local dev / dataset regeneration but are NOT
// referenced by the app at runtime. They stay on disk; this list only keeps
// them out of the production `dist` build so it isn't bloated by multi-GB
// unused datasets. Paths are relative to public/, with '/' separators.
const EXCLUDE_FROM_DIST = new Set([
  'data/satellites.geojson',          // source for satellites.stt, not fetched at runtime
  'data/nyc-taxi-points.stt',         // points demo reads nyc-taxi-paths.stt (VAT head) instead
  'data/nyc-taxi-points.new.parquet', // intermediate build artifact
  'data/nyc-taxi-points.new.stt',     // empty regen artifact
  'data/earthquakes.stt',             // superseded by earthquakes-v2.stt
  'data/earthquakes-summary.stt',     // unused summary tier
  'data/land-110m.geojson',           // unreferenced basemap geojson
]);

// Selectively copy public/ -> dist/, skipping the unused files above (and OS
// junk). Replaces Vite's default whole-dir public copy (disabled below via
// build.copyPublicDir: false).
function excludeUnusedPublicFiles(): Plugin {
  const publicDir = path.join(rootDir, 'public');
  return {
    name: 'exclude-unused-public-files',
    apply: 'build',
    closeBundle() {
      if (!fs.existsSync(publicDir)) return;
      const distDir = path.join(rootDir, 'dist');
      const skipped: string[] = [];
      fs.cpSync(publicDir, distDir, {
        recursive: true,
        filter(src) {
          if (path.basename(src) === '.DS_Store') return false;
          const rel = path.relative(publicDir, src).split(path.sep).join('/');
          // All tile data is served from R2 (VITE_DATA_BASE_URL), never the site
          // origin — prune the whole data/ tree (flat .stt + packed <stem>/ dirs:
          // manifest.json + index/*.sttd + packs/*.sttp) so dist stays well under
          // Cloudflare's per-asset (25 MiB) and total deploy limits. Dev server
          // reads public/ directly, so local dev is unaffected.
          if (rel === 'data' || rel.startsWith('data/')) {
            if (rel === 'data') skipped.push('data/ (entire tree)');
            return false;
          }
          // Tile archives (.stt) and intermediate build artifacts (.parquet) are
          // served from R2 (VITE_DATA_BASE_URL), never from the site origin, and
          // far exceed Cloudflare's 25 MiB-per-asset deploy limit — keep them out
          // of dist. They remain in public/ for local dev (served by the dev
          // server, which reads public/ directly and never touches dist).
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
          `excluded ${skipped.length} unused public file(s) from dist: ${skipped.join(', ')}`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excludeUnusedPublicFiles()],
  server: {
    port: 3000,
  },
  optimizeDeps: {
    include: ['maplibre-gl', 'mapbox-gl'],
    exclude: ['brotli-wasm'],
  },
  build: {
    target: 'esnext',
    copyPublicDir: false, // selective copy handled by excludeUnusedPublicFiles()
  },
  assetsInclude: ['**/*.wasm'],
});
