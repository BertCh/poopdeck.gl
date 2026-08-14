// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

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
  /**
   * Independently addressable payload representation. `0`/absent is raw;
   * summary tiles use `1`. Variant is part of tile identity.
   */
  variantId?: number;
  /**
   * Temporal-LOD bucket width (ms) this id addresses, for archives that
   * carry a temporal-LOD pyramid. Set by
   * `STTArchive.getTileIdsInBoundsForTemporalLod` on the ids it returns;
   * absent = the base tier.
   *
   * Load-bearing for identity: a LOD tile shares `z/x/y/t` with the base
   * tile whose bucket starts at the same instant but holds different bytes,
   * so a key that drops `bucketMs` merges the two tiers. Derive every such
   * key with `tileKey()` (`tile-key.ts`), which is the only producer of the
   * format and folds the tier in — hand-assembling one re-opens the
   * collision.
   */
  bucketMs?: number;
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

/**
 * Codec tag for a tile payload, package-local.
 *
 * These numbers are NOT a wire contract. No live STT format stores a
 * compression byte: a packed archive names its codec as a string in
 * `manifest.json` (`"zstd"` | `"none"`), and that enum in
 * `docs/spec/manifest.schema.json` is the real contract. `STTArchive` maps the
 * manifest string onto these values at open; from there they travel no further
 * than the postMessage handing a blob to the decoder worker. The Rust
 * `Compression` enum carries no discriminants at all, so the two languages
 * agree on codec *names* and never on numbers.
 *
 * `1` is skipped rather than assigned — it was gzip's tag in the single-file
 * `.stt` archive, and leaving it unassigned keeps a salvaged legacy byte from
 * decoding as a live codec. See `compression.ts` for the full account.
 */
export enum Compression {
  None = 0,
  Zstd = 2,
}

/** Geometry type */
export enum GeometryType {
  Point = 0,
  LineString = 1,
  Polygon = 2,
}

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
  /**
   * How base-tier features are distributed across zooms (DT-1). Absent =
   * `'replicated'` = today's behaviour. `'home-zoom'` archives MUST also
   * declare the `additive-partition` capability, so a reader that does not
   * understand the partition refuses at open rather than silently rendering a
   * sparse per-zoom slice as if it were complete.
   */
  partition?: ArchivePartition;
  /**
   * Optional bake-time HeatmapLayer intensity-domain entries. When set,
   * the deck.gl/maplibre HeatmapLayer skips its [0, 1] default and uses
   * these per-class domains — vital for weighted heatmaps where the
   * configured `weightProperty` carries large values (earthquake
   * magnitudes, AIS speed, etc.).
   */
  heatmapDomain?: HeatmapDomain;
  /**
   * Optional bake-time style hints (measured value percentiles, suggested
   * ramp domains, playback duration, layer kind). These are build-time-
   * measured DEFAULTS only — layer props / spec / user config always
   * override them. Absent for archives built before the hints were added.
   */
  styleHints?: StyleHints;
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
  /** Directory/manifest variant that stores this summary representation. */
  variantId: number;
  scheme: SummaryScheme;
  minZoom: number;
  maxZoom: number;
  cellResolutionPerZoom: number[];
  columns: SummaryColumn[];
  layerName: string;
  /**
   * Number of fine-grained sub-buckets per outer time-bucket. When > 1,
   * each cell row carries `bucket_0`..`bucket_<N-1>` numeric columns and
   * the renderer animates by switching which one drives the cell colour
   * — no data re-upload between frames. Defaults to 1 (legacy
   * single-count behaviour).
   */
  subBuckets: number;
}

/** What a reader may assume a declared tier's tiles CONTAIN (DT-1). */
export type TierContract = 'union' | 'reduced';

/** How a `reduced` tier was derived (DT-1). */
export type ReductionMethod = 'm4' | 'minmaxlttb';

/** How base-tier features are distributed across zooms (DT-1). */
export type ArchivePartition = 'replicated' | 'home-zoom';

/** One level of a temporal LOD pyramid. */
export interface TemporalLodLevel {
  bucketMs: number;
  maxZoomLevel: number;
  /**
   * Absent = `'union'` = the normative default: exactly the base features,
   * re-bucketed, with no reduction, aggregation or thinning.
   *
   * ⚠️ Normative reader rule (DT-1): a reader MUST NOT substitute a non-base
   * tier for base content unless it understands the declared `contract` (and
   * `method`, if reduced). An unrecognized value means "never substitute",
   * which keeps conservative-superset soundness.
   */
  contract?: TierContract;
  /** Reduction method; present only when `contract === 'reduced'`. */
  method?: ReductionMethod;
}

/**
 * One bake-time HeatmapLayer intensity-domain entry. The renderer pins
 * `colorDomain` to `[min, max]` whenever the FE channel-spec id (or `'default'`)
 * matches `id`, skipping any runtime auto-detect.
 */
export interface HeatmapClassDomain {
  /** Channel id (matches HeatmapChannelSpec.id, or `'default'` for unsplit). */
  id: string;
  /** Inclusive minimum splat intensity. */
  min: number;
  /** Inclusive maximum splat intensity (typically 95p of `weightProperty`). */
  max: number;
  /** Weight property the domain was computed from, if any. */
  property?: string;
}

/** Container for the bake-time HeatmapLayer domain metadata. */
export interface HeatmapDomain {
  classes: HeatmapClassDomain[];
}

/**
 * Build-time-measured style hint for one tile property. Every value here is
 * a DEFAULT measured by the writer over the whole dataset — layer props /
 * spec / user config always override it.
 *
 * Numeric properties carry the percentile fields plus {@link suggestedDomain};
 * categorical (string) properties carry only `name` + {@link cardinality}
 * (the numeric fields are absent, never null-filled).
 */
export interface PropertyStyleHint {
  /** Property (column) name the hint describes. */
  name: string;
  /** Measured minimum value (numeric properties only). */
  min?: number;
  /** Measured 50th-percentile value (numeric properties only). */
  p50?: number;
  /** Measured 90th-percentile value (numeric properties only). */
  p90?: number;
  /** Measured 95th-percentile value (numeric properties only). */
  p95?: number;
  /** Measured 97th-percentile value (numeric properties only). */
  p97?: number;
  /** Measured 99th-percentile value (numeric properties only). */
  p99?: number;
  /** Measured maximum value (numeric properties only). */
  max?: number;
  /**
   * Suggested color/size ramp domain: `[min, p97]` with each endpoint
   * rounded OUTWARD to 2 significant figures (bakes in the "clamp the ramp
   * at ~p97" convention so outliers don't wash out the ramp). A DEFAULT
   * only — always overridable.
   */
  suggestedDomain?: [number, number];
  /** Distinct-value count (categorical properties only). */
  cardinality?: number;
}

/**
 * Optional bake-time styling hints folded into the archive metadata
 * (`style_hints` on the wire). Everything here is a build-time-measured
 * DEFAULT the renderer / spec / user config can always override; archives
 * without the block behave exactly as before.
 */
export interface StyleHints {
  /** `style_hints` block schema version (currently 1). */
  version: number;
  /** Per-property measured hints. */
  properties: PropertyStyleHint[];
  /**
   * Suggested duration (seconds) for one full playback of the dataset's
   * time range, derived from its temporal bucket count. A DEFAULT only.
   *
   * The archive does not record WHICH formula produced the number, and a
   * reader must not care — two are in circulation. Today's default emission is
   * the legacy `clamp(round(sqrt(K)), 20, 90)`; `stt-build
   * --derived-playback-params` emits the frame-rate refit
   * `clamp(K/20, K/30, K/12)` clamped to `[5, 300]` instead (`K` = bucket
   * count). So the same dataset can legitimately carry different values across
   * two builds — that is a build-recipe difference, not drift.
   */
  suggestedPlaybackSeconds?: number;
  /**
   * Suggested resident/rolling loader window in MILLISECONDS: the widest
   * window the writer measured as affordable against a reference client byte
   * budget (256 MiB), capped at 24 native buckets and floored at one. On the
   * wire this is `suggested_time_window_ms` inside the `style_hints` block;
   * `parseStyleHints` (archive.ts) is the one hop that renames it.
   *
   * NOT emitted by default. Only `stt-build --derived-playback-params`
   * produces it, and only on the in-memory pipeline (a `--streaming` build
   * totals no payload bytes, so it has no `β̄` to measure). Every archive in
   * the published fleet predates the flag, so treat this as usually-absent and
   * never make a reader path depend on its presence.
   *
   * A DEFAULT only, and specifically a *default*, not an override — an
   * authored `timeWindow` still beats it (see
   * `@poopdeck.gl/playback`'s `resolvePlaybackParams`). Archives without the
   * field keep the bucket-derived default exactly as before.
   */
  suggestedTimeWindowMs?: number;
  /** Suggested primary layer kind for the dataset. A DEFAULT only. */
  layerHint?: 'points' | 'paths' | 'trips' | 'polygons';
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

/** 2D position [lon, lat] */
export type STTPosition2D = [number, number];

/** 3D position [lon, lat, altitude] */
export type STTPosition3D = [number, number, number];

/**
 * A tile-space coordinate: 2D or 3D.
 *
 * Prefixed because `@deck.gl/core` also exports a `Position`, and it is NOT the
 * same type — deck's is broader (`Readonly<[number, number]> | Readonly<[number,
 * number, number]> | Readonly<Float32Array> | Readonly<Float64Array>`). Two
 * different types under one name in the packages an app imports together is the
 * collision worth spending a rename on.
 */
export type STTPosition = STTPosition2D | STTPosition3D;

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

  /**
   * Start index for each RING's positions, for Polygon geometries only.
   * Length = totalRingCount + 1 (last value is the total position count), so
   * ring `r` spans `[ringIndices[r], ringIndices[r + 1])` and every feature
   * boundary in {@link startIndices} also appears here.
   *
   * `startIndices` collapses a feature's rings into one flat run, which is all
   * the fill path needs (the exterior/hole structure rides the pre-baked
   * `triangles`). Consumers that walk EDGES — extruded side walls, per-ring
   * outlines — need the ring breaks too, or they stitch a spurious edge from
   * the last vertex of one ring to the first vertex of the next.
   *
   * Absent for non-polygon geometries (and for polygon tiles decoded by
   * readers predating this column).
   */
  ringIndices?: Uint32Array;

  /**
   * Start index for each PART's positions, for Polygon geometries only — the
   * MultiPolygon boundaries the wire geometry cannot express.
   *
   * Same units and convention as {@link ringIndices}: GLOBAL vertex
   * (coordinate-pair) indices rebased to the layer's first vertex, length =
   * totalPartCount + 1 (the last value is the total position count), so part
   * `p` spans `[partIndices[p], partIndices[p + 1])`. Every feature boundary in
   * {@link startIndices} also appears here (a feature's part 0 starts at its
   * first ring), and every part boundary is also a ring boundary in
   * {@link ringIndices} — the three are nested, coarsest to finest:
   * feature ⊇ part ⊇ ring.
   *
   * Why it exists: `geoarrow.polygon` is `List<List<FixedSizeList>>`, i.e. ONE
   * flat ring list per feature (exterior first, then holes). The builder
   * flattens a MultiPolygon's parts into that same list, after which
   * part-vs-hole is unrecoverable — ring 2 of a two-part feature is that
   * part's EXTERIOR, but every conformant GeoArrow consumer reads it as a hole
   * of part 1. Consumers that care about the distinction (winding-order fixes,
   * per-part fills, hole subtraction, GeoJSON/GeoParquet round-trips) need
   * this array.
   *
   * ABSENT means every feature in the layer is single-part — the encoder omits
   * the underlying `part_offsets` column entirely in that case, so absence is
   * information, not a gap. It is also absent for non-polygon geometries and
   * for polygon tiles decoded by readers predating this column.
   */
  partIndices?: Uint32Array;

  /**
   * Coordinate-quantization step `[sx, sy]` in DEGREES, when the source layer
   * stored fixed-point grid indices (`stt:quant`) rather than Float64 lon/lat.
   * Positions are always dequantized to real lon/lat before they reach here;
   * this records the grid resolution they snapped to, so consumers that need
   * to recognise a coordinate as "on" a known line (e.g. a tile boundary the
   * builder clipped against) know the tolerance to allow. Absent when the
   * layer's coordinates are full-precision Float64.
   */
  coordQuantStep?: [number, number];

  /**
   * Per-feature IDs, narrowed to 32 bits as `id & 0xffffffff`.
   *
   * ⚠️ This is a MASKED LOW HALF, not an identity. It is a valid identifier
   * only for archives whose ids all fit in 32 bits. For anything wider — H3 cell
   * indices at resolution ≥ 7, every Quadbin id — distinct cells collide here,
   * and {@link featureIds64} is the only correct source. Do not use this as a
   * dedupe key, a picking-map key, or a cross-tile identity without first
   * establishing that the archive's id domain is 32-bit.
   *
   * (Before the masking fix this field was computed as `Number(bigint)`, which
   * rounds through f64 BEFORE the `Uint32Array` store — so above 2⁵³ the stored
   * bits were not even a truncation, they were garbage: Quadbin
   * `0x4CFFFFFFFFFFFFFF` landed on `0` rather than `4294967295`. Any code or
   * comment predating that fix which describes this field as a faithful low-half
   * mirror was wrong twice over.)
   *
   * Materialized LAZILY — see `materializeFeatureIds` in `tile.ts` for the
   * contract. A consumer that only ever reads {@link featureIds64} never pays
   * for it.
   */
  featureIds: Uint32Array;

  /**
   * Full-precision 64-bit feature IDs, verbatim from the archive's Arrow UInt64
   * `id` column — the authoritative identity whenever it is present.
   *
   * Present for EVERY tile whose `id` column decoded as UInt64, which in
   * practice is nearly all of them; it is not reserved for archives that
   * "need" the width. Mandatory for H3 resolution ≥ 7 and for all Quadbin
   * schemes, where {@link featureIds} collides.
   */
  featureIds64?: BigUint64Array;

  /**
   * Global feature IDs for cross-tile feature identification.
   *
   * ⚠️ Currently vestigial: no writer in this repo emits it and no reader
   * consumes it, so it is always `undefined` in practice. Cross-tile identity
   * today rides {@link featureIds64}. Kept because the wire format reserves the
   * concept; treat a non-undefined value as authoritative if one ever appears.
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
   * Per-vertex scalar values (optional), e.g. sea-surface temperature for the
   * ocean-drifter dataset. When present, has the same length as the total
   * vertex count and aligns 1:1 with `positions` (like {@link vertexTimestamps}).
   * `NaN` marks a vertex with no value. AnimatedTripsLayer maps these through a
   * color ramp to shade the line by the value along its length.
   */
  vertexValues?: Float32Array;

  /**
   * Per-vertex × per-time-bucket value matrix (optional), flattened globally
   * **vertex-major**: `vertexValueMatrix[globalVertex * vertexValueBuckets +
   * bucket]`, aligned 1:1 with `positions` per bucket. Lets a static-geometry
   * overview (flow corridors) carry a per-vertex time series so the renderer
   * animates by selecting the active bucket column from the playhead — geometry
   * stays resident, only the playhead moves. See {@link vertexValueBuckets}.
   */
  vertexValueMatrix?: Float32Array;

  /**
   * Number of time buckets packed into {@link vertexValueMatrix} (0 when the
   * tile carries no matrix). The bucket axis is global across the dataset;
   * `bucket0` / `bucketWidth` are derived per feature from `startTimes` /
   * `endTimes` and this count.
   */
  vertexValueBuckets?: number;

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
  categoricalProps: Record<
    string,
    {
      /**
       * Per-feature index into `categories`. Uint16Array supports up to 65535
       * categories. Archives built before the u16 widening are normalized from
       * the legacy single-byte field into a Uint16Array on decode.
       */
      indices: Uint16Array;
      categories: string[];
    }
  >;

  /**
   * True when this tile's rows are stable-sorted by `start_time` — declared
   * by the packed formatVersion-3 frame's `TILE_META.sorted` flag (spec
   * §5.2.3), enabling window slicing / future partial decode. `undefined`
   * for v1 tiles and synthetic fixtures: per the spec, readers MUST NOT
   * assume sortedness without the flag.
   */
  timesSorted?: boolean;

  /**
   * Interleaved fixed-width vector properties — `FixedSizeList<Float32|UInt8, N>`
   * columns baked at build time (e.g. a `[qx,qy,qz,qw]` surfel quaternion, a
   * `[s_major,s_minor]` scale, an `[r,g,b,a]` colour). The `value` typed array is
   * the contiguous, row-major child buffer (feature `i` occupies `[i*size,
   * (i+1)*size)`), surfaced **zero-copy** so the renderer binds it straight to a
   * deck.gl instanced attribute with NO per-point re-interleave on the main
   * thread. `Float32Array` for `f32` leaves, `Uint8Array` (bind as `normalized`)
   * for `u8` colour leaves.
   *
   * Optional only so hand-built fixtures can omit it; `decodeTile` always sets
   * it (empty when the tile carries no FixedSizeList columns).
   */
  vectorProps?: Record<
    string,
    { value: Float32Array | Uint8Array; size: number }
  >;
}

/**
 * The v2 `TILE_META` section: per-tile-varying metadata hoisted out of the
 * (dataset-constant, template-resident) Arrow schema. Canonical JSON, keys
 * sorted, no whitespace; unknown keys MUST be ignored (spec §5.2.2).
 */
export interface TileMetaJson {
  /**
   * Compact `end_time` encoding — the `time-delta` capability. `'dur32'`: the
   * column is a non-null `UInt32` DURATION against each feature's own start.
   * `'zero'`: the column is OMITTED entirely (`end === start` for every
   * feature). Absent ⇒ the historical absolute `Int64` column.
   */
  et?: 'dur32' | 'zero';
  /** Attribute-quant affines, `column → [o, s]` (v1 `stt:qa`). */
  qa?: Record<string, [number, number]>;
  /** Rows are stable-sorted by `start_time` (spec §5.2.3). */
  sorted?: boolean;
  /**
   * Compact `start_time` encoding — the `time-delta` capability. `'u32'`: the
   * column is a non-null `UInt32` MILLISECOND OFFSET from {@link t0} (which is
   * therefore mandatory, not an optimization). Absent ⇒ absolute `Int64`.
   */
  st?: 'u32';
  /** Minimum feature start-time (v1 `stt:time_offset_ms`). */
  t0?: number;
  /** Vertex-value matrix bucket count (v1 `stt:vertex_value_buckets`). */
  vb?: number;
  /**
   * Per-vertex value quantization affines, `column → [o, s]`
   * (`value = o + q*s`) — the `vertex-value-quant` capability. Keys are a
   * subset of `{'vertex_value', 'vertex_value_matrix'}`: whichever of the two
   * ships its list leaf as `UInt16` indices rather than `Float32` on this
   * tile. The reserved index `0xFFFF` decodes to `NaN` (the format's "this
   * vertex has no value" marker). Absent ⇒ raw `Float32` leaves.
   */
  vq?: Record<string, [number, number]>;
  /** `[origin_ms, step_ms]` (v1 `stt:vertex_time_origin_ms`/`_step_ms`). */
  vt?: [number, number];
  /**
   * `step_ms` for the FEATURE-ANCHORED per-vertex time form (TB-11 extension
   * 2, `stt:vertex_time_feature_step_ms`): deltas measured from each feature's
   * own `start_time` rather than a layer-wide origin, which keeps trip-shaped
   * layers in `UInt16` at exact millisecond precision.
   *
   * There is no companion origin — the anchor is the `start_time` column. A
   * distinct key rather than a reshaped {@link vt} so a reader lacking the
   * branch refuses the archive on the `vertex-time-feature-anchor` capability
   * instead of resolving the deltas against an origin it invented. Mutually
   * exclusive with `vt`.
   */
  vtf?: number;
}

/**
 * One decoded layer within a tile — binary (GPU-ready) typed arrays plus the
 * Arrow table they came from.
 *
 * Named `STTTileLayer`, not `Layer`: `@deck.gl/core` exports a `Layer` CLASS
 * (the base every deck layer extends), and importing both into one module is a
 * hard duplicate-identifier error — which is why every consumer in this repo
 * had to write `import { STTTileLayer as TileLayer }`.
 */
export interface STTTileLayer {
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
   * {@link import('./tile.js').toGeoArrowTable}) without re-encoding the
   * typed arrays in {@link BinaryFeatures}.
   *
   * Optional because the worker-pool decoder strips `arrowTable` before
   * postMessage (the `Table` class is not structured-cloneable) — on that
   * path {@link arrowIpc} carries the layer instead and
   * `toGeoArrowTable()` rehydrates the Table lazily on first use.
   */
  arrowTable?: import('apache-arrow').Table;
  /**
   * The layer's raw Arrow IPC stream bytes, verbatim from the decoded tile
   * payload. Unlike {@link arrowTable} this IS structured-cloneable (and
   * transferable), so it survives the worker→main postMessage boundary —
   * it's what lets `toGeoArrowTable()` work for worker-decoded tiles by
   * re-parsing lazily on first call (the result is memoized back into
   * {@link arrowTable}). Usually a view into the same buffer as the
   * layer's typed-array columns.
   */
  arrowIpc?: Uint8Array;
  /**
   * packed formatVersion 3 only: the layer's spliced PROPS Arrow IPC stream
   * (property columns ride their own schema/template in a v2 frame — spec
   * §5.2). Present iff the layer has property columns; {@link arrowIpc} then
   * holds the spliced CORE stream and `toGeoArrowTable()` re-merges the two
   * when rehydrating a worker-decoded layer. Dropped together with
   * {@link arrowIpc} under `ArchiveOptions.retainArrowIpc`.
   */
  arrowIpcProps?: Uint8Array;
  /**
   * packed formatVersion 3 only: the layer's parsed `TILE_META` section
   * (spec §5.2.2). Plain JSON — unlike {@link arrowTable} it survives the
   * worker→main postMessage boundary — so `toGeoArrowTable()` can re-inject
   * the hoisted per-tile metadata (`stt:qa` / `stt:time_offset_ms` /
   * `stt:vertex_*`) into a rehydrated Table's schema exactly like the
   * inline decode path (and Rust's `merge_v2_layer`) does. Absent on v1
   * layers, whose schemas carry the keys on the wire already.
   */
  tileMeta?: TileMetaJson;
  /**
   * Set when the archive dropped this layer's {@link arrowIpc} (and
   * {@link arrowTable}) reference per `ArchiveOptions.retainArrowIpc` —
   * distinguishes "dropped to save memory" (a clear, actionable
   * `toGeoArrowTable()` error naming the option) from "never had one"
   * (synthetic test layers).
   */
  arrowIpcDropped?: boolean;
  /**
   * True when the layer's geometry leaf is `stt:quant` fixed-point `Int32`
   * grid indices rather than Float64 lon/lat — i.e. the layer is NOT literal
   * GeoArrow (a generic consumer would misread the coordinates). This is the
   * semantic signal `ArchiveOptions.retainArrowIpc: 'auto'` keys on when
   * deciding to drop the IPC bytes.
   */
  coordinatesQuantized?: boolean;
}

/** Decoded tile with binary features */
export interface Tile {
  id: TileId;
  timeRange: TimeRange;
  layers: STTTileLayer[];
}

export interface TileEntry {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  /** Independently addressable payload representation. */
  variantId: number;
  /**
   * Which packed-format object (`manifest.packs[packId]`) holds this tile's
   * blob. `offset`/`length` are relative to that pack. Always `0` for an
   * archive read from a single implicit pack (v4 directory, single-file).
   */
  packId: number;
  offset: number;
  length: number;
  featureCount: number;
  compression: Compression;
  uncompressedSize: number;
  /**
   * CRC-32C (Castagnoli) of the blob's compressed bytes, from the directory.
   * Verified before decompression.
   * `0` (the TS `encodeDirectory` default for synthetic archives) means "no
   * checksum recorded" and skips verification; `undefined` for hand-built
   * test entries behaves the same.
   */
  crc32c?: number;
  /**
   * Temporal bucket size in milliseconds this tile spans.
   *
   * `undefined` when the archive predates the temporal-LOD scaffold (the
   * directory column isn't present); the reader treats those tiles as
   * belonging to the archive's base `temporalBucketMs`. LOD-aware archives
   * always populate this so a reader can dispatch on bucket size.
   */
  temporalBucketMs?: number;
  /**
   * Tight lower covering bound — the earliest feature *start* time actually in
   * the tile (vs `timeStart`, the addressable bucket edge, which can be far
   * earlier). Lets the reader skip a tile whose data lies entirely after a query
   * window without fetching it. `undefined` for archives with no covering
   * section (repacked/transcoded or pre-covering builds) → fall back to
   * `timeStart`.
   */
  coverTMin?: number;
}

/**
 * Exact directory-priced cost of a tile selection — what
 * `STTArchive.estimateSelectionCost` answers for one
 * (bounds × zoom × time-window × tier) query.
 *
 * `unknownTiles` is the HONESTY CHANNEL, and it rides in the return type
 * precisely so a caller cannot forget to look at it. The reader knows a tile's
 * compressed length only once the directory leaf holding it is resident; on a
 * paged archive a leaf whose root descriptor intersects the query but has not
 * been fetched CANNOT be priced. Those entries are counted here — never
 * estimated, never extrapolated from the priced ones. So:
 *
 *   - `unknownTiles === 0` → `bytes` is exact for the queried selection.
 *   - `unknownTiles > 0`   → `bytes` is a LOWER BOUND. Treat the answer as
 *     unusable for gating and fall back to whatever the caller did before it
 *     could ask (the same abstention the playback governor applies to blind
 *     byte totals).
 *
 * This mirrors, at the directory level, the rule the whole reader follows:
 * an unknown quantity is reported as unknown, not guessed at.
 */
export interface SelectionCost {
  /**
   * Σ compressed `length` over every matching directory entry the reader can
   * actually see. Never includes a guess for a non-resident leaf.
   */
  bytes: number;
  /** How many matching entries were priced into {@link bytes}. */
  tiles: number;
  /**
   * Entries the query could not price, as an UPPER bound: the sum of
   * `entryCount` over every non-resident leaf page whose descriptor intersects
   * the query. Descriptors carry no per-entry time/variant detail, so some of
   * those entries would not have matched the query's filters — hence an upper
   * bound rather than an exact count. `Infinity` when the directory itself is
   * not open yet (the count of unknowns is then itself unknown), and `0` for
   * every fully-resident (single or whole-loaded) directory.
   */
  unknownTiles: number;
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

/**
 * loaders.gl-style load options. Only the `fetch` key is consumed:
 *
 * - **Object form** (`RequestInit`): merged into every HTTP request the
 *   archive makes — manifest, directory, and pack range reads — for auth
 *   headers, credentials, CORS mode, etc. Per-request fields (the `Range`
 *   header, abort signal, fetch priority) always win on conflict.
 * - **Function form** (fetch-like): a drop-in transport replacement,
 *   equivalent to {@link ArchiveOptions.fetch} — which takes precedence
 *   when both are provided.
 *
 * Other keys are accepted (loaders.gl callers pass rich option bags) but
 * ignored by the archive reader.
 */
export interface SttLoadOptions {
  fetch?: RequestInit | typeof fetch;
  [key: string]: unknown;
}

/** Options for archive reader */
export interface ArchiveOptions {
  /** Base URL for the archive */
  url: string;
  /** Custom fetch function (for adding auth headers, etc.) */
  fetch?: typeof fetch;
  /** loaders.gl-style options; see {@link SttLoadOptions} for what is consumed. */
  loadOptions?: SttLoadOptions;
  /**
   * Override the tile decoder. Defaults to a worker-pool decoder in browsers
   * that support module workers, inline decoding elsewhere (Node tests,
   * SSR). Pass an InlineTileDecoder to force inline decoding even in the
   * browser — useful for debugging or environments that block workers.
   */
  decoder?: import('./tile-decoder.js').TileDecoder;
  /**
   * Whether decoded layers keep their raw Arrow IPC bytes (`STTTileLayer.arrowIpc` /
   * `STTTileLayer.arrowTable`) for lazy `toGeoArrowTable()` rehydration:
   *
   * - `'auto'` (**default**): SEMANTIC — drop the reference only for
   *   coordinate-quantized layers (`stt:quant`), whose tables are not
   *   literal GeoArrow anyway (a generic consumer misreads Int32 grid
   *   indices as lon/lat, so the hand-off was never spec-valid there);
   *   keep it for every layer where `toGeoArrowTable()` is actually valid,
   *   including legacy unaligned-frame archives whose columns are copies.
   * - `true`: always keep — required if you call `toGeoArrowTable()` on
   *   quantized archives and are prepared to handle the Int32 leaf.
   * - `false`: always drop — smallest memory, `toGeoArrowTable()` throws.
   *
   * `toGeoArrowTable()` on a dropped layer throws an error naming this
   * option.
   */
  retainArrowIpc?: boolean | 'auto';
  /**
   * Maximum compressed tile payloads retained by this archive in memory.
   * Defaults device-adaptively to 100–500. Pass `0` to disable the compressed
   * cache when a decoded tileset cache already owns the working set.
   */
  maxCacheTiles?: number;
  /**
   * Maximum compressed bytes retained by this archive. Defaults to 256 MiB on
   * constrained/mobile devices and 512 MiB otherwise. A process-wide budget
   * applies across all archives as an additional ceiling. Pass `0` to disable.
   */
  maxCacheBytes?: number;
  /**
   * Enable the OPFS-backed persistent tile cache.
   *
   * **Defaults to `false`** everywhere (including browsers that expose
   * `navigator.storage.getDirectory`) — persistence is strictly opt-in.
   * When enabled, decompressed tile payloads are stored under the Origin
   * Private File System keyed by `(url, tileId, archiveFingerprint)`. On a
   * tab reload the cache survives, so re-rendering the same viewport skips
   * both the HTTP range request AND the zstd decompress step — only the
   * Arrow IPC parse runs.
   *
   * Only enable this when the archive fits comfortably in
   * `opfsCacheMaxBytes` AND users revisit the same viewport across reloads.
   * The default decoders hand their decompressed bytes back to the cache
   * writer (no duplicate decompress); a custom {@link decoder} that ignores
   * `DecodeArgs.onPayload` falls back to one extra decompress per cold tile.
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
  opfsCacheImpl?: import('./opfs-cache.js').OpfsTileCache;
  /**
   * Max gap (bytes) between two tile byte-ranges that `getTiles` will still
   * bridge into ONE coalesced HTTP range request. Over-fetching the gap
   * trades wasted bytes (≈free on R2: free egress) for one fewer ~60 ms RTT,
   * so the break-even is large (~bandwidth × RTT ≈ multiple MB). Comparable
   * cloud readers (Apache Arrow `object_store`, obstore) default to ~1 MB;
   * the old STT default of 32 KB was ~30× too conservative.
   *
   * **Defaults to 2 MB.** On free-egress storage (R2) the gap bytes are free,
   * so a wider gap fuses more neighbours into fewer billed GETs — notably
   * collapsing a globe view's many per-cell requests. Lower it on metered-
   * egress hosts or very sparse archives where the bridged bytes are wasted.
   */
  coalesceGapBytes?: number;
  /**
   * Max number of concurrent HTTP range requests `getTiles` keeps in flight
   * for a single batch. After coalescing, a viewport×window usually collapses
   * to a handful of byte-ranges; this only bounds the pathological sparse case
   * (many non-adjacent blobs) so it can't exceed an object store's per-
   * connection stream cap (Cloudflare R2 closes the connection at ~75 streams).
   *
   * **Defaults to 24.**
   */
  maxConcurrentRequests?: number;
  /**
   * Backoff schedule (ms) for retrying a failed HTTP range request. The
   * array length is the retry count; each delay is jittered ±50% before
   * sleeping. Aborted requests are never retried. Tests can pass `[0, 0]`
   * (or `[]` to disable retries entirely).
   *
   * **Defaults to `[250, 1000]`** — 2 retries with exponential backoff.
   */
  retryDelaysMs?: number[];
  /**
   * Per-transfer stall timeout (ms) applied to every HTTP fetch the archive
   * makes — manifest, directory, and pack range reads. A response that
   * neither completes nor errors within the window (TCP stall, dead proxy)
   * is aborted with a `TimeoutError` and treated as a TRANSIENT failure:
   * it retries per `retryDelaysMs` like any 5xx. Caller aborts are
   * unaffected (they propagate immediately, never retried).
   *
   * **Defaults to 20000** (hls.js `fragLoadingTimeOut` parity). Pass `0`
   * to disable the watchdog entirely.
   */
  transferTimeoutMs?: number;
  /**
   * Paged-directory whole-load cutoff (bytes). A paged `.sttd` whose at-rest
   * size is ≤ this is fetched in one GET and fully decoded (no extra request,
   * no incremental bookkeeping) — small datasets behave like a single
   * whole-load directory. Above it, only the root page is fetched up front and
   * leaf pages stream in on demand as the viewport/time-window moves.
   * No effect on single (non-paged) directories.
   *
   * **Defaults to 262144 (256 KiB).** Pass `0` to always page (stream every
   * leaf on demand, even for tiny directories).
   */
  directoryPageThresholdBytes?: number;
  /**
   * Relative weight of THIS archive for the process-shared request scheduler's
   * weighted-fair (Deficit-Round-Robin) slot share when several archives
   * composite into one scene (multi-source coordination, Phase 2). Higher
   * weight ⇒ a larger share of the global concurrency budget when archives
   * contend; an idle archive's share is reclaimed (work-conserving), so a SINGLE
   * archive always gets the whole budget regardless of weight.
   *
   * **Defaults to 1.**
   */
  schedulerWeight?: number;
}

/** Options for tile requests */
export interface TileRequestOptions {
  /** Abort signal for canceling requests */
  signal?: AbortSignal;
  /** Priority (higher = more important) */
  priority?: number;
  /**
   * Incremental delivery for `getTiles()` batches: called with `(index, tile)`
   * — index into the input `ids` array — as EACH tile finishes decoding,
   * before the batch promise resolves. A coalesced batch fetches its range
   * groups concurrently, so without this every member is held hostage until
   * the slowest range request lands; with it, callers can render/mark tiles
   * the moment their own group arrives. Tiles that resolve to `null`
   * (missing / failed) are never delivered here — they stay `null` in the
   * resolved array.
   */
  onTileReady?: (index: number, tile: Tile) => void;
  /**
   * Browser fetch-priority hint (`RequestInit.priority`) applied to the
   * request's HTTP fetches. Lookahead traffic should pass `'low'` so the
   * browser's connection scheduler favors concurrent need-now fetches.
   */
  fetchPriority?: 'high' | 'low' | 'auto';
  /**
   * Current play-head time (sim-ms, in the same time domain as a tile's
   * `timeStart`) for the process-shared scheduler's cross-source
   * earliest-deadline-first (EDF) priority (multi-source coordination,
   * docs/roadmap/playback-and-loading.md §5). When set, each coalesced
   * range-group is prioritized by its
   * members' minimum distance-to-playhead — comparable ACROSS archives because
   * they share one playhead — so the most-imminent data loads first globally,
   * not just within one source. Omit it and the scheduler falls back to a
   * per-archive nearest-first sequence (tier-correct, but not true cross-source
   * EDF within a tier). The {@link fetchPriority} tier still dominates: a
   * `'low'` (prefetch) group never outranks an `'auto'`/`'high'` (need-now)
   * group of any source.
   */
  playheadTime?: number;
  /**
   * Play-head travel direction (+1 forward / -1 backward) paired with
   * {@link playheadTime}. Data BEHIND the play-head in the travel direction is
   * deprioritized (the play-head has already passed it). Defaults to forward
   * (+1) when omitted but `playheadTime` is set.
   */
  playheadDirection?: 1 | -1;
  /**
   * Current viewport center (geographic). When set, the scheduler adds a
   * small spatial tie-break to each coalesced range-group's priority — the
   * squared normalized-mercator distance from the group's nearest member's
   * tile center to this point, weighted well under one tier/EDF unit (see
   * `SPATIAL_TIEBREAK_WEIGHT` in archive.ts). It can only ever resolve
   * requests that are ALREADY essentially tied in time (or, absent a
   * play-head, never — enqueue-order ties don't happen), never override a
   * real temporal/tier distinction. Mirrors MapLibre's `coveringTiles()`
   * sorting ideal tiles by `distanceSq` from the camera-projected center, so
   * equally-urgent tiles still resolve screen-center-first. Omit it and
   * priority is unaffected (byte-for-byte the pre-existing behavior).
   */
  viewportCenter?: { lon: number; lat: number };
}
