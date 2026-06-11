// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * Content digests for the animated layers' hand-rolled cache keys.
 *
 * The per-tile prepared-data caches key on a styleKey string assembled from
 * the style props. Keying a palette by `.length` (or a mapping by key-count)
 * let same-size content swaps render stale tiles. These helpers digest the
 * CONTENT instead, memoized per object reference in a WeakMap so the digest
 * is computed once per prop value — styleKey assembly stays a cheap string
 * join of cached parts even when called per tile per render.
 *
 * @internal
 */

import type { Color } from '@deck.gl/core';

const colorListDigests = new WeakMap<readonly Color[], string>();

/** Digest a palette / color ramp by its RGBA contents. Memoized per array reference. */
export function colorListDigest(colors: readonly Color[]): string {
  let digest = colorListDigests.get(colors);
  if (digest === undefined) {
    digest = colors.map((c) => c.join('.')).join(';');
    colorListDigests.set(colors, digest);
  }
  return digest;
}

const colorMappingDigests = new WeakMap<Record<string, Color>, string>();

/** Digest a category-string → color mapping by its entries. Memoized per object reference. */
export function colorMappingDigest(mapping: Record<string, Color>): string {
  let digest = colorMappingDigests.get(mapping);
  if (digest === undefined) {
    digest = Object.keys(mapping)
      .map((key) => `${key}:${mapping[key].join('.')}`)
      .join(';');
    colorMappingDigests.set(mapping, digest);
  }
  return digest;
}

const functionIds = new WeakMap<Function, number>();
let nextFunctionId = 1;

/**
 * Stable identity token for a function-valued prop (e.g. `radiusTransform`).
 * Function bodies can't be digested cheaply, so reference identity is the
 * invalidation contract: swapping in a different function reference yields a
 * different token and invalidates dependent caches.
 */
export function functionId(fn: (...args: any[]) => any): number {
  let id = functionIds.get(fn);
  if (id === undefined) {
    id = nextFunctionId++;
    functionIds.set(fn, id);
  }
  return id;
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

/** Reference-identity token for opaque object values (typed arrays, deep nests). */
function objectRefToken(obj: object): string {
  let id = objectIds.get(obj);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(obj, id);
  }
  return `#${id}`;
}

/** Recursion ceiling for {@link structuralDigest}; deeper values fall back to reference identity. */
const STRUCTURAL_DIGEST_MAX_DEPTH = 4;

/**
 * Cheap stable serialization of an arbitrary prop value for cache keys.
 * Primitives stringify, arrays/plain objects serialize structurally (sorted
 * keys), functions and classes digest by reference identity (`functionId`),
 * and typed arrays / over-deep nests fall back to a reference token. Strictly
 * stronger than deck's own shallow `updateTriggers` diff (which also misses
 * in-place mutation of a reused object).
 */
export function structuralDigest(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return '';
    case 'function':
      return `fn#${functionId(value as (...args: any[]) => any)}`;
    case 'object':
      break;
    default:
      return String(value);
  }
  const obj = value as object;
  if (depth >= STRUCTURAL_DIGEST_MAX_DEPTH || ArrayBuffer.isView(obj)) {
    return objectRefToken(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((v) => structuralDigest(v, depth + 1)).join(',')}]`;
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${k}:${structuralDigest(record[k], depth + 1)}`).join(',')}}`;
}

const updateTriggersDigests = new WeakMap<object, string>();

/**
 * Content digest of a user-facing `updateTriggers` prop, folded into the
 * layers' styleKey / layerPropsKey digests so a trigger bump invalidates the
 * cached prepared tiles + sublayer instances — the deck.gl contract the
 * hand-rolled keys previously ignored. Memoized per object reference: a fresh
 * literal per render costs one small serialization; a reused reference is a
 * WeakMap hit (in-place mutation of a reused object is invisible, exactly as
 * it is to deck's own oldProps/props trigger diff).
 */
export function updateTriggersDigest(
  triggers: Record<string, unknown> | null | undefined,
): string {
  if (!triggers) return '';
  let digest = updateTriggersDigests.get(triggers);
  if (digest === undefined) {
    digest = structuralDigest(triggers);
    updateTriggersDigests.set(triggers, digest);
  }
  return digest;
}

/**
 * Digest of every composite prop that `CompositeLayer.getSubLayerProps()`
 * forwards into sublayers (opacity/pickable/visible, coordinate system,
 * modelMatrix, highlight props, …) plus the `_subLayerProps` override map.
 * The animated layers bake these into cached sublayer instances at
 * construction time, so any change here must invalidate the sublayer caches
 * — without it, inherited props would only apply to newly built tiles.
 */
export function inheritedPropsDigest(props: Record<string, any>): string {
  return [
    props.opacity,
    props.pickable,
    props.visible,
    props.coordinateSystem,
    structuralDigest(props.coordinateOrigin),
    structuralDigest(props.modelMatrix),
    props.wrapLongitude,
    props.positionFormat,
    props.autoHighlight,
    structuralDigest(props.highlightColor),
    props.highlightedObjectIndex,
    props.operation,
    structuralDigest(props.parameters),
    structuralDigest(props.getPolygonOffset),
    structuralDigest(props.fetch),
    structuralDigest(props._subLayerProps),
  ].join('|');
}
