// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * CollisionFilterExtension — thin poopdeck adapter.
 *
 * deck.gl's `CollisionFilterExtension` hides overlapping objects (de-clutter
 * icons / text labels). Its **constant** configuration
 * (`collisionEnabled` / `collisionGroup` / `collisionTestProps`) already works
 * on the STT layers **today** via the plain top-level `extensions` prop — the
 * extension's `getSubLayerProps` pass forwards those scalars from the composite
 * onto every binary sublayer, exactly like Brushing / Mask / Clip
 * (see `test/extensions-passthrough.test.ts`). This module exists to make that
 * one-import ergonomic and to spell out the one genuinely data-driven knob.
 *
 * ## What works (constant)
 * ```ts
 * import { AnimatedIconLayer, collisionFilterProps } from '@poopdeck.gl/layers';
 *
 * new AnimatedIconLayer({
 *   // …tileset / icon props…
 *   ...collisionFilterProps({ collisionEnabled: true, collisionGroup: 'labels' }),
 * });
 * ```
 *
 * ## What is deferred (`collisionPriorityProperty`, data-driven ranking)
 * deck ranks colliding features by `getCollisionPriority`, an accessor. On a
 * binary tile there are no JS rows to run an accessor over, so a data-driven
 * priority has to arrive as a `collisionPriorities` **instanced attribute**
 * baked from a tile column — the same shape as the (ported) DataFilter /
 * TimeFilter `filterValue` attribute. The STT layers do **not** emit that
 * attribute yet, and this wrapper cannot inject an attribute into a sublayer's
 * binary `data.attributes` from the outside. So per the audit's guidance we
 * ship the honest constant helper and **do not force** the data-driven path:
 * passing `collisionPriorityProperty` warns once and falls back to the
 * constant `collisionPriority` (all features rank equally). Wiring it for real
 * is a layer-level follow-up (audit Tier 3, tracked alongside DataFilter).
 *
 * A **constant** `collisionPriority` (e.g. always rank this whole layer above
 * another group) does work and is forwarded verbatim.
 *
 * ## Spread safety
 * The helper's result is meant to be SPREAD, so it emits `getCollisionPriority`
 * only when you actually asked for a priority. Route your own accessor through
 * the helper (`collisionFilterProps({getCollisionPriority: d => d.rank})`)
 * rather than setting it next to the spread, where key order decides the
 * winner.
 */

import { CollisionFilterExtension } from '@deck.gl/extensions';
import type { Accessor, LayerExtension } from '@deck.gl/core';
import { warnOnce } from '../lib/log.js';

// Re-export so consumers get the extension and the helper from one module —
// the constant passthrough case can also just do `extensions: [new
// CollisionFilterExtension()]` directly.
export { CollisionFilterExtension };

/** deck's documented priority clamp. Values outside are meaningless. */
export const COLLISION_PRIORITY_MIN = -1000;
export const COLLISION_PRIORITY_MAX = 1000;

export interface CollisionFilterOptions<DataT = unknown> {
  /**
   * Enable/disable collisions. When disabled every object renders.
   * @default true
   */
  collisionEnabled?: boolean;
  /**
   * Collision group this layer belongs to. Layers in different groups never
   * collide with each other. Defaults to deck's `'default'` group when omitted.
   */
  collisionGroup?: string;
  /**
   * Props overridden while deck renders the (hidden) collision map — e.g.
   * `{ radiusScale: 2 }` to reserve extra space around each icon.
   */
  collisionTestProps?: Record<string, unknown>;
  /**
   * CONSTANT collision priority in `[-1000, 1000]`; higher wins. Applies to
   * every feature in the layer (rank a whole layer above/below another).
   * Out-of-range values are clamped with a one-time warning.
   *
   * OMITTED BY DEFAULT: when neither this nor {@link getCollisionPriority} is
   * supplied, the returned props carry NO `getCollisionPriority` key at all, so
   * spreading them can never overwrite an accessor already set on the layer.
   * @default undefined (deck's own default of 0 applies)
   */
  collisionPriority?: number;
  /**
   * deck's real `getCollisionPriority` ACCESSOR, routed through this helper so
   * the spread cannot clobber it.
   *
   * `...collisionFilterProps({…})` is a prop spread: whatever it returns wins
   * over keys written EARLIER in the object literal. The helper used to always
   * emit `getCollisionPriority: 0`, so
   * `new AnimatedIconLayer({getCollisionPriority: d => d.rank,
   * ...collisionFilterProps({collisionEnabled: true})})` silently flattened
   * every feature to priority 0 and de-clutter became arbitrary — easy to miss
   * because the option is spelled `collisionPriority`, not
   * `getCollisionPriority`. Pass the accessor here instead (or put the spread
   * FIRST). Supplying both this and `collisionPriority` warns once; this wins.
   *
   * A FUNCTION accessor only runs where deck has JS rows to run it over —
   * binary STT tiles do not, so on those a function is inert. See the module
   * doc for the deferred baked-column path.
   */
  getCollisionPriority?: Accessor<DataT, number>;
  /**
   * DEFERRED — a baked tile column name for per-feature priority. Not wired in
   * the layers yet (needs a `collisionPriorities` instanced attribute, a
   * layer-level change). Passing it warns once and falls back to the constant
   * `collisionPriority`. See the module doc.
   */
  collisionPriorityProperty?: string;
  /**
   * Existing extensions to compose with. A `CollisionFilterExtension` already
   * present is reused (not duplicated); everything else is preserved.
   * @default []
   */
  extensions?: LayerExtension[];
}

/**
 * Props returned by {@link collisionFilterProps}, spreadable onto any STT
 * layer. Optional keys are OMITTED (not defaulted) when the caller did not ask
 * for them, so the spread never overwrites a prop the layer already set.
 */
export interface CollisionFilterProps<DataT = unknown> {
  extensions: LayerExtension[];
  collisionEnabled: boolean;
  collisionGroup?: string;
  collisionTestProps?: Record<string, unknown>;
  /**
   * Present ONLY when the caller supplied `collisionPriority` or
   * `getCollisionPriority`. Matches deck's own `Accessor<DataT, number>` type
   * rather than pinning a constant.
   */
  getCollisionPriority?: Accessor<DataT, number>;
}

/** One shared instance — a constant extension set keeps the sublayer shader cache warm. */
const SHARED_COLLISION_EXTENSION = new CollisionFilterExtension();

function clampPriority(value: number): number {
  if (value < COLLISION_PRIORITY_MIN || value > COLLISION_PRIORITY_MAX) {
    warnOnce(
      'collisionFilter:priorityRange',
      `[collisionFilterProps] collisionPriority ${value} is outside deck's ` +
        `[${COLLISION_PRIORITY_MIN}, ${COLLISION_PRIORITY_MAX}] range; clamping.`,
    );
    return Math.max(
      COLLISION_PRIORITY_MIN,
      Math.min(COLLISION_PRIORITY_MAX, value),
    );
  }
  return value;
}

/**
 * Build the props needed to attach deck's `CollisionFilterExtension` to an STT
 * layer. Spread the result onto the layer — it merges the extension into any
 * `extensions` you already pass and wires the constant collision props.
 *
 * `getCollisionPriority` is emitted ONLY when the caller asked for a priority
 * (via `collisionPriority` or `getCollisionPriority`), so the spread can never
 * clobber an accessor the layer already carries. STT tiles are binary, so a
 * per-feature FUNCTION accessor is inert on them — see the module doc for the
 * deferred baked-column path.
 */
export function collisionFilterProps<DataT = unknown>(
  options: CollisionFilterOptions<DataT> = {},
): CollisionFilterProps<DataT> {
  const {
    collisionEnabled = true,
    collisionGroup,
    collisionTestProps,
    collisionPriority,
    getCollisionPriority,
    collisionPriorityProperty,
    extensions = [],
  } = options;

  if (collisionPriorityProperty !== undefined) {
    warnOnce(
      'collisionFilter:priorityProperty',
      `[collisionFilterProps] collisionPriorityProperty ` +
        `("${collisionPriorityProperty}") is not wired yet: per-feature ` +
        'collision priority needs a baked `collisionPriorities` attribute ' +
        '(a layer-level change). Falling back to the constant ' +
        `collisionPriority (${collisionPriority ?? 0}) — every feature ranks equally.`,
    );
  }

  if (collisionPriority !== undefined && getCollisionPriority !== undefined) {
    warnOnce(
      'collisionFilter:priorityConflict',
      '[collisionFilterProps] both `collisionPriority` (a constant) and ' +
        '`getCollisionPriority` (an accessor) were supplied; the accessor ' +
        `wins and the constant (${collisionPriority}) is ignored.`,
    );
  }

  // Reuse a CollisionFilterExtension the caller already passed; otherwise add
  // the shared one. Keeps the extension set stable (shader-cache contract).
  const hasCollision = extensions.some(
    (e) => e instanceof CollisionFilterExtension,
  );
  const mergedExtensions = hasCollision
    ? extensions
    : [...extensions, SHARED_COLLISION_EXTENSION];

  const props: CollisionFilterProps<DataT> = {
    extensions: mergedExtensions,
    collisionEnabled,
  };
  // Only WRITE the key when a priority was actually requested — otherwise the
  // spread would overwrite a caller's own `getCollisionPriority` accessor with
  // a constant and flatten every feature's rank.
  if (getCollisionPriority !== undefined) {
    props.getCollisionPriority =
      typeof getCollisionPriority === 'number'
        ? clampPriority(getCollisionPriority)
        : getCollisionPriority;
  } else if (collisionPriority !== undefined) {
    props.getCollisionPriority = clampPriority(collisionPriority);
  }
  if (collisionGroup !== undefined) props.collisionGroup = collisionGroup;
  if (collisionTestProps !== undefined)
    props.collisionTestProps = collisionTestProps;
  return props;
}
