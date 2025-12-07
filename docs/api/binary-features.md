# Binary Features Format

GPU-optimized binary columnar format for spatiotemporal data. This format enables zero-copy GPU upload and efficient rendering in deck.gl.

## Overview

The binary format stores feature data in typed arrays instead of JavaScript objects:

```typescript
// Standard object format (CPU-friendly)
interface Feature {
  id: number;
  positions: [number, number][];
  properties: Record<string, any>;
  timeRange?: { start: number; end: number };
}

// Binary columnar format (GPU-friendly)
interface BinaryFeatures {
  featureCount: number;
  positions: Float64Array;      // [lon0, lat0, lon1, lat1, ...]
  featureIds: Uint32Array;      // [id0, id1, id2, ...]
  startTimes: Float32Array;     // [start0, start1, ...]
  endTimes: Float32Array;       // [end0, end1, ...]
  numericProperties: Record<string, Float32Array>;
  categoricalProperties: Record<string, { indices: Uint8Array; categories: string[] }>;
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
import { STTLoader, BinaryTile } from "@stt/core";

const binaryTile = await load(url, STTLoader, {
  stt: {
    tileId: { z: 0, x: 0, y: 0, t: 0 },
    outputFormat: 'binary',
  },
}) as BinaryTile;
```

### Accessing Data

```typescript
import { getBinaryPosition, getBinaryPath } from "@stt/core";

const features = binaryTile.layers[0].features;

// Get position for point feature at index 0
const [lon, lat] = getBinaryPosition(features, 0);

// Get path for line feature at index 5
const path = getBinaryPath(features, 5);

// Access numeric property
const magnitude = features.numericProperties['magnitude']?.[0];

// Access categorical property
const category = features.categoricalProperties['status'];
const statusIndex = category.indices[0];
const statusValue = category.categories[statusIndex];
```

### Using with deck.gl

```typescript
import { ScatterplotLayer } from "@deck.gl/layers";

// Binary data requires index-based accessors
const layer = new ScatterplotLayer({
  id: 'binary-points',
  data: {
    length: features.featureCount,
    attributes: {
      getPosition: { value: features.positions, size: 2 },
    },
  },
  getRadius: 100,
});
```

## Types

### BinaryTile

```typescript
interface BinaryTile {
  id: TileId;
  timeRange: TimeRange;
  layers: BinaryLayer[];
}
```

### BinaryLayer

```typescript
interface BinaryLayer {
  name: string;
  extent: number;
  features: BinaryFeatures;
}
```

### BinaryFeatures

```typescript
interface BinaryFeatures {
  featureCount: number;
  geometryType: GeometryType;
  
  // Interleaved positions [lon, lat, lon, lat, ...]
  positions: Float64Array;
  
  // For lines/polygons: offset into positions for each feature
  positionOffsets?: Uint32Array;
  
  // Feature identifiers
  featureIds: Uint32Array;
  
  // Temporal data (relative to timeOffset)
  startTimes: Float32Array;
  endTimes: Float32Array;
  timeOffset: number;
  
  // Properties as typed arrays
  numericProperties: Record<string, Float32Array>;
  categoricalProperties: Record<string, {
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


