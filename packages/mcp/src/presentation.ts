// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * `presentation` — the deterministic "desired presentation" recommender behind
 * `view_map`. Given a dataset's manifest (geometry, temporal grain, measured
 * `style_hints`, summary tier) and an optional presentation `intent`, it decides
 * the render facets the raw layer inference never touched: which layer best
 * expresses the intent, what property drives color and over what measured
 * domain, how wide the visible time window should be, and whether to render the
 * coarse summary tier.
 *
 * It reasons ONLY over manifest fields the packed format actually carries and
 * emits only props the STT layer chassis actually accepts (per family). When a
 * requested facet has no backing data (e.g. color-by with no measured
 * percentiles) it degrades with a `warning` rather than inventing numbers — the
 * caller folds these into the `view_map` advisories. No deps; unit-testable in
 * isolation; the `layer` tool param still overrides everything downstream.
 */
import type { DatasetColumnSummary, DatasetDescription } from './manifest.js';

/**
 * The presentation-intent vocabulary. A const tuple so `z.enum` on the server
 * side infers the exact literal union (and rejects anything else).
 */
export const PRESENTATION_INTENTS = [
  'exploratory',
  'density',
  'tracking',
  'choropleth',
  'flow',
  'magnitude',
] as const;

/**
 * How the user wants the data shown. Biases layer/color/tier/timeWindow toward a
 * reading; explicit overrides (`colorBy`/`timeWindow`) always win over the bias.
 */
export type PresentationIntent = (typeof PRESENTATION_INTENTS)[number];

export interface PresentationOptions {
  intent?: PresentationIntent;
  /** Force the color-by property (overrides the auto pick from measured columns). */
  colorBy?: string;
  /** Force the visible time window in ms (overrides the temporal-grain-derived default). */
  timeWindow?: number;
}

/** Context the caller (buildViewMap) supplies so this module needs no view-map import. */
export interface PresentationContext {
  /** The layer `@@type` already inferred/overridden for this dataset. */
  baseLayerType: string;
  /**
   * True when `baseLayerType` was EXPLICITLY chosen by the caller (the
   * `layer` tool param): intents then never promote it, and every facet is
   * resolved against the locked type — otherwise trips/summary-only props
   * would be computed for a promoted type and merged onto a layer that
   * cannot render them.
   */
  layerLocked?: boolean;
  /** The summary-tier `@@type` (H3SummaryLayer/QuadbinSummaryLayer) when the dataset has one. */
  summaryLayerType?: string;
  /** The zoom the map is framed at (from the union bbox) — decides if the summary tier is in range. */
  framedZoom: number;
}

export interface PresentationResult {
  /** A layer `@@type` the intent upgraded to (e.g. summary/trips); `undefined` = keep the base. */
  layerType?: string;
  /** Extra props to merge onto the layer (timeWindow, tier, weight/gradient color props). */
  props: Record<string, unknown>;
  /** The property chosen to drive color, if any. */
  colorBy?: string;
  /** The measured `[lo, hi]` domain for `colorBy`, if one was found. */
  colorDomain?: [number, number];
  /** Non-fatal advisories about facets that couldn't be honored. */
  warnings: string[];
}

/** Layers whose scalar color-by is `weightProperty` + `colorDomain`. */
const WEIGHT_DOMAIN_LAYERS = new Set([
  'H3SummaryLayer',
  'QuadbinSummaryLayer',
  'AnimatedHeatmapLayer',
]);
/** Layers whose scalar color-by is `gradientProperty` + `gradientDomain`. */
const GRADIENT_DOMAIN_LAYERS = new Set(['AnimatedTripsLayer']);
/** Line layers that `tracking` can promote to an animated-trail (trips) layer, or `flow` to OD arcs. */
const LINE_LAYERS = new Set(['AnimatedPathLayer', 'AnimatedTripsLayer']);
/**
 * Point layers that `magnitude` can promote to extruded 3D columns. The only
 * point `@@type` the geometry inference / `points` layer_hint ever produces is
 * `AnimatedPointLayer`; kept a set so the promotion check reads symmetrically
 * with {@link LINE_LAYERS} and tolerates future point base types.
 */
const POINT_LAYERS = new Set(['AnimatedPointLayer']);

/**
 * Visible window = this many temporal buckets. MUST match
 * `DEFAULT_TIME_WINDOW_BUCKETS` in `@poopdeck.gl/playback` (derive-params.ts) —
 * the one bucket→window default the whole ecosystem shares — or `view_map`
 * specs render with a different window than the runtime derives for the very
 * same archive. (This module stays dependency-free, so the value is pinned
 * here with that contract instead of imported.)
 */
const WINDOW_BUCKET_MULTIPLE = 24;
/** `tracking` shows longer trails — widen the window by this factor. */
const TRACKING_WINDOW_FACTOR = 4;
/**
 * Fallback window when the dataset declares no temporal bucket: 24 h,
 * matching `DEFAULT_TIME_WINDOW_MS` in `@poopdeck.gl/playback` (same contract
 * as `WINDOW_BUCKET_MULTIPLE` above). Span-clamped by the caller.
 */
const FALLBACK_WINDOW_MS = 86_400_000;

/**
 * Recommend the presentation facets for one dataset. Pure function of the
 * manifest + intent + context; never throws — unresolvable requests surface as
 * `warnings`.
 */
export function recommendPresentation(
  dataset: DatasetDescription,
  ctx: PresentationContext,
  options: PresentationOptions = {},
): PresentationResult {
  const warnings: string[] = [];
  const intent = options.intent;

  // --- Layer type: an intent may promote the geometry-inferred base layer. ---
  const layerType = resolveLayerType(dataset, ctx, intent, warnings);
  const effectiveType = layerType ?? ctx.baseLayerType;

  const props: Record<string, unknown> = {};

  // --- Time window: temporal grain drives it; tracking widens it. ---
  const timeWindow = resolveTimeWindow(dataset, intent, options.timeWindow);
  if (timeWindow !== undefined) props.timeWindow = timeWindow;

  // --- Tier: density reads the coarse summary tier when it is in zoom range
  // AND the summary layer is actually the one being rendered (a locked
  // non-summary layer must not be pointed at summary tiles). ---
  if (
    intent === 'density' &&
    dataset.hasSummaryTier &&
    isSummaryInRange(dataset, ctx.framedZoom) &&
    effectiveType === ctx.summaryLayerType
  ) {
    props.tier = 'summary';
  }

  // --- Color-by: pick a measured property and emit the layer's domain props. ---
  const color = resolveColorBy(
    dataset,
    effectiveType,
    options,
    intent,
    warnings,
  );

  return {
    layerType,
    props: { ...props, ...color.props },
    colorBy: color.colorBy,
    colorDomain: color.colorDomain,
    warnings,
  };
}

/** Promote the base layer when the intent asks for a reading the geometry supports. */
function resolveLayerType(
  dataset: DatasetDescription,
  ctx: PresentationContext,
  intent: PresentationIntent | undefined,
  warnings: string[],
): string | undefined {
  // An explicitly chosen layer is never promoted — surface what the intent
  // would have done instead, so the caller can drop the override if they want it.
  if (ctx.layerLocked) {
    if (
      intent === 'density' &&
      ctx.summaryLayerType &&
      ctx.baseLayerType !== ctx.summaryLayerType
    ) {
      warnings.push(
        `intent "density" would read the ${ctx.summaryLayerType} summary tier, but the layer ` +
          `was explicitly set to ${ctx.baseLayerType} — keeping it (omit the layer override for the density view).`,
      );
    }
    if (
      intent === 'tracking' &&
      ctx.baseLayerType !== 'AnimatedTripsLayer' &&
      LINE_LAYERS.has(ctx.baseLayerType)
    ) {
      warnings.push(
        `intent "tracking" would render AnimatedTripsLayer trails, but the layer was ` +
          `explicitly set to ${ctx.baseLayerType} — keeping it (omit the layer override for trails).`,
      );
    }
    if (
      intent === 'flow' &&
      ctx.baseLayerType !== 'AnimatedArcLayer' &&
      LINE_LAYERS.has(ctx.baseLayerType)
    ) {
      warnings.push(
        `intent "flow" would render AnimatedArcLayer origin→destination arcs, but the layer was ` +
          `explicitly set to ${ctx.baseLayerType} — keeping it (omit the layer override for arcs).`,
      );
    }
    if (
      intent === 'magnitude' &&
      ctx.baseLayerType !== 'AnimatedColumnLayer' &&
      POINT_LAYERS.has(ctx.baseLayerType)
    ) {
      warnings.push(
        `intent "magnitude" would extrude AnimatedColumnLayer columns, but the layer was ` +
          `explicitly set to ${ctx.baseLayerType} — keeping it (omit the layer override for columns).`,
      );
    }
    return undefined;
  }
  if (intent === 'density') {
    if (ctx.summaryLayerType) return ctx.summaryLayerType;
    warnings.push(
      `intent "density" wants a summary/H3 tier, but "${datasetId(dataset)}" has none — ` +
        `keeping ${ctx.baseLayerType}. Rebuild with --summary-tier h3 (or quadbin) for a density view.`,
    );
    return undefined;
  }
  if (intent === 'tracking') {
    if (LINE_LAYERS.has(ctx.baseLayerType)) return 'AnimatedTripsLayer';
    warnings.push(
      `intent "tracking" wants trajectory/trail rendering, but "${datasetId(dataset)}" is ` +
        `${ctx.baseLayerType} (not line geometry) — keeping it.`,
    );
    return undefined;
  }
  if (intent === 'flow') {
    // OD/flow reads as one arc per (typically 2-vertex) LineString: source =
    // first vertex, target = last (AnimatedArcLayer's contract). Only line
    // geometry carries that source→target pair.
    if (LINE_LAYERS.has(ctx.baseLayerType)) return 'AnimatedArcLayer';
    warnings.push(
      `intent "flow" renders origin→destination arcs, but "${datasetId(dataset)}" is ` +
        `${ctx.baseLayerType} (not OD line geometry) — keeping it. Build OD-pair LineStrings ` +
        `(e.g. nyc-rideshare --od) for a flow/arc view.`,
    );
    return undefined;
  }
  if (intent === 'magnitude') {
    // Extruded columns rise from point features; height/color is a per-column
    // prop the caller sets (this only promotes the @@type, never spreads an
    // optional accessor that would shadow the layer's default).
    if (POINT_LAYERS.has(ctx.baseLayerType)) return 'AnimatedColumnLayer';
    warnings.push(
      `intent "magnitude" extrudes 3D columns at point features, but "${datasetId(dataset)}" is ` +
        `${ctx.baseLayerType} (not point geometry) — keeping it.`,
    );
    return undefined;
  }
  if (intent === 'choropleth' && ctx.baseLayerType !== 'AnimatedPolygonLayer') {
    warnings.push(
      `intent "choropleth" reads best on polygon geometry, but "${datasetId(dataset)}" is ` +
        `${ctx.baseLayerType} — keeping it (color-by still applies where supported).`,
    );
  }
  return undefined;
}

/** Visible time window from the temporal grain (a few buckets), widened for tracking. */
function resolveTimeWindow(
  dataset: DatasetDescription,
  intent: PresentationIntent | undefined,
  override: number | undefined,
): number | undefined {
  if (override !== undefined) return override;
  const factor = intent === 'tracking' ? TRACKING_WINDOW_FACTOR : 1;
  const bucket = dataset.temporalBucketMs;
  const span = dataset.timeRange
    ? dataset.timeRange.end - dataset.timeRange.start
    : undefined;
  let base: number | undefined;
  if (bucket && bucket > 0) {
    base = bucket * WINDOW_BUCKET_MULTIPLE;
  } else if (span && span > 0) {
    base = FALLBACK_WINDOW_MS;
  }
  if (base === undefined) return undefined;
  const win = Math.round(base * factor);
  // Never recommend showing more than the data actually spans.
  return span && span > 0 ? Math.min(win, span) : win;
}

/** Is the framed zoom within the summary tier's declared zoom span? */
function isSummaryInRange(
  dataset: DatasetDescription,
  framedZoom: number,
): boolean {
  const tier = dataset.summaryTier;
  if (!tier) return false;
  return framedZoom <= tier.max_zoom;
}

interface ColorResolution {
  props: Record<string, unknown>;
  colorBy?: string;
  colorDomain?: [number, number];
}

/** Layers that read SUMMARY tiles, whose properties are the aggregated columns. */
const SUMMARY_TILE_LAYERS = new Set(['H3SummaryLayer', 'QuadbinSummaryLayer']);

/** Choose a color-by property and emit the target layer's domain props (or warn). */
function resolveColorBy(
  dataset: DatasetDescription,
  layerType: string,
  options: PresentationOptions,
  intent: PresentationIntent | undefined,
  warnings: string[],
): ColorResolution {
  const supportsWeight = WEIGHT_DOMAIN_LAYERS.has(layerType);
  const supportsGradient = GRADIENT_DOMAIN_LAYERS.has(layerType);

  // Resolve which property to color by: explicit override, else the first
  // measured numeric column (the auto pick is skipped for non-density unless a
  // domain-capable layer can actually show it). An explicit pick that resolves
  // to a KNOWN non-numeric column is rejected below — wiring a text column as
  // a weight/gradient property renders a silently blank/wrong layer.
  const explicit = options.colorBy;
  const explicitCol = explicit ? findColumn(dataset, explicit) : undefined;
  const explicitNonNumeric =
    explicitCol !== undefined && explicitCol.type !== 'Number';
  const numericCol = explicit
    ? explicitNonNumeric
      ? undefined
      : explicitCol
    : firstNumericColumn(dataset);

  if (!supportsWeight && !supportsGradient) {
    if (explicit) {
      warnings.push(
        `color-by "${explicit}" was requested, but ${layerType} has no first-class ` +
          `scalar color-domain prop — set getFillColor/getColor manually for this layer.`,
      );
    }
    return { props: {} };
  }

  if (explicitNonNumeric) {
    warnings.push(
      `color-by "${explicit}" is a categorical/text column on "${datasetId(dataset)}" — ` +
        `${layerType} needs a measured NUMERIC column for its scalar color domain, so the ` +
        `request was not wired (the layer keeps its default weighting).`,
    );
    return { props: {} };
  }

  if (explicit && !numericCol) {
    warnings.push(
      `color-by "${explicit}" was requested, but "${datasetId(dataset)}" exposes no measured ` +
        `numeric column by that name (build with --style-hints to bake per-property domains).`,
    );
    // Still wire the property name so the layer weights by it, just without a domain.
  }

  const colorBy = explicit ?? numericCol?.name;
  // For summary/heatmap layers, a missing colorBy is fine — they default to
  // weightProperty:'count'. Only bail when there's nothing to say at all.
  if (colorBy === undefined) {
    if (intent === 'density' || supportsGradient) {
      warnings.push(
        `no measured numeric column found on "${datasetId(dataset)}" to color by — ` +
          `${layerType} falls back to its default weighting (build with --style-hints for a data-driven domain).`,
      );
    }
    return { props: {} };
  }

  const domain = numericCol ? columnDomain(numericCol) : undefined;
  const props: Record<string, unknown> = {};
  if (supportsWeight) {
    if (SUMMARY_TILE_LAYERS.has(layerType)) {
      // Summary tiles carry the AGGREGATED columns (`count` / `<agg>_<source>`,
      // summary.rs::output_column_name), not the raw source properties — a raw
      // name would miss the tile's numericProps and blank the whole layer.
      const aggregated = summaryOutputColumn(dataset, colorBy);
      if (aggregated === undefined) {
        if (explicit) {
          warnings.push(
            `color-by "${colorBy}" is not aggregated into the summary tier of ` +
              `"${datasetId(dataset)}" — the summary layer keeps its cell-count default ` +
              `(rebuild with --summary-columns "${colorBy}:mean" to weight by it).`,
          );
        }
        return { props: {} };
      }
      props.weightProperty = aggregated.name;
      // The measured domain describes the RAW distribution; it only bounds
      // order-preserving aggregates (mean/min/max), never count/sum.
      if (domain && aggregated.domainPreserving) props.colorDomain = domain;
      return {
        props,
        colorBy,
        colorDomain: aggregated.domainPreserving ? domain : undefined,
      };
    }
    props.weightProperty = colorBy;
    if (domain) props.colorDomain = domain;
  } else {
    props.gradientProperty = colorBy;
    if (domain) props.gradientDomain = domain;
  }
  return { props, colorBy, colorDomain: domain };
}

/**
 * Map a source column to its on-wire summary-tile column
 * (summary.rs::output_column_name): `count` for the count aggregate, else
 * `<agg>_<source>`. Accepts a name that is ALREADY an output column
 * (`count` / `mean_magnitude`) and passes it through. `domainPreserving` is
 * true for aggregates whose values stay inside the source column's measured
 * domain (mean/min/max).
 */
function summaryOutputColumn(
  dataset: DatasetDescription,
  colorBy: string,
): { name: string; domainPreserving: boolean } | undefined {
  const columns = dataset.summaryTier?.columns;
  if (!columns || columns.length === 0) return undefined;
  const DOMAIN_PRESERVING = new Set(['mean', 'min', 'max']);
  for (const c of columns) {
    const output = c.agg === 'count' ? 'count' : `${c.agg}_${c.name}`;
    if (colorBy === c.name || colorBy === output) {
      return { name: output, domainPreserving: DOMAIN_PRESERVING.has(c.agg) };
    }
  }
  return undefined;
}

/** First measured numeric column that carries a usable domain (deterministic by manifest order). */
function firstNumericColumn(
  dataset: DatasetDescription,
): DatasetColumnSummary | undefined {
  return dataset.columns?.find(
    (c) => c.type === 'Number' && columnDomain(c) !== undefined,
  );
}

function findColumn(
  dataset: DatasetDescription,
  name: string,
): DatasetColumnSummary | undefined {
  return dataset.columns?.find((c) => c.name === name);
}

/** Measured `[lo, hi]` for a column: the suggested (p97-clamped) domain, else raw min/max. */
function columnDomain(col: DatasetColumnSummary): [number, number] | undefined {
  if (col.suggestedDomain) return col.suggestedDomain;
  if (typeof col.min === 'number' && typeof col.max === 'number')
    return [col.min, col.max];
  return undefined;
}

function datasetId(dataset: DatasetDescription): string {
  return dataset.name || dataset.metadataName || 'dataset';
}
