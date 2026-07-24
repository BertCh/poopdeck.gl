// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * TSL node mirror of `./data-filter-math.ts` — the Three port of deck's
 * `DataFilterExtension` (poopdeck's general-column sibling of the time filter).
 * It is a GPU range filter over ONE baked numeric column (`filterSize: 1`):
 * features whose per-feature `filterValue` falls inside `[filterRange]` render,
 * others collapse; an optional `filterSoftRange` inside the hard range fades
 * features across the margin instead of hard-clipping.
 *
 * Usage mirrors `./time-filter.ts`: a material binds a per-instance / per-vertex
 * `sttFilterValue` attribute node, holds a {@link DataFilterUniforms}, and
 * consumes TWO complementary nodes:
 *
 *   • {@link dataFilterVisibleNode} — a hard `0 | 1` — is multiplied into the
 *     primitive's per-instance / per-vertex SIZE / SCALE in the VERTEX stage
 *     (alongside the time filter's own visible gate), so an out-of-range
 *     primitive collapses to zero extent and dies at assembly (zero fragment
 *     cost, keeps early-Z; deck.gl #7509). `filterValue` is per-FEATURE (every
 *     vertex of a feature shares it), so a feature always collapses as a whole —
 *     no end is left pinned at the origin (the trap the time filter's per-vertex
 *     trail mode has to dodge).
 *   • {@link dataFilterAlphaNode} — a soft `[0, 1]` — feeds `opacityNode` in the
 *     FRAGMENT stage for the `filterSoftRange` fade band. It respects
 *     `filterTransformColor` (returns `1` when off) and idles to `1` when the
 *     filter is disabled, so multiplying it in is always safe.
 *
 * WGSL: the soft alpha is built branch-free from `mix()` / `step()` / arithmetic
 * `smoothstep` (no `select()`), so it is varying-safe — the material varies the
 * raw `sttFilterValue` and recomputes the alpha in the fragment stage, never
 * wrapping the node in a `varying()` (the recurring WGSL crash). The visible
 * gate is likewise branch-free.
 *
 * Composes with {@link TimeFilterUniforms}: distinct uniform object, distinct
 * attribute (`sttFilterValue` vs `sttStart`/`sttEnd`), so the temporal window and
 * the column filter multiply independently into both size and opacity.
 *
 * The CPU functions in `./data-filter-math.ts` are the unit-tested source of
 * truth for the range math AND the deck-prop → uniform resolution; keep the two
 * in lockstep.
 */

import { uniform, float, mix, step, saturate, max } from './nodes.js';
import type { TSLNode, UniformNode } from './nodes.js';
import {
  resolveDataFilter,
  type DataFilterOptions,
  type DataFilterRange,
} from './data-filter-math.js';

export type { DataFilterRange, DataFilterOptions };

/** Guards divisions by a zero (or inverted) soft-ramp width. Matches the CPU EPS. */
const EPS = 1e-6;

/**
 * The scalar uniforms both stages read. One instance per material; the scene
 * loop pushes `.value` each tick via {@link updateDataFilterUniforms}. Defaults
 * idle the filter (`enabled = 0` → every feature renders) so an installed-but-
 * unconfigured filter is a no-op — the deck extension's `enabled`-gate posture.
 */
export class DataFilterUniforms {
  readonly filterMin: UniformNode = uniform(0);
  readonly filterMax: UniformNode = uniform(0);
  readonly filterSoftMin: UniformNode = uniform(0);
  readonly filterSoftMax: UniformNode = uniform(0);
  /** 1 when the filter is active (enabled + a finite range), else 0. */
  readonly enabled: UniformNode = uniform(0);
  /** 1 when a finite soft range is supplied (smoothstep fade), else 0. */
  readonly useSoftMargin: UniformNode = uniform(0);
  readonly transformSize: UniformNode = uniform(1);
  readonly transformColor: UniformNode = uniform(1);
}

/**
 * `smoothstep(e0, e1, x)` as a node graph — nodes.ts exposes no `smoothstep`
 * builder (and is out of this module's edit lane), so it is composed from
 * `saturate` + arithmetic. The denominator is EPS-guarded exactly like the CPU
 * mirror, so an inverted / zero-width ramp (soft edge past the hard edge) yields
 * a finite value that the hard-vs-soft `step()` selector then masks out.
 */
function smoothstepNode(e0: TSLNode, e1: TSLNode, x: TSLNode): TSLNode {
  const t = saturate(x.sub(e0).div(max(e1.sub(e0), float(EPS))));
  return t.mul(t).mul(float(3).sub(t.mul(2)));
}

/**
 * Hard visibility node — the vertex-collapse companion to
 * {@link dataFilterAlphaNode}. Materials MULTIPLY this into their per-instance /
 * per-vertex size / scale (vertex stage). `filterValue` is the raw per-feature
 * attribute node. `1` when the filter idles (`enabled = 0`).
 */
export function dataFilterVisibleNode(
  u: DataFilterUniforms,
  filterValue: TSLNode,
): TSLNode {
  // filterValue >= filterMin AND filterValue <= filterMax.
  const hardStep = step(u.filterMin, filterValue).mul(
    step(filterValue, u.filterMax),
  );
  return mix(float(1), hardStep, u.enabled);
}

/**
 * Soft opacity node — the `filterSoftRange` fade band, for `opacityNode` in the
 * fragment stage. `filterValue` should be the VARIED raw attribute node.
 * Returns `1` when the filter idles or `filterTransformColor` is off; inside the
 * hard range it is the smoothstep fade (a hard `1` with no soft range); outside
 * the hard range it is `0` (the primitive is already collapsed there anyway).
 */
export function dataFilterAlphaNode(
  u: DataFilterUniforms,
  filterValue: TSLNode,
): TSLNode {
  const leftInRange = mix(
    smoothstepNode(u.filterMin, u.filterSoftMin, filterValue),
    step(u.filterMin, filterValue),
    step(u.filterSoftMin, u.filterMin),
  );
  const rightInRange = mix(
    float(1).sub(smoothstepNode(u.filterSoftMax, u.filterMax, filterValue)),
    step(filterValue, u.filterMax),
    step(u.filterMax, u.filterSoftMax),
  );
  const softFade = leftInRange.mul(rightInRange);
  return mix(float(1), softFade, u.enabled.mul(u.transformColor));
}

/**
 * Push deck-shaped filter props into the uniforms. Resolves through the shared
 * {@link resolveDataFilter} (the CPU source of truth), so the GPU and CPU stay
 * in exact lockstep. Call once per frame (or whenever the range animates).
 */
export function updateDataFilterUniforms(
  u: DataFilterUniforms,
  opts: DataFilterOptions = {},
): void {
  const r = resolveDataFilter(opts);
  u.filterMin.value = r.filterMin;
  u.filterMax.value = r.filterMax;
  u.filterSoftMin.value = r.filterSoftMin;
  u.filterSoftMax.value = r.filterSoftMax;
  u.enabled.value = r.enabled;
  u.useSoftMargin.value = r.useSoftMargin;
  u.transformSize.value = r.transformSize;
  u.transformColor.value = r.transformColor;
}
