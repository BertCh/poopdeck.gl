import React, { useState } from 'react';
import { useReducedMotion } from '../lib/reducedMotion';

/**
 * Photosensitivity / motion notice shown at the top of every page (mounted once
 * in `Layout`). Several demos animate continuously and a few (flow maps, the
 * space-time cube, the data story's era cross-dissolves) pulse or flash, which
 * can be uncomfortable for motion-sensitive viewers.
 *
 * The notice points people at the OS "Reduce motion" setting, which the whole
 * site honors (see `useReducedMotion`), and adapts its copy once that setting
 * is on. Dismissal is lightweight: a single localStorage flag — so it sticks
 * for the session (the component never remounts on navigation) and across
 * future visits, with no provider/store.
 */
const STORAGE_KEY = 'poopdeck:motion-notice-dismissed';

const MotionDisclaimer: React.FC = () => {
  const reduced = useReducedMotion();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Private mode / blocked storage — fine, it just re-shows next visit.
    }
  };

  return (
    <div
      role="note"
      aria-label="Motion and photosensitivity notice"
      className="flex items-start gap-3 px-5 sm:px-7 lg:px-12 py-2.5 text-xs"
      style={{
        background: 'var(--accent-soft)',
        borderBottom: '1px solid var(--hairline)',
        color: 'var(--ink-700)',
      }}
    >
      {/* Motion / waves glyph */}
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        aria-hidden="true"
        className="mt-0.5 shrink-0"
        style={{ color: 'var(--accent)' }}
      >
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 16c2-2 4-2 6 0s4 2 6 0 4-2 6 0"
        />
      </svg>

      <p className="flex-1" style={{ lineHeight: 1.55 }}>
        {reduced ? (
          <>
            <strong style={{ color: 'var(--ink-900)', fontWeight: 600 }}>
              Reduced motion is on.
            </strong>{' '}
            Autoplay, looping animation, and globe rotation are minimized across
            this site. Press play on any demo to animate it when you choose.
          </>
        ) : (
          <>
            Some visualizations animate, pulse, and flash. If you're sensitive
            to motion or flashing, turn on{' '}
            <span style={{ fontWeight: 600 }}>Reduce motion</span> in your
            system settings.
          </>
        )}
      </p>

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss this notice"
        className="shrink-0 leading-none px-1 transition-opacity"
        style={{ color: 'var(--ink-400)', fontSize: '14px' }}
        onMouseOver={(e) => (e.currentTarget.style.color = 'var(--ink-700)')}
        onMouseOut={(e) => (e.currentTarget.style.color = 'var(--ink-400)')}
      >
        ✕
      </button>
    </div>
  );
};

export default MotionDisclaimer;
