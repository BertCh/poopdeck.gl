/**
 * Tileset wiring tests — verifies `initTileset` configures the
 * SpatiotemporalTileset with the full @stt/core capability set (parity with
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
import { SpatiotemporalTileset, type TileId } from '@stt/core';
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
  const layer = new STTPointLayer({ ...baseOpts, id: 'p', ...extraOpts }) as any;
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
    });
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
    expect(tileset).toBeInstanceOf(SpatiotemporalTileset);
    expect(layer.getTileset()).toBe(tileset);
  });

  it('getTileset() is undefined before init resolves', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' });
    expect(layer.getTileset()).toBeUndefined();
  });
});
