// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * The **GPU id-buffer picking catalog** — the reusable, kind-agnostic mechanism
 * that lets ANY instanced STT layer (points, columns, arcs, lines, trips,
 * polygons, paths, icons, iso) answer a click/hover pick, generalising the
 * point-cloud-only path that shipped first (see `./point-pick.ts`, now the
 * point specialisation of this contract).
 *
 * Three pieces make a layer id-pickable, and this module owns the two shared
 * ones (the third — an id-material variant — lives per-kind in `tsl/…`):
 *
 *  1. Its merge builder emits an {@link InstanceProvenance} + `binaryByTileKey`
 *     map in DRAW ORDER (merged instance `i` → `(tileKey, featureIndex)`), the
 *     same identity a GPU id readback decodes. `point-buffers.ts` is the
 *     template; `column-buffers.ts` / `arc-buffers.ts` follow it.
 *  2. Its layer implements {@link SttIdPickable}: a `pick()` that renders its
 *     id-material variant off-screen through the shared {@link GpuPicker},
 *     decodes the merged id, and calls {@link resolveIdPick} to join it back to
 *     a feature. Structurally implementing `pick()` is ALSO the registration
 *     signal — the r3f mount auto-registers any {@link isIdPickable} layer, so a
 *     new kind never touches `r3f/index.tsx`.
 *
 * {@link resolveIdPick} is the pure, unit-tested seam (merged index →
 * {@link SttIdPickInfo}); the GPU render + readback needs a live device and is
 * browser-verify per this package's test policy.
 */

import type { BinaryFeatures, TileId } from '@poopdeck.gl/core';
import { getFeatureProperties } from '@poopdeck.gl/core';
import type { InstanceProvenance } from '@poopdeck.gl/core/picking';
import type { GpuPicker } from './gpu-pick.js';
import type { SttPickInfoBase } from './box-pick.js';

/**
 * The instanced-layer kinds that answer a GPU id-buffer pick, i.e. every
 * `SttIdPickInfo.kind`. Widen this union (append a kind) when a fanout agent
 * lights up a new kind; the value is the `kind` a consumer narrows on. `'point'`
 * is the historical first kind (its narrowing alias is `SttPointPickInfo`).
 */
export type SttIdPickKind =
  | 'point'
  | 'column'
  | 'arc'
  | 'line'
  | 'trips'
  | 'polygon'
  | 'path'
  | 'icon'
  | 'iso';

/**
 * A hit on a GPU-instanced feature (id-buffer readback → provenance resolve),
 * shared by every id-pickable kind. `kind` says which kind answered, and
 * `tileKey` + `featureIndex` are the merged-buffer provenance identity so a
 * consumer can address the exact source `(tile, layer, feature)` regardless of
 * kind. Discriminated against {@link import('./box-pick.js').SttBoxPickInfo} by
 * `kind` (box kinds are `'object' | 'ego'`, disjoint from the id kinds).
 */
export interface SttIdPickInfo extends SttPickInfoBase {
  /** Which instanced-layer kind answered the pick. */
  kind: SttIdPickKind;
  /** Provenance key `z/x/y/t::layer` of the source `(tile, layer)`. */
  tileKey: string;
  /** Feature index within that source `(tile, layer)`'s `BinaryFeatures`. */
  featureIndex: number;
  /**
   * Alias of {@link featureIndex}, for `SttPointPickInfo` back-compat (the
   * point path surfaced the feature index as `index`). @deprecated use
   * `featureIndex`.
   */
  index: number;
  /** Decoded feature properties, or null when unresolved. */
  object: Record<string, unknown> | null;
  /** Geographic `[lng, lat]` of the picked feature (its first/representative vertex). */
  coordinate?: [number, number];
  /** The picked tile, when the provenance key parses. */
  tileId?: TileId;
  /** Screen `[cssX, cssY]` of the pick, when the caller supplies it. */
  screen?: [number, number];
}

/**
 * A layer that answers a GPU id-buffer pick for its instanced geometry. The
 * pick controller registers these (any layer that structurally satisfies this —
 * see {@link isIdPickable}) and, when a CPU box pick misses, runs `pick()` at
 * the cursor. A kind satisfies it by resolving its own provenance to an
 * {@link SttIdPickInfo} (typically via {@link resolveIdPick}); the interface
 * lets the controller keep a typed set without importing every concrete class.
 */
export interface SttIdPickable {
  pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<SttIdPickInfo | null>;
}

/**
 * Structural test for {@link SttIdPickable}: the layer exposes a `pick` method.
 * This is the AUTO-REGISTRATION signal — the r3f layer mount registers any
 * id-pickable layer into the id-pick set with no per-kind wiring, so a new kind
 * becomes pickable purely by implementing `pick()`. (Box pickables use the
 * separate `getPickBoxes` CPU registry and are unaffected.)
 */
export function isIdPickable(layer: unknown): layer is SttIdPickable {
  return typeof (layer as { pick?: unknown } | null)?.pick === 'function';
}

/**
 * Stable key for a source `(tile, layer)`: `z/x/y/t::layerName` — the identity a
 * merged-buffer provenance records per instance. Shared by every id-pickable
 * builder so keys line up with {@link parseIdTileKey}. (Mirrors
 * `point-buffers.ts`'s `pointTileKey`, which predates this module.)
 */
export function featureTileKey(id: TileId, layerName: string): string {
  return `${id.z}/${id.x}/${id.y}/${id.t}::${layerName}`;
}

/**
 * Parse a {@link featureTileKey} back into its {@link TileId}, or `undefined` if
 * the shape is unexpected (so a malformed key never fabricates a bogus tile).
 */
export function parseIdTileKey(tileKey: string): TileId | undefined {
  const sep = tileKey.indexOf('::');
  const coords = sep >= 0 ? tileKey.slice(0, sep) : tileKey;
  const p = coords.split('/');
  if (p.length !== 4) return undefined;
  const [z, x, y, t] = p.map(Number);
  if (![z, x, y, t].every((n) => Number.isFinite(n))) return undefined;
  return { z, x, y, t };
}

export interface ResolveIdPickParams {
  /** Merged instance index (as decoded from the GPU id buffer). */
  index: number;
  /** The merged layer's per-instance provenance (from its buffer builder). */
  provenance: InstanceProvenance;
  /** `tileKey` → source `BinaryFeatures` (from the same buffer builder). */
  binaryByTileKey: Map<string, BinaryFeatures>;
  /** The kind that answered — becomes {@link SttIdPickInfo.kind}. */
  kind: SttIdPickKind;
  /** The STT layer id surfaced on the result. */
  layerId: string;
  /** Optional screen `[cssX, cssY]` to echo back (world-space hit point, if known). */
  screen?: [number, number];
}

/**
 * Resolve a merged instance index (as decoded from a GPU id-buffer readback) to
 * a normalised, kind-tagged {@link SttIdPickInfo}, or `null` for a miss
 * (out-of-range index, unknown tileKey, or a stale feature index). Pure — the
 * unit-tested seam every id-pickable kind shares; call it directly if you
 * already have a decoded index from your own pick pass.
 *
 * The coordinate is the feature's representative vertex: for Point geometry
 * (points / columns / icons) that is vertex `featureIndex`; for indexed geometry
 * (arcs / lines / polygons / paths, which carry `startIndices`) it is the
 * feature's FIRST vertex (`startIndices[featureIndex]`, e.g. an arc's source
 * endpoint).
 */
export function resolveIdPick(
  params: ResolveIdPickParams,
): SttIdPickInfo | null {
  const { index, provenance, binaryByTileKey, kind, layerId, screen } = params;
  const entry = provenance.resolve(index);
  if (!entry) return null;
  const binary = binaryByTileKey.get(entry.tileKey);
  if (!binary) return null;
  const object = getFeatureProperties(binary, entry.featureIndex);
  if (!object) return null;

  const dims = binary.positionDimensions ?? 2;
  // Point geometry: one vertex per feature. Indexed geometry (line/polygon):
  // the feature's first vertex via startIndices.
  const vtx = binary.startIndices
    ? binary.startIndices[entry.featureIndex]
    : entry.featureIndex;
  const lon = binary.positions[vtx * dims];
  const lat = binary.positions[vtx * dims + 1];

  const info: SttIdPickInfo = {
    kind,
    layerId,
    tileKey: entry.tileKey,
    featureIndex: entry.featureIndex,
    index: entry.featureIndex,
    object,
    coordinate: [lon, lat],
  };
  const tileId = parseIdTileKey(entry.tileKey);
  if (tileId) info.tileId = tileId;
  if (screen) info.screen = screen;
  return info;
}
