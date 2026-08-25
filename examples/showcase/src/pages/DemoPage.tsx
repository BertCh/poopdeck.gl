import { clientOnlyRoute } from '../lib/clientOnlyRoute';
import type { MetaFunction } from 'react-router';
import { createSeoMeta } from '../lib/seo';

export const meta: MetaFunction = ({ location }) => {
  const maplibre = location.pathname.startsWith('/maplibre/');
  return createSeoMeta({
    title: maplibre ? 'MapLibre STT viewer' : 'Interactive STT viewer',
    description: maplibre
      ? 'Explore a SpatioTemporal Tiles dataset in the fullscreen MapLibre renderer.'
      : 'Explore a SpatioTemporal Tiles dataset in the fullscreen interactive renderer.',
    path: location.pathname,
    // Fullscreen viewers duplicate the indexable editorial /demos/:id pages
    // when a catalog entry exists; keep them usable without splitting search
    // authority across two URLs.
    noIndex: true,
  });
};

// Fullscreen deck.gl + MapLibre viewer — pure client-only (never prerendered).
// The heavy implementation is lazy so it stays out of the prerender bundle.
export default clientOnlyRoute(() => import('./DemoPageImpl'));
