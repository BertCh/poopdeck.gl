/**
 * Mapbox host detection + Standard-style slot support.
 *
 * The maplibre and mapbox custom-layer surfaces are near-identical — the same
 * `render(gl, matrix, …)` positional signature, the same premultiplied-alpha
 * translucent pass — so one `STTBaseLayer` build runs on either host. The ONE
 * placement difference is the mapbox Standard style's `slot`: a custom layer
 * may set `slot: 'bottom' | 'middle' | 'top'` and mapbox-gl reads it off the
 * layer object at `map.addLayer` time to position it inside the style's layer
 * stack (below fills, between fills and symbols, or on top). MapLibre has no
 * slot concept at all, so a slot request there must be ignored rather than
 * stamped onto a layer the host will never read it from.
 *
 * This module owns the two pieces the base layer needs to honour that split:
 * the {@link MapboxSlot} vocabulary and an {@link isMapboxHost} heuristic. It
 * NEVER imports or vendors mapbox-gl (it is proprietary): the host check is
 * purely structural / duck-typed, and mapbox is a
 * structural optional peer at most (no `mapbox-gl` dependency is added; the
 * documented floor is mapbox-gl >=3.9.1, below which custom layers crash
 * `queryRenderedFeatures`). maplibre stays the default, CI-tested target.
 *
 * Scope: mercator only. Mapbox globe would require hand-rolled ECEF from
 * the positional render params and is deferred; a mapbox user at globe zooms
 * sees the basemap's own globe→mercator transition cover most practical zooms.
 * The slot governs 2D stacking, which is orthogonal to projection, so slot
 * support holds regardless.
 */

/** The three Standard-style slots a mapbox custom layer may target. */
export type MapboxSlot = 'bottom' | 'middle' | 'top';

const MAPBOX_SLOTS: readonly MapboxSlot[] = ['bottom', 'middle', 'top'];

/**
 * Runtime guard for a slot value crossing the untyped JS boundary (a caller
 * past the TS `MapboxSlot` type). The base layer drops anything this rejects
 * rather than stamp an unknown string mapbox would refuse.
 */
export function isValidMapboxSlot(v: unknown): v is MapboxSlot {
  return (
    typeof v === 'string' && (MAPBOX_SLOTS as readonly string[]).includes(v)
  );
}

/**
 * Is `map` a Mapbox GL JS host (as opposed to MapLibre)?
 *
 * There is no version field common to both libraries, so the check is
 * DUCK-TYPED against APIs mapbox-gl v3 exposes that MapLibre (any version)
 * does not:
 *
 *   1. `getConfigProperty` — mapbox v3's Standard-style import-config accessor
 *      (`map.getConfigProperty(importId, configName)`). MapLibre has no
 *      style-import config system, so this method is mapbox-exclusive. It is
 *      the cheapest and strongest signal; we only test `typeof`, never call it
 *      (calling it without args would throw). MapLibre's own bespoke state API
 *      is spelled `getGlobalState`, not `getConfigProperty`, so there is no
 *      collision.
 *   2. Failing that, the returned style's import graph. Mapbox's Standard style
 *      is delivered through an `imports` array and registers named `slots`;
 *      MapLibre's flat style spec carries neither. `getStyle()` can throw
 *      before the style resolves, so the read is guarded and an exception is
 *      treated as inconclusive.
 *
 * Conservative by construction: an unrecognised host is treated as NOT mapbox,
 * so a slot request on it is ignored rather than applied blindly.
 */
export function isMapboxHost(map: unknown): boolean {
  if (map === null || typeof map !== 'object') return false;
  const m = map as { getConfigProperty?: unknown; getStyle?: unknown };
  if (typeof m.getConfigProperty === 'function') return true;
  if (typeof m.getStyle === 'function') {
    try {
      const style = (m.getStyle as () => unknown)();
      if (style !== null && typeof style === 'object') {
        const s = style as { imports?: unknown; slots?: unknown };
        if (Array.isArray(s.imports) || Array.isArray(s.slots)) return true;
      }
    } catch {
      // getStyle throws before the style loads — inconclusive; fall through.
    }
  }
  return false;
}
