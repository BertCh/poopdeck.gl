// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * `STTPathLayer` — the `path` kind.
 *
 * This class is deliberately a THIN subclass of `STTLineLayer` (an OD line is a
 * 2-vertex LineString; a path is the same primitive with more vertices), so the
 * cases here are pointed at exactly the two things that are its own and NOT
 * inherited:
 *
 *   1. the deck-parity width default, including the explicit-`undefined`
 *      semantics a React prop-forwarder produces;
 *   2. `timeModeLoadKnobs` — the one REAL gap the kind closed. The reveal
 *      shader lights `revealDuration` ms of history behind the play head while
 *      tile SELECTION was sized on `timeWindow` alone, so the tiles holding
 *      that history were evicted while the shader still wanted them and the
 *      "drawn" ink vanished mid-playback.
 *
 * Everything else (the four time modes, DataFilter, metric width, globe
 * subdivision, the reveal math itself, id-picking) is the line renderer's and
 * is covered by `line-layer.test.ts`. Re-asserting it here would test the
 * `extends`, not the subclass.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import { STTPathLayer } from '../src/layers/path-layer';
import {
  REVEAL_PERSIST_TRAIL_MS,
  resolveRevealTrailLength,
} from '../src/layers/line-layer';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5_000,
};

function makeLayer(extra: Record<string, unknown> = {}): any {
  return new STTPathLayer({ ...baseOpts, id: 'p', ...extra } as any) as any;
}

/** The protected hook, read the way the base reads it. */
const knobs = (layer: any): any => layer.timeModeLoadKnobs();
/** The number tile selection is actually sized against. */
const effective = (layer: any): number => layer.getEffectiveTimeWindow();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deck-parity width default', () => {
  it('defaults width to 3 — deck DEFAULT_PATH_WIDTH, not the OD-line default', () => {
    expect(makeLayer().lineOpts.width).toBe(3);
  });

  it('an explicit width still wins', () => {
    expect(makeLayer({ width: 12 }).lineOpts.width).toBe(12);
  });

  it('an explicit `width: undefined` reaches the default (the React-forwarding shape)', () => {
    // `{...opts, width: opts.width ?? D}` is required here: a `{width: D, ...opts}`
    // spread would let the own key `width: undefined` shadow the default and
    // render a zero-width path.
    expect(makeLayer({ width: undefined }).lineOpts.width).toBe(3);
  });

  it('does not invent any OTHER divergence from the line kind', () => {
    // deck spells everything except width the same on both layers; re-defaulting
    // more here would fabricate a divergence deck does not have.
    const o = makeLayer().lineOpts;
    expect(o.revealTrail ?? false).toBe(false);
    expect(o.revealDuration ?? 0).toBe(0);
    expect(o.widthUnits ?? 'pixels').toBe('pixels');
  });
});

describe('timeModeLoadKnobs — the reveal tile-load gap this kind closed', () => {
  it('reports the RESOLVED mode and lengths for a non-reveal mode, not the raw option bag', () => {
    const layer = makeLayer({ timeFilterMode: 'trail', trailLength: 9_000 });
    expect(knobs(layer)).toMatchObject({ mode: 'trail', trailLength: 9_000 });
  });

  it('maps a FINITE revealDuration onto a trail of that length', () => {
    const layer = makeLayer({ revealTrail: true, revealDuration: 60_000 });
    expect(knobs(layer)).toMatchObject({ mode: 'trail', trailLength: 60_000 });
  });

  it('widens the load window to 2 x revealDuration — the tail stays resident', () => {
    const layer = makeLayer({ revealTrail: true, revealDuration: 60_000 });
    // Without the override this was 5_000 (timeWindow alone) and the tiles
    // holding the revealed history were evicted out from under the shader.
    expect(effective(layer)).toBe(120_000);
    expect(effective(layer)).toBeGreaterThan(baseOpts.timeWindow);
  });

  it('treats revealDuration:0 (persist) as cumulative WHEN a timeRange bounds it', () => {
    const timeRange = { start: 1_700_000_000_000, end: 1_700_000_100_000 };
    const layer = makeLayer({
      revealTrail: true,
      revealDuration: 0,
      timeRange,
    });
    expect(knobs(layer)).toMatchObject({ mode: 'cumulative' });
    // 2 x span, so from ANY head position the symmetric window reaches the start.
    expect(effective(layer)).toBe(200_000);
  });

  it('falls back to window and warns ONCE when persist has nothing to bound it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer({ revealTrail: true, revealDuration: 0 });
    expect(knobs(layer)).toMatchObject({ mode: 'window' });
    knobs(layer);
    knobs(layer);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /timeRange|tileLoadTimeWindow/,
    );
  });

  it('does NOT warn when the caller bounded it with an explicit tileLoadTimeWindow', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer({
      revealTrail: true,
      revealDuration: 0,
      tileLoadTimeWindow: 90_000,
    });
    knobs(layer);
    expect(warn).not.toHaveBeenCalled();
    expect(effective(layer)).toBe(90_000);
  });

  it('every widening is a FLOOR — an explicit tileLoadTimeWindow can only raise it', () => {
    const bigger = makeLayer({
      revealTrail: true,
      revealDuration: 60_000,
      tileLoadTimeWindow: 500_000,
    });
    expect(effective(bigger)).toBe(500_000);
    const smaller = makeLayer({
      revealTrail: true,
      revealDuration: 60_000,
      tileLoadTimeWindow: 1_000,
    });
    // The reveal floor still wins; the smaller explicit value cannot undercut it.
    expect(effective(smaller)).toBe(120_000);
  });

  it('agrees with the shader on what "persist" is', () => {
    // The override branches on `resolveRevealTrailLength` — the shader's own
    // answer — so a change to the sentinel cannot silently desync the two.
    expect(resolveRevealTrailLength(0)).toBe(REVEAL_PERSIST_TRAIL_MS);
    expect(resolveRevealTrailLength(60_000)).toBe(60_000);
  });
});

describe('it is the line renderer, not a fork', () => {
  it('inherits STTLineLayer rather than reimplementing it', () => {
    const layer = makeLayer();
    expect(typeof layer.drawTile).toBe('function');
    expect(typeof layer.drawPickTile).toBe('function');
    // A path is a LineString: the accepted geometry must be identical to the
    // line kind's, or the kind would silently render nothing.
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(false);
  });
});
