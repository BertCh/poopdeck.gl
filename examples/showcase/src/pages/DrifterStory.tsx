import { clientOnlyRoute } from '../lib/clientOnlyRoute';
import type { MetaFunction } from 'react-router';
import { createSeoMeta } from '../lib/seo';

export const meta: MetaFunction = () =>
  createSeoMeta({
    title: '43 years adrift',
    description:
      'Follow 43 years of NOAA surface drifter observations in an interactive story powered by SpatioTemporal Tiles.',
    path: '/story/drifters',
    type: 'article',
  });

// Scroll-driven cinematic drifters story (deck.gl globe) — client-only, never
// prerendered. Lazy so its heavy deps stay out of the prerender bundle.
export default clientOnlyRoute(() => import('./DrifterStoryImpl'));
