// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Governor source registration for the Three renderer.
 *
 * The deck cockpit registers each tileset with the playback `PlaybackGovernor`
 * (via `usePlayback().registry`) so the shared clock gates on real buffer
 * readiness. The Three renderer historically registered NOTHING — and the
 * governor's "zero sources ⇒ start immediately" short-circuit lives INSIDE its
 * `hasAnySource()` branch, so an empty source set does NOT pass the start gate;
 * it falls through to the multi-second `maxStartWaitMs` escape hatch. Net effect:
 * pressing play froze the clock for ~8 s before lurching into a degraded start.
 *
 * This renderer eager-loads each archive in full (see {@link SttTileSource}), so
 * by the time a layer mounts its tiles are already resident. We therefore
 * register a trivially-COMPLETE {@link BufferSource} per layer: the gate passes
 * instantly (honest — the data is loaded) and the cockpit's buffered-range bar,
 * Auto-speed, and ETA chip light up. Use the SAME source ids/`required` flags the
 * deck path uses (LIDAR = dataset id required, ego/objects required, map
 * optional) so stream toggles reconcile identically.
 */

import type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';

/**
 * The minimal registry surface the Three renderer needs — structurally
 * compatible with `@poopdeck.gl/react`'s `SourceRegistry` (which is what the
 * showcase passes), without coupling this package to the React package.
 */
export interface SttSourceRegistry {
  registerSource: (
    id: string,
    source: BufferSource,
    opts?: { required?: boolean; weight?: number },
  ) => void;
  unregisterSource: (id: string) => void;
  onBufferChange?: (id: string, runway: BufferedRunway) => void;
}

/**
 * A {@link BufferSource} that reports its whole range as already buffered and
 * complete. For an eager loader whose tiles are resident by the time the layer
 * mounts, this is the honest report: the start/seek gate passes immediately and
 * the timeline's buffered-range bar fills.
 */
export function createCompleteBufferSource(timeRange?: {
  start: number;
  end: number;
}): BufferSource {
  const ranges = timeRange
    ? [{ start: timeRange.start, end: timeRange.end }]
    : [];
  const runway: BufferedRunway = {
    simMs: Infinity,
    bytesPending: 0,
    horizonSimMs: Infinity,
    complete: true,
  };
  return {
    getBufferedRunway: () => runway,
    getBufferedRanges: () => ranges.map((r) => ({ ...r })),
    estimateCost: () => ({ bytes: 0, tiles: 0 }),
    estimateTimeToReadyMs: () => 0,
    flushPrefetch: () => {},
    // The clock is externally driven (not gated), so prefetch state is a no-op.
    setAnimationState: () => {},
  };
}
