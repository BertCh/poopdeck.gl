import { clientOnlyRoute } from "../lib/clientOnlyRoute";

// CesiumJS (WGS84 globe) viewer — client-only, never prerendered. Lazy so
// Cesium stays out of the prerender bundle.
export default clientOnlyRoute(() => import("./CesiumDemoPageImpl"));
