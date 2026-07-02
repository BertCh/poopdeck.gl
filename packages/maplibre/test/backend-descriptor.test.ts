// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Structural conformance gate for the maplibre backend descriptor
 * (docs/roadmap/renderer-abstraction-2026-06.md Phase 5).
 *
 * This does NOT re-test rendering behaviour (the other suites do). It proves the
 * DECLARATION cannot drift or lie:
 *   (a) every kind claimed `supported` maps to a class that is a real export;
 *   (b) `assertDescriptorConsistent(maplibreBackend, evidence)` == [] where the
 *       evidence set is built from the REAL exports + the claimed caps/modes — so
 *       a supported kind whose export vanished would fail the over-claim gate;
 *   (c) the record is exhaustive over `LAYER_KINDS` and every unsupported kind
 *       carries a reason.
 */

import { describe, it, expect } from 'vitest';
import {
  LAYER_KINDS,
  CAPABILITIES,
  assertDescriptorConsistent,
  type LayerKind,
  type Capability,
  type ConformanceEvidence,
} from '@poopdeck.gl/core/capabilities';
import type { TimeFilterMode } from '@poopdeck.gl/core/time-filter';
import { maplibreBackend } from '../src/backend-descriptor';
import * as maplibre from '../src/index';

/** The exported layer class that renders each maplibre-supported kind. */
const CLASS_FOR_KIND: Partial<Record<LayerKind, string>> = {
  point: 'STTPointLayer',
  line: 'STTLineLayer',
  polygon: 'STTPolygonLayer',
  trips: 'STTTripsLayer',
  heatmap: 'STTHeatmapLayer',
};

const exports = maplibre as unknown as Record<string, unknown>;
const isExportedClass = (name: string | undefined): boolean =>
  name !== undefined && typeof exports[name] === 'function';

describe('maplibreBackend descriptor', () => {
  it('is the maplibre backend and re-exports through the package barrel', () => {
    expect(maplibreBackend.id).toBe('maplibre');
    expect((maplibre as { maplibreBackend?: unknown }).maplibreBackend).toBe(maplibreBackend);
  });

  it('(c) declares every LayerKind exactly once (exhaustive over the frozen vocabulary)', () => {
    expect(Object.keys(maplibreBackend.layerKinds).sort()).toEqual([...LAYER_KINDS].sort());
    for (const kind of LAYER_KINDS) {
      expect(maplibreBackend.layerKinds[kind], `missing kind ${kind}`).toBeDefined();
    }
  });

  it('(c) every unsupported kind carries a reason', () => {
    for (const kind of LAYER_KINDS) {
      const support = maplibreBackend.layerKinds[kind];
      if (!support.supported) {
        expect(support.reason, `unsupported kind ${kind} needs a reason`).toBeTruthy();
      }
    }
  });

  it('supports exactly point/line/polygon/trips/heatmap and nothing else', () => {
    const supported = LAYER_KINDS.filter((k) => maplibreBackend.layerKinds[k].supported).sort();
    expect(supported).toEqual(['heatmap', 'line', 'point', 'polygon', 'trips']);
  });

  it('degrades arc to a line fallback (natural for a backend without arc geometry)', () => {
    const arc = maplibreBackend.layerKinds.arc;
    expect(arc.supported).toBe(false);
    if (!arc.supported) {
      expect(arc.fallbackKind).toBe('line');
      expect(arc.reason).toBeTruthy();
    }
  });

  it('declares window + trail only (no wake/cumulative)', () => {
    expect([...maplibreBackend.timeFilterModes].sort()).toEqual(['trail', 'window']);
  });

  it('(a) every supported kind maps to a class that is a real export', () => {
    for (const kind of LAYER_KINDS) {
      if (maplibreBackend.layerKinds[kind].supported) {
        const name = CLASS_FOR_KIND[kind];
        expect(name, `no class mapping for supported kind ${kind}`).toBeDefined();
        expect(isExportedClass(name), `${name} is not an exported class`).toBe(true);
      }
    }
  });

  it('(b) is consistent: no capability/kind/mode is claimed without evidence', () => {
    // Evidence is derived from the ground truth (real exports + declared caps/modes),
    // NOT copied from the descriptor — so if a supported kind's class disappeared,
    // its evidence would drop out and the gate would flag the over-claim.
    const provenKinds = new Set<LayerKind>(
      (Object.keys(CLASS_FOR_KIND) as LayerKind[]).filter((k) => isExportedClass(CLASS_FOR_KIND[k])),
    );
    const provenCaps = new Set<Capability>(
      CAPABILITIES.filter((c) => maplibreBackend.capabilities[c]),
    );
    const evidence: ConformanceEvidence = {
      capabilities: provenCaps,
      layerKinds: provenKinds,
      timeFilterModes: new Set<TimeFilterMode>(maplibreBackend.timeFilterModes),
    };
    expect(assertDescriptorConsistent(maplibreBackend, evidence)).toEqual([]);
  });
});
