# Delta Encoding Code Issues - Line-by-Line Analysis

## Issue 1: Delta Encoding Disabled

**File:** `crates/stt-build/src/main.rs`  
**Line:** 165

```rust
use_delta_encoding: false, // TODO: Make configurable
```

**Problem:** The flag that would enable delta encoding is hardcoded to `false`.

**Fix:**

```rust
use_delta_encoding: args.delta_encoding.unwrap_or(true),
```

And add to CLI args:

```rust
#[arg(long, default_value = "true")]
delta_encoding: bool,
```

---

## Issue 2: Delta Tracker Never Instantiated

**File:** `crates/stt-build/src/tiler.rs`  
**Lines:** 8, 199-236

```rust
// Line 8: Imported but never used
use stt_core::delta::{TemporalDeltaTracker, hash_feature};

// Lines 199-236: Tile generation with NO delta tracking
pub fn generate_tiles(
    features: &[ParsedFeature],
    config: &TileConfig,
    workers: usize,
) -> Result<Vec<GeneratedTile>> {
    // ... grouping logic ...

    let tiles: Vec<GeneratedTile> = tile_map
        .par_iter()
        .filter_map(|(tile_id, features)| {
            match create_tile(*tile_id, features, config) {
                // ❌ No delta tracker passed here
                Ok(tile) => Some(tile),
                Err(e) => {
                    tracing::warn!("Failed to create tile {:?}: {}", tile_id, e);
                    None
                }
            }
        })
        .collect();

    Ok(tiles)
}
```

**Problem:** `TemporalDeltaTracker` is imported but never instantiated or used.

**Fix:**

```rust
pub fn generate_tiles(
    features: &[ParsedFeature],
    config: &TileConfig,
    workers: usize,
) -> Result<Vec<GeneratedTile>> {
    // ... setup ...

    // Group by spatial location first
    let mut spatial_groups: HashMap<(u8, u32, u32), Vec<(TileId, Vec<&ParsedFeature>)>> = HashMap::new();

    for (tile_id, features) in tile_map {
        let spatial_key = (tile_id.z, tile_id.x, tile_id.y);
        spatial_groups
            .entry(spatial_key)
            .or_insert_with(Vec::new)
            .push((tile_id, features));
    }

    // Process each spatial location across time
    let mut tiles = Vec::new();

    for ((z, x, y), mut temporal_tiles) in spatial_groups {
        // Sort by time to enable delta tracking
        temporal_tiles.sort_by_key(|(id, _)| id.t);

        // One tracker per spatial tile
        let mut delta_tracker = if config.use_delta_encoding {
            Some(TemporalDeltaTracker::new())
        } else {
            None
        };

        for (tile_id, features) in temporal_tiles {
            let tile = create_tile(tile_id, &features, config, &mut delta_tracker)?;
            tiles.push(tile);
        }
    }

    Ok(tiles)
}
```

---

## Issue 3: create_tile() Doesn't Accept Delta Tracker

**File:** `crates/stt-build/src/tiler.rs`  
**Lines:** 322-354

```rust
fn create_tile(
    tile_id: TileId,
    features: &[&ParsedFeature],
    config: &TileConfig,
    // ❌ Missing: delta_tracker parameter
) -> Result<GeneratedTile> {
    let mut proto_features = Vec::new();
    // ...

    for feature in features {
        // ❌ No delta comparison
        let proto_feature = convert_feature(
            feature,
            tile_id,
            config,
            &mut keys,
            &mut values,
            &mut key_map,
            &mut value_map,
        )?;

        proto_features.push(proto_feature);
    }

    // ...
}
```

**Problem:** Function signature doesn't accept delta tracker, so comparison is impossible.

**Fix:**

```rust
fn create_tile(
    tile_id: TileId,
    features: &[&ParsedFeature],
    config: &TileConfig,
    delta_tracker: &mut Option<TemporalDeltaTracker>, // ✅ Add parameter
) -> Result<GeneratedTile> {
    let mut proto_features = Vec::new();
    // ...

    // Convert features to internal format for delta comparison
    let internal_features: Vec<stt_core::tile::Feature> = features
        .iter()
        .map(|f| parsed_to_internal_feature(f, tile_id, config))
        .collect::<Result<Vec<_>>>()?;

    // Apply delta tracking if enabled
    let features_with_changes = if let Some(tracker) = delta_tracker {
        tracker.process_frame(internal_features)
    } else {
        // No delta tracking - mark all as CREATED
        internal_features
            .into_iter()
            .map(|f| (f, stt_core::delta::ChangeType::Created))
            .collect()
    };

    // Encode to proto
    for (feature, change_type) in features_with_changes {
        let proto_feature = internal_feature_to_proto(
            &feature,
            change_type,
            &mut keys,
            &mut values,
            &mut key_map,
            &mut value_map,
        )?;

        proto_features.push(proto_feature);
    }

    // ...
}
```

---

## Issue 4: Encoding Ignores Change Type

**File:** `crates/stt-core/src/encoding.rs`  
**Lines:** 136-145

```rust
fn feature_to_proto(
    feature: &Feature,
    keys: &mut Vec<String>,
    values: &mut Vec<crate::proto::Value>,
    key_map: &mut std::collections::HashMap<String, u32>,
    value_map: &mut std::collections::HashMap<String, u32>,
) -> Result<crate::proto::Feature> {
    // ... property encoding ...

    Ok(crate::proto::Feature {
        id: feature.id,
        r#type: feature.geometry_type.to_proto(),
        geometry: feature.geometry.clone(), // ❌ Always includes geometry
        tags,
        valid_from,
        valid_to,
        previous_hash: 0,  // ❌ Hardcoded
        change: 0,         // ❌ Hardcoded to UNCHANGED
    })
}
```

**Problem:** Function doesn't accept `ChangeType` parameter and hardcodes all values.

**Fix:**

```rust
fn feature_to_proto(
    feature: &Feature,
    change_type: crate::delta::ChangeType, // ✅ Add parameter
    keys: &mut Vec<String>,
    values: &mut Vec<crate::proto::Value>,
    key_map: &mut std::collections::HashMap<String, u32>,
    value_map: &mut std::collections::HashMap<String, u32>,
) -> Result<crate::proto::Feature> {
    // Only encode properties for non-UNCHANGED features
    let tags = if matches!(change_type, crate::delta::ChangeType::Unchanged(_)) {
        vec![] // ✅ Skip properties for unchanged features
    } else {
        let mut tags = Vec::new();
        for (key, value) in &feature.properties {
            // ... encode as before ...
        }
        tags
    };

    // Only encode geometry for non-UNCHANGED features
    let geometry = if matches!(change_type, crate::delta::ChangeType::Unchanged(_)) {
        vec![] // ✅ Skip geometry for unchanged features
    } else {
        feature.geometry.clone()
    };

    // Extract hash if UNCHANGED
    let (previous_hash, change_enum) = match change_type {
        crate::delta::ChangeType::Unchanged(hash) => (hash.to_u64(), 0),
        crate::delta::ChangeType::Created => (0, 1),
        crate::delta::ChangeType::Modified => (0, 2),
        crate::delta::ChangeType::Deleted => (0, 3),
    };

    Ok(crate::proto::Feature {
        id: feature.id,
        r#type: feature.geometry_type.to_proto(),
        geometry,  // ✅ May be empty
        tags,      // ✅ May be empty
        valid_from,
        valid_to,
        previous_hash, // ✅ Set correctly
        change: change_enum, // ✅ Set correctly
    })
}
```

---

## Issue 5: Frontend Ignores Change Type

**File:** `packages/core/src/tile.ts`  
**Lines:** 22-53

```typescript
const features: Feature[] = (protoLayer.features || []).map((protoFeature) => {
  // Decode properties from tags
  const properties: Record<string, PropertyValue> = {};
  const tags = protoFeature.tags || [];
  const keys = protoLayer.keys || [];
  const values = protoLayer.values || [];

  for (let i = 0; i < tags.length; i += 2) {
    const keyIdx = tags[i];
    const valIdx = tags[i + 1];
    if (keyIdx < keys.length && valIdx < values.length) {
      const key = keys[keyIdx];
      const value = values[valIdx];
      if (key && value) {
        properties[key] = protoValueToValue(value);
      }
    }
  }

  return {
    id: Number(protoFeature.id) || 0,
    type: protoGeomTypeToType(protoFeature.type || 0),
    geometry: Array.from(protoFeature.geometry || []),
    properties,
    timeRange:
      protoFeature.validFrom && protoFeature.validTo
        ? {
            start: Number(protoFeature.validFrom),
            end: Number(protoFeature.validTo),
          }
        : undefined,
    // ❌ Missing: changeType field
  };
});
```

**Problem:** Decoder doesn't read `change` or `previousHash` fields, and doesn't maintain feature cache.

**Fix:**

```typescript
/**
 * Tile decoder with delta reconstruction support
 */
export class DeltaTileDecoder {
  // Cache features across tiles for delta reconstruction
  private featureCache: Map<number, Feature> = new Map();

  /**
   * Decode a tile and reconstruct UNCHANGED features from cache
   */
  decodeTile(data: Uint8Array, id: TileId): Tile {
    const protoTile = stt.Tile.decode(data);

    const layers: Layer[] = (protoTile.layers || []).map((protoLayer) => {
      const features: Feature[] = [];

      for (const protoFeature of (protoLayer.features || [])) {
        const changeType = protoFeature.change || 0;

        if (changeType === 0) { // UNCHANGED
          // ✅ Reconstruct from cache
          const featureId = Number(protoFeature.id) || 0;
          const cached = this.featureCache.get(featureId);

          if (cached) {
            features.push(cached);
          } else {
            console.warn(
              `Missing cache entry for UNCHANGED feature ${featureId} in tile ${id.z}/${id.x}/${id.y}/${id.t}`
            );
            // Skip this feature or decode with empty geometry (will fail)
          }
        } else {
          // ✅ Decode normally
          const feature = this.decodeFeature(protoFeature, protoLayer);

          // Cache for future UNCHANGED references
          this.featureCache.set(feature.id, feature);

          features.push(feature);
        }
      }

      return {
        name: protoLayer.name || 'default',
        extent: protoLayer.extent || 4096,
        features,
      };
    });

    return {
      id,
      timeRange: {
        start: Number(protoTile.timeStart),
        end: Number(protoTile.timeEnd),
      },
      layers,
      temporalResolution: /* ... */,
    };
  }

  private decodeFeature(
    protoFeature: stt.Feature,
    protoLayer: stt.Layer
  ): Feature {
    // ... existing decode logic ...

    return {
      id: Number(protoFeature.id) || 0,
      type: protoGeomTypeToType(protoFeature.type || 0),
      geometry: Array.from(protoFeature.geometry || []),
      properties,
      timeRange: /* ... */,
      changeType: protoFeature.change as ChangeType,
    };
  }

  /**
   * Clear the cache (e.g., when switching datasets)
   */
  clearCache() {
    this.featureCache.clear();
  }
}

// Export singleton instance
export const tileDecoder = new DeltaTileDecoder();

// Update decodeTile() to use it
export function decodeTile(data: Uint8Array, id: TileId): Tile {
  return tileDecoder.decodeTile(data, id);
}
```

---

## Issue 6: Hash Truncation Loses Data

**File:** `crates/stt-core/src/delta.rs`  
**Lines:** 22-27

```rust
pub fn to_u64(&self) -> u64 {
    u64::from_le_bytes([
        self.0[0], self.0[1], self.0[2], self.0[3],
        self.0[4], self.0[5], self.0[6], self.0[7],
    ])
}
```

**Problem:** blake3 produces 32-byte hashes, but only 8 bytes are used. This increases collision risk.

**Analysis:**

- 32-byte hash = 2^256 possible values (collision probability ≈ 0)
- 8-byte hash = 2^64 possible values (collision probability ≈ 1 in 18 quintillion)
- For 10,000 features: collision probability ≈ 0.000003% (acceptable)
- For 1,000,000 features: collision probability ≈ 0.03% (risky)

**Options:**

### Option A: Use full hash (best)

```protobuf
// In proto/tile.proto
bytes previous_hash = 7; // ✅ Store all 32 bytes
```

```rust
// In delta.rs
pub fn to_bytes(&self) -> &[u8; 32] {
    &self.0
}
```

### Option B: Use better truncation (good)

```rust
// Use first 16 bytes instead of 8
pub fn to_u128(&self) -> u128 {
    u128::from_le_bytes([
        self.0[0], self.0[1], self.0[2], self.0[3],
        self.0[4], self.0[5], self.0[6], self.0[7],
        self.0[8], self.0[9], self.0[10], self.0[11],
        self.0[12], self.0[13], self.0[14], self.0[15],
    ])
}
```

```protobuf
// In proto/tile.proto - use two uint64s
uint64 previous_hash_low = 7;
uint64 previous_hash_high = 8;
```

### Option C: Keep current (acceptable for small datasets)

```rust
// Add collision detection
impl TemporalDeltaTracker {
    pub fn process_frame(&mut self, features: Vec<Feature>) -> Vec<(Feature, ChangeType)> {
        // ... existing logic ...

        // Check for hash collisions
        let mut hash_counts: HashMap<u64, usize> = HashMap::new();
        for hash in self.previous_hashes.values() {
            *hash_counts.entry(hash.to_u64()).or_insert(0) += 1;
        }

        for (hash_u64, count) in hash_counts {
            if count > 1 {
                tracing::warn!("Hash collision detected: {} features share hash 0x{:x}", count, hash_u64);
            }
        }

        // ...
    }
}
```

---

## Issue 7: No Test Coverage

**File:** `crates/stt-core/src/delta.rs`  
**Lines:** 193-268

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_feature_hashing() {
        // ✅ This test exists
    }

    #[test]
    fn test_delta_tracking() {
        // ✅ This test exists
    }

    #[test]
    fn test_feature_deletion() {
        // ✅ This test exists
    }

    // ❌ Missing: integration test with encoding
    // ❌ Missing: test that UNCHANGED features omit geometry
    // ❌ Missing: test hash collision handling
    // ❌ Missing: test with real-world data
}
```

**Fix:**

```rust
#[test]
fn test_delta_encoding_omits_geometry() {
    let mut tracker = TemporalDeltaTracker::new();

    // Frame 1
    let frame1 = vec![create_test_feature(1, 100, 200)];
    tracker.process_frame(frame1);

    // Frame 2 - same feature
    let frame2 = vec![create_test_feature(1, 100, 200)];
    let results = tracker.process_frame(frame2);

    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].1, ChangeType::Unchanged(_)));

    // Encode to proto
    let proto = feature_to_proto_with_change(&results[0].0, results[0].1, &mut vec![], &mut vec![], &mut HashMap::new(), &mut HashMap::new()).unwrap();

    // Verify geometry is empty for UNCHANGED
    assert_eq!(proto.geometry.len(), 0);
    assert_eq!(proto.change, 0);
    assert_ne!(proto.previous_hash, 0);
}

#[test]
fn test_hash_collision_detection() {
    // Create 100,000 random features
    let features: Vec<_> = (0..100_000)
        .map(|i| create_test_feature(i, i as u32 % 4096, i as u32 / 4096))
        .collect();

    // Hash all features
    let hashes: Vec<_> = features.iter().map(|f| hash_feature(f).to_u64()).collect();

    // Check for collisions
    let unique_hashes: std::collections::HashSet<_> = hashes.iter().collect();

    assert_eq!(
        hashes.len(),
        unique_hashes.len(),
        "Hash collision detected in {} features",
        hashes.len()
    );
}

#[test]
fn test_end_to_end_delta_encoding() {
    // Simulate 3 temporal tiles with delta encoding
    let mut tracker = TemporalDeltaTracker::new();

    // Tile T0: 3 ships
    let t0 = vec![
        create_test_feature(1, 100, 200),
        create_test_feature(2, 150, 250),
        create_test_feature(3, 200, 300),
    ];
    let results_t0 = tracker.process_frame(t0);
    assert_eq!(results_t0.iter().filter(|(_, ct)| matches!(ct, ChangeType::Created)).count(), 3);

    // Tile T1: Ship 1 unchanged, Ship 2 moved, Ship 3 deleted, Ship 4 created
    let t1 = vec![
        create_test_feature(1, 100, 200), // Unchanged
        create_test_feature(2, 160, 260), // Modified
        create_test_feature(4, 250, 350), // Created
    ];
    let results_t1 = tracker.process_frame(t1);

    assert_eq!(results_t1.iter().filter(|(_, ct)| matches!(ct, ChangeType::Unchanged(_))).count(), 1);
    assert_eq!(results_t1.iter().filter(|(_, ct)| matches!(ct, ChangeType::Modified)).count(), 1);
    assert_eq!(results_t1.iter().filter(|(_, ct)| matches!(ct, ChangeType::Created)).count(), 1);
    assert_eq!(tracker.stats.deleted_features, 1);
}
```

---

## Summary of Required Changes

| File          | Function             | Change Required                | Lines   | Effort  |
| ------------- | -------------------- | ------------------------------ | ------- | ------- |
| `main.rs`     | CLI args             | Add `--delta-encoding` flag    | 165     | 5 min   |
| `tiler.rs`    | `generate_tiles()`   | Reorder to sequential by time  | 199-236 | 2 hours |
| `tiler.rs`    | `create_tile()`      | Accept & use delta tracker     | 322-354 | 1 hour  |
| `tiler.rs`    | New function         | `parsed_to_internal_feature()` | New     | 30 min  |
| `encoding.rs` | `feature_to_proto()` | Accept & use ChangeType        | 100-146 | 1 hour  |
| `tile.ts`     | `decodeTile()`       | Add cache & reconstruction     | 18-80   | 3 hours |
| `tile.ts`     | New class            | `DeltaTileDecoder`             | New     | 2 hours |
| `delta.rs`    | `to_u64()`           | Expand to full hash            | 22-27   | 1 hour  |
| `delta.rs`    | Tests                | Add integration tests          | 268+    | 2 hours |

**Total Effort:** ~12-15 hours of development

**Testing Effort:** ~5-8 hours

**Total:** ~20-25 hours (3-4 days of focused work)
