// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// DataFilter wiring gate for the ICON kind — the sixth (and final) kind deck
// filters on that the three backend now covers. Mirrors the family suite
// (`data-filter-{buffers,materials,layers}.test.ts`): with a `filterProperty`
// set the buffer builder emits a per-icon `filterValues` array, the material
// installs a `DataFilterUniforms` and folds the hard visible gate into the
// vertex-stage quad collapse + the soft alpha into `opacityNode`, and the layer
// binds `sttFilterValue` + a filter-enabled material — COMPOSING with the
// existing wake / glide / stable-tint icon paths. Off ⇒ byte-identical (no
// attribute, no filter). GPU compilation is browser-verified, as everywhere in
// this renderer; here we assert the node graphs BUILD and the glue is present.

import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import type { InstancedBufferGeometry } from 'three';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildIconBuffers } from '../src/lib/icon-buffers';
import {
  createIconMaterial,
  updateIconUniforms,
  type IconMaterialBundle,
  type IconMode,
} from '../src/tsl/icon-material';
import { STTIconLayer } from '../src/layers/icon-layer';
import { DataFilterUniforms } from '../src/tsl/data-filter';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makePointTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };

const iconOpts = {
  atlas: new Texture(),
  atlasWidth: 64,
  atlasHeight: 64,
  iconMapping: { marker: { x: 0, y: 0, width: 32, height: 32 } },
};

/** Two markers (start 0 / 1000) with a heading + a `mag` filter column [3, 7]. */
function iconTile(extra: Partial<BinaryFeatures> = {}) {
  return makePointTile(
    2,
    [
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + 0.001,
      anchor.latitude,
    ],
    {
      startTimes: new Float32Array([0, 1000]),
      endTimes: new Float32Array([0, 1000]),
      numericProps: {
        heading: new Float32Array([0, 90]),
        mag: new Float32Array([3, 7]),
      },
      ...extra,
    },
    { layerName: 'icons', geometryType: GeometryType.Point },
  );
}

const bundleOf = (layer: STTIconLayer): IconMaterialBundle =>
  (layer as unknown as { bundle: IconMaterialBundle }).bundle;

describe('icon buffers — filterValues (per icon instance)', () => {
  it('emits one value per point feature from filterProperty', () => {
    const buf = buildIconBuffers([iconTile()], proj, 0, {
      ...iconOpts,
      icon: 'marker',
      angleProperty: null,
      sizeProperty: null,
      colorMode: { type: 'constant', color: [255, 255, 255, 255] },
      filterProperty: 'mag',
    });
    expect(buf.count).toBe(2);
    expect(Array.from(buf.filterValues)).toEqual([3, 7]);
  });

  it('is 0-length when no filterProperty is set', () => {
    const buf = buildIconBuffers([iconTile()], proj, 0, {
      ...iconOpts,
      icon: 'marker',
      angleProperty: null,
      sizeProperty: null,
      colorMode: { type: 'constant', color: [255, 255, 255, 255] },
    });
    expect(buf.filterValues.length).toBe(0);
  });

  it('falls back to 0 where a tile lacks the column', () => {
    const noCol = iconTile();
    // Drop `mag` (keep the layer valid) so the fallback path is exercised.
    delete (noCol.layers[0].features.numericProps as Record<string, unknown>)
      .mag;
    const buf = buildIconBuffers([noCol], proj, 0, {
      ...iconOpts,
      icon: 'marker',
      angleProperty: null,
      sizeProperty: null,
      colorMode: { type: 'constant', color: [255, 255, 255, 255] },
      filterProperty: 'mag',
    });
    expect(Array.from(buf.filterValues)).toEqual([0, 0]);
  });
});

describe('icon material — DataFilter node graph builds + composes', () => {
  // Composes across every icon mode (window / wake / cumulative / none) AND with
  // the glide (motionInterpolation) path — all install the filter uniforms.
  for (const mode of ['window', 'wake', 'cumulative', 'none'] as IconMode[]) {
    it(`builds with dataFilter (mode: ${mode})`, () => {
      const b = createIconMaterial({
        mode,
        atlas: new Texture(),
        dataFilter: true,
      });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.filter).toBeInstanceOf(DataFilterUniforms);
    });
  }

  it('composes dataFilter with the glide keyframe path', () => {
    const b = createIconMaterial({
      mode: 'window',
      atlas: new Texture(),
      dataFilter: true,
      glide: { texture: new Texture() },
    });
    expect(b.material.vertexNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.filter).toBeInstanceOf(DataFilterUniforms);
    expect(b.glide).not.toBeNull();
  });

  it('omits the filter uniforms when dataFilter is off', () => {
    expect(
      createIconMaterial({ mode: 'window', atlas: new Texture() }).filter,
    ).toBeNull();
  });

  it('activates the filter + pushes the deck range on the uniform push', () => {
    const b = createIconMaterial({
      mode: 'window',
      atlas: new Texture(),
      dataFilter: true,
    });
    updateIconUniforms(b, {
      relativeCurrentTime: 0,
      dataFilter: { filterRange: [2, 8], filterSoftRange: [3, 7] },
    });
    expect(b.filter!.enabled.value).toBe(1);
    expect(b.filter!.filterMin.value).toBe(2);
    expect(b.filter!.filterMax.value).toBe(8);
    expect(b.filter!.useSoftMargin.value).toBe(1);
  });

  it('is a no-op push when no filter is installed', () => {
    const b = createIconMaterial({ mode: 'window', atlas: new Texture() });
    expect(() =>
      updateIconUniforms(b, {
        relativeCurrentTime: 0,
        dataFilter: { filterRange: [0, 1] },
      }),
    ).not.toThrow();
    expect(b.filter).toBeNull();
  });
});

describe('STTIconLayer — DataFilter end-to-end', () => {
  it('binds sttFilterValue + a filter-enabled material when filterProperty is set', () => {
    const layer = new STTIconLayer({
      ...iconOpts,
      angleProperty: 'heading',
      filterProperty: 'mag',
      filterRange: [2, 8],
    });
    layer.setTiles([iconTile()], ctx);

    const geom = layer.object.geometry as InstancedBufferGeometry;
    const a = geom.getAttribute('sttFilterValue');
    expect(a).toBeTruthy();
    expect(Array.from(a!.array)).toEqual([3, 7]); // per-icon value
    expect(bundleOf(layer).filter).toBeInstanceOf(DataFilterUniforms);

    // Range reaches the uniform on the per-frame push.
    layer.setTime(0);
    expect(bundleOf(layer).filter!.enabled.value).toBe(1);
    expect(bundleOf(layer).filter!.filterMax.value).toBe(8);
    layer.dispose();
  });

  it('binds nothing + installs no filter without filterProperty (byte-identical off)', () => {
    const layer = new STTIconLayer({ ...iconOpts, angleProperty: 'heading' });
    layer.setTiles([iconTile()], ctx);
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.getAttribute('sttFilterValue')).toBeUndefined();
    expect(bundleOf(layer).filter).toBeNull();
    // Static per-instance path unchanged.
    expect(geom.getAttribute('sttCenter')).toBeTruthy();
    expect(geom.getAttribute('sttAngle')).toBeTruthy();
    layer.dispose();
  });

  it('composes the filter collapse with the wake tail (both gates present)', () => {
    const layer = new STTIconLayer({
      ...iconOpts,
      mode: 'wake',
      wakeLength: 5000,
      angleProperty: 'heading',
      filterProperty: 'mag',
    });
    layer.setTiles([iconTile()], ctx);
    layer.setTime(2000);

    const bundle = bundleOf(layer);
    expect(bundle.mode).toBe('wake');
    expect(bundle.filter).toBeInstanceOf(DataFilterUniforms);
    expect(bundle.time.wakeLength.value).toBe(5000);
    // Both the wake gate's `sttStart` and the filter's `sttFilterValue` are bound.
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.getAttribute('sttStart')).toBeTruthy();
    expect(geom.getAttribute('sttFilterValue')).toBeTruthy();
    layer.dispose();
  });

  it('glide path is unaffected — the filter is a documented no-op there', () => {
    const layer = new STTIconLayer({
      ...iconOpts,
      angleProperty: 'heading',
      // Glide activation (interpolate + a resolvable id, window mode).
      interpolate: true,
      idProperty: 'mmsi',
      // A filter is set, but the glide path carries no per-sample filter column.
      filterProperty: 'mag',
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
    // Glide geometry (row-locator present), NO static filter attribute or uniform.
    const geom = layer.object.geometry as InstancedBufferGeometry;
    expect(geom.getAttribute('sttGlideRowV')).toBeTruthy();
    expect(geom.getAttribute('sttFilterValue')).toBeUndefined();
    expect(bundle.filter).toBeNull();
    expect(bundle.glide).not.toBeNull();
    layer.dispose();
  });
});
