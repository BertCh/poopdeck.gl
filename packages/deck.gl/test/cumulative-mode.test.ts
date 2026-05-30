/**
 * Cumulative ("draw and persist") mode tests for TimeFilterExtension.
 *
 * The reveal logic lives in GLSL (the `vs:#main-start` inject), which can't run
 * without a GPU. We assert two things instead:
 *   1. Wiring — the shader module declares the `cumulative` uniform and the
 *      inject carries the persist branch + the default prop is off.
 *   2. Semantics — a pure-JS reference of the branch (kept in lockstep with the
 *      GLSL) produces the intended "appear at creation, fade in, then persist"
 *      alpha. If you change the GLSL branch, update `cumulativeAlphaRef` too.
 */

import { describe, it, expect } from 'vitest';
import { TimeFilterExtension } from '../src/time-filter-extension';

/** JS mirror of the GLSL `if (timeFilter.cumulative > 0.0) { … }` branch. */
function cumulativeAlphaRef(
  startTime: number,
  currentTime: number,
  fadeIn: number,
): number {
  if (startTime > currentTime) return 0; // not created yet
  if (fadeIn > 0) {
    const age = currentTime - startTime;
    if (age < fadeIn) return age / fadeIn; // ink appearing
  }
  return 1; // revealed and persisting
}

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

describe('cumulative reveal semantics (reference)', () => {
  const fadeIn = 1000;

  it('hides features whose creation is in the future', () => {
    expect(cumulativeAlphaRef(5000, 4000, fadeIn)).toBe(0);
  });

  it('fades a freshly-created feature in over fadeInDuration', () => {
    expect(cumulativeAlphaRef(4000, 4000, fadeIn)).toBe(0); // just created
    expect(cumulativeAlphaRef(4000, 4500, fadeIn)).toBeCloseTo(0.5);
    expect(cumulativeAlphaRef(4000, 5000, fadeIn)).toBe(1); // fully inked
  });

  it('persists a long-created feature regardless of how far time advanced', () => {
    expect(cumulativeAlphaRef(100, 999_999_999, fadeIn)).toBe(1);
  });

  it('with no fadeIn, reveals instantly at creation and persists', () => {
    expect(cumulativeAlphaRef(4000, 3999, 0)).toBe(0);
    expect(cumulativeAlphaRef(4000, 4000, 0)).toBe(1);
    expect(cumulativeAlphaRef(4000, 4001, 0)).toBe(1);
  });
});
