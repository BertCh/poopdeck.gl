/**
 * `@deck.gl/core` mock that additionally reproduces deck's **extension
 * pass-through**.
 *
 * `fake-deck-core.ts` deliberately omits the extension `getSubLayerProps`
 * pass ("the composite itself carries no extensions in these tests"). The
 * extensions-passthrough / collision suites need exactly that pass: they put a
 * REAL deck extension on the composite's top-level `extensions` prop and then
 * assert that both the extension instance AND its scalar props reach the
 * built sublayer — which is only true because deck's
 * `CompositeLayer.getSubLayerProps()` walks `this.props.extensions` and merges
 * each `extension.getSubLayerProps.call(this, extension)` into the sublayer
 * props (see the installed 9.3.2 `lib/composite-layer.js:153-162`).
 *
 * The `LayerExtension` base here carries the real default `getSubLayerProps`
 * (installed `lib/layer-extension.js:27`) so unmodified extensions
 * (Mask/Clip/PathStyle/Collision) forward the keys named in their static
 * `defaultProps`, and BrushingExtension's own override runs on top.
 *
 * vi.mock factories cannot close over imports, so consume it as:
 *   vi.mock('@deck.gl/core', async () =>
 *     (await import('./faithful-deck-core')).createFaithfulDeckCoreMock());
 */

function shallowEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export function createFaithfulDeckCoreMock() {
  /** Faithful base: the real default `getSubLayerProps` + `equals`. */
  class FakeLayerExtension {
    opts: any;
    constructor(opts?: any) {
      if (opts) this.opts = opts;
    }
    equals(extension: any): boolean {
      if (this === extension) return true;
      return (
        this.constructor === extension.constructor &&
        shallowEqual(this.opts, extension.opts)
      );
    }
    getShaders(): any {
      return null;
    }
    // `this` is the composite layer (deck calls `.call(this, extension)`).
    getSubLayerProps(this: any, extension: any): any {
      const defaultProps = extension?.constructor?.defaultProps;
      const newProps: any = { updateTriggers: {} };
      for (const key in defaultProps) {
        if (key in this.props) {
          const propDef = defaultProps[key];
          const propValue = this.props[key];
          newProps[key] = propValue;
          if (propDef && propDef.type === 'accessor') {
            newProps.updateTriggers[key] = this.props.updateTriggers?.[key];
          }
        }
      }
      return newProps;
    }
    initializeState(): void {}
    updateState(): void {}
    draw(): void {}
    finalizeState(): void {}
    getNeedsPickingBuffer(): boolean {
      return false;
    }
  }

  class FakeCompositeLayer {
    declare props: any;
    declare state: any;
    declare context: any;

    setState(_state: any) {}
    setNeedsRedraw() {}
    getCurrentTime() {
      return 0;
    }

    // deck's real LayerExtension.getSubLayerProps calls this on `this` (the
    // composite) to wrap a function accessor before forwarding it. The real
    // wrapper adapts the accessor to the sublayer's data; for these binary
    // tests returning it verbatim is enough to prove the passthrough.
    getSubLayerAccessor(accessor: any) {
      return accessor;
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
      // Extension pass-through — the reason this mock exists. Iterate the
      // COMPOSITE's own extensions (not the composed sublayer list) exactly
      // like deck, so each extension forwards its scalar props from the
      // composite onto the sublayer.
      for (const extension of extensions ?? []) {
        const passThroughProps = extension.getSubLayerProps.call(
          this,
          extension,
        );
        if (passThroughProps) {
          Object.assign(newProps, passThroughProps, {
            updateTriggers: Object.assign(
              newProps.updateTriggers,
              passThroughProps.updateTriggers,
            ),
          });
        }
      }
      return newProps;
    }
  }

  return {
    CompositeLayer: FakeCompositeLayer,
    LayerExtension: FakeLayerExtension,
    COORDINATE_SYSTEM: { LNGLAT: 1 },
  };
}
