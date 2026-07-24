import React from 'react';
import { Outlet } from 'react-router';
import MotionDisclaimer from './MotionDisclaimer';

/**
 * Root layout for every route. Deliberately thin: the site pages get their
 * chrome from SiteChrome (header + the single scroll surface); the fullscreen
 * surfaces (/demo, /drive, /worlds, /story) mount bare under this route.
 *
 * (There used to be a `SHOW_SIDEBAR = false` branch here carrying a whole
 * second navigation implementation — a left rail listing `navDatasets`. It was
 * never rendered and described an IA the site no longer has; navigation is
 * SiteHeader + the /demos catalog. Removed with `components/Sidebar.tsx`.)
 */
const Layout: React.FC = () => {
  return (
    // Column: the motion/photosensitivity notice sits above every page (it
    // mounts once here, so it persists across navigation and a dismissal sticks
    // for the session); the content row takes the remaining height. When the
    // notice is dismissed it renders nothing and the row reclaims it.
    <div
      className="w-full h-full flex flex-col overflow-hidden"
      style={{ background: 'var(--page-bg)' }}
    >
      <MotionDisclaimer />
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <main className="flex-1 min-w-0 h-full overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default Layout;
