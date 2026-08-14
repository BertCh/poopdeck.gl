// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  PlaybackGovernor,
  PlaybackGovernorState,
  SourceRunway,
} from '@poopdeck.gl/playback';
import { useReducedMotion } from '../hooks/use-reduced-motion.js';
import { PLAYBACK_SHORTCUTS } from '../hooks/use-playback-hotkeys.js';

export interface PlaybackControlsProps {
  currentTime: number;
  timeRange: { start: number; end: number };
  /** User intent (drives the play/pause glyph); the governor may still be gating. */
  isPlaying: boolean;
  /**
   * Parked at a non-looping range boundary (the media-element `ended` bit —
   * `usePlayback` mirrors it off the governor). Swaps the play glyph for a
   * replay glyph; pressing it restarts from the range start, which the
   * governor's `requestPlay` already implements.
   */
  ended?: boolean;
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
  /**
   * How long the full range should take to play at 1× — drives the remaining-
   * time readout. Default 60. (Matches `usePlayback`'s convention of
   * `baseSpeed = (end - start) / (target * 1000)`.)
   */
  targetPlaybackSeconds?: number;
  /** Whether the opt-in Auto speed mode is active. */
  autoSpeed: boolean;
  /** Select Auto speed mode (any explicit preset/slider choice exits it). */
  onAutoSpeedSelect: () => void;
  /** Current loop state. Only rendered when `onLoopToggle` is also supplied. */
  loop?: boolean;
  /** Supply to render the loop toggle (media-element `loop`). */
  onLoopToggle?: () => void;
  /**
   * Set on surfaces that also mount {@link usePlaybackHotkeys}. Adds a
   * shortcuts disclosure and appends the key to each button's tooltip. Off by
   * default because an embed page that does NOT mount the hotkeys would
   * otherwise advertise keys that do nothing.
   */
  keyboardShortcuts?: boolean;
  /**
   * Optional YouTube-style hover preview. When supplied, a "Preview" toggle
   * appears; while enabled, hovering the scrubber shows a card above it
   * rendering the map at the (settle-debounced) hovered time. The parent owns
   * the actual render (it has the deck/camera context) — we just call this with
   * the hovered timestamp. Omit it and nothing about the bar changes.
   */
  renderPreview?: (time: number) => React.ReactNode;
  /** Merged onto the root element (the bar is otherwise unopinionated). */
  className?: string;
  /** Merged onto the root element — the usual place to re-map the theme tokens. */
  style?: React.CSSProperties;
}

/** Upper bound on the hover-preview card width (matches HoverPreview's
 *  `maxWidth`); the card itself hugs the live viewport's aspect ratio, so we
 *  only need the max for keeping it on-screen. */
const PREVIEW_MAX_W = 264;
/** Cursor must rest this long before the (expensive) preview frame re-renders. */
const PREVIEW_SETTLE_MS = 120;

/**
 * Scrub hit area, vertically. The PAINTED track is 6px (8px while active) but
 * a 6px pointer target fails WCAG 2.5.8 (24×24 minimum) and is miserable on
 * touch, so the input covers a padded box: 9 + 6 + 9 = 24px even with no
 * density strip. Video players do the same thing — YouTube's visible bar is a
 * few px inside a much taller grab region.
 */
const SCRUB_PAD_Y = 9;

/** Coarse keyboard seek on the scrubber — deliberately the same 2% the global
 *  hotkey map uses, so the step does not change depending on what has focus. */
const SEEK_STEP_FRACTION = 0.02;
/** PageUp/PageDown on the scrubber, and the skip buttons. */
const LONG_STEP_FRACTION = 0.1;

/** All timestamps in the player are dataset time — global scientific datasets
 *  (drifters, satellites, ECCO) are authored in UTC, so the labels must not
 *  drift with the viewer's locale zone. The LOCALE is left to the viewer
 *  (`undefined`): pinning the zone is a correctness requirement, pinning
 *  month/day order to en-US was never one. */
const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
};

/**
 * ONE `Intl.DateTimeFormat`, built on first use and reused.
 *
 * This was `new Date(t).toLocaleString(undefined, {...})`, which is not the
 * cheap call it looks like: every invocation re-normalizes the option bag and
 * resolves a formatter. The transport bar renders on the 10 Hz UI clock and
 * formats at least four timestamps per render (the playhead label, its
 * `aria-valuetext`, and both range endpoints), so that was ~80 formatter
 * resolutions a second for four strings — 1.1 % of total CPU on the
 * `ocean-drifters` profile, spent entirely on the transport bar.
 *
 * Built lazily rather than at module scope so the module stays importable in
 * an environment without a full `Intl` (SSR shims), and so the viewer's locale
 * is read when the player first renders rather than at bundle-eval time.
 */
let dateFormatter: Intl.DateTimeFormat | null = null;

const formatDate = (timestamp: number): string => {
  // `toLocaleString` degraded to the string 'Invalid Date' on a non-finite
  // timestamp; `Intl.DateTimeFormat.format` THROWS a RangeError instead. Keep
  // the old, non-fatal behaviour — a malformed range should render a bad label,
  // not take the whole transport bar down with it.
  if (!Number.isFinite(timestamp)) return 'Invalid Date';
  dateFormatter ??= new Intl.DateTimeFormat(undefined, DATE_FORMAT_OPTIONS);
  return dateFormatter.format(timestamp);
};

/** `M:SS` / `H:MM:SS` — the readout shape every video player uses. */
const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const DAY_MS = 86_400_000;

/**
 * A span of DATASET time for the elapsed/total readout. This is the analogue of
 * media time — it does not move when the speed multiplier changes, exactly like
 * a video's `currentTime / duration`. Scales its unit because STT ranges run
 * from a 60-second AV log to the 43-year drifter archive.
 */
const formatSpan = (ms: number): string => {
  const t = Math.max(0, ms);
  if (t < DAY_MS) return formatClock(t / 1000);
  const days = Math.floor(t / DAY_MS);
  if (days < 365) {
    const hours = Math.floor((t % DAY_MS) / 3_600_000);
    return `${days}d ${String(hours).padStart(2, '0')}h`;
  }
  return `${Math.floor(days / 365)}y ${days % 365}d`;
};

const DENSITY_BUCKETS = 80;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Cheap structural equality so the 1Hz poll below can skip no-op re-renders. */
const sameRanges = (
  a: Array<{ start: number; end: number }>,
  b: Array<{ start: number; end: number }>,
) =>
  a.length === b.length &&
  a.every((r, i) => r.start === b[i].start && r.end === b[i].end);

const sameRunways = (a: SourceRunway[], b: SourceRunway[]) =>
  a.length === b.length &&
  a.every(
    (r, i) =>
      r.id === b[i].id &&
      r.runwaySimMs === b[i].runwaySimMs &&
      r.complete === b[i].complete &&
      r.required === b[i].required,
  );

// ── Icons ───────────────────────────────────────────────────────────────────
// Crisp SVG rather than emoji/box-drawing glyphs, which render at
// platform-dependent sizes and baselines.

type IconProps = { size?: number };
const svg = (d: string, size: number, extra?: React.CSSProperties) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
    style={extra}
  >
    <path d={d} />
  </svg>
);

const PauseIcon: React.FC<IconProps> = ({ size = 18 }) =>
  svg('M6 5h3.5v14H6zM14.5 5H18v14h-3.5z', size);
const PlayIcon: React.FC<IconProps> = ({ size = 18 }) =>
  svg(
    'M8 5.14v13.72a1 1 0 0 0 1.54.84l10.3-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z',
    size,
    { marginLeft: 1 },
  );
const ReplayIcon: React.FC<IconProps> = ({ size = 18 }) =>
  svg('M12 5V1.5L7.2 6.3 12 11.1V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z', size);
const ToStartIcon: React.FC<IconProps> = ({ size = 15 }) =>
  svg(
    'M7 6a1 1 0 0 0-1 1v10a1 1 0 0 0 2 0V7a1 1 0 0 0-1-1zm10.5.13L10.2 11.2a1 1 0 0 0 0 1.6l7.3 5.07A1 1 0 0 0 19 17.06V6.94a1 1 0 0 0-1.5-.81z',
    size,
  );
const RewindIcon: React.FC<IconProps> = ({ size = 15 }) =>
  svg('M11.5 6.5v11L4 12l7.5-5.5zm8 0v11L12 12l7.5-5.5z', size);
const ForwardIcon: React.FC<IconProps> = ({ size = 15 }) =>
  svg('M12.5 6.5L20 12l-7.5 5.5v-11zm-8 0L12 12l-7.5 5.5v-11z', size);
const LoopIcon: React.FC<IconProps> = ({ size = 15 }) =>
  svg(
    'M7 7h9v2.5l4-3.5-4-3.5V5H5v6h2V7zm10 10H8v-2.5l-4 3.5 4 3.5V19h11v-6h-2v4z',
    size,
  );
const PreviewIcon: React.FC<IconProps> = ({ size = 12 }) =>
  svg(
    'M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h16V6H4zm4 8.5l2.2 2.5 3-3.8L18 17H6l2-2.5z',
    size,
  );
const HelpIcon: React.FC<IconProps> = ({ size = 12 }) =>
  svg(
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 15.4a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm1.5-5.5c-.6.4-.8.66-.8 1.1v.3h-1.5v-.45c0-.95.44-1.5 1.16-2 .62-.43.87-.68.87-1.16 0-.57-.47-1-1.15-1-.72 0-1.2.43-1.34 1.1l-1.4-.42c.3-1.2 1.26-1.97 2.66-1.97 1.5 0 2.6.87 2.6 2.22 0 1-.48 1.53-1.1 2.02z',
    size,
  );

// ── Leaf controls ───────────────────────────────────────────────────────────

/**
 * Hover / active / focus-visible state is held per-button in React and composed
 * into the inline style, because the geometry and colours MUST be inline: a
 * published package cannot rely on the host app's Tailwind content scan reaching
 * `node_modules`, and an inline `background` would beat any `:hover` class we
 * shipped anyway. A `transition-colors` class is therefore inert here — nothing
 * it can animate ever changes — so a button that leans on one instead of this
 * state has no hover feedback at all.
 */
const useInteractiveState = () => {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const handlers = {
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => {
      setHovered(false);
      setPressed(false);
    },
    onPointerDown: () => setPressed(true),
    onPointerUp: () => setPressed(false),
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      // Only ring for keyboard focus. Browsers (and jsdom) without
      // :focus-visible support throw on matches() — fall back to ringing.
      try {
        setFocusRing(e.currentTarget.matches(':focus-visible'));
      } catch {
        setFocusRing(true);
      }
    },
    onBlur: () => {
      setFocusRing(false);
      setPressed(false);
    },
  };
  return { hovered, pressed, focusRing, handlers };
};

const focusOutline = (on: boolean): React.CSSProperties =>
  on
    ? { outline: '2px solid var(--accent)', outlineOffset: 2 }
    : { outline: 'none' };

const IconButton: React.FC<{
  onClick: () => void;
  label: string;
  title?: string;
  tone?: 'primary' | 'ghost';
  size?: number;
  radius?: number;
  active?: boolean;
  ariaExpanded?: boolean;
  ariaControls?: string;
  children: React.ReactNode;
}> = ({
  onClick,
  label,
  title,
  tone = 'ghost',
  size = 32,
  radius = 10,
  active,
  ariaExpanded,
  ariaControls,
  children,
}) => {
  const { hovered, pressed, focusRing, handlers } = useInteractiveState();
  const primary = tone === 'primary';
  // brightness() rather than a second colour token: it works for whatever
  // --accent the consumer themed in, light or dark.
  const filter = pressed
    ? 'brightness(0.92)'
    : hovered
      ? 'brightness(1.12)'
      : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      aria-pressed={active}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      {...handlers}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius,
        cursor: 'pointer',
        padding: 0,
        background: primary
          ? 'var(--accent)'
          : active
            ? 'var(--accent-soft)'
            : hovered
              ? 'var(--accent-soft)'
              : 'var(--surface)',
        color: primary
          ? '#FFFFFF'
          : active
            ? 'var(--accent)'
            : hovered
              ? 'var(--ink-900)'
              : 'var(--ink-500)',
        border: primary
          ? 'none'
          : `1px solid ${active ? 'var(--accent)' : 'var(--hairline)'}`,
        filter,
        ...focusOutline(focusRing),
      }}
    >
      {children}
    </button>
  );
};

/**
 * One speed choice. A REAL radio inside a label, not a button with
 * `aria-pressed`: the presets and Auto are mutually exclusive, which is a radio
 * group, and the native element brings roving arrow-key traversal and the
 * checked state for free instead of faking both. The input is visually hidden
 * (`sr-only`), so the focus ring lives on the label.
 */
const SpeedOption: React.FC<{
  name: string;
  label: string;
  title?: string;
  checked: boolean;
  onSelect: () => void;
}> = ({ name, label, title, checked, onSelect }) => {
  const { hovered, focusRing, handlers } = useInteractiveState();
  return (
    <label
      title={title}
      onPointerEnter={handlers.onPointerEnter}
      onPointerLeave={handlers.onPointerLeave}
      className="rounded text-[10px] select-none"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        // WCAG 2.5.8: the old px-2 py-1 chips computed to ~22px.
        minHeight: 24,
        padding: '0 8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        background: checked || hovered ? 'var(--accent-soft)' : 'transparent',
        color: checked
          ? 'var(--accent)'
          : hovered
            ? 'var(--ink-900)'
            : 'var(--ink-500)',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--hairline)'}`,
        ...focusOutline(focusRing),
      }}
    >
      <input
        type="radio"
        name={name}
        className="sr-only"
        checked={checked}
        onChange={onSelect}
        onFocus={handlers.onFocus}
        onBlur={handlers.onBlur}
      />
      {label}
    </label>
  );
};

/** Faint per-bucket "where the data is" strip above the scrubber. Purely
 *  decorative and `aria-hidden`; the timestamps around it already carry the
 *  information in words. It sits INSIDE the scrub hit area, so clicking the
 *  histogram seeks (which is what everyone tries first). It carries no `title`
 *  tooltip: the transparent range input covers the strip, and the bar shows its
 *  own hover timestamp instead. */
const DensityStrip: React.FC<{ density: number[] }> = ({ density }) => (
  <div
    aria-hidden="true"
    className="flex items-end w-full"
    style={{ height: 9, marginBottom: 2, pointerEvents: 'none' }}
  >
    {density.map((v, i) => (
      <div
        key={i}
        style={{
          flex: 1,
          // Floor nonzero buckets at 1px so sparse-but-present time still reads.
          height: v > 0 ? `${Math.max(v * 100, 12)}%` : 0,
          background: 'var(--ink-400)',
          opacity: 0.15,
        }}
      />
    ))}
  </div>
);

/**
 * A compact per-source runway strip, shown only when 2+ sources are registered
 * (single-source demos show the plain buffered bar and nothing more). Each
 * source gets one thin track; the filled portion
 * is that source's contiguous resident runway ahead of the playhead, mapped
 * onto the bar's sim-time axis (forward from the playhead). The GATING source
 * (the required, not-yet-complete source with the least runway — what the clock
 * is held by) is drawn in the accent colour; other required sources are inked;
 * optional (non-gating) sources are faint. Decorative and `aria-hidden` (the
 * per-track `title` is therefore a mouse-only hint, NOT an AT affordance — the
 * live status chip is what announces buffering to a screen reader). No
 * animation, so it is inert under prefers-reduced-motion by construction.
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
          ? clamp(s.runwaySimMs / rangeMs, 0, 1)
          : 0;
      const left = clamp(playheadFrac * 100, 0, 100);
      const width = Math.min(100 - left, runwayFrac * 100);
      const isGating = s.id === gatingId;
      const color = isGating
        ? 'var(--accent)'
        : s.required
          ? 'var(--ink-500)'
          : 'var(--ink-400)';
      const labelKind = s.required
        ? isGating
          ? 'gating — clock is held here'
          : 'required'
        : 'optional';
      return (
        <div
          key={s.id}
          title={`${s.id}: ${labelKind}${s.complete ? ' (complete)' : ''}`}
          className="relative w-full rounded-full"
          style={{ height: 2, background: 'var(--hairline)' }}
        >
          {/* A bone-dry source (runway 0) still paints a minimum-width nub at
              the playhead — otherwise the one source actually HOLDING the
              clock is the only one with no marker. CSS max()/min() keep the
              nub visible without ever painting past the bar's right edge. */}
          <div
            className="absolute top-0 h-full rounded-full"
            style={{
              left: `min(${left}%, calc(100% - 3px))`,
              width: `max(${width}%, 3px)`,
              background: color,
              opacity: isGating ? 0.95 : s.required ? 0.55 : 0.3,
            }}
          />
        </div>
      );
    })}
  </div>
);

const SPEED_PRESETS = [
  { label: '0.5x', value: 0.5 },
  { label: '1x', value: 1 },
  { label: '2x', value: 2 },
  { label: '5x', value: 5 },
  { label: '10x', value: 10 },
] as const;

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  currentTime,
  timeRange,
  isPlaying,
  ended = false,
  bufferState,
  governor,
  onPlayPause,
  onSeek,
  onSpeedChange,
  currentSpeedMultiplier,
  targetPlaybackSeconds = 60,
  autoSpeed,
  onAutoSpeedSelect,
  loop,
  onLoopToggle,
  keyboardShortcuts = false,
  renderPreview,
  className,
  style,
}) => {
  const reducedMotion = useReducedMotion();
  const rangeMs = timeRange.end - timeRange.start;
  // One radio-group name per mounted bar — native radios group by name, and a
  // hardcoded one would fuse two mounted players into a single group.
  const speedGroup = useId();
  const shortcutsId = useId();

  // ── Drag-aware scrubbing ────────────────────────────────────────────────────
  // While the thumb is held, every move is a PREVIEW (instant feedback from
  // whatever tiles are resident — no fetch churn); the real seek commits on
  // release, or early if the position rests unchanged for the governor's
  // settle window while still dragging. Keyboard steps go through the same
  // settle debounce so a held key produces ONE committed seek, not a
  // flushPrefetch storm.
  const draggingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keySeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  // Mirrors draggingRef for RENDER (the ref alone can't thicken the track).
  const [scrubbing, setScrubbing] = useState(false);
  const [sliderFocused, setSliderFocused] = useState(false);
  // Keyboard/programmatic position awaiting its settle-debounced commit;
  // shown immediately (like scrubValue) so arrows feel instant.
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  // Ref twin of pendingSeek: a held arrow key repeats faster than React
  // commits, so the NEXT step has to accumulate off the last value we chose,
  // not off whatever the last committed render happened to show.
  const pendingSeekRef = useRef<number | null>(null);
  const currentTimeRef = useRef(currentTime);
  // Written in an effect, not during render (React 19 forbids render-phase ref
  // writes — a discarded concurrent render must not leave a value behind).
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

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

  const setPending = useCallback((value: number | null) => {
    pendingSeekRef.current = value;
    setPendingSeek(value);
  }, []);

  /** Show `value` immediately; commit it once the position rests. */
  const queueSeek = useCallback(
    (value: number) => {
      setPending(value);
      clearKeySeekTimer();
      keySeekTimerRef.current = setTimeout(() => {
        keySeekTimerRef.current = null;
        setPending(null);
        onSeek(value);
      }, governor?.seekSettleMs ?? 200);
    },
    [governor, onSeek, clearKeySeekTimer, setPending],
  );

  const handleScrubStart = useCallback(() => {
    draggingRef.current = true;
    setScrubbing(true);
    // The drag takes over: drop any pending keyboard commit (release will
    // commit the dragged position anyway).
    clearKeySeekTimer();
    setPending(null);
    governor?.beginScrub();
  }, [governor, clearKeySeekTimer, setPending]);

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
        // Programmatic change (keyboard is intercepted in onKeyDown below).
        queueSeek(value);
      }
    },
    [governor, clearSettleTimer, queueSeek],
  );

  const handleScrubEnd = useCallback(
    (e: React.SyntheticEvent<HTMLInputElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setScrubbing(false);
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

  /**
   * The scrubber's own arrow keys. Handled explicitly rather than left to the
   * input's native `step` because `step` also quantizes DRAGGING, so it has to
   * stay tiny (0.2%) — which made an arrow press on the focused scrubber move
   * a tenth of what the same arrow does when focus is elsewhere. Both paths now
   * step 2%, PageUp/PageDown 10%.
   */
  const handleSliderKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (rangeMs <= 0) return;
      const base =
        pendingSeekRef.current ?? scrubValue ?? currentTimeRef.current;
      let next: number;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          next = base - rangeMs * SEEK_STEP_FRACTION;
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          next = base + rangeMs * SEEK_STEP_FRACTION;
          break;
        case 'PageDown':
          next = base - rangeMs * LONG_STEP_FRACTION;
          break;
        case 'PageUp':
          next = base + rangeMs * LONG_STEP_FRACTION;
          break;
        case 'Home':
          next = timeRange.start;
          break;
        case 'End':
          next = timeRange.end;
          break;
        default:
          return;
      }
      // Suppress the native step so ours is the only movement.
      e.preventDefault();
      queueSeek(clamp(next, timeRange.start, timeRange.end));
    },
    [rangeMs, scrubValue, timeRange.start, timeRange.end, queueSeek],
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

  // Drag quantization only: 500 steps ≈ 0.2% keeps a drag visually continuous
  // on a wide bar. Keyboard granularity does NOT ride on this (see
  // handleSliderKeyDown): the native minimum — 1 Unix MILLISECOND — would make a
  // multi-day range's arrow press move nothing at all.
  const sliderStep = Math.max(1, Math.round(rangeMs / 500));

  // ── Buffered ranges + ETA (the gray "buffered" bar + buffering chip) ───────
  const [bufferedRanges, setBufferedRanges] = useState<
    Array<{ start: number; end: number }>
  >([]);
  // Per-source runways. Empty / single entry → no extra UI (the single buffered
  // bar already IS the required intersection, i.e. exactly what the clock gates
  // on). 2+ sources → a compact per-source strip with the gating source
  // highlighted.
  const [sourceRunways, setSourceRunways] = useState<SourceRunway[]>([]);
  const [etaMs, setEtaMs] = useState<number | null>(null);
  const [isCreeping, setIsCreeping] = useState(false);
  const isBuffering =
    bufferState === 'starting' ||
    bufferState === 'buffering' ||
    bufferState === 'seeking';

  useEffect(() => {
    if (!governor) return;
    let lastProgressUpdate = 0;
    const update = () => {
      // Poll results are fresh arrays every tick; without the equality guards
      // this effect re-rendered the whole bar once a second forever, including
      // while paused with nothing loading.
      const ranges = governor.getBufferedRanges({ maxRanges: 64 });
      setBufferedRanges((prev) => (sameRanges(prev, ranges) ? prev : ranges));
      // Probe per-source runways for the multi-track strip. `?.()` guards the
      // one case the types can't: `governor` comes from the host app, which can
      // pin an @poopdeck.gl/playback older than this @poopdeck.gl/react — a
      // governor without the passthrough then yields the single-bar path
      // (empty array) instead of throwing on every poll tick.
      const runways = governor.getSourceRunways?.() ?? [];
      setSourceRunways((prev) => (sameRunways(prev, runways) ? prev : runways));
      setIsCreeping(governor.isCreeping);
      setEtaMs(
        governor.state === 'starting' ||
          governor.state === 'buffering' ||
          governor.state === 'seeking'
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
    governor.on('progress', onProgress);
    return () => {
      clearInterval(intervalId);
      governor.off('progress', onProgress);
    };
  }, [governor]);

  // ── Data-volume density strip ───────────────────────────────────────────────
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
    const total = timeRange.end - timeRange.start;
    if (total <= 0) return;

    const sample = (): boolean => {
      const bytes: number[] = [];
      let sum = 0;
      for (let i = 0; i < DENSITY_BUCKETS; i++) {
        const cost = governor.estimateCost({
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

  // ── Hover timestamp ─────────────────────────────────────────────────────────
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
  // Pointer moves arrive faster than the screen refreshes, and every one used
  // to setState → a full re-render of the bar (80 density bars, up to 64
  // buffered segments) per move event. Coalesce to one per frame.
  const hoverRafRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<{
    x: number;
    width: number;
    time: number;
  } | null>(null);

  const cancelHoverRaf = useCallback(() => {
    if (hoverRafRef.current != null) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
  }, []);

  const handleBarPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'mouse' || draggingRef.current || e.buttons !== 0) {
        cancelHoverRaf();
        setHover(null);
        return;
      }
      // Read the rect synchronously — currentTarget is null inside the rAF.
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      pendingHoverRef.current = {
        x: e.clientX - rect.left,
        width: rect.width,
        time: timeRange.start + frac * rangeMs,
      };
      if (hoverRafRef.current != null) return;
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = null;
        const next = pendingHoverRef.current;
        if (!next) return;
        lastHoverRef.current = { x: next.x, width: next.width };
        setHover(next);
      });
    },
    [timeRange.start, rangeMs, cancelHoverRaf],
  );

  const handleBarPointerLeave = useCallback(() => {
    cancelHoverRaf();
    setHover(null);
  }, [cancelHoverRaf]);

  useEffect(() => cancelHoverRaf, [cancelHoverRaf]);

  // ── YouTube-style hover preview (opt-in) ────────────────────────────────────
  // Only wired when the parent supplies `renderPreview`. `previewTime` is the
  // SETTLED time the preview frame renders at — debounced so a fast sweep
  // doesn't thrash the (expensive) live render; it re-renders only when the
  // cursor rests. The card stays mounted while enabled so its deck/archive
  // stays warm; it just fades on hover.
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const previewSettleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── Shortcuts disclosure ────────────────────────────────────────────────────
  const [showShortcuts, setShowShortcuts] = useState(false);
  const shortcutsWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showShortcuts) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!shortcutsWrapRef.current?.contains(e.target as Node)) {
        setShowShortcuts(false);
      }
    };
    // Standard disclosure dismissal. Handled at the document so it works from
    // wherever focus is, and captured so a host Escape handler doesn't win.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowShortcuts(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [showShortcuts]);

  const progress =
    rangeMs === 0 ? 0 : ((displayTime - timeRange.start) / rangeMs) * 100;
  const remainingSeconds =
    (targetPlaybackSeconds / currentSpeedMultiplier) * ((100 - progress) / 100);

  // ── Multi-source runway strip ───────────────────────────────────────────────
  // Only meaningful with 2+ registered sources — a single source's runway is
  // already exactly the buffered bar, so single-dataset demos render no extra
  // chrome (graceful degrade). The gating source is the contract-defined one:
  // the REQUIRED entry with the smallest contiguous runway among those not yet
  // complete (i.e. the source the combined min-gate currently folds to). When
  // every required source is complete there's no live gate, so nothing is
  // highlighted.
  const multiSource = sourceRunways.length >= 2;
  let gatingId: string | null = null;
  if (multiSource) {
    let min = Infinity;
    for (const r of sourceRunways) {
      if (!r.required || r.complete) continue;
      if (r.runwaySimMs < min) {
        min = r.runwaySimMs;
        gatingId = r.id;
      }
    }
  }

  const etaLabel =
    etaMs != null && Number.isFinite(etaMs) && etaMs > 0
      ? ` ~${Math.max(1, Math.round(etaMs / 1000))}s`
      : '…';

  // Tooltip x, clamped so it doesn't overflow the bar (half the tooltip's
  // approximate rendered width — ~22 monospace chars at 10px).
  const TOOLTIP_HALF_WIDTH = 70;
  const tooltipX = hover
    ? clamp(
        hover.x,
        TOOLTIP_HALF_WIDTH,
        Math.max(TOOLTIP_HALF_WIDTH, hover.width - TOOLTIP_HALF_WIDTH),
      )
    : 0;

  // Preview-card x, clamped to the bar (uses the persisted anchor so it holds
  // position while fading out). Falls back to the live hover anchor.
  const previewAnchor = hover ?? lastHoverRef.current;
  const previewX = previewAnchor
    ? clamp(
        previewAnchor.x,
        PREVIEW_MAX_W / 2,
        Math.max(PREVIEW_MAX_W / 2, previewAnchor.width - PREVIEW_MAX_W / 2),
      )
    : 0;

  // The bar grows while it is being used — the standard video affordance for
  // "this is grabbable", and the only thing that makes the 6px track findable.
  const barActive = scrubbing || hover != null || sliderFocused;
  const trackHeight = barActive ? 8 : 6;
  const thumbSize = barActive ? 14 : 10;
  const motion = (t: string) => (reducedMotion ? undefined : t);

  // Only TRANSITION-shaped text goes in the live region. The remaining-time
  // countdown next to it changes every second; inside aria-live a screen
  // reader would recite "58s left, 57s left, …" for the whole session.
  const liveStatus = isBuffering
    ? `Buffering${etaLabel}`
    : isPlaying && isCreeping
      ? 'Playing as data arrives'
      : ended
        ? 'Ended'
        : null;

  // Only advertise a key when the surface actually mounts the hotkeys.
  const keyHint = (k: string) => (keyboardShortcuts ? ` (${k})` : '');
  const seekBy = (fraction: number) =>
    onSeek(
      clamp(displayTime + rangeMs * fraction, timeRange.start, timeRange.end),
    );

  return (
    // NOTE: never write a utility immediately before `${` in a className
    // template — Tailwind's scanner reads `space-y-3${className` as one
    // candidate, finds it invalid, and silently drops the class from the
    // compiled stylesheet. Keep every utility inside a self-contained literal.
    <div
      className={className ? `space-y-3 ${className}` : 'space-y-3'}
      style={style}
    >
      {/* Time display */}
      <div className="flex justify-between items-baseline gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <span
            className="text-xs font-medium font-mono whitespace-nowrap"
            style={{ color: 'var(--ink-900)' }}
          >
            {formatDate(displayTime)}
            <span style={{ color: 'var(--ink-500)' }}> UTC</span>
          </span>
          {/* elapsed / total, in DATASET time — the readout a video user looks
              for. Unlike the countdown on the right it does not move with the
              speed multiplier, exactly like a video's currentTime/duration. */}
          <span
            className="text-[10px] font-mono whitespace-nowrap tabular-nums"
            style={{ color: 'var(--ink-500)' }}
          >
            {formatSpan(displayTime - timeRange.start)} / {formatSpan(rangeMs)}
          </span>
        </div>
        <span
          className="text-[10px] flex items-center gap-1.5 shrink-0"
          style={{ color: 'var(--ink-500)' }}
        >
          {isBuffering ? (
            <span
              // prefers-reduced-motion: a spinning ring is exactly the kind of
              // continuous animation the setting exists to suppress, so it
              // degrades to a static accent dot.
              className={
                reducedMotion
                  ? 'w-2.5 h-2.5 rounded-full border-2'
                  : 'w-2.5 h-2.5 rounded-full border-2 animate-spin'
              }
              style={{
                borderColor: 'var(--accent)',
                borderTopColor: reducedMotion ? 'var(--accent)' : 'transparent',
              }}
            />
          ) : (
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: isPlaying ? 'var(--accent)' : 'var(--ink-400)',
              }}
            />
          )}
          {/* <output> carries an implicit role="status" live region — the
              semantic element rather than a div wearing the role. */}
          <output aria-live="polite">{liveStatus}</output>
          {liveStatus == null &&
            (isPlaying ? `${formatClock(remainingSeconds)} left` : 'Paused')}
        </span>
      </div>

      {/* Density strip + progress bar (kept adjacent inside one block so the
          parent's space-y doesn't separate them). */}
      <div>
        {/* Scrub HIT AREA — see SCRUB_PAD_Y. The range input inside is
            `opacity-0` over the custom-drawn track, which also hides the
            browser's own focus ring, so the ring lives on this box instead —
            and only on :focus-visible, so a pointer scrub stays clean. */}
        <div
          className="relative cursor-pointer has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:[outline-color:var(--accent)]"
          style={{
            paddingTop: SCRUB_PAD_Y,
            paddingBottom: SCRUB_PAD_Y,
            borderRadius: 4,
          }}
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
                bottom: '100%',
                transform: 'translate(-50%, -22px)',
                pointerEvents: 'none',
                opacity: hover ? 1 : 0,
                transition: motion('opacity 120ms ease'),
                zIndex: 60,
              }}
            >
              <div
                style={{
                  display: 'inline-block',
                  // Card hugs the preview, which sizes itself to the live
                  // viewport's aspect ratio (see HoverPreview).
                  lineHeight: 0,
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: '1px solid var(--hairline)',
                  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
                  background: 'var(--page-bg)',
                }}
              >
                {renderPreview(previewTime ?? displayTime)}
              </div>
            </div>
          )}
          {/* Hover timestamp tooltip. */}
          {hover && (
            <div
              aria-hidden="true"
              className="absolute text-[10px] font-mono whitespace-nowrap px-1.5 py-0.5 rounded"
              style={{
                left: tooltipX,
                bottom: '100%',
                transform: 'translate(-50%, -4px)',
                pointerEvents: 'none',
                background: 'var(--surface)',
                color: 'var(--ink-900)',
                border: '1px solid var(--hairline)',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
              }}
            >
              {formatDate(hover.time)}
            </div>
          )}

          {density && <DensityStrip density={density} />}

          <div
            className="relative rounded-full"
            style={{
              height: trackHeight,
              background: 'var(--hairline)',
              transition: motion('height 100ms ease'),
            }}
          >
            {/* Buffered ranges — the translucent "loaded" bar every video player
                has, straight from the tileset's coverage index. */}
            {bufferedRanges.map((range, i) => {
              if (rangeMs <= 0) return null;
              const left = clamp(
                ((range.start - timeRange.start) / rangeMs) * 100,
                0,
                100,
              );
              const right = clamp(
                ((range.end - timeRange.start) / rangeMs) * 100,
                0,
                100,
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
                    background: 'var(--ink-400)',
                    opacity: 0.35,
                  }}
                />
              );
            })}
            <div
              aria-hidden="true"
              className="absolute left-0 top-0 h-full rounded-full"
              style={{
                width: `${progress}%`,
                background: 'var(--accent)',
                // Smooth over the 10Hz UI clock while playing; instant while
                // the user is driving, or the fill would lag the thumb.
                transition:
                  isPlaying && !scrubbing
                    ? motion('width 120ms linear')
                    : undefined,
              }}
            />
            {/* The grab handle. Without it the bar is a bare fill with a hard
                edge and nothing says "draggable" — every video player draws a
                knob. pointer-events off so the input underneath still gets the
                drag. */}
            <div
              aria-hidden="true"
              className="absolute rounded-full"
              style={{
                left: `${clamp(progress, 0, 100)}%`,
                top: '50%',
                width: thumbSize,
                height: thumbSize,
                transform: 'translate(-50%, -50%)',
                background: 'var(--accent)',
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.35)',
                pointerEvents: 'none',
                transition: motion('width 100ms ease, height 100ms ease'),
              }}
            />
          </div>

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
            onKeyDown={handleSliderKeyDown}
            onPointerUp={handleScrubEnd}
            onPointerCancel={handleScrubEnd}
            onFocus={() => setSliderFocused(true)}
            onBlur={(e) => {
              setSliderFocused(false);
              handleScrubEnd(e);
            }}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            // Without this a touch drag along the bar scrolls the page instead
            // of scrubbing on some engines.
            style={{ touchAction: 'none', margin: 0 }}
          />
        </div>

        {/* Per-source runway strip — only with 2+ registered sources; a single
            source's runway already equals the buffered bar above. */}
        {multiSource && (
          <SourceRunwayStrip
            sources={sourceRunways}
            gatingId={gatingId}
            playheadFrac={progress / 100}
            rangeMs={rangeMs}
          />
        )}
      </div>

      {/* Time range labels. --ink-400 is a DECORATIVE token (≈2.6:1 on the
          default light surface); text uses --ink-500, which clears 4.5:1. */}
      <div className="flex justify-between">
        <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
          {formatDate(timeRange.start)}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
          {formatDate(timeRange.end)}
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Transport cluster. Geometry is inline (not via Tailwind w-/h-
            utilities) so the buttons keep their dimensions in any consumer — a
            published package can't rely on the host app's Tailwind content
            scan reaching node_modules. */}
        <div className="flex items-center" style={{ gap: 8 }}>
          <IconButton
            onClick={() => {
              onSeek(timeRange.start);
              // Media convention: the replay control PLAYS. A restart that
              // leaves you paused at frame zero is a seek, not a replay.
              if (!isPlaying) onPlayPause();
            }}
            label="Restart from beginning"
            // No key hint: `Home` seeks to the start without resuming, so it
            // is not the same action as this button.
            title="Restart from beginning"
          >
            <ToStartIcon />
          </IconButton>
          <IconButton
            onClick={() => seekBy(-LONG_STEP_FRACTION)}
            label="Back 10 percent"
            title={`Back 10%${keyHint('J')}`}
          >
            <RewindIcon />
          </IconButton>
          <IconButton
            onClick={onPlayPause}
            tone="primary"
            size={40}
            radius={12}
            label={ended ? 'Replay' : isPlaying ? 'Pause' : 'Play'}
            title={`${ended ? 'Replay' : isPlaying ? 'Pause' : 'Play'}${keyHint('Space')}`}
          >
            {ended ? <ReplayIcon /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
          </IconButton>
          <IconButton
            onClick={() => seekBy(LONG_STEP_FRACTION)}
            label="Forward 10 percent"
            title={`Forward 10%${keyHint('L')}`}
          >
            <ForwardIcon />
          </IconButton>
          {onLoopToggle && (
            <IconButton
              onClick={onLoopToggle}
              active={loop === true}
              label="Loop at the end of the range"
              title={loop ? 'Looping — click to stop at the end' : 'Loop'}
            >
              <LoopIcon />
            </IconButton>
          )}
        </div>

        {/* Speed. A real <fieldset> of real radios: the presets and Auto are
            mutually exclusive, so this is a radio group, not five independent
            toggles — and native radios bring arrow-key traversal and the
            checked state instead of faking both with aria-pressed. */}
        <fieldset className="flex items-center gap-1 m-0 p-0 border-0 min-w-0">
          <legend className="sr-only">Playback speed</legend>
          <span
            aria-hidden="true"
            className="text-[10px] mr-1 hidden sm:inline"
            style={{ color: 'var(--ink-500)' }}
          >
            Speed:
          </span>
          {SPEED_PRESETS.map((preset) => (
            <SpeedOption
              key={preset.value}
              name={speedGroup}
              label={preset.label}
              // Tight epsilon: the slider steps at 0.25, so exact preset values
              // are representable — a loose 0.1 epsilon lit presets for values
              // they don't equal.
              checked={
                !autoSpeed &&
                Math.abs(currentSpeedMultiplier - preset.value) < 0.01
              }
              onSelect={() => onSpeedChange(preset.value)}
            />
          ))}
          {/* Opt-in Auto speed: the governor caps speed at what the measured
              network can sustain; the resolved value is shown ("Auto 2.5x").
              Selecting any explicit preset/slider value exits Auto. */}
          <SpeedOption
            name={speedGroup}
            label={
              autoSpeed ? `Auto ${currentSpeedMultiplier.toFixed(1)}x` : 'Auto'
            }
            title="Match playback speed to what the network can sustain"
            checked={autoSpeed}
            onSelect={onAutoSpeedSelect}
          />
        </fieldset>

        {/* Fine slider — max matches the presets and Auto's clamp. */}
        <div className="flex-1 items-center gap-2 min-w-0 hidden md:flex">
          <input
            type="range"
            aria-label="Playback speed multiplier"
            aria-valuetext={`${currentSpeedMultiplier.toFixed(2)}x`}
            min="0.25"
            max="10"
            step="0.25"
            value={currentSpeedMultiplier}
            onChange={(e) => onSpeedChange(Number(e.target.value))}
            className="flex-1 h-1 cursor-pointer"
            style={{ accentColor: 'var(--accent)' }}
          />
          <span
            className="text-[10px] font-medium min-w-[32px] text-right tabular-nums"
            style={{ color: 'var(--ink-900)' }}
          >
            {currentSpeedMultiplier.toFixed(1)}x
          </span>
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          {/* Opt-in hover preview toggle (only when the parent can render one). */}
          {renderPreview && (
            <IconButton
              onClick={() => setPreviewEnabled((v) => !v)}
              active={previewEnabled}
              size={24}
              radius={6}
              label="Scrubber hover preview"
              title="Show a rendered preview of the map at the hovered time"
            >
              <PreviewIcon />
            </IconButton>
          )}
          {keyboardShortcuts && (
            <div className="relative" ref={shortcutsWrapRef}>
              {/* Escape is handled document-wide while open (see the effect),
                  so no wrapper needs a keydown handler — and it closes from
                  wherever focus happens to be. The panel holds no focusable
                  content, so focus is still on this button afterwards. */}
              <IconButton
                onClick={() => setShowShortcuts((v) => !v)}
                active={showShortcuts}
                size={24}
                radius={6}
                label="Keyboard shortcuts"
                ariaExpanded={showShortcuts}
                ariaControls={shortcutsId}
              >
                <HelpIcon />
              </IconButton>
              {showShortcuts && (
                <div
                  id={shortcutsId}
                  className="absolute right-0 rounded px-2.5 py-2"
                  style={{
                    bottom: '100%',
                    marginBottom: 8,
                    zIndex: 70,
                    minWidth: 214,
                    background: 'var(--surface)',
                    border: '1px solid var(--hairline)',
                    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
                  }}
                >
                  <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
                    {PLAYBACK_SHORTCUTS.map((s) => (
                      <React.Fragment key={s.keys}>
                        <dt
                          className="font-mono whitespace-nowrap"
                          style={{ color: 'var(--ink-900)' }}
                        >
                          {s.keys}
                        </dt>
                        <dd className="m-0" style={{ color: 'var(--ink-500)' }}>
                          {s.action}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
