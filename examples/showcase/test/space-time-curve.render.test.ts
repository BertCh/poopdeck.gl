import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import SpaceTimeCurve, {
  __test,
} from '../src/components/how/SpaceTimeCurve.tsx';

const {
  ORDERS,
  ORDER_KEYS,
  GESTURE_KEYS,
  INTERACTIONS,
  CUMULATIVE,
  STATS,
  SEEKS,
  CELLS,
  sceneAt,
  Cube,
  ByteStrip,
} = __test;

describe('SpaceTimeCurve data model', () => {
  it('every ordering visits all 64 cells exactly once', () => {
    for (const k of ORDER_KEYS) {
      const order = ORDERS[k];
      expect(order.length).toBe(CELLS);
      const keys = new Set(order.map((c) => `${c.x},${c.y},${c.t}`));
      expect(keys.size).toBe(CELLS);
    }
  });

  it('hilbert3 has zero seeks — every consecutive pair is grid-adjacent', () => {
    expect(SEEKS.hilbert3).toBe(0);
  });

  it('each gesture touches the tiles the story claims', () => {
    const distinct = Object.fromEntries(
      GESTURE_KEYS.map((g) => [g, CUMULATIVE[g].length]),
    );
    expect(distinct).toEqual({
      play: 16,
      pan: 16,
      panPlay: 16,
      zoom: 28,
      preload: 4,
    });
  });

  it("a gesture's cumulative set is exactly the union of its frames", () => {
    for (const g of GESTURE_KEYS) {
      const union = new Set<string>();
      for (const frame of INTERACTIONS[g].frames)
        for (const c of frame) union.add(`${c.x},${c.y},${c.t}`);
      expect(new Set(CUMULATIVE[g].map((c) => `${c.x},${c.y},${c.t}`))).toEqual(
        union,
      );
    }
  });

  // The whole pedagogy in one table — pin it so the numbers can never drift
  // from the walk each ordering is meant to win, and hilbert3 never spikes.
  it('range-read matrix matches the locked story', () => {
    const matrix = Object.fromEntries(
      ORDER_KEYS.map((k) => [
        k,
        GESTURE_KEYS.map((g) => STATS[k][g].runs.length),
      ]),
    );
    expect(matrix).toEqual({
      // play  pan  panPlay  zoom  preload
      spatial: [1, 16, 10, 12, 1],
      hilbert3: [1, 4, 5, 3, 2],
      time: [4, 1, 6, 3, 4],
    });
  });

  it('each specialist walk wins its own gesture, and hilbert3 is never worst', () => {
    const runs = (
      k: (typeof ORDER_KEYS)[number],
      g: (typeof GESTURE_KEYS)[number],
    ) => STATS[k][g].runs.length;
    // play/preload favour the time-deep spatial walk; pan favours time-major.
    expect(runs('spatial', 'play')).toBeLessThanOrEqual(runs('time', 'play'));
    expect(runs('spatial', 'preload')).toBeLessThan(runs('time', 'preload'));
    expect(runs('time', 'pan')).toBeLessThan(runs('spatial', 'pan'));
    // the combined gesture belongs to the 3D generalist outright.
    for (const other of ['spatial', 'time'] as const)
      expect(runs('hilbert3', 'panPlay')).toBeLessThan(runs(other, 'panPlay'));
    // and hilbert3 never has the worst count on any gesture.
    for (const g of GESTURE_KEYS) {
      const worst = Math.max(...ORDER_KEYS.map((k) => runs(k, g)));
      expect(runs('hilbert3', g)).toBeLessThan(worst + 1); // ≤ worst
      expect(runs('hilbert3', g)).toBeLessThanOrEqual(
        Math.max(runs('spatial', g), runs('time', g)),
      );
    }
  });

  it('sceneAt accumulates: touched grows to the full set, active is a subset of touched', () => {
    for (const g of GESTURE_KEYS) {
      const start = sceneAt(g, 0);
      const end = sceneAt(g, 1);
      expect(end.touched.size).toBe(CUMULATIVE[g].length);
      // active is always part of what's been touched so far.
      for (const p of [0, 0.3, 0.5, 0.75, 1]) {
        const s = sceneAt(g, p);
        for (const k of s.active) expect(s.touched.has(k)).toBe(true);
      }
      expect(start.touched.size).toBeGreaterThan(0);
      expect(start.touched.size).toBeLessThanOrEqual(end.touched.size);
    }
  });
});

describe('SpaceTimeCurve rendering', () => {
  it('the page component renders at initial state', () => {
    expect(renderToString(React.createElement(SpaceTimeCurve))).toContain(
      'svg',
    );
  });

  it('Cube and ByteStrip render for every order × gesture × progress, including out-of-range', () => {
    const progresses = [-1, -0.01, 0, 0.01, 0.25, 0.5, 0.999, 1, 1.5, NaN];
    for (const order of ORDER_KEYS) {
      for (const gesture of GESTURE_KEYS) {
        for (const p of progresses) {
          const { active, touched } = sceneAt(gesture, Number.isNaN(p) ? 0 : p);
          for (const animating of [true, false]) {
            expect(() =>
              renderToString(
                React.createElement(Cube, {
                  order,
                  gesture,
                  active,
                  touched,
                  animating,
                }),
              ),
            ).not.toThrow();
          }
          expect(() =>
            renderToString(
              React.createElement(ByteStrip, {
                order,
                gesture,
                active,
                touched,
              }),
            ),
          ).not.toThrow();
        }
        // also the reduced-motion end state (empty active, full touched)
        expect(() =>
          renderToString(
            React.createElement(Cube, {
              order,
              gesture,
              active: new Set<string>(),
              touched: new Set(
                CUMULATIVE[gesture].map((c) => `${c.x},${c.y},${c.t}`),
              ),
              animating: false,
            }),
          ),
        ).not.toThrow();
      }
    }
  });
});
