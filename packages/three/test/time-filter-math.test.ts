import { describe, it, expect } from 'vitest';
import {
  windowAlpha,
  wakeAlpha,
  cumulativeAlpha,
  trailAlpha,
  wakeSizeScale,
  timeFilterAlpha,
  windowVisible,
  wakeVisible,
  cumulativeVisible,
  trailVisible,
  timeFilterVisible,
} from '../src/tsl/time-filter-math';
import type { TimeFilterMode } from '../src/tsl/time-filter-math';

describe('windowAlpha', () => {
  it('is 1 inside the window with no fades', () => {
    // window [100±50] = [50,150]; feature [90,110] overlaps
    expect(windowAlpha(100, 90, 110, 50)).toBe(1);
  });
  it('is 0 when the feature is entirely before the window', () => {
    expect(windowAlpha(100, 0, 40, 50)).toBe(0); // endTime 40 < timeStart 50
  });
  it('is 0 when the feature is entirely after the window', () => {
    expect(windowAlpha(100, 160, 200, 50)).toBe(0); // startTime 160 > timeEnd 150
  });
  it('ramps with fadeIn at the leading edge', () => {
    // currentTime 100, windowHalf 50 -> timeEnd 150; startTime 140 -> age 10
    // fadeIn 20 -> alpha = 10/20 = 0.5
    expect(windowAlpha(100, 140, 200, 50, 20, 0)).toBeCloseTo(0.5, 6);
  });
  it('ramps with fadeOut at the trailing edge', () => {
    // timeStart 50; endTime 60 -> remaining 10; fadeOut 20 -> 0.5
    expect(windowAlpha(100, 0, 60, 50, 0, 20)).toBeCloseTo(0.5, 6);
  });
});

describe('wakeAlpha', () => {
  it('is 1 exactly at the playhead and fades to 0 at the tail', () => {
    expect(wakeAlpha(100, 100, 60)).toBe(1); // age 0
    expect(wakeAlpha(100, 70, 60)).toBeCloseTo(0.5, 6); // age 30 / 60
    expect(wakeAlpha(100, 40, 60)).toBe(0); // age 60 -> tail
  });
  it('is 0 ahead of the playhead and beyond the wake', () => {
    expect(wakeAlpha(100, 110, 60)).toBe(0); // future
    expect(wakeAlpha(100, 30, 60)).toBe(0); // age 70 > 60
  });
});

describe('cumulativeAlpha', () => {
  it('hides features not yet created', () => {
    expect(cumulativeAlpha(100, 120)).toBe(0);
  });
  it('shows created features at full alpha with no fade', () => {
    expect(cumulativeAlpha(100, 80)).toBe(1);
  });
  it('ramps over fadeIn after creation', () => {
    expect(cumulativeAlpha(100, 90, 20)).toBeCloseTo(0.5, 6); // age 10 / 20
    expect(cumulativeAlpha(100, 50, 20)).toBe(1); // age 50 -> clamped
  });
});

describe('trailAlpha', () => {
  it('hides vertices ahead of the playhead or behind the trail', () => {
    expect(trailAlpha(100, 110, 50, 1)).toBe(0); // future vertex
    expect(trailAlpha(100, 40, 50, 1)).toBe(0); // older than trailStart 50
  });
  it('fades head->tail when trailFade=1', () => {
    expect(trailAlpha(100, 100, 50, 1)).toBe(1); // head
    expect(trailAlpha(100, 75, 50, 1)).toBeCloseTo(0.5, 6); // age 25 / 50
  });
  it('is solid (1) along the whole trail when trailFade=0', () => {
    expect(trailAlpha(100, 75, 50, 0)).toBe(1);
    expect(trailAlpha(100, 60, 50, 0)).toBe(1);
  });
});

describe('wakeSizeScale', () => {
  it('keeps the head full size and shrinks the tail toward wakeTailScale', () => {
    expect(wakeSizeScale(1, 0.1)).toBeCloseTo(1, 6); // head
    expect(wakeSizeScale(0, 0.1)).toBeCloseTo(0.1, 6); // tail
    expect(wakeSizeScale(0.5, 0.1)).toBeCloseTo(0.55, 6);
  });
});

describe('timeFilterAlpha dispatch', () => {
  it('routes to the right mode', () => {
    expect(timeFilterAlpha('none', 0, 0, 0)).toBe(1);
    expect(timeFilterAlpha('window', 100, 90, 110, { windowHalf: 50 })).toBe(1);
    expect(timeFilterAlpha('wake', 100, 70, 0, { wakeLength: 60 })).toBeCloseTo(
      0.5,
      6,
    );
    expect(timeFilterAlpha('cumulative', 100, 120, 0)).toBe(0);
    expect(
      timeFilterAlpha(
        'trail',
        100,
        0,
        0,
        { trailLength: 50, trailFade: 1 },
        75,
      ),
    ).toBeCloseTo(0.5, 6);
  });
});

// ── Hard-visibility mirror (vertex-stage collapse) ───────────────────────────

describe('windowVisible', () => {
  it('is 1 inside the window and 0 outside (edges are inclusive)', () => {
    expect(windowVisible(100, 90, 110, 50)).toBe(1); // [90,110] ∩ [50,150]
    expect(windowVisible(100, 0, 40, 50)).toBe(0); // endTime 40 < timeStart 50
    expect(windowVisible(100, 160, 200, 50)).toBe(0); // startTime 160 > timeEnd 150
    expect(windowVisible(100, 50, 50, 50)).toBe(1); // touches timeStart exactly
    expect(windowVisible(100, 150, 150, 50)).toBe(1); // touches timeEnd exactly
  });
  it('ignores the fade band — visible is 1 wherever windowAlpha would fade', () => {
    // The leading-edge fade case (windowAlpha 0.5) is still fully visible.
    expect(windowVisible(100, 140, 200, 50)).toBe(1);
  });
});

describe('wakeVisible', () => {
  it('is 1 across [0, wakeLength] behind the playhead, 0 elsewhere', () => {
    expect(wakeVisible(100, 100, 60)).toBe(1); // age 0 (head)
    expect(wakeVisible(100, 40, 60)).toBe(1); // age 60 (tail, inclusive)
    expect(wakeVisible(100, 110, 60)).toBe(0); // future
    expect(wakeVisible(100, 30, 60)).toBe(0); // age 70 > 60
  });
});

describe('cumulativeVisible', () => {
  it('is 1 once created, 0 before', () => {
    expect(cumulativeVisible(100, 80)).toBe(1);
    expect(cumulativeVisible(100, 100)).toBe(1); // exactly created
    expect(cumulativeVisible(100, 120)).toBe(0);
  });
});

describe('trailVisible', () => {
  it('is 1 within [cur-trailLength, cur], 0 outside', () => {
    expect(trailVisible(100, 100, 50)).toBe(1); // head
    expect(trailVisible(100, 50, 50)).toBe(1); // tail (inclusive)
    expect(trailVisible(100, 110, 50)).toBe(0); // future vertex
    expect(trailVisible(100, 40, 50)).toBe(0); // older than trailStart
  });
});

describe('timeFilterVisible dispatch', () => {
  it('routes to the right mode', () => {
    expect(timeFilterVisible('none', 0, 0, 0)).toBe(1);
    expect(timeFilterVisible('window', 100, 90, 110, { windowHalf: 50 })).toBe(
      1,
    );
    expect(timeFilterVisible('wake', 100, 70, 0, { wakeLength: 60 })).toBe(1);
    expect(timeFilterVisible('cumulative', 100, 120, 0)).toBe(0);
    expect(timeFilterVisible('trail', 100, 0, 0, { trailLength: 50 }, 75)).toBe(
      1,
    );
  });
});

// The load-bearing SAFETY invariant behind the vertex-collapse rewrite: the hard
// visibility is 0 ONLY on the hard out-of-window region, which is a SUBSET of
// where the soft alpha is 0 — so a collapsed primitive is always one the alpha
// would have drawn at opacity 0 anyway:
//
//     visible === 0  ⟹  alpha === 0        (equivalently  alpha > 0 ⟹ visible === 1)
//
// The REVERSE does NOT hold: at a fade razor-edge (e.g. startTime === timeEnd
// with fadeIn > 0, or age === wakeLength) alpha is exactly 0 while visible is 1 —
// the primitive is NOT collapsed and simply rasterises at opacity 0, exactly as
// today. Sweep each mode across a grid of times / windows / fades and assert the
// safe implication holds (and that visible is always a hard 0/1).
describe('visible ⟹ (alpha would draw) — safe-collapse invariant', () => {
  const params = {
    windowHalf: 50,
    fadeIn: 20,
    fadeOut: 20,
    wakeLength: 60,
    trailLength: 50,
    trailFade: 1,
  };
  const modes: TimeFilterMode[] = [
    'window',
    'wake',
    'cumulative',
    'trail',
    'none',
  ];
  it('never collapses a primitive whose alpha is > 0, for every mode', () => {
    for (const mode of modes) {
      for (let cur = 0; cur <= 200; cur += 7) {
        for (let start = -20; start <= 220; start += 11) {
          for (const span of [0, 15, 60]) {
            const end = start + span;
            // vertexTime sweeps within/around the feature for trail mode.
            for (const vt of [start, (start + end) / 2, end, cur, cur - 40]) {
              const a = timeFilterAlpha(mode, cur, start, end, params, vt);
              const v = timeFilterVisible(mode, cur, start, end, params, vt);
              expect(v === 0 || v === 1).toBe(true); // hard 0/1
              if (a > 0) expect(v).toBe(1); // alpha draws ⟹ never collapse
              if (v === 0) expect(a).toBe(0); // collapsed ⟹ alpha already 0
            }
          }
        }
      }
    }
  });
});
