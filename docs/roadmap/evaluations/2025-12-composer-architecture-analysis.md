# STT Format & deck.gl Architecture Performance Evaluation

**Date**: 2025-01-27  
**Model**: Composer  
**Target**: 120fps rendering with seamless playback + map interaction

## Executive Summary

The current architecture demonstrates solid fundamentals for high-performance spatiotemporal visualization, but several optimization opportunities exist to achieve consistent 120fps rendering. The binary data format and GPU-based time filtering are well-designed, but layer management overhead, tile loading complexity, and potential overdraw issues may limit performance at scale.

**Key Findings**:

- ✅ Binary format enables direct GPU upload (zero-copy potential)
- ✅ Shader-based time filtering avoids CPU-side filtering overhead
- ⚠️ Layer cloning on every frame creates unnecessary object allocation
- ⚠️ Multiple layers per tile can create render overhead
- ⚠️ Complex prefetching logic may compete with rendering
- ⚠️ No explicit instancing optimization for dense point clouds

---

## 1. STT File Format Analysis

### 1.1 Format Structure

The STT format uses Protocol Buffers with Gzip/Brotli compression:

```
Archive Structure:
├── Header (53 bytes) - Fixed size, contains offsets
├── Tiles (compressed protobuf) - Bulk of data
├── Index (protobuf) - Spatial + temporal lookup
└── Metadata (protobuf) - Dataset info
```

**Strengths**:

- **HTTP Range Requests**: Enables efficient random access without downloading entire archive
- **Spatial Index**: O(1) lookup via `Map<string, TileEntry[]>` keyed by `z/x/y`
- **Temporal Index**: Efficient time-range queries via sorted arrays
- **Compression**: Gzip/Brotli reduces network transfer (2-10x typical)
- **Binary Format**: Direct decode to `BinaryFeatures` (typed arrays) avoids JSON parsing overhead

**Performance Characteristics**:

- Index loading: Single HTTP range request (~10-100KB typically)
- Tile loading: Per-tile HTTP range request (compressed size varies)
- Decoding: Protobuf decode + decompression in worker thread
- Memory: Typed arrays (`Float64Array`, `Uint32Array`, etc.) ready for GPU upload

### 1.2 Decoding Pipeline

```
HTTP Range Request → ArrayBuffer → Worker Thread
  → Decompress (Gzip/Brotli) → Protobuf Decode
  → BinaryFeatures (typed arrays)
  → Transfer to Main Thread (zero-copy via Transferable)
  → GPU Upload (via deck.gl)
```

**Analysis**:

- ✅ Worker thread offloads CPU-intensive work (decompression + protobuf decode)
- ✅ Transferable objects enable zero-copy transfer (no serialization)
- ✅ Binary format aligns with deck.gl's binary data interface
- ⚠️ Worker overhead: Each tile decode requires worker message passing
- ⚠️ Protobuf decode: Still CPU-bound, though optimized in `prost` (Rust) / `protobufjs` (JS)

**Recommendations**:

1. **Batch Decoding**: Decode multiple tiles in single worker message to amortize overhead
2. **Streaming Decompression**: Use streaming decompression APIs if available
3. **Pre-decode Common Tiles**: For animation loops, pre-decode frequently accessed tiles

---

## 2. deck.gl Rendering Architecture

### 2.1 Layer Hierarchy

```
SpatioTemporalLayer (CompositeLayer)
  └── renderLayers() → AnimatedPointLayer instances
       └── renderLayers() → ScatterplotLayer instances (one per tile layer)
            └── GPU Rendering (via TimeFilterExtension)
```

**Current Implementation** (`AnimatedPointLayer`):

- Creates one `ScatterplotLayer` per tile layer
- Caches layers by `tileId + layerIndex`
- Clones cached layers on every frame with updated time props
- Uses `TimeFilterExtension` for GPU-based temporal filtering

### 2.2 Performance Bottlenecks

#### 2.2.1 Layer Cloning Overhead

**Issue**: `getOrCreateLayer()` clones layers on every frame:

```typescript
return cached.layer.clone({
  currentTime: currentTime - timeOffset,
  timeWindow,
  opacity: this.props.opacity,
  visible: this.props.visible,
} as any);
```

**Impact**:

- Creates new layer objects every frame (even if only time changed)
- Triggers deck.gl's update cycle (attribute manager checks, uniform updates)
- For 50 tiles × 2 layers = 100 layer clones per frame
- At 120fps: 12,000 layer object allocations per second

**deck.gl's `clone()` behavior**:

- Preserves GPU state (buffers, textures) ✅
- Creates new JavaScript object ❌
- Triggers `updateState()` lifecycle ❌
- Updates uniforms (cheap) ✅

**Recommendation**: Use uniform updates instead of cloning:

```typescript
// Instead of cloning, update uniforms directly
cached.layer.setProps({
  currentTime: currentTime - timeOffset,
  timeWindow,
});
```

However, deck.gl's extension system may require cloning for uniform updates. **Alternative**: Update uniforms via `setShaderModuleProps()` in `draw()` hook.

#### 2.2.2 Multiple Layers Per Tile

**Current**: Each tile can have multiple layers (e.g., different geometry types or data sources).

**Impact**:

- 10 tiles × 3 layers = 30 `ScatterplotLayer` instances
- Each layer has separate draw calls
- GPU state changes between layers (bind/unbind buffers, shaders)

**deck.gl Optimization**: `ScatterplotLayer` uses instanced rendering, so multiple layers are still efficient. However, **consolidating layers** could reduce draw calls.

**Recommendation**:

- If layers share same geometry type, merge into single layer with multiple data sources
- Use `updateTriggers` to update only changed attributes
- Consider using `MultiIconLayer` or custom instanced layer for better batching

#### 2.2.3 Time Filter Extension

**Implementation**: `TimeFilterExtension` uses shader uniforms for time filtering:

```glsl
uniform timeFilterUniforms {
  float currentTime;
  float windowHalf;
  float fadeIn;
  float fadeOut;
  float trailLength;
} timeFilter;
```

**Performance**: ✅ Excellent

- Time filtering happens entirely in GPU (vertex/fragment shaders)
- No CPU-side filtering or data copying
- Discard invisible features early (`discard` in fragment shader)
- Uniform updates are cheap (single GPU upload per frame)

**Potential Issue**: Uniform updates per layer

- If 100 layers, 100 uniform updates per frame
- However, deck.gl batches uniform updates efficiently

**Recommendation**: Verify uniform batching in deck.gl 9.x. If not batched, consider shared uniform buffer.

---

## 3. Tile Loading & Caching

### 3.1 Tileset Architecture

**Current**: `SpatiotemporalTileset` manages tile lifecycle:

- Request queue with priority (current tiles vs prefetch)
- LRU cache eviction
- Concurrent request limit (`maxRequests: 64`)
- Prefetching for animation (`prefetchAhead`, `prefetchSteps`)

**Strengths**:

- ✅ Separates tile management from rendering
- ✅ Priority queue ensures current tiles load first
- ✅ LRU cache prevents unbounded memory growth
- ✅ Prefetching reduces animation stutter

**Concerns**:

#### 3.1.1 Prefetch Complexity

**Current**: Prefetches `prefetchSteps` (default: 10) time windows ahead:

```typescript
for (let step = 1; step <= prefetchSteps; step++) {
  const futureTime = time + direction * effectivePrefetchAhead * step;
  // Query tiles for futureTime...
}
```

**Impact**:

- 10 steps × 3 zoom levels = 30 parallel queries per prefetch cycle
- Combined with current tiles: 50+ concurrent HTTP requests
- Network saturation may delay current tile loading

**Recommendation**:

- **Adaptive Prefetching**: Reduce `prefetchSteps` based on network latency
- **Bandwidth Throttling**: Limit prefetch requests to 20% of `maxRequests`
- **Time-based Throttling**: Only prefetch when animation speed > threshold

#### 3.1.2 Cache Eviction

**Current**: LRU with 5-minute grace period for animation loops.

**Issue**: Large datasets may have thousands of tiles. Cache eviction during animation can cause stutter if tiles are evicted too aggressively.

**Recommendation**:

- **Predictive Eviction**: Don't evict tiles that will be needed soon (based on animation direction)
- **Size-based Priority**: Evict large tiles first (if over byte limit)
- **Temporal Locality**: Keep tiles within `timeWindow * 2` of current time

---

## 4. Rendering Performance Analysis

### 4.1 GPU Rendering Path

**deck.gl Rendering Pipeline**:

1. `renderLayers()` → Returns array of `ScatterplotLayer` instances
2. deck.gl batches layers by shader/material
3. GPU uploads: Positions, colors, radii (if changed)
4. Draw calls: Instanced rendering (one call per layer)
5. Time filtering: GPU shader discards invisible features

**Performance Characteristics**:

**Good**:

- ✅ Binary data → Direct GPU upload (no CPU transformation)
- ✅ Instanced rendering: Single draw call per layer
- ✅ Early discard: Fragment shader discards invisible features
- ✅ Uniform updates: Cheap (single GPU upload per frame)

**Potential Issues**:

#### 4.1.1 Overdraw

**Issue**: Points may overlap, causing fragment shader overdraw.

**Impact**:

- 1M points with 5px radius = ~78M pixels to render (at 1080p)
- Fragment shader runs for every pixel, even if occluded

**Mitigation**:

- ✅ Small point radius reduces overdraw
- ✅ Time filtering discards invisible features early
- ⚠️ No depth testing for 2D points (by design)

**Recommendation**:

- Use `radiusMinPixels` / `radiusMaxPixels` to cap point size
- Consider aggregation layers (`GridLayer`, `HexagonLayer`) for very dense data
- Use LOD: Smaller points at higher zoom levels

#### 4.1.2 Draw Call Count

**Current**: One draw call per `ScatterplotLayer` instance.

**Impact**:

- 50 tiles × 2 layers = 100 draw calls per frame
- At 120fps: 12,000 draw calls per second
- Modern GPUs handle this, but state changes add overhead

**deck.gl Optimization**: deck.gl batches layers with same shader/material, reducing state changes.

**Recommendation**:

- Profile with Chrome DevTools Performance tab
- Use `deck.log.priority = 1` to see draw call counts
- Consider merging layers if possible

---

## 5. Comparison with deck.gl Best Practices

### 5.1 Binary Data Interface

**Current**: ✅ Uses deck.gl's binary data interface:

```typescript
const data = {
  length: binary.featureCount,
  attributes: {
    getPosition: { value: binary.positions, size: dims },
    getInstanceStartTime: { value: binary.startTimes, size: 1 },
    getInstanceEndTime: { value: binary.endTimes, size: 1 },
  },
};
```

**deck.gl Recommendation**: ✅ Matches specification exactly.

### 5.2 Layer Caching

**Current**: Caches layers by `tileId + layerIndex`.

**deck.gl Pattern**: deck.gl's `TileLayer` doesn't cache sub-layers; it recreates them on each render. However, **your caching is beneficial** because:

- Prevents buffer regeneration (expensive)
- Reduces attribute manager overhead

**Recommendation**: ✅ Keep caching, but optimize cloning (see 2.2.1).

### 5.3 Time Updates

**Current**: Updates `currentTime` via layer cloning or `setNeedsRedraw()`.

**deck.gl Pattern**: deck.gl's `TileLayer` uses `updateTriggers` to detect changes. Your approach is similar but may be less efficient.

**Recommendation**:

- Use `updateTriggers: { currentTime: [currentTime] }` instead of cloning
- Or update uniforms directly in `draw()` hook

---

## 6. Recommendations for 120fps

### 6.1 Immediate Optimizations

1. **Eliminate Layer Cloning**:
   - Update uniforms directly via `setShaderModuleProps()` in `draw()` hook
   - Or use `updateTriggers` to trigger minimal updates

2. **Reduce Draw Calls**:
   - Merge layers with same geometry type where possible
   - Use single `ScatterplotLayer` with multiple data sources

3. **Optimize Prefetching**:
   - Reduce `prefetchSteps` to 3-5 (from 10)
   - Throttle prefetch requests to 20% of `maxRequests`
   - Only prefetch when animation speed > 1x

4. **Cache Optimization**:
   - Increase `maxCacheSize` for animation loops (current: 2000 is good)
   - Implement predictive eviction (don't evict tiles needed soon)

### 6.2 Architecture Improvements

1. **Uniform Batching**:
   - Use shared uniform buffer for `TimeFilterExtension` across all layers
   - Reduces uniform updates from N (layers) to 1

2. **Worker Pool**:
   - Use worker pool instead of single worker for tile decoding
   - Parallelizes decompression + protobuf decode

3. **Streaming Decode**:
   - Decode tiles incrementally as data arrives
   - Show partial data while decoding completes

4. **LOD System**:
   - Use lower zoom tiles when higher zoom tiles aren't loaded
   - Reduces visual pop-in during pan/zoom

### 6.3 Measurement & Profiling

**Critical Metrics**:

1. **Frame Time**: Target < 8.3ms per frame (120fps)
2. **Draw Calls**: Profile with Chrome DevTools
3. **GPU Time**: Use `EXT_disjoint_timer_query` or Chrome GPU Profiler
4. **Memory**: Monitor tile cache size and eviction rate
5. **Network**: Track tile load latency and prefetch effectiveness

**Profiling Tools**:

- Chrome DevTools Performance tab
- deck.gl's `deck.log.priority = 1` for draw call counts
- `performance.mark()` / `performance.measure()` for custom timing
- WebGL Inspector for GPU profiling

---

## 7. Complexity Assessment

### 7.1 Current Complexity

**Architecture Layers**:

1. `STTArchive` - HTTP range requests, index lookup
2. `SpatiotemporalTileset` - Tile lifecycle, caching, prefetching
3. `SpatioTemporalLayer` - Viewport management, time updates
4. `AnimatedPointLayer` - Layer caching, binary data conversion
5. `ScatterplotLayer` - GPU rendering
6. `TimeFilterExtension` - Shader-based time filtering

**Complexity Score**: **Medium-High**

**Justification**:

- ✅ Separation of concerns (good)
- ✅ Follows deck.gl patterns (good)
- ⚠️ Multiple abstraction layers (moderate complexity)
- ⚠️ Prefetching logic is complex (but necessary)

**Comparison**: Similar complexity to deck.gl's `TileLayer` + `MVTLayer`, which is reasonable for a production system.

### 7.2 Simplification Opportunities

1. **Remove Layer Cloning**: Simplifies update path
2. **Consolidate Tileset Logic**: Move some logic from `SpatioTemporalLayer` to `SpatiotemporalTileset`
3. **Simplify Prefetching**: Use simpler time-based prefetch (no step-based logic)

**Trade-off**: Simplification may reduce flexibility or performance optimizations.

---

## 8. Conclusion

### 8.1 Strengths

1. ✅ **Binary Format**: Efficient, GPU-ready, enables zero-copy transfer
2. ✅ **Shader-Based Filtering**: Time filtering in GPU avoids CPU overhead
3. ✅ **Worker Decoding**: Offloads CPU-intensive work
4. ✅ **Tile Management**: Well-structured with priority queues and caching
5. ✅ **deck.gl Integration**: Follows deck.gl patterns correctly

### 8.2 Weaknesses

1. ⚠️ **Layer Cloning**: Creates unnecessary object allocations
2. ⚠️ **Prefetch Complexity**: May compete with current tile loading
3. ⚠️ **Multiple Layers**: Could be consolidated for fewer draw calls
4. ⚠️ **No Uniform Batching**: Each layer updates uniforms separately

### 8.3 120fps Feasibility

**Current State**: Likely **60-90fps** on modern hardware with moderate datasets.

**With Optimizations**: **120fps achievable** with:

- Eliminating layer cloning
- Reducing draw calls (layer consolidation)
- Optimizing prefetching (reduced steps, throttling)
- GPU profiling and optimization

**Bottlenecks** (in order of impact):

1. Layer cloning overhead (high impact)
2. Draw call count (medium impact)
3. Prefetch network saturation (medium impact)
4. Overdraw (low-medium impact, depends on point density)

### 8.4 Next Steps

1. **Profile Current Performance**: Measure frame time, draw calls, GPU time
2. **Implement Uniform Updates**: Replace layer cloning with direct uniform updates
3. **Optimize Prefetching**: Reduce steps, add throttling
4. **Consolidate Layers**: Merge layers where possible
5. **GPU Profiling**: Identify shader bottlenecks

---

## Appendix: Reference Architecture

### Ideal Architecture (for reference)

```
┌─────────────────────────────────────────┐
│ SpatioTemporalLayer                    │
│  - Viewport + time management          │
│  - Minimal state updates               │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ SpatiotemporalTileset                  │
│  - Tile lifecycle                      │
│  - Request queue (priority + prefetch) │
│  - LRU cache                           │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ STTArchive                             │
│  - HTTP range requests                 │
│  - Index lookup (O(1))                  │
│  - Worker pool decoding                │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ AnimatedPointLayer                     │
│  - Single layer instance (merged)       │
│  - Uniform updates (no cloning)         │
│  - Binary data → GPU                   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ ScatterplotLayer + TimeFilterExtension  │
│  - Instanced rendering                  │
│  - GPU time filtering                  │
│  - Shared uniform buffer                │
└─────────────────────────────────────────┘
```

**Key Differences**:

- Single merged layer instead of multiple layers
- Uniform updates instead of cloning
- Shared uniform buffer for time filtering
- Worker pool for parallel decoding
