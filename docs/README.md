# Spatiotemporal Tiles Documentation

Welcome to the documentation for Spatiotemporal Tiles (STT), a system for visualizing massive time-variant geospatial datasets.

## Introduction

- [**Concepts**](./intro/concepts.md): Understand the core ideas—Spatiotemporal Tiles, Delta Encoding, and Optimistic Rendering.

## Architecture

- [**System Overview**](./architecture/system-overview.md): High-level look at the Rust generation tools and TypeScript rendering stack.
- [**Data Format**](./architecture/data-format.md): Specification of the `.stt` binary archive and Protocol Buffers schema.

## API Reference

### deck.gl Layers

- [**SpatioTemporalLayer**](./api/spatiotemporal-layer.md): The base class for STT layers.
- [**AnimatedPointLayer**](./api/animated-point-layer.md): A layer for rendering animated points.

### loaders.gl Loaders

- [**STTLoader**](./api/stt-loader.md): Loader for parsing `.stt` tile data.
- [**SpatiotemporalTileset**](./api/spatiotemporal-tileset.md): Manages tile lifecycle and temporal logic.

### CLI Tools

- [**CLI Reference**](./api/cli-reference.md): Documentation for `stt-build`.

## Guides

- [**Data Generation**](./guides/data-generation.md): How to create `.stt` files from CSV or GeoJSON.

## Legacy / Archive

- [**Archive**](./archive/): Old status reports, audit logs, and implementation notes.
