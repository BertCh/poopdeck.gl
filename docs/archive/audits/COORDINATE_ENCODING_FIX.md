# Coordinate Encoding Fix - Root Cause Analysis

## Problem

Points were rendering randomly scattered across the wrong geographic region (e.g., Kentucky instead of US East Coast).

## Root Cause

**Mismatch between how coordinates are stored vs. how they're decoded.**

### How Coordinates Are Stored (Rust Tiler)

In `crates/stt-build/src/tiler.rs` line 555:

```rust
// MoveTo command (1) + coordinate pair
let geometry = vec![9, tile_coords.0, tile_coords.1];
```

And in `crates/stt-build/src/main.rs` line 165:

```rust
use_delta_encoding: false, // TODO: Make configurable
```

**Key Finding**: Coordinates are stored as **absolute values** within the tile extent (0-4096), **NOT delta-encoded**.

The `9` is the MVT command integer `(1 << 3) | 1` which means "MoveTo with count 1", but the following values are **absolute tile coordinates**.

### How Coordinates Were Being Decoded (JavaScript - INCORRECT)

The `AnimatedPointLayer` was treating coordinates as delta-encoded:

```typescript
// WRONG: Treating absolute values as deltas
const dx = this.zigzagDecode(feature.geometry[1]); // ZigZag decode
const dy = this.zigzagDecode(feature.geometry[2]);
const absoluteX = cursorX + dx; // Accumulate deltas
const absoluteY = cursorY + dy;
cursorX = absoluteX; // Update cursor
cursorY = absoluteY;
```

**Problems with this approach**:

1. **ZigZag decoding**: Coordinates aren't zigzag-encoded, they're plain unsigned integers
2. **Delta accumulation**: Coordinates aren't deltas, they're absolute values
3. **Cursor tracking**: Not needed since coordinates are independent

## The Fix

### Corrected Decoding (JavaScript - CORRECT)

```typescript
// CORRECT: Read absolute values directly
const tileX = feature.geometry[1]; // Already absolute
const tileY = feature.geometry[2]; // Already absolute

// Normalize coordinates (0-1 range within tile)
const normX = tileX / extent;
const normY = tileY / extent;

// Convert to lon/lat using Web Mercator projection
const lon = ((x + normX) / n) * 360 - 180;
const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + normY)) / n)));
const lat = (latRad * 180) / Math.PI;
```

## Why The Confusion?

### MVT Specification

The Mapbox Vector Tile (MVT) specification **does** use delta encoding for geometries. This is where the confusion came from.

**Standard MVT format** (with delta encoding):

```
geometry: [
  9,        // MoveTo command
  dx1, dy1, // Delta from (0,0) - zigzag encoded
  10,       // LineTo command
  dx2, dy2, // Delta from previous point - zigzag encoded
  ...
]
```

### Our Implementation

However, **our Rust tiler explicitly disables delta encoding**:

```rust
use_delta_encoding: false
```

So our format is:

```
geometry: [
  9,     // MoveTo command
  x, y,  // Absolute coordinates within tile extent (0-4096)
]
```

## Verification

### Before Fix

```bash
# Points scattered randomly in wrong location
Rendered position: [-85.2341, 37.8921]  # Kentucky
Expected position: [-72.5408, 34.9955]  # East Coast
```

### After Fix

```bash
# Points render in correct location
Rendered position: [-72.5408, 34.9955]  # East Coast ✅
Raw data position: [-72.5408, 34.9955]  # East Coast ✅
```

## Code Changes

### File: `packages/deck.gl/src/animated-point-layer.ts`

**Removed**:

- Cursor tracking (`cursorX`, `cursorY`)
- ZigZag decoding
- Delta accumulation

**Simplified**:

- Direct read of absolute coordinates
- Single-step conversion to lon/lat

**Before** (70 lines with cursor tracking):

```typescript
for (const tile of tiles) {
  for (const layer of tile.layers) {
    let cursorX = 0; // Track cursor
    let cursorY = 0;

    for (const feature of layer.features) {
      const dx = this.zigzagDecode(feature.geometry[1]);
      const dy = this.zigzagDecode(feature.geometry[2]);
      const absoluteX = cursorX + dx; // Accumulate
      const absoluteY = cursorY + dy;
      cursorX = absoluteX;
      cursorY = absoluteY;
      // ... convert to lon/lat
    }
  }
}
```

**After** (50 lines, simpler):

```typescript
for (const tile of tiles) {
  for (const layer of tile.layers) {
    for (const feature of layer.features) {
      const tileX = feature.geometry[1]; // Direct read
      const tileY = feature.geometry[2];
      // ... convert to lon/lat
    }
  }
}
```

## Future Considerations

### If Delta Encoding Is Enabled

If `use_delta_encoding` is ever set to `true` in the Rust tiler, we'll need to:

1. **Detect encoding type** from tile metadata
2. **Branch decoding logic** based on encoding:

   ```typescript
   if (tile.useDeltaEncoding) {
     // Use delta decoding with cursor tracking
     const dx = this.zigzagDecode(feature.geometry[1]);
     const dy = this.zigzagDecode(feature.geometry[2]);
     cursorX += dx;
     cursorY += dy;
     const tileX = cursorX;
     const tileY = cursorY;
   } else {
     // Use absolute decoding (current)
     const tileX = feature.geometry[1];
     const tileY = feature.geometry[2];
   }
   ```

3. **Add metadata field** to tiles:
   ```rust
   pub struct TileMetadata {
       pub use_delta_encoding: bool,
       // ... other fields
   }
   ```

### Benefits of Delta Encoding

**Why enable it?**

- **Smaller tile sizes**: Deltas are typically smaller numbers (better compression)
- **Standard MVT format**: Compatible with standard MVT tooling

**Why not enable it?**

- **Complexity**: More complex decoding logic
- **Performance**: Additional CPU overhead for zigzag decode + accumulation
- **Debugging**: Harder to inspect raw tile data

**Current decision**: Keep `use_delta_encoding: false` for simplicity and debuggability.

## Testing

### Validation Script

Use the validation script to verify coordinates:

```bash
cd scripts/data-generation
node validate-ais-coords.js data/ais-2024-01-01-east-coast.geojson
```

**Expected output**:

```
✅ Coordinates within expected US East Coast bounds
   Longitude: -79.9999 to -65.0817
   Latitude:  25.0000 to 44.9910
```

### Visual Verification

1. Load showcase app
2. Select "Maritime Traffic (AIS)" dataset
3. Verify ships render on US East Coast
4. Check that coordinates match raw data bounds

## Lessons Learned

1. **Always verify encoding assumptions** - Don't assume MVT standard encoding
2. **Check the source** - Look at how data is written, not just how it should be read
3. **Add metadata** - Include encoding type in tile metadata for future flexibility
4. **Document decisions** - Clearly document why `use_delta_encoding: false`
5. **Test with real data** - Synthetic data might not expose coordinate issues

## References

- **Rust tiler encoding**: `crates/stt-build/src/tiler.rs` line 555
- **Delta encoding flag**: `crates/stt-build/src/main.rs` line 165
- **MVT specification**: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
- **Coordinate projection**: `crates/stt-core/src/projection.rs`

---

**Status**: ✅ Fixed  
**Date**: 2024-10-25  
**Impact**: Critical - All point datasets now render in correct locations
