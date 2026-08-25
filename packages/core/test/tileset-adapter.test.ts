/**
 * `makeTilesetCallbacks` — the one adapter between an `STTArchive` and the
 * tileset's fetch callbacks. Pins the two hand-offs the tile-loading audit
 * (2026-08) added — `estimateFetchBytes` rides `planRangeBytes` (C4), and a
 * batch member's failure reason (`onTileError`, B8) crosses the adapter
 * archive → tileset unchanged — next to the hooks it already forwarded.
 * The archive is a hand-rolled fake: the adapter is pure glue, so the
 * assertion is identity of what arrives on each side, not transport.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTilesetCallbacks } from '../src/render/tileset-adapter';
import type { STTArchive } from '../src/archive';
import type { SpatioTemporalTilesetOptions } from '../src/spatiotemporal-tileset';
import type { TileId } from '../src/types';

function fakeArchive() {
  return {
    getTileIdsInBounds: vi.fn(async () => []),
    getSummaryTileIdsInBounds: vi.fn(async () => []),
    getTile: vi.fn(async () => null),
    getTiles: vi.fn(async (ids: TileId[]) => ids.map(() => null)),
    getTileByteSize: vi.fn(() => 0),
    planRangeBytes: vi.fn(() => 0),
    getThroughputEstimate: vi.fn(() => ({ bytesPerMs: 1, samples: 1 })),
    setSchedulerWeight: vi.fn(),
    setMaxConcurrentRequests: vi.fn(),
  };
}
const asArchive = (a: ReturnType<typeof fakeArchive>) =>
  a as unknown as STTArchive;

const IDS: TileId[] = [
  { z: 3, x: 1, y: 2, t: 0 },
  { z: 3, x: 2, y: 2, t: 0 },
];

describe('makeTilesetCallbacks', () => {
  it('C4: estimateFetchBytes is wired and prices the archive RANGE plan, not the directory sum', () => {
    const archive = fakeArchive();
    archive.planRangeBytes.mockReturnValue(22_200_000);
    archive.getTileByteSize.mockReturnValue(1);
    const callbacks = makeTilesetCallbacks(asArchive(archive));
    expect(typeof callbacks.estimateFetchBytes).toBe('function');
    expect(callbacks.estimateFetchBytes!(IDS)).toBe(22_200_000);
    expect(archive.planRangeBytes).toHaveBeenCalledWith(IDS);
    expect(archive.getTileByteSize).not.toHaveBeenCalled();
  });

  it('C4: the callback bag assigns onto SpatioTemporalTilesetOptions with estimateFetchBytes carried', () => {
    // Compile-time half: `estimateFetchBytes` is a real tileset option now,
    // so the spread the layers do must carry it without a cast.
    const options: Partial<SpatioTemporalTilesetOptions> = {
      ...makeTilesetCallbacks(asArchive(fakeArchive())),
    };
    expect(typeof options.estimateFetchBytes).toBe('function');
  });

  it('B8: a member failure the archive reports reaches the tileset batch hook, index + reason intact', async () => {
    const archive = fakeArchive();
    const failure = new Error('x');
    archive.getTiles.mockImplementation(async (ids: TileId[], opts?: any) => {
      opts?.onTileError?.(0, failure);
      return ids.map(() => null);
    });
    const callbacks = makeTilesetCallbacks(asArchive(archive));
    const onTileError = vi.fn();
    const result = await callbacks.getTileDataBatch!(
      IDS,
      new AbortController().signal,
      { onTileError },
    );
    expect(onTileError).toHaveBeenCalledTimes(1);
    expect(onTileError).toHaveBeenCalledWith(0, failure);
    expect(result).toEqual([null, null]);
  });

  it('forwards the batch hooks and signal to getTiles by identity', async () => {
    const archive = fakeArchive();
    const callbacks = makeTilesetCallbacks(asArchive(archive));
    const signal = new AbortController().signal;
    const hooks = {
      onTileReady: vi.fn(),
      onTileError: vi.fn(),
      fetchPriority: 'low' as const,
      playheadTime: 1_000,
      playheadDirection: 1 as const,
      viewportCenter: { lng: 1, lat: 2 },
    };
    await callbacks.getTileDataBatch!(IDS, signal, hooks as any);
    expect(archive.getTiles).toHaveBeenCalledTimes(1);
    const [ids, forwarded] = archive.getTiles.mock.calls[0] as [
      TileId[],
      Record<string, unknown>,
    ];
    expect(ids).toBe(IDS);
    expect(forwarded.signal).toBe(signal);
    expect(forwarded.onTileReady).toBe(hooks.onTileReady);
    expect(forwarded.onTileError).toBe(hooks.onTileError);
    expect(forwarded.fetchPriority).toBe('low');
    expect(forwarded.playheadTime).toBe(1_000);
    expect(forwarded.playheadDirection).toBe(1);
    expect(forwarded.viewportCenter).toBe(hooks.viewportCenter);
  });

  it('omits the batch hooks cleanly when the tileset passes none', async () => {
    const archive = fakeArchive();
    const callbacks = makeTilesetCallbacks(asArchive(archive));
    await callbacks.getTileDataBatch!(IDS, new AbortController().signal);
    const [, forwarded] = archive.getTiles.mock.calls[0] as [
      TileId[],
      Record<string, unknown>,
    ];
    expect(forwarded.onTileError).toBeUndefined();
    expect(forwarded.onTileReady).toBeUndefined();
  });
});
