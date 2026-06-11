import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  GITHUB_BLOB_BASE,
  docSections,
  getDocEntry,
  getSectionForSlug,
} from "./manifest";
import { fileLoader, manifestSchemaRaw } from "./content";
import { extractHeadings } from "./headings";
import Markdown from "./Markdown";
import CodeBlock from "./CodeBlock";
import Toc from "./Toc";
import PrevNext from "./PrevNext";
import { useDocsContext } from "./DocsLayout";

/**
 * One documentation page: loads its lazily-bundled markdown chunk, renders it
 * with the docs prose treatment, and wires the on-this-page TOC + prev/next.
 * `spec/manifest-schema` is the one non-markdown page (pretty-printed JSON).
 */
const DocPage: React.FC = () => {
  const params = useParams();
  const slug = params["*"] ?? "";
  const entry = getDocEntry(slug);
  const section = getSectionForSlug(slug);
  const location = useLocation();
  const { contentRef } = useDocsContext();
  const getContainer = useCallback(
    () => contentRef.current,
    [contentRef],
  );

  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setRaw(null);
    setError(false);
    if (!entry || entry.kind === "json") return;
    const loader = fileLoader(entry.file);
    if (!loader) {
      setError(true);
      return;
    }
    // Guard against out-of-order resolution on rapid sidebar clicks.
    let cancelled = false;
    loader()
      .then((text) => {
        if (!cancelled) setRaw(text);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  // Scroll handling: new slug → top; hash present → anchor (after paint).
  // Both against the docs container — the window never scrolls.
  useEffect(() => {
    if (!raw && entry?.kind !== "json") return;
    if (location.hash) {
      const id = decodeURIComponent(location.hash.slice(1));
      // Let the markdown commit first.
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: "start" });
      });
    } else {
      contentRef.current?.scrollTo({ top: 0 });
    }
  }, [slug, raw, location.hash, entry, contentRef]);

  const headings = useMemo(() => (raw ? extractHeadings(raw) : []), [raw]);

  if (!entry) return <NotFound slug={slug} />;

  const isSchema = entry.kind === "json";

  return (
    <div className="flex justify-center gap-10 px-5 sm:px-8 py-8">
      <article className="docs-prose prose prose-sm md:prose-base max-w-3xl min-w-0 flex-1">
        <div className="not-prose mb-1">
          <span className="eyebrow">{section?.label}</span>
        </div>

        {isSchema ? (
          <>
            <h1>Manifest Schema</h1>
            <p>
              The machine-checkable contract for a packed dataset's{" "}
              <code>manifest.json</code> (JSON Schema 2020-12). It is pinned in
              CI against the Rust writer (<code>stt_core::pack::Manifest</code>)
              and the TypeScript reader (<code>PackedManifest</code> in{" "}
              <code>@stt/core</code>). See the{" "}
              <Link to="/docs/spec/stt-packed-format">packed format spec</Link>{" "}
              for the semantics.
            </p>
            <CodeBlock
              code={prettyJson(manifestSchemaRaw)}
              language="json"
            />
          </>
        ) : error ? (
          <p style={{ color: "var(--ink-500)" }}>
            This page failed to load. It is also available{" "}
            <a
              href={`${GITHUB_BLOB_BASE}docs/${entry.file}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              on GitHub
            </a>
            .
          </p>
        ) : raw == null ? (
          <p style={{ color: "var(--ink-400)" }}>Loading…</p>
        ) : (
          <Markdown raw={raw} currentFile={entry.file} scrollContainer={getContainer} />
        )}

        <div className="not-prose">
          <div className="mt-10 text-xs">
            <a
              href={`${GITHUB_BLOB_BASE}docs/${entry.file}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--ink-400)" }}
            >
              Edit this page on GitHub ↗
            </a>
          </div>
          <PrevNext slug={slug} />
        </div>
      </article>

      {/* On-this-page TOC (xl+) */}
      <aside className="hidden xl:block w-52 shrink-0">
        <div className="sticky top-8">
          <Toc headings={headings} getContainer={getContainer} />
        </div>
      </aside>
    </div>
  );
};

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const NotFound: React.FC<{ slug: string }> = ({ slug }) => (
  <div className="px-8 py-10 max-w-2xl">
    <span className="eyebrow">Documentation</span>
    <h1
      className="font-display text-2xl font-bold mt-2"
      style={{ color: "var(--ink-900)" }}
    >
      Page not found
    </h1>
    <p className="text-sm mt-3" style={{ color: "var(--ink-500)" }}>
      No documentation page at <code className="code-block">/docs/{slug}</code>.
      Try one of these sections:
    </p>
    <ul className="mt-5 space-y-2">
      {docSections.map((s) => (
        <li key={s.id}>
          <Link
            to={`/docs/${s.entries[0].slug}`}
            className="text-sm font-medium"
            style={{ color: "var(--accent)" }}
          >
            {s.label} →
          </Link>
        </li>
      ))}
    </ul>
  </div>
);

export default DocPage;
