// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * PolygonTimeFilterExtension — DEPRECATED alias of {@link TimeFilterExtension}.
 *
 * This fork existed only to work around TimeFilterExtension registering its
 * attributes via `addInstanced()`, which deck.gl core unconditionally pins to
 * `stepMode: 'instance'` — wrong for SolidPolygonLayer's non-instanced fill
 * model. TimeFilterExtension now registers via `add()` + `stepMode:'dynamic'`
 * (the upstream DataFilterExtension mechanism), which resolves to 'instance'
 * on instanced models and 'vertex' on non-instanced ones, so the single
 * extension class serves polygons too and the fork has no reason to exist.
 *
 * MIGRATION NOTES for external consumers:
 * - Attribute names changed: binary `data.attributes` keys are now
 *   `instanceStartTime` / `instanceEndTime` (was `startTime` / `endTime`).
 *   For SolidPolygonLayer (vertex-stepped there), supply per-VERTEX-expanded
 *   values — one entry per vertex, all vertices of feature i carrying feature
 *   i's time. See AnimatedPolygonLayer.prepareTile for the reference
 *   expansion.
 * - Accessor names changed: `getInstanceStartTime` / `getInstanceEndTime`
 *   (was `getPolygonStartTime` / `getPolygonEndTime`).
 * - The uniform block is `timeFilter` (was `polygonTimeFilter`); the uniform
 *   props (`currentTime`/`getTime`/`timeOffset`/`timeWindow`/`fadeInDuration`/
 *   `fadeOutDuration`) are unchanged.
 */

import { TimeFilterExtension } from './time-filter-extension';
import type { TimeFilterExtensionProps } from './time-filter-extension';
import type { Accessor } from '@deck.gl/core';
import { warnOnce } from '../lib/log';

/**
 * @deprecated Use {@link TimeFilterExtensionProps}. The polygon-specific
 * accessor props are no longer read — see the migration notes in this module.
 */
export type PolygonTimeFilterExtensionProps<DataT = unknown> =
  TimeFilterExtensionProps<DataT> & {
    /** @deprecated Ignored — use `getInstanceStartTime`. */
    getPolygonStartTime?: Accessor<DataT, number>;
    /** @deprecated Ignored — use `getInstanceEndTime`. */
    getPolygonEndTime?: Accessor<DataT, number>;
  };

/**
 * @deprecated Use {@link TimeFilterExtension} directly — it now works on
 * SolidPolygonLayer (and every other non-instanced model). This subclass is a
 * thin compatibility alias and behaves identically to TimeFilterExtension;
 * note the attribute/accessor renames in the module docstring.
 */
export class PolygonTimeFilterExtension extends TimeFilterExtension {
  static extensionName = 'PolygonTimeFilterExtension';

  constructor() {
    super();
    warnOnce(
      'PolygonTimeFilterExtension:deprecated',
      '[PolygonTimeFilterExtension] is deprecated — use TimeFilterExtension. ' +
        'Binary attribute keys are now instanceStartTime/instanceEndTime ' +
        '(per-vertex-expanded on polygon layers) and accessors are ' +
        'getInstanceStartTime/getInstanceEndTime.',
    );
  }
}
