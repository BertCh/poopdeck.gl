// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Enforces the render-kernel invariant: `@poopdeck.gl/core` must stay
 * FRAMEWORK-FREE so every renderer backend (deck / three / maplibre / Cesium /
 * WebGL-three / …) can depend on it. The kernel modules (time-filter, and the
 * forthcoming style/geo/geometry/picking/tileset-adapter/shader-codegen)
 * therefore may NOT import any rendering library.
 *
 * This repo has no eslint, so the guard is a test (matching the manifest-schema
 * / palette-parity precedent). It is the machine that replaces the "// keep in
 * lockstep" comments the renderer-abstraction plan retires. See
 * docs/roadmap/renderer-abstraction-2026-06.md.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

// Renderer libraries a data/playback kernel must never pull in.
const BANNED = [
  /^three(\/|$)/, // three.js incl. three/webgpu, three/tsl
  /^@deck\.gl\//,
  /^@luma\.gl\//,
  /^maplibre-gl(\/|$)/,
  /^mapbox-gl(\/|$)/,
  /^cesium(\/|$)/i,
  /^@react-three\//,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// Match the specifier in `from '…'`, `import '…'`, and dynamic `import('…')`.
const SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

describe('core render kernel stays framework-free', () => {
  const files = walk(SRC);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports no rendering library anywhere in core/src', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(SPECIFIER_RE)) {
        const spec = m[1];
        if (BANNED.some((re) => re.test(spec))) {
          violations.push(`${relative(SRC, file)} → "${spec}"`);
        }
      }
    }
    expect(
      violations,
      `core imported a renderer library:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
