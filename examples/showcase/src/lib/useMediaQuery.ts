/**
 * Reactive CSS media-query hook, mirroring {@link ./reducedMotion} — a
 * `matchMedia`-backed `useSyncExternalStore` so layouts can branch on viewport
 * size and re-render live when the query flips (rotate, resize, devtools), with
 * no resize-listener churn.
 *
 *   • `useMediaQuery(query)` — true while the query matches.
 *   • `useIsMobile()` — true on phone-width viewports (below Tailwind's `md`,
 *     i.e. < 768px), where the AV cockpit swaps its floating desktop chrome for
 *     a single-column mobile layout.
 */
import { useCallback, useSyncExternalStore } from "react";

const supported = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

/** Reactive: true while `query` matches the current viewport. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!supported()) return () => {};
      const mql = window.matchMedia(query);
      // addEventListener is the modern API; older Safari only has addListener.
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => supported() && window.matchMedia(query).matches,
    [query],
  );
  // getServerSnapshot returns false — client-only Vite SPA; default to the
  // desktop (non-matching) layout for the never-hit SSR path.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** True on phone-width viewports (below Tailwind's `md` breakpoint = 768px). */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767.98px)");
}
