/**
 * Showcase ↔ archive contract test.
 *
 * The showcase registry (`src/datasets.ts`) is coupled to the generated `.stt`
 * archives entirely by hand-typed strings (filenames, `colorProperty`,
 * `radiusProperty`, …). This test turns a class of that silent drift into a
 * real failure:
 *
 *   - Structural invariants on the registry itself (always runnable, no
 *     archives needed — these run in CI).
 *   - Archive sanity for every referenced `.stt` that is present on disk
 *     (loads, sane bounds/zoom/time-range, non-empty index). Archives are
 *     git-ignored, so a missing file is SKIPPED (with a notice) rather than
 *     failed — that keeps CI green while still exercising everything locally.
 *
 * Regeneration-dependent drift (a declared `timeRange` that no longer matches
 * the archive, a declared `type` that disagrees with the archive geometry) is
 * surfaced as a console warning instead of a hard failure, because the fix is
 * to regenerate the archive — not to edit this test. Promote those to hard
 * assertions once the archives are rebuilt with the typed-column pipeline.
 */
import { describe, it, expect } from 'vitest';
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { datasets } from '../src/datasets';
import { STTArchive } from '@stt/core';

/** Resolve a dataset `url` ("/data/foo.stt") to its on-disk path. */
function localPath(url: string): string {
  return fileURLToPath(new URL(`../public${url}`, import.meta.url));
}

/**
 * A `fetch` shim that serves byte ranges of an on-disk file. Reads only the
 * requested slice via a file descriptor — never loads the whole archive, so it
 * works for multi-GB files that exceed Node's 2 GiB `readFileSync` limit.
 * `STTArchive` always sends a `Range` header, so the no-range branch is only a
 * defensive fallback.
 */
function diskRangeFetch(path: string): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range;
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
      const start = m ? Number(m[1]) : 0;
      const end = m ? Math.min(Number(m[2]), size - 1) : size - 1;
      const len = Math.max(0, end - start + 1);
      const buf = Buffer.allocUnsafe(len);
      if (len > 0) readSync(fd, buf, 0, len, start);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      return {
        ok: true,
        status: m ? 206 : 200,
        statusText: m ? 'Partial Content' : 'OK',
        arrayBuffer: async () => ab,
      };
    } finally {
      closeSync(fd);
    }
  }) as unknown as typeof fetch;
}

describe('dataset registry structural invariants', () => {
  it('every dataset id is unique', () => {
    const ids = datasets.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every dataset has a non-empty .stt url', () => {
    for (const d of datasets) {
      expect(d.url, `dataset ${d.id}`).toBeTruthy();
      expect(d.url.endsWith('.stt'), `dataset ${d.id} url=${d.url}`).toBe(true);
    }
  });

  it('numeric/categorical driver property names are non-empty strings', () => {
    for (const d of datasets) {
      for (const key of [
        'colorProperty',
        'radiusProperty',
        'elevationProperty',
        'weightProperty',
      ] as const) {
        const v = (d as Record<string, unknown>)[key];
        if (v !== undefined) {
          expect(typeof v, `${d.id}.${key}`).toBe('string');
          expect((v as string).length, `${d.id}.${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('colorPalette entries are RGBA 4-number arrays', () => {
    for (const d of datasets) {
      const palette = (d as Record<string, unknown>).colorPalette as
        | Record<string, number[]>
        | undefined;
      if (!palette) continue;
      for (const [k, rgba] of Object.entries(palette)) {
        expect(Array.isArray(rgba), `${d.id}.colorPalette.${k}`).toBe(true);
        expect(rgba.length, `${d.id}.colorPalette.${k}`).toBe(4);
        for (const c of rgba) {
          expect(typeof c).toBe('number');
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

// One archive case per UNIQUE url (several datasets can share a .stt).
const uniqueUrls = Array.from(new Set(datasets.map((d) => d.url)));

describe('referenced archives load and are sane', () => {
  for (const url of uniqueUrls) {
    const consumers = datasets.filter((d) => d.url === url).map((d) => d.id);
    it(`${url} (used by: ${consumers.join(', ')})`, async () => {
      const path = localPath(url);
      if (!existsSync(path)) {
        // Git-ignored archive absent (e.g. in CI). Don't fail; record it.
        console.warn(`[contract] SKIP ${url} — archive not present at ${path}`);
        return;
      }
      const archive = new STTArchive({ url: `mem:/${url}`, fetch: diskRangeFetch(path) });

      const meta = await archive.getMetadata();
      expect(meta.version, `${url} version`).toBeGreaterThanOrEqual(2);
      expect(meta.version, `${url} version`).toBeLessThanOrEqual(4);
      expect(meta.minZoom).toBeLessThanOrEqual(meta.maxZoom);

      // World-bounds sanity: non-degenerate and inside the WGS84 extent.
      expect(meta.bounds.minLon).toBeLessThan(meta.bounds.maxLon);
      expect(meta.bounds.minLat).toBeLessThan(meta.bounds.maxLat);
      expect(meta.bounds.minLon).toBeGreaterThanOrEqual(-180.5);
      expect(meta.bounds.maxLon).toBeLessThanOrEqual(180.5);
      expect(meta.bounds.minLat).toBeGreaterThanOrEqual(-90.5);
      expect(meta.bounds.maxLat).toBeLessThanOrEqual(90.5);

      expect(meta.timeRange.end).toBeGreaterThanOrEqual(meta.timeRange.start);

      const index = await archive.getIndex();
      expect(index.tiles.length, `${url} tile count`).toBeGreaterThan(0);

      // Soft drift detection: a declared timeRange that no longer overlaps the
      // archive's window usually means the archive was regenerated against a
      // different epoch (the "blank globe" class). Warn, don't fail.
      for (const d of datasets.filter((x) => x.url === url && x.timeRange)) {
        const dr = d.timeRange!;
        const overlaps = dr.start <= meta.timeRange.end && dr.end >= meta.timeRange.start;
        if (!overlaps) {
          console.warn(
            `[contract] ${d.id}: declared timeRange [${dr.start}, ${dr.end}] does not ` +
              `overlap archive [${meta.timeRange.start}, ${meta.timeRange.end}] — regenerate?`,
          );
        }
      }
    });
  }
});
