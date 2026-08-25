import { SITE_ORIGIN } from './seo.ts';

/**
 * Indexable routes and React Router prerender routes are the same list.
 * Keeping one source prevents a new public page from silently missing either
 * static HTML or sitemap discovery.
 */
export async function getPublicIndexPaths(): Promise<string[]> {
  const [{ DEMO_META }, { getDatasetById }, { flatDocEntries }] =
    await Promise.all([
      import('../content/demoMeta.ts'),
      import('../datasets.ts'),
      import('../docs/manifest.ts'),
    ]);

  return [
    '/',
    '/demos',
    '/how-it-works',
    '/docs',
    '/story/drifters',
    '/drive',
    '/worlds',
    ...Object.keys(DEMO_META)
      .filter((id) => getDatasetById(id))
      .map((id) => `/demos/${id}`),
    ...flatDocEntries.map((entry) => `/docs/${entry.slug}`),
  ];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderSitemapXml(paths: readonly string[]): string {
  const urls = [...new Set(paths)]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const location = path === '/' ? SITE_ORIGIN : `${SITE_ORIGIN}${path}`;
      return `  <url><loc>${escapeXml(location)}</loc></url>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n');
}
