// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

import type { Object3D } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu';

/**
 * Context handed to every layer when it (re)builds geometry from tiles.
 *
 * `timeOrigin` is the single common time base (absolute epoch-ms) ALL layers
 * rebase their per-vertex/per-feature times into. STT tiles each carry their own
 * `timeOffset`; rather than one material per tile (deck's approach), a layer here
 * merges every tile into one buffer and rebases each tile's relative times to
 * `timeOrigin`, so a single shared material + a single `currentTime` uniform
 * (`absolute - timeOrigin`) drives the whole layer. AV spans are seconds, so the
 * rebased f32 times stay exact.
 */
export interface SttLayerContext {
  projection: Projection;
  timeOrigin: number;
}

/**
 * A renderable STT layer: owns one Three {@link Object3D}, (re)builds it from
 * decoded tiles, and advances cheaply per frame via a time uniform.
 */
export interface SttLayer {
  /** Stable id (mostly for debugging / scene introspection). */
  readonly id: string;
  /** The object to add to the scene graph. */
  readonly object: Object3D;
  /**
   * Rebuild GPU buffers from the given decoded tiles. Called when the resident
   * tile set changes (for AV: once, after the eager full-scene load).
   */
  setTiles(tiles: Tile[], ctx: SttLayerContext): void;
  /**
   * Advance to an absolute playhead time (epoch-ms). The layer subtracts its
   * `timeOrigin` and writes the time uniform(s) — no geometry rebuild.
   */
  setTime(absoluteTimeMs: number): void;
  /** Release geometries / materials. */
  dispose(): void;
}

/** Convenience base that holds the common state every layer needs. */
export abstract class BaseSttLayer implements SttLayer {
  abstract readonly id: string;
  abstract readonly object: Object3D;
  protected timeOrigin = 0;

  abstract setTiles(tiles: Tile[], ctx: SttLayerContext): void;
  abstract setTime(absoluteTimeMs: number): void;
  abstract dispose(): void;

  /** Absolute epoch-ms → time relative to the layer's `timeOrigin`. */
  protected relativeTime(absoluteTimeMs: number): number {
    return absoluteTimeMs - this.timeOrigin;
  }
}
