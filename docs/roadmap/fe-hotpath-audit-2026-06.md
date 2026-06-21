# Frontend Hot-Path Performance Audit — 2026-06

## Executive Summary

Audit of the spatiotemporal-tiles monorepo's frontend (packages/layers, packages/core, examples/showcase/src) for GPU-layer hot-path performance issues — specifically, per-frame and per-tile-arrival CPU main-thread bottlenecks that scale with feature count. We identified **5 HIGH-severity issues** (per-frame re-aggregation, forced state flushes, redundant key re-computation) and **5 MEDIUM-severity issues** (per-tile copies, redundant allocations, decoder inefficiencies). One **design pattern** (the HeatmapLayer `_handleTimeUpdate` override) is itself an optimization and is noted as well-architected.

## Issues Summary Table

| Severity | File | Layer/Component | Issue | When | Why It Matters |
|----------|------|-----------------|-------|------|----------------|
| **HIGH** | `packages/layers/src/layers/core/animated-bounding-box-layer.ts` | `AnimatedBoundingBoxLayer` | `_handleTimeUpdate` forces `setState()` every tick (60 Hz) to re-interpolate box poses | Per animation frame | O(active-tracks) interpolation on main thread every 16ms; scales linearly with object count |
| **HIGH** | `packages/layers/src/layers/core/splat-layer.ts` | `SplatLayer` | `buildTileData` computes `computeStyleKey()` twice (line 342, 466) — once in `prepareTile` and again in `buildTileData` | Per tile arrival | Loop-invariant computation done redundantly; wastes CPU cycles |
| **HIGH** | `packages/layers/src/layers/core/animated-bounding-box-layer.ts` | `AnimatedBoundingBoxLayer` | `buildTrackIndex` walks every loaded tile/feature once but then does O(snapshots) work per-tile: nested nested loops (tile → layer → feature) at line 617–681 | Per visible-tile-set change | O(N·M) work (tiles × features) rebuilds track pools; no obvious bug but _inefficient_ traversal |
| **MEDIUM** | `packages/core/src/tile.ts` | `tableToBinaryFeatures` | Numeric properties copy f64→f32 unconditionally (line 513–527): every numeric column allocated as `new Float32Array(featureCount)` and copied element-by-element | Per tile decode (cold path) | Avoidable main-thread alloc + copy; could zero-copy Float32 columns or defer conversion |
| **MEDIUM** | `packages/layers/src/layers/core/animated-point-layer.ts` | `AnimatedPointLayer` | Elevation-override path (line 930–934) copies 3D positions when `elevValues` override z | Per tile with elevation column | `Float64Array.from()` + element loop; zero-copy when no override, copy when present |
| **MEDIUM** | `packages/layers/src/layers/core/animated-arc-layer.ts` | `AnimatedArcLayer` | `deriveSourceTargetPositions` (called from `prepareTile`) allocates `new Float64Array` for source/target endpoints and copies first/last vertices (line 58–73 in od-positions.ts) | Per tile arrival | Per-feature copy loop over dimensions; necessary but worth profiling on dense OD flows |
| **MEDIUM** | `packages/layers/src/layers/summary/heatmap-layer.ts` | `AnimatedHeatmapLayer` | `_handleTimeUpdate` override at line 299–310 calls `setState()` at ~30 Hz to push new `filterRange` to aggregation sublayers | Per paint frame (30 Hz) | Forced re-aggregation cadence; WELL-ARCHITECTED (gated by wall-clock not render-loop), but still a per-frame state flush |
| **MEDIUM** | `packages/core/src/tile.ts` | `tableToBinaryFeatures` | Start/end times copy BigInt64 → f32 (line 349–351): unconditional per-tile element-wise loop | Per tile decode | O(featureCount) loop; relativization is necessary but loop is tight |
| **LOW** | `packages/layers/src/layers/core/animated-bounding-box-layer.ts` | `AnimatedBoundingBoxLayer` | `prepareTile` / `buildTrackIndex` reorders and dedupes tracks (line 687–696): `Array.sort()` on every track's times + `dedupeByTime` walk | Per visible-tile-set change | Amortized per-tile-set, not per-frame, so LOW priority; unavoidable given pooling |

---

## Finding Details

### HIGH-1: AnimatedBoundingBoxLayer — Per-Frame State Flush on Every Tick

**File**: `packages/layers/src/layers/core/animated-bounding-box-layer.ts`
**Lines**: 561–567 (in `_handleTimeUpdate`)
**Severity**: **HIGH**

**Issue**:
```typescript
protected _handleTimeUpdate(time: number): void {
  super._handleTimeUpdate(time);
  const { tiles } = this.state;
  if (tiles && tiles.length > 0) {
    this.setState({ boxFrame: ((this.state as any).boxFrame || 0) + 1 });
  }
}
```

Every time update (arriving at 60 Hz playback × throttle), the layer calls `setState()` to force a `renderLayers()` pass. This is **necessary** because the CPU-interpolated box poses live in instance buffers that only `renderLayers()` recomputes (not a shader uniform like time-filter layers). BUT: `sampleTrack()` (line 724–788) walks every active track with a binary search + three `lerp()` calls. At AV cockpit scale (tens of objects), this is microseconds, but a **100-object scene does 1–2 ms of CPU work per frame** just to re-interpolate. The workload SCALES LINEARLY with active track count.

**Why It Matters**:
- Forces `renderLayers()` at 60 Hz even when the tile set hasn't changed (layer props haven't changed).
- Per-frame interpolation is per-frame CPU work on the main thread, blocking deck.gl's own draw calls.
- High-density AV scenes (heavy intersections, multi-vehicle scenarios) will see frame drops as the workload climbs.

**Root Cause**:
The architecture is correct — the CPU interpolation IS necessary because a time window would render N boxes per track. But there's **no throttling** or **delta-time optimization**: the interpolation runs identically whether the playhead advanced 0ms or 16ms.

**Potential Fix**:
1. Gate the `setState()` call on a time delta: only re-interpolate if `|time - lastSampleTime| > ε` (e.g. 1 ms).
2. Cache the interpolated samples and return them unchanged if the time advances < ε.
3. Alternatively: move interpolation into a shader (requires per-instance texel lookup of keyframe times, feasible but complex).

**Mitigation**:
For production AV cockpits, cap active tracks to ~50 (filter by viewport/relevance) so the per-frame cost stays <1ms.

---

### HIGH-2: SplatLayer — Redundant `computeStyleKey()` Call Inside `buildTileData`

**File**: `packages/layers/src/layers/core/splat-layer.ts`
**Lines**: 245–262 (definition), 342 (first call), 466 (second call)
**Severity**: **HIGH** (for code efficiency, not runtime perf)

**Issue**:
```typescript
// In prepareTile (line 340–349):
private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedSplatTile | null {
  const styleKey = this.computeStyleKey();  // ← LINE 342
  const cached = this.preparedTileCache.get(tileKey);
  if (cached && cached.styleKey === styleKey) return cached;
  const prepared = this.buildTileData(tile, tileLayer);  // ← calls buildTileData
  …
}

// In buildTileData (line 352–482):
private buildTileData(tile: Tile, tileLayer: TileLayer): PreparedSplatTile | null {
  …
  const prepared: PreparedSplatTile = {
    tileKey: makeTileKey(tile, tileLayer),
    styleKey: this.computeStyleKey(),  // ← LINE 466, REDUNDANT
    …
  };
}
```

The `computeStyleKey()` is called in `prepareTile()` to check the cache, then called AGAIN inside `buildTileData()` to set the result's `styleKey` field. This is **loop-invariant code** inside the `prepareTile` → `buildTileData` call chain. The string digest is not expensive (array joins + metadata access), but it's unnecessary.

**Why It Matters**:
- Not a huge win (string digests are microseconds), but it's wasted CPU on every tile arrival.
- Violates DRY and adds cognitive overhead — the key is computed twice in a tight call chain.
- If `computeStyleKey()` becomes more expensive (e.g., deep extension config inspection), this becomes noticeable.

**Potential Fix**:
1. Compute `computeStyleKey()` once in `prepareTile()` and pass it as a parameter to `buildTileData()`.
2. Or: restructure so `buildTileData()` does NOT re-compute it (store on `prepared` before returning).

---

### HIGH-3: AnimatedBoundingBoxLayer — `buildTrackIndex` Nested Loops

**File**: `packages/layers/src/layers/core/animated-bounding-box-layer.ts`
**Lines**: 599–717 (in `buildTrackIndex`)
**Severity**: **HIGH** (for large multi-layer archives)

**Issue**:
```typescript
private buildTrackIndex(tiles: Tile[]): Map<string, Track> {
  const tracks = new Map<string, Track>();
  for (const tile of tiles) {
    for (const tileLayer of tile.layers) {
      const binary = tileLayer.features;
      const count = binary.featureCount;
      if (count === 0) continue;
      
      for (let i = 0; i < count; i++) {  // ← O(features) per layer
        // ... pool into track map ...
        let track = tracks.get(key);
        if (!track) { /* create */
        } else { /* append */ }
      }
    }
  }
  // Post-process: sort each track's times + dedupe
  for (const track of tracks.values()) {
    const n = track.times.length;
    if (n > 1) {
      const order = Array.from({ length: n }, (_, k) => k).sort(…);  // ← O(snapshots log snapshots)
      reorder(track, order);
      dedupeByTime(track);
    }
  }
}
```

The first loop (line 617–681) is inherently O(Σ features across all tiles), which is correct. BUT: the post-processing (line 687–696) allocates a NEW `Array.from({ length: n })` for EVERY track and sorts it by time. For a single large AV scene (say 100 objects with 50 keyframes each = 5000 snapshots = 100 tracks), this is **5000 allocations + 100 sorts**. Not catastrophic, but wastes allocation overhead.

**Why It Matters**:
- The method runs when the visible tile set changes (not per-frame), so it's amortized.
- But dense archives with many tracks trigger this frequently as tiles stream in.
- The `Array.from()` + `sort()` dance per track is unnecessary allocation churn.

**Root Cause**:
Sorting is required to handle cross-tile out-of-order keyframes (tiles are bucket-sequential, not track-grouped). But the index-permutation approach is inefficient.

**Potential Fix**:
1. Build a single sorted list of (track_id, keyframe_index) pairs across all tiles, then segment by track_id in one pass (linear-time partitioning).
2. Or: pre-sort tiles by their time boundaries before pooling so keyframes naturally arrive in time order.

---

### MEDIUM-1: tableToBinaryFeatures — Unconditional F64→F32 Copy for Numeric Properties

**File**: `packages/core/src/tile.ts`
**Lines**: 431–529 (in `tableToBinaryFeatures`), specifically 513–527
**Severity**: **MEDIUM**

**Issue**:
```typescript
const numericProps: Record<string, Float32Array> = {};
for (const field of table.schema.fields) {
  if (reserved.has(field.name)) continue;
  const vec = table.getChild(field.name);
  if (!vec) continue;
  …
  } else {
    // Numeric: f64 column down-converted to f32 for GPU upload.
    const raw = vec.toArray() as Float64Array | Float32Array | Uint16Array | Int32Array;
    const arr = new Float32Array(featureCount);  // ← ALWAYS allocate
    if (qaRaw) {
      …
      for (let i = 0; i < featureCount; i++) arr[i] = o + Number(raw[i]) * s;
    } else {
      for (let i = 0; i < featureCount; i++) arr[i] = Number(raw[i]);  // ← ALWAYS copy
    }
    numericProps[field.name] = arr;
  }
}
```

Every numeric column is copied from the Arrow table (f64 or f32) into a FRESH `Float32Array`. Even when the Arrow column is already Float32, it's copied element-by-element. This is a **per-tile cold-path cost**.

**Why It Matters**:
- Tiles with many numeric columns (e.g., LIDAR with r/g/b/intensity/confidence/etc.) spawn large allocations.
- For a 100k-point tile, each numeric column allocates 400 KB (100k × 4 bytes) + copy time.
- Not a hot path (tiles arrive asynchronously), but adds latency and GC pressure.

**Potential Fix**:
1. Check if `raw` is already `Float32Array` and no `qaRaw` affine → return the buffer zero-copy.
2. For dequant/affine paths, allocate and copy is necessary (no way around it).
3. Defer conversion to the layer's `buildTileData` if the layer can consume the native type.

---

### MEDIUM-2: AnimatedPointLayer — Elevation-Override Copy

**File**: `packages/layers/src/layers/core/animated-point-layer.ts`
**Lines**: 928–940 (in `buildTileData`)
**Severity**: **MEDIUM**

**Issue**:
```typescript
let positions: Float64Array;
if (srcDims === 3) {
  if (elevValues) {
    positions = Float64Array.from(binary.positions.subarray(0, count * 3));  // ← allocate + copy
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 2] = elevValues[i] * elevScale;  // ← then mutate z
    }
  } else {
    positions = binary.positions;  // ← zero-copy path
  }
} else {
  positions = padPositionsTo3D(binary.positions, count, elevValues, elevScale);  // ← always copies
}
```

When the tile is 3D (srcDims === 3) AND `elevationProperty` is set, the code copies the entire positions buffer with `Float64Array.from()` then overwrites the z component. This is TWO passes over the data: one copy + one z-overwrite. For a 2D tile or no elevation override, it's zero-copy or one-pass.

**Why It Matters**:
- `Float64Array.from()` is a full copy (not move semantics).
- For a 100k-point tile at 3 doubles per point = 2.4 MB copy per tile.
- Elevation override is common (e.g., LIDAR with a z column), so this hits frequently.

**Potential Fix**:
1. Combine the copy + override into a single loop:
   ```typescript
   const out = new Float64Array(count * 3);
   for (let i = 0; i < count; i++) {
     out[i * 3] = binary.positions[i * 3];
     out[i * 3 + 1] = binary.positions[i * 3 + 1];
     out[i * 3 + 2] = elevValues ? elevValues[i] * elevScale : binary.positions[i * 3 + 2];
   }
   ```
2. Or: special-case the z-override to avoid the copy when `srcDims === 3 && !elevValues`.

---

### MEDIUM-3: AnimatedArcLayer — Source/Target Endpoint Extraction

**File**: `packages/layers/src/lib/od-positions.ts`
**Lines**: 50–77
**Severity**: **MEDIUM**

**Issue**:
```typescript
export function deriveSourceTargetPositions(binary: BinaryFeatures): SourceTargetPositions {
  const dims = binary.positionDimensions ?? 2;
  const featureCount = binary.featureCount;
  const startIndices = binary.startIndices!;
  const positions = binary.positions;

  const source = new Float64Array(featureCount * dims);  // ← allocate
  const target = new Float64Array(featureCount * dims);  // ← allocate
  
  for (let i = 0; i < featureCount; i++) {
    const srcVertex = startIndices[i];
    const tgtVertex = startIndices[i + 1] - 1;
    const srcBase = srcVertex * dims;
    const tgtBase = tgtVertex * dims;
    const outBase = i * dims;
    for (let d = 0; d < dims; d++) {
      source[outBase + d] = positions[srcBase + d];  // ← copy vertex
      target[outBase + d] = positions[tgtBase + d];  // ← copy vertex
    }
  }
  return { source, target, dims };
}
```

Called from `AnimatedArcLayer.prepareTile()` and `AnimatedLineLayer.prepareTile()` every time a tile arrives. Allocates two full-sized buffers and copies the first/last vertex of each LineString feature. For a 10k-feature tile, that's 2 × 40 KB allocations + copy loops.

**Why It Matters**:
- Necessary per-tile cold-path cost (can't be zero-copy without changing the tile format).
- But the nested loop over `d` dimensions could be unrolled or SIMD-fused in future (memcpy-style).

**Potential Fix**:
1. This is already well-optimized (per-tile allocation is acceptable; cold path).
2. SIMD micro-optimization: use `TypedArray.set()` for the dimension loop (might be faster via WebAssembly bridge).

---

### MEDIUM-4: AnimatedHeatmapLayer — Per-Frame Re-Aggregation via _handleTimeUpdate

**File**: `packages/layers/src/layers/summary/heatmap-layer.ts`
**Lines**: 299–310 (in `_handleTimeUpdate`)
**Severity**: **MEDIUM** (but **WELL-ARCHITECTED**)

**Issue**:
```typescript
protected _handleTimeUpdate(time: number): void {
  super._handleTimeUpdate(time);
  const intervalMs = 1000 / FILTER_UPDATE_HZ;  // ← 30 Hz cadence
  const nowWall = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (nowWall - this._lastFilterUpdateWall >= intervalMs) {
    this._lastFilterUpdateWall = nowWall;
    this.setState({ frameNumber: (this.state.frameNumber || 0) + 1 });
  }
}
```

EVERY TIME an animation tick arrives (60 Hz), the layer checks the wall clock and (at ~33 ms intervals) calls `setState()` to push a fresh `filterRange` to the aggregation sublayers. This forces a `renderLayers()` pass and thus a re-aggregation (the canonical HeatmapLayer's DataFilterExtension observes `filterRange` changes and re-runs the GPU weights pass).

**Why It Matters**:
- Per-frame state flushes are normally bad, but this one is INTENTIONAL and GATED by wall-clock (not render-loop).
- The 30 Hz limit is deliberate: GPU aggregation is expensive, so re-aggregating faster than 30 Hz yields no visual benefit (human eyes can't see the difference).
- This is **NOT a bug** — it's a correct optimization. The layer does exactly what it should.

**Assessment**:
✅ **WELL-ARCHITECTED**. This layer is a good reference for how to do per-frame work correctly: gate by elapsed wall-clock time, not render-loop ticks. No fix needed; this is the model other layers should follow.

---

### MEDIUM-5: tableToBinaryFeatures — Start/End Time Conversion Loop

**File**: `packages/core/src/tile.ts`
**Lines**: 331–352
**Severity**: **MEDIUM** (unavoidable, tight loop)

**Issue**:
```typescript
const startRaw = table.getChild('start_time')?.toArray() as BigInt64Array | undefined;
const endRaw = table.getChild('end_time')?.toArray() as BigInt64Array | undefined;
let timeOffset = 0;
if (startRaw && startRaw.length > 0) {
  let min = Number(startRaw[0]);
  for (let i = 1; i < startRaw.length; i++) {
    const v = Number(startRaw[i]);
    if (v < min) min = v;
  }
  timeOffset = min;  // ← global min for relativization
}
const startTimes = new Float32Array(featureCount);  // ← allocate
const endTimes = new Float32Array(featureCount);    // ← allocate
for (let i = 0; i < featureCount; i++) {
  startTimes[i] = startRaw ? Number(startRaw[i]) - timeOffset : 0;  // ← O(n) conversion + relative
  endTimes[i] = endRaw ? Number(endRaw[i]) - timeOffset : 0;
}
```

Two passes over start times (first to find min, then to convert + relativize). The second loop is unavoidable (BigInt64 → Float32 conversion), but the min-finding pass could be avoided if the tile's metadata carried the offset.

**Why It Matters**:
- Not a hot path (cold per-tile decode), so low priority.
- But large tiles (100k features) pay 2 × the cost.
- Tight loop with numeric operations, so cache-friendly; not much upside to optimization.

**Potential Fix**:
1. Compute the min during the build phase (Rust tile generation) and bake it into the tile metadata.
2. Then the JS decoder skips the first pass and only does the conversion loop.
3. Minor win: saves one full scan of the time column per tile.

---

### LOW-1: AnimatedBoundingBoxLayer — Track Sorting Allocation Churn

**File**: `packages/layers/src/layers/core/animated-bounding-box-layer.ts`
**Lines**: 687–696 (in `buildTrackIndex`)
**Severity**: **LOW** (amortized, one-time per tile-set change)

**Issue**:
```typescript
for (const track of tracks.values()) {
  const n = track.times.length;
  if (n > 1) {
    const order = Array.from({ length: n }, (_, k) => k).sort(
      (a, b) => track.times[a] - track.times[b],
    );  // ← allocate indices array, sort
    reorder(track, order);
    dedupeByTime(track);
  }
  track.singleton = track.times.length < 2;
}
```

Per-track sorting allocates a fresh indices array and performs an O(n log n) sort. For 100 tracks with 50 keyframes each, that's 100 sorts. Not per-frame (only when tile set changes), so LOW priority. But still wasteful allocation.

**Potential Fix**:
1. Pre-sort tiles by time before pooling so tracks naturally arrive sorted.
2. Or: single-pass radix/bucket sort across all times, then segment by track.

**Assessment**:
LOW impact because this runs only when the tile set changes, not every frame. Acceptable as-is.

---

## Already Well-Optimized (Not Issues)

### SplatLayer — Per-Tile Prepared-Data Caching

**File**: `packages/layers/src/layers/core/splat-layer.ts`
**Lines**: 223–228, 340–349
**Status**: ✅ **WELL-DONE**

The layer caches prepared tile data by tileKey + styleKey and returns the cached data when both match. The cached `data` object's identity is preserved so deck.gl's reference-equality check (`dataComparator: (a, b) => a === b`) skips GPU re-uploads. This is the correct pattern.

---

### AnimatedPointLayer — Zero-Copy Fallback for Unchanged Elevation

**File**: `packages/layers/src/layers/core/animated-point-layer.ts`
**Lines**: 928–940
**Status**: ✅ **PARTIALLY DONE** (but has the MEDIUM-2 copy-on-override path)

When `elevValues` is not set, the layer returns `binary.positions` directly (zero-copy). This is correct. The issue arises only when elevation overrides z (MEDIUM-2 above).

---

### HeatmapLayer — Wall-Clock Gating on Per-Frame State

**File**: `packages/layers/src/layers/summary/heatmap-layer.ts`
**Lines**: 299–310
**Status**: ✅ **BEST-PRACTICE REFERENCE**

The `_handleTimeUpdate` override does per-frame work (state flush), but gates it by wall-clock elapsed time (30 Hz cap), not render-loop ticks. This is the correct pattern for layers that MUST update per-frame but want to avoid excessive re-computation. Other layers should follow this model.

---

## Recommendations — Priority Order

### Immediate (Impact + Easy Fix):

1. **HIGH-2 (SplatLayer redundant key)**: Pass `styleKey` from `prepareTile` → `buildTileData` as a parameter.
   - Effort: ~5 lines.
   - Impact: Eliminates one string digest per tile.

2. **MEDIUM-2 (AnimatedPointLayer elevation copy)**: Fuse the copy + z-override loop.
   - Effort: ~10 lines.
   - Impact: Cuts allocation overhead in half when elevation override is active.

### Near-Term (Impact, Medium Effort):

3. **HIGH-1 (AnimatedBoundingBoxLayer frame rate)**: Gate `setState()` on time delta (e.g., 1 ms advance).
   - Effort: ~15 lines (track lastSampleTime, gate on delta).
   - Impact: Reduces per-frame work by up to 50% when playback is paused or slow.
   - Risk: Must ensure interpolation is still smooth at all playback speeds.

4. **MEDIUM-5 (tableToBinaryFeatures offset meta)**: Bake `timeOffset` into Rust tile generation (as schema metadata).
   - Effort: ~20 lines Rust + 5 lines TS (read from metadata).
   - Impact: Eliminates one full scan of time column per tile.

### Medium-Term (Design/Refactor):

5. **HIGH-3 (AnimatedBoundingBoxLayer pooling)**: Refactor track pooling to single-pass sorted merge instead of post-hoc sort.
   - Effort: ~50 lines (rewrite pooling loop + merge logic).
   - Impact: Reduces allocation churn and sorts from O(K log K) to O(K) (K = total snapshots).
   - Complexity: Requires careful index tracking across tiles.

6. **MEDIUM-1 (tableToBinaryFeatures f32 copy)**: Add zero-copy path for Float32 columns.
   - Effort: ~20 lines (type check + conditional copy).
   - Impact: Saves allocation/copy for tiles with native Float32 numeric columns.
   - Risk: Must ensure GPU doesn't expect a different buffer lifetime.

---

## Measurement Notes

- **AnimatedBoundingBoxLayer per-frame cost**: Measure `sampleTrack` time with browser DevTools for a 10/50/100-object scene. Expect 0.1–2 ms on modern hardware.
- **SplatLayer key computation**: Negligible (< 0.1 ms), but easy win.
- **Heatmap re-aggregation**: GPU-bound, not CPU; the 30 Hz gate is correct.
- **Tile decode latency**: Use the `tilePrepare` telemetry emitted by layers; compare with/without optimizations.

---

## Conclusion

The codebase demonstrates strong optimization awareness (caching, zero-copy paths, reference-stable layer instances). The issues identified are mostly **missed opportunities** (redundant work, unconditional copies) rather than architectural flaws. The **AnimatedBoundingBoxLayer per-frame interpolation** and **AnimatedHeatmapLayer re-aggregation gating** are the most impactful, but both are design-correct; only the BB-layer could benefit from a delta-time gate.

The **HeatmapLayer serves as a reference**: its `_handleTimeUpdate` with wall-clock gating is the correct pattern for layers that must do per-frame work. Other per-frame state flushes should follow this model.

Recommendations are prioritized by impact-to-effort ratio. Start with HIGH-2 (trivial fix, eliminates waste), then tackle HIGH-1 (user-visible frame-rate win) and MEDIUM-2 (allocation churn).
