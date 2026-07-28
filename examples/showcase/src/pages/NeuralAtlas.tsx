import { clientOnlyRoute } from '../lib/clientOnlyRoute';

// Neural-State Atlas — a transformer's internal state as a navigable map played
// on the token clock. Client-only, never prerendered; lazy so its deck + layer
// deps stay out of the prerender bundle.
export default clientOnlyRoute(() => import('./NeuralAtlasImpl'));
