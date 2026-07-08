import React, { useState } from 'react';
import { Outlet } from 'react-router';
import Sidebar from './Sidebar';
import MotionDisclaimer from './MotionDisclaimer';

// This demo ships as a curated, single-surface showcase with no left-nav
// sidebar — the highlighted demos are reached from the Overview grid, and each
// demo page links back via its "Overview" header link. Flip to `true` to bring
// the full dataset sidebar back for local development.
const SHOW_SIDEBAR = false;

const Layout: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    // Column: the motion/photosensitivity notice sits above every page (it
    // mounts once here, so it persists across navigation and a dismissal sticks
    // for the session); the sidebar+content row takes the remaining height.
    // When the notice is dismissed it renders nothing and the row reclaims it.
    <div
      className="w-full h-full flex flex-col overflow-hidden"
      style={{ background: 'var(--page-bg)' }}
    >
      <MotionDisclaimer />
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {SHOW_SIDEBAR && (
          <>
            {/* Mobile hamburger */}
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="lg:hidden fixed top-3 left-3 z-50 p-2 rounded transition-colors"
              style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
              aria-label="Toggle menu"
            >
              <div className="w-4 h-3 flex flex-col justify-between">
                <span
                  className="block h-0.5 transition-all"
                  style={{
                    background: 'var(--ink-700)',
                    transform: sidebarOpen ? 'rotate(45deg) translateY(5px)' : 'none'
                  }}
                />
                <span
                  className="block h-0.5 transition-all"
                  style={{
                    background: 'var(--ink-700)',
                    opacity: sidebarOpen ? 0 : 1
                  }}
                />
                <span
                  className="block h-0.5 transition-all"
                  style={{
                    background: 'var(--ink-700)',
                    transform: sidebarOpen ? 'rotate(-45deg) translateY(-5px)' : 'none'
                  }}
                />
              </div>
            </button>

            {/* Mobile overlay */}
            {sidebarOpen && (
              <div
                className="lg:hidden fixed inset-0 z-30"
                style={{ background: 'rgba(21, 23, 28, 0.3)' }}
                onClick={() => setSidebarOpen(false)}
              />
            )}

            {/* Sidebar */}
            <aside
              className={`
                fixed lg:relative top-0 left-0 h-full z-40
                w-64 shrink-0
                transform transition-transform duration-200
                lg:translate-x-0
                ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
              `}
            >
              <Sidebar onNavigate={() => setSidebarOpen(false)} />
            </aside>
          </>
        )}

        {/* Main content */}
        <main className="flex-1 min-w-0 h-full overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default Layout;
