import { describe, it, expect } from 'vitest';
import {
  LAYER_KINDS,
  CAPABILITIES,
  assertDescriptorConsistent,
  type Capability,
  type LayerKind,
  type ConformanceEvidence,
} from '@poopdeck.gl/core/capabilities';
import { threeBackend } from '../src/backend-descriptor';
import * as three from '../src/index';

/**
 * The structural conformance gate for the three backend's `BackendDescriptor`.
 *
 * "Structural" (vs the pixel-level readback conformance of Tier-2): a supported
 * layer kind is *proven* by the existence of its concrete renderer class as a
 * public export of `../src/index`. If a class is deleted or renamed, the mapping
 * below stops resolving and this gate fails — exactly the over-claim protection
 * `assertDescriptorConsistent` is designed to enforce.
 */
const KIND_TO_EXPORT: Record<LayerKind, string | null> = {
  point: 'PointCloudLayer',
  path: 'StaticPathLayer',
  polygon: 'StaticPolygonLayer',
  arc: 'ArcLayer',
  line: 'WideLineLayer',
  icon: 'IconLayer',
  column: 'ColumnLayer',
  trips: 'TripsLayer',
  tripHeads: 'TripHeadsLayer',
  boundingBox: 'BoundingBoxLayer',
  surfel: 'SurfelLayer',
  h3Summary: 'H3SummaryLayer',
  quadbinSummary: 'QuadbinSummaryLayer',
  flowmap: 'FlowmapLayer',
  flowCorridor: 'FlowCorridorLayer',
  isoLines: 'IsoLayer',
  ego: 'EgoLayer',
  // Not natively rendered by three; no class expected.
  heatmap: null,
  flowStroke: null,
  text: null,
  mesh: null,
  pointCloud: null,
  hexbin: null,
};

const exports = three as Record<string, unknown>;

describe('threeBackend descriptor — structural conformance gate', () => {
  it('is exported from ../src/index', () => {
    expect(exports.threeBackend).toBe(threeBackend);
    expect(threeBackend.id).toBe('three');
  });

  it('(c) declares every LayerKind key; every unsupported kind carries a reason', () => {
    for (const kind of LAYER_KINDS) {
      const support = threeBackend.layerKinds[kind];
      expect(support, `missing declaration for layer kind "${kind}"`).toBeDefined();
      if (!support.supported) {
        expect(
          support.reason,
          `unsupported kind "${kind}" must carry a reason`,
        ).toBeTruthy();
      }
    }
    // No stray keys beyond the frozen vocabulary.
    expect(Object.keys(threeBackend.layerKinds).sort()).toEqual([...LAYER_KINDS].sort());
  });

  it('(a) every supported kind maps to a real renderer class exported from ../src/index', () => {
    for (const kind of LAYER_KINDS) {
      if (!threeBackend.layerKinds[kind].supported) continue;
      const exportName = KIND_TO_EXPORT[kind];
      expect(exportName, `no export mapping for supported kind "${kind}"`).toBeTruthy();
      const cls = exports[exportName as string];
      expect(
        typeof cls,
        `supported kind "${kind}" expects export "${exportName}" to be a class`,
      ).toBe('function');
    }
  });

  it('unsupported kinds fall back to a supported kind', () => {
    for (const kind of LAYER_KINDS) {
      const support = threeBackend.layerKinds[kind];
      if (support.supported) continue;
      expect(support.fallbackKind, `unsupported "${kind}" should name a fallback`).toBeTruthy();
      const target = threeBackend.layerKinds[support.fallbackKind as LayerKind];
      expect(
        target?.supported,
        `fallback of "${kind}" (${support.fallbackKind}) must itself be supported`,
      ).toBe(true);
    }
  });

  it('(b) assertDescriptorConsistent == [] against evidence built from real exports + claimed caps/modes', () => {
    // Layer-kind evidence: a kind is proven iff its mapped class is a real export.
    const provenKinds = new Set<LayerKind>();
    for (const kind of LAYER_KINDS) {
      if (!threeBackend.layerKinds[kind].supported) continue;
      const exportName = KIND_TO_EXPORT[kind];
      if (exportName && typeof exports[exportName] === 'function') {
        provenKinds.add(kind);
      }
    }
    // Capability evidence: the caps the descriptor claims true (structural gate —
    // these are retro-documented as shipping reality).
    const provenCaps = new Set<Capability>(
      CAPABILITIES.filter((cap) => threeBackend.capabilities[cap]),
    );
    // Time-filter mode evidence: three ships CPU-ref + TSL nodes for each claimed
    // mode (windowAlpha/wakeAlpha/cumulativeAlpha/trailAlpha are real exports).
    const provenModes = new Set(threeBackend.timeFilterModes);

    const evidence: ConformanceEvidence = {
      capabilities: provenCaps,
      layerKinds: provenKinds,
      timeFilterModes: provenModes,
    };

    expect(assertDescriptorConsistent(threeBackend, evidence)).toEqual([]);
  });

  it('claimed time-filter modes are backed by real alpha exports', () => {
    const MODE_TO_EXPORT: Record<string, string> = {
      window: 'windowAlpha',
      wake: 'wakeAlpha',
      cumulative: 'cumulativeAlpha',
      trail: 'trailAlpha',
    };
    for (const mode of threeBackend.timeFilterModes) {
      const name = MODE_TO_EXPORT[mode];
      expect(name, `no export mapping for mode "${mode}"`).toBeTruthy();
      expect(typeof exports[name], `mode "${mode}" expects export "${name}"`).toBe('function');
    }
  });
});
