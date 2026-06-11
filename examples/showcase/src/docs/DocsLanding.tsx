import React from "react";
import { Link } from "react-router-dom";
import { docSections } from "./manifest";
import CodeBlock from "./CodeBlock";

const QUICK_START = `npm install @stt/core @stt/deck.gl

import { AnimatedPointLayer, TimeController } from '@stt/deck.gl';

const timeController = new TimeController({ speed: 3600 });
const layer = new AnimatedPointLayer({
  id: 'earthquakes',
  data: 'https://tiles.example.com/data/earthquakes/manifest.json',
  timeController,
  timeWindow: 30 * 24 * 3600 * 1000, // 30-day visible window
});
timeController.play();`;

/**
 * The /docs landing: a short pitch, one card per manifest section, and a
 * minimal quick-start. Deliberately NOT a rendered README.md — that file is a
 * link hub that would duplicate the sidebar.
 */
const DocsLanding: React.FC = () => {
  return (
    <div className="px-5 sm:px-8 py-8 sm:py-10 max-w-4xl">
      <span className="eyebrow">Documentation</span>
      <h1
        className="font-display text-2xl sm:text-3xl font-bold mt-2"
        style={{ color: "var(--ink-900)", lineHeight: 1.15 }}
      >
        Spatiotemporal Tiles
      </h1>
      <p
        className="text-sm mt-3 max-w-2xl"
        style={{ color: "var(--ink-500)", lineHeight: 1.7 }}
      >
        A cloud-native, edge-cacheable tile format for streaming massive
        time-variant geospatial datasets — Rust tools to build archives from
        GeoParquet, and TypeScript layers to animate them in deck.gl or
        MapLibre.
      </p>

      {/* Section cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-8">
        {docSections.map((section) => (
          <Link
            key={section.id}
            to={`/docs/${section.entries[0].slug}`}
            className="group block rounded-md p-4 transition-colors"
            style={{
              border: "1px solid var(--hairline)",
              background: "var(--surface)",
            }}
            onMouseOver={(e) =>
              (e.currentTarget.style.borderColor = "var(--accent)")
            }
            onMouseOut={(e) =>
              (e.currentTarget.style.borderColor = "var(--hairline)")
            }
          >
            <h2
              className="text-sm font-semibold group-hover:[color:var(--accent)] transition-colors"
              style={{ color: "var(--ink-900)" }}
            >
              {section.label}
            </h2>
            <p
              className="text-xs mt-1.5"
              style={{ color: "var(--ink-500)", lineHeight: 1.6 }}
            >
              {section.blurb}
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3">
              {section.entries.slice(0, 4).map((e) => (
                <span
                  key={e.slug}
                  className="text-[11px]"
                  style={{ color: "var(--ink-400)" }}
                >
                  {e.title}
                </span>
              ))}
              {section.entries.length > 4 && (
                <span className="text-[11px]" style={{ color: "var(--ink-400)" }}>
                  +{section.entries.length - 4} more
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>

      {/* Quick start */}
      <div className="mt-10">
        <span className="eyebrow">Quick start</span>
        <p
          className="text-sm mt-2 max-w-2xl"
          style={{ color: "var(--ink-500)", lineHeight: 1.7 }}
        >
          Point an animated layer at a packed dataset's <code>manifest.json</code>{" "}
          and give it a clock:
        </p>
        <CodeBlock code={QUICK_START} language="typescript" />
        <p className="text-xs" style={{ color: "var(--ink-400)" }}>
          Building your own dataset? Start with the{" "}
          <Link to="/docs/guides/data-generation" style={{ color: "var(--accent)" }}>
            data-generation guide
          </Link>{" "}
          or the{" "}
          <Link to="/docs/guides/python" style={{ color: "var(--accent)" }}>
            Python recipes
          </Link>
          .
        </p>
      </div>
    </div>
  );
};

export default DocsLanding;
