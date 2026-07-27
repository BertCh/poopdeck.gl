// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Exhaustive prop classification + the sublayer-cache key built from it.
 *
 * THE DEFECT THIS PREVENTS. The animated layers cache their deck.gl sublayer
 * instances per tile and rebuild them only when a layer-wide key changes. A
 * prop whose value is baked into a cached sublayer but is ABSENT from that key
 * is a silent rendering bug: editing the prop leaves the stale sublayers on
 * screen, and only for that one prop, and only at runtime. A hand-enumerated
 * key array has nothing tying it to the props type, so the omission is
 * invisible until someone looks at the map.
 *
 * THE FIX. Each layer declares its OWN props in a `_XxxLayerProps` interface,
 * separate from the inherited {@link SpatioTemporalLayerProps}. Annotating a
 * table as {@link PropEffects}`<_XxxLayerProps>` makes it a total function from
 * that interface's keys to a cache effect, so adding a prop to the interface
 * without classifying it is a COMPILE error, not a rendering bug.
 *
 * USAGE. Bind the props type on the table (that annotation is what enforces
 * exhaustiveness) and pass it explicitly at the call site so `overrides` keys
 * are checked too:
 *
 * ```ts
 * const PROP_EFFECTS: PropEffects<_AnimatedPointLayerProps> = {
 *   radiusScale: 'sublayer',
 *   colorPalette: 'prepare',
 *   // …every remaining key, or tsc fails
 * };
 *
 * private computeLayerPropsKey(): string {
 *   return buildLayerPropsKey<_AnimatedPointLayerProps>(this.props, PROP_EFFECTS, {
 *     overrides: { radius: this.radiusValue(), strokeWidth: this.lineWidthValue() },
 *     extra: [inheritedPropsDigest(this.props), updateTriggersDigest(this.props.updateTriggers)],
 *   });
 * }
 * ```
 *
 * WHEN UNSURE, CLASSIFY AS `'sublayer'`. An over-broad key costs a rebuild
 * (performance); an under-broad key costs correctness.
 *
 * @internal
 */

import { structuralDigest } from './style-digest.js';

/**
 * Where a prop's value ends up, which determines whether editing it has to
 * invalidate the per-tile sublayer cache.
 *
 * - `'sublayer'` — the value is read while CONSTRUCTING a sublayer, so a
 *   cached instance holds a frozen copy of it. Included in the key.
 * - `'prepare'` — the value is read while building a tile's prepared
 *   attributes, and is already covered by that layer's `styleKey` /
 *   `preparedKey`. Excluded from the key; a change re-prepares the tile, which
 *   invalidates the sublayer through the prepared-object identity check.
 * - `'uniform'` — the value reaches the GPU as a per-frame uniform written
 *   through an extension or a `setState` path that does not touch sublayer
 *   construction. Excluded from the key.
 * - `'inert'` — the value never reaches rendering (legend text, callbacks the
 *   composite invokes itself, tuning knobs consumed outside the sublayers).
 *   Excluded from the key.
 *
 * CONSEQUENCE OF MISCLASSIFYING. Calling a sublayer-baked prop `'uniform'` or
 * `'inert'` — or `'prepare'` when the layer's `styleKey` does not actually
 * contain it — drops it from the key, and editing that prop then leaves stale
 * sublayers on screen. The reverse mistake (calling a uniform or prepare-only
 * prop `'sublayer'`) only rebuilds sublayers more often than strictly needed.
 * The classification is therefore deliberately biased: prefer `'sublayer'`.
 */
export type PropEffect = 'sublayer' | 'prepare' | 'uniform' | 'inert';

/**
 * Total classification of `P`'s keys. Annotating a table with this type is
 * what makes an unclassified prop a compile error: a missing key fails the
 * assignment, and a key that is not on `P` fails the object literal's excess
 * property check (so a prop that gets renamed or deleted cannot leave a
 * dangling entry behind).
 */
export type PropEffects<P> = Readonly<Record<keyof Required<P>, PropEffect>>;

/** Extra inputs folded into a key beyond the `'sublayer'`-classified props. */
export interface LayerPropsKeyOptions<P> {
  /**
   * Values that replace `props[key]` in the key, for props read through an
   * alias resolver rather than raw (`radius` vs `getRadius`, `strokeWidth` vs
   * `getLineWidth`, …). The sublayer is constructed from the RESOLVED value,
   * so the key has to track the resolved value: keying the raw prop leaves
   * every cached sublayer stale when only the alias changes.
   *
   * A key present here wins even when its value is `undefined`. An entry whose
   * prop is not classified `'sublayer'` is still folded into the key rather
   * than dropped, so a resolved value can never go missing by misclassification.
   */
  overrides?: Readonly<Partial<Record<keyof P, unknown>>>;
  /**
   * Composite digests that are not props of `P` — `inheritedPropsDigest`,
   * `updateTriggersDigest`, and any layer-specific derived value. Positional:
   * reordering the array changes the key.
   */
  extra?: readonly unknown[];
}

/**
 * `'sublayer'` keys of a table, sorted so the key never depends on the order
 * the table was written in. Memoized per table reference; layers declare their
 * table once at module scope, so this runs once per layer class.
 */
const sublayerKeyCache = new WeakMap<object, readonly string[]>();

function sublayerKeys(
  effects: Readonly<Record<string, PropEffect>>,
): readonly string[] {
  let keys = sublayerKeyCache.get(effects);
  if (keys === undefined) {
    keys = Object.keys(effects)
      .filter((key) => effects[key] === 'sublayer')
      .sort();
    sublayerKeyCache.set(effects, keys);
  }
  return keys;
}

/**
 * One `name=type:length:digest` segment.
 *
 * The type tag and the length prefix are what make the joined key injective.
 * Without the type tag `undefined`, `''`, `null` and the string `'null'` all
 * digest to indistinguishable text; without the length prefix a prop whose
 * string value contains the separator could impersonate the segment that
 * follows it. Either collision is a stale sublayer.
 */
function segment(name: string, value: unknown): string {
  const digest = structuralDigest(value);
  return `${name}=${typeof value}:${digest.length}:${digest}`;
}

/**
 * Cache key over exactly the props classified `'sublayer'`, plus `overrides`
 * and `extra`. Deterministic (keys are sorted, not taken in table order) and
 * content-stable (values serialize through {@link structuralDigest}, so an
 * equal-content array or object yields an equal key while a content change —
 * including in-place mutation — yields a different one).
 *
 * `P` does not infer from `props`: `this.props` also carries the inherited and
 * `Required<>`-widened base props, and inferring from it would demand that the
 * table classify those too. Bind `P` on the table's annotation, and pass it
 * explicitly here when `overrides` keys should be checked against it.
 */
export function buildLayerPropsKey<P extends object>(
  props: NoInfer<P>,
  effects: PropEffects<P>,
  opts?: LayerPropsKeyOptions<P>,
): string {
  const table = effects as Readonly<Record<string, PropEffect>>;
  const values = props as Readonly<Record<string, unknown>>;
  const overrides = opts?.overrides as Record<string, unknown> | undefined;

  const parts: string[] = [];
  for (const key of sublayerKeys(table)) {
    parts.push(
      segment(
        key,
        overrides && key in overrides ? overrides[key] : values[key],
      ),
    );
  }
  if (overrides) {
    for (const key of Object.keys(overrides).sort()) {
      if (table[key] === 'sublayer') continue;
      parts.push(segment(key, overrides[key]));
    }
  }
  const extra = opts?.extra;
  if (extra) {
    for (let i = 0; i < extra.length; i++)
      parts.push(segment(`~${i}`, extra[i]));
  }
  return parts.join('|');
}
