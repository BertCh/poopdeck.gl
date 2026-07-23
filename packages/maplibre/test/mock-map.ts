/**
 * Minimal fake MapLibre Map + canvas for lifecycle tests: a layer registry
 * whose addLayer/removeLayer dispatch the custom-layer onAdd/onRemove hooks,
 * an event emitter (on/off/fire), a triggerRepaint counter, the internal
 * `style._loaded` gate `addLayer` enforces (matching maplibre's
 * "Style is not done loading" throw), and a canvas stub whose
 * webglcontextlost/restored events tests can dispatch.
 *
 * Complements `mock-gl.ts`'s `makeMockMap` (bounds/zoom only) — use this one
 * whenever a test needs the real add/remove/styledata lifecycle.
 */

import { vi } from 'vitest';

export interface MockCanvas {
  clientWidth: number;
  clientHeight: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  /** Dispatch to the registered listeners (e.g. 'webglcontextlost'). */
  dispatch(type: string, ev?: unknown): void;
}

function makeMockCanvas(): MockCanvas {
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  return {
    clientWidth: 512,
    clientHeight: 384,
    addEventListener: vi.fn((type: string, fn: (ev: unknown) => void) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (ev: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    }),
    dispatch(type, ev = { preventDefault: vi.fn() }) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
    },
  };
}

/** The subset of a layer the mock map's registry interacts with. */
interface MockLayerLike {
  id: string;
  onAdd?(map: unknown, gl: unknown): void;
  onRemove?(): void;
}

export class MockMap {
  /**
   * Mirrors maplibre's internal `style._loaded` gate — flip to simulate a
   * still-loading style, or set the whole field `undefined` to simulate a Map
   * constructed without the optional `style` option / after `map.remove()`
   * (`delete this.style`).
   */
  style: { _loaded: boolean } | undefined = { _loaded: true };
  readonly triggerRepaint = vi.fn();
  /** Records every addLayer ATTEMPT (id, beforeId) — including ones the loaded-gate rejected. */
  readonly addLayerSpy = vi.fn();
  private readonly layers = new Map<string, MockLayerLike>();
  private layerOrder: string[] = [];
  private readonly handlers = new Map<string, Set<(ev: unknown) => void>>();
  private readonly canvas = makeMockCanvas();

  constructor(private readonly gl: unknown = {}) {}

  addLayer(layer: MockLayerLike, beforeId?: string): this {
    this.addLayerSpy(layer.id, beforeId);
    if (!this.style?._loaded) throw new Error('Style is not done loading');
    if (this.layers.has(layer.id)) {
      throw new Error(`Layer "${layer.id}" already exists on this map`);
    }
    if (beforeId !== undefined) {
      const i = this.layerOrder.indexOf(beforeId);
      if (i < 0) throw new Error(`Layer "${beforeId}" does not exist`);
      this.layerOrder.splice(i, 0, layer.id);
    } else {
      this.layerOrder.push(layer.id);
    }
    this.layers.set(layer.id, layer);
    layer.onAdd?.(this, this.gl);
    this.fire('styledata');
    return this;
  }

  removeLayer(id: string): this {
    const layer = this.layers.get(id);
    if (!layer) throw new Error(`Layer "${id}" does not exist`);
    this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter((l) => l !== id);
    layer.onRemove?.();
    this.fire('styledata');
    return this;
  }

  getLayer(id: string): MockLayerLike | undefined {
    // Mirrors maplibre exactly: `return this.style.getLayer(id)` with NO null
    // guard — a style-less map throws, which is what the layer's styleOf
    // probes exist to avoid.
    if (!this.style) {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'getLayer')",
      );
    }
    return this.layers.get(id);
  }

  moveLayer(id: string, beforeId?: string): this {
    if (!this.layers.has(id)) throw new Error(`Layer "${id}" does not exist`);
    this.layerOrder = this.layerOrder.filter((l) => l !== id);
    const i = beforeId !== undefined ? this.layerOrder.indexOf(beforeId) : -1;
    if (i >= 0) this.layerOrder.splice(i, 0, id);
    else this.layerOrder.push(id);
    return this;
  }

  getLayerOrder(): readonly string[] {
    return this.layerOrder;
  }

  on(type: string, fn: (ev: unknown) => void): this {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(type: string, fn: (ev: unknown) => void): this {
    this.handlers.get(type)?.delete(fn);
    return this;
  }

  fire(type: string, ev: unknown = {}): this {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(ev);
    return this;
  }

  getCanvas(): MockCanvas {
    return this.canvas;
  }

  getZoom(): number {
    return 2;
  }

  getBounds() {
    return {
      getWest: () => -180,
      getSouth: () => -85,
      getEast: () => 180,
      getNorth: () => 85,
    };
  }

  /**
   * Simulate a `setStyle` diff-fallback rebuild: every layer (custom layers
   * included — maplibre does NOT preserve them on this path) is destroyed,
   * then `styledata` fires on the fresh style. On real maplibre v4.7 the
   * rebuild (`_updateStyle` → `Style._remove`) NEVER calls custom-layer
   * onRemove — pass `{ fireOnRemove: false }` to model that host; the
   * default keeps the historical does-fire behavior (v5-style hosts).
   */
  simulateStyleRebuild(opts: { fireOnRemove?: boolean } = {}): void {
    const fireOnRemove = opts.fireOnRemove ?? true;
    for (const id of [...this.layers.keys()]) {
      const layer = this.layers.get(id)!;
      this.layers.delete(id);
      if (fireOnRemove) layer.onRemove?.();
    }
    this.layerOrder = [];
    this.fire('styledata');
  }

  /**
   * Simulate `Map.remove()` (verified against maplibre v4.7): `setStyle(null)`
   * drops every layer WITHOUT custom-layer onRemove and deletes `this.style`,
   * the GL context is force-lost, and the terminal 'remove' event fires last.
   */
  remove(): void {
    this.layers.clear();
    this.layerOrder = [];
    this.style = undefined;
    this.canvas.dispatch('webglcontextlost');
    this.fire('remove');
  }
}
