// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Animated vehicle trails for CesiumJS — the Cesium analogue of deck's
 * `AnimatedTripsLayer`. Cesium's stock polyline has no per-vertex shader hook,
 * so the trail is realized as GEOMETRY instead of alpha: every frame each
 * active trip is trimmed to `[t - trailLength, t]` by the kernel's `trimTrail`
 * (interpolated head + tail vertices) and written into a `PolylineCollection`
 * polyline — the Cesium primitive built for per-frame position updates.
 *
 * The tail fade (`fadeTrail`) is a tiny custom polyline material that ramps
 * alpha along the line's normalized arc length (`materialInput.st.s`, 0 at the
 * trimmed tail → 1 at the head). That is a GEOMETRIC fade, not the per-vertex
 * TIME fade deck/three compute — visually equivalent for smoothly-sampled
 * trips, and documented as a deviation. Trips sharing a colour share one
 * material instance so the collection still batches by material.
 *
 * Per-frame cost is proportional to the number of ACTIVE trips (inactive ones
 * are a `show` check); allocation per active trip is one wrapper array — the
 * `Cartesian3` vertices live in a per-trip grow-only pool, and Cesium's
 * `positions` setter requires a fresh array identity to mark the line dirty.
 *
 * Rendering needs a live Cesium `Scene` → browser-verify-only; `trimTrail` and
 * `buildTripIndex` are unit-tested in core.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  Material,
  PolylineCollection,
  defined,
  type Polyline,
  type Scene,
} from 'cesium';
import { GeometryType, getFeatureProperties, type BinaryFeatures, type Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { buildTripIndex, trimTrail, type Trip } from '@poopdeck.gl/core/trips';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import { featureColor, type FeatureColorMode } from './lib/feature-color';

export interface CesiumTripsLayerOptions {
  id?: string;
  /** Trail duration in ms behind the playhead. @default 300_000 (5 min) */
  trailLength?: number;
  /** Per-trip colour (constant / categorical / ramp). @default constant */
  color?: FeatureColorMode;
  /** Trail width in pixels. @default 3 */
  width?: number;
  /** Fade the tail to transparent along the trail (vs. a hard cut). @default true */
  fadeTrail?: boolean;
}

interface TripEntry {
  trip: Trip;
  polyline: Polyline;
  /** Grow-only Cartesian3 pool the per-frame trim writes into. */
  pool: Cartesian3[];
  active: boolean;
}

const DEFAULT_COLOR: RGBA255 = [200, 205, 215, 255];

/**
 * One fabric shared by every trail material: diffuse = colour, alpha ramps
 * linearly tail→head along the trimmed polyline. Registered once per type
 * name; per-colour instances only differ in the `color` uniform, so trips of
 * the same colour batch together.
 */
const TRAIL_FABRIC_TYPE = 'SttTrailFade';
const TRAIL_FABRIC_SOURCE = `czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    material.diffuse = color.rgb;
    material.alpha = color.a * materialInput.st.s;
    return material;
}`;

function makeTrailMaterial(rgba: RGBA255, fade: boolean): Material {
  const color = new Color(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, (rgba[3] ?? 255) / 255);
  if (!fade) return Material.fromType('Color', { color });
  return new Material({
    fabric: {
      type: TRAIL_FABRIC_TYPE,
      uniforms: { color },
      source: TRAIL_FABRIC_SOURCE,
    },
    translucent: true,
  });
}

// The WGS84 globe — Cesium's native frame.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, { datum: 'wgs84' });

export class CesiumTripsLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PolylineCollection;
  private readonly trailLength: number;
  private readonly colorMode: FeatureColorMode;
  private readonly width: number;
  private readonly fadeTrail: boolean;
  private entries: TripEntry[] = [];
  private origin: [number, number, number] = [0, 0, 0];
  private timeOrigin = 0;
  /** Reused trim output (grow-only): interleaved x,y,z relative to `origin`. */
  private trimScratch = new Float64Array(0);
  /** Materials keyed by resolved RGBA so same-colour trips batch. */
  private materials = new Map<string, Material>();

  constructor(scene: Scene, options: CesiumTripsLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-trips';
    this.scene = scene;
    this.trailLength = options.trailLength ?? 300_000;
    this.colorMode = options.color ?? { type: 'constant', color: DEFAULT_COLOR };
    this.width = options.width ?? 3;
    this.fadeTrail = options.fadeTrail ?? true;
    this.collection = new PolylineCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build the trip index from decoded tiles (replace-all). */
  setTiles(tiles: Tile[]): void {
    this.collection.removeAll();
    this.entries = [];
    this.materials.clear();

    // Scene-wide time origin = first LineString layer's timeOffset (the same
    // convention as every other layer in this package).
    this.timeOrigin = 0;
    outer: for (const tile of tiles) {
      for (const tl of tile.layers) {
        const b = tl.features;
        if (b.geometryType === GeometryType.LineString && b.featureCount > 0 && b.startIndices) {
          this.timeOrigin = b.timeOffset;
          break outer;
        }
      }
    }

    const index = buildTripIndex(tiles, GLOBE, this.timeOrigin, { precision: 'f64' });
    this.origin = index.origin;

    let maxVerts = 0;
    for (const trip of index.trips) {
      const rgba = featureColor(trip.binary, trip.featureIndex, this.colorMode);
      const key = rgba.join(',');
      let material = this.materials.get(key);
      if (!material) {
        material = makeTrailMaterial(rgba, this.fadeTrail);
        this.materials.set(key, material);
      }
      const polyline = this.collection.add({
        positions: [],
        width: this.width,
        material,
        show: false,
        id: { layerId: this.id, binary: trip.binary, featureIndex: trip.featureIndex },
      });
      this.entries.push({ trip, polyline, pool: [], active: false });
      if (trip.numVerts > maxVerts) maxVerts = trip.numVerts;
    }
    // trimTrail writes at most numVerts + 2 vertices.
    if (this.trimScratch.length < (maxVerts + 2) * 3) {
      this.trimScratch = new Float64Array((maxVerts + 2) * 3);
    }
  }

  /** Advance to an absolute playhead time; trim every active trail. */
  setTime(absoluteMs: number): void {
    const cur = absoluteMs - this.timeOrigin;
    const [ox, oy, oz] = this.origin;
    const scratch = this.trimScratch;

    for (const e of this.entries) {
      const n = trimTrail(e.trip, cur, this.trailLength, scratch);
      if (n < 2) {
        // Inactive (or degenerate single-vertex window) — hide, once.
        if (e.active) {
          e.polyline.show = false;
          e.active = false;
        }
        continue;
      }
      // Grow the pool to n, then write the trimmed vertices into it.
      while (e.pool.length < n) e.pool.push(new Cartesian3());
      const positions: Cartesian3[] = new Array(n);
      for (let v = 0; v < n; v++) {
        const c = e.pool[v];
        c.x = scratch[v * 3] + ox;
        c.y = scratch[v * 3 + 1] + oy;
        c.z = scratch[v * 3 + 2] + oz;
        positions[v] = c;
      }
      e.polyline.positions = positions; // fresh array identity marks the line dirty
      if (!e.active) {
        e.polyline.show = true;
        e.active = true;
      }
    }
  }

  /** Hit-test → the shared `SttPickResult`. */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | { id?: { layerId: string; binary: BinaryFeatures; featureIndex: number } }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id) return null;
    const { binary, featureIndex } = picked.id;
    const dims = binary.positionDimensions ?? 2;
    const v0 = binary.startIndices ? binary.startIndices[featureIndex] : 0;
    return {
      object: getFeatureProperties(binary, featureIndex),
      index: featureIndex,
      layerId: this.id,
      coordinate: [binary.positions[v0 * dims], binary.positions[v0 * dims + 1]],
      screen: [cssX, cssY],
    };
  }

  dispose(): void {
    this.scene.primitives.remove(this.collection);
    this.entries = [];
    this.materials.clear();
  }
}
