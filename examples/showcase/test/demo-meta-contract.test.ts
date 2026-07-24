/**
 * Demo-catalog ↔ registry contract test.
 *
 * `src/content/demoMeta.ts` is the curation source of truth: a dataset is in
 * the `/demos` catalog iff it has a DEMO_META entry. This test pins the
 * invariants that keep the catalog, the runtime dataset registry, and the
 * repo docs from silently drifting apart.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  datasets,
  getDatasetById,
  isRemoteGated,
  SHIPPED_DATASET_IDS,
} from '../src/datasets';
import {
  DEMO_META,
  CATALOG_EXCLUDED_IDS,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  getCatalog,
  getRelated,
} from '../src/content/demoMeta';

const metaIds = Object.keys(DEMO_META);

/** Resolve "/docs/api/<slug>" to the repo markdown file backing it. */
function docFilePath(docPath: string): string {
  // /docs/<section>/<slug> → <repo>/docs/<section>/<slug>.md
  const rel = docPath.replace(/^\/docs\//, '');
  return fileURLToPath(new URL(`../../../docs/${rel}.md`, import.meta.url));
}

/** Every free-text field rendered through InlineProse on `/demos/:id`. */
function proseOf(meta: (typeof DEMO_META)[string]): string[] {
  return meta.buildNote ? [...meta.about, meta.buildNote] : [...meta.about];
}

/** Markdown link targets that stay inside the app (leading "/"). */
function internalLinkTargets(text: string): string[] {
  return [...text.matchAll(/\[[^\]]+\]\((\/[^)\s]*)\)/g)].map((m) => m[1]);
}

/** Non-dataset routes from `src/routes.ts` the prose is allowed to link. */
const STATIC_ROUTES = new Set([
  '/',
  '/demos',
  '/how-it-works',
  '/docs',
  '/drive',
  '/worlds',
  '/story/drifters',
]);

describe('demo catalog curation invariants', () => {
  it('every DEMO_META key resolves to a real dataset id', () => {
    for (const id of metaIds) {
      expect(
        getDatasetById(id),
        `DEMO_META["${id}"] has no dataset`,
      ).toBeTruthy();
    }
  });

  it('every dataset is either catalog-included or deliberately excluded', () => {
    for (const d of datasets) {
      const included = id(d) in DEMO_META;
      const excluded = CATALOG_EXCLUDED_IDS.includes(d.id);
      expect(
        included !== excluded,
        `dataset ${d.id} must be in exactly one of DEMO_META / CATALOG_EXCLUDED_IDS`,
      ).toBe(true);
    }
    function id(d: { id: string }): string {
      return d.id;
    }
  });

  it('excluded-by-design ids have no DEMO_META entry (re-inclusion is a reviewed act)', () => {
    for (const id of CATALOG_EXCLUDED_IDS) {
      expect(
        DEMO_META[id],
        `${id} is excluded but has a DEMO_META entry`,
      ).toBeUndefined();
    }
  });

  // The mirror of the case above, and the one that was missing: an exclusion
  // that names nothing is invisible rot. Ten `nuscenes-*-splat` ids sat here for
  // months excluding datasets that were never built (nuScenes is not in
  // COLORED_SPLAT_BASE_IDS), and no test could see it — "has no DEMO_META entry"
  // is trivially true for an id that doesn't exist. Runs against the LOCAL
  // registry (no VITE_DATA_BASE_URL under vitest), so the Waymo / not-yet-synced
  // ids that the remote deploy filters out still resolve here.
  it('excluded-by-design ids resolve to real datasets (no stale exclusions)', () => {
    for (const id of CATALOG_EXCLUDED_IDS) {
      expect(
        getDatasetById(id),
        `CATALOG_EXCLUDED_IDS lists "${id}", which is not a registered dataset — delete the stale exclusion`,
      ).toBeTruthy();
    }
  });

  it('every SHIPPED dataset has a DEMO_META entry', () => {
    for (const id of SHIPPED_DATASET_IDS) {
      expect(
        DEMO_META[id],
        `shipped dataset ${id} missing from catalog`,
      ).toBeTruthy();
    }
  });

  // …and the converse, so the two curated lists can't drift into telling
  // different stories again: SHIPPED_DATASET_IDS drives the home-page grid and
  // DEMO_META drives /demos, and before 2026-07 they disagreed on 7 of 13 ids.
  // They are now ONE curated set (order still matters — the first six are the
  // grid). Adding a card means adding it to both.
  it('every catalog entry is a SHIPPED dataset (one curated set, not two)', () => {
    for (const id of metaIds) {
      expect(
        SHIPPED_DATASET_IDS.includes(id),
        `DEMO_META has "${id}" but SHIPPED_DATASET_IDS does not — add it there or drop the card`,
      ).toBe(true);
    }
  });

  it('categories are valid and every category is non-empty', () => {
    for (const [id, meta] of Object.entries(DEMO_META)) {
      expect(CATEGORY_ORDER, `${id}.category`).toContain(meta.category);
      expect(
        CATEGORY_LABELS[meta.category],
        `${id}.category label`,
      ).toBeTruthy();
    }
    const catalog = getCatalog();
    for (const cat of CATEGORY_ORDER) {
      expect(
        catalog.get(cat)!.length,
        `category ${cat} is empty`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('demo meta editorial content', () => {
  for (const [id, meta] of Object.entries(DEMO_META)) {
    describe(`${id}`, () => {
      it('has at least two non-empty about paragraphs', () => {
        expect(meta.about.length).toBeGreaterThanOrEqual(2);
        for (const p of meta.about) {
          expect(p.trim().length).toBeGreaterThan(0);
        }
      });

      it('has a non-empty technique tag', () => {
        expect(meta.techniqueTag.trim().length).toBeGreaterThan(0);
      });

      it('has at least one data source with a valid http(s) url', () => {
        expect(meta.dataSources.length).toBeGreaterThanOrEqual(1);
        for (const s of meta.dataSources) {
          expect(s.name.trim().length).toBeGreaterThan(0);
          expect(s.url, `${id} source ${s.name}`).toMatch(/^https?:\/\//);
        }
      });

      it('has a build command or an explanatory build note', () => {
        expect(
          Boolean(meta.buildCommand) || Boolean(meta.buildNote),
          `${id} needs buildCommand or buildNote`,
        ).toBe(true);
      });

      it('technique doc links point at markdown files that exist on disk', () => {
        expect(meta.techniques.length).toBeGreaterThanOrEqual(1);
        for (const t of meta.techniques) {
          expect(t.docPath, `${id} technique ${t.label}`).toMatch(
            /^\/docs\/[a-z-]+\/[a-z0-9-]+$/,
          );
          const file = docFilePath(t.docPath);
          expect(
            existsSync(file),
            `${id} technique "${t.label}" → ${t.docPath} has no file at ${file}`,
          ).toBe(true);
        }
      });

      it('related ids resolve, are catalog members, and never self-reference', () => {
        for (const rid of meta.related) {
          expect(rid, `${id}.related`).not.toBe(id);
          expect(
            getDatasetById(rid),
            `${id}.related → ${rid} not a dataset`,
          ).toBeTruthy();
          expect(
            DEMO_META[rid],
            `${id}.related → ${rid} not in catalog`,
          ).toBeTruthy();
        }
      });

      // The prose is where the 36 demos cut from the catalog in 2026-07 stayed
      // reachable, so its links are load-bearing, not decoration. Two ways they
      // rot: a typo'd id (dead on every environment), and a link into a demo
      // that only resolves under `npm run dev` because its archives aren't on
      // R2 yet — that one looks fine locally and 404s in production.
      it('inline prose links point at routes that exist on the public deploy', () => {
        for (const text of proseOf(meta)) {
          for (const target of internalLinkTargets(text)) {
            const demo = /^\/demo\/([^/#?]+)/.exec(target);
            const drive = /^\/drive\/([^/#?]+)/.exec(target);
            const datasetId = demo?.[1] ?? drive?.[1];
            if (datasetId) {
              expect(
                getDatasetById(datasetId),
                `${id} prose links ${target}, but "${datasetId}" is not a dataset`,
              ).toBeTruthy();
              expect(
                isRemoteGated(datasetId),
                `${id} prose links ${target}, but "${datasetId}" is gated off the public deploy (LOCAL_ONLY_DATASETS / Waymo) — the link would 404 in production`,
              ).toBe(false);
              if (drive) {
                expect(
                  getDatasetById(datasetId)!.type,
                  `${id} prose links ${target}, but "${datasetId}" is not an AV scene — /drive can't render it`,
                ).toBe('av');
              }
              continue;
            }
            expect(
              STATIC_ROUTES.has(target),
              `${id} prose links ${target}, which is not a route this app serves`,
            ).toBe(true);
          }
        }
      });
    });
  }

  it('getRelated returns resolved catalog entries', () => {
    const rel = getRelated('ocean-drifters');
    expect(rel.length).toBeGreaterThan(0);
    for (const e of rel) {
      expect(e.dataset.id).toBeTruthy();
      expect(e.meta.category).toBeTruthy();
    }
  });
});
