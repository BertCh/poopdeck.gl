// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

// Enforces docs/spec/render-spec.json — the DECLARED shader-codegen contract
// (renderer-abstraction-2026-06 §5.1). The frozen op-set must be stated, not
// discovered by reading emitters: this test pins the ALPHA_EXPR ASTs, the
// canonical variable names, and the mode list to the spec file so widening any
// of them silently (without the spec edit + the all-emitters gate it documents)
// fails CI.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALPHA_EXPR,
  TIME_FILTER_VARS,
  type Expr,
} from '../src/render/shader-codegen';

const spec = JSON.parse(
  readFileSync(join(__dirname, '../../../docs/spec/render-spec.json'), 'utf8'),
) as {
  ops: string[];
  variables: { uniforms: string[]; attributes: string[] };
  modes: string[];
};

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
  for (const expr of Object.values(ALPHA_EXPR)) walk(expr, ops, uniforms, attributes);

  it('ALPHA_EXPR uses only ops declared in the spec', () => {
    for (const op of ops) expect(spec.ops).toContain(op);
  });

  it('every uniform/attr the ASTs read is declared in the spec', () => {
    for (const name of uniforms) expect(spec.variables.uniforms).toContain(name);
    for (const name of attributes) expect(spec.variables.attributes).toContain(name);
  });

  it('the spec declares no variables the code does not define', () => {
    // TIME_FILTER_VARS is the canonical name registry; the spec must be a
    // subset of it (spec listing a name the code lost = stale spec).
    const known = new Set<string>(Object.values(TIME_FILTER_VARS));
    for (const name of [...spec.variables.uniforms, ...spec.variables.attributes]) {
      expect(known).toContain(name);
    }
  });

  it('mode list matches ALPHA_EXPR exactly', () => {
    expect([...spec.modes].sort()).toEqual(Object.keys(ALPHA_EXPR).sort());
  });

  it('op-set is exactly the frozen 12 (widening requires the all-emitters gate)', () => {
    expect([...spec.ops].sort()).toEqual(
      [
        'uniform', 'attr', 'const',
        'add', 'sub', 'mul', 'div',
        'min', 'max', 'step', 'clamp01', 'select',
      ].sort(),
    );
  });
});
