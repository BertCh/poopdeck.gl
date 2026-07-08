import { describe, it, expect } from 'vitest';
import {
  windowAlpha,
  wakeAlpha,
  cumulativeAlpha,
  trailAlpha,
  wakeSizeScale,
  timeFilterAlpha,
} from '../src/tsl/time-filter-math';

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
