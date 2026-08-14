// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Colour-space parity gate.
 *
 * STT colours are authored as sRGB bytes and deck.gl writes them to an
 * unmanaged canvas, so what a demo config says is what the screen shows. Three
 * is colour-managed: `WebGPURenderer.outputColorSpace` is `SRGBColorSpace`, so
 * its output pass runs linear→sRGB over every fragment. Handing that pass a
 * value that is already sRGB encodes it TWICE — every layer lifts toward white
 * ([31,186,214] arrives as [98,222,236]) — which is the regression these tests
 * pin down. See `src/tsl/color-space.ts`.
 *
 * Three properties are checked:
 *   1. the CPU decode inverts the output pass exactly (all 256 bytes);
 *   2. every COLOUR material decodes sRGB in its `colorNode`…
 *   3. …and no ID material does — the GPU-pick pass renders to a RenderTarget
 *      (working colour space, no output encode), so a decode there would
 *      corrupt the 24-bit indices the picker reads back.
 */

import { describe, it, expect } from 'vitest';
import { Texture, SRGBColorSpace, Color, ColorManagement } from 'three';
import { srgbToLinear } from '../src/lib/color';
import { onScreen } from './_support/color-space';
import {
  createPointMaterial,
  createPointIdMaterial,
} from '../src/tsl/point-material';
import {
  createIconMaterial,
  createIconIdMaterial,
} from '../src/tsl/icon-material';
import {
  createColumnMaterial,
  createColumnIdMaterial,
} from '../src/tsl/column-material';
import {
  createArcMaterial,
  createArcIdMaterial,
} from '../src/tsl/arc-material';
import {
  createWideLineMaterial,
  createWideLineIdMaterial,
} from '../src/tsl/wide-line-material';
import {
  createPolygonMaterial,
  createPolygonIdMaterial,
} from '../src/tsl/polygon-material';
import {
  createIsoLineMaterial,
  createIsoLineIdMaterial,
} from '../src/tsl/iso-line-material';
import { createSurfelMaterial } from '../src/tsl/surfel-material';
import { createFlowArrowMaterial } from '../src/tsl/flow-arrow-material';
import { createFlowCorridorMaterial } from '../src/tsl/flow-corridor-material';

// ── 1. transfer function ─────────────────────────────────────────────────────

describe('srgbToLinear — inverts Three’s output encode', () => {
  it('round-trips every authored byte back to itself', () => {
    for (let byte = 0; byte <= 255; byte++) {
      const authored = byte / 255;
      expect(onScreen(srgbToLinear(authored))).toBeCloseTo(authored, 6);
    }
  });

  it('agrees with three’s own ColorManagement', () => {
    expect(ColorManagement.enabled).toBe(true); // else the whole premise is moot
    // `Color.setRGB(…, SRGBColorSpace)` is the conversion three applies to a hex
    // colour; our per-channel function must land on the same linear numbers.
    for (const [r, g, b] of [
      [31, 186, 214], // app cyan
      [253, 128, 93], // trip-head orange
      [255, 255, 204], // the summary ramp's pale low stop
      [0, 0, 0],
      [255, 255, 255],
    ]) {
      const c = new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
      expect(srgbToLinear(r / 255)).toBeCloseTo(c.r, 6);
      expect(srgbToLinear(g / 255)).toBeCloseTo(c.g, 6);
      expect(srgbToLinear(b / 255)).toBeCloseTo(c.b, 6);
    }
  });

  it('is monotonic and pinned at both ends', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = srgbToLinear(i / 100);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('darkens the mid-tones — the drift that made the layers look white', () => {
    // Undecoded, the output pass would have shown these instead of the authored
    // colour. The decode is what buys back the ~50/255 lift.
    expect(Math.round(onScreen(31 / 255) * 255)).toBe(98);
    expect(Math.round(onScreen(186 / 255) * 255)).toBe(222);
    expect(Math.round(onScreen(128 / 255) * 255)).toBe(188);
  });
});

// ── 2 + 3. material node graphs ──────────────────────────────────────────────

/** The sRGB→working `ColorSpaceNode` inside a node graph, if the graph has one. */
function findSrgbDecode(node: unknown): { source: string } | null {
  let found: { source: string } | null = null;
  (node as { traverse?: (cb: (n: unknown) => void) => void }).traverse?.(
    (n) => {
      const candidate = n as {
        source?: string;
        constructor?: { type?: string };
      };
      if (
        !found &&
        candidate?.constructor?.type === 'ColorSpaceNode' &&
        candidate.source === SRGBColorSpace
      ) {
        found = candidate as { source: string };
      }
    },
  );
  return found;
}

const colourMaterials: Array<
  [string, () => { material: { colorNode: unknown } }]
> = [
  ['point', () => createPointMaterial({ mode: 'window' })],
  ['icon', () => createIconMaterial({ mode: 'window', atlas: new Texture() })],
  ['column', () => createColumnMaterial({ timeFiltered: true })],
  ['arc', () => createArcMaterial({ shape: 'parabolic' })],
  ['wide-line', () => createWideLineMaterial({ mode: 'trail' })],
  ['polygon', () => createPolygonMaterial({ mode: 'window' })],
  ['iso-line', () => createIsoLineMaterial()],
  ['surfel', () => createSurfelMaterial({ packed: false })],
  ['flow-arrow', () => createFlowArrowMaterial({})],
  [
    'flow-corridor',
    () =>
      createFlowCorridorMaterial({
        valueTexture: new Texture(),
        rampTexture: new Texture(),
      }),
  ],
];

const idMaterials: Array<[string, () => { material: { colorNode: unknown } }]> =
  [
    ['point', () => createPointIdMaterial({ mode: 'window' })],
    [
      'icon',
      () => createIconIdMaterial({ mode: 'window', atlas: new Texture() }),
    ],
    ['column', () => createColumnIdMaterial({ timeFiltered: true })],
    ['arc', () => createArcIdMaterial({ shape: 'parabolic' })],
    ['wide-line', () => createWideLineIdMaterial({ mode: 'trail' })],
    ['polygon', () => createPolygonIdMaterial({ mode: 'window' })],
    ['iso-line', () => createIsoLineIdMaterial()],
  ];

describe('every colour material decodes sRGB before shading', () => {
  for (const [name, make] of colourMaterials) {
    it(`${name} material`, () => {
      const decode = findSrgbDecode(make().material.colorNode);
      expect(
        decode,
        `${name} colorNode is missing srgbToWorking`,
      ).not.toBeNull();
      expect(decode!.source).toBe(SRGBColorSpace);
    });
  }
});

describe('no id material decodes — pick indices must stay bit-exact', () => {
  for (const [name, make] of idMaterials) {
    it(`${name} id material`, () => {
      // The pick pass renders into a RenderTarget, which stays in the working
      // colour space: nothing re-encodes it, so nothing may decode it either.
      expect(findSrgbDecode(make().material.colorNode)).toBeNull();
    });
  }
});
