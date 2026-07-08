import React from 'react';
import { Outlet, useLocation } from 'react-router';
import SiteHeader from './SiteHeader';

/**
 * Layout route wrapping every "site" page (landing, demo catalog, per-demo
 * pages, docs) with the shared header. The chrome owns the page scroll —
 * `html/body/#root` are `overflow: hidden`, so this container is THE scroll
 * surface; pages under it must not create their own full-page scroll.
 *
 * The fullscreen viewer (`/demo/:id`) and the drifters story mount as
 * siblings of this route, so they stay chrome-free.
 */
const SiteChrome: React.FC = () => {
  const location = useLocation();
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // New page → top of the new page. Hash/anchor scrolling within docs pages
  // is handled by the docs layout against this same container.
  React.useEffect(() => {
    if (!location.hash) scrollRef.current?.scrollTo({ top: 0 });
  }, [location.pathname, location.hash]);

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: 'var(--page-bg)' }}
    >
      <SiteHeader />
      <div
        ref={scrollRef}
        id="site-scroll"
        className="flex-1 min-h-0 overflow-y-auto custom-scrollbar"
      >
        <Outlet context={{ scrollRef }} />
      </div>
    </div>
  );
};

export default SiteChrome;
