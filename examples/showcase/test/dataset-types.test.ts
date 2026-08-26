/**
 * Dataset-vocabulary drift gate.
 *
 * `src/types.ts` used to declare its own 19-member layer union, and it HAD
 * drifted from the frozen cross-backend vocabulary in
 * `@poopdeck.gl/core/capabilities`: `trip-heads` vs `tripHeads`, `point-cloud`
 * vs `pointCloud`, `summary` vs `h3Summary`, `quadbin-summary` vs
 * `quadbinSummary`. `DatasetType` is now `LayerKind | ShowcaseLocalType`, so a
 * respelling is a `tsc` break — but only for LITERAL types. This suite pins the
 * parts tsc cannot see: that the SHIPPED catalog stays inside the vocabulary,
 * that the local union never shadows a core kind, and that the backend gates
 * still read from the published descriptors rather than a hand list.
 */
import { describe, it, expect } from 'vitest';
import {
  LAYER_KINDS,
  type BackendDescriptor,
  type LayerKind,
} from '@poopdeck.gl/core/capabilities';
import { deckBackend } from '@poopdeck.gl/layers';
import { maplibreBackend } from '@poopdeck.gl/maplibre';
import { threeBackend } from '@poopdeck.gl/three';
import { cesiumBackend } from '@poopdeck.gl/cesium';
import {
  COMPOSITE_LAYER_KINDS,
  SHOWCASE_LOCAL_TYPES,
  datasetTypeKinds,
  type DatasetType,
} from '../src/types';
import { datasets } from '../src/datasets';
import { VIZ_REGISTRY } from '../src/components/VizBadge.tsx';
import {
  backendRendersType,
  renderableDatasetTypes,
} from '../src/lib/backendSupport';

const coreKinds = new Set<string>(LAYER_KINDS);
const localTypes = new Set<string>(SHOWCASE_LOCAL_TYPES);

describe('dataset type vocabulary', () => {
  it('every shipped dataset type is a core LayerKind or a declared local composite', () => {
    const strays = datasets
      .filter((d) => !coreKinds.has(d.type) && !localTypes.has(d.type))
      .map((d) => `${d.id}: ${d.type}`);
    expect(strays).toEqual([]);
  });

  it('no showcase-local type shadows a core LayerKind', () => {
    // A local name that core later adopts must be DELETED here, not kept as a
    // second spelling — that is exactly how the four drifted names survived.
    const shadowed = SHOWCASE_LOCAL_TYPES.filter((t) =>
      coreKinds.has(t as string),
    );
    expect(shadowed).toEqual([]);
  });

  it('every composite maps to real core LayerKinds', () => {
    for (const [type, kinds] of Object.entries(COMPOSITE_LAYER_KINDS)) {
      expect(kinds.length, `${type} maps to no kind`).toBeGreaterThan(0);
      for (const kind of kinds) {
        expect(coreKinds.has(kind), `${type} → unknown kind ${kind}`).toBe(
          true,
        );
      }
    }
  });

  it('datasetTypeKinds is identity on core kinds and the stack on composites', () => {
    for (const kind of LAYER_KINDS) {
      expect(datasetTypeKinds(kind)).toEqual([kind]);
    }
    expect(datasetTypeKinds('radar')).toEqual(['polygon', 'point', 'trips']);
  });

  it('every shipped dataset type has a viz badge', () => {
    // Replaces the exhaustiveness the old `Record<DatasetType, VizDef>` gave —
    // and is strictly stronger, because it checks the types actually in use.
    const missing = [
      ...new Set(datasets.map((d) => d.type as DatasetType)),
    ].filter((t) => !VIZ_REGISTRY[t]);
    expect(missing).toEqual([]);
  });
});

describe('backend gates read the published descriptors', () => {
  it('a backend is offered a type only when it declares every kind that type mounts', () => {
    // deck is the reference backend: it declares every kind except isoLines
    // (fallback → path) and ego, so it renders every shipped dataset type.
    for (const d of datasets) {
      expect(
        backendRendersType(deckBackend, d.type),
        `deck cannot render ${d.id} (${d.type})`,
      ).toBe(true);
    }
  });

  it('an unsupported kind is NOT rescued by a declared fallback', () => {
    // deck degrades isoLines → path. Following that would advertise an
    // iso-band demo on a viewer that would draw bare contour polylines, which
    // is the silent wrong-render failure this gate exists to prevent.
    // Degradation is a decision for a caller that asked to render ONE layer,
    // not for a gate deciding whether to offer a whole backend.
    //
    // This used to read `three` + `heatmap`; the non-deck parity campaign gave
    // three a real heatmap layer, so deck's isoLines is now the only
    // fallback-bearing unsupported kind left in any shipped descriptor. If that
    // one closes too, assert against a synthetic descriptor rather than
    // deleting the rule.
    expect(deckBackend.layerKinds.isoLines.supported).toBe(false);
    expect(deckBackend.layerKinds.isoLines.fallbackKind).toBe('path');
    expect(backendRendersType(deckBackend, 'isoLines')).toBe(false);
  });

  it('a composite is dropped when the backend lacks any kind in its stack', () => {
    // Written against a SYNTHETIC descriptor on purpose. This used to read
    // `cesium ships the movement family only`, and the non-deck parity campaign
    // took cesium to all 23 kinds — at which point a test phrased as "this
    // backend cannot" quietly stops exercising the narrowing at all instead of
    // failing. The rule under test belongs to `renderableDatasetTypes`, not to
    // whichever backend happens to be behind this month, so knock ONE kind out
    // of a real descriptor and check the composites that mount it fall out.
    const noTrips: BackendDescriptor = {
      ...cesiumBackend,
      layerKinds: {
        ...cesiumBackend.layerKinds,
        trips: { ...cesiumBackend.layerKinds.trips, supported: false },
      },
    };
    const offered = renderableDatasetTypes(noTrips, SHOWCASE_LOCAL_TYPES);
    // Every composite whose stack includes `trips`: radar, av, weather, …
    for (const local of SHOWCASE_LOCAL_TYPES) {
      const mountsTrips = COMPOSITE_LAYER_KINDS[local].includes('trips');
      expect(
        offered.has(local),
        `${local} (mounts trips: ${mountsTrips})`,
      ).toBe(!mountsTrips);
    }
    expect(offered.has('trips')).toBe(false);
    expect(offered.has('point')).toBe(true);

    // And the real cesium descriptor, for the record: it now carries every
    // composite the showcase declares.
    const real = renderableDatasetTypes(cesiumBackend, SHOWCASE_LOCAL_TYPES);
    for (const local of SHOWCASE_LOCAL_TYPES) {
      expect(real.has(local), `cesium should claim ${local}`).toBe(true);
    }
  });

  it('maplibre renders the summary + flow families it declares', () => {
    const ml = renderableDatasetTypes(maplibreBackend, [
      'lightning',
      'radar',
      'flowmap-bundled',
    ]);
    for (const kind of [
      'point',
      'polygon',
      'trips',
      'heatmap',
      'tripHeads',
      'arc',
      'column',
      'h3Summary',
      'quadbinSummary',
      'flowmap',
    ] satisfies LayerKind[]) {
      expect(ml.has(kind), `maplibre should render ${kind}`).toBe(true);
    }
    expect(ml.has('lightning')).toBe(true);
    expect(ml.has('radar')).toBe(true);
  });

  it('pins which SHIPPED dataset types each alternate backend offers', () => {
    // A pin, not a preference: these sets are now derived, so a descriptor edit
    // in @poopdeck.gl/{maplibre,three,cesium} silently adds or removes a
    // renderer toggle from live demo pages. Failing here is the intended way to
    // notice — and it is the way the non-deck parity campaign's six new Cesium
    // toggles and three's heatmap were noticed before a browser saw them.
    //
    // Every type listed here has a dispatch branch in the adapter that offers
    // it (`buildCesiumLayer`, `MaplibreRenderer`, `SttThreeGeoViewer`); adding
    // a line without adding that branch ships a toggle onto a blank canvas.
    // `test/cesium-dispatch.test.ts` proves it for the Cesium route, whose
    // eligibility set is derived and so widens on its own.
    const shipped = [...new Set(datasets.map((d) => d.type))].sort();
    // Same `locals` each adapter passes (MaplibreRenderer / SttThreeGeoViewer /
    // buildCesiumLayer), so this pins what a demo page actually offers.
    const offered = (
      ...args: Parameters<typeof renderableDatasetTypes>
    ): DatasetType[] => {
      const set = renderableDatasetTypes(...args);
      return shipped.filter((t) => set.has(t));
    };

    // `path` joined maplibre when the parity campaign fixed the capability-matrix
    // bug this pin used to record: `STTLineLayer` always rendered polylines and
    // `MaplibreRenderer`'s `case 'path'` always mounted it, while the descriptor
    // declared the kind unsupported.
    expect(
      offered(maplibreBackend, ['lightning', 'radar', 'flowmap-bundled']),
    ).toEqual([
      'arc',
      'column',
      'flowmap',
      'flowmap-bundled',
      'h3Summary',
      'heatmap',
      'lightning',
      'path',
      'point',
      'polygon',
      'quadbinSummary',
      'radar',
      'tripHeads',
      'trips',
    ]);
    // `heatmap` joined three with a real screen-space splat layer (it used to
    // declare the kind unsupported with a fallback → point).
    expect(offered(threeBackend, ['flowmap-bundled'])).toEqual([
      'arc',
      'column',
      'flowmap',
      'flowmap-bundled',
      'h3Summary',
      'heatmap',
      'path',
      'point',
      'polygon',
      'quadbinSummary',
      'tripHeads',
      'trips',
    ]);
    // Cesium went from the movement family (arc/path/point/tripHeads/trips) to
    // every kind in the vocabulary. No composite appears because the Cesium
    // route mounts exactly one archive and so passes no `locals`.
    expect(offered(cesiumBackend)).toEqual([
      'arc',
      'column',
      'flowmap',
      'h3Summary',
      'heatmap',
      'path',
      'point',
      'polygon',
      'quadbinSummary',
      'tripHeads',
      'trips',
    ]);
  });
});
