// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  LAYER_KINDS,
  CAPABILITIES,
  degradeRequest,
  assertDescriptorConsistent,
  type BackendDescriptor,
  type Capability,
  type LayerKind,
  type ConformanceEvidence,
} from '../src/render/capabilities';
import type { TimeFilterMode } from '../src/render/time-filter';

function descriptor(over: Partial<BackendDescriptor> = {}): BackendDescriptor {
  const capabilities = Object.fromEntries(CAPABILITIES.map((c) => [c, false])) as Record<Capability, boolean>;
  const layerKinds = Object.fromEntries(
    LAYER_KINDS.map((k) => [k, { supported: false, reason: 'not built' }]),
  ) as Record<LayerKind, { supported: false; reason: string }>;
  return {
    id: 'test',
    capabilities,
    timeFilterModes: ['window'],
    layerKinds,
    projectsOnCpu: false,
    tilesetOwnership: 'shared',
    pickMechanism: 'none',
    interleavedBasemap: true,
    basemapProjection: 'mercator',
    ...over,
  };
}

describe('vocabulary is a stable frozen set', () => {
  it('has the expected core kinds + capabilities (drift guard)', () => {
    expect(LAYER_KINDS).toContain('point');
    expect(LAYER_KINDS).toContain('surfel');
    expect(CAPABILITIES).toContain('globe');
    expect(CAPABILITIES).toContain('cameraRoll');
    // No duplicates.
    expect(new Set(LAYER_KINDS).size).toBe(LAYER_KINDS.length);
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });
});

describe('degradeRequest', () => {
  const d = descriptor({
    layerKinds: {
      ...descriptor().layerKinds,
      point: { supported: true },
      surfel: { supported: false, fallbackKind: 'point', reason: 'no oriented splat' },
      heatmap: { supported: false, reason: 'no GPU aggregation' },
    } as Record<LayerKind, { supported: true } | { supported: false; fallbackKind?: LayerKind; reason: string }>,
    timeFilterModes: ['window', 'trail'],
  });

  it('returns null when kind + mode are both supported', () => {
    expect(degradeRequest(d, 'point', 'window')).toBeNull();
  });
  it('falls back an unsupported kind that has a fallbackKind', () => {
    expect(degradeRequest(d, 'surfel', 'window')).toEqual({ action: 'fallback', toKind: 'point', lost: [] });
  });
  it('skips an unsupported kind with no fallback', () => {
    const r = degradeRequest(d, 'heatmap', 'window');
    expect(r?.action).toBe('skip');
  });
  it('falls back an unsupported mode to window (the maplibre wake/cumulative gap)', () => {
    expect(degradeRequest(d, 'point', 'wake')).toEqual({
      action: 'fallbackMode',
      fromMode: 'wake' as TimeFilterMode,
      toMode: 'window' as TimeFilterMode,
      lost: [],
    });
  });
  it('kind support is checked before mode', () => {
    // surfel unsupported AND wake unsupported → the kind fallback wins.
    expect(degradeRequest(d, 'surfel', 'wake')?.action).toBe('fallback');
  });
});

describe('assertDescriptorConsistent (over-claim gate)', () => {
  const proven: ConformanceEvidence = {
    capabilities: new Set<Capability>(['picking']),
    layerKinds: new Set<LayerKind>(['point']),
    timeFilterModes: new Set<TimeFilterMode>(['window']),
  };

  it('passes when every claim has evidence', () => {
    const d = descriptor({
      capabilities: { ...descriptor().capabilities, picking: true },
      layerKinds: { ...descriptor().layerKinds, point: { supported: true } } as BackendDescriptor['layerKinds'],
      timeFilterModes: ['window'],
    });
    expect(assertDescriptorConsistent(d, proven)).toEqual([]);
  });

  it('flags a capability claimed without a passing case', () => {
    const d = descriptor({ capabilities: { ...descriptor().capabilities, globe: true } });
    const v = assertDescriptorConsistent(d, proven);
    expect(v.some((s) => s.includes('globe'))).toBe(true);
  });

  it('flags a layer kind + a mode claimed without evidence', () => {
    const d = descriptor({
      layerKinds: { ...descriptor().layerKinds, arc: { supported: true } } as BackendDescriptor['layerKinds'],
      timeFilterModes: ['window', 'trail'],
    });
    const v = assertDescriptorConsistent(d, proven);
    expect(v.some((s) => s.includes('arc'))).toBe(true);
    expect(v.some((s) => s.includes('trail'))).toBe(true);
  });
});
