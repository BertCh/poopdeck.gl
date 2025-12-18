# CategoryColorExtension

The `CategoryColorExtension` is a deck.gl layer extension that provides GPU-based categorical color lookup. Instead of expanding category indices to RGBA colors on the CPU, it passes category indices to the GPU and performs palette lookup in the fragment shader.

## Installation

```typescript
import { CategoryColorExtension } from '@stt/deck.gl';
```

## Usage

```typescript
import { ScatterplotLayer } from '@deck.gl/layers';
import { CategoryColorExtension } from '@stt/deck.gl';

const layer = new ScatterplotLayer({
  id: 'categorical-points',
  data: myData,
  
  // Extension configuration
  extensions: [new CategoryColorExtension()],
  categoryPalette: [
    [255, 0, 0, 255],   // Category 0: Red
    [0, 255, 0, 255],   // Category 1: Green
    [0, 0, 255, 255],   // Category 2: Blue
  ],
  getCategoryIndex: d => d.categoryId, // Returns 0, 1, or 2
  useCategoryColor: true,
  
  // Regular layer props
  getPosition: d => d.coordinates,
  getRadius: 100,
});
```

## Extension Props

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `categoryPalette` | `Color[]` | `[]` | Array of RGBA colors (up to 256). |
| `getCategoryIndex` | `Accessor<number>` | `0` | Accessor returning category index (0-255). |
| `useCategoryColor` | `boolean` | `true` | Enable/disable categorical coloring. |

## Benefits

1. **Eliminates O(n) CPU loop**: No need to expand category indices to RGBA for each feature
2. **Reduces memory**: 1 byte per feature instead of 4 bytes
3. **Dynamic palette changes**: Change colors without re-uploading attribute data

## Performance Comparison

```typescript
// Traditional approach - O(n) CPU work per update
const colors = data.map(d => palette[d.category]); // CPU expansion
new ScatterplotLayer({
  getFillColor: (d, i) => colors[i],
});

// With CategoryColorExtension - O(1) GPU lookup
new ScatterplotLayer({
  extensions: [new CategoryColorExtension()],
  categoryPalette: palette,
  getCategoryIndex: d => d.category,
});
```

## Limitations

- Maximum 256 categories (shader uniform array limit)
- Category indices must be integers 0-255
- Overrides the layer's normal color accessor when enabled

## Source

[packages/deck.gl/src/category-color-extension.ts](../../packages/deck.gl/src/category-color-extension.ts)

