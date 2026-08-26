// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// Motion-glide wiring gate. GPU compilation is browser-verified (like every TSL
// material here); this suite asserts (1) the point + icon materials CONSTRUCT
// their glide node graph without throwing in both interpolate on/off states, and
// (2) the layers build the glide instanced geometry (one instance per entity,
// the `sttGlide*` row locators, NO static `sttCenter`/`sttAngle`) when
// `interpolate` is on and stay byte-identical (static path) when it is off.

import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import type { InstancedBufferGeometry } from 'three';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import {
  createPointMaterial,
  createPointIdMaterial,
} from '../src/tsl/point-material';
import { createIconMaterial } from '../src/tsl/icon-material';
import { GlideUniforms } from '../src/tsl/motion-glide';
import { STTPointLayer } from '../src/layers/point-layer';
import { STTIconLayer } from '../src/layers/icon-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makePointTile } from './_support/features';

const proj = new LocalEnuProjection({ longitude: 0, latitude: 0 });
const ctx = { projection: proj, timeOrigin: 0 };

/** A 2-entity × 2-sample moving point tile with a categorical id column. */
function movingTile(
  idProp: string,
  layerName: string,
  extra: Partial<BinaryFeatures> = {},
) {
  return makePointTile(
    4,
    // A: (0,0)→(0.001,0)  B: (0.002,0)→(0.002,0.001)
    [0, 0, 0.001, 0, 0.002, 0, 0.002, 0.001],
    {
      startTimes: new Float32Array([0, 1000, 0, 1000]),
      endTimes: new Float32Array([0, 1000, 0, 1000]),
      categoricalProps: {
        [idProp]: {
          indices: new Uint16Array([0, 0, 1, 1]),
          categories: ['A', 'B'],
        },
      },
      ...extra,
    },
    { layerName, geometryType: GeometryType.Point },
  );
}

describe('point material — glide node graph builds', () => {
  it('wires a glide bundle when `glide` is set, none when off', () => {
    const off = createPointMaterial({ mode: 'window' });
    expect(off.material.vertexNode).toBeTruthy();
    expect(off.glide).toBeNull();

    const on = createPointMaterial({
      mode: 'window',
      glide: { texture: new Texture() },
    });
    expect(on.material.vertexNode).toBeTruthy();
    expect(on.glide).toBeInstanceOf(GlideUniforms);

    // The id material glides identically (time-correct picking under glide).
    const id = createPointIdMaterial({
      mode: 'window',
      glide: { texture: new Texture() },
    });
    expect(id.material.vertexNode).toBeTruthy();
    expect(id.glide).toBeInstanceOf(GlideUniforms);
  });
});

describe('icon material — glide node graph builds', () => {
  it('wires a glide bundle when `glide` is set, none when off', () => {
    const off = createIconMaterial({ mode: 'window', atlas: new Texture() });
    expect(off.material.vertexNode).toBeTruthy();
    expect(off.glide).toBeNull();

    for (const mask of [false, true]) {
      const on = createIconMaterial({
        mode: 'window',
        atlas: new Texture(),
        mask,
        glide: { texture: new Texture() },
      });
      expect(on.material.vertexNode).toBeTruthy();
      expect(on.material.opacityNode).toBeTruthy();
      expect(on.glide).toBeInstanceOf(GlideUniforms);
    }
  });
});

describe('STTPointLayer — glide render path', () => {
  it('builds one glided instance per entity with the row locators', () => {
    const layer = new STTPointLayer({
      interpolate: true,
      idProperty: 'ac',
    });
    layer.setTiles([movingTile('ac', 'points')], ctx);

    expect(layer.object.visible).toBe(true);
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.instanceCount).toBe(2); // 2 entities, not 4 samples
    // The glide row locators are present…
    expect(geom.getAttribute('sttGlideT0')).toBeTruthy();
    expect(geom.getAttribute('sttGlideInvDt')).toBeTruthy();
    expect(geom.getAttribute('sttGlideFrameMax')).toBeTruthy();
    expect(geom.getAttribute('sttGlideRowV')).toBeTruthy();
    expect(geom.getAttribute('sttColor')).toBeTruthy();
    // …and the STATIC per-sample centre is gone (position comes from the texture).
    expect(geom.getAttribute('sttCenter')).toBeUndefined();

    // Advancing time is a pure uniform write — must not throw / rebuild.
    expect(() => layer.setTime(500)).not.toThrow();
    layer.dispose();
  });

  it('stays on the static per-sample path when interpolate is off', () => {
    const layer = new STTPointLayer({ idProperty: 'ac' }); // interpolate defaults off
    layer.setTiles([movingTile('ac', 'points')], ctx);
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.instanceCount).toBe(4); // one instance per sample
    expect(geom.getAttribute('sttCenter')).toBeTruthy();
    expect(geom.getAttribute('sttGlideT0')).toBeUndefined();
    layer.dispose();
  });

  it('degrades to the static path under reduced motion', () => {
    const layer = new STTPointLayer({
      interpolate: true,
      idProperty: 'ac',
      reducedMotion: true,
    });
    layer.setTiles([movingTile('ac', 'points')], ctx);
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.getAttribute('sttCenter')).toBeTruthy();
    expect(geom.getAttribute('sttGlideT0')).toBeUndefined();
    layer.dispose();
  });
});

describe('STTIconLayer — glide render path', () => {
  const iconOpts = {
    atlas: new Texture(),
    atlasWidth: 64,
    atlasHeight: 64,
    iconMapping: { marker: { x: 0, y: 0, width: 32, height: 32 } },
  };

  it('glides position + heading with the entity-constant icon geometry', () => {
    const layer = new STTIconLayer({
      ...iconOpts,
      interpolate: true,
      idProperty: 'mmsi',
      angleProperty: 'cog',
    });
    layer.setTiles(
      [
        movingTile('mmsi', 'icons', {
          numericProps: { cog: new Float32Array([0, 90, 45, 135]) },
        }),
      ],
      ctx,
    );

    expect(layer.object.visible).toBe(true);
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.instanceCount).toBe(2);
    expect(geom.getAttribute('sttGlideRowV')).toBeTruthy();
    // Entity-constant icon geometry is baked per instance…
    expect(geom.getAttribute('sttSize')).toBeTruthy();
    expect(geom.getAttribute('sttUvRect')).toBeTruthy();
    expect(geom.getAttribute('sttAnchor')).toBeTruthy();
    // …while centre AND heading come from the texture (no static attrs).
    expect(geom.getAttribute('sttCenter')).toBeUndefined();
    expect(geom.getAttribute('sttAngle')).toBeUndefined();

    expect(() => layer.setTime(500)).not.toThrow();
    layer.dispose();
  });

  it('stays on the static path when interpolate is off', () => {
    const layer = new STTIconLayer({ ...iconOpts, angleProperty: 'cog' });
    layer.setTiles(
      [
        movingTile('mmsi', 'icons', {
          numericProps: { cog: new Float32Array([0, 90, 45, 135]) },
        }),
      ],
      ctx,
    );
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.instanceCount).toBe(4);
    expect(geom.getAttribute('sttCenter')).toBeTruthy();
    expect(geom.getAttribute('sttAngle')).toBeTruthy();
    expect(geom.getAttribute('sttGlideRowV')).toBeUndefined();
    layer.dispose();
  });
});
