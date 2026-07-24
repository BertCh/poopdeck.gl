import React, { useState, useMemo } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router';
import { docSections } from './manifest';

/** SiteChrome hands every page its shared scroll surface (#site-scroll). */
interface ChromeOutletContext {
  scrollRef: React.RefObject<HTMLDivElement>;
}

interface DocsOutletContext {
  /** The docs content scroll container — anchors/TOC must target this. */
  contentRef: React.RefObject<HTMLDivElement>;
}

export function useDocsContext(): DocsOutletContext {
  return useOutletContext<DocsOutletContext>();
}

/**
 * The /docs shell: persistent grouped sidebar + a content column.
 *
 * Scrolling: docs do NOT own their own scroll surface. They scroll on the
 * shared SiteChrome scroller (#site-scroll) like every other route — the
 * sidebar is `sticky` instead. An earlier design nested a second
 * `overflow-y-auto` here for the content; that nested-scroller layer left the
 * lower part of long articles unpainted in Chromium/Safari until a scroll tick
 * forced a repaint ("pop-in"). The TOC/anchor helpers still receive a
 * `contentRef` — it just points at #site-scroll now.
 */
const DocsLayout: React.FC = () => {
  const { scrollRef } = useOutletContext<ChromeOutletContext>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return docSections;
    return docSections
      .map((s) => ({
        ...s,
        entries: s.entries.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.group?.toLowerCase().includes(q) ||
            s.label.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.entries.length > 0);
  }, [filter]);

  const sidebar = (
    <div className="px-4 py-5">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter docs…"
        className="w-full mb-5 px-2.5 py-1.5 rounded text-xs outline-none"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--hairline)',
          color: 'var(--ink-700)',
        }}
        aria-label="Filter documentation pages"
      />
      {filtered.map((section) => (
        <div key={section.id} className="mb-6">
          <div className="eyebrow mb-2">{section.label}</div>
          <ul className="space-y-0.5">
            {section.entries.map((entry, i) => (
              <li key={entry.slug}>
                {/* Sub-group header — shown where the group label changes. */}
                {entry.group &&
                  entry.group !== section.entries[i - 1]?.group && (
                    <div
                      className="px-2 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: 'var(--ink-400)' }}
                    >
                      {entry.group}
                    </div>
                  )}
                <NavLink
                  to={`/docs/${entry.slug}`}
                  onClick={() => setDrawerOpen(false)}
                  className="block px-2 py-1 rounded text-[13px] leading-snug transition-colors"
                  style={({ isActive }) => ({
                    color: isActive ? 'var(--accent)' : 'var(--ink-700)',
                    background: isActive ? 'var(--accent-soft)' : 'transparent',
                    fontWeight: isActive ? 600 : 400,
                  })}
                >
                  {entry.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {filtered.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--ink-400)' }}>
          No pages match “{filter}”.
        </p>
      )}
    </div>
  );

  return (
    <div className="flex min-h-full">
      {/* Desktop sidebar — sticky against the shared page scroller (#site-scroll
          starts below the 3rem header, so the rail fills the rest). */}
      <aside
        className="hidden lg:block w-60 shrink-0 sticky top-0 self-start h-[calc(100vh-3rem)] overflow-y-auto custom-scrollbar"
        style={{ borderRight: '1px solid var(--hairline)' }}
      >
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <>
          {/* A real <button>, not a click-handling <div>: the scrim is the only
              way to dismiss the drawer besides the toggle, and as a div it was
              unreachable by keyboard and invisible to assistive tech. */}
          <button
            type="button"
            aria-label="Close docs menu"
            className="lg:hidden fixed inset-0 z-30 cursor-default"
            style={{ background: 'rgba(21, 23, 28, 0.3)' }}
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            className="lg:hidden fixed top-12 left-0 bottom-0 z-40 w-64 overflow-y-auto custom-scrollbar"
            style={{
              background: 'var(--page-bg)',
              borderRight: '1px solid var(--hairline)',
            }}
          >
            {sidebar}
          </aside>
        </>
      )}

      {/* Content column — flows into the shared page scroll. */}
      <div className="flex-1 min-w-0">
        {/* Mobile: docs-nav toggle bar (sticks to the top of the page scroll). */}
        <div
          className="lg:hidden sticky top-0 z-10 px-4 py-2"
          style={{
            borderBottom: '1px solid var(--hairline)',
            background: 'var(--page-bg)',
          }}
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(!drawerOpen)}
            className="text-xs font-medium"
            style={{ color: 'var(--accent)' }}
          >
            {drawerOpen ? '✕ Close docs menu' : '☰ Docs menu'}
          </button>
        </div>
        {/* TOC/anchor helpers target the shared scroller via `contentRef`. */}
        <Outlet
          context={{ contentRef: scrollRef } satisfies DocsOutletContext}
        />
      </div>
    </div>
  );
};

export default DocsLayout;
