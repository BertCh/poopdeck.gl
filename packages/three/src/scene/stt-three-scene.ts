// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `SttScene` — the framework-agnostic engine core.
 *
 * It owns a single Three {@link Group} (`root`) holding the ground + each layer's
 * object, a {@link Projection} (the local ENU frame), and the per-source tile
 * loaders. It does NOT own a renderer, camera, controls, or render loop — those
 * belong to the host (the r3f `<Canvas>` binding, or an imperative mount). The
 * host adds `root` to its scene, calls {@link load} once, then {@link setTime}
 * every frame.
 *
 * Layer construction (which streams → which layers, with which columns/colours)
 * is the caller's job; for the AV cockpit that wiring lives in the showcase
 * `AvThreeViewer` via the layer factories in `../layers`.
 */

import { Group, Box3 } from 'three';
import {
  LocalEnuProjection,
  type GeoAnchor,
  type Projection,
} from '../projection/local-enu';
import type { SttLayer } from '../layers/layer';
import { SttTileSource } from './tile-source';
import { makeGround, type GroundOptions } from './ground';

export interface SttSceneOptions {
  /** lon/lat anchor that maps to the world origin (usually the scene's view centre). */
  anchor: GeoAnchor;
  /** Common time base (epoch-ms) every layer rebases to — usually `timeRange.start`. */
  timeOrigin: number;
  /** Ground options, or `false` for no ground. */
  ground?: GroundOptions | false;
  /** Custom fetch for archive requests (base rewrite / auth). */
  fetch?: typeof fetch;
}

interface SceneSource {
  source: SttTileSource;
  layer: SttLayer;
}

export class SttScene {
  /** Add this to the host scene graph. */
  readonly root = new Group();
  readonly projection: Projection;
  readonly timeOrigin: number;

  private readonly fetchFn?: typeof fetch;
  private readonly sources: SceneSource[] = [];
  private readonly layers: SttLayer[] = [];
  private disposed = false;

  constructor(opts: SttSceneOptions) {
    this.projection = new LocalEnuProjection(opts.anchor);
    this.timeOrigin = opts.timeOrigin;
    this.fetchFn = opts.fetch;
    this.root.name = 'stt-scene';
    if (opts.ground !== false) {
      this.root.add(makeGround(opts.ground ?? {}));
    }
  }

  /** Register a layer whose geometry comes from an archive at `url`. */
  addLayer(layer: SttLayer, url: string): this {
    this.layers.push(layer);
    this.root.add(layer.object);
    this.sources.push({
      source: new SttTileSource({ url, fetch: this.fetchFn }),
      layer,
    });
    return this;
  }

  /** Register a layer that needs no archive (host-fed geometry, e.g. an ego marker). */
  addStaticLayer(layer: SttLayer): this {
    this.layers.push(layer);
    this.root.add(layer.object);
    return this;
  }

  /** Eagerly load every source and build its layer. Resolves when all are resident. */
  async load(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      this.sources.map(async ({ source, layer }) => {
        const { tiles } = await source.load(signal);
        if (this.disposed) return;
        layer.setTiles(tiles, {
          projection: this.projection,
          timeOrigin: this.timeOrigin,
        });
      }),
    );
  }

  /** Advance the playhead (absolute epoch-ms). Cheap — uniform writes only.
   * Each layer is isolated: a throw in one must not abort the frame (and the
   * render after it) for the others. */
  setTime(absoluteTimeMs: number): void {
    for (const l of this.layers) {
      try {
        l.setTime(absoluteTimeMs);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[stt-three] layer "${l.id}" setTime failed`, err);
      }
    }
  }

  /** World-space bounds of all layer geometry (for camera framing). */
  computeBounds(): Box3 {
    const box = new Box3().makeEmpty();
    for (const l of this.layers) box.expandByObject(l.object);
    return box;
  }

  /** The registered layers (read-only view for introspection). */
  getLayers(): readonly SttLayer[] {
    return this.layers;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const l of this.layers) l.dispose();
    for (const s of this.sources) s.source.dispose();
    this.layers.length = 0;
    this.sources.length = 0;
    this.root.clear();
  }
}
