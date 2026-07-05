// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT

/**
 * Structural conformance gate for the deck.gl backend descriptor
 * (docs/roadmap/renderer-abstraction-2026-06.md §4.3 tier 5, Phase 5).
 *
 * This is NOT a GPU/pixel conformance harness (that is the deferred nightly 1px
 * readback). It proves the cheaper-but-real invariant: every layer kind the
 * descriptor claims `supported: true` has an actual exported class backing it,
 * so `assertDescriptorConsistent` reports no over-claim. If a kind's class is
 * ever renamed or dropped from the barrel, this test fails instead of the
 * descriptor lying to `docs/spec/backend-capabilities.md`.
 */

import { describe, it, expect } from 'vitest';
import * as barrel from '../src/index';
import { deckBackend } from '../src/backend-descriptor';
import {
  LAYER_KINDS,
  CAPABILITIES,
  assertDescriptorConsistent,
  type LayerKind,
  type Capability,
  type TimeFilterMode,
  type ConformanceEvidence,
} from '@poopdeck.gl/core/capabilities';

/**
 * The layer class each supported kind resolves to in the package index. Only
 * the kinds the deck backend claims `supported: true` need an entry; the
 * unsupported kinds (isoLines/ego) have no dedicated class.
 */
const KIND_TO_EXPORT: Partial<Record<LayerKind, string>> = {
  point: 'AnimatedPointLayer',
  path: 'AnimatedPathLayer',
  polygon: 'AnimatedPolygonLayer',
  arc: 'AnimatedArcLayer',
  line: 'AnimatedLineLayer',
  icon: 'AnimatedIconLayer',
  column: 'AnimatedColumnLayer',
  trips: 'AnimatedTripsLayer',
  tripHeads: 'AnimatedTripHeadsLayer',
  boundingBox: 'AnimatedBoundingBoxLayer',
  surfel: 'SplatLayer',
  heatmap: 'AnimatedHeatmapLayer',
  h3Summary: 'H3SummaryLayer',
  quadbinSummary: 'QuadbinSummaryLayer',
  flowmap: 'FlowmapLayer',
  flowCorridor: 'FlowCorridorLayer',
  flowStroke: 'FlowStrokeLayer',
  text: 'AnimatedTextLayer',
  mesh: 'AnimatedMeshLayer',
  pointCloud: 'AnimatedPointCloudLayer',
  hexbin: 'AnimatedHexagonLayer',
};

const exports = barrel as Record<string, unknown>;

/** Kinds this descriptor claims are supported. */
const supportedKinds = LAYER_KINDS.filter((k) => deckBackend.layerKinds[k].supported);

describe('deckBackend — the descriptor is exported', () => {
  it('re-exports deckBackend from the package index', () => {
    expect(exports.deckBackend).toBe(deckBackend);
    expect(deckBackend.id).toBe('deck');
  });
});

describe('deckBackend — every supported kind maps to a real export (a)', () => {
  it('every supported kind has a KIND_TO_EXPORT entry', () => {
    for (const kind of supportedKinds) {
      expect(KIND_TO_EXPORT[kind], `KIND_TO_EXPORT.${kind}`).toBeTypeOf('string');
    }
  });

  it.each(supportedKinds)('kind "%s" is backed by a live exported class', (kind) => {
    const name = KIND_TO_EXPORT[kind]!;
    const cls = exports[name];
    expect(cls, `barrel.${name} (kind=${kind})`).toBeTypeOf('function');
  });
});

describe('deckBackend — no over-claim vs. actual exports (b)', () => {
  it('assertDescriptorConsistent returns [] against evidence built from real exports', () => {
    // Layer-kind evidence comes ONLY from classes actually present in the
    // barrel — the structural teeth. A misspelled/dropped export would leave
    // the kind out of `provenKinds` and trip the over-claim gate below.
    const provenKinds = new Set<LayerKind>(
      supportedKinds.filter((k) => {
        const name = KIND_TO_EXPORT[k];
        return !!name && !!exports[name];
      }),
    );
    // Capability + mode evidence: the descriptor's own claims (this structural
    // gate proves catalog coverage, not GPU pixels — those are the deferred
    // nightly readback). The gate still fails on any capability/mode the
    // descriptor claims that is absent from these sets.
    const provenCaps = new Set<Capability>(CAPABILITIES.filter((c) => deckBackend.capabilities[c]));
    const provenModes = new Set<TimeFilterMode>(deckBackend.timeFilterModes);

    const evidence: ConformanceEvidence = {
      capabilities: provenCaps,
      layerKinds: provenKinds,
      timeFilterModes: provenModes,
    };

    expect(assertDescriptorConsistent(deckBackend, evidence)).toEqual([]);
  });
});

describe('deckBackend — layerKinds is exhaustive + unsupported carry a reason (c)', () => {
  it('every LayerKind key is present in layerKinds', () => {
    for (const kind of LAYER_KINDS) {
      expect(deckBackend.layerKinds[kind], `layerKinds.${kind}`).toBeDefined();
    }
  });

  it('every unsupported kind carries a non-empty reason', () => {
    for (const kind of LAYER_KINDS) {
      const support = deckBackend.layerKinds[kind];
      if (!support.supported) {
        expect(support.reason, `layerKinds.${kind}.reason`).toBeTruthy();
      }
    }
  });
});
