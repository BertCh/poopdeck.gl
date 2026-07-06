/**
 * Shared fake wall-clock for the grace-eviction tests: shift `Date.now()`
 * forward by a cumulative offset WITHOUT faking timers (so real setTimeout /
 * microtasks still run). `installClock()` spies `Date.now`; `advanceClock(ms)`
 * moves the offset. Call `vi.restoreAllMocks()` (typically in `afterEach`) to
 * remove the spy. `clockOffset` is module-scoped, but Vitest isolates each test
 * file's module graph, so two files never share the offset.
 */

import { vi } from 'vitest';

let clockOffset = 0;

/** Shift `Date.now()` forward by `ms` (cumulative). */
export function advanceClock(ms: number): void {
  clockOffset += ms;
}

/** Spy `Date.now()` to add the (reset-to-zero) cumulative offset. */
export function installClock(): void {
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
}
