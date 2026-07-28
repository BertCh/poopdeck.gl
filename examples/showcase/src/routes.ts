import {
  type RouteConfig,
  index,
  layout,
  route,
} from '@react-router/dev/routes';

/**
 * Route tree (framework mode) — mirrors the former hand-written <Routes> in
 * main.tsx. Each route module is code-split automatically, so the old
 * React.lazy/Suspense wrappers are gone.
 *
 * Two layout tiers:
 *   Layout        — MotionDisclaimer + main flex; wraps every page.
 *   SiteChrome    — shared header + the single scroll surface; wraps the
 *                   "site" pages only. Fullscreen viewers are siblings of
 *                   SiteChrome (chrome-free) but still under Layout.
 */
/**
 * Is this build allowed to carry the experimental surfaces?
 *
 * `VITE_DATA_BASE_URL` is set exactly when the build points at the public CDN,
 * so it is this repo's one signal for "the public deploy" — the same signal
 * `ATLAS_AVAILABLE` in `datasets.ts` uses for the nav link. Read from both
 * `process.env` and `import.meta.env` because this module is evaluated by the
 * react-router config loader in Node, where only the former is guaranteed.
 */
const EXPERIMENTAL_IN_BUILD =
  !(typeof process !== 'undefined' ? process.env?.VITE_DATA_BASE_URL : '') &&
  !(import.meta as any).env?.VITE_DATA_BASE_URL;

export default [
  layout('components/Layout.tsx', [
    layout('components/SiteChrome.tsx', [
      index('pages/HomePage.tsx'),
      route('demos', 'pages/DemosCatalog.tsx'),
      route('how-it-works', 'pages/HowItWorks.tsx'),
      route('demos/:datasetId', 'pages/DemoDetailPage.tsx'),
      route('docs', 'docs/DocsLayout.tsx', [
        index('docs/DocsLanding.tsx'),
        // Catch-all handles two-segment slugs (api/cli-reference) and renders
        // a styled 404 for unknown ones.
        route('*', 'docs/DocPage.tsx'),
      ]),
    ]),

    // Chrome-free fullscreen surfaces (client-only; never prerendered).
    route('story/drifters', 'pages/DrifterStory.tsx'),
    route('drive/:sceneId?', 'pages/AvCockpit.tsx'),
    route('worlds/:worldId?', 'pages/CosmosWorlds.tsx'),
    // Neural-State Atlas — EXPERIMENTAL, and compiled out of the public build
    // entirely rather than merely unlinked. Its archives are not on the CDN, so
    // a registered route there would ship the page and its whole layer tree in
    // the bundle and then answer /atlas with an error card. The optional
    // segment is the METRIC, so a link can carry "show me the attribution view"
    // and browser-back returns to activation — see atlasTypes' §3 metric enum.
    ...(EXPERIMENTAL_IN_BUILD
      ? [route('atlas/:metric?', 'pages/NeuralAtlas.tsx')]
      : []),
    route('demo/:datasetId', 'pages/DemoPage.tsx'),
    // Backwards-compat: old /maplibre/:id deep-links route to the same viewer.
    // Same module reused → needs a distinct id.
    route('maplibre/:datasetId', 'pages/DemoPage.tsx', { id: 'demo-maplibre' }),
    route('cesium/:datasetId', 'pages/CesiumDemoPage.tsx'),
  ]),
] satisfies RouteConfig;
