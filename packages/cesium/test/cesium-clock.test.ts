// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from 'vitest';
import { attachCesiumClock, type PlayheadClock } from '../src/cesium-clock';

/** A fake Cesium Scene exposing just `preRender.addEventListener` + `requestRender`. */
function fakeScene() {
  const preRenderListeners = new Set<() => void>();
  let renderRequests = 0;
  const scene = {
    preRender: {
      addEventListener: (cb: () => void) => {
        preRenderListeners.add(cb);
        return () => preRenderListeners.delete(cb);
      },
    },
    requestRender: () => {
      renderRequests += 1;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return {
    scene,
    firePreRender: () => preRenderListeners.forEach((cb) => cb()),
    preRenderCount: () => preRenderListeners.size,
    renderRequests: () => renderRequests,
  };
}

/** A fake PlayheadClock with fireable tick/playState and a settable time. */
function fakeClock() {
  const tick = new Set<(t: number) => void>();
  const playState = new Set<(p: boolean, s: number) => void>();
  let time = 1000;
  const clock: PlayheadClock & {
    setTime: (t: number) => void;
    fireTick: () => void;
    firePlayState: () => void;
    tickCount: () => number;
    playStateCount: () => number;
  } = {
    getTime: () => time,
    on: ((event: 'tick' | 'playState', cb: (...args: never[]) => void) => {
      const set = event === 'tick' ? tick : playState;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (set as Set<any>).add(cb);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return () => (set as Set<any>).delete(cb);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    setTime: (t: number) => {
      time = t;
    },
    fireTick: () => tick.forEach((cb) => cb(time)),
    firePlayState: () => playState.forEach((cb) => cb(true, 1)),
    tickCount: () => tick.size,
    playStateCount: () => playState.size,
  };
  return clock;
}

describe('attachCesiumClock', () => {
  it('applies clock.getTime() on every preRender', () => {
    const { scene, firePreRender } = fakeScene();
    const clock = fakeClock();
    const apply = vi.fn();

    attachCesiumClock(scene, clock, apply);
    clock.setTime(2000);
    firePreRender();
    firePreRender();

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(2000);
  });

  it('does NOT subscribe tick/playState (no requestRender) by default', () => {
    const { scene, renderRequests } = fakeScene();
    const clock = fakeClock();

    attachCesiumClock(scene, clock, () => {});

    expect(clock.tickCount()).toBe(0);
    expect(clock.playStateCount()).toBe(0);
    clock.fireTick();
    expect(renderRequests()).toBe(0);
  });

  it('pumps requestRender from tick + playState when requestRender:true', () => {
    const { scene, renderRequests } = fakeScene();
    const clock = fakeClock();

    attachCesiumClock(scene, clock, () => {}, { requestRender: true });
    clock.fireTick();
    clock.firePlayState();

    expect(renderRequests()).toBe(2);
  });

  it('disposer removes preRender + tick + playState so nothing fires post-dispose', () => {
    const { scene, firePreRender, preRenderCount, renderRequests } = fakeScene();
    const clock = fakeClock();
    const apply = vi.fn();

    const dispose = attachCesiumClock(scene, clock, apply, { requestRender: true });
    expect(preRenderCount()).toBe(1);
    expect(clock.tickCount()).toBe(1);
    expect(clock.playStateCount()).toBe(1);

    dispose();
    expect(preRenderCount()).toBe(0);
    expect(clock.tickCount()).toBe(0);
    expect(clock.playStateCount()).toBe(0);

    firePreRender();
    clock.fireTick();
    clock.firePlayState();
    expect(apply).not.toHaveBeenCalled();
    expect(renderRequests()).toBe(0);
  });
});
