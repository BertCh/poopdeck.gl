import { describe, expect, it } from 'vitest';
import { maplibreBackend } from '@poopdeck.gl/maplibre';
import { threeBackend } from '@poopdeck.gl/three';
import { renderableDatasetTypes } from '../src/lib/backendSupport';
import {
  MAPLIBRE_RENDERABLE_TYPES,
  THREE_GEO_RENDERABLE_TYPES,
} from '../src/lib/rendererEligibility';

describe('lightweight renderer eligibility tables', () => {
  it('matches the canonical MapLibre descriptor', () => {
    expect([...MAPLIBRE_RENDERABLE_TYPES]).toEqual([
      ...renderableDatasetTypes(maplibreBackend, [
        'lightning',
        'radar',
        'flowmap-bundled',
      ]),
    ]);
  });

  it('matches the canonical Three descriptor', () => {
    expect([...THREE_GEO_RENDERABLE_TYPES]).toEqual([
      ...renderableDatasetTypes(threeBackend, ['flowmap-bundled']),
    ]);
  });
});
