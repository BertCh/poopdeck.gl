// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedTripsLayer - GPU-efficient animated trips/trajectories
 *
 * Renders a "vehicle moving along the route" effect with a trailing fade.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One PathLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, startIndices,
 *   attributes }` interface, with attribute typed arrays referenced directly
 *   from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension instance. No layer-wide rebasing pass.
 * - `getTime` callback drives the trail uniform per draw without layer
 *   recreation, so the demo's tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is
 *   stable across renderLayers() calls; deck.gl short-circuits GPU
 *   re-uploads when the reference matches.
 *
 * Streaming is now additive: a new tile creates one new sublayer and one
 * GPU upload. Existing tiles' GPU buffers are untouched. The previous
 * consolidation path rebuilt every buffer on every tile arrival.
 *
 * TWO-TIER TILE CACHE (structural vs playhead-driven)
 * ---------------------------------------------------
 * A prepared tile carries TWO keys. `styleKey` is STRUCTURAL — colour/width
 * column names, palettes, ramps, the filter column, subclass knobs — and a
 * change there rebuilds the whole `data` object (a new reference ⇒
 * `changeFlags.dataChanged` ⇒ re-tessellation + a full attribute re-upload,
 * which is correct because the geometry-shaped buffers really did change).
 * `dynamicKey` is the quantized PLAYHEAD sub-step (`gradientStyleSuffix`),
 * which the flow-corridor subclasses advance ~5×/second. Crossing a sub-step
 * must NOT look like a data change: `refreshDynamicAttributes` keeps
 * `prepared.data` AND every unchanged attribute wrapper
 * (`getPath`, `filterValue`, …) reference-identical and swaps only the
 * playhead-driven wrappers, then `buildSublayer` invalidates exactly those
 * attributes via `updateTriggers`. Upstream then skips both
 * `pathTesselator.updateGeometry()` (PathLayer's `geometryChanged` only reacts
 * to `dataChanged || updateTriggersChanged.getPath`) and the fp64 hi/lo split
 * of the position buffer (`Attribute.setBinaryValue` /
 * `setExternalBuffer` short-circuit on WRAPPER-OBJECT identity, so a fresh
 * wrapper around an unchanged `Float64Array` defeats them). A ~500k-vertex
 * corridor tile used to pay ~1M doubles → 2M floats plus a multi-MB GPU write
 * about five times a second to change 4 bytes/vertex of colour — the tail half
 * of the "re-tessellates the whole network at ~6 Hz" regression.
 *
 * DEFAULT DRIFT vs upstream `PathLayer`/`TripsLayer` (deliberate, documented)
 * --------------------------------------------------------------------------
 *   `widthUnits`      'meters' → 'pixels'  (screen-stable trails at every zoom)
 *   `widthMinPixels`  0 → 2                (hairlines vanish on hidpi)
 *   `widthMaxPixels`  MAX_SAFE_INTEGER → 10
 *   `jointRounded`    false → true
 *   `capRounded`      false → true
 * The `widthMaxPixels` cap is the one that bites: a caller who switches to
 * `widthUnits: 'meters'` and scales up silently clamps at 10 px. That
 * combination warns once (see `buildSublayer`). Trail semantics also diverge
 * from upstream `TripsLayer` under `fadeTrail: false` — see that prop's doc.
 *
 * KNOWN PARITY GAP — per-SEGMENT trail time (deferred, attribute-budget bound)
 * ---------------------------------------------------------------------------
 * Upstream `TripsLayer` registers its `timestamps` attribute with TWO shader
 * views of the same buffer — `instanceTimestamps {vertexOffset: 0}` and
 * `instanceNextTimestamps {vertexOffset: 1}` — and interpolates along the
 * segment quad:
 *   `vTime = instanceTimestamps + (next - instanceTimestamps)
 *            * vPathPosition.y / vPathLength;`
 * STT's {@link TimeFilterExtension} registers ONE view (`instanceVertexTime`,
 * no `shaderAttributes`), so each segment instance reads only its START
 * vertex's time and `vTimeAlpha` is CONSTANT across the quad: the trail head
 * advances one whole segment at a time and the fade is a staircase, not a
 * glide. On sparse geometry (bridges, highways, coarse-sampled trips) that
 * reads as popping — which is precisely why {@link AnimatedTripHeadsLayer}
 * exists (its dot is a CPU-interpolated position, so it glides).
 *
 * Closing it costs ONE more vertex-attribute slot (a second `in` declaration
 * gets its own slot even though it shares the GL buffer), and the budget has
 * none free: NoPickingPathLayer 12 + TimeFilterExtension 3 = 15, and
 * CategoryColorExtension's `instanceCategoryIndex` — installed by default on
 * this layer — takes it to WebGL2's guaranteed 16-slot floor. A twin view
 * would be 17: a fatal link failure (blank trips) on GPUs that report exactly
 * 16. Freeing a slot means dropping `instanceStartTime`/`instanceEndTime` from
 * the shader inject for trail-only pipelines, but this layer's single
 * `TimeFilterExtension({mode:'trail'})` singleton is ALSO what
 * {@link FlowCorridorLayer} runs in WINDOW mode (it feeds those very
 * attributes via `timeBoundsForSublayer`), so the drop has to be a genuine
 * per-mode shader variant, not a registration tweak. That is an extension-side
 * change with real link-failure blast radius, so it is deferred rather than
 * half-landed here; there is no layer-side wiring to do in the meantime (the
 * twin view is derived from the SAME buffer via `vertexOffset`, so no new tile
 * attribute is involved).
 */

import { PathLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer, LayerContext } from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { NoPickingPathLayer } from '../internal/no-picking-path-layer.js';
import { TimeFilterExtension } from '../../extensions/time-filter-extension.js';
import { CategoryColorExtension } from '../../extensions/category-color-extension.js';
import { STTDataFilterExtension } from '../../extensions/data-filter-extension.js';
import type { DataFilterRange } from '../../extensions/data-filter-extension.js';
import { emit, isProbeEnabled } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
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
import {
  DEFAULT_TRIPS_PALETTE,
  GeometryType,
  tileLayerKey,
} from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** These layers index `positions` as a flattened vertex run per feature. */
const LINESTRING_ONLY = [GeometryType.LineString] as const;

/** Props added by {@link AnimatedTripsLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedTripsLayerProps}). */
export interface _AnimatedTripsLayerProps {
  /**
   * Units for `tripWidth`. 'pixels' (default) is screen-space; 'meters' makes
   * widths world-space so trails thicken/thin with zoom like real objects
   * (clamped by widthMin/MaxPixels), mirroring the maritime point layer.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters' | 'common';
  /**
   * Width multiplier.
   * @default 1
   */
  widthScale?: number;
  /**
   * Minimum on-screen path width in pixels.
   * @default 2
   */
  widthMinPixels?: number;
  /**
   * Maximum on-screen path width in pixels.
   *
   * NOTE the drift from upstream `PathLayer` (`MAX_SAFE_INTEGER`): 10 px keeps
   * pixel-space trails from blowing out, but it is also a HARD clamp on the
   * world-space path — `widthUnits: 'meters'` with a large `widthScale` will
   * silently top out at 10 px unless this is raised too. That combination
   * warns once.
   * @default 10
   */
  widthMaxPixels?: number;
  /**
   * Trip color — constant {@link Color}, or property name for categorical coloring.
   * @default [253, 128, 93, 255]
   */
  tripColor?: Color | string;
  /**
   * Upstream-vocabulary (TripsLayer/PathLayer) alias of {@link tripColor}.
   * NOTE: unlike upstream deck.gl, this accepts a constant Color OR a
   * property-column NAME — NOT a function accessor (binary tiles can't run
   * per-feature JS; a function warns once and falls back to `tripColor`).
   * When set, it wins over `tripColor`.
   */
  getColor?: ColorAccessorValue | null;
  /**
   * Trip width — constant number, or property name for per-feature width.
   * @default 3
   */
  tripWidth?: number | string;
  /**
   * Upstream-vocabulary alias of {@link tripWidth}. Accepts a constant
   * number OR a property-column NAME — NOT a function accessor (a function
   * warns once and falls back to `tripWidth`). When set, it wins over
   * `tripWidth`.
   */
  getWidth?: NumericAccessorValue | null;
  /** Color palette for categorical `tripColor`. */
  colorPalette?: Color[];
  /**
   * Explicit category-string → color map for categorical `tripColor`.
   * Resolved per-tile against each tile's own category dictionary, so colors
   * stay consistent across tiles (unlike `colorPalette`, whose indices are
   * assigned per-tile in first-seen order). Takes precedence over
   * `colorPalette` when set. Mirrors `AnimatedPointLayer.colorMapping`.
   */
  colorMapping?: Record<string, Color> | null;
  /** Fallback color for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;
  /**
   * Per-vertex gradient coloring. Names which `BinaryFeatures` per-vertex
   * scalar channel to color by — currently only `'vertexValues'` (e.g. SST).
   * When set and the tile carries that channel, each vertex's value is mapped
   * through {@link gradientColorRamp} over {@link gradientDomain}, shading the
   * line *along its length*. Takes precedence over categorical `tripColor`.
   * `NaN` values fall back to {@link colorMappingDefault}.
   */
  gradientProperty?: string | null;
  /** `[min, max]` value range mapped onto `gradientColorRamp`. */
  gradientDomain?: [number, number];
  /** Low→high color stops for the gradient ramp. */
  gradientColorRamp?: Color[];
  /**
   * Trail length in milliseconds.
   * @default 180000
   */
  trailLength?: number;
  /**
   * Fade the trail older→transparent.
   *
   * DIVERGENCE from upstream `TripsLayer` — read before porting. Upstream
   * discards a vertex only when `vTime > currentTime || (fadeTrail && vTime <
   * currentTime - trailLength)`, so `fadeTrail: false` never culls the tail:
   * the whole traversed path stays drawn at full opacity ("ink the route as it
   * is driven"). STT's {@link TimeFilterExtension} ALWAYS culls at
   * `vertexTime < trailStart` and uses this prop only to pick a ramped vs a
   * flat alpha, so `fadeTrail: false` yields a fixed-length SOLID SNAKE, not an
   * accumulating path. For the upstream "accumulating" look use
   * {@link SpatioTemporalLayerProps.cumulative} (whole-feature reveal) or set
   * `trailLength` to the dataset's full span. The cull is shared with the
   * `trailAlpha()` kernel oracle in `@poopdeck.gl/core/time-filter` that the
   * three/maplibre backends are pinned against, so it is not a deck-only knob.
   * @default true
   */
  fadeTrail?: boolean;
  /**
   * Rounded line caps. Upstream `PathLayer` defaults to `false`; trails read
   * better round, so STT flips it.
   * @default true
   */
  capRounded?: boolean;
  /**
   * Rounded line joints. Upstream `PathLayer` defaults to `false`; see
   * {@link capRounded}.
   * @default true
   */
  jointRounded?: boolean;
  /**
   * Path closure — `PathLayer._pathType` pass-through. `'open'` draws each
   * LineString as-is; `'loop'` closes it back onto its first vertex. STT tiles
   * arrive pre-normalized, so upstream's third mode (`undefined` ⇒ "normalize
   * on the CPU") is deliberately not offered — it would re-walk every path.
   * @default 'open'
   */
  pathType?: 'open' | 'loop';
  /**
   * Miter-joint length cap (multiples of line width) — PathLayer pass-through,
   * applies when `jointRounded` is false.
   * @default 4
   */
  miterLimit?: number;
  /**
   * Extrude lines in screen space (always face the camera) — PathLayer
   * pass-through.
   * @default false
   */
  billboard?: boolean;
  /**
   * GPU range filter — the NAME of a baked numeric column to filter trips by
   * (installs {@link STTDataFilterExtension}). Trips whose value in this column
   * falls inside {@link filterRange} render; the rest are hidden (or soft-faded
   * via {@link filterSoftRange}). Composes WITH the trail-mode time filter — a
   * trip must pass both the trail window and the column range.
   *
   * Accessor-alias of deck.gl's `getFilterValue`: pass a column NAME, not a
   * function (STT tiles are binary — a function warns once and is ignored).
   * Unset (the default) ⇒ the extension is not installed at all: zero
   * attribute, zero uniform, zero shader change. A tile that lacks the named
   * column renders unfiltered (the filter idles for that tile). The filter is
   * per-FEATURE (all vertices of a trip share its value), splatted per-vertex
   * to match PathLayer's segment-instanced attribute layout.
   *
   * NOTE: installing this adds one instanced vertex attribute; PathLayer sits
   * near WebGL2's 16-attribute floor (fp64 split + time + category), so a
   * pickable + categorical + filtered trip layer can exceed it on GPUs that
   * report exactly 16. Opt-in, so default trips are unaffected.
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
   * Optional soft `[min, max]` inside {@link filterRange}: trips between the
   * soft and hard bounds fade rather than hard-clip. No effect unless
   * `filterProperty` + `filterRange` are set. (PathLayer honours the alpha
   * fade; the size-shrink hook is silently ignored, as upstream.)
   * @default null
   */
  filterSoftRange?: DataFilterRange | null;
  /**
   * Enable/disable the column filter without dropping the bound attribute.
   * Effective only when `filterProperty` + a valid `filterRange` are set.
   * @default true
   */
  filterEnabled?: boolean;
}

/** Complete props accepted by {@link AnimatedTripsLayer}. */
export type AnimatedTripsLayerProps = _AnimatedTripsLayerProps &
  SpatioTemporalLayerProps;

/**
 * Sublayer-cache effect of every own prop, exhaustive by type: a prop added to
 * {@link _AnimatedTripsLayerProps} without an entry here fails to compile.
 *
 * `'sublayer'` — read by {@link AnimatedTripsLayer.buildSublayer}, so a cached
 * `PathLayer` freezes the value and a change must drop the sublayer cache.
 *
 * `'prepare'` — read only by `prepareTile`/`applyDynamicAttributes`, where the
 * value is baked into the tile's CPU-expanded per-vertex buffers. Each of these
 * is a component of the per-tile `styleKey` (`colorPalette` via
 * `colorListDigest`, `colorMapping` via `mapSig`, `colorMappingDefault` via
 * `mapDefault`, the three `gradient*` props via `gradSig`), so a change rebuilds
 * `prepared` — and the sublayer cache hit tests `prepared` by object identity,
 * which is what invalidates the sublayer. Moving one of these to `'sublayer'`
 * is safe; moving a `'sublayer'` prop here is only safe while `styleKey`
 * genuinely contains it.
 *
 * The three accessor-alias props (`tripColor`, `tripWidth`, `filterProperty`)
 * are additionally keyed on their RESOLVED value through the `overrides`
 * channel — see {@link AnimatedTripsLayer.computeLayerPropsKey}.
 */
const TRIPS_PROP_EFFECTS: PropEffects<_AnimatedTripsLayerProps> = {
  widthUnits: 'sublayer',
  widthScale: 'sublayer',
  widthMinPixels: 'sublayer',
  widthMaxPixels: 'sublayer',
  tripColor: 'sublayer',
  getColor: 'sublayer',
  tripWidth: 'sublayer',
  getWidth: 'sublayer',
  colorPalette: 'prepare',
  colorMapping: 'prepare',
  colorMappingDefault: 'prepare',
  gradientProperty: 'prepare',
  gradientDomain: 'prepare',
  gradientColorRamp: 'prepare',
  trailLength: 'sublayer',
  fadeTrail: 'sublayer',
  capRounded: 'sublayer',
  jointRounded: 'sublayer',
  pathType: 'sublayer',
  miterLimit: 'sublayer',
  billboard: 'sublayer',
  filterProperty: 'sublayer',
  filterRange: 'sublayer',
  filterSoftRange: 'sublayer',
  filterEnabled: 'sublayer',
};

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_TRIPS_PALETTE;

/**
 * Build a per-tile palette by mapping the tile's own category dictionary
 * through an explicit string→color map. Because `instanceCategoryIndex`
 * indexes into the same per-tile `categories` array, the resulting palette
 * makes each category render the same color in every tile.
 */
function paletteFromMapping(
  categories: string[],
  mapping: Record<string, Color>,
  fallback: Color,
): Color[] {
  return categories.map((c) => mapping[c] ?? fallback);
}

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * deck.gl is stable across renders — deck.gl compares `data` by reference
 * to decide whether to re-tessellate / re-upload GPU buffers.
 */
interface PreparedTile {
  /** Resolved (archive, tile, layer) cache key */
  tileKey: string;
  /**
   * Hash of the STRUCTURAL style props that shape the prepared `attributes`
   * (color/width/filter column names, palette + ramp content, subclass knobs).
   * Playhead-INDEPENDENT: a change here rebuilds the whole `data` object.
   */
  styleKey: string;
  /**
   * Quantized playhead sub-step (`gradientStyleSuffix`). A change here swaps
   * ONLY the playhead-driven attribute wrappers in place — see the
   * two-tier-cache note in the module docstring.
   */
  dynamicKey: string;
  /**
   * Bumped on every dynamic swap. Rides into the sublayer as an
   * `updateTriggers` value so deck invalidates exactly the swapped attributes
   * (and nothing else) without seeing a data change.
   */
  dynamicVersion: number;
  /** Reference-stable data object for PathLayer's binary interface */
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: Record<
      string,
      { value: any; size: number; normalized?: boolean }
    >;
  };
  /**
   * Pooled per-vertex RGBA scratch for the gradient path, reused across
   * sub-steps (`expandGradientColors` overwrites every byte, so sharing it is
   * pixel-identical to reallocating). The WRAPPER around it is still fresh on
   * every swap — that is what makes deck re-upload it.
   */
  colorBuffer: Uint8Array | null;
  /** Per-tile time reference; passed to TimeFilterExtension as `timeOffset`. */
  timeOffset: number;
  /** 2 or 3 — drives `positionFormat`. */
  dims: number;
  /** Resolved palette when GPU categorical-color path is active for this tile. */
  gpuPalette: Color[] | null;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  features: BinaryFeatures;
}

/**
 * Cache key for one (tile, layer) pair: core's canonical {@link tileLayerKey}
 * under an archive qualifier.
 *
 * `archiveKey` (the archive URL) is part of the key because a `data` swap keeps
 * the SAME layer instance — and z/x/y/t collisions between two archives are the
 * common case, not the rare one. Without it, the new archive's first render
 * could hit a `PreparedTile` whose `getPath.value` still points at the PREVIOUS
 * archive's `Float64Array`. The tile half is never spelled here: it carries the
 * temporal-LOD tier only because core's producer folds it in.
 */
function makeTileKey(tile: Tile, layer: TileLayer, archiveKey: string): string {
  return `${archiveKey}|${tileLayerKey(tile.id, layer.name)}`;
}

/**
 * Per-vertex time fallback when the tile lacks `vertexTimestamps`.
 *
 * Distributes each feature's [startTime, endTime] across its vertices by
 * cumulative haversine distance — matches the Rust side
 * (`interpolate_vertex_times` in stt-build/src/columnar.rs). Index-based
 * fallback (the previous behaviour) made long segments "flash" because a
 * single long edge got the same time delta as a short urban-block edge.
 *
 * The build path normally populates `binary.vertexTimestamps` directly, so
 * this only fires for tiles whose producer didn't compute per-vertex times
 * (older datasets, ad-hoc inputs). Allocated once per tile (cached in
 * PreparedTile) — not per frame.
 */
export function synthesizeVertexTimes(binary: BinaryFeatures): Float32Array {
  const startIndices = binary.startIndices!;
  const totalVerts = startIndices[binary.featureCount];
  const out = new Float32Array(totalVerts);
  const dims = binary.positionDimensions ?? 2;
  const positions = binary.positions;

  // Reused per-feature distance buffer. featureCount-bounded growth means a
  // single allocation lives across all features in this tile.
  let cum = new Float64Array(0);

  for (let i = 0; i < binary.featureCount; i++) {
    const v0 = startIndices[i];
    const v1 = startIndices[i + 1];
    const numVerts = v1 - v0;
    const featureStart = binary.startTimes[i];
    const featureEnd = binary.endTimes[i];
    const duration = featureEnd - featureStart;

    if (numVerts <= 1) {
      if (numVerts === 1) out[v0] = featureStart;
      continue;
    }
    if (duration <= 0) {
      for (let v = 0; v < numVerts; v++) out[v0 + v] = featureStart;
      continue;
    }

    if (cum.length < numVerts) cum = new Float64Array(numVerts);
    cum[0] = 0;
    let total = 0;
    for (let v = 1; v < numVerts; v++) {
      const aBase = (v0 + v - 1) * dims;
      const bBase = (v0 + v) * dims;
      total += haversineMeters(
        positions[aBase],
        positions[aBase + 1],
        positions[bBase],
        positions[bBase + 1],
      );
      cum[v] = total;
    }

    if (total <= 0) {
      for (let v = 0; v < numVerts; v++) out[v0 + v] = featureStart;
      continue;
    }
    for (let v = 0; v < numVerts; v++) {
      const frac = cum[v] / total;
      out[v0 + v] = featureStart + frac * duration;
    }
  }
  return out;
}

const EARTH_RADIUS_M = 6_371_000;

/** Haversine distance in meters. Inputs in degrees. */
function haversineMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a =
    sinDLat * sinDLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Resolve each feature's categorical color from the palette and expand it to
 * one RGBA per vertex. PathLayer renders segments as instances and maps a
 * per-vertex `getColor` onto them via its tessellator, so a per-vertex buffer
 * is the correct granularity here — a per-feature one under-sizes the draw
 * call (the cause of "vertex buffer is not big enough").
 */
function expandCategoryColors(
  indices: Uint16Array,
  palette: Color[],
  startIndices: Uint32Array,
  featureCount: number,
  totalVerts: number,
  fallback: Color,
): Uint8Array {
  const out = new Uint8Array(totalVerts * 4);
  for (let f = 0; f < featureCount; f++) {
    const c = palette[indices[f]] ?? fallback;
    const r = c[0];
    const g = c[1];
    const b = c[2];
    const a = c[3] ?? 255;
    for (let v = startIndices[f]; v < startIndices[f + 1]; v++) {
      const o = v * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

/**
 * Expand a per-FEATURE scalar column (e.g. a Strahler-order `width`) to one
 * value per vertex. PathLayer's `instanceStrokeWidths` (accessor `getWidth`) is
 * a per-SEGMENT-instanced attribute sized to the tessellated vertex count, and
 * deck.gl's binary interface binds a size-matched buffer DIRECTLY (fast path in
 * `Attribute.setBinaryValue`, since the layer's `startIndices` already equals
 * `data.startIndices`). A featureCount-length buffer is therefore too small for
 * the draw — the exact "vertex buffer is not big enough" crash. Splatting the
 * feature's scalar across its vertices (identical to the categorical-color and
 * gradient paths) yields the correct per-vertex granularity.
 */
function expandFeatureWidths(
  values: ArrayLike<number>,
  startIndices: Uint32Array,
  featureCount: number,
  totalVerts: number,
): Float32Array {
  const out = new Float32Array(totalVerts);
  for (let f = 0; f < featureCount; f++) {
    const w = values[f];
    for (let v = startIndices[f]; v < startIndices[f + 1]; v++) out[v] = w;
  }
  return out;
}

// ── Per-tile geometry-derived attribute caches ──────────────────────────────
// `synthesizeVertexTimes` and the static-`width` expansion are pure functions
// of a tile's decoded `binary` features (positions + per-feature start/end/
// width) — they do NOT depend on the play head. But FlowCorridorLayer /
// FlowStrokeLayer fold the playback sub-step into the per-tile `styleKey`
// (`gradientStyleSuffix` → `:fp{step}`), so `prepareTile` re-runs ~6×/second
// during playback and, before this cache, re-ran BOTH of these O(totalVerts)
// loops every time — synthesizeVertexTimes (a haversine over every vertex) was
// the single largest per-sub-step CPU cost in the rivers+rain composite.
// Keying by the `binary` object identity (stable for a loaded tile, GC'd on
// unload) computes each exactly once per tile-load and reuses it across every
// sub-step re-prepare. The cached arrays are read-only after construction, so
// sharing them is pixel-identical to recomputing.
const vertexTimeMemo = new WeakMap<BinaryFeatures, Float32Array>();
function synthesizeVertexTimesMemo(binary: BinaryFeatures): Float32Array {
  let cached = vertexTimeMemo.get(binary);
  if (!cached) {
    cached = synthesizeVertexTimes(binary);
    vertexTimeMemo.set(binary, cached);
  }
  return cached;
}

const staticWidthMemo = new WeakMap<
  BinaryFeatures,
  { prop: string; value: Float32Array }
>();
function expandFeatureWidthsMemo(
  binary: BinaryFeatures,
  widthProp: string,
  values: ArrayLike<number>,
  totalVerts: number,
): Float32Array {
  const cached = staticWidthMemo.get(binary);
  if (cached && cached.prop === widthProp) return cached.value;
  const value = expandFeatureWidths(
    values,
    binary.startIndices!,
    binary.featureCount,
    totalVerts,
  );
  staticWidthMemo.set(binary, { prop: widthProp, value });
  return value;
}

/**
 * Map a per-vertex scalar array through a color ramp to one RGBA per vertex,
 * so PathLayer shades each line *along its length* (its tessellator carries
 * `getColor` as a per-vertex attribute and interpolates it across segments).
 * Each value is normalized into `[0,1]` over `domain`, then piecewise-lerped
 * across the ramp stops. `NaN` (no value) gets `fallback`.
 *
 * `pool` lets a caller that re-expands the SAME tile every sub-step (the flow
 * corridors) or every frame (the head dots) hand back its previous buffer
 * instead of allocating megabytes per pass. Every byte is overwritten below, so
 * reuse is bit-identical to a fresh allocation; it is only accepted when the
 * length matches EXACTLY, so a shorter pool can never leave stale trailing
 * vertices in the draw.
 */
export function expandGradientColors(
  values: Float32Array,
  domain: [number, number],
  ramp: Color[],
  totalVerts: number,
  fallback: Color,
  pool?: Uint8Array | null,
): Uint8Array {
  const out =
    pool && pool.length === totalVerts * 4
      ? pool
      : new Uint8Array(totalVerts * 4);
  const [lo, hi] = domain;
  const span = hi - lo;
  const n = ramp.length;
  const fr = fallback[0];
  const fg = fallback[1];
  const fb = fallback[2];
  const fa = fallback[3] ?? 255;
  // Guard against a degenerate ramp/domain so the loop stays branch-light.
  const safeSpan = span !== 0 ? span : 1;
  for (let v = 0; v < totalVerts; v++) {
    const o = v * 4;
    const value = values[v];
    if (n === 0 || Number.isNaN(value)) {
      out[o] = fr;
      out[o + 1] = fg;
      out[o + 2] = fb;
      out[o + 3] = fa;
      continue;
    }
    let t = (value - lo) / safeSpan;
    if (t <= 0 || n === 1) {
      const c = ramp[0];
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3] ?? 255;
      continue;
    }
    if (t >= 1) {
      const c = ramp[n - 1];
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3] ?? 255;
      continue;
    }
    // Locate the bracketing stops and lerp between them.
    const scaled = t * (n - 1);
    const i0 = Math.floor(scaled);
    const f = scaled - i0;
    const c0 = ramp[i0];
    const c1 = ramp[i0 + 1];
    out[o] = c0[0] + (c1[0] - c0[0]) * f;
    out[o + 1] = c0[1] + (c1[1] - c0[1]) * f;
    out[o + 2] = c0[2] + (c1[2] - c0[2]) * f;
    out[o + 3] = (c0[3] ?? 255) + ((c1[3] ?? 255) - (c0[3] ?? 255)) * f;
  }
  return out;
}

/**
 * Animated trips layer (trail mode) with per-tile binary sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`trips`**.
 * `_subLayerProps: { trips: { type: MyLayer, ...props } }` swaps the
 * sublayer class / overrides sublayer props (deck's CompositeLayer
 * contract). Without a `type` override the class is `PathLayer` when
 * `pickable` and the attribute-stripped `NoPickingPathLayer` otherwise.
 */
/** Shared stable empties for the `extraTrips*` hooks — a fresh `[]`/`{}` per
 * call would defeat deck's per-extension-set shader-pipeline cache. */
const EMPTY_EXTENSIONS: unknown[] = [];
const EMPTY_SUBLAYER_PROPS: Record<string, unknown> = {};

/** One cached sublayer plus the keys it was built from. */
interface CachedSublayer {
  layer: PathLayer;
  preparedKey: PreparedTile;
  /** `prepared.dynamicVersion` at build time — a swap must re-emit updateTriggers. */
  preparedVersion: number;
  layerPropsKey: string;
}

/**
 * Everything the render path caches between frames, kept in ONE bag so it can
 * live on `this.state`.
 *
 * deck's `_transferState` moves only `state`/`internalState` to the new layer
 * instance; class-FIELD initializers re-run on it. Holding these as fields
 * meant that any unmemoized `new AnimatedTripsLayer({...})` in a React render
 * threw away every prepared tile and cached sublayer — re-running
 * `expandCategoryColors`/`expandGradientColors` over every visible tile and
 * re-uploading every GPU buffer, i.e. exactly the 30-60%-of-frame-time cost the
 * caches exist to avoid. On `state` they survive the swap.
 */
interface TripsCaches {
  /** Per-tile prepared data. Pruned to the currently-visible tile set each render. */
  prepared: Map<string, PreparedTile>;
  /**
   * Per-tile sublayer instances. Returning the SAME `PathLayer` reference lets
   * deck short-circuit layer matching + the whole prop-diff pass for that tile.
   */
  sublayers: Map<string, CachedSublayer>;
  /** Digest of the layer-level props baked into every sublayer at build time. */
  layerPropsKey: string;
  /** `state.tiles` identity from the previous render (prune-walk skip). */
  tilesRef: Tile[] | null;
}

const TRIPS_CACHE_SLOT = '_sttTripsCaches';

function freshTripsCaches(): TripsCaches {
  return {
    prepared: new Map(),
    sublayers: new Map(),
    layerPropsKey: '',
    tilesRef: null,
  };
}

export class AnimatedTripsLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedTripsLayerProps>
> {
  static layerName = 'AnimatedTripsLayer';

  static defaultProps: DefaultProps<AnimatedTripsLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    widthUnits: 'pixels',
    widthScale: { type: 'number', value: 1, min: 0 },
    widthMinPixels: { type: 'number', value: 2 },
    widthMaxPixels: { type: 'number', value: 10 },
    // Permissive descriptors ({type:'object'} validates anything): these
    // props legally hold a constant OR a column-name string, which the
    // 'color'/'number' validators would reject in deck's debug mode.
    tripColor: { type: 'object', value: [253, 128, 93, 255], compare: true },
    tripWidth: { type: 'object', value: 3, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getColor: { type: 'object', value: null, optional: true, compare: true },
    getWidth: { type: 'object', value: null, optional: true, compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    colorMappingDefault: { type: 'color', value: [120, 120, 120, 255] },
    gradientProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    gradientDomain: { type: 'array', value: [0, 1], compare: true },
    gradientColorRamp: { type: 'array', value: [], compare: true },
    trailLength: { type: 'number', value: 180_000, min: 0 },
    fadeTrail: true,
    capRounded: true,
    jointRounded: true,
    pathType: 'open',
    miterLimit: { type: 'number', value: 4, min: 0 },
    billboard: false,
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
  };

  // `stateSlot` (and its pre-state detached bag) now live on the chassis —
  // see SpatioTemporalLayer.stateSlot. Every layer in the family gets the same
  // `_transferState`-surviving storage without re-declaring the mechanism.

  /** State-resident render caches — see {@link TripsCaches}. */
  private get tripsCaches(): TripsCaches {
    return this.stateSlot(TRIPS_CACHE_SLOT, freshTripsCaches);
  }

  // The four accessors below keep the historical field NAMES (they are part of
  // this family's de-facto internal contract — the shared test harnesses and
  // sibling layers all speak them) while the storage lives on `state`.

  /** Per-tile prepared-data cache. Pruned to the currently-visible tile set on each render. */
  private get preparedTileCache(): Map<string, PreparedTile> {
    return this.tripsCaches.prepared;
  }
  private set preparedTileCache(value: Map<string, PreparedTile>) {
    this.tripsCaches.prepared = value;
  }

  /**
   * Per-tile sublayer-instance cache. Returning the SAME `PathLayer`
   * reference across renderLayers() calls lets deck.gl short-circuit layer
   * matching + the entire prop-diff pass for that tile. Allocating a fresh
   * PathLayer per visible tile per frame instead costs 30-60% of frame time
   * once 50+ tiles are on screen — the JS-side constructor + props object
   * literal dominate even when the GPU buffer upload is already
   * short-circuited via `prepared.data`.
   *
   * Cache key is the tileKey (archive|z/x/y/t:layer). The value carries the
   * cache keys we baked into the layer at construction time (`preparedKey`,
   * `preparedVersion`, `layerPropsKey`); we reuse the cached layer iff ALL
   * still match.
   */
  private get sublayerCache(): Map<string, CachedSublayer> {
    return this.tripsCaches.sublayers;
  }
  private set sublayerCache(value: Map<string, CachedSublayer>) {
    this.tripsCaches.sublayers = value;
  }

  /**
   * Cached digest of every prop on `this.props` that we bake into a sublayer
   * at construction time. When this changes, every cached PathLayer is
   * invalidated and rebuilt on the next render.
   */
  private get lastLayerPropsKey(): string {
    return this.tripsCaches.layerPropsKey;
  }
  private set lastLayerPropsKey(value: string) {
    this.tripsCaches.layerPropsKey = value;
  }

  /**
   * Tile-array identity from the previous render. When the parent layer
   * returns the SAME `state.tiles` reference (i.e. no setState during this
   * render cycle) we skip the prune walks over `preparedTileCache` and
   * `sublayerCache` entirely — the live set is unchanged by construction.
   */
  private get lastTilesRef(): Tile[] | null {
    return this.tripsCaches.tilesRef;
  }
  private set lastTilesRef(value: Tile[] | null) {
    this.tripsCaches.tilesRef = value;
  }

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Extensions are
   * stateless w.r.t. data; the per-tile timeOffset is passed as a layer prop.
   */
  /**
   * Trips run in trail mode (per-vertex time + trail uniform). The
   * `mode: 'trail'` arg is forward-compat only and a NO-OP today (see the
   * TimeFilterMode docstring): the extension registers all three time
   * attributes (`instanceVertexTime` + `instanceStartTime`/`instanceEndTime`)
   * unconditionally, and the shader's trailLength branch selects per-vertex
   * time at draw. What keeps PathLayer's fp64 split + time + category combo
   * under WebGL2's 16-attribute floor is NoPickingPathLayer freeing the
   * `instancePickingColors` slot — not attribute pruning here.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({
    mode: 'trail',
  });

  /**
   * Singleton CategoryColorExtension. Replaces the per-tile CPU
   * expandPaletteColors() RGBA expansion with a one-time palette texture
   * upload and a Float32 category-index attribute per tile. The shader
   * branch is gated by useCategoryColor so the extension is inert on tiles
   * without categorical color (constant tripColor, etc.).
   */
  private readonly categoryColorExtension = new CategoryColorExtension();

  /**
   * Singleton STTDataFilterExtension. Composed into a sublayer's extension list
   * ONLY when `filterProperty` is set (a per-layer constant, so the list stays
   * stable across this layer's sublayers). Constructed unconditionally — a
   * no-op object alloc; it contributes no attribute, uniform or shader unless
   * actually installed. Mirrors {@link AnimatedPointLayer}.
   */
  private readonly dataFilterExtension = new STTDataFilterExtension({
    filterSize: 1,
  });

  /**
   * Stable getTime reference. Critical: deck.gl re-runs work when accessor
   * function references change; a fresh arrow every render would defeat the
   * cache. The extension reads this from layer props on every draw().
   */
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
    this.lastTilesRef = null;
  }

  /**
   * Identity of the archive the currently-visible tiles came from — folded into
   * every tile cache key (see {@link makeTileKey}). A `data` swap keeps this
   * layer INSTANCE, so without it the new archive can hit the previous one's
   * cached buffers on any repeated `z/x/y/t`.
   *
   * `state.archive.url` is authoritative once the archive resolves;
   * `initializingUrl` covers the window between the swap and the load, and the
   * `data` prop is the last resort (and the only source the unit-test harnesses
   * ever have).
   */
  protected archiveKey(): string {
    const state = this.state as
      | { archive?: { url?: string } | null; initializingUrl?: string | null }
      | undefined
      | null;
    const url = state?.archive?.url ?? state?.initializingUrl;
    if (typeof url === 'string') return url;
    const data = (this.props as { data?: unknown }).data;
    return typeof data === 'string' ? data : '';
  }

  /**
   * Accessor-alias resolution: the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy
   * prop. Same value domain as the legacy props (constant or column name).
   */
  private colorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedTripsLayer',
      'getColor',
      this.props.getColor,
      this.props.tripColor,
    );
  }

  private widthValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedTripsLayer',
      'getWidth',
      this.props.getWidth,
      this.props.tripWidth,
    );
  }

  /**
   * Resolve `filterProperty` to a baked-column NAME. Accessor-alias of deck's
   * `getFilterValue`: a function-valued prop warns once and is ignored (there
   * is no legacy prop, so the fallback is "no filter" — `undefined`).
   */
  private filterPropertyValue(): string | undefined {
    return resolveAccessorAlias<string | undefined>(
      'AnimatedTripsLayer',
      'filterProperty',
      this.props.filterProperty,
      undefined,
    );
  }

  /**
   * Digest of the layer-level inputs baked into every sublayer. When it
   * changes, every cached PathLayer holds a frozen copy of a stale value, so
   * the whole sublayer cache is thrown away.
   *
   * Which props participate is decided by {@link TRIPS_PROP_EFFECTS} rather
   * than by an enumeration here, so a new prop cannot silently miss the key.
   * The accessor-alias props go in through `overrides` carrying the RESOLVED
   * value (`getColor` beats `tripColor`, `getWidth` beats `tripWidth`) —
   * exactly what `buildSublayer` reads. The rest of the key's inputs are not
   * props of this layer at all: the subclass style knobs and the inherited
   * composite/time props ride the positional `extra` channel.
   */
  private computeLayerPropsKey(): string {
    return buildLayerPropsKey<_AnimatedTripsLayerProps>(
      this.props,
      TRIPS_PROP_EFFECTS,
      {
        overrides: {
          tripColor: this.colorValue(),
          tripWidth: this.widthValue(),
          filterProperty: this.filterPropertyValue(),
        },
        extra: [
          // Subclass knobs (flow-corridor / flow-stroke). These reach BOTH
          // caches: some of them (offsetWidths) decide the sublayer's
          // EXTENSION SET, which is baked at construction time.
          this.subclassStyleKey(),
          // Composite props that getSubLayerProps bakes into every sublayer
          // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
          // plus the user's updateTriggers.
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
   * Trail rendering needs tiles spanning at least `trailLength` of sim time
   * before the play head. Widen the tileset time window if `timeWindow` is
   * narrower than that.
   */
  protected getEffectiveTimeWindow(): number {
    // Seed from the base class, not the raw prop, so `tileLoadTimeWindow`
    // keeps its contract here too; `trailLength` is `Required<>`-typed.
    return Math.max(super.getEffectiveTimeWindow(), this.props.trailLength * 2);
  }

  renderLayers(): Layer[] {
    // `emit` no-ops when the probe is off; building its payload and calling
    // performance.now() unconditionally would not.
    const probe = isProbeEnabled();
    const t0 = probe ? performance.now() : 0;
    const tiles = this.state.tiles as Tile[] | undefined;
    const archiveKey = this.archiveKey();

    // Prune BEFORE the empty-set early return. The chassis deliberately
    // setStates `tiles: []` on archive init to signal "the visible set just
    // collapsed"; an early return there meant this block never re-ran, so every
    // entry from the PREVIOUS archive stayed cached (and `finalizeState` does
    // not fire — the layer instance is reused across a `data` swap). Folding
    // the archive into the tile key makes a stale hit impossible regardless;
    // pruning here also stops the dead entries from leaking.
    //
    // Otherwise: skip the O(cacheSize) walk when the parent handed us the SAME
    // tile-array reference (no setState since the last render) — the live set
    // is then identical to the cached set by construction.
    if (this.lastTilesRef !== (tiles ?? null)) {
      const live = new Set<string>();
      if (tiles) {
        for (const tile of tiles) {
          for (const tileLayer of tile.layers)
            live.add(makeTileKey(tile, tileLayer, archiveKey));
        }
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      for (const key of this.sublayerCache.keys()) {
        if (!live.has(key)) this.sublayerCache.delete(key);
      }
      this.lastTilesRef = tiles ?? null;
    }

    if (!tiles || tiles.length === 0) return [];

    // If any layer-level prop changed since the last render, every cached
    // sublayer is stale — drop them all so the loop below rebuilds.
    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastLayerPropsKey) {
      this.lastLayerPropsKey = layerPropsKey;
      this.sublayerCache.clear();
    }

    const sublayers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer, archiveKey);
        if (!prepared) continue;
        const cached = this.sublayerCache.get(prepared.tileKey);
        // Three-part hit check: the prepared-data object reference (which
        // captures structural style key + tile identity), its dynamic version
        // (a playhead sub-step swapped attribute wrappers in place, so the
        // sublayer must re-emit its updateTriggers) AND the layer-level props
        // digest. We pass the SAME PathLayer reference back unless one changed.
        if (
          cached &&
          cached.preparedKey === prepared &&
          cached.preparedVersion === prepared.dynamicVersion &&
          cached.layerPropsKey === layerPropsKey
        ) {
          sublayers.push(cached.layer);
          continue;
        }
        const layer = this.buildSublayer(prepared);
        this.sublayerCache.set(prepared.tileKey, {
          layer,
          preparedKey: prepared,
          preparedVersion: prepared.dynamicVersion,
          layerPropsKey,
        });
        sublayers.push(layer);
      }
    }

    if (probe) {
      emit('renderLayers', {
        layer: 'AnimatedTripsLayer',
        tiles: tiles.length,
        sublayers: sublayers.length,
        ms: performance.now() - t0,
      });
    }
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedTripsLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  /**
   * Build the binary `data` object for a single tile, or return the cached
   * entry when the tile and style key are unchanged.
   */
  /**
   * The per-vertex scalar array fed to the gradient ramp. Base: the static
   * `vertexValues` channel (e.g. drifter SST). {@link FlowCorridorLayer}
   * overrides this to select/blend a time-bucket column from a per-vertex value
   * matrix, so the corridor geometry stays resident on the GPU while the
   * playhead picks the colors.
   */
  protected gradientValuesFor(
    binary: BinaryFeatures,
    _totalVerts: number,
  ): Float32Array | undefined {
    return this.props.gradientProperty === 'vertexValues'
      ? binary.vertexValues
      : undefined;
  }

  /**
   * Post-process the freshly-expanded per-vertex RGBA color buffer (from the
   * gradient ramp) in place, before it is uploaded as the `getColor` attribute.
   * Base is a no-op; {@link FlowCorridorLayer} overrides it to pack a SECOND
   * per-vertex signal (instantaneous per-trip flow) into the alpha byte without
   * adding a GPU attribute — the RGB carries the aggregate ramp color, the alpha
   * carries the instant. Called only on the gradient path.
   */
  protected finalizeGradientColorBuffer(
    _colors: Uint8Array,
    _binary: BinaryFeatures,
    _totalVerts: number,
  ): void {
    // no-op
  }

  /**
   * PER-VERTEX chevron direction sign (length `totalVerts`), or `undefined` to
   * leave direction to the geometry winding. {@link FlowCorridorLayer} overrides
   * it (when `signedFlow`) to read the sign of the SIGNED value matrix's active
   * bucket, so `ChevronFlowExtension({ perBucketDirection: true })` flips the
   * arrows per time-step. Wired to the `instanceChevronDir` attribute — the same
   * per-vertex plumbing as the gradient `getColor` / dynamic `getWidth` buffers.
   */
  protected chevronDirectionsFor(
    _binary: BinaryFeatures,
    _totalVerts: number,
  ): Float32Array | undefined {
    return undefined;
  }

  /**
   * Per-tile token identifying the PLAYHEAD sub-step, so the CPU-expanded
   * per-vertex colors (and the dynamic width / chevron-direction buffers)
   * re-expand as the playhead advances. Base: '' (the static gradient never
   * varies with time).
   *
   * This is NOT part of the structural `styleKey` — a change here swaps only
   * the playhead-driven attribute wrappers on the EXISTING `data` object, so
   * the geometry never re-tessellates or re-uploads. See the two-tier-cache
   * note in the module docstring.
   */
  protected gradientStyleSuffix(_binary: BinaryFeatures): string {
    return '';
  }

  /**
   * Digest of SUBCLASS props that change what `prepareTile` bakes into the
   * per-vertex buffers or what `buildSublayer` installs. Folded into BOTH the
   * prepared-tile `styleKey` and `computeLayerPropsKey`, because some of these
   * (e.g. {@link FlowStrokeLayer}'s `offsetWidths`) decide the sublayer's
   * EXTENSION SET — which is baked at construction time and must not change
   * under a cached instance. Base: '' (no subclass props).
   *
   * Without this, dragging a `widthExponent` / `persistenceMs` slider while
   * PAUSED hit both caches and handed back the identical `PathLayer` — the
   * control read as dead until the playhead crossed a half-bucket.
   */
  protected subclassStyleKey(): string {
    return '';
  }

  /**
   * Per-feature `[start, end]` times (relative to the tile `timeOffset`) to feed
   * the window-mode time filter's `instanceStartTime`/`instanceEndTime`, or
   * `null` to leave them at the accessor default (0). Base returns null — trail
   * trips animate via `instanceVertexTime`, not these. {@link FlowCorridorLayer}
   * returns the corridor's FULL range so its static geometry stays visible
   * under `trailLength: 0` (otherwise the window hides it once the playhead
   * passes `windowHalf`, since the unset attributes default to 0).
   */
  protected timeBoundsForSublayer(
    _binary: BinaryFeatures,
  ): { start: number; end: number } | null {
    return null;
  }

  /**
   * PER-VERTEX width override (length `totalVerts`, aligned 1:1 with `positions`
   * exactly like the gradient `getColor` buffer — PathLayer's `instanceStrokeWidths`
   * is per-SEGMENT-instanced, so a shorter per-feature buffer under-sizes the draw).
   * Base: `undefined`, so the static `getWidth`/`tripWidth` accessor wins.
   * {@link FlowStrokeLayer} overrides it to make width breathe with the active
   * time-bucket volume (√-scaled) and taper along each trunk, reusing the same
   * sub-step cache machinery as the gradient color (recomputes exactly when
   * `gradientStyleSuffix` changes). Anything shorter than `totalVerts` is ignored.
   *
   * `gradientValues` is the array {@link gradientValuesFor} just produced in
   * THIS pass (or `undefined` when the gradient path is idle). It is threaded
   * through because both hooks want the same blend: `FlowStrokeLayer` used to
   * call `gradientValuesFor` a second time, paying another
   * `trailingMaxMatrixRow` sweep (O(totalVerts × windowBuckets)) or rolling
   * mean (O(totalVerts × (2w+1))) plus another `Float32Array(totalVerts)`, per
   * tile per sub-step.
   */
  protected widthsFor(
    _binary: BinaryFeatures,
    _featureCount: number,
    _gradientValues?: Float32Array,
  ): Float32Array | undefined {
    return undefined;
  }

  /**
   * Extra deck extensions appended (after the time-filter + category-color
   * singletons) to every sublayer of this instance. MUST return a stable
   * reference per instance — deck caches compiled shader pipelines per extension
   * set, so a fresh array each call defeats that cache. Base: a shared empty
   * array. {@link FlowStrokeLayer} adds a `PathStyleExtension({offset:true})` for
   * the twin-ribbon offset.
   */
  protected extraTripsExtensions(): unknown[] {
    return EMPTY_EXTENSIONS;
  }

  /**
   * Extra sublayer props merged into every trips sublayer (e.g. the constant
   * `getOffset` that pairs with {@link FlowStrokeLayer}'s offset extension).
   * Base: a shared empty object. User `_subLayerProps.trips` still wins, as it
   * is applied last by `composeSubLayerProps`.
   */
  protected extraTripsSubLayerProps(): Record<string, unknown> {
    return EMPTY_SUBLAYER_PROPS;
  }

  /**
   * Whether to install the (idle-for-trips) CategoryColorExtension. Base: true.
   * A subclass that never categorically colors AND needs an extra attribute slot
   * (e.g. {@link FlowStrokeLayer}, which adds PathStyleExtension's offset) returns
   * false to drop `instanceCategoryIndex` and stay under WebGL2's 16-attribute
   * floor. Must be constant per instance (shader-pipeline cache).
   */
  protected includeCategoryColorExtension(): boolean {
    return true;
  }

  /**
   * (Re)compute the PLAYHEAD-DRIVEN attribute slots on an already-built
   * `attributes` object, IN PLACE.
   *
   * Exactly three slots vary with the playhead: the gradient `getColor`, the
   * dynamic per-vertex `getWidth`, and — for `signedFlow` corridors — the
   * direction sign that rides the otherwise-idle `instanceVertexTime` slot.
   * Everything else (`getPath`, the static width splat, `filterValue`) keeps
   * its WRAPPER OBJECT, which is what lets deck short-circuit its re-upload
   * (`Attribute.setExternalBuffer` / `setBinaryValue` compare wrapper
   * identity, not contents).
   */
  private applyDynamicAttributes(
    prepared: PreparedTile,
    binary: BinaryFeatures,
    totalVerts: number,
  ): void {
    const attributes = prepared.data.attributes;

    // Per-bucket chevron direction (FlowCorridorLayer signedFlow) reuses the
    // instanceVertexTime slot: flow-corridor tiles run window mode, where
    // TimeFilterExtension never reads it (only trail mode does), so
    // ChevronFlowExtension({ perBucketDirection }) reads it for the sign —
    // no extra attribute (PathLayer already sits at WebGL2's link ceiling).
    const chevronDirs = this.chevronDirectionsFor(binary, totalVerts);
    if (chevronDirs && chevronDirs.length >= totalVerts) {
      attributes.instanceVertexTime = { value: chevronDirs, size: 1 };
    }

    // Per-vertex gradient color: map each vertex's scalar through the ramp so
    // the line shades along its length. Per-VERTEX for the same reason as the
    // categorical path — PathLayer instances are segments, not features.
    const ramp = this.props.gradientColorRamp;
    const gradientValues = this.gradientValuesFor(binary, totalVerts);
    if (
      gradientValues &&
      gradientValues.length >= totalVerts &&
      ramp &&
      ramp.length > 0
    ) {
      const gradientColorBuffer = expandGradientColors(
        gradientValues,
        this.props.gradientDomain ?? [0, 1],
        ramp,
        totalVerts,
        this.props.colorMappingDefault ?? [120, 120, 120, 255],
        prepared.colorBuffer,
      );
      prepared.colorBuffer = gradientColorBuffer;
      // Seam for a second per-vertex signal packed into alpha (FlowCorridorLayer
      // per-trip lighting). No-op in the base class.
      this.finalizeGradientColorBuffer(gradientColorBuffer, binary, totalVerts);
      attributes.getColor = {
        value: gradientColorBuffer,
        size: 4,
        normalized: true,
      };
    }

    // Dynamic PER-VERTEX width hook (FlowStrokeLayer: active-bucket volume).
    // MUST be per-vertex (length totalVerts), NOT per-feature: PathLayer's
    // `instanceStrokeWidths` is a per-SEGMENT-instanced attribute, so a
    // featureCount-length buffer is too small for the draw ("vertex buffer is
    // not big enough"). Per-vertex mirrors the getColor path exactly (and lets
    // width taper along the line). Handed the blend the gradient just computed
    // so the subclass never recomputes it.
    const dynWidths = this.widthsFor(
      binary,
      binary.featureCount,
      gradientValues,
    );
    if (dynWidths && dynWidths.length >= totalVerts) {
      attributes.getWidth = { value: dynWidths, size: 1 };
    }
  }

  private prepareTile(
    tile: Tile,
    tileLayer: TileLayer,
    archiveKey: string = this.archiveKey(),
  ): PreparedTile | null {
    const binary = tileLayer.features;
    // An empty tile is normal and silent; a MISMATCHED one should say so.
    if (binary.featureCount === 0) return null;
    // LineString semantics are load-bearing here: `startIndices` delimits each
    // trip's vertex RUN inside a flattened position buffer. A point tile would
    // render as a handful of degenerate paths, silently — and it is checked
    // BEFORE `startIndices` so the diagnostic fires instead of a bare `null`.
    if (
      !expectGeometry(
        binary.geometryType,
        LINESTRING_ONLY,
        this.props.id ??
          (this.constructor as { layerName?: string }).layerName ??
          'AnimatedTripsLayer',
        tileLayer.name,
      )
    ) {
      return null;
    }
    if (!binary.startIndices) return null;

    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const widthProp = typeof widthValue === 'string' ? widthValue : '';
    const filterProp = this.filterPropertyValue() ?? '';
    // Palette / mapping / ramp keyed by CONTENT, not length or key-count — a
    // same-size swap must invalidate the CPU-expanded per-vertex colors.
    // Digests are memoized per object reference (style-digest.ts), so this is
    // a WeakMap lookup per tile, not a re-serialization.
    const mapSig = this.props.colorMapping
      ? `m${colorMappingDigest(this.props.colorMapping)}`
      : '';
    // Gradient signature: property + domain + ramp content. Including the
    // domain invalidates the cached per-vertex colors when the scale changes.
    // Gated on the RAMP being present as well as on `gradientProperty`: the
    // flow subclasses source their per-vertex scalar from the value MATRIX and
    // never set `gradientProperty`, yet their colour buffers still bake the
    // domain + ramp — so keying on the property alone left a ramp/domain swap
    // serving the previous colours until the playhead moved.
    const gradientRamp = this.props.gradientColorRamp;
    const hasRamp = !!gradientRamp && gradientRamp.length > 0;
    const gradSig =
      this.props.gradientProperty || hasRamp
        ? `g${this.props.gradientProperty ?? ''}:${(
            this.props.gradientDomain ?? [0, 1]
          ).join(',')}:${hasRamp ? colorListDigest(gradientRamp!) : ''}`
        : '';
    // colorMappingDefault is baked into the CPU-expanded per-vertex RGBA
    // buffers (categorical fallback + gradient fallback), so a change in
    // isolation must invalidate the prepared tile — otherwise the cache keeps
    // old fallback colors.
    const mapDefault = (
      this.props.colorMappingDefault ?? [120, 120, 120, 255]
    ).join(',');
    // The filter-column NAME is baked into the per-vertex `filterValue`
    // attribute, so a change (incl. the unset↔set toggle that adds/removes
    // STTDataFilterExtension) must re-prepare tiles → rebuild sublayers via the
    // new preparedKey.
    //
    // STRUCTURAL key only — the playhead sub-step is tracked separately as
    // `dynamicKey` so crossing it never rebuilds `data` (module docstring).
    // `subclassStyleKey()` carries the flow-corridor / flow-stroke knobs
    // (`signedFlow`, `persistenceMs`, `widthExponent`, `minFlow`, the chevron
    // window/decay props, …), which all feed these per-vertex buffers.
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp
        ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${mapSig}|${gradSig}|d${mapDefault}|f${filterProp}|s${this.subclassStyleKey()}|${updateTriggersDigest(
      this.props.updateTriggers,
    )}`;
    const dynamicKey = this.gradientStyleSuffix(binary);

    const probe = isProbeEnabled();
    const tileKey = makeTileKey(tile, tileLayer, archiveKey);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      if (cached.dynamicKey !== dynamicKey) {
        // Playhead crossed a sub-step. Swap ONLY the playhead-driven wrappers;
        // `data`, `getPath`, `filterValue` and the static width splat keep
        // their identity, so deck skips the re-tessellation AND the fp64
        // hi/lo re-split of the position buffer. `dynamicVersion` rides into
        // the sublayer's updateTriggers to invalidate exactly what changed.
        this.applyDynamicAttributes(
          cached,
          binary,
          binary.startIndices[binary.featureCount],
        );
        cached.dynamicKey = dynamicKey;
        cached.dynamicVersion++;
      }
      if (probe) {
        emit('tilePrepare', {
          layer: 'AnimatedTripsLayer',
          tileKey,
          cached: true,
          ms: 0,
        });
      }
      return cached;
    }

    const t0 = probe ? performance.now() : 0;
    const dims = binary.positionDimensions ?? 2;
    const totalVerts = binary.startIndices[binary.featureCount];

    const attributes: PreparedTile['data']['attributes'] = {
      // PathLayer's positions attribute — keyed by ACCESSOR NAME `getPath`.
      // Float64Array is required so deck.gl's fp64 attribute populates the
      // hi/lo split correctly; a Float32Array buffer leaves the low half
      // zero and renders coordinates with ~m-scale jitter at high zoom.
      // This wrapper is built ONCE per (tile, structural style) and never
      // reallocated on a sub-step — see the module docstring.
      getPath: { value: binary.positions, size: dims },
    };

    // The GPU CategoryColorExtension stays installed (constant extension list
    // keeps shader pipelines cached) but idle for trips: its instanced index
    // can't ride PathLayer's segment tessellation, so we color via getColor.
    const gpuPalette: Color[] | null = null;

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      dynamicKey,
      dynamicVersion: 0,
      data: {
        length: binary.featureCount,
        startIndices: binary.startIndices,
        attributes,
      },
      colorBuffer: null,
      timeOffset: binary.timeOffset,
      dims,
      gpuPalette,
      tile,
      features: binary,
    };

    // Playhead-driven slots FIRST, so the static fallbacks below only run when
    // the dynamic hooks left the slot empty — notably, a signedFlow corridor
    // never pays the synthesizeVertexTimes haversine sweep for a slot it is
    // about to overwrite with direction signs.
    this.applyDynamicAttributes(prepared, binary, totalVerts);

    if (!attributes.instanceVertexTime) {
      // Per-vertex time: prefer the tile's own array (zero-copy from Arrow).
      // Fallback synthesizes from feature start/end times, memoized per tile so
      // the haversine loop runs once per tile-LOAD, not per re-prepare.
      // Extension-registered attribute — keyed by the EXACT registered
      // attribute name `instanceVertexTime` (see TimeFilterExtension
      // .initializeState). The accessor name `getInstanceVertexTime` does
      // NOT work for the binary interface.
      attributes.instanceVertexTime = {
        value:
          binary.vertexTimestamps &&
          binary.vertexTimestamps.length >= totalVerts
            ? binary.vertexTimestamps
            : synthesizeVertexTimesMemo(binary),
        size: 1,
      };
    }

    // Property-driven categorical color — playhead-INDEPENDENT, so it only
    // applies where the gradient path above did not claim `getColor`.
    // PathLayer instances are SEGMENTS, not features, so the GPU per-feature
    // `instanceCategoryIndex` path (correct for the point layer) under-sizes
    // the instanced buffer here and throws "vertex buffer is not big enough".
    // Resolve each feature's color on the CPU and expand it per-vertex instead
    // — PathLayer's tessellator maps a per-vertex `getColor` onto its segment
    // instances natively. The extra 4 bytes/vertex is negligible at
    // trip-dataset scale.
    if (!attributes.getColor && colorProp) {
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        // Explicit colorMapping → stable per-tile palette (resolved against
        // this tile's own category dictionary); else the ordered colorPalette.
        const palette = this.props.colorMapping
          ? paletteFromMapping(
              cat.categories,
              this.props.colorMapping,
              this.props.colorMappingDefault ?? [120, 120, 120, 255],
            )
          : (this.props.colorPalette ?? DEFAULT_PALETTE);
        attributes.getColor = {
          value: expandCategoryColors(
            cat.indices,
            palette,
            binary.startIndices,
            binary.featureCount,
            totalVerts,
            this.props.colorMappingDefault ?? [120, 120, 120, 255],
          ),
          size: 4,
          normalized: true,
        };
      }
    }

    // Property-driven width is a per-FEATURE column (length featureCount).
    // PathLayer's `instanceStrokeWidths` is per-SEGMENT-instanced (sized to the
    // tessellated vertex count) and deck.gl's binary path binds a size-1 buffer
    // DIRECTLY, so a featureCount-length buffer under-sizes the draw ("vertex
    // buffer is not big enough"). Splat the feature scalar across its vertices,
    // exactly like the categorical-color / gradient paths above. The dynamic
    // per-vertex `widthsFor` hook wins when it produced a buffer.
    if (!attributes.getWidth && widthProp) {
      const values = binary.numericProps[widthProp];
      if (values) {
        attributes.getWidth = {
          // Static per-feature width: memoized per tile (same rationale as the
          // vertex-time cache) so a re-prepare reuses the splat.
          value: expandFeatureWidthsMemo(binary, widthProp, values, totalVerts),
          size: 1,
        };
      }
    }

    // Column range filter (STTDataFilterExtension): bind the named numeric column
    // to the `filterValue` attribute. Unlike the instanced arc/line/point path,
    // PathLayer's `filterValue` is a per-SEGMENT-instanced attribute sized to
    // the tessellated vertex count, so a per-FEATURE column must be splatted
    // per-vertex (exactly like the categorical-color / width paths) — a
    // featureCount-length buffer under-sizes the draw ("vertex buffer is not
    // big enough"). Absent column ⇒ no attribute → the sublayer idles the
    // filter for this tile. A categorical column can't be range-filtered in v1.
    if (filterProp) {
      const values = binary.numericProps[filterProp];
      if (values) {
        attributes.filterValue = {
          value: expandFeatureWidths(
            values,
            binary.startIndices,
            binary.featureCount,
            totalVerts,
          ),
          size: 1,
        };
      } else if (binary.categoricalProps[filterProp]) {
        warnOnce(
          'AnimatedTripsLayer:filterPropertyCategorical',
          `[AnimatedTripsLayer] filterProperty "${filterProp}" is a categorical ` +
            'column; v1 range-filters NUMERIC columns only. The filter is ignored ' +
            'for tiles where the column is categorical.',
        );
      }
    }
    // NOTE: the per-vertex chevron direction sign (signedFlow) is carried on the
    // instanceVertexTime attribute above — see the comment there. No separate
    // attribute is added, to stay under WebGL2's 16-attribute ceiling.

    this.preparedTileCache.set(tileKey, prepared);
    if (probe) {
      emit('tilePrepare', {
        layer: 'AnimatedTripsLayer',
        tileKey,
        cached: false,
        features: binary.featureCount,
        gpuPalette: gpuPalette !== null,
        ms: performance.now() - t0,
      });
    }
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): PathLayer {
    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    const constColor = (
      Array.isArray(colorValue) ? colorValue : [253, 128, 93, 255]
    ) as Color;
    // Fallback for tiles that don't bake a width buffer. MUST stay equal to
    // the documented `tripWidth` default (3): if the two drift apart, a
    // column-named `tripWidth` renders at a different width on tiles missing
    // that column than the default does.
    const constWidth = typeof widthValue === 'number' ? widthValue : 3;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;

    // The `widthMaxPixels: 10` default (upstream: MAX_SAFE_INTEGER) is a HARD
    // screen-space clamp, so a world-space width silently tops out at 10 px —
    // the "my meters width does nothing" trap. Warn once for that combination.
    if (this.props.widthUnits !== 'pixels' && this.props.widthMaxPixels <= 10) {
      warnOnce(
        'AnimatedTripsLayer:metersWidthClamped',
        `[AnimatedTripsLayer] widthUnits: '${this.props.widthUnits}' with ` +
          `widthMaxPixels: ${this.props.widthMaxPixels} (the STT default is 10, ` +
          "not upstream PathLayer's MAX_SAFE_INTEGER) clamps every world-space " +
          'trail to at most 10 screen pixels, so widthScale appears to do ' +
          'nothing past that. Raise widthMaxPixels alongside widthUnits.',
      );
    }
    // Per-feature [start,end] for the window-mode filter (null for trail trips).
    const timeBounds = this.timeBoundsForSublayer(prepared.features);

    // Always false for trips — gpuPalette is intentionally hardwired null in
    // prepareTile (CPU per-vertex colors; GPU palette indices can't ride
    // PathLayer's segment tessellation). Plumbing kept for family parity.
    const useGpuCategory = prepared.gpuPalette !== null;

    // Keep the extension list constant across all sublayers of this
    // AnimatedTripsLayer instance — deck.gl caches compiled shader
    // pipelines per extension set, and a varying list produces one cache
    // entry per (set, props) combination, which manifests as 0.3 FPS
    // shader-rebuild storms during tile churn. CategoryColorExtension
    // sits idle when `useCategoryColor` is false (gated in its own
    // shader branch via the uniform). User extensions from the top-level
    // `extensions` prop are appended (composeExtensions) — the contract
    // holds as long as the caller's entries compare equal across renders.
    // Category-color is idle for some subclasses (FlowStrokeLayer colors via the
    // gradient, never categorically) — dropping its `instanceCategoryIndex`
    // attribute there frees a WebGL2 vertex-attribute slot for an extra extension
    // (e.g. PathStyleExtension's offset), which otherwise overflows the 16-slot
    // floor on GPUs that report exactly 16. The list stays CONSTANT per instance
    // (the subclass's choice never changes), so shader-pipeline caching holds.
    // Column filter: install STTDataFilterExtension only when a column is named
    // (per-layer constant ⇒ stable list across this layer's sublayers). Whether
    // THIS tile actually baked the attribute gates the per-tile enable, so a
    // tile missing the column renders unfiltered (idle extension). Its
    // per-feature alpha commutes with the trail fade + categorical color.
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;
    // ATTRIBUTE-BUDGET: the non-pickable path pipeline (NoPickingPathLayer, 12
    // attrs) + TimeFilterExtension's 3 sits at 15; ONE more extension attribute
    // lands at WebGL2's guaranteed 16-slot floor. CategoryColorExtension
    // (`instanceCategoryIndex`, unconditionally declared `in` its vertex shader
    // so it costs a slot even while idle) is pure DEAD WEIGHT for trips —
    // gpuPalette is hardwired null (categorical color is CPU-expanded into
    // getColor), so its shader branch is permanently off (`useCategoryColor`
    // false). Installing BOTH it AND STTDataFilterExtension (`filterValue`) would
    // make 17 — a fatal per-pipeline link FAILURE (blank trips) on GPUs that
    // report exactly 16 (Apple Silicon, Intel UHD, software WebGL). So when a
    // column filter is installed we DROP the idle CategoryColorExtension and
    // spend that one free slot on `filterValue` instead: net 16, no overflow,
    // no lost color (it was never coloring anything). Mirrors the sibling
    // AnimatedPathLayer's identical trade. `filterProp` +
    // includeCategoryColorExtension() are per-LAYER constants, so the list stays
    // CONSTANT across this layer's sublayers (the shader-cache contract above).
    const baseExtensions: unknown[] =
      this.includeCategoryColorExtension() && !filterProp
        ? [this.timeFilterExtension, this.categoryColorExtension]
        : [this.timeFilterExtension];
    const extensions = this.composeExtensions([
      ...baseExtensions,
      ...(filterProp ? [this.dataFilterExtension] : []),
      ...this.extraTripsExtensions(),
    ]);

    // Pickable sublayers must use the stock PathLayer: NoPickingPathLayer
    // strips `instancePickingColors`, so forwarding pickable:true into it
    // produced silently-broken picking (zeroed picking colors). The stock
    // layer's extra attribute can push the fp64 + TimeFilter + CategoryColor
    // combo past WebGL2's 16-slot minimum on GPUs that report exactly 16 —
    // accepted, with a warning. The picked instance index is the trip index
    // within the tile; getPickingInfo decodes its properties from there.
    // A `_subLayerProps: { trips: { type } }` override beats both defaults.
    if (this.props.pickable) {
      warnOnce(
        'AnimatedTripsLayer:pickableAttributeBudget',
        '[AnimatedTripsLayer] pickable:true renders through the stock PathLayer ' +
          'so picking works, but its instancePickingColors attribute can exceed ' +
          "WebGL2's 16-vertex-attribute minimum on some GPUs (link warning).",
      );
    }
    const SubLayerClass = this.getSubLayerClass(
      'trips',
      this.props.pickable ? PathLayer : NoPickingPathLayer,
    );
    // The resolved CLASS rides in the sublayer id. deck matches a new layer to
    // an old one by id alone and then runs `_transferState` + `_update`, never
    // `_initialize` — so flipping `pickable` under a stable id would hand the
    // stripped shader + AttributeManager (no `instancePickingColors`) to a
    // stock PathLayer and leave picking dead for the life of the layer, and the
    // mirror image on the reverse flip. Folding the class into the id makes the
    // swap a REPLACEMENT. Derived from the RESOLVED class so a
    // `_subLayerProps.trips.type` override — the same class in both branches —
    // keeps a stable id. See `no-picking-path-layer.ts`.
    const instanceKey = `${prepared.tileKey}:${
      SubLayerClass === NoPickingPathLayer ? 'np' : 'pk'
    }`;

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.trips` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    // positionFormat is passed explicitly (sublayerProps beats inheritance):
    // PathLayer's default 'XYZ' would misread 2D tile buffers.
    const props = this.composeSubLayerProps('trips', instanceKey, {
      data: prepared.data,
      // Identity comparator: deck.gl skips prop-diff on `data` when the same
      // object reference comes back. Pairs with preparedTileCache.
      dataComparator: (a: any, b: any) => a === b,
      // Playhead-driven invalidation. `data` stays reference-identical across a
      // sub-step, so deck sees NO data change (and PathLayer's `geometryChanged`
      // — `dataChanged || updateTriggersChanged.getPath` — stays false, i.e. no
      // re-tessellation). These triggers name the ATTRIBUTE IDS rather than the
      // accessors (deck accepts either) so a caller's own `getColor`/`getWidth`
      // updateTriggers, forwarded wholesale by composeSubLayerProps, are left
      // untouched — invalidating `instanceColors` is exactly equivalent.
      updateTriggers: {
        ...this.props.updateTriggers,
        instanceColors: prepared.dynamicVersion,
        instanceStrokeWidths: prepared.dynamicVersion,
        instanceVertexTime: prepared.dynamicVersion,
      },
      _pathType: this.props.pathType ?? 'open',
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',
      // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
      widthUnits: this.props.widthUnits,
      widthScale: this.props.widthScale,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      capRounded: this.props.capRounded,
      jointRounded: this.props.jointRounded,
      miterLimit: this.props.miterLimit,
      billboard: this.props.billboard,

      // Constants are harmless when the binary attribute is present (binary
      // attributes win); they only kick in for tiles missing the property.
      getColor: constColor,
      getWidth: constWidth,
      // Subclass extras (e.g. FlowStrokeLayer's constant getOffset for the
      // PathStyleExtension twin-ribbon offset). Empty for the base class.
      ...this.extraTripsSubLayerProps(),

      extensions,
      // Dynamic time: extension reads getTime() on every draw, so we never
      // recreate the layer for time-only changes.
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      // Time-as-height (space-time cube): a pure uniform pair, so the morph
      // slider only re-issues sublayer props — no data/GPU re-upload.
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,
      trailLength: this.props.trailLength,
      // Whether the trail fades head→tail or renders solid. This prop is baked
      // into the sublayer cache key, so it MUST also be forwarded to the
      // TimeFilterExtension here — keyed but not forwarded, `fadeTrail: false`
      // is a silent no-op.
      fadeTrail: this.props.fadeTrail,
      // Static-geometry layers (FlowCorridorLayer) feed the corridor's full
      // [start,end] so the window-mode filter never hides it; trail trips leave
      // these unset (instanceVertexTime drives visibility instead).
      ...(timeBounds && {
        getInstanceStartTime: timeBounds.start,
        getInstanceEndTime: timeBounds.end,
      }),

      // TileLayer convention: the source tile rides on the sublayer so the
      // base getPickingInfo can enrich info.tile / decode the picked trip.
      tile: prepared.tile,
      sttFeatures: prepared.features,

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
    // NoPickingPathLayer (the non-pickable branch) frees the
    // `instancePickingColors` attribute slot, which keeps the fp64 +
    // TimeFilter + CategoryColor combo under WebGL2's 16-attribute minimum.
    // Sublayers there are non-pickable, so dropping the picking buffer is a
    // no-op behaviourally. See `no-picking-path-layer.ts` for the upstream-fix
    // timeline.
    return new SubLayerClass(props as any);
  }
}
