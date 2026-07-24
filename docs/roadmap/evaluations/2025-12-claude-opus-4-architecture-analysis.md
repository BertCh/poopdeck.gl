# STT Architecture Evaluation: 120fps Rendering Analysis

**Model**: Claude Opus 4  
**Date**: December 18, 2025  
**Scope**: STT file format, deck.gl rendering layers, loaders.gl integration

---

## Executive Summary

The STT (Spatiotemporal Tiles) architecture is **well-designed for high-performance rendering** but has several complexity and performance concerns that may prevent consistent 120fps under demanding conditions. The system demonstrates strong understanding of deck.gl patterns, but over-engineering in certain areas creates unnecessary overhead.

**Overall Assessment**: 🟡 **Good foundation, but optimization needed for 120fps guarantee**

| Component           | Rating     | Primary Concern                                 |
| ------------------- | ---------- | ----------------------------------------------- |
| File Format (.stt)  | ⭐⭐⭐⭐   | Solid columnar design, good compression         |
| Tile Loading        | ⭐⭐⭐     | Worker pool overhead, synchronous decompression |
| deck.gl Layers      | ⭐⭐⭐⭐   | Good GPU binary interface usage                 |
| Time Filtering      | ⭐⭐⭐⭐⭐ | Excellent GPU shader-based filtering            |
| Tileset Manager     | ⭐⭐⭐     | Complex prefetch logic, potential GC pressure   |
| Overall Integration | ⭐⭐⭐     | Multiple abstraction layers add latency         |

---

## 1. STT File Format Analysis

### Strengths ✅

**1.1 Columnar Layout for GPU Efficiency**

```protobuf
message ColumnarFeatures {
  repeated sint32 geometry = 4 [packed = true];
  repeated sint64 start_times = 6 [packed = true];
  repeated sint64 end_times = 7 [packed = true];
  repeated NumericColumn numeric_properties = 8;
}
```

- Data is stored in columnar format matching deck.gl's binary data interface
- Packed protobuf arrays serialize efficiently
- Delta + varint encoding for geometry (~2-4 bytes/coordinate)

**1.2 O(1) Tile Lookup Architecture**

```typescript
// archive.ts - Spatial key lookup
private tileEntryIndex: Map<string, TileEntry[]> = new Map();
// Key: "z/x/y" -> temporal entries
```

- HTTP Range Requests enable random access without full file download
- Hilbert curve ordering maximizes spatial locality
- Index fits in memory for most datasets

**1.3 GPU-Ready BinaryFeatures Output**

```typescript
export interface BinaryFeatures {
  positions: Float64Array; // Direct GPU upload
  startTimes: Float32Array; // Shader filtering
  endTimes: Float32Array;
  numericProps: Record<string, Float32Array>;
}
```

### Concerns ⚠️

**1.4 Gzip Decompression is Synchronous**

```typescript
// compression.ts
export async function decompress(
  data: Uint8Array,
  compression: Compression,
): Promise<Uint8Array> {
  return pako.ungzip(data); // Synchronous despite async wrapper
}
```

- `pako.ungzip()` is CPU-bound and blocks the thread
- Worker pool mitigates but adds message passing overhead
- **Recommendation**: Consider WebAssembly decompression or streaming decompression

**1.5 Float64 Positions → Conversion Overhead**

```typescript
positions: Float64Array; // 8 bytes per component
```

- deck.gl internally uses Float32 for GPU buffers
- 64-bit precision needed for tile-relative coordinate decoding
- **Hidden cost**: Framework may convert to Float32 before GPU upload

**1.6 Protobuf Decoding Allocates Intermediate Objects**

```typescript
const protoTile = stt.Tile.decode(data); // Allocates JS objects
```

- protobufjs creates JavaScript objects before typed array conversion
- GC pressure for tiles with 100k+ features
- **Alternative**: Consider FlatBuffers or Cap'n Proto for zero-copy access

---

## 2. deck.gl Rendering Layer Analysis

### Strengths ✅

**2.1 Binary Data Interface Correctly Implemented**

```typescript
// animated-point-layer.ts
const data: any = {
  length: binary.featureCount,
  attributes: {
    getPosition: { value: binary.positions, size: dims },
    getInstanceStartTime: { value: binary.startTimes, size: 1 },
    getInstanceEndTime: { value: binary.endTimes, size: 1 },
  },
};
```

- Typed arrays passed directly to GPU (zero accessor calls)
- Matches deck.gl's recommended high-performance pattern
- Avoids per-feature function invocation

**2.2 TimeFilterExtension is GPU-Native**

```glsl
// time-filter-extension.ts - Vertex shader
if (instanceEndTime < timeStart || instanceStartTime > timeEnd) {
  vTimeAlpha = 0.0;  // GPU-side visibility culling
}
```

- All temporal filtering happens in shaders (no CPU iteration)
- Fade-in/fade-out computed per-vertex
- Single uniform update per frame

**2.3 Layer Caching Pattern**

```typescript
// animated-point-layer.ts
private layerCache: Map<string, CachedLayerInfo> = new Map();

if (cached && cached.binary === binary) {
  return cached.layer.clone({ currentTime, timeWindow });
}
```

- `layer.clone()` preserves GPU buffer state
- Only time-varying props updated (uniforms, not buffers)
- Prevents expensive buffer re-allocation

### Concerns ⚠️

**2.4 Layer Recreation on Tile Changes**

```typescript
// renderLayers() creates new ScatterplotLayer when cache miss
return new ScatterplotLayer({ ... });
```

- Each new layer allocates GPU buffers
- Tile load/unload during animation triggers buffer churn
- **Recommendation**: Pre-allocate buffer pools for common sizes

**2.5 Categorical Color Computation on Main Thread**

```typescript
// animated-point-layer.ts
const colors = new Uint8Array(binary.featureCount * 4);
for (let i = 0; i < binary.featureCount; i++) {
  const categoryIndex = prop.indices[i];
  const color = palette[categoryIndex % palette.length];
  colors[i * 4] = color[0];
  // ...
}
```

- O(n) loop for every tile with categorical coloring
- Runs on main thread during render
- **Impact**: 100k features = noticeable frame spike
- **Recommendation**: Compute in worker during tile decode, or use GPU palette lookup

**2.6 Multiple Abstraction Layers**

```
React Component
    → useMemo(layers)
        → AnimatedPointLayer
            → SpatioTemporalLayer
                → SpatiotemporalTileset
                    → STTArchive
                        → STTLoader (worker pool)
```

- 6+ layers of abstraction
- Each layer has state management overhead
- Debug tracing difficult

---

## 3. Tileset Manager Analysis

### Strengths ✅

**3.1 Dual-Queue Priority System**

```typescript
private priorityQueue: TileId[] = [];   // Current viewport
private prefetchQueue: TileId[] = [];   // Future tiles
```

- Current-time tiles always load first
- Prefetch uses remaining bandwidth
- Animation-aware (adjusts based on playback speed)

**3.2 Parallel Tile ID Queries**

```typescript
const tileIdsByZoom = await Promise.all(
  zoomLevels.map(async (z) => ({
    zoom: z,
    tileIds: await this.options.getAvailableTiles(bounds, z, timeRange),
  })),
);
```

- All zoom levels queried in parallel
- Reduces initial load latency

### Concerns ⚠️

**3.3 O(n) Visible Tile Filtering**

```typescript
getVisibleTiles(): Tile[] {
  const tiles: Tile[] = [];
  for (const key of this.neededTileKeys) {
    const header = this.tiles.get(key);
    if (header?.isLoaded && header.tile) {
      tiles.push(header.tile);
    }
  }
  return tiles;
}
```

- Called every frame during animation
- Creates new array each call (GC pressure)
- **Recommendation**: Cache result, invalidate on tile load/unload

**3.4 Excessive Prefetch Complexity**

```typescript
prefetchAhead: 30000,    // 30 seconds
prefetchSteps: 10,       // 10 steps
// Results in up to 10 * numSpatialTiles * numZoomLevels tile queries
```

- Prefetch creates many async operations
- Memory pressure from queued tiles
- **Recommendation**: Simpler linear look-ahead with budget cap

**3.5 Time-Based Update Throttling Misaligned**

```typescript
// spatiotemporal-layer.ts
const updateThreshold = timeWindow / 20; // 5% of window
if (timeDelta > updateThreshold) {
  // Update tileset
}
```

- At 60fps, 16.7ms between frames
- Fast animations may skip threshold updates
- Tiles can lag behind visible time
- **Recommendation**: Frame-count based throttling, not time-delta

---

## 4. 120fps Feasibility Assessment

### Frame Budget Analysis

At 120fps: **8.33ms per frame**

| Operation                 | Typical Time | Notes                     |
| ------------------------- | ------------ | ------------------------- |
| TimeController tick       | 0.01ms       | Minimal                   |
| Tileset.getVisibleTiles() | 0.1-0.5ms    | Depends on tile count     |
| Layer.renderLayers()      | 0.2-1ms      | Creates sublayers         |
| deck.gl diffing           | 0.5-2ms      | Props comparison          |
| GPU draw calls            | 1-4ms        | Varies with feature count |
| React reconciliation      | 0-2ms        | If state updates          |
| **Total (optimistic)**    | **~4-8ms**   | Leaves little margin      |

### Bottleneck Scenarios

**Scenario A: Tile Load During Animation**

- New tile arrives → buffer allocation → layer recreation
- Can cause 20-50ms frame spike
- **Mitigation**: Pre-allocate buffers, use background loading

**Scenario B: Many Small Tiles**

- 50+ tiles visible → 50+ layer instances
- Each layer = draw call overhead
- **Mitigation**: Tile consolidation at render time

**Scenario C: High Feature Density**

- 1M+ features visible → fragment shader overdraw
- 5px radius points = 78 pixels each = 78M fragment ops
- **Mitigation**: Dynamic point sizing, LOD culling

---

## 5. Recommendations for 120fps

### High Priority

1. **Streaming Decompression**
   - Replace `pako.ungzip()` with streaming WebAssembly decoder
   - Process chunks incrementally
   - Never block main thread

2. **Buffer Pooling**

   ```typescript
   class BufferPool {
     getFloat32Array(size: number): Float32Array;
     release(buffer: Float32Array): void;
   }
   ```
   - Reuse typed arrays across tile loads
   - Eliminate GC pauses

3. **GPU Palette Lookup**

   ```glsl
   uniform sampler2D colorPalette;
   vec4 color = texture(colorPalette, vec2(categoryIndex / 255.0, 0.5));
   ```
   - Remove CPU color expansion loop
   - Single texture uniform instead of per-vertex attribute

4. **Tile Consolidation Layer**
   ```typescript
   class ConsolidatedPointLayer {
     // Merge multiple tile buffers into single draw call
     mergeBuffers(tiles: Tile[]): MergedBuffer;
   }
   ```
   - Reduce draw call count from O(tiles) to O(1)
   - Single large buffer, offset-based rendering

### Medium Priority

5. **FlatBuffers Migration**
   - Zero-copy deserialization
   - Direct typed array access without protobuf intermediates
   - 2-5x decode performance improvement

6. **Frame-Aligned Updates**

   ```typescript
   if (frameCount % 2 === 0) {
     tileset.update(viewport);
   }
   ```
   - Update tileset every N frames, not every time change
   - Smoother animation with predictable load

7. **Visibility Culling in Workers**
   - Pre-filter features by time range in decode worker
   - Only transfer visible features to main thread
   - Reduces memory bandwidth

### Low Priority

8. **WebGPU Exploration**
   - Compute shaders for data transformation
   - Better buffer management
   - Prepare for luma.gl v10 WebGPU support

9. **Temporal Prediction**
   - Predict user seeking behavior
   - Pre-warm tile cache along likely timeline positions

---

## 6. Architectural Simplification Opportunities

### Current: 6 Abstraction Layers

```
App → Layer → SpatioTemporalLayer → Tileset → Archive → Loader
```

### Proposed: 3 Core Components

```
App → SttVisualizationLayer → TileStreamManager
           ↓                          ↓
    (deck.gl layer)         (fetch + decode + cache)
```

**Benefits:**

- Fewer state synchronization points
- Clearer data flow
- Easier debugging and profiling

---

## 7. Comparison with Industry Standards

| Feature        | STT Current      | Mapbox Vector Tiles | Google Maps 3D |
| -------------- | ---------------- | ------------------- | -------------- |
| Tile Format    | Protobuf + Gzip  | Protobuf + Gzip     | Proprietary    |
| GPU Data       | Binary interface | Binary interface    | Native GPU     |
| Time Dimension | ✅ Native        | ❌ Client-side      | ❌ N/A         |
| Streaming      | HTTP Range       | HTTP/2 Push         | Proprietary    |
| Decompression  | Main thread      | WebAssembly         | Native         |
| Target FPS     | 60-120           | 60                  | 60             |

**STT Advantages:**

- Native 4D (x, y, z, t) tile addressing
- GPU-based temporal filtering (vs CPU filtering)
- Single archive file (vs tile pyramid directories)

**STT Disadvantages:**

- No WebAssembly decompression pipeline
- Higher abstraction complexity
- Less mature ecosystem

---

## 8. Conclusion

The STT architecture demonstrates **sophisticated understanding of WebGL rendering patterns** and deck.gl best practices. The columnar data format, GPU-based time filtering, and binary data interface are correctly implemented.

However, achieving **consistent 120fps requires optimization** in:

1. Decompression pipeline (move to WebAssembly)
2. Buffer allocation (implement pooling)
3. Tile rendering (consolidate draw calls)
4. Architecture (reduce abstraction layers)

**Estimated 120fps Achievement:**

- Current state: 60-90fps typical, drops during tile loads
- After high-priority optimizations: 90-120fps sustainable
- Full optimization: 120fps with headroom

The fundamental design is sound. The complexity is appropriate for the problem domain (4D spatiotemporal visualization), but execution can be streamlined for the 120fps target.

---

## Appendix: Key File Paths

| Component           | Path                                            |
| ------------------- | ----------------------------------------------- |
| STT Format (Rust)   | `crates/stt-core/src/tile.rs`                   |
| STT Format (Proto)  | `proto/tile.proto`                              |
| Archive Reader      | `packages/core/src/archive.ts`                  |
| Tile Decoder        | `packages/core/src/tile.ts`                     |
| Tileset Manager     | `packages/core/src/spatiotemporal-tileset.ts`   |
| deck.gl Point Layer | `packages/deck.gl/src/animated-point-layer.ts`  |
| Time Filter Shader  | `packages/deck.gl/src/time-filter-extension.ts` |
| Time Controller     | `packages/deck.gl/src/time-controller.ts`       |
