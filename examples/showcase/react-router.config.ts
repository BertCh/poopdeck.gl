import type { Config } from '@react-router/dev/config';
import path from 'node:path';
import { getPublicIndexPaths } from './src/lib/publicPaths.ts';
import { finalizeStaticAssets } from './scripts/finalize-static-assets.ts';

export default {
  // Keep the app in src/ (no file moves) so the vitest contract tests, the
  // ../../../../docs glob in src/docs/content.ts, and the scripts that parse
  // src/datasets.ts all keep working untouched.
  appDirectory: 'src',

  // SPA mode: no runtime server. The root shell + the routes listed in
  // prerender() are rendered to static HTML at build time; everything else
  // falls back to the client-rendered SPA shell.
  ssr: false,

  async buildEnd({ reactRouterConfig }) {
    await finalizeStaticAssets(
      path.join(reactRouterConfig.buildDirectory, 'client'),
    );
  },

  async prerender() {
    // This includes every curated demo whose dataset actually ships and every
    // published docs slug. The same source generates sitemap.xml, so a route
    // cannot become indexable without also receiving static HTML.
    return getPublicIndexPaths();
  },
} satisfies Config;
