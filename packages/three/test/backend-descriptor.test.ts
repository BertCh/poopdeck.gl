import { describe, it, expect } from 'vitest';
import {
  LAYER_KINDS,
  CAPABILITIES,
  assertDescriptorConsistent,
  type LayerKind,
  type ConformanceEvidence,
} from '@poopdeck.gl/core/capabilities';
import {
  threeBackend,
  threeLayerFeatures,
  LAYER_FEATURES,
  type LayerFeature,
} from '../src/backend-descriptor';
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
  point: 'STTPointLayer',
  path: 'STTStaticPathLayer',
  polygon: 'STTStaticPolygonLayer',
  arc: 'STTArcLayer',
  line: 'STTWideLineLayer',
  icon: 'STTIconLayer',
  column: 'STTColumnLayer',
  trips: 'STTTripsLayer',
  tripHeads: 'STTTripHeadsLayer',
  boundingBox: 'STTBoundingBoxLayer',
  surfel: 'STTSurfelLayer',
  h3Summary: 'STTH3SummaryLayer',
  quadbinSummary: 'STTQuadbinSummaryLayer',
  flowmap: 'STTFlowmapLayer',
  flowCorridor: 'STTFlowCorridorLayer',
  isoLines: 'STTIsoLayer',
  ego: 'STTEgoLayer',
  // Closed by the non-deck parity campaign — three now renders all 23 kinds
  // natively, so there is no `null` entry left. A future unsupported kind gets
  // one back, and case (a) below then requires it to carry a fallback.
  heatmap: 'STTHeatmapLayer',
  flowStroke: 'STTFlowStrokeLayer',
  text: 'STTTextLayer',
  mesh: 'STTMeshLayer',
  pointCloud: 'STTPointCloudLayer',
  hexbin: 'STTHexbinLayer',
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
      expect(
        support,
        `missing declaration for layer kind "${kind}"`,
      ).toBeDefined();
      if (!support.supported) {
        expect(
          support.reason,
          `unsupported kind "${kind}" must carry a reason`,
        ).toBeTruthy();
      }
    }
    // No stray keys beyond the frozen vocabulary.
    expect(Object.keys(threeBackend.layerKinds).sort()).toEqual(
      [...LAYER_KINDS].sort(),
    );
  });

  it('(a) every supported kind maps to a real renderer class exported from ../src/index', () => {
    for (const kind of LAYER_KINDS) {
      if (!threeBackend.layerKinds[kind].supported) continue;
      const exportName = KIND_TO_EXPORT[kind];
      expect(
        exportName,
        `no export mapping for supported kind "${kind}"`,
      ).toBeTruthy();
      const cls = exports[exportName as string];
      expect(
        typeof cls,
        `supported kind "${kind}" expects export "${exportName}" to be a class`,
      ).toBe('function');
    }
  });

  it('unsupported kinds fall back to a supported kind', () => {
    // Vacuous today (three renders all 23), and deliberately kept: it is the
    // gate a future unsupported kind trips if it names no fallback, or names one
    // three does not itself render. The companion case below asserts the
    // all-native state directly so this file cannot go quietly vacuous.
    for (const kind of LAYER_KINDS) {
      const support = threeBackend.layerKinds[kind];
      if (support.supported) continue;
      expect(
        support.fallbackKind,
        `unsupported "${kind}" should name a fallback`,
      ).toBeTruthy();
      const target = threeBackend.layerKinds[support.fallbackKind as LayerKind];
      expect(
        target?.supported,
        `fallback of "${kind}" (${support.fallbackKind}) must itself be supported`,
      ).toBe(true);
    }
  });

  it('renders every frozen LayerKind natively — the parity claim, stated once', () => {
    const unsupported = LAYER_KINDS.filter(
      (k) => !threeBackend.layerKinds[k].supported,
    );
    expect(unsupported).toEqual([]);
    expect(LAYER_KINDS.length).toBe(23);
  });

  it('(b) assertDescriptorConsistent flags no over-claim for layer kinds (real exports) or modes', () => {
    // Layer-kind evidence: a kind is proven iff its mapped class is a real export —
    // derived INDEPENDENTLY of the descriptor's own claim, so a kind claimed with no
    // backing class surfaces as a violation. This is the genuine over-claim gate.
    const provenKinds = new Set<LayerKind>();
    for (const kind of LAYER_KINDS) {
      if (!threeBackend.layerKinds[kind].supported) continue;
      const exportName = KIND_TO_EXPORT[kind];
      if (exportName && typeof exports[exportName] === 'function') {
        provenKinds.add(kind);
      }
    }
    // Time-filter mode evidence is the descriptor's claimed modes; those are gated
    // independently by the "backed by real alpha exports" case below.
    const provenModes = new Set(threeBackend.timeFilterModes);
    // The capability axis is DELIBERATELY not gated here. Capabilities are
    // cross-cutting runtime behaviours (globe/picking/extrude3d/metricSizing) with
    // no 1:1 structural export to prove them, so deriving evidence from
    // `threeBackend.capabilities` (as this case used to) is a self-fulfilling
    // tautology that can never fail. We pass the full capability set so this case
    // asserts ONLY the two axes it can honestly prove structurally — layer kinds
    // and modes; capability conformance is a Tier-2 pixel/behavioural concern the
    // user browser-verifies (see vitest.config.ts).
    const evidence: ConformanceEvidence = {
      capabilities: new Set(CAPABILITIES),
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
      expect(
        typeof exports[name],
        `mode "${mode}" expects export "${name}"`,
      ).toBe('function');
    }
  });

  /* ────────────────────────────────────────────────────────────────────────
   * Layer-feature matrix (2026-07 kind-parity campaign).
   *
   * deck (the reference backend) gained per-layer prop families. three does NOT
   * implement any of them yet — the honest declaration is a DELIBERATE typed
   * fallback + reason per feature, not a silent no-op. This gate proves the
   * three table is exhaustive over the frozen vocabulary and that every entry
   * degrades explicitly, and cross-checks the one entry that must agree with a
   * coarse capability (timeHeightScale ⇄ capabilities.timeAsHeight).
   * ──────────────────────────────────────────────────────────────────────── */
  it('threeLayerFeatures declares every LAYER_FEATURE exactly once, no strays', () => {
    for (const feature of LAYER_FEATURES) {
      expect(
        threeLayerFeatures[feature],
        `threeLayerFeatures.${feature}`,
      ).toBeDefined();
    }
    expect(Object.keys(threeLayerFeatures).sort()).toEqual(
      [...LAYER_FEATURES].sort(),
    );
  });

  it.each(LAYER_FEATURES)(
    'feature "%s" is a well-formed support/fallback declaration',
    (feature: LayerFeature) => {
      const support = threeLayerFeatures[feature];
      expect(support.kinds.length, `${feature}.kinds`).toBeGreaterThan(0);
      // Every kind the declaration names — whether supported or a degrade
      // target — must be a real LayerKind the descriptor knows about (no typos).
      for (const kind of support.kinds) {
        expect(
          threeBackend.layerKinds[kind],
          `feature "${feature}" names unknown kind "${kind}"`,
        ).toBeDefined();
      }
      if (support.supported) {
        // A ported feature must carry its enabling prop + a human summary.
        expect(support.prop, `${feature}.prop`).toBeTruthy();
        expect(support.summary, `${feature}.summary`).toBeTruthy();
      } else {
        expect(support.fallback, `${feature}.fallback`).toBeTruthy();
        expect(support.reason, `${feature}.reason`).toBeTruthy();
      }
    },
  );

  it('dataFilter is supported on the full deck kind set (icon included)', () => {
    // Wave 1 + the icon follow-up wired DataFilter end-to-end on every kind deck
    // filters on — arc/line/trips/column/polygon/icon. The supported set must be
    // the complete deck set; dropping a kind would under-state three's reach.
    // three deliberately does not depend on `@poopdeck.gl/layers`, so the deck
    // set is asserted literally.
    const support = threeLayerFeatures.dataFilter;
    expect(support.supported).toBe(true);
    expect([...support.kinds].sort()).toEqual(
      ['arc', 'column', 'icon', 'line', 'polygon', 'trips'].sort(),
    );
  });

  it('timeHeightScale fallback is consistent with capabilities.timeAsHeight', () => {
    const support = threeLayerFeatures.timeHeightScale;
    // The space-time-cube lift is a rendering of time-as-height; the two claims
    // must never disagree.
    expect(support.supported).toBe(threeBackend.capabilities.timeAsHeight);
  });
});
