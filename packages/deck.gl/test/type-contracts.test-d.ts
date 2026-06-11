// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * Compile-only contracts for the upstream generics pattern (audit B3).
 *
 * NOT executed by vitest (the `.test-d.ts` suffix is outside the runner's
 * `test/**​/*.test.ts` glob) — it is type-checked by `pnpm typecheck` via
 * `tsconfig.typetest.json`. Each block pins one piece of the public typing
 * surface:
 *
 * 1. Third-party subclassing via `ExtraPropsT` (the upstream
 *    `PathLayer<DataT, ExtraPropsT>` extension pattern, minus `DataT` —
 *    tiles are binary, there is no per-row datum type): `this.props` carries
 *    the subclass's own props AND the `Required<>`-typed base props.
 * 2. The exported `XxxLayerProps` types compose own props + base props +
 *    `CompositeLayerProps`, and `value: null`-default props stay nullable.
 * 3. The deprecated `HeatmapLayer`/`HeatmapLayerProps` rename aliases remain
 *    assignable to the new names.
 */

import {
  SpatioTemporalLayer,
  AnimatedPathLayer,
  AnimatedPointLayer,
  AnimatedTripsLayer,
  AnimatedPolygonLayer,
  AnimatedTripHeadsLayer,
  AnimatedHeatmapLayer,
  HeatmapLayer,
  H3SummaryLayer,
} from '../src';
import type {
  SpatioTemporalLayerProps,
  AnimatedPathLayerProps,
  AnimatedPointLayerProps,
  AnimatedTripsLayerProps,
  AnimatedPolygonLayerProps,
  AnimatedTripHeadsLayerProps,
  AnimatedHeatmapLayerProps,
  HeatmapLayerProps,
  H3SummaryLayerProps,
} from '../src';

declare function expectType<T>(value: T): void;

// ---------------------------------------------------------------------------
// 1. Third-party subclassing with ExtraPropsT
// ---------------------------------------------------------------------------

interface MyExtraProps {
  myProp: number;
  myCallback?: ((value: string) => void) | null;
}

class MyPathLayer extends AnimatedPathLayer<MyExtraProps> {
  static layerName = 'MyPathLayer';

  typeContract(): void {
    // The subclass's own props are typed on this.props…
    expectType<number>(this.props.myProp);
    // …alongside the Required<>-typed inherited props: defaults guarantee
    // values, so no `| undefined` and no `?? fallback` refetches needed.
    expectType<number>(this.props.timeWindow);
    expectType<number>(this.props.widthScale);
    expectType<'pixels' | 'meters'>(this.props.widthUnits);
    expectType<string>(this.props.data);
    // `value: null`-default props stay nullable.
    expectType<{ start: number; end: number } | null>(this.props.timeRange);

    // @ts-expect-error myProp is a number, not a string.
    expectType<string>(this.props.myProp);
  }
}

class MySummaryLayer extends H3SummaryLayer<{ legendTitle: string }> {
  static layerName = 'MySummaryLayer';

  typeContract(): void {
    expectType<string>(this.props.legendTitle);
    // Own H3 props are Required<>-typed too…
    expectType<string>(this.props.weightProperty);
    expectType<number>(this.props.coverage);
    // …and the base composite props came along with the extend.
    expectType<number>(this.props.maxCacheByteSize);
    expectType<[number, number] | null>(this.props.colorDomain);
  }
}

// Subclasses of every family member accept ExtraPropsT the same way.
class MyPointLayer extends AnimatedPointLayer<{ a: 1 }> {}
class MyTripsLayer extends AnimatedTripsLayer<{ a: 1 }> {}
class MyPolygonLayer extends AnimatedPolygonLayer<{ a: 1 }> {}
class MyHeadsLayer extends AnimatedTripHeadsLayer<{ a: 1 }> {}
class MyHeatmapLayer extends AnimatedHeatmapLayer<{ a: 1 }> {}
class MyBaseLayer extends SpatioTemporalLayer<{ a: 1 }> {}

// ---------------------------------------------------------------------------
// 2. Exported props types compose (own + base + CompositeLayerProps)
// ---------------------------------------------------------------------------

const pathProps: AnimatedPathLayerProps = {
  id: 'paths',
  data: 'https://tiles.example/dataset/manifest.json',
  currentTime: 0,
  // Base (_SpatioTemporalLayerProps) members:
  timeWindow: 60_000,
  onTileError: (error, tileId) => {
    expectType<Error>(error);
    void tileId;
  },
  // Own (_AnimatedPathLayerProps) members:
  widthScale: 2,
  pathColor: 'vehicle_type',
  getColor: [255, 0, 0, 255],
  // CompositeLayerProps members:
  opacity: 0.8,
  pickable: true,
  visible: true,
};

const baseProps: SpatioTemporalLayerProps = pathProps;
void baseProps;

const pointProps: AnimatedPointLayerProps = {
  id: 'points',
  data: '',
  currentTime: 0,
  radius: 'magnitude',
  colorMapping: { a: [1, 2, 3, 255] },
};
const tripsProps: AnimatedTripsLayerProps = {
  id: 'trips',
  data: '',
  currentTime: 0,
  trailLength: 10_000,
  gradientProperty: 'vertexValues',
};
const polygonProps: AnimatedPolygonLayerProps = {
  id: 'polygons',
  data: '',
  currentTime: 0,
  extruded: true,
  elevation: 'height',
};
const headsProps: AnimatedTripHeadsLayerProps = {
  id: 'heads',
  data: '',
  currentTime: 0,
  headRadius: 20,
  sizeUnits: 'meters',
};
const h3Props: H3SummaryLayerProps = {
  id: 'h3',
  data: '',
  currentTime: 0,
  weightProperty: 'count',
  colorDomain: [0, 100],
  onMetadataLoad: (meta) => void meta.minZoom,
};

// Constructors accept the composed props — including extra props on a
// third-party subclass.
new AnimatedPathLayer(pathProps);
new MyPathLayer({ ...pathProps, myProp: 42 });
new MyPointLayer({ ...pointProps, a: 1 });
new MyTripsLayer({ ...tripsProps, a: 1 });
new MyPolygonLayer({ ...polygonProps, a: 1 });
new MyHeadsLayer({ ...headsProps, a: 1 });
new MyBaseLayer({ id: 'base', data: '', currentTime: 0, a: 1 });
new MySummaryLayer({ ...h3Props, legendTitle: 'Cells' });

// ---------------------------------------------------------------------------
// 3. Deprecated rename aliases stay importable and identical
// ---------------------------------------------------------------------------

const heatmapProps: AnimatedHeatmapLayerProps = {
  id: 'heatmap',
  data: '',
  currentTime: 0,
  radiusPixels: 24,
  channels: [{ id: 'a' }],
};
// The deprecated props alias IS the new type.
const legacyHeatmapProps: HeatmapLayerProps = heatmapProps;
void legacyHeatmapProps;

// The deprecated class alias IS the new class (same constructor, same type).
expectType<typeof AnimatedHeatmapLayer>(HeatmapLayer);
new HeatmapLayer(heatmapProps);
new MyHeatmapLayer({ ...heatmapProps, a: 1 });
