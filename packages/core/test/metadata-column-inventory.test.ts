/**
 * `metadata.layers[].properties` — the archive's column inventory.
 *
 * The field is typed, public and documented, and it was hard-coded to `[]` on
 * every archive ever opened. A browser client asking "which columns can I style
 * by?" — the obvious next question after the quickstart's "any prop that takes
 * a constant also takes a column name" — had no answer short of hand-decoding
 * `manifest.schemas[].data` (base64 Arrow IPC) or installing the Rust CLIs on a
 * page whose whole point is that you do not need them (DX review 2026-08-26,
 * F8).
 *
 * It is now derived at open from the manifest's own embedded schema templates:
 * no tile fetch, no extra request.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { GeometryType } from '../src/types';
import {
  loadPackedDatasetFromDisk,
  packedFetch,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function dataset(name: string): InMemoryPackedDataset {
  return loadPackedDatasetFromDisk(
    fs,
    FIXTURES + name,
    `mem://data/${name}/manifest.json`,
  );
}

function openArchive(name: string): STTArchive {
  const ds = dataset(name);
  return new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
}

describe('column inventory from the manifest schema templates', () => {
  it('lists the point fixture’s user columns with their coarse types', async () => {
    const archive = openArchive('v2-golden');
    try {
      const meta = await archive.getMetadata();
      expect(meta.layers).toHaveLength(1);
      const [layer] = meta.layers;
      expect(layer.name).toBe('default');
      expect(layer.properties).toEqual([
        // `agency` and `kind` are Utf8; `speed` is a quantized UInt16 that the
        // shader dequantizes, so it is a number logically and here.
        { name: 'agency', type: 'string' },
        { name: 'kind', type: 'string' },
        { name: 'speed', type: 'number' },
      ]);
      expect(layer.geometryTypes).toEqual([GeometryType.Point]);
    } finally {
      archive.finalize();
    }
  });

  it('reads geometry kind off the CORE template for a trajectory archive', async () => {
    const archive = openArchive('v2-golden-tracks');
    try {
      const meta = await archive.getMetadata();
      const [layer] = meta.layers;
      expect(layer.geometryTypes).toEqual([GeometryType.LineString]);
      expect(layer.properties).toEqual([{ name: 'speed', type: 'number' }]);
    } finally {
      archive.finalize();
    }
  });

  it('never advertises a decoder-owned column as a styleable property', async () => {
    const archive = openArchive('v2-golden-tracks');
    try {
      const meta = await archive.getMetadata();
      const names = meta.layers.flatMap((l) => l.properties.map((p) => p.name));
      // `vertex_time` and `geometry` both ride the tracks CORE template.
      for (const reserved of [
        'id',
        'start_time',
        'end_time',
        'geometry',
        'vertex_time',
      ]) {
        expect(names).not.toContain(reserved);
      }
    } finally {
      archive.finalize();
    }
  });

  it('degrades to an empty list, not a throw, on an archive with no templates', async () => {
    // `packed-golden` is a formatVersion-1 archive: inline schemas, no
    // `manifest.schemas` table to derive anything from.
    const archive = openArchive('packed-golden');
    try {
      const meta = await archive.getMetadata();
      expect(meta.layers).toEqual([
        { name: 'default', properties: [], geometryTypes: [] },
      ]);
    } finally {
      archive.finalize();
    }
  });

  it('is stable across repeated calls (the metadata cache is not re-derived)', async () => {
    const archive = openArchive('v2-golden');
    try {
      const first = await archive.getMetadata();
      const second = await archive.getMetadata();
      expect(second).toBe(first);
      expect(second.layers[0].properties).toHaveLength(3);
    } finally {
      archive.finalize();
    }
  });
});
