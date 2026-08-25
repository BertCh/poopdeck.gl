import React, { useEffect, useState } from 'react';
import { useReducedMotion } from '../lib/reducedMotion';
import { useIsMobile } from '../lib/useMediaQuery';

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
 *
 * It mounts ABOVE every page, fullscreen map surfaces included, so its height
 * comes straight out of the map. At desktop widths that is one 34px row; on a
 * phone the full sentence wraps to four lines and eats ~90px of a ~750px
 * screen, so the phone copy is cut to the actionable half.
 */
const STORAGE_KEY = 'poopdeck:motion-notice-dismissed';

const MotionDisclaimer: React.FC = () => {
  const reduced = useReducedMotion();
  const isMobile = useIsMobile();
  // Start from the SSR-safe default (not dismissed) so the prerendered HTML and
  // the first client render match — reading localStorage in the initializer
  // would hydrate-mismatch on every prerendered page. Reconcile from storage
  // after mount instead (client-only, so no server/client divergence).
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') setDismissed(true);
    } catch {
      // Private mode / blocked storage — leave the notice shown.
    }
  }, []);

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
      className="flex items-start gap-2 sm:gap-3 px-4 sm:px-7 lg:px-12 py-2 sm:py-2.5 text-[11px] sm:text-xs"
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

      <p className="flex-1" style={{ lineHeight: 1.5 }}>
        {reduced ? (
          isMobile ? (
            <strong style={{ color: 'var(--ink-900)', fontWeight: 600 }}>
              Reduced motion is on — demos won't autoplay.
            </strong>
          ) : (
            <>
              <strong style={{ color: 'var(--ink-900)', fontWeight: 600 }}>
                Reduced motion is on.
              </strong>{' '}
              Autoplay, looping animation, and globe rotation are minimized
              across this site. Press play on any demo to animate it when you
              choose.
            </>
          )
        ) : isMobile ? (
          <>
            Demos animate and flash. Turn on{' '}
            <span style={{ fontWeight: 600 }}>Reduce motion</span> if you're
            sensitive.
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
        // Hover darkening as CSS, not onMouseOver/onMouseOut writing
        // `style.color`: the JS version left a keyboard user with no feedback
        // at all on the one control that dismisses this notice.
        className="-my-1 shrink-0 leading-none px-2 py-1 transition-opacity [color:var(--ink-400)] hover:[color:var(--ink-700)] focus-visible:[color:var(--ink-700)]"
        style={{ fontSize: '14px' }}
      >
        ✕
      </button>
    </div>
  );
};

export default MotionDisclaimer;
