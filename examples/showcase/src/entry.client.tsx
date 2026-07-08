import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { datasets } from "./datasets";

// Expose a JSON-safe dataset manifest on `window` so the render-test runner
// (tools/render-test) can enumerate every demo without re-parsing the TS
// source. Only includes fields the runner needs; deliberately drops
// React/function props so the object is structured-clone-safe. Lives in the
// browser entry so it never runs during the Node prerender pass.
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
// deck.gl falls back to a non-picking shader and rendering proceeds — the
// warning is just visual noise. The proper fix lands in deck.gl 9.4
// (gl_InstanceID picking, no vertex-attribute slot).
const originalError = console.error;
console.error = function (...args: unknown[]): void {
  const msg = String(args[0] ?? "");
  if (
    /Too many attributes \(instancePickingColors\)/.test(msg) ||
    /Link error during link-error/.test(msg)
  ) {
    return;
  }
  originalError.apply(console, args as []);
};

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
