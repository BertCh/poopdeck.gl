// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedIconLayer - GPU-efficient directional markers with time filtering.
 *
 * ARCHITECTURE (per-tile binary sublayers, mirroring AnimatedPointLayer):
 * - One `IconLayer` per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, attributes }`
 *   interface, with positions / startTimes / endTimes referenced DIRECTLY
 *   from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension (window mode) uniform set.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation; the tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is stable
 *   across renderLayers() calls; deck.gl short-circuits GPU re-uploads when
 *   the reference matches.
 *
 * `IconLayer` is instanced at points exactly like `ScatterplotLayer`, so the
 * binary-attribute path is identical to AnimatedPointLayer's window-mode
 * branch — only the per-instance accessors differ (`getAngle` rotation,
 * `getIcon` sprite name, `getSize`).
 *
 * The headline use case is rotated markers for moving points (AIS vessels,
 * aircraft) using a per-feature heading column (e.g. 'heading' / 'cog') baked
 * into the `getAngle` instanced attribute.
 *
 * PER-CATEGORY ICONS: `getIcon` is deck's ONE accessor whose value is not a
 * number — it names a sprite, and deck's standard updater resolves it through
 * `getInstanceIconDef` once per ROW, allocating a fresh 7-element array each
 * time (`icon-layer.ts:332`). That is 100k throwaway arrays on a 100k-feature
 * tile, exactly the per-row JS work the binary path exists to remove. So this
 * layer BYPASSES the accessor: `AttributeManager.update` resolves
 * `buffers.instanceIconDefs` through `setExternalBuffer` BEFORE the accessor
 * path (`attribute-manager.ts:199`), so baking the size-7 `instanceIconDefs`
 * buffer ourselves — ONE `iconMapping` lookup per CATEGORY plus a typed-array
 * fill — skips both the accessor and the transform. {@link
 * _AnimatedIconLayerProps.iconProperty} names the categorical column that
 * selects the sprite, mirroring how `color` already keys a category column.
 * With no `iconProperty` (the default) every feature shares ONE constant icon
 * via a constant `getIcon`. Per-feature ROTATION, COLOR, SIZE and PIXEL OFFSET
 * ride instanced attributes as usual.
 *
 * Categorical colors lift to the GPU via CategoryColorExtension (same path as
 * AnimatedPointLayer's `fillColor`): a `color` property NAME hands the
 * per-feature category index to the fragment shader, which samples the palette
 * texture. A constant `color` rides a scalar prop instead.
 */

import { IconLayer } from '@deck.gl/layers';
import type {
  Color,
  DefaultProps,
  GetPickingInfoParams,
  Layer,
  LayerContext,
} from '@deck.gl/core';
import type { Texture } from '@luma.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
  SpatioTemporalPickingInfo,
} from '../spatiotemporal-layer.js';
import { TimeFilterExtension } from '../../extensions/time-filter-extension.js';
import { STTDataFilterExtension } from '../../extensions/data-filter-extension.js';
import type { DataFilterRange } from '../../extensions/data-filter-extension.js';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
  appendNullCategorySlot,
  categoryIndicesToFloat32,
} from '../../extensions/category-color-extension.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import {
  sampleTrack as kernelSampleTrack,
  RAD_TO_DEG,
  TrackIndexMaintainer,
} from '../../lib/track-kernel.js';
import type {
  Track,
  Sample,
  TrackFieldConfig,
  TrackSampleConfig,
} from '../../lib/track-kernel.js';
import {
  colorListDigest,
  colorMappingDigest,
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import {
  buildLayerPropsKey,
  type PropEffects,
} from '../../lib/layer-props-key.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
  WeightAccessorValue,
} from '../../lib/accessor-alias.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
import { bindFloatVector } from '../../lib/vector-props.js';
import {
  DEFAULT_CATEGORICAL_PALETTE,
  GeometryType,
  getFeatureProperties,
  tileLayerKey,
} from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';
import { expandCategoricalColors as coreExpandCategoricalColors } from '@poopdeck.gl/core/style';
import type { RGBA255 } from '@poopdeck.gl/core/style';

const DEBUG = false;

/**
 * Value domain of the {@link _AnimatedIconLayerProps.getPixelOffset} alias: a
 * constant `[x, y]` screen-space offset, a size-2 property-column NAME (an
 * interleaved `vectorProps` column baked at build time), or — like the other
 * accessor aliases — a function that warns once and falls back. Mirrors
 * {@link NumericAccessorValue} but two-wide (deck.gl's `getPixelOffset` is a
 * size-2 accessor).
 */
export type PixelOffsetAccessorValue =
  | [number, number]
  | number[]
  | string
  | ((d: unknown) => unknown);

/**
 * One entry of an `iconMapping` — the sub-rectangle of the atlas a named icon
 * occupies, plus anchor / mask flags. Mirrors deck.gl `IconLayer`'s mapping
 * shape; forwarded verbatim to the sublayer.
 */
export interface IconMappingEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX?: number;
  anchorY?: number;
  mask?: boolean;
}

/** Value domain of {@link _AnimatedIconLayerProps.iconMapping}. */
export type IconMappingValue = Record<string, IconMappingEntry> | string;

/**
 * Failure context handed to {@link _AnimatedIconLayerProps.onIconError} —
 * deck.gl `IconManager`'s `LoadIconErrorContext`, re-declared so consumers do
 * not have to reach into `@deck.gl/layers`' internal module.
 */
export interface IconLoadErrorContext {
  error: Error;
  /** The URL whose fetch failed. */
  url: string;
  /** The data object that requested the icon (always `null` on binary tiles). */
  source: unknown;
  /** Index of that object. */
  sourceIndex: number;
  /** The load options the fetch used (see `iconLoadOptions`). */
  loadOptions: unknown;
}

/* ── Icon-atlas / icon-mapping cache tokens ────────────────────────────────
 * `iconAtlas` and `iconMapping` are baked into a sublayer at CONSTRUCTION
 * time, and the sublayer cache hands the SAME IconLayer instance back every
 * render — deck never diffs its props — so an atlas/mapping swap only takes
 * effect if it changes the layerPropsKey. Keying the atlas by
 * `typeof x === 'string' ? x : ''` collapsed every Texture to the empty
 * string, and the mapping was not keyed at all: a fresh mapping object with
 * the same URL atlas, or a hi-DPI Texture swapped for the old one, both
 * produced a byte-identical key and rendered the STALE atlas forever. */

const iconAtlasIds = new WeakMap<object, number>();
let nextIconAtlasId = 1;

/**
 * Cache token for an `iconAtlas`. A URL string digests verbatim (its content
 * IS its identity); a `Texture` (or any object form) digests by reference
 * identity — a texture's pixels can't be digested cheaply, so swapping the
 * object is the invalidation contract, exactly like `functionId` in
 * style-digest.ts.
 */
function iconAtlasToken(atlas: string | Texture | null | undefined): string {
  if (!atlas) return '';
  if (typeof atlas === 'string') return `u:${atlas}`;
  let id = iconAtlasIds.get(atlas as unknown as object);
  if (id === undefined) {
    id = nextIconAtlasId++;
    iconAtlasIds.set(atlas as unknown as object, id);
  }
  return `#${id}`;
}

const iconMappingDigests = new WeakMap<object, string>();

/**
 * Content digest of an `iconMapping`, memoized per object reference (the
 * `colorMappingDigest` idiom): a caller who rebuilds an equal mapping literal
 * every render pays one small serialization, and a reused reference is a
 * WeakMap hit. A URL-string mapping digests verbatim. Key order is NOT
 * normalized — a reordered-but-equal mapping merely rebuilds the sublayers
 * once, which is cheap and correct.
 */
function iconMappingDigest(
  mapping: IconMappingValue | null | undefined,
): string {
  if (!mapping) return '';
  if (typeof mapping === 'string') return `u:${mapping}`;
  let digest = iconMappingDigests.get(mapping);
  if (digest === undefined) {
    digest = Object.keys(mapping)
      .map((key) => {
        const e = mapping[key];
        return `${key}:${e.x},${e.y},${e.width},${e.height},${
          e.anchorX ?? ''
        },${e.anchorY ?? ''},${e.mask ? 1 : 0}`;
      })
      .join(';');
    iconMappingDigests.set(mapping, digest);
  }
  return digest;
}

const categoryIconMappingDigests = new WeakMap<
  Record<string, string>,
  string
>();

/** Content digest of an `iconCategoryMapping` (category → icon name). Memoized per reference. */
function categoryIconMappingDigest(mapping: Record<string, string>): string {
  let digest = categoryIconMappingDigests.get(mapping);
  if (digest === undefined) {
    digest = Object.keys(mapping)
      .map((key) => `${key}:${mapping[key]}`)
      .join(';');
    categoryIconMappingDigests.set(mapping, digest);
  }
  return digest;
}

/**
 * Floats per `instanceIconDefs` entry — deck's `IconLayer` declares
 * `{size: 7}` with the shader attributes `instanceOffsets` (elements 0-1),
 * `instanceIconFrames` (2-5) and `instanceColorModes` (6) carved out of it by
 * `elementOffset`. Must stay in lockstep with `getInstanceIconDef`.
 */
const ICON_DEF_SIZE = 7;

/**
 * Write one icon's def at `offset`, byte-for-byte as deck's
 * `IconLayer.getInstanceIconDef` computes it: `[width/2 - anchorX,
 * height/2 - anchorY, x, y, width, height, mask ? 1 : 0]`, with each anchor
 * defaulting to the sprite's half-extent. An absent entry leaves the seven
 * zeros already in the buffer — the same values deck's own `MISSING_ICON`
 * ({x:0, y:0, width:0, height:0}) produces, i.e. a zero-size (invisible)
 * sprite rather than a wrong one.
 */
function writeIconDef(
  target: Float32Array,
  offset: number,
  entry: IconMappingEntry | undefined,
): void {
  if (!entry) return;
  const { x, y, width, height } = entry;
  target[offset] = width / 2 - (entry.anchorX ?? width / 2);
  target[offset + 1] = height / 2 - (entry.anchorY ?? height / 2);
  target[offset + 2] = x;
  target[offset + 3] = y;
  target[offset + 4] = width;
  target[offset + 5] = height;
  target[offset + 6] = entry.mask ? 1 : 0;
}

/** Props added by {@link AnimatedIconLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedIconLayerProps}). */
export interface _AnimatedIconLayerProps {
  /**
   * Icon atlas — a URL string or a pre-created {@link Texture}. Forwarded
   * verbatim to the sublayer `IconLayer`. Required to render anything (the
   * single constant icon is looked up in this atlas via `iconMapping`).
   */
  iconAtlas?: string | Texture | null;

  /**
   * Named sub-rectangle map into {@link iconAtlas}, or a URL string pointing at
   * a JSON file of the same shape (deck.gl resolves the URL asynchronously in
   * the sublayer — its `iconMapping` prop is declared `async`). Forwarded
   * verbatim to the sublayer `IconLayer`. {@link icon} / {@link iconProperty}
   * name which entry a feature uses.
   *
   * NOTE: {@link iconProperty} needs the mapping's CONTENT to bake the per-
   * feature sprite buffer, so it requires the OBJECT form — with a URL string
   * the layer warns once and falls back to the constant {@link icon}.
   */
  iconMapping?: IconMappingValue | null;

  /**
   * The icon name (a key of {@link iconMapping}) used for every feature — and,
   * when {@link iconProperty} is set, the fallback for features whose category
   * resolves to no entry.
   * @default 'marker'
   */
  icon?: string;

  /**
   * Categorical column NAME whose per-feature value selects the sprite —
   * per-CATEGORY icons, mirroring how {@link color} keys a category column.
   *
   * The value is resolved to an icon name through {@link iconCategoryMapping}
   * when that is set, otherwise the category value IS the icon name (a key of
   * {@link iconMapping}). Resolution costs ONE mapping lookup per distinct
   * category; the per-feature `instanceIconDefs` buffer is then a typed-array
   * fill, bypassing deck's per-row `getIcon` accessor + `getInstanceIconDef`
   * transform entirely (see the file header).
   *
   * Unset (the default) ⇒ every feature uses the constant {@link icon}, and no
   * `instanceIconDefs` attribute is baked. Requires an OBJECT
   * {@link iconMapping}. Ignored on the glide (`interpolate`) path, which
   * re-emits one pose per entity and has no per-sample category to read.
   * @default null
   */
  iconProperty?: string | null;

  /**
   * Explicit category value → icon NAME map for {@link iconProperty}. Unset
   * (the default) means the category value is used as the icon name directly.
   * Categories absent from the map fall back to {@link icon}; an icon name
   * absent from {@link iconMapping} renders a zero-size (invisible) sprite,
   * matching deck's own `MISSING_ICON` behaviour.
   * @default null
   */
  iconCategoryMapping?: Record<string, string> | null;

  /**
   * Called when deck.gl's `IconManager` fails to fetch an icon (a bad atlas
   * URL, a 403 on a credentialed atlas). Without it the failure is only
   * observable as a `log.error` in the console. `IconLayer` pass-through.
   * @default null
   */
  onIconError?: ((context: IconLoadErrorContext) => void) | null;

  /**
   * loaders.gl load options for the ICON ATLAS fetch — headers, credentials, a
   * custom `fetch`. Reaches deck's `IconManager` as the sublayer's
   * `loadOptions`.
   *
   * SPLIT, deliberately: the base {@link SpatioTemporalLayerProps.loadOptions}
   * is repurposed by this project for the ARCHIVE's HTTP (manifest, directory,
   * pack ranges) and `CompositeLayer.getSubLayerProps` does not forward it, so
   * overloading it would either break archive loading or leak archive auth
   * headers to a third-party atlas host. This prop is the icon-side half.
   * @default null
   */
  iconLoadOptions?: Record<string, unknown> | null;

  /**
   * Rotation in degrees — constant number, or a numeric property NAME (e.g.
   * 'heading' / 'cog') baked per-feature into the `getAngle` instanced
   * attribute. deck.gl `IconLayer` measures `getAngle` in DEGREES,
   * counter-clockwise from the icon's default (up) orientation.
   * @default 0
   */
  angle?: number | string;

  /**
   * Upstream-vocabulary alias of {@link angle}. Accepts a constant number OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `angle`). When set, it wins over `angle`.
   */
  getAngle?: NumericAccessorValue | null;

  /**
   * Marker tint — constant {@link Color}, or a property name for categorical
   * coloring (GPU path via CategoryColorExtension). For a `mask: true` icon the
   * tint replaces the sprite's color; for an opaque icon it modulates it.
   *
   * DELIBERATE DIVERGENCE from deck.gl `IconLayer.getColor` (`[0, 0, 0, 255]`):
   * white leaves an opaque sprite's own colours untouched, whereas deck's black
   * default silently blackens every masked icon. Pass `[0, 0, 0, 255]`
   * explicitly for upstream parity.
   * @default [255, 255, 255, 255]
   */
  color?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link color}. Accepts a constant Color OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `color`). When set, it wins over `color`.
   */
  getColor?: ColorAccessorValue | null;

  /** Color palette for categorical `color`. */
  colorPalette?: Color[];

  /**
   * Explicit category-to-color map for a categorical `color` property (B3
   * stable colorMapping). When set, each icon's tint is
   * `colorMapping[categoryValue]`, CPU-expanded into a per-feature RGBA
   * `getColor` buffer, using {@link colorMappingDefault} (transparent by
   * default) for values absent from the map. This is the ONLY way to get STABLE
   * colors across tiles whose categorical column holds different category
   * subsets — the GPU first-seen palette-index fallback assigns the same band a
   * different palette slot per tile. With `colorMapping` unset, the GPU
   * CategoryColorExtension handles the lookup against `colorPalette`.
   * @default null
   */
  colorMapping?: Record<string, Color> | null;

  /** Fallback tint for categories absent from {@link colorMapping}. @default transparent */
  colorMappingDefault?: Color;

  /**
   * Icon size — constant number, or a numeric property NAME baked per-feature
   * into the `getSize` instanced attribute. Interpreted in {@link sizeUnits}.
   *
   * DELIBERATE DIVERGENCE from deck.gl `IconLayer.getSize` (`1`): deck's
   * default renders a 1-pixel marker, which reads as "nothing drew". Pass `1`
   * explicitly for upstream parity.
   * @default 12
   */
  size?: number | string;

  /**
   * Upstream-vocabulary alias of {@link size}. Accepts a constant number OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `size`). When set, it wins over `size`.
   */
  getSize?: NumericAccessorValue | null;

  /**
   * Units for `size` — `IconLayer` pass-through.
   * @default 'pixels'
   */
  sizeUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Icon size multiplier — `IconLayer` pass-through.
   * @default 1
   */
  sizeScale?: number;

  /** Minimum on-screen icon size in pixels. Forwarded to `IconLayer`. */
  sizeMinPixels?: number;

  /** Maximum on-screen icon size in pixels. Forwarded to `IconLayer`. */
  sizeMaxPixels?: number;

  /**
   * Which dimension of a non-square icon `size` measures. `'height'` scales the
   * icon so its rendered height equals `size` (width follows the aspect ratio);
   * `'width'` scales by width instead. No effect on square icons.
   * `IconLayer` pass-through.
   * @default 'height'
   */
  sizeBasis?: 'height' | 'width';

  /**
   * Screen-space pixel offset — a constant `[x, y]` applied to every icon, or a
   * size-2 property-column NAME (an interleaved `vectorProps` column) baked
   * per-feature into the `getPixelOffset` instanced attribute. Same
   * constant-or-column domain as {@link size}/{@link angle}, but two-wide.
   * `IconLayer` pass-through / accessor.
   * @default [0, 0]
   */
  pixelOffset?: [number, number] | string;

  /**
   * Upstream-vocabulary alias of {@link pixelOffset}. Accepts a constant
   * `[x, y]` OR a size-2 property-column NAME — NOT a function accessor (a
   * function warns once and falls back to `pixelOffset`). When set, it wins over
   * `pixelOffset`.
   */
  getPixelOffset?: PixelOffsetAccessorValue | null;

  /**
   * Alpha discard threshold in `[0, 1]`. Fragments whose (icon × tint) alpha is
   * below this cutoff are dropped, which crisps the masked-icon edge and keeps
   * translucent sprite fringes from depth-writing. `IconLayer` pass-through.
   * @default 0.05
   */
  alphaCutoff?: number;

  /**
   * Render icons as billboards (always face the camera in 3D views) —
   * `IconLayer` pass-through.
   * @default true
   */
  billboard?: boolean;

  /**
   * Sampler parameters for the icon-atlas texture — filtering (`minFilter` /
   * `magFilter` / `mipmapFilter`) and wrap (`addressModeU` / `addressModeV`).
   * `null` leaves deck.gl's `IconManager` defaults in place. Forwarded verbatim
   * to the sublayer `IconLayer` (a luma.gl `SamplerProps` object).
   * @default null
   */
  textureParameters?: Record<string, unknown> | null;

  /**
   * Fade-in duration for appearing icons (ms).
   * @default 300
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration for disappearing icons (ms).
   * @default 300
   */
  fadeOutDuration?: number;

  /**
   * Wake length in milliseconds (B3 — the point layer's "ship wake" exposed on
   * icons). When > 0, switches the layer's TimeFilterExtension into one-sided
   * wake mode: each icon is visible only while
   * `0 <= currentTime - startTime <= wakeLength`, its alpha fading linearly to 0
   * at the trailing edge. Takes precedence over the symmetric window/fade
   * filter. Unlike the point layer, the trailing SIZE shrink does not apply
   * (that shader hook is ScatterplotLayer-only) — the icon wake is an alpha
   * tail. The layer widens the load window to `2 × wakeLength` so the tail
   * stays resident (see {@link getEffectiveTimeWindow}).
   * @default 0
   */
  wakeLength?: number;

  /**
   * Trailing-edge size multiplier in wake mode (0..1) — forwarded to the
   * TimeFilterExtension for parity with the point layer. No visible effect on
   * icons (the size-shrink shader hook is ScatterplotLayer-only); the alpha tail
   * still fades. @default 0.15
   */
  wakeTailScale?: number;

  /**
   * GPU range filter — the NAME of a baked numeric column to filter icons by
   * (installs {@link STTDataFilterExtension}). Icons whose value in this column
   * falls inside {@link filterRange} render; the rest are hidden (or soft-faded
   * via {@link filterSoftRange}). Composes WITH the time filter — an icon must
   * pass both the time window and the column range.
   *
   * Accessor-alias of deck.gl's `getFilterValue`: pass a column NAME, not a
   * function (STT tiles are binary — a function warns once and is ignored).
   * Unset (the default) ⇒ the extension is not installed at all: zero
   * attribute, zero uniform, zero shader change. A tile that lacks the named
   * column renders unfiltered (the filter idles for that tile). Applies to the
   * discrete window path only — the glide (`interpolate`) path filters by
   * activity, so a filter column is ignored there.
   * @default null
   */
  filterProperty?: WeightAccessorValue | null;

  /**
   * Inclusive `[min, max]` bounds for {@link filterProperty}. `null` (default)
   * means "no range yet" — the column is still bound, so a range set later
   * animates purely by uniform with no tile re-preparation. No effect unless
   * `filterProperty` is set.
   * @default null
   */
  filterRange?: DataFilterRange | null;

  /**
   * Optional soft `[min, max]` inside {@link filterRange}: icons between the soft
   * and hard bounds fade rather than hard-clip. No effect unless
   * `filterProperty` + `filterRange` are set.
   * @default null
   */
  filterSoftRange?: DataFilterRange | null;

  /**
   * Enable/disable the column filter without dropping the bound attribute.
   * Effective only when `filterProperty` + a valid `filterRange` are set.
   * @default true
   */
  filterEnabled?: boolean;

  /**
   * Opt into the CPU "glide" render path (B2 motion interpolation). Icon
   * archives carry one row per entity PER SAMPLE, so a GPU time-WINDOW filter
   * shows every sample in the window at once — a moving marker POPS. With
   * `interpolate` on, the layer pools the loaded tiles' samples by
   * {@link idProperty} and once per frame emits ONE IconLayer of each ACTIVE
   * entity's pose, position AND heading CPU-interpolated between the samples
   * bracketing the playhead, so it GLIDES and rotates smoothly. Reuses the
   * shared track kernel.
   *
   * Gated: used only when `interpolate && !reducedMotion &&` a resolvable
   * `idProperty && wakeLength === 0`. Any unmet (the default: off) leaves the
   * GPU window/wake path BYTE-IDENTICAL.
   * @default false
   */
  interpolate?: boolean;

  /**
   * Per-entity id column NAME grouping samples into one glide track (e.g. AIS
   * exact vessel id, aircraft `icao24`). Reads a categorical (string) column;
   * must be an EXACT per-entity id (a lossy/quantized id fuses distinct
   * entities). No effect unless {@link interpolate} is on. @default null
   */
  idProperty?: string | null;

  /**
   * Largest gap (ms) between two of an entity's samples that glide interpolates
   * across; a wider gap HOLDS the last sample (position AND heading) instead of
   * fabricating motion through a data hole. No effect unless {@link interpolate}
   * is on. @default Infinity
   */
  maxInterpolationGap?: number;

  /**
   * Honor the viewer's reduced-motion preference. When `true`, the glide path is
   * disabled and the layer DEGRADES to the GPU time-window path (discrete
   * per-sample rendering). A concrete boolean (survives the
   * explicit-undefined-shadows-default gotcha). @default false
   */
  reducedMotion?: boolean;
}

/** Complete props accepted by {@link AnimatedIconLayer}. */
export type AnimatedIconLayerProps = _AnimatedIconLayerProps &
  SpatioTemporalLayerProps;

/**
 * Sublayer-cache effect of every own prop, exhaustive by type: a prop added to
 * {@link _AnimatedIconLayerProps} without an entry here fails to compile.
 *
 * `'sublayer'` — read by {@link AnimatedIconLayer.buildSublayer} (or by
 * {@link AnimatedIconLayer.renderInterpolated}, which rebuilds its single
 * sublayer every frame). A cached `IconLayer` freezes the value and deck never
 * diffs its props, so a change must drop the sublayer cache.
 *
 * `'prepare'` — read only while baking a tile's binary attributes. Each is a
 * component of {@link AnimatedIconLayer.computeStyleKey} (`iconProperty` and
 * `iconCategoryMapping` via `iconKey`, `colorPalette` via `colorListDigest`,
 * `colorMapping` via `colorMappingDigest`, `colorMappingDefault` via
 * `mapDefault`), so a change rebuilds `prepared` — and the sublayer cache hit
 * tests `prepared` by object identity, which is what invalidates the sublayer.
 * Moving one of these to `'sublayer'` is safe; moving a `'sublayer'` prop here
 * is only safe while `styleKey` genuinely contains it.
 *
 * The accessor-alias props (`angle`, `color`, `size`, `pixelOffset`,
 * `filterProperty`) and the two opaque icon-atlas props are additionally keyed
 * on a resolved value through the `overrides` channel — see
 * {@link AnimatedIconLayer.computeLayerPropsKey}.
 */
const ICON_PROP_EFFECTS: PropEffects<_AnimatedIconLayerProps> = {
  iconAtlas: 'sublayer',
  iconMapping: 'sublayer',
  icon: 'sublayer',
  iconProperty: 'prepare',
  iconCategoryMapping: 'prepare',
  onIconError: 'sublayer',
  iconLoadOptions: 'sublayer',
  angle: 'sublayer',
  getAngle: 'sublayer',
  color: 'sublayer',
  getColor: 'sublayer',
  colorPalette: 'prepare',
  colorMapping: 'prepare',
  colorMappingDefault: 'prepare',
  size: 'sublayer',
  getSize: 'sublayer',
  sizeUnits: 'sublayer',
  sizeScale: 'sublayer',
  sizeMinPixels: 'sublayer',
  sizeMaxPixels: 'sublayer',
  sizeBasis: 'sublayer',
  pixelOffset: 'sublayer',
  getPixelOffset: 'sublayer',
  alphaCutoff: 'sublayer',
  billboard: 'sublayer',
  textureParameters: 'sublayer',
  fadeInDuration: 'sublayer',
  fadeOutDuration: 'sublayer',
  wakeLength: 'sublayer',
  wakeTailScale: 'sublayer',
  // `filterProperty` decides the sublayer's EXTENSION SET, which is baked at
  // construction time; the ranges and the enable flag are sublayer props.
  filterProperty: 'sublayer',
  filterRange: 'sublayer',
  filterSoftRange: 'sublayer',
  filterEnabled: 'sublayer',
  // Glide knobs. They select which render path runs and shape the pose data
  // the interpolated sublayer is constructed from.
  interpolate: 'sublayer',
  idProperty: 'sublayer',
  maxInterpolationGap: 'sublayer',
  reducedMotion: 'sublayer',
};

// Default color palette for categorical data (shared shape with the point layer).
// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_CATEGORICAL_PALETTE;

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * deck.gl is stable across renders — deck.gl compares `data` by reference
 * (with our dataComparator: ===) to decide whether to re-upload GPU buffers.
 *
 * Mirrors AnimatedPointLayer's PreparedTile shape (window mode only).
 */
interface PreparedTile {
  /** Resolved (tile, layer) cache key. */
  tileKey: string;
  /** Hash of style props that affect the prepared `attributes`. */
  styleKey: string;
  /** Reference-stable data object for IconLayer's binary interface. */
  data: {
    length: number;
    attributes: Record<
      string,
      { value: any; size: number; normalized?: boolean }
    >;
  };
  /** Per-tile time reference; passed to TimeFilterExtension as `timeOffset`. */
  timeOffset: number;
  /**
   * When the GPU categorical-color path is active for this tile, the resolved
   * palette to pass to the extension. Null when constant color is in use.
   */
  gpuPalette: Color[] | null;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  layerName: string;
  features: BinaryFeatures;
}

/**
 * Animated icon layer with per-tile binary sublayers.
 *
 * Each visible tile produces one `IconLayer` instance that is cached across
 * renders. Time updates flow through getTime() on the extension; tile arrivals
 * only construct one new sublayer + one GPU upload, never touching the buffers
 * of already-loaded tiles. Window-mode time filtering only — there is no
 * cumulative ("draws itself") path here (see AnimatedPointLayer for that).
 *
 * Sublayer short id for `_subLayerProps` overrides: **`icons`**.
 * `_subLayerProps: { icons: { type: MyLayer, ...props } }` swaps the sublayer
 * class / overrides sublayer props (deck's CompositeLayer contract).
 */
export class AnimatedIconLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_AnimatedIconLayerProps>> {
  static layerName = 'AnimatedIconLayer';

  static defaultProps: DefaultProps<AnimatedIconLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,

    // Icon atlas + mapping forwarded verbatim to IconLayer.
    iconAtlas: { type: 'object', value: null, optional: true, compare: true },
    iconMapping: { type: 'object', value: null, optional: true, compare: true },
    icon: 'marker',
    // Per-category sprite selection. Unset ⇒ constant icon, no instanceIconDefs
    // attribute (byte-identical to the pre-category path).
    iconProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    iconCategoryMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    // Atlas-fetch failure hook + icon-side load options (the base `loadOptions`
    // is the ARCHIVE's — see the prop docs).
    onIconError: { type: 'object', value: null, optional: true, compare: true },
    iconLoadOptions: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },

    // Permissive descriptors ({type:'object'} validates anything): these props
    // legally hold a constant OR a column-name string, which the
    // 'number'/'color' validators would reject in deck's debug mode.
    angle: { type: 'object', value: 0, compare: true },
    color: { type: 'object', value: [255, 255, 255, 255], compare: true },
    size: { type: 'object', value: 12, compare: true },
    // Constant [x,y] OR a size-2 column name — permissive descriptor for the
    // same reason as angle/color/size.
    pixelOffset: { type: 'object', value: [0, 0], compare: true },

    // Accessor-named aliases: unset by default so the legacy props win unless
    // the caller opts into the upstream vocabulary.
    getAngle: { type: 'object', value: null, optional: true, compare: true },
    getColor: { type: 'object', value: null, optional: true, compare: true },
    getSize: { type: 'object', value: null, optional: true, compare: true },
    getPixelOffset: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },

    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    // Stable categorical colorMapping (B3). Unset ⇒ GPU palette path; set ⇒
    // CPU-expanded per-feature RGBA (stable across tiles). Permissive
    // descriptors (a map / null / a Color that 'color' would reject).
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    // Transparent fallback: categories absent from the map disappear rather
    // than render a misleading color (parity with the point layer).
    colorMappingDefault: { type: 'color', value: [0, 0, 0, 0] },

    // Sizing forwarded to IconLayer.
    sizeUnits: 'pixels',
    sizeScale: { type: 'number', value: 1, min: 0 },
    sizeMinPixels: { type: 'number', value: 0, min: 0 },
    sizeMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    sizeBasis: 'height',
    billboard: true,

    // Masked-icon edge crisping — deck default 0.05.
    alphaCutoff: { type: 'number', value: 0.05, min: 0, max: 1 },

    // Atlas sampler params — null keeps IconManager's defaults (deck default).
    textureParameters: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },

    // Fade ramps, forwarded to TimeFilterExtension (window mode).
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },

    // Wake mode (B3). wakeLength=0 keeps the symmetric window behavior.
    wakeLength: { type: 'number', value: 0, min: 0 },
    wakeTailScale: { type: 'number', value: 0.15, min: 0 },

    // Column range filter (STTDataFilterExtension). Unset ⇒ not installed.
    // Permissive {type:'object'} descriptors: filterProperty holds a column
    // name; the ranges hold a [min,max] tuple OR null (rejected by 'array').
    filterProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    filterRange: { type: 'object', value: null, optional: true, compare: true },
    filterSoftRange: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    filterEnabled: true,

    // Glide (B2 motion interpolation). Off ⇒ the GPU window path is
    // byte-identical. idProperty is permissive (column-name string OR null).
    interpolate: false,
    idProperty: { type: 'object', value: null, optional: true, compare: true },
    maxInterpolationGap: { type: 'number', value: Infinity, min: 0 },
    reducedMotion: false,
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Returning the SAME IconLayer reference
   * across renderLayers() calls lets deck.gl short-circuit the prop diff
   * entirely — the same cache-storm avoidance as AnimatedPointLayer.
   */
  private sublayerCache = new Map<
    string,
    { layer: IconLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction time. */
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedPointLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /* ── Glide (motion-interpolation) state — only the `interpolate` path ─────
   * Pool the loaded tiles' samples into one id-keyed track index (rebuilt only
   * when the tile SET or a feeding prop changes), then re-interpolate one pose
   * (position + heading) per active entity every frame. */
  private interpTrackIndex: Map<string, Track> | null = null;
  private interpTrackIndexKey = '';
  /**
   * Incremental maintainer of {@link interpTrackIndex}: re-pools only ADDED
   * tiles and re-sorts only AFFECTED tracks across tile churn, instead of the
   * O(all snapshots) full rebuild that spiked frame time. Lazily created (the
   * test harness bypasses field initializers via Object.create).
   */
  private interpMaintainer: TrackIndexMaintainer | null = null;
  /**
   * Per-track representative decoded source feature, for glide picking. Pruned
   * to the RESIDENT track set on every tile-set change — see
   * {@link scanInterpPickRows}.
   */
  private interpPickRows: Map<string, Record<string, unknown>> | null = null;
  /** Tile keys already scanned for {@link interpPickRows}; pruned to the live tile set. */
  private interpPickRowsScanned: Set<string> | null = null;
  /** Sim-time of the last glide re-interpolation; skips redundant ticks. */
  private lastInterpFrameTime = NaN;
  /** Grow-only per-frame output buffers (avoid a fresh alloc every glide frame). */
  private interpPosBuf: Float64Array | null = null;
  private interpAngBuf: Float32Array | null = null;
  private interpColBuf: Uint8Array | null = null;

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Window-mode
   * filtering (whole feature on/off + fade) — the per-vertex time attribute is
   * unused.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({
    mode: 'window',
  });

  /**
   * Singleton CategoryColorExtension. Stateless — the palette and
   * `useCategoryColor` toggle ride through layer props. Always included: when a
   * tile lacks `instanceCategoryIndex`, the shader branch is gated off via the
   * uniform.
   */
  private readonly categoryColorExtension = new CategoryColorExtension();

  /**
   * Singleton STTDataFilterExtension. Composed into a sublayer's extension list
   * ONLY when `filterProperty` is set (a per-layer constant, so the list stays
   * stable across this layer's sublayers). Constructed unconditionally — a
   * no-op object alloc; it contributes no attribute, uniform or shader unless
   * actually installed. Mirrors {@link AnimatedArcLayer} / {@link AnimatedPointLayer}.
   */
  private readonly dataFilterExtension = new STTDataFilterExtension({
    filterSize: 1,
  });

  /**
   * Stable getTime reference. A fresh arrow every render defeats the cache
   * (deck.gl re-runs work when accessor function references change).
   */
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
    this.interpTrackIndex = null;
    this.interpMaintainer?.reset();
    this.interpPickRows = null;
    this.interpPickRowsScanned = null;
    this.interpPosBuf = null;
    this.interpAngBuf = null;
    this.interpColBuf = null;
  }

  /**
   * Widen the load window for wake mode so the wake's trailing half stays
   * resident (parity with AnimatedPointLayer). Common case (wake off): returns
   * the base window unchanged — byte-identical.
   */
  protected getEffectiveTimeWindow(): number {
    let widened = super.getEffectiveTimeWindow();
    const wakeLength = this.props.wakeLength;
    if (wakeLength > 0) widened = Math.max(widened, wakeLength * 2);
    return widened;
  }

  /**
   * Accessor-alias resolution: the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy prop.
   * Same value domain as the legacy props (constant or column name).
   */
  private angleValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedIconLayer',
      'getAngle',
      this.props.getAngle,
      this.props.angle,
    );
  }

  private colorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedIconLayer',
      'getColor',
      this.props.getColor,
      this.props.color,
    );
  }

  private sizeValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedIconLayer',
      'getSize',
      this.props.getSize,
      this.props.size,
    );
  }

  private pixelOffsetValue(): [number, number] | number[] | string | undefined {
    return resolveAccessorAlias<[number, number] | number[] | string>(
      'AnimatedIconLayer',
      'getPixelOffset',
      this.props.getPixelOffset,
      this.props.pixelOffset,
    );
  }

  /** Resolve `iconProperty` to a categorical-column NAME, or '' when unset. */
  private iconPropertyValue(): string {
    const p = this.props.iconProperty;
    return typeof p === 'string' ? p : '';
  }

  /**
   * The `iconMapping` in OBJECT form, or null when it is a URL string / unset.
   * Per-category sprites need the mapping's geometry on the CPU to bake
   * `instanceIconDefs`; an unresolved URL can't provide it, so the layer warns
   * once and falls back to the constant icon (which the sublayer still resolves
   * once the async mapping lands).
   */
  private resolvedIconMapping(): Record<string, IconMappingEntry> | null {
    const mapping = this.props.iconMapping;
    if (!mapping) return null;
    if (typeof mapping === 'string') {
      if (this.iconPropertyValue()) {
        warnOnce(
          'AnimatedIconLayer:iconPropertyUrlMapping',
          '[AnimatedIconLayer] iconProperty needs the iconMapping CONTENT to ' +
            'bake per-feature sprites, but iconMapping is a URL string that ' +
            'only the sublayer resolves. Falling back to the constant `icon`; ' +
            'pass the mapping object to get per-category icons.',
        );
      }
      return null;
    }
    return mapping;
  }

  /**
   * Resolve `filterProperty` to a baked-column NAME. Accessor-alias of deck's
   * `getFilterValue`: a function-valued prop warns once and is ignored (there
   * is no legacy prop, so the fallback is "no filter" — `undefined`).
   */
  private filterPropertyValue(): string | undefined {
    return resolveAccessorAlias<string | undefined>(
      'AnimatedIconLayer',
      'filterProperty',
      this.props.filterProperty,
      undefined,
    );
  }

  /**
   * Digest of the layer-level inputs baked into every sublayer. When it
   * changes, every cached `IconLayer` holds a frozen copy of a stale value, so
   * the whole sublayer cache is thrown away.
   *
   * Which props participate is decided by {@link ICON_PROP_EFFECTS} rather than
   * by an enumeration here, so a new prop cannot silently miss the key. The
   * remaining inputs are not props of this layer at all — the inherited
   * composite/time props ride the positional `extra` channel.
   */
  private computeLayerPropsKey(): string {
    return buildLayerPropsKey<_AnimatedIconLayerProps>(
      this.props,
      ICON_PROP_EFFECTS,
      {
        overrides: {
          // The sublayer is built from the RESOLVED alias value, so the key has
          // to track it: keying the raw prop leaves every cached sublayer stale
          // when only the alias changes.
          angle: this.angleValue(),
          color: this.colorValue(),
          size: this.sizeValue(),
          pixelOffset: this.pixelOffsetValue(),
          filterProperty: this.filterPropertyValue(),
          // A Texture's pixels cannot be digested, so the atlas keys by URL
          // string or by reference identity; the mapping keys by CONTENT
          // (memoized per reference), so a fresh-but-equal literal costs no
          // rebuild while a real edit invalidates.
          iconAtlas: iconAtlasToken(this.props.iconAtlas),
          iconMapping: iconMappingDigest(this.props.iconMapping),
        },
        extra: [
          // Composite props that getSubLayerProps bakes into every sublayer
          // (opacity/pickable/visible, coordinateSystem, modelMatrix, highlight
          // props, _subLayerProps overrides…) plus the user's updateTriggers.
          inheritedPropsDigest(this.props),
          updateTriggersDigest(this.props.updateTriggers),
          // Inherited time props that `buildSublayer` forwards directly.
          this.props.timeWindow,
          this.props.timeHeightScale,
          this.props.timeHeightOrigin,
        ],
      },
    );
  }

  /**
   * True when the CPU glide path is active: `interpolate` on, reduced-motion
   * off, a resolvable `idProperty`, and wake off. Any unmet condition (the
   * default) leaves the GPU window/wake path byte-identical.
   */
  private interpolationActive(): boolean {
    return (
      this.props.interpolate === true &&
      this.props.reducedMotion !== true &&
      !(this.props.wakeLength > 0) &&
      this.idPropertyValue().length > 0
    );
  }

  /** Resolve `idProperty` to a column NAME, or '' when unset/blank. */
  private idPropertyValue(): string {
    const p = this.props.idProperty;
    return typeof p === 'string' ? p : '';
  }

  /**
   * Bump a state counter each tick so the CPU-interpolated glide advances —
   * ONLY when the glide branch is active and sim-time actually moved. The GPU
   * window/wake path animates via a draw-time uniform and needs no
   * renderLayers() pass, so this is a no-op there (byte-identical default-off
   * behaviour).
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    if (!this.interpolationActive()) return;
    const { tiles } = this.state;
    if (tiles && tiles.length > 0 && time !== this.lastInterpFrameTime) {
      this.lastInterpFrameTime = time;
      this.setState({
        interpFrame: ((this.state as any).interpFrame || 0) + 1,
      });
    }
  }

  renderLayers(): Layer[] {
    // Glide (motion interpolation): pool samples by id, emit ONE IconLayer of
    // interpolated active poses. Off / reduced-motion / no id ⇒ falls through
    // to the byte-identical GPU window path below.
    if (this.interpolationActive()) {
      return this.renderInterpolated();
    }

    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune cache only when the tile-array ref changed — when the parent hands
    // us the same `state.tiles` instance, the live and cached sets are
    // identical by construction and the walks are pure overhead.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tileLayer of tile.layers)
          live.add(tileLayerKey(tile.id, tileLayer.name));
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      for (const key of this.sublayerCache.keys()) {
        if (!live.has(key)) this.sublayerCache.delete(key);
      }
      this.lastTilesRef = tiles;
    }

    // Any layer-level prop change invalidates every cached sublayer.
    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastLayerPropsKey) {
      this.lastLayerPropsKey = layerPropsKey;
      this.sublayerCache.clear();
    }

    const sublayers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer);
        if (!prepared) continue;
        const cached = this.sublayerCache.get(prepared.tileKey);
        if (
          cached &&
          cached.preparedKey === prepared &&
          cached.layerPropsKey === layerPropsKey
        ) {
          sublayers.push(cached.layer);
          continue;
        }
        const layer = this.buildSublayer(prepared);
        this.sublayerCache.set(prepared.tileKey, {
          layer,
          preparedKey: prepared,
          layerPropsKey,
        });
        sublayers.push(layer);
      }
    }

    emit('renderLayers', {
      layer: 'AnimatedIconLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedIconLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  /**
   * styleKey digest of the props that change a tile's prepared `attributes`
   * (which angle/color/size column, palette content). Drives the per-tile
   * cache check.
   */
  private computeStyleKey(): string {
    const angle = this.angleValue();
    const color = this.colorValue();
    const size = this.sizeValue();
    const pixelOffset = this.pixelOffsetValue();
    const angleProp = typeof angle === 'string' ? angle : '';
    const colorProp = typeof color === 'string' ? color : '';
    const sizeProp = typeof size === 'string' ? size : '';
    const pixelOffsetProp = typeof pixelOffset === 'string' ? pixelOffset : '';
    // Palette identity matters only when color is a column name. Digests are
    // memoized per object reference (style-digest.ts), so this stays a WeakMap
    // lookup per tile, not a re-serialization. The colorMapping branch keys
    // CONTENT + colorMappingDefault (both baked into the CPU-expanded RGBA
    // buffer, so editing either must re-prepare the tile) and the CPU↔GPU
    // toggle (which adds/removes the getColor attribute).
    const mapping = this.props.colorMapping;
    const mapDefault = (this.props.colorMappingDefault ?? [0, 0, 0, 0]).join(
      ',',
    );
    // Filter column NAME is baked into the `filterValue` attribute, so a change
    // must re-prepare tiles (and, via the new preparedKey, rebuild sublayers —
    // covering the unset↔set toggle that adds/removes STTDataFilterExtension).
    const filterProp = this.filterPropertyValue() ?? '';
    // Per-category sprites (`iconProperty`) bake the resolved iconMapping
    // GEOMETRY into the instanceIconDefs attribute, so both the column and the
    // mapping's CONTENT (plus the category→name indirection and the fallback
    // `icon`) have to re-prepare tiles, not just rebuild sublayers.
    const iconProp = this.iconPropertyValue();
    const iconKey = iconProp
      ? `${iconProp}~${this.props.icon}~${iconMappingDigest(
          this.props.iconMapping,
        )}~${
          this.props.iconCategoryMapping
            ? categoryIconMappingDigest(this.props.iconCategoryMapping)
            : ''
        }`
      : '';
    return `${angleProp}|${colorProp}|${sizeProp}|${pixelOffsetProp}|${
      colorProp
        ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${colorProp && mapping ? `m${colorMappingDigest(mapping)}` : 'g'}|d${mapDefault}|f${filterProp}|i${iconKey}|${updateTriggersDigest(this.props.updateTriggers)}`;
  }

  /**
   * Fetch the cached binary `data` object for a single tile, building (and
   * caching) it on a miss. Returns a reference-stable PreparedTile so deck.gl
   * can short-circuit GPU re-uploads.
   */
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    if (tileLayer.features.featureCount === 0) return null;
    // Icons are instanced ONE PER FEATURE at `positions[i]`, so a linestring /
    // polygon layer would silently read the first `featureCount` VERTICES of a
    // flattened vertex run and bunch every marker onto the first few paths.
    if (
      !expectGeometry(
        tileLayer.features.geometryType,
        [GeometryType.Point],
        this.props.id,
        tileLayer.name,
      )
    ) {
      return null;
    }
    const styleKey = this.computeStyleKey();
    const tileKey = tileLayerKey(tile.id, tileLayer.name);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', {
        layer: 'AnimatedIconLayer',
        tileKey,
        cached: true,
        ms: 0,
      });
      return cached;
    }
    const prepared = this.buildTileData(tile, tileLayer);
    if (prepared) this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /**
   * Build the binary `data` object for a single tile from scratch (no caching).
   */
  private buildTileData(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;

    const angleValue = this.angleValue();
    const colorValue = this.colorValue();
    const sizeValue = this.sizeValue();
    const pixelOffsetValue = this.pixelOffsetValue();
    const angleProp = typeof angleValue === 'string' ? angleValue : '';
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const sizeProp = typeof sizeValue === 'string' ? sizeValue : '';
    const pixelOffsetProp =
      typeof pixelOffsetValue === 'string' ? pixelOffsetValue : '';
    const styleKey = this.computeStyleKey();
    const tileKey = tileLayerKey(tile.id, tileLayer.name);

    const t0 = performance.now();
    const count = binary.featureCount;
    const srcDims = binary.positionDimensions ?? 2;

    // IconLayer expects size-3 positions. When the tile is 2D, pad once into a
    // fresh Float64Array; 3D tiles ride zero-copy.
    const positions: Float64Array =
      srcDims === 3
        ? binary.positions
        : padPositionsTo3D(binary.positions, count);

    const attributes: PreparedTile['data']['attributes'] = {
      getPosition: { value: positions, size: 3 },
      // Extension-registered attribute names — must match
      // TimeFilterExtension.initializeState exactly. Zero-copy: the tile's own
      // Float32Arrays (relative to binary.timeOffset) ride straight to the GPU.
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    let gpuPalette: Color[] | null = null;

    // Property-driven rotation — IconLayer's getAngle attribute (degrees). The
    // tile's numeric column is already a Float32Array, so it rides zero-copy.
    if (angleProp) {
      const values = binary.numericProps[angleProp];
      if (values) attributes.getAngle = { value: values, size: 1 };
    }

    // Property-driven size — zero-copy Float32Array ride-along.
    if (sizeProp) {
      const values = binary.numericProps[sizeProp];
      if (values) attributes.getSize = { value: values, size: 1 };
    }

    // Property-driven pixel offset — a size-2 interleaved `vectorProps` column
    // ([x0,y0, x1,y1, …]) bound zero-copy to the getPixelOffset instanced
    // attribute. `instancePixelOffset` is a FLOAT attribute, so the leaf type is
    // load-bearing: a u8 leaf would produce a `uint8x2` vertex buffer against
    // it (a format mismatch, not a rescale). bindFloatVector enforces that and
    // warns once; anything it rejects falls through to the constant offset.
    if (pixelOffsetProp) {
      const bound = bindFloatVector(
        binary.vectorProps?.[pixelOffsetProp],
        2,
        'AnimatedIconLayer',
        pixelOffsetProp,
      );
      if (bound) attributes.getPixelOffset = bound;
    }

    // Per-CATEGORY sprites — bake `instanceIconDefs` ourselves rather than let
    // deck resolve `getIcon` + `getInstanceIconDef` once per ROW (a fresh
    // 7-element array per feature). AttributeManager.update resolves
    // `buffers.instanceIconDefs` through setExternalBuffer BEFORE the accessor
    // path, so this bypasses both. Cost: one iconMapping lookup per CATEGORY
    // plus a typed-array fill.
    const iconProp = this.iconPropertyValue();
    if (iconProp) {
      const mapping = this.resolvedIconMapping();
      const cat = mapping ? binary.categoricalProps[iconProp] : undefined;
      if (mapping && cat) {
        attributes.instanceIconDefs = {
          value: this.buildIconDefs(cat, count, mapping),
          size: ICON_DEF_SIZE,
        };
      } else if (mapping && binary.numericProps[iconProp]) {
        warnOnce(
          'AnimatedIconLayer:iconPropertyNumeric',
          `[AnimatedIconLayer] iconProperty "${iconProp}" is a NUMERIC column; ` +
            'sprite selection reads a CATEGORICAL (string) column. Falling back ' +
            'to the constant `icon` for tiles where it is numeric.',
        );
      }
    }

    // Property-driven color — categorical only. A numeric color column has no
    // natural categorical lookup here, so it's ignored (constant color applies)
    // rather than guessing a ramp.
    if (colorProp) {
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        if (this.props.colorMapping) {
          // Stable CPU path (B3): indexed by the category STRING → a per-feature
          // RGBA getColor buffer, so the same category is the same color across
          // tiles carrying different category subsets. No GPU palette.
          const fallback =
            this.props.colorMappingDefault ?? ([0, 0, 0, 0] as Color);
          attributes.getColor = {
            value: coreExpandCategoricalColors(
              binary,
              {
                property: colorProp,
                colorMapping: this.props.colorMapping as Record<
                  string,
                  RGBA255
                >,
                colorMappingDefault: fallback as RGBA255,
              },
              'u8',
            ) as Uint8Array,
            size: 4,
            normalized: true,
          };
        } else {
          // GPU palette path (first-seen index; not stable across tiles).
          attributes.instanceCategoryIndex = {
            value: categoryIndicesToFloat32(
              cat.indices,
              count,
              (this.props.colorPalette ?? DEFAULT_PALETTE).length,
              'AnimatedIconLayer',
            ),
            size: 1,
          };
          gpuPalette = appendNullCategorySlot(
            this.props.colorPalette ?? DEFAULT_PALETTE,
            this.props.colorMappingDefault as Color | undefined,
          );
        }
      }
    }

    // Column range filter (STTDataFilterExtension): bind the named numeric column
    // to the `filterValue` attribute zero-copy (already a Float32Array). Absent
    // column ⇒ no attribute baked → the sublayer idles the filter for this tile
    // (renders unfiltered), mirroring how a missing color/size column falls
    // back. IconLayer is instanced one-per-feature, so a per-feature column
    // binds directly. A categorical column can't be range-filtered in v1 —
    // warn once.
    const filterProp = this.filterPropertyValue();
    if (filterProp) {
      const values = binary.numericProps[filterProp];
      if (values) {
        attributes.filterValue = { value: values, size: 1 };
      } else if (binary.categoricalProps[filterProp]) {
        warnOnce(
          'AnimatedIconLayer:filterPropertyCategorical',
          `[AnimatedIconLayer] filterProperty "${filterProp}" is a categorical ` +
            'column; v1 range-filters NUMERIC columns only. The filter is ignored ' +
            'for tiles where the column is categorical.',
        );
      }
    }

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      data: { length: count, attributes },
      timeOffset: binary.timeOffset,
      gpuPalette,
      tile,
      layerName: tileLayer.name,
      features: binary,
    };
    emit('tilePrepare', {
      layer: 'AnimatedIconLayer',
      tileKey,
      cached: false,
      features: count,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  /**
   * Expand a categorical column into deck's size-7 `instanceIconDefs` buffer.
   *
   * PER CATEGORY (not per feature): the K distinct values each resolve to one
   * icon name (through `iconCategoryMapping`, or identity) and one
   * {@link writeIconDef} call, into a `(K + 1) × 7` table whose last slot is
   * the fallback {@link _AnimatedIconLayerProps.icon} — used for the NULL
   * sentinel (0xffff) and for out-of-range indices. The per-feature pass is
   * then seven scalar copies with no allocation, so a 100k-feature tile costs
   * K mapping lookups instead of 100k lookups + 100k throwaway arrays.
   */
  private buildIconDefs(
    cat: { indices: Uint16Array; categories: string[] },
    count: number,
    mapping: Record<string, IconMappingEntry>,
  ): Float32Array {
    const categoryMapping = this.props.iconCategoryMapping ?? null;
    const fallbackIcon = this.props.icon;
    const K = cat.categories.length;
    const table = new Float32Array((K + 1) * ICON_DEF_SIZE);
    let missing = '';
    for (let k = 0; k < K; k++) {
      const value = cat.categories[k];
      const name = categoryMapping
        ? (categoryMapping[value] ?? fallbackIcon)
        : value;
      const entry = mapping[name] ?? mapping[fallbackIcon];
      if (!entry && !missing) missing = name;
      writeIconDef(table, k * ICON_DEF_SIZE, entry);
    }
    writeIconDef(table, K * ICON_DEF_SIZE, mapping[fallbackIcon]);
    if (missing) {
      warnOnce(
        'AnimatedIconLayer:iconCategoryUnmapped',
        `[AnimatedIconLayer] iconMapping has no entry for "${missing}" (and no ` +
          `fallback entry for icon "${fallbackIcon}") — those features render a ` +
          'zero-size, invisible sprite. Add the entry, or map the category to a ' +
          'known icon name via `iconCategoryMapping`.',
      );
    }

    const out = new Float32Array(count * ICON_DEF_SIZE);
    for (let i = 0; i < count; i++) {
      const idx = cat.indices[i];
      const slot = idx === 0xffff || idx >= K ? K : idx;
      const s = slot * ICON_DEF_SIZE;
      const o = i * ICON_DEF_SIZE;
      out[o] = table[s];
      out[o + 1] = table[s + 1];
      out[o + 2] = table[s + 2];
      out[o + 3] = table[s + 3];
      out[o + 4] = table[s + 4];
      out[o + 5] = table[s + 5];
      out[o + 6] = table[s + 6];
    }
    return out;
  }

  private buildSublayer(prepared: PreparedTile): IconLayer {
    // `Required<>`-typed: the defaultProps value guarantees a value here.
    const timeWindow = this.props.timeWindow;
    const icon = this.props.icon;
    const angleValue = this.angleValue();
    const colorValue = this.colorValue();
    const sizeValue = this.sizeValue();
    const pixelOffsetValue = this.pixelOffsetValue();
    const constAngle = typeof angleValue === 'number' ? angleValue : 0;
    const constSize = typeof sizeValue === 'number' ? sizeValue : 12;
    const constColor = (
      Array.isArray(colorValue) ? colorValue : ([255, 255, 255, 255] as Color)
    ) as Color;
    const constPixelOffset = (
      Array.isArray(pixelOffsetValue) ? pixelOffsetValue : [0, 0]
    ) as [number, number];

    if (!this.props.iconAtlas || !this.props.iconMapping) {
      warnOnce(
        'AnimatedIconLayer:missingAtlas',
        '[AnimatedIconLayer] iconAtlas and iconMapping are required to render ' +
          'icons; nothing will be drawn until both are supplied.',
      );
    }

    // CategoryColorExtension props: when this tile uses the GPU palette path we
    // pass the resolved palette + useCategoryColor=true. Otherwise the
    // extension idles (its shader branch is gated by useCategoryColor).
    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedIconLayer:paletteOverflow',
        `[AnimatedIconLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Column filter: install STTDataFilterExtension only when a column is named
    // (per-layer constant ⇒ stable list across this layer's sublayers). Whether
    // THIS tile actually baked the attribute gates the per-tile enable, so a
    // tile missing the column renders unfiltered (idle extension).
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;

    // Keep the extension list constant across sublayers (cache-storm rationale,
    // as in AnimatedPointLayer). User extensions from the top-level
    // `extensions` prop are appended via composeExtensions.
    const extensions = this.composeExtensions([
      this.timeFilterExtension,
      this.categoryColorExtension,
      // Column range filter, when a filterProperty is set. Multiplies its own
      // in/out (or soft-fade) factor into color.a — commutes with the time and
      // categorical alphas, so it composes cleanly with both.
      ...(filterProp ? [this.dataFilterExtension] : []),
    ]);

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.icons` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('icons', prepared.tileKey, {
      data: prepared.data as any,
      // Identity comparator: deck.gl skips prop-diff for `data` entirely when
      // the same object reference comes back. Pairs with the preparedTileCache.
      dataComparator: (a: any, b: any) => a === b,

      // Icon atlas + mapping forwarded verbatim.
      iconAtlas: this.props.iconAtlas,
      iconMapping: this.props.iconMapping,
      // Atlas-fetch failure hook + the icon-side load options (headers /
      // credentials / custom fetch for the atlas URL). `loadOptions` is NOT in
      // getSubLayerProps' forwarded allowlist, so it only reaches IconManager
      // because we pass it here — and it is deliberately NOT the base layer's
      // (archive) loadOptions. See the `iconLoadOptions` prop docs.
      onIconError: this.props.onIconError ?? null,
      ...(this.props.iconLoadOptions
        ? { loadOptions: this.props.iconLoadOptions }
        : {}),
      // Constant icon for every feature. When `iconProperty` baked the
      // `instanceIconDefs` attribute above, that external buffer wins (deck
      // resolves it before the accessor) and this is the fallback for tiles
      // that lack the column.
      getIcon: () => icon,

      sizeUnits: this.props.sizeUnits,
      sizeScale: this.props.sizeScale,
      sizeMinPixels: this.props.sizeMinPixels,
      sizeMaxPixels: this.props.sizeMaxPixels,
      sizeBasis: this.props.sizeBasis,
      billboard: this.props.billboard,
      alphaCutoff: this.props.alphaCutoff,
      // Atlas sampler params (filtering/wrap); null keeps IconManager defaults.
      textureParameters: this.props.textureParameters,

      // Constant fallbacks — used when the matching binary attribute is absent.
      getAngle: constAngle,
      getSize: constSize,
      getColor: constColor,
      getPixelOffset: constPixelOffset,

      // Time-as-height (space-time cube): whole icons lift by start time.
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,

      extensions,

      // TimeFilterExtension wiring — per-tile timeOffset and window (no trail).
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      // Wake mode (B3): wakeLength>0 flips the extension into the one-sided
      // alpha tail. 0 (default) keeps the symmetric window — no behaviour change.
      wakeLength: this.props.wakeLength,
      wakeTailScale: this.props.wakeTailScale,

      // TileLayer convention: the source tile rides on the sublayer so the base
      // getPickingInfo can enrich info.tile / decode the picked feature.
      tile: prepared.tile,
      sttFeatures: prepared.features,

      // Always set `useCategoryColor` so tests / debug tooling can distinguish
      // the two paths via prop inspection. The extension only works when true.
      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: prepared.gpuPalette! } : {}),

      // STTDataFilterExtension wiring (only when a filterProperty is set). The
      // constant getFilterValue is the fallback for tiles missing the column;
      // filterEnabled is additionally gated on THIS tile having baked it.
      ...(filterProp
        ? {
            getFilterValue: 0,
            filterEnabled: hasFilter && this.props.filterEnabled !== false,
            filterRange: this.props.filterRange ?? null,
            filterSoftRange: this.props.filterSoftRange ?? null,
          }
        : {}),
    });
    // `_subLayerProps: { icons: { type } }` swaps the sublayer class — the
    // CompositeLayer-native renderSubLayers-style override point.
    const SubLayerClass = this.getSubLayerClass('icons', IconLayer);
    return new SubLayerClass(props as any);
  }

  /* ── Glide (motion-interpolation) path ───────────────────────────────────
   * Pool the loaded tiles' samples by `idProperty` and emit ONE IconLayer of
   * each active entity's interpolated pose (position + heading). Reuses the
   * shared track kernel; visibility is implicit (only active tracks emitted) so
   * there is no TimeFilterExtension and no window uniform.
   */

  /** Digest of the props feeding the POOLED glide index (columns + baked color). */
  private computeInterpIndexKey(): string {
    const colorValue = this.colorValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const angleValue = this.angleValue();
    const angleProp = typeof angleValue === 'string' ? angleValue : '';
    return [
      this.idPropertyValue(),
      colorProp,
      angleProp,
      colorProp && this.props.colorMapping
        ? colorMappingDigest(this.props.colorMapping)
        : 0,
      Array.isArray(this.props.colorMappingDefault)
        ? this.props.colorMappingDefault.join(',')
        : '',
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  /** Resolve which tile columns the kernel reads for the glide index. */
  private interpTrackFieldConfig(): TrackFieldConfig {
    const colorValue = this.colorValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const angleValue = this.angleValue();
    const angleProp = typeof angleValue === 'string' ? angleValue : '';
    // Silent-transparency guard (mirrored from AnimatedPointLayer): the CPU
    // glide path resolves per-track color through the STRING-keyed `colorMapping`,
    // not the GPU first-seen palette. A categorical color column with NO
    // colorMapping falls to the transparent colorMappingDefault ([0,0,0,0]) for
    // every track, so glide renders every icon INVISIBLE — warn rather than blank.
    if (colorProp && !this.props.colorMapping) {
      warnOnce(
        'AnimatedIconLayer:interpNoColorMapping',
        `[AnimatedIconLayer] interpolate is on with a categorical color column ` +
          `("${colorProp}") but no \`colorMapping\` — the CPU glide path cannot ` +
          `use the GPU first-seen palette, so every icon resolves to the ` +
          `transparent colorMappingDefault and renders INVISIBLE. Provide a ` +
          `\`colorMapping\` (category → color) or a constant color for glide.`,
      );
    }
    return {
      trackIdProperty: this.idPropertyValue(),
      colorProperty: colorProp,
      labelProperty: '',
      // Heading column (DEGREES) drives the interpolated getAngle; blank ⇒
      // bearing-from-motion fallback (computed here, not by the kernel).
      headingProperty: angleProp,
      lengthProperty: '',
      widthProperty: '',
      heightProperty: '',
      speedProperty: '',
      colorMapping: this.props.colorMapping,
      colorMappingDefault: (this.props.colorMappingDefault ?? [
        0, 0, 0, 0,
      ]) as Color,
    };
  }

  /** Fade ramps + degrees-heading unit + max-gap hold fed to the kernel. */
  private interpSampleConfig(): TrackSampleConfig {
    return {
      defaultLength: 0,
      defaultWidth: 0,
      defaultHeight: 0,
      fadeInDuration: this.props.fadeInDuration ?? 0,
      fadeOutDuration: this.props.fadeOutDuration ?? 0,
      // IconLayer.getAngle is DEGREES and the heading column is degrees too, so
      // interpolate the heading along the shortest DEGREE arc.
      angleUnit: 'deg',
      maxGapMs: this.props.maxInterpolationGap ?? Infinity,
    };
  }

  /**
   * Bearing (deck IconLayer getAngle degrees — CCW from the icon's default "up"
   * orientation) from the entity's direction of travel, for when there is no
   * heading column. Reuses the already-sampled pose `s` at `now` and samples a
   * hair ahead (or behind, at the track's end); returns null when the marker
   * isn't moving (a held sample / degenerate delta) so the caller keeps the
   * constant angle instead of spinning to an arbitrary heading.
   */
  private bearingDeg(
    track: Track,
    s: Sample,
    now: number,
    cfg: TrackSampleConfig,
  ): number | null {
    let from: Sample = s;
    let to: Sample | null = kernelSampleTrack(track, now + 1, cfg);
    if (!to) {
      const behind = kernelSampleTrack(track, now - 1, cfg);
      if (!behind) return null;
      from = behind;
      to = s;
    }
    const dLon = to.lon - from.lon;
    const dLat = to.lat - from.lat;
    const cosLat = Math.cos((from.lat * Math.PI) / 180);
    const dEast = dLon * cosLat;
    const dNorth = dLat;
    if (dEast === 0 && dNorth === 0) return null; // not moving
    // Icon default points up (north); deck getAngle is CCW degrees. The CCW
    // angle from north to the travel vector is atan2(-dEast, dNorth).
    return Math.atan2(-dEast, dNorth) * RAD_TO_DEG;
  }

  /**
   * Ensure the glide index reflects the current tile set. Rebuilds fully when a
   * feeding style prop changed (the maintainer + pick rows reset); otherwise the
   * {@link TrackIndexMaintainer} re-pools only ADDED tiles and re-sorts only
   * AFFECTED tracks, and pick rows are scanned only for not-yet-seen tiles — so
   * a sliding loader window costs O(changed tiles + affected tracks) instead of
   * the O(all snapshots) full rebuild that spiked frame time.
   */
  private syncInterpIndex(tiles: Tile[], indexKey: string): void {
    if (!this.interpMaintainer)
      this.interpMaintainer = new TrackIndexMaintainer();
    if (this.interpTrackIndexKey !== indexKey) {
      this.interpMaintainer.reset();
      this.interpPickRows = null;
      this.interpPickRowsScanned = null;
    }
    const cfg = this.interpTrackFieldConfig();
    const result = this.interpMaintainer.sync(tiles, cfg);
    this.interpTrackIndex = result.tracks;
    if (result.trackIdMissing) {
      warnOnce(
        'AnimatedIconLayer:interpNoIdColumn',
        `[AnimatedIconLayer] interpolate is on but no \`${cfg.trackIdProperty}\` ` +
          `categorical column was found — each sample becomes its own held ` +
          `instance (no glide). Set idProperty to an EXACT per-entity id column.`,
      );
    }
    this.scanInterpPickRows(tiles, cfg.trackIdProperty);
    this.interpTrackIndexKey = indexKey;
    this.lastTilesRef = tiles;
  }

  /**
   * Decode ONE representative source feature per entity id, for glide picking.
   * Incremental: only (tile, layer)s not scanned before are walked, and an id
   * already present is never re-decoded (entity-level props are
   * sample-invariant).
   *
   * BOUNDED, not accumulate-only: both caches are pruned to the RESIDENT set on
   * every call — pick rows to the ids still in {@link interpTrackIndex}, scanned
   * keys to the live (tile, layer) pairs. Retention was correct (only active
   * tracks are ever picked) but not bounded: over a long AIS / ADS-B session
   * every entity id ever seen kept a decoded `getFeatureProperties` object alive
   * forever. Pruning costs O(cached ids) per tile-set change — strictly less
   * than the pooling pass that precedes it — and a re-entering tile is simply
   * re-scanned. Reset wholesale with the maintainer on a feeding-prop change.
   */
  private scanInterpPickRows(tiles: Tile[], idProp: string): void {
    if (!this.interpPickRows) this.interpPickRows = new Map();
    if (!this.interpPickRowsScanned) this.interpPickRowsScanned = new Set();
    const prov = this.interpPickRows;
    const scanned = this.interpPickRowsScanned;

    const live = new Set<string>();
    for (const tile of tiles) {
      for (const tileLayer of tile.layers)
        live.add(tileLayerKey(tile.id, tileLayer.name));
    }
    for (const key of scanned) {
      if (!live.has(key)) scanned.delete(key);
    }
    // Drop rows for entities no longer in the pooled (resident) track index, so
    // the map's high-water mark is the resident track count, not the session's.
    const tracks = this.interpTrackIndex;
    if (tracks) {
      for (const id of prov.keys()) {
        if (!tracks.has(id)) prov.delete(id);
      }
    }

    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const key = tileLayerKey(tile.id, tileLayer.name);
        if (scanned.has(key)) continue;
        scanned.add(key);
        const binary = tileLayer.features;
        // Glide reads `positions[i]` per feature through the shared track
        // kernel; a non-point layer would misread the vertex run.
        if (
          !expectGeometry(
            binary.geometryType,
            [GeometryType.Point],
            this.props.id,
            tileLayer.name,
          )
        ) {
          continue;
        }
        const col = binary.categoricalProps[idProp];
        if (!col) continue;
        const count = binary.featureCount;
        for (let i = 0; i < count; i++) {
          const idx = col.indices[i];
          if (idx === 0xffff) continue;
          const k = col.categories[idx];
          if (k === undefined || prov.has(k)) continue;
          prov.set(k, getFeatureProperties(binary, i) ?? {});
        }
      }
    }
  }

  /** Grow-only Float64 scratch buffer (reused across glide frames). */
  private ensureInterpPos(len: number): Float64Array {
    let b = this.interpPosBuf;
    if (!b || b.length < len) {
      b = new Float64Array(len);
      this.interpPosBuf = b;
    }
    return b;
  }

  /** Grow-only Float32 scratch buffer (reused across glide frames). */
  private ensureInterpAng(len: number): Float32Array {
    let b = this.interpAngBuf;
    if (!b || b.length < len) {
      b = new Float32Array(len);
      this.interpAngBuf = b;
    }
    return b;
  }

  /** Grow-only Uint8 scratch buffer (reused across glide frames). */
  private ensureInterpCol(len: number): Uint8Array {
    let b = this.interpColBuf;
    if (!b || b.length < len) {
      b = new Uint8Array(len);
      this.interpColBuf = b;
    }
    return b;
  }

  /**
   * Glide render pass: refresh the pooled index when the tile set / feeding prop
   * changes (incrementally — see {@link syncInterpIndex}), then interpolate one
   * pose (position + heading) per active entity straight into the reused output
   * buffers and emit a single IconLayer.
   */
  private renderInterpolated(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.interpTrackIndex = null;
      this.interpMaintainer?.reset();
      this.interpPickRows = null;
      this.interpPickRowsScanned = null;
      this.lastTilesRef = null;
      return [];
    }
    if (!this.props.iconAtlas || !this.props.iconMapping) {
      warnOnce(
        'AnimatedIconLayer:missingAtlas',
        '[AnimatedIconLayer] iconAtlas and iconMapping are required to render ' +
          'icons; nothing will be drawn until both are supplied.',
      );
    }

    const indexKey = this.computeInterpIndexKey();
    if (
      this.lastTilesRef !== tiles ||
      this.interpTrackIndexKey !== indexKey ||
      !this.interpTrackIndex
    ) {
      this.syncInterpIndex(tiles, indexKey);
    }

    const index = this.interpTrackIndex!;
    const now = this.getCurrentTime();
    const cfg = this.interpSampleConfig();
    const angleValue = this.angleValue();
    const hasHeadingColumn = typeof angleValue === 'string';
    const constAngle = typeof angleValue === 'number' ? angleValue : 0;
    const colorValue = this.colorValue();
    const perTrackColor = typeof colorValue === 'string';
    const constColor = (
      Array.isArray(colorValue) ? colorValue : ([255, 255, 255, 255] as Color)
    ) as Color;

    // Track count bounds the active count; size the reused buffers to it and
    // fill only the active prefix (subarray'd to the exact length below).
    const cap = index.size;
    const positions = this.ensureInterpPos(cap * 3);
    const angles = this.ensureInterpAng(cap);
    // Always bake per-instance color: it folds the appear/disappear fade
    // (sample.alpha) and, when color names a column, the stable per-track color
    // the kernel resolved through colorMapping.
    const colors = this.ensureInterpCol(cap * 4);
    const pickRows: (Record<string, unknown> | undefined)[] = [];
    let w = 0;
    for (const track of index.values()) {
      const s = kernelSampleTrack(track, now, cfg);
      if (!s) continue;
      let angleDeg: number;
      if (hasHeadingColumn) {
        // s.heading is already degrees (angleUnit 'deg'); NaN ⇒ no column value.
        angleDeg = Number.isFinite(s.heading) ? s.heading : constAngle;
      } else {
        angleDeg = this.bearingDeg(track, s, now, cfg) ?? constAngle;
      }
      const o3 = w * 3;
      positions[o3] = s.lon;
      positions[o3 + 1] = s.lat;
      positions[o3 + 2] = s.alt;
      angles[w] = angleDeg;
      const base = perTrackColor ? s.track.color : constColor;
      const o4 = w * 4;
      colors[o4] = base[0];
      colors[o4 + 1] = base[1];
      colors[o4 + 2] = base[2];
      colors[o4 + 3] = Math.round((base[3] ?? 255) * s.alpha);
      pickRows.push(this.interpPickRows?.get(s.track.trackId));
      w++;
    }

    emit('renderLayers', {
      layer: 'AnimatedIconLayer',
      mode: 'interpolate',
      tiles: tiles.length,
      tracks: index.size,
      active: w,
      ms: performance.now() - t0,
    });

    if (w === 0) return [];
    return [
      this.buildInterpolatedSublayer(
        positions.subarray(0, w * 3),
        angles.subarray(0, w),
        colors.subarray(0, w * 4),
        pickRows,
        w,
      ),
    ];
  }

  /** Bake the active interpolated icon poses (already written into the buffer
   * views) into one IconLayer sublayer. */
  private buildInterpolatedSublayer(
    positions: Float64Array,
    angles: Float32Array,
    colors: Uint8Array,
    pickRows: (Record<string, unknown> | undefined)[],
    n: number,
  ): IconLayer {
    const icon = this.props.icon;
    const colorValue = this.colorValue();
    const constColor = (
      Array.isArray(colorValue) ? colorValue : ([255, 255, 255, 255] as Color)
    ) as Color;
    const sizeValue = this.sizeValue();
    const constSize = typeof sizeValue === 'number' ? sizeValue : 12;
    const angleValue = this.angleValue();
    const constAngle = typeof angleValue === 'number' ? angleValue : 0;
    const pixelOffsetValue = this.pixelOffsetValue();
    const constPixelOffset = (
      Array.isArray(pixelOffsetValue) ? pixelOffsetValue : [0, 0]
    ) as [number, number];

    const data = {
      length: n,
      attributes: {
        getPosition: { value: positions, size: 3 },
        getAngle: { value: angles, size: 1 },
        getColor: { value: colors, size: 4, normalized: true },
      },
    };

    // No TimeFilterExtension: visibility is implicit (only active entities are
    // emitted), so no start/end-time attributes and no window uniform.
    const extensions = this.composeExtensions([]);
    const props = this.composeSubLayerProps('icons', 'interp', {
      data: data as any,
      dataComparator: (a: any, b: any) => a === b,

      iconAtlas: this.props.iconAtlas,
      iconMapping: this.props.iconMapping,
      onIconError: this.props.onIconError ?? null,
      ...(this.props.iconLoadOptions
        ? { loadOptions: this.props.iconLoadOptions }
        : {}),
      // Glide re-emits ONE pose per ENTITY, not per sample, so there is no
      // per-instance category to read — `iconProperty` does not apply here and
      // every glided marker uses the constant icon.
      getIcon: () => icon,

      sizeUnits: this.props.sizeUnits,
      sizeScale: this.props.sizeScale,
      sizeMinPixels: this.props.sizeMinPixels,
      sizeMaxPixels: this.props.sizeMaxPixels,
      sizeBasis: this.props.sizeBasis,
      billboard: this.props.billboard,
      alphaCutoff: this.props.alphaCutoff,
      textureParameters: this.props.textureParameters,

      // Constant fallbacks; the binary attributes win per instance.
      getAngle: constAngle,
      getSize: constSize,
      getColor: constColor,
      getPixelOffset: constPixelOffset,

      extensions,

      // Picking: one instance per active entity (stride 1) — resolve to the
      // entity's decoded source feature via sttPickRows.
      tile: null,
      sttPickRows: pickRows,
      sttPickStride: 1,
    });
    const SubLayerClass = this.getSubLayerClass('icons', IconLayer);
    return new SubLayerClass(props as any);
  }

  /**
   * Picking. In the glide path the sublayer merges many tiles' entities into
   * one IconLayer, so resolve the hit to its entity's decoded source feature
   * via the per-instance pick rows; otherwise the base tile/sttFeatures path
   * (non-glide) applies.
   */
  getPickingInfo(params: GetPickingInfoParams): SpatioTemporalPickingInfo {
    const info = super.getPickingInfo(params);
    const pickRows = (
      params.sourceLayer?.props as
        | { sttPickRows?: (Record<string, unknown> | undefined)[] }
        | undefined
    )?.sttPickRows;
    if (pickRows && info.index >= 0 && info.object === undefined) {
      const row = pickRows[info.index];
      if (row) info.object = row;
    }
    return info;
  }
}

/**
 * Pad a 2D Float64Array of positions [x0,y0, x1,y1, ...] into a 3D buffer
 * [x0,y0,0, x1,y1,0, ...] for IconLayer's size-3 position attribute. The only
 * allocation per tile in the prepare step.
 */
function padPositionsTo3D(src: Float64Array, count: number): Float64Array {
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = src[i * 2];
    out[i * 3 + 1] = src[i * 2 + 1];
    // out[i * 3 + 2] = 0; (already zero-initialized)
  }
  return out;
}
