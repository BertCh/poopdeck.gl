import React from 'react';
import { Link, type MetaFunction } from 'react-router';
import {
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  CATEGORY_BLURBS,
  getCatalog,
  getUncataloguedByType,
} from '../content/demoMeta';
import { DEV_FULL_INDEX } from '../datasets';
import DemoCard from '../components/DemoCard';
// Reused, not re-derived: `av` scenes belong in /drive and `worlds` at /worlds,
// and hardcoding /demo/:id here would reintroduce exactly the dead-end that
// helper was extracted to fix.
import { fullscreenRoute } from '../components/demo/DemoEmbed';
import { createSeoMeta } from '../lib/seo';

export const meta: MetaFunction = () =>
  createSeoMeta({
    title: 'Spatiotemporal data demos',
    description:
      'Explore real ships, earthquakes, ocean drifters, transit, weather, mobility, and other time-aware vector datasets rendered with STT.',
    path: '/demos',
  });

/**
 * The full demo catalog (`/demos`): every healthy dataset grouped by theme.
 * Deliberately static — cards carry no live maps, so this page costs zero
 * tile traffic; the live embeds live on the per-demo pages.
 *
 * On a local build (`DEV_FULL_INDEX`) a plain-text index of every UNCARDED
 * dataset follows the cards. It is intentionally text, not `DemoCard`s: a card
 * promises editorial prose that these ids have none of, and ~150 more cards
 * would bury the twelve the page exists to present.
 */
const DemosCatalog: React.FC = () => {
  const catalog = getCatalog();
  const uncatalogued = DEV_FULL_INDEX ? getUncataloguedByType() : null;
  const uncataloguedCount = uncatalogued
    ? [...uncatalogued.values()].reduce((n, list) => n + list.length, 0)
    : 0;

  return (
    <div className="min-h-full px-5 sm:px-7 lg:px-12 py-8 sm:py-12">
      <div className="max-w-5xl">
        <span className="eyebrow">Demos</span>
        <h1
          className="font-display text-2xl sm:text-3xl font-bold mt-2"
          style={{ color: 'var(--ink-900)', lineHeight: 1.15 }}
        >
          The catalog
        </h1>
        <p
          className="text-sm mt-3 max-w-xl"
          style={{ color: 'var(--ink-500)', lineHeight: 1.7 }}
        >
          Every demo streams a real dataset as spatiotemporal tiles. Each page
          explains the data, how the archive was built, and which layers render
          it.
        </p>

        {CATEGORY_ORDER.map((cat) => {
          const entries = catalog.get(cat) ?? [];
          if (entries.length === 0) return null;
          return (
            <section key={cat} className="mt-10 sm:mt-12">
              <div
                className="pb-2 mb-4"
                style={{ borderBottom: '1px solid var(--hairline)' }}
              >
                <h2
                  className="font-display text-base font-semibold"
                  style={{ color: 'var(--ink-900)' }}
                >
                  {CATEGORY_LABELS[cat]}
                </h2>
                <p className="text-xs mt-1" style={{ color: 'var(--ink-400)' }}>
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

        {uncatalogued && uncataloguedCount > 0 && (
          <section className="mt-14 sm:mt-16">
            <div
              className="pb-2 mb-4"
              style={{ borderBottom: '1px solid var(--hairline)' }}
            >
              <h2
                className="font-display text-base font-semibold"
                style={{ color: 'var(--ink-900)' }}
              >
                Everything else{' '}
                <span
                  className="font-normal text-xs align-middle ml-1 px-1.5 py-0.5 rounded"
                  style={{
                    color: 'var(--ink-500)',
                    border: '1px solid var(--hairline)',
                  }}
                >
                  local only
                </span>
              </h2>
              <p className="text-xs mt-1" style={{ color: 'var(--ink-400)' }}>
                {uncataloguedCount} further datasets in the registry with no
                catalog card — other cuts of the same archives, render-mode
                variants, and work in progress. They stream from{' '}
                <code>public/data</code> and are not part of the public deploy.
              </p>
            </div>
            {[...uncatalogued.entries()].map(([type, list]) => (
              <div key={type} className="mt-5">
                <h3
                  className="text-xs font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--ink-500)' }}
                >
                  {type}{' '}
                  <span style={{ color: 'var(--ink-400)' }}>
                    ({list.length})
                  </span>
                </h3>
                <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                  {list.map((d) => (
                    <li key={d.id}>
                      <Link
                        to={fullscreenRoute(d).to}
                        className="text-xs transition-colors hover:[color:var(--accent)] focus-visible:[color:var(--accent)]"
                        style={{ color: 'var(--ink-700)' }}
                        title={d.name}
                      >
                        {d.id}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
};

export default DemosCatalog;
