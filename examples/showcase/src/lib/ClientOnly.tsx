import { useEffect, useState, type ReactNode } from "react";

/**
 * Renders `children()` only after the component has hydrated in the browser.
 *
 * During the build-time (Node) prerender pass `hydrated` is false, so only
 * `fallback` renders and `children()` is never invoked — which means a lazy
 * import inside `children()` (e.g. a deck.gl/WebGL surface) is not pulled into
 * the prerendered module graph. This is how the statically prerendered pages
 * (home, per-demo) keep their live canvases client-only while still shipping a
 * real static editorial shell.
 */
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: () => ReactNode;
  fallback?: ReactNode;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return <>{hydrated ? children() : fallback}</>;
}
