import React from 'react';
import { Link, NavLink } from 'react-router';
import { ATLAS_AVAILABLE } from '../datasets';

export const GITHUB_URL = 'https://github.com/BertCh/spatiotemporal-tiles';

/**
 * Site-wide top bar shared by the landing page, demo catalog, per-demo pages
 * and docs. Deliberately quiet — a hairline under the wordmark, hierarchy from
 * ink weight — matching the rest of the editorial chrome. The fullscreen demo
 * viewer, the AV cockpit, the worlds gallery and the drifters story render
 * outside SiteChrome and never see it.
 *
 * `/drive` and `/worlds` live HERE, not only on a demo card, because they are
 * standalone destinations the way `/story/drifters` is — chrome-free fullscreen
 * surfaces with their own IA, not a dataset in the deck viewer. Before this they
 * had no clickable path from anywhere on the site: the only route into either
 * was typing the URL. `/drive` with no `:sceneId` defaults to av-synthetic;
 * `/worlds` with no `:worldId` opens the whole gallery. Six links plus GitHub no
 * longer fit a ~360px phone, so the strip scrolls (`.nav-scroll`) instead of
 * clipping the last item — it never overflows at desktop widths.
 */
const NAV_ITEMS: { label: string; to: string }[] = [
  { label: 'Demos', to: '/demos' },
  { label: 'Drive', to: '/drive' },
  { label: 'Worlds', to: '/worlds' },
  // `/atlas` is the same kind of destination and is offered only where its
  // archives resolve — see ATLAS_AVAILABLE.
  ...(ATLAS_AVAILABLE ? [{ label: 'Atlas', to: '/atlas' }] : []),
  { label: 'How it works', to: '/how-it-works' },
  { label: 'Docs', to: '/docs' },
  { label: 'Story', to: '/story/drifters' },
];

const SiteHeader: React.FC = () => {
  return (
    <header
      className="shrink-0 flex items-center justify-between px-5 sm:px-7 lg:px-12 h-12"
      style={{
        background: 'var(--page-bg)',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      <Link
        to="/"
        className="font-display text-sm font-bold tracking-tight shrink-0"
        style={{ color: 'var(--ink-900)' }}
      >
        poopdeck<span style={{ color: 'var(--ink-400)' }}>.gl</span>
      </Link>

      <nav
        className="flex items-center gap-4 sm:gap-6 min-w-0 overflow-x-auto nav-scroll"
        aria-label="Site"
      >
        {NAV_ITEMS.map((item) => (
          // The accent-on-hover used to be JS (onMouseOver/onMouseOut writing
          // `style.color`), which meant a keyboard user tabbing the nav got no
          // highlight at all — and the handler had to re-read `aria-current` to
          // undo itself. As CSS it covers hover AND :focus-visible, and the
          // active route's accent survives because the class only sets the
          // muted ink, which the `style` prop overrides.
          <NavLink
            key={item.to}
            to={item.to}
            className="text-xs sm:text-[13px] font-medium transition-colors shrink-0 [color:var(--ink-500)] hover:[color:var(--accent)] focus-visible:[color:var(--accent)]"
            style={({ isActive }) =>
              isActive ? { color: 'var(--accent)' } : {}
            }
          >
            {item.label}
          </NavLink>
        ))}
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs sm:text-[13px] font-medium transition-colors inline-flex items-center gap-1 shrink-0 [color:var(--ink-500)] hover:[color:var(--accent)] focus-visible:[color:var(--accent)]"
        >
          GitHub
          <svg
            viewBox="0 0 24 24"
            width="11"
            height="11"
            aria-hidden="true"
            style={{ opacity: 0.7 }}
          >
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M7 17L17 7M9 7h8v8"
            />
          </svg>
        </a>
      </nav>
    </header>
  );
};

export default SiteHeader;
