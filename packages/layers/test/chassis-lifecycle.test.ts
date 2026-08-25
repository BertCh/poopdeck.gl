/**
 * `SpatioTemporalLayer` lifecycle contract — the chassis half of the layer, as
 * opposed to the per-tile sublayer chassis in `chassis-driver.test.ts`.
 *
 * Covers the review findings that all live in `spatiotemporal-layer.ts`:
 *  1. a `data`-only archive swap must re-init (deck's `diffProps` ignores
 *     `data` when computing `propsChanged`, so it arrives ONLY as
 *     `changeFlags.dataChanged`);
 *  2. lifecycle state lives in `this.state`, so the unmount-during-init guard
 *     survives deck's `_transferState` onto a fresh layer instance;
 *  3. a failing `archive.getMetadata()` routes to `onTileError` / `console.error`
 *     and releases `state.initializingUrl` instead of pinning it forever;
 *  4. the mutable tileset options are re-pushed via `tileset.setOptions()` on
 *     every `propsChanged` (upstream `TileLayer`'s contract), with
 *     `loadOptions` routed to the ARCHIVE instead — it builds the fetch
 *     transport and has no tileset counterpart;
 *  5. `state.frameNumber` has ONE authority — the layer — so it cannot drift
 *     from the tileset's own counter and force an extra `renderLayers()`;
 *  6. `skipDebounce` is reachable for a play-head driven by the `currentTime`
 *     prop;
 *  7. `isLoaded` reports selection settle, not "some tiles exist".
 *
 * `STTArchive` / `SpatioTemporalTileset` are mocked so the real
 * `_initArchiveAndTileset` runs without touching the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetWarnOnce } from '../src/lib/log';
import * as actualCore from '@poopdeck.gl/core';

// ---------------------------------------------------------------------------
// @poopdeck.gl/core mock — records every constructed archive/tileset, and lets
// a test control when `getMetadata()` settles (the unmount-during-init race).
// ---------------------------------------------------------------------------

interface Captured {
  archives: any[];
  tilesets: any[];
  /**
   * When set, `getMetadata()` calls this instead of resolving immediately. A
   * FACTORY, not a promise: a rejected promise built eagerly in the test body
   * would trip Node's unhandled-rejection detector before the layer (behind an
   * `await import`) ever attaches its handler.
   */
  metadataGate?: (archive: any) => Promise<any>;
}
const captured: Captured = { archives: [], tilesets: [] };

const METADATA = {
  minZoom: 0,
  maxZoom: 5,
  temporalBucketMs: 3_600_000,
};

vi.mock('@poopdeck.gl/core', async () => {
  const actual = await vi.importActual<any>('@poopdeck.gl/core');

  class MockSTTArchive {
    url: string;
    finalize = vi.fn();
    getCacheStats = vi.fn(() => ({}));
    getTiles = vi.fn(async () => []);
    getTile = vi.fn(async () => null);
    getTileIdsInBounds = vi.fn(async () => []);
    getSummaryTileIdsInBounds = vi.fn(async () => []);
    getTileByteSize = vi.fn(() => 4096);
    getThroughputEstimate = vi.fn(() => ({ bytesPerMs: 5, samples: 3 }));
    setSchedulerWeight = vi.fn();
    setMaxConcurrentRequests = vi.fn();
    setLoadOptions = vi.fn();
    getMetadata = vi.fn(() =>
      captured.metadataGate
        ? captured.metadataGate(this)
        : Promise.resolve(METADATA),
    );
    planRangeBytes = vi.fn(() => 0);
    /** Every construction option, for the wiring tests (tile-loading audit 2026-08). */
    opts: any;
    constructor(opts: { url: string }) {
      this.url = opts.url;
      this.opts = opts;
      captured.archives.push(this);
    }
  }

  class MockSpatioTemporalTileset {
    options: any;
    isLoaded = true;
    selectionVersion = 0;
    finalize = vi.fn();
    setAnimationState = vi.fn();
    getVisibleTiles = vi.fn(() => []);
    getCacheStats = vi.fn(() => ({}));
    preloadOverviewTier = vi.fn(() => new Promise(() => {})); // never settles
    update = vi.fn(() => 0);
    setOptions = vi.fn();
    constructor(options: any) {
      this.options = options;
      captured.tilesets.push(this);
    }
  }

  return {
    ...actual,
    STTArchive: MockSTTArchive,
    SpatioTemporalTileset: MockSpatioTemporalTileset,
  };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const VIEWPORT = {
  id: 'v',
  width: 800,
  height: 600,
  zoom: 4,
  longitude: 0,
  latitude: 0,
  pitch: 0,
  bearing: 0,
  unproject: ([px, py]: [number, number]) => [px / 100 - 4, 40 - py / 100],
};

/**
 * A bare layer over the REAL prototype. `state` is a plain object exactly as
 * deck's `_initialize` leaves it, so the state-backed lifecycle accessors are
 * exercised (not the detached fallback).
 */
async function makeLayer(props: Record<string, unknown> = {}) {
  const { SpatioTemporalLayer } =
    await import('../src/layers/spatiotemporal-layer');
  const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
  layer.props = {
    id: 'stl',
    data: 'mem://a.stt',
    currentTime: 0,
    timeWindow: 1000,
    maxRequests: 8,
    tier: 'auto',
    refinementStrategy: 'best-available',
    lodMode: 'parent-fallback',
    maxCacheSize: 2000,
    maxCacheByteSize: 1024,
    debounceTime: 0,
    enablePrefetch: true,
    prefetchAhead: 30_000,
    prefetchSteps: 4,
    scrubLod: null,
    loadOptions: {},
    ...props,
  };
  layer.state = {};
  layer.setState = (patch: Record<string, unknown>) =>
    Object.assign(layer.state, patch);
  layer.setNeedsRedraw = vi.fn();
  // `resourceManager` is what deck's own `Layer.finalizeState` unsubscribes
  // from; `internalState` stays undefined so the rest of it no-ops.
  layer.context = {
    viewport: VIEWPORT,
    resourceManager: { unsubscribe: vi.fn() },
  };
  return layer;
}

beforeEach(() => {
  captured.archives = [];
  captured.tilesets = [];
  captured.metadataGate = undefined;
  _resetWarnOnce();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1 — `data`-only swap
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer archive swap', () => {
  it('re-inits when ONLY `data` changed (changeFlags.dataChanged, propsChanged false)', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    expect(layer.state.archive.url).toBe('mem://a.stt');

    const init = vi.spyOn(layer as any, '_initArchiveAndTileset');
    // deck's `diffProps` runs `compareProps` with `ignoreProps: {data: null}`,
    // so a data-only swap NEVER sets propsChanged — this is the exact shape
    // deck hands `updateState`.
    layer.props = { ...layer.props, data: 'mem://b.stt' };
    layer.updateState({
      changeFlags: {
        propsChanged: false,
        dataChanged: 'props.data changed shallowly',
        propsOrDataChanged: true,
        viewportChanged: false,
        somethingChanged: true,
      },
    });

    expect(init).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-init when the URL is unchanged', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const init = vi.spyOn(layer as any, '_initArchiveAndTileset');

    layer.updateState({
      changeFlags: {
        propsChanged: 'props.timeWindow changed',
        dataChanged: false,
        propsOrDataChanged: true,
        viewportChanged: false,
        somethingChanged: true,
      },
    });

    expect(init).not.toHaveBeenCalled();
  });

  it('uses a monotonic generation so stale A→B→A metadata cannot commit', async () => {
    const releases: Array<(metadata: unknown) => void> = [];
    captured.metadataGate = () =>
      new Promise((resolve) => {
        releases.push(resolve);
      });

    const layer = await makeLayer();
    const firstA = layer._initArchiveAndTileset();
    const archiveA1 = captured.archives[0];

    layer.props = { ...layer.props, data: 'mem://b.stt' };
    const b = layer._initArchiveAndTileset();
    const archiveB = captured.archives[1];

    layer.props = { ...layer.props, data: 'mem://a.stt' };
    const secondA = layer._initArchiveAndTileset();
    const archiveA2 = captured.archives[2];

    // Superseded pending archives are cancelled immediately, not left alive
    // until their metadata requests happen to settle.
    expect(archiveA1.finalize).toHaveBeenCalled();
    expect(archiveB.finalize).toHaveBeenCalled();
    expect(layer.state.initializingArchive).toBe(archiveA2);
    expect(layer.state.archive).toBeNull();
    expect(layer.state.tileset).toBeNull();

    // Resolve in the most adversarial order. URL equality must not let the
    // first A attach after the newer A has become authoritative.
    releases[0](METADATA);
    releases[1](METADATA);
    await Promise.all([firstA, b]);
    expect(captured.tilesets).toHaveLength(0);

    releases[2](METADATA);
    await secondA;
    expect(captured.tilesets).toHaveLength(1);
    expect(layer.state.archive).toBe(archiveA2);
    expect(layer.state.initializingArchive).toBeNull();
  });

  it('detaches a live source immediately while its replacement loads', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const oldArchive = layer.state.archive;
    const oldTileset = layer.state.tileset;

    let release!: (metadata: unknown) => void;
    captured.metadataGate = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    layer.props = { ...layer.props, data: 'mem://b.stt' };
    const pending = layer._initArchiveAndTileset();

    expect(oldArchive.finalize).toHaveBeenCalled();
    expect(oldTileset.finalize).toHaveBeenCalled();
    expect(layer.state.archive).toBeNull();
    expect(layer.state.tileset).toBeNull();
    expect(layer.state.metadata).toBeNull();
    expect(layer.state.tiles).toEqual([]);

    release(METADATA);
    await pending;
  });

  it('pushes changed transport options into an archive still loading metadata', async () => {
    let release!: (metadata: unknown) => void;
    captured.metadataGate = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const layer = await makeLayer();
    const pending = layer._initArchiveAndTileset();
    const archive = captured.archives[0];

    const loadOptions = { fetch: vi.fn() };
    layer.props = {
      ...layer.props,
      loadOptions,
      maxRequests: 3,
    };
    layer.updateState({
      changeFlags: {
        propsChanged: 'props.loadOptions,maxRequests changed',
        dataChanged: false,
        propsOrDataChanged: true,
        viewportChanged: false,
        somethingChanged: true,
      },
    });

    expect(archive.setLoadOptions).toHaveBeenCalledWith(loadOptions);
    expect(archive.setMaxConcurrentRequests).toHaveBeenCalledWith(3);

    release(METADATA);
    await pending;
    expect(layer.state.tileset.options.maxRequests).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2 — lifecycle state survives `_transferState`
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer lifecycle state', () => {
  it('keeps every guard in `state`, not in class fields', async () => {
    const layer = await makeLayer();
    layer._finalized = true;
    layer._viewportLoadVersion = 7;
    layer._currentTime = 1234;

    expect(layer.state.finalized).toBe(true);
    expect(layer.state.viewportLoadVersion).toBe(7);
    expect(layer.state.currentTime).toBe(1234);
    // No own data property shadows the prototype accessors.
    expect(Object.hasOwn(layer, '_finalized')).toBe(false);
    expect(Object.hasOwn(layer, '_currentTime')).toBe(false);
  });

  it('bails an in-flight init when the NEW instance (post-_transferState) is finalized', async () => {
    let releaseMetadata!: (m: unknown) => void;
    const gate = new Promise((resolve) => {
      releaseMetadata = resolve;
    });
    captured.metadataGate = () => gate;

    const first = await makeLayer();
    const pending = first._initArchiveAndTileset();
    expect(first.state.initializingUrl).toBe('mem://a.stt');

    // React re-renders: deck constructs a NEW layer and `_transferState` moves
    // ONLY `state`/`internalState` across. Class-field initializers would have
    // re-run on this instance; the awaiting continuation still holds `first`.
    const second = await makeLayer();
    second.state = first.state;

    // deck finalizes the NEWEST instance.
    second._finalized = true;

    releaseMetadata(METADATA);
    await pending;

    // The continuation on the OLD instance must have seen the shared flag.
    expect(captured.tilesets).toHaveLength(0);
    expect(captured.archives).toHaveLength(1);
    expect(captured.archives[0].finalize).toHaveBeenCalledTimes(1);
    expect(first.state.tileset).toBeNull();
  });

  it('finalizeState nulls the tileset/archive handles so deferred bail-outs see a dead slot', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    const archive = layer.state.archive;

    layer.state.resolvedTimeController = null;
    layer.finalizeState(layer.context);

    expect(tileset.finalize).toHaveBeenCalled();
    expect(archive.finalize).toHaveBeenCalled();
    expect(layer.state.tileset).toBeNull();
    expect(layer.state.archive).toBeNull();
    expect(layer.state.initializingUrl).toBeNull();
    expect(layer.state.finalized).toBe(true);
  });

  it('a tile-load rAF scheduled for a torn-down tileset bails instead of touching dead state', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;

    const callbacks: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    layer._scheduleTileLoadUpdate(tileset);
    layer.state.tileset = null; // source switch / unmount between rAF + callback
    callbacks[0]();

    expect(tileset.getVisibleTiles).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// 3 — init error path
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer init failure', () => {
  it('routes a rejected getMetadata() to onTileError with tileId undefined and frees the slot', async () => {
    const boom = new Error('404 Not Found');
    captured.metadataGate = () => Promise.reject(boom);
    const onTileError = vi.fn();
    const layer = await makeLayer({ onTileError });

    await expect(layer._initArchiveAndTileset()).resolves.toBeUndefined();

    expect(onTileError).toHaveBeenCalledTimes(1);
    expect(onTileError).toHaveBeenCalledWith(boom, undefined);
    // The slot is released, so `updateState` no longer treats the dead URL as
    // live and a later prop change can retry.
    expect(layer.state.initializingUrl).toBeNull();
    expect(layer.state.tileset).toBeNull();
    expect(captured.archives[0].finalize).toHaveBeenCalledTimes(1);
  });

  it('falls back to console.error when no onTileError is supplied (TileLayer default)', async () => {
    captured.metadataGate = () => Promise.reject(new Error('CORS'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const layer = await makeLayer({ onTileError: null });

    await layer._initArchiveAndTileset();

    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain('Archive init failed');
  });

  it('retries the failed URL on the next prop change', async () => {
    captured.metadataGate = () => Promise.reject(new Error('nope'));
    const layer = await makeLayer({ onTileError: vi.fn() });
    await layer._initArchiveAndTileset();

    const init = vi
      .spyOn(layer as any, '_initArchiveAndTileset')
      .mockResolvedValue(undefined);
    layer.updateState({
      changeFlags: {
        propsChanged: 'props.timeWindow changed',
        dataChanged: false,
        propsOrDataChanged: true,
        viewportChanged: false,
        somethingChanged: true,
      },
    });
    expect(init).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4 — construction-only props
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer mutable tileset options', () => {
  /** Drive one `propsChanged` pass. */
  function pushProps(layer: any, patch: Record<string, unknown>) {
    layer.props = { ...layer.props, ...patch };
    layer.updateState({
      changeFlags: {
        propsChanged: `props.${Object.keys(patch).join(',')} changed`,
        dataChanged: false,
        propsOrDataChanged: true,
        viewportChanged: false,
        somethingChanged: true,
      },
    });
  }

  it('re-pushes `tier` to the live tileset instead of warning it away', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const tileset = captured.tilesets.at(-1)!;

    pushProps(layer, { tier: 'summary' });

    // Core's setOptions re-derives (reselect + coverage-index drop); the
    // chassis' job is only to hand it the current value.
    expect(tileset.setOptions).toHaveBeenCalledTimes(1);
    expect(tileset.setOptions.mock.calls[0][0]).toMatchObject({
      tier: 'summary',
    });
    // The old CONSTRUCTION-ONLY warning must be gone — the change is applied.
    expect(warn).not.toHaveBeenCalled();
  });

  it('pushes the whole mutable option set, not just the changed key', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const tileset = captured.tilesets.at(-1)!;

    pushProps(layer, { maxCacheSize: 42 });

    // `setOptions` takes a Partial and treats an ABSENT key as "leave alone",
    // so the chassis must send every mutable knob or an unrelated change would
    // silently reset the others to their defaults.
    expect(tileset.setOptions.mock.calls[0][0]).toMatchObject({
      tier: expect.anything(),
      refinementStrategy: expect.anything(),
      lodMode: expect.anything(),
      maxCacheSize: 42,
      maxCacheByteSize: expect.anything(),
      maxRequests: expect.anything(),
      debounceTime: expect.anything(),
      enablePrefetch: expect.anything(),
      prefetchAhead: expect.anything(),
      prefetchSteps: expect.anything(),
    });
  });

  it('routes `loadOptions` to the ARCHIVE — it is not a tileset option', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const archive = captured.archives.at(-1)!;
    const tileset = captured.tilesets.at(-1)!;

    const loadOptions = { fetch: vi.fn() };
    pushProps(layer, { loadOptions });

    // It builds the archive's fetch transport, so it cannot ride setOptions.
    expect(archive.setLoadOptions).toHaveBeenCalledWith(loadOptions);
    expect(tileset.setOptions.mock.calls[0][0]).not.toHaveProperty(
      'loadOptions',
    );
  });

  it('does not push against a tileset that does not exist yet', async () => {
    const layer = await makeLayer();
    // No `_initArchiveAndTileset()` — init still pending.
    expect(() => pushProps(layer, { tier: 'summary' })).not.toThrow();
    expect(captured.tilesets).toHaveLength(0);
  });

  it('does not warn before a tileset exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = await makeLayer();
    layer.props = { ...layer.props, refinementStrategy: 'no-overlap' };
    layer.updateState({
      changeFlags: {
        propsChanged: 'props.refinementStrategy changed',
        dataChanged: false,
        propsOrDataChanged: true,
        viewportChanged: false,
        somethingChanged: true,
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('re-applies the subclass overrides, which construction spreads LAST', async () => {
    const layer = await makeLayer();
    // The H3/Quadbin summary shape: a subclass that swaps the tier, its zoom
    // band and the refinement strategy at construction. `setOptions` treats
    // every key PRESENT in the bag as an instruction, so pushing the base bag
    // alone reverted the subclass on the first propsChanged pass — any prop,
    // including one the bag does not carry.
    layer.getTilesetOptionOverrides = () => ({
      tier: 'summary',
      minZoom: 1,
      maxZoom: 4,
      refinementStrategy: 'no-overlap',
    });
    await layer._initArchiveAndTileset();
    const tileset = captured.tilesets.at(-1)!;
    expect(tileset.options.refinementStrategy).toBe('no-overlap');

    pushProps(layer, { maxCacheSize: 42 });

    const pushed = tileset.setOptions.mock.calls[0][0];
    expect(pushed).toMatchObject({
      tier: 'summary',
      minZoom: 1,
      maxZoom: 4,
      refinementStrategy: 'no-overlap',
      // ... without dropping the knobs the overrides do not claim.
      maxCacheSize: 42,
    });
  });

  it('pushes the base bag unchanged when the subclass overrides nothing', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const tileset = captured.tilesets.at(-1)!;

    pushProps(layer, { maxCacheSize: 42 });

    // The base hook returns `{}`, so re-applying it must be a no-op rather
    // than, say, re-introducing a stale zoom range.
    expect(tileset.setOptions.mock.calls[0][0]).not.toHaveProperty('minZoom');
    expect(tileset.setOptions.mock.calls[0][0].refinementStrategy).toBe(
      'best-available',
    );
  });
});

// ---------------------------------------------------------------------------
// 5 — one frameNumber authority
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer frameNumber authority', () => {
  it('does not re-render when the tileset counter is unchanged', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    tileset.update.mockReturnValue(3);

    const flags = {
      propsChanged: 'x',
      dataChanged: false,
      viewportChanged: false,
    };
    layer._updateTileset({ ...flags });
    const afterFirst = layer.state.frameNumber;
    expect(layer.state.tilesetFrameNumber).toBe(3);

    // Same tileset counter, same (empty) tile set → nothing changed.
    layer._updateTileset({ ...flags });
    expect(layer.state.frameNumber).toBe(afterFirst);
  });

  it('the tick path advances the SAME counter and mirrors the tileset value', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    tileset.update.mockReturnValue(9);

    layer._updateTileset({ propsChanged: 'x', dataChanged: false });
    const base = layer.state.frameNumber as number;
    expect(layer.state.tilesetFrameNumber).toBe(9);

    // A tick that changes the visible set bumps the LAYER counter by one and
    // records the tileset's value — the two never drift.
    tileset.update.mockReturnValue(10);
    tileset.getVisibleTiles.mockReturnValue([
      { id: { z: 1, x: 0, y: 0, t: 0 } },
    ]);
    layer._handleTimeUpdate(500_000);

    expect(layer.state.frameNumber).toBe(base + 1);
    expect(layer.state.tilesetFrameNumber).toBe(10);

    // The very next `_updateTileset` must NOT see a spurious frameChanged.
    tileset.update.mockReturnValue(10);
    layer._updateTileset({ propsChanged: 'x', dataChanged: false });
    expect(layer.state.frameNumber).toBe(base + 1);
  });
});

// ---------------------------------------------------------------------------
// 6 — skipDebounce
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer debounce bypass', () => {
  it('skips the debounce for a prop-driven play-head move (no viewport change)', async () => {
    const layer = await makeLayer({ debounceTime: 50 });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;

    layer.props = { ...layer.props, currentTime: 5_000 };
    layer._updateTileset({
      propsChanged: 'props.currentTime changed',
      propsOrDataChanged: true,
      dataChanged: false,
      viewportChanged: false,
    });

    expect(tileset.update).toHaveBeenCalledTimes(1);
    expect(tileset.update.mock.calls[0][1]).toBe(true); // skipDebounce
  });

  it('keeps the debounce when the viewport moved in the same pass', async () => {
    const layer = await makeLayer({ debounceTime: 50 });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;

    layer.props = { ...layer.props, currentTime: 5_000 };
    layer._updateTileset({
      propsChanged: 'props.currentTime changed',
      propsOrDataChanged: true,
      dataChanged: false,
      viewportChanged: true,
    });

    expect(tileset.update.mock.calls[0][1]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7 — isLoaded
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer isLoaded', () => {
  it('is false before the tileset exists', async () => {
    const layer = await makeLayer();
    expect(layer.isLoaded).toBe(false);
  });

  it('reports a SETTLED selection even when it is legitimately empty', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    // deck's own async-prop/sublayer readiness, which `super.isLoaded` reads.
    layer.internalState = {
      isAsyncPropLoading: () => false,
      subLayers: [],
    };

    layer.state.tileset.isLoaded = true;
    layer.state.tiles = []; // panned over empty ocean
    expect(layer.isLoaded).toBe(true);

    layer.state.tileset.isLoaded = false;
    expect(layer.isLoaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tile-loading audit 2026-08 — C4 (deferred overview kick), E7 (commit budget)
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer overview preload timing (C4)', () => {
  const flags = {
    propsChanged: 'x',
    dataChanged: false,
    viewportChanged: false,
  };

  it('C4: is not kicked at attach; kicked exactly once after the first viewport load settles', async () => {
    const layer = await makeLayer({ overviewPreload: true });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    expect(tileset.preloadOverviewTier).not.toHaveBeenCalled();

    // A selection exists but has not settled → still nothing.
    tileset.selectionVersion = 1;
    tileset.isLoaded = false;
    layer._updateTileset({ ...flags });
    expect(tileset.preloadOverviewTier).not.toHaveBeenCalled();

    // The first viewport load settles → one kick, with the opts contract.
    tileset.isLoaded = true;
    layer._updateTileset({ ...flags });
    expect(tileset.preloadOverviewTier).toHaveBeenCalledTimes(1);
    expect(tileset.preloadOverviewTier).toHaveBeenCalledWith(undefined);

    // Later settles never re-kick.
    tileset.selectionVersion = 2;
    layer._updateTileset({ ...flags });
    expect(tileset.preloadOverviewTier).toHaveBeenCalledTimes(1);
  });

  it('C4: keeps the onOverviewPreload result contract and the object-form opts', async () => {
    const onOverviewPreload = vi.fn();
    const result = { loaded: true, tileCount: 12, bytes: 4096 };
    const layer = await makeLayer({
      overviewPreload: { budgetBytes: 1024, maxZoom: 2 },
      onOverviewPreload,
    });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    tileset.preloadOverviewTier.mockReturnValue(Promise.resolve(result));
    tileset.selectionVersion = 1;
    tileset.isLoaded = true;
    layer._updateTileset({ ...flags });
    expect(tileset.preloadOverviewTier).toHaveBeenCalledWith({
      budgetBytes: 1024,
      maxZoom: 2,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onOverviewPreload).toHaveBeenCalledWith(result);
    expect(layer.state.overviewPreloadResult).toBe(result);
  });

  it('C4: overviewPreload off never kicks, even after settle', async () => {
    const layer = await makeLayer({ overviewPreload: false });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    tileset.selectionVersion = 1;
    tileset.isLoaded = true;
    layer._updateTileset({ ...flags });
    expect(tileset.preloadOverviewTier).not.toHaveBeenCalled();
  });
});

describe('SpatioTemporalLayer per-frame commit budget (E7)', () => {
  const { tileKey } = actualCore;

  function fakeTiles(n: number, z = 5) {
    return Array.from({ length: n }, (_, i) => ({
      id: { z, x: i, y: 0, t: 0 },
      timeRange: { start: 0, end: 1000 },
      layers: [],
    }));
  }
  /** ~1 ms of CPU, as a `prepareTile` would cost. */
  function busy(ms: number) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      /* spin */
    }
  }
  function stubRaf() {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    return callbacks;
  }
  const keys = (tiles: any[]) => tiles.map((t) => tileKey(t.id));

  it('E7: 50 arrivals at 1 ms each commit ~6 per rAF, all within 10 frames, never un-committing', async () => {
    const layer = await makeLayer({ tileCommitBudgetMs: 6 });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    tileset.getVisibleTiles.mockReturnValue(fakeTiles(50));
    // Deterministic clock: each warm costs exactly 1 ms of the budget's own
    // clock. A real 1 ms busy-wait measured by the real `performance.now`
    // drifted under CI-scale load (a loaded box stretched each spin past
    // 1 ms and the first frame committed fewer than 5) — the budget's
    // arithmetic is what this pins, not the machine's scheduler.
    let fakeNow = 0;
    const realPerformance = globalThis.performance;
    vi.stubGlobal('performance', {
      ...realPerformance,
      now: () => fakeNow,
    });
    layer.warmTile = vi.fn(() => {
      fakeNow += 1;
    });
    const callbacks = stubRaf();

    layer._scheduleTileLoadUpdate(tileset);
    let frames = 0;
    const seen = new Set<string>();
    while (callbacks.length > 0 && frames < 20) {
      frames++;
      callbacks.shift()!();
      const committed = keys(layer.state.tiles);
      for (const k of seen) expect(committed).toContain(k);
      for (const k of committed) seen.add(k);
      if (frames === 1) {
        expect(committed.length).toBeGreaterThanOrEqual(5);
        expect(committed.length).toBeLessThanOrEqual(7);
      }
    }
    expect(layer.state.tiles).toHaveLength(50);
    expect(frames).toBeLessThanOrEqual(10);
    expect(layer.warmTile).toHaveBeenCalledTimes(50);
    expect(callbacks).toHaveLength(0); // nothing left armed
    vi.unstubAllGlobals();
  });

  it('E7: tileCommitBudgetMs 0 commits the whole batch in one frame', async () => {
    const layer = await makeLayer({ tileCommitBudgetMs: 0 });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    tileset.getVisibleTiles.mockReturnValue(fakeTiles(50));
    layer.warmTile = vi.fn(() => busy(1));
    const callbacks = stubRaf();
    layer._scheduleTileLoadUpdate(tileset);
    callbacks.shift()!();
    expect(layer.state.tiles).toHaveLength(50);
    expect(callbacks).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('E7: a parent the selection dropped keeps standing in until its children have all landed', async () => {
    const layer = await makeLayer({ tileCommitBudgetMs: 6 });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    const parent = fakeTiles(1, 4)[0];
    // The parent is committed (it was drawn while the children loaded).
    tileset.getVisibleTiles.mockReturnValue([parent]);
    layer._updateTileset({ propsChanged: 'x', dataChanged: false });
    expect(keys(layer.state.tiles)).toEqual([tileKey(parent.id)]);

    // The tileset now hands back only the 50 loaded children.
    const children = fakeTiles(50);
    tileset.getVisibleTiles.mockReturnValue(children);
    layer.warmTile = vi.fn(() => busy(1));
    const callbacks = stubRaf();
    layer._scheduleTileLoadUpdate(tileset);

    callbacks.shift()!();
    const first = keys(layer.state.tiles);
    expect(first).toContain(tileKey(parent.id)); // still covering
    expect(first.length).toBeLessThan(51);

    let frames = 1;
    while (callbacks.length > 0 && frames < 20) {
      frames++;
      callbacks.shift()!();
    }
    const final = keys(layer.state.tiles);
    expect(final).not.toContain(tileKey(parent.id));
    expect(final).toHaveLength(50);
    vi.unstubAllGlobals();
  });

  it('E7: the carried remainder is committed nearest-to-playhead first', async () => {
    const layer = await makeLayer({ tileCommitBudgetMs: 2 });
    await layer._initArchiveAndTileset();
    const tileset = layer.state.tileset;
    layer.state.currentTime = 5_000;
    const far = {
      id: { z: 5, x: 0, y: 0, t: 0 },
      timeRange: { start: 20_000, end: 21_000 },
      layers: [],
    };
    const near = {
      id: { z: 5, x: 1, y: 0, t: 0 },
      timeRange: { start: 4_000, end: 6_000 },
      layers: [],
    };
    const mid = {
      id: { z: 5, x: 2, y: 0, t: 0 },
      timeRange: { start: 8_000, end: 9_000 },
      layers: [],
    };
    tileset.getVisibleTiles.mockReturnValue([far, mid, near]);
    const warmed: string[] = [];
    layer.warmTile = (t: any) => {
      warmed.push(tileKey(t.id));
      busy(2);
    };
    const callbacks = stubRaf();
    layer._scheduleTileLoadUpdate(tileset);
    while (callbacks.length > 0) callbacks.shift()!();
    expect(warmed).toEqual([
      tileKey(near.id),
      tileKey(mid.id),
      tileKey(far.id),
    ]);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Archive <-> tileset wiring (tile-loading audit 2026-08): the option-level
// hand-offs the chassis owes its neighbours — `sparsePrimary` from the
// archive's partition, `estimateFetchBytes` + the batch `onTileError` hook
// through the core adapter, and `schedulerWeight` into the archive.
// ---------------------------------------------------------------------------

describe('SpatioTemporalLayer archive/tileset wiring (tile-loading audit 2026-08)', () => {
  it('sparsePrimary: a home-zoom archive builds the tileset with sparsePrimary: true', async () => {
    captured.metadataGate = () =>
      Promise.resolve({ ...METADATA, partition: 'home-zoom' });
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    expect(layer.state.tileset.options.sparsePrimary).toBe(true);
  });

  it('sparsePrimary: a replicated (default) archive builds the tileset with sparsePrimary: false', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    expect(layer.state.tileset.options.sparsePrimary).toBe(false);
  });

  it('C4: the tileset receives estimateFetchBytes, routed to archive.planRangeBytes', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const archive = captured.archives[0];
    const tileset = layer.state.tileset;
    expect(typeof tileset.options.estimateFetchBytes).toBe('function');
    archive.planRangeBytes.mockReturnValue(4242);
    const ids = [{ z: 3, x: 1, y: 2, t: 0 }];
    expect(tileset.options.estimateFetchBytes(ids)).toBe(4242);
    expect(archive.planRangeBytes).toHaveBeenCalledWith(ids);
  });

  it('B8: a batch member failure the archive reports reaches the tileset batch hook unchanged', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    const archive = captured.archives[0];
    const tileset = layer.state.tileset;
    const failure = new Error('x');
    archive.getTiles.mockImplementation(async (ids: unknown[], opts: any) => {
      opts.onTileError?.(0, failure);
      return ids.map(() => null);
    });
    const onTileError = vi.fn();
    const onTileReady = vi.fn();
    const ids = [{ z: 3, x: 1, y: 2, t: 0 }];
    const signal = new AbortController().signal;
    await tileset.options.getTileDataBatch(ids, signal, {
      onTileError,
      onTileReady,
      fetchPriority: 'low',
    });
    expect(onTileError).toHaveBeenCalledWith(0, failure);
    // The archive saw the SAME hook objects — no re-wrapping in between.
    const [, forwarded] = archive.getTiles.mock.calls[0];
    expect(forwarded.onTileError).toBe(onTileError);
    expect(forwarded.onTileReady).toBe(onTileReady);
    expect(forwarded.signal).toBe(signal);
    expect(forwarded.fetchPriority).toBe('low');
  });

  it('schedulerWeight: the prop reaches the STTArchive constructor', async () => {
    const layer = await makeLayer({ schedulerWeight: 3 });
    await layer._initArchiveAndTileset();
    expect(captured.archives[0].opts.schedulerWeight).toBe(3);
  });

  it('schedulerWeight: absent, nothing is forced on the archive (its own default stands)', async () => {
    const layer = await makeLayer();
    await layer._initArchiveAndTileset();
    expect(captured.archives[0].opts.schedulerWeight).toBeUndefined();
  });
});
