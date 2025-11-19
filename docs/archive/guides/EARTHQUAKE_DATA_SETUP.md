# Earthquake Data Setup - Complete Guide

## Data Pipeline Overview

### 1. Data Generation (Rust)

```bash
cd scripts/data-generation
../../target/release/stt-build \
  --input data/earthquakes.geojson \
  --output ../../examples/showcase/dist/data/earthquakes.stt \
  --time-field timestamp \
  --temporal-resolution sparse-events \
  --min-zoom 0 \
  --max-zoom 4 \
  --compression brotli
```

**Output:**

- File: `earthquakes.stt` (16.44 MB)
- Tiles: 6,805
- Features: 77,198 earthquakes (2020-2024)
- Features per tile: ~11.3

### 2. Temporal Bucketing (Optimized for File Size)

**Sparse-Events Profile:**

- Zoom 0-2: YEARLY (~365 days per bucket)
- Zoom 3-4: MONTHLY (~30 days per bucket)
- Zoom 5-6: WEEKLY (~7 days per bucket)
- Zoom 7-8: DAILY (1 day per bucket)

**Why this matters:**

- Larger temporal buckets = fewer tiles = smaller files
- Each tile covers a full bucket period (e.g., entire year for zoom 0-2)
- Queries must use a time window large enough to catch the bucket

### 3. File Deployment

**For Development (`npm run dev`):**

```bash
cp examples/showcase/dist/data/earthquakes.stt examples/showcase/public/data/earthquakes.stt
```

Vite dev server serves from `public/`

**For Production (`npm run build`):**

```bash
# Already in dist/data/ from generation
# Build copies public/ to dist/, so file must be in public/ first
```

### 4. Frontend Configuration

**Dataset Config (`examples/showcase/src/datasets.ts`):**

```typescript
{
  id: 'earthquake-activity',
  name: 'Earthquake Activity',
  url: '/data/earthquakes.stt',  // Relative to public/
  timeRange: {
    start: Date.parse('2020-01-01'),  // Must match data range!
    end: Date.parse('2024-12-31'),
  },
  timeWindow: 7 * 86400000,  // 7 days (gets auto-adjusted by layer)
  animationSpeed: 2 * 86400000,  // 2 days/sec (gets auto-adjusted)
}
```

### 5. Layer Loading (`spatiotemporal-layer.ts`)

**Initial Query:**

```typescript
// Use 400-day window to catch yearly buckets
const initialTimeWindow = 400 * 86400000; // ~13 months
const initialTimeRange = {
  start: Math.max(metadata.timeRange.start, time - initialTimeWindow / 2),
  end: Math.min(metadata.timeRange.end, time + initialTimeWindow / 2),
};
```

**Auto-configuration:**
When tiles load, the layer reads `temporalResolution` from the first tile:

- `bucketSizeMs`: Size of temporal bucket in milliseconds
- `suggestedSpeedMultiplier`: Recommended animation speed (ms/sec)

The layer then:

1. Adjusts time window to 2.5x bucket size
2. Reloads tiles with proper window
3. Updates animation speed

### 6. Tile Querying

**Archive Query Logic (`archive.ts`):**

```typescript
// Find tiles that match:
// 1. Spatial tile coordinates (z, x, y)
// 2. Time range overlap
const entry = index.tiles.find(
  (e) =>
    e.zoom === id.z &&
    e.x === id.x &&
    e.y === id.y &&
    e.timeStart <= queryTime && // Tile covers query time
    e.timeEnd >= queryTime
);
```

**Critical: Tile Time Ranges**

- Tiles store `timeStart` and `timeEnd` covering the full bucket period
- Example: Yearly tile for 2020 has `timeStart=2020-01-01, timeEnd=2020-12-31`
- Query time must fall within this range

## Troubleshooting

### No Tiles Loading

**Check 1: File exists in correct location**

```bash
ls -lh examples/showcase/public/data/earthquakes.stt
ls -lh examples/showcase/dist/data/earthquakes.stt
```

**Check 2: Time window large enough**

- Zoom 0-2 needs ~365 days minimum
- Current: 400 days (safe for yearly buckets)

**Check 3: Initial time within data range**

```typescript
// Dataset must start within data range
timeRange: {
  start: Date.parse('2020-01-01'),  // ✓ Matches data
  end: Date.parse('2024-12-31'),
}
```

**Check 4: Console logs**
Open browser dev tools and look for:

```
Archive: Index contains 6805 tile entries
Archive: Available zoom levels: [0, 1, 2, 3, 4]
Archive: Need X tiles for bounds at zoom Y
Archive: Returning X tiles out of Y requested
SpatioTemporalLayer: Loaded X tiles
```

### Animation Too Fast/Slow

The layer auto-adjusts speed based on tile metadata:

- Yearly buckets: 2 days/sec (172,800,000 ms/sec)
- Monthly buckets: 2 days/sec
- Weekly buckets: 1 hour/sec
- Daily buckets: 10 minutes/sec

If speed is wrong, regenerate data with updated `tiler.rs`.

### Wrong Time Range in Config

If dataset config doesn't match generated data:

1. Regenerate data with correct time range, OR
2. Update `datasets.ts` to match generated data

## Quick Regeneration Script

```bash
#!/bin/bash
cd scripts/data-generation

# Generate with desired zoom range
../../target/release/stt-build \
  --input data/earthquakes.geojson \
  --output ../../examples/showcase/dist/data/earthquakes.stt \
  --time-field timestamp \
  --temporal-resolution sparse-events \
  --min-zoom 0 \
  --max-zoom 4 \
  --compression brotli

# Copy to public for dev server
cp ../../examples/showcase/dist/data/earthquakes.stt \
   ../../examples/showcase/public/data/earthquakes.stt

# Rebuild frontend
cd ../../examples/showcase
npm run build
```

## Current Status

✅ Data generated: `earthquakes.stt` (16.44 MB, 6805 tiles)
✅ Files deployed to public/ and dist/
✅ Dataset config updated with correct time range and stats
✅ Initial time window increased to 400 days for yearly buckets
✅ Frontend rebuilt with latest changes

**To view:**

```bash
cd examples/showcase
npm run dev
```

Open http://localhost:5173 and select "Earthquake Activity"
