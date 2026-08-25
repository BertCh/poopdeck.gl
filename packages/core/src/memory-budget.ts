// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Process-wide DECODED-byte budget shared by every live tileset (A4,
 * tile-loading audit 2026-08).
 *
 * Decoded tile caches are per tileset, but memory pressure is per process.
 * The default was 2 GiB per `SpatioTemporalTileset` with no device
 * awareness, and a composite's per-tileset floors SUMMED past any budget
 * (storm-4d: ten sources, 5 GiB nominal). The COMPRESSED byte cache already
 * solved this shape for itself — `sharedByteCacheLru` in archive.ts is one
 * device-sized ceiling every archive registers against. This is the same
 * idea for decoded bytes, with one difference forced by ownership: decoded
 * tiles live in each tileset's registry under its playhead-relative tiered
 * eviction, so the budget cannot evict them itself. It hands each owner a
 * SHARE, and when the process total still overruns the limit it asks the
 * owners furthest over their share to evict toward it through their own
 * policy.
 *
 * The share is the plain fair split `limit / owners`. A usage-proportional
 * split is deliberately out of scope (the audit's smallest sound change).
 */

/** A registered holder of decoded bytes — a tileset, in practice. */
export interface DecodedMemoryOwner {
  /** Unique per registration; re-registering the same id replaces. */
  readonly id: string;
  /** Decoded bytes currently resident with this owner. */
  bytes(): number;
  /**
   * Evict resident bytes down toward `targetBytes` through the owner's own
   * eviction policy. Returns the bytes released; an owner whose remaining
   * bytes are all needed or pinned may release less than asked.
   */
  evictToward(targetBytes: number): number;
}

export interface DecodedMemoryBudgetConfig {
  /**
   * Process-wide ceiling on decoded bytes, or `null`/absent to return to the
   * device default. Non-finite or non-positive values are ignored.
   */
  maxBytes?: number | null;
}

/** The `navigator` subset the device default is derived from. */
export interface DeviceMemoryHints {
  deviceMemory?: number;
  userAgent?: string;
}

const MIB = 1024 * 1024;

/** `navigator.deviceMemory ≤ 2` GB — iOS Safari / low-end Android territory. */
export const DECODED_BUDGET_LOW_DEVICE_BYTES = 384 * MIB;
/** `navigator.deviceMemory ≤ 4` GB. */
export const DECODED_BUDGET_MID_DEVICE_BYTES = 768 * MIB;
/** More than 4 GB. */
export const DECODED_BUDGET_LARGE_DEVICE_BYTES = 1536 * MIB;
/** No `deviceMemory` at all (Safari, Firefox, node) and no mobile UA. */
export const DECODED_BUDGET_UNKNOWN_DEVICE_BYTES = 1024 * MIB;

/**
 * The device-derived default. Same tiers and the same mobile-UA fallback the
 * compressed cache uses (`getDeviceAwareCacheSize` in archive.ts): browsers
 * that expose `deviceMemory` are bucketed on it, a mobile UA without it is
 * treated as the small tier, and everything else gets the unknown-device
 * figure — iOS Safari kills tabs around 1–1.5 GB, so the ceiling stays under
 * that even where nothing is known.
 */
export function deviceDefaultDecodedBudgetBytes(
  hints?: DeviceMemoryHints,
): number {
  const nav =
    hints ??
    (typeof navigator !== 'undefined'
      ? (navigator as DeviceMemoryHints)
      : undefined);
  const gb = nav?.deviceMemory;
  if (typeof gb === 'number' && Number.isFinite(gb) && gb > 0) {
    if (gb <= 2) return DECODED_BUDGET_LOW_DEVICE_BYTES;
    if (gb <= 4) return DECODED_BUDGET_MID_DEVICE_BYTES;
    return DECODED_BUDGET_LARGE_DEVICE_BYTES;
  }
  if (
    typeof nav?.userAgent === 'string' &&
    /mobile|android|iphone|ipad/i.test(nav.userAgent)
  ) {
    return DECODED_BUDGET_LOW_DEVICE_BYTES;
  }
  return DECODED_BUDGET_UNKNOWN_DEVICE_BYTES;
}

export class DecodedMemoryBudget {
  private readonly owners = new Map<string, DecodedMemoryOwner>();
  /** Caller-configured ceiling; `null` = the device default. */
  private configuredMax: number | null = null;
  /** The device default, resolved once on first use. */
  private deviceMax: number | null = null;
  /** Re-entrancy guard: an owner's eviction may notify back into `enforce`. */
  private enforcing = false;

  configure(config: DecodedMemoryBudgetConfig): void {
    const max = config.maxBytes;
    if (max === undefined || max === null) {
      this.configuredMax = null;
      return;
    }
    if (!Number.isFinite(max) || max <= 0) return;
    this.configuredMax = max;
  }

  /** The device-derived default (see {@link deviceDefaultDecodedBudgetBytes}). */
  deviceDefault(hints?: DeviceMemoryHints): number {
    return deviceDefaultDecodedBudgetBytes(hints);
  }

  /** The process-wide ceiling in effect. */
  limit(): number {
    if (this.configuredMax !== null) return this.configuredMax;
    if (this.deviceMax === null) this.deviceMax = this.deviceDefault();
    return this.deviceMax;
  }

  register(owner: DecodedMemoryOwner): void {
    this.owners.set(owner.id, owner);
  }

  unregister(owner: DecodedMemoryOwner | string): void {
    this.owners.delete(typeof owner === 'string' ? owner : owner.id);
  }

  ownerCount(): number {
    return this.owners.size;
  }

  /** The fair per-owner split, `limit / owners` (the whole limit with none). */
  share(): number {
    return this.limit() / Math.max(1, this.owners.size);
  }

  /** Decoded bytes resident across every registered owner. */
  total(): number {
    let total = 0;
    for (const owner of this.owners.values()) total += owner.bytes();
    return total;
  }

  /**
   * When the process total exceeds the limit, ask the owners over their
   * share to evict toward it — most-over first, each asked for no more than
   * the overrun still needs — until the total fits or nobody can release
   * more. Returns the bytes released. A re-entrant call is a no-op.
   */
  enforce(): number {
    if (this.enforcing) return 0;
    const limit = this.limit();
    let total = this.total();
    if (total <= limit) return 0;
    this.enforcing = true;
    let released = 0;
    try {
      const share = this.share();
      const ranked = Array.from(this.owners.values())
        .map((owner) => ({ owner, over: owner.bytes() - share }))
        .filter((r) => r.over > 0)
        .sort((a, b) => b.over - a.over);
      for (const { owner } of ranked) {
        if (total <= limit) break;
        const before = owner.bytes();
        // Toward the share, but never further than the overrun requires.
        const target = Math.max(share, before - (total - limit));
        owner.evictToward(target);
        const freed = Math.max(0, before - owner.bytes());
        released += freed;
        total -= freed;
      }
    } finally {
      this.enforcing = false;
    }
    return released;
  }

  /** Test seam: drop every owner, the configured limit and the cached default. */
  reset(): void {
    this.owners.clear();
    this.configuredMax = null;
    this.deviceMax = null;
  }
}

/** The process singleton every tileset registers with. */
export const decodedMemoryBudget = new DecodedMemoryBudget();
