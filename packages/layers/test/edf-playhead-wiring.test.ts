/**
 * Cross-source EDF play-head wiring (multi-source coordination, Phase 2 §2.8).
 *
 * The tileset populates `TileBatchHooks.playheadTime` + `.playheadDirection`
 * from its current viewport in `startTileBatch`, and `STTArchive.getTiles`
 * already computes EDF priority from `TileRequestOptions.playheadTime` /
 * `.playheadDirection`. The only link is the layer's `getTileDataBatch`, which
 * must forward both hook fields into the `archive.getTiles(...)` call — without
 * it the archive falls back to its byte-order / enqueue-order sequence and the
 * cross-source EDF stays inert.
 *
 * This pins that forward in the deck.gl `SpatioTemporalLayer`: it drives the
 * real `_initArchiveAndTileset`, captures the `getTileDataBatch` closure the
 * layer wires into the tileset (both `STTArchive` and `SpatiotemporalTileset`
 * are mocked to capture the constructor options), then invokes that closure
 * with play-head hooks and asserts the archive receives them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the options the layer hands the tileset, and a stub archive whose
// getTiles records the options it was called with.
const captured: { tilesetOptions?: any; archive?: any } = {};

vi.mock('@poopdeck.gl/core', async () => {
  const actual = await vi.importActual<any>('@poopdeck.gl/core');

  class MockSTTArchive {
    url: string;
    getTiles = vi.fn(async (ids: any[]) => ids.map(() => null));
    getTile = vi.fn(async () => null);
    getTileIdsInBounds = vi.fn(() => []);
    getSummaryTileIdsInBounds = vi.fn(() => []);
    getTileByteSize = vi.fn(() => 4096);
    getThroughputEstimate = vi.fn(() => ({ bytesPerMs: 5, samples: 3 }));
    getMetadata = vi.fn(async () => ({ minZoom: 0, maxZoom: 5, temporalBucketMs: 3_600_000 }));
    finalize = vi.fn();
    constructor(opts: { url: string }) {
      this.url = opts.url;
      captured.archive = this;
    }
  }

  class MockSpatiotemporalTileset {
    options: any;
    constructor(options: any) {
      this.options = options;
      captured.tilesetOptions = options;
    }
    setAnimationState = vi.fn();
    preloadOverviewTier = vi.fn(() => new Promise(() => {})); // never settles
    finalize = vi.fn();
  }

  return {
    ...actual,
    STTArchive: MockSTTArchive,
    SpatiotemporalTileset: MockSpatiotemporalTileset,
  };
});

beforeEach(() => {
  captured.tilesetOptions = undefined;
  captured.archive = undefined;
});

/** Drive the real `_initArchiveAndTileset` on an Object.create'd layer. */
async function initLayer(extraProps: Record<string, unknown> = {}) {
  const { SpatioTemporalLayer } = await import('../src/layers/spatiotemporal-layer');
  const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
  layer.props = {
    id: 'edf',
    data: 'mem://test.stt',
    maxRequests: 8,
    timeWindow: 1000,
    ...extraProps,
  };
  layer.state = {};
  layer.setState = (patch: Record<string, unknown>) => {
    Object.assign(layer.state, patch);
  };
  layer._finalized = false;
  await layer._initArchiveAndTileset();
  return layer;
}

describe('SpatioTemporalLayer cross-source EDF play-head wiring', () => {
  it('forwards hooks.playheadTime + playheadDirection into archive.getTiles', async () => {
    await initLayer();
    const opts = captured.tilesetOptions;
    expect(opts.getTileDataBatch).toBeTypeOf('function');

    const ids = [{ z: 1, x: 0, y: 0, t: 0 }];
    const signal = new AbortController().signal;
    const onTileReady = vi.fn();
    await opts.getTileDataBatch(ids, signal, {
      onTileReady,
      fetchPriority: 'auto',
      playheadTime: 1_700_000_001_000,
      playheadDirection: -1,
    });

    expect(captured.archive.getTiles).toHaveBeenCalledWith(
      ids,
      expect.objectContaining({
        signal,
        onTileReady,
        fetchPriority: 'auto',
        playheadTime: 1_700_000_001_000,
        playheadDirection: -1,
      }),
    );
  });

  it('passes through undefined play-head when the tileset has no current time', async () => {
    await initLayer();
    const opts = captured.tilesetOptions;

    const ids = [{ z: 1, x: 0, y: 0, t: 0 }];
    const signal = new AbortController().signal;
    await opts.getTileDataBatch(ids, signal, { fetchPriority: 'low' });

    const call = captured.archive.getTiles.mock.calls[0][1];
    expect(call.playheadTime).toBeUndefined();
    expect(call.playheadDirection).toBeUndefined();
    expect(call.fetchPriority).toBe('low');
  });
});
