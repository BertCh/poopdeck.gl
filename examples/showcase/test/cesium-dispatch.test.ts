/**
 * Cesium route-dispatch exhaustiveness gate.
 *
 * `CESIUM_SUPPORTED_TYPES` is DERIVED from the `cesiumBackend` descriptor, so
 * `CesiumDemoPage` starts offering a demo the moment the package declares the
 * kind it mounts — with no showcase edit, and no compiler error if
 * `buildCesiumLayer` has no branch for it. The non-deck parity campaign took
 * that backend from 5 kinds to 23 in one pass, which silently put a Cesium
 * toggle on six shipped demo pages whose only possible outcome was a blank
 * globe (`buildCesiumLayer` returns `null`, `CesiumRenderer`'s belt catches it,
 * nothing draws).
 *
 * So: for every SHIPPED dataset the route will offer, actually build the layer.
 * A descriptor that grows past the dispatch fails here, which is the only place
 * it can be noticed before a browser.
 *
 * Unshipped kinds are deliberately out of scope — the gate is about demo pages
 * that exist, not about mirroring the descriptor for its own sake.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Scene } from 'cesium';
import { datasets } from '../src/datasets';
import {
  CESIUM_SUPPORTED_TYPES,
  buildCesiumLayer,
} from '../src/components/buildCesiumLayer';

/** The slice every STT Cesium layer touches at construction. */
function stubScene(): Scene {
  return {
    primitives: {
      add: <T>(p: T): T => p,
      remove: () => true,
      removeAll: () => {},
      contains: () => true,
    },
    pick: () => undefined,
    requestRender: () => {},
    globe: { ellipsoid: undefined },
  } as unknown as Scene;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Cesium demo route can build every type it offers', () => {
  const offered = datasets.filter((d) => CESIUM_SUPPORTED_TYPES.has(d.type));

  it('offers at least the movement family (the gate is not vacuous)', () => {
    expect(offered.length).toBeGreaterThan(5);
    expect(new Set(offered.map((d) => d.type))).toContain('trips');
  });

  it.each([...new Set(offered.map((d) => d.type))])(
    'builds a layer for %s',
    (type) => {
      const dataset = offered.find((d) => d.type === type)!;
      // The summary layers warn through `onDiagnostics` on an empty build; the
      // gate is about the dispatch, not about console hygiene.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const layer = buildCesiumLayer(stubScene(), dataset);
      expect(layer, `${dataset.id} (${type}) has no dispatch branch`).not.toBe(
        null,
      );
      layer?.dispose();
    },
  );
});
