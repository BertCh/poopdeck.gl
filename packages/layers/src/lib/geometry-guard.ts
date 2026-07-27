// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Geometry-kind guard for tile layers.
 *
 * `BinaryFeatures.geometryType` is the only thing that distinguishes a point
 * tile from a linestring tile once the columns are decoded — `featureCount`,
 * `positions` and `numericProps` are all present either way, with different
 * MEANINGS. A point layer handed a linestring tile reads the first
 * `featureCount` *vertices* of the flattened vertex run instead of one position
 * per feature: no error, no blank map, just features silently bunched along the
 * first few paths. Polygon-shaped guards (`!binary.startIndices`) do not catch
 * it either, because linestring tiles carry `startIndices` too.
 *
 * Every layer that indexes `positions` by feature index, or that assumes a
 * particular `startIndices` semantic, calls {@link expectGeometry} before
 * preparing a tile and skips the layer when it returns false. The mismatch then
 * surfaces as one named console warning instead of a wrong render — the
 * failure class `docs/guides` and the `debugging-blank-renders` skill exist to
 * chase.
 */

import { GeometryType } from '@poopdeck.gl/core';
import { warnOnce } from './log.js';

const NAMES: Record<number, string> = {
  [GeometryType.Point]: 'Point',
  [GeometryType.LineString]: 'LineString',
  [GeometryType.Polygon]: 'Polygon',
};

function nameOf(kind: number | undefined): string {
  return kind === undefined
    ? 'unknown'
    : (NAMES[kind] ?? `unrecognized(${kind})`);
}

/**
 * True when `actual` is one of `accepted`, or when the tile predates the
 * geometry-kind tag (`undefined` — hand-built fixtures and pre-tag archives),
 * which is treated as "trust the caller" rather than "reject".
 *
 * On a mismatch, warns ONCE per (layer, expected, actual) triple and returns
 * false so the caller can skip the layer.
 *
 * @param actual      the tile layer's `BinaryFeatures.geometryType`
 * @param accepted    geometry kinds this renderer can read
 * @param layerId     the STT layer's `id`, for the message
 * @param sourceName  the tile layer's `name`, for the message
 */
export function expectGeometry(
  actual: number | undefined,
  accepted: readonly GeometryType[],
  layerId: string,
  sourceName: string,
): boolean {
  if (actual === undefined) return true;
  if (accepted.includes(actual as GeometryType)) return true;

  const want = accepted.map(nameOf).join(' or ');
  warnOnce(
    `geometry-kind:${layerId}:${actual}:${want}`,
    `[${layerId}] tile layer ${JSON.stringify(sourceName)} carries ` +
      `${nameOf(actual)} geometry, but this layer reads ${want}. Skipping it — ` +
      `rendering it would misread the position buffer (feature indices are not ` +
      `vertex indices). Point a matching layer kind at this archive, or check ` +
      `the layer name if the archive carries more than one geometry kind.`,
  );
  return false;
}
