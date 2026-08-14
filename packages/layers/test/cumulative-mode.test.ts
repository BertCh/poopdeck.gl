/**
 * Cumulative ("draw and persist") mode WIRING tests for TimeFilterExtension.
 *
 * Scope is deliberately narrow: that the shader module declares the `cumulative`
 * uniform, that the inject carries the persist branch, and that the default prop
 * is off. Those are plumbing facts no math test would catch.
 *
 * The MATH is not tested here. This file used to carry a local
 * `cumulativeAlphaRef` checked against hand-typed expectations — a mirror of a
 * mirror, tied to nothing, and covering one of four modes. It has been replaced
 * by `./time-filter-conformance.test.ts`, which pins a full JS reference of the
 * inject to BOTH core oracles (`time-filter.ts` and `shader-codegen.ts`'s
 * `evalExpr`) across all four modes and structurally locks the shipped GLSL.
 * Add reveal-semantics assertions there, not here.
 */

import { describe, it, expect } from 'vitest';
import { TimeFilterExtension } from '../src/extensions/time-filter-extension';

function getShaderObject() {
  const ext = new TimeFilterExtension();
  // getShaders only reads its `extension` arg (not `this`), so a bare object
  // is a fine receiver.
  return (ext.getShaders as any).call({}, ext);
}

describe('TimeFilterExtension cumulative-mode wiring', () => {
  it('declares the cumulative uniform in the shader module', () => {
    const shaders = getShaderObject();
    const moduleSrc = (shaders.modules as any[])[0].vs as string;
    expect(moduleSrc).toContain('float cumulative;');
  });

  it('injects the persist branch into the vertex main', () => {
    const shaders = getShaderObject();
    const inject = shaders.inject['vs:#main-start'] as string;
    expect(inject).toContain('timeFilter.cumulative > 0.0');
    // The branch hides not-yet-created features and otherwise keeps them on.
    expect(inject).toContain('instanceStartTime > timeFilter.currentTime');
  });

  it('defaults cumulative off so existing datasets are unaffected', () => {
    expect((TimeFilterExtension as any).defaultProps.cumulative).toBe(false);
  });
});

// Reveal semantics (appear at creation → fade in → persist) are pinned against
// both core oracles in ./time-filter-conformance.test.ts.
