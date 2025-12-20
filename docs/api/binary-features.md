# Binary Features Format

GPU-optimized binary columnar format for spatiotemporal data. This format enables zero-copy GPU upload and efficient rendering in deck.gl.

## Overview

The binary format stores feature data in typed arrays instead of JavaScript objects:

```typescript
// Binary columnar format (GPU-friendly)
interface BinaryFeatures {
  featureCount: number;
  geometryType: GeometryType;
  positionDimensions?: 2 | 3;
  positions: Float64Array;     // Interleaved [lon, lat, ...] or [lon, lat, alt, ...]
  startIndices?: Uint32Array;  // For lines/polygons: start index per feature
  featureIds: Uint32Array;
  startTimes: Float32Array;    // Relative to timeOffset
  endTimes: Float32Array;      // Relative to timeOffset
  timeOffset: number;          // Add to times for absolute value
  numericProps: Record<string, Float32Array>;
  categoricalProps: Record<string, { indices: Uint8Array; categories: string[] }>;
}
```

## Benefits

1. **Zero-Copy GPU Upload**: Typed arrays can be uploaded to GPU buffers directly
2. **Memory Efficiency**: No JavaScript object overhead per feature
3. **Cache-Friendly**: Columnar layout enables efficient iteration
4. **Worker Transfer**: Typed array buffers can be transferred (not copied) between workers

## Usage

### Loading Binary Data

```typescript
import { load } from "@loaders.gl/core";
import { STTLoader } from "@stt/core";

const tile = await load(url, STTLoader, {
  stt: {
    tileId: { z: 0, x: 0, y: 0, t: 0 },
  },
});

// All tiles are returned in binary format
const features = tile.layers[0].features;
```

### Accessing Data

```typescript
import {
  getBinaryPosition,
  getBinaryPosition3D,
  getAbsoluteStartTime,
  getAbsoluteEndTime,
  getNumericProperty,
  getCategoricalProperty,
} from "@stt/core";

const features = tile.layers[0].features;

// Get 2D position for point feature at index 0
const [lon, lat] = getBinaryPosition(features, 0);

// Get 3D position (includes altitude if available)
const [lon, lat, alt] = getBinaryPosition3D(features, 0);

// Get absolute timestamp
const startTime = getAbsoluteStartTime(features, 0);

// Access numeric property
const magnitude = getNumericProperty(features, "magnitude", 0);

// Access categorical property (returns resolved string value)
const status = getCategoricalProperty(features, "status", 0);
```

### Using with deck.gl

```typescript
import { ScatterplotLayer } from "@deck.gl/layers";

const features = tile.layers[0].features;

// Binary data uses deck.gl's binary data interface
const layer = new ScatterplotLayer({
  id: "binary-points",
  data: {
    length: features.featureCount,
    attributes: {
      getPosition: { value: features.positions, size: 2 },
    },
  },
  getRadius: 100,
});
```

### Using with PathLayer

```typescript
import { PathLayer } from "@deck.gl/layers";

const features = tile.layers[0].features;

// Lines/polygons use startIndices for variable-length geometries
const layer = new PathLayer({
  id: "binary-paths",
  data: {
    length: features.featureCount,
    startIndices: features.startIndices,
    attributes: {
      getPath: { value: features.positions, size: 2 },
    },
  },
  getWidth: 2,
});
```

## Types

### BinaryFeatures

```typescript
interface BinaryFeatures {
  /** Total number of features */
  featureCount: number;

  /** Geometry type (0=Point, 1=LineString, 2=Polygon) */
  geometryType: GeometryType;

  /** Number of dimensions per position (2 or 3) */
  positionDimensions?: 2 | 3;

  /** Interleaved positions [lon, lat, ...] or [lon, lat, alt, ...] */
  positions: Float64Array;

  /** Start index for each feature's positions (for lines/polygons) */
  startIndices?: Uint32Array;

  /** Feature IDs (per feature) */
  featureIds: Uint32Array;

  /** Start time for each feature (ms, relative to timeOffset) */
  startTimes: Float32Array;

  /** End time for each feature (ms, relative to timeOffset) */
  endTimes: Float32Array;

  /** Time offset - add to times for absolute values */
  timeOffset: number;

  /** Numeric properties as Float32Arrays */
  numericProps: Record<string, Float32Array>;

  /** Categorical properties as index + lookup table */
  categoricalProps: Record<string, {
    indices: Uint8Array;
    categories: string[];
  }>;
}
```

## Memory Size Calculation

```typescript
import { getBinaryFeaturesSize } from "@stt/core";

const sizeInBytes = getBinaryFeaturesSize(features);
console.log(`Features use ${sizeInBytes / 1024}KB`);
```

## Source

[packages/core/src/binary-features.ts](../../packages/core/src/binary-features.ts)
