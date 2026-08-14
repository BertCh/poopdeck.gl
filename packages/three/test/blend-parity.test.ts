// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Blend-mode parity gate.
 *
 * deck's `AnimatedTripsLayer` sets no blending override, so it draws with
 * deck's normal `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. `STTTripsLayer` used to
 * default `additive: true` — the only such divergence among the three line
 * layers — and additive blending SATURATES its destination: over a light
 * basemap every track clips to white no matter what colour the shader
 * computed. That is what hid the ocean-drifters SST ramp on its cream globe,
 * and it hid it identically before and after the colour fixes, because the
 * blend discards the colour after the fragment stage.
 *
 * So: normal blending unless a caller explicitly asks for the glow.
 */

import { describe, it, expect } from 'vitest';
import { NormalBlending, AdditiveBlending } from 'three';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { STTPathGeoLayer } from '../src/layers/path-geo-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile } from './_support/features';
import type { RGBA } from '../src/lib/color';

const CYAN: RGBA = [31, 186, 214, 255];
const constantColor = { type: 'constant' as const, color: CYAN };

const ctx = {
  projection: new LocalEnuProjection({ longitude: 0, latitude: 0 }),
  timeOrigin: 0,
};

/** One 3-vertex track, enough to force the layer to build its material. */
function track() {
  return makeLineTile({
    featureCount: 1,
    positions: new Float64Array([0, 0, 0.01, 0, 0.02, 0]),
    startIndices: new Uint32Array([0, 3]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([1000]),
  });
}

function blendingOf(layer: {
  setTiles: (t: ReturnType<typeof track>[], c: typeof ctx) => void;
  object: { material: { blending: number } };
}): number {
  layer.setTiles([track()], ctx);
  return layer.object.material.blending;
}

describe('trips layer blends like deck unless told otherwise', () => {
  it('defaults to NORMAL blending (deck AnimatedTripsLayer parity)', () => {
    const layer = new STTTripsLayer({ colorMode: constantColor });
    expect(blendingOf(layer as never)).toBe(NormalBlending);
  });

  it('still honours an explicit opt-in to the additive glow', () => {
    const layer = new STTTripsLayer({
      colorMode: constantColor,
      additive: true,
    });
    expect(blendingOf(layer as never)).toBe(AdditiveBlending);
  });

  it('explicit false stays normal', () => {
    const layer = new STTTripsLayer({
      colorMode: constantColor,
      additive: false,
    });
    expect(blendingOf(layer as never)).toBe(NormalBlending);
  });
});

describe('the sibling line layer already matched deck', () => {
  it('path-geo defaults to NORMAL blending', () => {
    const layer = new STTPathGeoLayer({ colorMode: constantColor });
    expect(blendingOf(layer as never)).toBe(NormalBlending);
  });
});
