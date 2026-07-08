import React from "react";
import { Link } from "react-router";
import { getPrevNext } from "./manifest";

/** Prev/next footer links from the flattened manifest order. */
const PrevNext: React.FC<{ slug: string }> = ({ slug }) => {
  const { prev, next } = getPrevNext(slug);
  if (!prev && !next) return null;
  return (
    <div
      className="mt-12 pt-5 flex items-stretch justify-between gap-4"
      style={{ borderTop: "1px solid var(--hairline)" }}
    >
      {prev ? (
        <Link to={`/docs/${prev.slug}`} className="group block max-w-[45%]">
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--ink-400)" }}>
            ← Previous
          </div>
          <div
            className="text-sm font-medium mt-0.5 group-hover:[color:var(--accent)] transition-colors"
            style={{ color: "var(--ink-700)" }}
          >
            {prev.title}
          </div>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link to={`/docs/${next.slug}`} className="group block max-w-[45%] text-right">
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--ink-400)" }}>
            Next →
          </div>
          <div
            className="text-sm font-medium mt-0.5 group-hover:[color:var(--accent)] transition-colors"
            style={{ color: "var(--ink-700)" }}
          >
            {next.title}
          </div>
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
};

export default PrevNext;
