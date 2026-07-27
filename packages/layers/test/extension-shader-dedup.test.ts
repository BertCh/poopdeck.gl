/**
 * Shader-duplication safety for the poopdeck layer extensions.
 *
 * THE BUG THIS PINS. deck.gl's `Layer.getShaders()` folds every entry of
 * `props.extensions` through `mergeShaders`, which CONCATENATES same-key
 * injections with no dedup at all:
 *
 *   result.inject[key] = (target.inject[key] || '') + source.inject[key]
 *   — @deck.gl/core/src/utils/shader.ts
 *
 * The STT composite layers install their own `TimeFilterExtension` /
 * `CategoryColorExtension` and then APPEND whatever the caller passed through
 * the public top-level `extensions` prop (`composeExtensions`). So the entirely
 * natural `new AnimatedPointLayer({extensions: [new TimeFilterExtension()]})` —
 * which the layer docs invite — yields `[internal, categoryColor, user]`. With
 * the attribute/varying declarations living in a `vs:#decl` injection that
 * emitted `in float instanceVertexTime; … out float vTimeAlpha;` TWICE, the
 * vertex shader failed to link and the layer rendered NOTHING.
 *
 * THE FIX. Declarations moved into each extension's shader MODULE source
 * (`vs`/`fs`), because luma resolves modules through a name-keyed map
 * (`getShaderModuleDependencies` → `moduleMap[module.name] = module`) and so
 * emits a duplicate module exactly once. Injections then only carry STATEMENTS,
 * which must additionally be idempotent: any local they declare has to be
 * block-scoped, or a doubled injection redeclares it in the same scope.
 *
 * This suite drives deck's REAL `mergeShaders` (plus a faithful mirror of
 * luma's name-keyed module map — see `dedupeModulesByName`), so it fails the
 * moment a declaration drifts back into an injection.
 */

import { describe, it, expect } from 'vitest';
import { _mergeShaders } from '@deck.gl/core';
import { TimeFilterExtension } from '../src/extensions/time-filter-extension';
import {
  STTDataFilterExtension,
  dataFilterUniforms,
} from '../src/extensions/data-filter-extension';
import {
  CategoryColorExtension,
  categoryColorUniforms,
} from '../src/extensions/category-color-extension';
import { SplatExtension } from '../src/extensions/splat-extension';
import { ChevronFlowExtension } from '../src/extensions/chevron-flow-extension';

type Shaders = { modules?: any[]; inject?: Record<string, string> };

/**
 * Mirror of luma's module resolution, which is what makes the fix work:
 *
 *   const moduleMap = {};
 *   for (const module of modules) moduleMap[module.name] = module;
 *   — @luma.gl/shadertools shader-module-dependencies.ts, getShaderModuleDependencies
 *
 * A name-keyed map, so a module listed twice contributes its source ONCE.
 * (`@luma.gl/shadertools` is a transitive dep of this package, not a direct
 * one, so it is mirrored here rather than imported.)
 */
function dedupeModulesByName(modules: any[]): any[] {
  const byName = new Map<string, any>();
  for (const module of modules) byName.set(module.name, module);
  return [...byName.values()];
}

/**
 * Reproduce what `Layer.getShaders()` does with a list of extensions: fold each
 * extension's contribution through deck's own `mergeShaders`. `this` is a
 * PathLayer-shaped host so the chevron extension keeps all its capabilities.
 */
function mergeExtensionShaders(extensions: any[]): Shaders {
  const host = {
    props: { getPath: (d: any) => d.path, extensions },
    id: 'host',
  };
  let shaders: Shaders = { modules: [], inject: {} };
  for (const extension of extensions) {
    shaders = _mergeShaders(
      shaders,
      extension.getShaders.call(host, extension),
    ) as Shaders;
  }
  return shaders;
}

/** Vertex/fragment source luma would actually assemble, module sources first. */
function assembledSource(shaders: Shaders, stage: 'vs' | 'fs'): string {
  const modules = dedupeModulesByName((shaders.modules ?? []) as any[]);
  const moduleSource = modules.map((m: any) => m[stage] ?? '').join('\n');
  const declKey = `${stage}:#decl`;
  return `${moduleSource}\n${shaders.inject?.[declKey] ?? ''}`;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every GLSL symbol each extension has to declare exactly once. */
const DECLARATIONS: Record<
  string,
  { make: () => any; vs: string[]; fs: string[] }
> = {
  TimeFilterExtension: {
    make: () => new TimeFilterExtension(),
    vs: [
      'in float instanceVertexTime;',
      'in float instanceStartTime;',
      'in float instanceEndTime;',
      'out float vTimeAlpha;',
    ],
    fs: ['in float vTimeAlpha;'],
  },
  STTDataFilterExtension: {
    make: () => new STTDataFilterExtension(),
    vs: ['in float filterValue;', 'out float vDataFilterAlpha;'],
    fs: ['in float vDataFilterAlpha;'],
  },
  CategoryColorExtension: {
    make: () => new CategoryColorExtension(),
    vs: ['in float instanceCategoryIndex;', 'out float vCategoryIndex;'],
    fs: ['in float vCategoryIndex;'],
  },
};

describe.each(Object.entries(DECLARATIONS))(
  '%s survives being installed twice on one layer',
  (name, spec) => {
    it('declares every attribute/varying in the shader MODULE, not in an injection', () => {
      const shaders = mergeExtensionShaders([spec.make()]);
      const [module] = shaders.modules as any[];
      for (const decl of spec.vs) expect(module.vs).toContain(decl);
      for (const decl of spec.fs) expect(module.fs).toContain(decl);
      // A `#decl` injection is exactly what mergeShaders would duplicate.
      expect(shaders.inject?.['vs:#decl']).toBeUndefined();
      expect(shaders.inject?.['fs:#decl']).toBeUndefined();
    });

    it('emits each declaration EXACTLY ONCE with two instances installed', () => {
      const shaders = mergeExtensionShaders([spec.make(), spec.make()]);
      const vs = assembledSource(shaders, 'vs');
      const fs = assembledSource(shaders, 'fs');
      for (const decl of spec.vs) {
        expect(`${name} vs ${decl}: ${countOccurrences(vs, decl)}`).toBe(
          `${name} vs ${decl}: 1`,
        );
      }
      for (const decl of spec.fs) {
        expect(`${name} fs ${decl}: ${countOccurrences(fs, decl)}`).toBe(
          `${name} fs ${decl}: 1`,
        );
      }
      // …and the uniform BLOCK, which would also be a redeclaration error.
      expect(countOccurrences(vs, 'layout(std140) uniform')).toBe(1);
    });

    it('duplicate modules collapse to one via luma name-keyed module resolution', () => {
      const shaders = mergeExtensionShaders([spec.make(), spec.make()]);
      // mergeShaders concatenated them…
      expect((shaders.modules as any[]).length).toBe(2);
      // …luma dedupes by `module.name`, which is why the fix works.
      expect(dedupeModulesByName(shaders.modules as any[]).length).toBe(1);
    });
  },
);

describe('injections stay idempotent under duplication', () => {
  // With the declarations moved out, what remains in the injections is pure
  // STATEMENTS — but a bare `float x = …;` at hook top level is still a
  // redeclaration when the hook body is concatenated twice. Every local an
  // injection introduces must therefore sit inside braces.
  const EXTENSIONS: [string, () => any][] = [
    ['TimeFilterExtension', () => new TimeFilterExtension()],
    ['STTDataFilterExtension', () => new STTDataFilterExtension()],
    ['CategoryColorExtension', () => new CategoryColorExtension()],
    ['SplatExtension', () => new SplatExtension()],
    ['ChevronFlowExtension', () => new ChevronFlowExtension()],
  ];

  it.each(EXTENSIONS)('%s declares no unbraced locals', (_name, make) => {
    const { inject = {} } = mergeExtensionShaders([make()]);
    for (const [key, source] of Object.entries(inject)) {
      if (key.endsWith('#decl')) continue;
      let depth = 0;
      for (const rawLine of source.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('//')) continue;
        if (
          depth === 0 &&
          /^(float|vec[234]|int|bool|mat[234])\s+\w+\s*=/.test(line)
        ) {
          throw new Error(
            `${_name} ${key} declares "${line}" at hook top level — a second ` +
              'copy of this injection would redeclare it. Wrap the body in {}.',
          );
        }
        depth +=
          countOccurrences(rawLine, '{') - countOccurrences(rawLine, '}');
      }
    }
  });

  it('SplatExtension braces its gaussian local (two splats still compile)', () => {
    const shaders = mergeExtensionShaders([
      new SplatExtension(),
      new SplatExtension(),
    ]);
    const hook = shaders.inject!['fs:DECKGL_FILTER_COLOR'];
    expect(countOccurrences(hook, 'float splatR2')).toBe(2);
    // …but each inside its own scope, so it is a re-scope, not a redeclaration.
    expect(countOccurrences(hook, '{')).toBe(2);
    expect(countOccurrences(hook, '}')).toBe(2);
  });
});

describe('shader symbol namespaces are disjoint across the extension set', () => {
  // Regression guard for the compose-everything case: the STT layers stack
  // TimeFilter + CategoryColor + STTDataFilter (+ Splat/Chevron) on ONE
  // pipeline, alongside deck's own `dataFilter` / `collision` modules if a
  // caller adds them. A collision here is a link error, not a warning.
  const ALL = [
    new TimeFilterExtension(),
    new CategoryColorExtension(),
    new STTDataFilterExtension(),
    new SplatExtension(),
    new ChevronFlowExtension(),
  ];

  it('every module name is unique and distinct from deck’s own', () => {
    const shaders = mergeExtensionShaders(ALL);
    const names = (shaders.modules as any[]).map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    // deck's stock modules a caller could add alongside ours.
    for (const reserved of [
      'dataFilter',
      'collision',
      'project32',
      'picking',
    ]) {
      expect(names).not.toContain(reserved);
    }
    expect(dataFilterUniforms.name).toBe('sttFilter');
    expect(categoryColorUniforms.name).toBe('categoryColor');
  });

  it('every declared GLSL symbol is unique across the whole stack', () => {
    const shaders = mergeExtensionShaders(ALL);
    for (const stage of ['vs', 'fs'] as const) {
      const source = assembledSource(shaders, stage);
      const declared = [
        ...source.matchAll(/^\s*(?:in|out|uniform)\s+\w+\s+(\w+)\s*;/gm),
      ].map((m) => m[1]);
      const seen = new Set<string>();
      for (const symbol of declared) {
        expect(`${stage}:${symbol} declared once`).toBe(
          `${stage}:${seen.has(symbol) ? 'DUPLICATE' : symbol} declared once`,
        );
        seen.add(symbol);
      }
      // The uniform-block INSTANCE names must differ too (they share a scope).
      const blocks = [
        ...source.matchAll(
          /layout\(std140\)\s+uniform\s+(\w+)\s*\{[^}]*\}\s*(\w+)\s*;/g,
        ),
      ];
      const blockNames = blocks.map((m) => m[1]);
      const instanceNames = blocks.map((m) => m[2]);
      expect(new Set(blockNames).size).toBe(blockNames.length);
      expect(new Set(instanceNames).size).toBe(instanceNames.length);
      expect(blockNames).not.toContain('dataFilterUniforms'); // deck's own
    }
  });
});
