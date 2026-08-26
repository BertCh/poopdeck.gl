// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cesiumBackend } from '../src/backend-descriptor';
import {
  LAYER_KINDS,
  CAPABILITIES,
  assertDescriptorConsistent,
  type Capability,
  type LayerKind,
  type ConformanceEvidence,
} from '@poopdeck.gl/core/capabilities';
import type { TimeFilterMode } from '@poopdeck.gl/core/time-filter';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

describe('cesiumBackend descriptor', () => {
  it('covers every LayerKind and gives each unsupported kind a reason', () => {
    for (const kind of LAYER_KINDS) {
      const s = cesiumBackend.layerKinds[kind];
      expect(s, `missing layerKind ${kind}`).toBeDefined();
      if (!s.supported) expect(typeof s.reason).toBe('string');
    }
  });

  it('declares the WGS84 globe traits honestly', () => {
    expect(cesiumBackend.capabilities.globe).toBe(true);
    expect(cesiumBackend.capabilities.cameraRoll).toBe(true); // Cesium is 3-DOF
    expect(cesiumBackend.projectsOnCpu).toBe(true);
    expect(cesiumBackend.basemapProjection).toBe('globe');
    expect(cesiumBackend.pickMechanism).toBe('host');
  });

  it('backs every supported kind with a real exported layer class', () => {
    // Structural gate WITHOUT importing the layers (they import cesium,
    // unavailable in node): assert the source actually exports the class
    // backing each claim, and that nothing else is claimed.
    const backing: Record<string, [file: string, cls: string]> = {
      point: ['cesium-point-layer.ts', 'STTPointLayer'],
      path: ['cesium-path-layer.ts', 'STTPathLayer'],
      line: ['cesium-path-layer.ts', 'STTPathLayer'], // an OD line is a 2-vertex LineString
      arc: ['cesium-arc-layer.ts', 'STTArcLayer'],
      trips: ['cesium-trips-layer.ts', 'STTTripsLayer'],
      tripHeads: ['cesium-trip-heads-layer.ts', 'STTTripHeadsLayer'],
      // Added by the non-deck parity campaign.
      boundingBox: ['cesium-bounding-box-layer.ts', 'STTBoundingBoxLayer'],
      column: ['cesium-column-layer.ts', 'STTColumnLayer'],
      pointCloud: ['cesium-point-cloud-layer.ts', 'STTPointCloudLayer'],
      surfel: ['cesium-surfel-layer.ts', 'STTSurfelLayer'],
      text: ['cesium-text-layer.ts', 'STTTextLayer'],
      ego: ['cesium-ego-layer.ts', 'STTEgoLayer'],
      h3Summary: ['cesium-h3-summary-layer.ts', 'STTH3SummaryLayer'],
      polygon: ['cesium-polygon-layer.ts', 'STTPolygonLayer'],
      icon: ['cesium-icon-layer.ts', 'STTIconLayer'],
      mesh: ['cesium-mesh-layer.ts', 'STTMeshLayer'],
      isoLines: ['cesium-iso-layer.ts', 'STTIsoLayer'],
      quadbinSummary: [
        'cesium-quadbin-summary-layer.ts',
        'STTQuadbinSummaryLayer',
      ],
      hexbin: ['cesium-hexbin-layer.ts', 'STTHexbinLayer'],
      heatmap: ['cesium-heatmap-layer.ts', 'STTHeatmapLayer'],
      flowCorridor: ['cesium-flow-corridor-layer.ts', 'STTFlowCorridorLayer'],
      flowStroke: ['cesium-flow-stroke-layer.ts', 'STTFlowStrokeLayer'],
      flowmap: ['cesium-flowmap-layer.ts', 'STTFlowmapLayer'],
    };
    const supported = LAYER_KINDS.filter(
      (k) => cesiumBackend.layerKinds[k].supported,
    );
    expect(new Set(supported)).toEqual(new Set(Object.keys(backing)));
    for (const [kind, [file, cls]] of Object.entries(backing)) {
      expect(
        cesiumBackend.layerKinds[kind as LayerKind].supported,
        `${kind}`,
      ).toBe(true);
      const src = readFileSync(join(SRC, file), 'utf8');
      expect(src, `${file} must export ${cls}`).toMatch(
        new RegExp(`export class ${cls}`),
      );
    }
  });

  it('renders every frozen LayerKind natively — the parity claim, stated once', () => {
    // This case REPLACES "declares typed fallbacks for the flow family,
    // iso-lines, and surfels". Those fallbacks were the honest description of a
    // backend that rendered six kinds; the 2026-08-26 completion pass made every
    // one of them native, so asserting the fallbacks now would be asserting a
    // degradation that no longer exists.
    const unsupported = LAYER_KINDS.filter(
      (k) => !cesiumBackend.layerKinds[k].supported,
    );
    expect(unsupported).toEqual([]);
    expect(LAYER_KINDS.length).toBe(23);
  });

  it('(c) every declared fallbackKind is itself a kind this backend renders', () => {
    // `degradeRequest` returns {action:'fallback', toKind} whenever a
    // fallbackKind is present, so naming an unsupported target hands the caller
    // a second unrenderable answer instead of the honest skip its `reason`
    // intends. maplibre's suite ships the identical gate; three's is stricter
    // (it REQUIRES a fallback for every unsupported kind) because three's
    // catalog is broad enough that every kind has an approximation. Cesium's
    // catalog is the movement family only, so skipping is the common case and
    // the gate checks the target rather than demanding one.
    for (const kind of LAYER_KINDS) {
      const support = cesiumBackend.layerKinds[kind];
      if (support.supported || !support.fallbackKind) continue;
      expect(
        cesiumBackend.layerKinds[support.fallbackKind as LayerKind]?.supported,
        `fallback of "${kind}" (${support.fallbackKind}) must itself be supported`,
      ).toBe(true);
    }
  });

  it('(c) no kind names a fallback at all, because none needs one', () => {
    // The regression this originally guarded: text/mesh/hexbin were copied from
    // the three descriptor with icon/boundingBox/h3Summary fallbacks that three
    // supports and this backend did not, so `degradeRequest` handed the caller a
    // second unrenderable kind instead of the honest skip its `reason` intends.
    // With every kind native there is nothing left to degrade — which is a
    // STRONGER statement than the old one, and it still fails loudly the moment
    // a future kind is added to LAYER_KINDS without an implementation here.
    for (const kind of LAYER_KINDS) {
      const support = cesiumBackend.layerKinds[kind];
      expect(support.supported, `${kind} must be native`).toBe(true);
    }
  });

  it('passes the over-claim gate against its own proven set', () => {
    const proven: ConformanceEvidence = {
      capabilities: new Set<Capability>(
        CAPABILITIES.filter((c) => cesiumBackend.capabilities[c]),
      ),
      layerKinds: new Set<LayerKind>(
        LAYER_KINDS.filter((k) => cesiumBackend.layerKinds[k].supported),
      ),
      timeFilterModes: new Set<TimeFilterMode>(cesiumBackend.timeFilterModes),
    };
    expect(assertDescriptorConsistent(cesiumBackend, proven)).toEqual([]);
  });

  it('would FAIL the over-claim gate if it claimed an unproven capability', () => {
    const emptyEvidence: ConformanceEvidence = {
      capabilities: new Set(),
      layerKinds: new Set<LayerKind>(['point']),
      timeFilterModes: new Set<TimeFilterMode>([
        'window',
        'wake',
        'cumulative',
        'trail',
      ]),
    };
    // globe is claimed true but not in evidence → a violation is reported.
    expect(
      assertDescriptorConsistent(cesiumBackend, emptyEvidence).some((v) =>
        v.includes('globe'),
      ),
    ).toBe(true);
  });
});
