/**
 * Tests for SharedRequestScheduler (multi-source coordination, Phase 2; see
 * docs/roadmap/playback-and-loading.md §4–5).
 *
 * The scheduler allocates a fixed global concurrency budget across N
 * heterogeneous sources by dynamic priority (lower value = higher priority,
 * Cesium semantics; priority < 0 cancels — loaders.gl RequestScheduler) and
 * Deficit-Round-Robin weighted-fair share (§2.6) so no heavy source starves a
 * light one and an idle source's share is reclaimed (work-conserving).
 *
 * All executors are controllable deferreds — no real timers, no network.
 */

import { describe, it, expect } from 'vitest';
import {
  SCHEDULER_PREFETCH_TIER_BASE,
  SharedRequestScheduler,
  isCancellationError,
} from '../src/request-scheduler';
import { flush } from './helpers/fixtures';

/** A manually-settled promise plus a record of whether/when it was invoked. */
interface Controllable<T> {
  /** The `execute` fn to hand to `schedule`. */
  execute: (signal: AbortSignal) => Promise<T>;
  /** Resolve the underlying work. No-op if already settled. */
  resolve: (value: T) => void;
  /** Reject the underlying work. No-op if already settled. */
  reject: (reason?: unknown) => void;
  /** True once `execute` has actually been called (i.e. it was dispatched). */
  started: () => boolean;
  /** The AbortSignal handed to `execute`, once started. */
  signal: () => AbortSignal | undefined;
}

function controllable<T = void>(): Controllable<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason?: unknown) => void;
  let didStart = false;
  let sig: AbortSignal | undefined;
  const inner = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return {
    execute: (signal: AbortSignal) => {
      didStart = true;
      sig = signal;
      return inner;
    },
    resolve: (value: T) => resolveFn(value),
    reject: (reason?: unknown) => rejectFn(reason),
    started: () => didStart,
    signal: () => sig,
  };
}

/**
 * Attach a rejection observer to `p` SYNCHRONOUSLY so it never registers as an
 * unhandled rejection (the scheduler may reject a queued request during a later
 * `flush()`, before the test gets a chance to `await expect(p).rejects`). Returns
 * a getter for the captured rejection reason; throws if `p` resolved instead.
 */
function captureRejection(p: Promise<unknown>): () => Promise<unknown> {
  let settled: { ok: boolean; value: unknown } | undefined;
  const observed = p.then(
    (v) => {
      settled = { ok: true, value: v };
    },
    (e) => {
      settled = { ok: false, value: e };
    },
  );
  return async () => {
    await observed;
    if (!settled || settled.ok) {
      throw new Error('expected promise to reject, but it resolved');
    }
    return settled.value;
  };
}

describe('SharedRequestScheduler', () => {
  it('runs immediately when slots are free and resolves with the value', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 4 });
    const c = controllable<number>();
    const p = s.schedule({
      sourceId: 'a',
      getPriority: () => 0,
      execute: c.execute,
    });
    await flush();
    expect(c.started()).toBe(true);
    expect(s.getStats().active).toBe(1);
    c.resolve(42);
    await expect(p).resolves.toBe(42);
    expect(s.getStats().active).toBe(0);
  });

  it('never runs more than maxRequests concurrently; queues the rest', async () => {
    const max = 3;
    const s = new SharedRequestScheduler({ maxRequests: max });
    const work = Array.from({ length: 10 }, () => controllable());
    work.forEach((c, i) =>
      s.schedule({
        sourceId: `src${i}`,
        getPriority: () => i,
        execute: c.execute,
      }),
    );
    await flush();

    // Only `max` started; the rest are queued.
    expect(work.filter((c) => c.started()).length).toBe(max);
    const stats = s.getStats();
    expect(stats.active).toBe(max);
    expect(stats.queued).toBe(10 - max);
    expect(stats.maxRequests).toBe(max);

    // Complete the running ones one at a time; each frees exactly one slot.
    for (let done = 0; done < 10; done++) {
      const running = work.filter((c) => c.started());
      // The cap is never exceeded at any point.
      expect(s.getStats().active).toBeLessThanOrEqual(max);
      const next = running.find((c) => !(c as any)._done);
      (next as any)._done = true;
      next!.resolve(undefined);
      await flush();
    }
    expect(s.getStats().active).toBe(0);
    expect(s.getStats().queued).toBe(0);
  });

  it('defaults to a sane global budget (~24)', () => {
    const s = new SharedRequestScheduler();
    expect(s.getStats().maxRequests).toBe(24);
  });

  it('dispatches queued requests in PRIORITY order (lowest value first)', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const order: string[] = [];
    const cs: Record<string, Controllable> = {};
    // Enqueue out of priority order; one slot forces serial dispatch.
    const specs: { id: string; pri: number }[] = [
      { id: 'mid', pri: 5 },
      { id: 'low', pri: 10 },
      { id: 'high', pri: 1 },
    ];
    for (const { id, pri } of specs) {
      const c = controllable();
      cs[id] = c;
      s.schedule({
        sourceId: id,
        getPriority: () => pri,
        execute: (sig) => {
          order.push(id);
          return c.execute(sig);
        },
      });
    }
    await flush();
    // First slot taken by whichever enqueued first ('mid'); resolve it to free.
    cs['mid'].resolve(undefined);
    await flush();
    // Now among queued {low:10, high:1} the lowest value (high) runs next.
    cs['high'].resolve(undefined);
    await flush();
    cs['low'].resolve(undefined);
    await flush();
    expect(order).toEqual(['mid', 'high', 'low']);
  });

  it('re-evaluates priority at DISPATCH time, not enqueue time', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const order: string[] = [];
    const blocker = controllable();
    s.schedule({
      sourceId: 'blocker',
      getPriority: () => 0,
      execute: blocker.execute,
    });
    await flush();

    // Two queued requests; their priorities will CHANGE before a slot frees.
    let aPri = 100;
    let bPri = 1;
    const a = controllable();
    const b = controllable();
    s.schedule({
      sourceId: 'a',
      getPriority: () => aPri,
      execute: (sig) => {
        order.push('a');
        return a.execute(sig);
      },
    });
    s.schedule({
      sourceId: 'b',
      getPriority: () => bPri,
      execute: (sig) => {
        order.push('b');
        return b.execute(sig);
      },
    });
    await flush();
    expect(order).toEqual([]); // neither has run, slot held by blocker

    // Flip priorities: now 'a' is most urgent. If priority were captured at
    // enqueue time, 'b' would run first. It must run 'a' first.
    aPri = 1;
    bPri = 100;
    blocker.resolve(undefined);
    await flush();
    expect(order).toEqual(['a']);
    a.resolve(undefined);
    await flush();
    expect(order).toEqual(['a', 'b']);
  });

  it('CANCELS a queued request whose getPriority() returns < 0', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const blocker = controllable();
    s.schedule({
      sourceId: 'blk',
      getPriority: () => 0,
      execute: blocker.execute,
    });
    await flush();

    const doomed = controllable();
    const p = s.schedule({
      sourceId: 'doomed',
      getPriority: () => -1, // cancel at next dispatch
      execute: doomed.execute,
    });
    const rejected = captureRejection(p);
    await flush();
    // Freeing the slot triggers selection, which cancels the negative one.
    blocker.resolve(undefined);
    await flush();

    expect(doomed.started()).toBe(false); // never ran ⇒ freed nothing
    expect(isCancellationError(await rejected())).toBe(true);
    expect(s.getStats().queued).toBe(0);
    expect(s.getStats().active).toBe(0);
  });

  it('does NOT deadlock when every queued request cancels', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 2 });
    const ps = Array.from({ length: 5 }, (_, i) =>
      s.schedule({
        sourceId: `c${i}`,
        getPriority: () => -1,
        execute: controllable().execute,
      }),
    );
    const settled = Promise.allSettled(ps);
    await flush();
    // All cancelled, none running, queue drained — clean idle.
    const results = await settled;
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(s.getStats().active).toBe(0);
    expect(s.getStats().queued).toBe(0);
  });

  it('frees the slot on SUCCESS', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const a = controllable<string>();
    const pa = s.schedule({
      sourceId: 'a',
      getPriority: () => 0,
      execute: a.execute,
    });
    await flush();
    expect(s.getStats().active).toBe(1);

    const b = controllable<string>();
    const pb = s.schedule({
      sourceId: 'b',
      getPriority: () => 0,
      execute: b.execute,
    });
    await flush();
    expect(b.started()).toBe(false); // queued behind the running one

    a.resolve('done-a');
    await expect(pa).resolves.toBe('done-a');
    await flush();
    expect(b.started()).toBe(true); // slot reused
    b.resolve('done-b');
    await expect(pb).resolves.toBe('done-b');
    expect(s.getStats().active).toBe(0);
  });

  it('frees the slot on FAILURE (rejection)', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const a = controllable();
    const pa = s.schedule({
      sourceId: 'a',
      getPriority: () => 0,
      execute: a.execute,
    });
    await flush();

    const b = controllable();
    const pb = s.schedule({
      sourceId: 'b',
      getPriority: () => 0,
      execute: b.execute,
    });
    await flush();
    expect(b.started()).toBe(false);

    const boom = new Error('network blew up');
    a.reject(boom);
    await expect(pa).rejects.toBe(boom);
    await flush();
    // A failed request must still free its slot for the next one.
    expect(b.started()).toBe(true);
    b.resolve(undefined);
    await pb;
    expect(s.getStats().active).toBe(0);
  });

  it('frees the slot when execute throws synchronously', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const boom = new Error('sync throw');
    const pa = s.schedule({
      sourceId: 'a',
      getPriority: () => 0,
      execute: () => {
        throw boom;
      },
    });
    await expect(pa).rejects.toBe(boom);
    await flush();
    const b = controllable();
    const pb = s.schedule({
      sourceId: 'b',
      getPriority: () => 0,
      execute: b.execute,
    });
    await flush();
    expect(b.started()).toBe(true); // slot was freed despite the sync throw
    b.resolve(undefined);
    await pb;
  });

  it('passes an AbortSignal to execute that fires on abort()', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const c = controllable();
    const handle = s.scheduleRequest({
      sourceId: 'a',
      getPriority: () => 0,
      execute: c.execute,
    });
    await flush();
    const sig = c.signal();
    expect(sig).toBeDefined();
    expect(sig!.aborted).toBe(false);

    const rejected = captureRejection(handle.promise);
    handle.abort('user navigated away');
    expect(sig!.aborted).toBe(true);
    // The executor can observe the abort and reject; the slot frees on settle.
    c.reject(sig!.reason);
    expect(isCancellationError(await rejected())).toBe(true);
    await flush();
    expect(s.getStats().active).toBe(0);
  });

  it('abort() on a QUEUED request rejects it without ever running', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const blocker = controllable();
    s.schedule({
      sourceId: 'blk',
      getPriority: () => 0,
      execute: blocker.execute,
    });
    await flush();

    const c = controllable();
    const handle = s.scheduleRequest({
      sourceId: 'q',
      getPriority: () => 0,
      execute: c.execute,
    });
    await flush();
    expect(c.started()).toBe(false);

    const rejected = captureRejection(handle.promise);
    handle.abort();
    expect(isCancellationError(await rejected())).toBe(true);
    expect(c.started()).toBe(false);
    expect(s.getStats().queued).toBe(0);

    // The slot was never taken by the queued one; the blocker still holds it.
    expect(s.getStats().active).toBe(1);
    blocker.resolve(undefined);
    await flush();
  });

  it('abortSource() cancels all queued + running requests for a source', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 2 });
    const running = [controllable(), controllable()];
    const r0 = s.schedule({
      sourceId: 'x',
      getPriority: () => 0,
      execute: running[0].execute,
    });
    const r1 = s.schedule({
      sourceId: 'x',
      getPriority: () => 0,
      execute: running[1].execute,
    });
    const queued = controllable();
    const rq = s.schedule({
      sourceId: 'x',
      getPriority: () => 0,
      execute: queued.execute,
    });
    // A different source must be untouched.
    const other = controllable();
    const ro = s.schedule({
      sourceId: 'y',
      getPriority: () => 0,
      execute: other.execute,
    });
    await flush();

    const xr0 = captureRejection(r0);
    const xr1 = captureRejection(r1);
    const xrq = captureRejection(rq);
    // Both 'x' slots run first (DRR, weight 1 each, lower seq wins the ties).
    expect(running[0].started()).toBe(true);
    expect(running[1].started()).toBe(true);

    s.abortSource('x');
    // Running ones get their signals fired; reject to drain their slots.
    running.forEach((c) => {
      if (c.started()) c.reject(c.signal()!.reason);
    });
    await flush();

    expect(isCancellationError(await xr0())).toBe(true);
    expect(isCancellationError(await xr1())).toBe(true);
    expect(isCancellationError(await xrq())).toBe(true);
    expect(queued.started()).toBe(false);
    expect(s.getStats().inFlightBySource['x']).toBeUndefined();

    other.resolve(undefined);
    await expect(ro).resolves.toBeUndefined();
  });

  it('reports per-source in-flight and queued counts in stats', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 3 });
    const a1 = controllable();
    const a2 = controllable();
    const b1 = controllable();
    const aQ = controllable();
    s.schedule({ sourceId: 'a', getPriority: () => 0, execute: a1.execute });
    s.schedule({ sourceId: 'a', getPriority: () => 0, execute: a2.execute });
    s.schedule({ sourceId: 'b', getPriority: () => 0, execute: b1.execute });
    s.schedule({ sourceId: 'a', getPriority: () => 0, execute: aQ.execute });
    await flush();

    const stats = s.getStats();
    expect(stats.active).toBe(3);
    expect(stats.queued).toBe(1);
    // a has 2 running (cap leaves 1 free taken by b), 1 queued.
    expect(stats.inFlightBySource['a']).toBe(2);
    expect(stats.inFlightBySource['b']).toBe(1);
    expect(stats.queuedBySource['a']).toBe(1);
    expect(stats.queuedBySource['b']).toBeUndefined();

    a1.resolve(undefined);
    a2.resolve(undefined);
    b1.resolve(undefined);
    aQ.resolve(undefined);
    await flush();
  });

  // ─── Deficit Round Robin fairness ───────────────────────────────────────────

  it('DRR: a heavy source flooding requests cannot starve a light source', async () => {
    // 1 slot to make scheduling fully serial and deterministic. Equal weights
    // (default 1) ⇒ the two sources should alternate over time, NOT let the
    // flooder ('heavy') monopolize while 'light' waits forever.
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const order: string[] = [];
    const ctrls: Controllable[] = [];

    const enqueue = (sourceId: string) => {
      const c = controllable();
      ctrls.push(c);
      s.schedule({
        sourceId,
        getPriority: () => 0, // equal priority — fairness alone decides
        execute: (sig) => {
          order.push(sourceId);
          return c.execute(sig);
        },
      });
    };

    // Heavy floods 8; light enqueues just 2. All same priority.
    for (let i = 0; i < 8; i++) enqueue('heavy');
    enqueue('light');
    enqueue('light');
    await flush();

    // Drain serially: resolve whichever is running, let the next dispatch.
    let guard = 0;
    while (s.getStats().active + s.getStats().queued > 0 && guard++ < 50) {
      const running = ctrls.find((c) => c.started() && !(c as any)._done);
      if (!running) break;
      (running as any)._done = true;
      running.resolve(undefined);
      await flush();
    }

    // 'light' must not be pushed to the very end. With DRR + equal weight, the
    // two light requests should be interleaved early, well before all 8 heavy.
    const firstLight = order.indexOf('light');
    const lastLight = order.lastIndexOf('light');
    expect(firstLight).toBeGreaterThanOrEqual(0);
    // The light source got a turn within the first few dispatches (not starved
    // behind all 8 heavy). With weight 1 each and round-robin crediting, light
    // is serviced by roughly its 2nd available round.
    expect(firstLight).toBeLessThanOrEqual(2);
    expect(lastLight).toBeLessThan(order.length - 1);
    expect(order.filter((x) => x === 'light').length).toBe(2);
    expect(order.filter((x) => x === 'heavy').length).toBe(8);
  });

  it('DRR: higher weight earns proportionally more slots over time', async () => {
    // weight 3 vs 1 ⇒ over many serial dispatches the heavy-weight source runs
    // ~3× as often as the contended low-weight one (when both always have work).
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const order: string[] = [];
    const ctrls: Controllable[] = [];

    const enqueueMany = (sourceId: string, weight: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const c = controllable();
        ctrls.push(c);
        s.schedule({
          sourceId,
          weight,
          getPriority: () => 0,
          execute: (sig) => {
            order.push(sourceId);
            return c.execute(sig);
          },
        });
      }
    };

    // Both sources have plenty of backlog so both are "always active".
    enqueueMany('big', 3, 12);
    enqueueMany('small', 1, 12);
    await flush();

    let guard = 0;
    while (s.getStats().active + s.getStats().queued > 0 && guard++ < 60) {
      const running = ctrls.find((c) => c.started() && !(c as any)._done);
      if (!running) break;
      (running as any)._done = true;
      running.resolve(undefined);
      await flush();
    }

    // Over the first 8 dispatches (while both still contend) big ran clearly
    // more than small, reflecting the 3:1 weight.
    const firstEight = order.slice(0, 8);
    const bigCount = firstEight.filter((x) => x === 'big').length;
    const smallCount = firstEight.filter((x) => x === 'small').length;
    expect(bigCount).toBeGreaterThan(smallCount);
    expect(bigCount).toBeGreaterThanOrEqual(5); // ~3:1 ⇒ ~6 of 8
  });

  it('DRR: the lighter source is NOT starved by a heavier one (3:1 weights)', async () => {
    // Regression for the unbounded-deficit starvation bug: with weight 3 vs 1
    // and both always contending, the old code credited every active source its
    // full quantum on EVERY dispatch (not once per round) and broke priority
    // ties by "larger deficit first", so 'big''s deficit diverged and it
    // consumed 100% of slots until its queue drained — 'small' got 0 of the
    // first 12. True DRR gives 'small' roughly its fair share (1/4) over time.
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const order: string[] = [];
    const ctrls: Controllable[] = [];

    const enqueueMany = (sourceId: string, weight: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const c = controllable();
        ctrls.push(c);
        s.schedule({
          sourceId,
          weight,
          getPriority: () => 0, // equal priority — fairness alone decides
          execute: (sig) => {
            order.push(sourceId);
            return c.execute(sig);
          },
        });
      }
    };

    // Both sources have deep backlog so both are "always active" throughout.
    enqueueMany('big', 3, 12);
    enqueueMany('small', 1, 12);
    await flush();

    let guard = 0;
    while (s.getStats().active + s.getStats().queued > 0 && guard++ < 80) {
      const running = ctrls.find((c) => c.started() && !(c as any)._done);
      if (!running) break;
      (running as any)._done = true;
      running.resolve(undefined);
      await flush();
    }

    // The lighter source must get serviced WHILE the heavier one still has
    // backlog — not parked at the very end. At 3:1, 'small''s fair share over
    // any window of 4 dispatches is ~1, so over the first 12 it should receive
    // at least ~3 (assert ≥ 2 to leave slack), and crucially MORE THAN ZERO.
    const firstTwelve = order.slice(0, 12);
    const smallInFirst12 = firstTwelve.filter((x) => x === 'small').length;
    expect(smallInFirst12).toBeGreaterThanOrEqual(2);
    // And 'big' must not have monopolized the entire window.
    expect(firstTwelve.filter((x) => x === 'big').length).toBeLessThan(12);
    // Everything ran exactly once; no slot lost, nothing starved permanently.
    expect(order.filter((x) => x === 'big').length).toBe(12);
    expect(order.filter((x) => x === 'small').length).toBe(12);
  });

  it('is WORK-CONSERVING: an idle source leaves no slot wasted', async () => {
    // With 2 slots and only one source supplying work, that source uses BOTH
    // slots — the absent source's share is reclaimed.
    const s = new SharedRequestScheduler({ maxRequests: 2 });
    const cs = [controllable(), controllable(), controllable()];
    cs.forEach((c) =>
      s.schedule({
        sourceId: 'only',
        getPriority: () => 0,
        execute: c.execute,
      }),
    );
    await flush();

    // Both slots are busy with the single source — none left idle.
    expect(s.getStats().active).toBe(2);
    expect(s.getStats().inFlightBySource['only']).toBe(2);

    cs[0].resolve(undefined);
    await flush();
    // The freed slot is immediately reused by the same source (3rd request).
    expect(s.getStats().active).toBe(2);
    cs[1].resolve(undefined);
    cs[2].resolve(undefined);
    await flush();
    expect(s.getStats().active).toBe(0);
  });

  it("work-conserving across sources: a light source reclaims a heavy source's share once heavy drains", async () => {
    const s = new SharedRequestScheduler({ maxRequests: 2 });
    const order: string[] = [];
    const ctrls: Controllable[] = [];
    const enq = (id: string) => {
      const c = controllable();
      ctrls.push(c);
      s.schedule({
        sourceId: id,
        getPriority: () => 0,
        execute: (sig) => {
          order.push(id);
          return c.execute(sig);
        },
      });
    };
    // Heavy has lots; light has a couple. Drain everything.
    for (let i = 0; i < 6; i++) enq('heavy');
    enq('light');
    enq('light');
    await flush();

    let guard = 0;
    while (s.getStats().active + s.getStats().queued > 0 && guard++ < 40) {
      const running = ctrls.find((c) => c.started() && !(c as any)._done);
      if (!running) break;
      (running as any)._done = true;
      running.resolve(undefined);
      await flush();
    }
    // Everything eventually ran (no slot permanently lost / no starvation).
    expect(order.filter((x) => x === 'heavy').length).toBe(6);
    expect(order.filter((x) => x === 'light').length).toBe(2);
    expect(order.length).toBe(8);
  });

  it('clear() aborts everything and the scheduler stays usable', async () => {
    // maxRequests 2 ⇒ two of the three dispatch immediately, one queues. We
    // don't assume WHICH two run, so abort all three and drain any that started.
    const s = new SharedRequestScheduler({ maxRequests: 2 });
    const cs = [controllable(), controllable(), controllable()];
    const ps = [
      s.schedule({
        sourceId: 'a',
        getPriority: () => 0,
        execute: cs[0].execute,
      }),
      s.schedule({
        sourceId: 'a',
        getPriority: () => 0,
        execute: cs[1].execute,
      }),
      s.schedule({
        sourceId: 'b',
        getPriority: () => 0,
        execute: cs[2].execute,
      }),
    ];
    await flush();
    expect(s.getStats().active).toBe(2); // budget fully used

    const captured = ps.map((p) => captureRejection(p));
    s.clear();
    // Every started executor got its signal fired; reject to drain its slot.
    cs.forEach((c) => {
      if (c.started()) c.reject(c.signal()!.reason);
    });
    await flush();

    for (const c of captured) expect(isCancellationError(await c())).toBe(true);
    expect(s.getStats().active).toBe(0);
    expect(s.getStats().queued).toBe(0);

    // Still usable after clear.
    const fresh = controllable<number>();
    const pf = s.schedule({
      sourceId: 'c',
      getPriority: () => 0,
      execute: fresh.execute,
    });
    await flush();
    fresh.resolve(7);
    await expect(pf).resolves.toBe(7);
  });

  it('a throwing getPriority() cancels that request without taking down the pump', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const blocker = controllable();
    s.schedule({
      sourceId: 'blk',
      getPriority: () => 0,
      execute: blocker.execute,
    });
    await flush();

    const bad = controllable();
    const pBad = s.schedule({
      sourceId: 'bad',
      getPriority: () => {
        throw new Error('priority kaboom');
      },
      execute: bad.execute,
    });
    const good = controllable();
    const pGood = s.schedule({
      sourceId: 'good',
      getPriority: () => 1,
      execute: good.execute,
    });
    const badRejected = captureRejection(pBad);
    await flush();

    blocker.resolve(undefined);
    await flush();
    expect(((await badRejected()) as Error).message).toContain(
      'priority kaboom',
    );
    expect(bad.started()).toBe(false);
    // The good request still got dispatched after the bad one was dropped.
    expect(good.started()).toBe(true);
    good.resolve(undefined);
    await pGood;
  });

  // ── Wave-1 LOW fix: fair-share bookkeeping must not leak ───────────────────
  // A source whose requests are all QUEUED-then-ABORTED never reached done()
  // (cleanup only ran for dispatched entries), so its weights/deficits/
  // roundCredited entries leaked for the scheduler's lifetime. The fix reclaims
  // them on the queued-abort path (and on clear()) just like done() does.
  describe('Wave-1 LOW fix: no fair-share bookkeeping leak', () => {
    it('reclaims a source whose queued requests are all aborted via the handle', async () => {
      const s = new SharedRequestScheduler({ maxRequests: 1 });
      // Saturate the one slot with a long-running OTHER source so the victims
      // stay queued (never dispatched).
      const blocker = controllable();
      s.schedule({
        sourceId: 'blk',
        getPriority: () => 0,
        execute: blocker.execute,
      });
      await flush();

      // Two queued requests for source 'leak' that never run.
      const v1 = controllable();
      const v2 = controllable();
      const r1 = s.scheduleRequest({
        sourceId: 'leak',
        getPriority: () => 1,
        execute: v1.execute,
      });
      const r2 = s.scheduleRequest({
        sourceId: 'leak',
        getPriority: () => 1,
        execute: v2.execute,
      });
      const j1 = captureRejection(r1.promise);
      const j2 = captureRejection(r2.promise);
      await flush();
      // 'blk' (running) + 'leak' (queued) are both tracked.
      expect(s.getStats().trackedSources).toBe(2);

      // Abort both 'leak' requests while still queued.
      r1.abort();
      r2.abort();
      await j1();
      await j2();
      await flush();

      // 'leak' is fully drained: its bookkeeping is reclaimed (only 'blk' left).
      expect(s.getStats().queuedBySource['leak']).toBeUndefined();
      expect(s.getStats().trackedSources).toBe(1);

      blocker.resolve(undefined);
      await flush();
      // After the blocker finishes too, nothing is tracked.
      expect(s.getStats().trackedSources).toBe(0);
    });

    it('reclaims a source drained via abortSource() while only queued', async () => {
      const s = new SharedRequestScheduler({ maxRequests: 1 });
      const blocker = controllable();
      s.schedule({
        sourceId: 'blk',
        getPriority: () => 0,
        execute: blocker.execute,
      });
      await flush();

      const v1 = controllable();
      const v2 = controllable();
      const p1 = s.schedule({
        sourceId: 'q',
        getPriority: () => 1,
        execute: v1.execute,
      });
      const p2 = s.schedule({
        sourceId: 'q',
        getPriority: () => 1,
        execute: v2.execute,
      });
      const j1 = captureRejection(p1);
      const j2 = captureRejection(p2);
      await flush();
      expect(s.getStats().trackedSources).toBe(2);

      s.abortSource('q');
      await j1();
      await j2();
      await flush();
      expect(s.getStats().trackedSources).toBe(1); // only 'blk' remains

      blocker.resolve(undefined);
      await flush();
      expect(s.getStats().trackedSources).toBe(0);
    });

    it('clear() reclaims weights for drained (queued) sources too', async () => {
      const s = new SharedRequestScheduler({ maxRequests: 1 });
      const blocker = controllable();
      const pBlk = s.schedule({
        sourceId: 'blk',
        getPriority: () => 0,
        execute: blocker.execute,
      });
      await flush();
      const v1 = controllable();
      const p1 = s.schedule({
        sourceId: 'q',
        getPriority: () => 1,
        execute: v1.execute,
      });
      const j1 = captureRejection(p1);
      // The running 'blk' resolves (its execute ignores the abort signal); guard
      // its promise from surfacing as unhandled regardless of outcome.
      pBlk.catch(() => {});
      await flush();
      expect(s.getStats().trackedSources).toBe(2);

      // clear() aborts queued ('q') and running ('blk'); the running one frees
      // its slot when its (aborted) execute settles.
      s.clear();
      await j1();
      // Resolve the blocker so its slot frees (clear fired its signal; our
      // controllable ignores it, so settle it to complete the done() handshake).
      blocker.resolve(undefined);
      await flush();

      // Every source's weight/deficit/round-state is gone — no leak.
      expect(s.getStats().trackedSources).toBe(0);
      expect(s.getStats().active).toBe(0);
      expect(s.getStats().queued).toBe(0);
    });
  });
});

// ─── M6 / BH-1: the DRR currency is BYTES ──────────────────────────────────
//
// The constrained resource on the wire is bytes, not slots. Metering slots gave
// a source whose coalesced range groups are 10× heavier 10× the link at equal
// weight. Only the CURRENCY changes here: the crediting scheme (credit at most
// once per round, clamp to one quantum, new round only when no credited source
// can dispatch, top up so no slot idles) is preserved verbatim — it is a pinned
// register entry, the prior variant being a recorded broken design.

/** One scripted unit of work for the byte-DRR driver. */
interface ByteJob {
  sourceId: string;
  costBytes?: number;
  weight?: number;
  priority?: number;
  label?: string;
}

/**
 * A serial (maxRequests: 1) driver: enqueue scripted work, then drain it one
 * dispatch at a time, recording the dispatch order. No timers, no network.
 */
function byteDriver(s: SharedRequestScheduler) {
  const ctrls: Array<Controllable & { label: string; done?: boolean }> = [];
  const order: string[] = [];
  const enqueue = (job: ByteJob): void => {
    const c = controllable() as Controllable & {
      label: string;
      done?: boolean;
    };
    c.label = job.label ?? job.sourceId;
    ctrls.push(c);
    void s
      .schedule({
        sourceId: job.sourceId,
        weight: job.weight,
        costBytes: job.costBytes,
        getPriority: () => job.priority ?? 0,
        execute: (sig) => {
          order.push(c.label);
          return c.execute(sig);
        },
      })
      .catch(() => {});
  };
  const drain = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await flush();
      const running = ctrls.find((c) => c.started() && !c.done);
      if (!running) break;
      running.done = true;
      running.resolve(undefined);
    }
    await flush();
  };
  const drainAll = async (): Promise<void> => {
    let guard = 0;
    while (
      s.getStats().active + s.getStats().queued > 0 &&
      guard++ < ctrls.length + 10
    ) {
      await drain(1);
    }
  };
  return { enqueue, drain, drainAll, order };
}

describe('SharedRequestScheduler — byte-metered DRR (M6 / BH-1)', () => {
  it('(1) equal weights + 10× byte-skewed groups converge to ~1:1 BYTE share', async () => {
    // 'light' groups are 100 B, 'heavy' groups 1000 B, quantum 1000 B. Per
    // round each source earns 1000 credits, so light runs 10× and heavy once —
    // equal BYTES. Under the old slot DRR they alternated 1:1 in slots, i.e.
    // 1:10 in bytes, which is what the link actually cares about.
    const s = new SharedRequestScheduler({
      maxRequests: 1,
      byteQuantum: 1000,
    });
    const d = byteDriver(s);
    for (let i = 0; i < 60; i++)
      d.enqueue({ sourceId: 'light', costBytes: 100 });
    for (let i = 0; i < 20; i++)
      d.enqueue({ sourceId: 'heavy', costBytes: 1000 });
    await d.drain(22); // two full rounds (11 dispatches each)

    const granted = s.getStats().dispatchedBytesBySource;
    expect(granted.light).toBeGreaterThan(0);
    expect(granted.heavy).toBeGreaterThan(0);
    const ratio = granted.light / granted.heavy;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);

    await d.drainAll();
  });

  it('(1b) the SAME script under the slot-semantics rollback is ~1:10 in bytes', async () => {
    // The counterfactual, so the win in (1) is attributable and the rollback
    // path is proven to still be the old behaviour.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: null });
    const d = byteDriver(s);
    for (let i = 0; i < 60; i++)
      d.enqueue({ sourceId: 'light', costBytes: 100 });
    for (let i = 0; i < 20; i++)
      d.enqueue({ sourceId: 'heavy', costBytes: 1000 });
    await d.drain(22);

    // Under the rollback `costBytes` is ignored entirely (every entry costs one
    // slot), so we count the granted bytes from the dispatch log ourselves.
    const lightSlots = d.order.filter((x) => x === 'light').length;
    const heavySlots = d.order.filter((x) => x === 'heavy').length;
    const byteRatio = (lightSlots * 100) / (heavySlots * 1000);
    expect(byteRatio).toBeLessThan(0.2); // ≈ 0.1 — the D3 gap, verbatim

    await d.drainAll();
  });

  it('(2) PROGRESS GUARANTEE: a group larger than a quantum still dispatches', async () => {
    // min(costBytes, quantum) is the admission threshold precisely so an
    // over-quantum group is admissible once the source is topped up — without
    // it the deficit clamp would make it permanently inadmissible.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const d = byteDriver(s);
    for (let i = 0; i < 3; i++)
      d.enqueue({ sourceId: 'huge', costBytes: 50_000, label: `h${i}` });
    await d.drainAll();
    expect(d.order).toEqual(['h0', 'h1', 'h2']);
  });

  it('(2b) an over-quantum source still makes progress against a small-group rival', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const d = byteDriver(s);
    for (let i = 0; i < 6; i++)
      d.enqueue({ sourceId: 'huge', costBytes: 5000 });
    for (let i = 0; i < 200; i++)
      d.enqueue({ sourceId: 'tiny', costBytes: 100 });
    await d.drain(80);
    const huge = d.order.filter((x) => x === 'huge').length;
    const tiny = d.order.filter((x) => x === 'tiny').length;
    expect(huge).toBeGreaterThanOrEqual(2); // not deadlocked behind its own size
    // …and it pays the arrears back: byte share stays roughly even.
    const ratio = (huge * 5000) / (tiny * 100);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
    await d.drainAll();
  });

  it('(3) REGRESSION PIN: omitting costBytes reproduces slot DRR exactly', async () => {
    // The `byteQuantum: null` scheduler IS the pre-BH-1 arithmetic, so it is the
    // oracle. Every entry declares no cost ⇒ bills one quantum ⇒ a weight-w
    // source gets w dispatches per round, exactly as before.
    const script: ByteJob[] = [];
    for (let i = 0; i < 12; i++) {
      script.push({ sourceId: 'a', weight: 1, priority: 1, label: `a${i}` });
      script.push({ sourceId: 'b', weight: 3, priority: 0, label: `b${i}` });
      script.push({ sourceId: 'c', weight: 1, priority: 2, label: `c${i}` });
    }
    const run = async (
      opts: { byteQuantum?: number | null } = {},
    ): Promise<string[]> => {
      const s = new SharedRequestScheduler({ maxRequests: 1, ...opts });
      const d = byteDriver(s);
      for (const job of script) d.enqueue(job);
      await d.drainAll();
      return d.order;
    };
    const metered = await run(); // default: 512 KiB byte quantum
    const slots = await run({ byteQuantum: null }); // today's arithmetic
    expect(metered).toEqual(slots);
  });

  it('(4) DEFICIT CLAMP: an idle-then-active source banks at most one quantum', async () => {
    // 'busy' works for many rounds while 'late' has nothing queued. When 'late'
    // shows up it must NOT be able to cash in the rounds it slept through: the
    // clamp caps its deficit at one quantum, so its first uninterrupted run is
    // at most quantum / costBytes = 10 dispatches.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const d = byteDriver(s);
    for (let i = 0; i < 200; i++)
      d.enqueue({ sourceId: 'busy', costBytes: 100 });
    await d.drain(40);
    for (let i = 0; i < 40; i++)
      d.enqueue({ sourceId: 'late', costBytes: 100 });
    await d.drain(40);

    const tail = d.order.slice(40);
    const firstLate = tail.indexOf('late');
    expect(firstLate).toBeGreaterThanOrEqual(0);
    let run = 0;
    for (let i = firstLate; i < tail.length && tail[i] === 'late'; i++) run++;
    expect(run).toBeLessThanOrEqual(10); // one quantum's worth, never more
    await d.drainAll();
  });

  it('(5) PROPERTY: weight-normalized BYTE share stays bounded, and beats slot metering', async () => {
    // Deterministic LCG over random weights/sizes — no wall clock, no Math.random.
    //
    // THE PROPERTY. Under contention the byte share each source receives, once
    // normalized by its weight, is equal across sources up to a bound that
    // depends on the QUANTUM and not on the length of the interval. The
    // measured quantity is therefore the RATIO max(gᵢ/wᵢ) / min(gᵢ/wᵢ), which
    // is 1 for perfect weighted fairness.
    //
    // ⚠️ A ratio, not an absolute byte error, is the honest statement. DRR's
    // crediting scheme (a PINNED register entry, reproduced verbatim here)
    // CLAMPS the deficit at one quantum, which discards the intra-round
    // leftover `quantum mod costBytes`. In the slot world that leftover was
    // always 0; in the byte world it makes a source whose group size does not
    // divide its quantum systematically under-served by up to costBytes per
    // round — an O(interval) byte drift but an O(1) SHARE drift. The default
    // 512 KiB quantum keeps costBytes/quantum small for ordinary groups; the
    // deviation is also conservative (it throttles the heavy source, the one
    // that used to be over-served 10×).
    let seed = 20260810;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const QUANTUM = 4096;
    const normalizedRatio = (
      s: SharedRequestScheduler,
      sources: Array<{ id: string; weight: number }>,
    ): number => {
      const g = s.getStats().dispatchedBytesBySource;
      const norm = sources.map((src) => (g[src.id] ?? 0) / src.weight);
      return Math.max(...norm) / Math.min(...norm);
    };

    for (let trial = 0; trial < 4; trial++) {
      const sources = ['s0', 's1', 's2'].map((id) => ({
        id,
        weight: 1 + Math.floor(rand() * 3),
        // Widely skewed group sizes — the whole point of byte metering.
        cost: 1 + Math.floor(rand() * QUANTUM),
      }));
      const script = (s: SharedRequestScheduler) => {
        const d = byteDriver(s);
        // Deep backlogs so every source contends across the whole interval.
        for (let i = 0; i < 300; i++) {
          for (const src of sources) {
            d.enqueue({
              sourceId: src.id,
              weight: src.weight,
              costBytes: src.cost,
            });
          }
        }
        return d;
      };

      const metered = new SharedRequestScheduler({
        maxRequests: 1,
        byteQuantum: QUANTUM,
      });
      const dm = script(metered);
      await dm.drain(60);
      const short = normalizedRatio(metered, sources);
      // Premise: still a contention interval, not work conservation.
      for (const src of sources) {
        expect(metered.getStats().queuedBySource[src.id] ?? 0).toBeGreaterThan(
          0,
        );
      }
      await dm.drain(120); // 3× the interval…
      const long = normalizedRatio(metered, sources);
      // …and the SAME constant bound holds (observed worst ≈ 1.9 across the
      // seeded trials; it tightens as the interval grows).
      expect(short).toBeLessThanOrEqual(2.5);
      expect(long).toBeLessThanOrEqual(2.5);
      metered.clear('trial over');

      // THE COUNTERFACTUAL: slot metering gives every source the same number of
      // DISPATCHES, so its byte share is proportional to its group size — the
      // exact D3 defect. With skewed sizes it is far worse than byte metering.
      const slots = new SharedRequestScheduler({
        maxRequests: 1,
        byteQuantum: null,
      });
      const ds = script(slots);
      await ds.drain(180);
      const bySize =
        Math.max(...sources.map((x) => x.cost)) /
        Math.min(...sources.map((x) => x.cost));
      if (bySize > 3) {
        // Recover granted BYTES from the dispatch log (the rollback scheduler
        // meters slots, so its counter is in slots).
        const grantedBytes = new Map(sources.map((x) => [x.id, 0]));
        for (const label of ds.order) {
          const src = sources.find((x) => x.id === label)!;
          grantedBytes.set(src.id, grantedBytes.get(src.id)! + src.cost);
        }
        const norm = sources.map((x) => grantedBytes.get(x.id)! / x.weight);
        const slotRatio = Math.max(...norm) / Math.min(...norm);
        expect(slotRatio).toBeGreaterThan(long);
      }
      slots.clear('trial over');
    }
  }, 20_000);

  it('(6) GUARD: the per-dispatch-crediting starvation bug stays dead in the byte world', async () => {
    // The recorded broken variant credited every active source on EVERY
    // dispatch, so a heavier source's deficit diverged and it monopolized the
    // budget. Byte metering must not resurrect it: a source with 50× heavier
    // groups must never lock the light one out.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const d = byteDriver(s);
    for (let i = 0; i < 40; i++)
      d.enqueue({ sourceId: 'whale', costBytes: 50_000, weight: 3 });
    for (let i = 0; i < 40; i++)
      d.enqueue({ sourceId: 'minnow', costBytes: 100, weight: 1 });
    await d.drain(40);

    const firstMinnow = d.order.indexOf('minnow');
    expect(firstMinnow).toBeGreaterThanOrEqual(0);
    expect(firstMinnow).toBeLessThanOrEqual(4); // serviced almost immediately
    // And it keeps getting turns throughout, not just once.
    expect(
      d.order.slice(20).filter((x) => x === 'minnow').length,
    ).toBeGreaterThan(0);
    await d.drainAll();
  });

  it('(7) DETERMINISM: two identical scripted runs dispatch identically', async () => {
    const script: ByteJob[] = [
      { sourceId: 'a', costBytes: 900, weight: 2, priority: 3, label: 'a0' },
      { sourceId: 'b', costBytes: 100, weight: 1, priority: 1, label: 'b0' },
      { sourceId: 'a', costBytes: 4000, weight: 2, priority: 1, label: 'a1' },
      { sourceId: 'c', weight: 1, priority: 2, label: 'c0' },
      { sourceId: 'b', costBytes: 100, weight: 1, priority: 0, label: 'b1' },
      { sourceId: 'a', costBytes: 50, weight: 2, priority: 5, label: 'a2' },
      { sourceId: 'c', costBytes: 2500, weight: 1, priority: 1, label: 'c1' },
      { sourceId: 'b', costBytes: 700, weight: 1, priority: 4, label: 'b2' },
    ];
    const run = async (): Promise<string[]> => {
      const s = new SharedRequestScheduler({
        maxRequests: 1,
        byteQuantum: 1000,
      });
      const d = byteDriver(s);
      for (const job of script) d.enqueue(job);
      await d.drainAll();
      return d.order;
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(first).toHaveLength(script.length);
  });

  it('counts granted cost per source and omits sources that never dispatched', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const d = byteDriver(s);
    d.enqueue({ sourceId: 'a', costBytes: 300 });
    d.enqueue({ sourceId: 'a', costBytes: 700 });
    d.enqueue({ sourceId: 'b' }); // no cost ⇒ bills one quantum
    await d.drainAll();
    const granted = s.getStats().dispatchedBytesBySource;
    expect(granted.a).toBe(1000);
    expect(granted.b).toBe(1000);
    expect(granted.zzz).toBeUndefined();
    // It is telemetry, not fair-share bookkeeping: draining reclaims the latter
    // but must not reset the counter.
    expect(s.getStats().trackedSources).toBe(0);
    s.clear();
    expect(s.getStats().dispatchedBytesBySource).toEqual({});
  });

  it('normalizes a bad or missing costBytes to exactly one quantum', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const d = byteDriver(s);
    d.enqueue({ sourceId: 'nan', costBytes: Number.NaN });
    d.enqueue({ sourceId: 'neg', costBytes: -5 });
    d.enqueue({ sourceId: 'zero', costBytes: 0 });
    d.enqueue({ sourceId: 'inf', costBytes: Number.POSITIVE_INFINITY });
    await d.drainAll();
    const granted = s.getStats().dispatchedBytesBySource;
    expect(granted).toEqual({ nan: 1000, neg: 1000, zero: 1000, inf: 1000 });
  });

  it('falls back to the default quantum for a non-finite byteQuantum', async () => {
    const s = new SharedRequestScheduler({
      maxRequests: 1,
      byteQuantum: Number.NaN,
    });
    const d = byteDriver(s);
    d.enqueue({ sourceId: 'a' });
    await d.drainAll();
    expect(s.getStats().dispatchedBytesBySource.a).toBe(512 * 1024);
  });
});

// ─── M6 / BH-1: the `byteQuantum: null` ROLLBACK is exact at every weight ────
//
// BH-1 advertises `byteQuantum: null` as the documented rollback to the
// pre-BH-1 slot scheme. A rollback that is only equivalent for weights ≥ 1 is
// not a rollback: §11.3's multi-source fairness controller sheds leaders to
// `0.25 × base`, so SUB-1 WEIGHTS ARE THE PRODUCTION CASE the moment two
// sources contend.
//
// The arithmetic that makes sub-1 weights special: `creditRound` clamps a
// weight-`w` source's deficit to `w`, so a `w < 1` source can never reach the
// slot scheme's flat `deficit ≥ 1` gate by crediting alone. The incumbent
// therefore routes it exclusively through the TOP-UP path, which fires only
// when no source at all is admissible — i.e. a shed source yields completely to
// any unshed rival that still has work, and runs only once that rival drains.
// Reading the admission threshold as `min(costBytes, weight × quantum)` under
// the rollback would relax the gate to `w` and admit the shed source after a
// single credit round, producing a DIFFERENT dispatch sequence.
//
// The expectations below are the pre-BH-1 implementation's dispatch sequences,
// recorded by running the HEAD scheduler against these exact scripts. They are
// the oracle; if a change moves them, the rollback claim in the module header,
// in `SharedRequestSchedulerOptions.byteQuantum` and in
// `SchedulerStats.dispatchedBytesBySource` has stopped being true.

describe('SharedRequestScheduler — byteQuantum:null rollback exactness', () => {
  it('a sub-1-weight source (0.25 — what §11.3 sheds to) reproduces slot DRR', async () => {
    // 'shed' carries §11.3's exact shed factor and the MORE urgent priority, so
    // any relaxation of the gate shows up immediately as it jumping the queue.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: null });
    const d = byteDriver(s);
    for (let i = 0; i < 8; i++) {
      d.enqueue({
        sourceId: 'shed',
        weight: 0.25,
        priority: 0,
        // Declared cost must be ignored entirely under the rollback.
        costBytes: 4096,
        label: `s${i}`,
      });
      d.enqueue({
        sourceId: 'base',
        weight: 1,
        priority: 1,
        costBytes: 999_999,
        label: `b${i}`,
      });
    }
    await d.drainAll();

    // HEAD's recorded order: the top-up admits 'shed' once (the scheduler was
    // empty, so it was the only active source), then 'base' takes every slot
    // until it drains — 'shed' cannot clear the flat `deficit ≥ 1` gate.
    expect(d.order).toEqual([
      's0',
      'b0',
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
    ]);

    // Rollback currency is slots: every entry is billed exactly 1 regardless of
    // the `costBytes` each declared.
    expect(s.getStats().dispatchedBytesBySource).toEqual({ shed: 8, base: 8 });
  });

  it('mixed sub-1 and super-1 weights reproduce slot DRR', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: null });
    const d = byteDriver(s);
    for (let i = 0; i < 6; i++) {
      d.enqueue({ sourceId: 'q', weight: 0.25, priority: 0, label: `q${i}` });
      d.enqueue({ sourceId: 'h', weight: 0.5, priority: 1, label: `h${i}` });
      d.enqueue({ sourceId: 'f', weight: 2, priority: 2, label: `f${i}` });
    }
    await d.drainAll();

    // HEAD's recorded order: both sub-1 sources are shut out while 'f' (the
    // only source that can bank a whole credit) has work, and they drain in
    // priority order only afterwards.
    expect(d.order).toEqual([
      'q0',
      'f0',
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
      'h0',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'q1',
      'q2',
      'q3',
      'q4',
      'q5',
    ]);
  });

  it('all-sub-1 weights reproduce slot DRR (the top-up path carries every dispatch)', async () => {
    // With no source able to bank a whole credit, EVERY dispatch goes through
    // the top-up. Its iteration domain is all active sources, not just those
    // holding a candidate — narrowing it changes the common amount added and
    // therefore the sequence.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: null });
    const d = byteDriver(s);
    for (let i = 0; i < 5; i++) {
      d.enqueue({ sourceId: 'x', weight: 0.25, priority: 1, label: `x${i}` });
      d.enqueue({ sourceId: 'y', weight: 0.5, priority: 0, label: `y${i}` });
    }
    await d.drainAll();

    expect(d.order).toEqual([
      'x0',
      'y0',
      'y1',
      'y2',
      'y3',
      'y4',
      'x1',
      'x2',
      'x3',
      'x4',
    ]);
  });

  it('the sub-1 gate is unconditional: 0.9 is still shut out, 1.0 is not', async () => {
    // A boundary pair, so the pin is not satisfiable by special-casing 0.25.
    const run = async (weight: number): Promise<string[]> => {
      const s = new SharedRequestScheduler({
        maxRequests: 1,
        byteQuantum: null,
      });
      const d = byteDriver(s);
      // 'rival' goes first so the scheduler is never empty when 'probe' arrives
      // — that removes the top-up's single free dispatch from the picture.
      d.enqueue({ sourceId: 'rival', weight: 1, priority: 1, label: 'r0' });
      for (let i = 0; i < 4; i++) {
        d.enqueue({ sourceId: 'probe', weight, priority: 0, label: `p${i}` });
        d.enqueue({
          sourceId: 'rival',
          weight: 1,
          priority: 1,
          label: `r${i + 1}`,
        });
      }
      await d.drainAll();
      return d.order;
    };

    // weight 0.9 < 1: clamped to 0.9, never clears the flat gate ⇒ every
    // 'rival' request runs first even though 'probe' is more urgent.
    expect(await run(0.9)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'p0',
      'p1',
      'p2',
      'p3',
    ]);
    // weight 1.0: clears the gate every round, so its better priority wins its
    // share back and it interleaves with 'rival' instead of waiting it out.
    expect(await run(1)).toEqual([
      'r0',
      'p0',
      'p1',
      'r1',
      'p2',
      'r2',
      'p3',
      'r3',
      'r4',
    ]);
  });

  it('byte metering keeps the WEIGHTED threshold (the rollback fix is scoped)', async () => {
    // The `min(costBytes, weight × byteQuantum)` reading is REQUIRED once the
    // quantum is bytes: `creditRound` caps a weight-0.25 source at 0.25 × 1000
    // = 250 credits, so a flat threshold of one full quantum would deadlock it
    // behind every group larger than 250 B. Scoping the rollback fix to
    // `byteQuantum: null` must not disturb that.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const d = byteDriver(s);
    for (let i = 0; i < 4; i++) {
      d.enqueue({
        sourceId: 'shed',
        weight: 0.25,
        costBytes: 800,
        label: `s${i}`,
      });
    }
    await d.drainAll();
    expect(d.order).toEqual(['s0', 's1', 's2', 's3']);
  });
});

// ─── B4 (tile-loading audit 2026-08): tier-gated DRR admission ──────────────
//
// The archive prices every need-now group below `SCHEDULER_PREFETCH_TIER_BASE`
// and every prefetch group at or above it. Before B4 the DRR deficit gate ran
// BEFORE the priority compare, so a source in byte arrears (it had just
// dispatched a group larger than one quantum — routine: primary groups are
// 0.25–15 MB) was skipped for as many rounds as the arrears took to repay, and
// every other source's PREFETCH ran in those rounds. The tier base only ordered
// admissible candidates; it never gated admission.

describe('SharedRequestScheduler — B4 tier-gated DRR admission', () => {
  const MiB = 1024 * 1024;

  it("B4: a required source's need-now request dispatches before any other source's prefetch-tier request, even in arrears", async () => {
    // Port of the audit's `drr-arrears3.mjs` (15 MiB, 'while-running' case)
    // onto controllable executors: no timers, one dispatch per freed slot.
    const s = new SharedRequestScheduler({ maxRequests: 24 });
    const started: string[] = [];
    const overlayRunning: Controllable[] = [];
    const enqueue = (
      sourceId: string,
      costBytes: number,
      priority: number,
      label: string,
    ): Controllable => {
      const c = controllable();
      void s
        .schedule({
          sourceId,
          costBytes,
          getPriority: () => priority,
          execute: (sig) => {
            started.push(label);
            if (sourceId !== 'R') overlayRunning.push(c);
            return c.execute(sig);
          },
        })
        .catch(() => {});
      return c;
    };
    const overlayStarts = () => started.filter((l) => l !== 'R').length;

    // R dispatches one 15 MiB need-now group and keeps it on the wire: ~29
    // quanta of arrears, which DRR repays one quantum per round and prunes
    // only once R is fully idle (never, during playback).
    const rBig = enqueue('R', 15 * MiB, 0, 'R');
    await flush();
    expect(rBig.started()).toBe(true);

    // Three overlays queue 200 prefetch-tier groups each (250 KB).
    for (let o = 0; o < 3; o++)
      for (let i = 0; i < 200; i++)
        enqueue(
          `O${o}`,
          250_000,
          SCHEDULER_PREFETCH_TIER_BASE + i * 1000,
          `O${o}`,
        );
    await flush();
    // R's group plus 23 overlay groups fill the budget.
    expect(started.length).toBe(24);
    expect(overlayStarts()).toBe(23);

    // R's NEXT need-now group arrives while its big one is still running.
    const rNext = enqueue('R', 1 * MiB, 1000, 'R');
    await flush();
    const overlaysAtEnqueue = overlayStarts();
    expect(rNext.started()).toBe(false); // no free slot yet

    // Free overlay slots one at a time until R's need-now group dispatches or
    // the overlays run dry. Each freed slot is one `selectNext` decision.
    while (!rNext.started() && overlayRunning.length > 0) {
      overlayRunning.shift()!.resolve(undefined);
      await flush();
    }

    // THE INVERSION: before B4, 174 optional groups (43 MB) dispatched here
    // while R's need-now group waited out its arrears.
    expect(rNext.started()).toBe(true);
    expect(overlayStarts() - overlaysAtEnqueue).toBe(0);

    s.clear();
    rBig.resolve(undefined);
    rNext.resolve(undefined);
    for (const c of overlayRunning) c.resolve(undefined);
    await flush();
  });

  it('B4: arrears still yield to a SAME-tier rival, and prefetch waits behind every need-now source', async () => {
    // Serial driver, 1000-byte quantum. R runs a 5× over-quantum need-now
    // group, then has two more need-now groups; S has need-now work; O only
    // prefetch. Expected: S soaks up R's arrears (same-tier byte share is the
    // property DRR exists for), and O never runs while EITHER need-now source
    // still has work — whatever R's arrears say.
    const s = new SharedRequestScheduler({ maxRequests: 1, byteQuantum: 1000 });
    const d = byteDriver(s);
    d.enqueue({ sourceId: 'R', costBytes: 5000, priority: 0, label: 'R-big' });
    for (let i = 0; i < 2; i++)
      d.enqueue({
        sourceId: 'R',
        costBytes: 1000,
        priority: 10,
        label: 'R-next',
      });
    for (let i = 0; i < 20; i++)
      d.enqueue({ sourceId: 'S', costBytes: 500, priority: 5, label: 'S' });
    for (let i = 0; i < 20; i++)
      d.enqueue({
        sourceId: 'O',
        costBytes: 500,
        priority: SCHEDULER_PREFETCH_TIER_BASE,
        label: 'O',
      });
    await d.drainAll();

    expect(d.order[0]).toBe('R-big');
    // Same-tier share preserved: S repays R's 5000-byte arrears (≈10 of its
    // 500-byte groups) before R's next need-now group runs.
    const firstRNext = d.order.indexOf('R-next');
    const sBeforeRNext = d.order
      .slice(0, firstRNext)
      .filter((x) => x === 'S').length;
    expect(sBeforeRNext).toBeGreaterThanOrEqual(8);
    // Tier gate: the first prefetch group dispatches only after the LAST
    // need-now group of either source.
    const firstO = d.order.indexOf('O');
    expect(firstO).toBeGreaterThan(d.order.lastIndexOf('R-next'));
    expect(firstO).toBeGreaterThan(d.order.lastIndexOf('S'));
    expect(d.order.filter((x) => x === 'O').length).toBe(20);
  });
});
