/**
 * Showcase adapter over @poopdeck.gl/react's `usePlayback`: derives the generic
 * playback options (time range + base speed) from a showcase `Dataset`. Every
 * surface that mounts a live demo map (`/demo/:id`, the `/demos/:id` embed, the
 * Cesium page) goes through this so they can't drift apart.
 *
 * Both the time range and `baseSpeed` are resolved by
 * `@poopdeck.gl/playback`'s `resolvePlaybackParams` — the single source of
 * truth that also drives `buildDemoLayers`' prefetch budget, so the clock and
 * the loader can no longer disagree on the play-through duration.
 *
 * ARCHIVE-RECONCILED RANGE (was a deferred followup, now implemented):
 * `useArchiveMetadata` fetches the demo's manifest once (cached per-url) and
 * feeds the archive's authoritative `timeRange` / `temporalBucketMs` into the
 * resolver alongside the hand-authored overrides. The resolver reconciles the
 * two: an authored range that is an in-bounds subset of the archive is
 * respected verbatim (preserving deliberate editorial sub-windows), while an
 * out-of-bounds authored range is clamped to the overlap and a precise
 * `console.warn` fires — the guard against the "authored range disagrees with
 * the data → renders blank" class of bug, now caught live for future drift.
 *
 * While the metadata is still loading (or absent/on error) the result is
 * byte-identical to the pre-reconciliation behaviour:
 * `resolvePlaybackParams(undefined, { authored })` returns the authored range
 * and the same `baseSpeed = span / targetPlaybackSeconds / 1000`.
 */
import { useMemo } from 'react';
import { usePlayback, type PlaybackState } from '@poopdeck.gl/react';
import { resolvePlaybackParams } from '@poopdeck.gl/playback';
import type { Dataset } from '../../types';
import { useArchiveMetadata } from '../../lib/useArchiveMetadata';

export function useDemoPlayback(dataset: Dataset | undefined): PlaybackState {
  const metadata = useArchiveMetadata(dataset?.url);
  // The resolver widens the resident window to cover a wake's tail. Only the
  // round-marker families draw one; the rest have no tail to keep resident.
  const wakeLength =
    dataset && 'wakeLength' in dataset ? dataset.wakeLength : undefined;

  // Memoise on the PRIMITIVE inputs (authored range/target/window/wake + the
  // reconciled metadata range/bucket) so the resolved object reference stays
  // stable across unrelated re-renders. usePlayback's range effect keys on the
  // range start/end values, so a stable reference keeps it from resetting the
  // clock every render; recomputing only when a primitive actually changes is
  // also what makes the reconciliation `console.warn` fire once (when metadata
  // arrives), not on every frame.
  const params = useMemo(() => {
    if (!dataset) return undefined;
    return resolvePlaybackParams(
      metadata,
      {
        timeRange: dataset.timeRange,
        targetPlaybackSeconds: dataset.targetPlaybackSeconds,
        timeWindow: dataset.timeWindow,
        wakeLength,
        datasetId: dataset.id,
      },
      { onWarn: (m) => console.warn(m) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dataset?.id,
    dataset?.timeRange.start,
    dataset?.timeRange.end,
    dataset?.targetPlaybackSeconds,
    dataset?.timeWindow,
    wakeLength,
    metadata?.timeRange?.start,
    metadata?.timeRange?.end,
    metadata?.temporalBucketMs,
  ]);

  return usePlayback({
    timeRange: params?.timeRange,
    baseSpeed: params?.baseSpeed,
  });
}
