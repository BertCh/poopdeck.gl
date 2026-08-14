import React, { Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { navDatasets } from '../datasets';
import { SourceLogo } from '../components/SourceLogo';
import { ClientOnly } from '../lib/ClientOnly';

// The live rotating globe carries all the deck.gl/playback deps; lazy + client
// only so the statically prerendered landing HTML stays deck-free (a poster
// frame renders in its place at build time).
const HomeGlobe = React.lazy(() => import('./home/HomeGlobe'));

const DeferredHomeGlobe: React.FC = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Leave hydration/LCP uncontended. Data-saver users keep the lightweight
    // poster instead of downloading a WebGL renderer and live tile stream.
    if ((navigator as any).connection?.saveData) return;
    const win = window as typeof window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(() => setReady(true), {
        timeout: 1_200,
      });
      return () => win.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setReady(true), 250);
    return () => window.clearTimeout(id);
  }, []);
  return ready ? <HomeGlobe /> : null;
};

const HomePage: React.FC = () => {
  // The curated demos for the quiet index below the hero.
  const featured = navDatasets.slice(0, 6);

  return (
    // Scroll is owned by SiteChrome's container; this page just flows.
    <div
      className="min-h-full flex flex-col"
      style={{ background: 'var(--page-bg)' }}
    >
      {/* Hero */}
      <div className="flex flex-col lg:flex-row lg:min-h-[490px]">
        {/* Left: content */}
        <div className="lg:w-[46%] flex flex-col justify-center px-5 sm:px-7 lg:px-12 py-8 sm:py-10 order-2 lg:order-1">
          <div className="max-w-md">
            <span className="eyebrow">Navigation &amp; observation</span>
            <h1
              className="font-display text-2xl sm:text-3xl lg:text-[2.6rem] font-bold mt-3 mb-5"
              style={{ color: 'var(--ink-900)', lineHeight: 1.1 }}
            >
              poopdeck<span style={{ color: 'var(--ink-400)' }}>.gl</span>
            </h1>

            <p
              className="text-base mb-4"
              style={{ color: 'var(--ink-700)', lineHeight: 1.7 }}
            >
              Time-aware{' '}
              <a
                href="https://deck.gl"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                deck.gl
              </a>{' '}
              layers and a tile format for streaming animated geospatial data —
              built for things that move: ships, drifters, cars, and anything
              with a trace.
            </p>

            <div className="flex flex-wrap gap-3">
              <Link
                to="/story/drifters"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-sm font-medium transition-opacity"
                style={{ background: 'var(--accent)', color: '#FFFFFF' }}
                onMouseOver={(e) => (e.currentTarget.style.opacity = '0.9')}
                onMouseOut={(e) => (e.currentTarget.style.opacity = '1')}
              >
                Read the drifters story <span>→</span>
              </Link>
              <Link
                to="/demos"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-sm font-medium transition-colors"
                style={{
                  border: '1px solid var(--hairline)',
                  color: 'var(--ink-700)',
                }}
                onMouseOver={(e) =>
                  (e.currentTarget.style.borderColor = 'var(--accent)')
                }
                onMouseOut={(e) =>
                  (e.currentTarget.style.borderColor = 'var(--hairline)')
                }
              >
                View demos <span>→</span>
              </Link>
            </div>
          </div>
        </div>

        {/* Right: rotating globe (dark canvas). The globe is client-only; at
            build time the map-viewport frame + label render as a static poster
            with a dark ocean fill where the canvas will hydrate. */}
        <div className="lg:w-[54%] h-56 sm:h-72 lg:h-auto order-1 lg:order-2 lg:min-h-[490px] p-3 sm:p-4 lg:p-6">
          <div className="w-full h-full rounded-lg overflow-hidden map-viewport relative">
            <ClientOnly
              fallback={
                <div
                  className="w-full h-full"
                  style={{ background: '#0a0d12' }}
                />
              }
            >
              {() => (
                <Suspense
                  fallback={
                    <div
                      className="w-full h-full"
                      style={{ background: '#0a0d12' }}
                    />
                  }
                >
                  <DeferredHomeGlobe />
                </Suspense>
              )}
            </ClientOnly>

            <div
              className="absolute top-3 left-3 px-2.5 py-1 rounded text-xs glass"
              style={{ color: 'rgba(255,255,255,0.85)' }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle"
                style={{ background: '#28B4C8' }}
              />
              Ocean current drifters
            </div>
          </div>
        </div>
      </div>

      {/* Quiet demo index */}
      <div
        className="px-5 sm:px-7 lg:px-12 py-8 sm:py-10"
        style={{ borderTop: '1px solid var(--hairline)' }}
      >
        <span className="eyebrow">Demos</span>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 sm:gap-x-8 gap-y-5 sm:gap-y-6 mt-4 max-w-4xl">
          {featured.map((d) => (
            <Link key={d.id} to={`/demos/${d.id}`} className="group block">
              {/* The accent lived on the <h3> via onMouseOver/onMouseOut — a
                  heading is not interactive, so hovering the rest of the card
                  did nothing and a keyboard user tabbing to the Link (which
                  already carries `group`) got no highlight at all. group-hover
                  / group-focus-visible move it to the real control. */}
              <h3 className="text-sm font-medium transition-colors [color:var(--ink-900)] group-hover:[color:var(--accent)] group-focus-visible:[color:var(--accent)]">
                {d.name}
              </h3>
              <p
                className="text-xs mt-1 line-clamp-2"
                style={{ color: 'var(--ink-500)', lineHeight: 1.5 }}
              >
                {d.description}
              </p>
              {d.sources && d.sources.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                  {d.sources.map((s) => (
                    <SourceLogo key={s} id={s} />
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>

        {/* Quiet pointers into the full catalog and the documentation. */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-8">
          <Link
            to="/demos"
            className="text-sm font-medium transition-colors"
            style={{ color: 'var(--accent)' }}
          >
            All demos →
          </Link>
          <Link
            to="/docs"
            className="text-sm font-medium transition-colors"
            style={{ color: 'var(--accent)' }}
          >
            Documentation →
          </Link>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
