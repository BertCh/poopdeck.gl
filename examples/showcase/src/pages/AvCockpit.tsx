import { clientOnlyRoute } from "../lib/clientOnlyRoute";

// AV telemetry cockpit (deck.gl mesh layers + three) — client-only, never
// prerendered. Lazy so its heavy deps stay out of the prerender bundle.
export default clientOnlyRoute(() => import("./AvCockpitImpl"));
