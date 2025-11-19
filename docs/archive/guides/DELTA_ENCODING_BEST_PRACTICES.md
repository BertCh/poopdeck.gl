# Delta Encoding - Best Practices

## When to Use Delta Encoding

### ✅ USE Delta Encoding For:

**Static Geometries with Changing Properties:**

- Weather stations (fixed locations, different readings)
- Sensors (same positions, varying values)
- Administrative boundaries (counties with changing COVID cases)
- Buildings with changing occupancy
- Traffic signals/cameras with status changes

**Expected file size reduction:** 50-86%

**Example:**

```bash
# Weather stations - GOOD use case
./target/release/stt-build \
  --input weather-stations.geojson \
  --output weather.stt \
  --delta-encoding \
  ...
```

### ❌ DON'T USE Delta Encoding For:

**Constantly Moving Objects:**

- Ships/vessels (AIS data) ← Our case
- Aircraft tracking
- Vehicle GPS traces
- Anything with continuous position changes

**Why?** No unchanged features to skip, only metadata overhead.

**Expected file size:** Same or larger (metadata adds ~2x overhead with 0% savings)

**Example:**

```bash
# Ships - BAD use case, skip --delta-encoding
./target/release/stt-build \
  --input ais-data.geojson \
  --output ships.stt \
  --compression gzip \
  ...
```

### ⚠️ CONSIDER Delta Encoding For:

**Semi-Static Features:**

- Slow-moving objects (animals, hikers)
- Objects that pause frequently (taxis, delivery vehicles)
- Features with repetitive patterns

**Expected file size reduction:** 20-50%

---

## Current Project Configuration

### Datasets Using Regular Encoding:

- ✅ `ships.stt` (83M) - AIS maritime traffic, constantly moving
- ✅ `earthquakes.stt` - One-time events, no temporal repetition
- ✅ `hurricanes.stt` - Moving storm tracks
- ✅ `sf-taxis.stt` - Moving vehicles
- ✅ `flights.stt` - Aircraft positions

### Future Candidates for Delta Encoding:

- `covid-cases.stt` - Same counties over time (if re-generated)
- Weather station data - Fixed locations with readings
- Infrastructure monitoring - Static sensors

---

## Quick Decision Guide

**Ask yourself:** "Does the same entity appear in multiple temporal frames with the same geometry?"

- **YES** → Use `--delta-encoding` flag
- **NO** → Skip delta encoding (regular encoding is better)

**Rule of thumb:** If objects are moving, don't use delta encoding.

---

## File Size Comparison (Ships Dataset)

```
Regular encoding:  83M  ✅ USE THIS
Delta encoding:   163M  ❌ Don't use
```

The delta-encoded version is **2x larger** because:

1. Ships constantly move (geometry always changes)
2. 0% unchanged features
3. Delta metadata (change types, hashes) adds overhead
4. No compression benefits

**Decision:** Use regular encoding for all tracking/movement data.

---

## Implementation Notes

Delta encoding is **fully implemented and working** in the codebase. It's available as an optional `--delta-encoding` flag for datasets where it provides benefits (static features with changing properties).

For our maritime traffic use case, regular encoding is the optimal choice.



