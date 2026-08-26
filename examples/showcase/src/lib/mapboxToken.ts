/**
 * Shared Mapbox access token for every basemap surface (the demo viewer, the
 * scrubber's static hover preview, and the AV cockpit). Set
 * `VITE_MAPBOX_TOKEN` in `.env.local` (see `.env.example`). No token is
 * checked into the repo: client-side tokens are public by nature, so deploys
 * should use a URL-restricted token, and fresh clones must bring their own.
 */
export const MAPBOX_ACCESS_TOKEN: string =
  (import.meta as any).env?.VITE_MAPBOX_TOKEN || '';

// DEV ONLY. The message is setup instructions for someone working in THIS
// repo ("copy .env.example to .env.local"), which is noise — and reads as a
// broken deployment — in the console of the published site, where opening
// devtools is exactly what an evaluating developer does. A missing token in
// production is a deploy-configuration fact, not something the visitor can act
// on. (DX review 2026-08-26, F10.)
if (
  !MAPBOX_ACCESS_TOKEN &&
  (import.meta as any).env?.DEV &&
  typeof console !== 'undefined'
) {
  console.warn(
    '[showcase] VITE_MAPBOX_TOKEN is not set — Mapbox basemap surfaces will ' +
      'not load. Copy examples/showcase/.env.example to .env.local and set it.',
  );
}
