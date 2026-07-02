/**
 * P1 — a SpatioTemporalLayer resolves its TimeController from the explicit
 * `timeController` prop OR, when absent, from the app-global controller mirrored
 * onto deck's shared `context.userData.stt.timeController`. This is the
 * deck-idiomatic "push one value to every layer with no per-layer wiring"
 * channel (the same `context` mechanism `viewport`/`timeline` ride), so new
 * layers see time for free once the host sets `userData` (see `useDeckClock`).
 *
 * Driven against an Object.create'd layer (the project's lightweight harness for
 * exercising lifecycle methods without the full deck.gl Layer machinery), with
 * `_initArchiveAndTileset` stubbed so the test isolates the subscription path.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatioTemporalLayer } from '../src/layers/spatiotemporal-layer';

function makeController() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    isPlaying: vi.fn(() => false),
    getSpeed: vi.fn(() => 1),
    getTime: vi.fn(() => 0),
  };
}

/** A bare layer instance with just enough wiring to run the lifecycle method. */
function makeLayer(props: Record<string, unknown>) {
  const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
  layer.props = { currentTime: 0, timeWindow: 1000, ...props };
  layer.state = {};
  layer.setState = (patch: Record<string, unknown>) => Object.assign(layer.state, patch);
  layer._initArchiveAndTileset = vi.fn(); // skip async archive setup
  return layer;
}

describe('SpatioTemporalLayer time-controller resolution', () => {
  it('_resolveTimeController: prop wins, else context.userData, else null', () => {
    const prop = makeController();
    const ud = makeController();

    const a = makeLayer({ timeController: prop });
    a.context = { userData: { stt: { timeController: ud } } };
    expect(a._resolveTimeController()).toBe(prop);

    const b = makeLayer({ timeController: null });
    b.context = { userData: { stt: { timeController: ud } } };
    expect(b._resolveTimeController()).toBe(ud);

    const c = makeLayer({ timeController: null });
    c.context = {};
    expect(c._resolveTimeController()).toBe(null);
  });

  it('subscribes to the controller found on context.userData when no prop is given', () => {
    const controller = makeController();
    const context = { userData: { stt: { timeController: controller } } };
    const layer = makeLayer({ timeController: null });

    layer.initializeState(context);

    expect(controller.on).toHaveBeenCalledWith('playState', expect.any(Function));
    expect(controller.on).toHaveBeenCalledWith('tick', expect.any(Function));
    expect(layer.state.resolvedTimeController).toBe(controller);
  });

  it('prefers the explicit prop over the userData controller', () => {
    const propController = makeController();
    const userDataController = makeController();
    const context = { userData: { stt: { timeController: userDataController } } };
    const layer = makeLayer({ timeController: propController });

    layer.initializeState(context);

    expect(propController.on).toHaveBeenCalledWith('tick', expect.any(Function));
    expect(userDataController.on).not.toHaveBeenCalled();
    expect(layer.state.resolvedTimeController).toBe(propController);
  });

  it('subscribes to nothing (and leaves resolved null) when neither is present', () => {
    const layer = makeLayer({ timeController: null });
    layer.initializeState({}); // empty context, no userData

    expect(layer.state.resolvedTimeController).toBe(null);
    expect(layer._initArchiveAndTileset).toHaveBeenCalled();
  });
});
