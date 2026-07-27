/**
 * Extension OPTION hygiene — `this.opts` shape and `LayerExtension.equals()`.
 *
 * Why this matters, and why it is invisible without a test: deck diffs an
 * extension list with
 *
 *   this.constructor === extension.constructor && deepEqual(this.opts, extension.opts, 1)
 *   — @deck.gl/core/src/lib/layer-extension.ts
 *
 * At depth 1, `deepEqual` compares each VALUE at depth 0, i.e. arrays BY
 * REFERENCE. An extension that reports unequal every render sets
 * `extensionsChanged`, and the primitive sublayer responds by destroying and
 * recreating its `Model` — silently, at frame rate. Two ways to fall in:
 *
 *  1. carrying an inert option into `opts` (`STTDataFilterExtension({fp64:
 *     true})` used to be spread straight through, so it never matched a
 *     default-constructed instance); and
 *  2. accepting a caller's ARRAY option by reference (`new
 *     ChevronFlowExtension({directionColors: [[255,0,0], …]})` written inline in
 *     a React render mints a fresh array every frame).
 *
 * Runs against the REAL `LayerExtension` — the sibling suites mock
 * `@deck.gl/core` with a base class that stores no `opts` at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STTDataFilterExtension } from '../src/extensions/data-filter-extension';
import { ChevronFlowExtension } from '../src/extensions/chevron-flow-extension';
import { TimeFilterExtension } from '../src/extensions/time-filter-extension';
import { _resetWarnOnce } from '../src/lib/log';

describe('STTDataFilterExtension opts normalization', () => {
  beforeEach(() => _resetWarnOnce());

  it('stores exactly {filterSize: 1}, whatever the caller passed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const junk = new STTDataFilterExtension({
        fp64: true,
        countItems: true,
        categorySize: 2,
        onFilteredItemsChange: () => {},
      } as any);
      expect(junk.opts).toEqual({ filterSize: 1 });
      expect(Object.keys(junk.opts)).toEqual(['filterSize']);
    } finally {
      warn.mockRestore();
    }
  });

  it('equals() a default-constructed instance (no per-render model rebuild)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const junk = new STTDataFilterExtension({ fp64: true } as any);
      const plain = new STTDataFilterExtension();
      expect(junk.equals(plain)).toBe(true);
      expect(plain.equals(junk)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('an out-of-range filterSize is still clamped into opts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(new STTDataFilterExtension({ filterSize: 3 } as any).opts).toEqual(
        {
          filterSize: 1,
        },
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ChevronFlowExtension array options are reference-stable', () => {
  const RED_PALETTE = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ] as const;

  it('two inline literals with the same content intern to one reference', () => {
    // The React-render shape: a fresh array object every frame.
    const a = new ChevronFlowExtension({
      directionColor: true,
      directionColors: RED_PALETTE.map((c) => [...c]) as any,
    });
    const b = new ChevronFlowExtension({
      directionColor: true,
      directionColors: RED_PALETTE.map((c) => [...c]) as any,
    });
    expect(a.opts.directionColors).toBe(b.opts.directionColors);
    // …which is the whole point: deck's depth-1 deepEqual now reports equal.
    expect(a.equals(b)).toBe(true);
  });

  it('an inline copy of the DEFAULT palette matches the bare constructor', () => {
    const bare = new ChevronFlowExtension();
    const spelled = new ChevronFlowExtension({
      directionColors: bare.opts.directionColors.map((c) => [...c]) as any,
    });
    expect(spelled.opts.directionColors).toBe(bare.opts.directionColors);
    expect(spelled.equals(bare)).toBe(true);
  });

  it('genuinely different palettes still compare unequal', () => {
    const a = new ChevronFlowExtension({
      directionColors: RED_PALETTE.map((c) => [...c]) as any,
    });
    const b = new ChevronFlowExtension({
      directionColors: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
        [10, 11, 12],
      ] as any,
    });
    expect(a.equals(b)).toBe(false);
  });

  it('interning copies, so mutating the caller’s array cannot desync the table', () => {
    const mine: any = RED_PALETTE.map((c) => [...c]);
    const ext = new ChevronFlowExtension({ directionColors: mine });
    expect(ext.opts.directionColors).not.toBe(mine);
    mine[0][0] = 7;
    expect(ext.opts.directionColors[0][0]).toBe(255);
  });

  it('scalar options still distinguish instances', () => {
    expect(
      new ChevronFlowExtension({ period: 8 }).equals(
        new ChevronFlowExtension({ period: 6 }),
      ),
    ).toBe(false);
    expect(
      new ChevronFlowExtension({ uniformSpacing: true }).equals(
        new ChevronFlowExtension({ uniformSpacing: false }),
      ),
    ).toBe(false);
  });
});

describe('TimeFilterExtension opts (unchanged contract)', () => {
  it('flows `mode` to super() so equals() distinguishes configurations', () => {
    expect(
      new TimeFilterExtension({ mode: 'window' }).equals(
        new TimeFilterExtension({ mode: 'trail' }),
      ),
    ).toBe(false);
    expect(
      new TimeFilterExtension({ mode: 'window' }).equals(
        new TimeFilterExtension({ mode: 'window' }),
      ),
    ).toBe(true);
  });
});
