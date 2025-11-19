# SpatioTemporal Tiles (STT)

> **High-performance tile format for interactive spatiotemporal data visualization**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.4+-blue.svg)](https://www.typescriptlang.org/)

---

## What is STT?

STT is a single-file archive format for spatiotemporal data visualization that combines efficient spatial tiling with native temporal indexing for smooth 60 FPS animations in the browser.

### Key Features

- ⚡ **60 FPS animation** - Sub-16ms frame switching with predictive prefetching
- 📦 **Single-file archives** - Deploy to CDN, no tile server needed
- 🗜️ **Efficient compression** - Gzip with MVT-compatible encoding
- 🔄 **Delta encoding** - Optional feature deduplication across temporal frames
- 🎯 **Smart indexing** - Hilbert curve (spatial) + interval tree (temporal)
- 🌐 **HTTP Range Requests** - Stream tiles on-demand
- 🔧 **Modern stack** - Rust (`geo`, `chrono`) + TypeScript (deck.gl)

---

## Quick Start

### 1. Install CLI

```bash
git clone https://github.com/robertchristie/spatiotemporal-tiles.git
cd spatiotemporal-tiles
cargo build --release
```

### 2. Build STT Archive

**From GeoJSON:**

```bash
./target/release/stt-build \
  --input data.geojson \
  --output tiles.stt \
  --time-field timestamp \
  --time-format iso8601 \
  --temporal-resolution sparse-events \
  --compression gzip \
  --delta-encoding
```

### 3. Visualize with deck.gl

```typescript
import { AnimatedPointLayer, TimeController } from "@stt/deck.gl";

const layer = new AnimatedPointLayer({
  id: "earthquakes",
  data: "/data/earthquakes.stt",
  currentTime: Date.now(),
});
```

For more details, see the **[Documentation](./docs/README.md)**.

---

## Documentation

Full documentation is available in the [`docs/`](./docs/) directory:

- **[Concepts](./docs/intro/concepts.md)** - Learn about STT, Delta Encoding, and Bucketing.
- **[System Overview](./docs/architecture/system-overview.md)** - Architecture and Design.
- **[CLI Reference](./docs/api/cli-reference.md)** - `stt-build` command options.
- **[Data Generation Guide](./docs/guides/data-generation.md)** - How to create your own archives.

---

## Architecture

### File Format

```
┌─────────────────┐
│ Header (53B)    │  Magic: "STT\x01", index/metadata offsets
├─────────────────┤
│ Tile Data       │  Compressed Protocol Buffers (MVT-compatible)
├─────────────────┤
│ Index           │  Hilbert spatial index + temporal ranges
├─────────────────┤
│ Metadata        │  Bounds, time range, zoom levels, stats
└─────────────────┘
```

See **[Data Format Specification](./docs/architecture/data-format.md)** for details.

---

## Repository Structure

```
spatiotemporal-tiles/
├── crates/                    # Rust Backend
│   ├── stt-core/             # Archive format & lib
│   └── stt-build/            # CLI tool
│
├── packages/                  # TypeScript Frontend
│   ├── core/                 # Archive reader
│   └── deck.gl/              # deck.gl layers
│
├── proto/                     # Protocol Buffer definitions
└── examples/
    └── showcase/             # Interactive demo app
```

---

## Roadmap

### ✅ Phase 1: Core (Complete)
- Archive format, CLI, deck.gl layers, showcase app
- Gzip/Brotli compression
- HTTP Range Requests

### ✅ Phase 2: Optimization (Complete)
- Delta encoding support
- Temporal bucketing profiles
- Frontend feature caching

### 📋 Phase 3: Advanced (In Progress)
- [ ] Web Worker tile decoding
- [ ] Parquet/Arrow file reading
- [ ] 3D Tile integration

---

## License

MIT © 2025 Robert Christie
