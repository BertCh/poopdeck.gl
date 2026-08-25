/**
 * A 10 Hz view of the shared TimeController's 60 Hz `tick` for React STATE.
 *
 * The controller must tick every frame (the layers read it per draw), but a
 * `setState` per tick re-renders the owning tree and rebuilds its deck
 * `layers` array 60×/s. Measured on /drive (av-synthetic, real GPU): the ego
 * overlay's per-tick `setEgoTime` was the dominant commit source — 119
 * commits/s × ~440 components ≈ 52k component renders/s; at 10 Hz it is 18.8
 * commits/s. Frame rate did not move (display-capped at 120), so this is
 * reclaimed main-thread headroom for slower machines, not an fps win. Same
 * 10 Hz rule `usePlayback` applies to its UI clock, for the same reason.
 *
 * A pause flushes the exact stop time so a throttled consumer does not freeze
 * up to one interval short of where the layers stopped.
 */
import type { TimeController } from '@poopdeck.gl/playback';

/** One publish per this many wall-ms while playing (10 Hz, as `usePlayback`). */
export const UI_TICK_INTERVAL_MS = 100;

type TickSource = Pick<TimeController, 'on' | 'getTime'>;

export function subscribeThrottledTick(
  controller: TickSource,
  publish: (time: number) => void,
  intervalMs: number = UI_TICK_INTERVAL_MS,
  now: () => number = () => performance.now(),
): () => void {
  // Negative so the first tick after subscribing always publishes.
  let last = -Infinity;
  const offTick = controller.on('tick', (t: number) => {
    const w = now();
    if (w - last < intervalMs) return;
    last = w;
    publish(t);
  });
  const offPlay = controller.on('playState', (playing: boolean) => {
    if (playing) return;
    last = now();
    publish(controller.getTime());
  });
  return () => {
    offTick();
    offPlay();
  };
}
