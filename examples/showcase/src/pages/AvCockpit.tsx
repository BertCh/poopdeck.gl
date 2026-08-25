import { clientOnlyRoute } from '../lib/clientOnlyRoute';
import type { MetaFunction } from 'react-router';
import { createSeoMeta } from '../lib/seo';

export const meta: MetaFunction = ({ location }) =>
  createSeoMeta({
    title: 'Autonomous-vehicle scene explorer',
    description:
      'Inspect time-synchronized LiDAR, trajectories, objects, and map context in the STT autonomous-vehicle cockpit.',
    path: location.pathname,
  });

// AV telemetry cockpit (deck.gl mesh layers + three) — client-only, never
// prerendered. Lazy so its heavy deps stay out of the prerender bundle.
export default clientOnlyRoute(() => import('./AvCockpitImpl'));
