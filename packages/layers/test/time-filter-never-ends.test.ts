/**
 * Regression: `getInstanceEndTime`'s "no end" default must be a large FINITE
 * f32, never `Infinity`.
 *
 * deck routes every constant attribute value through
 * `DataColumn._normalizeValue` (core/lib/attribute/data-column.ts). For a
 * size-1 attribute that reduces to
 *
 *     Number.isFinite(value[0]) ? value[0] : defaultValue[0]
 *
 * and `Infinity[0]` is `undefined`, so a literal `Infinity` writes the
 * descriptor's `defaultValue` instead. With no `defaultValue` declared,
 * DataColumn synthesizes `[0]` — turning "never ends" into "ended at the
 * epoch". The shader's window test then hides the feature the moment
 * `relativeTime > timeWindow / 2`: a silently blank layer.
 *
 * Every shipped chassis layer binds a real `instanceEndTime` buffer, so this
 * only ever bit external users of the publicly-exported extension — which is
 * exactly the surface the `@default` doc advertises.
 */
import { describe, it, expect } from 'vitest';
import {
  TimeFilterExtension,
  NEVER_ENDS,
} from '../src/extensions/time-filter-extension';

describe('TimeFilterExtension "never ends" sentinel', () => {
  it('is finite and survives a Float32 round-trip', () => {
    expect(Number.isFinite(NEVER_ENDS)).toBe(true);
    expect(new Float32Array([NEVER_ENDS])[0]).toBe(NEVER_ENDS);
  });

  it('is larger than any plausible relative time', () => {
    // Relative times are ms offsets from a per-tile timeOffset; even a decade
    // is ~3.15e11, twenty-seven orders of magnitude below the sentinel.
    expect(NEVER_ENDS).toBeGreaterThan(1e30);
  });

  it('is the declared getInstanceEndTime default, not Infinity', () => {
    const value = (TimeFilterExtension as any).defaultProps.getInstanceEndTime
      .value;
    expect(value).toBe(NEVER_ENDS);
    expect(Number.isFinite(value)).toBe(true);
  });

  it('registers instanceEndTime with a finite defaultValue', () => {
    // Reproduces deck's normalization on the descriptor the extension
    // registers: without an explicit finite `defaultValue`, a non-finite
    // accessor result falls back to 0 and blanks the feature.
    const added: Record<string, any> = {};
    const layer = {
      getAttributeManager: () => ({
        add: (spec: Record<string, any>) => Object.assign(added, spec),
      }),
      props: {},
      state: {},
      context: {},
    };
    const ext = new TimeFilterExtension();
    (ext.initializeState as any).call(layer, {}, ext);

    const endTime = added.instanceEndTime;
    expect(endTime).toBeDefined();
    expect(Number.isFinite(endTime.defaultValue)).toBe(true);
    expect(endTime.defaultValue).toBe(NEVER_ENDS);

    // deck's size-1 branch, verbatim.
    const normalize = (v: number) =>
      Number.isFinite((v as any)[0])
        ? (v as any)[0]
        : Number.isFinite(v)
          ? v
          : endTime.defaultValue;
    expect(normalize(NEVER_ENDS)).toBe(NEVER_ENDS);
    expect(normalize(Infinity)).toBe(NEVER_ENDS);
  });
});
