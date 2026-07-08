/**
 * Shared `@deck.gl/core` mock for the layer unit tests.
 *
 * The @stt layers now build sublayer props through the real
 * `CompositeLayer.getSubLayerProps()` / `getSubLayerClass()` contract, so
 * the test mock must reproduce that contract faithfully — the same inherited
 * prop list and the same merge order as the installed 9.3.2 source
 * (`composite-layer.ts`): inherited composite props < the sublayerProps the
 * layer passes < the user's `_subLayerProps[id]` overrides; id composed as
 * `${parent.id}-${sublayerId}`; updateTriggers merged from `all` +
 * sublayerProps.updateTriggers + overriding triggers.
 *
 * Deliberately omitted vs upstream: the PROP_TYPES_SYMBOL accessor-wrapping
 * pass (needs deck's parsed prop types, absent under the Object.create test
 * harness) and the extension `getSubLayerProps` pass-through (the composite
 * itself carries no extensions in these tests).
 *
 * Usage (vi.mock factories cannot close over imports):
 *   vi.mock('@deck.gl/core', async () =>
 *     (await import('./fake-deck-core')).createDeckCoreMock());
 */

export function createDeckCoreMock() {
  class FakeCompositeLayer<P = any> {
    declare props: any;
    declare state: any;
    declare context: any;

    setState(_: any) {}
    setNeedsRedraw() {}
    getCurrentTime() {
      return 0;
    }

    getSubLayerClass(subLayerId: string, DefaultLayerClass: any) {
      const overridingProps = this.props._subLayerProps;
      return (
        (overridingProps &&
          overridingProps[subLayerId] &&
          overridingProps[subLayerId].type) ||
        DefaultLayerClass
      );
    }

    getSubLayerProps(sublayerProps: any = {}) {
      const {
        opacity,
        pickable,
        visible,
        parameters,
        getPolygonOffset,
        highlightedObjectIndex,
        autoHighlight,
        highlightColor,
        coordinateSystem,
        coordinateOrigin,
        wrapLongitude,
        positionFormat,
        modelMatrix,
        extensions,
        fetch,
        operation,
        _subLayerProps: overridingProps,
      } = this.props;
      const newProps: any = {
        id: '',
        updateTriggers: {},
        opacity,
        pickable,
        visible,
        parameters,
        getPolygonOffset,
        highlightedObjectIndex,
        autoHighlight,
        highlightColor,
        coordinateSystem,
        coordinateOrigin,
        wrapLongitude,
        positionFormat,
        modelMatrix,
        extensions,
        fetch,
        operation,
      };
      const overridingSublayerProps =
        overridingProps &&
        sublayerProps.id &&
        overridingProps[sublayerProps.id];
      const overridingSublayerTriggers =
        overridingSublayerProps && overridingSublayerProps.updateTriggers;
      const sublayerId = sublayerProps.id || 'sublayer';
      Object.assign(newProps, sublayerProps, overridingSublayerProps);
      newProps.id = `${this.props.id}-${sublayerId}`;
      newProps.updateTriggers = {
        all: this.props.updateTriggers?.all,
        ...sublayerProps.updateTriggers,
        ...overridingSublayerTriggers,
      };
      return newProps;
    }
  }

  class FakeLayerExtension {}

  return {
    CompositeLayer: FakeCompositeLayer,
    LayerExtension: FakeLayerExtension,
    COORDINATE_SYSTEM: { LNGLAT: 1 },
  };
}
