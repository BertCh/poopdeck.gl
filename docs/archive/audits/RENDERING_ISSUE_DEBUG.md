# Rendering Issue Investigation

**Issue**: Datasets aren't showing up on the map in the showcase app

## Root Cause Analysis

### 1. Components Working

✅ Rust builds successfully  
✅ TypeScript builds successfully  
✅ STT files are valid (correct magic number)  
✅ Dev server is running  
✅ Files are served correctly over HTTP

### 2. Potential Issues to Investigate

#### A. Layer Registration with deck.gl

The custom layers (AnimatedPointLayer, etc.) extend deck.gl's CompositeLayer. Need to verify:

- Layers are properly registered
- render methods are being called
- State updates trigger re-renders

#### B. Archive Loading

- HTTP Range Requests working?
- Index being parsed correctly?
- Tiles being fetched?
- Features being decoded?

#### C. Coordinate Transformation

- `extractPosition()` function in AnimatedPointLayer
- Tile coordinates → lon/lat conversion
- Extent and tile ID attached to features

#### D. Time Window Filtering

- `isFeatureVisible()` filtering too aggressively?
- Current time vs. feature time ranges
- Time window size appropriate for dataset

## Debugging Steps

### Step 1: Check Browser Console

Open http://localhost:5174 and check for:

- JavaScript errors
- Console logs from layers
- Network requests for STT files

### Step 2: Use Debug Page

Open http://localhost:5174/debug.html to see:

- Archive metadata loading
- Index contents
- Tile query results
- Feature extraction

### Step 3: Check Layer Rendering

Add console.logs to verify:

- `renderLayers()` is being called
- Features are extracted from tiles
- Positions are calculated correctly
- ScatterplotLayer receives data

## Quick Fix Checklist

### Fix 1: Verify getPosition is not overridden

In `App.tsx`, the layers use getPosition prop which might be overriding the default. Need to ensure either:

- Don't pass getPosition prop (use default extractPosition)
- OR ensure extractPosition logic is correct

### Fix 2: Check Time Window

Earthquake data uses 30-day window, but initial time might be wrong:

```typescript
timeWindow: 30 * 86400000, // 30 days
```

Need to ensure `currentTime` is within dataset time range.

### Fix 3: Check Zoom Level

Datasets have min/max zoom levels. Need to verify:

- Viewport zoom matches available tile zoom levels
- `getZoomLevel()` in spatiotemporal-layer returns correct value

## Next Actions

1. Open browser console and check for errors
2. Visit debug page to see if data loads
3. Check layer console.log outputs
4. Verify tiles are fetched from correct URLs
5. Test with simpler dataset (test.stt) first

## Expected Console Output

When working correctly, should see:

```
SpatioTemporalLayer: Initializing archive from /data/earthquakes.stt
Archive metadata: { minZoom: 0, maxZoom: 10, ... }
Archive: Index contains 276766 tile entries
Archive: Need 1-4 tiles for bounds at zoom 2
SpatioTemporalLayer: Loaded 3 tiles
AnimatedPointLayer: Rendering 150 features at time 2024-01-01...
First feature: { position: [lon, lat], radius: 5000, ... }
```

If not seeing these logs, that's the problem to fix.
