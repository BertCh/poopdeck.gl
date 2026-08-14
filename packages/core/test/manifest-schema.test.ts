/**
 * Contract test: the published manifest JSON Schema is the source of truth for
 * the packed-format `manifest.json`, and the Rust-produced golden fixture
 * conforms to it.
 *
 * This guards the cross-language wire boundary. The Rust writer
 * (`crate::pack::Manifest`), the TS reader type ({@link PackedManifest}) and
 * `docs/spec/manifest.schema.json` must all agree; if any drifts, this fails.
 *
 * A tiny dependency-free validator covers the subset of JSON Schema the
 * manifest schema actually uses (type / const / enum / required / properties /
 * additionalProperties as `false` OR as a sub-schema / items / minItems /
 * maxItems / minimum / pattern). The negative cases below prove it actually
 * rejects drift rather than rubber-stamping anything.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PackedManifest } from '../src';
import { Compression, KNOWN_MANIFEST_CAPABILITIES } from '../src';
import { manifestBuildAssumedGapBytes } from '../src/archive';

const SCHEMA_PATH = fileURLToPath(
  new URL('../../../docs/spec/manifest.schema.json', import.meta.url),
);
const GOLDEN_MANIFEST_PATH = fileURLToPath(
  new URL('./fixtures/packed-golden/manifest.json', import.meta.url),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = any;

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkType(v: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    default:
      return true;
  }
}

/** Validate `value` against `schema`, accumulating human-readable errors. */
function validate(
  value: unknown,
  schema: Schema,
  path = '$',
  errors: string[] = [],
): string[] {
  if ('const' in schema && value !== schema.const) {
    errors.push(
      `${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
    );
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(
      `${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`,
    );
  }
  if (schema.type && !checkType(value, schema.type)) {
    errors.push(`${path}: expected type ${schema.type}, got ${jsType(value)}`);
    return errors;
  }
  if (
    typeof value === 'number' &&
    schema.minimum !== undefined &&
    value < schema.minimum
  ) {
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }
  if (
    typeof value === 'string' &&
    schema.pattern &&
    !new RegExp(schema.pattern).test(value)
  ) {
    errors.push(
      `${path}: ${JSON.stringify(value)} does not match /${schema.pattern}/`,
    );
  }
  if (jsType(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj))
        errors.push(`${path}: missing required property "${req}"`);
    }
    const props: Record<string, Schema> = schema.properties ?? {};
    const extra = schema.additionalProperties;
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) validate(v, props[k], `${path}.${k}`, errors);
      else if (extra === false)
        errors.push(`${path}: unexpected property "${k}"`);
      // `additionalProperties` as a SUB-SCHEMA is how the fingerprint's
      // per-column maps (`numeric_ranges`, `categorical_cardinality`,
      // `column_tolerance`) pin their VALUES while leaving the key set open —
      // column names are dataset-specific, the shape of what they map to is
      // not. Without this branch those maps would validate vacuously.
      else if (extra && typeof extra === 'object')
        validate(v, extra, `${path}.${k}`, errors);
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(
        `${path}: array length ${value.length} < minItems ${schema.minItems}`,
      );
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(
        `${path}: array length ${value.length} > maxItems ${schema.maxItems}`,
      );
    }
    if (schema.items)
      value.forEach((item, i) =>
        validate(item, schema.items, `${path}[${i}]`, errors),
      );
  }
  return errors;
}

const schema: Schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const golden = JSON.parse(readFileSync(GOLDEN_MANIFEST_PATH, 'utf8'));

describe('packed-format manifest contract', () => {
  it('the published schema is well-formed and pins formatVersion 3', () => {
    expect(schema.$schema).toContain('json-schema.org');
    expect(schema.properties.format.const).toBe('stt-packed');
    // formatVersion is the closed [3] enum — the authoritative
    // discriminator (packed spec §5.2); readers refuse anything else at open.
    expect(schema.properties.formatVersion.enum).toEqual([3]);
    expect(schema.properties.directory.properties.directoryVersion.const).toBe(
      6,
    );
    expect(schema.properties.directory.properties.encoding.enum).toEqual([
      'zstd',
    ]);
    expect(schema.properties.directory.required).not.toContain('encoding');
    // formatVersion-3 `schemas` table (packed spec §3.2): declared with the
    // {hash, data} entry shape, never required (v1 manifests omit the key).
    const schemas = schema.properties.schemas;
    expect(schemas.type).toBe('array');
    expect(schemas.items.required).toEqual(['hash', 'data']);
    expect(schemas.items.properties.hash.pattern).toBe('^[0-9a-f]{32}$');
    expect(schema.required).not.toContain('schemas');
  });

  it('the Rust-produced golden manifest conforms to the schema', () => {
    const errors = validate(golden, schema);
    expect(errors).toEqual([]);
  });

  it('the Rust-produced current golden manifest conforms too (schemas table)', () => {
    const goldenV2 = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('./fixtures/v2-golden/manifest.json', import.meta.url),
        ),
        'utf8',
      ),
    );
    expect(validate(goldenV2, schema)).toEqual([]);
    // Assignable to the exported type, with the v2 additions populated.
    const m: PackedManifest = goldenV2;
    expect(m.formatVersion).toBe(3);
    expect(m.schemas!.length).toBeGreaterThan(0);
    // Sorted by hash + deduped (byte-reproducible manifests, spec §3.2).
    const hashes = m.schemas!.map((s) => s.hash);
    expect(hashes).toEqual([...hashes].sort());
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('the golden manifest is assignable to the exported PackedManifest type', () => {
    // Compile-time: the public type must be importable and structurally match.
    const m: PackedManifest = golden;
    expect(m.format).toBe('stt-packed');
    expect(m.formatVersion).toBe(3);
    expect(m.directory.directoryVersion).toBe(6);
    // The Rust writer compresses the directory at rest and declares it.
    expect(m.directory.encoding).toBe('zstd');
    expect(m.packs.length).toBeGreaterThan(0);
  });

  it('the validator rejects drift (negative cases)', () => {
    const wrongFormat = { ...golden, format: 'stt-v4' };
    expect(validate(wrongFormat, schema).length).toBeGreaterThan(0);

    const wrongVersion = { ...golden, formatVersion: 2 };
    expect(validate(wrongVersion, schema).length).toBeGreaterThan(0);

    const badSchemaEntry = {
      ...golden,
      schemas: [{ hash: 'NOT-HEX', data: 'AAAA' }],
    };
    expect(
      validate(badSchemaEntry, schema).some((e) => /does not match/.test(e)),
    ).toBe(true);

    const missingPacks = { ...golden };
    delete (missingPacks as Record<string, unknown>).packs;
    expect(validate(missingPacks, schema).some((e) => /packs/.test(e))).toBe(
      true,
    );

    const badPackKey = {
      ...golden,
      packs: [{ key: 'packs/not-a-hash.sttp', length: 10 }],
    };
    expect(
      validate(badPackKey, schema).some((e) => /does not match/.test(e)),
    ).toBe(true);

    const badDirVersion = {
      ...golden,
      directory: { ...golden.directory, directoryVersion: 4 },
    };
    expect(validate(badDirVersion, schema).length).toBeGreaterThan(0);

    const badEncoding = {
      ...golden,
      directory: { ...golden.directory, encoding: 'br' },
    };
    expect(validate(badEncoding, schema).some((e) => /enum/.test(e))).toBe(
      true,
    );
  });

  it('the schema compression enum matches the ACTIVE TS Compression codecs (gzip retired)', () => {
    // F5: mechanically pin the schema's compression enum to the TS Compression
    // enum so the two can no longer silently drift. gzip was retired with the
    // legacy single-file format — it is absent from BOTH the packed schema and
    // the TS enum, and byte 1 stays permanently reserved (never renumber).
    const CODEC_NAME: Record<Compression, string> = {
      [Compression.None]: 'none',
      [Compression.Zstd]: 'zstd',
    };
    const schemaCodecs = new Set<string>(schema.properties.compression.enum);
    const activeCodecs = new Set(
      [Compression.None, Compression.Zstd].map((c) => CODEC_NAME[c]),
    );
    expect(schemaCodecs).toEqual(activeCodecs);
    // Byte 1 (retired gzip) is neither a TS enum member nor a schema value.
    expect((Compression as Record<string, unknown>).Gzip).toBeUndefined();
    expect(Compression.Zstd).toBe(2); // byte 1 stays reserved — never renumber
    expect(schemaCodecs.has('gzip')).toBe(false);
  });

  it('capabilities is additive: optional, open-ended string array (must-understand, §3.1)', () => {
    // Schema pin: declared (so its shape is pinned) but never required. The
    // golden fixture DOES use a re-typing feature (compact times), so it now
    // declares `["time-delta"]` — and every entry it declares must be one the
    // TS reader implements, or `openPackedArchive` would refuse it.
    const cap = schema.properties.capabilities;
    expect(cap.type).toBe('array');
    expect(cap.items.type).toBe('string');
    expect(cap.items.enum).toBeUndefined(); // open-ended registry, by design
    expect(schema.required).not.toContain('capabilities');
    expect(golden.capabilities).toEqual(['time-delta']);
    for (const c of golden.capabilities ?? []) {
      expect(KNOWN_MANIFEST_CAPABILITIES).toContain(c);
    }
    // …and OPTIONAL means optional: strip the key and the manifest still
    // validates. (This is the half of the old `'capabilities' in golden ===
    // false` assertion that was actually about the schema rather than about
    // which flags the fixture generator happened to pass.)
    const { capabilities: _omitted, ...withoutCapabilities } = golden;
    expect(validate(withoutCapabilities, schema)).toEqual([]);

    // A quantized build's declaration validates…
    expect(
      validate(
        { ...golden, capabilities: ['coord-quant', 'attr-quant'] },
        schema,
      ),
    ).toEqual([]);
    // …and so does a FUTURE registry entry: readers enforce their own
    // implemented set (and refuse), the schema envelope stays open.
    expect(
      validate({ ...golden, capabilities: ['from-the-future'] }, schema),
    ).toEqual([]);
    // A non-string entry is drift, not evolution.
    expect(
      validate({ ...golden, capabilities: [42] }, schema).length,
    ).toBeGreaterThan(0);

    // The TS reader's implemented set is pinned against the schema's
    // machine-readable registry — the SINGLE source of truth both reference
    // implementations assert against (the Rust side pins in
    // crates/stt-core/tests/capability_registry.rs), so a registry addition
    // on either side fails CI until the schema and both readers agree.
    const registry = (schema as Record<string, unknown>)[
      'x-stt-capability-registry'
    ];
    expect(Array.isArray(registry)).toBe(true);
    expect([...KNOWN_MANIFEST_CAPABILITIES].sort()).toEqual(
      [...(registry as string[])].sort(),
    );
    const m: PackedManifest = { ...golden, capabilities: ['coord-quant'] };
    expect(m.capabilities).toEqual(['coord-quant']);
  });

  it('tolerates unknown fields at every envelope level (additive evolution)', () => {
    // Readers must ignore fields they do not recognize, so the schema must
    // not reject them — otherwise external validators built from it would
    // refuse manifests from any newer writer.
    const extended = {
      ...golden,
      generation: 7,
      directory: { ...golden.directory, sectionOffsets: [0, 64] },
      packs: golden.packs.map((p: Record<string, unknown>) => ({
        ...p,
        tier: 'raw',
      })),
    };
    expect(validate(extended, schema)).toEqual([]);
  });

  it('a raw v3 directory pointer (no `encoding` key) still validates', () => {
    const legacyDir = { ...golden.directory };
    delete (legacyDir as Record<string, unknown>).encoding;
    expect(validate({ ...golden, directory: legacyDir }, schema)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// M7 — the manifest-honesty blocks (SH-1 fingerprint, SH-2 z_range, SH-3
// ordering workload). Normative text: docs/spec/conformance.md §3.
//
// These three are the only manifest fields whose whole point is that they make
// a CLAIM about content rather than describing structure, so their wire shape
// is pinned harder than the envelope around them: a malformed claim is worse
// than an absent one, because the validator would compare against it.
// ───────────────────────────────────────────────────────────────────────────

/** The workload block a `measured` build records, at both pinned keys. */
const WORKLOAD = {
  scrub: 3,
  pan: 2,
  playback: 1,
  playback_window_buckets: 8,
  runway_multiplier: 4,
  coalesce_gap_bytes: 2 * 1024 * 1024,
};

/** A well-formed version-1 content fingerprint. */
const FINGERPRINT = {
  version: 1,
  bbox: [-122.52, 37.7, -122.35, 37.83],
  z_range: [0, 1250.5],
  distinct_feature_count: 4096,
  numeric_ranges: { speed: [0, 31.25] },
  categorical_cardinality: { kind: 3 },
  coord_tolerance_deg: 0,
  column_tolerance: {},
};

/**
 * The golden manifest plus every M7 honesty block, i.e. the shape an archive
 * rebuilt in window R1 carries.
 */
function honest(
  metadataOver: Record<string, unknown> = {},
  topOver: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...golden,
    blobOrdering: 'time-major',
    orderingWorkload: WORKLOAD,
    metadata: {
      ...golden.metadata,
      z_range: [0, 1250.5],
      content_fingerprint: FINGERPRINT,
      ordering_workload: WORKLOAD,
      ...metadataOver,
    },
    ...topOver,
  };
}

/** The fingerprint with one field replaced (or deleted, when `undefined`). */
function fingerprintWith(
  over: Record<string, unknown>,
  drop?: string,
): Record<string, unknown> {
  const fp: Record<string, unknown> = { ...FINGERPRINT, ...over };
  if (drop) delete fp[drop];
  return { content_fingerprint: fp };
}

describe('manifest honesty blocks (M7)', () => {
  it('a manifest carrying all three blocks validates', () => {
    expect(validate(honest(), schema)).toEqual([]);
  });

  it('all three are additive — absent, the manifest still validates', () => {
    // The byte-identity criterion: an archive built before the fields existed
    // (which is every published archive) must not be made non-conformant by
    // adding them to the schema.
    expect(validate(golden, schema)).toEqual([]);
    expect(schema.required).not.toContain('orderingWorkload');
    expect(schema.properties.metadata.required).toBeUndefined();
    const meta = { ...golden.metadata };
    for (const k of ['z_range', 'content_fingerprint', 'ordering_workload'])
      delete (meta as Record<string, unknown>)[k];
    expect(validate({ ...golden, metadata: meta }, schema)).toEqual([]);
  });

  it('rejects a wrong-arity fingerprint bbox (too few AND too many)', () => {
    // The bbox is the containment claim the scrambled-coordinate check is
    // evaluated against; a 3- or 5-element one is not a bbox.
    for (const bbox of [
      [-1, -1, 1],
      [-1, -1, 1, 1, 9],
    ]) {
      const errors = validate(honest(fingerprintWith({ bbox })), schema);
      expect(
        errors.some((e) => /content_fingerprint\.bbox: array length/.test(e)),
      ).toBe(true);
    }
    // A non-numeric element is drift too.
    expect(
      validate(honest(fingerprintWith({ bbox: [-1, -1, 1, 'east'] })), schema)
        .length,
    ).toBeGreaterThan(0);
  });

  it('requires the four load-bearing fingerprint fields', () => {
    for (const key of [
      'version',
      'bbox',
      'distinct_feature_count',
      'coord_tolerance_deg',
    ]) {
      const errors = validate(honest(fingerprintWith({}, key)), schema);
      expect(
        errors.some((e) => e.includes(`missing required property "${key}"`)),
      ).toBe(true);
    }
    // The optional halves really are optional.
    expect(
      validate(
        honest({
          content_fingerprint: {
            version: 1,
            bbox: [-1, -1, 1, 1],
            distinct_feature_count: 0,
            coord_tolerance_deg: 0,
          },
        }),
        schema,
      ),
    ).toEqual([]);
  });

  it('pins the per-column maps: open keys, closed value shapes', () => {
    // Column NAMES are dataset-specific, so the key set stays open; what they
    // map to is a contract (`[min, max]` pairs, non-negative counts/slack).
    expect(
      validate(
        honest(fingerprintWith({ numeric_ranges: { speed: [0, 1, 2] } })),
        schema,
      ).some((e) => /numeric_ranges\.speed: array length/.test(e)),
    ).toBe(true);
    expect(
      validate(
        honest(fingerprintWith({ categorical_cardinality: { kind: 2.5 } })),
        schema,
      ).some((e) => /categorical_cardinality\.kind/.test(e)),
    ).toBe(true);
    expect(
      validate(
        honest(fingerprintWith({ column_tolerance: { speed: -0.5 } })),
        schema,
      ).some((e) => /column_tolerance\.speed: -0\.5 < minimum/.test(e)),
    ).toBe(true);
    // …and an arbitrary column name is fine.
    expect(
      validate(
        honest(
          fingerprintWith({
            numeric_ranges: { 'mag/☂': [-1, 1], other: [0, 0] },
          }),
        ),
        schema,
      ),
    ).toEqual([]);
  });

  it('rejects a tolerance that is not a non-negative number', () => {
    // Tolerances are capability-gated slack; a malformed one would widen every
    // comparison, which is exactly the laundering the gate exists to stop.
    for (const bad of ['1e-5', -1]) {
      expect(
        validate(honest(fingerprintWith({ coord_tolerance_deg: bad })), schema)
          .length,
      ).toBeGreaterThan(0);
    }
    expect(
      validate(
        honest(fingerprintWith({ distinct_feature_count: 12.5 })),
        schema,
      ).some((e) => /distinct_feature_count: expected type integer/.test(e)),
    ).toBe(true);
  });

  it('tolerates unknown keys INSIDE the fingerprint (additive evolution)', () => {
    // A version-2 writer adding a statistic must not make the block invalid
    // for a version-1 validator, which warns and skips on the version instead.
    expect(
      validate(
        honest(fingerprintWith({ version: 2, temporal_histogram: [1, 2, 3] })),
        schema,
      ),
    ).toEqual([]);
  });

  it('pins metadata.z_range to exactly two numbers', () => {
    for (const bad of [[0], [0, 1, 2], '0..1250']) {
      expect(validate(honest({ z_range: bad }), schema).length).toBeGreaterThan(
        0,
      );
    }
    expect(validate(honest({ z_range: [-430, 18500.5] }), schema)).toEqual([]);
  });

  it('pins coalesce_gap_bytes to an integer at BOTH ordering-workload keys', () => {
    const bad = { ...WORKLOAD, coalesce_gap_bytes: 2097152.5 };
    expect(
      validate(honest({ ordering_workload: bad }), schema).some((e) =>
        /metadata\.ordering_workload\.coalesce_gap_bytes: expected type integer/.test(
          e,
        ),
      ),
    ).toBe(true);
    expect(
      validate(honest({}, { orderingWorkload: bad }), schema).some((e) =>
        /orderingWorkload\.coalesce_gap_bytes: expected type integer/.test(e),
      ),
    ).toBe(true);
    // A missing member of the workload tuple is drift, not evolution: the
    // block co-versions a layout, and a partial one cannot be compared.
    const partial: Record<string, unknown> = { ...WORKLOAD };
    delete partial.runway_multiplier;
    expect(
      validate(honest({}, { orderingWorkload: partial }), schema).some((e) =>
        e.includes('missing required property "runway_multiplier"'),
      ),
    ).toBe(true);
  });

  it('the two ordering-workload copies are pinned to the SAME shape', () => {
    // The spec MUST is "a writer emitting one emits both, with equal values",
    // so the two schema declarations must not be allowed to drift apart.
    const top = schema.properties.orderingWorkload;
    const mirror = schema.properties.metadata.properties.ordering_workload;
    expect(mirror.type).toBe(top.type);
    expect([...mirror.required].sort()).toEqual([...top.required].sort());
    expect(Object.keys(mirror.properties).sort()).toEqual(
      Object.keys(top.properties).sort(),
    );
    for (const key of Object.keys(top.properties)) {
      expect(mirror.properties[key].type).toBe(top.properties[key].type);
      expect(mirror.properties[key].minimum).toBe(top.properties[key].minimum);
    }
  });

  it('the shipped reader resolves the build-assumed gap through the MIRROR', () => {
    // Why the mirror exists at all (and why deleting it is a breaking change
    // until the reader moves): `manifestBuildAssumedGapBytes` reads
    // `metadata.ordering_workload`, not the canonical top-level key.
    const m = honest() as unknown as PackedManifest;
    expect(manifestBuildAssumedGapBytes(m)).toBe(2 * 1024 * 1024);
    // Absent ⇒ null ⇒ the layout's provenance is unknown and never guessed at.
    const legacy = { ...golden } as unknown as PackedManifest;
    expect(manifestBuildAssumedGapBytes(legacy)).toBeNull();
    // The top-level key alone does NOT satisfy the reader today — the pin that
    // makes the mirror's "removal trigger" checkable rather than folkloric.
    const topOnly = honest({ ordering_workload: undefined });
    delete (topOnly.metadata as Record<string, unknown>).ordering_workload;
    expect(
      manifestBuildAssumedGapBytes(topOnly as unknown as PackedManifest),
    ).toBeNull();
  });

  it('an honest manifest is assignable to the exported PackedManifest type', () => {
    const m: PackedManifest = honest() as unknown as PackedManifest;
    expect(m.blobOrdering).toBe('time-major');
    const meta = m.metadata as Record<string, unknown>;
    const fp = meta.content_fingerprint as Record<string, unknown>;
    expect(fp.version).toBe(1);
    expect(meta.z_range).toEqual([0, 1250.5]);
  });
});
