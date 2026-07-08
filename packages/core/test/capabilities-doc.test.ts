// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { renderCapabilitiesMarkdown } from '../src/render/capabilities-doc';
import {
  LAYER_KINDS,
  CAPABILITIES,
  type BackendDescriptor,
  type LayerKind,
} from '../src/render/capabilities';

function descriptor(
  id: string,
  over: Partial<BackendDescriptor> = {},
): BackendDescriptor {
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((c) => [c, false]),
  ) as BackendDescriptor['capabilities'];
  const layerKinds = Object.fromEntries(
    LAYER_KINDS.map((k) => [k, { supported: false, reason: 'x' }]),
  ) as BackendDescriptor['layerKinds'];
  return {
    id,
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

describe('renderCapabilitiesMarkdown', () => {
  const a = descriptor('deck', {
    capabilities: { ...descriptor('deck').capabilities, globe: true },
    timeFilterModes: ['window', 'wake', 'cumulative', 'trail'],
    layerKinds: {
      ...descriptor('deck').layerKinds,
      point: { supported: true },
    } as BackendDescriptor['layerKinds'],
  });
  const b = descriptor('maplibre', {
    layerKinds: {
      ...descriptor('maplibre').layerKinds,
      arc: { supported: false, fallbackKind: 'line' as LayerKind, reason: 'x' },
    } as BackendDescriptor['layerKinds'],
  });
  const md = renderCapabilitiesMarkdown([a, b]);

  it('has a column per backend id + all sections', () => {
    expect(md).toContain('| deck | maplibre |');
    expect(md).toContain('## Capabilities');
    expect(md).toContain('## Time-filter modes');
    expect(md).toContain('## Layer kinds');
  });
  it('marks native ✅, fallback ↳, unsupported —, and never leaks undefined', () => {
    expect(md).toContain('| globe | ✅ | — |');
    expect(md).toContain('↳ line'); // maplibre arc fallback
    expect(md).not.toContain('undefined');
    // Every LAYER_KIND has a row.
    for (const k of LAYER_KINDS) expect(md).toContain(`| ${k} |`);
  });
});
