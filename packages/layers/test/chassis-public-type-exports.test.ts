/**
 * Public TYPE surface of the package barrel.
 *
 * Several types appear on public prop surfaces (`iconMapping`,
 * `getPixelOffset`, `mesh`/`meshMapping`, the hexagon aggregation props, the
 * `TimeFilterExtension` constructor options) but were never re-exported, so a
 * consumer could not name the object literal it had to pass. Every SIBLING
 * extension already exports its options type, which made
 * `TimeFilterExtensionOptions` the odd one out.
 *
 * Types are erased at runtime, so this asserts against the barrel's SOURCE:
 * each name must appear in an `export type { … }` clause in `src/index.ts` and
 * must actually be declared by the module it is re-exported from.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (relative: string) =>
  readFileSync(resolve(here, '..', 'src', relative), 'utf8');

/** Names inside every `export type { … } from '…'` block of the barrel. */
function barrelTypeExports(): Set<string> {
  // Strip line comments FIRST: the barrel documents each export inline and
  // those sentences contain commas, which would otherwise survive the split.
  const source = src('index.ts').replace(/\/\/[^\n]*/g, '');
  const names = new Set<string>();
  const blocks = source.matchAll(/export\s+type\s*\{([^}]*)\}/g);
  for (const [, body] of blocks) {
    for (const raw of body.split(',')) {
      const cleaned = raw.trim();
      if (!cleaned) continue;
      // `A as B` re-exports under the alias.
      const asMatch = cleaned.match(/\bas\s+([A-Za-z0-9_$]+)$/);
      names.add(asMatch ? asMatch[1] : cleaned);
    }
  }
  return names;
}

const REQUIRED: [name: string, declaredIn: string][] = [
  ['IconMappingEntry', 'layers/core/animated-icon-layer.ts'],
  ['PixelOffsetAccessorValue', 'layers/core/animated-icon-layer.ts'],
  ['MeshSource', 'layers/core/animated-mesh-layer.ts'],
  ['HexagonAggregationType', 'layers/summary/animated-hexagon-layer.ts'],
  ['TimeFilterExtensionOptions', 'extensions/time-filter-extension.ts'],
  ['TimeFilterMode', 'extensions/time-filter-extension.ts'],
];

describe('package barrel type exports', () => {
  const exported = barrelTypeExports();

  it.each(REQUIRED)('re-exports %s', (name) => {
    expect(exported.has(name)).toBe(true);
  });

  it.each(REQUIRED)('%s is declared by %s', (name, module) => {
    expect(src(module)).toMatch(
      new RegExp(`export\\s+(interface|type)\\s+${name}\\b`),
    );
  });

  it('keeps the sibling extension options types exported (the parity baseline)', () => {
    for (const name of [
      'ChevronFlowExtensionOptions',
      'STTDataFilterExtensionOptions',
      'CollisionFilterOptions',
    ]) {
      expect(exported.has(name)).toBe(true);
    }
  });

  it('still exports NoPickingPathLayer as a value (public, not internal)', () => {
    // Source-level assertion on purpose: importing the whole barrel would drag
    // in every layer module, so an unrelated file's syntax error would fail
    // this contract test for the wrong reason.
    expect(src('index.ts')).toMatch(
      /export\s*\{\s*NoPickingPathLayer\s*\}\s*from/,
    );
  });
});
