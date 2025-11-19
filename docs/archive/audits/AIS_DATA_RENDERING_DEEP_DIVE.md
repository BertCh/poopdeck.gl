# AIS Data Processing and Rendering Deep Dive

**Date:** October 25, 2025  
**Focus:** Maritime Traffic (AIS) Data Flow Analysis

---

## Executive Summary

A comprehensive analysis of the AIS (Automatic Identification System) data pipeline reveals several critical issues affecting rendering and visualization. The system processes real NOAA Maritime Cadastre data through multiple stages, and I've identified **8 major issues** spanning data generation, temporal bucketing, tile loading, and coordinate decoding.

### 🚨 Critical Issues Found

1. **Temporal Bucket Mismatch** - High-frequency profile vs. 1-hour time window
2. **Coordinate Decoding Bug** - ZigZag decode produces invalid coordinates
3. **Time Window Too Small** - 1-hour window misses hourly-bucketed features
4. **Large Dataset Performance** - 77MB file with aggressive loading
5. **Missing Vessel ID Tracking** - Can't connect points into trajectories
6. **Feature Visibility Logic** - Off-by-one errors in time range checks
7. **No Trajectory Generation** - Points rendered as discrete entities
8. **Temporal Resolution Auto-Config** - May override user settings

---

## Data Flow Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         1. DATA GENERATION (ais.rs)                         │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │  NOAA AIS CSV (800MB/day)    │
                    │  • MMSI (vessel ID)           │
                    │  • Timestamp (ISO-8601)       │
                    │  • LAT, LON (decimal degrees) │
                    │  • Speed, Course, Heading     │
                    │  • Vessel Type, Name          │
                    └───────────────┬───────────────┘
                                    │
                                    │ Processing:
                                    │ - Parse CSV (~17K vessels/day)
                                    │ - Filter invalid positions
                                    │ - Apply geographic bounds
                                    │ - Sample @ 10min intervals
                                    │ - Categorize vessel types
                                    │
                    ┌───────────────▼───────────────┐
                    │   GeoJSON (Point features)    │
                    │   properties: {               │
                    │     mmsi: "367XXX",           │
                    │     timestamp: "2024-01-01..Z"│
                    │     vessel_type: "cargo",     │
                    │     speed: 12.5 (knots),      │
                    │     course: 180.0 (degrees)   │
                    │   }                           │
                    └───────────────┬───────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────────┐
│                     2. TILE BUILDING (stt-build)                            │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │  Build Command:               │
                    │  stt-build \                  │
                    │    --input ais.geojson \      │
                    │    --output ais-real.stt \    │
                    │    --time-field timestamp \   │
                    │    --temporal-resolution \    │
                    │       high-frequency \        │ ⚠️ ISSUE #1
                    │    --min-zoom 0 \             │
                    │    --max-zoom 14 \            │
                    │    --compression gzip         │
                    └───────────────┬───────────────┘
                                    │
                        ┌───────────▼────────────┐
                        │ Temporal Bucketing     │
                        │ (high-frequency)       │
                        │                        │
                        │ Zoom 0-3: DAILY        │ ⚠️ ISSUE #2
                        │ Zoom 4-6: HOURLY       │
                        │ Zoom 7-9: MINUTE       │
                        │ Zoom 10+: SECOND       │
                        └───────────┬────────────┘
                                    │
                        For zoom=5 (default view):
                        - Bucket = HOURLY
                        - Features grouped by hour
                        - Tile timestamp = hour start
                        │
                        Example: 2024-01-01T14:35:22Z
                                → 2024-01-01T14:00:00Z
                        │
                    ┌───────────────▼────────────────┐
                    │  Spatial Tiling               │
                    │  • Mercator projection        │
                    │  • H3 hexagonal grid          │
                    │  • ZigZag coordinate encoding │
                    │  • Delta compression          │
                    │  • Properties de-duplication  │
                    └───────────────┬────────────────┘
                                    │
                    ┌───────────────▼────────────────┐
                    │  STT Archive (77MB)           │
                    │                               │
                    │  Index:                       │
                    │    tiles: [                   │
                    │      {                        │
                    │        zoom: 5,               │
                    │        x: 145,                │
                    │        y: 192,                │
                    │        timeStart: 1704117600, │ ← Hour bucket
                    │        timeEnd: 1704121199,   │ ← Bucket end
                    │        offset: 12345,         │
                    │        length: 45678          │
                    │      }, ...                   │
                    │    ]                          │
                    │                               │
                    │  Tiles: [encoded protobuf]    │
                    └───────────────┬────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────────┐
│                    3. FRONTEND RENDERING (showcase)                         │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                    ┌───────────────▼────────────────┐
                    │  datasets.ts Configuration    │
                    │  {                            │
                    │    id: 'ship-traffic',        │
                    │    url: '/data/ais-real.stt', │
                    │    timeRange: {               │
                    │      start: Jan 1 00:00,      │
                    │      end: Jan 1 23:59         │
                    │    },                         │
                    │    timeWindow: 3600000,       │ ⚠️ ISSUE #3
                    │    // = 1 hour (too small!)   │
                    │    animationSpeed: 3600000    │
                    │    // = 1 hour/sec            │
                    │  }                            │
                    └───────────────┬────────────────┘
                                    │
                    ┌───────────────▼────────────────┐
                    │  SpatioTemporalLayer          │
                    │  (spatiotemporal-layer.ts)    │
                    └───────────────┬────────────────┘
                                    │
                        Step 1: Initialize
                        │
                        ├─► Get viewport bounds
                        │   (lon/lat extent)
                        │
                        ├─► Get zoom level
                        │   (floor(viewport.zoom))
                        │
                        ├─► Load metadata
                        │   GET /data/ais-real.stt?index
                        │
                        ├─► Calculate initial window
                        │   400 days (13 months) ⚠️ ISSUE #4
                        │   Too large for initial load
                        │
                        └─► Load tiles
                            │
                    ┌───────▼────────────────────────┐
                    │  STTArchive.getTilesInBounds  │
                    │  (packages/core/archive.ts)   │
                    └───────┬────────────────────────┘
                            │
                            ├─► Calculate spatial tiles
                            │   in viewport bbox
                            │
                            ├─► For each (x,y,z):
                            │   │
                            │   └─► Find temporal tiles
                            │       WHERE timeEnd >= queryStart
                            │       AND timeStart <= queryEnd
                            │
                            ├─► Fetch tile data
                            │   GET /data/ais-real.stt
                            │       ?offset=X&length=Y
                            │
                            └─► Decode protobuf tiles
                                │
                    ┌───────────▼────────────────────┐
                    │  decodeTile                   │
                    │  (packages/core/tile.ts)      │
                    │                               │
                    │  Tile structure:              │
                    │    id: {z,x,y,t}              │
                    │    timeRange: {               │
                    │      start: 1704117600000,    │
                    │      end: 1704121199999       │
                    │    }                          │
                    │    layers: [{                 │
                    │      extent: 4096,            │
                    │      keys: ["mmsi", "speed"], │
                    │      values: ["367XXX", 12.5],│
                    │      features: [{             │
                    │        id: 1,                 │
                    │        type: POINT,           │
                    │        geometry: [2045, 1893],│ ← ZigZag encoded
                    │        tags: [0,1, 2,3],      │ ← Key-value refs
                    │        validFrom: 1704118234, │
                    │        validTo: 1704118234    │
                    │      }]                       │
                    │    }]                         │
                    │    temporalResolution: {      │
                    │      bucketSizeMs: 3600000,   │ ← 1 hour
                    │      suggestedSpeed: 3600000  │
                    │    }                          │
                    └───────────┬────────────────────┘
                                │
                                │ Auto-config: ⚠️ ISSUE #5
                                │ - Reads temporalResolution
                                │ - Sets timeWindow = bucket * 2.5
                                │ - May override user config
                                │ - Reloads tiles with new window
                                │
                    ┌───────────▼────────────────────┐
                    │  AnimatedPointLayer           │
                    │  (animated-point-layer.ts)    │
                    └───────────┬────────────────────┘
                                │
                        Step 1: Extract features
                        │
                        ├─► For each tile:
                        │     For each layer:
                        │       For each feature:
                        │         if isFeatureVisible():
                        │           features.push(feature)
                        │
                        │   isFeatureVisible(f, time): ⚠️ ISSUE #6
                        │     windowStart = time - window/2
                        │     windowEnd = time + window/2
                        │     return f.timeRange.start <= windowEnd
                        │        && f.timeRange.end >= windowStart
                        │
                        │   Problem: Off-by-one with bucket edges
                        │
                        Step 2: Decode positions
                        │
                        ├─► extractPosition(feature):
                        │     │
                        │     ├─► Get tile bounds
                        │     │   from (tileId.x, tileId.y, tileId.z)
                        │     │
                        │     ├─► ZigZag decode coordinates
                        │     │   geometry = [2045, 1893]
                        │     │   x = zigzagDecode(2045) = 1022 ⚠️ ISSUE #7
                        │     │   y = zigzagDecode(1893) = 946
                        │     │
                        │     ├─► Normalize to [0,1]
                        │     │   normX = x / extent
                        │     │   normY = y / extent
                        │     │
                        │     └─► Convert to lon/lat
                        │         lon = minLon + (maxLon-minLon)*normX
                        │         lat = minLat + (maxLat-minLat)*normY
                        │
                        │   Problem: ZigZag decode wrong?
                        │   Expected: [-80, 35] (East Coast)
                        │   Getting: [?, ?] (need verification)
                        │
                        Step 3: Map to ScatterplotLayer
                        │
                        └─► data = features.map(f => ({
                                position: extractPosition(f),
                                radius: 1000,  // meters
                                fillColor: colorByVesselType(f),
                                feature: f
                            }))
                            │
                    ┌───────────▼────────────────────┐
                    │  ScatterplotLayer (deck.gl)   │
                    │  • GPU rendering              │
                    │  • Mercator projection        │
                    │  • Billboard sprites          │
                    └───────────────────────────────┘
                                    │
                                    ▼
                            [Rendered on Map]
```

---

## Issue Analysis

### 🔴 Issue #1: Temporal Resolution Mismatch

**Location:** `generate-all.sh` + `datasets.ts`

**Problem:**

```bash
# Build script uses high-frequency profile
stt-build \
  --temporal-resolution high-frequency  # Hourly bucketing at zoom 5

# BUT dataset config expects 1-hour window
{
  timeWindow: 3600000,  // 1 hour
  animationSpeed: 3600000
}
```

**High-Frequency Bucketing at Zoom 5:**

```rust
// From tiler.rs
Self::HighFrequency => {
    match zoom {
        0..=3 => TemporalBucket::Day,
        4..=6 => TemporalBucket::Hour,     // ← Zoom 5 uses HOURLY
        7..=9 => TemporalBucket::Minute,
        10..=12 => TemporalBucket::Second,
        _ => TemporalBucket::None,
    }
}
```

**Result:**

- At zoom 5, features are bucketed into 1-hour tiles
- Each tile covers a full hour (e.g., 14:00:00 - 14:59:59)
- But `timeWindow: 3600000` (1 hour) means:
  - Query at 14:30:00 looks for tiles in [14:00:00, 15:00:00]
  - Gets tile for 14:00-14:59
  - **Misses tile for 15:00-15:59** (edge case)

**Fix:**

```typescript
// datasets.ts
{
  id: 'ship-traffic',
  timeWindow: 3600000 * 2.5,  // 2.5 hours (catches adjacent buckets)
  animationSpeed: 3600000      // Still 1 hour/sec
}
```

---

### 🔴 Issue #2: High-Frequency Profile Inappropriate for AIS

**Location:** `download-ais.sh`, `generate-all.sh`

**Problem:**
AIS data sampled at 10-minute intervals but uses "high-frequency" profile designed for second-level tracking.

**Current Sampling:**

```rust
// ais.rs
Args {
    sample_minutes: 10,  // One position per vessel per 10 minutes
    // ...
}
```

**Temporal Profile:**

```rust
// high-frequency expects:
Zoom 10+: SECOND level  // But we only have data every 10 minutes!
Zoom 7-9: MINUTE level  // Also finer than our sampling
```

**Recommendation:**
Use a custom temporal profile that matches AIS sampling:

```bash
# Option 1: Use daily-aggregates (coarser)
stt-build \
  --temporal-resolution daily-aggregates

# Option 2: Create custom AIS profile
# In tiler.rs, add:
pub enum TemporalResolutionProfile {
    // ...
    AisTracking,  // Optimized for 10-minute sampling
}

impl TemporalResolutionProfile {
    pub fn bucket_for_zoom(&self, zoom: u8) -> TemporalBucket {
        match self {
            Self::AisTracking => {
                match zoom {
                    0..=2 => TemporalBucket::Day,    // World view
                    3..=5 => TemporalBucket::Hour,   // Regional
                    6..=8 => TemporalBucket::Hour,   // City (10min ≈ hour)
                    _ => TemporalBucket::Hour,       // Never go finer than hour
                }
            }
            // ...
        }
    }
}
```

---

### 🔴 Issue #3: Feature Visibility Edge Cases

**Location:** `packages/deck.gl/src/animated-point-layer.ts`

**Problem:**

```typescript
isFeatureVisible(feature, currentTime) {
  const timeWindow = this.props.timeWindow || 86400000;
  const windowStart = currentTime - timeWindow / 2;
  const windowEnd = currentTime + timeWindow / 2;

  return (
    feature.timeRange.start <= windowEnd &&
    feature.timeRange.end >= windowStart
  );
}
```

**Edge Case:**

```
Current time: 14:30:00 (center of window)
Time window: 1 hour (3600000ms)

Window: [14:00:00, 15:00:00]

Feature (hourly bucket):
  timeRange.start = 14:00:00
  timeRange.end = 14:59:59.999

Check:
  14:00:00 <= 15:00:00 ✓
  14:59:59 >= 14:00:00 ✓
  → Visible

BUT if feature is in next bucket:
  timeRange.start = 15:00:00
  timeRange.end = 15:59:59.999

Check:
  15:00:00 <= 15:00:00 ✓
  15:59:59 >= 14:00:00 ✓
  → Visible (correct!)

Actually, this logic looks correct. But...
```

**Real Issue:** The time window is too small relative to bucket size.

**Fix:**

```typescript
// Auto-calculate window based on temporal resolution
const bucketMs = tile.temporalResolution?.bucketSizeMs || 0;
const calculatedWindow =
  bucketMs > 0
    ? bucketMs * 3 // Always show current + prev + next buckets
    : this.props.timeWindow || 86400000;
```

---

### 🔴 Issue #4: ZigZag Coordinate Decoding

**Location:** `packages/deck.gl/src/animated-point-layer.ts`

**Current Implementation:**

```typescript
zigzagDecode(n: number): number {
  return (n >> 1) ^ (-(n & 1));
}

extractPosition(feature: Feature): [number, number] {
  const tileId = (feature as any).tileId;
  const extent = (feature as any).extent || 4096;

  // Decode geometry
  const geom = feature.geometry;
  if (geom.length < 2) return [0, 0];

  const x = this.zigzagDecode(geom[0]);
  const y = this.zigzagDecode(geom[1]);

  // Normalize to [0, 1]
  const normX = x / extent;
  const normY = y / extent;

  // Get tile bounds
  const [minLon, minLat, maxLon, maxLat] = this.getTileBounds(tileId);

  // Convert to lon/lat
  const lon = minLon + (maxLon - minLon) * normX;
  const lat = minLat + (maxLat - minLat) * normY;

  return [lon, lat];
}
```

**Potential Issue:** Is ZigZag decoding correct?

**Test Case:**

```typescript
// If encoded geometry is [2045, 1893]
zigzagDecode(2045):
  = (2045 >> 1) ^ (-(2045 & 1))
  = 1022 ^ (-1)
  = 1022 ^ 0xFFFFFFFF
  = -1023

zigzagDecode(1893):
  = (1893 >> 1) ^ (-(1893 & 1))
  = 946 ^ (-1)
  = -947

// Normalize to [0, 1]
normX = -1023 / 4096 = -0.25 ⚠️ NEGATIVE!
normY = -947 / 4096 = -0.23 ⚠️ NEGATIVE!

// This would place the point OUTSIDE the tile!
```

**Problem Confirmed:** ZigZag decode can produce negative values, but normalization expects [0, extent].

**Correct Implementation:**

ZigZag encoding maps signed integers to unsigned:

```
 0 → 0
-1 → 1
 1 → 2
-2 → 3
 2 → 4
```

So the decode should handle both positive and negative results:

```typescript
zigzagDecode(n: number): number {
  return (n >> 1) ^ (-(n & 1));
}

extractPosition(feature: Feature): [number, number] {
  const tileId = (feature as any).tileId;
  const extent = (feature as any).extent || 4096;

  const geom = feature.geometry;
  if (geom.length < 2) return [0, 0];

  // ZigZag decode (produces signed integers)
  let x = this.zigzagDecode(geom[0]);
  let y = this.zigzagDecode(geom[1]);

  // CRITICAL: Handle delta encoding
  // First feature in tile is absolute, rest are deltas
  // Need to accumulate deltas across features
  // (This is missing!)

  // For now, treat as absolute coordinates
  // Normalize to [0, 1] - need to handle negative values
  const normX = (x + extent / 2) / extent;  // Shift range
  const normY = (y + extent / 2) / extent;

  // Clamp to [0, 1]
  const clampedX = Math.max(0, Math.min(1, normX));
  const clampedY = Math.max(0, Math.min(1, normY));

  // Get tile bounds
  const [minLon, minLat, maxLon, maxLat] = this.getTileBounds(tileId);

  // Convert to lon/lat
  const lon = minLon + (maxLon - minLon) * clampedX;
  const lat = minLat + (maxLat - minLat) * clampedY;

  return [lon, lat];
}
```

**BUT WAIT:** There's a bigger issue...

---

### 🔴 Issue #5: Delta Encoding Not Handled

**Location:** `packages/deck.gl/src/animated-point-layer.ts`

**Problem:** The coordinate encoding uses **delta compression**, but the decoder treats each coordinate as absolute!

**How Delta Encoding Works:**

```
Feature 0: geometry = [2045, 1893]  // Absolute
Feature 1: geometry = [15, -8]      // Delta from Feature 0
Feature 2: geometry = [-3, 22]      // Delta from Feature 1

To decode Feature 1:
  x = 2045 + 15 = 2060
  y = 1893 + (-8) = 1885

To decode Feature 2:
  x = 2060 + (-3) = 2057
  y = 1885 + 22 = 1907
```

**Current Code:**

```typescript
// WRONG: Treats each feature independently
const data = features.map((feature) => ({
  position: this.extractPosition(feature), // Decodes in isolation!
  // ...
}));
```

**Correct Implementation:**

```typescript
renderLayers(): any[] {
  const { tiles, currentTime } = this.state;
  if (!tiles || tiles.length === 0) return [];

  const features: Feature[] = [];

  // Process tiles and decode with delta accumulation
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      // Track accumulated coordinates for delta decoding
      let lastX = 0;
      let lastY = 0;

      for (const feature of layer.features) {
        if (this.isFeatureVisible(feature, currentTime)) {
          // Decode with delta accumulation
          const geom = feature.geometry;
          if (geom.length >= 2) {
            // ZigZag decode deltas
            const dx = this.zigzagDecode(geom[0]);
            const dy = this.zigzagDecode(geom[1]);

            // Accumulate
            lastX += dx;
            lastY += dy;

            // Store absolute coordinates in feature
            (feature as any).absoluteCoords = [lastX, lastY];
            (feature as any).tileId = tile.id;
            (feature as any).extent = layer.extent;
          }
          features.push(feature);
        }
      }
    }
  }

  // Now convert to ScatterplotLayer data
  const data = features.map((feature) => ({
    feature,
    position: this.extractAbsolutePosition(feature),
    radius: this.props.getRadius ? this.props.getRadius(feature) : 1000,
    fillColor: this.props.getFillColor
      ? this.props.getFillColor(feature)
      : [255, 128, 0, 255],
  }));

  // ...
}

extractAbsolutePosition(feature: Feature): [number, number] {
  const tileId = (feature as any).tileId;
  const extent = (feature as any).extent || 4096;
  const [x, y] = (feature as any).absoluteCoords || [0, 0];

  // Normalize to [0, 1]
  const normX = x / extent;
  const normY = y / extent;

  // Clamp
  const clampedX = Math.max(0, Math.min(1, normX));
  const clampedY = Math.max(0, Math.min(1, normY));

  // Get tile bounds
  const [minLon, minLat, maxLon, maxLat] = this.getTileBounds(tileId);

  // Convert to lon/lat
  const lon = minLon + (maxLon - minLon) * clampedX;
  const lat = maxLat - (maxLat - minLat) * clampedY;  // Note: Y is inverted!

  return [lon, lat];
}
```

---

### 🔴 Issue #6: No Vessel Trajectory Tracking

**Location:** `packages/deck.gl/src/animated-point-layer.ts`

**Problem:** AIS data represents vessel movements over time, but features are rendered as independent points.

**What's Missing:**

- No MMSI (vessel ID) tracking across time
- No trajectory generation
- No trail rendering
- Can't tell which points belong to the same vessel

**Expected Behavior:**

```typescript
// Group features by vessel ID
const vesselPaths = new Map<string, Feature[]>();

for (const feature of features) {
  const mmsi = feature.properties.mmsi || "unknown";
  if (!vesselPaths.has(mmsi)) {
    vesselPaths.set(mmsi, []);
  }
  vesselPaths.get(mmsi)!.push(feature);
}

// Sort each vessel's features by time
for (const [mmsi, path] of vesselPaths) {
  path.sort((a, b) => a.timeRange.start - b.timeRange.start);
}

// Render as paths instead of points
return [
  new PathLayer({
    data: Array.from(vesselPaths.values()),
    getPath: (path) => path.map((f) => extractPosition(f)),
    getColor: (path) => colorByVesselType(path[0]),
    getWidth: 2,
    widthMinPixels: 1,
  }),
];
```

---

### 🔴 Issue #7: Auto-Config Override

**Location:** `packages/deck.gl/src/spatiotemporal-layer.ts:156`

**Problem:**

```typescript
// Auto-configure from first tile's temporal resolution
if (tiles.length > 0 && tiles[0].temporalResolution) {
  const tempRes = tiles[0].temporalResolution;

  // Calculate time window (query 2-3x bucket size to catch adjacent tiles)
  const autoTimeWindow =
    tempRes.bucketSizeMs > 0
      ? tempRes.bucketSizeMs * 2.5
      : this.props.timeWindow || 86400000;

  // Reload with proper time window
  const timeRange = {
    start: Math.max(metadata.timeRange.start, time - autoTimeWindow / 2),
    end: Math.min(metadata.timeRange.end, time + autoTimeWindow / 2),
  };

  const tilesWithWindow = await archive.getTilesInBounds(
    bounds,
    zoom,
    timeRange
  );

  // Update time controller speed if needed
  if (this.props.timeController && tempRes.suggestedSpeedMultiplier > 1) {
    this.props.timeController.setSpeed(tempRes.suggestedSpeedMultiplier);
  }

  this.setState({ tiles: tilesWithWindow, currentTime: time });
}
```

**Issues:**

1. **Silently overrides user config** - User sets `timeWindow: 3600000` but auto-config changes it
2. **Reloads tiles twice** - First with 400-day window, then with auto-configured window (wasteful)
3. **Modifies global time controller** - Affects all datasets, not just this one
4. **No feedback to user** - Console logs only

**Fix:**

```typescript
// Option 1: Respect user config unless explicitly auto
if (!this.props.autoConfigTemporal) {
  // Use user's timeWindow
} else {
  // Auto-configure
}

// Option 2: Use auto-config but don't override time controller
// Let App.tsx manage animation speed per dataset

// Option 3: Skip initial 400-day load, use temporal resolution from metadata
const metadata = await archive.getMetadata();
if (metadata.temporalResolution) {
  const autoWindow = metadata.temporalResolution.bucketSizeMs * 2.5;
  // Load with correct window from start
}
```

---

### 🔴 Issue #8: Large Initial Load

**Location:** `packages/deck.gl/src/spatiotemporal-layer.ts:145`

**Problem:**

```typescript
// Use a generous initial time window to account for temporal bucketing
// For yearly bucketing (zoom 0-2), we need at least a year
// For monthly bucketing, 60 days is fine
// Use 400 days to be safe (covers yearly + some margin)
const initialTimeWindow = 400 * 86400000; // 400 days (~13 months)
```

**For AIS data (77MB file):**

- Initial query requests 400 days of tiles
- But dataset only spans 24 hours!
- Loads ALL tiles in the file
- Then reloads with narrower window

**Performance Impact:**

```
First load: GET /data/ais-real.stt (77MB)
  - Parse index
  - Find 400-day window (gets everything)
  - Fetch ~500 tiles
  - Decode protobuf

Second load:
  - Find 2.5-hour window (gets ~3 tiles)
  - Fetch ~3 tiles (from cache)
  - Decode protobuf
```

**Fix:**

```typescript
// Check metadata first to determine appropriate window
const metadata = await archive.getMetadata();
const datasetDuration = metadata.timeRange.end - metadata.timeRange.start;

// Use smart initial window based on dataset duration
const initialTimeWindow = Math.min(
  datasetDuration, // Never exceed dataset duration
  this.props.timeWindow || 86400000 // Use user config or 1 day
);
```

---

## Testing & Verification

### Test 1: Verify Coordinate Decoding

```typescript
// Add to AnimatedPointLayer
if (data.length > 0) {
  console.log("===== COORDINATE DEBUG =====");
  const f = data[0];
  console.log("Raw geometry:", f.feature.geometry);
  console.log("ZigZag decoded:", {
    x: this.zigzagDecode(f.feature.geometry[0]),
    y: this.zigzagDecode(f.feature.geometry[1]),
  });
  console.log("Normalized:", {
    normX: this.zigzagDecode(f.feature.geometry[0]) / 4096,
    normY: this.zigzagDecode(f.feature.geometry[1]) / 4096,
  });
  console.log("Final position:", f.position);
  console.log("Tile bounds:", this.getTileBounds(f.feature.tileId));
  console.log("Expected range: lon=[-80, -65], lat=[25, 45]");
  console.log("===========================");
}
```

### Test 2: Verify Temporal Bucketing

```bash
# Rebuild with explicit hourly bucketing
cd scripts/data-generation
cargo run --release --bin generate-ais-data -- \
  --input data/AIS_2024_01_01.csv \
  --output data/ais-test.geojson \
  --sample-minutes 10 \
  --bounds "35.0,-80.0,45.0,-65.0" \
  --max-vessels 100

# Build with hour bucket
cd ../..
cargo run --release --bin stt-build -- \
  --input scripts/data-generation/data/ais-test.geojson \
  --output ais-test.stt \
  --time-field timestamp \
  --temporal-bucket hour \
  --min-zoom 5 \
  --max-zoom 5 \
  --compression gzip

# Inspect tile
cargo run --release --bin stt-tile -- \
  --archive ais-test.stt \
  --tile 5/145/192/1704117600000 \
  --verbose
```

### Test 3: Check Feature Visibility

```typescript
// Add to AnimatedPointLayer.isFeatureVisible
console.log(`Feature visibility check:
  Current time: ${new Date(currentTime).toISOString()}
  Window: [${new Date(windowStart).toISOString()}, ${new Date(windowEnd).toISOString()}]
  Feature: [${new Date(feature.timeRange.start).toISOString()}, ${new Date(feature.timeRange.end).toISOString()}]
  Result: ${result}
`);
```

---

## Recommended Fixes (Priority Order)

### 1. Fix Delta Encoding (CRITICAL)

**Impact:** HIGH - Breaks all coordinate rendering  
**Effort:** MEDIUM - Need to refactor feature iteration

```typescript
// File: packages/deck.gl/src/animated-point-layer.ts
// Implement delta accumulation in renderLayers()
```

### 2. Fix Temporal Profile (HIGH)

**Impact:** HIGH - Mismatched bucketing causes missing data  
**Effort:** LOW - Just change config

```bash
# File: scripts/data-generation/download-ais.sh
# Change --temporal-resolution to daily-aggregates or custom
```

### 3. Fix Time Window (HIGH)

**Impact:** MEDIUM - Missing adjacent buckets  
**Effort:** LOW - Increase timeWindow

```typescript
// File: examples/showcase/src/datasets.ts
timeWindow: 3600000 * 3,  // 3 hours instead of 1
```

### 4. Optimize Initial Load (MEDIUM)

**Impact:** MEDIUM - Slower initial rendering  
**Effort:** LOW - Smart window calculation

```typescript
// File: packages/deck.gl/src/spatiotemporal-layer.ts
// Use metadata to determine initial window
```

### 5. Add Trajectory Support (LOW)

**Impact:** LOW - Nice-to-have feature  
**Effort:** HIGH - Major refactor

```typescript
// Create new AnimatedTrajectoryLayer
// Group by vessel ID, render as paths
```

---

## Conclusion

The AIS rendering issues stem from a combination of:

1. **Encoding mismatch** - Delta encoding not handled
2. **Temporal bucketing mismatch** - High-frequency profile vs. coarse sampling
3. **Configuration inconsistency** - Build settings vs. frontend settings
4. **Performance inefficiencies** - Oversized initial loads

The **most critical fix** is handling delta encoding properly. Without this, coordinates are completely wrong.

The **next priority** is fixing the temporal resolution profile to match the 10-minute sampling rate.

---

**Next Steps:**

1. Fix delta decoding in AnimatedPointLayer
2. Add coordinate verification logging
3. Test with small dataset (100 vessels)
4. Adjust temporal profile
5. Optimize time windows
6. Consider trajectory rendering
