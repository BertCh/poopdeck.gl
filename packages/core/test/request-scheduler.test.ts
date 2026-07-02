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
  SharedRequestScheduler,
  isCancellationError,
} from '../src/request-scheduler';

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

/** Flush all currently-queued microtasks so promise reactions run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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
      s.schedule({ sourceId: `src${i}`, getPriority: () => i, execute: c.execute }),
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
    s.schedule({ sourceId: 'blocker', getPriority: () => 0, execute: blocker.execute });
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
    s.schedule({ sourceId: 'blk', getPriority: () => 0, execute: blocker.execute });
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
    const pa = s.schedule({ sourceId: 'a', getPriority: () => 0, execute: a.execute });
    await flush();
    expect(s.getStats().active).toBe(1);

    const b = controllable<string>();
    const pb = s.schedule({ sourceId: 'b', getPriority: () => 0, execute: b.execute });
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
    const pa = s.schedule({ sourceId: 'a', getPriority: () => 0, execute: a.execute });
    await flush();

    const b = controllable();
    const pb = s.schedule({ sourceId: 'b', getPriority: () => 0, execute: b.execute });
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
    const pb = s.schedule({ sourceId: 'b', getPriority: () => 0, execute: b.execute });
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
    s.schedule({ sourceId: 'blk', getPriority: () => 0, execute: blocker.execute });
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
    const r0 = s.schedule({ sourceId: 'x', getPriority: () => 0, execute: running[0].execute });
    const r1 = s.schedule({ sourceId: 'x', getPriority: () => 0, execute: running[1].execute });
    const queued = controllable();
    const rq = s.schedule({ sourceId: 'x', getPriority: () => 0, execute: queued.execute });
    // A different source must be untouched.
    const other = controllable();
    const ro = s.schedule({ sourceId: 'y', getPriority: () => 0, execute: other.execute });
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
    cs.forEach((c) => s.schedule({ sourceId: 'only', getPriority: () => 0, execute: c.execute }));
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

  it('work-conserving across sources: a light source reclaims a heavy source\'s share once heavy drains', async () => {
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
      s.schedule({ sourceId: 'a', getPriority: () => 0, execute: cs[0].execute }),
      s.schedule({ sourceId: 'a', getPriority: () => 0, execute: cs[1].execute }),
      s.schedule({ sourceId: 'b', getPriority: () => 0, execute: cs[2].execute }),
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
    const pf = s.schedule({ sourceId: 'c', getPriority: () => 0, execute: fresh.execute });
    await flush();
    fresh.resolve(7);
    await expect(pf).resolves.toBe(7);
  });

  it('a throwing getPriority() cancels that request without taking down the pump', async () => {
    const s = new SharedRequestScheduler({ maxRequests: 1 });
    const blocker = controllable();
    s.schedule({ sourceId: 'blk', getPriority: () => 0, execute: blocker.execute });
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
    const pGood = s.schedule({ sourceId: 'good', getPriority: () => 1, execute: good.execute });
    const badRejected = captureRejection(pBad);
    await flush();

    blocker.resolve(undefined);
    await flush();
    expect((await badRejected() as Error).message).toContain('priority kaboom');
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
      s.schedule({ sourceId: 'blk', getPriority: () => 0, execute: blocker.execute });
      await flush();

      // Two queued requests for source 'leak' that never run.
      const v1 = controllable();
      const v2 = controllable();
      const r1 = s.scheduleRequest({ sourceId: 'leak', getPriority: () => 1, execute: v1.execute });
      const r2 = s.scheduleRequest({ sourceId: 'leak', getPriority: () => 1, execute: v2.execute });
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
      s.schedule({ sourceId: 'blk', getPriority: () => 0, execute: blocker.execute });
      await flush();

      const v1 = controllable();
      const v2 = controllable();
      const p1 = s.schedule({ sourceId: 'q', getPriority: () => 1, execute: v1.execute });
      const p2 = s.schedule({ sourceId: 'q', getPriority: () => 1, execute: v2.execute });
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
      const pBlk = s.schedule({ sourceId: 'blk', getPriority: () => 0, execute: blocker.execute });
      await flush();
      const v1 = controllable();
      const p1 = s.schedule({ sourceId: 'q', getPriority: () => 1, execute: v1.execute });
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
