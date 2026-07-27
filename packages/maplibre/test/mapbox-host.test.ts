/**
 * Mapbox-target tests (campaign D5, Wave M5 item 1).
 *
 * The maplibre backend runs on a Mapbox GL JS v3 host from the SAME build:
 *   - `isMapboxHost` duck-types the two libraries apart so slot support only
 *     activates on mapbox (host-slot.ts).
 *   - `attach({ slot })` stamps the mapbox Standard-style slot onto the layer
 *     object (mapbox reads `layer.slot` at addLayer time); on maplibre the
 *     request is dropped with a one-time dev warning.
 *   - the mapbox positional render signature
 *     `render(gl, matrix, projection, projectionToMercatorMatrix,
 *      projectionToMercatorTransition, centerInMercator, pixelsPerMeterRatio)`
 *     rides the existing legacy (mercator) dispatch: arg2 is a matrix, the
 *     projection-spec arg3 is not camera options, and the extra positional
 *     globe params never reach the adapter. Mapbox globe is DEFERRED (D5) — the
 *     transition param is ignored, so the layer stays mercator.
 *
 * No mapbox-gl dependency: the host is a structural mock carrying only the
 * markers `isMapboxHost` keys on (proprietary-license hygiene, campaign §2).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeometryType, type Tile } from '@poopdeck.gl/core';
import {
  STTBaseLayer,
  type DrawContext,
  type STTBaseLayerOptions,
} from '../src/base-layer';
import {
  isMapboxHost,
  isValidMapboxSlot,
  type MapboxSlot,
} from '../src/lib/host-slot';
import { DEFAULT_FOV_RADIANS } from '../src/lib/host-adapter';
import { makeMockGl, publishVisibleTiles } from './mock-gl';
import { MockMap } from './mock-map';
import { makePointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** Minimal concrete subclass recording the last DrawContext handed to drawTile. */
class TestLayer extends STTBaseLayer {
  lastCtx?: DrawContext;

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }
  protected onContextReady(): void {}
  protected onContextLost(): void {}
  protected drawTile(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: unknown,
    _cache: unknown,
    ctx: DrawContext,
  ): void {
    this.lastCtx = ctx;
  }
}

/** Stub the archive surface initTileset consumes (same as base-lifecycle). */
function makeStubArchive() {
  return {
    getMetadata: vi.fn(async () => ({
      minZoom: 0,
      maxZoom: 5,
      temporalBucketMs: 3_600_000,
    })),
    getTileIdsInBounds: vi.fn(() => []),
    getTile: vi.fn(async () => null),
    getTiles: vi.fn(async (ids: unknown[]) => ids.map(() => null)),
    getTileByteSize: vi.fn(() => 4096),
    getThroughputEstimate: vi.fn(() => ({ bytesPerMs: 5, samples: 3 })),
    finalize: vi.fn(),
  };
}

function makeLayer(id = 'stt-mbx', extra: Partial<STTBaseLayerOptions> = {}) {
  const layer = new TestLayer({ ...baseOpts, id, ...extra }) as any;
  layer.archive = makeStubArchive();
  return layer;
}

/** The subset of a layer the mock registry captures, plus the mapbox `slot`. */
interface MockLayerWithSlot {
  id: string;
  slot?: string;
  onAdd?(map: unknown, gl: unknown): void;
  onRemove?(): void;
}

/**
 * A MockMap that reads as Mapbox GL JS: it exposes `getConfigProperty` (the
 * mapbox v3 Standard-style config accessor `isMapboxHost` keys on) and snapshots
 * `layer.slot` at addLayer time — proving mapbox would pick up the slot off the
 * layer object exactly when the layer is (re)added.
 */
class MockMapboxMap extends MockMap {
  slotAtAdd?: string;
  addCount = 0;
  // Mapbox v3 Standard-style import-config accessor — absent on every MapLibre.
  getConfigProperty(): unknown {
    return undefined;
  }
  override addLayer(layer: MockLayerWithSlot, beforeId?: string): this {
    this.slotAtAdd = layer.slot;
    this.addCount++;
    return super.addLayer(layer, beforeId);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isMapboxHost', () => {
  it('detects mapbox via the getConfigProperty accessor', () => {
    expect(isMapboxHost({ getConfigProperty: () => undefined })).toBe(true);
    expect(isMapboxHost(new MockMapboxMap(makeMockGl()))).toBe(true);
  });

  it('detects mapbox via the Standard-style import/slot graph on getStyle()', () => {
    expect(isMapboxHost({ getStyle: () => ({ imports: [] }) })).toBe(true);
    expect(isMapboxHost({ getStyle: () => ({ slots: ['middle'] }) })).toBe(
      true,
    );
  });

  it('treats MapLibre as NOT mapbox', () => {
    // MockMap has no getConfigProperty and no getStyle method at all.
    expect(isMapboxHost(new MockMap(makeMockGl()))).toBe(false);
    // A maplibre-shaped host whose getStyle returns a flat style (no import
    // graph, no slots) is still not mapbox.
    expect(
      isMapboxHost({ getStyle: () => ({ layers: [], sources: {} }) }),
    ).toBe(false);
  });

  it('is conservative: a throwing getStyle and non-objects are not mapbox', () => {
    expect(
      isMapboxHost({
        getStyle: () => {
          throw new Error('Style is not done loading');
        },
      }),
    ).toBe(false);
    expect(isMapboxHost(null)).toBe(false);
    expect(isMapboxHost(undefined)).toBe(false);
    expect(isMapboxHost(42)).toBe(false);
  });
});

describe('isValidMapboxSlot', () => {
  it('accepts the three Standard-style slots and rejects anything else', () => {
    for (const s of ['bottom', 'middle', 'top'] as const) {
      expect(isValidMapboxSlot(s)).toBe(true);
    }
    for (const bad of ['Top', 'front', '', 0, null, undefined, {}]) {
      expect(isValidMapboxSlot(bad)).toBe(false);
    }
  });
});

describe('attach({ slot }) on a mapbox host', () => {
  it('stamps the slot onto the layer object, read at addLayer time', () => {
    const map = new MockMapboxMap(makeMockGl());
    const layer = makeLayer();
    layer.attach(map as any, { slot: 'middle' as MapboxSlot });
    // Exposed on the layer instance (mapbox reads CustomLayerInterface.slot)...
    expect(layer.slot).toBe('middle');
    // ...and present on the object at the moment the map added it.
    expect(map.slotAtAdd).toBe('middle');
    layer.detach();
  });

  it('the slot survives a styledata rebuild re-add', () => {
    const map = new MockMapboxMap(makeMockGl());
    const layer = makeLayer();
    layer.attach(map as any, { slot: 'top' as MapboxSlot });
    expect(map.slotAtAdd).toBe('top');

    // A diff-fallback rebuild drops then re-adds the SAME layer object; its
    // slot field persists, so mapbox re-reads 'top' on the re-add.
    map.slotAtAdd = undefined;
    map.simulateStyleRebuild();
    expect(map.getLayer('stt-mbx')).toBeDefined();
    expect(map.slotAtAdd).toBe('top');
    expect(layer.slot).toBe('top');
    layer.detach();
  });

  it('slot and beforeId coexist (beforeId still orders within the slot)', () => {
    const map = new MockMapboxMap(makeMockGl());
    map.addLayer({ id: 'water' });
    map.addLayer({ id: 'labels' });
    const layer = makeLayer();
    layer.attach(map as any, {
      beforeId: 'labels',
      slot: 'bottom' as MapboxSlot,
    });
    expect(layer.slot).toBe('bottom');
    expect(map.getLayerOrder()).toEqual(['water', 'stt-mbx', 'labels']);
    layer.detach();
  });

  it('re-attaching without a slot clears the prior request (beforeId parity)', () => {
    const map = new MockMapboxMap(makeMockGl());
    const layer = makeLayer();
    layer.attach(map as any, { slot: 'middle' as MapboxSlot });
    expect(layer.slot).toBe('middle');
    layer.attach(map as any); // no slot — overwrites, like beforeId
    expect(layer.slot).toBeUndefined();
    layer.detach();
  });

  it('drops an out-of-union slot value even on mapbox, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = new MockMapboxMap(makeMockGl());
    const layer = makeLayer();
    // A JS caller past the TS type.
    layer.attach(map as any, { slot: 'FRONT' as unknown as MapboxSlot });
    expect(layer.slot).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    layer.detach();
  });
});

describe('attach({ slot }) on a maplibre host', () => {
  it('ignores the slot with a one-time dev warning; the layer still adds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = new MockMap(makeMockGl());
    const layer = makeLayer();
    layer.attach(map as any, { slot: 'middle' as MapboxSlot });

    // No slot field leaks onto the layer object on maplibre.
    expect(layer.slot).toBeUndefined();
    // The layer is still added — slot is advisory, not a gate.
    expect(map.getLayer('stt-mbx')).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('MapLibre');

    // A second slot request does NOT warn again (one-time guard).
    layer.attach(map as any, { slot: 'top' as MapboxSlot });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(layer.slot).toBeUndefined();
    layer.detach();
  });

  it('attach with no slot never warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = new MockMap(makeMockGl());
    const layer = makeLayer();
    layer.attach(map as any, { beforeId: undefined });
    expect(warn).not.toHaveBeenCalled();
    layer.detach();
  });
});

describe('mapbox v3 render signature → legacy (mercator) dispatch', () => {
  async function renderableLayer() {
    const gl = makeMockGl();
    const map = new MockMapboxMap(gl);
    const layer = makeLayer();
    map.addLayer(layer);
    await tick(); // let initTileset resolve
    publishVisibleTiles(layer, makePointTile());
    return { gl, map, layer };
  }

  // The 4×4 mercator MVP mapbox passes as arg2 (a plain identity here).
  const mercatorMvp = () =>
    // prettier-ignore
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it('routes the full 7-arg mapbox call through the legacy path and draws', async () => {
    const { gl, layer } = await renderableLayer();
    const matrix = mercatorMvp();
    // render(gl, matrix, projection, projectionToMercatorMatrix,
    //        projectionToMercatorTransition, centerInMercator,
    //        pixelsPerMeterRatio) — mapbox v3's positional custom-layer args.
    const projToMerc = Array.from({ length: 16 }, (_, i) => i);
    layer.render(
      gl,
      matrix,
      { name: 'mercator' }, // ProjectionSpecification — NOT camera options
      projToMerc,
      0, // transition
      [0.3, 0.4], // centerInMercator
      1.2, // pixelsPerMeterRatio
    );

    const ctx = layer.lastCtx!;
    // drawTile ran for the point tile ⇒ the layer drew.
    expect(ctx).toBeDefined();
    // Legacy (mercator) frame; the arg2 matrix is the MVP the shader uses.
    expect(ctx.frame?.mode).toBe('legacy');
    expect(ctx.frame?.isGlobe).toBe(false);
    expect(Array.from(ctx.matrix)).toEqual(matrix);
    expect(layer.lastMatrix).toBe(ctx.matrix);

    // The projection-spec arg3 is NOT read as camera options, and the extra
    // positional globe params never reach the adapter ⇒ no camera params, so
    // pick math falls back to maplibre's default fov.
    expect(layer.lastFov).toBeUndefined();
    expect(layer.lastNearZ).toBeUndefined();
    expect(layer.lastFarZ).toBeUndefined();
    expect(layer.getCameraParams().fovRadians).toBeCloseTo(
      DEFAULT_FOV_RADIANS,
      6,
    );
  });

  it('mapbox globe is deferred: a nonzero transition param stays mercator', async () => {
    const { gl, layer } = await renderableLayer();
    // Even mid globe→mercator transition (transition = 0.6), the adapter never
    // sees that param — it rides the legacy mercator matrix path (D5).
    layer.render(
      gl,
      mercatorMvp(),
      { name: 'globe' },
      Array.from({ length: 16 }, () => 0),
      0.6, // projectionToMercatorTransition — ignored
      [0.5, 0.5],
      2,
    );
    expect(layer.lastCtx!.frame?.mode).toBe('legacy');
    expect(layer.lastCtx!.frame?.isGlobe).toBe(false);
  });
});
