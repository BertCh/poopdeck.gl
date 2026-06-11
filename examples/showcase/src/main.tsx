import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import SiteChrome from "./components/SiteChrome";
import HomePage from "./pages/HomePage";
import DemoPage from "./pages/DemoPage";
import DemosCatalog from "./pages/DemosCatalog";
import DemoDetailPage from "./pages/DemoDetailPage";
import DrifterStory from "./pages/DrifterStory";
import { datasets } from "./datasets";
import "./index.css";

// The docs section (react-markdown, prism theme, nav manifest, and one lazy
// chunk per markdown file) loads on demand so the landing/demo bundles don't
// carry it.
const DocsLayout = React.lazy(() => import("./docs/DocsLayout"));
const DocsLanding = React.lazy(() => import("./docs/DocsLanding"));
const DocPage = React.lazy(() => import("./docs/DocPage"));

const DocsFallback: React.FC = () => (
  <div className="px-8 py-10 text-sm" style={{ color: "var(--ink-400)" }}>
    Loading documentation…
  </div>
);

// Expose a JSON-safe dataset manifest on `window` so the render-test runner
// can enumerate every demo without re-parsing the TS source. Only includes
// fields the runner needs; deliberately drops React/function props so the
// object is structured-clone-safe.
(window as unknown as { __STT_DATASETS?: unknown }).__STT_DATASETS = datasets.map(
  (d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    url: d.url,
    timeRange: d.timeRange,
    targetPlaybackSeconds: d.targetPlaybackSeconds,
    useGlobe: d.useGlobe ?? false,
  }),
);

// Silence the known non-fatal luma.gl link warning that fires on deck.gl
// ≤ 9.3 for the per-tile sublayer demos:
//   `WebGL Link error: Too many attributes (instancePickingColors)`
// deck.gl falls back to a non-picking shader and rendering proceeds —
// the warning is just visual noise. The proper fix lands in deck.gl 9.4
// (gl_InstanceID picking, no vertex-attribute slot).
const originalError = console.error;
console.error = function (...args: unknown[]): void {
  const msg = String(args[0] ?? '');
  if (
    /Too many attributes \(instancePickingColors\)/.test(msg) ||
    /Link error during link-error/.test(msg)
  ) {
    return;
  }
  originalError.apply(console, args as []);
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          {/* "Site" pages share the header chrome + a single scroll surface. */}
          <Route element={<SiteChrome />}>
            <Route index element={<HomePage />} />
            <Route path="demos" element={<DemosCatalog />} />
            <Route path="demos/:datasetId" element={<DemoDetailPage />} />
            <Route
              path="docs"
              element={
                <Suspense fallback={<DocsFallback />}>
                  <DocsLayout />
                </Suspense>
              }
            >
              <Route index element={<DocsLanding />} />
              {/* Catch-all handles two-segment slugs (api/cli-reference) and
                  renders a styled 404 for unknown ones. */}
              <Route path="*" element={<DocPage />} />
            </Route>
          </Route>

          {/* Chrome-free fullscreen surfaces. */}
          <Route path="story/drifters" element={<DrifterStory />} />
          <Route path="demo/:datasetId" element={<DemoPage />} />
          {/* Backwards-compat: old `/maplibre/:id` deep-links route to the
              same dataset; the renderer toggle on DemoPage replaces the
              previous standalone page. */}
          <Route path="maplibre/:datasetId" element={<DemoPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
