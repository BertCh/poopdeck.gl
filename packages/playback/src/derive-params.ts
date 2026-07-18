// @poopdeck.gl/playback
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/playback contributors

/**
 * derive-params — the single source of truth that turns a dataset's archive
 * metadata (+ optional authored aesthetic overrides) into fully-resolved,
 * deterministic playback parameters.
 *
 * WHY THIS EXISTS
 * ---------------
 * The archive (`STTArchive.getMetadata()`) already knows the facts the
 * frontend used to hand-type: the real `timeRange`, the native
 * `temporalBucketMs` timestep, the fitted `bounds`, the zoom span and a
 * build-time-measured `suggestedPlaybackSeconds`. Historically the showcase
 * re-declared those facts in `datasets.ts` and derived playback with TWO
 * divergent formulas (`calculateAnimationSpeed` ÷30 vs `buildDemoLayers` ÷60),
 * which silently drift from the archive and each other. This module pins the
 * FORMULA in one pure function so every consumer — the showcase, the MCP
 * `view_map` tool, external integrators — resolves identically, and turns the
 * "authored timeRange disagrees with the archive → renders blank" hazard into
 * a loud, precise warning.
 *
 * It has zero runtime dependencies and reads a MINIMAL STRUCTURAL slice of the
 * metadata (see {@link PlaybackMetadataInput}) — it deliberately does NOT
 * depend on `@poopdeck.gl/core`'s concrete `ArchiveMetadata`, so any object
 * with the right shape (a real archive, a JSON blob, a hand-built fixture)
 * works.
 */

/** Minimal `[start, end]` window in Unix milliseconds. */
export interface PlaybackTimeRange {
  /** Start timestamp (Unix milliseconds). */
  start: number;
  /** End timestamp (Unix milliseconds). */
  end: number;
}

/** Minimal geographic extent (matches `@poopdeck.gl/core`'s `BoundingBox`). */
export interface PlaybackBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/**
 * Minimal STRUCTURAL slice of archive metadata this module reads. Every field
 * is optional so a partial/absent archive never throws — the resolver falls
 * back to safe defaults. A real `@poopdeck.gl/core` `ArchiveMetadata` is
 * assignable to this without any cast.
 */
export interface PlaybackMetadataInput {
  /** Authoritative dataset time span. */
  timeRange?: PlaybackTimeRange;
  /** Native temporal bucket size in ms (the animation timestep). */
  temporalBucketMs?: number;
  /** Minimum tile zoom. */
  minZoom?: number;
  /** Maximum tile zoom. */
  maxZoom?: number;
  /** Fitted geographic extent (used only for the camera-fit fallback). */
  bounds?: PlaybackBounds;
  /** Server-aggregated summary tier — only `subBuckets` is read. */
  summaryTier?: { subBuckets?: number };
  /** Temporal LOD pyramid — only `bucketMs` per level is read. */
  temporalLod?: { bucketMs: number }[];
  /** Build-time style hints — only `suggestedPlaybackSeconds` is read. */
  styleHints?: { suggestedPlaybackSeconds?: number };
}

/**
 * Authored aesthetic overrides. Everything here is a hand-tuned CHOICE that
 * intentionally beats the archive-derived default; leave a field unset to let
 * the metadata drive it.
 */
export interface PlaybackOverrides {
  /** Wall-clock seconds for one full play-through (beats `suggestedPlaybackSeconds`). */
  targetPlaybackSeconds?: number;
  /** Resident/rolling loader window in ms (beats the bucket-derived default). */
  timeWindow?: number;
  /** Trip trail length in ms — passed through verbatim (never invented). */
  trailLength?: number;
  /** Ship/comet wake length in ms — enforces the wake invariant on `timeWindow`. */
  wakeLength?: number;
  /**
   * Authored time range. An in-bounds SUBSET of the archive extent is
   * respected verbatim (a deliberate editorial sub-window); a range that
   * spills outside the archive is clamped to the overlap with a warning.
   */
  timeRange?: PlaybackTimeRange;
  /** Dataset id, used only to make warning messages precise. */
  datasetId?: string;
}

/** Fully-resolved, deterministic playback parameters. */
export interface ResolvedPlaybackParams {
  /** Resolved time range: an in-bounds authored subset, else the archive extent (out-of-bounds authored is clamped to the overlap). */
  timeRange: PlaybackTimeRange;
  /** `end - start` of the resolved range, in ms (never negative). */
  span: number;
  /** Sim-ms per wall-ms: `span / targetPlaybackSeconds / 1000`. */
  baseSpeed: number;
  /** Resolved wall-clock seconds for one full play-through. */
  targetPlaybackSeconds: number;
  /** Effective loader window in ms, after the wake invariant is enforced. */
  timeWindow: number;
  /** Native timestep in ms, if the archive declared one. */
  temporalBucketMs?: number;
  /** Number of native frames: `ceil(span / temporalBucketMs)` (0 if unknown). */
  frameCount: number;
  /** Trail length in ms — present only when the caller authored one. */
  trailLength?: number;
  /** Wake length in ms — present only when the caller authored one. */
  wakeLength?: number;
}

/** Options threaded into {@link resolvePlaybackParams}. */
export interface ResolvePlaybackOptions {
  /**
   * Reconciliation-warning sink. Defaults to a guarded dev-only
   * `console.warn`. The warning path never throws.
   */
  onWarn?: (message: string) => void;
}

/** Options for {@link deriveViewStateFromBounds}. */
export interface DeriveViewStateOptions {
  /** Viewport width in CSS px (default 1280). */
  width?: number;
  /** Viewport height in CSS px (default 720). */
  height?: number;
  /** Fractional margin kept on every edge, 0..0.49 (default 0.1). */
  padding?: number;
  /** Lower zoom clamp (default 0). */
  minZoom?: number;
  /** Upper zoom clamp (default 22). */
  maxZoom?: number;
}

/**
 * The ONE default playback duration, in wall-clock seconds. This is the single
 * fallback the whole ecosystem shares; the historical `÷30` (showcase
 * `calculateAnimationSpeed`) and `÷60` (`buildDemoLayers`) formulas are
 * unified to this value. Any per-demo speed that relied on a different
 * fallback must now pass an explicit `overrides.targetPlaybackSeconds`.
 */
export const DEFAULT_TARGET_PLAYBACK_SECONDS = 30;

/**
 * Multiplier on the native bucket used to derive a default loader window when
 * no `overrides.timeWindow` is authored (24 native buckets resident).
 */
export const DEFAULT_TIME_WINDOW_BUCKETS = 24;

/**
 * Ultimate loader-window fallback in ms (24h) when the archive declares no
 * `temporalBucketMs` — mirrors the showcase's historical `|| 86400000`.
 */
export const DEFAULT_TIME_WINDOW_MS = 86_400_000;

/** Floor for {@link deriveTrailLength}, in ms — mirrors `MaplibreRenderer`. */
export const MIN_TRAIL_LENGTH_MS = 30_000;

/** Fallback camera zoom for the degenerate point-extent case. */
export const DEFAULT_POINT_ZOOM = 11;

const MERCATOR_MAX_LAT = 85.051_128_78;
const TILE_SIZE = 512;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * First finite, strictly-positive number in `values`, else `undefined`. Used
 * so a nonsensical `0`/`NaN`/`Infinity` never poisons `baseSpeed` — it falls
 * through to the next candidate exactly as an absent value would.
 */
function firstPositive(...values: (number | undefined)[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/**
 * Guarded, dev-only default warning sink. Never throws; silent in Node
 * production builds. Callers that want their own routing pass `opts.onWarn`.
 */
function defaultOnWarn(message: string): void {
  try {
    if (
      typeof process !== 'undefined' &&
      process.env != null &&
      process.env.NODE_ENV === 'production'
    ) {
      return;
    }
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(message);
    }
  } catch {
    // The warning path must never throw — swallow anything the environment
    // (exotic `process`/`console` shims) surprises us with.
  }
}

/**
 * Number of native frames spanned by `timeRange` at `temporalBucketMs`:
 * `ceil((end - start) / temporalBucketMs)`. Returns 0 when the timestep is
 * unknown or the span is non-positive (the archive carries no explicit
 * frame-count field, so this is the canonical derivation).
 */
export function deriveFrameCount(
  timeRange: PlaybackTimeRange,
  temporalBucketMs?: number,
): number {
  if (temporalBucketMs == null || !(temporalBucketMs > 0)) return 0;
  const span = timeRange.end - timeRange.start;
  if (!(span > 0)) return 0;
  return Math.ceil(span / temporalBucketMs);
}

/**
 * Trail length in ms derived from a loader window, mirroring
 * `MaplibreRenderer`: `max(timeWindow / 4, 30_000)`. Provided as an OPT-IN
 * helper — {@link resolvePlaybackParams} never invents a trail; it only passes
 * through an authored `overrides.trailLength`.
 */
export function deriveTrailLength(timeWindow: number): number {
  return Math.max(timeWindow / 4, MIN_TRAIL_LENGTH_MS);
}

/** Web-Mercator north-normalised Y in [0, 1] (0 = north edge, 1 = south). */
function mercatorY(lat: number): number {
  const clamped = clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/**
 * Web-Mercator `fitBounds` FALLBACK: the centre longitude/latitude plus the
 * integer-free zoom that fits `bounds` inside a `width × height` viewport with
 * `padding` margin. The camera is purely aesthetic — authored `initialView`
 * always wins; this is only the fallback when none is provided. Degenerate
 * (point) extents fall back to {@link DEFAULT_POINT_ZOOM}, clamped to the
 * metadata zoom span when supplied.
 */
export function deriveViewStateFromBounds(
  bounds: PlaybackBounds,
  opts: DeriveViewStateOptions = {},
): { longitude: number; latitude: number; zoom: number } {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const padding = clamp(opts.padding ?? 0.1, 0, 0.49);
  const minZoom = opts.minZoom ?? 0;
  const maxZoom = opts.maxZoom ?? 22;

  const longitude = (bounds.minLon + bounds.maxLon) / 2;
  const latitude = (bounds.minLat + bounds.maxLat) / 2;

  const lonFraction = Math.abs(bounds.maxLon - bounds.minLon) / 360;
  const latFraction = Math.abs(
    mercatorY(bounds.minLat) - mercatorY(bounds.maxLat),
  );

  const usableW = width * (1 - 2 * padding);
  const usableH = height * (1 - 2 * padding);

  const zooms: number[] = [];
  if (lonFraction > 0) zooms.push(Math.log2(usableW / TILE_SIZE / lonFraction));
  if (latFraction > 0) zooms.push(Math.log2(usableH / TILE_SIZE / latFraction));

  const fitted = zooms.length > 0 ? Math.min(...zooms) : DEFAULT_POINT_ZOOM;

  return { longitude, latitude, zoom: clamp(fitted, minZoom, maxZoom) };
}

/**
 * Resolve a dataset's archive metadata (+ optional authored overrides) into
 * deterministic playback parameters. PURE: no `Date.now`, no I/O, no mutation
 * of the inputs; identical inputs always yield identical outputs.
 *
 * Precedence & rules:
 *  - `timeRange`: subset-respect / out-of-bounds-clamp. An authored
 *    `overrides.timeRange` that lies INSIDE the archive extent (within
 *    `tol = max(temporalBucketMs, 1% of span, 1000ms)`) is RESPECTED verbatim
 *    — this preserves deliberate editorial sub-windows. A range that spills
 *    OUTSIDE the archive (the "authored range → dead-air/blank render" hazard)
 *    is clamped to the overlap `[max(a.start,m.start), min(a.end,m.end)]` with
 *    a warning, or — when there is no overlap at all — falls back to the full
 *    archive extent with a stronger warning. `overrides.timeRange` is adopted
 *    verbatim only when the archive declares none.
 *  - `targetPlaybackSeconds`: `overrides ?? styleHints.suggestedPlaybackSeconds
 *    ?? {@link DEFAULT_TARGET_PLAYBACK_SECONDS}` (non-positive candidates are
 *    skipped so `baseSpeed` never goes infinite).
 *  - `baseSpeed = span / targetPlaybackSeconds / 1000` (sim-ms per wall-ms).
 *  - `timeWindow`: `overrides.timeWindow ?? min(temporalBucketMs *
 *    {@link DEFAULT_TIME_WINDOW_BUCKETS}, span)`, then RAISED to `2 *
 *    wakeLength` (with a warning) if a `wakeLength` override would otherwise
 *    let the trailing half of the wake evict.
 *  - `trailLength`: passed through from overrides only (never invented).
 */
export function resolvePlaybackParams(
  metadata: PlaybackMetadataInput = {},
  overrides: PlaybackOverrides = {},
  opts: ResolvePlaybackOptions = {},
): ResolvedPlaybackParams {
  const onWarn = opts.onWarn ?? defaultOnWarn;
  const idPart = overrides.datasetId ? ` for "${overrides.datasetId}"` : '';

  // 1. timeRange — subset-respect / out-of-bounds-clamp reconciliation.
  //    An authored range that sits INSIDE the archive extent (a deliberate
  //    editorial sub-window) is RESPECTED verbatim, no warning. An authored
  //    range that spills OUTSIDE the archive (would render dead air / blank)
  //    is a hazard: clamp to the overlap and warn — or, if there is no
  //    overlap at all, fall back to the full archive extent and warn harder.
  const metaRange = metadata.timeRange;
  const overrideRange = overrides.timeRange;
  let timeRange: PlaybackTimeRange;
  if (!metaRange) {
    // Nothing to reconcile against — adopt the authored range if any.
    timeRange = overrideRange ?? { start: 0, end: 0 };
  } else if (!overrideRange) {
    // No authored range — the archive extent is the answer.
    timeRange = metaRange;
  } else {
    const metaSpan = metaRange.end - metaRange.start;
    // Tolerance absorbs authoring precision + AV sub-frame noise: the native
    // bucket, 1% of the archive span, or a 1s ms floor — whichever is largest.
    const tol = Math.max(
      metadata.temporalBucketMs ?? 0,
      Math.abs(metaSpan) * 0.01,
      1000,
    );
    const startOOB = overrideRange.start < metaRange.start - tol;
    const endOOB = overrideRange.end > metaRange.end + tol;
    if (!startOOB && !endOOB) {
      // In-bounds subset (or ~equal): the authored window is deliberate.
      timeRange = overrideRange;
    } else {
      const overlapStart = Math.max(overrideRange.start, metaRange.start);
      const overlapEnd = Math.min(overrideRange.end, metaRange.end);
      if (overlapEnd > overlapStart) {
        onWarn(
          `resolvePlaybackParams${idPart}: authored timeRange ` +
            `[${overrideRange.start}, ${overrideRange.end}] extends outside the ` +
            `archive's [${metaRange.start}, ${metaRange.end}] (would render dead ` +
            `air); clamping to [${overlapStart}, ${overlapEnd}] (the overlap). ` +
            `Trim the authored range to the archive extent to silence this.`,
        );
        timeRange = { start: overlapStart, end: overlapEnd };
      } else {
        onWarn(
          `resolvePlaybackParams${idPart}: authored timeRange ` +
            `[${overrideRange.start}, ${overrideRange.end}] does not overlap the ` +
            `archive's [${metaRange.start}, ${metaRange.end}] and would render ` +
            `entirely blank; using archive extent instead.`,
        );
        timeRange = metaRange;
      }
    }
  }

  const span = Math.max(0, timeRange.end - timeRange.start);

  // 2. targetPlaybackSeconds & baseSpeed.
  const targetPlaybackSeconds =
    firstPositive(
      overrides.targetPlaybackSeconds,
      metadata.styleHints?.suggestedPlaybackSeconds,
    ) ?? DEFAULT_TARGET_PLAYBACK_SECONDS;
  const baseSpeed = span / targetPlaybackSeconds / 1000;

  // 3. timeWindow — bucket-derived default, then wake-invariant enforcement.
  let timeWindow: number;
  if (overrides.timeWindow != null && overrides.timeWindow > 0) {
    timeWindow = overrides.timeWindow;
  } else {
    const bucket = metadata.temporalBucketMs;
    const rawWindow =
      bucket != null && bucket > 0
        ? bucket * DEFAULT_TIME_WINDOW_BUCKETS
        : DEFAULT_TIME_WINDOW_MS;
    timeWindow = span > 0 ? Math.min(rawWindow, span) : rawWindow;
  }

  const wakeLength = overrides.wakeLength;
  if (wakeLength != null && wakeLength > 0) {
    const minWindow = 2 * wakeLength;
    if (timeWindow < minWindow) {
      onWarn(
        `resolvePlaybackParams${idPart}: timeWindow ${timeWindow}ms is below ` +
          `2×wakeLength (${minWindow}ms); raising it to ${minWindow}ms so the ` +
          `trailing half of the wake is not evicted.`,
      );
      timeWindow = minWindow;
    }
  }

  const result: ResolvedPlaybackParams = {
    timeRange,
    span,
    baseSpeed,
    targetPlaybackSeconds,
    timeWindow,
    frameCount: deriveFrameCount(timeRange, metadata.temporalBucketMs),
  };
  if (metadata.temporalBucketMs != null) {
    result.temporalBucketMs = metadata.temporalBucketMs;
  }
  if (overrides.trailLength != null) result.trailLength = overrides.trailLength;
  if (wakeLength != null) result.wakeLength = wakeLength;
  return result;
}
