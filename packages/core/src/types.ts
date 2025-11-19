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
  Brotli = 2,
}

/** Geometry type */
export enum GeometryType {
  Point = 0,
  LineString = 1,
  Polygon = 2,
}

/** Feature change type for delta encoding */
export enum ChangeType {
  Unchanged = 0,
  Created = 1,
  Modified = 2,
  Deleted = 3,
}

/** Interpolation method for temporal transitions */
export enum InterpolationMethod {
  None = 0,
  Linear = 1,
  Step = 2,
  Cubic = 3,
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

/** Decoded tile */
export interface Tile {
  id: TileId;
  timeRange: TimeRange;
  layers: Layer[];
  interpolation?: InterpolationHint;
  temporalResolution?: TemporalResolution;
}

/** Layer within a tile */
export interface Layer {
  name: string;
  extent: number;
  features: Feature[];
  /** Trajectories for moving objects (decoded as binary data) */
  trajectories?: TrajectoryData;
  binary?: BinaryLayerData;
}

/** Binary data for a layer (Structure of Arrays) */
export interface BinaryLayerData {
  /** Flat array of coordinates [x, y, x, y, ...] or [x, y, z, ...] */
  positions: Float32Array;
  /** Flat array of other numeric attributes */
  numericProps: Record<string, Float32Array>;
  /** Number of features/vertices */
  length: number;
  /** Global feature IDs corresponding to indices */
  featureIds: Float64Array;
  /** Start times (Unix ms) */
  startTimes: Float64Array;
  /** End times (Unix ms) */
  endTimes: Float64Array;
}

/** Optimized trajectory data for GPU rendering */
export interface TrajectoryData {
  /** Number of paths */
  count: number;
  
  /** Flat array of path IDs */
  ids: Float64Array;
  
  /** Start index in flattened arrays for each path */
  startIndices: Uint32Array;
  
  /** Number of points in each path */
  lengths: Uint32Array;
  
  /** Flattened timestamps (Float32 for precision relative to tile start) */
  timestamps: Float32Array;
  
  /** Flattened positions [x, y, x, y...] */
  positions: Float32Array;
  
  /** Properties per path */
  properties: Record<string, PropertyValue>[];
}

/** Feature within a layer */
export interface Feature {
  id: number;
  type: GeometryType;
  geometry: number[]; // Delta-encoded coordinates
  properties: Record<string, PropertyValue>;
  timeRange?: TimeRange;
  changeType?: ChangeType;
}

/** Interpolation hint */
export interface InterpolationHint {
  method: InterpolationMethod;
  properties: string[];
}

/** Temporal resolution metadata - tells frontend how to handle animation */
export interface TemporalResolution {
  /** Temporal bucket size in milliseconds (0 = no bucketing) */
  bucketSizeMs: number;
  /** Zoom level of this tile */
  zoomLevel: number;
  /** Number of features in this tile */
  featureCount: number;
  /** Suggested animation speed multiplier (1.0 = normal, >1.0 = faster) */
  suggestedSpeedMultiplier: number;
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
}

/** Options for tile requests */
export interface TileRequestOptions {
  /** Abort signal for canceling requests */
  signal?: AbortSignal;
  /** Priority (higher = more important) */
  priority?: number;
}
