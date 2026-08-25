// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * STTDataFilterExtension — poopdeck-native "filter by any baked column".
 *
 * A GPU range filter that shows/hides (and optionally soft-fades) features
 * whose value in ONE baked numeric column falls inside a `[min, max]` range.
 * It is the general-column sibling of {@link TimeFilterExtension} (which is a
 * hand-built `DataFilterExtension` specialized to the time window): both bind a
 * per-feature numeric attribute and gate the feature in the vertex shader.
 *
 * ## Why the `STT` prefix
 * Because it is a DIFFERENT class with the SAME job. Exporting it unprefixed
 * as `DataFilterExtension` shadows `@deck.gl/extensions`' export of that name
 * in any app importing both — and this package imports BOTH itself (the
 * heatmap / hexagon composites drive deck's stock extension over CPU rows,
 * everything else drives this one over binary columns). Two classes, same
 * name, different `getFilterValue` contract, is exactly the confusion the
 * prefix removes.
 *
 * ## Why not just pass deck.gl's `@deck.gl/extensions` `DataFilterExtension`?
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
 * ## ⚠ ONE BEHAVIOURAL DIVERGENCE FROM deck.gl — the `filterRange` default
 * Upstream defaults `filterRange` to **`[-1, 1]`**, which is an ACTIVE filter:
 * drop the stock `DataFilterExtension` onto a layer without setting a range and
 * everything outside `[-1, 1]` disappears. This extension defaults it to
 * **`null` = IDLE**: with no range set, EVERY feature renders and the bound
 * `filterValue` attribute simply sits there until a range arrives (so a slider
 * animates by uniform alone, with zero tile re-preparation).
 *
 * Same layer, same props, opposite visibility for any value outside `[-1, 1]`.
 * If you are porting code from `@deck.gl/extensions`, pass `filterRange:
 * [-1, 1]` explicitly to reproduce upstream's behaviour. The default is NOT
 * going to change — it is load-bearing for the tile pipeline and for every
 * shipped STT layer that installs this extension speculatively.
 *
 * ## v1 scope
 * `filterSize` is fixed at **1** (a single scalar column). Multi-column
 * filtering (`filterSize` 2–4, a `vec4` range, the min-reduce), 64-bit
 * precision (`fp64`), and category-bitmask filtering (`categorySize`) are
 * deliberately deferred — see the {@link STTDataFilterExtensionOptions} docstring.
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
 * Props for layers using {@link STTDataFilterExtension}. Mirrors the deck.gl
 * `DataFilterExtension` surface for `filterSize: 1` (a superset via the
 * layer-level `filterProperty` accessor-alias).
 */
export type STTDataFilterExtensionProps<DataT = unknown> = {
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
   * `filterValue` is within the bounds, hidden otherwise.
   *
   * ⚠ **DIVERGES from `@deck.gl/extensions`.** Upstream defaults this to
   * `[-1, 1]`, an ACTIVE filter that hides everything outside that band the
   * moment the extension is installed. Here the default is `null` = "no range
   * yet" → the filter IDLES and everything renders, so the attribute can be
   * bound up-front and the range animated later (a slider, say) purely by
   * uniform with zero tile re-preparation. Porting from upstream? Pass
   * `filterRange: [-1, 1]` explicitly. See the module docstring.
   * @default null (idle — upstream's is `[-1, 1]`, active)
   */
  filterRange?: DataFilterRange | null;
  /**
   * If set, features fade in/out across the margin between `filterSoftRange`
   * and `filterRange` instead of hard-clipping. When a value is inside
   * `filterRange` but outside `filterSoftRange` it renders "faded". Must sit
   * INSIDE `filterRange` to have any effect (a soft range wider than the hard
   * range is ignored per-edge, matching deck).
   *
   * Like upstream, supplying this turns the soft margin on INDEPENDENTLY of
   * `filterRange` — the `useSoftMargin` uniform tracks this prop alone. (It
   * still has no visible effect while `filterRange` is null, because the
   * whole filter is idle then; see that prop.)
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

/** Uniform payload set every draw() — see {@link STTDataFilterExtension.draw}. */
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

// Attribute + varying declarations live in the shader MODULE source, NOT in a
// `vs:#decl` / `fs:#decl` injection: deck's `mergeShaders` concatenates
// same-key injections with NO dedup, so two STTDataFilterExtension instances on
// one layer would emit `in float filterValue;` twice and the vertex shader
// would fail to link (a silently blank layer). luma dedupes shader MODULES by
// name, so declaring them here makes duplication harmless — the same placement
// upstream's data-filter shader module uses for `filterValues`.
const glslVertexDecl = `\
// Per-feature filter value, bound zero-copy from a baked numeric column
// (constant fallback via the getFilterValue accessor).
in float filterValue;
out float vDataFilterAlpha;
`;

const glslFragmentDecl = `\
in float vDataFilterAlpha;
`;

// Shader-module definition for deck.gl 9.x. Exported for the ShaderInputs
// getUniforms regression test (and symmetry with categoryColorUniforms).
export const dataFilterUniforms = {
  name: 'sttFilter',
  vs: `${glslUniformBlock}${glslVertexDecl}`,
  fs: `${glslUniformBlock}${glslFragmentDecl}`,
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

const defaultProps: DefaultProps<STTDataFilterExtensionProps> = {
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
export interface STTDataFilterExtensionOptions {
  /**
   * Number of scalar columns to filter by. **v1 supports `1` only.** Multi-size
   * filtering (2–4) — a `vec4` range with the classic per-component min-reduce,
   * as upstream — is deferred: it needs a `FixedSizeList` filter attribute and
   * a vec4 uniform block. See {@link STTDataFilterUnsupportedOptions} for the
   * rest of upstream's construction surface.
   * @default 1
   */
  filterSize?: 1;
}

/**
 * Upstream `DataFilterExtension` construction options that are **accepted but
 * NOT implemented** here. They are declared so porting code type-checks and so
 * the constructor can say so out loud instead of absorbing them silently —
 * each one warns once and is then dropped from `this.opts`.
 *
 * Why dropped rather than kept: `LayerExtension.equals()` compares `this.opts`
 * with `deepEqual(…, 1)`, so an inert `{fp64: true}` riding along would make
 * the instance compare UNEQUAL to a default-constructed one and force an
 * `extensionsChanged` model rebuild every render — a silent frame-rate cliff
 * bought for an option that does nothing.
 */
export interface STTDataFilterUnsupportedOptions {
  /** N/A — v1 compares `filterValue` in f32. Bake a pre-offset column instead. */
  fp64?: boolean;
  /** N/A — there is no CPU row list to count on a binary tile. */
  countItems?: boolean;
  /** N/A — pairs with `countItems`; never fires. */
  onFilteredItemsChange?: (event: { id: string; count: number }) => void;
  /** N/A — category-bitmask filtering is deferred (see the module docstring). */
  categorySize?: number;
}

/** The normalized option set actually stored on `this.opts` (v1: just the size). */
const defaultOptions: Required<STTDataFilterExtensionOptions> = {
  filterSize: 1,
};

/** Keys of {@link STTDataFilterUnsupportedOptions}, for the constructor warning. */
const UNSUPPORTED_OPTION_KEYS = [
  'fp64',
  'countItems',
  'onFilteredItemsChange',
  'categorySize',
] as const;

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
export class STTDataFilterExtension extends LayerExtension<
  Required<STTDataFilterExtensionOptions>
> {
  static defaultProps = defaultProps;
  static extensionName = 'STTDataFilterExtension';

  /**
   * Memoized shader-injection object. deck.gl calls `getShaders()` per
   * sublayer construction — one per visible tile here. luma 9.3.3 keys its
   * shader and pipeline caches on SOURCE TEXT, so a fresh literal carrying the
   * same strings still hits both caches (there is no re-link); what the memo
   * saves is the per-sublayer allocation of the modules array + inject
   * strings and deck's `mergeShaders` pass over them. Cheap, and it keeps
   * identity stable across every sublayer sharing the singleton (see
   * TimeFilterExtension).
   */
  private cachedShaders: {
    modules: unknown[];
    inject: Record<string, string>;
  } | null = null;

  // `filterSize` flows to super() so LayerExtension.equals() (which compares
  // this.opts) distinguishes instances — same pattern as upstream
  // `DataFilterExtension` and our TimeFilterExtension `mode`. v1 only supports
  // 1, so the opts are NORMALIZED to exactly `{filterSize: 1}` rather than
  // spread from the caller's object: an unsupported key riding along would
  // make `equals()` report false against a default-constructed instance and
  // rebuild the model every render for no behavioural gain. Everything the v1
  // shader cannot honour warns once here and is dropped.
  constructor(
    options: STTDataFilterExtensionOptions &
      STTDataFilterUnsupportedOptions = {},
  ) {
    if (options.filterSize !== undefined && options.filterSize !== 1) {
      warnOnce(
        'STTDataFilterExtension:filterSize',
        `[STTDataFilterExtension] filterSize=${options.filterSize} is not supported ` +
          'in v1; only a single numeric column (filterSize: 1) filters. Falling ' +
          'back to 1.',
      );
    }
    for (const key of UNSUPPORTED_OPTION_KEYS) {
      if (options[key] === undefined) continue;
      warnOnce(
        `STTDataFilterExtension:${key}`,
        `[STTDataFilterExtension] the \`${key}\` option is accepted for ` +
          'upstream-source compatibility but NOT implemented; it is ignored ' +
          '(and dropped from the extension options so `equals()` stays ' +
          'stable). See STTDataFilterUnsupportedOptions.',
      );
    }
    super({ ...defaultOptions, filterSize: 1 });
  }

  getShaders(
    this: Layer<STTDataFilterExtensionProps>,
    extension: STTDataFilterExtension,
  ) {
    if (extension.cachedShaders) return extension.cachedShaders;
    const shaders = {
      modules: [dataFilterUniforms],
      // NOTE: no `vs:#decl` / `fs:#decl` entries — the attribute and varying
      // are declared in `dataFilterUniforms.vs/fs` so luma's name-based module
      // dedup protects a duplicated extension. Every injection below keeps its
      // locals block-scoped, so a doubled injection still links.
      inject: {
        'vs:#main-start': `
          vDataFilterAlpha = 1.0;
          if (sttFilter.enabled > 0.5) {
            if (sttFilter.useSoftMargin > 0.5) {
              // Soft fade. smoothstep is undefined when edge0 >= edge1, so —
              // exactly like deck's own upstream DataFilterExtension — fall back to a hard
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
    this: Layer<STTDataFilterExtensionProps>,
    _context: LayerContext,
    _extension: STTDataFilterExtension,
  ): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    // add() + stepMode:'dynamic' — NOT addInstanced() (which hard-locks
    // stepMode to 'instance'). 'dynamic' resolves to 'instance' on instanced
    // models and 'vertex' on non-instanced ones, so one extension serves every
    // layer type — the same registration TimeFilterExtension / upstream
    // `DataFilterExtension`'s filterValues use.
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
    this: Layer<STTDataFilterExtensionProps>,
    _params: unknown,
    _extension: STTDataFilterExtension,
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

    // Upstream parity: `useSoftMargin` tracks `filterSoftRange` ALONE
    // (`useSoftMargin: Boolean(opts.filterSoftRange)`), independently of
    // whether the hard range is present. Do NOT gate it on `active` as well —
    // that makes the soft margin quietly conditional on a second prop. (The
    // extra finiteness check is ours: upstream's truthiness test would happily
    // push NaN edges into `smoothstep`.)
    const useSoft =
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

    // ── Push only when something moved ───────────────────────────────────
    // `draw()` runs once per MODEL per FRAME — one call per visible tile —
    // and all eight of these are constants for the layer's lifetime (they
    // change only with a prop edit). `setShaderModuleProps` clones every
    // value it is handed (`ShaderInputs.setProps`), so the unconditional push
    // paid eight clones per sublayer per frame for nothing. Same guard as
    // TimeFilterExtension: the block is pushed in full once per MODEL SET (a
    // fresh model starts from the module defaults, so a skipped push there
    // would render with `enabled: 0`… or worse, stale edges) and thereafter
    // only when a value differs from what that model set was last given.
    const models = this.getModels();
    const cache = this.state?.dataFilterPush as DataFilterPushCache | undefined;
    if (
      cache &&
      cache.model === models[0] &&
      cache.modelCount === models.length &&
      uniformsEqual(cache.uniforms, uniforms)
    ) {
      return;
    }
    if (this.state) {
      this.state.dataFilterPush = {
        model: models[0],
        modelCount: models.length,
        uniforms,
      } satisfies DataFilterPushCache;
    }
    this.setShaderModuleProps({ sttFilter: uniforms });
  }
}

/**
 * What the last uniform push covered, cached on the host layer's state.
 * `model`/`modelCount` pin it to the model set it was applied to — see the
 * note in `draw()`.
 */
interface DataFilterPushCache {
  model: unknown;
  modelCount: number;
  uniforms: DataFilterUniformProps;
}

const UNIFORM_KEYS = [
  'filterMin',
  'filterMax',
  'filterSoftMin',
  'filterSoftMax',
  'enabled',
  'useSoftMargin',
  'transformSize',
  'transformColor',
] as const satisfies readonly (keyof DataFilterUniformProps)[];

/** Allocation-free field-wise compare of two uniform blocks. */
function uniformsEqual(
  a: DataFilterUniformProps,
  b: DataFilterUniformProps,
): boolean {
  for (let i = 0; i < UNIFORM_KEYS.length; i++) {
    const key = UNIFORM_KEYS[i];
    if (a[key] !== b[key]) return false;
  }
  return true;
}
