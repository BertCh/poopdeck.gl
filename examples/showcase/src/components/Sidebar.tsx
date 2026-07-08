import React from 'react';
import { NavLink, useLocation } from 'react-router';
import { navDatasets } from '../datasets';

interface SidebarProps {
  onNavigate?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ onNavigate }) => {
  const location = useLocation();

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: 'var(--page-bg)', borderRight: '1px solid var(--hairline)' }}
    >
      {/* Wordmark */}
      <div className="shrink-0 px-5 pt-6 pb-5">
        <NavLink to="/" onClick={onNavigate} className="block">
          <span className="eyebrow">Navigation &amp; observation</span>
          <h1
            className="font-display text-xl font-bold mt-1 leading-tight"
            style={{ color: 'var(--ink-900)' }}
          >
            poopdeck<span style={{ color: 'var(--ink-400)' }}>.gl</span>
          </h1>
        </NavLink>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar pb-4">
        {/* Top-level */}
        <div className="px-3 space-y-0.5">
          {[
            { to: '/', label: 'Overview' },
          ].map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={onNavigate}
              className="block px-2 py-1.5 rounded text-sm transition-colors"
              style={({ isActive }) => ({
                color: isActive ? 'var(--accent)' : 'var(--ink-700)',
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                fontWeight: isActive ? 600 : 500,
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </div>

        {/* Demos */}
        <div className="mt-6 px-5 mb-2">
          <span className="eyebrow">Demos</span>
        </div>
        <div className="px-3">
          {navDatasets.map((dataset) => {
            const isActive = location.pathname === `/demo/${dataset.id}`;
            return (
              <NavLink
                key={dataset.id}
                to={`/demo/${dataset.id}`}
                onClick={onNavigate}
                className="block px-2 py-2 rounded transition-colors"
                style={{
                  borderLeft: isActive
                    ? '2px solid var(--accent)'
                    : '2px solid transparent',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                }}
                onMouseOver={(e) => {
                  if (!isActive)
                    e.currentTarget.style.background = 'var(--surface-sunken)';
                }}
                onMouseOut={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span
                  className="block text-sm leading-tight"
                  style={{
                    color: isActive ? 'var(--accent)' : 'var(--ink-900)',
                    fontWeight: isActive ? 600 : 500,
                  }}
                >
                  {dataset.name}
                </span>
                <span
                  className="block text-xs mt-0.5 line-clamp-1"
                  style={{ color: 'var(--ink-400)' }}
                >
                  {dataset.description}
                </span>
              </NavLink>
            );
          })}
        </div>
      </nav>

      {/* Footer */}
      <div className="shrink-0 px-5 py-4" style={{ borderTop: '1px solid var(--hairline)' }}>
        <a
          href="https://github.com/your-org/spatiotemporal-tiles"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-xs transition-colors"
          style={{ color: 'var(--ink-500)' }}
          onMouseOver={(e) => { e.currentTarget.style.color = 'var(--ink-900)'; }}
          onMouseOut={(e) => { e.currentTarget.style.color = 'var(--ink-500)'; }}
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
          GitHub
        </a>
      </div>
    </div>
  );
};

export default Sidebar;
