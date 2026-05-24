/**
 * Minimal in-process telemetry channel.
 *
 * Layers call `emit('renderLayers', { ms, tiles, layer })` at hot points.
 * In production this is a no-op fast path (one identity check + early return).
 * Tests and the perf harness opt in by setting:
 *
 *   (globalThis as any).__sttProbe = { renderLayers: [], ... };
 *
 * Any channel that exists as an array on `__sttProbe` will receive its
 * payloads pushed onto the array. Channels not present on the probe are
 * dropped — callers never have to guard the call site.
 *
 * Why a global: the showcase harness lives in a different module graph from
 * the layers (vite SSR vs. browser bundle), so a module-level subscriber
 * registry would be invisible across the boundary. `globalThis.__sttProbe` is
 * the smallest contract that survives that without dragging in an event bus.
 */

type Probe = Record<string, unknown[]> | undefined;

export function emit(channel: string, payload: unknown): void {
  const probe = (globalThis as { __sttProbe?: Probe }).__sttProbe;
  if (!probe) return;
  const sink = probe[channel];
  if (Array.isArray(sink)) sink.push(payload);
}
