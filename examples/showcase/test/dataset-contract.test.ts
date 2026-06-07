/**
 * Showcase ↔ dataset contract test.
 *
 * The showcase registry (`src/datasets.ts`) is coupled to the generated STT
 * datasets entirely by hand-typed strings (paths, `colorProperty`,
 * `radiusProperty`, …). This test turns a class of that silent drift into a
 * real failure.
 *
 * Packed-format note: a dataset is no longer a single `.stt` file but a packed
 * DIRECTORY (`/data/<stem>/manifest.json` + `index/<hash>.sttd` +
 * `packs/<hash>.sttp`; see `docs/spec/stt-packed-format.md`). A `url` therefore
 * points at the dataset's `manifest.json`, and `STTArchive` resolves the index
 * and pack objects relative to it.
 *
 * What this test covers:
 *   - Structural invariants on the registry itself (always runnable, no
 *     datasets on disk needed — these run in CI).
 *   - Manifest-path well-formedness for every referenced dataset (the path
 *     shape `/data/<stem>/manifest.json`), and — when a dataset directory is
 *     present on disk — that its `manifest.json` parses and points at sibling
 *     index/pack objects. The packed datasets are git-ignored, so an absent
 *     directory is SKIPPED (with a notice) rather than failed, keeping CI green
 *     while still exercising everything locally.
 *
 * (Previously this opened the single-file `.stt` and asserted bounds/zoom/time
 * via `STTArchive`. Under the packed format the on-disk shape changed to a
 * directory, so the disk check now validates the manifest object instead of
 * range-reading a monolithic blob — see the orchestrator notes / option (b).)
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { datasets } from '../src/datasets';

/** Resolve a dataset `url` ("/data/<stem>/manifest.json") to its on-disk path. */
function localPath(url: string): string {
  return fileURLToPath(new URL(`../public${url}`, import.meta.url));
}

describe('dataset registry structural invariants', () => {
  it('every dataset id is unique', () => {
    const ids = datasets.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every dataset url is a packed manifest path (/data/<stem>/manifest.json)', () => {
    for (const d of datasets) {
      expect(d.url, `dataset ${d.id}`).toBeTruthy();
      expect(
        d.url.endsWith('/manifest.json'),
        `dataset ${d.id} url=${d.url} should end in /manifest.json`,
      ).toBe(true);
      // /data/<stem>/manifest.json — a non-empty stem segment between the
      // /data/ prefix and the manifest filename. (A VITE_DATA_BASE_URL prefix
      // is not applied in tests, so the path stays origin-relative.)
      expect(
        /\/data\/[^/]+\/manifest\.json$/.test(d.url),
        `dataset ${d.id} url=${d.url} should match /data/<stem>/manifest.json`,
      ).toBe(true);
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
        const v = (d as unknown as Record<string, unknown>)[key];
        if (v !== undefined) {
          expect(typeof v, `${d.id}.${key}`).toBe('string');
          expect((v as string).length, `${d.id}.${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('colorPalette entries are RGBA 4-number arrays', () => {
    for (const d of datasets) {
      const palette = (d as unknown as Record<string, unknown>).colorPalette as
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

// One case per UNIQUE url (several datasets can share a packed dataset).
const uniqueUrls = Array.from(new Set(datasets.map((d) => d.url)));

/** Minimal shape of the packed `manifest.json` we assert on. */
interface PackedManifest {
  format?: string;
  formatVersion?: number;
  directory?: { key?: string; length?: number };
  packs?: Array<{ key?: string; length?: number }>;
  metadata?: unknown;
}

describe('referenced packed datasets are well-formed', () => {
  for (const url of uniqueUrls) {
    const consumers = datasets.filter((d) => d.url === url).map((d) => d.id);
    it(`${url} (used by: ${consumers.join(', ')})`, () => {
      const manifestPath = localPath(url);
      if (!existsSync(manifestPath)) {
        // Git-ignored packed dataset absent (e.g. in CI). Don't fail; record it.
        console.warn(
          `[contract] SKIP ${url} — manifest not present at ${manifestPath}`,
        );
        return;
      }

      const manifest = JSON.parse(
        readFileSync(manifestPath, 'utf8'),
      ) as PackedManifest;

      // Manifest shape (mirrors docs/spec/stt-packed-format.md §3).
      expect(manifest.format, `${url} format`).toBe('stt-packed');
      expect(manifest.metadata, `${url} metadata`).toBeTruthy();
      expect(manifest.directory?.key, `${url} directory.key`).toMatch(
        /^index\/.+\.sttd$/,
      );
      expect(Array.isArray(manifest.packs), `${url} packs`).toBe(true);
      expect(manifest.packs!.length, `${url} pack count`).toBeGreaterThan(0);

      // Resolve siblings relative to the manifest and confirm they exist on
      // disk — the same relative resolution STTArchive does against the URL.
      const dir = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
      for (const ref of [manifest.directory!, ...manifest.packs!]) {
        expect(ref.key, `${url} ref.key`).toBeTruthy();
        expect(ref.key!.startsWith('packs/') || ref.key!.startsWith('index/')).toBe(true);
        expect(
          existsSync(dir + ref.key!),
          `${url} → sibling object ${ref.key} missing on disk`,
        ).toBe(true);
      }
    });
  }
});
