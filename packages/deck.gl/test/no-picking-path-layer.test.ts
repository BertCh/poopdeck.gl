// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * Guard test for the regex-rewrite in NoPickingPathLayer.
 *
 * The subclass strips `instancePickingColors` from PathLayer's compiled vs
 * to keep the per-pipeline attribute count under WebGL2's 16-slot minimum.
 * The rewrite uses a regex against PathLayer's source — a brittle contract
 * across deck.gl versions. This test fires on every CI run and will fail
 * loudly the day deck.gl reformats the declaration (or, more usefully, the
 * day 9.4 lands and the attribute is gone — at which point this subclass
 * becomes a no-op and can be deleted in favour of plain PathLayer).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PathLayer } from '@deck.gl/layers';
import { NoPickingPathLayer } from '../src/no-picking-path-layer';
import { _resetWarnOnce } from '../src/log';

/**
 * Drive `NoPickingPathLayer.getShaders()` with a stubbed parent so we don't
 * need a real GL context. `super.getShaders` resolves to PathLayer's
 * implementation in the prototype chain — patching its return value lets us
 * test the regex pass in isolation.
 */
function runWithStubbedSuper(vs: string): { vs: string; fs: string } {
  const layer = Object.create(NoPickingPathLayer.prototype);
  const spy = vi
    .spyOn(PathLayer.prototype as unknown as { getShaders: () => unknown }, 'getShaders')
    .mockReturnValue({ vs, fs: '' });
  try {
    return (layer as NoPickingPathLayer).getShaders();
  } finally {
    spy.mockRestore();
  }
}

describe('NoPickingPathLayer shader rewrite', () => {
  beforeEach(() => {
    _resetWarnOnce();
  });

  it("strips instancePickingColors from PathLayer's vertex shader", () => {
    const stubVs = `\
#version 300 es
in vec3 instancePickingColors;
void main() {
  geometry.pickingColor = instancePickingColors;
  gl_Position = vec4(0.0);
}
`;
    const shaders = runWithStubbedSuper(stubVs);
    expect(shaders.vs).not.toMatch(/in\s+vec3\s+instancePickingColors\s*;/);
    expect(shaders.vs).not.toMatch(
      /geometry\.pickingColor\s*=\s*instancePickingColors/,
    );
    expect(shaders.vs).toMatch(/geometry\.pickingColor\s*=\s*vec3\(0\.0\)\s*;/);
  });

  it("matches the real PathLayer vertex source", () => {
    // Sanity-check against the installed @deck.gl/layers PathLayer shader.
    // The package's `exports` block hides the internal shader path, so we
    // resolve the package root via require.resolve('@deck.gl/layers') and
    // read the shipped .js file from disk. This is the test that fires the
    // day deck.gl reformats / removes the declaration — at which point the
    // subclass either needs an updated regex or can be deleted.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const entry = require.resolve('@deck.gl/layers');
    // entry is .../@deck.gl/layers/dist/index.js — walk up to the package root.
    const pkgRoot = path.resolve(path.dirname(entry), '..');
    const shaderPath = path.join(
      pkgRoot,
      'dist',
      'path-layer',
      'path-layer-vertex.glsl.js',
    );
    const vs = fs.readFileSync(shaderPath, 'utf8');
    expect(vs).toMatch(/in\s+vec3\s+instancePickingColors\s*;/);
    expect(vs).toMatch(/geometry\.pickingColor\s*=\s*instancePickingColors/);
  });

  it('warns if the regex no longer matches (deck.gl version drift)', () => {
    const stubVs = '#version 300 es\nvoid main() { gl_Position = vec4(0.0); }';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runWithStubbedSuper(stubVs);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(
        /could not strip instancePickingColors/,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
