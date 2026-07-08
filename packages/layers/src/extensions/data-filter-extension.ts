// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * DataFilterExtension — poopdeck-native "filter by any baked column".
 *
 * A GPU range filter that shows/hides (and optionally soft-fades) features
 * whose value in ONE baked numeric column falls inside a `[min, max]` range.
 * It is the general-column sibling of {@link TimeFilterExtension} (which is a
 * hand-built DataFilterExtension specialized to the time window): both bind a
 * per-feature numeric attribute and gate the feature in the vertex shader.
 *
 * ## Why not just pass deck.gl's `@deck.gl/extensions` DataFilterExtension?
 * Upstream sources its filter value by running a JS **function** accessor
 * (`getFilterValue`) over each data row. STT tiles are binary Arrow columns —
 * there is no per-row JS to run. So the LAYER binds a `filterValue` ATTRIBUTE
 * straight from a baked numeric column (zero-copy), and this extension reads
 * that attribute plus a few constant uniforms. This mirrors exactly how
 * {@link TimeFilterExtension} binds `instanceStartTime`/`instanceEndTime`.
 *
 * ## Public-API parity (a superset of deck's)
 * The props mirror deck's surface — `filterRange`, `filterSoftRange`,
 * `filterEnabled`, `filterTransformSize`, `filterTransformColor` — so callers
 * who know the upstream extension are immediately at home. The ONE adaptation:
 * deck's `getFilterValue` **function** accessor is replaced, at the LAYER
 * level, by an accessor-alias `filterProperty` (a baked-column NAME; a function
 * warns once and is ignored — see `lib/accessor-alias.ts`). At the EXTENSION
 * level, `getFilterValue` survives only as the internal binding accessor / the
 * constant fallback used when a tile lacks the column.
 *
 * ## v1 scope
 * `filterSize` is fixed at **1** (a single scalar column). Multi-column
 * filtering (`filterSize` 2–4, a `vec4` range, the min-reduce), 64-bit
 * precision (`fp64`), and category-bitmask filtering (`categorySize`) are
 * deliberately deferred — see the {@link DataFilterExtensionOptions} docstring.
 * v1 compares `filterValue` in **f32**, so columns with huge magnitudes (raw
 * epoch-ms, say) lose precision; bake a pre-normalized / offset column for
 * those (unlike time, which {@link TimeFilterExtension} relativizes for you).
 *
 * ## Composition
 * Runs happily alongside {@link TimeFilterExtension} and
 * {@link CategoryColorExtension}: distinct GLSL module name (`sttFilter`),
 * attribute (`filterValue`) and varying (`vDataFilterAlpha`) mean zero name
 * collision — including with deck's own stock `dataFilter` module, should a
 * caller add both. Each extension multiplies its own factor into `color.a`, so
 * the temporal fade, the categorical color and the column filter compose.
 */

import { LayerExtension } from '@deck.gl/core';
import type {
  Layer,
  LayerContext,
  Accessor,
  DefaultProps,
} from '@deck.gl/core';
import { warnOnce } from '../lib/log.js';

/** An inclusive `[min, max]` filter bound. */
export type DataFilterRange = readonly [number, number];

/**
 * Props for layers using {@link DataFilterExtension}. Mirrors the deck.gl
 * `DataFilterExtension` surface for `filterSize: 1` (a superset via the
 * layer-level `filterProperty` accessor-alias).
 */
export type DataFilterExtensionProps<DataT = unknown> = {
  /**
   * Enable/disable the filter. When disabled every feature is rendered (the
   * filter is a no-op). Note the effective state is ALSO gated by whether a
   * valid `filterRange` is present and — at the layer — whether the named
   * column exists in a given tile.
   * @default true
   */
  filterEnabled?: boolean;
  /**
   * The inclusive `[min, max]` bounds. A feature is rendered when its
   * `filterValue` is within the bounds, hidden otherwise. `null` (the default)
   * means "no range yet" → the filter idles and everything renders, so the
   * attribute can be bound up-front and the range animated later (a slider,
   * say) purely by uniform with zero tile re-preparation.
   * @default null
   */
  filterRange?: DataFilterRange | null;
  /**
   * If set, features fade in/out across the margin between `filterSoftRange`
   * and `filterRange` instead of hard-clipping. When a value is inside
   * `filterRange` but outside `filterSoftRange` it renders "faded". Must sit
   * INSIDE `filterRange` to have any effect (a soft range wider than the hard
   * range is ignored per-edge, matching deck).
   * @default null
   */
  filterSoftRange?: DataFilterRange | null;
  /**
   * When a feature is "faded" (soft range only), also shrink its size/width.
   * ScatterplotLayer honours this via `DECKGL_FILTER_SIZE`; layers without that
   * hook (e.g. PathLayer) silently ignore it.
   * @default true
   */
  filterTransformSize?: boolean;
  /**
   * When a feature is "faded" (soft range only), also lower its opacity.
   * @default true
   */
  filterTransformColor?: boolean;
  /**
   * INTERNAL binding accessor for the bound `filterValue` attribute — the
   * constant fallback deck uses when a tile does not supply the binary column.
   * Callers filter through the LAYER's `filterProperty` (a column name), NOT
   * this. Kept for deck-surface parity; a function here is a plain deck
   * accessor (it never runs against binary tiles, which bind the attribute
   * directly).
   * @default 0
   */
  getFilterValue?: Accessor<DataT, number>;
};

// std140-packed scalar uniform block. All scalars (filterSize 1), so std140
// packs identically to default; the explicit layout matches the
// TimeFilterExtension / CategoryColorExtension convention and stays safe if a
// vec is ever added. The instance var + module name are `sttFilter` — distinct
// from deck's own `dataFilter` block so both can coexist on one pipeline.
const glslUniformBlock = `\
layout(std140) uniform sttFilterUniforms {
  float filterMin;
  float filterMax;
  float filterSoftMin;
  float filterSoftMax;
  float enabled;
  float useSoftMargin;
  float transformSize;
  float transformColor;
} sttFilter;
`;

/** Uniform payload set every draw() — see {@link DataFilterExtension.draw}. */
type DataFilterUniformProps = {
  filterMin: number;
  filterMax: number;
  filterSoftMin: number;
  filterSoftMax: number;
  /** 1.0 when the filter is active (enabled + a valid range), else 0.0. */
  enabled: number;
  /** 1.0 when a soft range is supplied (smoothstep fade), else 0.0 (hard step). */
  useSoftMargin: number;
  transformSize: number;
  transformColor: number;
};

// Shader-module definition for deck.gl 9.x. Exported for the ShaderInputs
// getUniforms regression test (and symmetry with categoryColorUniforms).
export const dataFilterUniforms = {
  name: 'sttFilter',
  vs: glslUniformBlock,
  fs: glslUniformBlock,
  uniformTypes: {
    filterMin: 'f32',
    filterMax: 'f32',
    filterSoftMin: 'f32',
    filterSoftMax: 'f32',
    enabled: 'f32',
    useSoftMargin: 'f32',
    transformSize: 'f32',
    transformColor: 'f32',
  },
};

const defaultProps: DefaultProps<DataFilterExtensionProps> = {
  filterEnabled: true,
  // Permissive {type:'object'} descriptor: these hold a [min,max] tuple OR null,
  // which the 'array' validator would reject (null) in deck's debug mode.
  filterRange: { type: 'object', value: null, optional: true, compare: true },
  filterSoftRange: {
    type: 'object',
    value: null,
    optional: true,
    compare: true,
  },
  filterTransformSize: true,
  filterTransformColor: true,
  // Constant fallback for the `filterValue` attribute (tiles missing the column).
  getFilterValue: { type: 'accessor', value: 0 },
};

/** Construction-time options, mirroring deck's (v1 supports `filterSize: 1`). */
export interface DataFilterExtensionOptions {
  /**
   * Number of scalar columns to filter by. **v1 supports `1` only.** Multi-size
   * filtering (2–4) — a `vec4` range with the classic per-component min-reduce,
   * as upstream — is deferred: it needs a `FixedSizeList` filter attribute and
   * a vec4 uniform block. `fp64` (64-bit filter precision) and `categorySize`
   * (category-bitmask filtering) are likewise future work.
   * @default 1
   */
  filterSize?: 1;
}

const defaultOptions: Required<DataFilterExtensionOptions> = {
  filterSize: 1,
};

/**
 * Layer extension for GPU range-filtering by a single baked numeric column.
 *
 * Install it in a layer's extension list whenever a `filterProperty` is set;
 * the shader branch is gated by the `enabled` uniform, so an installed-but-
 * disabled extension (no range yet, or a tile missing the column) still draws
 * everything — mirroring `CategoryColorExtension`'s `useCategoryColor` gate.
 * When no `filterProperty` is set the layer does not install it at all → zero
 * attribute, zero uniform, zero shader change.
 */
export class DataFilterExtension extends LayerExtension<
  Required<DataFilterExtensionOptions>
> {
  static defaultProps = defaultProps;
  static extensionName = 'DataFilterExtension';

  /**
   * Memoized shader-injection object. deck.gl calls `getShaders()` per sublayer
   * construction; a fresh literal each time would miss the shader cache and
   * re-link per tile. Building once per extension instance preserves identity
   * across every sublayer sharing the singleton (see TimeFilterExtension).
   */
  private cachedShaders: {
    modules: unknown[];
    inject: Record<string, string>;
  } | null = null;

  // `filterSize` flows to super() so LayerExtension.equals() (which compares
  // this.opts) distinguishes instances — same pattern as upstream
  // DataFilterExtension and our TimeFilterExtension `mode`. v1 only supports 1,
  // so we CLAMP it into the opts up front (never mutating this.opts afterward,
  // which keeps the constructor agnostic to LayerExtension's internals).
  constructor(options: DataFilterExtensionOptions = {}) {
    if (options.filterSize !== undefined && options.filterSize !== 1) {
      warnOnce(
        'DataFilterExtension:filterSize',
        `[DataFilterExtension] filterSize=${options.filterSize} is not supported ` +
          'in v1; only a single numeric column (filterSize: 1) filters. Falling ' +
          'back to 1.',
      );
    }
    super({ ...defaultOptions, ...options, filterSize: 1 });
  }

  getShaders(
    this: Layer<DataFilterExtensionProps>,
    extension: DataFilterExtension,
  ) {
    if (extension.cachedShaders) return extension.cachedShaders;
    const shaders = {
      modules: [dataFilterUniforms],
      inject: {
        'vs:#decl': `
          // Per-feature filter value, bound zero-copy from a baked numeric
          // column (constant fallback via the getFilterValue accessor).
          in float filterValue;
          out float vDataFilterAlpha;
        `,
        'vs:#main-start': `
          vDataFilterAlpha = 1.0;
          if (sttFilter.enabled > 0.5) {
            if (sttFilter.useSoftMargin > 0.5) {
              // Soft fade. smoothstep is undefined when edge0 >= edge1, so —
              // exactly like upstream DataFilterExtension — fall back to a hard
              // step on the edge where filterSoftRange is truncated by
              // filterRange. step(soft, hard) picks step vs smoothstep via mix.
              float leftInRange = mix(
                smoothstep(sttFilter.filterMin, sttFilter.filterSoftMin, filterValue),
                step(sttFilter.filterMin, filterValue),
                step(sttFilter.filterSoftMin, sttFilter.filterMin)
              );
              float rightInRange = mix(
                1.0 - smoothstep(sttFilter.filterSoftMax, sttFilter.filterMax, filterValue),
                step(filterValue, sttFilter.filterMax),
                step(sttFilter.filterMax, sttFilter.filterSoftMax)
              );
              vDataFilterAlpha = leftInRange * rightInRange;
            } else {
              // Hard range: 1.0 inside [min, max], 0.0 outside.
              vDataFilterAlpha =
                step(sttFilter.filterMin, filterValue) *
                step(filterValue, sttFilter.filterMax);
            }
          }
        `,
        // Collapse fully-filtered features at the VERTEX stage (upstream
        // parity): a degenerate clip-space position ⇒ zero fragments. Safe
        // even for multi-vertex paths — `filterValue` is per-FEATURE (all
        // vertices of a feature share it), so a feature collapses as a whole,
        // never leaving one end pinned at the origin (the trap TimeFilter's
        // per-vertex trail mode has to dodge).
        'vs:#main-end': `
          if (vDataFilterAlpha == 0.0) {
            gl_Position = vec4(0.);
          }
        `,
        // ScatterplotLayer-only hook (silently ignored where absent, e.g.
        // PathLayer). Shrinks a faded feature toward zero size in the soft band.
        'vs:DECKGL_FILTER_SIZE': `
          if (sttFilter.transformSize > 0.5) {
            size *= vDataFilterAlpha;
          }
        `,
        'fs:#decl': `
          in float vDataFilterAlpha;
        `,
        'fs:#main-start': `
          if (vDataFilterAlpha == 0.0) discard;
        `,
        'fs:DECKGL_FILTER_COLOR': `
          if (sttFilter.transformColor > 0.5) {
            color.a *= vDataFilterAlpha;
          }
        `,
      },
    };
    extension.cachedShaders = shaders;
    return shaders;
  }

  initializeState(
    this: Layer<DataFilterExtensionProps>,
    _context: LayerContext,
    _extension: DataFilterExtension,
  ): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    // add() + stepMode:'dynamic' — NOT addInstanced() (which hard-locks
    // stepMode to 'instance'). 'dynamic' resolves to 'instance' on instanced
    // models and 'vertex' on non-instanced ones, so one extension serves every
    // layer type — the same registration TimeFilterExtension / upstream
    // DataFilterExtension's filterValues use.
    attributeManager.add({
      filterValue: {
        size: 1,
        accessor: 'getFilterValue',
        type: 'float32',
        stepMode: 'dynamic',
        defaultValue: 0,
      },
    });
  }

  draw(
    this: Layer<DataFilterExtensionProps>,
    _params: unknown,
    _extension: DataFilterExtension,
  ): void {
    const {
      filterEnabled = true,
      filterRange = null,
      filterSoftRange = null,
      filterTransformSize = true,
      filterTransformColor = true,
    } = this.props;

    // The filter is active only when explicitly enabled AND handed a finite
    // [min, max] pair. A null / malformed range idles the extension (renders
    // everything) so the attribute can be bound before a range exists.
    const active =
      filterEnabled &&
      Array.isArray(filterRange) &&
      filterRange.length >= 2 &&
      Number.isFinite(filterRange[0]) &&
      Number.isFinite(filterRange[1]);

    const useSoft =
      active &&
      Array.isArray(filterSoftRange) &&
      filterSoftRange.length >= 2 &&
      Number.isFinite(filterSoftRange[0]) &&
      Number.isFinite(filterSoftRange[1]);

    const filterMin = active ? (filterRange as DataFilterRange)[0] : 0;
    const filterMax = active ? (filterRange as DataFilterRange)[1] : 0;

    const uniforms: DataFilterUniformProps = {
      filterMin,
      filterMax,
      // With no soft range, collapse soft edges onto the hard edges so the
      // shader's soft branch (if ever taken) is a no-op; `useSoftMargin` gates
      // it off anyway.
      filterSoftMin: useSoft
        ? (filterSoftRange as DataFilterRange)[0]
        : filterMin,
      filterSoftMax: useSoft
        ? (filterSoftRange as DataFilterRange)[1]
        : filterMax,
      enabled: active ? 1.0 : 0.0,
      useSoftMargin: useSoft ? 1.0 : 0.0,
      transformSize: filterTransformSize ? 1.0 : 0.0,
      transformColor: filterTransformColor ? 1.0 : 0.0,
    };

    this.setShaderModuleProps({ sttFilter: uniforms });
  }
}
