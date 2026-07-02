// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Web-Mercator projection moved to `@poopdeck.gl/core/geo`. Re-export shim so
 * three importers of `../projection/mercator` are unchanged.
 */

export { MercatorProjection, MAX_MERCATOR_LAT } from '@poopdeck.gl/core/geo';
