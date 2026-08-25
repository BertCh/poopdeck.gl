import type { MetaDescriptor } from 'react-router';

export const SITE_ORIGIN = 'https://poopdeck.gl';
export const SITE_NAME = 'poopdeck.gl';

export const DEFAULT_DESCRIPTION =
  'Build, stream, and render full-fidelity vector data across space and time with SpatioTemporal Tiles and poopdeck.gl.';

/** Site-wide machine-readable identity for search engines and link unfurlers. */
export const SOFTWARE_APPLICATION_STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'poopdeck.gl / SpatioTemporal Tiles',
  alternateName: 'STT',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Cross-platform',
  description: DEFAULT_DESCRIPTION,
  url: SITE_ORIGIN,
  codeRepository: 'https://github.com/RobertChristie/spatiotemporal-tiles',
  license: 'https://opensource.org/license/mit',
} as const;

export interface SeoMetaOptions {
  /** Page title without the site-name suffix. */
  title: string;
  description: string;
  /** Canonical pathname. Query strings and fragments are deliberately omitted. */
  path: string;
  type?: 'website' | 'article';
  noIndex?: boolean;
  /** Keep the homepage's editorial title instead of appending the site name. */
  absoluteTitle?: boolean;
}

/** Normalize one site-local path into the public, non-trailing-slash URL form. */
export function canonicalUrl(pathname: string): string {
  const path = `/${pathname}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  return `${SITE_ORIGIN}${path === '/' ? '' : path}`;
}

/**
 * One metadata contract for every public route.
 *
 * Leaf route modules call this helper rather than copying slightly different
 * title, canonical, Open Graph, and Twitter descriptors across the route tree.
 */
export function createSeoMeta({
  title,
  description,
  path,
  type = 'website',
  noIndex = false,
  absoluteTitle = false,
}: SeoMetaOptions): MetaDescriptor[] {
  const documentTitle = absoluteTitle ? title : `${title} | ${SITE_NAME}`;
  const canonical = canonicalUrl(path);

  return [
    { title: documentTitle },
    { name: 'description', content: description },
    { tagName: 'link', rel: 'canonical', href: canonical },
    { property: 'og:site_name', content: SITE_NAME },
    { property: 'og:type', content: type },
    { property: 'og:title', content: documentTitle },
    { property: 'og:description', content: description },
    { property: 'og:url', content: canonical },
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: documentTitle },
    { name: 'twitter:description', content: description },
    ...(noIndex
      ? [{ name: 'robots', content: 'noindex, follow' } as MetaDescriptor]
      : []),
  ];
}
