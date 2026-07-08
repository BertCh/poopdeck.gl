// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `EgoLayer` — the ego vehicle: its full trajectory as a static trail line plus a
 * marker box interpolated to the playhead. Also the source of the follow-camera
 * target via {@link getEgoPose}. The ego archive is point-per-frame snapshots
 * (`lon,lat,alt`, optional `heading`); they are pooled into one sorted track and
 * binary-searched per frame. Heading falls back to the direction of travel when
 * no column is present.
 */

import {
  Group,
  Line,
  LineSegments,
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
} from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import { writeBoxEdges, FLOATS_PER_BOX } from '../geometry/box-edges.js';
import type { Projection } from '../projection/local-enu.js';
import type { RGBA } from '../lib/color.js';
import type { SttPickable, PickBox } from '../lib/box-pick.js';

export interface EgoPose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

export interface EgoLayerOptions {
  id?: string;
  headingProperty?: string;
  /** Marker box dims (metres). @default [4.5, 2, 1.5] */
  boxSize?: [number, number, number];
  trailColor?: RGBA;
  markerColor?: RGBA;
  zLift?: number;
}

const DEFAULT_TRAIL: RGBA = [80, 200, 255, 160];
const DEFAULT_MARKER: RGBA = [120, 230, 255, 255];

export class EgoLayer extends BaseSttLayer implements SttPickable {
  readonly id: string;
  readonly object = new Group();

  private projection: Projection | null = null;
  private times: number[] = [];
  private lon: number[] = [];
  private lat: number[] = [];
  private alt: number[] = [];
  private heading: number[] = [];
  private currentPose: EgoPose | null = null;

  private trail: Line;
  private marker: LineSegments;
  private markerBuf = new Float32Array(FLOATS_PER_BOX);

  private readonly opts: Required<Omit<EgoLayerOptions, 'id'>>;

  constructor(options: EgoLayerOptions = {}) {
    super();
    this.id = options.id ?? 'ego';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.opts = {
      headingProperty: options.headingProperty ?? 'heading',
      boxSize: options.boxSize ?? [4.5, 2, 1.5],
      trailColor: options.trailColor ?? DEFAULT_TRAIL,
      markerColor: options.markerColor ?? DEFAULT_MARKER,
      zLift: options.zLift ?? 0.05,
    };

    const tc = this.opts.trailColor;
    this.trail = new Line(
      new BufferGeometry(),
      new LineBasicMaterial({
        color: (tc[0] << 16) | (tc[1] << 8) | tc[2],
        transparent: true,
        opacity: (tc[3] ?? 255) / 255,
      }),
    );
    this.trail.frustumCulled = false;
    this.object.add(this.trail);

    const mc = this.opts.markerColor;
    this.marker = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({
        color: (mc[0] << 16) | (mc[1] << 8) | mc[2],
        transparent: true,
        opacity: (mc[3] ?? 255) / 255,
      }),
    );
    this.marker.frustumCulled = false;
    this.object.add(this.marker);
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.projection = ctx.projection;

    const t: number[] = [];
    const lon: number[] = [];
    const lat: number[] = [];
    const alt: number[] = [];
    const head: number[] = [];

    for (const tile of tiles) {
      for (const tl of tile.layers) {
        const b = tl.features;
        if (!b.featureCount || b.geometryType !== GeometryType.Point) continue;
        const dims = b.positionDimensions ?? 2;
        const headingCol = b.numericProps[this.opts.headingProperty] ?? null;
        for (let i = 0; i < b.featureCount; i++) {
          t.push(b.startTimes[i] + b.timeOffset);
          lon.push(b.positions[i * dims]);
          lat.push(b.positions[i * dims + 1]);
          alt.push(dims > 2 ? b.positions[i * dims + 2] : 0);
          head.push(headingCol ? headingCol[i] : NaN);
        }
      }
    }

    const order = Array.from({ length: t.length }, (_, k) => k).sort(
      (a, b) => t[a] - t[b],
    );
    this.times = order.map((i) => t[i]);
    this.lon = order.map((i) => lon[i]);
    this.lat = order.map((i) => lat[i]);
    this.alt = order.map((i) => alt[i]);
    this.heading = order.map((i) => head[i]);

    // Static trail.
    const proj = ctx.projection;
    const pos = new Float32Array(this.times.length * 3);
    for (let i = 0; i < this.times.length; i++) {
      const p = proj.project(
        this.lon[i],
        this.lat[i],
        this.alt[i] + this.opts.zLift,
      );
      pos[i * 3] = p[0];
      pos[i * 3 + 1] = p[1];
      pos[i * 3 + 2] = p[2];
    }
    this.trail.geometry.dispose();
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geom.computeBoundingSphere();
    this.trail.geometry = geom;
    this.trail.visible = this.times.length > 0; // no 0-vertex draw on an empty trail

    const mgeom = new BufferGeometry();
    mgeom.setAttribute(
      'position',
      new Float32BufferAttribute(this.markerBuf, 3),
    );
    this.marker.geometry.dispose();
    this.marker.geometry = mgeom;
    this.marker.visible = false; // enabled by setTime once a pose is sampled
  }

  setTime(absoluteTimeMs: number): void {
    const pose = this.getEgoPose(absoluteTimeMs);
    this.currentPose = pose;
    const geom = this.marker.geometry;
    if (!pose) {
      this.marker.visible = false;
      geom.setDrawRange(0, 0);
      return;
    }
    const [l, w, h] = this.opts.boxSize;
    writeBoxEdges(
      this.markerBuf,
      0,
      pose.x,
      pose.y,
      pose.z,
      pose.heading,
      l,
      w,
      h,
    );
    this.marker.visible = true;
    geom.setDrawRange(0, FLOATS_PER_BOX / 3);
    (geom.getAttribute('position') as Float32BufferAttribute).needsUpdate =
      true;
  }

  /** Current-frame ego OBB for click-to-inspect picking ({@link SttPickable}). */
  getPickBoxes(): PickBox[] {
    const pose = this.currentPose;
    if (!pose) return [];
    const [l, w, h] = this.opts.boxSize;
    return [
      {
        center: [pose.x, pose.y, pose.z + h / 2],
        heading: pose.heading,
        halfExtents: [l / 2, w / 2, h / 2],
        meta: {
          layerId: this.id,
          kind: 'ego',
          category: 'ego',
          length: l,
          width: w,
          height: h,
          heading: Number.isFinite(pose.heading) ? pose.heading : undefined,
        },
      },
    ];
  }

  /** Interpolated ego pose in WORLD coordinates at `now` (epoch-ms), or null. */
  getEgoPose(now: number): EgoPose | null {
    const n = this.times.length;
    if (n === 0 || !this.projection) return null;
    const first = this.times[0];
    const last = this.times[n - 1];
    const c = now < first ? first : now > last ? last : now;
    let lo = 0;
    let hi = n - 1;
    if (n > 1) {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.times[mid] <= c) lo = mid;
        else hi = mid;
      }
    } else {
      hi = lo;
    }
    const denom = this.times[hi] - this.times[lo];
    const f = denom > 0 ? (c - this.times[lo]) / denom : 0;
    const lon = this.lon[lo] + (this.lon[hi] - this.lon[lo]) * f;
    const lat = this.lat[lo] + (this.lat[hi] - this.lat[lo]) * f;
    const alt = this.alt[lo] + (this.alt[hi] - this.alt[lo]) * f;
    const [x, y, z] = this.projection.project(lon, lat, alt + this.opts.zLift);

    // Heading from the column, else from the direction of travel.
    let heading = this.heading[lo];
    if (!Number.isFinite(heading)) {
      const a = this.projection.project(this.lon[lo], this.lat[lo], 0);
      const b = this.projection.project(this.lon[hi], this.lat[hi], 0);
      heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
    return { x, y, z, heading };
  }

  dispose(): void {
    this.trail.geometry.dispose();
    (this.trail.material as LineBasicMaterial).dispose();
    this.marker.geometry.dispose();
    (this.marker.material as LineBasicMaterial).dispose();
  }
}
