import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalUrl,
  createSeoMeta,
  SITE_ORIGIN,
  SOFTWARE_APPLICATION_STRUCTURED_DATA,
} from '../src/lib/seo';
import { getPublicIndexPaths, renderSitemapXml } from '../src/lib/publicPaths';

const SHOWCASE_ROOT = path.resolve(import.meta.dirname, '..');

describe('site metadata contract', () => {
  it('emits a complete canonical, Open Graph, and Twitter set', () => {
    const meta = createSeoMeta({
      title: 'Documentation',
      description: 'Reference documentation.',
      path: '/docs/',
    });

    expect(meta).toContainEqual({ title: 'Documentation | poopdeck.gl' });
    expect(meta).toContainEqual({
      name: 'description',
      content: 'Reference documentation.',
    });
    expect(meta).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://poopdeck.gl/docs',
    });
    expect(meta).toContainEqual({
      property: 'og:url',
      content: 'https://poopdeck.gl/docs',
    });
    expect(meta).toContainEqual({ name: 'twitter:card', content: 'summary' });
  });

  it('normalizes site-local canonical paths and marks duplicate viewers', () => {
    expect(canonicalUrl('/')).toBe(SITE_ORIGIN);
    expect(canonicalUrl('//docs///')).toBe(`${SITE_ORIGIN}/docs`);
    expect(
      createSeoMeta({
        title: 'Viewer',
        description: 'Fullscreen viewer.',
        path: '/demo/example',
        noIndex: true,
      }),
    ).toContainEqual({ name: 'robots', content: 'noindex, follow' });
  });

  it('publishes one software identity as structured data', () => {
    expect(SOFTWARE_APPLICATION_STRUCTURED_DATA).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'poopdeck.gl / SpatioTemporal Tiles',
      url: SITE_ORIGIN,
      license: 'https://opensource.org/license/mit',
    });
  });
});

describe('crawler discovery contract', () => {
  it('uses one unique route list for prerendering and sitemap generation', async () => {
    const routes = await getPublicIndexPaths();

    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toEqual(
      expect.arrayContaining([
        '/',
        '/demos',
        '/how-it-works',
        '/docs',
        '/story/drifters',
        '/drive',
        '/worlds',
      ]),
    );
    expect(routes.some((route) => route.startsWith('/demos/'))).toBe(true);
    expect(routes.some((route) => route.startsWith('/docs/'))).toBe(true);
    expect(routes.some((route) => route.startsWith('/demo/'))).toBe(false);

    const sitemap = renderSitemapXml(routes);
    for (const route of routes) {
      const url = route === '/' ? SITE_ORIGIN : `${SITE_ORIGIN}${route}`;
      expect(sitemap).toContain(`<loc>${url}</loc>`);
    }
  });

  it('ships crawler and manifest assets with the public origin', () => {
    const robots = fs.readFileSync(
      path.join(SHOWCASE_ROOT, 'public/robots.txt'),
      'utf8',
    );
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://poopdeck.gl/sitemap.xml');

    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(SHOWCASE_ROOT, 'public/site.webmanifest'),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({
      name: 'poopdeck.gl — SpatioTemporal Tiles',
      start_url: '/',
      scope: '/',
      theme_color: '#0a0d12',
    });
  });
});
