/**
 * Cloudflare Worker entry for the showcase.
 *
 * The site is a React Router v7 SPA with build-time prerendering (ssr:false).
 * The build emits real static HTML for the prerendered routes — `index.html`
 * (home), `demos/`, `demos/<id>/`, `how-it-works/`, `docs/**` — plus a generic
 * `__spa-fallback.html` shell for everything else.
 *
 * Static assets are matched and served first (see wrangler.jsonc: assets are
 * tried before the Worker). This Worker only runs on an asset MISS — i.e. the
 * client-only fullscreen routes and any unknown path. Explicit client routes
 * must boot from the generic shell (which hydrates at any URL), NOT from
 * `index.html` (the prerendered home would hydrate-mismatch at another URL).
 * Unknown paths receive the same shell with a real 404 status so the router can
 * render its error boundary without producing a search-engine soft 404.
 */

const CLIENT_ONLY_ROUTE_PATTERNS = [
  /^\/story\/drifters$/,
  /^\/drive(?:\/[^/]+)?$/,
  /^\/worlds(?:\/[^/]+)?$/,
  /^\/demo\/[^/]+$/,
  /^\/maplibre\/[^/]+$/,
  /^\/cesium\/[^/]+$/,
];

const BASE_SECURITY_HEADERS = {
  'content-security-policy': "frame-ancestors 'self'",
  'permissions-policy':
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
};

export function isClientOnlyRoute(pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return CLIENT_ONLY_ROUTE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function applySecurityHeaders(headers) {
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const headers = new Headers({
        allow: 'GET, HEAD',
        'content-type': 'text/plain; charset=utf-8',
      });
      applySecurityHeaders(headers);
      return new Response('Method not allowed', { status: 405, headers });
    }

    const fallback = await env.ASSETS.fetch(
      new URL('/__spa-fallback.html', url.origin),
    );
    const knownClientRoute = isClientOnlyRoute(url.pathname);
    const wantsHtml =
      request.headers.get('accept')?.includes('text/html') ?? false;

    // Missing scripts, images, schema files, and other machine-readable assets
    // should never receive an HTML document, even as a 404 response.
    if (!knownClientRoute && !wantsHtml) {
      const headers = new Headers({
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=0, must-revalidate',
        'x-robots-tag': 'noindex',
      });
      applySecurityHeaders(headers);
      return new Response(request.method === 'HEAD' ? null : 'Not found', {
        status: 404,
        headers,
      });
    }

    const headers = new Headers(fallback.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    // The shell is tiny and route-agnostic; always revalidate so a redeploy's
    // new bundle is picked up.
    headers.set('cache-control', 'public, max-age=0, must-revalidate');
    applySecurityHeaders(headers);
    if (!knownClientRoute) headers.set('x-robots-tag', 'noindex');
    if (/^\/(?:demo|maplibre|cesium)\//.test(url.pathname)) {
      headers.set('x-robots-tag', 'noindex, follow');
    }

    return new Response(request.method === 'HEAD' ? null : fallback.body, {
      status: knownClientRoute ? 200 : 404,
      headers,
    });
  },
};
