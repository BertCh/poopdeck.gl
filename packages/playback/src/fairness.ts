// @poopdeck.gl/playback
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/playback contributors

/**
 * Multi-source fair-share WEIGHT policy (BH-3, §11.3 of
 * docs/roadmap/optimization-implementation-plan-2026-08.md).
 *
 * The governor's fairness pass has two levers: a run-ahead CAP (Shaka-style,
 * unchanged — see `PlaybackGovernor.sendRunAheadCap`) and the fair-share WEIGHT
 * each required source carries into the process-shared request scheduler. This
 * module owns the second one, as pure functions of the probe vector, so the
 * policy is unit-testable without a clock, a network, or a tileset.
 *
 * Why the incumbent `1/x` shed was not enough. It compared RUNWAYS — sim-time —
 * while the constrained resource is BYTES. Two sources whose runways are the
 * same distance behind the leader are not equally behind: one may need 10 MB to
 * catch up and the other 100 KB. Handing them equal share equalizes the wrong
 * quantity, and (with the byte-metered DRR of BH-1 underneath) the heavier one
 * stays the laggard for ten times as long. The fill below therefore prices each
 * source's deficit in bytes — `N_i = β_i × deficit_i`, where β_i is the source's
 * measured byte density at ITS OWN frontier — and hands out share in proportion
 * to `N_i`, which equalizes TIME-TO-GATE rather than sim-time runway.
 *
 * Bytes-blind sources degrade, they do not break: β falls back to 1 and the fill
 * collapses to a runway-only shed (see `computeProgressiveFillWeights`).
 */

/** Floor of the shed: no source is ever de-weighted below a quarter of base. */
export const FAIRNESS_WEIGHT_MIN = 0.25;
/** Ceiling of the gain: no source is ever weighted above 4× base. */
export const FAIRNESS_WEIGHT_MAX = 4;

/**
 * One incomplete REQUIRED source, as the weight policy sees it. The governor
 * builds these from the same per-evaluation probe sweep the frontier fold uses
 * — no extra `getBufferedRunway` calls.
 */
export interface ProgressiveFillProbe {
  /** Registry id the weight is written back against. */
  id: string;
  /** Contiguous sim-ms this source has resident ahead of the playhead. */
  runwaySimMs: number;
  /**
   * Byte density at this source's frontier (bytes of still-missing data per
   * sim-ms of runway it must still buy). `≤ 0` / non-finite means "bytes-blind"
   * and is read as `1`, which reduces the fill to the runway-only shed.
   */
  betaBytesPerSimMs: number;
  /** The registered (base) fair-share weight the gain multiplies. */
  baseWeight: number;
}

/** Total-order tiebreak so the fill order never depends on Map iteration. */
function byRunwayThenId(
  a: ProgressiveFillProbe,
  b: ProgressiveFillProbe,
): number {
  if (a.runwaySimMs !== b.runwaySimMs) return a.runwaySimMs - b.runwaySimMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** β, sanitized: a blind or nonsensical density is read as 1 (runway-only). */
function safeBeta(beta: number): number {
  return Number.isFinite(beta) && beta > 0 ? beta : 1;
}

function clampGain(gain: number): number {
  return Math.min(FAIRNESS_WEIGHT_MAX, Math.max(FAIRNESS_WEIGHT_MIN, gain));
}

/**
 * Progressive filling toward equalized TIME-TO-GATE.
 *
 * The fill target is the LEADING incomplete required frontier less the fairness
 * slack (`slackSimMs` — the same dead-weight boundary the run-ahead cap uses):
 * a source already within slack of the leader is at the cap horizon and needs
 * nothing, which is also what keeps a near-tie from shedding anybody (the
 * deadband that makes the 20% write throttle upstream effective).
 *
 * For every probe:
 *
 *   `N_i = β_i × max(0, (r_lead − slack) − r_i)`      (bytes still to buy)
 *   `w_i = base_i × clamp(4 × N_i / max_j N_j, 0.25, 4)`
 *
 * i.e. weights proportional to byte need, normalized so the neediest source
 * (the laggard) lands on `4 × base` and every source whose need is already met
 * falls to the `0.25 × base` floor. Sources in between land in between — a
 * source with half the laggard's need gets half its share. The loop runs over
 * sources sorted by runway (neediest first, id as the total tiebreak) and stops
 * where the clamps bind, which is the fixed point of the standard
 * progressive-filling loop when each source's fill rate is its own need.
 *
 * Degenerate cases all collapse to the incumbent behaviour — every source at
 * its registered base weight, which the governor's write throttle then turns
 * into zero writes:
 *  - no probes;
 *  - every probe already within slack of the leader (no dispersion in need);
 *  - a non-finite runway anywhere (a complete source leaked into the vector).
 *
 * Pure and deterministic: same probe vector ⇒ same map, no clock, no RNG, no
 * insertion-order dependence.
 */
export function computeProgressiveFillWeights(
  probes: readonly ProgressiveFillProbe[],
  slackSimMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (probes.length === 0) return out;
  const ordered = [...probes].sort(byRunwayThenId);
  // Default for every degenerate exit below: the registered base weight.
  for (const p of ordered) out.set(p.id, p.baseWeight);

  let leadSimMs = -Infinity;
  for (const p of ordered) {
    if (p.runwaySimMs > leadSimMs) leadSimMs = p.runwaySimMs;
  }
  if (!Number.isFinite(leadSimMs)) return out;
  const slack = Number.isFinite(slackSimMs) && slackSimMs > 0 ? slackSimMs : 0;
  const fillTarget = leadSimMs - slack;

  const needs: number[] = [];
  let needMax = 0;
  for (const p of ordered) {
    const deficit = fillTarget - p.runwaySimMs;
    const raw = deficit > 0 ? safeBeta(p.betaBytesPerSimMs) * deficit : 0;
    const need = Number.isFinite(raw) ? raw : 0;
    needs.push(need);
    if (need > needMax) needMax = need;
  }
  // No dispersion in need (everyone inside the slack band, or the whole vector
  // bytes-free): nothing to redistribute — leave every source at base.
  if (!(needMax > 0) || !Number.isFinite(needMax)) return out;

  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    // share ∈ [0, 1]; exactly 1 for the neediest, 0 for a satisfied source.
    const share = needs[i] / needMax;
    out.set(p.id, p.baseWeight * clampGain(FAIRNESS_WEIGHT_MAX * share));
  }
  return out;
}

/**
 * The incumbent `1/x` runway shed, kept as the NAMED FALLBACK for one release
 * (the BH-3 rollback line): `clamp((slack + r_laggard) / (slack + r_i),
 * 0.25, 4)`, which lands the laggard exactly on base and sheds leaders toward
 * the floor. Runway-only — it cannot see that one source's deficit costs ten
 * times the bytes of another's, which is the whole reason the fill replaced it.
 *
 * Still exported (and still tested) so the swap back is a one-line change in
 * `playback-governor.ts` rather than an archaeology exercise.
 */
export function legacyRunwayShedWeight(
  runwaySimMs: number,
  laggardSimMs: number,
  slackSimMs: number,
): number {
  return clampGain((slackSimMs + laggardSimMs) / (slackSimMs + runwaySimMs));
}

/**
 * Vector form of {@link legacyRunwayShedWeight} — same shape as
 * {@link computeProgressiveFillWeights} so the governor can swap one for the
 * other behind a single constant. The laggard is the min runway in the vector.
 */
export function computeRunwayShedWeights(
  probes: readonly ProgressiveFillProbe[],
  slackSimMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (probes.length === 0) return out;
  let laggardSimMs = Infinity;
  for (const p of probes) {
    if (p.runwaySimMs < laggardSimMs) laggardSimMs = p.runwaySimMs;
  }
  for (const p of [...probes].sort(byRunwayThenId)) {
    out.set(
      p.id,
      p.baseWeight *
        legacyRunwayShedWeight(p.runwaySimMs, laggardSimMs, slackSimMs),
    );
  }
  return out;
}
