import { clientOnlyRoute } from '../lib/clientOnlyRoute';

// World Model Scenario Explorer (deck.gl gallery + synced generated video) —
// client-only, never prerendered. Lazy so its heavy deps stay out of the
// prerender bundle.
export default clientOnlyRoute(() => import('./CosmosWorldsImpl'));
