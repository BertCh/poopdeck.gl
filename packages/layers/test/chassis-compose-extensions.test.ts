/**
 * `SpatioTemporalLayer.composeExtensions` — merge the layer's INTERNAL
 * extensions with the user's top-level `extensions` prop, deduped by
 * constructor.
 *
 * All four STT extensions are publicly exported and the chassis docs tell
 * callers to add extensions through the top-level `extensions` prop, so a
 * caller re-adding one the layer already applies internally is expected. A
 * plain `[...internal, ...user]` broke that two ways, both asserted here:
 *
 *  1. deck's `mergeShaders` CONCATENATES each extension's `inject` strings, so
 *     a duplicated extension emits its `in float instanceStartTime;` style
 *     declarations twice → GLSL redeclaration → the program never links and
 *     the layer renders nothing;
 *  2. `LayerExtension.getSubLayerProps` copies the extension's `defaultProps`
 *     keys off the COMPOSITE's props, so a second instance re-runs that copy
 *     and clobbers the per-tile `timeOffset` / `getTime` / `filterEnabled` /
 *     `categoryPalette` the chassis just wired.
 *
 * The INTERNAL instance is the keeper — it is the one carrying the per-tile
 * wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpatioTemporalLayer } from '../src/layers/spatiotemporal-layer';
import { _resetWarnOnce } from '../src/lib/log';

/** Minimal stand-in for a deck `LayerExtension` subclass. */
class FakeExtension {
  static defaultProps = { timeOffset: 0, getTime: null };
  constructor(public opts: Record<string, unknown> = {}) {}
  getShaders() {
    return { inject: { 'vs:#decl': 'in float instanceStartTime;\n' } };
  }
}
class OtherExtension {
  static defaultProps = { brushingRadius: 1 };
}

function makeLayer(userExtensions?: unknown[]) {
  const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
  layer.props = { id: 'stl', extensions: userExtensions };
  return layer;
}

beforeEach(() => {
  _resetWarnOnce();
});

describe('composeExtensions', () => {
  it('returns the internal list untouched when the user passed none', () => {
    const internal = [new FakeExtension()];
    const layer = makeLayer(undefined);
    expect(layer.composeExtensions(internal)).toBe(internal);

    const layerEmpty = makeLayer([]);
    expect(layerEmpty.composeExtensions(internal)).toBe(internal);
  });

  it('appends a user extension the layer does not already apply', () => {
    const internal = [new FakeExtension()];
    const user = new OtherExtension();
    const merged = makeLayer([user]).composeExtensions(internal);
    expect(merged).toEqual([internal[0], user]);
  });

  it('drops a user duplicate and keeps the INTERNAL instance (per-tile wiring)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const internal = [new FakeExtension({ tag: 'internal' })];
    const userDuplicate = new FakeExtension({ tag: 'user' });

    const merged = makeLayer([userDuplicate]).composeExtensions(internal);

    // Failure mode 1: exactly one instance of the class, so `mergeShaders`
    // cannot concatenate the same `inject` twice.
    expect(
      merged.filter((e: unknown) => e instanceof FakeExtension),
    ).toHaveLength(1);
    // Failure mode 2: the survivor is the internal instance, so
    // `getSubLayerProps` runs the defaultProps copy once, from the wiring the
    // chassis intended.
    expect(merged[0]).toBe(internal[0]);
    expect(merged[0].opts).toEqual({ tag: 'internal' });

    warn.mockRestore();
  });

  it('warns once, naming the extension and both failure modes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const internal = [new FakeExtension()];

    makeLayer([new FakeExtension()]).composeExtensions(internal);
    makeLayer([new FakeExtension()]).composeExtensions(internal);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('FakeExtension');
    expect(message).toContain('shader injections twice');
    expect(message).toContain('defaultProps');

    warn.mockRestore();
  });

  it('dedupes only by constructor — a mixed list keeps every distinct class', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const internal = [new FakeExtension()];
    const other = new OtherExtension();

    const merged = makeLayer([
      new FakeExtension(),
      other,
      new FakeExtension(),
    ]).composeExtensions(internal);

    expect(merged).toEqual([internal[0], other]);
    warn.mockRestore();
  });
});
