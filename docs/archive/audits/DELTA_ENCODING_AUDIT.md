# Delta Encoding Audit Report

## Executive Summary

**STATUS: Delta encoding infrastructure exists but is NOT CONNECTED to the tile generation pipeline.**

The delta encoding system in `delta.rs` is well-designed but is currently unused, explaining why there are no rendering benefits from it. The system is explicitly disabled (`use_delta_encoding: false`) and was never integrated into the tile building process.

---

## Critical Issues Found

### 1. **Delta Encoding Is Completely Disabled** ❌

**Location:** `crates/stt-build/src/main.rs:165`

```rust
use_delta_encoding: false, // TODO: Make configurable
```

**Impact:** All tiles are built WITHOUT delta encoding, defeating the entire purpose of the system.

---

### 2. **Delta Tracker Is Never Instantiated** ❌

**Location:** `crates/stt-build/src/tiler.rs`

The `TemporalDeltaTracker` is imported but never used:

```rust
use stt_core::delta::{TemporalDeltaTracker, hash_feature}; // Line 8
```

But in the tile generation functions (`generate_tiles()` and `create_tile()`), there is NO instantiation or use of the tracker.

**Impact:** Features are never compared across temporal frames, so unchanged features are not deduplicated.

---

### 3. **Encoding Module Ignores Change Tracking** ❌

**Location:** `crates/stt-core/src/encoding.rs:143-144`

When encoding features to protobuf, the system hardcodes:

```rust
previous_hash: 0,     // No previous hash
change: 0,            // UNCHANGED (always)
```

**Impact:** Even if delta encoding were enabled, the hash references would be lost.

---

### 4. **Frontend Can't Handle UNCHANGED Features** ❌

**Location:** `packages/core/src/tile.ts:18-80`

The frontend decoder completely ignores the `change` and `previous_hash` fields:

```typescript
export function decodeTile(data: Uint8Array, id: TileId): Tile {
  const protoTile = stt.Tile.decode(data);
  const layers: Layer[] = (protoTile.layers || []).map((protoLayer) => {
    const features: Feature[] = (protoLayer.features || []).map((protoFeature) => {
      // ... property decoding ...

      return {
        id: Number(protoFeature.id) || 0,
        type: protoGeomTypeToType(protoFeature.type || 0),
        geometry: Array.from(protoFeature.geometry || []),
        properties,
        timeRange: /* ... */,
        // ❌ NO HANDLING OF: protoFeature.change or protoFeature.previousHash
      };
    });
  });
}
```

**Impact:** Even if UNCHANGED features were marked, the frontend has no logic to:

- Detect them
- Look up previous feature data
- Reconstruct the feature from the hash reference
- Maintain a feature cache across temporal tiles

---

### 5. **Proto Field Mismatch** ⚠️

**Location:** `proto/tile.proto:69`

The proto defines `previous_hash` as `uint64`:

```protobuf
uint64 previous_hash = 7;
```

But `FeatureHash` in `delta.rs` is a 32-byte blake3 hash. The `to_u64()` method only takes the first 8 bytes:

```rust
pub fn to_u64(&self) -> u64 {
    u64::from_le_bytes([
        self.0[0], self.0[1], self.0[2], self.0[3],
        self.0[4], self.0[5], self.0[6], self.0[7],
    ])
}
```

**Impact:** 75% of the hash data is discarded, significantly increasing collision risk. Two different features could have the same truncated hash.

---

### 6. **Tile-by-Tile Processing Breaks Delta Tracking** 🔴

**Location:** `crates/stt-build/src/tiler.rs:225-236`

Tiles are generated in parallel, independently:

```rust
let tiles: Vec<GeneratedTile> = tile_map
    .par_iter()  // ❌ Parallel iteration
    .filter_map(|(tile_id, features)| {
        match create_tile(*tile_id, features, config) {
            // Each tile created independently
        }
    })
    .collect();
```

**Impact:** Delta tracking requires sequential processing of temporal frames to compare features. The current parallel architecture makes this impossible without a major refactor.

---

## Architecture Analysis

### What Delta Encoding SHOULD Do

1. **Track features across time:** When processing tile at time T, compare features to tile at time T-1
2. **Mark unchanged features:** If feature geometry + properties match, mark as `UNCHANGED` and store hash reference
3. **Omit duplicate data:** For UNCHANGED features, don't re-encode geometry/properties
4. **Frontend reconstruction:** Reader maintains cache, reconstructs UNCHANGED features from previous tiles

### What It ACTUALLY Does

1. **Nothing** - The system is disabled
2. When enabled, it would still fail because:
   - Tiles are built in parallel (no temporal sequence)
   - Encoding ignores change tracking
   - Frontend has no reconstruction logic

---

## Why This Doesn't Break Rendering

The system currently works because:

1. **Every feature is fully encoded:** No delta encoding means every tile contains complete feature data
2. **Frontend expects complete features:** The decoder doesn't look for change tracking
3. **No dependencies between tiles:** Each tile is self-contained

However, this means:

- **Large file sizes:** Features are duplicated across every temporal tile
- **Wasted bandwidth:** Same ships/vehicles encoded thousands of times
- **Slower loading:** More data to decompress and parse

---

## Root Cause Summary

| Issue                            | Severity    | Location              |
| -------------------------------- | ----------- | --------------------- |
| Delta encoding flag disabled     | 🔴 Critical | `main.rs:165`         |
| Delta tracker never instantiated | 🔴 Critical | `tiler.rs`            |
| Encoding ignores change data     | 🔴 Critical | `encoding.rs:143-144` |
| Frontend lacks reconstruction    | 🔴 Critical | `tile.ts:18-80`       |
| Hash truncation                  | ⚠️ High     | `delta.rs:22-27`      |
| Parallel tile generation         | 🔴 Critical | `tiler.rs:225`        |

---

## Why You're Having Rendering Issues

**This is likely NOT the root cause of your rendering problems.**

Since delta encoding is completely disabled, your rendering issues must stem from:

1. Coordinate projection/encoding problems (already documented)
2. Temporal range queries not matching features
3. MVT geometry decoding errors
4. Time bucketing misalignment

The delta encoding system is ready to use but disconnected - it's not causing problems, but it's also not providing any benefits.

---

## Recommendations

### Option 1: Enable Delta Encoding (Major Refactor)

**Required Changes:**

1. **Reorder tile generation** to process temporally sequential

   ```rust
   // Sort tiles by time BEFORE parallel processing
   let mut sorted_tiles: Vec<_> = tile_map.into_iter().collect();
   sorted_tiles.sort_by_key(|(id, _)| id.t);

   // Process each spatial location across time
   let mut delta_trackers: HashMap<(u8, u32, u32), TemporalDeltaTracker> = HashMap::new();
   ```

2. **Integrate delta tracker** into `create_tile()`

   ```rust
   fn create_tile(
       tile_id: TileId,
       features: &[&ParsedFeature],
       config: &TileConfig,
       delta_tracker: &mut TemporalDeltaTracker,
   ) -> Result<GeneratedTile>
   ```

3. **Store change type** in encoding

   ```rust
   // In feature_to_proto()
   previous_hash: change_type.hash_u64(),
   change: change_type.to_proto(),
   ```

4. **Implement frontend reconstruction**

   ```typescript
   class TileCache {
     private featureCache: Map<number, Feature> = new Map();

     decodeTile(data: Uint8Array): Tile {
       // For each feature:
       if (feature.change === ChangeType.UNCHANGED) {
         const cached = this.featureCache.get(feature.id);
         if (cached) return cached;
       } else {
         this.featureCache.set(feature.id, feature);
       }
     }
   }
   ```

5. **Expand hash storage** to full 32 bytes or use better truncation

**Effort:** 2-3 weeks  
**Risk:** High - changes core architecture  
**Benefit:** 50-80% file size reduction for repetitive features

---

### Option 2: Remove Unused Code (Recommended Short-Term)

If delta encoding isn't a priority:

1. Remove `delta.rs` module
2. Remove `previous_hash` and `change` from proto
3. Remove `use_delta_encoding` config flag
4. Simplify encoding logic

**Effort:** 1-2 days  
**Risk:** Low  
**Benefit:** Cleaner codebase, less confusion

---

### Option 3: Fix Real Rendering Issues First (Recommended)

Focus on the actual rendering problems:

1. Verify coordinate projection is correct
2. Check temporal queries match feature `valid_from`/`valid_to`
3. Validate MVT geometry decoding
4. Test time bucketing alignment

**Effort:** Depends on root cause  
**Risk:** Low  
**Benefit:** Actually fixes rendering

---

## Testing Recommendations

If you choose Option 1, test with:

1. **Small dataset:** 100 features, 10 temporal tiles
2. **Verify deduplication:** Check stats show `unchanged_features > 0`
3. **Frontend cache:** Log cache hits/misses
4. **Hash collisions:** Monitor for duplicate truncated hashes
5. **Compare outputs:** Delta-encoded vs. full encoding should render identically

---

## Conclusion

The delta encoding infrastructure is **architecturally sound but functionally disconnected**. It's not causing your rendering issues - it's simply not being used at all.

**Next Steps:**

1. Fix current rendering issues (not related to delta encoding)
2. Decide if delta encoding is worth the implementation effort
3. Either implement it properly or remove the unused code
