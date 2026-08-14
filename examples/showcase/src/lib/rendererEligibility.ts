import type { Dataset, DatasetType } from '../types';

/**
 * Lightweight route-gating tables. Keep renderer implementations out of the
 * default deck route: importing their published backend descriptors through
 * the package barrels also imports MapLibre/Three and defeats code splitting.
 *
 * `test/renderer-eligibility.test.ts` recomputes both sets from the canonical
 * descriptors, so these cheap literals cannot silently drift.
 */
export const MAPLIBRE_RENDERABLE_TYPES: ReadonlySet<DatasetType> = new Set([
  'point',
  'polygon',
  'arc',
  'line',
  'icon',
  'column',
  'trips',
  'tripHeads',
  'heatmap',
  'h3Summary',
  'quadbinSummary',
  'flowmap',
  'flowCorridor',
  'flowStroke',
  'hexbin',
  'lightning',
  'radar',
  'flowmap-bundled',
]);

export const THREE_GEO_RENDERABLE_TYPES: ReadonlySet<DatasetType> = new Set([
  'point',
  'path',
  'polygon',
  'arc',
  'line',
  'icon',
  'column',
  'trips',
  'tripHeads',
  'boundingBox',
  'surfel',
  'h3Summary',
  'quadbinSummary',
  'flowmap',
  'flowCorridor',
  'isoLines',
  'ego',
  'flowmap-bundled',
]);

export function datasetSupportsThree(dataset: Dataset): boolean {
  return THREE_GEO_RENDERABLE_TYPES.has(dataset.type);
}
