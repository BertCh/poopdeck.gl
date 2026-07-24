/**
 * Which dataset types a renderer backend can draw — READ from the backend's
 * published `BackendDescriptor`, never hand-listed.
 *
 * Each of `@poopdeck.gl/{layers,maplibre,three,cesium}` ships a descriptor whose
 * `layerKinds` record is exhaustive over the frozen `LAYER_KINDS` vocabulary and
 * is proven against the package's REAL exports by that package's conformance
 * gate (`assertDescriptorConsistent`). The showcase used to keep three parallel
 * copies of that information — `CESIUM_SUPPORTED_TYPES`,
 * `MAPLIBRE_RENDERABLE_TYPES`, `THREE_GEO_TYPES` — which could only ever drift
 * one way: a backend loses (or gains) a kind and the showcase keeps offering
 * (or hiding) the toggle, so the demo renders an empty canvas instead of not
 * offering the backend at all.
 *
 * Support is STRICT: every kind a type needs must be `supported: true`. A
 * declared `fallbackKind` is deliberately NOT followed here — three degrades
 * `heatmap → point` and `pointCloud → point`, and following those would say
 * "three renders the heatmap demo" when the three viewer has no heatmap branch
 * at all. Degradation is a decision for a caller that asked to render one
 * layer, not for a gate that decides whether to offer a whole backend.
 */

import type {
  BackendDescriptor,
  LayerKind,
} from '@poopdeck.gl/core/capabilities';
import { LAYER_KINDS } from '@poopdeck.gl/core/capabilities';
import {
  datasetTypeKinds,
  type DatasetType,
  type ShowcaseLocalType,
} from '../types';

/** Does `backend` declare support for every core kind `type` mounts? */
export function backendRendersType(
  backend: BackendDescriptor,
  type: DatasetType,
): boolean {
  const kinds = datasetTypeKinds(type);
  return (
    kinds.length > 0 &&
    kinds.every((kind: LayerKind) => backend.layerKinds[kind]?.supported)
  );
}

/**
 * The dataset types `backend` can render: every core {@link LayerKind} it
 * declares, plus the showcase-local composites in `locals` whose whole stack it
 * declares.
 *
 * `locals` is the one thing a descriptor cannot tell us — a composite is an
 * editorial stack of archives that the showcase's own dispatch has to build,
 * so each adapter passes the compositions IT wires. It can only ever NARROW the
 * result: a composite whose kinds the backend lacks is dropped here regardless
 * of what the adapter claims, so the list cannot over-claim capability.
 */
export function renderableDatasetTypes(
  backend: BackendDescriptor,
  locals: readonly ShowcaseLocalType[] = [],
): ReadonlySet<DatasetType> {
  const out = new Set<DatasetType>();
  for (const kind of LAYER_KINDS) {
    if (backendRendersType(backend, kind)) out.add(kind);
  }
  for (const local of locals) {
    if (backendRendersType(backend, local)) out.add(local);
  }
  return out;
}
