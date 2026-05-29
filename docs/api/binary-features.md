# Binary Features Format

GPU-optimized binary columnar representation that the tile decoder produces.
This format aligns with deck.gl's binary data interface and loaders.gl's
`BinaryFeatures` specification, with STT-specific temporal extensions.

It's what every `Tile.layers[i].features` value carries — the deck.gl
layers in `@stt/deck.gl` consume it directly, and so do the
`@stt/maplibre` adapters.

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
   * Line / polygon feature boundaries.
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
   * AnimatedTripsLayer uses this for accurate "vehicle at position"
   * animation instead of linear start/end interpolation.
   */
  vertexTimestamps?: Float32Array;

  /* ───── Pre-tessellated polygons (--pre-tessellate) ─────────────── */

  /** Tile-global earcut indices. Groups of 3 per triangle. */
  triangles?: Uint32Array;

  /** Per-feature offsets into `triangles`. Length = featureCount + 1. */
  triangleOffsets?: Uint32Array;

  /* ───── Properties ──────────────────────────────────────────────── */

  /** One Float32Array per numeric property, length = featureCount. */
  numericProps: Record<string, Float32Array>;

  /** Categorical properties as indices into a per-tile lookup. */
  categoricalProps: Record<string, {
    /** Uint16 supports up to 65535 categories per property per tile. */
    indices: Uint16Array;
    categories: string[];
  }>;
}
```

## Why a custom binary shape

1. **Zero-copy GPU upload**: typed arrays go straight to GPU buffers.
2. **Cache-friendly**: columnar layout iterates fast.
3. **Transferable**: typed-array buffers transfer (not copy) from the
   worker decoder to the main thread.
4. **Bake-time tessellation**: when an archive is built with
   `--pre-tessellate`, polygon triangles arrive ready to draw — the
   renderer never runs earcut at tile-arrival time.

## Float32 precision

`startTimes`, `endTimes`, and `vertexTimestamps` are stored relative to a
per-tile `timeOffset` so they fit within f32's exactly-representable
integer range. The `TimeFilterExtension` applies the same offset to its
`currentTime` shader uniform; if you build a custom layer, pass
`tile.timeOffset` through unchanged.

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

## Source

Defined in [`packages/core/src/types.ts`](../../packages/core/src/types.ts);
constructed by the decoder in
[`packages/core/src/tile.ts`](../../packages/core/src/tile.ts).
