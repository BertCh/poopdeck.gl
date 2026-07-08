import React, { useCallback, useEffect, useMemo } from 'react';
import {
  Link,
  useLoaderData,
  useLocation,
  useParams,
  type ClientLoaderFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import {
  GITHUB_BLOB_BASE,
  docSections,
  getDocEntry,
  getSectionForSlug,
} from './manifest';
import { fileLoader, manifestSchemaRaw } from './content';
import { extractHeadings } from './headings';
import Markdown from './Markdown';
import CodeBlock from './CodeBlock';
import Toc from './Toc';
import PrevNext from './PrevNext';
import { useDocsContext } from './DocsLayout';

/**
 * One documentation page. The markdown body is read in the route `loader` so
 * it is baked into the prerendered static HTML (real SEO, no client fetch);
 * the component renders `useLoaderData()` synchronously. `spec/manifest-schema`
 * is the one non-markdown page (pretty-printed JSON).
 *
 * The loader reuses the same `import.meta.glob('?raw')` loaders as the docs
 * manifest contract test — during the build prerender pass (Vite SSR) they
 * resolve to the file contents, so the resolution stays in lockstep with the
 * glob the test pins. `clientLoader` handles client-side navigations: known
 * (prerendered) slugs delegate to the baked loader data; unknown slugs render
 * the styled 404 without needing a runtime server.
 */

type DocData =
  | { slug: string; notFound: true }
  | { slug: string; notFound?: false; kind: 'markdown' | 'json'; raw: string };

export async function loader({ params }: LoaderFunctionArgs): Promise<DocData> {
  const slug = params['*'] ?? '';
  const entry = getDocEntry(slug);
  if (!entry) throw new Response('Not found', { status: 404 });
  if (entry.kind === 'json') {
    return { slug, kind: 'json', raw: manifestSchemaRaw };
  }
  const load = fileLoader(entry.file);
  if (!load) throw new Response('Not found', { status: 404 });
  return { slug, kind: 'markdown', raw: await load() };
}

export async function clientLoader({
  params,
  serverLoader,
}: ClientLoaderFunctionArgs): Promise<DocData> {
  const slug = params['*'] ?? '';
  // Unknown slug isn't prerendered → no baked data to fetch; render the 404.
  if (!getDocEntry(slug)) return { slug, notFound: true };
  return serverLoader<DocData>();
}

const DocPage: React.FC = () => {
  const params = useParams();
  const slug = params['*'] ?? '';
  const data = useLoaderData() as DocData;
  const entry = getDocEntry(slug);
  const section = getSectionForSlug(slug);
  const location = useLocation();
  const { contentRef } = useDocsContext();
  const getContainer = useCallback(() => contentRef.current, [contentRef]);

  const notFound = data.notFound === true || !entry;
  const raw = notFound ? '' : data.raw;
  const isSchema = !notFound && data.kind === 'json';

  // Scroll handling: new slug → top; hash present → anchor (after paint).
  // Both against the docs container — the window never scrolls.
  useEffect(() => {
    if (notFound) return;
    if (location.hash) {
      const id = decodeURIComponent(location.hash.slice(1));
      // Let the markdown commit first.
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: 'start' });
      });
    } else {
      contentRef.current?.scrollTo({ top: 0 });
    }
  }, [slug, location.hash, contentRef, notFound]);

  const headings = useMemo(
    () => (raw && !isSchema ? extractHeadings(raw) : []),
    [raw, isSchema],
  );

  if (notFound || !entry) return <NotFound slug={slug} />;

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
              The machine-checkable contract for a packed dataset's{' '}
              <code>manifest.json</code> (JSON Schema 2020-12). It is pinned in
              CI against the Rust writer (<code>stt_core::pack::Manifest</code>)
              and the TypeScript reader (<code>PackedManifest</code> in{' '}
              <code>@poopdeck.gl/core</code>). See the{' '}
              <Link to="/docs/spec/stt-packed-format">packed format spec</Link>{' '}
              for the semantics.
            </p>
            <CodeBlock code={prettyJson(raw)} language="json" />
          </>
        ) : (
          <Markdown
            raw={raw}
            currentFile={entry.file}
            scrollContainer={getContainer}
          />
        )}

        <div className="not-prose">
          <div className="mt-10 text-xs">
            <a
              href={`${GITHUB_BLOB_BASE}docs/${entry.file}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--ink-400)' }}
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
      style={{ color: 'var(--ink-900)' }}
    >
      Page not found
    </h1>
    <p className="text-sm mt-3" style={{ color: 'var(--ink-500)' }}>
      No documentation page at <code className="code-block">/docs/{slug}</code>.
      Try one of these sections:
    </p>
    <ul className="mt-5 space-y-2">
      {docSections.map((s) => (
        <li key={s.id}>
          <Link
            to={`/docs/${s.entries[0].slug}`}
            className="text-sm font-medium"
            style={{ color: 'var(--accent)' }}
          >
            {s.label} →
          </Link>
        </li>
      ))}
    </ul>
  </div>
);

export default DocPage;
