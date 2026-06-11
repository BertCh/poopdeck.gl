import React, { useEffect, useState } from "react";
import type { TocHeading } from "./headings";

/**
 * On-this-page TOC (xl+ screens). Scroll-spy runs an IntersectionObserver
 * with `root` set to the DOCS SCROLL CONTAINER — the window never scrolls in
 * this app (body is overflow:hidden), so a viewport-rooted observer would
 * never fire correctly.
 */
const Toc: React.FC<{
  headings: TocHeading[];
  getContainer: () => HTMLElement | null;
}> = ({ headings, getContainer }) => {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = getContainer();
    if (!root || headings.length === 0) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        // Highlight the first visible heading in document order; if none are
        // visible (mid-section), keep the current one.
        for (const h of headings) {
          if (visible.has(h.id)) {
            setActiveId(h.id);
            return;
          }
        }
      },
      { root, rootMargin: "0px 0px -70% 0px" },
    );
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [headings, getContainer]);

  if (headings.length < 2) return null;

  return (
    <nav className="text-xs" aria-label="On this page">
      <div className="eyebrow mb-3">On this page</div>
      <ul className="space-y-1.5">
        {headings.map((h) => (
          <li key={h.id} style={{ paddingLeft: h.level === 3 ? 12 : 0 }}>
            <a
              href={`#${h.id}`}
              className="block leading-snug transition-colors"
              style={{
                color: h.id === activeId ? "var(--accent)" : "var(--ink-500)",
                fontWeight: h.id === activeId ? 600 : 400,
              }}
              onClick={(e) => {
                e.preventDefault();
                history.replaceState(null, "", `#${h.id}`);
                document
                  .getElementById(h.id)
                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
};

export default Toc;
