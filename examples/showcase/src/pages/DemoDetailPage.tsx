import React, { useState } from "react";
import { useParams, Navigate, Link } from "react-router-dom";
import { Highlight, themes } from "prism-react-renderer";
import { getDatasetById } from "../datasets";
import {
  CATEGORY_LABELS,
  getCatalogEntry,
  getRelated,
} from "../content/demoMeta";
import DemoEmbed from "../components/demo/DemoEmbed";
import DemoCard from "../components/DemoCard";
import { SourceLogo } from "../components/SourceLogo";
import { VizBadge } from "../components/VizBadge";

/**
 * Per-demo landing page (`/demos/:id`): live embed up top, then the
 * editorial sections — what you're seeing, where the data comes from, the
 * exact build command, and which layers/techniques render it (linking into
 * the docs). Excluded datasets deep-link straight to the fullscreen viewer.
 */
const DemoDetailPage: React.FC = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const dataset = getDatasetById(datasetId || "");
  const entry = getCatalogEntry(datasetId || "");

  if (!dataset) return <Navigate to="/demos" replace />;
  // Real dataset but not catalog-curated → the fullscreen viewer still serves it.
  if (!entry) return <Navigate to={`/demo/${dataset.id}`} replace />;

  const { meta } = entry;
  const related = getRelated(dataset.id);

  return (
    // key forces a clean remount (fresh TimeController + governor) when
    // navigating between related demos.
    <div key={dataset.id} className="min-h-full px-5 sm:px-7 lg:px-12 py-8 sm:py-10">
      <div className="max-w-5xl">
        {/* Title block */}
        <nav className="text-xs" aria-label="Breadcrumb">
          <Link to="/demos" style={{ color: "var(--ink-400)" }}>
            Demos
          </Link>
          <span style={{ color: "var(--ink-400)" }}> / </span>
          <span style={{ color: "var(--ink-500)" }}>
            {CATEGORY_LABELS[meta.category]}
          </span>
        </nav>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mt-2">
          <h1
            className="font-display text-2xl sm:text-3xl font-bold"
            style={{ color: "var(--ink-900)", lineHeight: 1.15 }}
          >
            {dataset.name}
          </h1>
          <VizBadge type={dataset.type} label={meta.techniqueTag} />
        </div>
        <p
          className="text-sm mt-2 max-w-2xl"
          style={{ color: "var(--ink-500)", lineHeight: 1.7 }}
        >
          {meta.tagline ?? dataset.description}
        </p>
        {dataset.sources && dataset.sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3">
            {dataset.sources.map((s) => (
              <SourceLogo key={s} id={s} />
            ))}
          </div>
        )}

        {/* Live embed */}
        <div className="mt-6">
          <DemoEmbed dataset={dataset} />
        </div>

        {/* Editorial body */}
        <div className="mt-10 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-x-12 gap-y-10">
          <div className="min-w-0">
            <Section title="About this demo">
              {meta.about.map((p, i) => (
                <p
                  key={i}
                  className="text-sm mb-4"
                  style={{ color: "var(--ink-700)", lineHeight: 1.75 }}
                >
                  {p}
                </p>
              ))}
            </Section>

            <Section title="How it was built">
              {meta.buildCommand ? (
                <CommandBlock command={meta.buildCommand} />
              ) : null}
              {meta.buildNote && (
                <p
                  className="text-xs mt-3"
                  style={{ color: "var(--ink-500)", lineHeight: 1.65 }}
                >
                  {meta.buildNote}
                </p>
              )}
              <p className="text-xs mt-3" style={{ color: "var(--ink-400)" }}>
                Full recipes for every dataset live in the{" "}
                <Link to="/docs/guides/data-generation" style={{ color: "var(--accent)" }}>
                  data-generation guide
                </Link>
                .
              </p>
            </Section>
          </div>

          {/* Side rail: the data + techniques */}
          <aside>
            <Section title="The data">
              <ul className="space-y-3">
                {meta.dataSources.map((s) => (
                  <li key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium"
                      style={{ color: "var(--accent)" }}
                    >
                      {s.name} ↗
                    </a>
                    {s.license && (
                      <div className="text-xs mt-0.5" style={{ color: "var(--ink-500)" }}>
                        {s.license}
                      </div>
                    )}
                    {s.note && (
                      <div
                        className="text-xs mt-0.5"
                        style={{ color: "var(--ink-400)", lineHeight: 1.5 }}
                      >
                        {s.note}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Techniques">
              <ul className="space-y-2">
                {meta.techniques.map((t) => (
                  <li key={t.docPath + t.label}>
                    <Link
                      to={t.docPath}
                      className="text-sm"
                      style={{ color: "var(--accent)" }}
                    >
                      {t.label} →
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          </aside>
        </div>

        {/* Related demos */}
        {related.length > 0 && (
          <section className="mt-12">
            <div
              className="pb-2 mb-4"
              style={{ borderBottom: "1px solid var(--hairline)" }}
            >
              <h2
                className="font-display text-base font-semibold"
                style={{ color: "var(--ink-900)" }}
              >
                Related demos
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2">
              {related.map((e) => (
                <DemoCard key={e.dataset.id} entry={e} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default DemoDetailPage;

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="mb-10">
    <span className="eyebrow">{title}</span>
    <div className="mt-3">{children}</div>
  </section>
);

/** Build-command code block with a copy button. */
const CommandBlock: React.FC<{ command: string }> = ({ command }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command.replace(/\\\n\s*/g, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — quietly ignore */
    }
  };
  return (
    <div
      className="relative rounded-md overflow-hidden"
      style={{ background: "var(--surface-sunken)", border: "1px solid var(--hairline)" }}
    >
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 px-2 py-1 rounded text-[10px] font-semibold tracking-wide uppercase transition-colors"
        style={{
          background: copied ? "var(--accent)" : "var(--surface)",
          color: copied ? "#fff" : "var(--ink-500)",
          border: "1px solid var(--hairline)",
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <Highlight code={command} language="bash" theme={themes.github}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre
            className="code-block px-4 py-3 overflow-x-auto"
            style={{ background: "transparent" }}
          >
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
};
