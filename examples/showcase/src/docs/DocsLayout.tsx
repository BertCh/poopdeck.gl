import React, { useRef, useState, useMemo } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import { docSections } from "./manifest";

interface DocsOutletContext {
  /** The docs content scroll container — anchors/TOC must target this. */
  contentRef: React.RefObject<HTMLDivElement>;
}

export function useDocsContext(): DocsOutletContext {
  return useOutletContext<DocsOutletContext>();
}

/**
 * The /docs shell: persistent grouped sidebar + a content column that OWNS
 * the docs scroll (html/body never scroll in this app). Mounted lazily so
 * react-markdown/prism stay out of the landing/demo bundles.
 */
const DocsLayout: React.FC = () => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return docSections;
    return docSections
      .map((s) => ({
        ...s,
        entries: s.entries.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            s.label.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.entries.length > 0);
  }, [filter]);

  const sidebar = (
    <div className="h-full overflow-y-auto custom-scrollbar px-4 py-5">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter docs…"
        className="w-full mb-5 px-2.5 py-1.5 rounded text-xs outline-none"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--hairline)",
          color: "var(--ink-700)",
        }}
        aria-label="Filter documentation pages"
      />
      {filtered.map((section) => (
        <div key={section.id} className="mb-6">
          <div className="eyebrow mb-2">{section.label}</div>
          <ul className="space-y-0.5">
            {section.entries.map((entry) => (
              <li key={entry.slug}>
                <NavLink
                  to={`/docs/${entry.slug}`}
                  onClick={() => setDrawerOpen(false)}
                  className="block px-2 py-1 rounded text-[13px] leading-snug transition-colors"
                  style={({ isActive }) => ({
                    color: isActive ? "var(--accent)" : "var(--ink-700)",
                    background: isActive ? "var(--accent-soft)" : "transparent",
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
        <p className="text-xs" style={{ color: "var(--ink-400)" }}>
          No pages match “{filter}”.
        </p>
      )}
    </div>
  );

  return (
    <div className="h-full flex overflow-hidden">
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:block w-60 shrink-0"
        style={{ borderRight: "1px solid var(--hairline)" }}
      >
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <>
          <div
            className="lg:hidden fixed inset-0 z-30"
            style={{ background: "rgba(21, 23, 28, 0.3)" }}
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            className="lg:hidden fixed top-12 left-0 bottom-0 z-40 w-64"
            style={{
              background: "var(--page-bg)",
              borderRight: "1px solid var(--hairline)",
            }}
          >
            {sidebar}
          </aside>
        </>
      )}

      {/* Content column — THE docs scroll surface. */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile: docs-nav toggle bar */}
        <div
          className="lg:hidden shrink-0 px-4 py-2"
          style={{ borderBottom: "1px solid var(--hairline)" }}
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(!drawerOpen)}
            className="text-xs font-medium"
            style={{ color: "var(--accent)" }}
          >
            {drawerOpen ? "✕ Close docs menu" : "☰ Docs menu"}
          </button>
        </div>
        <div
          ref={contentRef}
          className="flex-1 min-h-0 overflow-y-auto custom-scrollbar"
        >
          <Outlet context={{ contentRef } satisfies DocsOutletContext} />
        </div>
      </div>
    </div>
  );
};

export default DocsLayout;
