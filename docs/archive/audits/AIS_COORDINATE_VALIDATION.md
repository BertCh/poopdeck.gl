# AIS Coordinate Validation & Troubleshooting Guide

**Date:** October 25, 2025  
**Issue:** Ensuring decoded coordinates exactly match raw AIS data

---

## Problem Statement

You're concerned that the locations might be getting spread across the US when they should be more concentrated in the East Coast region specified in the AIS data bounds. We need to ensure our coordinate decoding exactly matches the raw data.

---

## Root Cause Analysis

After reviewing the entire coordinate pipeline, I've identified the potential issues:

### 1. **Understanding the Coordinate Flow**

```
Raw AIS Data (CSV)
  lon: -72.5, lat: 35.0  (US East Coast)
        ↓
  [generate-ais-data filters by bounds]
        ↓
GeoJSON
  lon: -72.5, lat: 35.0  (✓ should be unchanged)
        ↓
  [stt-build encodes]
        ↓
Tile Coordinates (relative to tile)
  tile z=5, x=145, y=192
  within-tile: [2045, 1893] (encoded integers 0-4096)
        ↓
  [MVT delta encoding]
        ↓
Stored Geometry Array
  [9, 2045, 1893] (command + zigzag-encoded deltas)
        ↓
  [Frontend decodes]
        ↓
Rendered Position
  lon: ???, lat: ???  (should match -72.5, 35.0)
```

### 2. **The Encoding Process (Build Time)**

Looking at `crates/stt-build/src/tiler.rs` line 554:

```rust
fn encode_geometry(feature: &geojson::Feature, tile_id: TileId, config: &TileConfig)
    -> Result<(GeometryType, Vec<u32>)>
{
    match &geom.value {
        geojson::Value::Point(coords) => {
            let tile_coords = projection::lonlat_to_tile_coords(
                coords[0],  // longitude
                coords[1],  // latitude
                tile_id.z,
                tile_id.x,
                tile_id.y,
                config.extent,  // typically 4096
            );
            // MoveTo command (9 = 1 << 3 | 1) + coordinate pair
            let geometry = vec![9, tile_coords.0, tile_coords.1];
            Ok((GeometryType::Point, geometry))
        }
    }
}
```

**Key insight:** The geometry array is `[9, x, y]` where:

- `9` = MoveTo command (command 1, count 1)
- `x`, `y` = absolute coordinates within tile (0-4096)

**NOT delta encoded during build!** Delta encoding happens WITHIN each tile for multiple features, but the first coordinate in the geometry array is absolute.

### 3. **The Decoding Process (Frontend)**

Our current decoder in `packages/deck.gl/src/animated-point-layer.ts`:

```typescript
extractPositionWithDelta(feature, extent, tileId, cursor) {
  const cmdInt = feature.geometry[0];  // 9
  const cmd = cmdInt & 0x7;             // 1 (MoveTo)

  // Next two elements are zigzag-encoded deltas from cursor position
  const dx = this.zigzagDecode(feature.geometry[1]);
  const dy = this.zigzagDecode(feature.geometry[2]);

  // Add deltas to cursor to get absolute position within tile
  const absoluteX = cursor.x + dx;
  const absoluteY = cursor.y + dy;

  // ... convert to lon/lat
}
```

**POTENTIAL ISSUE:** We're treating `feature.geometry[1]` and `feature.geometry[2]` as delta-encoded, but they might actually be absolute coordinates!

---

## Testing the Hypothesis

### Test 1: Check if coordinates are actually delta-encoded

```typescript
// Add to AnimatedPointLayer.renderLayers()
console.log("=== GEOMETRY DEBUG ===");
for (let i = 0; i < Math.min(5, layer.features.length); i++) {
  const f = layer.features[i];
  console.log(`Feature ${i}:`, {
    geometry: f.geometry,
    cmd: f.geometry[0],
    x: f.geometry[1],
    y: f.geometry[2],
    "zigzag(x)": this.zigzagDecode(f.geometry[1]),
    "zigzag(y)": this.zigzagDecode(f.geometry[2]),
  });
}
```

Expected output if they're **absolute**:

```
Feature 0: { x: 2045, y: 1893, zigzag(x): 1022, zigzag(y): 946 }
Feature 1: { x: 2050, y: 1900, zigzag(x): 1025, zigzag(y): 950 }
Feature 2: { x: 2055, y: 1905, zigzag(x): 1027, zigzag(y): 952 }
```

Expected output if they're **deltas**:

```
Feature 0: { x: 2045, y: 1893, zigzag(x): 1022, zigzag(y): 946 }
Feature 1: { x: 5, y: 7, zigzag(x): 2, zigzag(y): 3 }
Feature 2: { x: 5, y: 5, zigzag(x): 2, zigzag(y): 2 }
```

### Test 2: Verify projection math

The projection functions in `crates/stt-core/src/projection.rs` look correct:

**Encoding (line 85):**

```rust
pub fn lonlat_to_tile_coords(lon, lat, zoom, tile_x, tile_y, extent) -> (u32, u32) {
    let n = 1u32 << zoom;

    // Convert to Web Mercator tile coordinates (0-n)
    let world_x = (lon + 180.0) / 360.0 * n as f64;
    let lat_rad = lat.to_radians();
    let world_y = (1.0 - lat_rad.tan().asinh() / PI) / 2.0 * n as f64;

    // Convert to tile-relative coordinates (0-extent)
    let tile_rel_x = (world_x - tile_x as f64) * extent as f64;
    let tile_rel_y = (world_y - tile_y as f64) * extent as f64;

    (tile_rel_x.clamp(0.0, extent as f64) as u32,
     tile_rel_y.clamp(0.0, extent as f64) as u32)
}
```

**Decoding (frontend):**

```typescript
const z = tileId.z;
const x = tileId.x;
const y = tileId.y;
const n = 1 << z;

// Normalize coordinates (0-1 range within tile)
const normX = absoluteX / extent;
const normY = absoluteY / extent;

// Convert to lon/lat using Web Mercator projection
const lon = ((x + normX) / n) * 360 - 180;
const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + normY)) / n)));
const lat = (latRad * 180) / Math.PI;
```

**This looks correct!** It's the inverse of the encoding.

---

## The Real Issue

I believe the issue is that **we're applying delta accumulation when we shouldn't be!**

Looking back at the build code, each feature's geometry is stored as **absolute coordinates within the tile**, not as deltas from the previous feature.

### Corrected Decoder

```typescript
extractPositionWithDelta(feature, extent, tileId, cursor) {
  const cmdInt = feature.geometry[0];
  const cmd = cmdInt & 0x7;

  if (cmd !== 1) {
    console.warn('Expected MoveTo command for point, got:', cmd);
    return [0, 0];
  }

  // These are ABSOLUTE coordinates within the tile, not deltas!
  // They're stored as uint32, no zigzag encoding needed for absolute values
  const absoluteX = feature.geometry[1];
  const absoluteY = feature.geometry[2];

  const z = tileId.z;
  const x = tileId.x;
  const y = tileId.y;
  const n = 1 << z;

  // Normalize coordinates (0-1 range within tile)
  const normX = absoluteX / extent;
  const normY = absoluteY / extent;

  // Convert to lon/lat using Web Mercator projection
  const lon = ((x + normX) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + normY) / n)));
  const lat = (latRad * 180) / Math.PI;

  return [lon, lat];
}
```

**Key changes:**

1. Don't apply zigzag decoding - coordinates are already unsigned integers
2. Don't add to cursor - they're absolute within the tile
3. Use values directly from geometry array

---

## Validation Steps

1. **Run the validation script:**

```bash
cd scripts/data-generation
node validate-ais-coords.js data/ais-traffic.geojson
```

This will show:

- Actual coordinate bounds in the GeoJSON
- Whether they match expected US East Coast bounds
- Sample features with exact coordinates

2. **Update the decoder** with the corrected logic above

3. **Test in showcase:**

- Load the app
- Select AIS dataset
- Check console for coordinate debug output
- Verify ships appear in the same region as the raw data

4. **Cross-reference:**

- Note the GeoJSON coordinates from validation script
- Note the rendered coordinates from browser console
- They should match within tile quantization error (~0.01°)

---

## Next Steps

1. ✅ Created validation script to check raw data bounds
2. ⏳ Need to test whether coordinates are absolute or delta-encoded
3. ⏳ May need to update decoder based on test results
4. ⏳ Verify rendered positions match raw data

Run the validation script first, and we'll determine if we need to adjust the decoder logic.
