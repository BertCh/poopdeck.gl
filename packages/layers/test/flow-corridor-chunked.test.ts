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
 * (30 daily buckets), as if that chunk's tile loaded first. The axis lives in
 * `state` (deck's `_transferState` moves state but re-runs class-field
 * initializers, so a field-held axis is lost on any layer re-instantiation);
 * `state = {…}` here also makes the base `_handleTimeUpdate` (which needs a
 * tileset) a no-op. `setState` is captured.
 */
function anchoredLayer(anchorAbs: number, archiveKey = 'chunked.stt') {
  const layer: any = Object.create(FlowCorridorLayer.prototype);
  layer.props = { timeWindow: DAY, data: archiveKey };
  layer.state = {
    [(FlowCorridorLayer as any).AXIS_SLOT]: {
      archiveKey,
      numBuckets: 30, // one chunk's worth — NOT the timeline
      bucketWidth: DAY, // uniform bin across chunks
      bucket0Abs: anchorAbs,
      lastStep: -1,
    },
  };
  layer.setStateCalls = [];
  layer.setState = (s: unknown) => layer.setStateCalls.push(s);
  return layer;
}

/** The layer's live bucket axis (state-resident). */
function axisOf(layer: any) {
  return layer.state[(FlowCorridorLayer as any).AXIS_SLOT];
}

describe('FlowCorridorLayer chunked re-render gate', () => {
  it('fires on daily playhead movement FAR from the anchor chunk', () => {
    // Anchor on June; drive the playhead across 20 days of JANUARY (≈150 days
    // and well beyond the anchor chunk's own column count). The old clamp froze `step`
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
    layer._handleTimeUpdate(JAN_1 + 10 * DAY); // one fire to set axis.lastStep
    const after = layer.setStateCalls.length;
    layer._handleTimeUpdate(JAN_1 + 10 * DAY); // same time
    layer._handleTimeUpdate(JAN_1 + 10 * DAY);
    expect(layer.setStateCalls.length).toBe(after);
  });
});

/**
 * The bucket axis is latched from the FIRST matrix tile and `noteAxis` is
 * idempotent, so nothing re-derived it when the layer's `data` changed. Swapping
 * a 1-HOUR-bucket archive for a 1-MINUTE-bucket one therefore kept
 * `bucketWidth = 3_600_000` and drove the colour re-expansion ~60× too slowly.
 * The axis now carries the archive it was latched from and clears on a mismatch.
 */
describe('FlowCorridorLayer bucket-axis reset on a data swap', () => {
  const HOUR = 3_600_000;
  const MINUTE = 60_000;

  /** A matrix tile whose 4 buckets span `span` ms from `t0`. */
  const matrixTile = (t0: number, span: number) =>
    ({
      vertexValueBuckets: 4,
      vertexValueMatrix: Float32Array.from([1, 2, 3, 4]),
      startTimes: Float32Array.from([0]),
      endTimes: Float32Array.from([span]),
      timeOffset: t0,
    }) as any;

  it('re-latches the bin width when the archive URL changes', () => {
    const layer: any = Object.create(FlowCorridorLayer.prototype);
    layer.props = { data: 'hourly.stt' };
    layer.state = {};

    layer.noteAxis(matrixTile(JAN_1, 4 * HOUR));
    expect(axisOf(layer).bucketWidth).toBe(HOUR);

    // Same layer INSTANCE, new archive (`_transferState` keeps `state`).
    layer.props = { data: 'minutely.stt' };
    layer.noteAxis(matrixTile(JAN_1, 4 * MINUTE));
    expect(axisOf(layer).bucketWidth).toBe(MINUTE);
    expect(axisOf(layer).archiveKey).toBe('minutely.stt');
  });

  it('stays latched (idempotent) while the archive is unchanged', () => {
    const layer: any = Object.create(FlowCorridorLayer.prototype);
    layer.props = { data: 'hourly.stt' };
    layer.state = {};

    layer.noteAxis(matrixTile(JAN_1, 4 * HOUR));
    // A later tile of the SAME archive must not move the anchor.
    layer.noteAxis(matrixTile(JAN_1 + 99 * DAY, 4 * HOUR));
    expect(axisOf(layer).bucket0Abs).toBe(JAN_1);
    expect(axisOf(layer).bucketWidth).toBe(HOUR);
  });

  it('resets the sub-step gate too, so the new cadence fires immediately', () => {
    const layer = anchoredLayer(JAN_1, 'hourly.stt');
    layer._handleTimeUpdate(JAN_1 + 10 * DAY);
    expect(layer.setStateCalls.length).toBe(1);

    // Data swap: the stale axis (and its `lastStep`) must not survive it.
    layer.props = { timeWindow: DAY, data: 'minutely.stt' };
    layer._handleTimeUpdate(JAN_1 + 10 * DAY);
    expect(axisOf(layer).numBuckets).toBe(0); // cleared — nothing to animate yet
    expect(axisOf(layer).lastStep).toBe(-1);
  });
});
