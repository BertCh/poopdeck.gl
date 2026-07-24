// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `FlowCorridorMaterial` — the Three/TSL port of deck's `FlowCorridorLayer`
 * rendering. A static street/route network drawn as screen-pixel-width segments
 * (the {@link createWideLineMaterial} ribbon expansion), but whose per-segment
 * ridership is a TIME SERIES sampled live from a GPU texture.
 *
 * THE WIN: deck re-expands the active-bucket per-vertex colour on the CPU at every
 * cross-fade sub-step. Here the WHOLE value matrix (`numBuckets` time columns ×
 * `count` segments, RG = endpoint-A / endpoint-B value) is uploaded ONCE as a
 * linear-filtered float `DataTexture`. The fragment stage samples it at
 * `u = (bucketPos + 0.5)/numBuckets`, `v = row` — the texture's linear filtering
 * performs the two-bucket lerp on the GPU for free. Advancing the playhead only
 * moves the `bucketPos` uniform: ZERO per-frame CPU work, nothing re-uploads.
 *
 * The instantaneous value (per endpoint) drives BOTH width (lerp min→max pixels)
 * and colour (a baked ramp `DataTexture` sampled at the normalised value). Width is
 * varied per-endpoint and the gradient is `mix`-blended along the segment.
 *
 * WGSL: no `select()` is wrapped in a `varying()` — the value sample and the
 * window alpha are computed in the FRAGMENT stage from raw varied inputs;
 * `mix()`/`step()`/texture samples are varying-safe.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending, AdditiveBlending } from 'three';
import type { Texture } from 'three';
import * as TSL from 'three/tsl';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec4,
  mix,
  saturate,
  modelViewMatrix,
  cameraProjectionMatrix,
  type UniformNode,
} from './nodes.js';
import {
  TimeFilterUniforms,
  windowAlphaNode,
  windowVisibleNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterParams } from './time-filter-math.js';

// Loose TSL builders not surfaced on the ./nodes seam (texture sampling), mirroring
// icon-material.ts.
const texture = TSL.texture as unknown as (...a: any[]) => any;

/** Live flow-corridor uniforms: playhead bucket, width ramp, value domain, ramp. */
export class FlowCorridorUniforms {
  /** Fractional playhead position in `[0, numBuckets - 1]` (host updates per frame). */
  readonly bucketPos: UniformNode = uniform(0);
  /** `1 / numBuckets` — converts a bucket index to the texture u centre. */
  readonly invBuckets: UniformNode = uniform(1);
  /** Width in CSS pixels at the LOW end of the value domain. */
  readonly minWidthPx: UniformNode = uniform(1);
  /** Width in CSS pixels at the HIGH end of the value domain. */
  readonly maxWidthPx: UniformNode = uniform(8);
  /** Value domain `[lo, hi]` mapped to `[0,1]` for width + ramp. */
  readonly domainLo: UniformNode = uniform(0);
  readonly domainHi: UniformNode = uniform(1);
  readonly opacity: UniformNode = uniform(1);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
}

export interface FlowCorridorMaterialOptions {
  /**
   * The value texture: `width = numBuckets`, `height = count`, RG-float,
   * LinearFilter (so the bucket lerp is hardware-interpolated). R = endpoint-A
   * value, G = endpoint-B value.
   */
  valueTexture: Texture;
  /** The baked colour ramp (1-D, `LinearFilter`); sampled at the normalised value. */
  rampTexture: Texture;
  /** Additive blending (glowing flows) vs normal alpha. @default false */
  additive?: boolean;
  /** Write depth. @default false */
  depthWrite?: boolean;
  /** Discard fragments below this final alpha. @default 0.02 */
  alphaCutoff?: number;
  /**
   * Apply the timeless window-mode alpha (so a corridor can be hidden once the
   * playhead leaves its `[start,end]`). Flow corridors span the whole range, so
   * the default keeps them always visible. @default false
   */
  windowFilter?: boolean;
}

export interface FlowCorridorMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  flow: FlowCorridorUniforms;
}

/**
 * Build the flow-corridor material. The layer attaches per-instance attributes
 * `sttPosA`/`sttPosB` (vec3 RTC-local), `sttRowV` (float, texture row centre),
 * `sttStart`/`sttEnd` (float, relative ms) on a {@link makeSegmentQuadGeometry}.
 */
export function createFlowCorridorMaterial(
  opts: FlowCorridorMaterialOptions,
): FlowCorridorMaterialBundle {
  const time = new TimeFilterUniforms();
  const flow = new FlowCorridorUniforms();

  const posA = attribute('sttPosA', 'vec3');
  const posB = attribute('sttPosB', 'vec3');
  const rowV = attribute('sttRowV', 'float');
  const along = positionGeometry.x; // 0 (A) .. 1 (B)
  const side = positionGeometry.y; // -1 .. +1

  // ── sample the value texture (linear filter does the two-bucket lerp) ────────
  // u = (bucketPos + 0.5) / numBuckets; the row v is per-instance.
  const sampleU = flow.bucketPos.add(0.5).mul(flow.invBuckets);
  const sample = texture(opts.valueTexture, vec2(sampleU, rowV));
  const valA = sample.x; // endpoint-A instantaneous value
  const valB = sample.y; // endpoint-B instantaneous value

  // Normalise each endpoint value to [0,1] across the domain.
  const span = TSL.max(flow.domainHi.sub(flow.domainLo), float(1e-6));
  const nA = saturate(valA.sub(flow.domainLo).div(span));
  const nB = saturate(valB.sub(flow.domainLo).div(span));

  // ── VERTEX: expand the segment to a value-driven width in screen space ───────
  // Per-endpoint width (px); interpolate at this corner's `along`.
  const widthA = mix(flow.minWidthPx, flow.maxWidthPx, nA);
  const widthB = mix(flow.minWidthPx, flow.maxWidthPx, nB);
  const widthPx = mix(widthA, widthB, along);

  const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
  const clipA = mvp.mul(vec4(posA, 1));
  const clipB = mvp.mul(vec4(posB, 1));
  const ndcA = clipA.xy.div(clipA.w);
  const ndcB = clipB.xy.div(clipB.w);
  const dir = ndcB.sub(ndcA).mul(flow.viewport).normalize();
  const perp = vec2(dir.y.negate(), dir.x);
  const clip = mix(clipA, clipB, along);
  // HARD vertex-stage collapse: when the corridor is window-filtered, an
  // out-of-window segment gets width ×0 (zero-area degenerate strip → dies at
  // assembly, no fragment cost; deck.gl #7509). Corridors that span the whole
  // range (the default, `windowFilter` off) never collapse. The soft window fade
  // stays in the fragment `opacityNode`.
  const visible = opts.windowFilter
    ? windowVisibleNode(
        time,
        attribute('sttStart', 'float'),
        attribute('sttEnd', 'float'),
      )
    : float(1);
  const off = perp
    .mul(side)
    .mul(widthPx)
    .mul(visible)
    .div(flow.viewport)
    .mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(off.x),
    clip.y.add(off.y),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: ramp colour by the (re-sampled) blended value + opacity ────────
  // Re-sample in the fragment stage so the ramp lookup is per-pixel-smooth and we
  // never wrap a texture/select in a varying. Vary only the raw quad params.
  const vAlong = varying(along);
  const vRowV = varying(rowV);
  const fSample = texture(opts.valueTexture, vec2(sampleU, vRowV));
  const fValA = fSample.x;
  const fValB = fSample.y;
  const fVal = mix(fValA, fValB, vAlong); // value along the segment
  const fNorm = saturate(fVal.sub(flow.domainLo).div(span));
  const ramp = texture(opts.rampTexture, vec2(fNorm, float(0.5)));

  let alpha = float(1);
  if (opts.windowFilter) {
    const vStart = varying(attribute('sttStart', 'float'));
    const vEnd = varying(attribute('sttEnd', 'float'));
    alpha = windowAlphaNode(time, vStart, vEnd);
  }

  material.colorNode = ramp.xyz;
  material.opacityNode = ramp.a.mul(flow.opacity).mul(alpha);
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = opts.depthWrite ?? false;
  material.side = DoubleSide;
  material.blending = opts.additive ? AdditiveBlending : NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.02;

  return { material, time, flow };
}

export interface FlowCorridorUniformValues {
  /** Fractional playhead bucket position in `[0, numBuckets - 1]`. */
  bucketPos: number;
  /** Bucket count (sets `invBuckets`). */
  numBuckets: number;
  relativeCurrentTime?: number;
  params?: TimeFilterParams;
  minWidthPx?: number;
  maxWidthPx?: number;
  domain?: [number, number];
  opacity?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize). */
  viewport?: [number, number];
}

/** Push the playhead bucket + width/domain/viewport into the uniforms. */
export function updateFlowCorridorUniforms(
  bundle: FlowCorridorMaterialBundle,
  v: FlowCorridorUniformValues,
): void {
  bundle.flow.bucketPos.value = v.bucketPos;
  if (v.numBuckets > 0) bundle.flow.invBuckets.value = 1 / v.numBuckets;
  if (v.relativeCurrentTime !== undefined) {
    updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  }
  if (v.minWidthPx !== undefined) bundle.flow.minWidthPx.value = v.minWidthPx;
  if (v.maxWidthPx !== undefined) bundle.flow.maxWidthPx.value = v.maxWidthPx;
  if (v.domain) {
    bundle.flow.domainLo.value = v.domain[0];
    bundle.flow.domainHi.value = v.domain[1];
  }
  if (v.opacity !== undefined) bundle.flow.opacity.value = v.opacity;
  if (v.viewport) bundle.flow.viewport.value.set(v.viewport[0], v.viewport[1]);
}
