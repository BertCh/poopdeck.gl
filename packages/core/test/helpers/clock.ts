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

/**
 * The REAL `Date.now`, captured at module load — before any spy exists.
 * `installClock()` is called repeatedly (some tests re-install it per loop
 * iteration), and Vitest 4 hands back the SAME spy when a method is already
 * spied. Binding `Date.now` inside `installClock()` would therefore bind the
 * spy itself, and the fresh implementation would call the very spy it just
 * replaced — `RangeError: Maximum call stack size exceeded`. Vitest 1 wrapped
 * each call in a new spy, so the chain stayed finite and this went unnoticed.
 */
const realNow: () => number = Date.now.bind(Date);

/** Shift `Date.now()` forward by `ms` (cumulative). */
export function advanceClock(ms: number): void {
  clockOffset += ms;
}

/** Spy `Date.now()` to add the (reset-to-zero) cumulative offset. */
export function installClock(): void {
  clockOffset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
}
