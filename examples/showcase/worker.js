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
 * client-only fullscreen routes (`/demo/:id`, `/maplibre/:id`, `/cesium/:id`,
 * `/drive`, `/story/drifters`) and any unknown path. Those must boot from the
 * generic shell (which hydrates at any URL), NOT from `index.html` (which is
 * the prerendered home and would hydrate-mismatch at another URL). So we serve
 * `__spa-fallback.html` with a 200.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const fallback = await env.ASSETS.fetch(
      new URL('/__spa-fallback.html', url.origin),
    );
    return new Response(fallback.body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // The shell is tiny and route-agnostic; let it cache briefly at the
        // edge but always revalidate so a redeploy's new bundle is picked up.
        'cache-control': 'public, max-age=0, must-revalidate',
      },
    });
  },
};
