/**
 * Manifest `style_hints` block: parse + expose.
 *
 * The Rust writer measures per-property value distributions at build time and
 * folds an OPTIONAL snake_case `style_hints` block into the manifest metadata.
 * The TS reader surfaces it as camelCase {@link StyleHints} on
 * `ArchiveMetadata.styleHints`. The hints are build-time-measured DEFAULTS
 * only — layers / spec / user config always override them — so the parser
 * must be strictly additive: a missing or malformed block degrades to
 * `undefined` (never a throw), a malformed property entry is dropped
 * individually, and unknown extra keys are ignored.
 */

import { describe, it, expect } from 'vitest';
import { STTArchive, parseStyleHints, suggestedDomainFor } from '../src/archive';
import { encodeDirectory } from '../src/directory';
import type { StyleHints } from '../src/types';
import { packedFetch, type InMemoryPackedDataset } from './helpers/packed-fixture';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The pinned wire shape, verbatim (snake_case, numeric + categorical). */
const WIRE_FIXTURE = {
  version: 1,
  properties: [
    {
      name: 'magnitude',
      min: 0.1,
      p50: 2.0,
      p90: 4.1,
      p95: 4.9,
      p97: 5.3,
      p99: 6.2,
      max: 9.1,
      suggested_domain: [0.1, 5.3],
      cardinality: null,
    },
    { name: 'category', cardinality: 7 },
  ],
  suggested_playback_seconds: 45,
  layer_hint: 'points',
};

const EXPECTED_HINTS: StyleHints = {
  version: 1,
  properties: [
    {
      name: 'magnitude',
      min: 0.1,
      p50: 2.0,
      p90: 4.1,
      p95: 4.9,
      p97: 5.3,
      p99: 6.2,
      max: 9.1,
      suggestedDomain: [0.1, 5.3],
    },
    { name: 'category', cardinality: 7 },
  ],
  suggestedPlaybackSeconds: 45,
  layerHint: 'points',
};

// ---------------------------------------------------------------------------
// parseStyleHints
// ---------------------------------------------------------------------------

describe('parseStyleHints', () => {
  it('parses the pinned snake_case wire shape into exact camelCase', () => {
    const hints = parseStyleHints(WIRE_FIXTURE);
    expect(hints).toEqual(EXPECTED_HINTS);
    // Categorical entries carry ONLY name + cardinality — the numeric fields
    // must be truly absent (not null/undefined-filled), and the numeric
    // entry's null-filled `cardinality` must not leak through.
    expect(Object.keys(hints!.properties[1])).toEqual(['name', 'cardinality']);
    expect('cardinality' in hints!.properties[0]).toBe(false);
  });

  it('returns undefined for an absent or non-object block', () => {
    expect(parseStyleHints(undefined)).toBeUndefined();
    expect(parseStyleHints(null)).toBeUndefined();
    expect(parseStyleHints('style')).toBeUndefined();
    expect(parseStyleHints(42)).toBeUndefined();
    expect(parseStyleHints([WIRE_FIXTURE])).toBeUndefined();
  });

  it('returns undefined when version is missing or malformed', () => {
    expect(parseStyleHints({ properties: [] })).toBeUndefined();
    expect(parseStyleHints({ version: '1', properties: [] })).toBeUndefined();
    expect(parseStyleHints({ version: NaN, properties: [] })).toBeUndefined();
  });

  it('drops malformed property entries individually, keeping the rest', () => {
    const hints = parseStyleHints({
      version: 1,
      properties: [
        { name: 'good', min: 0, p97: 9, suggested_domain: [0, 9] },
        { name: 'string-min', min: '0.1', max: 9.1 }, // wrong type → dropped
        { name: 'bad-domain', suggested_domain: [0, 5, 9] }, // 3 elements → dropped
        { name: 'nan-domain', suggested_domain: [0, NaN] }, // non-finite → dropped
        { min: 0, max: 1 }, // no name → dropped
        'not-an-object', // → dropped
        { name: 'categorical', cardinality: 3 },
      ],
      suggested_playback_seconds: 30,
    });
    expect(hints).toEqual({
      version: 1,
      properties: [
        { name: 'good', min: 0, p97: 9, suggestedDomain: [0, 9] },
        { name: 'categorical', cardinality: 3 },
      ],
      suggestedPlaybackSeconds: 30,
    });
  });

  it('degrades non-array properties to an empty list without losing the block', () => {
    const hints = parseStyleHints({
      version: 1,
      properties: { name: 'oops' },
      suggested_playback_seconds: 60,
      layer_hint: 'trips',
    });
    expect(hints).toEqual({
      version: 1,
      properties: [],
      suggestedPlaybackSeconds: 60,
      layerHint: 'trips',
    });
  });

  it('drops malformed optional block fields but keeps the block', () => {
    const hints = parseStyleHints({
      version: 1,
      properties: [],
      suggested_playback_seconds: 'forever',
      layer_hint: 'hexagons', // not a recognized hint
    });
    expect(hints).toEqual({ version: 1, properties: [] });
  });

  it('tolerates unknown extra keys at block and entry level', () => {
    const hints = parseStyleHints({
      version: 1,
      future_block_field: { nested: true },
      properties: [{ name: 'magnitude', p97: 5.3, future_entry_field: 'x' }],
    });
    expect(hints).toEqual({
      version: 1,
      properties: [{ name: 'magnitude', p97: 5.3 }],
    });
  });
});

// ---------------------------------------------------------------------------
// suggestedDomainFor
// ---------------------------------------------------------------------------

describe('suggestedDomainFor', () => {
  const hints = parseStyleHints(WIRE_FIXTURE);

  it('returns the parsed domain for a numeric property', () => {
    expect(suggestedDomainFor(hints, 'magnitude')).toEqual([0.1, 5.3]);
  });

  it('returns undefined on a miss', () => {
    // No such property.
    expect(suggestedDomainFor(hints, 'nope')).toBeUndefined();
    // Categorical entry: present but carries no domain.
    expect(suggestedDomainFor(hints, 'category')).toBeUndefined();
    // No hints at all (archive predates the block).
    expect(suggestedDomainFor(undefined, 'magnitude')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: getMetadata surfaces styleHints from the manifest metadata
// ---------------------------------------------------------------------------

let synthSeq = 0;

/**
 * Build a minimal in-memory packed archive (one dummy tile) carrying the
 * given metadata JSON — mirrors the temporal-lod tests' synthetic builder;
 * the path under test only reads the manifest.
 */
function buildSyntheticArchive(metadata: unknown): InMemoryPackedDataset {
  const pack = new Uint8Array([0]);
  const indexBytes = encodeDirectory([
    {
      zoom: 0,
      x: 0,
      y: 0,
      timeStart: 0,
      timeEnd: 3_600_000,
      packId: 0,
      offset: 0,
      length: 1,
      uncompressedSize: 1,
      featureCount: 1,
      hilbert: 0,
      crc32c: 0,
    },
  ]);
  const objects = new Map<string, Uint8Array>();
  objects.set('packs/p0.sttp', pack);
  objects.set('index/dir.sttd', indexBytes);
  const manifest = {
    format: 'stt-packed',
    formatVersion: 1,
    compression: 'none',
    directory: { key: 'index/dir.sttd', length: indexBytes.byteLength, directoryVersion: 5 },
    packs: [{ key: 'packs/p0.sttp', length: pack.byteLength }],
    metadata,
  };
  objects.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  return { objects, manifestUrl: `mem://style-hints-${synthSeq++}/manifest.json` };
}

const BASE_METADATA = {
  name: 'hints',
  bounds: { min_lon: -1, min_lat: -1, max_lon: 1, max_lat: 1 },
  time_range: { start: 0, end: 3_600_000 },
  temporal_bucket_ms: 3_600_000,
};

describe('style hints: metadata round-trip', () => {
  it('decodes style_hints from archive metadata JSON', async () => {
    const ds = buildSyntheticArchive({ ...BASE_METADATA, style_hints: WIRE_FIXTURE });
    const archive = new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
    const meta = await archive.getMetadata();
    expect(meta.styleHints).toEqual(EXPECTED_HINTS);
    expect(suggestedDomainFor(meta.styleHints, 'magnitude')).toEqual([0.1, 5.3]);
  });

  it('leaves styleHints undefined for archives without the block', async () => {
    const ds = buildSyntheticArchive(BASE_METADATA);
    const archive = new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
    const meta = await archive.getMetadata();
    expect(meta.styleHints).toBeUndefined();
  });

  it('never throws on a malformed block — metadata still parses', async () => {
    const ds = buildSyntheticArchive({ ...BASE_METADATA, style_hints: 'garbage' });
    const archive = new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
    const meta = await archive.getMetadata();
    expect(meta.styleHints).toBeUndefined();
    expect(meta.name).toBe('hints');
  });
});
