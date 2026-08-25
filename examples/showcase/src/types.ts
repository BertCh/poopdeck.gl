import { resolvePlaybackParams } from '@poopdeck.gl/playback';
import type { LayerKind } from '@poopdeck.gl/core/capabilities';

/**
 * Showcase-LOCAL dataset types: editorial COMPOSITIONS (several archives on one
 * playhead) plus one render VARIANT, none of which is a layer kind any backend
 * could declare — they are demos, not renderers. Everything else a dataset can
 * be is a core {@link LayerKind}, imported above rather than respelled here.
 *
 * This union used to be a second, hand-written copy of the whole layer
 * vocabulary, and it had already drifted from the frozen one in
 * `@poopdeck.gl/core/capabilities`: `trip-heads` vs `tripHeads`, `point-cloud`
 * vs `pointCloud`, `summary` vs `h3Summary`, `quadbin-summary` vs
 * `quadbinSummary`. Four spellings that made every cross-reference between the
 * showcase and a backend descriptor a manual translation. Keeping ONLY the
 * genuinely-local names here means a rename in core is now a `tsc` break in the
 * showcase too, which is the whole point of the frozen vocabulary.
 *
 * Notes the deleted union carried about the core kinds it respelled, kept
 * because they record how to BUILD an archive of that kind:
 *   - `pointCloud` — Phong-lit 3D cloud (`AnimatedPointCloudLayer`), one lit
 *     point per feature animating on/off with the window. Build with
 *     `stt-build --point-elevation-column z` (true 3D geometry) and
 *     `--vector-group point_rgba=r,g,b,a:u8` (per-point colour bound zero-copy,
 *     which takes precedence over `color`/`colorMapping`).
 *   - `tripHeads` — one interpolated dot at the head of each active trip
 *     (`AnimatedTripHeadsLayer`, CPU per-frame position on a stock
 *     ScatterplotLayer). Same archive shape as `trips`, no rebuild needed.
 *   - `h3Summary` — server-aggregated H3 summary tier (`H3SummaryLayer`); only
 *     useful for archives built with `stt-build --summary-tier h3`.
 *   - `quadbinSummary` — the square-cell (CARTO Quadbin) analog
 *     (`QuadbinSummaryLayer`), from `stt-build --summary-tier quadbin`.
 *   - `arc` — origin→destination flow arcs (`AnimatedArcLayer`); each feature
 *     is a 2-vertex LineString (first vertex = source, last = target). Build
 *     with `stt-generate nyc-rideshare --od`.
 *   - `column` — extruded 3D columns at point features (`AnimatedColumnLayer`),
 *     height from a numeric `elevationProperty`. Reuses any point archive.
 */
export const SHOWCASE_LOCAL_TYPES = [
  'lightning',
  'flowmap-bundled',
  'radar',
  'av',
  'weather',
  'storm4d',
  'worlds',
] as const;

/** A composition/variant the showcase owns; see {@link SHOWCASE_LOCAL_TYPES}. */
export type ShowcaseLocalType = (typeof SHOWCASE_LOCAL_TYPES)[number];

/**
 * What a demo card's `type` may be: a core cross-backend {@link LayerKind}, or
 * one of the showcase's own compositions. `test/dataset-types.test.ts` fails if
 * a shipped dataset is neither.
 */
export type DatasetType = LayerKind | ShowcaseLocalType;

/**
 * The core {@link LayerKind}s each showcase-local type MOUNTS. This is the
 * translation the three backend gates need: a backend descriptor speaks
 * `LayerKind`, so `radar` is renderable exactly when the backend renders
 * polygons, points and trips. Every entry is the honest stack the corresponding
 * `buildDemoLayers` / `buildSttLayers` case actually builds — an omission here
 * makes a backend look MORE capable than it is, so it is the one table worth
 * reading against the code when a composite changes.
 */
export const COMPOSITE_LAYER_KINDS = {
  /**
   * GLM lightning from ONE flash-point archive, drawn as TWO stacked layers: a
   * live strike-DENSITY field (`AnimatedHeatmapLayer`) as the glowing backdrop,
   * plus individual FLASHES (`AnimatedPointLayer`) on top, each appearing bright
   * then fading + shrinking over `wakeLength` sim-ms so instantaneous strikes
   * read as a shimmering flicker on the compressed clock. Build the archive with
   * `python glm_lightning.py` (GOES-16 GLM L2 LCFA).
   */
  lightning: ['heatmap', 'point'],
  /**
   * GPU force-directed edge-bundled flowmap (`BundledFlowmapLayer`). Same OD
   * `vertexValueMatrix` tiles as the core `flowmap` kind, but compatible flows
   * are relaxed into smooth bundled rivers on the GPU (Holten FDEB, cosmos.gl-
   * style ping-pong textures). A drop-in superset of `flowmap` honoring the same
   * `flow*` props — which is why it maps to the `flowmap` kind and NOT to a kind
   * of its own: bundling is the `liveBundling` CAPABILITY, and a backend without
   * it (maplibre) draws the straight flowmap instead of refusing the demo.
   */
  'flowmap-bundled': ['flowmap'],
  /**
   * Composite storm-radar render (NEXRAD). Overlays THREE STT archives from one
   * dataset entry: filled reflectivity contour bands (`AnimatedPolygonLayer`,
   * categorical `dbz_band`) as the animated precipitation field — the dataset's
   * primary `url`; storm-cell centroids (`AnimatedPointLayer`) from
   * `radarCellsUrl`; and animated cell tracks (`AnimatedTripsLayer`, per-vertex
   * intensity) from `radarTracksUrl`. Build with `stt-generate storms`.
   */
  radar: ['polygon', 'point', 'trips'],
  /**
   * Composite AV-telemetry "cockpit" render (streetscape.gl / avs.auto style).
   * Overlays up to THREE STT archives from one AV scene bundle: an accumulated
   * LIDAR point cloud (`AnimatedPointLayer`, categorical `height_band` fill) as
   * the dataset's primary `url`; the ego trajectory (`AnimatedTripsLayer`) from
   * `avEgoUrl`; and tracked-object 3D boxes (`AnimatedBoundingBoxLayer`,
   * categorical `category`) from `avObjectsUrl`. The bespoke `/drive/:sceneId`
   * cockpit additionally reads `avSceneUrl` (the `scene.json` manifest) plus the
   * `avTelemetryUrl` / `avCamerasUrl` sidecars for chrome, gauges, and the camera
   * inset. Built by the `av_synthetic.py` / `nuscenes_extract.py` adapters.
   *
   * `pointCloud` is listed even though the deck path draws the cloud with
   * `AnimatedPointLayer`: the three backend has a real lit-cloud requirement
   * here (`AvThreeViewer`), and declaring the weaker `point` would advertise the
   * cockpit on backends that cannot carry it.
   */
  av: ['pointCloud', 'trips', 'boundingBox'],
  /**
   * Composite WEATHER-SUITE render on one playhead. Stacks (bottom→top): HRRR
   * wind streamlines (`AnimatedTripsLayer`, from `windUrl`); the MRMS precip
   * FIELD (`AnimatedPolygonLayer`, categorical `dbz_band`) — the primary `url`
   * and REQUIRED governor source; WPC surface fronts in classic notation
   * (`AnimatedPathLayer` lines from `frontsUrl` + `AnimatedPolygonLayer`
   * triangle/semicircle pips from `frontsPipsUrl`); precip cell tracks +
   * centroids (from `radarTracksUrl`/`radarCellsUrl`); and GLM lightning as a
   * density field + flashes (from `lightningUrl`). Built by glm_lightning.py +
   * mrms_weather.py + hrrr_advect.py + wpc_fronts.py.
   */
  weather: ['polygon', 'trips', 'path', 'point', 'heatmap'],
  /**
   * Composite STORM-4D render — one supercell as a true 4D object on one
   * playhead (the depth-first sibling of the continental `weather` suite).
   * Stacks (bottom→top): county power outages extruded by `customers_out`
   * (`AnimatedPolygonLayer`, from `outagesUrl`); the GOES C13 cloud-top "anvil
   * canopy" isobands lifted to their brightness-temperature height (from
   * `cloudTopUrl`); multi-level HRRR wind trips at `level_alt_m` (from
   * `wind3dUrl`); the NEXRAD Level II gate VOLUME as a 3D billboard point
   * cloud stacked by beam altitude (`AnimatedPointLayer`, `use3D` +
   * `elevationProperty: 'alt_m'`) — the primary `url` and REQUIRED governor
   * source, toggling between reflectivity (`dbz_band`) and dealiased radial
   * velocity (`vel_band`) render modes via `summaryToggleWeights`; VTEC
   * warning polygons extruded as translucent wireframe prisms (from
   * `warningsUrl`); mesocyclone couplet markers (from `coupletUrl`); ASOS
   * surface stations (from `stationsUrl`); local storm reports arriving
   * behind the storm (from `reportsUrl`); GLM lightning at ground (reused
   * `lightningUrl`); and the radiosonde ascent trail (from `soundingUrl`).
   * Built by nexrad_volume.py + the storm4d fetch scripts.
   */
  storm4d: ['polygon', 'point', 'trips', 'path', 'heatmap'],
  /**
   * WORLD-MODEL SCENARIO GALLERY (`/worlds`) — hundreds of short driving
   * scenarios laid out side by side on a synthetic grid, every one animating
   * at once on a single shared looping clock. FOUR cross-scenario archives:
   * the ego trips (`avEgoUrl`, the primary `url` + the one REQUIRED governor
   * source), the oriented agent boxes (`avObjectsUrl`, mounted only when the
   * camera is close enough to read them), and the HD-map line/polygon
   * substrate (`avMapLineUrl` / `avMapPolyUrl`, timeless full-range archives).
   * A `worldsUrl` sidecar carries the per-scenario index (grid origin, caption,
   * agent counts, generated-video paths, hero LiDAR manifest); heroes stream
   * their own LiDAR archive when selected. Rendered by the bespoke `/worlds`
   * page (never by `DemoViewer`), which is why this type has no
   * `buildDemoLayers` case. Built by `cosmos_drive_dreams.py`.
   */
  worlds: ['trips', 'boundingBox', 'path', 'polygon'],
} as const satisfies Record<ShowcaseLocalType, readonly LayerKind[]>;

/**
 * The core {@link LayerKind}s a backend must support to render `type`. A core
 * kind needs itself; a showcase-local type needs its whole composite stack.
 * Feed this to a published `BackendDescriptor` (see `lib/backendSupport.ts`)
 * instead of hand-listing what each backend can draw.
 */
export function datasetTypeKinds(type: DatasetType): readonly LayerKind[] {
  return type in COMPOSITE_LAYER_KINDS
    ? COMPOSITE_LAYER_KINDS[type as ShowcaseLocalType]
    : [type as LayerKind];
}

export interface DatasetLegendItem {
  color: string;
  label: string;
}

/** A color ramp shown as a horizontal gradient strip with a low/high label. */
export interface DatasetLegendRamp {
  label: string;
  /** CSS color stops, low→high. */
  colors: string[];
}

export interface DatasetLegend {
  title: string;
  items?: DatasetLegendItem[];
  /** Optional ramps; if set, the legend renders gradient strips alongside items. */
  ramps?: DatasetLegendRamp[];
}

/** RGBA color, 0-255 per channel. Matches deck.gl's Color type. */
export type ColorRGBA = [number, number, number, number];

/**
 * One channel of a stacked heatmap. N specs (max 4) pack into the
 * RGBA channels of the new HeatmapLayer's accumulator FBO — one splat
 * pass + one ramp pass total, regardless of channel count.
 */
export interface HeatmapLayerSpec {
  /** Channel id (used for log/picking + future build-time metadata lookup). */
  id: string;
  /** Color ramp from low density → high density. */
  colorRange: ColorRGBA[];
  /** Optional filter on a categorical property — only matching features count. */
  categoryFilter?: { property: string; values: string[] };
  /** Optional weight property (defaults to 1 per feature). */
  weightProperty?: string;
  /**
   * Optional per-layer radius override (px). When several channels are
   * stacked, only the FIRST channel's `radiusPixels` is honoured — the
   * splat pass runs once for all channels.
   */
  radiusPixels?: number;
  /** Per-channel weight multiplier on top of the global intensity. */
  intensity?: number;
  /**
   * Pinned `[min, max]` accumulator-intensity domain. Setting this skips
   * any runtime auto-detect (zero GPU readback). Defaults to [0, 1].
   */
  colorDomain?: [number, number];
}

/**
 * What EVERY demo card carries, whatever it renders: identity, the clock, the
 * camera, the basemap treatment, and the tile-loading knobs the viewer applies
 * before it knows the layer type.
 *
 * A field belongs here only when it is meaningful for every family. Anything a
 * single family reads lives on that family's variant, so the compiler rejects
 * `lidarSurfelTemporalSigma` on a seismicity dataset. Anything a HANDFUL of
 * families share lives on a styling mixin below.
 */
interface BaseDataset {
  id: string;
  name: string;
  description: string;
  url: string;
  /**
   * Data-source attribution keys (see SOURCE_REGISTRY in components/SourceLogo).
   * Rendered as small source badges on the demo cards.
   */
  sources?: string[];
  /**
   * Tile-tier dispatch for archives built with `--summary-tier`. `'auto'`
   * (default) swaps to the H3 summary overview at low zoom; `'raw'` always
   * uses raw features (use this when the summary overlay would obscure the
   * point-level story, e.g. the cumulative "draws itself" demo); `'summary'`
   * always uses the aggregated tier. No effect on archives without a summary tier.
   */
  tier?: 'auto' | 'summary' | 'raw';
  timeRange: {
    start: number;
    end: number;
  };
  timeWindow: number;
  /**
   * Widen the tile-SELECTION window without widening the render window. Needed by
   * baked frame-sequence archives, whose `timeWindow` is one frame long: the
   * tileset refreshes its visible set at most every 100 ms of wall clock, so a
   * one-frame selection is already stale by the next refresh and the layer draws
   * nothing. A few hundred ms keeps several buckets resident; the render window
   * still shows exactly one frame, because features are filtered individually.
   */
  tileLoadTimeWindow?: number;
  /** Target duration in seconds for one complete playthrough at 1x speed (default: 30) */
  targetPlaybackSeconds?: number;
  /**
   * When true (DEFAULT), composite overlay archives register as REQUIRED
   * governor sources, so the shared clock waits for them (MSE-intersection
   * semantics). Set false for decorative overlays that should
   * continue-and-degrade (text-track semantics) — they then render empty when
   * their data lags the clock.
   */
  overlayGatesPlayback?: boolean;
  initialViewState: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
    /**
     * Optional MapState pitch constraint carried in the view state (deck's
     * MapController honors it there). DemoViewer spreads `initialViewState`
     * straight into the deck view state, so setting this raises the 60°
     * default the same way the space-time-cube `timeHeight.maxPitch` path
     * does — used by the storm4d volumetric demo (pitch 55, maxPitch 85).
     */
    maxPitch?: number;
  };
  legend?: DatasetLegend;

  /** Enable 3D visualization with altitude/elevation */
  use3D?: boolean;

  /** Use GlobeView instead of Mercator projection (for global satellite data) */
  useGlobe?: boolean;

  /** Slowly auto-rotate the globe (only applies when `useGlobe` is true). */
  autoRotate?: boolean;

  /**
   * Fill color of the globe's earth sphere (only applies when `useGlobe`).
   * Defaults to a dark sphere; set a light tone to match the paper landing page.
   */
  globeBackgroundColor?: ColorRGBA;

  // ─── Basemap overrides (Mercator viewer only) ──────────────────────────
  /**
   * Override the Mapbox basemap style URL for this demo. Defaults to
   * `mapbox://styles/mapbox/dark-v11`. Use to give a demo a different backdrop
   * without touching the others.
   */
  basemapStyle?: string;
  /**
   * Drop the basemap entirely and render the data over a flat backdrop
   * (`backdropColor`). For scenes that are geographically anchored but not
   * geographically *readable* — a 140 m ship in open water sits inside a single
   * z14 tile, so the basemap contributes nothing but empty ocean. The AV cockpit
   * has the same idea in `avLocalFrame`; this is it for the ordinary DemoViewer
   * path.
   */
  hideBasemap?: boolean;
  /**
   * CSS `background` value behind the deck canvas when `hideBasemap` is set.
   * Any valid `background` — a flat colour, or a layered gradient painting a sky
   * (the ship demo uses a storm-sky gradient in place of a flat void).
   */
  backdropColor?: string;
  /**
   * Hide every label on the basemap (place titles, road/POI text) by switching
   * all `symbol` layers to `visibility: none` on map load. Keeps roads, water,
   * and land geometry — just removes the text. Lets the data own the frame.
   */
  basemapHideLabels?: boolean;
  /**
   * Darken the basemap to a near-black backdrop by repainting the base
   * `background` (and land) fill to this CSS color, while roads/water still
   * render on top for context. Pairs with `basemapHideLabels` for a "darkest
   * possible, no labels, still-legible streets" look. e.g. `'#02040a'`.
   */
  basemapBackgroundColor?: string;
  /**
   * Repaint the basemap's road/street `line` layers (`road-*`, `bridge-*`,
   * `tunnel-*`) to this CSS color, so the street network sinks toward the
   * backdrop instead of rendering at Mapbox's default grey. Pairs with
   * `basemapBackgroundColor`: set this a touch lighter than the land fill to
   * keep streets as faint context, or match the land to hide them entirely.
   * Type-based (not layer-id) so it survives Mapbox style revisions. e.g.
   * `'#0a0d14'`.
   */
  basemapRoadColor?: string;
  /**
   * Render the basemap with 3D terrain (Mapbox `raster-dem`) under this demo,
   * and put the demo on the INTERLEAVED render path: deck draws inside the
   * map's own frame (`MapboxOverlay`), sharing its terrain-aware camera and
   * depth buffer, so data with real z sits exactly ON the relief and is
   * occluded behind ridges. Layers that support a terrain probe (currently
   * `tripHeads`) additionally drape their moving dots onto the surface via
   * per-frame `queryTerrainElevation` sampling.
   *
   * Distinct from `use3D`, which keeps the classic deck-over-map compositing
   * (no occlusion, camera diverges over high relief when pitched) and doubles
   * as "lift data by its elevation column" — that path suits data flying WELL
   * ABOVE terrain (flights); this one suits data ON the terrain.
   *
   * `true` = default 1.5× exaggeration; pass `{ exaggeration }` to pin it.
   * Mercator viewer only (ignored on the globe / maplibre / three paths).
   */
  basemapTerrain?: boolean | { exaggeration?: number };

  /** Property name containing elevation data (e.g., 'altitude', 'elevation') */
  elevationProperty?: string;

  /** Scale factor for elevation values (e.g., for unit conversion) */
  elevationScale?: number;

  /**
   * The archive's per-vertex `vertexValues` channel is BAKED elevation in
   * metres (built with `stt-generate gtfs --bake-elevation`): trip-head dots
   * are lifted by the value interpolated at their live position ×
   * `elevationScale`. Set `elevationScale` to the `basemapTerrain`
   * exaggeration so data and relief agree. When set, the viewer does NOT
   * build the runtime `queryTerrainElevation` drape probe — baked wins.
   */
  elevationFromVertexValues?: boolean;

  /**
   * Vertical extent of the RENDERED scene, `[minMetres, maxMetres]` above the
   * ellipsoid — forwarded to the layer's `zRange`, which unions the camera's
   * ground-plane footprint with its footprint at the top of the content when
   * selecting tiles.
   *
   * Only volumetric demos need it, and only because tile selection is a
   * ground-plane operation: geometry drawn at altitude projects into a pitched
   * frame from tiles whose ground footprint is outside the visible box, so
   * without it the near edge of the frame silently loses its highest data.
   * Post-`elevationScale` metres (the value goes to `viewport.getBounds({z})`
   * in common space), so a 19 km column at `elevationScale: 15` is 285000.
   *
   * Unset ⇒ the composite's own default for that demo family, or the ground
   * plane alone. NOT derived automatically: an over-large slab reports a
   * near-global box and selects accordingly, so a wrong guess is not
   * conservative (see the layer prop's docs).
   */
  zRange?: [number, number];

  /** Property name for categorical coloring (passed to layers as colorProperty) */
  colorProperty?: string;

  /**
   * Stable category-string → RGBA mapping for `colorProperty`. When set, the
   * layer colors each feature by looking up its category string in this
   * mapping — required for cross-tile consistency, since the default palette
   * fallback assigns palette indices in first-seen order per tile.
   */
  colorMapping?: Record<string, ColorRGBA>;

  /** Fallback color for categories absent from colorMapping. */
  colorMappingDefault?: ColorRGBA;

  /**
   * Fade-in duration in SIM milliseconds for appearing features. On a point
   * dataset in `cumulative` mode this is the "ink appearing" ramp applied as
   * each point is revealed. On the polygon-field composites (`radar`,
   * `weather`, `storm4d`) the pair instead tunes the field's cross-dissolve:
   * each discrete scan's isobands ramp in/out as the window slides over them
   * instead of popping at frame boundaries.
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration in SIM milliseconds for disappearing features. Both fades
   * default to 300 sim-ms in the layers; a dataset whose `timeWindow` is only a
   * frame or two wide (e.g. `pointCloud` playback at 30 fps) must zero them,
   * or every feature stays lit long past its window and the frames smear
   * together.
   */
  fadeOutDuration?: number;

  /**
   * Layer opacity (0-1). Defaults to 0.8. Lower values let dense, overlapping
   * geometry (e.g. thousands of satellite trails) read as a density glow
   * instead of saturating into a solid block.
   */
  opacity?: number;

  /** Force a specific zoom for tile selection (used by globe-style demos). */
  zoomOverride?: number;

  /** Load tiles for the entire planet, ignoring the current viewport bounds. */
  useGlobalBounds?: boolean;

  // ─── space-time cube (time = height) ───────────────────────────────────
  /**
   * Render the dataset as a Hägerstrand space-time cube: time maps to
   * altitude, so trail-mode trips become 3D threads climbing through the
   * cube (slope = speed) and points become temporal strata. DemoPage adds a
   * "squash" slider that morphs between the flat map (0) and the full cube
   * (1) — a single shader uniform, free to animate. MapView demos only.
   */
  timeHeight?: {
    /** Cube height in meters for the full timeRange at squash factor 1. */
    rangeHeightMeters: number;
    /** Initial squash factor, 0..1. Defaults to 1 (full cube). */
    initialFactor?: number;
    /** Draw a translucent "now" plane rising with the playhead. Default true. */
    nowPlane?: boolean;
    /**
     * Draw the STT tile lattice: each loaded tile rendered as a wireframe
     * box (spatial footprint × temporal bucket) — the format made visible.
     * Default true.
     */
    tileLattice?: boolean;
    /** Camera pitch limit (MapView defaults to 60; cubes want more). */
    maxPitch?: number;
  };
}

// ─── styling mixins ──────────────────────────────────────────────────────
// Each mixin is the prop set ONE deck layer honors. A composite variant
// extends every mixin whose layer it actually mounts, so `radiusScale` is
// legal on the storm-4D volume (it draws points) and illegal on a flowmap.

/** Props {@link AnimatedPointLayer} honors — the round-marker family. */
interface PointStyling {
  /** Property name for radius/size (passed to layers as radiusProperty) */
  radiusProperty?: string;

  /**
   * Fixed radius for all features when no `radiusProperty` is set. Interpreted
   * in `radiusUnits` (meters by default in DemoPage). Falls back to 1000 m.
   */
  radius?: number;

  /** Units for the `radius` prop — defaults to 'pixels' in DemoPage. */
  radiusUnits?: 'pixels' | 'meters' | 'common';

  /** Multiplier applied to per-feature radius values. */
  radiusScale?: number;

  /** Clamp radius to at least this many on-screen pixels. */
  radiusMinPixels?: number;

  /** Clamp radius to at most this many on-screen pixels. */
  radiusMaxPixels?: number;

  /**
   * Non-linear transform applied to each feature's `radiusProperty` value.
   * Useful when the property is a log-scale quantity (e.g. earthquake
   * magnitude) and a linear pixel mapping is uninformative.
   */
  radiusTransform?: (value: number) => number;

  /**
   * Wake length in milliseconds. When > 0, each point is drawn behind the play
   * head as a fading + shrinking "ship wake". The caller's `timeWindow` should
   * be `>= 2 × wakeLength` so the tile loader still covers the past portion of
   * the wake.
   */
  wakeLength?: number;

  /** Tail-edge size multiplier for wake mode (0..1). Defaults to 0.15. */
  wakeTailScale?: number;

  /** Render a stroke around each point. */
  stroked?: boolean;

  /** Stroke color (constant). */
  strokeColor?: ColorRGBA;

  /** Stroke width clamp in pixels. */
  lineWidthMinPixels?: number;
}

/** The width scale + clamps every line-geometry layer honors, arcs included. */
interface LineWidthStyling {
  /** Units for `pathWidth` / `tripWidth` / `arcWidth`. */
  widthUnits?: 'pixels' | 'meters';
  /** Clamp line width to at least this many on-screen pixels. */
  widthMinPixels?: number;
  /** Clamp line width to at most this many on-screen pixels. */
  widthMaxPixels?: number;
}

/** Width + join treatment shared by the polyline layers (paths and trips). */
interface LineStyling extends LineWidthStyling {
  /** Rounded line caps; disable for ~2× faster fragment shading at small widths. */
  capRounded?: boolean;
  /** Rounded line joints; same perf tradeoff as `capRounded`. */
  jointRounded?: boolean;
}

/** Props {@link AnimatedTripsLayer} honors on top of {@link LineStyling}. */
interface TripStyling extends LineStyling {
  /** Constant trip color, RGBA 0-255. */
  tripColor?: ColorRGBA;
  /**
   * Color each trip *along its length* by a per-vertex scalar carried in the
   * tile (the `vertex_value` channel, e.g. sea-surface temperature). `property`
   * names the BinaryFeatures channel (currently only `'vertexValues'`),
   * `domain` is the `[min, max]` mapped onto `colors` (low→high RGBA stops).
   * Takes precedence over `colorProperty` / `tripColor`.
   */
  tripGradient?: {
    property: string;
    domain: [number, number];
    colors: ColorRGBA[];
  };
  /** Trip line width — number (in widthUnits) or numeric property name. */
  tripWidth?: number | string;
  /**
   * Trail duration in ms — how long the trailing path remains visible behind
   * the play head. The tile loader auto-widens its window to `2 × trailLength`
   * if `timeWindow` is shorter; setting `timeWindow` smaller than that has no
   * effect.
   */
  trailLength?: number;
  /** Fade the trail's tail to transparent (vs. hard cut at trailLength). */
  fadeTrail?: boolean;
}

/** Props {@link AnimatedPathLayer} honors on top of {@link LineStyling}. */
interface PathStyling extends LineStyling {
  /** Constant path color (or fall back to `colorProperty` if categorical). */
  pathColor?: ColorRGBA;
  /** Path line width — number (in widthUnits) or numeric property name. */
  pathWidth?: number | string;
}

/** Props {@link AnimatedPolygonLayer} honors. */
interface PolygonStyling {
  /** Fill polygons (default true). */
  polygonFilled?: boolean;
  /** Polygon fill color — constant RGBA or `colorProperty` for categorical fill. */
  polygonFillColor?: ColorRGBA;
}

/**
 * Props {@link AnimatedTripHeadsLayer} honors — a smooth moving dot at the head
 * of each active trip (CPU-interpolated position on a stock ScatterplotLayer).
 */
interface TripHeadStyling {
  /** Head-dot color, RGBA 0-255. */
  headColor?: ColorRGBA;
  /** Head-dot radius in pixels (used when `headSizeUnits` is 'pixels'). */
  headRadiusPixels?: number;
  /**
   * Units for the head radius. 'pixels' (default) is screen-space; 'meters'
   * makes the dot world-space (emerges on zoom) like the maritime point layer,
   * using `headRadius` and clamped by the *MinPixels/*MaxPixels bounds.
   */
  headSizeUnits?: 'pixels' | 'meters';
  /** Head radius in METRES when `headSizeUnits === 'meters'`. */
  headRadius?: number;
  /** Min on-screen head radius in pixels (meters-mode clamp). */
  headRadiusMinPixels?: number;
  /** Max on-screen head radius in pixels (meters-mode clamp). */
  headRadiusMaxPixels?: number;
}

/** GPU range-filter on a numeric column (deck's DataFilterExtension). */
interface DataFilterStyling {
  /**
   * Numeric column to range-filter features by. Composes WITH the time filter —
   * a feature shows only when BOTH its time window and its filter range admit
   * it. Names an existing numeric column (e.g. `'magnitude'`); a categorical
   * column warns and is ignored. No effect unless set.
   */
  filterProperty?: string;
  /**
   * Inclusive `[min, max]` bounds for {@link DataFilterStyling.filterProperty}.
   * Only meaningful when `filterProperty` is set. A future in-map slider would
   * drive this live; a static value renders a fixed band.
   */
  filterRange?: [number, number];
}

/**
 * The storm-cell overlay pair shared by the `radar` and `weather` composites:
 * both draw the same STORMCELL centroids + tracks over their precip field, from
 * the same generator.
 */
interface StormCellOverlay {
  /**
   * Storm-cell CENTROID points manifest (sized/colored by `max_dbz`). The
   * dataset's primary `url` is the reflectivity FIELD manifest; this and
   * `radarTracksUrl` are the two overlay tilesets. Rewritten through
   * `resolveDataUrl` alongside `url` so an R2 deploy resolves all three.
   */
  radarCellsUrl?: string;
  /** Storm-cell TRACK linestrings manifest (per-vertex intensity trail). */
  radarTracksUrl?: string;
  /** Solid fill for storm-cell centroids. Defaults to near-white. */
  radarCellColor?: ColorRGBA;
}

/**
 * The AV scene archives + palettes shared by the single-scene cockpit (`av`)
 * and the multi-scenario gallery (`worlds`): both mount an ego trajectory,
 * tracked-object boxes, and the HD-map substrate from one bundle layout.
 * Every url is rewritten through `resolveDataUrl` alongside `url`.
 */
interface AvSceneStreams {
  /**
   * Ego-trajectory archive manifest (an STT TRIPS archive — one LineString =
   * the ego path). Rendered by `AnimatedTripsLayer`. On LIDAR scenes the
   * primary `url` is the LIDAR archive; on LIDAR-less scenes (comma.ai) this IS
   * the primary `url`, so the governor rides it.
   */
  avEgoUrl?: string;
  /**
   * Tracked-object archive manifest (an STT POINT archive — one point per
   * object per annotated sample, carrying `category`/`heading`/box dims).
   * Rendered by `AnimatedBoundingBoxLayer`.
   */
  avObjectsUrl?: string;
  /**
   * HD-map vector streams: drivable-area / lane / crosswalk POLYGONS
   * (`avMapPolyUrl`) and lane-divider / boundary LINES (`avMapLineUrl`), each an
   * STT archive whose features carry a categorical `map_layer` string. Rendered
   * UNDER the LIDAR as the scene substrate (the streetscape.gl "real road" cue).
   */
  avMapPolyUrl?: string;
  avMapLineUrl?: string;
  /** `map_layer` (categorical) → RGBA for both map streams (fills low-alpha, lines crisp). */
  mapColors?: Record<string, ColorRGBA>;
  /**
   * Tracked-object category → RGBA color. Also present in `scene.json`; the
   * Dataset copy keeps `buildDemoLayers` self-contained (so the standard
   * `DemoPage` render colors object boxes without fetching the manifest).
   */
  avObjectColors?: Record<string, ColorRGBA>;
  /**
   * LIDAR `height_band` (categorical) → RGBA color ramp. Drives the LIDAR
   * point cloud's `colorMapping`. ~8 bands across the height domain.
   */
  lidarColorMapping?: Record<string, ColorRGBA>;
  /** Fallback color for `height_band` values absent from `lidarColorMapping`. */
  lidarColorMappingDefault?: ColorRGBA;
  /**
   * The scene rides an APPROXIMATE/anchored local frame, not a real geo-registered
   * one (e.g. Waymo: the Open Dataset discloses no lat/lon, so the scene is anchored
   * at a plausible metro point — the metro is right, the streets are not). When
   * true, the cockpit drops the street basemap (renders the cloud on a plain dark
   * background) so the real road network can't visibly contradict the anchor.
   * Georeferenced sources (nuScenes / Argoverse) leave this unset → street basemap.
   */
  avLocalFrame?: boolean;
}

// ─── the families ────────────────────────────────────────────────────────

/** Round markers, one per feature (`AnimatedPointLayer`). */
export interface PointDataset
  extends BaseDataset, PointStyling, DataFilterStyling {
  type: 'point';
  /**
   * Cumulative "draw and persist" mode. When true, each point appears at its
   * start time and stays visible for the rest of playback — the dataset "draws
   * itself" (e.g. OSM node creations inking a city in). DemoPage widens the tile
   * loader's window to keep revealed tiles resident; the GPU does the
   * progressive reveal. Pair with `fadeInDuration` for an "ink appearing" ramp.
   */
  cumulative?: boolean;
  // ─── motion glide ──────────────────────────────────────────────────────
  /**
   * Smooth CPU motion interpolation. When true (and the user has NOT asked for
   * reduced motion, and {@link PointDataset.idProperty} resolves), the layer
   * pools loaded samples by entity id and glides ONE marker per active entity
   * between the two samples bracketing the play head, instead of popping a fresh
   * instance per ping. Mutually exclusive with `wakeLength` / `cumulative` (the
   * layer keeps its GPU window path when either is set). `buildDemoLayers` folds
   * the reduced-motion flag into the concrete boolean it forwards, so
   * reduced-motion viewers get the discrete (non-glide) path.
   */
  interpolate?: boolean;
  /**
   * Categorical id column that identifies one moving entity across pings — the
   * key the glide path pools samples by (e.g. `'icao24'` for aircraft). Has no
   * effect unless {@link PointDataset.interpolate} is on. Must be a column that
   * already exists in the archive (no rebuild).
   */
  idProperty?: string;
  /**
   * Max gap (ms) between two consecutive samples of the same entity that the
   * glide will interpolate across. A larger gap is a data hole (e.g. an ADS-B
   * coverage dropout), so the marker HOLDS its last known position instead of
   * gliding a fabricated straight line the entity never travelled. No effect
   * unless {@link PointDataset.interpolate} is on. Omit to inherit the layer
   * default (`Infinity` = always interpolate — only safe for gap-free feeds).
   */
  maxInterpolationGap?: number;
}

/**
 * Phong-lit 3D cloud (`AnimatedPointCloudLayer`), one lit point per feature
 * animating on/off with the window. Build with `stt-build --point-elevation-column z`
 * (true 3D geometry) and `--vector-group point_rgba=r,g,b,a:u8` (per-point colour
 * bound zero-copy, which takes precedence over `color`/`colorMapping`).
 */
export interface PointCloudDataset extends BaseDataset {
  type: 'pointCloud';
  /** Radius of every point in `pointSizeUnits`. Defaults to the layer's 10. */
  pointSize?: number;
  /** Units for `pointSize`. Defaults to the layer's `'pixels'`. */
  pointSizeUnits?: 'meters' | 'pixels' | 'common';
  /**
   * Phong lighting for the lit points: `true` for the default material, `false`
   * to render them unlit. An archive that bakes its own shaded colours into
   * `point_rgba` usually wants `false`, so lighting isn't applied twice.
   */
  pointMaterial?: boolean;
}

/** Static polylines revealed by the play head (`AnimatedPathLayer`). */
export interface PathDataset extends BaseDataset, PathStyling {
  type: 'path';
}

/** Trailing trip threads (`AnimatedTripsLayer`) and the flow-corridor variants. */
export interface TripsDataset
  extends BaseDataset, TripStyling, TripHeadStyling {
  type: 'trips';
  /**
   * Composite overlay: the manifest URL of a SECOND (per-trip, OSRM-routed)
   * archive rendered ON TOP of the flow corridors below, both on the one
   * playhead. The corridor archive stays the primary governor source; the
   * overlay ALSO gates the clock unless {@link BaseDataset.overlayGatesPlayback}
   * is set false.
   *
   * Draws as moving head-DOTS (AnimatedTripHeadsLayer, styled by the `head*`
   * fields) by default, or as fading TRAILS when {@link overlayTrail} is set.
   */
  headsOverlayUrl?: string;
  /**
   * Draw the {@link headsOverlayUrl} archive as fading TRAILS
   * (AnimatedTripsLayer) instead of head dots. Presence IS the switch; the
   * fields configure the trail, since the top-level `trip*`/`width*` ones
   * belong to the PRIMARY corridor layer and a composite needs both styled
   * independently.
   *
   * A trail reads the route a vehicle just took, where a dot reads only where
   * it is — on a corridor base that already encodes aggregate volume, the
   * per-trip PATH is the part the corridors can't show.
   *
   * `trailLength` is in sim-ms and must fit the overlay's loader window: the
   * tileset covers `[t − window/2, t + window/2]`, so a trail longer than half
   * {@link headsOverlayTimeWindow} runs off the back of the resident tiles and
   * truncates. (`AnimatedTripsLayer.getEffectiveTimeWindow` widens the window to
   * `2 × trailLength` rather than let that happen — which is exactly the
   * residency blow-up that field's docstring warns about, so size the two
   * together instead of relying on the widen.)
   */
  overlayTrail?: {
    /** Trail color (RGBA 0-255). @default the `headColor` fallback */
    color?: ColorRGBA;
    /** Trail width, in {@link overlayTrail.widthUnits}. */
    width?: number;
    /** @default 'meters' — trails thicken on zoom like the head dots do. */
    widthUnits?: 'pixels' | 'meters';
    widthMinPixels?: number;
    widthMaxPixels?: number;
    /** Trail span in sim-ms — how far back down the route the tail reaches. */
    trailLength: number;
    /** Alpha-fade head→tail (`true`) or a solid snake (`false`). @default true */
    fadeTrail?: boolean;
    capRounded?: boolean;
    jointRounded?: boolean;
  };
  /**
   * Loader window (ms) for the {@link headsOverlayUrl} archive, overriding the
   * primary's `timeWindow` on the overlay tileset ONLY.
   *
   * It exists because the two archives in a composite can have wildly different
   * temporal bucket sizes, and `timeWindow` is authored for the PRIMARY. The
   * overlay's window has no visual meaning — AnimatedTripHeadsLayer draws a dot
   * for every trip active at the playhead and never consults `timeWindow` — so
   * it is purely a residency knob, and an over-wide one is expensive twice over:
   *
   *   • residency = (window / overlayBucketMs) × viewport tiles, and only the
   *     playhead's own bucket can ever draw (stt-build slices every clipped
   *     trajectory segment to lie inside ONE bucket, so a bucket is
   *     self-contained — see clip.rs "Slice a clipped segment at temporal
   *     bucket boundaries");
   *   • the governor's buffered-runway horizon is `4 × timeWindow`, and every
   *     tile inside it must be RESIDENT for the runway to complete. Past the
   *     tile-cache cap that is unsatisfiable, so the tileset evicts tiles it
   *     still needs and re-fetches them forever.
   *
   * On nyc-flow-and-riders (1-hour primary window over a 1-MINUTE overlay
   * bucket) that combination measured 854 resident overlay tiles to draw 14
   * tiles' worth of dots, 5.7k tile + 3.3k pack-blob evictions per 8 s, and
   * 43 MB/s of re-fetch. Size this at a few overlay buckets: enough to cover
   * the bucket the playhead is in plus the 100 ms tileset-refresh throttle
   * (`speed × 100 ms` of sim-time), no more.
   *
   * @default unset (follow the primary `timeWindow`)
   */
  headsOverlayTimeWindow?: number;
  /**
   * Render with {@link FlowCorridorLayer} instead of {@link AnimatedTripsLayer}.
   * Use for static-geometry *overview* archives (flow corridors) whose tiles
   * carry a per-vertex × per-time-bucket value matrix: the corridor geometry
   * loads ONCE and the renderer animates the `tripGradient` color by selecting
   * the active bucket column from the playhead — no per-timestep geometry
   * re-fetch. Pair with `trailLength: 0` (the matrix drives the animation, not a
   * trailing fade).
   */
  flowMatrix?: boolean;
  /**
   * `flowMatrix`: TRAILING persistence window (ms of data time). Each vertex
   * holds the MAX of its matrix signal over `[t − flowPersistenceMs, t]`
   * instead of the instantaneous bucket blend. The generators bin a trip's
   * whole route into its START bucket, so without this a corridor's highlight
   * fades one bucket after departure while the moving-heads overlay is still
   * riding it — set to the typical trip DURATION so highlight and riders stay
   * in sync. @default 0 (off)
   */
  flowPersistenceMs?: number;
  /**
   * Render with {@link FlowStrokeLayer} (a {@link FlowCorridorLayer} subclass).
   * Like `flowMatrix` the corridor geometry loads once and colour animates by
   * active bucket, but additionally the per-PATH WIDTH breathes with the active
   * hour's traveller count, and a constant perpendicular offset draws opposing
   * directions as twin side-by-side ribbons. For the `bixi-corridors` archive
   * (`bixi --merged-paths`). Implies `flowMatrix` semantics; pair with
   * `trailLength: 0`.
   */
  flowStroke?: boolean;
  /** `flowStroke`: width = (active-bucket peak volume) ** this, before
   * widthScale / widthMin/MaxPixels. 0.5 (√, area-proportional) is the default.
   * (Corridors at/under `flowMinFlow` render at width 0 — the per-hour pulse.) */
  flowWidthExponent?: number;
  /** `flowStroke`: constant twin-ribbon offset, in multiples of the rendered
   * width (0 disables; ~0.6 leaves a small gap). */
  flowOffsetWidths?: number;
  /** Arrow width in px per `sqrt(current-bucket trip count)`. Default 1.1. */
  flowWidthScale?: number;
  /** Hide corridors whose current flow is below this many trips. Default 0.25. */
  flowMinFlow?: number;
  /**
   * Overlay marching directional chevrons on a `flowMatrix` corridor archive
   * built with `bixi --streets --directional` (each corridor's geometry is
   * pre-oriented toward its dominant flow direction). Adds a
   * {@link ChevronFlowExtension} to the {@link FlowCorridorLayer} so arrowheads
   * slide along each segment the way riders actually go, while the value matrix
   * still pulses each corridor's brightness over the day. Requires
   * `flowMatrix: true`.
   */
  flowDirectional?: boolean;
  /** `flowDirectional`: chevron spacing in line-width units. @default 6 */
  chevronPeriod?: number;
  /** `flowDirectional`: march speed (phase width-units per play-head second). @default 0.0006 */
  chevronSpeed?: number;
  /** `flowDirectional`: arrowhead sharpness (along-path shear per half-width). @default 1.4 */
  chevronSkew?: number;
  /** `flowDirectional`: fraction of each period lit by the chevron band, `[0,1]`. @default 0.5 */
  chevronDuty?: number;
  /** `flowDirectional`: alpha of the dim track between chevrons, `[0,1]`. @default 0.15 */
  chevronBaseAlpha?: number;
  /**
   * `flowDirectional`: fit a WHOLE number of chevrons into each path segment so
   * arrows land evenly (~`chevronPeriod` apart) and are never truncated at a
   * vertex/joint — a consistent count per unit of corridor length instead of the
   * raw per-segment spacing that restarts at every bend. Best for STATIC chevrons
   * (`chevronSpeed: 0`). @default false
   */
  chevronUniformSpacing?: boolean;
  /**
   * `flowDirectional`: color the chevron arrowheads by the compass bearing they
   * point, using FOUR cardinal colors (`chevronDirectionColors` = N,E,S,W) blended
   * cyclically around the compass. Bearing is derived on the GPU and flipped per
   * bucket, so a corridor's arrows recolor as its dominant flow reverses.
   * @default false
   */
  chevronDirectionColor?: boolean;
  /** `chevronDirectionColor`: the four cardinal colors `[N,E,S,W]`, each `[r,g,b]` 0–255. @default amber/green/teal/violet */
  chevronDirectionColors?: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  /** `chevronDirectionColor`: bearing offset (deg) of the first color; 45 = intercardinals (NE/SE/SW/NW). @default 0 */
  chevronDirectionOffset?: number;
  /**
   * `flowDirectional` + `flowMatrix`: TWO-SIGNAL per-trip effect. FlowCorridorLayer
   * derives an AGGREGATE (rolling-window volume → dim track color) and an INSTANT
   * per-trip flow (→ the color alpha); the chevron arrowheads flash their cardinal
   * hue as individual trips pass. Needs a FINE (≈1-min) `bixi-live-flow` matrix to
   * resolve individual trips. @default false
   */
  chevronPerTripLight?: boolean;
  /** `chevronPerTripLight`: arrowhead brightness BETWEEN trip flashes `[0,1]`. @default 0.22 */
  chevronPerTripFloor?: number;
  /** `chevronPerTripLight`: AGGREGATE rolling-window HALF-span, ms of data time. @default 240000 (±4 min) */
  chevronAggregateWindowMs?: number;
  /** `chevronPerTripLight`: INSTANT normalization top (trailing-sum that reads as a full flash). @default 1.5 */
  chevronInstantDomain?: number;
  /** `chevronPerTripLight`: INSTANT trailing-decay time constant, ms of data time. @default 120000 (2 min) */
  chevronInstantDecayMs?: number;
  /**
   * `flowDirectional`: force the chevron per-vertex direction morph OFF while
   * keeping `flowSignedDirection` on (so the layer still colours by `|value|`).
   * The arrows stay STATIC — no shape morph or flip — pointing the pre-oriented
   * winding. Defaults to `flowSignedDirection`. @default = flowSignedDirection
   */
  chevronPerBucketDirection?: boolean;
  /**
   * `flowSignedDirection`: rolling-window HALF-span (ms of data time) over which the
   * continuous net-flow DIRECTION is averaged (a coherence ratio). Wider = the arrow
   * shape/hue morph glides more slowly and smoothly across a flow reversal. Defaults
   * to `chevronAggregateWindowMs`; set it wider on COARSE (e.g. 10-min) matrices so
   * the window spans several buckets. @default = chevronAggregateWindowMs
   */
  chevronDirectionWindowMs?: number;
  /**
   * PER-BUCKET chevron direction. When true, the corridor value matrix is SIGNED
   * (built by `bixi --streets --per-bucket-direction`): the layer colours by
   * `|value|` (volume) and hands the per-vertex SIGN to the ChevronFlowExtension,
   * so each corridor's chevrons FLIP as its dominant flow reverses over the day
   * (morning inbound → evening outbound) instead of pointing one static winding.
   * Requires `flowMatrix` + `flowDirectional`.
   */
  flowSignedDirection?: boolean;
}

/**
 * One interpolated dot at the head of each active trip
 * (`AnimatedTripHeadsLayer`, CPU per-frame position on a stock
 * ScatterplotLayer). Same archive shape as `trips`, no rebuild needed.
 */
export interface TripHeadsDataset extends BaseDataset, TripHeadStyling {
  type: 'tripHeads';
  /**
   * Trail duration in ms behind each head. The tile loader keeps
   * `2 × trailLength` resident so a head entering the viewport has its history.
   */
  trailLength?: number;
}

/** Filled polygon fields (`AnimatedPolygonLayer`). */
export interface PolygonDataset extends BaseDataset, PolygonStyling {
  type: 'polygon';
  // ─── rain→flood composite (a river overlay on the precip field) ────────
  /**
   * Optional river-discharge FLOW-MATRIX archive painted ON TOP of the primary
   * precip-isoband polygon field (the rain→flood demo: rainfall drives the
   * rivers). A `FlowCorridorLayer` overlay, styled by `riversConfig`. Registers
   * as a REQUIRED governor source unless {@link BaseDataset.overlayGatesPlayback}
   * is set false, so the clock waits for the heavy river archive instead of
   * sweeping past its loaded frontier (empty rivers). Rewritten through
   * `resolveDataUrl` alongside `url` so an R2 deploy resolves it.
   */
  riversUrl?: string;
  /** Styling for the `riversUrl` flow-matrix overlay (see `tripGradient`). */
  riversConfig?: {
    tripGradient: {
      property: string;
      domain: [number, number];
      colors: number[][];
    };
    /** Bed color for NaN / out-of-range vertices. */
    colorMappingDefault?: ColorRGBA;
    /** Per-feature width — numeric property name (e.g. `'width'`) or constant. */
    tripWidth?: string | number;
    widthMinPixels?: number;
    widthMaxPixels?: number;
  };
}

/**
 * Origin→destination flow arcs (`AnimatedArcLayer`); each feature is a 2-vertex
 * LineString (first vertex = source, last = target). Build with
 * `stt-generate nyc-rideshare --od`.
 */
export interface ArcDataset extends BaseDataset, LineWidthStyling {
  type: 'arc';
  /** Arc source-endpoint (origin) color, RGBA. The arc interpolates source→target. */
  arcSourceColor?: ColorRGBA;
  /** Arc target-endpoint (destination) color, RGBA. */
  arcTargetColor?: ColorRGBA;
  /** Arc line width in `widthUnits` (default pixels). */
  arcWidth?: number;
  /** Bow arcs along a great-circle path (for globe / long-haul flows). */
  arcGreatCircle?: boolean;
  /** Arc height multiplier; 0 = flat lines. Default 1. */
  arcHeight?: number;
  /**
   * Palette for a categorical `colorProperty`
   * (GPU CategoryColorExtension — palette[categoryIndex]).
   */
  colorPalette?: ColorRGBA[];
}

/**
 * Extruded 3D columns at point features (`AnimatedColumnLayer`), height from a
 * numeric `elevationProperty`. Reuses any point archive.
 */
export interface ColumnDataset extends BaseDataset {
  type: 'column';
  /** Column disk radius in `columnRadiusUnits`. Default 100. */
  columnRadius?: number;
  /** Units for `columnRadius`. Default 'meters'. */
  columnRadiusUnits?: 'meters' | 'pixels' | 'common';
  /** Column cross-section resolution (sides). Default 12. */
  columnDiskResolution?: number;
  /** Constant column height when no `elevationProperty` is set. */
  columnElevation?: number;
  /** Constant column fill, RGBA (or use `colorProperty` for categorical fill). */
  columnFillColor?: ColorRGBA;
  /**
   * Palette for a categorical `colorProperty`
   * (GPU CategoryColorExtension — palette[categoryIndex]).
   */
  colorPalette?: ColorRGBA[];
}

/** GPU density field (`AnimatedHeatmapLayer`), optionally channel-stacked. */
export interface HeatmapDataset extends BaseDataset {
  type: 'heatmap';
  /** Property name for weight (defaults to 1 per feature). */
  weightProperty?: string;
  /**
   * Render multiple stacked heatmap layers from this one source archive (e.g.
   * pickup + dropoff heatmaps from the NYC taxi status column). If unset, a
   * single default heatmap layer is rendered.
   */
  heatmapLayers?: HeatmapLayerSpec[];
}

/**
 * Server-aggregated summary tier — H3 hexes (`H3SummaryLayer`) or the
 * square-cell CARTO Quadbin analog (`QuadbinSummaryLayer`). Only useful for
 * archives built with `stt-build --summary-tier h3` / `--summary-tier quadbin`.
 */
export interface SummaryDataset extends BaseDataset {
  type: 'h3Summary' | 'quadbinSummary';
  /**
   * Numeric column the summary-tier color ramp + extrusion are driven by.
   * Defaults to `'count'` (the implicit per-cell count column).
   */
  summaryWeightProperty?: string;
  /**
   * 6-stop low→high colour ramp for the summary tier. RGBA, 0-255.
   */
  summaryColorRange?: ColorRGBA[];
  /**
   * `[min, max]` pin for the colour ramp. When unset, each tile's own
   * min/max drives the ramp — visually unstable but a usable default.
   */
  summaryColorDomain?: [number, number];
  /** Extrude the cells by `weight * elevationScale`. */
  summaryExtruded?: boolean;
  /** Meters-per-weight-unit when extruded. */
  summaryElevationScale?: number;
  /** Cell coverage (0..1). Lower values leave visible gaps between cells. */
  summaryCoverage?: number;
  /**
   * Optional pickup/dropoff-style toggle. When set, the demo renders a small
   * segmented control over the map; selecting an option swaps the layer's
   * `weightProperty` + colour ramp + domain in place. The first entry is the
   * initial selection.
   */
  summaryToggleWeights?: SummaryToggleOption[];
}

/**
 * OD flow arrows between aggregated nodes (`FlowmapLayer`), and the GPU
 * force-directed edge-bundled superset (`BundledFlowmapLayer`) that relaxes
 * compatible flows into smooth rivers (Holten FDEB, cosmos.gl-style ping-pong
 * textures). Both read the same OD `vertexValueMatrix` tiles, so the bundling
 * knobs are declared once here; a backend without `liveBundling` draws the
 * straight arrows instead of refusing the demo.
 */
export interface FlowmapDataset extends BaseDataset {
  type: 'flowmap' | 'flowmap-bundled';
  /** Arrow width in px per `sqrt(current-bucket trip count)`. Default 1.1. */
  flowWidthScale?: number;
  /** Clamp arrow width to at least this many px (active arrows only). */
  flowWidthMinPixels?: number;
  /** Clamp arrow width to at most this many px. */
  flowWidthMaxPixels?: number;
  /** Arrow source (origin / tail) color, RGBA. */
  flowSourceColor?: ColorRGBA;
  /** Arrow target (destination / arrowhead) color, RGBA. */
  flowTargetColor?: ColorRGBA;
  /** Perpendicular separation of the two directions, in arrow widths. Default 0.5. */
  flowGap?: number;
  /** Node circle radius per `sqrt(incident flow)`. Default 1.3. */
  flowNodeRadiusScale?: number;
  /**
   * Units for node-circle radius: `'pixels'` (constant on screen) or `'meters'`
   * (scales with the map, so dense overviews don't blow out into overlapping
   * dots — still clamped by `flowNodeRadiusMaxPixels`). With `'meters'`,
   * `flowNodeRadiusScale` is metres per √flow. Default `'pixels'`.
   */
  flowNodeRadiusUnits?: 'meters' | 'pixels';
  /** Clamp node circle radius to at most this many px. Default 28. */
  flowNodeRadiusMaxPixels?: number;
  /** Node circle fill color, RGBA. */
  flowNodeColor?: ColorRGBA;
  /** Hide arrows/nodes whose current flow is below this many trips. Default 0.25. */
  flowMinFlow?: number;

  // ─── edge-bundling tuning (KDEEB, `flowmap-bundled` only) ─────────────
  /** Control points per edge (P). Higher = smoother rivers, more GPU work. Default 48. */
  flowSubdivisionPoints?: number;
  /** Kernel bandwidth as a fraction of the tile extent — the headline knob; larger bundles more. Default 0.05. */
  flowKernelRadius?: number;
  /** Number of KDEEB density-advection iterations (more = tighter). Default 15. */
  flowBundlingIterations?: number;
  /** Per-iteration Laplacian smoothing strength in [0,1]. Default 0.5. */
  flowSmoothingStrength?: number;
  /** Above this many edges per tile, skip bundling (straight arrows). Default 4000. */
  flowMaxBundledEdges?: number;
  /**
   * The tiles already carry BAKED bundled geometry (`stt-generate bixi
   * --bake-bundling`): `BundledFlowmapLayer` skips the live GPU bundler and just
   * renders the precomputed rivers. Cheaper, stable, works without `EXT_float_blend`.
   */
  flowPreBundled?: boolean;
}

/**
 * GLM lightning from ONE flash-point archive, drawn as TWO stacked layers: a
 * live strike-DENSITY field (`AnimatedHeatmapLayer`) as the glowing backdrop,
 * plus individual FLASHES (`AnimatedPointLayer`) on top, each appearing bright
 * then fading + shrinking over `wakeLength` sim-ms so instantaneous strikes
 * read as a shimmering flicker on the compressed clock. Build the archive with
 * `python glm_lightning.py` (GOES-16 GLM L2 LCFA).
 */
export interface LightningDataset extends BaseDataset, PointStyling {
  type: 'lightning';
}

/**
 * Composite storm-radar render (NEXRAD). Overlays THREE STT archives from one
 * dataset entry: filled reflectivity contour bands (`AnimatedPolygonLayer`,
 * categorical `dbz_band`) as the animated precipitation field — the dataset's
 * primary `url`; storm-cell centroids (`AnimatedPointLayer`) from
 * `radarCellsUrl`; and animated cell tracks (`AnimatedTripsLayer`, per-vertex
 * intensity) from `radarTracksUrl`. Build with `stt-generate storms`.
 */
export interface RadarDataset
  extends
    BaseDataset,
    PointStyling,
    TripStyling,
    PolygonStyling,
    StormCellOverlay {
  type: 'radar';
}

/**
 * Composite WEATHER-SUITE render on one playhead. Stacks (bottom→top): HRRR
 * wind streamlines (`AnimatedTripsLayer`, from `windUrl`); the MRMS precip
 * FIELD (`AnimatedPolygonLayer`, categorical `dbz_band`) — the primary `url`
 * and REQUIRED governor source; WPC surface fronts in classic notation
 * (`AnimatedPathLayer` lines from `frontsUrl` + `AnimatedPolygonLayer`
 * triangle/semicircle pips from `frontsPipsUrl`); precip cell tracks +
 * centroids (from `radarTracksUrl`/`radarCellsUrl`); and GLM lightning as a
 * density field + flashes (from `lightningUrl`). Built by glm_lightning.py +
 * mrms_weather.py + hrrr_advect.py + wpc_fronts.py.
 */
export interface WeatherDataset
  extends
    BaseDataset,
    PointStyling,
    TripStyling,
    PathStyling,
    PolygonStyling,
    StormCellOverlay {
  type: 'weather';
  /**
   * HRRR wind archive manifest (the hrrr-wind trips archive from
   * hrrr_advect.py). In the composite it renders as a minimal drifting PARTICLE
   * FIELD via `AnimatedTripHeadsLayer` — one CPU-interpolated head-dot per
   * active particle, the contextual steering-flow backdrop (not streamline
   * ribbons). Rewritten through `resolveDataUrl` alongside `url`.
   */
  windUrl?: string;
  /**
   * GLM lightning flash-point manifest, rendered as BOTH a density heatmap and
   * flash points (the `lightning` pair) within the composite. Rewritten
   * through `resolveDataUrl`. The composite reuses `radarCellsUrl`/
   * `radarTracksUrl` for the precip cells/tracks and `url` for the precip field.
   */
  lightningUrl?: string;
  /**
   * WPC surface frontal analysis manifest (the wpc-fronts path archive from
   * wpc_fronts.py): meteorologist-analyzed cold/warm/occluded/stationary
   * fronts + troughs, one analysis every 3 h — the synoptic skeleton drawn
   * over the precip field as categorical polylines (`render_class`), with
   * successive analyses cross-dissolved by the renderer. Rewritten through
   * `resolveDataUrl`.
   */
  frontsUrl?: string;
  /**
   * Companion archive to {@link WeatherDataset.frontsUrl}: the classic frontal
   * notation — filled triangles (cold), semicircles (warm), alternating
   * (occluded/stationary) — baked by wpc_fronts.py as small ORIENTED GEOGRAPHIC
   * POLYGONS on each front's advancing side, so they rotate and scale with
   * the map exactly like the paper-map symbols. Rendered by a second
   * AnimatedPolygonLayer with the same categorical mapping and fades as the
   * lines. Rewritten through `resolveDataUrl`.
   */
  frontsPipsUrl?: string;
  /**
   * Per-vertex TEMPERATURE gradient for the composite's wind drift dots
   * (`AnimatedTripHeadsLayer`). When set, each moving dot is colored by its
   * per-vertex `vertexValues` scalar — the 500 mb air temperature (°C) sampled
   * from the SAME HRRR file as the wind (`hrrr_advect.py --color-by temp`), so
   * the grounding shares the wind's exact 3 km / hourly resolution. `domain` is
   * the [min, max] °C mapped onto the cold→warm `colors` ramp. Unset →
   * constant {@link WeatherDataset.windHeadColor}.
   */
  windGradient?: {
    property: string;
    domain: [number, number];
    colors: ColorRGBA[];
  };
  /**
   * Fill color (RGBA, 0-255) for the composite's wind drift dots
   * (`AnimatedTripHeadsLayer`). Cool low-contrast blue so the field recedes as
   * background context, distinct from the bright white lightning that pops.
   * @default `[95, 160, 230, 100]`
   */
  windHeadColor?: ColorRGBA;
  /**
   * Screen-space radius (px) of each wind drift dot. Kept small — the wind is a
   * dense background field whose presence comes from particle density, not dot
   * size. @default 1.3
   */
  windHeadRadiusPixels?: number;
  /** Layer opacity for the wind drift dots. @default 0.6 */
  windHeadOpacity?: number;
}

/**
 * Composite STORM-4D render — one supercell as a true 4D object on one
 * playhead (the depth-first sibling of the continental `weather` suite).
 * Stacks (bottom→top): county power outages extruded by `customers_out`
 * (`AnimatedPolygonLayer`, from `outagesUrl`); the GOES C13 cloud-top "anvil
 * canopy" isobands lifted to their brightness-temperature height (from
 * `cloudTopUrl`); multi-level HRRR wind trips at `level_alt_m` (from
 * `wind3dUrl`); the NEXRAD Level II gate VOLUME as a 3D billboard point
 * cloud stacked by beam altitude (`AnimatedPointLayer`, `use3D` +
 * `elevationProperty: 'alt_m'`) — the primary `url` and REQUIRED governor
 * source, toggling between reflectivity (`dbz_band`) and dealiased radial
 * velocity (`vel_band`) render modes via `summaryToggleWeights`; VTEC
 * warning polygons extruded as translucent wireframe prisms (from
 * `warningsUrl`); mesocyclone couplet markers (from `coupletUrl`); ASOS
 * surface stations (from `stationsUrl`); local storm reports arriving
 * behind the storm (from `reportsUrl`); GLM lightning at ground (from
 * `lightningUrl`); and the radiosonde ascent trail (from `soundingUrl`).
 * Built by nexrad_volume.py + the storm4d fetch scripts.
 *
 * Every overlay url is rewritten through `resolveDataUrl` alongside `url` so an
 * R2 deploy resolves them.
 */
export interface Storm4dDataset
  extends
    BaseDataset,
    PointStyling,
    TripStyling,
    PathStyling,
    PolygonStyling,
    DataFilterStyling {
  type: 'storm4d';
  /**
   * Mesocyclone couplet marker archive (`storm4d-couplet`): azimuthal-shear
   * local maxima on the lowest dealiased velocity sweep, one marker per
   * detected cluster carrying `strength_ms` (peak gate-to-gate Δv) + `alt_m`.
   * Rendered as white stroked rings sized by `strength_ms`.
   */
  coupletUrl?: string;
  /**
   * VTEC storm-based warning polygon archive (`storm4d-warnings`, IEM SBW
   * with SVS shrink phases): `phenom` ("TO"|"SV"|"FF") + per-phase
   * timestamp/end_timestamp. Rendered as translucent wireframe prisms
   * extruded 12 km (TO red / SV amber / FF green).
   */
  warningsUrl?: string;
  /**
   * Local-storm-report point archive (`storm4d-reports`, IEM LSR + SPC):
   * categorical `kind` + `magnitude`. Rendered with a wake so reports read
   * as arriving BEHIND the storm.
   */
  reportsUrl?: string;
  /**
   * Surface-station point archive (`storm4d-stations`, IEM 1-min ASOS +
   * METAR fallback): per-minute `wind_kt`/`gust_kt` + categorical
   * `gust_band`. Rendered as dots sized by gust, colored by `gust_band`.
   */
  stationsUrl?: string;
  /**
   * County power-outage polygon archive (`storm4d-outages`, EAGLE-I 15-min
   * county rollups on Census county geometry): `customers_out` per interval.
   * Rendered as dark-red translucent prisms extruded by `customers_out`.
   */
  outagesUrl?: string;
  /**
   * GOES C13 cloud-top isoband archive (`storm4d-cloudtop`): brightness-
   * temperature bands (`bt_band`) each carrying `top_alt_m` (standard-
   * atmosphere BT→height). Rendered as the translucent "anvil canopy"
   * lifted to `top_alt_m`.
   */
  cloudTopUrl?: string;
  /**
   * Multi-level HRRR wind trips archive (`storm4d-wind3d`): particle trips
   * at 850/700/500/250 mb, each feature carrying `level_alt_m`. Rendered as
   * reveal-trail paths lifted to their pressure-level altitude.
   */
  wind3dUrl?: string;
  /**
   * Radiosonde ascent point archive (`storm4d-sounding`, OAX 18Z special
   * launch): one point per reported level with `alt_m`, drift-integrated
   * position. Rendered as a small climbing trail (delight layer).
   */
  soundingUrl?: string;
  /**
   * GLM lightning flash-point manifest at ground level (the shared
   * goes-glm-lightning archive, timeRange-subset at render).
   */
  lightningUrl?: string;
  /**
   * How the primary `url` archive renders the storm itself:
   *
   * * `'points'` (default) — the NEXRAD gate VOLUME (`storm4d-volume`):
   *   one 3D billboard point per radar gate, stacked by beam altitude.
   * * `'isolines'` — the CAPPI CONTOUR SHEETS (`storm4d-isolines`, built by
   *   `nexrad_isolines.py`): the same volumes gridded to constant-altitude
   *   slices and contoured at fixed dBZ levels, so the storm reads as a
   *   stack of nested iso-line rings terracing up through the troposphere.
   *   Rendered with `AnimatedPathLayer` lifted by the per-feature `alt_m`
   *   CAPPI height (× the shared `STORM4D_ELEVATION_SCALE`), colored by the
   *   categorical `dbz_level` (or `alt_band` in the height render mode).
   *
   * Everything else about the composite — the nine context overlays, the
   * camera, the governor wiring — is identical between the two.
   */
  stormVolumeMode?: 'points' | 'isolines';
  /**
   * Reflectivity ↔ velocity RENDER-MODE toggle, reusing the summary-tier
   * segmented control: each option's `weightProperty` names the volume's
   * CATEGORICAL color column (`dbz_band` or `vel_band`) and its `colorMapping`
   * carries that mode's category → RGBA map.
   */
  summaryToggleWeights?: SummaryToggleOption[];
}

/**
 * Composite AV-telemetry "cockpit" render (streetscape.gl / avs.auto style).
 * Overlays up to THREE STT archives from one AV scene bundle: an accumulated
 * LIDAR point cloud (`AnimatedPointLayer`, categorical `height_band` fill) as
 * the dataset's primary `url`; the ego trajectory (`AnimatedTripsLayer`) from
 * `avEgoUrl`; and tracked-object 3D boxes (`AnimatedBoundingBoxLayer`,
 * categorical `category`) from `avObjectsUrl`. The bespoke `/drive/:sceneId`
 * cockpit additionally reads `avSceneUrl` (the `scene.json` manifest) plus the
 * `avTelemetryUrl` / `avCamerasUrl` sidecars for chrome, gauges, and the camera
 * inset. Built by the `av_synthetic.py` / `nuscenes_extract.py` adapters.
 *
 * Every url is rewritten through `resolveDataUrl` alongside `url` so an R2
 * deploy resolves it.
 */
export interface AvDataset
  extends BaseDataset, PointStyling, TripStyling, AvSceneStreams {
  type: 'av';
  /**
   * `scene.json` manifest URL for the AV scene bundle. The bespoke
   * `/drive/:sceneId` cockpit fetches it for chrome (name/attribution/license),
   * object colors, the runtime time range, and the telemetry/camera sidecar
   * references. The standard `case 'av'` render does NOT need it (it composes
   * from the archive URLs + the Dataset copies of the colors); the cockpit does.
   */
  avSceneUrl: string;
  /**
   * LIDAR point-cloud archive manifest (an STT POINT archive — accumulated
   * returns, colored by categorical `height_band`). Rendered by
   * `AnimatedPointLayer`. Present ONLY on scenes that have a LIDAR stream
   * (nuScenes / Argoverse / synthetic); omit it for LIDAR-less scenes such as
   * comma.ai. On LIDAR scenes set it equal to the dataset's primary `url` so the
   * playback governor rides the LIDAR (heaviest) archive.
   */
  avLidarUrl?: string;
  /**
   * Scene-split ("stage + actors") STATIC archive manifest (an STT POINT/surfel
   * archive). The FIXED environment, built by `argoverse_extract.py --scene-split`
   * by accumulating every sweep, removing the moving returns (in-box +
   * ERASOR-style scrub), voxel-downsampling and fitting surfels — baked as ONE
   * timeless full-range cloud that loads once and persists. Rendered as a
   * persistent `SplatLayer` backdrop (no playhead filter) UNDER the animated
   * actors. Set together with {@link AvDataset.avDynamicUrl} +
   * {@link AvDataset.lidarStage}.
   */
  avStaticUrl?: string;
  /**
   * Scene-split DYNAMIC archive manifest (an STT POINT/surfel archive). The
   * MOVING agents' per-sweep returns (cars/bikes/pedestrians inside moving
   * boxes), time-bucketed and animated. On scene-split scenes this is also the
   * primary `url` / {@link AvDataset.avLidarUrl} so the governor rides it.
   */
  avDynamicUrl?: string;
  /**
   * CAN-bus telemetry sidecar JSON URL (`telemetry.json`). Loaded client-side
   * by the cockpit; binary-searched at the playhead to drive the metric gauges.
   */
  avTelemetryUrl?: string;
  /**
   * Camera-keyframe sidecar JSON URL (`cameras.json`). Loaded client-side by
   * the cockpit's top-right camera inset.
   */
  avCamerasUrl?: string;
  /**
   * Camera-colored LIDAR: the bundle bakes per-point `r`/`g`/`b` columns
   * (sampled by projecting each return into the camera images at build time —
   * `waymo_extract.py --colorize`). When set, the cloud is painted per-point
   * from those columns instead of the `height_band` ramp.
   */
  lidarRgb?: boolean;
  /**
   * Render the LIDAR cloud as soft gaussian "splats" (SplatExtension) — a
   * photographic point-cloud look. Best paired with `lidarRgb`.
   */
  lidarSplat?: boolean;
  /**
   * Render the LIDAR cloud as ORIENTED ANISOTROPIC GAUSSIAN SURFELS via
   * `SplatLayer` — a "formal" splat (oriented disks lying on the surface, each
   * with a soft radial AND soft temporal Gaussian) instead of round dots. The
   * bundle must be built with `waymo_extract.py --surfel`, which bakes the
   * per-return orientation quaternion + in-plane extents + confidence columns.
   * Supersedes the `AnimatedPointLayer` LIDAR path when set.
   */
  lidarSurfel?: boolean;
  /**
   * Soft temporal-Gaussian width (ms) for `lidarSurfel` — each surfel brightens
   * at its sweep instant and fades within ±~3σ. Tune to ~1–2× the sweep
   * interval (Waymo LIDAR ≈ 100 ms). Forwarded to `SplatLayer.temporalSigma`.
   */
  lidarSurfelTemporalSigma?: number;
  /** Multiplier on every surfel's baked extents (`SplatLayer.sizeScale`). */
  lidarSurfelSizeScale?: number;
  /**
   * Additive-octree zoom LOD: the bundle was built with `argoverse_extract.py
   * --lod`, baking a single `home_zoom` per return (per-sweep hierarchical voxel
   * subsample) so each point is materialized at exactly ONE zoom level. Renders
   * through the normal `AnimatedPointLayer` point path but with the engine's
   * `lodMode: 'additive'` — the tileset loads + renders the UNION of zoom levels
   * `[minZoom..cameraZoom]`, so coarse zooms show a sparse overview and zooming
   * in streams ONLY the deeper residual detail (the coarse tiles stay resident).
   */
  lidarLod?: boolean;
  /**
   * Render the LIDAR as DENSITY ISO-LINES instead of points/surfels: the bundle's
   * `lidar/` archive is windowed contour LineStrings (built with
   * `waymo_extract.py --contours`) drawn by `AnimatedPathLayer`, colored by a
   * categorical `density_band` ramp (`lidarColorMapping`). A height-independent
   * topographic map of where the cloud clusters, morphing per playhead window.
   * Supersedes the `AnimatedPointLayer` / surfel LIDAR paths when set.
   */
  lidarIso?: boolean;
  /**
   * TRUE-3D variant of {@link AvDataset.lidarIso}: the `-iso3d` bundle (built
   * with `waymo_extract.py --contours --contour-z-step …`) slices the returns
   * into height layers and contours each layer's XY density independently,
   * tagging every contour with a numeric `z_layer` (its slab's real altitude,
   * metres). `AnimatedPathLayer` lifts each ring to `z_layer × {@link
   * AvDataset.lidarIsoElevationScale}`, so the vertical axis carries REAL
   * structure — a wall contours up its whole height, a parked car only near the
   * ground. Implies `lidarIso`; still colored by the categorical `density_band`
   * ramp.
   */
  lidarIso3d?: boolean;
  /**
   * Vertical exaggeration applied to the `z_layer` altitude for the {@link
   * AvDataset.lidarIso3d} relief — `1` is true 1:1 scale (matches the point
   * cloud); a small multiplier (~2–3) makes the few-metre structure read against
   * the ~100 m-wide scene. Default 1.
   */
  lidarIsoElevationScale?: number;
  /**
   * Height-graded opacity for the {@link AvDataset.lidarIso3d} stack: fades each
   * contour ring's alpha by its real altitude so the upper slabs go translucent
   * and the stack reads coherently from a TOP-DOWN view (you see down through
   * the roof to the ground rather than the top slab occluding everything below).
   * `range` is the `[low, high]` altitude in METRES (raw `z_layer`,
   * pre-exaggeration) the fade spans; `near` is the alpha multiplier at the
   * ground (default 1) and `far` at the top (e.g. `0.35` → top fades to 35%).
   * Omit for an un-graded stack. Forwarded to
   * `AnimatedPathLayer.elevationOpacity{Range,Near,Far}`.
   */
  lidarIsoTopFade?: { range: [number, number]; near?: number; far?: number };
  /**
   * Worldbuild ("scene reconstruction") variant of the surfel splat: instead of
   * each surfel fading away from its sweep instant, STATIC surfels (`is_dynamic`
   * = 0) PERSIST once revealed — the cloud accumulates into a built-up 3D world
   * as the car drives, while DYNAMIC surfels (moving objects) smear with a short
   * temporal Gaussian so traffic still reads as motion. Renders the `<id>-world`
   * bundle (SplatLayer-compatible surfel cloud + `is_dynamic` / `world_class`
   * columns) via {@link SplatLayer} with `cumulative: true`. Implies camera color.
   */
  lidarWorldbuild?: boolean;
  /**
   * Reveal-fade (ms) for {@link AvDataset.lidarWorldbuild} — how long a freshly-
   * revealed static surfel ramps from invisible to full as it first appears. 0 =
   * snap on (the surface "paints in" instantly at each sweep). Forwarded to
   * `SplatLayer.revealFade`.
   */
  lidarWorldbuildRevealFade?: number;
  /**
   * Temporal-Gaussian width (ms) for the DYNAMIC surfels in
   * {@link AvDataset.lidarWorldbuild} — moving-object returns smear over ±~3σ of
   * this so traffic reads as motion against the persistent static world.
   * Forwarded to `SplatLayer.temporalSigmaDynamic`.
   */
  lidarWorldbuildDynamicSigma?: number;
  /**
   * Scene-split ("stage + actors") render: decompose the LIDAR into two distinct
   * `SplatLayer`s — a STATIC stage (the fixed environment,
   * {@link AvDataset.avStaticUrl}) drawn as a persistent backdrop, and the
   * DYNAMIC actors ({@link AvDataset.avDynamicUrl}) animated over the playhead.
   * Unlike {@link AvDataset.lidarWorldbuild} (one merged cloud, a shader branch
   * on `is_dynamic`), this renders two separate archives with independent load
   * lifecycles. Implies camera-colored surfels on both halves.
   */
  lidarStage?: boolean;
  /**
   * For {@link AvDataset.lidarStage}: render the static stage with NO playhead
   * filter — an effectively-infinite `temporalSigma` pins every stage surfel
   * full-bright from t=0 (a fixed backdrop, not an accreting reveal). Defaults
   * to `true`.
   */
  lidarStageStatic?: boolean;
  /**
   * For {@link AvDataset.lidarStage}: layer opacity of the static stage
   * backdrop, muted vs the bright actors so the moving agents pop against it.
   * Defaults to ~0.5.
   */
  lidarStageOpacity?: number;
  /**
   * For {@link AvDataset.lidarStage}: surfel size multiplier for the DYNAMIC
   * actors, so the moving agents render chunkier and pop against the recessive
   * stage. Defaults to ~1.5 (the stage keeps
   * {@link AvDataset.lidarSurfelSizeScale}, default 1).
   */
  lidarActorSizeScale?: number;
  /**
   * Raw-sweep ("sweep / scan") variant: the `<id>-scan` bundle is raw LIDAR with
   * a per-point TRUE scan-time `start_time` and a phase-ramp `r`/`g`/`b` color,
   * rendered as a WAKE-mode {@link AnimatedPointLayer} so the sweep's rotating
   * scan-line sweeps across the scene like a live radar. AV2 only (only AV2
   * builds a `-scan` bundle). Implies camera/phase color.
   */
  lidarScan?: boolean;
  /**
   * Tracked-track LineStrings archive (`tracks/manifest.json`) present in EVERY
   * base bundle: one LineString per track (object classes + the synthetic "ego"
   * spine), carrying `vertex_timestamps`, a categorical `category`, and per-vertex
   * speed. Drives the {@link AvDataset.avCube} space-time-cube render
   * (`AnimatedTripsLayer` in trail mode, lifted by time = height).
   */
  avTracksUrl?: string;
  /**
   * Render the scene as a Hägerstrand space-time cube of the TRACK trajectories:
   * the {@link AvDataset.avTracksUrl} LineStrings are drawn as 3D ribbons
   * climbing through the cube (time = altitude, slope = speed), with a
   * translucent now-plane riding the playhead. A render-only flag set on a clone
   * of the base dataset (no bundle swap — it reads the base + its `tracks/`
   * archive). The cockpit's "Spacetime" render mode.
   */
  avCube?: boolean;
  /**
   * Cube height in METRES for the full time range at squash factor 1 (the
   * {@link AvDataset.avCube} analog of `timeHeight.rangeHeightMeters`). Defaults
   * to ~200.
   */
  avCubeRangeHeightMeters?: number;
  /**
   * Opt this AV scene into a toggleable Google Photorealistic 3D Tiles overlay
   * (deck.gl `Tile3DLayer` from `@deck.gl/geo-layers`, pointed at Google's
   * `tile.googleapis.com` photoreal city mesh). The cockpit shows a "3D Tiles"
   * toggle ONLY when this is set AND a `VITE_GOOGLE_MAPS_API_KEY` is configured
   * AND the deck.gl renderer is active (the Three.js engine can't host a deck
   * layer); flipping it loads the photoreal mesh at the scene's geo-anchor as a
   * backdrop UNDER the LIDAR cloud + object boxes (depth-tested, so buildings
   * occlude returns behind them). Geo-registered scenes (nuScenes / Argoverse)
   * align cleanly; APPROXIMATE local-frame scenes (Waymo — no disclosed georef,
   * anchored at a plausible metro point) render the real city but won't perfectly
   * match the cloud's streets. Off by default; deck-renderer AV scenes only.
   */
  tiles3d?: boolean;
  /**
   * Hard-coded local ground ellipsoidal height (metres) at this scene's anchor,
   * used to seat {@link AvDataset.tiles3d}. Google's photoreal mesh is referenced
   * to WGS84 ellipsoidal height (e.g. Pittsburgh ground ≈ 230 m) while the AV
   * cloud sits at local `z ≈ 0`; the cockpit lowers the mesh by this much so the
   * streets line up. Measured per scene by reading the finest Google tile at the
   * anchor (the values are baked into `datasets.ts`). When unset, the cockpit
   * falls back to auto-detecting it from the tiles at runtime (less reliable).
   * The in-app "3D tiles height" slider trims ± on top of this.
   */
  tiles3dGroundHeight?: number;
  /**
   * Default opacity (0–1) for this scene's {@link AvDataset.tiles3d} photoreal
   * mesh. Below 1 ghosts the buildings so the LIDAR reads against them. Seeds
   * the cockpit's "Tiles opacity" slider (the `?tiles3dop=` URL param
   * overrides). @default 1
   */
  tiles3dOpacity?: number;
}

/**
 * WORLD-MODEL SCENARIO GALLERY (`/worlds`) — hundreds of short driving
 * scenarios laid out side by side on a synthetic grid, every one animating
 * at once on a single shared looping clock. FOUR cross-scenario archives:
 * the ego trips (`avEgoUrl`, the primary `url` + the one REQUIRED governor
 * source), the oriented agent boxes (`avObjectsUrl`, mounted only when the
 * camera is close enough to read them), and the HD-map line/polygon
 * substrate (`avMapLineUrl` / `avMapPolyUrl`, timeless full-range archives).
 * Rendered by the bespoke `/worlds` page (never by `DemoViewer`), which is why
 * this type has no `buildDemoLayers` case. Built by `cosmos_drive_dreams.py`.
 */
export interface WorldsDataset
  extends BaseDataset, PointStyling, TripStyling, AvSceneStreams {
  type: 'worlds';
  /**
   * The scenario-index sidecar (`worlds.json`) written by
   * `cosmos_drive_dreams.py`. Carries the grid geometry, the shared clock, and
   * one record per scenario (origin lon/lat, caption, agent counts, generated
   * weather-variant video paths, hero LiDAR manifest). The `/worlds` page fetches
   * it and resolves every asset path inside it RELATIVE to this url's directory,
   * so the bundle stays self-describing. Routed through `resolveDataUrl`.
   */
  worldsUrl: string;
  /**
   * Additive-octree LOD POINT overview of the HD-map lines: a decimated dotted
   * road network whose points each carry a single `home_zoom`, rendered via
   * `AnimatedPointLayer` with `lodMode:'additive'` so the multi-scenario overview
   * loads a sparse coarse tier instead of the full `avMapLineUrl` archive at
   * every zoom. The crisp lines take over on zoom-in. Built by
   * `cosmos_drive_dreams.py`'s `map_points` archive. Routed through
   * `resolveDataUrl`.
   */
  avMapPointsUrl?: string;
}

/** The core {@link LayerKind}s that have a dedicated {@link Dataset} variant. */
type StyledLayerKind =
  | PointDataset['type']
  | PointCloudDataset['type']
  | PathDataset['type']
  | TripsDataset['type']
  | TripHeadsDataset['type']
  | PolygonDataset['type']
  | ArcDataset['type']
  | ColumnDataset['type']
  | HeatmapDataset['type']
  | SummaryDataset['type']
  | FlowmapDataset['type'];

/**
 * A kind in the frozen core vocabulary that no demo styles yet. It gets the
 * base fields and nothing else, so adding a kind in `@poopdeck.gl/core` never
 * silently admits another family's props — authoring a demo for it means giving
 * it a variant above.
 */
export interface GenericDataset extends BaseDataset {
  type: Exclude<LayerKind, StyledLayerKind>;
}

/**
 * A demo card, discriminated on {@link DatasetType}. Narrow on `type` before
 * reading anything a single family owns — that is what makes
 * `lidarSurfelTemporalSigma` a compile error on a seismicity dataset.
 */
export type Dataset =
  | PointDataset
  | PointCloudDataset
  | PathDataset
  | TripsDataset
  | TripHeadsDataset
  | PolygonDataset
  | ArcDataset
  | ColumnDataset
  | HeatmapDataset
  | SummaryDataset
  | FlowmapDataset
  | LightningDataset
  | RadarDataset
  | WeatherDataset
  | Storm4dDataset
  | AvDataset
  | WorldsDataset
  | GenericDataset;

/** Keys of EVERY member of a union, not just the ones they all share. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * A field name SOME {@link Dataset} variant declares. Use it to type lists of
 * field names that are looked up dynamically, so a rename in a variant breaks
 * the list instead of silently skipping the field.
 */
export type DatasetField = KeysOfUnion<Dataset>;

/**
 * One choice in a summary-tier weight toggle. Each option points at a
 * different numeric column on the summary tier (e.g. `sum_is_pickup`
 * vs `sum_is_dropoff`) and styles it with its own ramp.
 *
 * The DemoViewer segmented control that renders these is type-independent
 * (it shows whenever `summaryToggleWeights` has >1 options and threads the
 * active option into `buildDemoLayers`), so the `storm4d` composite reuses
 * it as its reflectivity ↔ velocity RENDER-MODE toggle: there
 * `weightProperty` names the volume's CATEGORICAL color column (`dbz_band`
 * or `vel_band`) and `colorMapping` carries that mode's category → RGBA map.
 */
export interface SummaryToggleOption {
  id: string;
  label: string;
  /** Summary column to drive the ramp (storm4d: the categorical color column). */
  weightProperty: string;
  colorRange: ColorRGBA[];
  /** Optional pinned `[min, max]` domain (same semantics as `summaryColorDomain`). */
  colorDomain?: [number, number];
  /** CSS gradient stops for the legend strip — usually `colorRange` mapped to hex strings. */
  legendColors?: string[];
  /**
   * Categorical category → RGBA mapping for this option (storm4d render
   * modes: the NWS dBZ ramp vs the diverging velocity map). Ignored by the
   * summary-tier cases, which color by the numeric ramp above.
   */
  colorMapping?: Record<string, ColorRGBA>;
}

/**
 * Calculate animation speed based on time range and target playback duration.
 * Returns the number of simulation milliseconds per real millisecond.
 *
 * Plays at the dataset's intended `targetPlaybackSeconds`. (The old global
 * `PLAYBACK_SLOWDOWN = 2` half-speed hack — which stretched every demo so R2
 * loading could keep up — is gone: the PlaybackGovernor now gates playback on
 * the buffered runway and stalls honestly when loading falls behind.)
 */
export function calculateAnimationSpeed(dataset: Dataset): number {
  // Delegates to the ONE shared formula in @poopdeck.gl/playback
  // (resolvePlaybackParams: baseSpeed = span / targetPlaybackSeconds / 1000),
  // so the showcase, buildDemoLayers' prefetch budget, and external
  // integrators all resolve identically. No archive metadata is threaded here
  // — the hand-authored timeRange + targetPlaybackSeconds are passed as the
  // overrides, and the resolver's default target is 30, byte-identical to the
  // historical `?? 30` for every real value (it additionally guards a
  // non-positive target from producing an infinite speed).
  return resolvePlaybackParams(undefined, {
    targetPlaybackSeconds: dataset.targetPlaybackSeconds,
    timeRange: dataset.timeRange,
  }).baseSpeed;
}

/**
 * The ONE tile-loading recipe every STT layer in the showcase uses — demo
 * pages, the home hero globe, and the data stories all spread this into their
 * layer props so loading behaves identically across surfaces. (The underlying
 * tileset freezes these options when it is created, so callers must pass a
 * budget that covers their fastest playback up front.)
 *
 * Prefetch budget is keyed to REAL-time playback, not sim-time: we want a few
 * seconds of real-time buffer ahead of the play head regardless of how
 * compressed sim-time is. `playbackSpeed` is sim-ms per real-ms, so
 * `playbackSpeed * PREFETCH_REAL_SECONDS * 1000` is that many real seconds
 * expressed in sim-time. The `timeWindow` floor keeps a paused or slow view
 * warming its whole resident window.
 *
 * (The old DemoPage math asked for max(5*timeWindow, playbackSpeed*60000) and
 * up to 150 steps. For ship-traffic that produced ~8h of lookahead × 150 steps
 * ≈ 50 days of prefetch horizon per tick — every tick blew through the
 * bucket-boundary cap and queued thousands of fetches, collapsing FPS to 0.5
 * under SwiftShader.)
 */
export function tileLoadingProps(timeWindow: number, playbackSpeed: number) {
  const PREFETCH_REAL_SECONDS = 5;
  return {
    enablePrefetch: true,
    prefetchAhead: Math.max(
      timeWindow,
      playbackSpeed * 1000 * PREFETCH_REAL_SECONDS,
    ),
    prefetchSteps: 4,
    // Browsers cap to ~6 concurrent connections per HTTP/1.1 origin; asking
    // for more just queues inside the network layer and deepens the decode
    // backlog on the main thread. 12 is enough for HTTP/2 multiplexing too.
    maxRequests: 12,
  };
}
