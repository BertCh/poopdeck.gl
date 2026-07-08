// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * `view_map` tool support — composes a `@deck.gl/json`-shaped deck spec
 * referencing STT layer `@@type`s (STT layer class names such as
 * `SpatioTemporalLayer` / `AnimatedTripsLayer`), pointed at one or more
 * datasets' manifest URLs. This server has no live renderer, so it returns
 * the JSON spec as text (always) plus a best-effort self-contained HTML
 * resource for MCP-Apps-capable clients (never required for the tool call to
 * succeed).
 *
 * This module has NO runtime dependency on `@deck.gl/json` or
 * `@poopdeck.gl/layers` (ground rule: this package's only dependencies are
 * `@modelcontextprotocol/sdk` + `zod`) — `@@type` values are plain strings,
 * matched by the host against the STT layer classes it registers in its
 * `@deck.gl/json` `JSONConfiguration`.
 */
import type { DatasetDescription } from './manifest.js';

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

export interface ViewMapOptions {
  /** Force this `@@type` for every dataset, overriding the per-dataset inference below. */
  layer?: string;
  viewState?: Partial<ViewState>;
  /** `currentTime` applied to every layer (Unix ms). Defaults to the first dataset's `timeRange.start`. */
  time?: number;
  /**
   * Base URL datasets are served from (e.g. an R2/CDN origin or a local
   * `stt-serve`/static-file-server root) — manifest URLs become
   * `${publicBaseUrl}/${name}/manifest.json`. Omit to fall back to the raw
   * filesystem path (informational — most `@deck.gl/json` hosts need an
   * http(s) URL to actually fetch tiles; see the `view_map` tool description).
   */
  publicBaseUrl?: string;
}

export interface ViewMapResult {
  spec: { layers: unknown[]; initialViewState: ViewState };
  /** Self-contained HTML page presenting `spec` legibly (a preview, not a live map — see {@link renderHtml}). */
  html: string;
  /**
   * Non-fatal advisories about the composed spec — e.g. a layer whose geometry
   * kind had to be guessed (defaulted to `AnimatedPointLayer`), or a manifest
   * URL that is a bare filesystem path most hosts cannot fetch. Empty when the
   * spec is unambiguous and browser-loadable.
   */
  warnings: string[];
}

/** Where an inferred `@@type` came from — a positive signal (`hint`/`summary`) or the blind `default` fallback. */
export type LayerConfidence = 'hint' | 'summary' | 'default';

/** Result of {@link inferLayerType}: the chosen `@@type` and how much to trust it. */
export interface InferredLayer {
  type: string;
  confidence: LayerConfidence;
}

/** Maps a build-time `style_hints.layer_hint` (`'points'|'paths'|'trips'|'polygons'`) to an STT `@@type`. */
const LAYER_HINT_TO_TYPE: Record<string, string> = {
  points: 'AnimatedPointLayer',
  paths: 'AnimatedPathLayer',
  trips: 'AnimatedTripsLayer',
  polygons: 'AnimatedPolygonLayer',
};

/** Maps a summary tier's `scheme` (`'h3'|'quadbin'`) to its STT summary-layer `@@type`. */
const SUMMARY_SCHEME_TO_TYPE: Record<string, string> = {
  h3: 'H3SummaryLayer',
  quadbin: 'QuadbinSummaryLayer',
};

/**
 * Infers a `@@type` for a dataset and reports how confident that choice is:
 *
 *  - `hint` — build-time `style_hints.layer_hint` names the actual raw-tier
 *    geometry kind the archive was built for (the only positive geometry
 *    signal the packed format carries); trustworthy.
 *  - `summary` — no geometry hint, but a summary-tier scheme (`h3`/`quadbin`)
 *    implies its matching summary layer; trustworthy for the summary tier.
 *  - `default` — NO positive signal at all, so this blindly falls back to
 *    `AnimatedPointLayer`. On every currently-shipped archive
 *    (`metadata.layers` is always `["default"]`, no `layer_hint`) this is the
 *    branch taken, and the real geometry may well be lines/polygons/trips —
 *    the caller surfaces this as a warning ({@link buildViewMap}).
 *
 * The `layer` tool param always overrides this inference outright.
 */
export function inferLayerType(dataset: DatasetDescription): InferredLayer {
  const hint = dataset.styleHints?.layer_hint;
  if (hint && LAYER_HINT_TO_TYPE[hint]) return { type: LAYER_HINT_TO_TYPE[hint], confidence: 'hint' };
  if (dataset.hasSummaryTier && dataset.summaryScheme && SUMMARY_SCHEME_TO_TYPE[dataset.summaryScheme]) {
    return { type: SUMMARY_SCHEME_TO_TYPE[dataset.summaryScheme], confidence: 'summary' };
  }
  return { type: 'AnimatedPointLayer', confidence: 'default' };
}

/** `${publicBaseUrl}/${name}/manifest.json` when configured, else the raw filesystem manifest path. */
export function resolveManifestUrl(dataset: DatasetDescription, publicBaseUrl?: string): string {
  if (publicBaseUrl) {
    const base = publicBaseUrl.replace(/\/+$/, '');
    return `${base}/${dataset.name}/manifest.json`;
  }
  return `${dataset.path}/manifest.json`;
}

/** Smallest span (degrees) we will divide 360 by — guards a single-tile / point-only bbox from an infinite zoom. */
const MIN_SPAN_DEG = 1e-6;
/** Upper zoom clamp when no dataset declares a `maxZoom` (a reasonable web-map ceiling). */
const FALLBACK_MAX_ZOOM = 20;

/**
 * Union bounding box center + a zoom derived from the union's *extent*, not
 * from any per-dataset `minZoom`. Unioning disjoint bboxes and then picking
 * the coarsest declared `minZoom` framed everything at a useless world zoom;
 * instead we fit the union's larger span: `floor(log2(360 / span))`, clamped
 * to `[0, maxZoomOfData]`. A single small-bbox dataset therefore frames
 * tightly, while far-apart datasets (a wide union span) zoom sensibly out.
 */
function defaultViewState(datasets: DatasetDescription[]): ViewState {
  const withBounds = datasets.filter((d) => d.boundingBox);
  if (withBounds.length === 0) {
    return { longitude: 0, latitude: 0, zoom: 1, pitch: 0, bearing: 0 };
  }
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let maxZoom = -Infinity;
  for (const d of withBounds) {
    const b = d.boundingBox!;
    minLon = Math.min(minLon, b.minLon);
    minLat = Math.min(minLat, b.minLat);
    maxLon = Math.max(maxLon, b.maxLon);
    maxLat = Math.max(maxLat, b.maxLat);
    if (d.maxZoom !== undefined) maxZoom = Math.max(maxZoom, d.maxZoom);
  }
  const span = Math.max(maxLon - minLon, maxLat - minLat, MIN_SPAN_DEG);
  const zoomCeiling = maxZoom === -Infinity ? FALLBACK_MAX_ZOOM : maxZoom;
  const zoom = clamp(Math.floor(Math.log2(360 / span)), 0, zoomCeiling);
  return {
    longitude: (minLon + maxLon) / 2,
    latitude: (minLat + maxLat) / 2,
    zoom,
    pitch: 0,
    bearing: 0,
  };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** Builds the `@deck.gl/json` spec + a best-effort HTML resource + advisory warnings for one or more datasets. */
export function buildViewMap(datasets: DatasetDescription[], options: ViewMapOptions = {}): ViewMapResult {
  const currentTime = options.time ?? datasets[0]?.timeRange?.start;
  const warnings: string[] = [];
  const layers = datasets.map((dataset) => {
    const inferred = inferLayerType(dataset);
    const type = options.layer ?? inferred.type;
    // An explicit `layer` override is a deliberate choice, so it suppresses the
    // geometry-unknown warning; a bare `default` inference does not.
    if (options.layer === undefined && inferred.confidence === 'default') {
      warnings.push(
        `Layer for "${dataset.name}": geometry type is unknown (no style_hints/summary tier on this dataset), ` +
          `defaulting to AnimatedPointLayer — pass the \`layer\` param (e.g. ` +
          `AnimatedPathLayer/AnimatedTripsLayer/AnimatedPolygonLayer) or rebuild with --style-hints if it is ` +
          `not point data.`,
      );
    }
    const props: Record<string, unknown> = {
      '@@type': type,
      id: dataset.name,
      data: resolveManifestUrl(dataset, options.publicBaseUrl),
    };
    if (currentTime !== undefined) props.currentTime = currentTime;
    return props;
  });

  // A missing publicBaseUrl makes every `data` a raw filesystem path; warn once,
  // since it is a single server-level configuration gap, not a per-layer one.
  if (!options.publicBaseUrl && datasets.length > 0) {
    warnings.push(
      `Manifest URLs are local filesystem paths, which most @deck.gl/json hosts cannot fetch — ` +
        `set --public-base-url to an http(s) origin for a browser-loadable URL.`,
    );
  }

  const base = defaultViewState(datasets);
  const initialViewState: ViewState = {
    longitude: options.viewState?.longitude ?? base.longitude,
    latitude: options.viewState?.latitude ?? base.latitude,
    zoom: options.viewState?.zoom ?? base.zoom,
    pitch: options.viewState?.pitch ?? base.pitch,
    bearing: options.viewState?.bearing ?? base.bearing,
  };

  const spec = { layers, initialViewState };
  return { spec, html: renderHtml(spec, datasets, warnings), warnings };
}

/**
 * A minimal, self-contained HTML page that presents the composed
 * `@deck.gl/json` spec legibly — deliberately a *spec preview*, NOT a live
 * map. An earlier version instantiated a `deck.Deck` from CDN scripts, but
 * with no `@poopdeck.gl/layers` class catalog available it only ever rendered
 * an empty black canvas that read as a broken render. Instead this page states
 * plainly that live rendering requires the host to register the STT layer
 * classes in its own `@deck.gl/json` `JSONConfiguration` (and an http(s)
 * `--public-base-url` so the manifest URL is browser-loadable), embeds the
 * spec pretty-printed for humans, and also
 * carries it verbatim in a `<script type="application/json">` block for a host
 * that DOES wire up a renderer. Best-effort resource only — the tool call's
 * authoritative `text` content carries the same JSON regardless.
 */
function renderHtml(spec: ViewMapResult['spec'], datasets: DatasetDescription[], warnings: string[]): string {
  const title = datasets.map((d) => d.name).join(', ') || 'STT view_map';
  // Escaping `<` as `<` keeps the JSON safe inside the <script> block (no `</script>` break-out).
  const specJson = JSON.stringify(spec).replace(/</g, '\\u003c');
  const prettySpec = escapeHtml(JSON.stringify(spec, null, 2));
  const warningsHtml =
    warnings.length > 0
      ? `<section class="warnings"><h2>Advisories</h2><ul>${warnings
          .map((w) => `<li>${escapeHtml(w)}</li>`)
          .join('')}</ul></section>`
      : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 1.5rem; font: 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  h2 { font-size: .95rem; margin: 1.25rem 0 .4rem; }
  .notice { border-left: 3px solid #d0a000; background: #d0a00018; padding: .6rem .8rem; border-radius: 4px; }
  .notice strong { color: #b48600; }
  .warnings ul { margin: 0; padding-left: 1.1rem; }
  .warnings li { color: #b45309; }
  pre { overflow-x: auto; background: #8881; padding: .8rem; border-radius: 4px; font: 12px/1.45 ui-monospace, monospace; }
  code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<main>
<h1>STT view_map &mdash; spec preview for ${escapeHtml(title)}</h1>
<p class="notice">This is a <strong>preview of the @deck.gl/json spec, not a live map</strong>.
Live rendering requires the MCP-Apps host to register the STT layer classes with
<code>@deck.gl/json</code> and to serve the datasets from an http(s)
<code>--public-base-url</code> so each manifest URL is browser-loadable. Rendering the spec
below without those two pieces would only draw an empty canvas.</p>
${warningsHtml}
<h2>@deck.gl/json spec</h2>
<pre>${prettySpec}</pre>
</main>
<script type="application/json" id="stt-view-map-spec">${specJson}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
