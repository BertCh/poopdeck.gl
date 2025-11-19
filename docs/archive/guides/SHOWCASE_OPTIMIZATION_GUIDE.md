# STT Showcase App - Optimization Configuration Guide

## Quick Reference

This guide shows how to configure optimal settings for each dataset type in the showcase application.

---

## Configuration Parameters

### Time Window (`timeWindow`)

**What it is**: The time range (in milliseconds) before and after `currentTime` to display  
**Purpose**: Prevents features from disappearing at temporal bucket boundaries  
**Formula**: `bucketSize * 2.5` (recommended minimum)

### Animation Speed (`animationSpeed`)

**What it is**: How fast time advances during playback (milliseconds per second of real time)  
**Purpose**: Appropriate playback speed for data density and duration  
**Examples**:

- `86400000` = 1 day per second
- `3600000` = 1 hour per second
- `60000` = 1 minute per second

### Temporal Resolution (in `stt-build`)

**What it is**: The bucketing strategy for temporal data  
**Options**:

- `high-frequency`: Sub-hour precision (seconds/minutes)
- `daily-aggregates`: Hour-to-day precision
- `sparse-events`: Dynamic, unpredictable timing

---

## Dataset Configuration Examples

### 1. AIS / Maritime Traffic (Real Data, 10-min sampling)

**Characteristics**:

- Duration: 24 hours
- Sampling: 10-minute intervals
- Data type: Position reports

**Optimal Configuration**:

```typescript
{
  temporalResolution: 'daily-aggregates',  // In stt-build
  timeWindow: 3600000 * 3,                 // 3 hours (catches adjacent buckets)
  animationSpeed: 3600000,                 // 1 hour per second
}
```

**Rationale**:

- 10-min sampling → hourly buckets (6 samples per bucket)
- 3-hour window ensures smooth transitions
- 1-hour/sec speed allows observation of vessel movements

---

### 2. Earthquakes (Sparse, unpredictable events)

**Characteristics**:

- Duration: 10+ months
- Event frequency: Irregular
- Data type: Point events

**Optimal Configuration**:

```typescript
{
  temporalResolution: 'sparse-events',     // In stt-build
  timeWindow: 7 * 86400000,                // 7 days
  animationSpeed: 86400000 * 7,            // 1 week per second
}
```

**Rationale**:

- Sparse events need wide time window to show patterns
- Weekly buckets balance granularity and performance
- Fast playback speed covers long duration

---

### 3. COVID-19 Cases (Daily aggregates)

**Characteristics**:

- Duration: 2+ years
- Sampling: Daily
- Data type: Case counts

**Optimal Configuration**:

```typescript
{
  temporalResolution: 'daily-aggregates',  // In stt-build
  timeWindow: 86400000,                    // 1 day
  animationSpeed: 86400000 * 7,            // 1 week per second
}
```

**Rationale**:

- Data is inherently daily
- 1-day window matches data granularity
- Weekly speed shows trends without overwhelming detail

---

### 4. Hurricanes (Sparse storm tracks)

**Characteristics**:

- Duration: 4 years
- Event frequency: Seasonal
- Data type: Storm paths

**Optimal Configuration**:

```typescript
{
  temporalResolution: 'sparse-events',     // In stt-build
  timeWindow: 21600000,                    // 6 hours
  animationSpeed: 86400000 * 7,            // 1 week per second
}
```

**Rationale**:

- 6-hour window matches forecast intervals
- Sparse events profile for unpredictable timing
- Fast playback shows seasonal patterns

---

### 5. Taxis / High-Frequency Movement

**Characteristics**:

- Duration: 24 hours
- Sampling: 1-minute intervals
- Data type: Trajectories

**Optimal Configuration**:

```typescript
{
  temporalResolution: 'high-frequency',    // In stt-build
  timeWindow: 60000,                       // 1 minute
  animationSpeed: 60000 * 5,               // 5 minutes per second
}
```

**Rationale**:

- High-frequency profile for minute-level precision
- 1-minute window matches sampling rate
- 5-min/sec speed shows movement patterns

---

### 6. Flights / Aircraft Positions

**Characteristics**:

- Duration: 24 hours
- Sampling: 1-minute intervals
- Data type: Point positions

**Optimal Configuration**:

```typescript
{
  temporalResolution: 'high-frequency',    // In stt-build
  timeWindow: 60000,                       // 1 minute
  animationSpeed: 60000 * 10,              // 10 minutes per second
}
```

**Rationale**:

- High-frequency profile for real-time positioning
- 1-minute window matches ADS-B update rate
- 10-min/sec speed shows traffic patterns

---

## General Guidelines

### Choosing Temporal Resolution

1. **high-frequency**: Use when data has sub-hour precision (seconds, minutes)
   - Examples: Real-time tracking, sensor data, high-frequency trading
   - Bucket size: Seconds to minutes

2. **daily-aggregates**: Use when data is sampled hourly or daily
   - Examples: Weather data, daily statistics, hourly traffic
   - Bucket size: Hours to days

3. **sparse-events**: Use when events are unpredictable or irregular
   - Examples: Earthquakes, accidents, alerts, rare occurrences
   - Bucket size: Dynamic, based on event density

### Calculating Time Window

**Formula**: `timeWindow = bucketSize * 2.5`

**Reasoning**:

- Loads current bucket + adjacent buckets
- Prevents feature disappearance at boundaries
- Accounts for clock skew and rounding

**Examples**:

```
Hourly buckets (3600000 ms):
  timeWindow = 3600000 * 2.5 = 9000000 ms (2.5 hours)

Daily buckets (86400000 ms):
  timeWindow = 86400000 * 2.5 = 216000000 ms (2.5 days)

Minute buckets (60000 ms):
  timeWindow = 60000 * 2.5 = 150000 ms (2.5 minutes)
```

### Setting Animation Speed

**Guidelines**:

- **Long duration** (years): Fast playback (weeks per second)
- **Medium duration** (months): Medium playback (days per second)
- **Short duration** (days): Slower playback (hours per second)
- **Real-time** (minutes): Very slow playback (minutes per second)

**User Experience**:

- Too fast: Users can't observe patterns
- Too slow: Users lose interest
- Sweet spot: 3-10 seconds to traverse interesting time range

---

## Performance Considerations

### Initial Load Optimization

The system automatically calculates optimal initial window:

```typescript
const datasetDuration = metadata.timeRange.end - metadata.timeRange.start;
const userTimeWindow = props.timeWindow || 86400000;
const maxInitialWindow = Math.min(30 * 86400000, datasetDuration);
const initialTimeWindow = Math.min(maxInitialWindow, userTimeWindow * 10);
```

**What this means**:

- Short datasets (< 30 days): Loads entire dataset
- Long datasets (> 30 days): Loads initial 30-day window
- Prevents loading 400 days for 24-hour dataset

### Memory Management

**Tile Cache**:

- Default: 200MB
- Configurable via `cacheSize` prop
- LRU eviction for older tiles

**Best Practices**:

- Keep `timeWindow` as small as practical
- Use appropriate temporal resolution
- Enable compression (gzip) for all datasets

---

## Troubleshooting

### Issue: Features disappear during animation

**Cause**: Time window too small for temporal resolution  
**Solution**: Increase `timeWindow` to at least `bucketSize * 2.5`

### Issue: Initial load is very slow

**Cause**: Loading too many tiles at startup  
**Solution**:

- Use shorter `timeWindow`
- Use coarser temporal resolution
- System auto-optimization should prevent this

### Issue: Animation is choppy

**Cause**: Too many features rendering per frame  
**Solution**:

- Reduce zoom level
- Increase temporal bucket size
- Enable GPU acceleration

### Issue: Coordinates are in wrong location

**Cause**: Delta encoding not properly handled  
**Solution**: Verify cursor tracking in `AnimatedPointLayer`

---

## Debug Mode

To enable debug logging:

```typescript
// packages/deck.gl/src/animated-point-layer.ts
const DEBUG = true;

// packages/deck.gl/src/spatiotemporal-layer.ts
const DEBUG = true;
```

Then rebuild:

```bash
cd packages/deck.gl && npm run build
cd ../../examples/showcase && npm run dev
```

**Debug Output**:

- Tile loading progress
- Feature count per frame
- Coordinate decoding verification
- Auto-configuration decisions

---

## Production Deployment

### Pre-Deployment Checklist

1. **Disable Debug Logging**:
   - [ ] Set `DEBUG = false` in `animated-point-layer.ts`
   - [ ] Set `DEBUG = false` in `spatiotemporal-layer.ts`

2. **Build Optimized Packages**:

   ```bash
   cd packages/deck.gl && npm run build
   cd ../core && npm run build
   ```

3. **Test All Datasets**:
   - [ ] Verify initial load < 1s for each dataset
   - [ ] Check coordinate accuracy
   - [ ] Test animation smoothness (60fps target)
   - [ ] Verify time window configurations

4. **Performance Validation**:
   - [ ] Monitor memory usage (<50MB growth over 10 minutes)
   - [ ] Check cache hit rate (>85% target)
   - [ ] Test on mobile devices (30fps acceptable)

---

## Example: Adding a New Dataset

Let's add "Air Quality Sensors" with hourly readings:

### Step 1: Generate Data

```bash
# Generate GeoJSON with hourly sensor readings
cargo run --release --bin generate-airquality-data -- \
  --output data/airquality.geojson \
  --sampling hourly
```

### Step 2: Build STT Archive

```bash
stt-build \
  --input data/airquality.geojson \
  --output showcase/public/data/airquality.stt \
  --time-field timestamp \
  --temporal-resolution daily-aggregates \  # Hourly data
  --min-zoom 3 \
  --max-zoom 12 \
  --compression gzip
```

### Step 3: Configure in `datasets.ts`

```typescript
{
  id: 'air-quality',
  name: 'Air Quality Sensors',
  description: 'PM2.5 readings from EPA monitoring stations',
  url: '/data/airquality.stt',
  type: 'point',
  timeRange: {
    start: Date.parse('2024-01-01T00:00:00Z'),
    end: Date.parse('2024-12-31T23:59:59Z'),
  },
  timeWindow: 3600000 * 3,  // 3 hours (hourly buckets * 2.5, rounded up)
  animationSpeed: 86400000,  // 1 day per second
  initialViewState: {
    longitude: -98.5,
    latitude: 39.8,
    zoom: 4,
  },
  legend: {
    title: 'PM2.5 (μg/m³)',
    items: [
      { color: '#00E400', label: 'Good (0-12)' },
      { color: '#FFFF00', label: 'Moderate (12-35)' },
      { color: '#FF7E00', label: 'Unhealthy for Sensitive (35-55)' },
      { color: '#FF0000', label: 'Unhealthy (55-150)' },
      { color: '#8F3F97', label: 'Very Unhealthy (150+)' },
    ],
  },
}
```

### Step 4: Add Styling in `App.tsx`

```typescript
getFillColor: (d: any) => {
  const pm25 = d.properties.pm25 || 0;
  if (pm25 < 12) return [0, 228, 0, 200];      // Green
  if (pm25 < 35) return [255, 255, 0, 200];    // Yellow
  if (pm25 < 55) return [255, 126, 0, 200];    // Orange
  if (pm25 < 150) return [255, 0, 0, 200];     // Red
  return [143, 63, 151, 200];                  // Purple
},
getRadius: () => 5000,  // 5km radius
```

---

Last Updated: 2024-10-25  
Version: 1.0.0
