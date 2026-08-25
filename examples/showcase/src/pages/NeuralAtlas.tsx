import { clientOnlyRoute } from '../lib/clientOnlyRoute';
import type { MetaFunction } from 'react-router';
import { createSeoMeta } from '../lib/seo';

export const meta: MetaFunction = ({ location }) =>
  createSeoMeta({
    title: 'Neural-state atlas',
    description:
      'Explore an experimental spatiotemporal atlas of model activations and token traces.',
    path: location.pathname,
    noIndex: true,
  });

// Neural-State Atlas — a transformer's internal state as a navigable map played
// on the token clock. Client-only, never prerendered; lazy so its deck + layer
// deps stay out of the prerender bundle.
export default clientOnlyRoute(() => import('./NeuralAtlasImpl'));
