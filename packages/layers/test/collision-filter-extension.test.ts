/**
 * CollisionFilterExtension adapter (`collisionFilterProps`) + passthrough onto
 * an STT layer.
 *
 * Two things under test:
 *   1. the pure helper — extension composition, constant-prop wiring, priority
 *      clamp, and the honest fallback when the (deferred) data-driven
 *      `collisionPriorityProperty` is requested; and
 *   2. that the helper's output composes onto a real STT layer via the
 *      top-level `extensions` prop and the constant collision props reach the
 *      sublayer (CollisionFilterExtension has no getSubLayerProps override, so
 *      it forwards via deck's default `defaultProps`-driven pass — the same
 *      mechanism the passthrough suite pins).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CollisionFilterExtension as DeckCollisionFilterExtension } from '@deck.gl/extensions';
import {
  collisionFilterProps,
  COLLISION_PRIORITY_MIN,
  COLLISION_PRIORITY_MAX,
} from '../src/extensions/collision-filter-extension';
import { makePointTile } from './fake-tile';
import { _resetWarnOnce } from '../src/lib/log';

// ---------------------------------------------------------------------------
// 1. The pure helper (no deck mock needed — plain prop assembly)
// ---------------------------------------------------------------------------

describe('collisionFilterProps helper', () => {
  it('constant case: adds a CollisionFilterExtension and wires the constant props', () => {
    const props = collisionFilterProps({
      collisionEnabled: true,
      collisionGroup: 'labels',
      collisionTestProps: { radiusScale: 2 },
      collisionPriority: 50,
    });
    expect(props.extensions.some((e) => e instanceof DeckCollisionFilterExtension)).toBe(true);
    expect(props.collisionEnabled).toBe(true);
    expect(props.collisionGroup).toBe('labels');
    expect(props.collisionTestProps).toEqual({ radiusScale: 2 });
    // Always a constant number — binary tiles run no per-feature accessor.
    expect(props.getCollisionPriority).toBe(50);
  });

  it('defaults: collisionEnabled true, priority 0, no group/testProps keys', () => {
    const props = collisionFilterProps();
    expect(props.collisionEnabled).toBe(true);
    expect(props.getCollisionPriority).toBe(0);
    expect('collisionGroup' in props).toBe(false);
    expect('collisionTestProps' in props).toBe(false);
  });

  it('composes with existing extensions without dropping them or double-adding collision', () => {
    const other = { name: 'other-ext' } as any;
    const props = collisionFilterProps({ extensions: [other] });
    expect(props.extensions).toContain(other);
    expect(
      props.extensions.filter((e) => e instanceof DeckCollisionFilterExtension).length,
    ).toBe(1);
  });

  it('reuses a CollisionFilterExtension the caller already passed (no duplicate)', () => {
    const existing = new DeckCollisionFilterExtension();
    const props = collisionFilterProps({ extensions: [existing] });
    expect(props.extensions).toEqual([existing]);
    expect(
      props.extensions.filter((e) => e instanceof DeckCollisionFilterExtension).length,
    ).toBe(1);
  });

  it('clamps an out-of-range priority and warns once', () => {
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(collisionFilterProps({ collisionPriority: 5000 }).getCollisionPriority).toBe(
        COLLISION_PRIORITY_MAX,
      );
      expect(collisionFilterProps({ collisionPriority: -5000 }).getCollisionPriority).toBe(
        COLLISION_PRIORITY_MIN,
      );
      const rangeWarnings = warnSpy.mock.calls.filter(([m]) =>
        String(m).includes('outside'),
      );
      expect(rangeWarnings.length).toBe(1); // warnOnce
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('deferred: collisionPriorityProperty warns once and falls back to the constant priority', () => {
    _resetWarnOnce();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const props = collisionFilterProps({
        collisionPriorityProperty: 'importance',
        collisionPriority: 12,
      });
      // Fall back to the constant — never a column name, never a crash.
      expect(props.getCollisionPriority).toBe(12);
      // The barrel doc must NOT claim this is wired: no accessor-alias, no
      // baked `collisionPriorities` attribute — getCollisionPriority is a plain
      // constant number, not the requested column name or a function accessor.
      expect(typeof props.getCollisionPriority).toBe('number');
      expect(props.getCollisionPriority).not.toBe('importance');
      expect(props).not.toHaveProperty('getCollisionPriorities');
      expect(props).not.toHaveProperty('collisionPriorities');
      const propWarnings = warnSpy.mock.calls.filter(([m]) =>
        String(m).includes('collisionPriorityProperty'),
      );
      expect(propWarnings.length).toBe(1);
      // A second call with the same key stays quiet (warnOnce).
      collisionFilterProps({ collisionPriorityProperty: 'importance' });
      expect(
        warnSpy.mock.calls.filter(([m]) => String(m).includes('collisionPriorityProperty'))
          .length,
      ).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Passthrough onto a real STT layer (faithful core mock)
// ---------------------------------------------------------------------------

vi.mock('@deck.gl/layers', () => {
  class FakeScatterplotLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { ScatterplotLayer: FakeScatterplotLayer };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./faithful-deck-core')).createFaithfulDeckCoreMock();
  class FakeLayer {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return { ...core, Layer: FakeLayer, project32: { name: 'project32' } };
});

async function makePointLayer(props: Record<string, any> = {}) {
  const { AnimatedPointLayer } = await import('../src/layers/core/animated-point-layer');
  const layer: any = Object.create((AnimatedPointLayer as any).prototype);
  layer.props = {
    id: 'icons',
    fillColor: [255, 128, 0, 255],
    radius: 5,
    radiusUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    updateTriggers: {},
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  return layer;
}

describe('CollisionFilterExtension composes onto an STT layer via the extensions prop', () => {
  beforeEach(() => vi.resetModules());

  it('the extension instance and the constant collision props reach the sublayer', async () => {
    const layer = await makePointLayer(
      collisionFilterProps({
        collisionEnabled: true,
        collisionGroup: 'labels',
        collisionPriority: 25,
      }),
    );
    layer.state = {
      tiles: [
        makePointTile({
          positions: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          startTimes: [0, 1, 2],
          endTimes: [1, 2, 3],
          timeOffset: 0,
        }),
      ],
    };
    const [sub] = layer.renderLayers();
    expect(
      sub.props.extensions.some((e: any) => e instanceof DeckCollisionFilterExtension),
    ).toBe(true);
    expect(sub.props.collisionEnabled).toBe(true);
    expect(sub.props.collisionGroup).toBe('labels');
    expect(sub.props.getCollisionPriority).toBe(25);
  });
});
