/**
 * Parity + semantics tests for the column range-filter kernel.
 *
 * `shaders/data-filter.glsl.ts` must compute the same in/out/faded factor as
 * @poopdeck.gl/layers's DataFilterExtension, so a `filterRange` slider hides
 * the identical features on both backends. We re-implement deck's
 * `step`/`smoothstep`/`mix` expression in-line (self-contained — no deck.gl
 * import) and assert branch-by-branch agreement, then pin the semantics deck
 * leaves implicit: inclusive bounds, inverted ranges, NaN values, and the
 * missing-column degradation that must render UNFILTERED rather than blank.
 */

import { describe, it, expect } from 'vitest';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  createDataFilterUniforms,
  dataFilterAlphaJS,
  expandFilterValues,
  extractFilterColumn,
  resolveDataFilterUniforms,
  type DataFilterRange,
} from '../src/shaders/data-filter.glsl';
import {
  makePointTile,
  makePropertyPointTile,
  makeTripsTile,
} from './fixtures';

// ── deck.gl reference ───────────────────────────────────────────────────────

const step = (edge: number, x: number) => (x >= edge ? 1 : 0);
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Reference re-implementation of the DataFilterExtension `vs:#main-start`
 * injection, pulled verbatim from
 * packages/layers/src/extensions/data-filter-extension.ts. If this drifts from
 * `dataFilterAlphaJS` the two backends no longer agree and we want a loud
 * failure.
 *
 * Note the caller must keep `softMin !== min` / `softMax !== max` when
 * `useSoftMargin` is on: deck's `mix` multiplies a degenerate `smoothstep`
 * (undefined for `edge0 == edge1`) by zero, which is NaN in JS. The collapsed
 * case is exactly what `useSoftMargin: false` covers, and that path is
 * compared separately below.
 */
function deckFilterAlpha(
  v: number,
  min: number,
  max: number,
  softMin: number,
  softMax: number,
  enabled: boolean,
  useSoftMargin: boolean,
): number {
  if (!enabled) return 1;
  if (useSoftMargin) {
    const leftInRange = mix(
      smoothstep(min, softMin, v),
      step(min, v),
      step(softMin, min),
    );
    const rightInRange = mix(
      1 - smoothstep(softMax, max, v),
      step(v, max),
      step(max, softMax),
    );
    return leftInRange * rightInRange;
  }
  return step(min, v) * step(v, max);
}

const SWEEP = [
  -100, -1, -0.001, 0, 0.001, 1, 2, 2.5, 5, 7.5, 8, 9, 9.999, 10, 10.001, 100,
];

/** Whole-sweep vectors, so a mismatch reports which values diverged. */
const sweepOurs = (
  range: DataFilterRange,
  soft: DataFilterRange,
  enabled = true,
) => SWEEP.map((v) => dataFilterAlphaJS(v, range, soft, enabled));
const sweepDeck = (
  range: DataFilterRange,
  soft: DataFilterRange,
  enabled = true,
  useSoftMargin = false,
) =>
  SWEEP.map((v) =>
    deckFilterAlpha(
      v,
      range[0],
      range[1],
      soft[0],
      soft[1],
      enabled,
      useSoftMargin,
    ),
  );

describe('data-filter parity vs @poopdeck.gl/layers DataFilterExtension', () => {
  it('matches the hard-range branch across a value sweep', () => {
    expect(sweepOurs([0, 10], [0, 10])).toEqual(sweepDeck([0, 10], [0, 10]));
  });

  it('matches the soft-margin branch across a value sweep', () => {
    // Exact, not approximate: with softMin > min deck's `mix` weight is 0, so
    // its expression reduces to the same `smoothstep` ours calls.
    expect(sweepOurs([0, 10], [2, 8])).toEqual(
      sweepDeck([0, 10], [2, 8], true, true),
    );
  });

  it('matches when a soft edge is truncated by the hard edge', () => {
    // softMin below min ⇒ deck's mix picks the hard step on the left; softMax
    // above max ⇒ same on the right. Both edges exercised independently.
    for (const soft of [
      [-5, 8],
      [2, 15],
      [-5, 15],
    ] as const) {
      expect(sweepOurs([0, 10], soft)).toEqual(
        sweepDeck([0, 10], soft, true, true),
      );
    }
  });

  it('collapsing the soft range onto the hard range equals deck useSoftMargin=0', () => {
    // This is what resolveDataFilterUniforms does when no filterSoftRange is
    // supplied — the kernel must read it as "no margin", not as a degenerate
    // smoothstep.
    expect(sweepOurs([2, 8], [2, 8])).toEqual(sweepDeck([2, 8], [2, 8]));
  });

  it('matches the disabled branch (everything renders)', () => {
    expect(sweepOurs([0, 10], [0, 10], false)).toEqual(
      sweepDeck([0, 10], [0, 10], false),
    );
  });
});

describe('dataFilterAlphaJS semantics', () => {
  it('is inclusive at both hard bounds', () => {
    expect(dataFilterAlphaJS(0, [0, 10], [0, 10], true)).toBe(1);
    expect(dataFilterAlphaJS(10, [0, 10], [0, 10], true)).toBe(1);
    expect(dataFilterAlphaJS(-0.001, [0, 10], [0, 10], true)).toBe(0);
    expect(dataFilterAlphaJS(10.001, [0, 10], [0, 10], true)).toBe(0);
  });

  it('ramps smoothly inside the soft margins', () => {
    // range [0,10], soft [2,8]: the midpoint of each margin is smoothstep 0.5.
    expect(dataFilterAlphaJS(1, [0, 10], [2, 8], true)).toBeCloseTo(0.5, 12);
    expect(dataFilterAlphaJS(9, [0, 10], [2, 8], true)).toBeCloseTo(0.5, 12);
    // Fully inside the soft range ⇒ untouched.
    expect(dataFilterAlphaJS(5, [0, 10], [2, 8], true)).toBe(1);
    // The hard edges themselves fade to 0 once a margin exists.
    expect(dataFilterAlphaJS(0, [0, 10], [2, 8], true)).toBe(0);
    expect(dataFilterAlphaJS(10, [0, 10], [2, 8], true)).toBe(0);
  });

  it('ignores a soft range wider than the hard range, per edge', () => {
    for (const v of SWEEP) {
      expect(dataFilterAlphaJS(v, [2, 8], [0, 10], true)).toBe(
        dataFilterAlphaJS(v, [2, 8], [2, 8], true),
      );
    }
  });

  it('hides everything for an inverted range (no auto-swap)', () => {
    for (const v of SWEEP) {
      expect(dataFilterAlphaJS(v, [10, 0], [10, 0], true)).toBe(0);
    }
  });

  it('hides a NaN value but never a disabled one', () => {
    expect(dataFilterAlphaJS(NaN, [0, 10], [0, 10], true)).toBe(0);
    expect(dataFilterAlphaJS(NaN, [0, 10], [2, 8], true)).toBe(0);
    // Disabled short-circuits before the value is inspected.
    expect(dataFilterAlphaJS(NaN, [0, 10], [0, 10], false)).toBe(1);
  });

  it('renders everything when disabled, however far outside the range', () => {
    expect(dataFilterAlphaJS(1e9, [0, 1], [0, 1], false)).toBe(1);
    expect(dataFilterAlphaJS(-1e9, [0, 1], [0, 1], false)).toBe(1);
  });
});

describe('resolveDataFilterUniforms', () => {
  it('activates on a finite range with the column present', () => {
    const u = resolveDataFilterUniforms(
      createDataFilterUniforms(),
      { filterRange: [1, 5] },
      true,
    );
    expect(u.enabled).toBe(1);
    expect(Array.from(u.range)).toEqual([1, 5]);
    // No soft range ⇒ collapsed onto the hard range (kernel reads it as hard).
    expect(Array.from(u.softRange)).toEqual([1, 5]);
  });

  it('carries a supplied soft range through', () => {
    const u = resolveDataFilterUniforms(
      createDataFilterUniforms(),
      { filterRange: [0, 10], filterSoftRange: [2, 8] },
      true,
    );
    expect(Array.from(u.softRange)).toEqual([2, 8]);
  });

  it('idles when the tile lacks the column — unfiltered, never blank', () => {
    const u = resolveDataFilterUniforms(
      createDataFilterUniforms(),
      { filterProperty: 'magnitude', filterRange: [1, 2] },
      false,
    );
    expect(u.enabled).toBe(0);
    // The regression this whole file exists for: a tile without the column
    // must render every feature, including ones far outside the range.
    expect(dataFilterAlphaJS(999, u.range, u.softRange, u.enabled > 0.5)).toBe(
      1,
    );
  });

  it('idles on filterEnabled:false, a null range, or a non-finite range', () => {
    const cases = [
      { filterRange: [1, 5] as const, filterEnabled: false },
      { filterRange: null },
      {},
      { filterRange: [NaN, 5] as const },
      { filterRange: [1, Infinity] as const },
    ];
    const resolved = cases.map((opts) => {
      const u = resolveDataFilterUniforms(
        createDataFilterUniforms(),
        opts,
        true,
      );
      return [u.enabled, ...u.range, ...u.softRange];
    });
    expect(resolved).toEqual(cases.map(() => [0, 0, 0, 0, 0]));
  });

  it('ignores a soft range when the hard range is absent', () => {
    const u = resolveDataFilterUniforms(
      createDataFilterUniforms(),
      { filterSoftRange: [2, 8] },
      true,
    );
    expect(u.enabled).toBe(0);
    expect(Array.from(u.softRange)).toEqual([0, 0]);
  });

  it('defaults both transform flags on and honours explicit false', () => {
    const on = resolveDataFilterUniforms(
      createDataFilterUniforms(),
      { filterRange: [0, 1] },
      true,
    );
    expect(on.transformSize).toBe(1);
    expect(on.transformColor).toBe(1);
    const off = resolveDataFilterUniforms(
      createDataFilterUniforms(),
      {
        filterRange: [0, 1],
        filterTransformSize: false,
        filterTransformColor: false,
      },
      true,
    );
    expect(off.transformSize).toBe(0);
    expect(off.transformColor).toBe(0);
  });

  it('resolves in place so the draw path allocates nothing', () => {
    const u = createDataFilterUniforms();
    const range = u.range;
    const softRange = u.softRange;
    const a = resolveDataFilterUniforms(u, { filterRange: [1, 5] }, true);
    const b = resolveDataFilterUniforms(u, { filterRange: [3, 9] }, true);
    expect(a).toBe(u);
    expect(b).toBe(u);
    expect(u.range).toBe(range);
    expect(u.softRange).toBe(softRange);
    expect(Array.from(u.range)).toEqual([3, 9]);
  });
});

describe('extractFilterColumn', () => {
  it('returns a zero-copy view of a baked numeric column', () => {
    const f = makePropertyPointTile().layers[0].features;
    const col = extractFilterColumn(f, 'magnitude');
    expect(col.hasColumn).toBe(true);
    expect(col.categorical).toBe(false);
    // Identity, not a copy — the layer uploads this straight to a buffer.
    expect(col.values).toBe(f.numericProps.magnitude);
    expect(Array.from(col.values!)).toEqual([2, 8]);
  });

  it('flags a categorical column as not range-filterable', () => {
    const f = makePropertyPointTile().layers[0].features;
    const col = extractFilterColumn(f, 'species');
    expect(col.categorical).toBe(true);
    expect(col.hasColumn).toBe(false);
    expect(col.values).toBeNull();
  });

  it('degrades to unfiltered for a missing column or no filterProperty', () => {
    const f = makePropertyPointTile().layers[0].features;
    const names = ['nope', '', undefined, null] as const;
    const resolved = names.map((name) => {
      const col = extractFilterColumn(f, name);
      return [name, col.hasColumn, col.categorical, col.values];
    });
    expect(resolved).toEqual(names.map((name) => [name, false, false, null]));
  });

  it('degrades on a tile with no properties at all', () => {
    const f = makePointTile().layers[0].features;
    const col = extractFilterColumn(f, 'magnitude');
    expect(col.hasColumn).toBe(false);
    expect(col.values).toBeNull();
  });

  it('reads a trips tile column alongside its categorical sibling', () => {
    const f = makeTripsTile().layers[0].features;
    expect(extractFilterColumn(f, 'width').hasColumn).toBe(true);
    expect(extractFilterColumn(f, 'vehicleType').categorical).toBe(true);
  });

  it('end-to-end: missing column + an active range renders everything', () => {
    const f = makePointTile().layers[0].features;
    const col = extractFilterColumn(f, 'magnitude');
    const u = resolveDataFilterUniforms(
      createDataFilterUniforms(),
      { filterProperty: 'magnitude', filterRange: [4, 6] },
      col.hasColumn,
    );
    for (const v of SWEEP) {
      expect(dataFilterAlphaJS(v, u.range, u.softRange, u.enabled > 0.5)).toBe(
        1,
      );
    }
  });

  it('end-to-end: present column + an active range filters as expected', () => {
    const f = makePropertyPointTile().layers[0].features;
    const col = extractFilterColumn(f, 'magnitude');
    const u = resolveDataFilterUniforms(
      createDataFilterUniforms(),
      { filterProperty: 'magnitude', filterRange: [4, 10] },
      col.hasColumn,
    );
    const alphas = Array.from(col.values!).map((v) =>
      dataFilterAlphaJS(v, u.range, u.softRange, u.enabled > 0.5),
    );
    expect(alphas).toEqual([0, 1]); // magnitudes [2, 8] against [4, 10]
  });
});

describe('expandFilterValues', () => {
  it('repeats each feature value across its instances', () => {
    const out = expandFilterValues(new Float32Array([4, 6]), [2, 1], 3);
    expect(Array.from(out)).toEqual([4, 4, 6]);
  });

  it('skips features that contributed no instances', () => {
    const out = expandFilterValues(new Float32Array([1, 2, 3]), [1, 0, 2], 3);
    expect(Array.from(out)).toEqual([1, 3, 3]);
  });

  it('never writes past `total`', () => {
    const out = expandFilterValues(new Float32Array([7, 8]), [5, 5], 3);
    expect(out.length).toBe(3);
    expect(Array.from(out)).toEqual([7, 7, 7]);
  });

  it('stops at the shorter of values/counts', () => {
    const out = expandFilterValues(new Float32Array([9]), [1, 4], 5);
    expect(Array.from(out)).toEqual([9, 0, 0, 0, 0]);
  });
});

describe('GLSL splice contract', () => {
  it('declares the kernel with the documented signature', () => {
    expect(DATA_FILTER_GLSL).toContain('float sttDataFilterAlpha(');
    expect(DATA_FILTER_GLSL).toContain('vec2 range');
    expect(DATA_FILTER_GLSL).toContain('vec2 softRange');
    expect(DATA_FILTER_GLSL).toContain('bool enabled');
    // Disabled must return 1.0, and a NaN value must be decided explicitly.
    expect(DATA_FILTER_GLSL).toContain('if (!enabled) return 1.0;');
    expect(DATA_FILTER_GLSL).toContain('filterValue != filterValue');
  });

  it('declares every name layers resolve locations by', () => {
    expect(DATA_FILTER_ATTRIBUTE_GLSL).toContain(
      `attribute float ${DATA_FILTER_NAMES.attribute};`,
    );
    for (const name of [DATA_FILTER_NAMES.range, DATA_FILTER_NAMES.softRange]) {
      expect(DATA_FILTER_UNIFORMS_GLSL).toContain(`uniform vec2 ${name};`);
    }
    for (const name of [
      DATA_FILTER_NAMES.enabled,
      DATA_FILTER_NAMES.transformSize,
      DATA_FILTER_NAMES.transformColor,
    ]) {
      expect(DATA_FILTER_UNIFORMS_GLSL).toContain(`uniform float ${name};`);
    }
  });

  it('calls the kernel with the declared names', () => {
    expect(DATA_FILTER_CALL_GLSL).toContain(DATA_FILTER_NAMES.attribute);
    expect(DATA_FILTER_CALL_GLSL).toContain(DATA_FILTER_NAMES.range);
    expect(DATA_FILTER_CALL_GLSL).toContain(DATA_FILTER_NAMES.softRange);
    expect(DATA_FILTER_CALL_GLSL).toContain(
      `${DATA_FILTER_NAMES.enabled} > 0.5`,
    );
  });
});
