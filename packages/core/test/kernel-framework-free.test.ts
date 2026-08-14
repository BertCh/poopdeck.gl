// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
 * docs/roadmap/renderer-architecture.md.
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

/**
 * `src/geo` is stricter than the rest of core: it is the projection kernel three
 * and Cesium import directly (`@poopdeck.gl/core/geo`), and it currently has
 * ZERO runtime dependencies of any kind — not just no renderer, no package at
 * all. That is a property worth machine-enforcing rather than rediscovering: the
 * frustum-cover walk in particular is specified as "no new runtime dependency in
 * core", and a `@math.gl/culling` import is the natural, plausible, and
 * contract-breaking way someone would implement the same thing next year.
 */
describe('the geo projection kernel carries no runtime dependency', () => {
  const GEO = join(SRC, 'geo');
  const files = walk(GEO);

  /**
   * Stricter than {@link SPECIFIER_RE}: anchored to an `import`/`export`
   * STATEMENT. The loose form is fine for the banned-library scan above — prose
   * does not accidentally spell `@deck.gl/` — but this test asserts a whitelist
   * ("relative only"), so a doc comment containing the words `from "…"` would
   * otherwise read as a dependency.
   */
  const IMPORT_STATEMENT_RE =
    /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*\(?\s*['"]([^'"]+)['"]/gm;

  it('finds the geo modules', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(`${sep}frustum-cover.ts`))).toBe(true);
  });

  it('imports nothing but sibling modules', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(IMPORT_STATEMENT_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec) continue;
        if (!spec.startsWith('./') && !spec.startsWith('../')) {
          violations.push(`${relative(SRC, file)} → "${spec}"`);
        }
      }
    }
    expect(
      violations,
      `geo kernel took on a dependency:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
