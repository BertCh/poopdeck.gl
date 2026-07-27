/**
 * Tileset wiring tests — verifies `initTileset` configures the
 * SpatioTemporalTileset with the full @poopdeck.gl/core capability set (parity with
 * the deck.gl adapter's `_initArchiveAndTileset`):
 *
 *   - getTileDataBatch → archive.getTiles with per-range-group onTileReady
 *     incremental delivery + the fetchPriority hint
 *   - getTileByteSize (skip-giant-parent gating)
 *   - refinementStrategy 'best-available'
 *   - onBufferChange / getThroughput forwarding (PlaybackGovernor contract)
 *   - onTilesetReady fires once with the live tileset; getTileset() agrees
 *
 * The archive is stubbed (initTileset only touches its public surface), and
 * the tileset's `options` are read through an `as any` cast — same pattern as
 * the rest of this suite's protected-hook access.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatioTemporalTileset, type TileId } from '@poopdeck.gl/core';
import { STTPointLayer } from '../src/layers/point-layer';
import { makeMockMap } from './mock-gl';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** Stub the archive surface initTileset consumes. */
function makeStubArchive() {
  return {
    getMetadata: vi.fn(async () => ({
      minZoom: 0,
      maxZoom: 5,
      temporalBucketMs: 3_600_000,
    })),
    getTileIdsInBounds: vi.fn(() => []),
    getTile: vi.fn(async () => null),
    getTiles: vi.fn(async (ids: TileId[]) => ids.map(() => null)),
    getTileByteSize: vi.fn(() => 4096),
    getThroughputEstimate: vi.fn(() => ({ bytesPerMs: 5, samples: 3 })),
    finalize: vi.fn(),
  };
}

async function initLayer(extraOpts: Record<string, unknown> = {}) {
  const layer = new STTPointLayer({
    ...baseOpts,
    id: 'p',
    ...extraOpts,
  }) as any;
  const archive = makeStubArchive();
  layer.archive = archive;
  layer.map = makeMockMap();
  await layer.initTileset();
  return { layer, archive };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe('STTBaseLayer.initTileset wiring', () => {
  it('wires the batch path through archive.getTiles with incremental hooks', async () => {
    const { layer, archive } = await initLayer();
    cleanup.push(() => layer.tileset.finalize());
    const options = (layer.tileset as any).options;
    expect(options.getTileDataBatch).toBeTypeOf('function');

    const ids = [{ z: 1, x: 0, y: 0, t: 0 }];
    const signal = new AbortController().signal;
    const onTileReady = vi.fn();
    await options.getTileDataBatch(ids, signal, {
      onTileReady,
      fetchPriority: 'low',
    });
    expect(archive.getTiles).toHaveBeenCalledWith(ids, {
      signal,
      onTileReady,
      fetchPriority: 'low',
      playheadTime: undefined,
      playheadDirection: undefined,
    });
  });

  it('forwards the cross-source EDF play-head hints into archive.getTiles', async () => {
    // The tileset populates hooks.playheadTime/playheadDirection from its
    // current viewport in startTileBatch; the batch wiring must forward both
    // into the archive so its shared scheduler can rank range-groups by
    // distance-to-playhead (multi-source coordination, Phase 2 §2.8). Without
    // this link the archive falls back to a byte-order / enqueue-order sequence
    // and cross-source EDF stays inert.
    const { layer, archive } = await initLayer();
    cleanup.push(() => layer.tileset.finalize());
    const options = (layer.tileset as any).options;

    const ids = [{ z: 1, x: 0, y: 0, t: 0 }];
    const signal = new AbortController().signal;
    await options.getTileDataBatch(ids, signal, {
      fetchPriority: 'auto',
      playheadTime: 1_700_000_001_000,
      playheadDirection: -1,
    });
    expect(archive.getTiles).toHaveBeenCalledWith(
      ids,
      expect.objectContaining({
        playheadTime: 1_700_000_001_000,
        playheadDirection: -1,
      }),
    );
  });

  it('wires byte-size gating, refinement strategy and throughput', async () => {
    const { layer, archive } = await initLayer();
    cleanup.push(() => layer.tileset.finalize());
    const options = (layer.tileset as any).options;

    expect(options.refinementStrategy).toBe('best-available');

    const id = { z: 2, x: 1, y: 1, t: 0 };
    expect(options.getTileByteSize(id)).toBe(4096);
    expect(archive.getTileByteSize).toHaveBeenCalledWith(id);

    expect(options.getThroughput()).toEqual({ bytesPerMs: 5, samples: 3 });
    expect(archive.getThroughputEstimate).toHaveBeenCalled();
  });

  it('forwards onBufferChange runway events to the layer options', async () => {
    const onBufferChange = vi.fn();
    const { layer } = await initLayer({ onBufferChange });
    cleanup.push(() => layer.tileset.finalize());
    const options = (layer.tileset as any).options;

    const runway = { runwayMs: 1234, horizonMs: 30000, bytesMissing: 0 };
    options.onBufferChange(runway);
    expect(onBufferChange).toHaveBeenCalledWith(runway);
  });

  it('fires onTilesetReady with the live tileset; getTileset() agrees', async () => {
    const onTilesetReady = vi.fn();
    const { layer } = await initLayer({ onTilesetReady });
    cleanup.push(() => layer.tileset.finalize());

    expect(onTilesetReady).toHaveBeenCalledTimes(1);
    const tileset = onTilesetReady.mock.calls[0][0];
    expect(tileset).toBeInstanceOf(SpatioTemporalTileset);
    expect(layer.getTileset()).toBe(tileset);
  });

  it('getTileset() is undefined before init resolves', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' });
    expect(layer.getTileset()).toBeUndefined();
  });

  it('a removal during the metadata await aborts init: no tileset, no onTilesetReady', async () => {
    // Regression: onRemove must clear `this.map` so the post-await guard in
    // initTileset short-circuits. Otherwise a layer removed while
    // archive.getMetadata() is in flight still builds a tileset and hands the
    // governor a source that can never render (and leaks that tileset).
    const onTilesetReady = vi.fn();
    const layer = new STTPointLayer({
      ...baseOpts,
      id: 'p',
      onTilesetReady,
    }) as any;
    const archive = makeStubArchive();
    let resolveMeta!: (m: unknown) => void;
    archive.getMetadata = vi.fn(
      () =>
        new Promise((res) => {
          resolveMeta = res;
        }),
    );
    layer.archive = archive;
    layer.map = makeMockMap();

    const done = layer.initTileset();
    // Layer removed while the metadata read is still pending.
    layer.onRemove();
    resolveMeta({ minZoom: 0, maxZoom: 5, temporalBucketMs: 3_600_000 });
    await done;

    expect(onTilesetReady).not.toHaveBeenCalled();
    expect(layer.getTileset()).toBeUndefined();
    expect(layer.map).toBeUndefined();
  });
});
