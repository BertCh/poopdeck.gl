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
 * additionalProperties:false / items / minItems / minimum / pattern). The
 * negative cases below prove it actually rejects drift rather than rubber-
 * stamping anything.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PackedManifest } from '../src';
import { Compression, KNOWN_MANIFEST_CAPABILITIES } from '../src';

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
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) validate(v, props[k], `${path}.${k}`, errors);
      else if (schema.additionalProperties === false)
        errors.push(`${path}: unexpected property "${k}"`);
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(
        `${path}: array length ${value.length} < minItems ${schema.minItems}`,
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
  it('the published schema is well-formed and pins formatVersion 2', () => {
    expect(schema.$schema).toContain('json-schema.org');
    expect(schema.properties.format.const).toBe('stt-packed');
    // formatVersion is the closed [2] enum — the authoritative
    // discriminator (packed spec §5.2); readers refuse anything else at open.
    expect(schema.properties.formatVersion.enum).toEqual([2]);
    expect(schema.properties.directory.properties.directoryVersion.const).toBe(
      5,
    );
    // directory.encoding is additive: declared (so its vocabulary is pinned)
    // but never required (pre-encoding manifests omit it).
    expect(schema.properties.directory.properties.encoding.enum).toEqual([
      'zstd',
    ]);
    expect(schema.properties.directory.required).not.toContain('encoding');
    // formatVersion-2 `schemas` table (packed spec §3.2): declared with the
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

  it('the Rust-produced formatVersion-2 golden manifest conforms too (schemas table)', () => {
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
    expect(m.formatVersion).toBe(2);
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
    expect(m.formatVersion).toBe(2);
    expect(m.directory.directoryVersion).toBe(5);
    // The Rust writer compresses the directory at rest and declares it.
    expect(m.directory.encoding).toBe('zstd');
    expect(m.packs.length).toBeGreaterThan(0);
  });

  it('the validator rejects drift (negative cases)', () => {
    const wrongFormat = { ...golden, format: 'stt-v4' };
    expect(validate(wrongFormat, schema).length).toBeGreaterThan(0);

    // 2 is a valid formatVersion since the 2026-07 byte break; 3 is not.
    const wrongVersion = { ...golden, formatVersion: 3 };
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

  it('a pre-encoding directory pointer (no `encoding` key) still validates', () => {
    // The shape of every deployed manifest: raw directory bytes, no field.
    const legacyDir = { ...golden.directory };
    delete (legacyDir as Record<string, unknown>).encoding;
    expect(validate({ ...golden, directory: legacyDir }, schema)).toEqual([]);
  });
});
