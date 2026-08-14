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
 * bandwidth with no shared budget, priority, or fairness
 * (docs/roadmap/playback-and-loading.md §2). This module is
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
 * analog of "time-to-playhead" replacing Cesium's "distance-from-camera"
 * (docs/roadmap/playback-and-loading.md §2).
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
 * discrete analog of Weighted Fair Queuing (§2.6) — on top of priority:
 *
 *   - Each `sourceId` has a `weight` (default 1) and a running `deficit` counter
 *     measured in BYTE credits (see "The currency is bytes" below).
 *   - Every dispatch round each source with at least one runnable (non-cancelled)
 *     queued request earns `weight × byteQuantum` credits added to its deficit
 *     (its "quantum"). A source's fair share of the global budget is thus
 *     proportional to its weight among the *currently active* sources.
 *   - Among the per-source fronts, a source may be DISPATCHED this round only if
 *     its deficit ≥ `min(candidate.costBytes, quantum)` — enough credit to pay
 *     for the request it wants to run, or a full quantum, whichever is smaller.
 *     (Under the `byteQuantum: null` rollback the gate is instead a flat 1 for
 *     every source, which is what the pre-BH-1 slot scheme did.) When it
 *     dispatches, the request's `costBytes` is subtracted from the deficit;
 *     leftover credit carries forward (and an over-quantum request leaves the
 *     source in arrears, which it pays back over later rounds), so a low-weight
 *     source eventually accumulates enough to run (no starvation).
 *   - WORK-CONSERVING: a source with no runnable requests earns no credits and
 *     holds none, so an idle source's share is reclaimed and redistributed —
 *     the global budget is never left idle while any source has work. If, after
 *     a full pass, no source has yet reached its admission threshold but slots
 *     and work remain, we top every active source up to that threshold so a slot
 *     is never wasted (DRR's standard "no idle slot" guarantee).
 *
 * Within those eligibility rules the actual pick is by priority (lowest value),
 * so DRR governs *how many* bytes each source gets over time while priority
 * governs *which* of a source's requests runs first. A required source below its
 * gate (priority near 0) still wins individual races; DRR only stops a flood
 * from one source from consuming the share another source is entitled to.
 *
 * ─── The currency is bytes (M6 / BH-1) ───────────────────────────────────────
 *
 * The constrained resource on the wire is BYTES, not slots. A source whose
 * coalesced range groups are 100× heavier than another's used to receive the
 * same number of slots at equal weight, i.e. 100× the link. The deficit
 * currency is therefore bytes: `ScheduleOptions.costBytes` prices one request
 * (the archive passes the coalesced range's exact `end - start + 1`), and the
 * per-round quantum is `weight × byteQuantum` (default 512 KiB ≈ the median
 * coalesced group).
 *
 * The `min(costBytes, quantum)` admission threshold is the progress guarantee
 * for a group LARGER than one quantum: a source whose deficit is topped up to a
 * full quantum can always dispatch, mirroring the tileset slicer's "a slice
 * takes at least one tile" rule. Without it, an oversized group would never be
 * admissible and the source would deadlock behind its own biggest request.
 *
 * Entries that declare NO `costBytes` bill at exactly one `byteQuantum`, so a
 * source of undifferentiated requests (directory-page fetches, custom callers)
 * gets `weight` dispatches per round — byte-for-byte the old slot semantics.
 * Constructing the scheduler with `byteQuantum: null` restores slot semantics
 * outright (quantum 1, every entry costs 1, admission gate a flat `deficit ≥ 1`)
 * as the documented rollback — see `admissionThreshold` for why the gate stays
 * flat under the rollback instead of following `weight`. The rollback is
 * sequence-exact against the pre-BH-1 implementation at EVERY weight, sub-1
 * ones included; `request-scheduler.test.ts` pins the recorded orders.
 *
 * ⚠️ KNOWN CONSEQUENCE of preserving the pinned crediting scheme verbatim: the
 * deficit is clamped to one quantum at each crediting, which discards the
 * intra-round leftover `quantum mod costBytes`. In the slot world that leftover
 * was always 0. In the byte world it under-serves a source whose group size does
 * not divide its quantum, by up to one `costBytes` per round — bounded in SHARE
 * (never worse than `costBytes / quantum`) but unbounded in cumulative bytes
 * over a long backlog. It is why the quantum default is large relative to a
 * typical group, and it errs toward throttling the heavy source, which is the
 * one byte metering exists to rein in.
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
 *
 * ─── Observation (P0-2) ──────────────────────────────────────────────────────
 *
 * When `globalThis.__sttProbe` is installed, every scheduled request emits one
 * sample on the core `requests` channel at settle: `{ key, priority, bytes,
 * enqueuedAt, dispatchedAt, completedAt, source }`. This is OBSERVATION ONLY —
 * no scheduling decision reads it, and with the probe off the whole path costs
 * one property read per `scheduleRequest` (no per-entry allocation, no clock
 * call). `key`/`bytes` are optional labels supplied by the caller; the
 * scheduler itself is still network- and format-agnostic.
 */

import {
  emit as emitProbe,
  isProbeEnabled,
  probeNow,
  type RequestProbeSample,
} from './telemetry.js';

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
   * OBSERVATION ONLY (P0-2). A label for this request on the `requests` probe
   * channel — the archive passes the lead tile's key for a coalesced range
   * group. Never read by any scheduling decision; ignored entirely when the
   * probe is off. Defaults to `''`.
   */
  key?: string;
  /**
   * OBSERVATION ONLY (P0-2). Byte length this request covers, for the probe
   * channel's byte accounting. Never read by any scheduling decision; ignored
   * entirely when the probe is off. Defaults to `0`.
   *
   * ⚠️ NOT the same field as {@link costBytes}, deliberately. `bytes` is a
   * probe LABEL: producers only compute it when `globalThis.__sttProbe` is
   * installed (the archive skips its `groupProbeMeta` callback entirely with
   * the probe off), so wiring DRR to it would make dispatch order depend on
   * whether an observer is attached — exactly the coupling P0-2 forbids.
   * `costBytes` is the DECISION field and is always supplied. They usually
   * carry the same number; only `costBytes` is authoritative for scheduling.
   */
  bytes?: number;
  /**
   * DECISION FIELD (M6 / BH-1). What this request costs in the DRR currency:
   * the number of bytes it will pull off the wire. The archive passes a
   * coalesced range group's exact size (`end - start + 1`, known at enqueue).
   *
   * Omitted / non-finite / ≤ 0 ⇒ the request bills one `byteQuantum`, which
   * reproduces the pre-BH-1 slot semantics exactly for callers that cannot
   * price their work (directory pages, custom callers). See {@link bytes} for
   * why this is a separate field from the probe label.
   */
  costBytes?: number;
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
  /**
   * Cumulative DRR cost GRANTED per `sourceId` since construction (reset by
   * {@link SharedRequestScheduler.clear}) — the byte-share counter M6's
   * evaluation reads against each source's weight share.
   *
   * Units are the scheduler's currency: bytes by default, slot-credits when the
   * `byteQuantum: null` rollback is engaged. Requests that declared no
   * `costBytes` are counted at one quantum (what they were billed), not at
   * their true wire size — the scheduler never learns that number.
   *
   * Sources with 0 granted are omitted. Unlike the fair-share maps this is NOT
   * pruned when a source drains (a cumulative counter that forgets is useless),
   * and it is deliberately excluded from {@link trackedSources}, which counts
   * only fair-share bookkeeping.
   */
  dispatchedBytesBySource: Record<string, number>;
}

/** Constructor options for {@link SharedRequestScheduler}. */
export interface SharedRequestSchedulerOptions {
  /**
   * Global concurrency budget — the maximum number of requests running at once
   * across ALL sources. Additional requests queue until a slot frees. Default
   * 24 (the legacy per-archive cap, now shared process-wide).
   */
  maxRequests?: number;
  /**
   * DRR quantum in BYTES (M6 / BH-1): a source of weight `w` earns
   * `w × byteQuantum` credits per crediting round, and a request declaring no
   * {@link ScheduleOptions.costBytes} bills exactly one `byteQuantum`.
   * Default `512 * 1024` — roughly the median coalesced range group, chosen so
   * a typical group costs about one quantum and rounds stay cheap (a much
   * smaller quantum means many rounds per dispatch, which is pure CPU).
   *
   * `null` is the ROLLBACK: it restores pre-BH-1 slot semantics outright
   * (quantum 1, every entry costs 1 credit, `costBytes` ignored, admission gate
   * a flat `deficit ≥ 1` at every weight). It is sequence-exact against the
   * pre-BH-1 implementation — including SUB-1 weights, which §11.3's fairness
   * controller produces whenever it sheds a leader to `0.25 × base`. Non-finite
   * or `< 1` values fall back to the default.
   */
  byteQuantum?: number | null;
}

/** Default global concurrency budget (legacy per-archive `maxConcurrentRequests`). */
const DEFAULT_MAX_REQUESTS = 24;

/**
 * Default DRR byte quantum: 512 KiB ≈ the median coalesced range group, so the
 * typical request costs about one quantum.
 */
const DEFAULT_BYTE_QUANTUM = 512 * 1024;

/**
 * Quantum used by the `byteQuantum: null` rollback. With quantum 1 and every
 * entry costing 1, `creditRound` / `pickEligible` / the spend step reduce
 * arithmetically to the pre-BH-1 slot scheme.
 */
const SLOT_QUANTUM = 1;

/**
 * Per-entry probe bookkeeping, allocated ONLY when the probe is enabled at
 * enqueue time. Its absence is what makes the probe-off path free.
 */
interface EntryProbe {
  key: string;
  bytes: number;
  enqueuedAt: number;
  /** 0 until `dispatch()` stamps it. */
  dispatchedAt: number;
  /** Priority the entry won its slot with; 0 if never dispatched. */
  priority: number;
}

/** A queued or running unit of work, internal to the scheduler. */
interface Entry<T = unknown> {
  readonly sourceId: string;
  readonly weight: number;
  /**
   * What this entry costs in the DRR currency, normalized at enqueue: the
   * caller's `costBytes` when byte metering is on, one `byteQuantum` when it
   * declared none, and a flat 1 under the `byteQuantum: null` rollback.
   */
  readonly costBytes: number;
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
  /** Probe bookkeeping; `undefined` whenever the probe was off at enqueue. */
  probe?: EntryProbe;
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
  /**
   * DRR quantum in the scheduler's currency (bytes by default, 1 under the
   * `byteQuantum: null` rollback). A source of weight `w` earns `w × this` per
   * crediting round.
   */
  private readonly byteQuantum: number;
  /** False under the `byteQuantum: null` rollback — `costBytes` is then ignored. */
  private readonly byteMetered: boolean;

  /** Requests waiting for a slot, in arbitrary order (selection re-ranks). */
  private readonly queue: Entry[] = [];
  /** Requests currently running (one slot each). */
  private readonly active = new Set<Entry>();

  /** Per-source DRR deficit, in the scheduler's currency (byte credits). */
  private readonly deficits = new Map<string, number>();
  /**
   * Cumulative granted cost per source (see
   * {@link SchedulerStats.dispatchedBytesBySource}). Deliberately NOT pruned by
   * `cleanupSourceIfDrained` — it is telemetry, not fair-share bookkeeping.
   */
  private readonly dispatchedBytes = new Map<string, number>();
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
    // `null` (explicit) = the slot-semantics rollback; anything else resolves to
    // a byte quantum (bad values → the 512 KiB default).
    if (options.byteQuantum === null) {
      this.byteMetered = false;
      this.byteQuantum = SLOT_QUANTUM;
    } else {
      const q = options.byteQuantum ?? DEFAULT_BYTE_QUANTUM;
      this.byteMetered = true;
      this.byteQuantum =
        typeof q === 'number' && Number.isFinite(q) && q >= 1
          ? q
          : DEFAULT_BYTE_QUANTUM;
    }
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
      costBytes: this.normalizeCostBytes(opts.costBytes),
      getPriority: opts.getPriority,
      execute: opts.execute,
      controller: new AbortController(),
      resolve,
      reject,
      seq: this.seqCounter++,
      running: false,
      settled: false,
      // P0-2: one property read when the probe is off; nothing else allocated.
      probe: isProbeEnabled()
        ? {
            key: opts.key ?? '',
            bytes: opts.bytes ?? 0,
            enqueuedAt: probeNow(),
            dispatchedAt: 0,
            priority: 0,
          }
        : undefined,
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
   * Re-weight `sourceId`'s fair share IMMEDIATELY, for work already queued.
   *
   * DELIBERATELY overrides the first-weight-wins pin ({@link
   * ScheduleOptions.weight}): the pin keeps a source's share stable by
   * default, but a governor re-balancing bandwidth mid-playback (a starved
   * required source vs. a leader with runway to spare) cannot wait for the
   * source's queue to drain. The new weight applies from the next DRR
   * crediting round; accumulated deficits are untouched (already-earned
   * credit is honored, so the change never claws back a slot in flight).
   * No-op for a source with no outstanding work — its bookkeeping entry
   * would only leak (see `trackedSources`), and its next request pins the
   * fresh weight at enqueue anyway.
   */
  setSourceWeight(sourceId: string, weight: number): void {
    if (!this.weights.has(sourceId)) return;
    this.weights.set(sourceId, normalizeWeight(weight));
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
    // The granted-cost counter is scoped to a scheduler "session"; clear() is
    // the documented reset point (it is also what resetSharedScheduler calls).
    this.dispatchedBytes.clear();
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
    const dispatchedBytesBySource: Record<string, number> = {};
    for (const [id, n] of this.dispatchedBytes) {
      if (n > 0) dispatchedBytesBySource[id] = n;
    }
    return {
      active: this.active.size,
      queued: this.queue.length,
      maxRequests: this.maxRequests,
      inFlightBySource,
      queuedBySource,
      trackedSources: tracked.size,
      dispatchedBytesBySource,
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
   * dispatch. Within a round we drain eligible sources by priority; once they
   * all fall short of their next request's admission threshold the round ends
   * and everyone is topped up again. Deficits therefore stay bounded and the
   * long-run BYTE share converges to weight / Σweight among contending sources.
   *
   * BH-1 CHANGED ONLY THE CURRENCY. The crediting scheme — credit at most once
   * per round via `roundCredited`, clamp the deficit to one quantum, open a new
   * round only when no credited source can dispatch, then top up (over EVERY
   * active source) so no slot idles — is preserved verbatim; `1` became
   * `min(costBytes, quantum)` and the quantum became `weight × byteQuantum`.
   * With `byteQuantum: null` both substitutions collapse back to `1` and `weight`
   * for all weights, which is what makes that config the sequence-exact rollback.
   *
   * Algorithm (one call dispatches at most one request):
   *  1. Snapshot each queued entry's priority once (`getPriority()` at dispatch
   *     time). Drop & reject any with priority < 0 (cancellation).
   *  2. Determine active sources (those with a survivor). Prune drained sources'
   *     deficits/round-state (work-conserving). Then credit — for the current
   *     round — any active source not yet credited this round.
   *  3. If no active source has reached its admission threshold, the round is
   *     over: start a fresh round (clear the credited set) and credit everyone
   *     again. If even a single quantum still leaves the most-deserving source
   *     short (weights < 1, or a group bigger than one quantum), top every
   *     active source up so a slot is never wasted.
   *  4. Among admissible sources, pick the candidate (its lowest-value =
   *     most-urgent survivor) with the globally lowest priority; ties → FIFO.
   *     Subtract its `costBytes` from the deficit. (No "larger deficit first"
   *     tiebreak — that let an inflated deficit monopolize.)
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
      // Sub-1 weights — or a group larger than one quantum, which leaves the
      // source in arrears after it dispatches — left even the most-deserving
      // source short. Top up the smallest common amount that makes at least one
      // source admissible, so a slot is never wasted (single-source-draws-all).
      //
      // The iteration domain is EVERY active source, exactly as the pre-BH-1
      // slot implementation did — narrowing it to sources that happen to hold a
      // candidate would be an unflagged semantic change. `bestPerSource` is
      // built from the same survivor scan that built `activeSources`, so the
      // candidate-less branch is unreachable today; it asks the source for its
      // threshold FLOOR rather than dropping it, keeping the loop total.
      let minNeeded = Infinity;
      for (const id of activeSources) {
        const cand = bestPerSource.get(id);
        minNeeded = Math.min(
          minNeeded,
          this.admissionThreshold(id, cand?.entry) -
            (this.deficits.get(id) ?? 0),
        );
      }
      if (Number.isFinite(minNeeded) && minNeeded > 0) {
        for (const id of activeSources) {
          this.deficits.set(id, (this.deficits.get(id) ?? 0) + minNeeded);
        }
      }
      chosen = this.pickEligible(bestPerSource);
    }

    if (!chosen) return null;

    // OBSERVATION: record the priority the winner actually won its slot with
    // (the value the EDF/DRR pick used, not the enqueue-time guess).
    if (chosen.entry.probe) chosen.entry.probe.priority = chosen.priority;

    // Spend the request's cost (BH-1: bytes) from the chosen source's deficit.
    // An over-quantum request can push the deficit negative; that is the arrears
    // DRR pays back over the following rounds, and the clamp in `creditRound`
    // (min(deficit + q, q)) keeps it from ever over-banking on the way out.
    const spentId = chosen.entry.sourceId;
    this.deficits.set(
      spentId,
      (this.deficits.get(spentId) ?? 0) - chosen.entry.costBytes,
    );
    this.dispatchedBytes.set(
      spentId,
      (this.dispatchedBytes.get(spentId) ?? 0) + chosen.entry.costBytes,
    );

    // Remove the chosen entry from the queue.
    const idx = this.queue.indexOf(chosen.entry);
    if (idx >= 0) this.queue.splice(idx, 1);
    return chosen.entry;
  }

  /**
   * Normalize a caller's `costBytes` into the DRR currency. Missing / non-finite
   * / non-positive ⇒ one `byteQuantum`, which reproduces the pre-BH-1 slot
   * scheme for callers that cannot price their work. Under the
   * `byteQuantum: null` rollback every entry costs a flat 1.
   */
  private normalizeCostBytes(costBytes: number | undefined): number {
    if (!this.byteMetered) return 1;
    return typeof costBytes === 'number' &&
      Number.isFinite(costBytes) &&
      costBytes > 0
      ? costBytes
      : this.byteQuantum;
  }

  /** A source's per-round quantum in the DRR currency: `weight × byteQuantum`. */
  private quantumFor(sourceId: string): number {
    return (this.weights.get(sourceId) ?? 1) * this.byteQuantum;
  }

  /**
   * Credit this source must hold before `entry` may dispatch:
   * `min(entry.costBytes, quantum)`.
   *
   * The `min` is the PROGRESS GUARANTEE for a request larger than one quantum —
   * `creditRound` clamps the deficit at exactly one quantum, so without it such
   * a request could never be admitted and its source would deadlock behind its
   * own biggest group. It mirrors the tileset slicer's "a slice takes at least
   * one tile" rule. Do not drop it.
   *
   * ⚠️ ROLLBACK EXACTNESS (`byteQuantum: null`). Under the rollback the
   * threshold is a FLAT 1 for every source, NOT `min(1, weight)`. The pre-BH-1
   * slot scheme gated on `deficit ≥ 1` unconditionally, and because
   * `creditRound` clamps a weight-`w` source's deficit to `w`, a source with
   * `w < 1` could never clear that gate by crediting alone — it was routed
   * through the top-up path instead, which only fires when NO source is
   * admissible. Taking the weighted reading here would admit a `w < 1` source
   * after a single credit round and change the dispatch sequence, so the
   * rollback would no longer be the incumbent. Sub-1 weights are the production
   * case: §11.3's fairness controller sheds leaders to `0.25 × base`.
   *
   * `entry` is optional only so the top-up loop can ask a source with no
   * candidate for its floor; every real admission decision passes one.
   */
  private admissionThreshold(sourceId: string, entry?: Entry): number {
    if (!this.byteMetered) return 1;
    const quantum = this.quantumFor(sourceId);
    return entry ? Math.min(entry.costBytes, quantum) : quantum;
  }

  /**
   * Credit each active source its `weight × byteQuantum` quantum, but only the
   * first time the source is seen within the current DRR round (tracked by
   * {@link roundCredited}). This is the heart of true DRR: a source is topped up
   * once per round, not once per dispatch, so deficits cannot diverge across the
   * many `selectNext` calls a single round may span. To keep an idle-then-active
   * source from banking unbounded credit across rounds, the resulting deficit is
   * clamped to one quantum (a source can be at most one quantum ahead).
   */
  private creditRound(activeSources: Set<string>): void {
    for (const id of activeSources) {
      if (this.roundCredited.has(id)) continue;
      this.roundCredited.add(id);
      const q = this.quantumFor(id);
      const next = (this.deficits.get(id) ?? 0) + q;
      // Clamp so banked credit stays bounded (≤ one quantum ahead).
      this.deficits.set(id, Math.min(next, q));
    }
  }

  /**
   * Among sources whose deficit has reached their candidate's
   * {@link admissionThreshold}, return the globally most-urgent candidate
   * (lowest priority value, ties → FIFO), or `null` if none is admissible.
   */
  private pickEligible(
    bestPerSource: Map<string, { entry: Entry; priority: number }>,
  ): { entry: Entry; priority: number } | null {
    let chosen: { entry: Entry; priority: number } | null = null;
    for (const [id, cand] of bestPerSource) {
      if (
        (this.deficits.get(id) ?? 0) < this.admissionThreshold(id, cand.entry)
      )
        continue;
      if (!chosen || compareCandidates(cand, chosen) < 0) {
        chosen = cand;
      }
    }
    return chosen;
  }

  /** Run an entry, freeing its slot exactly once on settle (the done() handshake). */
  private dispatch(entry: Entry): void {
    entry.running = true;
    if (entry.probe) entry.probe.dispatchedAt = probeNow();
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
    // OBSERVATION (P0-2): one `requests` sample per settled request. Entries
    // that never dispatched (superseded while queued) settle here too and are
    // recorded with `dispatchedAt === 0` — a replay harness needs BOTH the
    // fetches and the supersessions, and the sentinel keeps them separable.
    const probe = entry.probe;
    if (probe) {
      emitProbe<RequestProbeSample>('requests', {
        key: probe.key,
        priority: probe.priority,
        bytes: probe.bytes,
        enqueuedAt: probe.enqueuedAt,
        dispatchedAt: probe.dispatchedAt,
        completedAt: probeNow(),
        source: entry.sourceId,
      });
    }
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
