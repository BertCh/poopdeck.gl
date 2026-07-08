// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * SharedRequestScheduler — a process-shareable request budget allocator for
 * compositing N heterogeneous STT sources (multi-source coordination, Phase 2;
 * see docs/roadmap/playback-and-loading.md §4–5).
 *
 * THE PROBLEM. A story or demo may composite several STT datasets of arbitrary,
 * mixed intensity. Today each `STTArchive` runs its own pool of up to 24
 * concurrent range requests, so N archives open ~24·N connections and fight for
 * bandwidth with no shared budget, priority, or fairness (§2.5). This module is
 * the single authority that hands out a *fixed global concurrency budget* across
 * all sources by dynamic priority and weighted-fair share.
 *
 * It is intentionally framework-agnostic and self-contained: no `fetch`, no
 * network, no clocks. The caller supplies an async `execute(signal)` that does
 * the real work, plus a `getPriority()` callback re-evaluated *at dispatch time*
 * (when a slot opens), never at enqueue time. This is the loaders.gl
 * `RequestScheduler` shape (global `maxRequests`, a `done()` handshake to free a
 * slot on completion OR failure, a priority callback consulted as slots open,
 * `priority < 0` cancels) married to Cesium priority semantics: priority is a
 * unit-less value where a LOWER numeric value means HIGHER priority — the direct
 * analog of "time-to-playhead" replacing Cesium's "distance-from-camera" (§2.8).
 *
 * ─── Dispatch model ──────────────────────────────────────────────────────────
 *
 * Up to `maxRequests` requests run concurrently. When a slot is free we pick the
 * next queued request to run by, for each candidate, calling `getPriority()`
 * fresh:
 *   - a return value `< 0` CANCELS that request (it rejects with an
 *     `AbortError`-style `DOMException`). It was never running, so it frees
 *     nothing; we simply drop it from the queue and keep selecting.
 *   - otherwise the request with the LOWEST priority value wins (Cesium: lower =
 *     more urgent). Ties broken by weighted-fair share (below), then FIFO.
 *
 * Because `getPriority()` is consulted at dispatch (not enqueue) time, the queue
 * is implicitly *re-prioritized every time a slot frees* — exactly the
 * earliest-deadline-first behaviour the playhead needs as it moves. Re-ordering
 * applies only to QUEUED requests; a request already running is never re-ranked
 * or preempted (only an explicit `abort()` can stop it).
 *
 * ─── Weighted-fair share via Deficit Round Robin (DRR) ───────────────────────
 *
 * Priority alone lets one heavy source that floods high-priority requests
 * monopolize every slot and starve a lighter source. We layer DRR — the
 * discrete-slot analog of Weighted Fair Queuing (§2.6) — on top of priority:
 *
 *   - Each `sourceId` has a `weight` (default 1) and a running `deficit` counter
 *     measured in fractional "slot credits".
 *   - Every dispatch round each source with at least one runnable (non-cancelled)
 *     queued request earns `weight` credits added to its deficit (a "quantum").
 *     A source's fair share of the global budget is thus proportional to its
 *     weight among the *currently active* sources.
 *   - Among the per-source fronts, a source may be DISPATCHED this round only if
 *     its deficit ≥ 1 (it has accumulated a whole slot's worth of credit). When
 *     it dispatches a request, 1 credit is subtracted from its deficit; leftover
 *     fractional credit carries forward, so a low-weight source eventually
 *     accumulates enough to run (no starvation).
 *   - WORK-CONSERVING: a source with no runnable requests earns no credits and
 *     holds none, so an idle source's share is reclaimed and redistributed —
 *     the global budget is never left idle while any source has work. If, after
 *     a full pass, no source has yet reached a full credit but slots and work
 *     remain, we top every active source up to the threshold so a slot is never
 *     wasted (DRR's standard "no idle slot" guarantee at slot granularity).
 *
 * Within those eligibility rules the actual pick is by priority (lowest value),
 * so DRR governs *how many* slots each source gets over time while priority
 * governs *which* of a source's requests runs first. A required source below its
 * gate (priority near 0) still wins individual races; DRR only stops a flood
 * from one source from consuming the share another source is entitled to.
 *
 * ─── Correctness guarantees ──────────────────────────────────────────────────
 *
 *   - No lost slots: every request that starts frees its slot exactly once, via
 *     a `try/finally` around `execute` (the `done()` handshake).
 *   - No deadlock when everything cancels: cancellation drains the queue and
 *     each cancelled promise rejects; the pump keeps draining until the queue is
 *     empty, then idles cleanly with zero active.
 *   - Re-prioritization affects only queued requests; running requests are
 *     untouched.
 *   - `AbortSignal` is passed to `execute` and fires on cancel/abort/negative
 *     priority, so in-flight work can stop promptly.
 */

/**
 * Error thrown when a scheduled request is cancelled — whether by a negative
 * `getPriority()` return, an explicit {@link SharedRequestScheduler.abort}, or
 * {@link SharedRequestScheduler.clear}. Matches the repo convention of an
 * `AbortError`-named `DOMException` so existing `isAbortError` checks
 * (`error.name === 'AbortError'`) treat it like any other cancellation.
 */
export function createCancellationError(message: string): Error {
  // `DOMException` is available in browsers and modern Node; fall back to a
  // plain Error with the conventional `.name` if it is somehow absent.
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** True if `error` is an `AbortError`-style cancellation (name-based, per repo convention). */
export function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Options for {@link SharedRequestScheduler.schedule}. */
export interface ScheduleOptions<T> {
  /**
   * Logical source this request belongs to (e.g. an archive / layer id). Used
   * for weighted-fair share and per-source stats. Requests with the same
   * `sourceId` share one weight and one DRR deficit counter.
   */
  sourceId: string;
  /**
   * Relative weight of this source for fair-share slot allocation (DRR
   * quantum). Higher weight ⇒ larger share of the global budget when sources
   * contend. Defaults to 1. The first weight seen for a `sourceId` wins for the
   * lifetime of its outstanding queue; later differing weights are ignored
   * until the source drains. Non-positive / non-finite weights fall back to 1.
   */
  weight?: number;
  /**
   * Priority callback, re-evaluated each time a slot opens (NOT at enqueue
   * time). LOWER value = HIGHER priority (Cesium semantics). A return value
   * `< 0` cancels the request (it rejects with a cancellation error and frees
   * nothing, since it was never running). Should be cheap and side-effect free.
   */
  getPriority: () => number;
  /**
   * The actual work. Receives an {@link AbortSignal} that fires if the request
   * is cancelled/aborted. The returned promise's settlement frees the slot
   * (success or failure) via the internal `done()` handshake.
   */
  execute: (signal: AbortSignal) => Promise<T>;
}

/** A handle to a scheduled request — its result promise plus an `abort()`. */
export interface ScheduledRequest<T> {
  /** Resolves with `execute`'s result, or rejects on failure / cancellation. */
  readonly promise: Promise<T>;
  /**
   * Cancel this request. If still queued it is dropped and the promise rejects
   * with a cancellation error; if already running, its `AbortSignal` fires and
   * the slot frees when `execute` settles. Idempotent.
   */
  abort(reason?: string): void;
}

/** A point-in-time snapshot of scheduler occupancy. */
export interface SchedulerStats {
  /** Requests currently running (occupying a slot). */
  active: number;
  /** Requests waiting in the queue (not yet running). */
  queued: number;
  /** The global concurrency budget. */
  maxRequests: number;
  /** In-flight (running) request count per `sourceId`. Sources with 0 running are omitted. */
  inFlightBySource: Record<string, number>;
  /** Queued request count per `sourceId`. Sources with 0 queued are omitted. */
  queuedBySource: Record<string, number>;
  /**
   * Number of sources currently holding fair-share bookkeeping (a pinned
   * `weight` / DRR deficit). Should equal the number of sources with queued OR
   * running work — a value larger than that signals a bookkeeping LEAK (the
   * Wave-1 LOW bug: a source whose requests were all queued-then-aborted used to
   * leak its Map entries forever). Diagnostic; safe to ignore.
   */
  trackedSources: number;
}

/** Constructor options for {@link SharedRequestScheduler}. */
export interface SharedRequestSchedulerOptions {
  /**
   * Global concurrency budget — the maximum number of requests running at once
   * across ALL sources. Additional requests queue until a slot frees. Default
   * 24 (the legacy per-archive cap, now shared process-wide).
   */
  maxRequests?: number;
}

/** Default global concurrency budget (legacy per-archive `maxConcurrentRequests`). */
const DEFAULT_MAX_REQUESTS = 24;

/** A queued or running unit of work, internal to the scheduler. */
interface Entry<T = unknown> {
  readonly sourceId: string;
  readonly weight: number;
  readonly getPriority: () => number;
  readonly execute: (signal: AbortSignal) => Promise<T>;
  readonly controller: AbortController;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  /** Monotonic enqueue order, for FIFO tie-breaking. */
  readonly seq: number;
  /** True once dispatched (occupying a slot); used to guard double-settle. */
  running: boolean;
  /** True once settled (resolved/rejected); guards double-settle. */
  settled: boolean;
}

/**
 * A process-shareable request scheduler. Allocate one instance and share it
 * across every `STTArchive` in a composited scene so they draw from a single
 * global concurrency budget with priority + weighted-fair share.
 *
 * Self-contained: no network, no timers. The caller supplies the executor.
 */
export class SharedRequestScheduler {
  private readonly maxRequests: number;

  /** Requests waiting for a slot, in arbitrary order (selection re-ranks). */
  private readonly queue: Entry[] = [];
  /** Requests currently running (one slot each). */
  private readonly active = new Set<Entry>();

  /** Per-source DRR deficit (fractional slot credits). */
  private readonly deficits = new Map<string, number>();
  /**
   * Sources already credited their quantum in the CURRENT DRR round. A source is
   * credited at most once per round (true DRR semantics); a new round begins —
   * and this set is cleared — only when no already-credited source can still
   * dispatch (its deficit dropped below 1). This is what stops a heavier source's
   * deficit from diverging unboundedly across dispatches and starving a lighter
   * one. See {@link selectNext}.
   */
  private readonly roundCredited = new Set<string>();
  /** Per-source weight (first weight seen for a sourceId, while it has work). */
  private readonly weights = new Map<string, number>();
  /** Running count per source, kept in sync for O(1) stats. */
  private readonly inFlight = new Map<string, number>();

  /** Monotonic sequence for FIFO tie-breaking. */
  private seqCounter = 0;
  /** Re-entrancy guard so synchronous settle→pump doesn't recurse unboundedly. */
  private pumping = false;

  constructor(options: SharedRequestSchedulerOptions = {}) {
    const max = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.maxRequests =
      Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_MAX_REQUESTS;
  }

  /**
   * Enqueue a request. Returns a promise resolving with `execute`'s result (or
   * rejecting on failure / cancellation). The request runs once a global slot
   * is free and it is selected by priority + fair share. `getPriority()` is
   * consulted at dispatch time; returning `< 0` then cancels it.
   *
   * For an abort handle as well as the promise, use {@link scheduleRequest}.
   */
  schedule<T>(opts: ScheduleOptions<T>): Promise<T> {
    return this.scheduleRequest(opts).promise;
  }

  /**
   * Like {@link schedule} but returns a {@link ScheduledRequest} handle exposing
   * both the result promise and an `abort()` to cancel a queued or in-flight
   * request.
   */
  scheduleRequest<T>(opts: ScheduleOptions<T>): ScheduledRequest<T> {
    const weight = normalizeWeight(opts.weight);
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: Entry<T> = {
      sourceId: opts.sourceId,
      weight,
      getPriority: opts.getPriority,
      execute: opts.execute,
      controller: new AbortController(),
      resolve,
      reject,
      seq: this.seqCounter++,
      running: false,
      settled: false,
    };

    // Remember the weight for this source while it has outstanding work; the
    // first weight wins until the source's queue + in-flight fully drains.
    if (!this.weights.has(opts.sourceId)) {
      this.weights.set(opts.sourceId, weight);
    }

    this.queue.push(entry as Entry);
    this.pump();

    return {
      promise,
      abort: (reason?: string) => this.abortEntry(entry as Entry, reason),
    };
  }

  /**
   * Abort a specific entry (queued or running). Queued entries are dropped and
   * rejected; running entries get their signal fired and free their slot when
   * `execute` settles. Idempotent. Exposed via the {@link ScheduledRequest}
   * handle returned by {@link scheduleRequest}.
   */
  private abortEntry(entry: Entry, reason?: string): void {
    if (entry.settled) return;
    const err = createCancellationError(reason ?? 'Request aborted');
    // Fire the signal first so running executors can stop promptly.
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(err);
    }
    if (entry.running) {
      // Slot frees when execute settles (its try/finally); just signal here.
      return;
    }
    // Still queued: remove and reject now.
    const idx = this.queue.indexOf(entry);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.settle(entry, false, err);
    // WAVE-1 LOW FIX: a source whose requests are all QUEUED-then-aborted never
    // reaches `done()` (which only runs for dispatched entries), so without this
    // its `weights` / `deficits` / `roundCredited` entries would leak for the
    // lifetime of the scheduler. Reclaim them the moment its last queued+running
    // request is gone — exactly the work-conserving cleanup `done()` performs.
    this.cleanupSourceIfDrained(entry.sourceId);
    this.pump();
  }

  /**
   * Abort every request belonging to `sourceId` (queued and running). Useful
   * when a source/layer is torn down.
   */
  abortSource(sourceId: string, reason = 'Source aborted'): void {
    // Snapshot first — abortEntry mutates the queue / active set.
    const victims: Entry[] = [];
    for (const e of this.queue) if (e.sourceId === sourceId) victims.push(e);
    for (const e of this.active) if (e.sourceId === sourceId) victims.push(e);
    for (const e of victims) this.abortEntry(e, reason);
  }

  /**
   * Abort EVERY request (queued and running) and reset DRR state. The scheduler
   * remains usable afterwards.
   */
  clear(reason = 'Scheduler cleared'): void {
    const victims = [...this.queue, ...this.active];
    for (const e of victims) this.abortEntry(e, reason);
    // Running entries finish draining via their finally; queued ones are gone.
    // Reset fair-share bookkeeping for sources that are fully drained.
    // WAVE-1 LOW FIX: also clear `weights` for drained sources — the earlier
    // implementation reset deficits/round-state but left `weights` populated
    // (it was only ever pruned in `done()`), leaking one Map entry per source
    // that was cleared while it still had queued work. Any source still
    // RUNNING keeps its weight (its `done()` will prune it when it settles).
    this.deficits.clear();
    this.roundCredited.clear();
    for (const id of [...this.weights.keys()]) {
      if ((this.inFlight.get(id) ?? 0) === 0) this.weights.delete(id);
    }
  }

  /**
   * Reclaim a source's fair-share bookkeeping (`weights` / `deficits` /
   * `roundCredited`) once it has no queued AND no running requests left. Shared
   * by the `done()` handshake (dispatched-then-settled requests) and the queued
   * abort path (requests cancelled before they ever ran), so a source that only
   * ever queued-then-aborted is cleaned up exactly like one that ran — no leak.
   */
  private cleanupSourceIfDrained(sourceId: string): void {
    if (
      (this.inFlight.get(sourceId) ?? 0) === 0 &&
      !this.queue.some((e) => e.sourceId === sourceId)
    ) {
      this.weights.delete(sourceId);
      this.deficits.delete(sourceId);
      this.roundCredited.delete(sourceId);
    }
  }

  /** Current occupancy snapshot. */
  getStats(): SchedulerStats {
    const inFlightBySource: Record<string, number> = {};
    for (const [id, n] of this.inFlight) if (n > 0) inFlightBySource[id] = n;
    const queuedBySource: Record<string, number> = {};
    for (const e of this.queue) {
      queuedBySource[e.sourceId] = (queuedBySource[e.sourceId] ?? 0) + 1;
    }
    // Union of sources holding any fair-share bookkeeping — the leak indicator.
    const tracked = new Set<string>();
    for (const id of this.weights.keys()) tracked.add(id);
    for (const id of this.deficits.keys()) tracked.add(id);
    for (const id of this.roundCredited.keys()) tracked.add(id);
    return {
      active: this.active.size,
      queued: this.queue.length,
      maxRequests: this.maxRequests,
      inFlightBySource,
      queuedBySource,
      trackedSources: tracked.size,
    };
  }

  /**
   * Pump the queue: while slots are free, select and dispatch the next request.
   * Re-entrancy-guarded — a synchronous settle that calls back into `pump`
   * loops here instead of recursing.
   */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.maxRequests && this.queue.length > 0) {
        const next = this.selectNext();
        if (!next) break; // queue exhausted (all cancelled this round)
        this.dispatch(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Select the next request to run, applying negative-priority cancellation,
   * Deficit Round Robin fair share, and lowest-priority-wins selection.
   * Returns `null` when nothing runnable remains in the queue (everything left
   * was cancelled this round).
   *
   * TRUE DRR ROUND SEMANTICS. The earlier implementation credited every active
   * source its full quantum on *every* dispatch while dispatching only one
   * request, so with unequal weights a heavier source's deficit grew without
   * bound and (via a "larger deficit first" tiebreak) monopolized every slot,
   * starving the lighter source — the exact failure DRR must prevent. Here a
   * source is credited at most once per ROUND: we credit a source only the first
   * time it is seen as active within the current round ({@link roundCredited}),
   * and a *new* round begins only when no already-credited source can still
   * dispatch. Within a round we drain eligible sources (deficit ≥ 1) by priority;
   * once they all fall below a full credit the round ends and everyone is
   * topped up again. Deficits therefore stay bounded and the long-run slot
   * share converges to weight / Σweight among contending sources.
   *
   * Algorithm (one call dispatches at most one request):
   *  1. Snapshot each queued entry's priority once (`getPriority()` at dispatch
   *     time). Drop & reject any with priority < 0 (cancellation).
   *  2. Determine active sources (those with a survivor). Prune drained sources'
   *     deficits/round-state (work-conserving). Then credit — for the current
   *     round — any active source not yet credited this round.
   *  3. If no active source has reached deficit ≥ 1, the round is over: start a
   *     fresh round (clear the credited set) and credit everyone again. If even
   *     a single quantum still leaves the most-deserving source short (weights
   *     < 1), top every active source up so a slot is never wasted.
   *  4. Among sources with deficit ≥ 1, pick the candidate (its lowest-value =
   *     most-urgent survivor) with the globally lowest priority; ties → FIFO.
   *     Subtract 1 from its deficit. (No "larger deficit first" tiebreak — that
   *     let an inflated deficit monopolize.)
   */
  private selectNext(): Entry | null {
    // (1) Evaluate priorities once; cancel negatives.
    const survivors: { entry: Entry; priority: number }[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      let priority: number;
      try {
        priority = entry.getPriority();
      } catch (err) {
        // A throwing priority callback cancels the request (treat like abort).
        this.queue.splice(i, 1);
        this.settle(entry, false, err);
        continue;
      }
      if (priority < 0 || Number.isNaN(priority)) {
        this.queue.splice(i, 1);
        this.settle(
          entry,
          false,
          createCancellationError('Request cancelled (priority < 0)'),
        );
        continue;
      }
      survivors.push({ entry, priority });
    }

    if (survivors.length === 0) return null;

    // (2) Determine active sources (those with a survivor).
    const activeSources = new Set<string>();
    for (const s of survivors) activeSources.add(s.entry.sourceId);

    // Prune deficits + round-state for sources with no current survivors AND
    // nothing running — their share is reclaimed (work-conserving). Keep running
    // sources so a burst that briefly empties a source's queue doesn't reset its
    // credit.
    for (const id of [...this.deficits.keys()]) {
      if (!activeSources.has(id) && (this.inFlight.get(id) ?? 0) === 0) {
        this.deficits.delete(id);
        this.roundCredited.delete(id);
      }
    }

    // Best candidate per source = its most-urgent (lowest-priority) survivor.
    const bestPerSource = new Map<string, { entry: Entry; priority: number }>();
    for (const s of survivors) {
      const cur = bestPerSource.get(s.entry.sourceId);
      if (!cur || lessUrgentFirst(s, cur) < 0) {
        bestPerSource.set(s.entry.sourceId, s);
      }
    }

    // Credit each active source its quantum AT MOST ONCE in the current round.
    // A source that became active mid-round still earns this round's quantum the
    // first time it is seen.
    this.creditRound(activeSources);

    // (3) If no source can dispatch yet, advance the round: clear the credited
    // set and credit everyone again. Repeat while progress is possible; a tiny
    // "top up" guarantees a slot is never wasted even with sub-1 weights.
    let chosen = this.pickEligible(bestPerSource);
    if (!chosen) {
      // New round.
      this.roundCredited.clear();
      this.creditRound(activeSources);
      chosen = this.pickEligible(bestPerSource);
    }
    if (!chosen) {
      // Weights < 1 left even the most-deserving source short — top up the
      // smallest common amount that makes at least one source eligible.
      let minNeeded = Infinity;
      for (const id of activeSources) {
        minNeeded = Math.min(minNeeded, 1 - (this.deficits.get(id) ?? 0));
      }
      if (Number.isFinite(minNeeded) && minNeeded > 0) {
        for (const id of activeSources) {
          this.deficits.set(id, (this.deficits.get(id) ?? 0) + minNeeded);
        }
      }
      chosen = this.pickEligible(bestPerSource);
    }

    if (!chosen) return null;

    // Spend one slot's worth of credit from the chosen source.
    this.deficits.set(
      chosen.entry.sourceId,
      (this.deficits.get(chosen.entry.sourceId) ?? 0) - 1,
    );

    // Remove the chosen entry from the queue.
    const idx = this.queue.indexOf(chosen.entry);
    if (idx >= 0) this.queue.splice(idx, 1);
    return chosen.entry;
  }

  /**
   * Credit each active source its `weight` quantum, but only the first time the
   * source is seen within the current DRR round (tracked by {@link
   * roundCredited}). This is the heart of true DRR: a source is topped up once
   * per round, not once per dispatch, so deficits cannot diverge across the many
   * `selectNext` calls a single round may span. To keep an idle-then-active
   * source from banking unbounded credit across rounds, the resulting deficit is
   * clamped to one quantum (a source can be at most `weight` credits ahead).
   */
  private creditRound(activeSources: Set<string>): void {
    for (const id of activeSources) {
      if (this.roundCredited.has(id)) continue;
      this.roundCredited.add(id);
      const w = this.weights.get(id) ?? 1;
      const next = (this.deficits.get(id) ?? 0) + w;
      // Clamp so banked credit stays bounded (≤ one quantum ahead).
      this.deficits.set(id, Math.min(next, w));
    }
  }

  /**
   * Among sources whose deficit ≥ 1, return the globally most-urgent candidate
   * (lowest priority value, ties → FIFO), or `null` if none is eligible.
   */
  private pickEligible(
    bestPerSource: Map<string, { entry: Entry; priority: number }>,
  ): { entry: Entry; priority: number } | null {
    let chosen: { entry: Entry; priority: number } | null = null;
    for (const [id, cand] of bestPerSource) {
      if ((this.deficits.get(id) ?? 0) < 1) continue;
      if (!chosen || compareCandidates(cand, chosen) < 0) {
        chosen = cand;
      }
    }
    return chosen;
  }

  /** Run an entry, freeing its slot exactly once on settle (the done() handshake). */
  private dispatch(entry: Entry): void {
    entry.running = true;
    this.active.add(entry);
    this.inFlight.set(
      entry.sourceId,
      (this.inFlight.get(entry.sourceId) ?? 0) + 1,
    );

    // If it was aborted between enqueue and dispatch, reject immediately.
    if (entry.controller.signal.aborted) {
      this.done(entry);
      this.settle(entry, false, entry.controller.signal.reason);
      return;
    }

    let result: Promise<unknown>;
    try {
      result = entry.execute(entry.controller.signal);
    } catch (syncErr) {
      // A synchronous throw from execute still must free the slot.
      this.done(entry);
      this.settle(entry, false, syncErr);
      return;
    }

    Promise.resolve(result).then(
      (value) => {
        this.done(entry);
        this.settle(entry, true, value);
      },
      (err) => {
        this.done(entry);
        this.settle(entry, false, err);
      },
    );
  }

  /** Free the slot held by a running entry exactly once, then re-pump. */
  private done(entry: Entry): void {
    if (this.active.delete(entry)) {
      const n = (this.inFlight.get(entry.sourceId) ?? 1) - 1;
      if (n > 0) this.inFlight.set(entry.sourceId, n);
      else this.inFlight.delete(entry.sourceId);
    }
    entry.running = false;
    // Forget the source's pinned weight once it has no work left, so a later
    // re-use of the same id can pick a fresh weight.
    this.cleanupSourceIfDrained(entry.sourceId);
    this.pump();
  }

  /** Settle an entry's promise exactly once. */
  private settle(entry: Entry, ok: boolean, value: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }
}

/** Coerce a weight to a positive finite number (default 1). */
function normalizeWeight(weight: number | undefined): number {
  return typeof weight === 'number' && Number.isFinite(weight) && weight > 0
    ? weight
    : 1;
}

/**
 * Order two same-source survivors: more urgent first (lower priority value,
 * then earlier FIFO). Returns < 0 if `a` should run before `b`.
 */
function lessUrgentFirst(
  a: { entry: Entry; priority: number },
  b: { entry: Entry; priority: number },
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.entry.seq - b.entry.seq;
}

/**
 * Order two cross-source candidates: lowest priority value wins; ties broken by
 * FIFO (earlier enqueue). Deliberately NOT broken by "larger deficit first" — an
 * inflated deficit must never let one source monopolize the budget (the DRR
 * starvation bug this module had). DRR governs *how many* slots a source earns
 * via the per-round eligibility gate, not via the priority tiebreak.
 */
function compareCandidates(
  a: { entry: Entry; priority: number },
  b: { entry: Entry; priority: number },
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.entry.seq - b.entry.seq;
}
