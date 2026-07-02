# Binary Features Format

GPU-optimized binary columnar representation that the tile decoder produces.
This format is modeled on deck.gl's binary data interface and loaders.gl's
`BinaryFeatures` specification, with STT-specific temporal extensions (and a
few deliberate divergences — see "loaders.gl alignment caveats" below).

It's what every `Tile.layers[i].features` value carries — the deck.gl
layers in `@poopdeck.gl/layers` consume it directly, and so do the
`@poopdeck.gl/maplibre` adapters.

## Shape

```typescript
interface BinaryFeatures {
  featureCount: number;
  geometryType: GeometryType;       // 0=Point, 1=LineString, 2=Polygon

  /** 2 for [lon, lat], 3 for [lon, lat, alt]. Defaults to 2. */
  positionDimensions?: 2 | 3;

  /** Interleaved [lon, lat, ...] (or [lon, lat, alt, ...] in 3D). */
  positions: Float64Array;

  /**
   * Per-FEATURE vertex boundaries for lines/polygons.
   * Length = featureCount + 1, last value = total position count.
   * Pass to deck.gl PathLayer/PolygonLayer as `startIndices`.
   */
  startIndices?: Uint32Array;

  featureIds: Uint32Array;

  /**
   * Optional full-precision 64-bit feature IDs, preserved verbatim from the
   * archive's Arrow UInt64 `id` column. Present when the archive needs
   * full-width IDs (e.g. H3 cell indices at resolution ≥ 7).
   */
  featureIds64?: BigUint64Array;

  globalFeatureIds?: Uint32Array;

  /* ───── Temporal extensions ─────────────────────────────────────── */

  /** Per-feature start/end, relative to timeOffset (ms). */
  startTimes: Float32Array;
  endTimes:   Float32Array;

  /** Absolute time = startTimes[i] + timeOffset. */
  timeOffset: number;

  /**
   * Per-vertex timestamps for LineStrings, relative to timeOffset.
   * Aligns 1:1 with positions. AnimatedTripsLayer uses this for accurate
   * "vehicle at position" animation instead of linear start/end
   * interpolation; AnimatedTripHeadsLayer for the moving head-dot position.
   */
  vertexTimestamps?: Float32Array;

  /**
   * Per-vertex scalar values (e.g. sea-surface temperature on drifter
   * tracks). Aligns 1:1 with positions; NaN marks a vertex with no value.
   * AnimatedTripsLayer's gradientProperty maps these through a color ramp
   * to shade the line along its length.
   */
  vertexValues?: Float32Array;

  /**
   * Per-vertex × per-time-bucket value matrix, flattened globally
   * vertex-major: `vertexValueMatrix[globalVertex * vertexValueBuckets +
   * bucket]`. Lets a static-geometry overview (flow corridors) carry a
   * per-vertex time series — geometry stays resident, the renderer just
   * selects the active bucket column from the playhead.
   */
  vertexValueMatrix?: Float32Array;

  /** Number of time buckets packed into vertexValueMatrix (0 = no matrix). */
  vertexValueBuckets?: number;

  /* ───── Pre-tessellated polygons (--pre-tessellate) ─────────────── */

  /** Tile-global triangle indices. Groups of 3 per triangle. */
  triangles?: Uint32Array;

  /** Per-feature offsets into `triangles`. Length = featureCount + 1. */
  triangleOffsets?: Uint32Array;

  /* ───── Properties ──────────────────────────────────────────────── */

  /** One Float32Array per numeric property, length = featureCount. */
  numericProps: Record<string, Float32Array>;

  /** Categorical properties as indices into a per-tile lookup. */
  categoricalProps: Record<string, {
    /** Uint16; 0xffff is the null sentinel. Up to 65535 categories per property per tile. */
    indices: Uint16Array;
    categories: string[];
  }>;

  /**
   * Interleaved fixed-width vector columns — `FixedSizeList<Float32|UInt8, N>`
   * baked at build time with `--vector-group NAME=cols[:f32|u8]` (e.g. a
   * `[qx,qy,qz,qw]` surfel quaternion, or an `[r,g,b,a]` u8 colour). Each
   * `value` is the contiguous row-major child buffer — feature `i` occupies
   * `[i*size, (i+1)*size)` — surfaced zero-copy so the renderer binds it
   * straight to a deck.gl instanced attribute with no per-point re-interleave.
   * `Float32Array` for `f32` leaves, `Uint8Array` (bind as `normalized`) for
   * `u8` colour leaves. `decodeTile` always sets it (empty when the tile
   * carries no FixedSizeList columns).
   */
  vectorProps?: Record<string, { value: Float32Array | Uint8Array; size: number }>;
}
```

## Why a custom binary shape

1. **Zero-copy GPU upload**: typed arrays go straight to GPU buffers. The
   coordinate/index arrays are views into the tile's Arrow IPC buffer
   (archives written with the aligned layer frame place every IPC stream
   on an 8-byte boundary precisely so these views never copy).
2. **Cache-friendly**: columnar layout iterates fast.
3. **Transferable**: typed-array buffers transfer (not copy) from the
   worker decoder to the main thread — including `vertexValues` and the
   raw per-layer Arrow IPC bytes (`Layer.arrowIpc`).
4. **Bake-time tessellation**: when an archive is built with
   `--pre-tessellate`, polygon triangles arrive ready to draw — the
   renderer never runs earcut at tile-arrival time. The Rust writer stores
   feature-LOCAL indices; the decoder pre-shifts them by each feature's
   `startIndices[i]` so the buffer is directly drawable.

## Polygon rings

`startIndices` is **feature-level**: the decoder collapses the Arrow
polygon's two offset levels (feature → ring, ring → vertex) into one
per-feature vertex run. **Ring boundaries inside a feature are not
preserved** — there is no equivalent of loaders.gl's
`polygonIndices`/`primitivePolygonIndices` pair.

Consequences:

- For single-ring polygons (what `stt-build` typically emits) this is
  lossless.
- Polygons **with holes** only render correctly on the pre-tessellated
  path (`--pre-tessellate`), where hole-aware triangulation already
  happened at build time and ships in `triangles`. On the
  non-pre-tessellated path, a runtime tessellator sees the outer ring and
  holes as one vertex run and will mis-tessellate.

## loaders.gl alignment caveats

The shape is *inspired by* loaders.gl `BinaryFeatures`, not conformant:

- loaders.gl splits points/lines/polygons into three parallel objects;
  STT carries ONE geometry type per layer with a `geometryType` tag.
- loaders.gl positions are `{ value, size }` accessor objects; STT uses
  bare typed arrays plus `positionDimensions`.
- loaders.gl's `polygonIndices` vs `primitivePolygonIndices` ring
  distinction is absent (see above) — `startIndices` matches deck.gl's
  binary-attribute convention instead.
- `numericProps` values are plain `Float32Array`s, not `{ value, size }`
  wrappers.

If you need a standards-track hand-off instead, use
`toGeoArrowTable(layer)` (see [Tile decoding](./stt-loader.md)) — each
layer also carries its original GeoArrow record batch.

## Float32 precision

`startTimes`, `endTimes`, `vertexTimestamps` (and the comparison side of
every shader filter) are stored relative to a per-tile `timeOffset` so they
fit within f32's exactly-representable integer range. The
[`TimeFilterExtension`](./time-filter-extension.md) applies the same offset
to its `currentTime` uniform; if you build a custom layer, pass
`features.timeOffset` through unchanged.

## Using with deck.gl directly

```typescript
import { ScatterplotLayer } from '@deck.gl/layers';

const features = tile.layers[0].features;

new ScatterplotLayer({
  id: 'binary-points',
  data: {
    length: features.featureCount,
    attributes: {
      getPosition: {
        value: features.positions,
        size: features.positionDimensions ?? 2,
      },
    },
  },
  getRadius: 100,
});
```

For paths and polygons, pass `startIndices` plus the same `positions`:

```typescript
import { PathLayer } from '@deck.gl/layers';

new PathLayer({
  id: 'binary-paths',
  data: {
    length: features.featureCount,
    startIndices: features.startIndices,
    attributes: {
      getPath: { value: features.positions, size: 2 },
    },
  },
  getWidth: 2,
});
```

## Reading one feature back

The render path never materializes per-feature objects; for picking,
tooltips, and debugging use `getFeatureProperties(features, index)` from
`@poopdeck.gl/core` — it decodes ONE feature's columns into a plain object
(`id`, absolute `start_time`/`end_time`, every numeric and categorical
column; categorical nulls decode to `null`). Each `vectorProps` entry is
included too, materialized as a plain `number[]` of length `size` (e.g. a
4-element quaternion or RGBA array) rather than the zero-copy typed-array
slice the render path binds.

## Source

Defined in [`packages/core/src/types.ts`](../../packages/core/src/types.ts);
constructed by the decoder in
[`packages/core/src/tile.ts`](../../packages/core/src/tile.ts).
