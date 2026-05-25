/**
 * Lightweight performance-probe channel.
 *
 * Layers and the consolidation step push timing samples into a
 * `globalThis.__sttProbe` object that test harnesses (Playwright probes,
 * the PerformanceMonitor HUD) can read. The channel is intentionally
 * passive — when the probe object isn't set up (i.e. production, tests
 * that don't care about perf) every call is a single property read + an
 * early return, so it's safe to leave in hot paths.
 *
 * Contract:
 *
 *   globalThis.__sttProbe = {
 *     enabled: true,
 *     // Channel -> rolling sample array. The probe consumer is expected
 *     // to clear / drain these as it sees fit; we never shrink them here.
 *     consolidations?: Array<{ ms: number; n: number; layer: string }>,
 *     renderLayers?:   Array<{ ms: number; tiles: number; layer: string }>,
 *     tilePrepare?:    Array<{ ms: number; tileKey: string; layer: string }>,
 *     decode?:         Array<{ ms: number; bytes: number; tileKey: string }>,
 *   };
 *
 * Set `enabled: false` to short-circuit even when the object exists, so
 * the probe can record its setup state once and disable sampling for a
 * baseline phase.
 */

export type ProbeChannel =
  | 'consolidations'
  | 'renderLayers'
  | 'tilePrepare'
  | 'decode';

interface ProbeBag {
  enabled?: boolean;
  consolidations?: unknown[];
  renderLayers?: unknown[];
  tilePrepare?: unknown[];
  decode?: unknown[];
  /** Latest-value channel (overwrites). HUDs subscribe; sample tools ignore. */
  snapshots?: Record<string, unknown>;
  [other: string]: unknown;
}

/**
 * Hard cap on samples kept per channel. A long perf session would otherwise
 * grow these arrays unboundedly and eventually dominate heap (each entry is
 * tiny but at 60 Hz × multiple channels × multi-minute runs they add up).
 * Drops the oldest sample once the cap is hit; the probe consumer is
 * expected to drain on its own cadence.
 */
const MAX_SAMPLES_PER_CHANNEL = 4096;

/** Record a sample to `__sttProbe[channel]`. No-op when the probe isn't set up. */
export function emit<T>(channel: ProbeChannel, payload: T): void {
  // `globalThis` works in Node, browsers, and workers — the probe may sit
  // on any of them.
  const bag = (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  if (!bag || bag.enabled === false) return;
  let arr = bag[channel] as unknown[] | undefined;
  if (!arr) {
    arr = [];
    bag[channel] = arr;
  }
  arr.push(payload);
  if (arr.length > MAX_SAMPLES_PER_CHANNEL) {
    // Cheap drop-oldest: pop from the front. The cap is generous enough
    // that the per-call shift cost is amortised across thousands of pushes.
    arr.shift();
  }
}

/**
 * Time a synchronous block of work and emit one sample. Returns the
 * function's value untouched so callers can wrap arbitrary expressions:
 *
 *     const data = measure('consolidations', { layer: id }, () => consolidatePoints(tiles));
 */
export function measure<T>(
  channel: ProbeChannel,
  baseSample: Record<string, unknown>,
  fn: () => T,
): T {
  const bag = (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  // Fast-path: when probe isn't enabled we skip the `performance.now()`
  // syscalls entirely. The bag check happens twice (once here, once in
  // emit) but it's a single property read; cheaper than the syscalls.
  if (!bag || bag.enabled === false) return fn();
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    return fn();
  } finally {
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    emit(channel, { ...baseSample, ms: t1 - t0 });
  }
}

/**
 * Stop sampling. Used by long-running probes that have already captured
 * the steady-state window and don't want subsequent renders to bloat the
 * sample buffers.
 */
export function disableProbe(): void {
  const bag = (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  if (bag) bag.enabled = false;
}

/**
 * Publish a "latest value" snapshot under `name`. Distinct from `emit()`:
 * snapshots overwrite (the HUD only cares about the most recent stats),
 * sample arrays grow (the probe wants histograms).
 *
 * Like `emit()`, this is a no-op when the probe isn't set up.
 */
export function snapshot<T>(name: string, value: T): void {
  const bag = (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  if (!bag || bag.enabled === false) return;
  let snaps = bag.snapshots as Record<string, unknown> | undefined;
  if (!snaps) {
    snaps = {};
    bag.snapshots = snaps;
  }
  snaps[name] = value;
}

/**
 * Read the latest snapshot under `name`, or `undefined` if none was published
 * (or the probe is disabled). The HUD calls this on its update tick.
 */
export function getSnapshot<T>(name: string): T | undefined {
  const bag = (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  const snaps = bag?.snapshots as Record<string, unknown> | undefined;
  return snaps?.[name] as T | undefined;
}

/**
 * Fast check used by hot paths to skip building a snapshot/sample payload
 * when no probe consumer is going to read it. `snapshot()` and `emit()` are
 * themselves no-ops in that case, but the ARGUMENTS to those calls are
 * still evaluated unconditionally — so a per-frame
 * `snapshot('x', expensive())` still pays for `expensive()` in production.
 * Gate the expensive part with `if (isProbeEnabled()) { ... }`.
 */
export function isProbeEnabled(): boolean {
  const bag = (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  return !!bag && bag.enabled !== false;
}

/**
 * Activate the probe. Call this from a consumer (HUD, Playwright probe)
 * BEFORE the work you want to sample so the first events are captured.
 * Idempotent — re-enabling a bag that's already active keeps existing samples.
 */
export function enableProbe(): void {
  const g = globalThis as unknown as { __sttProbe?: ProbeBag };
  if (!g.__sttProbe) g.__sttProbe = {};
  g.__sttProbe.enabled = true;
}
