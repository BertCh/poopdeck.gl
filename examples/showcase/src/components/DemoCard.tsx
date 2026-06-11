import React from "react";
import { Link } from "react-router-dom";
import { SourceLogo } from "./SourceLogo";
import type { CatalogEntry } from "../content/demoMeta";

/**
 * Catalog card shared by `/demos` and the "Related demos" rail on per-demo
 * pages. Completely static — no map, no tile traffic — matching the quiet
 * text-first index on the landing page, plus a technique chip.
 */
const DemoCard: React.FC<{ entry: CatalogEntry }> = ({ entry }) => {
  const { dataset, meta } = entry;
  return (
    <Link
      to={`/demos/${dataset.id}`}
      className="group block rounded-md p-4 -m-1 transition-colors"
      style={{ border: "1px solid transparent" }}
      onMouseOver={(e) => {
        e.currentTarget.style.borderColor = "var(--hairline)";
        e.currentTarget.style.background = "var(--surface)";
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.borderColor = "transparent";
        e.currentTarget.style.background = "transparent";
      }}
    >
      <h3
        className="text-sm font-medium transition-colors group-hover:[color:var(--accent)]"
        style={{ color: "var(--ink-900)" }}
      >
        {dataset.name}
      </h3>
      <p
        className="text-xs mt-1.5 line-clamp-2"
        style={{ color: "var(--ink-500)", lineHeight: 1.5 }}
      >
        {meta.tagline ?? dataset.description}
      </p>
      {/* Meta row: attribution left, technique chip right — keeps long chips
          from squeezing the title into awkward wraps. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mt-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {(dataset.sources ?? []).map((s) => (
            <SourceLogo key={s} id={s} />
          ))}
        </div>
        <span
          className="text-[10px] font-semibold tracking-wide uppercase px-1.5 py-0.5 rounded"
          style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
        >
          {meta.techniqueTag}
        </span>
      </div>
    </Link>
  );
};

export default DemoCard;
