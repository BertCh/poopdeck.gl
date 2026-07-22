/**
 * Dynamic per-source re-weighting on the SharedRequestScheduler.
 *
 * `setSourceWeight` deliberately overrides the first-weight-wins pin so a
 * governor re-balancing bandwidth mid-playback (a starved required source vs.
 * a leader with runway to spare) takes effect for work ALREADY QUEUED — no
 * waiting for the source's queue to drain. Deficits are untouched; the new
 * weight applies from the next DRR crediting round.
 *
 * All executors are controllable deferreds — no real timers, no network
 * (same conventions as the request-scheduler suite).
 */

import { describe, it, expect } from 'vitest';
import { SharedRequestScheduler } from '../src/request-scheduler';
import { flush } from './helpers/fixtures';

/** A held unit of work whose dispatch is observable and manually settled. */
interface Held {
  label: string;
  execute: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  started: () => boolean;
}

function held(label: string): Held {
  let resolveFn!: () => void;
  let didStart = false;
  const inner = new Promise<void>((res) => {
    resolveFn = res;
  });
  return {
    label,
    execute: () => {
      didStart = true;
      return inner;
    },
    resolve: () => resolveFn(),
    started: () => didStart,
  };
}

/**
 * Enqueue `n` held requests per source on a maxRequests=1 scheduler. Source
 * 'b' gets the more urgent priority (0 vs 1) so within a DRR round the pick
 * order is deterministic: b's single credit dispatches first, then a's.
 */
function seed(s: SharedRequestScheduler, n: number): Held[] {
  const work: Held[] = [];
  for (let i = 0; i < n; i++) {
    for (const [sourceId, priority] of [
      ['a', 1],
      ['b', 0],
    ] as const) {
      const h = held(`${sourceId}${i}`);
      work.push(h);
      void s
        .schedule({
          sourceId,
          weight: 1,
          getPriority: () => priority,
          execute: h.execute,
        })
        .catch(() => {}); // settled by resolve(); observe just in case
    }
  }
  return work;
}

/** Drive `count` dispatches, recording their labels in order. */
async function drain(work: Held[], count: number): Promise<string[]> {
  const order: string[] = [];
  for (let i = 0; i < count; i++) {
    await flush();
    const running = work.find(
      (h) => h.started() && !(h as unknown as { settled?: boolean }).settled,
    );
    expect(running).toBeDefined();
    order.push(running!.label);
    (running as unknown as { settled: boolean }).settled = true;
    running!.resolve();
  }
  await flush();
  return order;
}

describe('SharedRequestScheduler.setSourceWeight', () => {
  it('shifts DRR shares immediately for queued work, without a drain', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const work = seed(s, 8);

    // Equal weights: after the seed-time dispatch (a0 ran the moment the
    // first schedule() pumped an empty scheduler), each round credits both
    // sources once, so dispatches alternate (b first within every full
    // round — it is the more urgent).
    const before = await drain(work, 4);
    expect(before).toEqual(['a0', 'b0', 'b1', 'a1']);

    // Re-weight 'a' to 3 while BOTH sources still hold queued work. The
    // request already running (b2, picked under the old weights) and the
    // already-earned deficit (one 'a' credit) are honored; every crediting
    // round AFTER that is 1×b + 3×a.
    s.setSourceWeight('a', 3);

    const after = await drain(work, 8);
    expect(after).toEqual(['b2', 'a2', 'b3', 'a3', 'a4', 'a5', 'b4', 'a6']);

    // Drain the rest so nothing leaks into other tests.
    await drain(work, 4);
    expect(s.getStats().queued).toBe(0);
  });

  it('normalizes invalid weights to 1 and ignores unknown sources', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const work = seed(s, 3);

    // Unknown source: no bookkeeping entry is created (no tracked-source leak).
    s.setSourceWeight('ghost', 5);
    expect(s.getStats().trackedSources).toBeLessThanOrEqual(2);

    // Non-finite / non-positive weights fall back to 1 → shares stay equal.
    s.setSourceWeight('a', Number.NaN);
    s.setSourceWeight('a', -3);
    const order = await drain(work, 6);
    expect(order).toEqual(['a0', 'b0', 'b1', 'a1', 'b2', 'a2']);
  });
});
