import React, { Suspense, type ComponentType } from "react";
import { ClientOnly } from "./ClientOnly";

const FullscreenLoading: React.FC = () => (
  <div
    className="w-full h-full flex items-center justify-center text-sm"
    style={{ background: "var(--page-bg)", color: "var(--ink-400)" }}
  >
    Loading…
  </div>
);

/**
 * Wraps a browser-only page component (deck.gl / three / cesium / maplibre) as
 * a lazy, client-only route module.
 *
 * The heavy implementation is pulled in via `import()`, so it lands in its own
 * chunk that never enters React Router's server/prerender bundle — critical
 * because that bundle statically includes every route module and would
 * otherwise evaluate browser-only (and Node-hostile, e.g. h3-js's Emscripten
 * `__dirname`) top-level code during the build's prerender pass. These routes
 * are pure SPA and are never prerendered, so `ClientOnly` also guards against
 * any render-time browser API use.
 */
export function clientOnlyRoute(
  load: () => Promise<{ default: ComponentType }>,
): React.FC {
  const Lazy = React.lazy(load);
  return function ClientOnlyRoute() {
    return (
      <ClientOnly fallback={<FullscreenLoading />}>
        {() => (
          <Suspense fallback={<FullscreenLoading />}>
            <Lazy />
          </Suspense>
        )}
      </ClientOnly>
    );
  };
}
