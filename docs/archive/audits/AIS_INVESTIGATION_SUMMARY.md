# AIS Rendering Issues - Investigation Summary

**Date:** October 25, 2025  
**Status:** ⚠️ Additional validation needed

---

## Your Concern

> "Are we overly processing the locations because they are spread across the US? We need to make sure they correspond exactly with the raw data."

**This is an excellent concern!** Let me explain what I've found and what we need to check.

---

## What I've Done So Far

### ✅ Fixed Issues:

1. **Delta encoding within tiles** - Implemented cursor tracking
2. **Time window** - Increased from 1 hour to 3 hours
3. **Initial load** - Optimized from 400 days to smart window
4. **Temporal resolution** - Changed to daily-aggregates
5. **Debugging output** - Added coordinate logging

### ⚠️ New Discovery

After reviewing the **entire coordinate pipeline**, I found a **critical ambiguity** in how coordinates are stored:

## The Question

**Are coordinates in the geometry array absolute or delta-encoded?**

### Scenario A: Absolute Coordinates (What I Now Believe)

Looking at the build code (`crates/stt-build/src/tiler.rs:555`):

```rust
let tile_coords = projection::lonlat_to_tile_coords(lon, lat, ...);
let geometry = vec![9, tile_coords.0, tile_coords.1];  // Direct assignment
```

This suggests coordinates are **absolute** within the tile (0-4096 range), not delta-encoded!

### Scenario B: Delta Encoded (What I Implemented)

I implemented delta accumulation thinking MVT uses delta encoding throughout, but that might only apply to **polylines/polygons**, not individual **points**.

---

## Impact

If coordinates are actually **absolute** and we're treating them as **deltas**:

```
Actual stored: [9, 2045, 1893]  // Absolute coords
Our decoder:   cursor(0,0) + zigzag(2045) + zigzag(1893)
             = 0 + 1022 + 946
             = Wrong position!

Should be:     2045, 1893 directly
```

This would explain why ships might appear in wrong locations!

---

## How to Verify

### Step 1: Run the Validation Script

```bash
cd scripts/data-generation

# If you have AIS GeoJSON data:
node validate-ais-coords.js data/ais-traffic.geojson

# This will show:
# - Exact coordinate bounds of raw data
# - Whether it matches expected US East Coast region
# - Sample feature coordinates
```

Expected output for US East Coast:

```
Longitude: -80.0000 to -65.0000
Latitude:  25.0000 to 45.0000
Center: [-72.50, 35.00]
```

### Step 2: Check Browser Console

When the showcase app loads:

1. Open browser console
2. Select "Maritime Traffic (AIS)" dataset
3. Look for "First feature:" output
4. Compare rendered coordinates to raw data coordinates

If they match → ✅ decoder is correct
If they don't match → ❌ need to fix decoder

### Step 3: Add Debug Logging

Add this to `AnimatedPointLayer.renderLayers()` to see geometry values:

```typescript
// At the start of renderLayers()
if (tiles.length > 0 && tiles[0].layers.length > 0) {
  const layer = tiles[0].layers[0];
  console.log("=== GEOMETRY DEBUG ===");
  for (let i = 0; i < Math.min(3, layer.features.length); i++) {
    const f = layer.features[i];
    console.log(`Feature ${i}:`, {
      geometry: f.geometry,
      raw_x: f.geometry[1],
      raw_y: f.geometry[2],
      "zigzag(x)": this.zigzagDecode(f.geometry[1]),
      "zigzag(y)": this.zigzagDecode(f.geometry[2]),
    });
  }
}
```

If `raw_x` values are large (>1000) and similar for consecutive features → **absolute**  
If `raw_x` values are small (<100) and vary → **delta-encoded**

---

## Two Possible Fixes

### Fix A: If Coordinates Are Absolute (Likely)

Remove delta accumulation and zigzag decoding:

```typescript
extractPosition(feature, extent, tileId) {
  const cmdInt = feature.geometry[0];
  const cmd = cmdInt & 0x7;

  if (cmd !== 1) return [0, 0];

  // Use coordinates directly - they're already absolute
  const absoluteX = feature.geometry[1];
  const absoluteY = feature.geometry[2];

  const z = tileId.z;
  const x = tileId.x;
  const y = tileId.y;
  const n = 1 << z;

  // Normalize and project
  const normX = absoluteX / extent;
  const normY = absoluteY / extent;

  const lon = ((x + normX) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + normY) / n)));
  const lat = (latRad * 180) / Math.PI;

  return [lon, lat];
}
```

### Fix B: If Coordinates Are Delta-Encoded (Current Implementation)

Keep the current implementation with cursor tracking.

---

## Next Steps

1. **Run validation script** to check raw data bounds
2. **Add debug logging** to see actual geometry values
3. **Determine if coordinates are absolute or delta-encoded**
4. **Apply appropriate fix** (A or B above)
5. **Verify** rendered positions match raw data

---

## Files Created

1. **`AIS_DATA_RENDERING_DEEP_DIVE.md`** - Complete analysis of data flow
2. **`AIS_FIXES_APPLIED.md`** - Summary of fixes applied so far
3. **`AIS_COORDINATE_VALIDATION.md`** - Detailed validation guide
4. **`validate-ais-coords.js`** - Script to check raw data bounds

---

## My Recommendation

**Before testing in the browser:**

1. First, verify your raw GeoJSON data is correctly bounded:

   ```bash
   cd scripts/data-generation
   node validate-ais-coords.js data/ais-traffic.geojson
   ```

2. Check if coordinates are in expected range (US East Coast):
   - Lon: -80 to -65
   - Lat: 25 to 45

3. If raw data is correct but rendered incorrectly, we know it's a decoder issue

4. Add the geometry debug logging I showed above

5. Based on the output, we'll know if we need Fix A or keep Fix B

**The validation script will tell us immediately if the problem is in:**

- Data generation (wrong bounds)
- Coordinate encoding (build process)
- Coordinate decoding (frontend)

Let me know what the validation script shows, and we'll fix the exact issue!
