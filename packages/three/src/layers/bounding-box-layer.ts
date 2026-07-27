// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTBoundingBoxLayer` — one smooth-moving oriented 3D box per tracked object, the
 * Three port of deck's `AnimatedBoundingBoxLayer`. The objects archive carries one
 * point snapshot per object per keyframe; {@link buildTrackIndex} pools them by
 * `track_id` and {@link sampleTracks} interpolates each active track to a pose at
 * the playhead. Unlike the GPU layers, this re-runs a CPU binary-search + lerp per
 * frame and rewrites a `LineSegments` of every active box's 12 edges (matching the
 * deck cockpit's `filled:false, stroked:true` look), plus optional velocity arrows.
 *
 * Per-box appear/disappear fade is premultiplied into the edge RGB (fading toward
 * the dark ground) since `LineBasicMaterial` has no per-vertex alpha.
 */

import {
  Group,
  LineSegments,
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
} from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  buildTrackIndex,
  sampleTracks,
  SINGLETON_HOLD_MS,
  type Track,
  type BoxSample,
  type BoxTrackOptions,
} from './box-tracks.js';
import { writeBoxEdges, FLOATS_PER_BOX } from '../geometry/box-edges.js';
import type { Projection } from '../projection/local-enu.js';
import type { RGBA } from '../lib/color.js';
import type { STTPickable, PickBox } from '../lib/box-pick.js';

export interface STTBoundingBoxLayerOptions {
  id?: string;
  trackIdProperty?: string;
  colorProperty?: string;
  colorMapping?: Record<string, RGBA>;
  colorMappingDefault?: RGBA;
  headingProperty?: string;
  lengthProperty?: string;
  widthProperty?: string;
  heightProperty?: string;
  speedProperty?: string;
  labelProperty?: string;
  defaultLength?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  sizeScale?: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  opacity?: number;
  showVelocity?: boolean;
  velocityScale?: number;
  velocityMinSpeed?: number;
  velocityColor?: RGBA;
}

const DEFAULT_COLOR: RGBA = [150, 160, 175, 220];
const DEFAULT_VELOCITY_COLOR: RGBA = [120, 230, 255, 255];

/**
 * A `LineSegments` geometry that ALWAYS carries (zero-length) `position` +
 * `color` attributes. The box/velocity buffers are allocated lazily (only once
 * a box is active), but the WebGPU/TSL backend builds a material's vertex
 * attribute nodes the first time the object is rendered — and a geometry with
 * NO `position` attribute makes that build throw ("Vertex attribute 'position'
 * not found"), which aborts the whole frame and blanks the viewport. Seeding
 * empty attributes lets the material build cleanly and draw nothing (drawRange
 * 0) until the real buffers arrive. WebGL tolerated the missing attribute;
 * WebGPU does not.
 */
function emptyColoredLineGeometry(): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute(
    'position',
    new Float32BufferAttribute(new Float32Array(0), 3),
  );
  geom.setAttribute(
    'color',
    new Float32BufferAttribute(new Float32Array(0), 3),
  );
  geom.setDrawRange(0, 0);
  return geom;
}

export class STTBoundingBoxLayer extends BaseSTTLayer implements STTPickable {
  readonly id: string;
  readonly object = new Group();

  private projection: Projection | null = null;
  private trackIndex: Map<string, Track> | null = null;
  private activeSamples: BoxSample[] = [];

  private edges: LineSegments;
  private edgePositions = new Float32Array(0);
  private edgeColors = new Float32Array(0);
  private edgeCapacity = 0; // boxes

  private velocity: LineSegments | null = null;
  private velPositions = new Float32Array(0);
  private velColors = new Float32Array(0);
  private velCapacity = 0;

  private readonly opts: Required<Omit<STTBoundingBoxLayerOptions, 'id'>>;

  constructor(options: STTBoundingBoxLayerOptions = {}) {
    super();
    this.id = options.id ?? 'objects';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.opts = {
      trackIdProperty: options.trackIdProperty ?? 'track_id',
      colorProperty: options.colorProperty ?? 'category',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_COLOR,
      headingProperty: options.headingProperty ?? 'heading',
      lengthProperty: options.lengthProperty ?? 'length',
      widthProperty: options.widthProperty ?? 'width',
      heightProperty: options.heightProperty ?? 'height',
      speedProperty: options.speedProperty ?? 'speed',
      labelProperty: options.labelProperty ?? 'category',
      defaultLength: options.defaultLength ?? 4,
      defaultWidth: options.defaultWidth ?? 2,
      defaultHeight: options.defaultHeight ?? 1.6,
      sizeScale: options.sizeScale ?? 1,
      fadeInDuration: options.fadeInDuration ?? 200,
      fadeOutDuration: options.fadeOutDuration ?? 200,
      opacity: options.opacity ?? 1,
      showVelocity: options.showVelocity ?? false,
      velocityScale: options.velocityScale ?? 1.5,
      velocityMinSpeed: options.velocityMinSpeed ?? 0.3,
      velocityColor: options.velocityColor ?? DEFAULT_VELOCITY_COLOR,
    };

    this.edges = new LineSegments(
      emptyColoredLineGeometry(),
      new LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: this.opts.opacity,
      }),
    );
    this.edges.frustumCulled = false;
    this.edges.visible = false; // nothing to draw until the first active box
    this.object.add(this.edges);

    if (this.opts.showVelocity) {
      this.velocity = new LineSegments(
        emptyColoredLineGeometry(),
        new LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: this.opts.opacity,
        }),
      );
      this.velocity.frustumCulled = false;
      this.velocity.visible = false;
      this.object.add(this.velocity);
    }
  }

  private trackOptions(): BoxTrackOptions {
    return {
      trackIdProperty: this.opts.trackIdProperty,
      colorProperty: this.opts.colorProperty,
      colorMapping: this.opts.colorMapping,
      colorMappingDefault: this.opts.colorMappingDefault,
      labelProperty: this.opts.labelProperty,
      headingProperty: this.opts.headingProperty,
      lengthProperty: this.opts.lengthProperty,
      widthProperty: this.opts.widthProperty,
      heightProperty: this.opts.heightProperty,
      speedProperty: this.opts.speedProperty,
    };
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.projection = ctx.projection;
    this.trackIndex = buildTrackIndex(tiles, this.trackOptions());
  }

  setTime(absoluteTimeMs: number): void {
    if (!this.trackIndex || !this.projection) return;
    const samples = sampleTracks(this.trackIndex, absoluteTimeMs, {
      length: this.opts.defaultLength,
      width: this.opts.defaultWidth,
      height: this.opts.defaultHeight,
      fadeIn: this.opts.fadeInDuration,
      fadeOut: this.opts.fadeOutDuration,
      // Passed EXPLICITLY, not left to a default: the shared kernel holds a
      // lone keyframe for 600 ms and this backend has always held it for 400.
      // Spelling it at the call site is what keeps that divergence a visible,
      // deliberate choice after the de-fork rather than an accident of which
      // module supplies the constant.
      singletonHoldMs: SINGLETON_HOLD_MS,
    });
    this.activeSamples = samples;
    this.rebuildEdges(samples);
    if (this.velocity) this.rebuildVelocity(samples);
  }

  private rebuildEdges(samples: BoxSample[]): void {
    const n = samples.length;
    if (n > this.edgeCapacity) {
      this.edgeCapacity = Math.max(n, this.edgeCapacity * 2, 16);
      this.edgePositions = new Float32Array(this.edgeCapacity * FLOATS_PER_BOX);
      this.edgeColors = new Float32Array(this.edgeCapacity * FLOATS_PER_BOX);
      this.edges.geometry.dispose();
      const geom = new BufferGeometry();
      geom.setAttribute(
        'position',
        new Float32BufferAttribute(this.edgePositions, 3),
      );
      geom.setAttribute(
        'color',
        new Float32BufferAttribute(this.edgeColors, 3),
      );
      this.edges.geometry = geom;
    }
    const pos = this.edgePositions;
    const col = this.edgeColors;
    const proj = this.projection!;
    const ss = this.opts.sizeScale;
    let o = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const [cx, cy, cz] = proj.project(s.lon, s.lat, s.alt);
      const start = o;
      o = writeBoxEdges(
        pos,
        o,
        cx,
        cy,
        cz,
        s.heading,
        s.length * ss,
        s.width * ss,
        s.height * ss,
      );
      // Fade premultiplied into RGB (LineBasicMaterial has no per-vertex alpha).
      const a = s.alpha;
      const r = (s.track.color[0] / 255) * a;
      const g = (s.track.color[1] / 255) * a;
      const b = (s.track.color[2] / 255) * a;
      for (let v = start; v < o; v += 3) {
        col[v] = r;
        col[v + 1] = g;
        col[v + 2] = b;
      }
    }
    this.updateDrawRange(this.edges, n * (FLOATS_PER_BOX / 3));
  }

  private rebuildVelocity(samples: BoxSample[]): void {
    const vel = this.velocity!;
    // Arrows = one segment per moving object (2 verts × 3 floats).
    const active = samples.filter(
      (s) => Number.isFinite(s.speed) && s.speed >= this.opts.velocityMinSpeed,
    );
    const n = active.length;
    if (n > this.velCapacity) {
      this.velCapacity = Math.max(n, this.velCapacity * 2, 16);
      this.velPositions = new Float32Array(this.velCapacity * 6);
      this.velColors = new Float32Array(this.velCapacity * 6);
      vel.geometry.dispose();
      const geom = new BufferGeometry();
      geom.setAttribute(
        'position',
        new Float32BufferAttribute(this.velPositions, 3),
      );
      geom.setAttribute('color', new Float32BufferAttribute(this.velColors, 3));
      vel.geometry = geom;
    }
    const pos = this.velPositions;
    const col = this.velColors;
    const proj = this.projection!;
    const vc = this.opts.velocityColor;
    let o = 0;
    for (let i = 0; i < n; i++) {
      const s = active[i];
      const [cx, cy, cz] = proj.project(s.lon, s.lat, s.alt);
      const len = s.speed * this.opts.velocityScale;
      const c = Number.isFinite(s.heading) ? Math.cos(s.heading) : 1;
      const sn = Number.isFinite(s.heading) ? Math.sin(s.heading) : 0;
      // origin at box top-centre, arrow along heading.
      const z = cz + s.height * this.opts.sizeScale;
      pos[o] = cx;
      pos[o + 1] = cy;
      pos[o + 2] = z;
      pos[o + 3] = cx + c * len;
      pos[o + 4] = cy + sn * len;
      pos[o + 5] = z;
      const r = (vc[0] / 255) * s.alpha;
      const g = (vc[1] / 255) * s.alpha;
      const b = (vc[2] / 255) * s.alpha;
      for (let k = 0; k < 6; k += 3) {
        col[o + k] = r;
        col[o + k + 1] = g;
        col[o + k + 2] = b;
      }
      o += 6;
    }
    this.updateDrawRange(vel, n * 2);
  }

  private updateDrawRange(line: LineSegments, vertexCount: number): void {
    const geom = line.geometry;
    const pos = geom.getAttribute('position') as
      | Float32BufferAttribute
      | undefined;
    // Hide (don't draw) when empty — a 0-vertex draw is a no-op that the WebGPU
    // backend warns about ("Draw with a vertex count of 0 is unusual").
    line.visible = vertexCount > 0;
    // No buffers yet (zero active boxes since mount): nothing to draw, and the
    // attributes don't exist — bail before touching them.
    if (!pos) {
      geom.setDrawRange(0, 0);
      return;
    }
    geom.setDrawRange(0, vertexCount);
    pos.needsUpdate = true;
    const col = geom.getAttribute('color') as
      | Float32BufferAttribute
      | undefined;
    if (col) col.needsUpdate = true;
    geom.computeBoundingSphere();
  }

  /** Active interpolated box poses at the last `setTime` (for picking / inspection). */
  getActiveSamples(): readonly BoxSample[] {
    return this.activeSamples;
  }

  /** Current-frame world-space OBBs for click-to-inspect picking ({@link STTPickable}). */
  getPickBoxes(): PickBox[] {
    if (!this.projection) return [];
    const ss = this.opts.sizeScale;
    const out: PickBox[] = [];
    for (const s of this.activeSamples) {
      const [cx, cy, cz] = this.projection.project(s.lon, s.lat, s.alt);
      const hh = (s.height * ss) / 2;
      out.push({
        center: [cx, cy, cz + hh],
        heading: s.heading,
        halfExtents: [(s.length * ss) / 2, (s.width * ss) / 2, hh],
        meta: {
          layerId: this.id,
          kind: 'object',
          category: s.track.category || undefined,
          trackId: s.track.trackId || undefined,
          speed: Number.isFinite(s.speed) ? s.speed : undefined,
          // Report the unscaled (true) object dimensions to the inspector.
          length: Number.isFinite(s.length) ? s.length : undefined,
          width: Number.isFinite(s.width) ? s.width : undefined,
          height: Number.isFinite(s.height) ? s.height : undefined,
          heading: Number.isFinite(s.heading) ? s.heading : undefined,
        },
      });
    }
    return out;
  }

  dispose(): void {
    this.edges.geometry.dispose();
    (this.edges.material as LineBasicMaterial).dispose();
    if (this.velocity) {
      this.velocity.geometry.dispose();
      (this.velocity.material as LineBasicMaterial).dispose();
    }
  }
}
