/**
 * @poopdeck.gl/maplibre — MapLibre GL custom-layer adapters for STT archives.
 *
 * Five layer classes, one per visualisation kind. Add the one(s) you need to
 * your map; each manages its own archive read, tile cache and shader pipeline:
 *
 *   - {@link STTPointLayer} — Point features (billboards).
 *   - {@link STTLineLayer} — LineString features, constant width window mode.
 *   - {@link STTPolygonLayer} — Polygon features, with optional stroke and
 *     extrusion.
 *   - {@link STTTripsLayer} — LineString features rendered with a trailing
 *     fade anchored at `currentTime` (parity with `AnimatedTripsLayer`).
 *   - {@link STTHeatmapLayer} — Density heatmap from POINT tiles, with an
 *     additive splat + colour-ramp pipeline (parity with `HeatmapTimeLayer`).
 *
 * For tiles containing multiple geometry types, instantiate multiple layers
 * pointing at the same URL — each will pick out the geometries it accepts —
 * or hand them one {@link SharedTilesetSource} (`{ source }` instead of
 * `{ url }`) so they share a single archive + tileset and a single governor
 * `BufferSource`.
 *
 * Layers work on maplibre v3–v6 and mapbox v3 from one build: `render()`
 * duck-types the host's calling convention (`lib/host-adapter.ts`), and on
 * v5+ hosts the shaders compile the host's injected projection prelude, which
 * includes globe. Prefer {@link STTBaseLayer.attach} over `map.addLayer` — it
 * survives `setStyle` diff-fallback rebuilds; `detach()` removes.
 *
 * For deck.gl's rounded joints, dashes and GPU picking, use
 * {@link "@poopdeck.gl/layers"} instead. This adapter exists for sites that don't
 * want a deck.gl dependency or that need to interleave STT data between
 * native MapLibre layers.
 */

export {
  STTPointLayer,
  type STTPointLayerOptions,
} from './layers/point-layer.js';
export { STTLineLayer, type STTLineLayerOptions } from './layers/line-layer.js';
export {
  STTPolygonLayer,
  type STTPolygonLayerOptions,
} from './layers/polygon-layer.js';
export {
  STTTripsLayer,
  type STTTripsLayerOptions,
} from './layers/trips-layer.js';
export {
  STTHeatmapLayer,
  type STTHeatmapLayerOptions,
} from './layers/heatmap-layer.js';
export {
  STTBaseLayer,
  cssToDevicePixel,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  type PickProvenanceEntry,
  type RGBA,
  type RGBA8,
} from './base-layer.js';
export { lngLatToMercator, projectPositions } from './lib/projection.js';

// Shared tileset source (D6a): ONE archive + ONE tileset serving N layers.
// Construct one per .stt, pass it to each layer as `{ source }`, and register
// its getBufferSource() with a PlaybackGovernor once per source.
export {
  SharedTilesetSource,
  SharedTilesetBufferSource,
  residentSetEqual,
  tileKey,
  type SharedTilesetSourceOptions,
  type SharedViewport,
  type TilesetConsumer,
  type DrivableTileset,
  type RunwayTileset,
} from './lib/streaming-source.js';

// Host render-signature adapter (D2): the normalized per-frame shape layers
// draw from, public for full-render()-override subclasses and tests.
export {
  createHostFrame,
  normalizeRenderArgs,
  DEFAULT_FOV_RADIANS,
  type HostFrame,
  type HostShaderData,
  type HostProjectionData,
} from './lib/host-adapter.js';

// Globe correctness kit (D4): mercator-space subdivision + wrap/granularity
// helpers for custom subclasses targeting v5+ globe hosts.
export {
  subdivideLineMercator,
  subdivideTrianglesMercator,
  shouldDrawWorldCopy,
  granularityForZoom,
  type AttrArray,
  type SubdivisionAttrs,
  type LineSubdivisionResult,
} from './lib/globe.js';

// Shared id-buffer picking result shape (see `STTBaseLayer.pick`). Re-exported
// from the core picking kernel so consumers don't reach across packages.
export type { SttPickResult } from '@poopdeck.gl/core/picking';

// Backend capability descriptor — what this adapter declares against the shared
// `@poopdeck.gl/core/capabilities` vocabulary (renderer-abstraction Phase 5).
export { maplibreBackend } from './backend-descriptor.js';

// Backwards-compat alias for the 0.1.x scaffold, which only had a points
// renderer named STTMaplibreLayer. New code should import STTPointLayer.
export { STTPointLayer as STTMaplibreLayer } from './layers/point-layer.js';
export type { STTPointLayerOptions as STTMaplibreLayerOptions } from './layers/point-layer.js';
