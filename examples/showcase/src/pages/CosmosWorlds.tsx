import { clientOnlyRoute } from '../lib/clientOnlyRoute';
import type { MetaFunction } from 'react-router';
import { createSeoMeta } from '../lib/seo';

export const meta: MetaFunction = ({ location }) =>
  createSeoMeta({
    title: 'Generated-world scenario explorer',
    description:
      'Explore synchronized vector scenes and generated visual worlds across weather and driving scenarios.',
    path: location.pathname,
  });

// World Model Scenario Explorer (deck.gl gallery + synced generated video) —
// client-only, never prerendered. Lazy so its heavy deps stay out of the
// prerender bundle.
export default clientOnlyRoute(() => import('./CosmosWorldsImpl'));
