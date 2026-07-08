/**
 * Shared access to the user's `prefers-reduced-motion` accessibility setting.
 *
 * Several of the showcase's surfaces animate continuously — the hero globe
 * spins and autoplays drifter trails, demos autoplay on scroll, the data story
 * flies the camera and cross-dissolves between eras, summary layers pulse. None
 * of that is CSS, so it can't be neutralized by a stylesheet `@media` query
 * alone; each motion source reads this and holds still when the user has asked
 * the OS to reduce motion.
 *
 *   • `useReducedMotion()` — reactive hook; re-renders when the OS setting flips
 *     so effects can start/stop motion live (no reload needed).
 *   • `prefersReducedMotion()` — one-shot read for imperative paths.
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

const supported = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function getSnapshot(): boolean {
  return supported() && window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  if (!supported()) return () => {};
  const mql = window.matchMedia(QUERY);
  // addEventListener is the modern API; older Safari only has addListener.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

/** Reactive: true when the OS "reduce motion" setting is on. */
export function useReducedMotion(): boolean {
  // getServerSnapshot returns false — this is a client-only Vite SPA, but the
  // third arg keeps useSyncExternalStore happy and defaults to "allow motion".
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** One-shot read for effects/handlers that can't use a hook. */
export function prefersReducedMotion(): boolean {
  return getSnapshot();
}
