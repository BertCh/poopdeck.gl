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

  it('re-weights the BYTE quantum, not the slot count (M6 / BH-1)', async () => {
    // The weight a governor writes now buys BYTES: a source's per-round quantum
    // is `weight × byteQuantum`. This is what makes BH-3's β-aware shedding
    // mean anything — a laggard behind because its tiles are 10× heavier gets
    // 10× the bytes, not 10× the slots it cannot fill.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const work: Held[] = [];
    const enqueue = (sourceId: string, costBytes: number): void => {
      const h = held(`${sourceId}${work.length}`);
      work.push(h);
      void s
        .schedule({
          sourceId,
          costBytes,
          getPriority: () => 0,
          execute: h.execute,
        })
        .catch(() => {});
    };
    for (let i = 0; i < 200; i++) enqueue('a', 100);
    for (let i = 0; i < 200; i++) enqueue('b', 100);

    await drain(work, 40);
    const even = s.getStats().dispatchedBytesBySource;
    expect(even.a / even.b).toBeGreaterThan(0.8);
    expect(even.a / even.b).toBeLessThan(1.25);

    // Triple 'a''s weight mid-flight: its quantum becomes 3000 B/round while
    // 'b' stays at 1000, so 'a' should draw ~3× the bytes from here on.
    const before = { ...even };
    s.setSourceWeight('a', 3);
    await drain(work, 80);
    const after = s.getStats().dispatchedBytesBySource;
    const deltaA = after.a - before.a;
    const deltaB = after.b - before.b;
    expect(deltaA / deltaB).toBeGreaterThan(2);
    expect(deltaA / deltaB).toBeLessThan(4);
    s.clear();
  });

  it('shedding a leader to 0.25 under byteQuantum:null reproduces slot DRR (M6 / BH-1 rollback)', async () => {
    // §11.3's fairness controller sheds a leader to `0.25 × base` — so the
    // scheduler's SUB-1 WEIGHT path is exactly what the multi-source rollback
    // has to reproduce, and `setSourceWeight` is how it gets there. Under the
    // pre-BH-1 slot scheme a weight-0.25 source can never clear the flat
    // `deficit ≥ 1` admission gate (its deficit is clamped to 0.25 at each
    // crediting), so a shed leader yields COMPLETELY to the laggard until the
    // laggard drains. Reading the gate as `min(cost, weight × quantum)` here
    // would relax it to 0.25 and let the shed leader keep taking turns.
    //
    // The expectation is the pre-BH-1 implementation's recorded dispatch order.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: null });
    const work: Held[] = [];
    const enqueue = (sourceId: string, priority: number, label: string) => {
      const h = held(label);
      work.push(h);
      void s
        .schedule({
          sourceId,
          weight: 1,
          // Declared costs are ignored under the rollback; supply skewed ones
          // so the pin fails if they ever leak into the decision.
          costBytes: sourceId === 'leader' ? 64 : 900_000,
          getPriority: () => priority,
          execute: h.execute,
        })
        .catch(() => {});
    };
    for (let i = 0; i < 8; i++) {
      enqueue('leader', 0, `L${i}`);
      enqueue('lag', 1, `G${i}`);
    }

    // Equal weights: the more-urgent 'leader' and 'lag' alternate.
    const before = await drain(work, 4);
    expect(before).toEqual(['L0', 'G0', 'L1', 'G1']);

    // Shed the leader to §11.3's floor while both still hold queued work.
    s.setSourceWeight('leader', 0.25);

    const after = await drain(work, 12);
    expect(after).toEqual([
      'L2', // already admitted under the old weight — never clawed back
      'G2',
      'G3',
      'G4',
      'G5',
      'G6',
      'G7',
      'L3',
      'L4',
      'L5',
      'L6',
      'L7',
    ]);
    expect(s.getStats().queued).toBe(0);

    // Rollback currency is slots: 1 per dispatch, skewed costBytes ignored.
    expect(s.getStats().dispatchedBytesBySource).toEqual({
      leader: 8,
      lag: 8,
    });
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
