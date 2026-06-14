/**
 * Abstract base for STT MapLibre custom layers.
 *
 * Owns the archive, tileset, currentTime, and the GL-lifecycle plumbing that
 * every geometry-specific subclass shares. Subclasses implement:
 *
 *   - `acceptsGeometry(type)` — return true for the geometry types this layer
 *     renders. The base class filters tiles before calling drawTile().
 *   - `onContextReady(gl)` — allocate the program, attribute locations and any
 *     fixed buffers. Called once per onAdd.
 *   - `onContextLost(gl)` — release everything allocated in onContextReady.
 *   - `drawTile(gl, tile, layer, ctx)` — draw a single layer of a single tile.
 *
 * The abstract class deliberately stays free of any geometry-specific shader
 * code so each subclass can ship its own minimal shader without forking the
 * tile pipeline.
 */

import type {
  CustomLayerInterface,
  Map as MaplibreMap,
  LngLatBounds,
} from 'maplibre-gl';
import {
  STTArchive,
  SpatiotemporalTileset,
  type ArchiveMetadata,
  type BinaryFeatures,
  type BoundingBox,
  type BufferedRunway,
  type Tile,
  type TileId,
  type Layer as STTLayer,
  type GeometryType,
} from '@poopdeck.gl/core';
import { projectPositions } from './lib/projection';

/** RGBA tuple in the 0–1 range used by all STT shader uniforms. */
export type RGBA = [number, number, number, number];

/**
 * RGBA tuple in the 0–255 range used by user-supplied colour palettes (so they
 * read the same as the deck.gl adapter's palettes). Internally these are
 * normalized to [0–1] in shaders via the `normalized: true` flag on the
 * attribute buffer.
 */
export type RGBA8 = [number, number, number, number];

/**
 * Normalize a constant colour to the 0–1 range the shaders expect, accepting
 * EITHER convention:
 * - 0–1 floats (the maplibre adapter's historical `color` convention), or
 * - 0–255 ints (the deck.gl `Color` convention and what `colorPalette` already
 *   uses).
 *
 * The range is auto-detected: if any RGB channel exceeds 1 the tuple is treated
 * as 0–255 and divided by 255. This removes the cross-adapter foot-gun where a
 * deck.gl-style `[255, 128, 0, 255]` ported to maplibre clamped to solid white,
 * and makes a single layer's `color` and `colorPalette` props self-consistent —
 * without breaking existing 0–1 callers.
 */
export function toRgba01(
  c: readonly [number, number, number, number],
): [number, number, number, number] {
  const is255 = c[0] > 1 || c[1] > 1 || c[2] > 1 || c[3] > 1;
  return is255
    ? [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255]
    : [c[0], c[1], c[2], c[3]];
}

export interface STTBaseLayerOptions {
  /** Unique layer id passed to MapLibre. */
  id: string;
  /** URL of the .stt archive. */
  url: string;
  /** Current time in Unix milliseconds. */
  currentTime: number;
  /**
   * Half-window for the time filter, in milliseconds. Features whose
   * [startTime,endTime] overlaps [currentTime - timeWindow/2, currentTime +
   * timeWindow/2] are drawn opaque; everything else is `discard`-ed.
   */
  timeWindow: number;
  /**
   * If true (default), the layer calls `map.triggerRepaint()` after
   * setCurrentTime(). Set to false if you drive the render loop yourself.
   */
  autoRepaint?: boolean;
  /**
   * Soft fade ramp at the *leading* edge of the time window, in milliseconds.
   * Features that have just entered the window ramp alpha 0 → 1 across this
   * many ms. Set 0 for a hard on/off. Defaults to 10% of `timeWindow` when
   * unset (back-compat with the original `softTimeWindow: true` behaviour).
   */
  fadeInDuration?: number;
  /**
   * Soft fade ramp at the *trailing* edge of the time window, in milliseconds.
   * Features about to leave the window ramp alpha 1 → 0 across this many ms.
   * Defaults to 10% of `timeWindow` when unset.
   */
  fadeOutDuration?: number;
  /**
   * Back-compat: when set, controls whether the default fade-in/out durations
   * (10% of `timeWindow`) are applied. Set to `false` for a hard on/off
   * window. Ignored if `fadeInDuration` / `fadeOutDuration` are set
   * explicitly. Older code that only knew about `softTimeWindow` keeps
   * working.
   */
  softTimeWindow?: boolean;
  /**
   * Override the maximum concurrent tile requests against the archive.
   * Defaults to the tileset's own default (24).
   */
  maxRequests?: number;
  /**
   * Override prefetch behaviour. Defaults follow the SpatiotemporalTileset
   * defaults (30s lookahead, 4 steps).
   */
  enablePrefetch?: boolean;
  prefetchAhead?: number;
  prefetchSteps?: number;
  /**
   * Called once per archive init with the live tileset, after metadata has
   * resolved. The tileset implements the BufferSource readiness contract
   * (runway / cost / ETA queries), which is what a PlaybackGovernor consumes.
   */
  onTilesetReady?: (tileset: SpatiotemporalTileset) => void;
  /**
   * Buffered-runway threshold events from the tileset's coverage index,
   * forwarded as-is. Route them into a PlaybackGovernor or a buffered-bar UI.
   */
  onBufferChange?: (runway: BufferedRunway) => void;
}

/** Per-tile cached GPU buffers. Created lazily on first draw. */
export interface TileGpuCache {
  /** Mercator unit-square positions, stride-3 Float32. */
  positionBuffer: WebGLBuffer;
  /** Interleaved [startTime, endTime] per feature, relative to timeOffset. */
  timeBuffer: WebGLBuffer;
  /** Optional per-vertex element indices (lines / polygons). */
  indexBuffer?: WebGLBuffer;
  /** Number of vertices in `positionBuffer`. */
  vertexCount: number;
  /** Number of indices in `indexBuffer` (0 if unindexed). */
  indexCount: number;
  /** This tile's timeOffset, so the shader can compare relative times. */
  timeOffset: number;
  /**
   * Additional WebGL buffers the subclass owns (e.g. line neighbor / side
   * attributes). The base class deletes them alongside `positionBuffer` etc
   * when the tile is unloaded.
   */
  extraBuffers?: WebGLBuffer[];
  /**
   * Cached vertex-array-object. Set by subclasses inside drawTile on the first
   * draw and reused on every subsequent frame — replaces ~5–7 buffer-binds +
   * enableVertexAttribArray calls per tile per frame with a single
   * `bindVertexArray(vao)`. Cleared automatically with the tile.
   * A separate VAO may exist per logical sub-pass (e.g. polygon fill vs. stroke).
   */
  vao?: WebGLVertexArrayObject | null;
  /** Secondary VAO for layers that emit more than one pass per tile (e.g. polygon stroke). */
  strokeVao?: WebGLVertexArrayObject | null;
}

/** Context passed to drawTile() with everything the subclass needs. */
export interface DrawContext {
  /** MapLibre's projection matrix (clip-space transform from mercator). */
  matrix: Float32Array;
  /** Window bounds in *relative* time, already offset for this tile. */
  windowStart: number;
  windowEnd: number;
  /** Current absolute time, for shaders that need it directly. */
  currentTime: number;
  /** Map zoom rounded down to integer (matches the tileset's zoom math). */
  zoom: number;
}

const tileKey = (id: TileId) => `${id.z}/${id.x}/${id.y}/${id.t}`;

export abstract class STTBaseLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode: '2d' | '3d' = '2d';

  protected map?: MaplibreMap;
  protected gl?: WebGLRenderingContext | WebGL2RenderingContext;
  protected archive: STTArchive;
  protected metadata?: ArchiveMetadata;
  protected tileset?: SpatiotemporalTileset;
  protected loadedTiles = new Map<string, Tile>();
  protected tileGpuCache = new Map<string, TileGpuCache | null>();
  protected opts: STTBaseLayerOptions & { autoRepaint: boolean };
  protected supports32BitIndices = false;
  /**
   * VAO support detection. WebGL2 has VAOs in core; WebGL1 exposes them via
   * `OES_vertex_array_object`. When unavailable, subclasses fall back to
   * rebinding attributes per draw (the legacy path) — still correct, just
   * 5–7× more API calls per tile.
   */
  protected vaoSupport: {
    enabled: boolean;
    create: () => WebGLVertexArrayObject | null;
    bind: (vao: WebGLVertexArrayObject | null) => void;
    delete: (vao: WebGLVertexArrayObject) => void;
  } = {
    enabled: false,
    create: () => null,
    bind: () => undefined,
    delete: () => undefined,
  };
  /**
   * Instanced-draw support detection. WebGL2 has `drawArraysInstanced` /
   * `drawElementsInstanced` / `vertexAttribDivisor` in core; WebGL1 exposes
   * them through `ANGLE_instanced_arrays`. When unavailable, layers that rely
   * on instancing (lines, trips, polygon stroke) will be dropped — the
   * fallback non-instanced path is gone now that instancing is widely
   * available (everywhere except old IE/Edge, both EOL).
   */
  protected instSupport: {
    enabled: boolean;
    drawArraysInstanced: (mode: number, first: number, count: number, primCount: number) => void;
    drawElementsInstanced: (mode: number, count: number, type: number, offset: number, primCount: number) => void;
    vertexAttribDivisor: (index: number, divisor: number) => void;
  } = {
    enabled: false,
    drawArraysInstanced: () => undefined,
    drawElementsInstanced: () => undefined,
    vertexAttribDivisor: () => undefined,
  };
  /**
   * A 4-vertex unit quad shared by every instanced layer in this layer
   * instance. Vertices are (sideA: -1|+1, along: 0|1) where `sideA` picks the
   * perpendicular offset direction and `along` picks the A or B endpoint of
   * the segment.
   *
   * Lazily uploaded the first time a subclass asks for it via `getUnitQuad()`.
   */
  protected unitQuadBuffer?: WebGLBuffer;

  constructor(opts: STTBaseLayerOptions) {
    this.id = opts.id;
    this.opts = { autoRepaint: true, ...opts };
    // `maxRequests` is the single concurrency knob: thread it into the
    // archive's range coalescer so it bounds actual in-flight fetches.
    // Undefined falls through to the archive's default (24).
    this.archive = new STTArchive({
      url: opts.url,
      maxConcurrentRequests: opts.maxRequests,
    });
  }

  /**
   * Update the time the next frame's filter compares against. Triggers a
   * repaint unless `autoRepaint: false` was passed.
   */
  setCurrentTime(t: number): void {
    this.opts.currentTime = t;
    if (this.opts.autoRepaint && this.map) {
      this.map.triggerRepaint();
    }
  }

  /** Replace the time window (in ms). */
  setTimeWindow(ms: number): void {
    this.opts.timeWindow = ms;
    if (this.opts.autoRepaint && this.map) {
      this.map.triggerRepaint();
    }
  }

  /** Promise that resolves once the archive's metadata has been read. */
  ready(): Promise<ArchiveMetadata> {
    return this.archive.getMetadata();
  }

  /**
   * The live tileset, or `undefined` before `initTileset` resolves the
   * archive metadata (subscribe via `onTilesetReady` to avoid polling). The
   * tileset implements the BufferSource readiness contract (runway / cost /
   * ETA queries), which is what a PlaybackGovernor attaches to.
   */
  getTileset(): SpatiotemporalTileset | undefined {
    return this.tileset;
  }

  // ------------------------------------------------------------------------
  // MapLibre lifecycle
  // ------------------------------------------------------------------------

  onAdd(
    map: MaplibreMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    this.map = map;
    this.gl = gl;
    // 32-bit element indices are required for tiles with > 65k vertices after
    // line/polygon expansion. WebGL2 supports them natively; on WebGL1 we
    // probe the extension. Subclasses that index >65k vertices must check
    // `this.supports32BitIndices` and fall back to multiple draws if false.
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      this.supports32BitIndices = true;
    } else {
      this.supports32BitIndices = !!gl.getExtension('OES_element_index_uint');
    }
    this.initVaoSupport(gl);
    this.initInstanceSupport(gl);
    this.onContextReady(gl);
    void this.initTileset();
  }

  /**
   * Resolve VAO entry points. WebGL2 has them in core under the unprefixed
   * names; WebGL1 must go through `OES_vertex_array_object` (the extension
   * lookup also covers the test mock, which exposes the WebGL2 names directly).
   * We capture function refs once so the per-draw fast path doesn't pay the
   * cost of `instanceof` / extension probing on every tile.
   */
  private initVaoSupport(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const gl2 = gl as WebGL2RenderingContext;
    if (typeof gl2.createVertexArray === 'function') {
      this.vaoSupport = {
        enabled: true,
        create: () => gl2.createVertexArray(),
        bind: (vao) => gl2.bindVertexArray(vao),
        delete: (vao) => gl2.deleteVertexArray(vao),
      };
      return;
    }
    const ext = gl.getExtension('OES_vertex_array_object') as {
      createVertexArrayOES: () => WebGLVertexArrayObject | null;
      bindVertexArrayOES: (vao: WebGLVertexArrayObject | null) => void;
      deleteVertexArrayOES: (vao: WebGLVertexArrayObject) => void;
    } | null;
    if (ext) {
      this.vaoSupport = {
        enabled: true,
        create: () => ext.createVertexArrayOES(),
        bind: (vao) => ext.bindVertexArrayOES(vao),
        delete: (vao) => ext.deleteVertexArrayOES(vao),
      };
    }
  }

  /**
   * Resolve instanced-draw entry points. WebGL2 has them in core; WebGL1 must
   * pull them off `ANGLE_instanced_arrays`. The line / trips / polygon-stroke
   * sub-layers rely on instancing for their quad expansion; everywhere
   * instancing is missing they bail out at tile-cache-build time with a
   * console warning and the tile is skipped.
   */
  private initInstanceSupport(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const gl2 = gl as WebGL2RenderingContext;
    if (typeof gl2.drawArraysInstanced === 'function') {
      this.instSupport = {
        enabled: true,
        drawArraysInstanced: (mode, first, count, primCount) =>
          gl2.drawArraysInstanced(mode, first, count, primCount),
        drawElementsInstanced: (mode, count, type, offset, primCount) =>
          gl2.drawElementsInstanced(mode, count, type, offset, primCount),
        vertexAttribDivisor: (index, divisor) =>
          gl2.vertexAttribDivisor(index, divisor),
      };
      return;
    }
    const ext = gl.getExtension('ANGLE_instanced_arrays') as {
      drawArraysInstancedANGLE: (mode: number, first: number, count: number, primCount: number) => void;
      drawElementsInstancedANGLE: (mode: number, count: number, type: number, offset: number, primCount: number) => void;
      vertexAttribDivisorANGLE: (index: number, divisor: number) => void;
    } | null;
    if (ext) {
      this.instSupport = {
        enabled: true,
        drawArraysInstanced: (mode, first, count, primCount) =>
          ext.drawArraysInstancedANGLE(mode, first, count, primCount),
        drawElementsInstanced: (mode, count, type, offset, primCount) =>
          ext.drawElementsInstancedANGLE(mode, count, type, offset, primCount),
        vertexAttribDivisor: (index, divisor) =>
          ext.vertexAttribDivisorANGLE(index, divisor),
      };
    }
  }

  /**
   * Build (lazily) and return the shared 4-vertex unit quad VBO used by every
   * instanced renderer. Vertex layout per vertex is `vec2(side, along)`:
   *   v0 = (-1, 0)  — A end, left
   *   v1 = ( 1, 0)  — A end, right
   *   v2 = (-1, 1)  — B end, left
   *   v3 = ( 1, 1)  — B end, right
   * Drawn as `TRIANGLE_STRIP`, 4 vertices per instance.
   */
  protected getUnitQuad(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): WebGLBuffer {
    if (this.unitQuadBuffer) return this.unitQuadBuffer;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, 0,
        1, 0,
        -1, 1,
        1, 1,
      ]),
      gl.STATIC_DRAW,
    );
    this.unitQuadBuffer = buf;
    return buf;
  }

  onRemove(): void {
    const gl = this.gl;
    if (gl) {
      for (const cache of this.tileGpuCache.values()) {
        if (cache) this.deleteCacheBuffers(gl, cache);
      }
      if (this.unitQuadBuffer) {
        gl.deleteBuffer(this.unitQuadBuffer);
        this.unitQuadBuffer = undefined;
      }
      this.onContextLost(gl);
    }
    this.tileGpuCache.clear();
    this.loadedTiles.clear();
    this.tileset?.finalize();
    this.archive.finalize();
  }

  private deleteCacheBuffers(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    cache: TileGpuCache,
  ): void {
    gl.deleteBuffer(cache.positionBuffer);
    gl.deleteBuffer(cache.timeBuffer);
    if (cache.indexBuffer) gl.deleteBuffer(cache.indexBuffer);
    if (cache.extraBuffers) {
      for (const b of cache.extraBuffers) gl.deleteBuffer(b);
    }
    if (cache.vao) this.vaoSupport.delete(cache.vao);
    if (cache.strokeVao) this.vaoSupport.delete(cache.strokeVao);
  }

  // This positional-matrix signature is v3/v4-only: MapLibre v5 REPLACED it
  // with a single CustomRenderMethodInput-style args object (and changed the
  // mercator matrix semantics — maplibre/maplibre-gl-js#3854), so a v5 host
  // would pass the args object where v3/v4 pass the matrix. The peerDep is
  // pinned to `^3 || ^4` accordingly. A v5 port means accepting the args
  // object, injecting `args.shaderData.vertexShaderPrelude` into each vertex
  // shader and projecting via `projectTile()` instead of multiplying
  // `uMatrix` by mercator-unit-square positions (that prelude path is also
  // what unlocks globe). Until then, v5 users should stay on v4 for STT.
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrix: Iterable<number>,
  ): void {
    if (!this.tileset || !this.map) return;

    const map = this.map;
    const m =
      matrix instanceof Float32Array
        ? matrix
        : new Float32Array(Array.from(matrix));

    const bounds = map.getBounds();
    const zoom = Math.floor(map.getZoom());
    const currentTime = this.opts.currentTime;

    this.tileset.update({
      bounds: toBoundsArray(bounds),
      zoom,
      time: currentTime,
      timeWindow: this.opts.timeWindow,
    });

    // Configure shared GL state. Subclasses may override per-draw if needed.
    this.applySharedGlState(gl);

    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.ensureTileGpuCache(gl, tile, layer);
        if (!cache) continue;
        const ctx: DrawContext = {
          matrix: m,
          currentTime,
          zoom,
          windowStart:
            currentTime - cache.timeOffset - this.opts.timeWindow / 2,
          windowEnd:
            currentTime - cache.timeOffset + this.opts.timeWindow / 2,
        };
        this.drawTile(gl, tile, layer, cache, ctx);
      }
    }
    // Unbind so unrelated GL consumers (basemap, other custom layers) start
    // from a clean attribute slate.
    this.unbindVao();
  }

  // ------------------------------------------------------------------------
  // Subclass hooks
  // ------------------------------------------------------------------------

  /** Geometry types this layer will draw. */
  protected abstract acceptsGeometry(type: GeometryType): boolean;

  /** Allocate program + uniforms. Called from onAdd. */
  protected abstract onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void;

  /** Release program + uniforms. Called from onRemove. */
  protected abstract onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void;

  /** Draw a single layer of a single tile. */
  protected abstract drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void;

  /**
   * Build the per-tile cache. Subclasses that need geometry-specific buffers
   * (e.g. polygon indices) override this; the default produces just positions
   * + per-feature times.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): TileGpuCache | null {
    const f = layer.features;
    if (!f.positions?.length) return null;

    const dims: 2 | 3 = f.positionDimensions === 3 ? 3 : 2;
    const positions = this.projectAndUpload(gl, f.positions, dims);
    const times = this.uploadFeatureTimes(gl, f.startTimes, f.endTimes);

    const vertexCount = f.positions.length / dims;
    return {
      positionBuffer: positions,
      timeBuffer: times,
      vertexCount,
      indexCount: 0,
      timeOffset: f.timeOffset,
    };
  }

  // ------------------------------------------------------------------------
  // Helpers for subclasses
  // ------------------------------------------------------------------------

  /**
   * Bind (or lazily build) a VAO for the given cache slot. On the first call
   * the `setup` callback runs inside a VAO recording scope so all
   * `bindBuffer(ARRAY_BUFFER, ...)` / `vertexAttribPointer` / element-buffer
   * binds are captured. On every subsequent call we just `bindVertexArray(vao)`
   * and skip the setup.
   *
   * When VAOs aren't available (very old WebGL1 without OES_vertex_array_object)
   * we still run `setup` every draw — correctness preserved, perf falls back to
   * the legacy path.
   *
   * The `slot` parameter selects which VAO slot on the cache to use. Subclasses
   * with two passes per tile (polygon fill + stroke, heatmap accumulate) can
   * use 'main' and 'stroke' independently.
   */
  protected bindVaoOrSetup(
    cache: TileGpuCache,
    setup: () => void,
    slot: 'main' | 'stroke' = 'main',
  ): void {
    if (!this.vaoSupport.enabled) {
      setup();
      return;
    }
    const existing = slot === 'main' ? cache.vao : cache.strokeVao;
    if (existing) {
      this.vaoSupport.bind(existing);
      return;
    }
    const vao = this.vaoSupport.create();
    if (!vao) {
      setup();
      return;
    }
    this.vaoSupport.bind(vao);
    setup();
    if (slot === 'main') cache.vao = vao;
    else cache.strokeVao = vao;
  }

  /**
   * Unbind any VAO that may be currently active. Call once at the end of a
   * frame so subsequent non-STT MapLibre passes don't inherit our attribute
   * bindings.
   */
  protected unbindVao(): void {
    if (this.vaoSupport.enabled) this.vaoSupport.bind(null);
  }

  /** GL state shared across all STT layers. Subclasses can extend in drawTile. */
  protected applySharedGlState(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // MapLibre's custom layer pipeline shares the depth buffer with the
    // basemap. Disabling depth-test keeps STT features always-on-top and
    // avoids z-fighting against raster tiles.
    gl.disable(gl.DEPTH_TEST);
  }

  /** Project lon/lat → mercator and upload to a fresh ARRAY_BUFFER. */
  protected projectAndUpload(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    positions: Float64Array | Float32Array,
    dimensions: 2 | 3,
  ): WebGLBuffer {
    const projected = projectPositions(positions, dimensions);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, projected, gl.STATIC_DRAW);
    return buf;
  }

  /**
   * Drop every per-tile GPU cache so the next frame rebuilds them from the
   * still-loaded tiles. Geometry-affecting option setters (polygon stroked /
   * extruded) call this — the cached vertex/index buffers bake those options
   * in at build time, so flipping them without a rebuild keeps drawing the
   * stale geometry.
   */
  protected rebuildTileCaches(): void {
    const gl = this.gl;
    for (const cache of this.tileGpuCache.values()) {
      if (cache && gl) this.deleteCacheBuffers(gl, cache);
    }
    this.tileGpuCache.clear();
    this.map?.triggerRepaint();
  }

  /**
   * Interleave per-feature [startTime, endTime] into a stride-2 Float32 buffer
   * and upload. Values stay relative to the tile's `timeOffset` — the shader
   * compares against `uWindowStart`/`uWindowEnd` which are already offset.
   */
  protected uploadFeatureTimes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    startTimes: Float32Array,
    endTimes: Float32Array,
  ): WebGLBuffer {
    const n = startTimes.length;
    const times = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      times[i * 2] = startTimes[i];
      times[i * 2 + 1] = endTimes[i];
    }
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, times, gl.STATIC_DRAW);
    return buf;
  }

  /**
   * Resolve the per-feature fade-in / fade-out durations from layer options,
   * honouring the legacy `softTimeWindow` flag. The window-mode shader fragments
   * compare against these directly (see `fadeShaderSnippet`).
   *
   * Returns ms (0 = hard cutoff at that edge).
   */
  protected resolveFadeDurations(): { fadeIn: number; fadeOut: number } {
    const o = this.opts;
    const haveExplicit =
      o.fadeInDuration !== undefined || o.fadeOutDuration !== undefined;
    if (haveExplicit) {
      return {
        fadeIn: Math.max(0, o.fadeInDuration ?? 0),
        fadeOut: Math.max(0, o.fadeOutDuration ?? 0),
      };
    }
    // Default to 10% of the window unless softTimeWindow is explicitly false.
    const softOn = o.softTimeWindow !== false;
    const half = Math.max(1, o.timeWindow * 0.1);
    return softOn ? { fadeIn: half, fadeOut: half } : { fadeIn: 0, fadeOut: 0 };
  }

  /**
   * Expand a categorical `binary` property to a flat per-feature RGBA8 buffer
   * (Uint8Array, normalized=true on GPU). Returns null if the property is
   * missing from the binary features.
   */
  protected expandCategoricalColors(
    binary: BinaryFeatures,
    propertyName: string,
    palette: ReadonlyArray<RGBA8>,
  ): Uint8Array | null {
    const cat = binary.categoricalProps[propertyName];
    if (!cat || palette.length === 0) return null;
    const n = binary.featureCount;
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const idx = cat.indices[i] % palette.length;
      const c = palette[idx];
      out[i * 4] = c[0];
      out[i * 4 + 1] = c[1];
      out[i * 4 + 2] = c[2];
      out[i * 4 + 3] = c[3] ?? 255;
    }
    return out;
  }

  /**
   * Pull a numeric per-feature property as a Float32Array view. Returns null
   * if the property is missing.
   */
  protected getNumericProperty(
    binary: BinaryFeatures,
    propertyName: string,
  ): Float32Array | null {
    const v = binary.numericProps[propertyName];
    return v ?? null;
  }

  /** Upload an arbitrary typed array to a fresh ARRAY_BUFFER. */
  protected uploadArrayBuffer(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    data: ArrayBufferView,
  ): WebGLBuffer {
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  /** Compile and link a GLSL ES 1.00 shader program (WebGL1-compatible). */
  protected linkProgram(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    vsSource: string,
    fsSource: string,
  ): WebGLProgram {
    const compile = (type: number, source: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`STT shader compile failed: ${log}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`STT shader link failed: ${log}`);
    }
    // Shaders can be deleted once attached + linked.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  private async initTileset(): Promise<void> {
    try {
      const metadata = await this.archive.getMetadata();
      this.metadata = metadata;
    } catch (err) {
      console.error(`[${this.id}] failed to read archive metadata:`, err);
      return;
    }

    if (!this.map) return; // onRemove ran before we got here.

    this.tileset = new SpatiotemporalTileset({
      maxRequests: this.opts.maxRequests,
      minZoom: this.metadata.minZoom,
      maxZoom: this.metadata.maxZoom,
      temporalBucketMs: this.metadata.temporalBucketMs,
      refinementStrategy: 'best-available', // Load parent tiles as fallback (deck.gl parity)
      enablePrefetch: this.opts.enablePrefetch,
      prefetchAhead: this.opts.prefetchAhead,
      prefetchSteps: this.opts.prefetchSteps,
      getAvailableTiles: (bounds, zoom, timeRange) =>
        this.archive.getTileIdsInBounds(bounds, zoom, timeRange),
      getTileData: (id, signal) => this.archive.getTile(id, { signal }),
      // Route the bulk viewport/prefetch fill through the range coalescer so
      // a viewport-full of Hilbert-adjacent tiles collapses into a handful of
      // HTTP Range requests instead of one request per tile. The hooks carry
      // incremental per-tile delivery (tiles render as their range group
      // lands) and the fetch-priority hint for lookahead tiers.
      getTileDataBatch: (tileIds, signal, hooks) =>
        this.archive.getTiles(tileIds, {
          signal,
          onTileReady: hooks?.onTileReady,
          fetchPriority: hooks?.fetchPriority,
        }),
      // Lets the tileset skip giant low-zoom parent-fallback tiles (e.g. a
      // 14 MB z10 tile under a z14 view) before fetching them. Sync directory
      // lookup, no I/O.
      getTileByteSize: (tileId) => this.archive.getTileByteSize(tileId),
      // Buffered-runway threshold events from the tileset's coverage index,
      // forwarded to the app (which routes them into a PlaybackGovernor).
      onBufferChange: (runway) => {
        this.opts.onBufferChange?.(runway);
      },
      // Wire the archive's coalesced-range throughput EWMA into the tileset
      // so estimateTimeToReadyMs() can compute honest ETAs.
      getThroughput: () => this.archive.getThroughputEstimate(),
      onTileLoad: (tile) => {
        this.loadedTiles.set(tileKey(tile.id), tile);
        this.map?.triggerRepaint();
      },
      onTileUnload: (tile) => {
        const baseKey = tileKey(tile.id);
        this.loadedTiles.delete(baseKey);
        // GPU cache entries are keyed per layer within a tile, so we sweep
        // all entries whose key starts with this tile's prefix.
        const prefix = `${baseKey}::`;
        for (const [k, cache] of this.tileGpuCache) {
          if (!k.startsWith(prefix)) continue;
          if (cache && this.gl) this.deleteCacheBuffers(this.gl, cache);
          this.tileGpuCache.delete(k);
        }
      },
    });

    // Hand the live tileset to the app exactly once per init. The tileset
    // implements the BufferSource readiness contract (runway / cost / ETA
    // queries), which is what a PlaybackGovernor consumes.
    this.opts.onTilesetReady?.(this.tileset);

    this.map.triggerRepaint();
  }

  protected ensureTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): TileGpuCache | null {
    const key = `${tileKey(tile.id)}::${layer.name}::${layer.features.geometryType}`;
    const existing = this.tileGpuCache.get(key);
    if (existing !== undefined) return existing;
    const cache = this.buildTileGpuCache(gl, tile, layer);
    this.tileGpuCache.set(key, cache);
    return cache;
  }
}

function toBoundsArray(b: LngLatBounds): BoundingBox {
  return {
    minLon: b.getWest(),
    minLat: b.getSouth(),
    maxLon: b.getEast(),
    maxLat: b.getNorth(),
  };
}
