# Temporal Range Fix

## Problem

The frontend was unable to query tiles correctly. Console logs showed:

```
Archive: No tile for z=1 x=0 y=0 at 2020-05-16
Archive: No tile for z=1 x=0 y=1 at 2020-05-16
...
Archive: Returning 0 tiles out of 4 requested
```

Even though the tile index contained tiles:

```
[0] z=0 x=0 y=0 time=2021-10-01 to 2021-10-01
[1] z=0 x=0 y=0 time=2021-11-01 to 2021-11-01
...
```

## Root Cause

When features were temporally bucketed (e.g., all May 2020 features → `2020-06-01`), all features in a tile had the **same timestamp**. The tile generation code used:

```rust
time_start: min_time,
time_end: max_time,
```

Since `min_time === max_time` for bucketed features, the tile's time range was a single point in time (e.g., `2020-06-01 to 2020-06-01`).

The frontend query logic checked:

```typescript
e.timeStart <= id.t && e.timeEnd >= id.t;
```

This failed because:

- Query time: `2020-05-16` (middle of May)
- Tile range: `2020-06-01 to 2020-06-01` (June 1st only)
- Check fails: `2020-06-01 > 2020-05-16`

## Solution

Modified `crates/stt-build/src/tiler.rs` to expand the time range to cover the entire bucket period:

### Before

```rust
let proto_tile = stt_core::proto::Tile {
    version: 1,
    time_start: min_time,  // Same as max_time for bucketed features
    time_end: max_time,    // Same as min_time
    ...
};
```

### After

```rust
// If features are bucketed (all have same timestamp), expand time range
let (tile_time_start, tile_time_end) = if bucket_size_ms > 0 && min_time == max_time {
    let start_time = min_time;
    let end_time = match temporal_bucket {
        TemporalBucket::Month => {
            // Calculate end of month properly
            if let Some(dt) = NaiveDateTime::from_timestamp_millis(start_time as i64) {
                if let Some(next_month) = dt.date().checked_add_months(Months::new(1)) {
                    let end_of_month = next_month
                        .and_hms_opt(0, 0, 0)
                        .map(|dt| dt.and_utc().timestamp_millis() as u64)
                        .unwrap_or(start_time + 2_592_000_000);
                    end_of_month - 1 // One millisecond before next month
                }
            }
        }
        // Similar logic for Day, Week, Year, etc.
        ...
    };
    (start_time, end_time)
} else {
    // Use actual feature time range
    (min_time, max_time)
};

let proto_tile = stt_core::proto::Tile {
    version: 1,
    time_start: tile_time_start,
    time_end: tile_time_end,
    ...
};
```

## Example

For a monthly bucket starting at `2020-06-01T00:00:00.000Z`:

### Before

- `time_start`: `1590969600000` (2020-06-01 00:00:00.000)
- `time_end`: `1590969600000` (2020-06-01 00:00:00.000)
- **Range**: Single instant

### After

- `time_start`: `1590969600000` (2020-06-01 00:00:00.000)
- `time_end`: `1593561599999` (2020-06-30 23:59:59.999)
- **Range**: Entire month of June 2020

## Result

Queries for any date in June 2020 (e.g., `2020-06-15`) will now match the tile:

```
2020-06-01 <= 2020-06-15 <= 2020-06-30  ✅
```

## Temporal Buckets Handled

- **None**: No change (exact timestamps)
- **Second**: Range = 1 second (start to start+999ms)
- **Minute**: Range = 1 minute (start to start+59,999ms)
- **Hour**: Range = 1 hour (start to start+3,599,999ms)
- **Day**: Range = 1 day (start to start+86,399,999ms)
- **Week**: Range = 1 week (start to start+604,799,999ms)
- **Month**: Range = full month (calculated using chrono)
- **Year**: Range = full year (calculated using chrono)

## Files Modified

1. `crates/stt-build/src/tiler.rs` - Added temporal range expansion logic

## Testing

Rebuilt COVID-19 dataset:

```bash
stt-build --input data/covid-cases.geojson \
          --output covid-cases.stt \
          --time-field timestamp \
          --temporal-resolution daily-aggregates \
          --min-zoom 0 \
          --max-zoom 14 \
          --compression brotli
```

Expected result: Frontend should now load tiles successfully.

## Date

October 25, 2025
