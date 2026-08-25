// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * Tile-loading audit 2026-08, finding E2 (LC-2): the Cesium consumer drove
 * `tileset.update()` from `attachCesiumClock`'s apply callback on EVERY drawn
 * frame, and the tileset's identical-params fast path keys on the raw time
 * range, so a moving playhead meant a full selection pass per frame. The
 * throttle mirrors the deck chassis's rule (`timeWindow/20` of sim travel AND
 * a 100 ms wall floor; spatial changes straight through; one trailing pass so
 * the last tick is never lost). Wall clock is injected; timers are faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BoundingBox } from '@poopdeck.gl/core';
import { attachCesiumClock, type PlayheadClock } from '../src/cesium-clock';
import {
  createThrottledTilesetUpdate,
  type TilesetViewport,
} from '../src/lib/tileset-update-throttle';

const T0 = 1_700_000_000_000;
const FRAME_MS = 1000 / 60;
const BOX: BoundingBox = { minLon: 7, minLat: 46, maxLon: 9, maxLat: 48 };

function viewport(time: number, extra: Partial<TilesetViewport> = {}) {
  return { bounds: BOX, zoom: 9, time, timeWindow: 5000, ...extra };
}

/** A fake tileset counting `update` calls, and a settable wall clock. */
function harness() {
  let wall = 0;
  const update = vi.fn();
  const throttled = createThrottledTilesetUpdate(
    { update },
    { now: () => wall },
  );
  return {
    update,
    throttled,
    tick: (ms = FRAME_MS) => {
      wall += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('E2 — createThrottledTilesetUpdate', () => {
  it('E2: 60 frames in one second with an advancing clock drive tileset.update at most 11 times', () => {
    const { update, throttled, tick } = harness();
    // 1 s of sim per frame — far past the 250 ms sim threshold — so only the
    // wall floor can bound the rate.
    for (let i = 0; i < 60; i++) {
      throttled.update(viewport(T0 + i * 1000), true);
      tick();
    }
    expect(update.mock.calls.length).toBeLessThanOrEqual(11);
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(9);
    // `skipDebounce` rides through on whichever pass carries the viewport.
    for (const call of update.mock.calls) expect(call[1]).toBe(true);
  });

  it('E2: a spatial change inside the throttle window drives immediately', () => {
    const { update, throttled, tick } = harness();
    expect(throttled.update(viewport(T0))).toBe(true);
    tick();
    expect(throttled.update(viewport(T0 + 50))).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);

    expect(throttled.update(viewport(T0 + 60, { zoom: 10 }))).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].zoom).toBe(10);

    const panned = { ...BOX, minLon: 6 };
    expect(
      throttled.update(viewport(T0 + 70, { zoom: 10, bounds: panned })),
    ).toBe(true);
    expect(update).toHaveBeenCalledTimes(3);
    expect(update.mock.calls[2][0].bounds).toBe(panned);

    // A changed selection window is a new selection too.
    expect(
      throttled.update(
        viewport(T0 + 80, { zoom: 10, bounds: panned, timeWindow: 9000 }),
      ),
    ).toBe(true);
    expect(update).toHaveBeenCalledTimes(4);
  });

  it('E2: a paused-clock setTime inside the window gets exactly one trailing update', () => {
    const { update, throttled, tick } = harness();
    throttled.update(viewport(T0));
    tick();
    // A 100 ms seek (under the 250 ms threshold), then the clock stops.
    expect(throttled.update(viewport(T0 + 100))).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);

    tick(200);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].time).toBe(T0 + 100);

    tick(2000);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('E2: the trailing pass carries the LAST held viewport, not the first', () => {
    const { update, throttled, tick } = harness();
    throttled.update(viewport(T0));
    tick();
    throttled.update(viewport(T0 + 20));
    tick();
    throttled.update(viewport(T0 + 40));
    tick(100);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].time).toBe(T0 + 40);
  });

  it('E2: an identical viewport is idle — no pass, no timer', () => {
    const { update, throttled, tick } = harness();
    throttled.update(viewport(T0));
    tick(500);
    expect(throttled.update(viewport(T0))).toBe(false);
    tick(500);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('E2: dispose drops a held viewport; flush runs one early', () => {
    const a = harness();
    a.throttled.update(viewport(T0));
    a.tick();
    a.throttled.update(viewport(T0 + 100));
    a.throttled.dispose();
    a.tick(500);
    expect(a.update).toHaveBeenCalledTimes(1);
    expect(a.throttled.update(viewport(T0 + 5000))).toBe(false);

    const b = harness();
    b.throttled.update(viewport(T0));
    b.tick();
    b.throttled.update(viewport(T0 + 100));
    expect(b.throttled.flush()).toBe(true);
    expect(b.update).toHaveBeenCalledTimes(2);
    b.tick(500);
    expect(b.update).toHaveBeenCalledTimes(2);
  });

  it('E2: wired under attachCesiumClock, 60 preRenders/s cost ≤ 11 selection passes', () => {
    const { update, throttled, tick } = harness();
    const preRender = new Set<() => void>();
    const scene = {
      preRender: {
        addEventListener: (cb: () => void) => {
          preRender.add(cb);
          return () => preRender.delete(cb);
        },
      },
      requestRender: () => {},
    } as never;
    let time = T0;
    const clock: PlayheadClock = {
      getTime: () => time,
      on: (() => () => {}) as never,
    };
    const detach = attachCesiumClock(scene, clock, (t) =>
      throttled.update(viewport(t), true),
    );
    for (let i = 0; i < 60; i++) {
      time = T0 + i * 1000;
      preRender.forEach((cb) => cb());
      tick();
    }
    detach();
    expect(update.mock.calls.length).toBeLessThanOrEqual(11);
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(9);
  });
});
