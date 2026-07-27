/**
 * Contracts for the shared sublayer-cache key builder.
 *
 * The property under test is that a layer CANNOT under-specify its key:
 *
 *   - exhaustiveness — an unclassified prop, a stale table entry, or a
 *     misspelled override key is a compile error. The `@ts-expect-error` blocks
 *     below encode that, and `type-level contracts` runs the TypeScript checker
 *     over this very file so an `@ts-expect-error` that stops firing FAILS the
 *     suite instead of silently passing.
 *   - determinism — the key never depends on table or prop declaration order.
 *   - stability — equal inputs give an equal key, so nothing rebuilds on a
 *     no-op render.
 *   - sensitivity — changing ANY `'sublayer'` prop changes the key; changing a
 *     `'uniform'` / `'prepare'` / `'inert'` prop does not.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  buildLayerPropsKey,
  type PropEffects,
} from '../src/lib/layer-props-key';

// ---------------------------------------------------------------------------
// A stand-in for a layer's `_XxxLayerProps` interface, covering every value
// shape the real ones use: scalars, tuples, nested objects, function
// accessors, and the alias-resolved unions (`number | string`).
// ---------------------------------------------------------------------------

interface DemoLayerProps {
  radiusScale?: number;
  stroked?: boolean;
  strokeColor?: [number, number, number, number];
  material?: { ambient: number; shininess: number } | null;
  /** Resolved through an alias (`getLineWidth` wins) — keyed via `overrides`. */
  lineWidth?: number | string;
  /** Constant branch is baked into the sublayer; column branch re-prepares. */
  fillColor?: number[] | string;
  /** Per-frame uniform. */
  currentTime?: number;
  /** Consumed while preparing tile attributes; covered by `styleKey`. */
  colorPalette?: number[][];
  /** Never reaches rendering. */
  legendTitle?: string;
}

const DEMO_EFFECTS: PropEffects<DemoLayerProps> = {
  radiusScale: 'sublayer',
  stroked: 'sublayer',
  strokeColor: 'sublayer',
  material: 'sublayer',
  lineWidth: 'sublayer',
  fillColor: 'sublayer',
  currentTime: 'uniform',
  colorPalette: 'prepare',
  legendTitle: 'inert',
};

const BASE: Required<DemoLayerProps> = {
  radiusScale: 2,
  stroked: true,
  strokeColor: [255, 128, 0, 255],
  material: { ambient: 0.35, shininess: 32 },
  lineWidth: 1,
  fillColor: [10, 20, 30, 255],
  currentTime: 1_700_000_000_000,
  colorPalette: [
    [1, 2, 3, 255],
    [4, 5, 6, 255],
  ],
  legendTitle: 'Depth',
};

/** A different value for every prop — exhaustive, so a new prop needs one. */
const CHANGED: Required<DemoLayerProps> = {
  radiusScale: 3,
  stroked: false,
  strokeColor: [255, 128, 1, 255],
  material: { ambient: 0.35, shininess: 33 },
  lineWidth: 'width_m',
  fillColor: 'category',
  currentTime: 1_700_000_001_000,
  colorPalette: [
    [1, 2, 3, 255],
    [4, 5, 7, 255],
  ],
  legendTitle: 'Magnitude',
};

const key = (
  props: DemoLayerProps,
  opts?: Parameters<typeof buildLayerPropsKey<DemoLayerProps>>[2],
): string => buildLayerPropsKey<DemoLayerProps>(props, DEMO_EFFECTS, opts);

// ---------------------------------------------------------------------------
// Compile-time cases. Each `@ts-expect-error` is an assertion that the type
// system rejects the line below it; `type-level contracts` proves they fire.
// ---------------------------------------------------------------------------

// @ts-expect-error `legendTitle` is unclassified — the whole point of the type.
export const MISSING_A_PROP: PropEffects<DemoLayerProps> = {
  radiusScale: 'sublayer',
  stroked: 'sublayer',
  strokeColor: 'sublayer',
  material: 'sublayer',
  lineWidth: 'sublayer',
  fillColor: 'sublayer',
  currentTime: 'uniform',
  colorPalette: 'prepare',
};

export const STALE_TABLE_ENTRY: PropEffects<DemoLayerProps> = {
  ...DEMO_EFFECTS,
  // @ts-expect-error `radiusSacle` is not a prop of DemoLayerProps.
  radiusSacle: 'sublayer',
};

export const BAD_EFFECT_NAME: PropEffects<DemoLayerProps> = {
  ...DEMO_EFFECTS,
  // @ts-expect-error 'gpu' is not a PropEffect.
  radiusScale: 'gpu',
};

export const MISSPELLED_OVERRIDE = (): string =>
  buildLayerPropsKey<DemoLayerProps>(BASE, DEMO_EFFECTS, {
    // @ts-expect-error `linewidth` is not a prop of DemoLayerProps.
    overrides: { linewidth: 4 },
  });

// ---------------------------------------------------------------------------

describe('type-level contracts', () => {
  it('rejects an unclassified prop, a stale entry, and a bad override key', () => {
    const fileName = fileURLToPath(import.meta.url);
    const program = ts.createProgram([fileName], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    });
    // Diagnostics from this file only: an `@ts-expect-error` that no longer
    // suppresses anything is reported HERE as TS2578 "Unused '@ts-expect-error'
    // directive", which is exactly the regression this test exists to catch.
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === fileName)
      .map(
        (d) =>
          `${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
      );
    expect(diagnostics).toEqual([]);
  }, 120_000);
});

describe('buildLayerPropsKey determinism', () => {
  it('ignores the order the effects table was written in', () => {
    const shuffled: PropEffects<DemoLayerProps> = {
      legendTitle: 'inert',
      fillColor: 'sublayer',
      currentTime: 'uniform',
      material: 'sublayer',
      colorPalette: 'prepare',
      stroked: 'sublayer',
      lineWidth: 'sublayer',
      strokeColor: 'sublayer',
      radiusScale: 'sublayer',
    };
    expect(buildLayerPropsKey<DemoLayerProps>(BASE, shuffled, undefined)).toBe(
      key(BASE),
    );
  });

  it('ignores the insertion order of the props object', () => {
    const reversed = Object.fromEntries(
      Object.entries(BASE).reverse(),
    ) as DemoLayerProps;
    expect(key(reversed)).toBe(key(BASE));
  });

  it('ignores the insertion order of the overrides object', () => {
    const a = key(BASE, { overrides: { lineWidth: 4, fillColor: 'cat' } });
    const b = key(BASE, { overrides: { fillColor: 'cat', lineWidth: 4 } });
    expect(a).toBe(b);
  });
});

describe('buildLayerPropsKey stability', () => {
  it('is a pure function of the inputs', () => {
    expect(key(BASE)).toBe(key(BASE));
  });

  it('keys equal-content values equally across object identities', () => {
    const clone: DemoLayerProps = {
      ...BASE,
      strokeColor: [...BASE.strokeColor],
      material: { ...BASE.material! },
      fillColor: [...(BASE.fillColor as number[])],
    };
    expect(key(clone)).toBe(key(BASE));
  });

  it('does not carry state between different effects tables', () => {
    type NarrowProps = Pick<DemoLayerProps, 'radiusScale'>;
    const onlyRadius: PropEffects<NarrowProps> = { radiusScale: 'sublayer' };
    const narrow = buildLayerPropsKey<NarrowProps>(BASE, onlyRadius);
    expect(narrow).not.toBe(key(BASE));
    expect(buildLayerPropsKey<NarrowProps>(BASE, onlyRadius)).toBe(narrow);
  });
});

describe('buildLayerPropsKey sensitivity', () => {
  const sublayerProps = (
    Object.keys(DEMO_EFFECTS) as (keyof DemoLayerProps)[]
  ).filter((k) => DEMO_EFFECTS[k] === 'sublayer');

  it.each(sublayerProps)('changing %s changes the key', (prop) => {
    expect(key({ ...BASE, [prop]: CHANGED[prop] })).not.toBe(key(BASE));
  });

  const excludedProps = (
    Object.keys(DEMO_EFFECTS) as (keyof DemoLayerProps)[]
  ).filter((k) => DEMO_EFFECTS[k] !== 'sublayer');

  it.each(excludedProps)('changing %s leaves the key alone', (prop) => {
    expect(key({ ...BASE, [prop]: CHANGED[prop] })).toBe(key(BASE));
  });

  it('detects in-place mutation of an object-valued prop', () => {
    const props: DemoLayerProps = { ...BASE, material: { ...BASE.material! } };
    const before = key(props);
    props.material!.shininess = 64;
    expect(key(props)).not.toBe(before);
  });

  it('distinguishes values that share a textual digest', () => {
    const keys = [undefined, '', null, 'null', 0, '0', false, 'false'].map(
      (v) => key({ ...BASE, fillColor: v as never }),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cannot be spoofed by a separator inside a string value', () => {
    const a = key({ ...BASE, fillColor: 'x', legendTitle: 'y' });
    const b = key({ ...BASE, fillColor: 'x|legendTitle=y', legendTitle: '' });
    expect(a).not.toBe(b);
  });
});

describe('buildLayerPropsKey overrides', () => {
  it('lets the resolved value win over the raw prop', () => {
    const resolved = key(BASE, { overrides: { lineWidth: 7 } });
    expect(resolved).not.toBe(key(BASE));
    expect(resolved).toBe(key({ ...BASE, lineWidth: 7 }));
  });

  it('honours an override whose resolved value is undefined', () => {
    expect(key(BASE, { overrides: { lineWidth: undefined } })).toBe(
      key({ ...BASE, lineWidth: undefined }),
    );
  });

  it('still keys an override on a prop classified outside sublayer', () => {
    const a = key(BASE, { overrides: { colorPalette: 'ramp-a' } });
    const b = key(BASE, { overrides: { colorPalette: 'ramp-b' } });
    expect(a).not.toBe(b);
    expect(a).not.toBe(key(BASE));
  });
});

describe('buildLayerPropsKey extra', () => {
  it('folds composite digests into the key', () => {
    const a = key(BASE, { extra: ['inherited:1', 'triggers:0'] });
    const b = key(BASE, { extra: ['inherited:2', 'triggers:0'] });
    expect(a).not.toBe(b);
    expect(a).not.toBe(key(BASE));
  });

  it('treats extra as positional', () => {
    const a = key(BASE, { extra: ['a', 'b'] });
    const b = key(BASE, { extra: ['b', 'a'] });
    expect(a).not.toBe(b);
  });

  it('keys an empty extra list the same as no extra', () => {
    expect(key(BASE, { extra: [] })).toBe(key(BASE));
  });
});

describe('buildLayerPropsKey function-valued props', () => {
  interface FnProps {
    radiusTransform?: ((value: number) => number) | null;
  }
  const effects: PropEffects<FnProps> = { radiusTransform: 'sublayer' };
  const build = (p: FnProps): string => buildLayerPropsKey<FnProps>(p, effects);

  it('keys a function by reference identity', () => {
    const fn = (v: number): number => v * 2;
    expect(build({ radiusTransform: fn })).toBe(build({ radiusTransform: fn }));
    expect(build({ radiusTransform: (v: number) => v * 2 })).not.toBe(
      build({ radiusTransform: (v: number) => v * 2 }),
    );
  });

  it('distinguishes a function from null and from absent', () => {
    const distinct = new Set([
      build({ radiusTransform: (v: number) => v }),
      build({ radiusTransform: null }),
      build({}),
    ]);
    expect(distinct.size).toBe(3);
  });
});
