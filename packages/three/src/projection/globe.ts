// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * ECEF globe projection moved to `@poopdeck.gl/core/geo` (and there extended with
 * a WGS84-ellipsoid datum + parameterizable radius). Re-export shim so three
 * importers of `../projection/globe` are unchanged.
 */

export { GlobeProjection } from '@poopdeck.gl/core/geo';
export type { GlobeDatum, GlobeProjectionOptions } from '@poopdeck.gl/core/geo';
