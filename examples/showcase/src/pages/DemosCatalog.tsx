import React from "react";
import {
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  CATEGORY_BLURBS,
  getCatalog,
} from "../content/demoMeta";
import DemoCard from "../components/DemoCard";

/**
 * The full demo catalog (`/demos`): every healthy dataset grouped by theme.
 * Deliberately static — cards carry no live maps, so this page costs zero
 * tile traffic; the live embeds live on the per-demo pages.
 */
const DemosCatalog: React.FC = () => {
  const catalog = getCatalog();

  return (
    <div className="min-h-full px-5 sm:px-7 lg:px-12 py-8 sm:py-12">
      <div className="max-w-5xl">
        <span className="eyebrow">Demos</span>
        <h1
          className="font-display text-2xl sm:text-3xl font-bold mt-2"
          style={{ color: "var(--ink-900)", lineHeight: 1.15 }}
        >
          The catalog
        </h1>
        <p
          className="text-sm mt-3 max-w-xl"
          style={{ color: "var(--ink-500)", lineHeight: 1.7 }}
        >
          Every demo streams a real dataset as spatiotemporal tiles — no
          thinning, no pre-rendered video. Each page explains the data, how the
          archive was built, and which layers render it.
        </p>

        {CATEGORY_ORDER.map((cat) => {
          const entries = catalog.get(cat) ?? [];
          if (entries.length === 0) return null;
          return (
            <section key={cat} className="mt-10 sm:mt-12">
              <div
                className="pb-2 mb-4"
                style={{ borderBottom: "1px solid var(--hairline)" }}
              >
                <h2
                  className="font-display text-base font-semibold"
                  style={{ color: "var(--ink-900)" }}
                >
                  {CATEGORY_LABELS[cat]}
                </h2>
                <p className="text-xs mt-1" style={{ color: "var(--ink-400)" }}>
                  {CATEGORY_BLURBS[cat]}
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2">
                {entries.map((entry) => (
                  <DemoCard key={entry.dataset.id} entry={entry} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};

export default DemosCatalog;
