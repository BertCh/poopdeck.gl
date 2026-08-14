// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

// Enforces docs/spec/render-spec.json — the DECLARED render-kernel time-filter
// contract (renderer-abstraction-2026-06 §5.1). Two halves, both of which must
// be STATED rather than discovered by reading source:
//
//   1. The frozen op-set. This test pins the ALPHA_EXPR ASTs, the canonical
//      variable names, and the mode list to the spec, so widening any of them
//      silently fails CI.
//   2. The per-backend CONFORMANCE OBLIGATIONS. Every backend hand-writes its
//      shader; nothing is machine-emitted. What stops the four dialects from
//      drifting is that each backend's test suite pins its math to BOTH oracles.
//      This test asserts that structurally — a backend package whose tests stop
//      referencing the oracles fails here, which is exactly how deck.gl went
//      unpinned for as long as it did.
//
// The spec previously declared an `emitters` list containing a dialect-specific
// `emitGLSL100` (no callers, byte-identical output) and an `emitTSL` that had no
// implementation at all. Both are gone; the export check below is what keeps a
// phantom emitter from being declared again.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALPHA_EXPR,
  TIME_FILTER_VARS,
  type Expr,
} from '../src/render/shader-codegen';
import * as shaderCodegen from '../src/render/shader-codegen';

const REPO_ROOT = join(__dirname, '../../..');

const spec = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/spec/render-spec.json'), 'utf8'),
) as {
  ops: string[];
  variables: { uniforms: string[]; attributes: string[] };
  modes: string[];
  oracles: Record<'primary' | 'second', { symbol: string; module: string }>;
  conformance: {
    obligations: string[];
    backends: {
      backend: string;
      package: string;
      testDir: string;
      dialect: string;
      authoring: string;
      shaderSource: string | null;
    }[];
  };
  emitters: { name: string; package: string; status: string }[];
};

/** Every `.ts` file under `dir`, recursively. */
function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Concatenated source of a backend package's whole test suite. */
function suiteSource(testDir: string): string {
  const abs = join(REPO_ROOT, testDir);
  if (!existsSync(abs)) return '';
  return testFilesUnder(abs)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

/** Walk an Expr AST, collecting every op and every uniform/attr name used. */
function walk(
  e: Expr,
  ops: Set<string>,
  uniforms: Set<string>,
  attributes: Set<string>,
): void {
  ops.add(e.op);
  switch (e.op) {
    case 'uniform':
      uniforms.add(e.name);
      return;
    case 'attr':
      attributes.add(e.name);
      return;
    case 'const':
      return;
    case 'clamp01':
      walk(e.a, ops, uniforms, attributes);
      return;
    case 'select':
      walk(e.c, ops, uniforms, attributes);
      walk(e.t, ops, uniforms, attributes);
      walk(e.f, ops, uniforms, attributes);
      return;
    default:
      // binary ops (add/sub/mul/div/min/max/step)
      walk(e.a, ops, uniforms, attributes);
      walk(e.b, ops, uniforms, attributes);
  }
}

describe('render-spec.json contract', () => {
  const ops = new Set<string>();
  const uniforms = new Set<string>();
  const attributes = new Set<string>();
  for (const expr of Object.values(ALPHA_EXPR))
    walk(expr, ops, uniforms, attributes);

  it('ALPHA_EXPR uses only ops declared in the spec', () => {
    for (const op of ops) expect(spec.ops).toContain(op);
  });

  it('every uniform/attr the ASTs read is declared in the spec', () => {
    for (const name of uniforms)
      expect(spec.variables.uniforms).toContain(name);
    for (const name of attributes)
      expect(spec.variables.attributes).toContain(name);
  });

  it('the spec declares no variables the code does not define', () => {
    // TIME_FILTER_VARS is the canonical name registry; the spec must be a
    // subset of it (spec listing a name the code lost = stale spec).
    const known = new Set<string>(Object.values(TIME_FILTER_VARS));
    for (const name of [
      ...spec.variables.uniforms,
      ...spec.variables.attributes,
    ]) {
      expect(known).toContain(name);
    }
  });

  it('mode list matches ALPHA_EXPR exactly', () => {
    expect([...spec.modes].sort()).toEqual(Object.keys(ALPHA_EXPR).sort());
  });

  it('op-set is exactly the frozen 12 (widening requires the conformance gate)', () => {
    expect([...spec.ops].sort()).toEqual(
      [
        'uniform',
        'attr',
        'const',
        'add',
        'sub',
        'mul',
        'div',
        'min',
        'max',
        'step',
        'clamp01',
        'select',
      ].sort(),
    );
  });
});

describe('render-spec.json conformance obligations', () => {
  const { backends } = spec.conformance;
  const primary = spec.oracles.primary.module;
  const second = spec.oracles.second.module;

  it('declares all four renderer backends', () => {
    expect(backends.map((b) => b.backend).sort()).toEqual([
      'cesium',
      'deck.gl',
      'maplibre',
      'three.js',
    ]);
  });

  it('the oracle modules the spec names are real core subpaths', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf8'),
    ) as { name: string; exports: Record<string, unknown> };
    for (const mod of [primary, second]) {
      const subpath = mod.replace(pkg.name, '.');
      expect(Object.keys(pkg.exports)).toContain(subpath);
    }
  });

  describe.each(backends)('$backend', (b) => {
    it('declares a test directory that exists', () => {
      expect(existsSync(join(REPO_ROOT, b.testDir))).toBe(true);
    });

    it('declares a shader source that exists (or null for a CPU backend)', () => {
      if (b.shaderSource === null) {
        expect(b.authoring).toContain('CPU');
        return;
      }
      expect(existsSync(join(REPO_ROOT, b.shaderSource))).toBe(true);
    });

    // The structural half of the contract. A GLSL/TSL backend must hold its
    // shader math to BOTH oracles; a CPU backend has no shader to pin, so it
    // owes only that it still routes through the primary oracle rather than
    // growing a local copy of the formulas.
    it('its test suite references the oracles it owes', () => {
      const src = suiteSource(b.testDir);
      expect(src).toContain(primary);
      if (b.shaderSource !== null) expect(src).toContain(second);
    });
  });
});

describe('render-spec.json emitters', () => {
  it('declares only emitters that actually exist in core', () => {
    // The spec once declared `emitTSL` in @poopdeck.gl/three, which was never
    // implemented. Anything listed here must be a real export.
    for (const e of spec.emitters) {
      expect(e.package).toBe('@poopdeck.gl/core');
      expect(shaderCodegen).toHaveProperty(e.name);
      expect(typeof (shaderCodegen as Record<string, unknown>)[e.name]).toBe(
        'function',
      );
    }
  });

  it('does not re-declare either removed emitter', () => {
    // Both went for the same reason — nothing compiled their output — so both
    // stay pinned. Without this the suite above passes VACUOUSLY on the empty
    // list, and a re-added emitter with no caller would sail through.
    for (const gone of ['emitGLSL100', 'emitGLSL300']) {
      expect(spec.emitters.map((e) => e.name)).not.toContain(gone);
      expect(shaderCodegen).not.toHaveProperty(gone);
    }
  });

  it('keeps the AST + evaluator that the emitters were removed in favour of', () => {
    // The load-bearing half: `ALPHA_EXPR`/`evalExpr` are the second oracle each
    // backend's hand-written shader is pinned to. Removing an emitter is
    // housekeeping; removing these would delete the conformance contract.
    expect(typeof (shaderCodegen as Record<string, unknown>).evalExpr).toBe(
      'function',
    );
    expect(shaderCodegen).toHaveProperty('ALPHA_EXPR');
  });

  it('marks every emitter UNWIRED while no shipped shader is generated', () => {
    // Flip this the day a backend actually renders from an emitted string —
    // and update `conformance.backends[].authoring` in the same edit.
    for (const e of spec.emitters) expect(e.status).toMatch(/^UNWIRED\b/);
    for (const b of spec.conformance.backends) {
      expect(b.authoring).not.toContain('machine-emitted');
    }
  });
});
