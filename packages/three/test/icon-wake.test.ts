// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// Icon wake wiring gate (three-backend SoTA campaign, Wave 1 item 5). GPU
// compilation is browser-verified (like every TSL material here); this suite
// asserts (1) the icon material CONSTRUCTS its `wake` node graph without throwing
// — the trailing comet tail = `wakeAlphaNode` on opacity + `wakeSizeScaleNode`
// tapering the quad size — and (2) the STTIconLayer threads `wakeLength` /
// `wakeTailScale` into the shared TimeFilterUniforms, gates the tail off under
// reduced motion (collapse to a static window marker), and leaves the non-wake
// paths byte-identical (wake uniform stays 0, static attributes intact).

import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import type { InstancedBufferGeometry } from 'three';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  createIconMaterial,
  type IconMaterialBundle,
} from '../src/tsl/icon-material';
import { STTIconLayer } from '../src/layers/icon-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makePointTile } from './_support/features';

const proj = new LocalEnuProjection({ longitude: 0, latitude: 0 });
const ctx = { projection: proj, timeOrigin: 0 };

const iconOpts = {
  atlas: new Texture(),
  atlasWidth: 64,
  atlasHeight: 64,
  iconMapping: { marker: { x: 0, y: 0, width: 32, height: 32 } },
};

/** A 2-marker icon tile (start times 0 / 1000) with a heading column, and an
 *  optional per-entity id so the glide-precedence case is exercisable. */
function iconTile(extra: Partial<BinaryFeatures> = {}) {
  return makePointTile(
    2,
    [0, 0, 0.001, 0],
    {
      startTimes: new Float32Array([0, 1000]),
      endTimes: new Float32Array([0, 1000]),
      numericProps: { heading: new Float32Array([0, 90]) },
      ...extra,
    },
    { layerName: 'icons', geometryType: GeometryType.Point },
  );
}

describe('icon material — wake node graph builds', () => {
  for (const mask of [false, true]) {
    it(`builds in wake mode (mask: ${mask})`, () => {
      const b = createIconMaterial({
        mode: 'wake',
        mask,
        atlas: new Texture(),
      });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.mode).toBe('wake');
    });
  }
});

describe('STTIconLayer — wake render path', () => {
  const bundleOf = (layer: STTIconLayer): IconMaterialBundle =>
    (layer as unknown as { bundle: IconMaterialBundle }).bundle;

  it('threads wakeLength / wakeTailScale into the shared time uniforms', () => {
    const layer = new STTIconLayer({
      ...iconOpts,
      mode: 'wake',
      angleProperty: 'heading',
      wakeLength: 5000,
      wakeTailScale: 0.3,
    });
    layer.setTiles([iconTile()], ctx);

    const bundle = bundleOf(layer);
    expect(bundle.mode).toBe('wake');
    expect(layer.object.visible).toBe(true);

    layer.setTime(2000);
    expect(bundle.time.wakeLength.value).toBe(5000);
    expect(bundle.time.wakeTailScale.value).toBeCloseTo(0.3);

    // Wake reuses the existing per-instance `sttStart`/`sttCenter` attributes —
    // no new buffer, the static merged-instance geometry is intact.
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.getAttribute('sttStart')).toBeTruthy();
    expect(geom.getAttribute('sttCenter')).toBeTruthy();
    layer.dispose();
  });

  it('defaults wakeTailScale to DEFAULT_WAKE_TAIL_SCALE when unset', () => {
    const layer = new STTIconLayer({
      ...iconOpts,
      mode: 'wake',
      wakeLength: 5000,
    });
    layer.setTiles([iconTile()], ctx);
    layer.setTime(2000);
    const bundle = bundleOf(layer);
    expect(bundle.time.wakeTailScale.value).toBeCloseTo(
      DEFAULT_WAKE_TAIL_SCALE,
    );
    layer.dispose();
  });

  it('collapses wake → static window marker under reduced motion (no trail)', () => {
    const layer = new STTIconLayer({
      ...iconOpts,
      mode: 'wake',
      wakeLength: 5000,
      wakeTailScale: 0.3,
      reducedMotion: true,
    });
    layer.setTiles([iconTile()], ctx);
    layer.setTime(2000);

    const bundle = bundleOf(layer);
    // Material is built as a plain window marker — the animated tail is gone…
    expect(bundle.mode).toBe('window');
    // …and the wake-length uniform is zeroed so nothing tapers/fades as a tail.
    expect(bundle.time.wakeLength.value).toBe(0);
    layer.dispose();
  });

  it('leaves the wake uniform at 0 in the default (window) mode — byte-identical off', () => {
    const layer = new STTIconLayer({ ...iconOpts, angleProperty: 'heading' });
    layer.setTiles([iconTile()], ctx);
    layer.setTime(2000);

    const bundle = bundleOf(layer);
    expect(bundle.mode).toBe('window');
    expect(bundle.time.wakeLength.value).toBe(0);
    // Static per-instance path unchanged.
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.getAttribute('sttCenter')).toBeTruthy();
    expect(geom.getAttribute('sttAngle')).toBeTruthy();
    layer.dispose();
  });

  it('wake takes precedence over glide — the interpolate gate stays off in wake mode', () => {
    const layer = new STTIconLayer({
      ...iconOpts,
      mode: 'wake',
      wakeLength: 5000,
      angleProperty: 'heading',
      // Would normally activate glide, but wake mode wins (mutually exclusive,
      // mirroring deck's `wakeLength === 0` glide gate).
      interpolate: true,
      idProperty: 'mmsi',
    });
    layer.setTiles(
      [
        iconTile({
          categoricalProps: {
            mmsi: { indices: new Uint16Array([0, 1]), categories: ['A', 'B'] },
          },
        }),
      ],
      ctx,
    );

    const bundle = bundleOf(layer);
    expect(bundle.mode).toBe('wake');
    // Static wake path (NOT the glide geometry): static centre/heading attrs
    // present, glide row-locator absent.
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.getAttribute('sttCenter')).toBeTruthy();
    expect(geom.getAttribute('sttAngle')).toBeTruthy();
    expect(geom.getAttribute('sttGlideRowV')).toBeUndefined();
    layer.dispose();
  });
});
