/**
 * STTLayerGroup — ONE MapLibre custom layer hosting an ordered list of STT
 * layers, driving them all in a single render pass (campaign D6b).
 *
 * ## Why
 *
 * Every custom layer costs the map a full lazy GL state re-apply per frame:
 * MapLibre runs `setCustomLayerDefaults()` + `context.setDirty()` around each
 * one and rebinds its framebuffer (`base-layer.ts` painter-contract notes,
 * campaign §1.1). A composite that stacks N STT layers on one map (the weather
 * suite, AV static substrates) therefore pays that cycle N times. Hosting the N
 * layers behind ONE custom layer collapses it to a single cycle — the same
 * amortization deck's `MapboxLayerGroup` performs (N deck layers behind one
 * hosting custom layer). This is a NATIVE analogue: no deck/luma dependency.
 *
 * ## How it reuses the existing base-layer API (no base-layer edit)
 *
 * `STTBaseLayer` already separates INITIALIZATION from MAP-REGISTRATION:
 *   - `onAdd(map, gl)` allocates programs, wires the tileset and installs the
 *     canvas/`remove` listeners — it is the callback MapLibre fires *after* a
 *     layer is registered, but it is a plain public method that does not itself
 *     touch the map's layer registry.
 *   - `render(gl, args, options)` draws one frame (normalizing whatever host
 *     signature arrived through its own scratch `HostFrame`).
 *   - `onRemove()` tears everything down.
 * Registration into the style is done SEPARATELY by `map.addLayer(layer)`.
 *
 * So the group calls each child's `onAdd`/`render`/`onRemove` DIRECTLY, and
 * never registers a child with `map.addLayer` — every child renders through the
 * group, not as its own map layer. That is exactly the "render into a
 * host-provided frame without being a standalone map layer" contract the D6b
 * task calls for, and the current base-layer API already satisfies it.
 *
 * ## Repaint coalescing (task item 4)
 *
 * Children still hold a map reference and call `map.triggerRepaint()` on time
 * advance and on tile load. To make the GROUP the single repaint hook — "the
 * group installs ONE autoRepaint hook; children do not each triggerRepaint" —
 * every child is handed a thin {@link Proxy} over the real map that intercepts
 * ONLY `triggerRepaint`, routing it into {@link STTLayerGroup.requestRepaint}.
 * Batch updates ({@link STTLayerGroup.setCurrentTime} /
 * {@link STTLayerGroup.setTimeWindow}) suspend the hook while fanning out and
 * fire exactly one real `triggerRepaint` afterwards, so advancing N children
 * costs one repaint, not N. Every other map method forwards to the real map
 * unchanged (bound, and cached so the render hot path allocates nothing).
 *
 * ## Ordering
 *
 * Children draw in array order; because STT layers paint always-on-top in draw
 * order (depth test disabled, `applySharedGlState`), a later child paints over
 * an earlier one — the same stacking a caller would get from adding the layers
 * back-to-front. `beforeId`/`slot` position the WHOLE group in the basemap's
 * layer stack (`beforeId` for MapLibre/Mapbox `addLayer`, `slot` for Mapbox
 * Standard-style ordering), not the children within it.
 *
 * ## Scope
 *
 * This is the single-anchor ordered host (one `beforeId`/`slot` for the group).
 * deck's group additionally BUCKETS sublayers by distinct `beforeId` into
 * several hosting custom layers; a caller wanting that constructs one
 * STTLayerGroup per anchor. Composites should pair the group with ONE
 * `SharedTilesetSource` (D6a) so the stacked layers also share a single archive
 * + governor `BufferSource`.
 */

import type { CustomLayerInterface, Map as MaplibreMap } from 'maplibre-gl';
import type { STTBaseLayer } from './base-layer.js';
import type { SttPickResult } from '@poopdeck.gl/core/picking';

/**
 * `map.style` is legitimately absent on a Map built without the `style` option
 * and after `map.remove()` (`delete this.style`), and `map.getLayer` is
 * `this.style.getLayer(id)` with no null guard. Every getLayer/moveLayer call
 * site probes this first — mirrors the identical helper in `base-layer.ts`.
 */
const styleOf = (map: MaplibreMap): { _loaded?: boolean } | undefined =>
  (map as unknown as { style?: { _loaded?: boolean } }).style;

/** The optional offscreen-pass hook a child may expose (heatmap, pick FBO). */
interface PrerenderCapable {
  prerender?: (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ) => void;
}

const hasPrerender = (layer: STTBaseLayer): boolean =>
  typeof (layer as unknown as PrerenderCapable).prerender === 'function';

export interface STTLayerGroupOptions {
  /** Unique id passed to MapLibre for the hosting custom layer. */
  id: string;
  /**
   * The STT layers this group hosts, in DRAW ORDER (later paints over earlier).
   * They must NOT also be added to the map individually — the group owns their
   * onAdd/render/onRemove lifecycle. A copy is taken, so mutating the passed
   * array afterwards has no effect.
   */
  layers: STTBaseLayer[];
  /**
   * Position the whole group before this basemap layer when it is added via
   * {@link STTLayerGroup.attach} (MapLibre/Mapbox `addLayer` semantics; omit =
   * top). Stored for re-adds across style rebuilds.
   */
  beforeId?: string;
  /**
   * Mapbox Standard-style slot (`'bottom'|'middle'|'top'`) for the whole group.
   * Read structurally by Mapbox at add time; ignored by MapLibre, which has no
   * slots. Never triggers a mapbox-gl dependency.
   */
  slot?: string;
}

/**
 * A single MapLibre/Mapbox custom layer that hosts and drives an ordered list
 * of {@link STTBaseLayer} instances. See the module header for the design.
 */
export class STTLayerGroup implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  /**
   * `'3d'` iff ANY child is 3d, so MapLibre installs the shared read-write
   * depth slab the extruded/arc children need; `'2d'` when every child paints
   * flat always-on-top.
   */
  readonly renderingMode: '2d' | '3d';
  /** Mapbox slot for the whole group (structural; see options). */
  readonly slot?: string;
  /** The hosted layers, in draw order (defensive copy of the option). */
  readonly layers: readonly STTBaseLayer[];

  /**
   * Present only when at least one child exposes an offscreen pass. Installed
   * conditionally so MapLibre does not schedule an empty prerender pass for a
   * group of screen-only layers. Forwards the frame args to every capable
   * child in order.
   */
  prerender?: (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ) => void;

  private beforeId?: string;

  /** The real host map/context while added; undefined when removed. */
  private map?: MaplibreMap;
  private gl?: WebGLRenderingContext | WebGL2RenderingContext;

  /** The repaint-intercepting proxy handed to children, and the map it wraps. */
  private hostProxy?: MaplibreMap;
  private hostProxyFor?: MaplibreMap;

  // ── repaint coalescing ──────────────────────────────────────────────────
  /** > 0 while a batch update is fanning out; child repaints are deferred. */
  private suspendDepth = 0;
  /** A child asked to repaint while suspended; flushed once when the batch ends. */
  private pendingRepaint = false;

  // ── attach guard (styledata re-add), mirrors STTBaseLayer.attach ─────────
  private attachedMap?: MaplibreMap;
  private autoReadd = false;

  constructor(opts: STTLayerGroupOptions) {
    this.id = opts.id;
    this.layers = [...opts.layers];
    this.slot = opts.slot;
    this.beforeId = opts.beforeId;
    this.renderingMode = this.layers.some((l) => l.renderingMode === '3d')
      ? '3d'
      : '2d';
    if (this.layers.some(hasPrerender)) {
      this.prerender = (gl, matrixOrArgs, options): void => {
        for (const child of this.layers) {
          const fn = (child as unknown as PrerenderCapable).prerender;
          if (typeof fn === 'function')
            fn.call(child, gl, matrixOrArgs, options);
        }
      };
    }
  }

  // ------------------------------------------------------------------------
  // Repaint hook — the ONE autoRepaint hook for the whole group.
  // ------------------------------------------------------------------------

  /**
   * The single repaint entry point every child routes through (via the host
   * proxy) instead of touching the real map. Deferred while a batch update is
   * in flight so N child advances collapse to one real `triggerRepaint`.
   * Arrow field so it can BE the proxy's `triggerRepaint`.
   */
  private readonly requestRepaint = (): void => {
    if (this.suspendDepth > 0) {
      this.pendingRepaint = true;
      return;
    }
    this.map?.triggerRepaint();
  };

  /**
   * Run `fn` (a fan-out over children) with the repaint hook suspended, then
   * fire at most one real repaint if any child asked for one.
   */
  private batch(fn: () => void): void {
    this.suspendDepth++;
    try {
      fn();
    } finally {
      this.suspendDepth--;
      if (this.suspendDepth === 0 && this.pendingRepaint) {
        this.pendingRepaint = false;
        this.map?.triggerRepaint();
      }
    }
  }

  /**
   * A `Proxy` over the real map that intercepts ONLY `triggerRepaint` (routing
   * it into {@link requestRepaint}) and forwards every other property to the
   * real map — methods bound to it and cached so the render hot path allocates
   * nothing after warmup. Reused while the wrapped map is unchanged so a child
   * `onAdd` re-run (style-rebuild re-add) sees the same map reference and its
   * own idempotence short-circuit holds.
   */
  private ensureHostProxy(realMap: MaplibreMap): MaplibreMap {
    if (this.hostProxy && this.hostProxyFor === realMap) return this.hostProxy;
    const requestRepaint = this.requestRepaint;
    const boundCache = new Map<PropertyKey, unknown>();
    const proxy = new Proxy(realMap as object, {
      get: (target, prop): unknown => {
        if (prop === 'triggerRepaint') return requestRepaint;
        const cached = boundCache.get(prop);
        if (cached !== undefined) return cached;
        const value = Reflect.get(target, prop, target);
        if (typeof value === 'function') {
          const bound = value.bind(target);
          boundCache.set(prop, bound);
          return bound;
        }
        return value;
      },
    }) as unknown as MaplibreMap;
    this.hostProxy = proxy;
    this.hostProxyFor = realMap;
    return proxy;
  }

  // ------------------------------------------------------------------------
  // CustomLayerInterface
  // ------------------------------------------------------------------------

  /**
   * MapLibre calls this after the group is registered. It initializes every
   * child against the SAME context via the repaint-intercepting host proxy,
   * WITHOUT registering any child with `map.addLayer` — children render only
   * through this group. Idempotent on a same-map/context re-add (a v4.7 diff
   * rebuild that skips `onRemove`): the guard short-circuits so children are
   * not re-initialized on a live context whose resources are still valid.
   */
  onAdd(
    map: MaplibreMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.map === map && this.gl === gl) return;
    if (this.map) this.onRemove();
    this.map = map;
    this.gl = gl;
    const proxy = this.ensureHostProxy(map);
    for (const child of this.layers) child.onAdd(proxy, gl);
    // `map.remove()` never calls custom-layer onRemove (base-layer note): each
    // child registered its OWN terminal-remove hook through the proxy, so they
    // self-tear-down; this hook only drops the group's own state + guard.
    (map as unknown as { on?: (type: string, fn: () => void) => void }).on?.(
      'remove',
      this.handleMapRemove,
    );
  }

  /**
   * Tear down every hosted child (this is the ONLY path children get torn down
   * on `removeLayer`/`detach` — they are not map layers, so MapLibre never
   * calls their onRemove) and drop the group's own state. Children removed via
   * their own onRemove also detach the per-child terminal-remove hook, so a
   * later `map.remove()` cannot double-fire them.
   */
  onRemove(): void {
    (
      this.map as unknown as
        | { off?: (type: string, fn: () => void) => void }
        | undefined
    )?.off?.('remove', this.handleMapRemove);
    for (const child of this.layers) child.onRemove();
    this.map = undefined;
    this.gl = undefined;
    this.hostProxy = undefined;
    this.hostProxyFor = undefined;
  }

  /**
   * Forward the SAME normalized-nothing host args to each child in draw order.
   * Each child runs its own `beginFrame` normalization over the identical
   * `matrixOrArgs`/`options`, so they all agree on the projection variant while
   * the map pays only ONE custom-layer state cycle (this group).
   */
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrixOrArgs?: unknown,
    options?: unknown,
  ): void {
    if (!this.map) return;
    for (const child of this.layers) child.render(gl, matrixOrArgs, options);
  }

  // ------------------------------------------------------------------------
  // Add / remove with a styledata re-add guard (mirrors STTBaseLayer.attach).
  // ------------------------------------------------------------------------

  /**
   * Add the group to `map` with an auto re-add guard: a `setStyle` diff-fallback
   * rebuild silently destroys custom layers (without calling onRemove on some
   * hosts), and the installed `styledata` guard re-adds the group — and thus
   * re-initializes every child — whenever a rebuild dropped it. Uses the
   * group's `beforeId` (constructor value, or the one passed here). Idempotent;
   * re-attaching with a new `beforeId` repositions via `moveLayer`. Remove via
   * {@link detach}. A plain `map.addLayer(group)` also works and gets NO guard.
   */
  attach(map: MaplibreMap, opts?: { beforeId?: string }): void {
    if (this.attachedMap && this.attachedMap !== map) this.detach();
    const wasAttached = this.attachedMap === map;
    const prevBeforeId = this.beforeId;
    if (opts && 'beforeId' in opts) this.beforeId = opts.beforeId;
    if (!wasAttached) {
      this.attachedMap = map;
      map.on('styledata', this.handleStyledata);
    }
    this.autoReadd = true;
    this.ensureAttachedLayer();
    if (
      wasAttached &&
      this.beforeId !== prevBeforeId &&
      styleOf(map) &&
      map.getLayer(this.id)
    ) {
      try {
        map.moveLayer(this.id, this.beforeId);
      } catch {
        // Anchor missing from the current style — keep position; a rebuild
        // re-add applies the stored beforeId.
      }
    }
  }

  /**
   * Undo {@link attach}: disarm the guard, drop the styledata listener, and
   * remove the group from the map (which tears down every child via
   * {@link onRemove}). Safe to call repeatedly, when never attached, or after
   * `map.remove()` (style-less map — nothing left to remove).
   */
  detach(): void {
    const map = this.attachedMap;
    this.autoReadd = false;
    if (!map) return;
    map.off('styledata', this.handleStyledata);
    this.attachedMap = undefined;
    if (!styleOf(map)) return;
    if (map.getLayer(this.id)) map.removeLayer(this.id);
  }

  private readonly handleStyledata = (): void => {
    this.ensureAttachedLayer();
  };

  private ensureAttachedLayer(): void {
    const map = this.attachedMap;
    if (!map || !this.autoReadd) return;
    const style = styleOf(map);
    if (!style) return;
    if (map.getLayer(this.id)) return;
    if (style._loaded === false) return;
    try {
      map.addLayer(this, this.beforeId);
    } catch {
      // Style raced us ('Style is not done loading') — retry on styledata.
    }
  }

  /**
   * Terminal `map.remove()` cleanup. Children self-tear-down via their own
   * per-child remove hooks; this only disarms the guard and drops group state,
   * so children are never torn down twice.
   */
  private readonly handleMapRemove = (): void => {
    this.detach();
    this.map = undefined;
    this.gl = undefined;
    this.hostProxy = undefined;
    this.hostProxyFor = undefined;
  };

  // ------------------------------------------------------------------------
  // Group-level driving API (coalesced).
  // ------------------------------------------------------------------------

  /**
   * Advance every child to time `t` with a SINGLE coalesced repaint (children
   * route their repaints through the group's suspended hook while fanning out).
   */
  setCurrentTime(t: number): void {
    this.batch(() => {
      for (const child of this.layers) child.setCurrentTime(t);
    });
  }

  /** Replace every child's time window (ms) with a single coalesced repaint. */
  setTimeWindow(ms: number): void {
    this.batch(() => {
      for (const child of this.layers) child.setTimeWindow(ms);
    });
  }

  /**
   * Hit-test the composite: query pickable children from TOPMOST (last drawn)
   * to bottom and return the first hit, so the feature the user sees on top
   * wins — the id-buffer analogue of draw order. Null when nothing is under the
   * cursor or no child is pickable. Uses each child's own `pick` (public API).
   */
  pick(cssX: number, cssY: number): SttPickResult | null {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const child = this.layers[i];
      if (!child.supportsPicking()) continue;
      const hit = child.pick(cssX, cssY);
      if (hit) return hit;
    }
    return null;
  }
}
