// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * `PathLayer` subclass that fully strips picking-color machinery so the GPU
 * pipeline allocates one fewer vertex-attribute slot.
 *
 * In deck.gl ≤ 9.3, `PathLayer`'s vertex shader hard-codes
 * `in vec3 instancePickingColors;` (see
 * `@deck.gl/layers/src/path-layer/path-layer-vertex.glsl.ts`). WebGL2
 * drivers allocate an attribute slot for every `in` declaration in the
 * compiled vertex shader, regardless of whether the `AttributeManager`
 * binds a buffer for it. Counting:
 *
 *   1 (positions) + 1 (instanceTypes)
 *   + 4 (start/end/left/right Positions)
 *   + 4 (matching `64Low` slots)
 *   + 1 (instanceStrokeWidths) + 1 (instanceColors)
 *   + 1 (instancePickingColors)                       = 13 PathLayer slots
 *   + 3 (TimeFilterExtension: vertexTime/start/end)   = 16
 *   + 1 (CategoryColorExtension: categoryIndex)       = 17
 *
 * That's one slot above WebGL2's guaranteed minimum (`MAX_VERTEX_ATTRIBS`
 * = 16). GPUs / drivers that report the minimum (Intel UHD, software
 * WebGL, some Apple Silicon configs) refuse to link the program and emit
 *   `WebGL Link error: Too many attributes (instancePickingColors)`
 * — picking ends up named because it's the last `in` to be allocated.
 *
 * The clean upstream fix lands in deck.gl 9.4 (which moves picking to
 * `gl_InstanceID` and drops the vertex attribute entirely). Until that
 * ships, this subclass:
 *   1. Rewrites PathLayer's vs to drop `in vec3 instancePickingColors;`
 *      and replace its only use site with a zero constant — picking is
 *      already disabled at the prop level (`pickable: false`), so the
 *      values don't matter.
 *   2. Removes the matching `AttributeManager` entry so the CPU-side
 *      buffer is never allocated either.
 *
 * Net effect: 16 attribute slots, which fits the WebGL2 minimum, and the
 * link warning stops firing on per-tile sublayers.
 */

import { PathLayer } from '@deck.gl/layers';
import { warnOnce } from './log';

const PICKING_ATTR_DECL = /in\s+vec3\s+instancePickingColors\s*;\s*/g;
const PICKING_USE = /geometry\.pickingColor\s*=\s*instancePickingColors\s*;/g;

/**
 * Drop-in replacement for `PathLayer` that omits `instancePickingColors`.
 * Picking is unavailable on this subclass — only use it when the layer's
 * `pickable: false`.
 */
export class NoPickingPathLayer extends PathLayer {
  static layerName = 'NoPickingPathLayer';

  getShaders(): any {
    const shaders = (super.getShaders as any)();
    // Strip both the `in` declaration and the line that copies it into
    // `geometry.pickingColor`. Feed the picking module a constant zero
    // instead — it ignores the value when picking is inactive, which is
    // always the case for this subclass.
    if (typeof shaders.vs === 'string') {
      const original = shaders.vs;
      const stripped = original
        .replace(PICKING_ATTR_DECL, '')
        .replace(PICKING_USE, 'geometry.pickingColor = vec3(0.0);');
      if (stripped === original) {
        // Regex-rewrite is brittle across deck.gl versions: the attribute
        // declaration's exact spelling might have changed (e.g. deck.gl 9.4
        // dropped the attribute entirely via `gl_InstanceID`). If the regex
        // misses, the layer still works but the link-error workaround is
        // silently disabled — surface that loudly so the consumer rebuilds
        // their deck.gl pin or switches back to plain PathLayer.
        warnOnce(
          'NoPickingPathLayer:regex-miss',
          '[NoPickingPathLayer] could not strip instancePickingColors from ' +
            "PathLayer's vertex shader — the regex did not match. The " +
            'attribute-budget workaround is INACTIVE. Likely deck.gl 9.4+ ' +
            'already dropped the attribute (in which case use PathLayer directly) ' +
            'or the shader source layout has changed.',
        );
      }
      shaders.vs = stripped;
    }
    return shaders;
  }

  initializeState(...args: any[]): void {
    (super.initializeState as any)(...args);
    const am = (this as any).getAttributeManager?.();
    if (am && typeof am.remove === 'function') {
      am.remove(['instancePickingColors']);
    }
  }
}
