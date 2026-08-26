// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * The shared Cesium machinery behind `STTPathLayer` and `STTArcLayer`:
 * one batched `Primitive` of `PolylineGeometry` instances with a per-instance
 * `ColorGeometryInstanceAttribute` — Cesium's idiomatic way to animate many
 * geometry colours (one draw-call bucket; a colour write is a batch-table
 * texel update, not a rebatch).
 *
 * Per-frame animation mirrors `STTPointLayer.setTime`: the kernel
 * `timeFilterAlpha` oracle computes each feature's alpha, unchanged alphas are
 * skipped, and the write reuses one scratch `Uint8Array` (the batch-table
 * setter copies the value immediately). Colour handles come from
 * `getGeometryInstanceAttributes`, which exists only after the primitive's
 * first render — `setTime` runs on `scene.preRender` every frame, so handles
 * are cached lazily the first frame `primitive.ready` is true.
 *
 * Rendering needs a live Cesium `Scene` → browser-verify-only; the pure
 * builders it consumes (`lib/polylines.ts`) are unit-tested.
 */

import {
  ArcType,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  PolylineColorAppearance,
  PolylineGeometry,
  Primitive,
  defined,
  type Scene,
} from 'cesium';
import { getFeatureProperties, type BinaryFeatures } from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import type { FeaturePolyline, PolylineBuild } from './lib/polylines.js';
import {
  compileExtensions,
  type CesiumLayerExtension,
  type CompiledExtensions,
} from './lib/extensions.js';

/** Pick/attribute identity for one polyline instance. */
interface InstanceId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface PolylineEntry {
  id: InstanceId;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // base colour channels (0–255) — batch-table colours are u8
  g: number;
  b: number;
  a: number; // base alpha 0..1, multiplied by the time-filter alpha
  lastAlpha: number;
  /** Batch-table colour handle; cached on the first ready frame. */
  attrs: { color: Uint8Array } | null;
  lon: number; // first vertex, for SttPickResult.coordinate
  lat: number;
}

export interface STTBatchedPolylineOptions {
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /** Line width in pixels. @default 3 */
  width?: number;
  /**
   * Vertex-to-vertex interpolation. `'none'` draws straight 3-D segments
   * between the (already-sampled/dense) vertices — required for data with
   * altitude; `'geodesic'` subdivides along the ellipsoid surface (sparse
   * ground-hugging lines). @default 'none'
   */
  arcType?: 'none' | 'geodesic' | 'rhumb';
  /**
   * User extensions — per-feature hooks composed ON TOP of the resolved alpha
   * and colour (`lib/extensions.ts`, the `userExtensions` capability). Declared
   * here rather than on the two wrappers deliberately: `STTPathLayerOptions`
   * extends this interface and `STTArcLayerOptions` extends `Omit<…,'arcType'>`
   * of it, and both hand their whole options object to this constructor, so
   * `path` / `line` / `arc` inherit the seam without either file changing.
   *
   * Channels reaching a hook are 0..1, the same contract every layer's
   * extensions see; this layer's own storage is u8 (batch-table colours are
   * bytes), so it converts either side of the call. That conversion is the only
   * cost the extension path adds here, and it is inside the `ext !== null`
   * branch — an empty or absent list compiles to `null` and this loop is
   * byte-for-byte the one it always was.
   */
  extensions?: readonly CesiumLayerExtension[];
}

// Reused for every per-frame colour write; the batch-table setter copies the
// four bytes immediately, so one shared scratch is safe (same argument as the
// point layer's SCRATCH_COLOR).
const SCRATCH_RGBA = new Uint8Array(4);

/** u8 → 0..1 for the extension contract; the round trip is exact after `Math.round`. */
const INV_255 = 1 / 255;

/** Map the option string onto Cesium's enum (default `'none'`). */
function toArcType(a: STTBatchedPolylineOptions['arcType']): ArcType {
  if (a === 'geodesic') return ArcType.GEODESIC;
  if (a === 'rhumb') return ArcType.RHUMB;
  return ArcType.NONE;
}

/**
 * Owns the batched primitive + per-frame colour animation. `STTPathLayer` /
 * `STTArcLayer` compose this with their pure geometry builder.
 */
export class STTBatchedPolylineLayer {
  private readonly scene: Scene;
  private readonly layerId: string;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly width: number;
  private readonly arcType: ArcType;
  /** Folded user extensions, or `null` — the zero-cost case. */
  private readonly ext: CompiledExtensions | null;
  private primitive: Primitive | null = null;
  private entries: PolylineEntry[] = [];
  private attrsCached = false;
  private timeOrigin = 0;

  constructor(
    scene: Scene,
    layerId: string,
    options: STTBatchedPolylineOptions = {},
  ) {
    this.scene = scene;
    this.layerId = layerId;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.width = options.width ?? 3;
    this.arcType = toArcType(options.arcType);
    // Compile once, at construction: a bad list (blank/duplicate name) throws
    // here rather than on the first drawn frame.
    this.ext = compileExtensions(options.extensions, layerId);
  }

  /** Replace the rendered polylines (replace-all, like `STTPointLayer.setTiles`). */
  setPolylines(build: PolylineBuild): void {
    // Bail on an empty build BEFORE destroying the standing primitive: selection
    // reports an empty visible set for the frames between a viewport change and
    // the first decoded tile of the new set, and tearing down first turns that
    // transient into a blank frame (the "tiles in view flash out" symptom). The
    // held-over lines stay geographically correct — the camera has moved on from
    // them, it is not being shown something false.
    if (build.polylines.length === 0) return;
    if (this.primitive) {
      this.scene.primitives.remove(this.primitive); // destroys the primitive
      this.primitive = null;
    }
    this.entries = [];
    this.attrsCached = false;
    this.timeOrigin = build.timeOrigin;

    const instances: GeometryInstance[] = [];
    for (const p of build.polylines) {
      const numVerts = p.positions.length / 3;
      const positions: Cartesian3[] = new Array(numVerts);
      for (let v = 0; v < numVerts; v++) {
        positions[v] = new Cartesian3(
          p.positions[v * 3],
          p.positions[v * 3 + 1],
          p.positions[v * 3 + 2],
        );
      }
      const id: InstanceId = {
        layerId: this.layerId,
        binary: p.binary,
        featureIndex: p.featureIndex,
      };
      const a = (p.color[3] ?? 255) / 255;
      instances.push(
        new GeometryInstance({
          geometry: new PolylineGeometry({
            positions,
            width: this.width,
            vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
            arcType: this.arcType,
          }),
          attributes: {
            // Seed fully transparent; the first setTime writes the real alpha.
            color: ColorGeometryInstanceAttribute.fromColor(
              new Color(
                p.color[0] / 255,
                p.color[1] / 255,
                p.color[2] / 255,
                0,
              ),
            ),
          },
          id,
        }),
      );
      this.entries.push({
        id,
        start: p.start,
        end: p.end,
        r: p.color[0],
        g: p.color[1],
        b: p.color[2],
        a,
        lastAlpha: NaN,
        attrs: null,
        lon: this.firstLon(p),
        lat: this.firstLat(p),
      });
    }

    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PolylineColorAppearance({ translucent: true }),
      asynchronous: false, // deterministic replace-all; no worker round-trip per tile load
    });
    this.scene.primitives.add(this.primitive);
  }

  private firstLon(p: FeaturePolyline): number {
    const dims = p.binary.positionDimensions ?? 2;
    const v0 = p.binary.startIndices
      ? p.binary.startIndices[p.featureIndex]
      : 0;
    return p.binary.positions[v0 * dims];
  }

  private firstLat(p: FeaturePolyline): number {
    const dims = p.binary.positionDimensions ?? 2;
    const v0 = p.binary.startIndices
      ? p.binary.startIndices[p.featureIndex]
      : 0;
    return p.binary.positions[v0 * dims + 1];
  }

  /**
   * Advance to an absolute playhead time (same contract as `STTPointLayer.setTime`).
   *
   * User extensions compose ON TOP of the oracle's alpha and the resolved
   * colour, never in place of them — the hook's argument IS
   * `e.a * timeFilterAlpha(...)`. They run BEFORE the skip compare and the
   * compare tests the COMPOSED alpha; a `color` hook clears `skipUnchanged`
   * altogether, because a cache keyed on alpha cannot see a colour move. With no
   * extensions `ext` is `null` and none of that is reached.
   */
  setTime(absoluteMs: number): void {
    const prim = this.primitive;
    if (!prim || !prim.ready) return; // batch table exists only after the first render
    if (!this.attrsCached) {
      for (const e of this.entries) {
        e.attrs = prim.getGeometryInstanceAttributes(e.id) as {
          color: Uint8Array;
        };
      }
      this.attrsCached = true;
    }

    const cur = absoluteMs - this.timeOrigin;
    const v = SCRATCH_RGBA;
    const ext = this.ext;
    if (ext !== null) ext.beginFrame(cur);
    const skipUnchanged = ext === null || ext.skipUnchanged;
    for (const e of this.entries) {
      let alpha =
        e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      let r = e.r;
      let g = e.g;
      let b = e.b;
      if (ext !== null) {
        const out = ext.apply(
          alpha,
          e.start,
          e.end,
          e.id.binary,
          e.id.featureIndex,
          e.r * INV_255,
          e.g * INV_255,
          e.b * INV_255,
        );
        alpha = out.alpha;
        // Back to u8. Rounding (not the Uint8Array store's truncation) keeps an
        // identity colour hook a true identity: 200 → 200/255 → ×255 is
        // 199.999…, which would truncate to 199 and drift a channel per frame.
        r = Math.round(out.r * 255);
        g = Math.round(out.g * 255);
        b = Math.round(out.b * 255);
      }
      if ((skipUnchanged && alpha === e.lastAlpha) || !e.attrs) continue;
      e.lastAlpha = alpha;
      v[0] = r;
      v[1] = g;
      v[2] = b;
      v[3] = Math.round(alpha * 255);
      e.attrs.color = v; // setter copies the bytes into the batch table
    }
  }

  /** Hit-test → the shared `SttPickResult`. */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | { id?: InstanceId }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.layerId)
      return null;
    const { binary, featureIndex } = picked.id;
    const entry = this.entries.find(
      (e) => e.id.binary === binary && e.id.featureIndex === featureIndex,
    );
    return {
      object: getFeatureProperties(binary, featureIndex),
      index: featureIndex,
      layerId: this.layerId,
      coordinate: entry ? [entry.lon, entry.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  dispose(): void {
    if (this.primitive) {
      this.scene.primitives.remove(this.primitive);
      this.primitive = null;
    }
    this.entries = [];
  }
}
