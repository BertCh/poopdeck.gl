# Temporal Bucketing & Resolution

STT uses adaptive temporal bucketing to optimize file size while maintaining query performance.

## Why Temporal Bucketing?

Instead of creating a separate tile for every unique timestamp, STT groups nearby events into temporal "buckets." This dramatically reduces tile count and archive size.

**Example:** 77,000 earthquakes over 5 years

- Without bucketing: 77,000 separate temporal tiles
- With yearly bucketing at zoom 0-2: ~365 tiles (one per day at finer zooms)
- **Result:** 99% reduction in tiles, 5x smaller file size

---

## Resolution Profiles

### 1. High-Frequency (`high-frequency`)

**Use Case:** Real-time tracking (ships, aircraft, vehicles)

| Zoom Level | Bucket Size | Use Case    |
| ---------- | ----------- | ----------- |
| 0-2        | 1 hour      | Global view |
| 3-5        | 10 minutes  | Regional    |
| 6-8        | 1 minute    | City view   |
| 9+         | 10 seconds  | Street view |

**Animation Speed:** 1 second of real time per second

### 2. Sparse Events (`sparse-events`)

**Use Case:** Earthquakes, incidents, discrete events

| Zoom Level | Bucket Size | Use Case          |
| ---------- | ----------- | ----------------- |
| 0-2        | 1 year      | Global patterns   |
| 3-5        | 1 month     | Regional activity |
| 6-8        | 1 week      | Local clustering  |
| 9+         | 1 day       | Precise locations |

**Animation Speed:** 2 days of real time per second  
**Optimization:** Prioritizes file size over temporal precision

### 3. Daily Aggregates (`daily-aggregates`)

**Use Case:** Weather, COVID cases, daily statistics

| Zoom Level | Bucket Size | Use Case        |
| ---------- | ----------- | --------------- |
| 0-4        | 1 week      | National trends |
| 5-7        | 1 day       | Regional detail |
| 8+         | 1 day       | Local precision |

**Animation Speed:** 1 day of real time per second

### 4. Fixed Buckets

You can also specify a fixed bucket size:

```bash
--temporal-resolution day    # Always 1-day buckets
--temporal-resolution hour   # Always 1-hour buckets
--temporal-resolution month  # Always monthly buckets
```

**Options:** `second`, `minute`, `hour`, `day`, `week`, `month`, `year`

---

## How It Works

### 1. Bucketing Process

```rust
// Pseudocode
fn bucket_timestamp(timestamp: u64, bucket_size: BucketSize) -> u64 {
    match bucket_size {
        BucketSize::Day => {
            // Round down to start of day
            let dt = DateTime::from_timestamp_millis(timestamp);
            dt.date().and_hms(0, 0, 0).timestamp_millis()
        }
        BucketSize::Month => {
            // Round down to start of month
            let dt = DateTime::from_timestamp_millis(timestamp);
            dt.with_day(1).and_hms(0, 0, 0).timestamp_millis()
        }
        // ... etc
    }
}
```

### 2. Tile Time Ranges

Each tile stores the actual range of data it contains:

```protobuf
message Tile {
  uint64 time_start = 1;  // Earliest feature timestamp
  uint64 time_end = 2;    // Latest feature timestamp
  repeated Layer layers = 3;
}
```

### 3. Querying

When the frontend queries tiles, it:

1. Calculates required spatial tiles (from viewport)
2. Filters to tiles whose time ranges **overlap** the query window
3. Loads all matching tiles in parallel

```typescript
// Find tiles that overlap query time range
const matchingTiles = index.tiles.filter(
  (tile) =>
    tile.zoom === zoom &&
    tile.x === x &&
    tile.y === y &&
    tile.timeEnd >= queryStart && // Tile ends after query starts
    tile.timeStart <= queryEnd // Tile starts before query ends
);
```

---

## Choosing the Right Profile

### High-Frequency

**Choose if:**

- Events happen continuously (every few seconds/minutes)
- You need smooth, real-time playback
- File size is less important than temporal precision

**Examples:** Ship tracking, flight paths, vehicle GPS

### Sparse Events (Recommended)

**Choose if:**

- Events are discrete and irregularly spaced
- File size is important (CDN bandwidth costs)
- Temporal precision of days/weeks is acceptable

**Examples:** Earthquakes, crime incidents, social media posts

### Daily Aggregates

**Choose if:**

- Data is naturally aggregated by day
- Showing daily trends is the primary use case
- Source data is already daily summaries

**Examples:** Weather data, COVID cases, air quality indices

### Fixed Buckets

**Choose if:**

- You have specific temporal precision requirements
- Data has a natural cadence (hourly reports, monthly statistics)
- Simplicity is more important than optimization

---

## Frontend Integration

### Auto-Configuration

The frontend automatically detects tile temporal resolution:

```typescript
// Tile metadata includes recommended settings
interface TemporalResolution {
  bucketSizeMs: number; // Size of temporal buckets
  suggestedSpeedMultiplier: number; // Recommended animation speed
  description: string; // Human-readable description
}
```

### Manual Time Window

You can override the time window if needed:

```typescript
const layer = new AnimatedPointLayer({
  data: "/earthquakes.stt",
  currentTime: Date.now(),
  timeWindow: 7 * 86400000, // Query 7 days before/after current time
  // ...
});
```

**Recommendation:** Let STT auto-configure from tile metadata for best results.

---

## Performance Impact

| Bucket Size | Tile Count | File Size  | Query Time | Animation Smoothness |
| ----------- | ---------- | ---------- | ---------- | -------------------- |
| Second      | Very High  | Large      | Slow       | Perfect              |
| Minute      | High       | Medium     | Medium     | Excellent            |
| Hour        | Medium     | Small      | Fast       | Good                 |
| Day         | Low        | Very Small | Very Fast  | Acceptable           |
| Week        | Very Low   | Tiny       | Instant    | Coarse               |

**Sweet Spot:** Use zoom-adaptive profiles (like `sparse-events`) to get the best of both worlds.

---

## Technical Details

### Chrono-Based Bucketing

STT uses Rust's `chrono` crate for accurate date/time math:

```rust
use chrono::{DateTime, Datelike, NaiveDateTime, Months};

// Add months correctly (handles different month lengths)
let dt = NaiveDateTime::from_timestamp_millis(timestamp)?;
let next_month = dt.checked_add_months(Months::new(1))?;

// Handle timezone-aware conversions
let dt_utc = DateTime::<Utc>::from_timestamp_millis(timestamp)?;
```

This ensures:

- Months are handled correctly (28, 29, 30, or 31 days)
- Years account for leap years
- Daylight saving time is handled properly
- ISO 8601 compatibility

### Tile Expansion

When features in a tile all have the same timestamp (due to bucketing), the tile's time range is expanded to cover the entire bucket period:

```rust
let (tile_time_start, tile_time_end) = if bucket_size_ms > 0 && min_time == max_time {
    // Expand to cover full bucket period
    (min_time, min_time + bucket_size_ms)
} else {
    // Use actual feature time range
    (min_time, max_time)
};
```

This ensures queries correctly find tiles even when the query time falls between feature timestamps.

---

## Best Practices

1. **Start with a profile** - Use `sparse-events` for most datasets
2. **Test animation speed** - Adjust `speed` in TimeController to match your data cadence
3. **Monitor file size** - Check build output for tile count and compression ratios
4. **Verify queries** - Check browser console to ensure tiles are loading

---

For more details, see [ARCHITECTURE.md](./ARCHITECTURE.md) and [GETTING_STARTED.md](./GETTING_STARTED.md).
