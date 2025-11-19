# Showcase Speed Configuration

## Overview

The showcase app now has dataset-specific animation speeds that are tailored to each dataset's characteristics. Speed multipliers (0.25x, 0.5x, 1x, 2x) properly multiply the base speed instead of replacing it.

## Dataset-Specific Base Speeds

Each dataset now has an appropriate base `animationSpeed` that reflects the nature of the data:

### Long-Timespan Datasets (Slower)

- **Earthquake Activity**: 3 days per second (was 7 days/sec)
  - Covers ~11 months, needs slower speed to observe patterns
- **COVID-19 Cases**: 2 days per second (was 7 days/sec)
  - Covers ~2.5 years, slower speed shows progression better
- **Hurricanes**: 3 days per second (was 7 days/sec)
  - Covers 4 years, slower speed allows tracking of individual storms

### Short-Timespan Datasets (Medium-Fast)

- **Ship Traffic (AIS)**: 10 minutes per second (was 60 min/sec)
  - Single day of data, slower speed provides more realistic feel
- **SF Taxis**: 2 minutes per second (was 5 min/sec)
  - Single day, slower speed better visualizes trajectories
- **Flights**: 3 minutes per second (was 10 min/sec)
  - Single day, slower speed improves tracking

## Speed Multiplier System

The speed controls now properly multiply the base speed:

- **0.25x**: Quarter speed (ideal for detailed observation)
- **0.5x**: Half speed (for careful analysis)
- **1x**: Base speed (default, dataset-optimized)
- **2x**: Double speed (for quick overview)

### How It Works

1. Each dataset defines a base `animationSpeed` in milliseconds per second
2. User selects a multiplier (0.25x - 2x)
3. Actual animation speed = `baseSpeed × multiplier`
4. When switching datasets, multiplier resets to 1x

## Implementation Details

### Files Modified

1. **datasets.ts**: Updated base `animationSpeed` values for all datasets
2. **App.tsx**:
   - Added `speedMultiplier` state
   - Modified `handleSpeedChange` to multiply base speed
   - Pass `currentSpeedMultiplier` to TimeControls
3. **TimeControls.tsx**:
   - Updated to receive and display current multiplier
   - Changed speed buttons from 5x to 0.25x (removed 5x, added 0.25x)
   - Properly sync UI with parent component state

### Example Calculation

For **Ship Traffic** (AIS data):

- Base speed: 600,000ms per second (10 real minutes per 1 animation second)
- At 0.5x: 300,000ms/sec (5 real minutes per animation second)
- At 1x: 600,000ms/sec (10 real minutes per animation second)
- At 2x: 1,200,000ms/sec (20 real minutes per animation second)

## Rationale

### Why Slower?

1. **Better User Experience**: Slower speeds allow users to observe and understand patterns
2. **Realistic Feel**: Particularly for real-time-like data (ships, taxis, flights)
3. **Dataset Appropriate**: Long timespans need different speeds than short timespans

### Why Dataset-Specific?

Different datasets have vastly different:

- **Temporal extents**: 1 day vs 4 years
- **Event frequencies**: Continuous (ships) vs sporadic (earthquakes)
- **User expectations**: Historical trends vs real-time monitoring

A one-size-fits-all approach doesn't work well for such varied data.

## Future Enhancements

Possible improvements:

1. Add more granular speed options (0.1x, 0.75x, 3x, etc.)
2. Allow custom speed input
3. Add keyboard shortcuts for speed control
4. Save user's preferred speed per dataset in local storage
5. Dynamic speed adjustment based on zoom level or viewport



