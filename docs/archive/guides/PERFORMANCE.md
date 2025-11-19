# Performance Benchmarking Plan

## Overview

This document outlines the comprehensive performance testing strategy for the SpatioTemporal Tiles (STT) project, covering both Rust (generation) and TypeScript (client-side) components.

## Performance Goals (Recap)

| Metric | Target | Critical Threshold |
|--------|--------|-------------------|
| Tile Generation | 10K features/sec | <5K features/sec |
| File Size Overhead | <15% vs PMTiles | >25% vs PMTiles |
| Initial Load | <500ms | >1000ms |
| Frame Switch | <16ms (60 FPS) | >33ms (30 FPS) |
| Timeline Scrub | <100ms | >200ms |
| Prefetch Distance | 5 seconds ahead | <2 seconds |
| Memory Footprint | <200MB | >500MB |
| Cache Hit Rate | >80% during playback | <60% |

## Rust Benchmarking (Tile Generation)

### 1. Encoding Performance

**File**: `crates/stt-core/benches/encoding.rs`

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use stt_core::{tile::*, types::*};

fn bench_tile_encoding(c: &mut Criterion) {
    let mut group = c.benchmark_group("tile_encoding");
    
    for feature_count in [100, 1_000, 10_000].iter() {
        group.bench_with_input(
            BenchmarkId::new("encode", feature_count),
            feature_count,
            |b, &count| {
                let tile = create_test_tile(count);
                b.iter(|| {
                    encode_tile(black_box(&tile))
                });
            },
        );
    }
    
    group.finish();
}

fn bench_compression(c: &mut Criterion) {
    let mut group = c.benchmark_group("compression");
    let tile_data = create_large_tile_data();
    
    for compression in [Compression::None, Compression::Gzip, Compression::Brotli] {
        group.bench_with_input(
            BenchmarkId::new("compress", format!("{:?}", compression)),
            &compression,
            |b, &comp| {
                b.iter(|| {
                    compress(black_box(&tile_data), comp)
                });
            },
        );
    }
    
    group.finish();
}

criterion_group!(benches, bench_tile_encoding, bench_compression);
criterion_main!(benches);
```

**Metrics**:
- Encode time per feature
- Compression ratio
- Compression throughput (MB/s)

### 2. Spatial Indexing Performance

**File**: `crates/stt-core/benches/indexing.rs`

```rust
fn bench_hilbert_curve(c: &mut Criterion) {
    let mut group = c.benchmark_group("hilbert_curve");
    
    for zoom in [10, 14, 18].iter() {
        group.bench_with_input(
            BenchmarkId::new("calculate", zoom),
            zoom,
            |b, &z| {
                let (x, y) = (rand::random::<u32>() % (1 << z), 
                              rand::random::<u32>() % (1 << z));
                b.iter(|| {
                    hilbert_index(black_box(x), black_box(y), black_box(z))
                });
            },
        );
    }
    
    group.finish();
}

fn bench_spatial_query(c: &mut Criterion) {
    let mut group = c.benchmark_group("spatial_query");
    let index = create_large_spatial_index(100_000);
    
    group.bench_function("bounds_query", |b| {
        let bounds = random_bounds();
        b.iter(|| {
            index.query_bounds(black_box(&bounds))
        });
    });
    
    group.finish();
}
```

**Metrics**:
- Hilbert curve calculation time
- Index lookup time
- Range query performance

### 3. End-to-End Generation

**File**: `crates/stt-build/benches/e2e.rs`

```rust
fn bench_full_pipeline(c: &mut Criterion) {
    let mut group = c.benchmark_group("full_pipeline");
    group.sample_size(10);
    group.measurement_time(Duration::from_secs(30));
    
    for feature_count in [10_000, 100_000, 1_000_000].iter() {
        group.bench_with_input(
            BenchmarkId::new("generate", feature_count),
            feature_count,
            |b, &count| {
                let input_file = create_test_geojson(count);
                b.iter(|| {
                    run_stt_build(black_box(&input_file))
                });
            },
        );
    }
    
    group.finish();
}
```

**Metrics**:
- Total generation time
- Features per second
- Memory usage
- Output file size
- Compression ratio

### Running Rust Benchmarks

```bash
# Run all benchmarks
cargo bench

# Run specific benchmark
cargo bench --bench encoding

# With profiling
cargo bench -- --profile-time=10

# Generate flamegraph
cargo flamegraph --bench encoding
```

## TypeScript Benchmarking (Client-Side)

### 1. Tile Decoding Performance

**File**: `packages/core/src/__tests__/performance.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { STTArchive } from '../archive';
import { decodeTile } from '../tile';

describe('Tile Decoding Performance', () => {
  it('should decode 10K features in <20ms', async () => {
    const tile = await loadTestTile('10k_features.bin');
    
    const start = performance.now();
    const decoded = decodeTile(tile, testTileId);
    const elapsed = performance.now() - start;
    
    expect(elapsed).toBeLessThan(20);
    expect(decoded.layers[0].features.length).toBe(10000);
  });
  
  it('should maintain 60 FPS with continuous decoding', async () => {
    const frames = 60;
    const tiles = await loadTestTiles(frames);
    
    const frameStart = performance.now();
    
    for (const tile of tiles) {
      const start = performance.now();
      decodeTile(tile, testTileId);
      const elapsed = performance.now() - start;
      
      // Each frame must decode in <16ms for 60 FPS
      expect(elapsed).toBeLessThan(16);
    }
    
    const totalTime = performance.now() - frameStart;
    const fps = (frames / totalTime) * 1000;
    
    expect(fps).toBeGreaterThan(55); // 5 FPS buffer
  });
});
```

### 2. HTTP Range Request Performance

```typescript
describe('HTTP Range Request Performance', () => {
  it('should fetch tile in <50ms (p95)', async () => {
    const archive = new STTArchive('https://test.com/tiles.stt');
    const times: number[] = [];
    
    // Measure 100 requests
    for (let i = 0; i < 100; i++) {
      const tileId = randomTileId();
      const start = performance.now();
      await archive.getTile(tileId);
      times.push(performance.now() - start);
    }
    
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    
    expect(p95).toBeLessThan(50);
  });
});
```

### 3. Cache Performance

```typescript
describe('Cache Performance', () => {
  it('should achieve >80% cache hit rate during animation', async () => {
    const archive = new STTArchive('https://test.com/tiles.stt');
    const timeController = new TimeController({
      initialTime: Date.now(),
      speed: 1.0,
    });
    
    let cacheHits = 0;
    let totalRequests = 0;
    
    // Simulate 10 seconds of animation at 60 FPS
    for (let frame = 0; frame < 600; frame++) {
      timeController.seek(Date.now() + frame * 16);
      
      const tiles = await archive.getTilesInBounds(
        testBounds,
        10,
        { start: timeController.getTime(), end: timeController.getTime() + 1000 }
      );
      
      totalRequests += tiles.length;
      // Track cache hits (tiles already in cache)
    }
    
    const hitRate = cacheHits / totalRequests;
    expect(hitRate).toBeGreaterThan(0.8);
  });
});
```

### 4. Memory Usage

```typescript
describe('Memory Usage', () => {
  it('should stay under 200MB during animation', async () => {
    const archive = new STTArchive('https://test.com/large-dataset.stt');
    
    if (performance.memory) {
      const initialMemory = performance.memory.usedJSHeapSize;
      
      // Load many tiles
      for (let i = 0; i < 100; i++) {
        await archive.getTilesInBounds(testBounds, 10, testTimeRange);
      }
      
      const finalMemory = performance.memory.usedJSHeapSize;
      const memoryUsed = (finalMemory - initialMemory) / (1024 * 1024);
      
      expect(memoryUsed).toBeLessThan(200);
    }
  });
});
```

### 5. deck.gl Rendering Performance

**File**: `packages/deck.gl/src/__tests__/rendering.test.ts`

```typescript
import { Deck } from '@deck.gl/core';
import { AnimatedPointLayer } from '../animated-point-layer';

describe('Rendering Performance', () => {
  it('should maintain 60 FPS with 1M points', async () => {
    const deck = new Deck({
      canvas: document.createElement('canvas'),
      initialViewState: testViewState,
      controller: true,
    });
    
    const layer = new AnimatedPointLayer({
      id: 'points',
      data: 'https://test.com/1m-points.stt',
      currentTime: Date.now(),
    });
    
    deck.setProps({ layers: [layer] });
    
    const frameTimes: number[] = [];
    let lastTime = performance.now();
    
    // Measure 120 frames (2 seconds)
    for (let i = 0; i < 120; i++) {
      deck.redraw();
      
      const now = performance.now();
      frameTimes.push(now - lastTime);
      lastTime = now;
      
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    
    const avgFrameTime = frameTimes.reduce((a, b) => a + b) / frameTimes.length;
    const fps = 1000 / avgFrameTime;
    
    expect(fps).toBeGreaterThan(55);
  });
});
```

### Running TypeScript Benchmarks

```bash
# Run all tests including performance tests
npm test

# Run only performance tests
npm test -- performance.test.ts

# Run with coverage
npm run test:coverage

# Run in watch mode
npm test -- --watch
```

## Real-World Scenario Testing

### 1. COVID-19 Case Animation

**Dataset**: 1M records, 365 days, 3K regions

**Metrics**:
- Initial load time
- Frame transition time
- Memory usage
- Cache hit rate

### 2. Vehicle Fleet Tracking

**Dataset**: 10K vehicles, 1 month, 1-second intervals

**Metrics**:
- Tile generation time
- Archive size vs raw GeoJSON
- Playback smoothness (FPS)
- Network bandwidth usage

### 3. Climate Data Visualization

**Dataset**: Global temperature grid, 50 years, monthly

**Metrics**:
- Spatial aggregation performance
- Temporal interpolation quality
- Heatmap rendering performance

## Continuous Performance Monitoring

### 1. CI/CD Integration

```yaml
# .github/workflows/benchmarks.yml
name: Performance Benchmarks

on:
  push:
    branches: [main]
  pull_request:

jobs:
  rust-bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - name: Run benchmarks
        run: cargo bench --no-fail-fast
      - name: Store results
        uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'cargo'
          output-file-path: target/criterion/results.json
  
  ts-bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm test -- performance.test.ts
      - name: Store results
        uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'vitest'
          output-file-path: test-results.json
```

### 2. Performance Regression Detection

- Track benchmark results over time
- Alert on >10% performance degradation
- Require benchmark approval for PRs that affect core paths

### 3. Profiling Tools

**Rust**:
- `cargo-flamegraph`: CPU profiling
- `heaptrack`: Memory profiling
- `cargo-bloat`: Binary size analysis

**TypeScript**:
- Chrome DevTools Performance tab
- Lighthouse performance audits
- `why-did-you-render`: React performance debugging (if applicable)

## Performance Optimization Checklist

### Rust
- [ ] Use release mode for benchmarks
- [ ] Enable LTO (Link-Time Optimization)
- [ ] Use `cargo-bloat` to identify large dependencies
- [ ] Profile with `perf` on Linux
- [ ] Consider SIMD for coordinate transforms
- [ ] Use `SmallVec` for small, frequent allocations
- [ ] Benchmark before and after optimizations

### TypeScript
- [ ] Use Web Workers for tile decoding
- [ ] Implement request coalescing
- [ ] Use binary search for index lookups
- [ ] Minimize Protocol Buffer allocations
- [ ] Use `OffscreenCanvas` where supported
- [ ] Implement backpressure for tile requests
- [ ] Profile with Chrome DevTools

## Reporting

### Weekly Performance Report

Generated automatically, includes:
- Benchmark trends (week over week)
- Performance regressions
- Memory usage patterns
- Cache efficiency metrics
- Real-world scenario results

### Release Performance Summary

For each release, document:
- Performance vs previous release
- Performance vs design goals
- Known performance limitations
- Optimization opportunities

---

**Last Updated**: October 24, 2025
**Version**: 1.0

