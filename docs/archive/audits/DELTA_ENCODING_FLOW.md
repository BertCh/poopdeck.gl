# Delta Encoding Data Flow Analysis

## Current State: Completely Disconnected

```
┌─────────────────────────────────────────────────────────────────┐
│                    TILE BUILDING PIPELINE                        │
└─────────────────────────────────────────────────────────────────┘

Input GeoJSON → load_features() → ParsedFeature[]
                                   │
                                   ├─ Group by (x, y, z, t)
                                   │
                                   ▼
                          ┌─────────────────┐
                          │  tile_map       │
                          │  HashMap        │
                          └─────────────────┘
                                   │
                                   ├─ .par_iter() [PARALLEL]
                                   │
                          ┌────────▼─────────┐
                          │  create_tile()   │
                          │                  │
                          │  ❌ NO DELTA     │
                          │  ❌ NO TRACKER   │
                          │  ❌ NO HISTORY   │
                          └──────────────────┘
                                   │
                                   ├─ convert_feature()
                                   │
                          ┌────────▼──────────┐
                          │ proto::Feature {  │
                          │   change: 0,      │ ← Always UNCHANGED
                          │   previous_hash: 0│ ← Never set
                          │ }                 │
                          └───────────────────┘
                                   │
                                   ▼
                          stt_core::Archive
                                   │
                                   ▼
                          Output .stt file


┌─────────────────────────────────────────────────────────────────┐
│           DELTA MODULE (delta.rs) - NEVER CALLED                 │
└─────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────┐
                    │TemporalDeltaTracker │  ← Imported but unused
                    │                     │
                    │ .process_frame()    │  ← Never called
                    │ .get_feature_by_hash│  ← Never called
                    │                     │
                    │ Stats:              │
                    │  unchanged: 0       │
                    │  modified: 0        │
                    │  new: 0             │
                    └─────────────────────┘
                            👻
                    [Ghost Module]


┌─────────────────────────────────────────────────────────────────┐
│                 FRONTEND DECODING PIPELINE                       │
└─────────────────────────────────────────────────────────────────┘

Load .stt → STTArchive.getTile() → proto::Tile bytes
                                        │
                                        ▼
                                 decodeTile()
                                        │
                          ┌─────────────┴─────────────┐
                          │                           │
                          │  return {                 │
                          │    id,                    │
                          │    type,                  │
                          │    geometry,              │
                          │    properties,            │
                          │    timeRange              │
                          │  }                        │
                          │                           │
                          │  ❌ Ignores: change       │
                          │  ❌ Ignores: previous_hash│
                          │  ❌ No feature cache      │
                          │  ❌ No reconstruction     │
                          └───────────────────────────┘
                                        │
                                        ▼
                        AnimatedPointLayer.renderLayers()
                                        │
                                        ├─ Extract features
                                        ├─ Filter by time
                                        │
                                        ▼
                                 ScatterplotLayer
                                        │
                                        ▼
                                  GPU rendering
```

---

## What SHOULD Happen (If Delta Encoding Worked)

```
┌─────────────────────────────────────────────────────────────────┐
│          TILE BUILDING WITH DELTA TRACKING                       │
└─────────────────────────────────────────────────────────────────┘

Input GeoJSON → load_features() → ParsedFeature[]
                                   │
                                   ├─ Group by (x, y, z)
                                   ├─ Sort by t (temporal order)
                                   │
                     ┌─────────────▼──────────────┐
                     │ For each spatial tile:     │
                     │   tracker = new Tracker()  │ ← ONE per (x,y,z)
                     └─────────────┬──────────────┘
                                   │
                     ┌─────────────▼──────────────┐
                     │ For time T₀:               │
                     │   features = [A, B, C]     │
                     │   result = tracker.process │
                     │   → All CREATED            │
                     └─────────────┬──────────────┘
                                   │
                                   ├─ encode_tile(T₀)
                                   │
                     ┌─────────────▼──────────────┐
                     │ For time T₁:               │
                     │   features = [A, B, D]     │
                     │   result = tracker.process │
                     │   → A: UNCHANGED (hash ref)│
                     │   → B: UNCHANGED (hash ref)│
                     │   → C: DELETED             │
                     │   → D: CREATED             │
                     └─────────────┬──────────────┘
                                   │
                                   ├─ encode_tile(T₁)
                                   │     A: {geometry: [], change: 0, hash: 0x123}
                                   │     B: {geometry: [], change: 0, hash: 0x456}
                                   │     D: {geometry: [1,2,3], change: 1, hash: 0}
                                   │
                                   ▼
                          Archive with delta tiles


┌─────────────────────────────────────────────────────────────────┐
│            FRONTEND WITH DELTA RECONSTRUCTION                    │
└─────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────┐
                    │  TileCache           │
                    │                      │
                    │  featureCache: Map   │ ← Cross-tile cache
                    │    id → Feature      │
                    └──────┬───────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     Decode T₀        Decode T₁        Decode T₂
          │                │                │
    ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
    │ A CREATED │    │ A UNCHANGED│    │ A UNCHANGED│
    │ B CREATED │    │ B UNCHANGED│    │ B MODIFIED │
    │ C CREATED │    │ D CREATED  │    │ D UNCHANGED│
    └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
          │                │                │
          ├─ Store A,B,C  ├─ Lookup A,B    ├─ Lookup A,D
          │  in cache      │  Store D       │  Update B
          │                │                │
          ▼                ▼                ▼
    [A,B,C]          [A,B,D]          [A,B',D]
       │                │                │
       └────────────────┴────────────────┘
                        │
                        ▼
              AnimatedPointLayer


┌─────────────────────────────────────────────────────────────────┐
│                     SIZE COMPARISON                              │
└─────────────────────────────────────────────────────────────────┘

WITHOUT Delta Encoding (Current):
  Tile T₀: [A, B, C]        100 features × 50 bytes = 5,000 bytes
  Tile T₁: [A, B, D]        100 features × 50 bytes = 5,000 bytes
  Tile T₂: [A, B', D]       100 features × 50 bytes = 5,000 bytes

  Total: 15,000 bytes

WITH Delta Encoding:
  Tile T₀: [A, B, C]        100 features × 50 bytes = 5,000 bytes
  Tile T₁: [A_ref, B_ref, D] 2 refs × 8 + 50 bytes  = 66 bytes
  Tile T₂: [A_ref, B', D_ref] 2 refs × 8 + 50 bytes = 66 bytes

  Total: 5,132 bytes (66% reduction!)


┌─────────────────────────────────────────────────────────────────┐
│                   REAL-WORLD EXAMPLE                             │
└─────────────────────────────────────────────────────────────────┘

AIS Ship Dataset:
  - 10,000 ships
  - 1,000 temporal tiles (hourly for 6 weeks)
  - Each ship appears in ~500 tiles
  - 90% of ships don't change geometry

Current size:
  10,000 ships × 1,000 tiles × 200 bytes = 2,000 MB

With delta encoding:
  10,000 ships × 200 bytes (first tile) = 2 MB
  9,000 unchanged × 1,000 tiles × 8 bytes = 72 MB
  1,000 moving × 1,000 tiles × 200 bytes = 200 MB

  Total: 274 MB (86% reduction!)
```

---

## Critical Missing Links

### 1. Build-Time Integration

**File:** `crates/stt-build/src/tiler.rs`

```rust
// CURRENT (Lines 225-236):
let tiles: Vec<GeneratedTile> = tile_map
    .par_iter()  // ❌ Parallel - no temporal ordering
    .filter_map(|(tile_id, features)| {
        match create_tile(*tile_id, features, config) {
            // ❌ No delta tracker passed
        }
    })
    .collect();

// NEEDED:
let mut tiles = Vec::new();
let mut trackers: HashMap<(u8, u32, u32), TemporalDeltaTracker> = HashMap::new();

// Group by spatial location
let mut spatial_groups: HashMap<(u8, u32, u32), Vec<(TileId, Vec<&ParsedFeature>)>> = HashMap::new();
for ((tile_id, features)) in tile_map {
    let spatial_key = (tile_id.z, tile_id.x, tile_id.y);
    spatial_groups.entry(spatial_key).or_insert_with(Vec::new).push((tile_id, features));
}

// Process each spatial location temporally
for ((z, x, y), mut temporal_tiles) in spatial_groups {
    // Sort by time
    temporal_tiles.sort_by_key(|(id, _)| id.t);

    let tracker = trackers.entry((z, x, y)).or_insert_with(TemporalDeltaTracker::new);

    for (tile_id, features) in temporal_tiles {
        let tile = create_tile(tile_id, features, config, tracker)?;
        tiles.push(tile);
    }
}
```

---

### 2. Encoding Integration

**File:** `crates/stt-core/src/encoding.rs`

```rust
// CURRENT (Lines 136-145):
Ok(crate::proto::Feature {
    id: feature.id,
    r#type: feature.geometry_type.to_proto(),
    geometry: feature.geometry.clone(),
    tags,
    valid_from,
    valid_to,
    previous_hash: 0,     // ❌ Hardcoded
    change: 0,            // ❌ Hardcoded
})

// NEEDED:
Ok(crate::proto::Feature {
    id: feature.id,
    r#type: feature.geometry_type.to_proto(),
    geometry: match &feature.change_type {
        Some(ChangeType::Unchanged(_)) => vec![], // ✅ Omit geometry
        _ => feature.geometry.clone(),
    },
    tags: match &feature.change_type {
        Some(ChangeType::Unchanged(_)) => vec![], // ✅ Omit properties
        _ => tags,
    },
    valid_from,
    valid_to,
    previous_hash: feature.change_type
        .as_ref()
        .and_then(|ct| {
            if let ChangeType::Unchanged(hash) = ct {
                Some(hash.to_u64())
            } else {
                None
            }
        })
        .unwrap_or(0),
    change: feature.change_type
        .as_ref()
        .map(|ct| ct.to_proto())
        .unwrap_or(1), // Default to CREATED
})
```

---

### 3. Frontend Integration

**File:** `packages/core/src/tile.ts`

```typescript
// CURRENT (Lines 18-54):
export function decodeTile(data: Uint8Array, id: TileId): Tile {
  const protoTile = stt.Tile.decode(data);

  const layers: Layer[] = (protoTile.layers || []).map((protoLayer) => {
    const features: Feature[] = (protoLayer.features || []).map((protoFeature) => {
      // ... decode properties ...

      return {
        id: Number(protoFeature.id) || 0,
        type: protoGeomTypeToType(protoFeature.type || 0),
        geometry: Array.from(protoFeature.geometry || []),
        properties,
        timeRange: /* ... */,
        // ❌ Missing: changeType
      };
    });
  });
}

// NEEDED:
class TileDecoder {
  private featureCache: Map<number, Feature> = new Map();

  decodeTile(data: Uint8Array, id: TileId): Tile {
    const protoTile = stt.Tile.decode(data);

    const layers: Layer[] = (protoTile.layers || []).map((protoLayer) => {
      const features: Feature[] = [];

      for (const protoFeature of (protoLayer.features || [])) {
        let feature: Feature;

        if (protoFeature.change === ChangeType.UNCHANGED) {
          // ✅ Reconstruct from cache
          const cached = this.featureCache.get(protoFeature.id);
          if (cached) {
            feature = cached;
          } else {
            console.warn(`Missing cache for feature ${protoFeature.id}`);
            continue; // Skip this feature
          }
        } else {
          // ✅ Decode normally and cache
          feature = this.decodeFeature(protoFeature, protoLayer);
          this.featureCache.set(feature.id, feature);
        }

        features.push(feature);
      }

      return { name: protoLayer.name || 'default', extent: protoLayer.extent || 4096, features };
    });

    return { id, layers, /* ... */ };
  }
}
```

---

## Summary

The delta encoding system has three critical disconnections:

1. **Build pipeline doesn't use `TemporalDeltaTracker`**
   - Tiles are built in parallel without temporal ordering
   - No delta comparison happens
   - Change types are always hardcoded to UNCHANGED

2. **Encoding ignores change information**
   - `previous_hash` always set to 0
   - `change` always set to 0
   - Full geometry/properties always encoded

3. **Frontend has no reconstruction logic**
   - `changeType` field ignored
   - No feature cache across tiles
   - No lookup by hash reference

**Result:** Delta encoding exists but is 100% inert. The system works because every feature is fully encoded, but files are 5-10× larger than necessary.
