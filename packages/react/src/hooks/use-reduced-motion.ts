// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * useReducedMotion — live `prefers-reduced-motion: reduce` subscription.
 *
 * The transport bar styles several things inline (so the buttons keep working
 * in a consumer whose Tailwind build never scanned `node_modules`), and an
 * inline `transition` / `animation` cannot be gated by a CSS media query. This
 * hook is that gate: components read it and simply omit the transition.
 *
 * Implemented with `useSyncExternalStore` rather than `useState` + an effect so
 * the FIRST paint is already correct — the effect version renders one animated
 * frame before it corrects itself, which is precisely the frame a
 * motion-sensitive user should not see. `getServerSnapshot` returns false so SSR
 * and hydration agree.
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

// `undefined` = not probed yet; `null` = no matchMedia (SSR / old jsdom).
let cached: MediaQueryList | null | undefined;

const media = (): MediaQueryList | null => {
  if (cached === undefined) {
    cached =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(QUERY)
        : null;
  }
  return cached;
};

const subscribe = (onStoreChange: () => void): (() => void) => {
  const mql = media();
  if (!mql) return () => {};
  // Safari < 14 only has the deprecated addListener; both are no-ops elsewhere.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onStoreChange);
    return () => mql.removeEventListener('change', onStoreChange);
  }
  mql.addListener(onStoreChange);
  return () => mql.removeListener(onStoreChange);
};

// Returns a boolean, so `useSyncExternalStore`'s identity check is value
// equality — no tearing, no re-render loop from a fresh object each call.
const getSnapshot = (): boolean => media()?.matches ?? false;
const getServerSnapshot = (): boolean => false;

/** True when the user asked the platform for reduced motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
