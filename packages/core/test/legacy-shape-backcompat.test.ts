/**
 * Legacy-container read guard.
 *
 * These frozen **formatVersion 2** archives are the real thing — v2 manifests
 * with no `variants` registry, directory codec v5, and no paged per-frame
 * hashes — committed so the compatibility path has coverage that does not
 * depend on anyone's local data directory.
 *
 * They were negative fixtures under the original clean-cutover plan. They are
 * positive ones now, and the reason is worth stating: several published
 * archives have no reproducible source (no generator, or a login-gated one), so
 * a read-side cutover would not have migrated them — it would have stranded
 * them permanently. The break is container-only; tile payloads share this
 * reader's layer-frame version, so supporting v2 forks nothing below the
 * container.
 *
 * The WRITER remains v3-only. Nothing here softens what gets produced.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import {
  loadPackedDatasetFromDisk,
  packedFetch,
} from './helpers/packed-fixture';

const FIXTURES = fileURLToPath(
  new URL('./fixtures/legacy-shape/', import.meta.url),
);
const DATASETS = ['flows', 'currents', 'points', 'tracks'] as const;

function openFixture(name: string): STTArchive {
  const dataset = loadPackedDatasetFromDisk(
    fs,
    FIXTURES + name,
    `mem://legacy/${name}/manifest.json`,
  );
  return new STTArchive({
    url: dataset.manifestUrl,
    fetch: packedFetch(dataset),
  });
}

describe('legacy formatVersion-2 archives', () => {
  for (const name of DATASETS) {
    it(`opens ${name} v2 and reads its metadata`, async () => {
      const metadata = await openFixture(name).getMetadata();
      expect(metadata).toBeDefined();
      // Real bounds and a real time range — proof the manifest was genuinely
      // parsed, not merely accepted.
      expect(Number.isFinite(metadata.bounds.minLon)).toBe(true);
      expect(metadata.timeRange.end).toBeGreaterThanOrEqual(
        metadata.timeRange.start,
      );
    });

    it(`decodes ${name} v2 directory entries as the raw variant`, async () => {
      const { tiles } = await openFixture(name).getIndex();
      expect(tiles.length).toBeGreaterThan(0);
      // A v5 directory carries no variant column. Every entry must therefore
      // read back as variant 0 — which is what those archives meant, since the
      // variant axis did not exist when they were written. Anything else means
      // the decoder mis-parsed the column layout and every following field
      // would be shifted.
      for (const entry of tiles) {
        expect(entry.variantId ?? 0).toBe(0);
        expect(entry.zoom).toBeGreaterThanOrEqual(0);
        expect(entry.length).toBeGreaterThan(0);
        expect(entry.timeEnd).toBeGreaterThanOrEqual(entry.timeStart);
      }
    });
  }

  it('still refuses a container BELOW the supported window', async () => {
    // The relaxation is a window, not an amnesty: v1 predates the packed
    // container entirely and stays refused.
    const dataset = loadPackedDatasetFromDisk(
      fs,
      FIXTURES + 'flows',
      'mem://legacy/too-old/manifest.json',
    );
    // The loader keys the manifest by name, not by URL, and rewrites the
    // object keys to content addresses — so re-serialise the one it built.
    const built = JSON.parse(
      new TextDecoder().decode(dataset.objects.get('manifest.json')!),
    );
    built.formatVersion = 1;
    dataset.objects.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(built)),
    );
    const archive = new STTArchive({
      url: dataset.manifestUrl,
      fetch: packedFetch(dataset),
    });
    await expect(archive.getMetadata()).rejects.toThrow(
      /unsupported formatVersion 1/,
    );
  });
});
