import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import HomePage from "./pages/HomePage";
import DemoPage from "./pages/DemoPage";
import DrifterStory from "./pages/DrifterStory";
import { datasets } from "./datasets";
import "./index.css";

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
          <Route index element={<HomePage />} />
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
