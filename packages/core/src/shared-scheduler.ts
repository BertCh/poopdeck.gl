// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Process-shared {@link SharedRequestScheduler} singleton + kill-switch
 * (multi-source coordination, Phase 2 — integration; see
 * docs/roadmap/playback-and-loading.md §4–5).
 *
 * ─── Why a module singleton ─────────────────────────────────────────────────
 *
 * The whole point of Phase 2 is that N composited `STTArchive`s share ONE global
 * concurrency budget instead of each opening up to its own per-archive cap (24)
 * and fighting for bandwidth (§2.5). A module-level singleton, reachable from
 * every archive instance, is that single authority. The default budget is 24 —
 * deliberately the SAME number as the legacy per-archive cap — so a scene with a
 * SINGLE archive is unchanged: DRR is work-conserving, so one source draws all
 * 24 slots and there is no throughput regression for the common single-dataset
 * case. With N archives the same 24 are shared by weighted-fair (DRR) share.
 *
 * ─── THE KILL-SWITCH (read this if you are rolling back) ─────────────────────
 *
 * `configureSharedScheduler({ enabled: false })` is the ROLLBACK. It is the one
 * flag that decides whether the archive routes its range-group fetches through
 * the shared scheduler at all. When disabled, every `STTArchive` takes its EXACT
 * pre-Phase-2 per-instance cursor-runner path (an unchanged fallback branch kept
 * verbatim in `archive.ts`) — guaranteeing a clean revert if browser
 * verification turns up trouble, with zero code changes and no redeploy of the
 * archive. The flag defaults to ENABLED.
 *
 * It can also be flipped at runtime BEFORE the relevant fetches begin (an app
 * may read a query param / feature flag and call `configureSharedScheduler`
 * once at startup). Each in-flight `getTiles` call samples the flag once at the
 * top, so toggling mid-flight never splits a single batch across both paths.
 *
 * The flag is independent of `maxRequests`: you can re-tune the global budget
 * without disabling, and disabling does not lose your `maxRequests` setting.
 */

import {
  SharedRequestScheduler,
  type SharedRequestSchedulerOptions,
} from './request-scheduler.js';

/** Default global concurrency budget — the legacy per-archive `maxConcurrentRequests`. */
const DEFAULT_SHARED_MAX_REQUESTS = 24;

/** Mutable module state. Lazily-created scheduler + the kill-switch + budget. */
interface SharedSchedulerState {
  scheduler: SharedRequestScheduler | null;
  /** THE KILL-SWITCH. Default true (enabled). */
  enabled: boolean;
  /** Global concurrency budget for the (lazily-created) singleton. */
  maxRequests: number;
}

const state: SharedSchedulerState = {
  scheduler: null,
  enabled: true,
  maxRequests: DEFAULT_SHARED_MAX_REQUESTS,
};

/** Configuration accepted by {@link configureSharedScheduler}. */
export interface ConfigureSharedSchedulerOptions extends SharedRequestSchedulerOptions {
  /**
   * THE KILL-SWITCH. When `false`, every `STTArchive` falls back to its legacy
   * per-instance concurrency runner and the shared scheduler is never consulted
   * (a guaranteed, code-change-free rollback). Defaults to `true`. Omit to leave
   * the current value untouched.
   */
  enabled?: boolean;
}

/**
 * Get the process-shared request scheduler, creating it lazily on first use.
 * Every `STTArchive` calls this so they all draw from ONE global concurrency
 * budget (default 24). The instance is stable for the life of the process
 * unless {@link resetSharedScheduler} is called (tests only).
 *
 * Note: this returns the scheduler regardless of the kill-switch — call
 * {@link isSharedSchedulingEnabled} to decide whether to USE it. (Creating the
 * scheduler has no cost beyond a few empty Maps; it does no work until a request
 * is scheduled.)
 */
export function getSharedScheduler(): SharedRequestScheduler {
  if (!state.scheduler) {
    state.scheduler = new SharedRequestScheduler({
      maxRequests: state.maxRequests,
    });
  }
  return state.scheduler;
}

/**
 * Configure the shared scheduler — the kill-switch and/or the global budget.
 *
 * - `{ enabled: false }` is the ROLLBACK (see this module's header): archives
 *   revert to the legacy per-instance runner. `{ enabled: true }` re-enables.
 * - `{ maxRequests: N }` re-tunes the global concurrency budget. Because the
 *   underlying `SharedRequestScheduler` fixes `maxRequests` at construction,
 *   changing it REPLACES the singleton with a fresh one carrying the new budget;
 *   any requests already queued/running on the old instance settle on their own
 *   (they are not migrated). Re-tune at startup, not mid-playback.
 *
 * Both fields are optional; omitted fields are left unchanged.
 */
export function configureSharedScheduler(
  options: ConfigureSharedSchedulerOptions = {},
): void {
  if (typeof options.enabled === 'boolean') {
    state.enabled = options.enabled;
  }
  if (
    typeof options.maxRequests === 'number' &&
    Number.isFinite(options.maxRequests) &&
    options.maxRequests >= 1
  ) {
    const next = Math.floor(options.maxRequests);
    if (next !== state.maxRequests) {
      state.maxRequests = next;
      // Rebuild the singleton with the new budget. Existing work on the old
      // instance keeps running to completion on its own (no migration).
      state.scheduler = new SharedRequestScheduler({ maxRequests: next });
    }
  }
}

/** Whether the kill-switch is on (archives route through the shared scheduler). Default `true`. */
export function isSharedSchedulingEnabled(): boolean {
  return state.enabled;
}

/** The configured global concurrency budget (the singleton's `maxRequests`). */
export function getSharedSchedulerMaxRequests(): number {
  return state.maxRequests;
}

/**
 * Tear down and forget the singleton, resetting config to defaults. TEST-ONLY —
 * production never needs this (the singleton is meant to live for the process).
 * Aborts any in-flight work on the old instance so tests don't leak timers.
 */
export function resetSharedScheduler(): void {
  state.scheduler?.clear('Shared scheduler reset');
  state.scheduler = null;
  state.enabled = true;
  state.maxRequests = DEFAULT_SHARED_MAX_REQUESTS;
}
