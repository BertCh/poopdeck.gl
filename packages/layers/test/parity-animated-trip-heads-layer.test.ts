/**
 * AnimatedTripHeadsLayer — deck.gl prop PARITY (audit 2026-07).
 *
 * The head-dot is a stock ScatterplotLayer driven by a CPU per-frame kernel.
 * These tests pin that every newly-added parity prop is FORWARDED to that
 * sublayer with its concrete default, and that overrides ride through:
 *
 *   - headBillboard        → ScatterplotLayer.billboard     (P1)
 *   - antialiasing         → ScatterplotLayer.antialiasing  (P2)
 *   - radiusScale          → ScatterplotLayer.radiusScale   (P2)
 *   - outline subsystem: headStroked→stroked, headFilled→filled,
 *     headStrokeColor→getLineColor, headStrokeWidth→getLineWidth,
 *     lineWidthUnits/Scale/MinPixels/MaxPixels                 (P2)
 *
 * Drives the real `renderLayers()` through the Object.create harness shared by
 * the sibling trips-family suites; GPU sublayers / deck core are mocked so no
 * luma shader loads.
 */

import { describe, it, expect } from 'vitest';
import { makePathTile } from './fake-tile';

import { vi } from 'vitest';

vi.mock('@deck.gl/layers', () => {
  class Fake {
    props: Record<string, any>;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { PathLayer: Fake, ScatterplotLayer: Fake, SolidPolygonLayer: Fake };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { ...core, Layer: FakeLayer, project32: { name: 'project32' } };
});

import { AnimatedTripHeadsLayer } from '../src/layers/trips/animated-trip-heads-layer';

/** Two 2-vertex corridors, both active over [0,100] — mid-trip yields 2 heads. */
function twoCorridorTile() {
  return makePathTile({
    paths: [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
    ],
    startTimes: [0, 0],
    endTimes: [100, 100],
    timeOffset: 0,
  });
}

/**
 * Object.create harness: instantiate the layer against its real prototype
 * (renderLayers + the CPU kernel run for real), then seed the minimal state
 * the base normally sets up. `defaults` mirrors `defaultProps` so unset props
 * resolve to the concrete deck defaults — the same values the base's
 * getSubLayerProps would see in production.
 */
function headsLayer(props: Record<string, any> = {}) {
  const layer: any = Object.create(AnimatedTripHeadsLayer.prototype);
  layer.props = {
    id: 'heads',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    // Fill vocabulary (existing props).
    headColor: [253, 128, 93, 255],
    sizeUnits: 'pixels',
    headRadiusPixels: 4,
    headRadius: 0,
    headRadiusMinPixels: 0,
    headRadiusMaxPixels: 1e9,
    // Parity defaults (must match defaultProps).
    radiusScale: 1,
    headBillboard: false,
    antialiasing: true,
    headStroked: false,
    headFilled: true,
    headStrokeColor: [0, 0, 0, 255],
    headStrokeWidth: 1,
    lineWidthUnits: 'meters',
    lineWidthScale: 1,
    lineWidthMinPixels: 0,
    lineWidthMaxPixels: Number.MAX_SAFE_INTEGER,
    ...props,
  };
  layer._currentTime = 50; // mid-trip for [0,100] windows → both heads active
  layer.preparedTileCache = new Map();
  layer.lastTilesRef = null;
  return layer;
}

function render(layer: any) {
  layer.state = { tiles: [twoCorridorTile()] };
  return layer.renderLayers();
}

describe('AnimatedTripHeadsLayer parity — defaults forwarded to the ScatterplotLayer sublayer', () => {
  it('forwards every new prop at its deck default', () => {
    const [sub] = render(headsLayer());
    expect(sub.props.radiusScale).toBe(1);
    expect(sub.props.billboard).toBe(false);
    expect(sub.props.antialiasing).toBe(true);
    expect(sub.props.stroked).toBe(false);
    expect(sub.props.filled).toBe(true);
    expect(sub.props.getLineColor).toEqual([0, 0, 0, 255]);
    expect(sub.props.getLineWidth).toBe(1);
    expect(sub.props.lineWidthUnits).toBe('meters');
    expect(sub.props.lineWidthScale).toBe(1);
    expect(sub.props.lineWidthMinPixels).toBe(0);
    expect(sub.props.lineWidthMaxPixels).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('defaultProps carries a concrete value for every new own prop (no undefined shadowing)', () => {
    const d = (AnimatedTripHeadsLayer as any).defaultProps;
    // Plain-value props resolve straight; descriptor props carry a .value.
    expect(d.headBillboard).toBe(false);
    expect(d.antialiasing).toBe(true);
    expect(d.headStroked).toBe(false);
    expect(d.headFilled).toBe(true);
    expect(d.lineWidthUnits).toBe('meters');
    expect(d.radiusScale.value).toBe(1);
    expect(d.headStrokeColor.value).toEqual([0, 0, 0, 255]);
    expect(d.headStrokeWidth.value).toBe(1);
    expect(d.lineWidthScale.value).toBe(1);
    expect(d.lineWidthMinPixels.value).toBe(0);
    expect(d.lineWidthMaxPixels.value).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('AnimatedTripHeadsLayer parity — P1 headBillboard', () => {
  it('forwards headBillboard → billboard', () => {
    const [sub] = render(headsLayer({ headBillboard: true }));
    expect(sub.props.billboard).toBe(true);
  });
});

describe('AnimatedTripHeadsLayer parity — P2 radiusScale / antialiasing', () => {
  it('forwards radiusScale as the global multiplier', () => {
    const [sub] = render(headsLayer({ radiusScale: 3 }));
    expect(sub.props.radiusScale).toBe(3);
  });

  it('forwards antialiasing:false to disable smoothing', () => {
    const [sub] = render(headsLayer({ antialiasing: false }));
    expect(sub.props.antialiasing).toBe(false);
  });
});

describe('AnimatedTripHeadsLayer parity — P2 outline subsystem', () => {
  it('drives the ring: headStroked/headFilled/headStrokeColor/headStrokeWidth', () => {
    const [sub] = render(
      headsLayer({
        headStroked: true,
        headFilled: false,
        headStrokeColor: [255, 255, 255, 200],
        headStrokeWidth: 2.5,
      }),
    );
    expect(sub.props.stroked).toBe(true);
    expect(sub.props.filled).toBe(false);
    expect(sub.props.getLineColor).toEqual([255, 255, 255, 200]);
    expect(sub.props.getLineWidth).toBe(2.5);
  });

  it('forwards the lineWidth units/scale/min/max pixel controls', () => {
    const [sub] = render(
      headsLayer({
        headStroked: true,
        lineWidthUnits: 'pixels',
        lineWidthScale: 2,
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: 8,
      }),
    );
    expect(sub.props.lineWidthUnits).toBe('pixels');
    expect(sub.props.lineWidthScale).toBe(2);
    expect(sub.props.lineWidthMinPixels).toBe(1);
    expect(sub.props.lineWidthMaxPixels).toBe(8);
  });

  it('falls back to the default stroke color when headStrokeColor is not an array', () => {
    // Guards the Array.isArray branch: a bad/unset value resolves to the
    // opaque-black default rather than leaking undefined to the sublayer.
    const [sub] = render(headsLayer({ headStrokeColor: undefined }));
    expect(sub.props.getLineColor).toEqual([0, 0, 0, 255]);
  });
});
