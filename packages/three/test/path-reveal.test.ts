// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// pathReveal feature family (three-backend SoTA campaign, Wave 1 item 5).
// Progressive path drawing — a path inks itself in up to the playhead instead of
// appearing whole — the Three port of deck `AnimatedPathLayer`'s `revealTrail` /
// `revealDuration` / `fadeTrail`. Three layers of coverage:
//   1. buffer builder (`buildLineSegmentBuffers` `revealTimes`) synthesizes /
//      prefers per-vertex arc-length reveal times; OFF = feature `[start,end]`.
//   2. material: the shared `trail` gate (`createWideLineMaterial({ mode: 'trail' })`)
//      that reveal routes through BUILDS and composes with the column filter.
//   3. PathGeoLayer end-to-end: `revealTrail` switches the base into `trail` mode,
//      threads the reveal times into the geometry, AND drives `trailLength`
//      (persist vs comet) / `trailFade`; `reducedMotion` degrades to the static
//      whole-path window render.
// The trail gate math itself is proven in `time-filter-math.test.ts`; here we
// assert the wiring + the reveal-time synthesis, not the GPU raster.

import { describe, it, expect } from 'vitest';
import type { BufferGeometry } from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { buildLineSegmentBuffers } from '../src/lib/geo-line-buffers';
import { createWideLineMaterial } from '../src/tsl/wide-line-material';
import { DataFilterUniforms } from '../src/tsl/data-filter';
import { PathGeoLayer } from '../src/layers/path-geo-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };
const CONST = { type: 'constant', color: [200, 200, 200, 255] } as const;

// One 3-vertex path (2 segments), collinear + equally spaced east so the
// cumulative haversine distances are equal → the middle vertex's synthesized
// reveal time is the exact midpoint of the feature's [start,end] span.
// start=100, end=200, timeOffset=0 ⇒ (with timeOrigin 0) rebase = 0.
const dLon = 0.001;
function pathTile(partial: Partial<BinaryFeatures> = {}): Tile {
  return makeLineTile(
    {
      positions: new Float64Array([
        anchor.longitude,
        anchor.latitude,
        anchor.longitude + dLon,
        anchor.latitude,
        anchor.longitude + 2 * dLon,
        anchor.latitude,
      ]),
      startIndices: new Uint32Array([0, 3]),
      startTimes: new Float32Array([100]),
      endTimes: new Float32Array([200]),
      ...partial,
    },
    { timeOffset: 0, layerName: 'paths' },
  );
}

function attrArray(geom: BufferGeometry, name: string): number[] {
  const a = geom.getAttribute(name);
  return a ? Array.from(a.array) : [];
}

/** The private material bundle — where the reveal mode + uniforms are observable. */
function bundle(layer: unknown): {
  mode: string;
  time: { trailLength: { value: number }; trailFade: { value: number } };
} {
  return (layer as { bundle: any }).bundle;
}

describe('buildLineSegmentBuffers — revealTimes (progressive reveal source)', () => {
  it('OFF (default): timeA/timeB stay at the feature [start,end] (byte-identical window mode)', () => {
    const buf = buildLineSegmentBuffers([pathTile()], proj, 0, {
      colorMode: CONST,
    });
    expect(buf.count).toBe(2);
    expect(Array.from(buf.starts)).toEqual([100, 100]);
    expect(Array.from(buf.ends)).toEqual([200, 200]);
    // No per-vertex reveal times — both endpoints carry the whole feature span.
    expect(Array.from(buf.timeA)).toEqual([100, 100]);
    expect(Array.from(buf.timeB)).toEqual([200, 200]);
  });

  it('ON: synthesizes per-vertex times by arc-length across [start,end]', () => {
    const buf = buildLineSegmentBuffers([pathTile()], proj, 0, {
      colorMode: CONST,
      revealTimes: true,
    });
    // Vertices reveal at [100, 150, 200]; segment A/B pick up consecutive verts.
    expect(buf.timeA[0]).toBeCloseTo(100, 3);
    expect(buf.timeB[0]).toBeCloseTo(150, 3); // midpoint vertex
    expect(buf.timeA[1]).toBeCloseTo(150, 3); // continuous across the shared vertex
    expect(buf.timeB[1]).toBeCloseTo(200, 3);
    // The feature window [start,end] is untouched (reveal replaces the gate but
    // the window attributes still ride along).
    expect(Array.from(buf.starts)).toEqual([100, 100]);
    expect(Array.from(buf.ends)).toEqual([200, 200]);
  });

  it('ON: prefers the tile own vertexTimestamps over synthesis (zero-copy)', () => {
    // Non-uniform column so it cannot be confused with the uniform-distance synth.
    const buf = buildLineSegmentBuffers(
      [pathTile({ vertexTimestamps: new Float32Array([100, 170, 200]) })],
      proj,
      0,
      { colorMode: CONST, revealTimes: true },
    );
    expect(Array.from(buf.timeA)).toEqual([100, 170]);
    expect(Array.from(buf.timeB)).toEqual([170, 200]);
  });
});

describe('createWideLineMaterial — reveal routes through the trail gate', () => {
  it('the shared trail gate (which reveal uses) builds', () => {
    const b = createWideLineMaterial({ mode: 'trail' });
    expect(b.material.vertexNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
  });

  it('the trail gate composes with the column filter', () => {
    const b = createWideLineMaterial({ mode: 'trail', dataFilter: true });
    expect(b.material.vertexNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.filter).toBeInstanceOf(DataFilterUniforms);
  });
});

describe('PathGeoLayer — pathReveal end-to-end', () => {
  it('OFF (default): whole path — window mode, sttTimeA/B = feature [start,end], no trail', () => {
    const layer = new PathGeoLayer({ colorMode: CONST });
    layer.setTiles([pathTile()], ctx);
    const geom = layer.object.geometry as BufferGeometry;
    expect(bundle(layer).mode).toBe('window');
    expect(attrArray(geom, 'sttTimeA')).toEqual([100, 100]);
    expect(attrArray(geom, 'sttTimeB')).toEqual([200, 200]);
    expect(bundle(layer).time.trailLength.value).toBe(0);
    layer.dispose();
  });

  it('revealTrail: trail mode reveals per-vertex + PERSISTS (huge trailLength, fade default on)', () => {
    const layer = new PathGeoLayer({ colorMode: CONST, revealTrail: true });
    layer.setTiles([pathTile()], ctx);
    const geom = layer.object.geometry as BufferGeometry;
    expect(bundle(layer).mode).toBe('trail');
    const tA = attrArray(geom, 'sttTimeA');
    const tB = attrArray(geom, 'sttTimeB');
    expect(tA[0]).toBeCloseTo(100, 3);
    expect(tB[0]).toBeCloseTo(150, 3); // per-vertex reveal time, not the feature end
    expect(tA[1]).toBeCloseTo(150, 3);
    expect(tB[1]).toBeCloseTo(200, 3);
    // revealDuration 0 ⇒ persist: trail longer than any single-feature span.
    expect(bundle(layer).time.trailLength.value).toBeGreaterThan(1e12);
    expect(bundle(layer).time.trailFade.value).toBe(1);
    layer.dispose();
  });

  it('revealDuration: finite comet trail maps to trailLength', () => {
    const layer = new PathGeoLayer({
      colorMode: CONST,
      revealTrail: true,
      revealDuration: 5000,
    });
    layer.setTiles([pathTile()], ctx);
    expect(bundle(layer).time.trailLength.value).toBe(5000);
    layer.dispose();
  });

  it('fadeTrail:false draws a solid snake (trailFade = 0)', () => {
    const layer = new PathGeoLayer({
      colorMode: CONST,
      revealTrail: true,
      fadeTrail: false,
    });
    layer.setTiles([pathTile()], ctx);
    expect(bundle(layer).time.trailFade.value).toBe(0);
    layer.dispose();
  });

  it('reducedMotion suppresses the reveal — static whole path (window fallback)', () => {
    const layer = new PathGeoLayer({
      colorMode: CONST,
      revealTrail: true,
      reducedMotion: true,
    });
    layer.setTiles([pathTile()], ctx);
    const geom = layer.object.geometry as BufferGeometry;
    // Degrades to window mode: no per-vertex reveal times synthesized — the
    // window attributes are all that ride, exactly like the reveal-off path.
    expect(bundle(layer).mode).toBe('window');
    expect(attrArray(geom, 'sttTimeA')).toEqual([100, 100]);
    expect(attrArray(geom, 'sttTimeB')).toEqual([200, 200]);
    expect(bundle(layer).time.trailLength.value).toBe(0);
    layer.dispose();
  });
});
