/**
 * Shared Mapbox access token for every basemap surface (the demo viewer, the
 * scrubber's static hover preview, and the AV cockpit). Set
 * `VITE_MAPBOX_TOKEN` in `.env.local` (see `.env.example`). No token is
 * checked into the repo: client-side tokens are public by nature, so deploys
 * should use a URL-restricted token, and fresh clones must bring their own.
 */
export const MAPBOX_ACCESS_TOKEN: string =
  (import.meta as any).env?.VITE_MAPBOX_TOKEN || '';

if (!MAPBOX_ACCESS_TOKEN && typeof console !== 'undefined') {
  console.warn(
    '[showcase] VITE_MAPBOX_TOKEN is not set — Mapbox basemap surfaces will ' +
      'not load. Copy examples/showcase/.env.example to .env.local and set it.',
  );
}
