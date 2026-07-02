// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Moving head-dots for CesiumJS — the Cesium analogue of deck's
 * `AnimatedTripHeadsLayer`: one interpolated dot at the head of each active
 * trip, sampled per rendered frame by the kernel's `sampleHead` (binary-search
 * + lerp along per-vertex times, `buildTripIndex` with `'f64'` precision on
 * the WGS84 globe). One `PointPrimitive` per trip, `show`-toggled; positions
 * are written through a scratch `Cartesian3` (the setter clones), so the
 * per-frame loop allocates nothing.
 *
 * Rendering needs a live Cesium `Scene` → browser-verify-only; the sampling
 * kernel is unit-tested in core.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  PointPrimitiveCollection,
  defined,
  type PointPrimitive,
  type Scene,
} from 'cesium';
import { GeometryType, getFeatureProperties, type BinaryFeatures, type Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { buildTripIndex, sampleHead, type Trip } from '@poopdeck.gl/core/trips';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import { featureColor, type FeatureColorMode } from './lib/feature-color';

export interface CesiumTripHeadsLayerOptions {
  id?: string;
  /** Head-dot colour (constant / categorical / ramp). @default warm white */
  color?: FeatureColorMode;
  /** Head-dot size in pixels. @default 8 */
  pixelSize?: number;
}

interface HeadEntry {
  trip: Trip;
  pp: PointPrimitive;
  active: boolean;
}

const DEFAULT_COLOR: RGBA255 = [255, 235, 205, 255];

// Scratch for every per-frame position write; the PointPrimitive setter clones
// into its own storage (same argument as the point layer's SCRATCH_COLOR).
const SCRATCH_POS = new Cartesian3();

// The WGS84 globe — Cesium's native frame.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, { datum: 'wgs84' });

export class CesiumTripHeadsLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PointPrimitiveCollection;
  private readonly colorMode: FeatureColorMode;
  private readonly pixelSize: number;
  private entries: HeadEntry[] = [];
  private origin: [number, number, number] = [0, 0, 0];
  private timeOrigin = 0;

  constructor(scene: Scene, options: CesiumTripHeadsLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-trip-heads';
    this.scene = scene;
    this.colorMode = options.color ?? { type: 'constant', color: DEFAULT_COLOR };
    this.pixelSize = options.pixelSize ?? 8;
    this.collection = new PointPrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build the trip index from decoded tiles (replace-all). */
  setTiles(tiles: Tile[]): void {
    this.collection.removeAll();
    this.entries = [];

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

    for (const trip of index.trips) {
      const rgba = featureColor(trip.binary, trip.featureIndex, this.colorMode);
      const pp = this.collection.add({
        position: Cartesian3.ZERO,
        color: new Color(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, (rgba[3] ?? 255) / 255),
        pixelSize: this.pixelSize,
        show: false,
        id: { layerId: this.id, binary: trip.binary, featureIndex: trip.featureIndex },
      });
      this.entries.push({ trip, pp, active: false });
    }
  }

  /** Advance to an absolute playhead time; move every active head. */
  setTime(absoluteMs: number): void {
    const cur = absoluteMs - this.timeOrigin;
    const [ox, oy, oz] = this.origin;
    for (const e of this.entries) {
      const head = sampleHead(e.trip, cur);
      if (!head) {
        if (e.active) {
          e.pp.show = false;
          e.active = false;
        }
        continue;
      }
      SCRATCH_POS.x = head.x + ox;
      SCRATCH_POS.y = head.y + oy;
      SCRATCH_POS.z = head.z + oz;
      e.pp.position = SCRATCH_POS; // setter clones the scratch
      if (!e.active) {
        e.pp.show = true;
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
  }
}
