import type { Config } from '@react-router/dev/config';

export default {
  // Keep the app in src/ (no file moves) so the vitest contract tests, the
  // ../../../../docs glob in src/docs/content.ts, and the scripts that parse
  // src/datasets.ts all keep working untouched.
  appDirectory: 'src',

  // SPA mode: no runtime server. The root shell + the routes listed in
  // prerender() are rendered to static HTML at build time; everything else
  // falls back to the client-rendered SPA shell.
  ssr: false,

  async prerender() {
    // Dynamic import so these modules evaluate in the Vite SSR pipeline (where
    // import.meta.env is populated for datasets.ts), not in the raw config
    // loader.
    const { DEMO_META } = await import('./src/content/demoMeta');
    const { flatDocEntries } = await import('./src/docs/manifest');

    return [
      '/',
      '/demos',
      '/how-it-works',
      '/docs',
      // Every curated catalog id has a /demos/:id detail page (the exact set
      // DemoDetailPage renders). NOT SHIPPED_DATASET_IDS (the nav subset).
      ...Object.keys(DEMO_META).map((id) => `/demos/${id}`),
      // Every published docs slug (includes two-segment api/* slugs and the
      // spec/manifest-schema JSON page).
      ...flatDocEntries.map((e) => `/docs/${e.slug}`),
    ];
  },
} satisfies Config;
