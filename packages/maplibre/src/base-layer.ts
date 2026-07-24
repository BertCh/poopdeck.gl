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
 *
 * Host-version dispatch lives in `lib/host-adapter.ts`: `render()` normalizes
 * whichever signature the basemap uses (maplibre ≤v4 positional matrix,
 * v4.6+ camera options, v5/v6 args object, mapbox v3) into a scratch
 * {@link HostFrame} via {@link STTBaseLayer.beginFrame} before any drawing.
 * Lifecycle hardening: {@link STTBaseLayer.attach} installs a styledata guard
 * that survives style diff-fallback rebuilds, and canvas context-loss
 * listeners invalidate every GPU cache so a restored context rebuilds lazily.
 *
 * Tileset ownership comes in two modes (D6a):
 *   - **Per-layer (default, compat).** `{ url }` — the layer owns a private
 *     archive + tileset, exactly the historical behaviour.
 *   - **Shared.** `{ source: SharedTilesetSource }` — N layers over one .stt
 *     register as consumers of ONE archive + ONE tileset (`lib/streaming-source.ts`),
 *     receiving the resident set replace-all and sharing a single governor
 *     `BufferSource`. `onTilesetReady`/`onBufferChange` fire in both modes.
 */

import type {
  CustomLayerInterface,
  Map as MaplibreMap,
  LngLatBounds,
} from 'maplibre-gl';
import {
  STTArchive,
  SpatiotemporalTileset,
  getFeatureProperties,
  type ArchiveMetadata,
  type BinaryFeatures,
  type BoundingBox,
  type BufferedRunway,
  type Tile,
  type TileId,
  type Layer as STTLayer,
  type GeometryType,
} from '@poopdeck.gl/core';
import * as core from '@poopdeck.gl/core/style';
import {
  resolveTimeFilterParams,
  type TimeFilterMode,
} from '@poopdeck.gl/core/time-filter';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';
import {
  encodePickId,
  decodePickId,
  MAX_PICK_ID,
  type SttPickResult,
} from '@poopdeck.gl/core/picking';
import {
  projectPositions,
  quantizePositionsToUint16,
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from './lib/projection.js';
import {
  createHostFrame,
  normalizeRenderArgs,
  DEFAULT_FOV_RADIANS,
  type HostFrame,
} from './lib/host-adapter.js';
import type { SharedTilesetSource } from './lib/streaming-source.js';
import { granularityForZoom } from './lib/globe.js';
import {
  isMapboxHost,
  isValidMapboxSlot,
  type MapboxSlot,
} from './lib/host-slot.js';

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

/**
 * The time-filter modes a maplibre layer can compile. ONE alias for the whole
 * package (every layer's `timeFilterMode` prop resolves to this) so the five
 * kinds cannot drift into five spellings of the same union.
 *
 * Core's fifth mode `'none'` is excluded on purpose: it is "no filtering at
 * all", which here is a `timeWindow` wider than the data, not a shader.
 */
export type STTTimeFilterMode = Exclude<TimeFilterMode, 'none'>;

/**
 * Normalize a `fadeTrail` prop to the shader's continuous 0..1 weight.
 * Booleans are the historical spelling (`true` → full head→tail comet,
 * `false` → solid snake); numbers blend between them (deck's `trailFade`
 * uniform / core `trailAlpha`'s `trailFade` argument). Non-finite input falls
 * back to the default rather than poisoning a uniform with NaN.
 */
export function resolveTrailFade(v: boolean | number | undefined): number {
  if (v === undefined) return 1;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

/**
 * Repeat each feature's encoded pick-id colour across the draw units (segments,
 * fill vertices, stroke edges) it contributed — the id-colour analogue of the
 * DataFilter kernel's `expandFilterValues`, and the reason per-vertex or
 * per-segment geometry still resolves to a per-FEATURE pick id.
 *
 * `perFeature` is the packed RGB triple stream from
 * {@link STTBaseLayer.buildPickIdColors}; `counts[fi]` is how many draw units
 * feature `fi` contributed; `total` is the layer's instance/vertex count. Never
 * writes past `total`, and any unit beyond the ids the base provenance reserved
 * stays id 0 (background) rather than borrowing the next entry's range.
 */
export function expandPickIdColors(
  perFeature: Uint8Array,
  counts: ArrayLike<number>,
  total: number,
): Uint8Array {
  const out = new Uint8Array(total * 3);
  const featureCount = Math.min(perFeature.length / 3, counts.length);
  let w = 0;
  for (let fi = 0; fi < featureCount; fi++) {
    const r = perFeature[fi * 3];
    const g = perFeature[fi * 3 + 1];
    const b = perFeature[fi * 3 + 2];
    for (let i = 0; i < counts[fi] && w < total; i++) {
      out[w * 3] = r;
      out[w * 3 + 1] = g;
      out[w * 3 + 2] = b;
      w++;
    }
  }
  return out;
}

export interface STTBaseLayerOptions {
  /** Unique layer id passed to MapLibre. */
  id: string;
  /**
   * URL of the .stt archive (per-layer ownership: the layer builds a private
   * archive + tileset). Exactly one of `url` / `source` must be given.
   */
  url?: string;
  /**
   * Shared tileset source (D6a): the layer registers as a consumer of ONE
   * archive + ONE tileset serving every layer constructed over the same
   * source. The source's lifetime is the caller's — the layer never
   * finalizes it (dispose the source after removing its layers). Exactly one
   * of `url` / `source` must be given.
   */
  source?: SharedTilesetSource;
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
   * many ms. Defaults to 0 (hard on/off — the unified deck/three policy)
   * unless `softTimeWindow: true` is set.
   */
  fadeInDuration?: number;
  /**
   * Soft fade ramp at the *trailing* edge of the time window, in milliseconds.
   * Features about to leave the window ramp alpha 1 → 0 across this many ms.
   * Defaults to 0 unless `softTimeWindow: true` is set.
   */
  fadeOutDuration?: number;
  /**
   * OPT-IN soft window: when explicitly `true`, both fade durations default to
   * 10% of `timeWindow` (floored at 1 ms). Ignored if `fadeInDuration` /
   * `fadeOutDuration` are set explicitly. Unset/false ⇒ hard on/off.
   */
  softTimeWindow?: boolean;
  /**
   * Override the maximum concurrent tile requests against the archive.
   * Defaults to the tileset's own default (24). Per-layer (`url`) mode only —
   * a shared `source` carries its own loading knobs.
   */
  maxRequests?: number;
  /**
   * Override prefetch behaviour. Defaults follow the SpatiotemporalTileset
   * defaults (30s lookahead, 4 steps). Per-layer (`url`) mode only.
   */
  enablePrefetch?: boolean;
  prefetchAhead?: number;
  prefetchSteps?: number;
  /**
   * Called once per init with the live tileset, after metadata has resolved
   * (in shared-source mode: the SHARED tileset, so N layers report the same
   * instance — register its BufferSource with a governor once per source, not
   * once per layer). The tileset implements the BufferSource readiness
   * contract (runway / cost / ETA queries), which is what a PlaybackGovernor
   * consumes.
   */
  onTilesetReady?: (tileset: SpatiotemporalTileset) => void;
  /**
   * Buffered-runway threshold events from the tileset's coverage index,
   * forwarded as-is (both ownership modes). Route them into a
   * PlaybackGovernor or a buffered-bar UI.
   */
  onBufferChange?: (runway: BufferedRunway) => void;
}

/** Per-tile cached GPU buffers. Created lazily on first draw. */
export interface TileGpuCache {
  /**
   * Mercator unit-square positions, stride-3. Layers built via
   * {@link STTBaseLayer.projectAndUpload} (point, heatmap) upload this
   * quantized to per-tile-local `UNSIGNED_SHORT` — `posScale`/`posOffset`
   * are then set and the shader must dequantize (see
   * `shaders/position-quantization.glsl.ts`). Layers with their own custom
   * position-building path (e.g. polygon fill triangulation) may still
   * upload plain Float32 here and leave `posScale`/`posOffset` unset.
   */
  positionBuffer: WebGLBuffer;
  /**
   * Per-axis `[scale, offset]` reconstructing this tile's mercator positions
   * from the quantized `positionBuffer`: `world = normalized * scale +
   * offset`. Present iff `positionBuffer` was built by
   * {@link STTBaseLayer.projectAndUpload} (quantized); absent for a
   * layer-specific unquantized position buffer.
   */
  posScale?: [number, number, number];
  posOffset?: [number, number, number];
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
  /**
   * Legacy MVP (mercator-0..1 → clip). On v5+ hosts this mirrors
   * `defaultProjectionData.mainMatrix` so matrix-based shaders keep working
   * off-globe; prelude-based shaders should read `frame` instead.
   */
  matrix: Float32Array;
  /**
   * The normalized host frame for this pass (projection variant, injectable
   * prelude, camera params, globe flag). Always set by the base render/pick
   * paths; optional only so hand-built test contexts stay valid.
   */
  frame?: HostFrame;
  /** Window bounds in *relative* time, already offset for this tile. */
  windowStart: number;
  windowEnd: number;
  /** Current absolute time, for shaders that need it directly. */
  currentTime: number;
  /** Map zoom rounded down to integer (matches the tileset's zoom math). */
  zoom: number;
}

/**
 * One entry per (tile, layer) drawn into the id-pick FBO in a single pick pass.
 *
 * MapLibre keeps each tile in its OWN vertex buffer (unlike three's merged
 * buffer), so a decoded pixel index is only meaningful once we know which
 * (tile, layer) it belongs to. We therefore allocate a CONTIGUOUS, 1-based
 * global id range `[idBase, idBase + count)` per drawn layer (0 stays reserved
 * for the cleared "no hit" background) and record it here. A decoded global id
 * `g` resolves to this entry when `idBase <= g < idBase + count`, and the local
 * feature index is `g - idBase` — the same index `getFeatureProperties` joins on.
 *
 * This is the per-tile-VBO analogue of the merged-buffer `InstanceProvenance`
 * kernel in `@poopdeck.gl/core/picking` (renderer-abstraction §5.3): same
 * "which feature is this pixel?" contract, different buffer topology.
 */
export interface PickProvenanceEntry {
  tile: Tile;
  layer: STTLayer;
  cache: TileGpuCache;
  /** First (1-based) global pick id assigned to this layer's feature 0. */
  idBase: number;
  /** Feature count; ids span the half-open range `[idBase, idBase + count)`. */
  count: number;
}

/**
 * Convert a CSS pixel `(cssX, cssY)` (top-left origin, the coordinate space of
 * DOM mouse events) to an integer device-pixel `(x, y)` in the GL read space
 * (bottom-left origin). `dpr` is the device-pixel ratio and `bufferHeight` is
 * the drawing-buffer (device-pixel) height. Pure so it can be unit-tested
 * without a GL context — the surrounding readback is browser-verify-only.
 */
export function cssToDevicePixel(
  cssX: number,
  cssY: number,
  dpr: number,
  bufferHeight: number,
): { x: number; y: number } {
  const px = Math.floor(cssX * dpr);
  const pyTop = Math.floor(cssY * dpr);
  // GL's read origin is bottom-left; DOM events are top-left → flip Y.
  const py = bufferHeight - 1 - pyTop;
  return { x: Math.max(0, px), y: Math.max(0, py) };
}

const tileKey = (id: TileId) => `${id.z}/${id.x}/${id.y}/${id.t}`;

/**
 * `map.style`, unguarded in maplibre itself: `map.getLayer` is
 * `this.style.getLayer(id)` with no null check, and the style is legitimately
 * absent on a Map constructed without the optional `style` option and after
 * `map.remove()` (`delete this.style`). Every getLayer/moveLayer call site
 * here must probe this first.
 */
const styleOf = (map: MaplibreMap): { _loaded?: boolean } | undefined =>
  (map as unknown as { style?: { _loaded?: boolean } }).style;

/** Cached locations of the v5 prelude's projection uniforms, per program. */
interface ProjectionUniformLocs {
  matrix: WebGLUniformLocation | null;
  tileMercatorCoords: WebGLUniformLocation | null;
  clippingPlane: WebGLUniformLocation | null;
  transition: WebGLUniformLocation | null;
  fallbackMatrix: WebGLUniformLocation | null;
}

export abstract class STTBaseLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode: '2d' | '3d' = '2d';

  protected map?: MaplibreMap;
  protected gl?: WebGLRenderingContext | WebGL2RenderingContext;
  /** Private archive (per-layer ownership); undefined in shared-source mode. */
  protected archive?: STTArchive;
  /** Shared tileset source (D6a); undefined in per-layer mode. */
  protected readonly source?: SharedTilesetSource;
  /** Unregister handle for the shared-source consumer; set while registered. */
  private unregisterConsumer?: () => void;
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
    /**
     * The vertex array currently bound. Only {@link pick} needs it: a pick can
     * be issued from a `mousemove` handler, i.e. OUTSIDE the host's render
     * pass, so maplibre's `setCustomLayerDefaults()` has NOT unbound its own
     * VAO and our raw attribute binds would be recorded into it.
     */
    current: () => WebGLVertexArrayObject | null;
  } = {
    enabled: false,
    create: () => null,
    bind: () => undefined,
    delete: () => undefined,
    current: () => null,
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
    drawArraysInstanced: (
      mode: number,
      first: number,
      count: number,
      primCount: number,
    ) => void;
    drawElementsInstanced: (
      mode: number,
      count: number,
      type: number,
      offset: number,
      primCount: number,
    ) => void;
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

  /**
   * The projection matrix captured from the most recent `render()` (an alias
   * of {@link hostFrame}'s scratch matrix). Picking needs it (the host only
   * passes projection state to `render`, not to our user-initiated `pick()`),
   * and a pick necessarily follows a frame. `pick()` returns null before the
   * first render.
   */
  protected lastMatrix?: Float32Array;

  /**
   * Scratch {@link HostFrame} reused every frame — {@link beginFrame} fills
   * it in place from whatever render signature the host used, so the hot
   * path allocates nothing per frame. Contents are only valid for the
   * current/most-recent pass.
   */
  private readonly hostFrame: HostFrame = createHostFrame();

  /**
   * Camera params captured from the latest frame (v4.6+/v5+ hosts only —
   * undefined on plain v3/v4 and mapbox). Read via {@link getCameraParams},
   * which supplies the 36.87° default fov when the host stayed silent.
   */
  protected lastFov?: number;
  protected lastNearZ?: number;
  protected lastFarZ?: number;

  /**
   * Program(+locations) cache keyed `cacheKey + '::' + shader variantName`.
   * A v5 host recompiles our shaders per projection variant (mercator /
   * globe / transition); a legacy host only ever sees the 'legacy' variant.
   * Invalidated wholesale on context loss and dispose.
   */
  private readonly programCache = new Map<string, { program: WebGLProgram }>();
  /** Lazily-resolved prelude projection uniform locations, per program. */
  private projectionUniformLocs = new WeakMap<
    WebGLProgram,
    ProjectionUniformLocs
  >();

  /** Set while the host canvas's WebGL context is lost; render/pick bail. */
  protected contextLost = false;
  /** Canvas we registered context-loss listeners on (removed in onRemove). */
  private lossCanvas?: HTMLCanvasElement;

  /**
   * Init-generation token: bumped by every init start AND by onRemove. An
   * async `initTileset`/`initSharedSource` continuation compares its captured
   * value after each await and aborts on mismatch — the `!this.map` guard
   * alone cannot distinguish "removed" from "removed then re-added" (a
   * styledata re-add restores `map` before the stale await resolves), which
   * previously double-fired `onTilesetReady` and orphaned a live tileset.
   */
  private initGeneration = 0;

  /** Map attach() bound to; undefined when unattached (plain addLayer use). */
  private attachedMap?: MaplibreMap;
  private attachBeforeId?: string;
  /**
   * Armed by attach(), disarmed by detach(): only while armed may the
   * styledata guard re-add a layer that a style diff-fallback rebuild
   * destroyed.
   */
  private autoReadd = false;

  // ── id-buffer picking scaffold (lazily allocated on first pick) ──────────
  /** Offscreen RGBA8 framebuffer the id pass renders into. */
  private pickFbo?: WebGLFramebuffer;
  /** Colour texture backing {@link pickFbo}. */
  private pickTexture?: WebGLTexture;
  /**
   * Depth renderbuffer backing {@link pickFbo} — allocated ONLY for a
   * `renderingMode: '3d'` layer, whose visual pass is depth-tested (see
   * {@link pick}). A '2d' layer paints always-on-top in draw order, and its id
   * pass matches that exactly with no depth buffer at all.
   */
  private pickDepth?: WebGLRenderbuffer;
  private pickWidth = 0;
  private pickHeight = 0;
  /** Reused single-pixel readback scratch (RGBA). */
  private readonly pickBuffer = new Uint8Array(4);

  constructor(opts: STTBaseLayerOptions) {
    this.id = opts.id;
    // `??`, not a `{ autoRepaint: true, ...opts }` seed: a spread carries an
    // EXPLICIT `autoRepaint: undefined` (the React prop-forwarding shape
    // `{ ...base, autoRepaint: props.autoRepaint }`) as an own key and would
    // shadow the default with undefined, silently killing every
    // setCurrentTime repaint.
    this.opts = { ...opts, autoRepaint: opts.autoRepaint ?? true };
    if (opts.source && opts.url) {
      throw new Error(
        `[${opts.id}] pass either url (per-layer archive) or source (shared tileset), not both`,
      );
    }
    if (opts.source) {
      this.source = opts.source;
      return;
    }
    if (!opts.url) {
      throw new Error(`[${opts.id}] one of url or source is required`);
    }
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
  async ready(): Promise<ArchiveMetadata> {
    if (this.archive) return this.archive.getMetadata();
    await this.source!.load();
    const metadata = this.source!.getMetadata();
    if (!metadata) {
      // load() no-ops after the source was disposed — surface that instead of
      // resolving with nothing.
      throw new Error(`[${this.id}] shared source disposed before metadata`);
    }
    return metadata;
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

  /**
   * Add this layer to `map` with an auto re-add guard. A successful
   * `setStyle` diff PRESERVES custom layers, but the diff-fallback rebuild
   * silently destroys them (WITHOUT calling `onRemove` — `Style._remove`
   * skips custom layers) — the installed `styledata` guard re-adds the layer
   * whenever a rebuild dropped it. Idempotent: re-attaching updates AND
   * applies `beforeId` (an already-present layer is repositioned via
   * `moveLayer`). Remove via {@link detach}; note a plain
   * `map.removeLayer(id)` on an *attached* layer is indistinguishable
   * from a rebuild drop and will be resurrected by the guard.
   *
   * Plain `map.addLayer(layer)` keeps working and gets NO auto re-add.
   *
   * `opts.slot` (mapbox Standard style only, campaign D5) requests a layer-stack
   * slot; see {@link applySlot} for the maplibre-ignores / mapbox-honours split.
   */
  attach(
    map: MaplibreMap,
    opts?: { beforeId?: string; slot?: MapboxSlot },
  ): void {
    if (this.attachedMap && this.attachedMap !== map) this.detach();
    const wasAttached = this.attachedMap === map;
    const prevBeforeId = this.attachBeforeId;
    this.attachBeforeId = opts?.beforeId;
    // Resolve the mapbox slot BEFORE (re)adding: mapbox reads `this.slot` off
    // the layer object inside addLayer, and the styledata guard re-adds the
    // same object, so the field must be set first. No-op / warn on maplibre.
    this.applySlot(map, opts?.slot);
    if (!wasAttached) {
      this.attachedMap = map;
      map.on('styledata', this.handleStyledata);
    }
    this.autoReadd = true;
    this.ensureAttachedLayer();
    // Re-attach with a different anchor: ensureAttachedLayer no-ops when the
    // layer is already present, so apply the reposition explicitly
    // (`beforeId: undefined` moves to top, matching addLayer's semantics).
    if (
      wasAttached &&
      this.attachBeforeId !== prevBeforeId &&
      styleOf(map) &&
      map.getLayer(this.id)
    ) {
      try {
        map.moveLayer(this.id, this.attachBeforeId);
      } catch {
        // Anchor missing from the current style — keep the current position;
        // a rebuild re-add applies the stored beforeId.
      }
    }
  }

  /**
   * Undo {@link attach}: disarm the styledata guard (so nothing resurrects
   * the layer), drop the listener, and remove the layer from the map if
   * present. Safe to call repeatedly, when never attached, or after
   * `map.remove()` (style-less map — nothing left to remove from).
   */
  detach(): void {
    const map = this.attachedMap;
    this.autoReadd = false;
    if (!map) return;
    map.off('styledata', this.handleStyledata);
    this.attachedMap = undefined;
    this.attachBeforeId = undefined;
    if (!styleOf(map)) return; // no style ⇒ no layer registry to clean.
    if (map.getLayer(this.id)) map.removeLayer(this.id);
  }

  // ── Mapbox Standard-style slot support (campaign D5) ─────────────────────
  // Self-contained additive block, kept beside attach/detach so a concurrent
  // edit to the render/pick/lifecycle internals never collides with it.
  //
  // Mapbox-gl reads a `slot` field off the custom-layer object at addLayer
  // time to place the layer in the Standard style's stack
  // ('bottom' | 'middle' | 'top'). MapLibre has no slot concept, so a slot
  // request on a maplibre host is dropped (one-time dev warning). Mercator
  // only — mapbox globe is deferred (D5); the slot governs 2D stacking, which
  // is orthogonal to projection.

  /**
   * Mapbox Standard-style slot this layer requests, or undefined. PUBLIC and
   * on the instance because mapbox-gl reads `layer.slot` off the
   * CustomLayerInterface object during `map.addLayer` — including the object
   * the styledata guard hands back on a re-add — so it must live here rather
   * than in a closure. Set only via {@link attach} on a mapbox host; always
   * undefined on maplibre. Harmless on maplibre hosts, which ignore unknown
   * layer fields.
   */
  slot?: MapboxSlot;

  /** One-time-per-layer guard so a dropped slot request warns at most once. */
  private slotWarned = false;

  /**
   * Resolve a requested Standard-style slot against the host. On mapbox the
   * slot is stamped onto {@link slot} so the next add (initial or a styledata
   * re-add) positions the layer; on maplibre — or for a value past the typed
   * union — it is dropped with a single dev warning. Passing no slot clears any
   * prior request, mirroring how `beforeId` is overwritten on re-attach; note
   * mapbox only reads slot at addLayer time, so a change takes effect on the
   * NEXT add/re-add, not on an already-mounted layer.
   */
  private applySlot(map: MaplibreMap, requested: MapboxSlot | undefined): void {
    if (requested === undefined) {
      this.slot = undefined;
      return;
    }
    if (!isValidMapboxSlot(requested)) {
      this.slot = undefined;
      if (!this.slotWarned) {
        this.slotWarned = true;
        console.warn(
          `[${this.id}] attach ignored unknown slot ${JSON.stringify(requested)} (expected 'bottom' | 'middle' | 'top')`,
        );
      }
      return;
    }
    if (isMapboxHost(map)) {
      this.slot = requested;
      return;
    }
    this.slot = undefined;
    if (!this.slotWarned) {
      this.slotWarned = true;
      console.warn(
        `[${this.id}] attach({ slot: '${requested}' }) ignored: the host is MapLibre, which has no Standard-style slots — use beforeId for ordering`,
      );
    }
  }

  /** styledata guard body: re-add if (and only if) the layer went missing. */
  private readonly handleStyledata = (): void => {
    this.ensureAttachedLayer();
  };

  private ensureAttachedLayer(): void {
    const map = this.attachedMap;
    if (!map || !this.autoReadd) return;
    // A Map constructed without the `style` option has no style object at
    // all — defer to the styledata that follows the app's eventual setStyle
    // (map.getLayer would throw on the missing style).
    const style = styleOf(map);
    if (!style) return;
    if (map.getLayer(this.id)) return; // still present — no re-add storms.
    // During a diff-fallback rebuild the new style may not be ready to accept
    // layers yet; skip and let the next styledata event retry.
    if (style._loaded === false) return;
    try {
      map.addLayer(this, this.attachBeforeId);
    } catch {
      // Style raced us ('Style is not done loading') — retry on styledata.
    }
  }

  onAdd(
    map: MaplibreMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // A diff-fallback rebuild on hosts whose `Style._remove` skips
    // custom-layer onRemove (source-verified on maplibre v4.7) re-adds a
    // still-initialized layer on the same live context: tileset, programs
    // and tile caches all remain valid, so short-circuit — re-running init
    // here would orphan the live tileset (never finalized, callbacks still
    // firing), re-fire onTilesetReady, and leak the subclass GPU handles a
    // second onContextReady overwrites.
    if (this.map === map && this.gl === gl) return;
    // Initialized against a different map/context: tear down first.
    if (this.map) this.onRemove();
    this.map = map;
    this.gl = gl;
    this.contextLost = false;
    this.initIndexSupport(gl);
    this.initVaoSupport(gl);
    this.initInstanceSupport(gl);
    this.onContextReady(gl);
    // The host explicitly cannot restore custom layers across a WebGL
    // context loss — we own the invalidation ourselves (D12). Optional
    // chaining keeps bare-bones test mocks without a canvas working.
    const canvas = (
      map as unknown as { getCanvas?: () => HTMLCanvasElement }
    ).getCanvas?.();
    if (canvas) {
      this.lossCanvas = canvas;
      canvas.addEventListener('webglcontextlost', this.handleContextLost);
      canvas.addEventListener(
        'webglcontextrestored',
        this.handleContextRestored,
      );
    }
    // `map.remove()` (setStyle(null) → Style._remove) never calls
    // custom-layer onRemove either — hook the map's terminal 'remove' event
    // so an app tearing down with only map.remove() (common SPA unmount)
    // still finalizes the tileset/archive and drops our listeners. Optional
    // call keeps bare-bones test mocks without an emitter working.
    (map as unknown as { on?: (type: string, fn: () => void) => void }).on?.(
      'remove',
      this.handleMapRemove,
    );
    if (this.source) void this.initSharedSource();
    else void this.initTileset();
  }

  /**
   * Full teardown off `map.remove()`. The GL context is force-lost by the
   * time (or right after) this fires, so any deletes onRemove issues are
   * silently ignored — reference release is what matters. Also disarms the
   * attach guard so nothing re-adds onto the dead map.
   */
  private readonly handleMapRemove = (): void => {
    this.detach();
    if (this.map) this.onRemove();
  };

  /**
   * 32-bit element indices are required for tiles with > 65k vertices after
   * line/polygon expansion. WebGL2 supports them natively; on WebGL1 we
   * probe the extension. Subclasses that index >65k vertices must check
   * `this.supports32BitIndices` and fall back to multiple draws if false.
   * Re-run on context restore (extensions don't survive a restore).
   */
  private initIndexSupport(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (
      typeof WebGL2RenderingContext !== 'undefined' &&
      gl instanceof WebGL2RenderingContext
    ) {
      this.supports32BitIndices = true;
    } else {
      this.supports32BitIndices = !!gl.getExtension('OES_element_index_uint');
    }
  }

  /**
   * Context-loss bookkeeping. On loss, drop every GPU reference WITHOUT
   * touching GL (all calls are silently ignored on a lost context, so
   * deletes would be no-ops at best); on restore, re-probe capabilities and
   * rebuild programs, letting tile buffers / VAOs / the pick FBO rebuild
   * lazily on the next frame.
   */
  private readonly handleContextLost = (): void => {
    this.contextLost = true;
    // The drawing buffer is reallocated on restore, so the dpr memo's key
    // (its width) is no longer trustworthy.
    this.dprMemoBufferWidth = -1;
    this.releaseGpuResources(undefined);
    // Null the subclass's handles too — any gl.delete* its hook issues is
    // ignored on the lost context, so this is a pure reference release.
    if (this.gl) this.onContextLost(this.gl);
  };

  private readonly handleContextRestored = (): void => {
    const gl = this.gl;
    this.contextLost = false;
    if (!gl || !this.map) return;
    // Extension objects and caps don't survive a restore — re-probe, then
    // rebuild the subclass's programs. Everything else rebuilds lazily.
    this.initIndexSupport(gl);
    this.initVaoSupport(gl);
    this.initInstanceSupport(gl);
    this.onContextReady(gl);
    this.map.triggerRepaint();
  };

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
    // 0x85B5 is VERTEX_ARRAY_BINDING in WebGL2 and VERTEX_ARRAY_BINDING_OES in
    // the WebGL1 extension — same enum, so one literal serves both paths.
    const VERTEX_ARRAY_BINDING = 0x85b5;
    const gl2 = gl as WebGL2RenderingContext;
    if (typeof gl2.createVertexArray === 'function') {
      this.vaoSupport = {
        enabled: true,
        create: () => gl2.createVertexArray(),
        bind: (vao) => gl2.bindVertexArray(vao),
        delete: (vao) => gl2.deleteVertexArray(vao),
        current: () =>
          (gl2.getParameter(VERTEX_ARRAY_BINDING) ??
            null) as WebGLVertexArrayObject | null,
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
        current: () =>
          (gl.getParameter(VERTEX_ARRAY_BINDING) ??
            null) as WebGLVertexArrayObject | null,
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
      drawArraysInstancedANGLE: (
        mode: number,
        first: number,
        count: number,
        primCount: number,
      ) => void;
      drawElementsInstancedANGLE: (
        mode: number,
        count: number,
        type: number,
        offset: number,
        primCount: number,
      ) => void;
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
      new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.unitQuadBuffer = buf;
    return buf;
  }

  onRemove(): void {
    // Invalidate any in-flight initTileset/initSharedSource continuation
    // (see initGeneration) and drop the map-remove hook.
    this.initGeneration++;
    (
      this.map as unknown as
        | { off?: (type: string, fn: () => void) => void }
        | undefined
    )?.off?.('remove', this.handleMapRemove);
    if (this.lossCanvas) {
      this.lossCanvas.removeEventListener(
        'webglcontextlost',
        this.handleContextLost,
      );
      this.lossCanvas.removeEventListener(
        'webglcontextrestored',
        this.handleContextRestored,
      );
      this.lossCanvas = undefined;
    }
    const gl = this.gl;
    // On a lost context every delete would be ignored — just drop references.
    this.releaseGpuResources(this.contextLost ? undefined : gl);
    if (gl) this.onContextLost(gl);
    this.contextLost = false;
    this.loadedTiles.clear();
    // Shared-source mode: the tileset/archive belong to the source (and to
    // its other consumers) — just stop receiving fan-out. A styledata re-add
    // re-registers in onAdd.
    this.unregisterConsumer?.();
    this.unregisterConsumer = undefined;
    if (!this.source) {
      this.tileset?.finalize();
      this.archive?.finalize();
    }
    // A finalized tileset must not serve a styledata re-add's first frames —
    // onAdd's initTileset builds a fresh one (the archive itself is reusable
    // after finalize: metadata stays cached, the decoder rebuilds lazily).
    this.tileset = undefined;
    // Clear the map handle LAST. An in-flight `initTileset` /
    // `initSharedSource` (awaiting metadata) is already invalidated by the
    // initGeneration bump above; the `!this.map` check is the belt to that
    // suspenders for continuations with no later re-add.
    this.map = undefined;
  }

  /**
   * Release every base-owned GPU handle. With a live `gl` the resources are
   * deleted; with none (context lost) references are simply dropped so the
   * next frame / restore rebuilds them lazily. Subclass handles are released
   * separately via their `onContextLost` hook.
   */
  private releaseGpuResources(
    gl?: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (gl) {
      for (const cache of this.tileGpuCache.values()) {
        if (cache) this.deleteCacheBuffers(gl, cache);
      }
      if (this.unitQuadBuffer) gl.deleteBuffer(this.unitQuadBuffer);
      if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);
      if (this.pickTexture) gl.deleteTexture(this.pickTexture);
      if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
    }
    this.tileGpuCache.clear();
    this.unitQuadBuffer = undefined;
    this.pickFbo = undefined;
    this.pickTexture = undefined;
    this.pickDepth = undefined;
    this.pickWidth = 0;
    this.pickHeight = 0;
    this.invalidateProgramCache(gl);
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

  /**
   * FIRST step of every render pass: normalize the host's arguments (legacy
   * positional matrix vs v5/v6 args object — see `lib/host-adapter.ts`) into
   * the per-instance scratch {@link HostFrame}, stash the matrix + camera
   * params for later `pick()` calls, and advance the tileset viewport.
   * Returns null when there is nothing to draw (no tileset yet, layer
   * removed, GL context lost). Subclasses that override `render()` wholesale
   * (heatmap) MUST route through this so v5+ hosts and picking keep working.
   */
  protected beginFrame(
    matrixOrArgs: unknown,
    options?: unknown,
  ): HostFrame | null {
    if (!this.tileset || !this.map || this.contextLost) return null;
    // Frame-constant and read once per tile by the mode uniform pushes / the
    // metric-sizing scale factors.
    this.refreshFadeDurations();
    this.frameZoom = this.map.getZoom();
    const frame = normalizeRenderArgs(matrixOrArgs, options, this.hostFrame);
    // Stash for user-initiated picking, which has no host frame of its own.
    this.lastMatrix = frame.matrix;
    this.lastFov = frame.fov;
    this.lastNearZ = frame.nearZ;
    this.lastFarZ = frame.farZ;
    const viewport = {
      bounds: toBoundsArray(this.map.getBounds()),
      zoom: Math.floor(this.map.getZoom()),
      time: this.opts.currentTime,
      timeWindow: this.opts.timeWindow,
    };
    // Shared mode routes through the source so its resident-set diff runs
    // and N sibling layers stay cheap: the source is left UNARMED (no
    // beginFrame/frameId — every update drives) because the core tileset
    // short-circuits identical-param selections via lastSelectKey AND the
    // source gates its getVisibleTiles/resident-diff walk on the tileset's
    // frame number, so redundant sibling updates allocate nothing; hosts
    // wanting strict once-per-frame driving may call `source.beginFrame()`
    // from their own frame hook.
    if (this.source) this.source.update(viewport);
    else this.tileset.update(viewport);
    return frame;
  }

  // Host signature dispatch (D2): maplibre ≤v4 calls `render(gl, matrix)`
  // (v4.6+ appends a camera-options arg) and mapbox v3 calls
  // `render(gl, matrix, ...globe positional params)` — both legacy; maplibre
  // v5 REPLACED the positional matrix with a single args object carrying
  // `defaultProjectionData` + `shaderData` (maplibre/maplibre-gl-js#3854),
  // and v6 adds `args.getProjectionData`. `beginFrame` duck-types whichever
  // shape arrives, so one layer instance works on every host.
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ): void {
    const frame = this.beginFrame(matrixOrArgs, options);
    if (!frame) return;

    const zoom = Math.floor(this.map!.getZoom());
    const currentTime = this.opts.currentTime;

    // Configure shared GL state. Subclasses may override per-draw if needed.
    this.applySharedGlState(gl);

    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.ensureTileGpuCache(gl, tile, layer);
        if (!cache) continue;
        const ctx: DrawContext = {
          matrix: frame.matrix,
          frame,
          currentTime,
          zoom,
          windowStart:
            currentTime - cache.timeOffset - this.opts.timeWindow / 2,
          windowEnd: currentTime - cache.timeOffset + this.opts.timeWindow / 2,
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
   * OPTIONAL id-buffer pick hook. Subclasses that support hit-testing implement
   * this to draw one (tile, layer) into the pick FBO with the SAME geometry as
   * `drawTile`, but painting feature `i` the flat opaque colour
   * `encodePickId(idBase + i)` (use {@link buildPickIdColors}). No blending, no
   * antialiasing — the readback must recover the byte triple exactly. Leave it
   * undefined and the layer is simply non-pickable (`pick()` returns null); this
   * keeps subclasses that haven't grown an id shader green. Browser-verify-only
   * (needs a live GL FBO); the id-colour build + decode join are unit-tested.
   */
  protected drawPickTile?(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
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
    const { buffer, scale, offset } = this.projectAndUpload(
      gl,
      f.positions,
      dims,
    );
    const times = this.uploadFeatureTimes(gl, f.startTimes, f.endTimes);

    const vertexCount = f.positions.length / dims;
    return {
      positionBuffer: buffer,
      posScale: scale,
      posOffset: offset,
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

  /**
   * Project lon/lat → mercator, quantize to per-tile-local `UNSIGNED_SHORT`
   * (perf research 2026-07 — half the bytes of Float32, no visible precision
   * loss inside one tile's own bounding box; see `quantizePositionsToUint16`),
   * and upload to a fresh ARRAY_BUFFER. Callers bind the attribute with
   * `vertexAttribPointer(loc, 3, gl.UNSIGNED_SHORT, true, 0, 0)`
   * (`normalized: true`) and dequantize in the shader via
   * `sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset)`
   * (`shaders/position-quantization.glsl.ts`), setting `uPosScale`/
   * `uPosOffset` once per tile draw from the returned `scale`/`offset`.
   */
  protected projectAndUpload(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    positions: Float64Array | Float32Array,
    dimensions: 2 | 3,
  ): {
    buffer: WebGLBuffer;
    scale: [number, number, number];
    offset: [number, number, number];
  } {
    const projected = projectPositions(positions, dimensions);
    const { quantized, scale, offset } = quantizePositionsToUint16(projected);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quantized, gl.STATIC_DRAW);
    return { buffer: buf, scale, offset };
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
   * Resolved fade durations, in ms (0 = hard cutoff at that edge). ONE object
   * per layer, refilled in place — `drawTile`/`drawPickTile` read it once per
   * tile per frame on four layers, so returning a fresh literal there was
   * thousands of short-lived objects a second on a resident tile set.
   */
  private readonly fadeDurations = { fadeIn: 0, fadeOut: 0 };
  /** Inputs the cached {@link fadeDurations} were resolved from. */
  private fadeMemo: [number, unknown, unknown, unknown] = [
    Number.NaN,
    undefined,
    undefined,
    undefined,
  ];

  /**
   * Recompute {@link fadeDurations} when (and only when) its inputs moved.
   * Delegates to the shared kernel resolver (one fade policy across backends):
   * fades default to a hard 0-cut, with the 10%-of-window soft ramp applied
   * only on explicit `softTimeWindow: true`. The window-mode shader fragments
   * compare against these directly.
   *
   * The four inputs are frame-constant, so the resolver runs at most once per
   * frame however many tiles ask for the result. Called from `beginFrame` and
   * `pick()`; the per-tile call sites go through {@link resolveFadeDurations},
   * which is then a pure read.
   */
  protected refreshFadeDurations(): void {
    const o = this.opts;
    const m = this.fadeMemo;
    if (
      m[0] === o.timeWindow &&
      m[1] === o.fadeInDuration &&
      m[2] === o.fadeOutDuration &&
      m[3] === o.softTimeWindow
    ) {
      return;
    }
    const p = resolveTimeFilterParams(o, { softDefaultFraction: 0.1 });
    this.fadeDurations.fadeIn = Math.max(0, p.fadeIn ?? 0);
    this.fadeDurations.fadeOut = Math.max(0, p.fadeOut ?? 0);
    m[0] = o.timeWindow;
    m[1] = o.fadeInDuration;
    m[2] = o.fadeOutDuration;
    m[3] = o.softTimeWindow;
  }

  /**
   * The layer's fade durations. Allocation-free: the SAME object comes back
   * every call (destructure it, never retain it).
   */
  protected resolveFadeDurations(): { fadeIn: number; fadeOut: number } {
    this.refreshFadeDurations();
    return this.fadeDurations;
  }

  /**
   * Expand a categorical `binary` property to a flat per-feature RGBA8 buffer
   * (Uint8Array, normalized=true on GPU). Returns null if the property is
   * missing from the binary features.
   *
   * Two coloring modes (deck/three parity):
   *
   *  - **Positional palette** (default): each feature's color is
   *    `palette[categoryIndex % palette.length]`. Simple, but the color a
   *    category gets depends on its *index* in the tile's own category
   *    dictionary — so a tile-local category reorder silently recolors it.
   *
   *  - **Keyed `colorMapping`** (when supplied): the category STRING
   *    (`cat.categories[index]`) is looked up in `colorMapping`, falling back to
   *    `colorMappingDefault`, then to the positional palette (if any), then to
   *    transparent. This makes a category render the SAME color in every tile
   *    regardless of per-tile dictionary order — matching deck's `colorMapping`
   *    / three's `colorMapping`.
   */
  protected expandCategoricalColors(
    binary: BinaryFeatures,
    propertyName: string,
    palette: ReadonlyArray<RGBA8>,
    colorMapping?: Record<string, RGBA8> | null,
    colorMappingDefault?: RGBA8,
  ): Uint8Array | null {
    return core.expandCategoricalColors(
      binary,
      {
        property: propertyName,
        colorMapping,
        palette,
        colorMappingDefault,
        onMissing: 'null',
        requireMappingOrPalette: true,
      },
      'u8',
    ) as Uint8Array | null;
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

  /**
   * Fetch (or build via `factory`) the program handles for `cacheKey` under
   * the frame's shader variant. The factory receives the host's
   * `{prelude, define}` to prepend to its vertex source (empty strings on
   * legacy frames — keep the `uMatrix` shader there) and returns the linked
   * program plus whatever attribute/uniform locations the subclass needs.
   * Cached per `cacheKey::variantName`, so a v5 globe transition (variant
   * flip) relinks once and then reuses; invalidated wholesale on context
   * loss and dispose.
   */
  protected getOrCreateProgram<H extends { program: WebGLProgram }>(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    cacheKey: string,
    frame: HostFrame,
    factory: (
      gl: WebGLRenderingContext | WebGL2RenderingContext,
      shader: { prelude: string; define: string },
    ) => H,
  ): H {
    const key = `${cacheKey}::${frame.shader.variantName}`;
    const cached = this.programCache.get(key);
    if (cached) return cached as H;
    const handles = factory(gl, frame.shader);
    this.programCache.set(key, handles);
    return handles;
  }

  /**
   * Drop every cached program. With `gl` (dispose path) the programs are
   * also deleted; without it (context loss — GL frees nothing on a dead
   * context) the references are simply released so the next frame relinks
   * lazily.
   */
  protected invalidateProgramCache(
    gl?: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (gl) {
      for (const h of this.programCache.values()) gl.deleteProgram(h.program);
    }
    this.programCache.clear();
    this.projectionUniformLocs = new WeakMap();
  }

  /**
   * Set the injected prelude's projection uniforms (`u_projection_matrix`,
   * `u_projection_tile_mercator_coords`, `u_projection_clipping_plane`,
   * `u_projection_transition`, `u_projection_fallback_matrix`) from the
   * frame's v5 projectionData. Call after `useProgram` on a program whose
   * vertex source had the frame's prelude prepended. No-op on legacy frames
   * (their shaders project via `uMatrix` instead). Locations are resolved
   * once per program and cached.
   */
  protected setPreludeProjectionUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    frame: HostFrame,
  ): void {
    const pd = frame.projectionData;
    if (!pd) return;
    let locs = this.projectionUniformLocs.get(program);
    if (!locs) {
      locs = {
        matrix: gl.getUniformLocation(program, 'u_projection_matrix'),
        tileMercatorCoords: gl.getUniformLocation(
          program,
          'u_projection_tile_mercator_coords',
        ),
        clippingPlane: gl.getUniformLocation(
          program,
          'u_projection_clipping_plane',
        ),
        transition: gl.getUniformLocation(program, 'u_projection_transition'),
        fallbackMatrix: gl.getUniformLocation(
          program,
          'u_projection_fallback_matrix',
        ),
      };
      this.projectionUniformLocs.set(program, locs);
    }
    gl.uniformMatrix4fv(locs.matrix, false, pd.mainMatrix);
    gl.uniform4fv(locs.tileMercatorCoords, pd.tileMercatorCoords);
    gl.uniform4fv(locs.clippingPlane, pd.clippingPlane);
    gl.uniform1f(locs.transition, pd.projectionTransition);
    gl.uniformMatrix4fv(locs.fallbackMatrix, false, pd.fallbackMatrix);
  }

  /**
   * Full-mercator-square subdivision granularity for a tile zoom on globe
   * frames: the host's per-tile granularity (duck-typed from
   * `map.style.projection.subdivisionGranularity`; maplibre's default
   * halving curve when the host object is absent/malformed) × 2^z per the
   * globe-kit convention — see `lib/globe.ts` module header. Geometry layers
   * (line/trips/polygon) subdivide tile geometry to this at build time so
   * long edges don't get horizon-clipped on globe.
   */
  protected tileSubdivisionGranularity(z: number): number {
    const like = (
      this.map as unknown as
        | { style?: { projection?: { subdivisionGranularity?: unknown } } }
        | undefined
    )?.style?.projection?.subdivisionGranularity;
    // Deliberately NOT memoized. The globe cache keys read this once per tile
    // per frame, but a host may mutate its granularity curve IN PLACE (only
    // maplibre's own projections are guaranteed to swap the settings object on
    // `setProjection`), and a stale granularity silently reuses chords that
    // horizon-clip. Correctness over two property reads.
    return granularityForZoom(like, z) * 2 ** z;
  }

  /**
   * Live fractional zoom for the frame in progress, captured once in
   * {@link beginFrame}. `undefined` outside a frame (a direct `drawTile` in a
   * test, or a layer driven by hand), where callers fall back to the live
   * getter. Metric sizing reads it once per TILE, and it cannot move inside a
   * render pass.
   */
  protected frameZoom?: number;

  /**
   * Camera parameters for CPU-side pick / billboard math: the values
   * captured from the latest host frame when available (v4.6+/v5+), else
   * MapLibre's default 36.87° fov with unknown clip planes.
   */
  protected getCameraParams(): {
    fovRadians: number;
    nearZ?: number;
    farZ?: number;
  } {
    return {
      fovRadians: this.lastFov ?? DEFAULT_FOV_RADIANS,
      nearZ: this.lastNearZ,
      farZ: this.lastFarZ,
    };
  }

  // ------------------------------------------------------------------------
  // Picking (id-buffer / FBO)
  // ------------------------------------------------------------------------
  //
  // MapLibre's CustomLayerInterface is invisible to `map.queryRenderedFeatures`,
  // so STT features have no native hit-testing. This scaffold adds the standard
  // deck.gl / three id-buffer trick: re-render the layer off-screen with each
  // feature painted a colour that encodes its integer index, read back the
  // cursor pixel, and decode it. The 24-bit id packing + `SttPickResult` shape
  // come from `@poopdeck.gl/core/picking` so every backend is interoperable.
  //
  // What's what for testing: the id-colour build (`buildPickIdColors`), the
  // cursor→pixel math (`cssToDevicePixel`), the global-id allocation
  // (`buildPickProvenance`) and the decode→join (`resolvePick`) are all pure /
  // CPU and unit-tested. Only the GL round-trip inside `pick()` (FBO render +
  // `readPixels`) needs a live GPU and is browser-verify-only.

  /**
   * Does this layer support id-buffer picking? True iff the subclass provides a
   * {@link drawPickTile} hook. Layers without one report `pick()` → null.
   */
  supportsPicking(): boolean {
    return typeof this.drawPickTile === 'function';
  }

  /**
   * Build a per-feature id-colour attribute (3 bytes / feature) where feature
   * `i` gets `encodePickId(idBase + i)`. Uploaded as an UNSIGNED_BYTE
   * `normalized` attribute so the fragment stage passes it straight through and
   * the RGBA8 readback recovers the exact triple.
   *
   * `idBase` is 1-based (id 0 is reserved for the cleared "no hit" background),
   * so callers pass the {@link PickProvenanceEntry.idBase} they were allocated.
   */
  protected buildPickIdColors(count: number, idBase: number): Uint8Array {
    if (!Number.isInteger(idBase) || idBase < 1) {
      throw new RangeError(
        `buildPickIdColors: idBase must be a positive integer (1-based), got ${idBase}`,
      );
    }
    const out = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [r, g, b] = encodePickId(idBase + i);
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    return out;
  }

  /**
   * Walk the currently loaded tiles/layers in the SAME order `render()` draws
   * them, filtering by `acceptsGeometry`, and assign each a contiguous global
   * pick-id range. Returns the provenance table `pick()` renders + resolves
   * against. Skips (and warns about) any layer that would push the id space
   * past {@link MAX_PICK_ID} rather than aliasing two features.
   */
  protected buildPickProvenance(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): PickProvenanceEntry[] {
    const entries: PickProvenanceEntry[] = [];
    let cursor = 1; // 1-based; 0 = cleared background = "no hit".
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const count = layer.features.featureCount;
        if (count <= 0) continue;
        if (cursor + count - 1 > MAX_PICK_ID) {
          console.warn(
            `[${this.id}] picking id space exhausted (> ${MAX_PICK_ID}); ` +
              `remaining features this frame are not pickable`,
          );
          return entries;
        }
        const cache = this.ensureTileGpuCache(gl, tile, layer);
        if (!cache) continue;
        entries.push({ tile, layer, cache, idBase: cursor, count });
        cursor += count;
      }
    }
    return entries;
  }

  /**
   * Resolve a read-back id-colour triple against a provenance table into a
   * {@link SttPickResult}, or null for the background / an unmatched id. Joins
   * the decoded feature index back to its columns via `getFeatureProperties`.
   * Pure — the CPU seam every `pick()` test exercises.
   */
  protected resolvePick(
    rgb: readonly [number, number, number],
    provenance: readonly PickProvenanceEntry[],
  ): SttPickResult | null {
    const globalId = decodePickId(rgb);
    if (globalId <= 0) return null; // cleared background.
    const entry = provenance.find(
      (e) => globalId >= e.idBase && globalId < e.idBase + e.count,
    );
    if (!entry) return null;
    const index = globalId - entry.idBase;
    return {
      object: getFeatureProperties(entry.layer.features, index),
      index,
      tileId: entry.tile.id,
      layerId: entry.layer.name,
    };
  }

  /**
   * Ensure the offscreen id-pick framebuffer exists and matches the drawing
   * buffer size. RGBA8 + NEAREST always — ids must survive as exact bytes, so
   * we never filter or use a float format. Recreated (not reattached) on resize
   * for driver portability, mirroring the heatmap accumulator.
   *
   * A `renderingMode: '3d'` layer additionally gets a DEPTH_COMPONENT16
   * renderbuffer: its VISIBLE frame is resolved by depth (maplibre installs a
   * LEQUAL read-write depth mode for 3d custom layers, which
   * {@link applySharedGlState} deliberately leaves in place), so an id pass with
   * no depth would resolve overlapping geometry by DRAW ORDER instead and hand
   * back the feature hidden BEHIND the one the user clicked. '2d' layers paint
   * always-on-top in draw order, so for them the colour-only target already
   * matches the frame exactly and the extra buffer would be waste.
   */
  private ensurePickFbo(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const w = gl.drawingBufferWidth | 0;
    const h = gl.drawingBufferHeight | 0;
    if (w === this.pickWidth && h === this.pickHeight && this.pickFbo) return;
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);
    if (this.pickTexture) gl.deleteTexture(this.pickTexture);
    if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
    this.pickDepth = undefined;
    this.pickFbo = gl.createFramebuffer()!;
    this.pickTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.pickTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      w,
      h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.pickTexture,
      0,
    );
    if (this.renderingMode === '3d' && w > 0 && h > 0) {
      this.pickDepth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        this.pickDepth,
      );
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pickWidth = w;
    this.pickHeight = h;
  }

  /**
   * Best-effort device-pixel ratio: the drawing buffer / canvas-CSS ratio when
   * the map canvas is reachable, else `devicePixelRatio`, else 1.
   *
   * Two callers, both needing the SAME ratio: the pick readback texel (an
   * off-by-a-fraction is harmless there) and metric sizing, where maplibre's
   * `512 · 2^zoom` world is CSS pixels while `gl_PointSize` / `uViewport` are
   * DEVICE pixels — so every metres→pixels conversion must cross this ratio.
   * `protected` so the sizing layers share one implementation.
   *
   * `canvas.clientWidth` is a layout-forcing DOM read and the metric-sizing
   * paths call this once per TILE, so the result is memoized against the
   * drawing-buffer width: the ratio can only move when the buffer is resized
   * (maplibre reallocates it on canvas resize and on a dpr change), and the
   * memo is dropped wholesale on context loss.
   */
  protected resolveDevicePixelRatio(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): number {
    if (gl.drawingBufferWidth === this.dprMemoBufferWidth) return this.dprMemo;
    const canvas = (
      this.map as unknown as { getCanvas?: () => HTMLCanvasElement }
    )?.getCanvas?.();
    const dpr =
      canvas && canvas.clientWidth > 0
        ? gl.drawingBufferWidth / canvas.clientWidth
        : ((globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1);
    this.dprMemoBufferWidth = gl.drawingBufferWidth;
    this.dprMemo = dpr;
    return dpr;
  }

  /** Drawing-buffer width {@link dprMemo} was measured at; -1 = unmeasured. */
  private dprMemoBufferWidth = -1;
  private dprMemo = 1;

  /**
   * Metric sizing, the ONE implementation (Wave M3 seam pass).
   *
   * How many DEVICE pixels `meters` metres of ground cover at `latitudeDeg`,
   * for the frame in progress. This is what every `radiusUnits`/`widthUnits`/
   * `sizeUnits: 'meters'` prop in the package resolves through, and the three
   * details it encodes were being re-derived, identically, in seven layers:
   *
   *  1. FRACTIONAL zoom. `ctx.zoom` is FLOORED (it is the tile-selection zoom),
   *     so sizing off it makes metric widths step at integer zooms instead of
   *     growing continuously. The ladder is: the value hoisted once per frame
   *     in {@link beginFrame} → the live map getter (for a draw issued outside
   *     a render pass) → `ctx.zoom` as the last resort.
   *  2. The DEVICE-pixel ratio. MapLibre's `512 · 2^zoom` world is CSS pixels
   *     while `gl_PointSize` and `uViewport` are device pixels, so the
   *     conversion must cross {@link resolveDevicePixelRatio} — which is
   *     memoized, because this runs once per TILE per frame.
   *  3. Latitude. Mercator stretches with `1/cos(lat)`; use the TILE's centre
   *     (see {@link metricPixelScale}) unless the geometry is not tied to one
   *     tile, in which case the map centre is the same single-factor
   *     approximation maplibre's own `_pixelPerMeter` makes.
   *
   * Screen-space caveat under pitch is documented on
   * `metersToPixelsAtLatitude`: the factor is resolved per tile, not per
   * fragment, so a pitched view keeps the centre-of-view size near the horizon.
   */
  protected metricPixelScaleAt(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    latitudeDeg: number,
    fallbackZoom: number,
    meters = 1,
  ): number {
    const zoom = this.frameZoom ?? this.map?.getZoom() ?? fallbackZoom;
    return metersToPixelsAtLatitude(
      meters,
      latitudeDeg,
      zoom,
      512 * this.resolveDevicePixelRatio(gl),
    );
  }

  /**
   * Per-slot scratch for {@link rgba01Uniform}. One array per uniform NAME the
   * subclass drives, so two constant colours in one program (fill + outline,
   * source + target) never share a buffer.
   */
  private readonly rgbaScratch = new Map<
    string,
    [number, number, number, number]
  >();

  /**
   * `toRgba01` without the per-call allocation — the form the DRAW path must
   * use (Wave M3 seam pass).
   *
   * `gl.uniform4fv(h.uColor, toRgba01(this.opts.color))` reads innocently, but
   * `toRgba01` builds a fresh 4-tuple and the draw path runs it once per TILE
   * per FRAME, on every layer with a constant colour — eight layers were doing
   * it, up to two slots each. This returns a cached array owned by `slot`,
   * refilled in place, so the steady state allocates nothing.
   *
   * Still a plain `number[]` rather than a `Float32Array`: WebGL accepts both,
   * and staying in float64 keeps the value byte-exact against the CPU-side
   * expectation (a `Float32Array` would quantize `150/255` and force every
   * assertion to go approximate).
   *
   * `slot` must be UNIQUE per uniform within a layer — reusing one slot for two
   * live uniforms would have the second overwrite the first before the driver
   * read it. Convention: the uniform's own name, minus the `u` prefix.
   */
  protected rgba01Uniform(
    slot: string,
    c: readonly [number, number, number, number],
  ): [number, number, number, number] {
    let out = this.rgbaScratch.get(slot);
    if (!out) {
      out = [0, 0, 0, 0];
      this.rgbaScratch.set(slot, out);
    }
    // deck's 0–255 convention vs 0–1 floats, auto-detected exactly as
    // `toRgba01` does (any channel above 1 means the tuple is bytes).
    const k = c[0] > 1 || c[1] > 1 || c[2] > 1 || c[3] > 1 ? 1 / 255 : 1;
    out[0] = c[0] * k;
    out[1] = c[1] * k;
    out[2] = c[2] * k;
    out[3] = c[3] * k;
    return out;
  }

  /**
   * {@link metricPixelScaleAt} at `tile`'s centre latitude — the form every
   * per-tile sizing path wants.
   */
  protected metricPixelScale(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
    meters = 1,
  ): number {
    return this.metricPixelScaleAt(
      gl,
      tileCenterLatitude(tile.id.z, tile.id.y),
      ctx.zoom,
      meters,
    );
  }

  /**
   * Hit-test the feature under CSS pixel `(cssX, cssY)`. Renders the layer's
   * features into an offscreen id buffer (via the subclass {@link drawPickTile}
   * hook), reads back the cursor pixel and decodes it to an
   * {@link SttPickResult}. Returns null when the layer isn't pickable, hasn't
   * rendered yet, or the cursor is over empty space.
   *
   * The pass mirrors the layer's own visibility rules, including DEPTH: a
   * `renderingMode: '3d'` layer renders its frame depth-tested, so its id pass
   * runs depth-tested too (against the FBO's own depth attachment, see
   * {@link ensurePickFbo}) rather than letting draw order decide which of two
   * overlapping prisms owns a texel. A '2d' layer keeps the historical
   * depth-less pass, which is exactly how its frame paints.
   *
   * Every piece of GL state this pass touches is captured and restored: render
   * target, viewport, BLEND / DEPTH_TEST enables, the depth func / write mask /
   * range / clear value when a 3d pass installs its own, the clear colour, and
   * the bound vertex array. That is not defensive tidiness — a pick is normally issued
   * from a `mousemove` handler, i.e. OUTSIDE `painter.render()`, so maplibre
   * has neither run `setCustomLayerDefaults()` (which unbinds its VAO) before
   * nor `context.setDirty()` after. maplibre caches blend/depth/clearColor as
   * `BaseValue`s and SKIPS the GL call when the cached value already matches,
   * so anything we leave changed behind its back is not self-healing: the next
   * frame would clear to transparent black and draw the basemap unblended.
   * Browser-verify-only (needs a live GL FBO + `readPixels`); its CPU pieces
   * are unit-tested.
   */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const gl = this.gl;
    if (!gl || !this.map || !this.tileset || this.contextLost) return null;
    if (!this.supportsPicking() || !this.drawPickTile) return null;
    const matrix = this.lastMatrix;
    if (!matrix) return null; // no frame rendered yet.

    const provenance = this.buildPickProvenance(gl);
    if (provenance.length === 0) return null;

    // Capture the host's render target + viewport (MapLibre may be draping into
    // an offscreen target under terrain/globe) so we restore them afterwards.
    const prevFramebuffer = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
    const prevClearColor = gl.getParameter(
      gl.COLOR_CLEAR_VALUE,
    ) as Float32Array | null;
    // Depth MODE, captured only when this pass is going to install its own (a
    // '3d' layer). maplibre caches depthFunc/depthMask/clearDepth as BaseValues
    // and skips redundant calls, so leaving any of them changed behind its back
    // would not self-heal — the next frame would depth-test the basemap wrong.
    const depthPass = this.renderingMode === '3d';
    const prevDepthFunc = depthPass
      ? (gl.getParameter(gl.DEPTH_FUNC) as number)
      : 0;
    const prevDepthMask = depthPass
      ? (gl.getParameter(gl.DEPTH_WRITEMASK) as boolean)
      : true;
    const prevClearDepth = depthPass
      ? (gl.getParameter(gl.DEPTH_CLEAR_VALUE) as number)
      : 1;
    // The RANGE matters as much as the func here. A pick fires from a
    // `mousemove`, i.e. outside the host's render pass, so the range left
    // installed is whatever the last basemap layer used — for a 2d sublayer
    // that is a razor-thin per-layer slab, which would squeeze every prism's z
    // into a handful of the id buffer's 16 bits and z-fight the hit test.
    const prevDepthRange = depthPass
      ? (gl.getParameter(gl.DEPTH_RANGE) as Float32Array | null)
      : null;
    // The host's VAO, when a pick lands outside its render pass (see the
    // doc-comment): the raw attribute binds below would otherwise be recorded
    // into whatever vertex array the last basemap layer drew with.
    const prevVao = this.vaoSupport.current();

    this.ensurePickFbo(gl);
    const w = this.pickWidth;
    const h = this.pickHeight;
    if (w === 0 || h === 0) return null;

    if (this.vaoSupport.enabled) this.vaoSupport.bind(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo!);
    gl.viewport(0, 0, w, h);
    // Ids are exact — never blended, and cleared to the reserved id 0.
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    if (depthPass) {
      // A depth-tested layer must resolve its id buffer the way it resolves the
      // frame the user is looking at, or hovering the prism in FRONT can return
      // the one hidden behind it (whichever happened to be drawn last wins the
      // texel otherwise). LEQUAL + writes on over our OWN cleared depth buffer
      // reproduces maplibre's `depthRangeFor3D` ordering; the host's depth
      // RANGE is left alone because it only remaps z monotonically, which
      // cannot change which fragment is nearer.
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.depthRange(0, 1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // Frame-constant scalars the per-tile pick draws read (metric sizing,
    // fades); resolved here so the tile loop stays allocation- and DOM-free.
    this.refreshFadeDurations();
    this.frameZoom = this.map.getZoom();
    const currentTime = this.opts.currentTime;
    const zoom = Math.floor(this.frameZoom);
    for (const e of provenance) {
      const ctx: DrawContext = {
        matrix,
        // The scratch frame still holds the values of the frame `matrix`
        // was captured from — a pick necessarily follows a render.
        frame: this.hostFrame,
        currentTime,
        zoom,
        windowStart:
          currentTime - e.cache.timeOffset - this.opts.timeWindow / 2,
        windowEnd: currentTime - e.cache.timeOffset + this.opts.timeWindow / 2,
      };
      this.drawPickTile(gl, e.tile, e.layer, e.cache, ctx, e.idBase);
    }

    const dpr = this.resolveDevicePixelRatio(gl);
    const { x, y } = cssToDevicePixel(cssX, cssY, dpr, h);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pickBuffer);

    // Restore every piece of host state this pass changed (see the
    // doc-comment: maplibre's own cache will not repair it for us).
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.viewport(
      prevViewport[0],
      prevViewport[1],
      prevViewport[2],
      prevViewport[3],
    );
    if (prevBlend) gl.enable(gl.BLEND);
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (depthPass) {
      gl.depthFunc(prevDepthFunc);
      gl.depthMask(prevDepthMask);
      gl.clearDepth(prevClearDepth);
      if (prevDepthRange) gl.depthRange(prevDepthRange[0], prevDepthRange[1]);
    }
    if (prevClearColor) {
      gl.clearColor(
        prevClearColor[0],
        prevClearColor[1],
        prevClearColor[2],
        prevClearColor[3],
      );
    }
    if (this.vaoSupport.enabled) this.vaoSupport.bind(prevVao);

    return this.resolvePick(
      [this.pickBuffer[0], this.pickBuffer[1], this.pickBuffer[2]],
      provenance,
    );
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  /**
   * Drop every GPU cache entry belonging to one tile (entries are keyed
   * `z/x/y/t::layer::…`, so variant-suffixed keys — e.g. the line layer's
   * `…::globe:<granularity>` — are swept too). Shared by the per-layer
   * `onTileUnload` callback and the shared-source resident-set diff.
   */
  private sweepTileGpuCache(baseKey: string): void {
    const prefix = `${baseKey}::`;
    for (const [k, cache] of this.tileGpuCache) {
      if (!k.startsWith(prefix)) continue;
      if (cache && this.gl) this.deleteCacheBuffers(this.gl, cache);
      this.tileGpuCache.delete(k);
    }
  }

  /**
   * Shared-source init (D6a counterpart of {@link initTileset}): register as
   * a consumer for resident-set fan-out, make sure the source is loaded, and
   * adopt its tileset. Mirrors initTileset's removal-race guards.
   */
  private async initSharedSource(): Promise<void> {
    const gen = ++this.initGeneration;
    const source = this.source!;
    // Register BEFORE load: an already-loaded source seeds the current
    // resident set synchronously, so a late-added layer renders immediately.
    this.unregisterConsumer?.();
    this.unregisterConsumer = source.registerConsumer({
      id: this.id,
      onTilesChanged: (tiles) => this.handleSharedTiles(tiles),
      onBufferChange: (runway) => {
        this.opts.onBufferChange?.(runway);
      },
    });
    try {
      await source.load();
    } catch (err) {
      console.error(`[${this.id}] shared source failed to load:`, err);
      return;
    }
    // A remove (or remove-then-re-add — the re-add's own init owns the
    // publish) raced the load: abort so onTilesetReady fires once per init.
    if (gen !== this.initGeneration || !this.map) return;
    const tileset = source.getTileset();
    const metadata = source.getMetadata();
    if (!tileset) return; // source disposed while loading.
    if (metadata) this.metadata = metadata;
    // The source's structural DrivableTileset IS the real tileset whenever it
    // was built by load(); a test-attached mock only needs the surface the
    // base layer touches in shared mode (readiness guard + getTileset()).
    this.tileset = tileset as unknown as SpatiotemporalTileset;
    this.opts.onTilesetReady?.(this.tileset);
    this.map.triggerRepaint();
  }

  /**
   * Replace-all resident-set delivery from the shared source: swap
   * `loadedTiles` wholesale and sweep GPU caches for tiles that left the set
   * (the shared analogue of the per-layer `onTileLoad`/`onTileUnload` pair).
   */
  private handleSharedTiles(tiles: Tile[]): void {
    const next = new Map<string, Tile>();
    for (const tile of tiles) next.set(tileKey(tile.id), tile);
    for (const key of this.loadedTiles.keys()) {
      if (!next.has(key)) this.sweepTileGpuCache(key);
    }
    this.loadedTiles = next;
    this.map?.triggerRepaint();
  }

  private async initTileset(): Promise<void> {
    const gen = ++this.initGeneration;
    const archive = this.archive!; // per-layer mode only (see onAdd dispatch).
    let metadata: ArchiveMetadata;
    try {
      metadata = await archive.getMetadata();
    } catch (err) {
      console.error(`[${this.id}] failed to read archive metadata:`, err);
      return;
    }

    // A remove (or remove-then-re-add, whose own init takes over) raced the
    // metadata read: abort BEFORE building — assigning here would overwrite
    // the re-add's tileset with an orphan that is never finalized.
    if (gen !== this.initGeneration || !this.map) return;
    this.metadata = metadata;

    this.tileset = new SpatiotemporalTileset({
      maxRequests: this.opts.maxRequests,
      minZoom: this.metadata.minZoom,
      maxZoom: this.metadata.maxZoom,
      temporalBucketMs: this.metadata.temporalBucketMs,
      refinementStrategy: 'best-available', // Load parent tiles as fallback (deck.gl parity)
      enablePrefetch: this.opts.enablePrefetch,
      prefetchAhead: this.opts.prefetchAhead,
      prefetchSteps: this.opts.prefetchSteps,
      // Archive-backed fetch callbacks (getAvailableTiles / getTileData /
      // getTileDataBatch / getTileByteSize / getThroughput). Shared verbatim
      // with the deck + three adapters via the core tileset-adapter kernel — it
      // routes the bulk viewport/prefetch fill through the range coalescer,
      // carries incremental per-tile delivery + the fetch-priority hint, forwards
      // the cross-source EDF play-head hints, gates giant parent-fallback tiles
      // via getTileByteSize, and wires the coalesced-range throughput EWMA so
      // estimateTimeToReadyMs() computes honest ETAs. See
      // docs/roadmap/renderer-architecture.md.
      ...makeTilesetCallbacks(archive),
      // Buffered-runway threshold events from the tileset's coverage index,
      // forwarded to the app (which routes them into a PlaybackGovernor).
      onBufferChange: (runway) => {
        this.opts.onBufferChange?.(runway);
      },
      onTileLoad: (tile) => {
        this.loadedTiles.set(tileKey(tile.id), tile);
        this.map?.triggerRepaint();
      },
      onTileUnload: (tile) => {
        const baseKey = tileKey(tile.id);
        this.loadedTiles.delete(baseKey);
        this.sweepTileGpuCache(baseKey);
      },
    });

    // Defensive re-check for a removal that raced the (synchronous) build:
    // if onRemove ran, its `this.tileset?.finalize()` saw no tileset yet, so
    // finalize the one we just built and skip onTilesetReady — handing the
    // governor a source that can never render would strand it.
    if (gen !== this.initGeneration || !this.map) {
      this.tileset.finalize();
      this.tileset = undefined;
      return;
    }

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
