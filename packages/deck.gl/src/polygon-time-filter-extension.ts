// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * PolygonTimeFilterExtension - GPU time filtering for SolidPolygonLayer.
 *
 * The standard TimeFilterExtension registers `instanceStartTime` /
 * `instanceEndTime` via `addInstanced()`, which sets `stepMode: 'instance'` —
 * correct for ScatterplotLayer / PathLayer but WRONG for SolidPolygonLayer.
 * Polygons are not instanced; their geometry comes from a tesselator that
 * expands per-feature attributes across each polygon's vertices, and the
 * vertex shader reads them as plain (non-instanced) `in float` attributes.
 *
 * This extension registers `startTime` / `endTime` via the non-instanced
 * `add()` path with `stepMode: 'dynamic'`. The PolygonTesselator does the
 * per-vertex expansion automatically; the shader gets one value per vertex
 * with all vertices of polygon i carrying polygon i's start/end times.
 *
 * Same float32-precision contract as TimeFilterExtension: time attributes
 * are RELATIVE to a per-layer `timeOffset`, and the extension subtracts the
 * same offset from `currentTime` (or `getTime()`) before uploading the
 * uniform. The polygon layer feeds `timeOffset` as a layer prop, identical
 * to the other animated layers.
 *
 * Why a separate extension and not a flag on TimeFilterExtension: shared
 * GLSL identifiers across the two would force runtime branching in the
 * vertex shader injection, and using one extension class for two different
 * attribute-step modes confuses anyone reading the layer setup. A small
 * dedicated extension is the smaller surface.
 */

import { LayerExtension } from '@deck.gl/core';
import type { Layer, LayerContext, Accessor, DefaultProps } from '@deck.gl/core';
import { relativizeTime, MAX_RELATIVE_TIME_MS } from './time-filter-extension';
import { warnOnce } from './log';

export type PolygonTimeFilterExtensionProps<DataT = unknown> = {
  /**
   * Absolute current time (epoch-ms). `getTime` takes priority when present.
   * @default 0
   */
  currentTime?: number;
  /**
   * Dynamic time getter — called every `draw()` so the layer instance can
   * stay cached across animation ticks (only uniforms update each frame).
   * @default null
   */
  getTime?: (() => number) | null;
  /**
   * Per-layer time offset. ALL per-feature time attribute values must be
   * relative to this; see TimeFilterExtension for the precision rationale.
   * @default 0
   */
  timeOffset?: number;
  /**
   * Total visible window size in ms (currentTime ± windowHalf).
   * @default 0
   */
  timeWindow?: number;
  /**
   * Fade-in duration (ms).
   * @default 0
   */
  fadeInDuration?: number;
  /**
   * Fade-out duration (ms).
   * @default 0
   */
  fadeOutDuration?: number;
  /**
   * Accessor for per-feature start time (relative to `timeOffset`).
   * @default 0
   */
  getPolygonStartTime?: Accessor<DataT, number>;
  /**
   * Accessor for per-feature end time (relative to `timeOffset`).
   * @default Infinity
   */
  getPolygonEndTime?: Accessor<DataT, number>;
};

type PolygonTimeFilterUniformProps = {
  currentTime: number;
  windowHalf: number;
  fadeIn: number;
  fadeOut: number;
};

// Same uniform block name (`polygonTimeFilter`) we declare in the shader.
// Note that we do NOT share the `timeFilter` uniform name with the standard
// extension — a layer could in principle install both; keeping the names
// disjoint avoids any cross-contamination of the uniform block.
const glslUniformBlock = `\
uniform polygonTimeFilterUniforms {
  float currentTime;
  float windowHalf;
  float fadeIn;
  float fadeOut;
} polygonTimeFilter;
`;

const polygonTimeFilterUniforms = {
  name: 'polygonTimeFilter',
  vs: glslUniformBlock,
  fs: glslUniformBlock,
  uniformTypes: {
    currentTime: 'f32',
    windowHalf: 'f32',
    fadeIn: 'f32',
    fadeOut: 'f32',
  },
};

const defaultProps: DefaultProps<PolygonTimeFilterExtensionProps> = {
  currentTime: 0,
  getTime: { type: 'function', value: null, optional: true },
  timeOffset: 0,
  timeWindow: 0,
  fadeInDuration: 0,
  fadeOutDuration: 0,
  getPolygonStartTime: { type: 'accessor', value: 0 },
  getPolygonEndTime: { type: 'accessor', value: Infinity },
};

/**
 * Layer extension for GPU-based polygon time filtering.
 *
 * Eliminates the CPU `getVisibleFeatureIndices` + `extractVisiblePolygons`
 * pass that ran every render — those scaled O(featureCount × renders) and
 * dominated at 100k+ polygons. With this extension installed, polygons are
 * uploaded ONCE; time-window changes update uniforms only.
 */
export class PolygonTimeFilterExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'PolygonTimeFilterExtension';

  getShaders(this: Layer<PolygonTimeFilterExtensionProps>, _extension: PolygonTimeFilterExtension) {
    return {
      modules: [polygonTimeFilterUniforms],
      inject: {
        'vs:#decl': `
          // Per-vertex feature times, RELATIVE to layer timeOffset. The
          // polygon tesselator expands per-feature accessor values across
          // each polygon's vertices, so the attribute is non-instanced.
          in float startTime;
          in float endTime;
          out float vPolygonTimeAlpha;
        `,
        'vs:#main-start': `
          float pTimeStart = polygonTimeFilter.currentTime - polygonTimeFilter.windowHalf;
          float pTimeEnd = polygonTimeFilter.currentTime + polygonTimeFilter.windowHalf;
          vPolygonTimeAlpha = 1.0;
          // Window mode: visible if [startTime, endTime] overlaps the window.
          if (endTime < pTimeStart || startTime > pTimeEnd) {
            vPolygonTimeAlpha = 0.0;
          }
          if (vPolygonTimeAlpha > 0.0 && polygonTimeFilter.fadeIn > 0.0) {
            float age = pTimeEnd - startTime;
            if (age < polygonTimeFilter.fadeIn) {
              vPolygonTimeAlpha *= (age / polygonTimeFilter.fadeIn);
            }
          }
          if (vPolygonTimeAlpha > 0.0 && polygonTimeFilter.fadeOut > 0.0) {
            float remaining = endTime - pTimeStart;
            if (remaining < polygonTimeFilter.fadeOut) {
              vPolygonTimeAlpha *= (remaining / polygonTimeFilter.fadeOut);
            }
          }
        `,
        'fs:#decl': `
          in float vPolygonTimeAlpha;
        `,
        'fs:#main-start': `
          if (vPolygonTimeAlpha <= 0.0) discard;
        `,
        'fs:DECKGL_FILTER_COLOR': `
          color.a *= vPolygonTimeAlpha;
        `,
      },
    };
  }

  initializeState(
    this: Layer<PolygonTimeFilterExtensionProps>,
    _context: LayerContext,
    _extension: PolygonTimeFilterExtension,
  ): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    // Non-instanced. PolygonTesselator expands per-feature values to per-vertex.
    // We register with `accessor` so the data-driven path works for both
    // object-array data and the binary `data.attributes` path.
    attributeManager.add({
      startTime: {
        size: 1,
        accessor: 'getPolygonStartTime',
        type: 'float32',
        stepMode: 'dynamic',
        defaultValue: 0,
      },
      endTime: {
        size: 1,
        accessor: 'getPolygonEndTime',
        type: 'float32',
        stepMode: 'dynamic',
        defaultValue: Number.MAX_VALUE,
      },
    });
  }

  draw(
    this: Layer<PolygonTimeFilterExtensionProps>,
    _params: unknown,
    _extension: PolygonTimeFilterExtension,
  ): void {
    const {
      currentTime = 0,
      getTime,
      timeOffset = 0,
      timeWindow = 0,
      fadeInDuration = 0,
      fadeOutDuration = 0,
    } = this.props;

    const resolvedTime = typeof getTime === 'function' ? getTime() : currentTime;
    const relativeTime = relativizeTime(resolvedTime, timeOffset);

    // Same precision guard as TimeFilterExtension. A wrong timeOffset (e.g.
    // not subtracted on the consumer side) silently degrades to ~131s
    // bucketing; the warning surfaces that without breaking rendering.
    if (Math.abs(relativeTime) > MAX_RELATIVE_TIME_MS) {
      warnOnce(
        'PolygonTimeFilterExtension:precision',
        `[PolygonTimeFilterExtension] relative time ${relativeTime} exceeds ` +
          `${MAX_RELATIVE_TIME_MS} ms — Float32 precision is degraded; ` +
          'check that `timeOffset` matches the tile data.',
      );
    }

    const uniforms: PolygonTimeFilterUniformProps = {
      currentTime: relativeTime,
      windowHalf: timeWindow / 2,
      fadeIn: fadeInDuration,
      fadeOut: fadeOutDuration,
    };
    this.setShaderModuleProps({ polygonTimeFilter: uniforms });
  }
}
