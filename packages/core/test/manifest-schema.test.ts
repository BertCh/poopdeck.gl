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
import { Compression } from '../src';

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
function validate(value: unknown, schema: Schema, path = '$', errors: string[] = []): string[] {
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type && !checkType(value, schema.type)) {
    errors.push(`${path}: expected type ${schema.type}, got ${jsType(value)}`);
    return errors;
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match /${schema.pattern}/`);
  }
  if (jsType(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}: missing required property "${req}"`);
    }
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) validate(v, props[k], `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors));
  }
  return errors;
}

const schema: Schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const golden = JSON.parse(readFileSync(GOLDEN_MANIFEST_PATH, 'utf8'));

describe('packed-format manifest contract', () => {
  it('the published schema is well-formed and v1', () => {
    expect(schema.$schema).toContain('json-schema.org');
    expect(schema.properties.format.const).toBe('stt-packed');
    expect(schema.properties.formatVersion.const).toBe(1);
    expect(schema.properties.directory.properties.directoryVersion.const).toBe(5);
    // directory.encoding is additive: declared (so its vocabulary is pinned)
    // but never required (pre-encoding manifests omit it).
    expect(schema.properties.directory.properties.encoding.enum).toEqual(['zstd']);
    expect(schema.properties.directory.required).not.toContain('encoding');
  });

  it('the Rust-produced golden manifest conforms to the schema', () => {
    const errors = validate(golden, schema);
    expect(errors).toEqual([]);
  });

  it('the golden manifest is assignable to the exported PackedManifest type', () => {
    // Compile-time: the public type must be importable and structurally match.
    const m: PackedManifest = golden;
    expect(m.format).toBe('stt-packed');
    expect(m.formatVersion).toBe(1);
    expect(m.directory.directoryVersion).toBe(5);
    // The Rust writer compresses the directory at rest and declares it.
    expect(m.directory.encoding).toBe('zstd');
    expect(m.packs.length).toBeGreaterThan(0);
  });

  it('the validator rejects drift (negative cases)', () => {
    const wrongFormat = { ...golden, format: 'stt-v4' };
    expect(validate(wrongFormat, schema).length).toBeGreaterThan(0);

    const wrongVersion = { ...golden, formatVersion: 2 };
    expect(validate(wrongVersion, schema).length).toBeGreaterThan(0);

    const missingPacks = { ...golden };
    delete (missingPacks as Record<string, unknown>).packs;
    expect(validate(missingPacks, schema).some((e) => /packs/.test(e))).toBe(true);

    const badPackKey = {
      ...golden,
      packs: [{ key: 'packs/not-a-hash.sttp', length: 10 }],
    };
    expect(validate(badPackKey, schema).some((e) => /does not match/.test(e))).toBe(true);

    const badDirVersion = {
      ...golden,
      directory: { ...golden.directory, directoryVersion: 4 },
    };
    expect(validate(badDirVersion, schema).length).toBeGreaterThan(0);

    const badEncoding = {
      ...golden,
      directory: { ...golden.directory, encoding: 'br' },
    };
    expect(validate(badEncoding, schema).some((e) => /enum/.test(e))).toBe(true);
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

  it('tolerates unknown fields at every envelope level (additive evolution)', () => {
    // Readers must ignore fields they do not recognize, so the schema must
    // not reject them — otherwise external validators built from it would
    // refuse manifests from any newer writer.
    const extended = {
      ...golden,
      generation: 7,
      directory: { ...golden.directory, sectionOffsets: [0, 64] },
      packs: golden.packs.map((p: Record<string, unknown>) => ({ ...p, tier: 'raw' })),
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
