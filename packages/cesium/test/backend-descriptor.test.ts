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

  it('declares typed fallbacks for the flow family, iso-lines, and surfels', () => {
    expect(cesiumBackend.layerKinds.surfel).toMatchObject({
      supported: false,
      fallbackKind: 'point',
    });
    expect(cesiumBackend.layerKinds.flowmap).toMatchObject({
      supported: false,
      fallbackKind: 'line',
    });
    expect(cesiumBackend.layerKinds.flowCorridor).toMatchObject({
      supported: false,
      fallbackKind: 'line',
    });
    expect(cesiumBackend.layerKinds.flowStroke).toMatchObject({
      supported: false,
      fallbackKind: 'line',
    });
    expect(cesiumBackend.layerKinds.isoLines).toMatchObject({
      supported: false,
      fallbackKind: 'path',
    });
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

  it('(c) a kind with no in-backend approximation SKIPS rather than naming a dead fallback', () => {
    // The exact regression this guards: text/mesh/hexbin were copied from the
    // three descriptor with icon/boundingBox/h3Summary fallbacks that three
    // supports and this backend does not. None of the three targets is in
    // Cesium's catalog, so all three must skip.
    for (const kind of ['text', 'mesh', 'hexbin'] as const) {
      const support = cesiumBackend.layerKinds[kind];
      expect(support.supported).toBe(false);
      if (!support.supported) expect(support.fallbackKind).toBeUndefined();
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
