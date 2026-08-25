import React, { Suspense, useState } from 'react';
import { useParams, Navigate, Link, type MetaFunction } from 'react-router';
import { Highlight, themes } from 'prism-react-renderer';
import { getDatasetById } from '../datasets';
import {
  CATEGORY_LABELS,
  getCatalogEntry,
  getRelated,
} from '../content/demoMeta';
import DemoCard from '../components/DemoCard';
import InlineProse from '../components/InlineProse';
import { SourceLogo } from '../components/SourceLogo';
import { VizBadge } from '../components/VizBadge';
import CubeInLine from '../components/demo/CubeInLine';
import { profileIdFromUrl } from '../lib/densityProfile';
import { ClientOnly } from '../lib/ClientOnly';
import { createSeoMeta } from '../lib/seo';

export const meta: MetaFunction = ({ params }) => {
  const id = params.datasetId ?? '';
  const dataset = getDatasetById(id);
  const entry = getCatalogEntry(id);
  if (!dataset || !entry) {
    return createSeoMeta({
      title: 'Demo not found',
      description: 'Browse the public SpatioTemporal Tiles demo catalog.',
      path: '/demos',
      noIndex: true,
    });
  }
  return createSeoMeta({
    title: dataset.name,
    description: entry.meta.tagline ?? dataset.description,
    path: `/demos/${dataset.id}`,
  });
};

// The live map embed carries deck.gl + the playback stack; lazy + client only
// so the statically prerendered detail HTML stays deck-free (a framed poster
// renders in its place at build time, replaced by the live viewer on hydrate).
const DemoEmbed = React.lazy(() => import('../components/demo/DemoEmbed'));

/**
 * Per-demo landing page (`/demos/:id`): live embed up top, then the
 * editorial sections — what you're seeing, where the data comes from, the
 * exact build command, and which layers/techniques render it (linking into
 * the docs). Excluded datasets deep-link straight to the fullscreen viewer.
 */
const DemoDetailPage: React.FC = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const dataset = getDatasetById(datasetId || '');
  const entry = getCatalogEntry(datasetId || '');

  if (!dataset) return <Navigate to="/demos" replace />;
  // Real dataset but not catalog-curated → the fullscreen viewer still serves it.
  if (!entry) return <Navigate to={`/demo/${dataset.id}`} replace />;

  const { meta } = entry;
  const related = getRelated(dataset.id);

  return (
    // key forces a clean remount (fresh TimeController + governor) when
    // navigating between related demos.
    <div
      key={dataset.id}
      className="min-h-full px-5 sm:px-7 lg:px-12 py-8 sm:py-10"
    >
      <div className="max-w-5xl">
        {/* Title block */}
        <nav className="text-xs" aria-label="Breadcrumb">
          <Link to="/demos" style={{ color: 'var(--ink-400)' }}>
            Demos
          </Link>
          <span style={{ color: 'var(--ink-400)' }}> / </span>
          <span style={{ color: 'var(--ink-500)' }}>
            {CATEGORY_LABELS[meta.category]}
          </span>
        </nav>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mt-2">
          <h1
            className="font-display text-2xl sm:text-3xl font-bold"
            style={{ color: 'var(--ink-900)', lineHeight: 1.15 }}
          >
            {dataset.name}
          </h1>
          <VizBadge type={dataset.type} label={meta.techniqueTag} />
        </div>
        <p
          className="text-sm mt-2 max-w-2xl"
          style={{ color: 'var(--ink-500)', lineHeight: 1.7 }}
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

        {/* Live embed (client-only; a framed poster prerenders in its place).
            Wrapped in a local error boundary so a throwing demo embed degrades
            to an inline notice instead of blanking the whole app via the root
            ErrorBoundary — the page chrome and editorial body survive. */}
        <div className="mt-6">
          <EmbedErrorBoundary>
            <ClientOnly fallback={<EmbedPoster />}>
              {() => (
                <Suspense fallback={<EmbedPoster />}>
                  <DemoEmbed dataset={dataset} />
                </Suspense>
              )}
            </ClientOnly>
          </EmbedErrorBoundary>
        </div>

        {/* Editorial body */}
        <div className="mt-10 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-x-12 gap-y-10">
          <div className="min-w-0">
            <Section title="About this demo">
              {/* The `about` strings are authored in inline markdown (code
                  spans, links) — render them, or the page ships literal
                  backticks to production. */}
              {meta.about.map((p, i) => (
                <p
                  key={i}
                  className="text-sm mb-4"
                  style={{ color: 'var(--ink-700)', lineHeight: 1.75 }}
                >
                  <InlineProse text={p} />
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
                  style={{ color: 'var(--ink-500)', lineHeight: 1.65 }}
                >
                  <InlineProse text={meta.buildNote} />
                </p>
              )}
              <p className="text-xs mt-3" style={{ color: 'var(--ink-400)' }}>
                Full recipes for every dataset live in the{' '}
                <Link
                  to="/docs/guides/data-generation"
                  style={{ color: 'var(--accent)' }}
                >
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
                      style={{ color: 'var(--accent)' }}
                    >
                      {s.name} ↗
                    </a>
                    {s.license && (
                      <div
                        className="text-xs mt-0.5"
                        style={{ color: 'var(--ink-500)' }}
                      >
                        {s.license}
                      </div>
                    )}
                    {s.note && (
                      <div
                        className="text-xs mt-0.5"
                        style={{ color: 'var(--ink-400)', lineHeight: 1.5 }}
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
                      style={{ color: 'var(--accent)' }}
                    >
                      {t.label} →
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          </aside>
        </div>

        {/* Under the hood: this demo's own cube, laid down in a line (hideable) */}
        <UnderTheHood url={dataset.url} />

        {/* Related demos */}
        {related.length > 0 && (
          <section className="mt-12">
            <div
              className="pb-2 mb-4"
              style={{ borderBottom: '1px solid var(--hairline)' }}
            >
              <h2
                className="font-display text-base font-semibold"
                style={{ color: 'var(--ink-900)' }}
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

/**
 * Static stand-in for the live embed: the same framed box, shown in the
 * prerendered HTML and while the deck.gl viewer chunk streams in on hydrate.
 */
const EmbedPoster: React.FC = () => (
  <div>
    <div
      className="relative rounded-lg overflow-hidden h-[320px] sm:h-[420px] lg:h-[520px]"
      style={{ background: 'var(--surface-sunken)' }}
    />
  </div>
);

/**
 * Localized boundary around the live embed. If a demo's deck.gl/WebGL surface
 * throws during render, only this box shows the error notice — the surrounding
 * page (title, editorial body, related demos) and the app chrome stay intact,
 * instead of the throw propagating to the root ErrorBoundary and blanking the
 * whole app. Resets automatically on navigation: the page keys its root on
 * `dataset.id`, so switching demos remounts this boundary fresh.
 */
class EmbedErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="relative rounded-lg overflow-hidden h-[320px] sm:h-[420px] lg:h-[520px] flex items-center justify-center px-6 text-center"
          style={{
            background: 'var(--surface-sunken)',
            border: '1px solid var(--hairline)',
            color: 'var(--ink-500)',
          }}
        >
          <p className="text-sm" style={{ lineHeight: 1.6 }}>
            This demo couldn&rsquo;t be rendered. The rest of the page is still
            available below.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Below-the-fold "meta" explorer: this dataset's space-time cube laid down in a
 * line, with the real density that decides which blob-ordering wins. Collapsed
 * by default; the profile only fetches once opened (CubeInLine loads it lazily).
 */
const UnderTheHood: React.FC<{ url: string }> = ({ url }) => {
  const [open, setOpen] = useState(false);
  const id = profileIdFromUrl(url);
  if (!id) return null; // no local archive → nothing to profile
  return (
    <section className="mt-12">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 pb-2 text-left"
        style={{ borderBottom: '1px solid var(--hairline)' }}
      >
        <span
          className="inline-block transition-transform"
          style={{
            color: 'var(--ink-400)',
            transform: open ? 'rotate(90deg)' : 'none',
          }}
          aria-hidden="true"
        >
          ▸
        </span>
        <h2
          className="font-display text-base font-semibold"
          style={{ color: 'var(--ink-900)' }}
        >
          Under the hood: this dataset's space-time cube, laid down in a line
        </h2>
      </button>
      {open ? (
        <div className="mt-4">
          <p
            className="text-xs mb-3 max-w-2xl"
            style={{ color: 'var(--ink-500)', lineHeight: 1.65 }}
          >
            A meta view of the format itself: how this archive's data mass sits
            across space and time, and how the{' '}
            <span className="font-mono">--blob-ordering</span> walk that
            flattens the cube into one byte string trades off range reads.
            Switch datasets to watch the winning walk flip.{' '}
            <Link to="/how-it-works#archive" style={{ color: 'var(--accent)' }}>
              How it works →
            </Link>
          </p>
          <CubeInLine id={id} />
        </div>
      ) : null}
    </section>
  );
};

/** Build-command code block with a copy button. */
const CommandBlock: React.FC<{ command: string }> = ({ command }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command.replace(/\\\n\s*/g, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — quietly ignore */
    }
  };
  return (
    <div
      className="relative rounded-md overflow-hidden"
      style={{
        background: 'var(--surface-sunken)',
        border: '1px solid var(--hairline)',
      }}
    >
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 px-2 py-1 rounded text-[10px] font-semibold tracking-wide uppercase transition-colors"
        style={{
          background: copied ? 'var(--accent)' : 'var(--surface)',
          color: copied ? '#fff' : 'var(--ink-500)',
          border: '1px solid var(--hairline)',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <Highlight code={command} language="bash" theme={themes.github}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre
            className="code-block px-4 py-3 overflow-x-auto"
            style={{ background: 'transparent' }}
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
