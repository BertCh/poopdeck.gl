// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { timeFilterAlphaGlsl } from '../src/shaders';

describe('timeFilterAlphaGlsl (Cesium consumes the same ALPHA_EXPR as deck)', () => {
  it('emits deterministic, complete GLSL for each linear mode', () => {
    for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
      const s = timeFilterAlphaGlsl(mode);
      expect(s).toBe(timeFilterAlphaGlsl(mode)); // deterministic
      expect(s).not.toContain('undefined');
      expect(s).not.toContain('NaN');
      expect(s).toContain('clamp('); // fade ramp / alpha bounds
    }
  });

  it('honors a nameMap to the host shader vars', () => {
    const s = timeFilterAlphaGlsl('cumulative', {
      currentTime: 'czm_frameTime',
      startTime: 'v_start',
    });
    expect(s).toContain('czm_frameTime');
    expect(s).toContain('v_start');
    expect(s).not.toContain('startTime');
  });
});
