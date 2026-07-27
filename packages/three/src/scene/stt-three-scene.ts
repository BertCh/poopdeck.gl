// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTScene` — the framework-agnostic engine core.
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
} from '../projection/local-enu.js';
import type { STTLayer, STTLayerContext } from '../layers/layer.js';
import { STTTileSource } from './tile-source.js';
import {
  StreamingTileSource,
  type StreamingLayerOptions,
  type StreamingViewport,
} from './streaming-tile-source.js';
import { makeGround, type GroundOptions } from './ground.js';

export interface STTSceneOptions {
  /** lon/lat anchor that maps to the world origin (usually the scene's view centre).
   *  Used to build the default {@link LocalEnuProjection} when `projection` is omitted. */
  anchor: GeoAnchor;
  /**
   * Pluggable projection. Defaults to a {@link LocalEnuProjection} about `anchor`
   * (the AV cockpit frame). Pass a `MercatorProjection` / `GlobeProjection` for the
   * geographic flat-map / globe scenes.
   */
  projection?: Projection;
  /** Common time base (epoch-ms) every layer rebases to — usually `timeRange.start`. */
  timeOrigin: number;
  /** Ground options, or `false` for no ground. */
  ground?: GroundOptions | false;
  /** Custom fetch for archive requests (base rewrite / auth). */
  fetch?: typeof fetch;
  /**
   * Scene-level streaming default applied to every {@link STTScene.addLayer} that
   * doesn't override it. `true` streams all layers with the archive defaults; an
   * options object streams with those tileset knobs. Omit / `false` (the default)
   * keeps the backward-compatible EAGER load-everything path
   * ({@link STTTileSource}). A per-layer `streaming` option always wins.
   */
  streaming?: boolean | StreamingLayerOptions;
}

/** Per-layer overrides for {@link STTScene.addLayer}. */
export interface AddLayerOptions {
  /**
   * Back this layer with the viewport-driven {@link StreamingTileSource} (real
   * LOD selection + prefetch + eviction) instead of the eager
   * {@link STTTileSource}. `true` streams with the archive defaults; an options
   * object passes tileset knobs; omit to inherit the scene's `streaming` default.
   * `false` forces eager even when the scene defaults to streaming.
   */
  streaming?: boolean | StreamingLayerOptions;
}

interface EagerSceneSource {
  kind: 'eager';
  source: STTTileSource;
  layer: STTLayer;
}
interface StreamingSceneSource {
  kind: 'streaming';
  source: StreamingTileSource;
  layer: STTLayer;
}
type SceneSource = EagerSceneSource | StreamingSceneSource;

export class STTScene {
  /** Add this to the host scene graph. */
  readonly root = new Group();
  readonly projection: Projection;
  readonly timeOrigin: number;

  private readonly fetchFn?: typeof fetch;
  private readonly defaultStreaming?: boolean | StreamingLayerOptions;
  private readonly sources: SceneSource[] = [];
  private readonly layers: STTLayer[] = [];
  private disposed = false;

  constructor(opts: STTSceneOptions) {
    this.projection = opts.projection ?? new LocalEnuProjection(opts.anchor);
    this.timeOrigin = opts.timeOrigin;
    this.fetchFn = opts.fetch;
    this.defaultStreaming = opts.streaming;
    this.root.name = 'stt-scene';
    if (opts.ground !== false) {
      this.root.add(makeGround(opts.ground ?? {}));
    }
  }

  /** The rebuild context every layer receives from `setTiles`. */
  private layerContext(): STTLayerContext {
    return { projection: this.projection, timeOrigin: this.timeOrigin };
  }

  /**
   * Register a layer whose geometry comes from an archive at `url`. Eager
   * (load-everything) by default; pass `{ streaming: true }` (or a
   * {@link StreamingLayerOptions} object) — or set the scene-level `streaming`
   * default — to back it with the viewport-driven {@link StreamingTileSource}
   * instead. Streaming layers are fed by {@link updateStreaming} + a live
   * `onTilesChanged` re-publish rather than the one-shot {@link load}.
   */
  addLayer(layer: STTLayer, url: string, opts: AddLayerOptions = {}): this {
    this.layers.push(layer);
    this.root.add(layer.object);
    const streaming = opts.streaming ?? this.defaultStreaming;
    if (streaming) {
      const streamOpts = streaming === true ? {} : streaming;
      const source = new StreamingTileSource({
        url,
        fetch: this.fetchFn,
        ...streamOpts,
      });
      // Replace-all rebuild on every real residency change (initial select +
      // async tile arrivals via the source's internal onTileLoad re-publish).
      source.setOnTilesChanged((tiles) => {
        if (this.disposed) return;
        try {
          layer.setTiles(tiles, this.layerContext());
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[stt-three] streaming layer "${layer.id}" setTiles failed`,
            err,
          );
        }
      });
      this.sources.push({ kind: 'streaming', source, layer });
    } else {
      this.sources.push({
        kind: 'eager',
        source: new STTTileSource({ url, fetch: this.fetchFn }),
        layer,
      });
    }
    return this;
  }

  /** Register a layer that needs no archive (host-fed geometry, e.g. an ego marker). */
  addStaticLayer(layer: STTLayer): this {
    this.layers.push(layer);
    this.root.add(layer.object);
    return this;
  }

  /**
   * Prepare every source. EAGER sources load their whole archive and build the
   * layer immediately. STREAMING sources only build their archive + tileset here
   * (cheap — a metadata fetch); their tiles arrive later, viewport-driven, via
   * {@link updateStreaming} → `onTilesChanged`. Resolves when all are ready.
   */
  async load(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      this.sources.map(async (s) => {
        if (s.kind === 'streaming') {
          await s.source.load();
          return;
        }
        const { tiles } = await s.source.load(signal);
        if (this.disposed) return;
        s.layer.setTiles(tiles, this.layerContext());
      }),
    );
  }

  /**
   * Pump a camera/playback-derived viewport into every streaming source; each
   * fires its layer's `setTiles` when its resident set actually changes. A no-op
   * for a purely-eager scene. Cheap and idempotent — safe to call every frame
   * (the host should still throttle; the underlying tileset also debounces).
   */
  updateStreaming(viewport: StreamingViewport): void {
    for (const s of this.sources) {
      if (s.kind === 'streaming') s.source.update(viewport);
    }
  }

  /**
   * Forward the playback animation state to every streaming source (keeps
   * prefetch alive while gated). A no-op for a purely-eager scene.
   */
  setAnimationState(isAnimating: boolean, speed = 0): void {
    for (const s of this.sources) {
      if (s.kind === 'streaming')
        s.source.setAnimationState(isAnimating, speed);
    }
  }

  /** `true` when at least one layer is backed by a {@link StreamingTileSource}. */
  hasStreamingLayers(): boolean {
    return this.sources.some((s) => s.kind === 'streaming');
  }

  /**
   * The scene's streaming sources — for wiring the real
   * {@link TilesetBufferSource} into the playback governor (honest buffered-bar
   * coverage) and for tests that inject a mock tileset via `attachTileset`.
   */
  getStreamingSources(): readonly StreamingTileSource[] {
    const out: StreamingTileSource[] = [];
    for (const s of this.sources)
      if (s.kind === 'streaming') out.push(s.source);
    return out;
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
  getLayers(): readonly STTLayer[] {
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
