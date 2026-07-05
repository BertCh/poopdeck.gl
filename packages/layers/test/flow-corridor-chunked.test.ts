/**
 * FlowCorridorLayer re-render gate across TIME-CHUNKED archives.
 *
 * A chunked flow archive (e.g. nwm-rivers) splits the timeline into temporal
 * tiles, each carrying only its window's matrix columns. The layer caches ONE
 * bucket axis from the first tile it sees — for a chunked archive that anchor is
 * an arbitrary chunk. The `_handleTimeUpdate` gate that forces the per-sub-step
 * re-expansion must therefore fire on GLOBAL playhead movement, never clamped to
 * the anchor chunk's own column count (which froze animation once the playhead
 * left that chunk). This drives the real gate via the Object.create harness.
 */

import { describe, it, expect, vi } from 'vitest';

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

import { FlowCorridorLayer } from '../src/layers/trips/flow-corridor-layer';

const DAY = 86_400_000;
const JAN_1 = 1_546_300_800_000; // 2019-01-01
const JUN_1 = JAN_1 + 151 * DAY; // ~mid-year anchor chunk

/**
 * A FlowCorridorLayer whose bucket axis is pre-anchored on a MID-YEAR chunk
 * (30 daily buckets), as if that chunk's tile loaded first. `state = {}` makes
 * the base `_handleTimeUpdate` (which needs a tileset) a no-op; `setState` is
 * captured.
 */
function anchoredLayer(anchorAbs: number) {
  const layer: any = Object.create(FlowCorridorLayer.prototype);
  layer.state = {};
  layer.props = { timeWindow: DAY };
  layer._numBuckets = 30; // one chunk's worth — NOT the timeline
  layer._bucketWidth = DAY; // uniform bin across chunks
  layer._bucket0Abs = anchorAbs;
  layer._lastStep = -1;
  layer.setStateCalls = [];
  layer.setState = (s: unknown) => layer.setStateCalls.push(s);
  return layer;
}

describe('FlowCorridorLayer chunked re-render gate', () => {
  it('fires on daily playhead movement FAR from the anchor chunk', () => {
    // Anchor on June; drive the playhead across 20 days of JANUARY (≈150 days
    // and well beyond `_numBuckets` from the anchor). The old clamp froze `step`
    // at 0 here → exactly one fire; the fix advances it every sub-step.
    const layer = anchoredLayer(JUN_1);
    let fires = 0;
    for (let d = 0; d < 20; d++) {
      const before = layer.setStateCalls.length;
      layer._handleTimeUpdate(JAN_1 + d * DAY);
      if (layer.setStateCalls.length > before) fires++;
    }
    expect(fires).toBeGreaterThanOrEqual(19);
  });

  it('fires across a chunk BOUNDARY as the playhead advances', () => {
    // Anchor on January; step from late in one 30-day chunk into the next.
    const layer = anchoredLayer(JAN_1);
    const t0 = JAN_1 + 29 * DAY; // last day of chunk 0's window
    const t1 = JAN_1 + 35 * DAY; // into chunk 1's window
    let fires = 0;
    for (let t = t0; t <= t1; t += DAY) {
      const before = layer.setStateCalls.length;
      layer._handleTimeUpdate(t);
      if (layer.setStateCalls.length > before) fires++;
    }
    // Crossing the 30-bucket boundary must NOT freeze — every day still fires.
    expect(fires).toBeGreaterThanOrEqual(6);
  });

  it('does not fire when the playhead is parked (no movement)', () => {
    const layer = anchoredLayer(JAN_1);
    layer._handleTimeUpdate(JAN_1 + 10 * DAY); // one fire to set _lastStep
    const after = layer.setStateCalls.length;
    layer._handleTimeUpdate(JAN_1 + 10 * DAY); // same time
    layer._handleTimeUpdate(JAN_1 + 10 * DAY);
    expect(layer.setStateCalls.length).toBe(after);
  });
});
