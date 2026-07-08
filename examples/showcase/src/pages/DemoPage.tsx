import { clientOnlyRoute } from '../lib/clientOnlyRoute';

// Fullscreen deck.gl + MapLibre viewer — pure client-only (never prerendered).
// The heavy implementation is lazy so it stays out of the prerender bundle.
export default clientOnlyRoute(() => import('./DemoPageImpl'));
