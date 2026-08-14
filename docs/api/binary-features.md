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
  geometryType: GeometryType; // 0=Point, 1=LineString, 2=Polygon

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

  /**
   * Polygons only. Per-RING vertex boundaries — length = totalRingCount + 1,
   * so ring `r` spans [ringIndices[r], ringIndices[r + 1]). Every feature
   * boundary in `startIndices` also appears here.
   */
  ringIndices?: Uint32Array;

  /**
   * Polygons only. Per-PART (MultiPolygon) vertex boundaries, same units and
   * convention as `ringIndices`. ABSENT means every feature in the layer is
   * single-part — the encoder omits the underlying column in that case, so
   * absence is information, not a gap.
   */
  partIndices?: Uint32Array;

  /**
   * Coordinate-quantization step [sx, sy] in DEGREES, when the source layer
   * stored fixed-point grid indices (`stt:quant`). Positions are always
   * dequantized to real lon/lat before they reach here; this records the grid
   * resolution they snapped to, so a consumer that needs to recognise a
   * coordinate as "on" a known line (a tile boundary the builder clipped
   * against, say) knows the tolerance to allow. Absent for full-precision
   * Float64 coordinates.
   */
  coordQuantStep?: [number, number];

  /**
   * ⚠️ MASKED low 32 bits (`id & 0xffffffff`), NOT an identity. Valid only for
   * archives whose ids all fit in 32 bits. Materialized LAZILY.
   */
  featureIds: Uint32Array;

  /**
   * Full-precision 64-bit feature IDs, verbatim from the archive's Arrow
   * UInt64 `id` column — the authoritative identity whenever present, which
   * is for EVERY tile whose `id` column decoded as UInt64 (in practice nearly
   * all of them).
   */
  featureIds64?: BigUint64Array;

  /** ⚠️ Vestigial — never emitted, never read. Always `undefined` in practice. */
  globalFeatureIds?: Uint32Array;

  /* ───── Temporal extensions ─────────────────────────────────────── */

  /** Per-feature start/end, relative to timeOffset (ms). */
  startTimes: Float32Array;
  endTimes: Float32Array;

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

  /* ───── Pre-tessellated polygons ────────────────────────────────── */

  /** Tile-global triangle indices. Groups of 3 per triangle. */
  triangles?: Uint32Array;

  /** Per-feature offsets into `triangles`. Length = featureCount + 1. */
  triangleOffsets?: Uint32Array;

  /**
   * True when this tile's rows are stable-sorted by `start_time` — declared
   * by the packed formatVersion-3 frame's TILE_META `sorted` flag.
   * `undefined` for synthetic fixtures: per the spec, readers MUST NOT assume
   * sortedness without the flag.
   */
  timesSorted?: boolean;

  /* ───── Properties ──────────────────────────────────────────────── */

  /** One Float32Array per numeric property, length = featureCount. */
  numericProps: Record<string, Float32Array>;

  /** Categorical properties as indices into a per-tile lookup. */
  categoricalProps: Record<
    string,
    {
      /** Uint16; 0xffff is the null sentinel. Up to 65535 categories per property per tile. */
      indices: Uint16Array;
      categories: string[];
    }
  >;

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
  vectorProps?: Record<
    string,
    { value: Float32Array | Uint8Array; size: number }
  >;
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
4. **Bake-time tessellation**: polygon triangles can arrive ready to draw —
   the renderer never runs earcut at tile-arrival time. `stt-build` bakes
   them for a whole layer when `--pre-tessellate` is passed **or** when any
   feature in it is multi-ring. The Rust writer stores feature-LOCAL indices;
   the decoder pre-shifts them by each feature's `startIndices[i]` so the
   buffer is directly drawable.

## Feature identity: read `featureIds64`, not `featureIds`

`featureIds` is the **masked low half** of the archive's UInt64 `id` column
(`id & 0xffffffff`). It is a valid identifier **only** for archives whose ids
all fit in 32 bits. For anything wider — **H3 cell indices at resolution ≥ 7,
and every Quadbin id** (whose header and zoom bits live in the high half) —
distinct cells collide there and the discriminating bits are simply gone.
`featureIds64` is the only correct source.

Do not use `featureIds` as a dedupe key, a picking-map key, or a cross-tile
identity without first establishing that the archive's id domain is 32-bit.

Two further notes:

- **It is materialized lazily.** A consumer that only ever reads `featureIds64`
  never pays for the gather. (On a little-endian host the mask is a stride-2
  `Uint32Array` gather over the `BigUint64Array`'s own buffer, so no `BigInt`
  ever materialises: ~0.8 ms per million ids.)
- **Before the masking fix** this field was computed as `Number(bigint)`, which
  rounds through f64 _before_ the `Uint32Array` store — so above 2⁵³ the stored
  bits were not even a truncation, they were garbage (Quadbin
  `0x4CFFFFFFFFFFFFFF` landed on `0` rather than `4294967295`). Any code or
  comment predating that fix which describes this field as a faithful low-half
  mirror was wrong twice over.

`globalFeatureIds` is **vestigial**: no writer in this repo emits it and no
reader consumes it, so it is always `undefined` in practice. Cross-tile identity
rides `featureIds64`. The field is kept because the wire format reserves the
concept; treat a non-`undefined` value as authoritative if one ever appears.

## Polygon rings and parts

Three nested offset arrays, coarsest to finest — **feature ⊇ part ⊇ ring**:

- **`startIndices`** is **feature-level**: it collapses a feature's rings into
  one flat vertex run. That is all the _fill_ path needs, because the
  exterior/hole structure rides the pre-baked `triangles`.
- **`ringIndices`** surfaces the ring breaks inside each feature. Consumers that
  walk EDGES need it, or they stitch a spurious edge from the last vertex of one
  ring to the first vertex of the next: it is what
  [`AnimatedPolygonLayer`](./animated-polygon-layer.md) uses for extruded
  side-wall masking and for its per-ring `stroked` outlines.
- **`partIndices`** surfaces MultiPolygon part boundaries, which the wire
  geometry cannot express: `geoarrow.polygon` is `List<List<FixedSizeList>>`,
  i.e. ONE flat ring list per feature, so after the builder flattens a
  MultiPolygon's parts into it, part-vs-hole is unrecoverable — ring 2 of a
  two-part feature is that part's _exterior_, but every conformant GeoArrow
  consumer reads it as a hole of part 1. Consumers that care about the
  distinction (winding-order fixes, per-part fills, hole subtraction,
  GeoJSON/GeoParquet round-trips) need this array. **Absent means every feature
  in the layer is single-part** — the encoder omits the underlying column
  entirely in that case, so absence is information, not a gap.

Both `ringIndices` and `partIndices` are absent for non-polygon geometries and
for polygon tiles decoded by readers predating those columns.

**Holes render correctly** through the baked `triangles` sidecar, which
`stt-build` emits for the whole layer whenever any feature in it is multi-ring —
so no build flag is needed for holed data. `--pre-tessellate` only extends the
sidecar to simple single-ring polygons.

## loaders.gl alignment caveats

The shape is _inspired by_ loaders.gl `BinaryFeatures`, not conformant:

- loaders.gl splits points/lines/polygons into three parallel objects;
  STT carries ONE geometry type per layer with a `geometryType` tag.
- loaders.gl positions are `{ value, size }` accessor objects; STT uses
  bare typed arrays plus `positionDimensions`.
- loaders.gl's `polygonIndices` vs `primitivePolygonIndices` pair is not
  reproduced verbatim: `startIndices` matches deck.gl's binary-attribute
  convention, with `ringIndices` (and `partIndices`) carrying the finer
  boundaries alongside it rather than replacing it.
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

## Row ordering (`timesSorted`)

`timesSorted` mirrors the packed formatVersion-3 frame's `TILE_META.sorted`
flag: `true` means the tile's rows are stable-sorted by `start_time`, which
enables window slicing and future partial decode. Per the spec, readers **must
not** assume sortedness without the flag — `undefined` (synthetic fixtures and
hand-built tiles) means "unknown", not "sorted".

It is consumed: [`AnimatedTextLayer`](./animated-text-layer.md) narrows its
per-frame CPU membership pass to **two binary searches** over `startTimes`
(widened by the tile's longest feature duration) when the flag is set, instead
of a full scan.

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
