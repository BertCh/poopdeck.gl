// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Process-shared {@link SharedRequestScheduler} singleton
 * (multi-source coordination, Phase 2 — integration; see
 * docs/roadmap/playback-and-loading.md §4–5).
 *
 * ─── Why a module singleton ─────────────────────────────────────────────────
 *
 * The whole point of Phase 2 is that N composited `STTArchive`s share ONE global
 * concurrency budget instead of each opening up to its own per-archive cap (24)
 * and fighting for bandwidth (docs/roadmap/playback-and-loading.md §2).
 * A module-level singleton, reachable from
 * every archive instance, is that single authority. The default budget is 24 —
 * the same number as the per-archive cap — so a scene with a
 * SINGLE archive is unchanged: DRR is work-conserving, so one source draws all
 * 24 slots and there is no throughput regression for the common single-dataset
 * case. With N archives the same 24 are shared by weighted-fair (DRR) share.
 *
 * The global budget is re-tunable via `configureSharedScheduler({ maxRequests })`.
 */

import {
  SharedRequestScheduler,
  type SharedRequestSchedulerOptions,
} from './request-scheduler.js';

/** Default global concurrency budget — the per-archive `maxConcurrentRequests`. */
const DEFAULT_SHARED_MAX_REQUESTS = 24;

/**
 * Default DRR byte quantum for the singleton (M6 / BH-1). `undefined` means
 * "whatever `SharedRequestScheduler` defaults to" (512 KiB) — we do not restate
 * the number here so there is exactly one definition of it.
 */
const DEFAULT_SHARED_BYTE_QUANTUM: number | null | undefined = undefined;

/** Mutable module state. Lazily-created scheduler + budget. */
interface SharedSchedulerState {
  scheduler: SharedRequestScheduler | null;
  /** Global concurrency budget for the (lazily-created) singleton. */
  maxRequests: number;
  /**
   * DRR byte quantum for the (lazily-created) singleton. `undefined` = the
   * scheduler's own default; `null` = the slot-semantics rollback.
   */
  byteQuantum: number | null | undefined;
}

const state: SharedSchedulerState = {
  scheduler: null,
  maxRequests: DEFAULT_SHARED_MAX_REQUESTS,
  byteQuantum: DEFAULT_SHARED_BYTE_QUANTUM,
};

/** Configuration accepted by {@link configureSharedScheduler}. */
export type ConfigureSharedSchedulerOptions = SharedRequestSchedulerOptions;

/**
 * Get the process-shared request scheduler, creating it lazily on first use.
 * Every `STTArchive` calls this so they all draw from ONE global concurrency
 * budget (default 24). The instance is stable for the life of the process
 * unless {@link resetSharedScheduler} is called (tests only).
 *
 * Creating the scheduler has no cost beyond a few empty Maps; it does no work
 * until a request is scheduled.
 */
export function getSharedScheduler(): SharedRequestScheduler {
  if (!state.scheduler) {
    state.scheduler = buildScheduler();
  }
  return state.scheduler;
}

/** Construct a scheduler from the current module state. */
function buildScheduler(): SharedRequestScheduler {
  return new SharedRequestScheduler({
    maxRequests: state.maxRequests,
    // Passing `undefined` keeps SharedRequestScheduler's own default.
    byteQuantum: state.byteQuantum,
  });
}

/**
 * Configure the shared scheduler's global budget and DRR byte quantum.
 *
 * - `{ maxRequests: N }` re-tunes the global concurrency budget.
 * - `{ byteQuantum: N }` re-tunes the DRR quantum in bytes (M6 / BH-1);
 *   `{ byteQuantum: null }` is the rollback to pre-BH-1 slot semantics.
 *
 * Because the underlying `SharedRequestScheduler` fixes both at construction,
 * changing either REPLACES the singleton with a fresh one carrying the new
 * configuration; any requests already queued/running on the old instance settle
 * on their own (they are not migrated). Re-tune at startup, not mid-playback.
 *
 * Omitted fields are left unchanged.
 */
export function configureSharedScheduler(
  options: ConfigureSharedSchedulerOptions = {},
): void {
  let changed = false;
  if (
    typeof options.maxRequests === 'number' &&
    Number.isFinite(options.maxRequests) &&
    options.maxRequests >= 1
  ) {
    const next = Math.floor(options.maxRequests);
    if (next !== state.maxRequests) {
      state.maxRequests = next;
      changed = true;
    }
  }
  // `byteQuantum` accepts an explicit `null` (the rollback), so presence is
  // tested rather than truthiness — `undefined` means "leave unchanged".
  if (options.byteQuantum !== undefined) {
    const next =
      options.byteQuantum === null
        ? null
        : Number.isFinite(options.byteQuantum) && options.byteQuantum >= 1
          ? options.byteQuantum
          : state.byteQuantum;
    if (next !== state.byteQuantum) {
      state.byteQuantum = next;
      changed = true;
    }
  }
  if (changed) {
    // Rebuild the singleton with the new configuration. Existing work on the
    // old instance keeps running to completion on its own (no migration).
    state.scheduler = buildScheduler();
  }
}

/**
 * Re-weight one source's fair share on the process-shared scheduler, effective
 * immediately for work already queued under that `sourceId` (see {@link
 * SharedRequestScheduler.setSourceWeight}). No-op when the singleton hasn't
 * been created yet — there is no queued work to re-share, and the source's
 * next request pins the new weight at enqueue.
 */
export function setSharedSchedulerSourceWeight(
  sourceId: string,
  weight: number,
): void {
  state.scheduler?.setSourceWeight(sourceId, weight);
}

/** The configured global concurrency budget (the singleton's `maxRequests`). */
export function getSharedSchedulerMaxRequests(): number {
  return state.maxRequests;
}

/**
 * The configured DRR byte quantum. `undefined` = the scheduler's own default
 * (512 KiB); `null` = the slot-semantics rollback is engaged.
 */
export function getSharedSchedulerByteQuantum(): number | null | undefined {
  return state.byteQuantum;
}

/**
 * Tear down and forget the singleton, resetting config to defaults. TEST-ONLY —
 * production never needs this (the singleton is meant to live for the process).
 * Aborts any in-flight work on the old instance so tests don't leak timers.
 */
export function resetSharedScheduler(): void {
  state.scheduler?.clear('Shared scheduler reset');
  state.scheduler = null;
  state.maxRequests = DEFAULT_SHARED_MAX_REQUESTS;
  state.byteQuantum = DEFAULT_SHARED_BYTE_QUANTUM;
}
