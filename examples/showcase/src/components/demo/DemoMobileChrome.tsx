/**
 * Phone-width chrome for the fullscreen demo viewer (`/demo/:id`, rendered
 * below Tailwind's `md` breakpoint via {@link useIsMobile}). Same idiom as
 * {@link ../av/AvMobileChrome} and {@link ../worlds/WorldsMobileChrome}.
 *
 * The desktop layout floats a 320px title/description/renderer card in the
 * top-left and a 5-row transport bar across the bottom. On a ~390px screen
 * those two cover roughly half the map — the title card alone runs the full
 * width and four lines deep, and the transport wraps its speed group onto its
 * own row. This collapses them into:
 *
 *   • a slim top bar (back · title · an ⓘ disclosure);
 *   • an "About" sheet under that bar holding everything the bar dropped —
 *     the description, the dataset's time span (which the compact transport
 *     no longer prints) and the renderer switch;
 *   • the shared transport pinned to the bottom in its `compact` layout.
 *
 * The map itself ({@link DemoViewer}) is identical to desktop — only the
 * chrome differs. Containers are `pointer-events-none` so their transparent
 * gutters never steal a map pan or pinch; the interactive blocks opt back in.
 * Top and bottom edges respect the iOS safe-area insets.
 */
import React, { useState } from 'react';
import { Link } from 'react-router';
import {
  PlaybackControls,
  type PlaybackControlsProps,
} from '@poopdeck.gl/react';
import type { Dataset } from '../../types';
import { DARK_CONTROL_THEME } from '../../lib/controlTheme';

/** One entry of the renderer switch (deck.gl ↔ MapLibre ↔ Three). */
export interface RendererOption {
  id: 'deck' | 'maplibre' | 'three';
  label: string;
  active: boolean;
}

export interface DemoMobileChromeProps {
  dataset: Dataset;
  /** Where the back arrow goes, and what it is called. */
  backTo: string;
  backLabel: string;
  /** Renderer switch — omitted (undefined) when only deck.gl can draw this set. */
  renderers?: RendererOption[];
  /** Shared radio-group name, owned by the page so two mounts never fuse. */
  rendererGroup: string;
  onRendererChange: (id: RendererOption['id']) => void;
  /** Everything the transport bar needs; rendered in its `compact` layout. */
  transport: PlaybackControlsProps;
  /** The page owns the idle-hide timer, so it owns the bar's node + state. */
  transportRef: React.RefObject<HTMLDivElement | null>;
  transportIdle: boolean;
  reducedMotion: boolean;
}

const BackIcon = () => (
  <svg
    className="h-[18px] w-[18px]"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

const InfoIcon = () => (
  <svg
    className="h-[18px] w-[18px]"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.6v.4" />
  </svg>
);

const CloseIcon = () => (
  <svg
    className="h-4 w-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** UTC, to the minute — the same zone the transport bar's labels use. */
const formatSpanLabel = (t: number): string =>
  new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const DemoMobileChrome: React.FC<DemoMobileChromeProps> = ({
  dataset,
  backTo,
  backLabel,
  renderers,
  rendererGroup,
  onRendererChange,
  transport,
  transportRef,
  transportIdle,
  reducedMotion,
}) => {
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <>
      {/* ── Top bar: back · title · about ──────────────────────────────────── */}
      <header
        className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-2 bg-gradient-to-b from-black/70 via-black/40 to-transparent px-3 pb-4"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        <Link
          to={backTo}
          aria-label={backLabel}
          className="pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-slate-200 backdrop-blur-md"
        >
          <BackIcon />
        </Link>
        {/* The title doubles as the disclosure's label — tapping either the
            text or the ⓘ opens the sheet, which is the whole affordance a
            phone has room for. */}
        <button
          type="button"
          onClick={() => setAboutOpen((v) => !v)}
          aria-expanded={aboutOpen}
          className="pointer-events-auto min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/55 px-3 py-2 text-left font-display text-sm font-semibold text-slate-100 backdrop-blur-md"
        >
          {dataset.name}
        </button>
        <button
          type="button"
          onClick={() => setAboutOpen((v) => !v)}
          aria-expanded={aboutOpen}
          aria-label="About this demo"
          className={`pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border backdrop-blur-md transition-colors ${
            aboutOpen
              ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
              : 'border-white/10 bg-black/55 text-slate-300'
          }`}
        >
          {aboutOpen ? <CloseIcon /> : <InfoIcon />}
        </button>
      </header>

      {/* ── About sheet: description · span · renderer switch ──────────────── */}
      {aboutOpen && (
        <div
          className="pointer-events-none absolute inset-x-0 z-30 px-3"
          style={{ top: 'calc(env(safe-area-inset-top) + 3.25rem)' }}
        >
          <div className="pointer-events-auto max-h-[45vh] overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-black/80 p-4 shadow-2xl backdrop-blur-md">
            <p className="text-xs leading-relaxed text-slate-300">
              {dataset.description}
            </p>
            {/* The dataset's span — the compact transport drops the two
                endpoint labels, so this is where they live on a phone. */}
            <p className="mt-2.5 font-mono text-[10px] text-slate-500">
              {formatSpanLabel(dataset.timeRange.start)} —{' '}
              {formatSpanLabel(dataset.timeRange.end)} UTC
            </p>
            {renderers && (
              <div
                className="mt-3.5 flex gap-1.5"
                role="radiogroup"
                aria-label="Renderer"
              >
                {renderers.map((r) => (
                  // A REAL radio, not a button with role="radio" — same
                  // contract as the desktop switch: the native input carries
                  // arrow-key traversal and the checked state.
                  <label
                    key={r.id}
                    className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-cyan-300/70 ${
                      r.active
                        ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
                        : 'border-white/15 text-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name={rendererGroup}
                      className="sr-only"
                      checked={r.active}
                      onChange={() => onRendererChange(r.id)}
                    />
                    {r.label}
                  </label>
                ))}
              </div>
            )}
            <Link
              to={backTo}
              className="mt-3.5 inline-flex items-center gap-1 text-xs text-cyan-300"
            >
              {backLabel}
              <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      )}

      {/* ── Transport, pinned to the bottom ────────────────────────────────── */}
      <div
        ref={transportRef}
        className="glass absolute inset-x-2 bottom-2 z-30 rounded-xl px-3 py-2.5"
        style={{
          ...DARK_CONTROL_THEME,
          marginBottom: 'env(safe-area-inset-bottom)',
          opacity: transportIdle ? 0 : 1,
          // Must not eat pointer events from the map once invisible.
          pointerEvents: transportIdle ? 'none' : 'auto',
          transform:
            transportIdle && !reducedMotion ? 'translateY(8px)' : undefined,
          transition: reducedMotion
            ? undefined
            : 'opacity 220ms ease, transform 220ms ease',
        }}
      >
        <PlaybackControls {...transport} compact />
      </div>
    </>
  );
};

export default DemoMobileChrome;
