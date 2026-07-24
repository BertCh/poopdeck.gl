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
    route('demo/:datasetId', 'pages/DemoPage.tsx'),
    // Backwards-compat: old /maplibre/:id deep-links route to the same viewer.
    // Same module reused → needs a distinct id.
    route('maplibre/:datasetId', 'pages/DemoPage.tsx', { id: 'demo-maplibre' }),
    route('cesium/:datasetId', 'pages/CesiumDemoPage.tsx'),
  ]),
] satisfies RouteConfig;
