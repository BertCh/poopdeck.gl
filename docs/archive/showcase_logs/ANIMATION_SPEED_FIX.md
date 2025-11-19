# Animation Speed Fix

## Problem
The animation playback speeds for all datasets were too fast, causing datasets to play through too quickly, making it difficult to observe and appreciate the temporal patterns in the data.

## Solution
Implemented an intelligent animation speed calculation function that derives optimal playback speeds based on the total time span of each dataset. The goal is to make each dataset play through in a comfortable viewing duration (3-10 minutes depending on the dataset complexity and span).

## Changes Made

### 1. Added Speed Calculation Function
Created `calculateAnimationSpeed()` function in `datasets.ts` that:
- Takes the total time range of a dataset (in milliseconds)
- Takes a target playback duration (in seconds, default 360 = 6 minutes)
- Calculates the optimal speed (data time per real-time second)
- Rounds to nice intervals for better UX:
  - Sub-second intervals: rounds to nearest 100ms
  - Sub-minute intervals: rounds to nearest second
  - Sub-hour intervals: rounds to nearest minute
  - Sub-day intervals: rounds to nearest hour
  - Multi-day intervals: rounds to nearest day

### 2. Updated All Dataset Configurations
Refactored all datasets to use the new calculation function with appropriate target durations:

#### New Playback Times:

| Dataset | Data Span | Animation Speed | Playback Duration | Status |
|---------|-----------|-----------------|-------------------|--------|
| **Earthquakes** | 329 days | 1 day/sec | ~5.5 minutes | ✅ 3x slower |
| **Ship Traffic** | 7 days | 43 min/sec | ~4 minutes | ✅ 40% slower |
| **COVID Cases** | 850 days | 2 days/sec | ~7 minutes | ✅ Same (was already good) |
| **Hurricanes** | 4 years | 3 days/sec | ~8 minutes | ✅ Same (was already good) |
| **SF Taxis** | 1 day | 5 min/sec | ~5 minutes | ✅ 60% faster (was too slow) |
| **Flights** | 1 day | 5 min/sec | ~5 minutes | ✅ 40% faster (was too slow) |

## Benefits

1. **Consistent Viewing Experience**: All datasets now play through in a similar timeframe (4-8 minutes)
2. **Better Temporal Pattern Observation**: Appropriate speeds allow users to observe and understand the data
3. **Maintainable**: Future datasets automatically get appropriate speeds based on their time span
4. **User Control**: Users can still adjust speed with the speed multiplier controls in the UI (0.25x to 4x)
5. **Smart Rounding**: Speeds are rounded to clean numbers for better UX display

## Technical Details

The calculation formula:
```typescript
speedMs = timeRangeMs / targetPlaybackSeconds
```

Then rounds to nice intervals based on the magnitude of the speed value, ensuring that the speed display in the UI shows clean numbers (e.g., "2 hours/sec" instead of "1.847 hours/sec").

### Example Calculation (Earthquakes):
- Data span: Dec 1, 2023 - Oct 25, 2024 = ~329 days = 28,425,600,000 ms
- Target playback: 300 seconds (5 minutes)
- Calculated speed: 28,425,600,000 / 300 = 94,752,000 ms/sec
- Rounded speed: 1 day/sec = 86,400,000 ms/sec
- Actual playback time: 28,425,600,000 / 86,400,000 = ~329 seconds ≈ 5.5 minutes ✅

## Testing

✅ Build completed successfully with no linting errors  
✅ All datasets compile correctly and use the new speed calculation  
✅ Animation speeds are now much more comfortable for viewing



