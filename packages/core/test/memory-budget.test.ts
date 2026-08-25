/**
 * The process-wide DECODED-byte budget (A4, tile-loading audit 2026-08) —
 * the decoded-side sibling of the archive's shared compressed byte cache.
 * Pure unit tests: no tileset, no timers; owners are hand-rolled counters.
 */

import { describe, it, expect } from 'vitest';
import {
  DecodedMemoryBudget,
  DECODED_BUDGET_LARGE_DEVICE_BYTES,
  DECODED_BUDGET_LOW_DEVICE_BYTES,
  DECODED_BUDGET_MID_DEVICE_BYTES,
  DECODED_BUDGET_UNKNOWN_DEVICE_BYTES,
  deviceDefaultDecodedBudgetBytes,
  type DecodedMemoryOwner,
} from '../src/memory-budget';

const MIB = 1024 * 1024;

/** An owner holding `bytes`, evicting exactly to the target when asked. */
function owner(id: string, bytes: number) {
  let held = bytes;
  const evictCalls: number[] = [];
  const o: DecodedMemoryOwner & { evictCalls: number[] } = {
    id,
    evictCalls,
    bytes: () => held,
    evictToward(target: number): number {
      evictCalls.push(target);
      const before = held;
      held = Math.min(held, target);
      return before - held;
    },
  };
  return o;
}

describe('A4: DecodedMemoryBudget', () => {
  it('deviceDefault maps navigator.deviceMemory into three tiers, with the mobile-UA and unknown fallbacks', () => {
    expect(deviceDefaultDecodedBudgetBytes({ deviceMemory: 1 })).toBe(
      DECODED_BUDGET_LOW_DEVICE_BYTES,
    );
    expect(deviceDefaultDecodedBudgetBytes({ deviceMemory: 2 })).toBe(
      DECODED_BUDGET_LOW_DEVICE_BYTES,
    );
    expect(deviceDefaultDecodedBudgetBytes({ deviceMemory: 4 })).toBe(
      DECODED_BUDGET_MID_DEVICE_BYTES,
    );
    expect(deviceDefaultDecodedBudgetBytes({ deviceMemory: 8 })).toBe(
      DECODED_BUDGET_LARGE_DEVICE_BYTES,
    );
    // No deviceMemory (Safari / Firefox): the UA decides between the small
    // tier and the unknown-device figure — the same rule the compressed
    // cache applies.
    expect(
      deviceDefaultDecodedBudgetBytes({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      }),
    ).toBe(DECODED_BUDGET_LOW_DEVICE_BYTES);
    expect(
      deviceDefaultDecodedBudgetBytes({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1)',
      }),
    ).toBe(DECODED_BUDGET_UNKNOWN_DEVICE_BYTES);
    expect(deviceDefaultDecodedBudgetBytes({})).toBe(
      DECODED_BUDGET_UNKNOWN_DEVICE_BYTES,
    );
    // Sizes are ordered and all under the ~1.5 GB mobile tab-kill line.
    expect(DECODED_BUDGET_LOW_DEVICE_BYTES).toBeLessThan(
      DECODED_BUDGET_MID_DEVICE_BYTES,
    );
    expect(DECODED_BUDGET_MID_DEVICE_BYTES).toBeLessThan(
      DECODED_BUDGET_UNKNOWN_DEVICE_BYTES,
    );
    expect(DECODED_BUDGET_UNKNOWN_DEVICE_BYTES).toBeLessThan(
      DECODED_BUDGET_LARGE_DEVICE_BYTES,
    );
    expect(DECODED_BUDGET_LARGE_DEVICE_BYTES).toBeLessThanOrEqual(1536 * MIB);
  });

  it('the share is limit / owners, and unregister frees the share', () => {
    const budget = new DecodedMemoryBudget();
    budget.configure({ maxBytes: 256 * MIB });
    expect(budget.limit()).toBe(256 * MIB);
    expect(budget.share()).toBe(256 * MIB); // no owners: the whole limit

    const a = owner('a', 0);
    const b = owner('b', 0);
    budget.register(a);
    budget.register(b);
    expect(budget.ownerCount()).toBe(2);
    expect(budget.share()).toBe(128 * MIB);

    budget.unregister(a);
    expect(budget.ownerCount()).toBe(1);
    expect(budget.share()).toBe(256 * MIB);
    // Re-registering the same id replaces rather than double-counts.
    budget.register(b);
    expect(budget.ownerCount()).toBe(1);
  });

  it('configure ignores a degenerate limit and null restores the device default', () => {
    const budget = new DecodedMemoryBudget();
    const deviceDefault = budget.limit();
    budget.configure({ maxBytes: 100 * MIB });
    expect(budget.limit()).toBe(100 * MIB);
    budget.configure({ maxBytes: 0 });
    expect(budget.limit()).toBe(100 * MIB);
    budget.configure({ maxBytes: Number.NaN });
    expect(budget.limit()).toBe(100 * MIB);
    budget.configure({ maxBytes: null });
    expect(budget.limit()).toBe(deviceDefault);
  });

  it('total sums the owners; enforce asks the owners furthest over their share, most-over first, for no more than the overrun needs', () => {
    const budget = new DecodedMemoryBudget();
    budget.configure({ maxBytes: 300 });
    const a = owner('a', 200);
    const b = owner('b', 90);
    const c = owner('c', 10);
    for (const o of [a, b, c]) budget.register(o);
    expect(budget.total()).toBe(300);
    // At the limit: nothing to do, nobody asked.
    expect(budget.enforce()).toBe(0);
    expect(a.evictCalls).toEqual([]);

    // 50 over. Share = 100: `a` is 150 over it, `c` under, `b` under.
    a.bytes = () => 250;
    let held = 250;
    a.bytes = () => held;
    a.evictToward = (target: number): number => {
      a.evictCalls.push(target);
      const before = held;
      held = Math.min(held, target);
      return before - held;
    };
    expect(budget.total()).toBe(350);
    expect(budget.enforce()).toBe(50);
    // `a` was asked to go to 200 (its 250 minus the 50 overrun), not all
    // the way to its 100 share; `b` and `c` were not asked at all.
    expect(a.evictCalls).toEqual([200]);
    expect(b.evictCalls).toEqual([]);
    expect(c.evictCalls).toEqual([]);
    expect(budget.total()).toBe(300);
  });

  it('enforce walks owners most-over first and stops once the total fits', () => {
    const budget = new DecodedMemoryBudget();
    budget.configure({ maxBytes: 200 });
    const a = owner('a', 150); // 50 over the 100 share
    const b = owner('b', 130); // 30 over
    budget.register(a);
    budget.register(b);
    // 80 over: `a` (most over) is asked first for its share, which frees 50;
    // `b` is then asked for the remaining 30 (to 100).
    expect(budget.enforce()).toBe(80);
    expect(a.evictCalls).toEqual([100]);
    expect(b.evictCalls).toEqual([100]);
    expect(budget.total()).toBe(200);
  });

  it('a re-entrant enforce (an owner evicting notifies back) is a no-op', () => {
    const budget = new DecodedMemoryBudget();
    budget.configure({ maxBytes: 100 });
    let held = 150;
    let inner = -1;
    const a: DecodedMemoryOwner = {
      id: 'a',
      bytes: () => held,
      evictToward(target: number): number {
        inner = budget.enforce(); // what a delivery-driven pass would do
        const before = held;
        held = Math.min(held, target);
        return before - held;
      },
    };
    budget.register(a);
    expect(budget.enforce()).toBe(50);
    expect(inner).toBe(0);
    expect(budget.total()).toBe(100);
  });
});
