// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// GPU id-buffer picking for the LIT POINT-CLOUD kind — instanced billboard-quad
// discs over Point geometry, the same merged shape as `point` / `icon`, tagged
// `kind: 'pointCloud'` so a consumer narrowing on the flat `'point'` kind never
// silently also matches a lit cloud. Three seams, mirroring the proven
// icon/column template:
//   • PROVENANCE — `buildPointCloudBuffers` records one entry per merged point in
//     DRAW ORDER + a `tileKey → BinaryFeatures` map, so a decoded GPU id is a
//     valid index into it.
//   • ID MATERIAL — `createPointCloudIdMaterial` BUILDS (TSL graph) with the SAME
//     vertex-stage gates as the colour material (window collapse, same
//     `pointSize`/`sizeUnits` billboard), so an out-of-window point is equally
//     invisible AND unpickable, and it drops the lighting entirely (an exact
//     24-bit id must never be multiplied by a shade term). Pixel-level collapse
//     is browser-verify per this package's policy; here we gate on the graph,
//     the bundle shape and the uniforms.
//   • DISPATCH — the FULL `layer.pick()` path with a stub renderer/readback: a
//     chosen id colour resolves to the right `{tileKey, featureIndex,
//     kind:'pointCloud'}`, a sentinel background is a miss, an empty cloud never
//     touches the GPU, and the colour material is restored after the pass.
//
// Two further sections at the foot of the file carry the NODE-GRAPH and
// LIFECYCLE gates the pick pass rests on, and which nothing else in the package
// can reach headlessly: a pick only means anything if the id graph rasterises
// the same quad the colour graph did, if every `stt*` attribute either material
// reads is actually BOUND on the live geometry, and if the colour material the
// pass swaps back is still the compiled one.

import { describe, it, expect, vi } from 'vitest';
import type { Material } from 'three';
import type { TileId } from '@poopdeck.gl/core';
import { buildPointCloudBuffers } from '../src/lib/point-cloud-buffers';
import {
  createPointCloudMaterial,
  createPointCloudIdMaterial,
  updatePointCloudUniforms,
  PointCloudUniforms,
  POINT_CLOUD_AMBIENT,
  POINT_CLOUD_DIFFUSE,
  POINT_CLOUD_LIGHT_DIRECTION,
  POINT_CLOUD_SIZE,
  type PointCloudSizeUnits,
} from '../src/tsl/point-cloud-material';
import { varying, select, float, attribute } from '../src/tsl/nodes';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import { STTPointCloudLayer } from '../src/layers/point-cloud-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import {
  GpuPicker,
  encodeId,
  decodeId,
  buildIdColors,
  type PickRenderer,
  type RenderTargetCtor,
} from '../src/lib/gpu-pick';
import { featureTileKey } from '../src/lib/id-pick';
import type { RGBA } from '../src/lib/color';
import { makePointTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };

const BUFFER_OPTS = {
  colorMode: { type: 'constant' as const, color: [255, 255, 255, 255] as RGBA },
  elevationProperty: null,
  elevationScale: 1,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// One merged fixture: tile A (2 points → merged 0,1) then tile B (3 points →
// merged 2,3,4). Tile A carries surface normals, B does not — so the build lands
// on the lit-by-normal variant and B's points take deck's default [0,0,1],
// exercising the mixed case through the whole pick chain.

const idA: TileId = { z: 16, x: 5, y: 6, t: 0 };
const idB: TileId = { z: 16, x: 7, y: 8, t: 500 };
const tileA = makePointTile(
  2,
  [
    anchor.longitude,
    anchor.latitude,
    anchor.longitude + 0.001,
    anchor.latitude,
  ],
  {
    vectorProps: {
      normal: { value: new Float32Array([0, 0, 1, 0, 1, 0]), size: 3 },
    },
    numericProps: { intensity: new Float32Array([10, 20]) },
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    featureIds: new Uint32Array([100, 101]),
  },
  { id: idA, layerName: 'lidar', timeOffset: 0 },
);
const tileB = makePointTile(
  3,
  [
    anchor.longitude + 0.002,
    anchor.latitude + 0.001,
    anchor.longitude + 0.003,
    anchor.latitude + 0.002,
    anchor.longitude + 0.004,
    anchor.latitude + 0.003, // the last (merged index 4)
  ],
  {
    numericProps: { intensity: new Float32Array([30, 40, 50]) },
    startTimes: new Float32Array([0, 0, 0]),
    endTimes: new Float32Array([1000, 1000, 1000]),
    featureIds: new Uint32Array([200, 201, 202]),
  },
  { id: idB, layerName: 'lidar', timeOffset: 500 },
);

/** Stub `GpuPicker` whose readback RETURNS one 1×1 texel painted `rgb` — the
 *  exact seam of `gpu-pick-readback.test.ts`, no GPU device. */
function mockPicker(rgb: readonly [number, number, number]) {
  const pixels = new Uint8Array([rgb[0], rgb[1], rgb[2], 255]);
  const renderer: PickRenderer = {
    domElement: { width: 200, height: 200 } as unknown as HTMLCanvasElement,
    getPixelRatio: () => 1,
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    render: () => {},
    readRenderTargetPixelsAsync: async () => pixels,
  };
  const camera = { setViewOffset() {}, clearViewOffset() {} };
  const TargetCtor = class {
    dispose() {}
  } as unknown as RenderTargetCtor;
  const picker = new GpuPicker(renderer, TargetCtor, 1);
  return { picker, camera };
}

// ── PROVENANCE ────────────────────────────────────────────────────────────────

describe('buildPointCloudBuffers provenance', () => {
  it('records one entry per merged point in emit order + a tileKey→binary map', () => {
    const buf = buildPointCloudBuffers([tileA, tileB], proj, 0, BUFFER_OPTS);
    expect(buf.count).toBe(5);
    expect(buf.provenance.length).toBe(5);
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: featureTileKey(idA, 'lidar'),
      featureIndex: 0,
    });
    // Boundary: last point of tile A, first point of tile B.
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: featureTileKey(idA, 'lidar'),
      featureIndex: 1,
    });
    expect(buf.provenance.resolve(2)).toEqual({
      tileKey: featureTileKey(idB, 'lidar'),
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(4)).toEqual({
      tileKey: featureTileKey(idB, 'lidar'),
      featureIndex: 2,
    });
    // Out of range → null (a background / stale readback).
    expect(buf.provenance.resolve(5)).toBeNull();
    expect(buf.provenance.resolve(-1)).toBeNull();
    expect(buf.binaryByTileKey.get(featureTileKey(idA, 'lidar'))).toBe(
      tileA.layers[0].features,
    );
    expect(buf.binaryByTileKey.get(featureTileKey(idB, 'lidar'))).toBe(
      tileB.layers[0].features,
    );
    expect(buf.binaryByTileKey.size).toBe(2);
  });

  it('keeps the normal buffer index-aligned with the provenance order', () => {
    const buf = buildPointCloudBuffers([tileA, tileB], proj, 0, BUFFER_OPTS);
    expect(buf.hasNormals).toBe(true);
    expect(buf.normals.length).toBe(5 * 3);
    // Merged 1 = tile A feature 1 → its own normal; merged 2 = tile B feature 0
    // → the default, since B carries no normal column.
    expect(Array.from(buf.normals.slice(3, 6))).toEqual([0, 1, 0]);
    expect(Array.from(buf.normals.slice(6, 9))).toEqual([0, 0, 1]);
  });

  it('emits empty (non-null) pick buffers when no points merge', () => {
    const buf = buildPointCloudBuffers([], proj, 0, BUFFER_OPTS);
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.provenance.resolve(0)).toBeNull();
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

// ── ID MATERIAL ───────────────────────────────────────────────────────────────

describe('createPointCloudIdMaterial (reuses the colour material collapse gates)', () => {
  it('builds a vertexNode + opacityNode + colorNode graph for both sizings', () => {
    for (const sizeUnits of ['pixels', 'meters'] as PointCloudSizeUnits[]) {
      const b = createPointCloudIdMaterial({ sizeUnits });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.material.colorNode).toBeTruthy();
      expect(b.sizeUnits).toBe(sizeUnits);
      expect(b.timeFiltered).toBe(true);
      expect(b.time).toBeInstanceOf(TimeFilterUniforms);
      expect(b.pointCloud).toBeInstanceOf(PointCloudUniforms);
      // The id is flat by construction — never the lit-by-normal variant, so it
      // can be shared across a normals flip and can never be shade-modulated.
      expect(b.normals).toBe(false);
      // Opaque + hard alpha cut: a decoded RGB must be an exact 24-bit index.
      expect(b.material.transparent).toBe(false);
      expect(b.material.alphaTest).toBe(0.5);
    }
  });

  it('drops the window gate with the colour material (timeFiltered: false)', () => {
    const b = createPointCloudIdMaterial({ timeFiltered: false });
    expect(b.timeFiltered).toBe(false);
    expect(b.material.vertexNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
  });

  it('ignores the `normals` option the colour material branches on', () => {
    // Same graph either way: the lit variant is a COLOUR-only concern, so one id
    // material stays valid across an archive's normals flip.
    expect(createPointCloudIdMaterial({ normals: true }).normals).toBe(false);
    expect(createPointCloudMaterial({ normals: true }).normals).toBe(true);
    expect(createPointCloudMaterial({}).normals).toBe(false);
  });
});

// ── DISPATCH ──────────────────────────────────────────────────────────────────

describe('STTPointCloudLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  it('resolves a merged id colour to {tileKey, featureIndex, kind:pointCloud}', async () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA, tileB], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(4)); // merged 4 → tile B feat 2
    const hit = await layer.pick(picker, camera, 12, 34);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('pointCloud');
    expect(hit!.layerId).toBe('cloud');
    expect(hit!.tileKey).toBe(featureTileKey(idB, 'lidar'));
    expect(hit!.featureIndex).toBe(2);
    expect(hit!.index).toBe(2); // back-compat alias of featureIndex
    expect(hit!.object!.id).toBe(202);
    expect(hit!.object!.intensity).toBeCloseTo(50, 5);
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude + 0.004, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude + 0.003, 9);
    expect(hit!.screen).toEqual([12, 34]);
    // The id material is swapped in only for the render; the colour material
    // must be back on the mesh by the time the readback resolves.
    expect(layer.object.material).toBe(colourMat);
    layer.dispose();
  });

  it('keeps merged index 0 a valid hit (black texel is NOT the background)', async () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA, tileB], ctx);
    // The id colour the shader paints for merged 0 decodes back to 0.
    const idColors = buildIdColors(5);
    expect(
      decodeId([
        Math.round(idColors[0] * 255),
        Math.round(idColors[1] * 255),
        Math.round(idColors[2] * 255),
      ]),
    ).toBe(0);
    const { picker, camera } = mockPicker(encodeId(0));
    const hit = await layer.pick(picker, camera, 1, 2);
    expect(hit!.tileKey).toBe(featureTileKey(idA, 'lidar'));
    expect(hit!.featureIndex).toBe(0);
    expect(hit!.object!.id).toBe(100);
    layer.dispose();
  });

  it('reports a sentinel background readback as a miss (no hit)', async () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA, tileB], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]); // → MAX_PICK_ID ≥ count
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('returns null (never touches the GPU) when there are no points', async () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([], ctx);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('resolves a stale index to null after the tiles are dropped', async () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA, tileB], ctx);
    expect(layer.resolvePick(4)).not.toBeNull();
    // A reload that merges nothing must adopt the EMPTY pick-identity pair.
    layer.setTiles([], ctx);
    expect(layer.resolvePick(4)).toBeNull();
    layer.dispose();
  });
});

// ── MATERIAL GRAPH ────────────────────────────────────────────────────────────
//
// A TSL graph is plain-old data (see `tsl-time-filter-conformance.test.ts`), so
// the shipped node graphs can be WALKED headlessly. That is the only headless
// evidence we can get for the four claims this kind rests on, each of which a
// plausible-looking material could silently drop while every behavioural test
// stayed green:
//   • the lighting is REAL — the ambient / diffuse / light-direction uniforms
//     are genuinely wired into the colour node, and the lit variant reads the
//     per-instance `sttNormal` while the impostor variant reads the quad corner;
//   • the window cut is a VERTEX-stage collapse, not a fragment discard;
//   • `srgbToWorking` runs EXACTLY ONCE, on the colour node, never on alpha,
//     never inside the id material;
//   • no `select()` is wrapped in a `varying()` (the recurring WGSL crash).
// Pixel output remains browser-verify per this package's policy.

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Depth-first walk of a TSL node graph. `parents` is skipped: three back-links
 * every node to its consumers, so following it would climb out of the subtree
 * under test and make every reachability answer trivially true.
 */
function walkGraph(
  node: any,
  visit: (n: any) => void,
  seen = new Set<any>(),
): void {
  if (node == null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parents') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const e of value) walkGraph(e, visit, seen);
    else if (value && typeof value === 'object') walkGraph(value, visit, seen);
  }
}

/** Every geometry/instance attribute name the graph reads, sorted + deduped. */
function attributeNames(root: any): string[] {
  const out = new Set<string>();
  walkGraph(root, (n) => {
    if (n.constructor?.name === 'AttributeNode')
      out.add(String(n._attributeName));
  });
  return [...out].sort();
}

/** How many nodes of a given three class the graph contains. */
function countClass(root: any, className: string): number {
  let n = 0;
  walkGraph(root, (x) => {
    if (x.constructor?.name === className) n++;
  });
  return n;
}

/** Whether `target` (a uniform node object) is reachable from `root`. */
function reaches(root: any, target: any): boolean {
  let hit = false;
  walkGraph(root, (n) => {
    if (n === target) hit = true;
  });
  return hit;
}

/** How many `varying()`s wrap a subtree containing a `select()`. Must be 0. */
function varyingsWrappingSelect(root: any): number {
  let bad = 0;
  walkGraph(root, (n) => {
    if (n.constructor?.name !== 'VaryingNode') return;
    let conditional = false;
    walkGraph(n.node, (m) => {
      if (m.constructor?.name === 'ConditionalNode' || m.condNode !== undefined)
        conditional = true;
    });
    if (conditional) bad++;
  });
  return bad;
}

/** Every scalar uniform value reachable from a graph. */
function uniformValues(root: any): number[] {
  const out: number[] = [];
  walkGraph(root, (n) => {
    if (n.constructor?.name === 'UniformNode' && typeof n.value === 'number') {
      out.push(n.value);
    }
  });
  return out;
}

/** The three node slots a material can carry, for a whole-material sweep. */
const slots = (m: any) => [m.vertexNode, m.colorNode, m.opacityNode];

describe('point-cloud material graph — the lit variant is real, not a flag', () => {
  it('lights the per-instance sttNormal, and only on the normals variant', () => {
    const lit = createPointCloudMaterial({ normals: true });
    const impostor = createPointCloudMaterial({ normals: false });
    // The lit graph reads the baked normal; the impostor graph reads the quad's
    // own corner (`position`) and derives (u, v, √(1−r²)) from it instead.
    expect(attributeNames(lit.material.colorNode)).toEqual([
      'sttColor',
      'sttNormal',
    ]);
    expect(attributeNames(impostor.material.colorNode)).toEqual([
      'position',
      'sttColor',
    ]);
    // Neither variant lets the normal leak into the geometry or the alpha.
    expect(attributeNames(lit.material.vertexNode)).not.toContain('sttNormal');
    expect(attributeNames(lit.material.opacityNode)).not.toContain('sttNormal');
  });

  it('wires ambient + diffuse·(N·L) into the colour node in BOTH variants', () => {
    for (const normals of [true, false]) {
      const b = createPointCloudMaterial({ normals });
      const { ambient, diffuse, lightDirection } = b.pointCloud;
      // An unlit material that merely reported `normals: true` would pass every
      // behavioural test in this file; it cannot pass this one.
      expect(reaches(b.material.colorNode, ambient)).toBe(true);
      expect(reaches(b.material.colorNode, diffuse)).toBe(true);
      expect(reaches(b.material.colorNode, lightDirection)).toBe(true);
      // Shading is a COLOUR term only — never geometry, never alpha.
      expect(reaches(b.material.vertexNode, lightDirection)).toBe(false);
      expect(reaches(b.material.opacityNode, ambient)).toBe(false);
    }
  });

  it('cuts the time window in the VERTEX stage, not with a fragment discard', () => {
    for (const make of [createPointCloudMaterial, createPointCloudIdMaterial]) {
      const on = make({});
      // The playhead reaches the clip-space position, i.e. the billboard's
      // half-size collapses to 0 off-window (deck.gl #7509). `alphaTest` is left
      // to the disc edge alone.
      expect(reaches(on.material.vertexNode, on.time.currentTime)).toBe(true);
      expect(reaches(on.material.vertexNode, on.pointCloud.pointSize)).toBe(
        true,
      );
      expect(attributeNames(on.material.vertexNode)).toEqual([
        'position',
        'sttCenter',
        'sttEnd',
        'sttStart',
      ]);
      // With the filter off the clock must not reach geometry at all.
      const off = make({ timeFiltered: false });
      expect(reaches(off.material.vertexNode, off.time.currentTime)).toBe(
        false,
      );
    }
  });

  it('reads the viewport uniform only on the pixel-sizing path', () => {
    const px = createPointCloudMaterial({ sizeUnits: 'pixels' });
    const m = createPointCloudMaterial({ sizeUnits: 'meters' });
    expect(reaches(px.material.vertexNode, px.pointCloud.viewport)).toBe(true);
    expect(reaches(m.material.vertexNode, m.pointCloud.viewport)).toBe(false);
  });

  it('applies srgbToWorking exactly once, on colour, never on alpha or the id', () => {
    for (const normals of [true, false]) {
      const b = createPointCloudMaterial({ normals });
      // Once, AFTER the shade multiply — a second conversion would wash the
      // cloud toward white, none would render it doubly dark.
      expect(countClass(b.material.colorNode, 'ColorSpaceNode')).toBe(1);
      expect(countClass(b.material.opacityNode, 'ColorSpaceNode')).toBe(0);
      expect(countClass(b.material.vertexNode, 'ColorSpaceNode')).toBe(0);
    }
    // The id pass renders into a RenderTarget with no output encode: converting
    // there would corrupt the 24-bit index.
    const id = createPointCloudIdMaterial({});
    for (const slot of slots(id.material)) {
      expect(countClass(slot, 'ColorSpaceNode')).toBe(0);
    }
  });

  it('never wraps a select() in a varying() (the WGSL build crash)', () => {
    const built = [
      createPointCloudMaterial({ normals: true }),
      createPointCloudMaterial({ normals: false }),
      createPointCloudMaterial({ timeFiltered: false }),
      createPointCloudMaterial({ sizeUnits: 'meters' }),
      createPointCloudIdMaterial({}),
      createPointCloudIdMaterial({ timeFiltered: false, sizeUnits: 'meters' }),
    ];
    for (const b of built) {
      for (const slot of slots(b.material)) {
        expect(varyingsWrappingSelect(slot)).toBe(0);
      }
    }
    // Negative control: the detector must actually fire on the shape it guards
    // against, otherwise the sweep above is vacuous.
    const offender = varying(
      select(
        attribute('sttStart', 'float').greaterThan(float(0)),
        float(1),
        float(0),
      ),
    );
    expect(varyingsWrappingSelect(offender)).toBe(1);
  });

  it('paints the id flat and unlit while rasterising the identical quad', () => {
    const colour = createPointCloudMaterial({ normals: true });
    const id = createPointCloudIdMaterial({});
    // Same vertex-stage inputs ⇒ same quad ⇒ a pick lands on the pixels the
    // point drew.
    expect(attributeNames(id.material.vertexNode)).toEqual(
      attributeNames(colour.material.vertexNode),
    );
    // The id itself is nothing but the flat per-instance colour.
    expect(attributeNames(id.material.colorNode)).toEqual(['sttIdColor']);
    expect(reaches(id.material.colorNode, id.pointCloud.ambient)).toBe(false);
    expect(reaches(id.material.colorNode, id.pointCloud.opacity)).toBe(false);
  });
});

describe('updatePointCloudUniforms — one values object, every holder', () => {
  it('pushes the live values through to the uniform nodes', () => {
    const b = createPointCloudMaterial({});
    updatePointCloudUniforms(b, {
      relativeCurrentTime: 1234,
      params: { windowHalf: 250, fadeIn: 40, fadeOut: 60 },
      pointSize: 3,
      opacity: 0.5,
      viewport: [800, 600],
      lightDirection: [0, 1, 0],
      ambient: 0.1,
      diffuse: 0.9,
    });
    expect(b.time.currentTime.value).toBe(1234);
    expect(b.time.windowHalf.value).toBe(250);
    expect(b.time.fadeIn.value).toBe(40);
    expect(b.pointCloud.pointSize.value).toBe(3);
    expect(b.pointCloud.opacity.value).toBe(0.5);
    expect(b.pointCloud.viewport.value.x).toBe(800);
    expect(b.pointCloud.viewport.value.y).toBe(600);
    expect(b.pointCloud.lightDirection.value.y).toBe(1);
    expect(b.pointCloud.ambient.value).toBe(0.1);
    expect(b.pointCloud.diffuse.value).toBe(0.9);
  });

  it('falls back to the deck-parity defaults when a value is omitted', () => {
    const b = createPointCloudMaterial({});
    updatePointCloudUniforms(b, {
      relativeCurrentTime: 0,
      pointSize: 99,
      ambient: 0,
    });
    updatePointCloudUniforms(b, { relativeCurrentTime: 0 });
    expect(b.pointCloud.pointSize.value).toBe(POINT_CLOUD_SIZE);
    expect(b.pointCloud.opacity.value).toBe(1);
    expect(b.pointCloud.ambient.value).toBe(POINT_CLOUD_AMBIENT);
    expect(b.pointCloud.diffuse.value).toBe(POINT_CLOUD_DIFFUSE);
    expect(b.pointCloud.lightDirection.value.x).toBeCloseTo(
      POINT_CLOUD_LIGHT_DIRECTION[0],
      12,
    );
    // The viewport is host-pushed on resize, so an omitted value must NOT be
    // stomped back to a default mid-session.
    updatePointCloudUniforms(b, {
      relativeCurrentTime: 0,
      viewport: [640, 480],
    });
    updatePointCloudUniforms(b, { relativeCurrentTime: 0 });
    expect(b.pointCloud.viewport.value.x).toBe(640);
  });
});

// ── MATERIAL LIFECYCLE (audit E5) ─────────────────────────────────────────────

describe('STTPointCloudLayer material lifecycle', () => {
  /** Every `stt*` attribute the live colour material reads must be BOUND. */
  function expectAttributesBound(layer: STTPointCloudLayer): void {
    const material = layer.object.material as any;
    const read = new Set<string>();
    for (const slot of slots(material)) {
      for (const name of attributeNames(slot)) read.add(name);
    }
    const bound = Object.keys(layer.object.geometry.attributes);
    // There is no compile-time link between `geometry.setAttribute` and the
    // material's `attribute('...')` — only string identity — so a typo reads
    // zeros silently. `position` comes from the quad template itself.
    for (const name of read) expect(bound).toContain(name);
    expect(read.has('position')).toBe(true);
  }

  it('binds exactly the attributes the LIT graph reads', () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA, tileB], ctx);
    expectAttributesBound(layer);
    expect(Object.keys(layer.object.geometry.attributes)).toContain(
      'sttNormal',
    );
    layer.dispose();
  });

  it('binds no sttNormal for an archive with no normal column', () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileB], ctx); // tile B carries no `normal` column
    expectAttributesBound(layer);
    const bound = Object.keys(layer.object.geometry.attributes);
    expect(bound).not.toContain('sttNormal');
    // ...and the impostor graph must not be reading one either.
    const material = layer.object.material as any;
    expect(attributeNames(material.colorNode)).not.toContain('sttNormal');
    layer.dispose();
  });

  it('binds sttIdColor onto the LIVE geometry on the first pick', async () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA, tileB], ctx);
    expect(Object.keys(layer.object.geometry.attributes)).not.toContain(
      'sttIdColor',
    );
    const { picker, camera } = mockPicker(encodeId(0));
    await layer.pick(picker, camera, 1, 2);
    const bound = Object.keys(layer.object.geometry.attributes);
    expect(bound).toContain('sttIdColor');
    // The id graph reads nothing the geometry does not carry.
    const id = createPointCloudIdMaterial({});
    for (const slot of slots(id.material)) {
      for (const name of attributeNames(slot)) expect(bound).toContain(name);
    }
    layer.dispose();
  });

  it('keeps ONE material across a MIXED archive (E5: no shader rebuild)', () => {
    // `hasNormals` is a property of the RESIDENT tiles, not of the archive:
    // tile A carries normals, tile B does not. Selecting the material variant
    // off the raw per-build verdict disposed and rebuilt the TSL material every
    // time the resident mix changed — a full nodeBuilderCache/program/pipeline
    // eviction per tile arrival, which is exactly what audit E5 removed from the
    // other merged-buffer layers.
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA], ctx); // normals present → lit variant
    const m1 = layer.object.material as Material;
    const disposed = vi.spyOn(m1, 'dispose');

    layer.setTiles([tileB], ctx); // normals gone from the resident set
    expect(layer.object.material).toBe(m1);
    layer.setTiles([tileA, tileB], ctx);
    expect(layer.object.material).toBe(m1);
    layer.setTiles([], ctx); // empty transition keeps the compiled material
    expect(layer.object.visible).toBe(false);
    expect(layer.object.material).toBe(m1);
    layer.setTiles([tileB], ctx);
    expect(layer.object.visible).toBe(true);
    expect(layer.object.material).toBe(m1);
    expect(disposed).not.toHaveBeenCalled();

    // Only the layer's own teardown releases it.
    layer.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('keeps the pinned lit graph fed: sttNormal stays bound and index-aligned', () => {
    // The companion to the test above: pinning the variant is only safe if the
    // attribute keeps arriving. An unbound `sttNormal` reads (0,0,0) on device,
    // so N·L is 0 and the whole cloud drops to the ambient floor.
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA], ctx);
    layer.setTiles([tileB], ctx);
    const normal = layer.object.geometry.attributes.sttNormal;
    expect(normal).toBeTruthy();
    expect(normal.count).toBe(3); // tile B's three points
    expect(Array.from((normal.array as Float32Array).slice(0, 3))).toEqual([
      0, 0, 1,
    ]);
    layer.dispose();
  });

  it('still churns GEOMETRY per setTiles — the previous buffer is released', () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([tileA, tileB], ctx);
    const g1 = layer.object.geometry;
    expect(g1.instanceCount).toBe(5);
    const disposed = vi.spyOn(g1, 'dispose');
    layer.setTiles([tileA], ctx);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(layer.object.geometry).not.toBe(g1);
    expect(layer.object.geometry.instanceCount).toBe(2);
    layer.dispose();
  });
});

// ── f32 DISCIPLINE (timeOrigin rebasing, end to end) ──────────────────────────

describe('STTPointCloudLayer time rebasing', () => {
  // A realistic playback clock: epoch-ms in the 1.7e12 range. f32 carries 24
  // bits of integer mantissa (16.7e6), so an ABSOLUTE epoch timestamp lands in
  // a bucket ~130 s wide — the window filter would not merely drift, it would
  // stop resolving frames at all. Both halves of the fix have to hold: the
  // builder folds `timeOffset - timeOrigin` into every start/end, and the layer
  // pushes `absolute - timeOrigin` as the per-frame uniform.
  const EPOCH = Date.UTC(2024, 5, 1);
  const F32_INT_LIMIT = 2 ** 24;

  const epochTile = makePointTile(
    2,
    [
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + 0.001,
      anchor.latitude,
    ],
    {
      startTimes: new Float32Array([10, 20]),
      endTimes: new Float32Array([1010, 1020]),
    },
    { id: idA, layerName: 'lidar', timeOffset: EPOCH },
  );

  it('never lets a raw epoch-ms reach an f32 buffer or a uniform', () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    layer.setTiles([epochTile], { projection: proj, timeOrigin: EPOCH });
    layer.setTime(EPOCH + 250);

    const starts = layer.object.geometry.attributes.sttStart;
    expect(Array.from(starts.array as Float32Array)).toEqual([10, 20]);

    // The playhead the vertex-stage collapse compares against is relative.
    const values = uniformValues((layer.object.material as any).vertexNode);
    expect(values).toContain(250);
    for (const v of values) expect(Math.abs(v)).toBeLessThan(F32_INT_LIMIT);
    layer.dispose();
  });

  it('rebases a tile whose timeOffset differs from the scene origin', () => {
    const layer = new STTPointCloudLayer({ id: 'cloud' });
    // Scene origin one minute BEFORE the tile's own offset.
    layer.setTiles([epochTile], {
      projection: proj,
      timeOrigin: EPOCH - 60_000,
    });
    const starts = layer.object.geometry.attributes.sttStart;
    expect(Array.from(starts.array as Float32Array)).toEqual([60_010, 60_020]);
    layer.setTime(EPOCH);
    const values = uniformValues((layer.object.material as any).vertexNode);
    expect(values).toContain(60_000);
    layer.dispose();
  });
});
