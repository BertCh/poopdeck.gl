/**
 * useArchiveMetadata — fetch a demo archive's authoritative metadata once and
 * hand it to the playback resolver so the hand-authored `dataset.timeRange`
 * can be reconciled against the real data span at runtime (see
 * `components/demo/useDemoPlayback`).
 *
 * The archive (`STTArchive.getMetadata()`) already knows the facts the
 * frontend hand-types in `datasets.ts` — the true `timeRange`, the native
 * `temporalBucketMs`, the fitted `bounds`, the zoom span, a build-time
 * `suggestedPlaybackSeconds`. `@poopdeck.gl/core`'s `ArchiveMetadata` is
 * assignable to `@poopdeck.gl/playback`'s `PlaybackMetadataInput` with NO cast,
 * so we get the canonical snake→camel mapping (`time_range` → `timeRange`,
 * `temporal_bucket_ms` → `temporalBucketMs`, …) for free.
 *
 * Contract:
 *  - Returns `undefined` while loading AND on any error — it NEVER throws and
 *    never blocks render. A demo whose manifest is missing/slow simply keeps
 *    trusting its authored `timeRange` (today's behaviour) until/if metadata
 *    arrives.
 *  - Results are cached per-url at MODULE scope, so every mount of the same
 *    demo (`/demo/:id`, the `/demos/:id` embed, the Cesium page) shares ONE
 *    manifest read and re-renders resolve synchronously from the cache — no
 *    flash. Concurrent mounts share one in-flight fetch.
 *  - A url change ignores any stale in-flight result (a late resolve for the
 *    previous demo can't clobber the current one).
 */
import { useEffect, useState } from 'react';
import { STTArchive } from '@poopdeck.gl/core';
import type { PlaybackMetadataInput } from '@poopdeck.gl/playback';

/**
 * Per-url resolved metadata. Present only after a successful `getMetadata()`;
 * a failed/absent manifest is intentionally left un-cached so a transient
 * network error can be retried by a later mount.
 */
const metadataCache = new Map<string, PlaybackMetadataInput>();
/** Per-url in-flight guard so concurrent mounts don't each open an archive. */
const inflight = new Map<string, Promise<PlaybackMetadataInput | undefined>>();

/**
 * Load (or return the cached) archive metadata for `url`, shaped for the
 * playback resolver. Resolves to `undefined` on ANY failure — the caller must
 * treat that as "no metadata yet", never as an error to surface.
 */
async function loadArchiveMetadata(
  url: string,
): Promise<PlaybackMetadataInput | undefined> {
  const cached = metadataCache.get(url);
  if (cached) return cached;
  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      // Opening an archive is cheap: `getMetadata()` is one whole-object
      // manifest GET (no worker pool, no tile fetches). The instance is
      // discarded once the metadata is extracted.
      const archive = new STTArchive({ url });
      const metadata = await archive.getMetadata();
      metadataCache.set(url, metadata);
      return metadata;
    } catch {
      // Missing manifest, offline, CORS, malformed JSON — swallow it. The
      // playback path keeps using the authored range; reconciliation is a
      // safety net, never a hard dependency.
      return undefined;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, promise);
  return promise;
}

/**
 * React hook: the archive metadata for `url`, or `undefined` while loading /
 * on error / when `url` is absent. Feed the result straight into
 * `resolvePlaybackParams(metadata, …)`.
 */
export function useArchiveMetadata(
  url?: string,
): PlaybackMetadataInput | undefined {
  // Seed from the module cache so an already-loaded demo renders reconciled on
  // the very first paint (no undefined→metadata transition, no clock reset).
  const [metadata, setMetadata] = useState<PlaybackMetadataInput | undefined>(
    () => (url ? metadataCache.get(url) : undefined),
  );

  useEffect(() => {
    if (!url) {
      setMetadata(undefined);
      return;
    }
    const cached = metadataCache.get(url);
    if (cached) {
      setMetadata(cached);
      return;
    }
    // Nothing cached for this url yet: reset to undefined (so a dataset swap
    // doesn't briefly show the previous demo's metadata) and fetch.
    setMetadata(undefined);
    let stale = false;
    void loadArchiveMetadata(url).then((result) => {
      if (!stale) setMetadata(result);
    });
    return () => {
      stale = true;
    };
  }, [url]);

  return metadata;
}
