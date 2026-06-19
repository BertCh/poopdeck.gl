// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PlaybackGovernor,
  PlaybackGovernorState,
  SourceRunway,
} from "@poopdeck.gl/playback";

export interface PlaybackControlsProps {
  currentTime: number;
  timeRange: { start: number; end: number };
  /** User intent (drives the play/pause glyph); the governor may still be gating. */
  isPlaying: boolean;
  /** Governor machine state (drives the buffering chip). */
  bufferState: PlaybackGovernorState;
  /**
   * The playback governor. Drag-scrubbing talks to it directly
   * (beginScrub/scrubTo/endScrub); committed seeks go through `onSeek` so the
   * page owns the commit path. Null only for the first paint — the page
   * creates it in a mount effect (StrictMode-safe lifecycle); scrub commits
   * fall back to `onSeek` until it exists.
   */
  governor: PlaybackGovernor | null;
  onPlayPause: () => void;
  /** Committed seek (keyboard arrows on the slider, jump-to-start). */
  onSeek: (time: number) => void;
  onSpeedChange: (multiplier: number) => void;
  currentSpeedMultiplier: number;
  targetPlaybackSeconds: number;
  /** Whether the opt-in Auto speed mode is active. */
  autoSpeed: boolean;
  /** Select Auto speed mode (any explicit preset/slider choice exits it). */
  onAutoSpeedSelect: () => void;
  /**
   * Optional YouTube-style hover preview. When supplied, a "Preview" toggle
   * appears; while enabled, hovering the scrubber shows a card above it
   * rendering the map at the (settle-debounced) hovered time. The parent owns
   * the actual render (it has the deck/camera context) — we just call this with
   * the hovered timestamp. Omit it and nothing about the bar changes.
   */
  renderPreview?: (time: number) => React.ReactNode;
}

/** Upper bound on the hover-preview card width (matches HoverPreview's
 *  `maxWidth`); the card itself hugs the live viewport's aspect ratio, so we
 *  only need the max for keeping it on-screen. */
const PREVIEW_MAX_W = 264;
/** Cursor must rest this long before the (expensive) preview frame re-renders. */
const PREVIEW_SETTLE_MS = 120;

// `estimateCost` is a new passthrough on PlaybackGovernor that lands alongside
// this change. The showcase typechecks against @poopdeck.gl/layers's BUILT dist,
// which may be stale until the package is rebuilt — this narrow intersection
// keeps the call site typed (and becomes a harmless no-op once the rebuilt
// types include the member) instead of scattering @ts-ignore.
type GovernorWithCost = PlaybackGovernor & {
  estimateCost(range: { start: number; end: number }): {
    bytes: number;
    tiles: number;
  };
};

// `getSourceRunways` is the multi-source-coordination Phase 4 passthrough (one
// runway probe per registered governor source). Same dist-staleness guard as
// `GovernorWithCost`: the showcase typechecks against @poopdeck.gl/playback's
// BUILT dist, which may not yet carry the member — this narrow intersection
// keeps the call typed and becomes a harmless no-op once the rebuilt types
// include it. Defensive `?.()` at the call site degrades to the single-bar
// path if an older governor build lacks the method entirely.
type GovernorWithSources = PlaybackGovernor & {
  getSourceRunways?: () => SourceRunway[];
};

/** All timestamps in the player are dataset time — global scientific datasets
 *  (drifters, satellites, ECCO) are authored in UTC, so the labels must not
 *  drift with the viewer's locale zone (§3.5). */
const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
};

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

const DENSITY_BUCKETS = 80;

/** §5.1 — faint per-bucket "where the data is" strip above the scrubber.
 *  Purely decorative (the tooltip carries the words), hence aria-hidden. */
const DensityStrip: React.FC<{ density: number[] }> = ({ density }) => (
  <div
    aria-hidden="true"
    title="Relative data volume"
    className="flex items-end w-full"
    style={{ height: 9, marginBottom: 2 }}
  >
    {density.map((v, i) => (
      <div
        key={i}
        style={{
          flex: 1,
          // Floor nonzero buckets at 1px so sparse-but-present time still reads.
          height: v > 0 ? `${Math.max(v * 100, 12)}%` : 0,
          background: "var(--ink-400)",
          opacity: 0.15,
        }}
      />
    ))}
  </div>
);

/**
 * Multi-source coordination Phase 4 — a compact per-source runway strip shown
 * only when 2+ sources are registered (single-source demos keep the plain
 * buffered bar unchanged). Each source gets one thin track; the filled portion
 * is that source's contiguous resident runway ahead of the playhead, mapped
 * onto the bar's sim-time axis (forward from the playhead). The GATING source
 * (the required, not-yet-complete source with the least runway — what the clock
 * is held by) is drawn in the accent colour; other required sources are inked;
 * optional (non-gating) sources are faint. Purely informational (aria-hidden);
 * the live status chip already announces buffering for screen readers, and a
 * per-track title carries the words. No animation, so it is inert under
 * prefers-reduced-motion by construction.
 */
const SourceRunwayStrip: React.FC<{
  sources: SourceRunway[];
  gatingId: string | null;
  playheadFrac: number;
  rangeMs: number;
}> = ({ sources, gatingId, playheadFrac, rangeMs }) => (
  <div
    aria-hidden="true"
    className="flex flex-col w-full"
    style={{ gap: 2, marginTop: 4 }}
  >
    {sources.map((s) => {
      // Resident runway as a fraction of the whole timeline, drawn forward
      // from the playhead. A complete source has effectively unbounded runway,
      // so fill to the end. Clamp so a long runway never paints past the bar.
      const runwayFrac = s.complete
        ? 1
        : rangeMs > 0
          ? Math.min(1, Math.max(0, s.runwaySimMs / rangeMs))
          : 0;
      const left = Math.min(100, Math.max(0, playheadFrac * 100));
      const width = Math.min(100 - left, runwayFrac * 100);
      const isGating = s.id === gatingId;
      const color = isGating
        ? "var(--accent)"
        : s.required
          ? "var(--ink-500)"
          : "var(--ink-400)";
      const labelKind = s.required
        ? isGating
          ? "gating — clock is held here"
          : "required"
        : "optional";
      return (
        <div
          key={s.id}
          title={`${s.id}: ${labelKind}${s.complete ? " (complete)" : ""}`}
          className="relative w-full rounded-full"
          style={{ height: 2, background: "var(--hairline)" }}
        >
          {width > 0 && (
            <div
              className="absolute top-0 h-full rounded-full"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: color,
                opacity: isGating ? 0.95 : s.required ? 0.55 : 0.3,
              }}
            />
          )}
        </div>
      );
    })}
  </div>
);

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  currentTime,
  timeRange,
  isPlaying,
  bufferState,
  governor,
  onPlayPause,
  onSeek,
  onSpeedChange,
  currentSpeedMultiplier,
  targetPlaybackSeconds,
  autoSpeed,
  onAutoSpeedSelect,
  renderPreview,
}) => {
  // ── Drag-aware scrubbing ────────────────────────────────────────────────────
  // While the thumb is held, every move is a PREVIEW (instant feedback from
  // whatever tiles are resident — no fetch churn); the real seek commits on
  // release, or early if the position rests unchanged for the governor's
  // settle window while still dragging. Keyboard arrows (onChange without a
  // preceding pointerdown) go through the same settle debounce so a held key
  // produces ONE committed seek, not a flushPrefetch storm (F3).
  const draggingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keySeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  // Keyboard/programmatic position awaiting its settle-debounced commit;
  // shown immediately (like scrubValue) so arrows feel instant.
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const clearKeySeekTimer = useCallback(() => {
    if (keySeekTimerRef.current !== null) {
      clearTimeout(keySeekTimerRef.current);
      keySeekTimerRef.current = null;
    }
  }, []);

  const handleScrubStart = useCallback(() => {
    draggingRef.current = true;
    // The drag takes over: drop any pending keyboard commit (release will
    // commit the dragged position anyway).
    clearKeySeekTimer();
    setPendingSeek(null);
    governor?.beginScrub();
  }, [governor, clearKeySeekTimer]);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      if (draggingRef.current && governor) {
        setScrubValue(value);
        governor.scrubTo(value); // preview only
        // Settle commit: if the thumb rests here, commit without waiting for
        // release (video-player behaviour). Further movement re-arms it.
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          if (draggingRef.current) governor.seekTo(value);
        }, governor.seekSettleMs);
      } else {
        // Keyboard arrows / programmatic change — preview now, commit once the
        // position rests for the settle window (same debounce as drag).
        setPendingSeek(value);
        clearKeySeekTimer();
        keySeekTimerRef.current = setTimeout(() => {
          keySeekTimerRef.current = null;
          setPendingSeek(null);
          onSeek(value);
        }, governor?.seekSettleMs ?? 200);
      }
    },
    [governor, onSeek, clearSettleTimer, clearKeySeekTimer],
  );

  const handleScrubEnd = useCallback(
    (e: React.SyntheticEvent<HTMLInputElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      clearSettleTimer();
      const value = Number(e.currentTarget.value);
      setScrubValue(null);
      if (governor) {
        governor.endScrub(value);
      } else {
        onSeek(value);
      }
    },
    [governor, onSeek, clearSettleTimer],
  );

  useEffect(
    () => () => {
      clearSettleTimer();
      clearKeySeekTimer();
    },
    [clearSettleTimer, clearKeySeekTimer],
  );

  // While dragging (or awaiting a keyboard-seek commit), the slider and the
  // progress fill follow the interaction, not the throttled page time.
  const displayTime = scrubValue ?? pendingSeek ?? currentTime;

  // F3: without a step the native step is 1 Unix-MILLISECOND — an arrow press
  // on a multi-day range moves nothing visible while still paying a committed
  // seek. The step also quantizes DRAG positions, so it must stay below ~1px
  // of a wide progress bar: 500 steps ≈ 0.2% per arrow press (PageUp/PageDown
  // get the browser's larger multiplier) while dragging stays visually
  // continuous.
  const sliderStep = Math.max(
    1,
    Math.round((timeRange.end - timeRange.start) / 500),
  );

  // ── Buffered ranges + ETA (the gray "buffered" bar + buffering chip) ───────
  const [bufferedRanges, setBufferedRanges] = useState<
    Array<{ start: number; end: number }>
  >([]);
  // Per-source runways (multi-source coordination Phase 4). Empty / single
  // entry → no extra UI (the single buffered bar already IS the required
  // intersection, i.e. exactly what the clock gates on). 2+ sources → a
  // compact per-source strip with the gating source highlighted.
  const [sourceRunways, setSourceRunways] = useState<SourceRunway[]>([]);
  const [etaMs, setEtaMs] = useState<number | null>(null);
  const [isCreeping, setIsCreeping] = useState(false);
  const isBuffering =
    bufferState === "starting" ||
    bufferState === "buffering" ||
    bufferState === "seeking";

  useEffect(() => {
    if (!governor) return;
    let lastProgressUpdate = 0;
    const update = () => {
      setBufferedRanges(governor.getBufferedRanges({ maxRanges: 64 }));
      // Probe per-source runways for the multi-track strip. `?.()` so a
      // governor built before this passthrough simply yields the single-bar
      // path (empty array) instead of throwing.
      setSourceRunways(
        (governor as GovernorWithSources).getSourceRunways?.() ?? [],
      );
      setIsCreeping(governor.isCreeping);
      setEtaMs(
        governor.state === "starting" ||
          governor.state === "buffering" ||
          governor.state === "seeking"
          ? governor.getEtaMs()
          : null,
      );
    };
    // ~1Hz poll while mounted, plus immediate (throttled) refresh on buffer
    // progress events so the bar tracks loading without waiting a second.
    const onProgress = () => {
      const now = performance.now();
      if (now - lastProgressUpdate < 250) return;
      lastProgressUpdate = now;
      update();
    };
    update();
    const intervalId = setInterval(update, 1000);
    governor.on("progress", onProgress);
    return () => {
      clearInterval(intervalId);
      governor.off("progress", onProgress);
    };
  }, [governor]);

  // ── Data-volume density strip (§5.1) ────────────────────────────────────────
  // One-shot sample of relative byte volume per timeline bucket, straight from
  // directory math. HONESTY CAVEAT: estimateCost counts only NOT-yet-loaded
  // tiles, so the profile is only true before loading eats into it — we sample
  // as early as possible (polling until the source attaches and reports a
  // nonzero total), freeze the first nonzero sample, and never resample. A
  // fully-cached dataset never yields a nonzero sample → no strip.
  const [density, setDensity] = useState<number[] | null>(null);

  useEffect(() => {
    setDensity(null);
    if (!governor) return;
    const g = governor as GovernorWithCost;
    const total = timeRange.end - timeRange.start;
    if (total <= 0) return;

    const sample = (): boolean => {
      const bytes: number[] = [];
      let sum = 0;
      for (let i = 0; i < DENSITY_BUCKETS; i++) {
        const cost = g.estimateCost({
          start: timeRange.start + (total * i) / DENSITY_BUCKETS,
          end: timeRange.start + (total * (i + 1)) / DENSITY_BUCKETS,
        });
        bytes.push(cost.bytes);
        sum += cost.bytes;
      }
      if (sum <= 0) return false;
      const max = Math.max(...bytes);
      setDensity(bytes.map((b) => b / max));
      return true;
    };

    if (sample()) return;
    let attempts = 0;
    const intervalId = setInterval(() => {
      attempts += 1;
      if (sample() || attempts >= 15) clearInterval(intervalId);
    }, 1000);
    return () => clearInterval(intervalId);
  }, [governor, timeRange.start, timeRange.end]);

  // ── Hover timestamp (§3.3) ──────────────────────────────────────────────────
  // Video-player convention: mousing over the bar shows the time you'd land
  // on. Mouse only — touch pointers are either dragging or gone, and the
  // dragged position already shows in the playhead label.
  const [hover, setHover] = useState<{
    x: number;
    width: number;
    time: number;
  } | null>(null);

  // Last hover anchor, kept so the preview card can stay positioned (and fade
  // out in place) after the cursor leaves, instead of jumping to the edge.
  const lastHoverRef = useRef<{ x: number; width: number } | null>(null);

  const handleBarPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== "mouse" || draggingRef.current || e.buttons !== 0) {
        setHover(null);
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = Math.min(
        1,
        Math.max(0, (e.clientX - rect.left) / rect.width),
      );
      const x = e.clientX - rect.left;
      lastHoverRef.current = { x, width: rect.width };
      setHover({
        x,
        width: rect.width,
        time: timeRange.start + frac * (timeRange.end - timeRange.start),
      });
    },
    [timeRange.start, timeRange.end],
  );

  const handleBarPointerLeave = useCallback(() => setHover(null), []);

  // ── YouTube-style hover preview (opt-in) ────────────────────────────────────
  // Only wired when the parent supplies `renderPreview`. `previewTime` is the
  // SETTLED time the preview frame renders at — debounced so a fast sweep
  // doesn't thrash the (expensive) live render; it re-renders only when the
  // cursor rests. The card stays mounted while enabled so its deck/archive
  // stays warm; it just fades on hover.
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const previewSettleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  // Seed the frozen preview at the live playhead whenever it's switched on, so
  // it shows something sensible before the first hover.
  useEffect(() => {
    if (previewEnabled) setPreviewTime(currentTimeRef.current);
  }, [previewEnabled]);

  // Settle-debounce: only advance the rendered frame once the cursor rests.
  useEffect(() => {
    if (!previewEnabled || !renderPreview || hover == null) return;
    const t = hover.time;
    if (previewSettleRef.current) clearTimeout(previewSettleRef.current);
    previewSettleRef.current = setTimeout(() => {
      previewSettleRef.current = null;
      setPreviewTime(t);
    }, PREVIEW_SETTLE_MS);
    return () => {
      if (previewSettleRef.current) clearTimeout(previewSettleRef.current);
    };
  }, [hover, previewEnabled, renderPreview]);

  const progress = useMemo(() => {
    const total = timeRange.end - timeRange.start;
    if (total === 0) return 0;
    return ((displayTime - timeRange.start) / total) * 100;
  }, [displayTime, timeRange]);

  const remainingSeconds = useMemo(() => {
    const remaining = (100 - progress) / 100;
    return (targetPlaybackSeconds / currentSpeedMultiplier) * remaining;
  }, [progress, targetPlaybackSeconds, currentSpeedMultiplier]);

  // ── Multi-source runway strip (multi-source coordination Phase 4) ───────────
  // Only meaningful with 2+ registered sources — a single source's runway is
  // already exactly the buffered bar, so single-dataset demos render no extra
  // chrome (graceful degrade). The gating source is the contract-defined one:
  // the REQUIRED entry with the smallest contiguous runway among those not yet
  // complete (i.e. the source the combined min-gate currently folds to). When
  // every required source is complete there's no live gate, so nothing is
  // highlighted. `runwaySimMs` is contiguous sim-ms ahead of the playhead, so
  // each source's resident segment maps straight onto the bar's sim-time axis
  // forward from the playhead (forward-at-nonneg-speed convention).
  const multiSource = sourceRunways.length >= 2;
  const gatingId = useMemo(() => {
    if (!multiSource) return null;
    let id: string | null = null;
    let min = Infinity;
    for (const r of sourceRunways) {
      if (!r.required || r.complete) continue;
      if (r.runwaySimMs < min) {
        min = r.runwaySimMs;
        id = r.id;
      }
    }
    return id;
  }, [sourceRunways, multiSource]);

  const speedPresets = [
    { label: "0.5x", value: 0.5 },
    { label: "1x", value: 1 },
    { label: "2x", value: 2 },
    { label: "5x", value: 5 },
    { label: "10x", value: 10 },
  ];

  const etaLabel =
    etaMs != null && Number.isFinite(etaMs) && etaMs > 0
      ? ` ~${Math.max(1, Math.round(etaMs / 1000))}s`
      : "…";

  // Tooltip x, clamped so it doesn't overflow the bar (half the tooltip's
  // approximate rendered width — ~22 monospace chars at 10px).
  const TOOLTIP_HALF_WIDTH = 70;
  const tooltipX = hover
    ? Math.min(
        Math.max(hover.x, TOOLTIP_HALF_WIDTH),
        Math.max(TOOLTIP_HALF_WIDTH, hover.width - TOOLTIP_HALF_WIDTH),
      )
    : 0;

  // Preview-card x, clamped to the bar (uses the persisted anchor so it holds
  // position while fading out). Falls back to the live hover anchor.
  const previewAnchor = hover ?? lastHoverRef.current;
  const previewX = previewAnchor
    ? Math.min(
        Math.max(previewAnchor.x, PREVIEW_MAX_W / 2),
        Math.max(PREVIEW_MAX_W / 2, previewAnchor.width - PREVIEW_MAX_W / 2),
      )
    : 0;

  return (
    <div className="space-y-3">
      {/* Time display */}
      <div className="flex justify-between items-center">
        <span
          className="text-xs font-medium font-mono"
          style={{ color: "var(--ink-900)" }}
        >
          {formatDate(displayTime)}
          <span style={{ color: "var(--ink-400)" }}> UTC</span>
        </span>
        {/* Status chip — polite live region so screen readers hear buffering /
            creep transitions without focus moving (§3.2). */}
        <span aria-live="polite">
          {isBuffering ? (
            <span
              className="text-[10px] flex items-center gap-1.5"
              style={{ color: "var(--ink-500)" }}
            >
              <span
                className="w-2.5 h-2.5 rounded-full border-2 animate-spin"
                style={{
                  borderColor: "var(--accent)",
                  borderTopColor: "transparent",
                }}
              />
              Buffering{etaLabel}
            </span>
          ) : (
            <span
              className="text-[10px] flex items-center gap-1.5"
              style={{ color: "var(--ink-500)" }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background: isPlaying ? "var(--accent)" : "var(--ink-400)",
                }}
              />
              {/* Under degraded creep the playhead advances at data-arrival
                  rate, so the nominal-speed countdown is fiction — be honest
                  about what's happening instead (§3.4). */}
              {isPlaying
                ? isCreeping
                  ? "playing as data arrives"
                  : `${formatDuration(remainingSeconds)} left`
                : "Paused"}
            </span>
          )}
        </span>
      </div>

      {/* Density strip + progress bar (kept adjacent inside one block so the
          parent's space-y doesn't separate them). */}
      <div>
        {density && <DensityStrip density={density} />}

        {/* Progress bar */}
        <div
          className="relative h-1.5 rounded-full cursor-pointer"
          style={{ background: "var(--hairline)" }}
          onPointerMove={handleBarPointerMove}
          onPointerLeave={handleBarPointerLeave}
        >
          {/* YouTube-style preview card — sits above the timestamp tooltip.
              Stays mounted while enabled (keeps its deck/archive warm) and
              fades on hover; renders the map at the settled hovered time. */}
          {previewEnabled && renderPreview && (
            <div
              aria-hidden="true"
              className="absolute"
              style={{
                left: previewX,
                bottom: "100%",
                transform: "translate(-50%, -22px)",
                pointerEvents: "none",
                opacity: hover ? 1 : 0,
                transition: "opacity 120ms ease",
                zIndex: 60,
              }}
            >
              <div
                style={{
                  display: "inline-block",
                  // Card hugs the preview, which sizes itself to the live
                  // viewport's aspect ratio (see HoverPreview).
                  lineHeight: 0,
                  borderRadius: 6,
                  overflow: "hidden",
                  border: "1px solid var(--hairline)",
                  boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
                  background: "var(--page-bg)",
                }}
              >
                {renderPreview(previewTime ?? displayTime)}
              </div>
            </div>
          )}
          {/* Hover timestamp tooltip (§3.3). */}
          {hover && (
            <div
              aria-hidden="true"
              className="absolute text-[10px] font-mono whitespace-nowrap px-1.5 py-0.5 rounded"
              style={{
                left: tooltipX,
                bottom: "100%",
                transform: "translate(-50%, -4px)",
                pointerEvents: "none",
                background: "var(--surface)",
                color: "var(--ink-900)",
                border: "1px solid var(--hairline)",
                boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
              }}
            >
              {formatDate(hover.time)}
            </div>
          )}
          {/* Buffered ranges — the translucent "loaded" bar every video player
              has, straight from the tileset's coverage index. */}
          {bufferedRanges.map((range, i) => {
            const total = timeRange.end - timeRange.start;
            if (total <= 0) return null;
            const left = Math.max(
              0,
              Math.min(100, ((range.start - timeRange.start) / total) * 100),
            );
            const right = Math.max(
              0,
              Math.min(100, ((range.end - timeRange.start) / total) * 100),
            );
            if (right - left <= 0) return null;
            return (
              <div
                key={i}
                aria-hidden="true"
                className="absolute top-0 h-full rounded-full"
                style={{
                  left: `${left}%`,
                  width: `${right - left}%`,
                  background: "var(--ink-400)",
                  opacity: 0.35,
                }}
              />
            );
          })}
          <div
            aria-hidden="true"
            className="absolute left-0 top-0 h-full rounded-full"
            style={{ width: `${progress}%`, background: "var(--accent)" }}
          />
          <input
            type="range"
            aria-label="Playback position"
            aria-valuetext={formatDate(displayTime)}
            min={timeRange.start}
            max={timeRange.end}
            step={sliderStep}
            value={displayTime}
            onPointerDown={handleScrubStart}
            onChange={handleSliderChange}
            onPointerUp={handleScrubEnd}
            onPointerCancel={handleScrubEnd}
            onBlur={handleScrubEnd}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>

        {/* Per-source runway strip — only with 2+ registered sources; a single
            source's runway already equals the buffered bar above. */}
        {multiSource && (
          <SourceRunwayStrip
            sources={sourceRunways}
            gatingId={gatingId}
            playheadFrac={progress / 100}
            rangeMs={timeRange.end - timeRange.start}
          />
        )}
      </div>

      {/* Time range labels */}
      <div className="flex justify-between">
        <span className="text-[9px]" style={{ color: "var(--ink-400)" }}>
          {formatDate(timeRange.start)}
        </span>
        <span className="text-[9px]" style={{ color: "var(--ink-400)" }}>
          {formatDate(timeRange.end)}
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Play/Pause + restart. Geometry is set inline (not via Tailwind w-/h-
            utilities) so the buttons keep their dimensions in any consumer —
            a published package can't rely on the host app's Tailwind content
            scan reaching node_modules. Crisp SVG glyphs replace the old emoji,
            which rendered at platform-dependent sizes/baselines. */}
        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            onClick={onPlayPause}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="transition-colors"
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 12,
              border: "none",
              cursor: "pointer",
              background: "var(--accent)",
              color: "#FFFFFF",
            }}
          >
            {isPlaying ? (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M6 5h3.5v14H6zM14.5 5H18v14h-3.5z" />
              </svg>
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                style={{ marginLeft: 1 }}
              >
                <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.3-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z" />
              </svg>
            )}
          </button>
          <button
            onClick={() => onSeek(timeRange.start)}
            aria-label="Restart from beginning"
            className="transition-colors"
            style={{
              width: 32,
              height: 32,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              cursor: "pointer",
              background: "var(--surface)",
              color: "var(--ink-500)",
              border: "1px solid var(--hairline)",
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M7 6a1 1 0 0 0-1 1v10a1 1 0 0 0 2 0V7a1 1 0 0 0-1-1zm10.5.13L10.2 11.2a1 1 0 0 0 0 1.6l7.3 5.07A1 1 0 0 0 19 17.06V6.94a1 1 0 0 0-1.5-.81z" />
            </svg>
          </button>
        </div>

        {/* Speed presets */}
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Playback speed"
        >
          <span
            className="text-[10px] mr-1 hidden sm:inline"
            style={{ color: "var(--ink-500)" }}
          >
            Speed:
          </span>
          {speedPresets.map((preset) => {
            // Tight epsilon: the slider steps at 0.25, so exact preset values
            // are representable — a loose 0.1 epsilon lit presets for values
            // they don't equal (§3.6).
            const isActive =
              !autoSpeed &&
              Math.abs(currentSpeedMultiplier - preset.value) < 0.01;
            return (
              <button
                key={preset.value}
                onClick={() => onSpeedChange(preset.value)}
                aria-pressed={isActive}
                className="px-2 py-1 rounded text-[10px] transition-colors"
                style={{
                  background: isActive ? "var(--accent-soft)" : "transparent",
                  color: isActive ? "var(--accent)" : "var(--ink-500)",
                  border: `1px solid ${isActive ? "var(--accent)" : "var(--hairline)"}`,
                }}
              >
                {preset.label}
              </button>
            );
          })}
          {/* Opt-in Auto speed: the governor caps speed at what the measured
              network can sustain; the resolved value is shown ("Auto 2.5x").
              Selecting any explicit preset/slider value exits Auto. */}
          <button
            onClick={onAutoSpeedSelect}
            aria-pressed={autoSpeed}
            className="px-2 py-1 rounded text-[10px] transition-colors"
            style={{
              background: autoSpeed ? "var(--accent-soft)" : "transparent",
              color: autoSpeed ? "var(--accent)" : "var(--ink-500)",
              border: `1px solid ${autoSpeed ? "var(--accent)" : "var(--hairline)"}`,
            }}
            title="Match playback speed to what the network can sustain"
          >
            {autoSpeed ? `Auto ${currentSpeedMultiplier.toFixed(1)}x` : "Auto"}
          </button>
        </div>

        {/* Fine slider — max matches the presets and Auto's clamp (§3.6). */}
        <div className="flex-1 flex items-center gap-2 min-w-0 hidden md:flex">
          <input
            type="range"
            aria-label="Playback speed multiplier"
            min="0.25"
            max="10"
            step="0.25"
            value={currentSpeedMultiplier}
            onChange={(e) => onSpeedChange(Number(e.target.value))}
            className="flex-1 h-1 cursor-pointer"
            style={{ accentColor: "var(--accent)" }}
          />
          <span
            className="text-[10px] font-medium min-w-[32px] text-right"
            style={{ color: "var(--ink-900)" }}
          >
            {currentSpeedMultiplier.toFixed(1)}x
          </span>
        </div>

        {/* Opt-in hover preview toggle (only when the parent can render one).
            Pushed to the trailing edge by the flex-1 speed slider on md+. */}
        {renderPreview && (
          <button
            onClick={() => setPreviewEnabled((v) => !v)}
            aria-pressed={previewEnabled}
            className="ml-auto px-2 py-1 rounded text-[10px] transition-colors flex items-center gap-1"
            style={{
              background: previewEnabled ? "var(--accent-soft)" : "transparent",
              color: previewEnabled ? "var(--accent)" : "var(--ink-500)",
              border: `1px solid ${previewEnabled ? "var(--accent)" : "var(--hairline)"}`,
            }}
            title="Show a rendered preview of the map at the hovered time"
          >
            <span aria-hidden="true">▦</span> Preview
          </button>
        )}
      </div>
    </div>
  );
};

