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
import { datasets, getDatasetById, SHIPPED_DATASET_IDS } from '../src/datasets';
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

describe('demo catalog curation invariants', () => {
  it('every DEMO_META key resolves to a real dataset id', () => {
    for (const id of metaIds) {
      expect(getDatasetById(id), `DEMO_META["${id}"] has no dataset`).toBeTruthy();
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
      expect(DEMO_META[id], `${id} is excluded but has a DEMO_META entry`).toBeUndefined();
    }
  });

  it('every SHIPPED dataset has a DEMO_META entry', () => {
    for (const id of SHIPPED_DATASET_IDS) {
      expect(DEMO_META[id], `shipped dataset ${id} missing from catalog`).toBeTruthy();
    }
  });

  it('categories are valid and every category is non-empty', () => {
    for (const [id, meta] of Object.entries(DEMO_META)) {
      expect(CATEGORY_ORDER, `${id}.category`).toContain(meta.category);
      expect(CATEGORY_LABELS[meta.category], `${id}.category label`).toBeTruthy();
    }
    const catalog = getCatalog();
    for (const cat of CATEGORY_ORDER) {
      expect(catalog.get(cat)!.length, `category ${cat} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('demo meta editorial content', () => {
  for (const [id, meta] of Object.entries(DEMO_META)) {
    describe(id, () => {
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
          expect(getDatasetById(rid), `${id}.related → ${rid} not a dataset`).toBeTruthy();
          expect(DEMO_META[rid], `${id}.related → ${rid} not in catalog`).toBeTruthy();
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
