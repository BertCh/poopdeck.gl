/**
 * Core types for spatiotemporal tiles
 */

/** Unique identifier for a spatiotemporal tile */
export interface TileId {
  /** Zoom level (0-22) */
  z: number;
  /** X coordinate */
  x: number;
  /** Y coordinate */
  y: number;
  /** Timestamp (Unix milliseconds) */
  t: number;
}

/** Geographic bounding box in WGS84 coordinates */
export interface BoundingBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** Time range with start and end timestamps */
export interface TimeRange {
  /** Start timestamp (Unix milliseconds) */
  start: number;
  /** End timestamp (Unix milliseconds) */
  end: number;
}

/** Compression method for tiles */
export enum Compression {
  None = 0,
  Gzip = 1,
  Zstd = 2,
}

/** Geometry type */
export enum GeometryType {
  Point = 0,
  LineString = 1,
  Polygon = 2,
}

/** Property value types */
export type PropertyValue = string | number | boolean;

/** Archive metadata */
export interface ArchiveMetadata {
  version: number;
  name?: string;
  description?: string;
  attribution?: string;
  bounds: BoundingBox;
  timeRange: TimeRange;
  minZoom: number;
  maxZoom: number;
  layers: LayerInfo[];
  statistics?: ArchiveStatistics;
  /**
   * Temporal bucket size in milliseconds used for tile chunking.
   * Tiles are organized into fixed temporal intervals (e.g., 3600000 = 1 hour).
   * This enables predictable prefetching and efficient animation.
   */
  temporalBucketMs?: number;
  /** Optional server-aggregated summary tier (H3 / Quadbin hex bins). */
  summaryTier?: SummaryTier;
  /** Optional temporal LOD pyramid (orthogonal to the summary tier). */
  temporalLod?: TemporalLodLevel[];
}

/** Aggregation scheme for the summary tier. */
export type SummaryScheme = 'h3' | 'quadbin';

/** Aggregation function for one summary-tier column. */
export type SummaryAggregation = 'count' | 'sum' | 'mean' | 'min' | 'max';

/** Descriptor for one aggregated column. */
export interface SummaryColumn {
  name: string;
  agg: SummaryAggregation;
}

/** Server-aggregated low-zoom tier. */
export interface SummaryTier {
  scheme: SummaryScheme;
  minZoom: number;
  maxZoom: number;
  cellResolutionPerZoom: number[];
  columns: SummaryColumn[];
  layerName: string;
}

/** One level of a temporal LOD pyramid. */
export interface TemporalLodLevel {
  bucketMs: number;
  maxZoomLevel: number;
}

/** Layer information */
export interface LayerInfo {
  name: string;
  description?: string;
  properties: PropertyInfo[];
  geometryTypes: GeometryType[];
}

/** Property information */
export interface PropertyInfo {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description?: string;
  minValue?: number;
  maxValue?: number;
}

/** Archive statistics */
export interface ArchiveStatistics {
  totalTiles: number;
  totalFeatures: number;
  totalSize: number;
  uncompressedSize: number;
  compressionRatio: number;
}

/** 2D position [lon, lat] */
export type Position2D = [number, number];

/** 3D position [lon, lat, altitude] */
export type Position3D = [number, number, number];

/** Position can be 2D or 3D */
export type Position = Position2D | Position3D;

/**
 * Binary representation of features for GPU-efficient rendering.
 * 
 * This format aligns with deck.gl's binary data interface and loaders.gl's
 * BinaryFeatures specification, with STT-specific temporal extensions.
 * 
 * @see https://loaders.gl/docs/specifications/category-gis#binary-geometries
 * @see https://deck.gl/docs/developer-guide/performance#supply-binary-data
 */
export interface BinaryFeatures {
  /** Total number of features */
  featureCount: number;
  
  /** Geometry type (0=Point, 1=LineString, 2=Polygon) */
  geometryType: GeometryType;
  
  /** 
   * Number of dimensions per position (2 for [lon, lat], 3 for [lon, lat, alt])
   * Defaults to 2 if not specified
   */
  positionDimensions?: 2 | 3;
  
  /** 
   * Interleaved positions as Float64Array.
   * For 2D: [lon0, lat0, lon1, lat1, ...]
   * For 3D: [lon0, lat0, alt0, lon1, lat1, alt1, ...]
   * For points: positionDimensions values per feature
   * For lines/polygons: variable, use startIndices to index
   */
  positions: Float64Array;
  
  /**
   * Start index for each feature's positions (loaders.gl pathIndices/polygonIndices).
   * Length = featureCount + 1 (last value is total position count).
   * Used as deck.gl startIndices for PathLayer/PolygonLayer.
   * Only present for LineString and Polygon geometries.
   */
  startIndices?: Uint32Array;
  
  /** Feature IDs (per feature) */
  featureIds: Uint32Array;

  /**
   * Optional full-precision 64-bit feature IDs, preserved verbatim from the
   * archive's Arrow UInt64 `id` column. Present only when the archive needs
   * full-width IDs (e.g. H3 cell indices at resolution ≥ 7 don't fit in
   * 32 bits). Most consumers should keep using `featureIds`.
   */
  featureIds64?: BigUint64Array;

  /**
   * Global feature IDs for cross-tile feature identification.
   * Optional - if not provided, featureIds are used.
   */
  globalFeatureIds?: Uint32Array;
  
  // ========== STT Temporal Extensions ==========
  
  /** Start time for each feature (milliseconds, relative to timeOffset) */
  startTimes: Float32Array;
  
  /** End time for each feature (milliseconds, relative to timeOffset) */
  endTimes: Float32Array;
  
  /** 
   * Time offset for floating point precision.
   * Absolute time = startTimes[i] + timeOffset
   */
  timeOffset: number;
  
  /**
   * Per-vertex timestamps for accurate path animation (optional).
   * When present, has same length as positions / positionDimensions.
   * Values are relative to timeOffset.
   *
   * This enables accurate "vehicle at position" animation instead of
   * linear interpolation between start/end times. Used by AnimatedTripsLayer
   * when available.
   *
   * Similar to deck.gl TripsLayer's getTimestamps accessor.
   */
  vertexTimestamps?: Float32Array;

  /**
   * Pre-baked polygon triangle indices, MLT-style.
   *
   * Flat array of vertex indices (groups of 3 per triangle). Indices are
   * GLOBAL across the tile: each refers to a vertex in `positions` indexed
   * by `(positions[2*i], positions[2*i+1])`. The Rust writer stores
   * feature-LOCAL indices in the on-disk Arrow column; the TS decoder
   * pre-shifts them by each feature's `startIndices[i]` so the renderer
   * can hand the buffer straight to deck.gl / WebGL without a second pass.
   *
   * Only meaningful for Polygon layers. Present when the source archive
   * was built with `--pre-tessellate`. Absent → the renderer must fall back
   * to its own CPU tessellation (earcut) at tile-arrival time.
   */
  triangles?: Uint32Array;

  /**
   * Per-feature offsets into `triangles`. `triangleOffsets[i]` is the first
   * index for feature `i`; `triangleOffsets[featureCount]` is the total
   * length. Only present when `triangles` is.
   */
  triangleOffsets?: Uint32Array;
  
  // ========== Properties ==========
  
  /** 
   * Numeric properties as typed arrays for direct GPU upload.
   * Key is property name, value is Float32Array with one value per feature.
   */
  numericProps: Record<string, Float32Array>;
  
  /**
   * Categorical properties as indices into lookup tables.
   * Enables GPU-based coloring by category.
   */
  categoricalProps: Record<string, {
    /**
     * Per-feature index into `categories`. Uint16Array supports up to 65535
     * categories. Archives built before the u16 widening are normalized from
     * the legacy single-byte field into a Uint16Array on decode.
     */
    indices: Uint16Array;
    categories: string[];
  }>;
}

/** Layer within a tile - uses binary format for GPU efficiency */
export interface Layer {
  name: string;
  extent: number;
  features: BinaryFeatures;
  /**
   * The standard GeoArrow extension name carried by the underlying Arrow
   * `geometry` field — e.g. `'geoarrow.point'`, `'geoarrow.linestring'`,
   * `'geoarrow.polygon'`. Surfaced here so downstream renderers
   * (`@geoarrow/deck.gl-layers`, Lonboard) can pick a layer type from the
   * standard metadata without re-parsing the Arrow schema.
   *
   * Empty string only for archives older than the GeoArrow extension-name
   * tag (pre-v2.x) — clients should treat that as "unknown" rather than
   * "point" to avoid silent mismatches.
   */
  geometryExtensionName: string;
  /**
   * The original Arrow {@link import('apache-arrow').Table} the layer was
   * decoded from — already a valid GeoArrow record batch. Held so callers
   * can hand it straight to `@geoarrow/deck.gl-layers` (see
   * {@link import('./tile').toGeoArrowTable}) without re-encoding the
   * typed arrays in {@link BinaryFeatures}.
   *
   * Optional because the worker-pool decoder strips `arrowTable` before
   * postMessage (the `Table` class is not structured-cloneable). Use
   * `InlineTileDecoder` if a downstream library needs the raw Table.
   */
  arrowTable?: import('apache-arrow').Table;
}

/** Decoded tile with binary features */
export interface Tile {
  id: TileId;
  timeRange: TimeRange;
  layers: Layer[];
}

export interface TileEntry {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  offset: number;
  length: number;
  featureCount: number;
  compression: Compression;
  uncompressedSize: number;
  /**
   * Temporal bucket size in milliseconds this tile spans.
   *
   * `undefined` when the archive predates the temporal-LOD scaffold (the
   * directory column isn't present); the reader treats those tiles as
   * belonging to the archive's base `temporalBucketMs`. LOD-aware archives
   * always populate this so a reader can dispatch on bucket size.
   */
  temporalBucketMs?: number;
}

/** Archive index */
export interface ArchiveIndex {
  tiles: TileEntry[];
  spatial?: SpatialIndex;
  temporal?: TemporalIndex;
}

/** Spatial index using Hilbert curve */
export interface SpatialIndex {
  hilbertIds: number[];
  tileIndices: number[];
  zoomOffsets: number[];
}

/** Temporal index */
export interface TemporalIndex {
  timestamps: number[];
  tileRefOffsets: number[];
  tileRefs: number[];
}

/** Options for archive reader */
export interface ArchiveOptions {
  /** Base URL for the archive */
  url: string;
  /** Custom fetch function (for adding auth headers, etc.) */
  fetch?: typeof fetch;
  /** Enable request caching */
  cache?: boolean;
  /** Maximum cache size in bytes */
  maxCacheSize?: number;
  /** Options for loaders.gl */
  loadOptions?: any;
  /**
   * Override the tile decoder. Defaults to a worker-pool decoder in browsers
   * that support module workers, inline decoding elsewhere (Node tests,
   * SSR). Pass an InlineTileDecoder to force inline decoding even in the
   * browser — useful for debugging or environments that block workers.
   */
  decoder?: import('./tile-decoder').TileDecoder;
  /**
   * Enable the OPFS-backed persistent tile cache. Defaults to `true` in
   * environments that expose `navigator.storage.getDirectory` (modern
   * browsers) and `false` everywhere else (Node, SSR, sandboxed iframes).
   *
   * **Defaults to `false`.** When enabled, decompressed tile payloads are
   * stored under the Origin Private File System keyed by `(url, tileId,
   * archiveFingerprint)`. On a tab reload the cache survives, so
   * re-rendering the same viewport skips both the HTTP range request AND
   * the zstd decompress step — only the Arrow IPC parse runs.
   *
   * Only enable this when the archive fits comfortably in
   * `opfsCacheMaxBytes` AND users revisit the same viewport across reloads.
   * Cold tile loads cost an extra main-thread zstd decompress per tile
   * (the worker decoder's decompressed bytes are not yet plumbed back to
   * the cache writer), which hurts initial pan/zoom on large archives.
   */
  opfsCache?: boolean;
  /** Soft byte budget for the OPFS cache. Defaults to 512 MB. */
  opfsCacheMaxBytes?: number;
  /** Subdirectory name under the OPFS root. Defaults to `"stt-cache"`. */
  opfsCacheDirectory?: string;
  /**
   * Inject a custom OPFS cache implementation. Tests pass an in-memory shim
   * here; production code should leave this unset and let `STTArchive`
   * construct the real one.
   */
  opfsCacheImpl?: import('./opfs-cache').OpfsTileCache;
}

/** Options for tile requests */
export interface TileRequestOptions {
  /** Abort signal for canceling requests */
  signal?: AbortSignal;
  /** Priority (higher = more important) */
  priority?: number;
}
