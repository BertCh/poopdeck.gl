import { clientOnlyRoute } from "../lib/clientOnlyRoute";

// Scroll-driven cinematic drifters story (deck.gl globe) — client-only, never
// prerendered. Lazy so its heavy deps stay out of the prerender bundle.
export default clientOnlyRoute(() => import("./DrifterStoryImpl"));
