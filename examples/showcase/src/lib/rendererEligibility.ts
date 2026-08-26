import type { Dataset, DatasetType } from '../types';

/**
 * Lightweight route-gating tables. Keep renderer implementations out of the
 * default deck route: importing their published backend descriptors through
 * the package barrels also imports MapLibre/Three and defeats code splitting.
 *
 * `test/renderer-eligibility.test.ts` recomputes both sets from the canonical
 * descriptors, so these cheap literals cannot silently drift. Both are now the
 * FULL cross-backend vocabulary plus each adapter's own composites — the
 * non-deck parity campaign closed every remaining kind in both backends.
 * `test/dataset-types.test.ts` pins which of these types a demo page actually
 * offers, which is the smaller, more interesting list.
 */
export const MAPLIBRE_RENDERABLE_TYPES: ReadonlySet<DatasetType> = new Set([
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
  'heatmap',
  'h3Summary',
  'quadbinSummary',
  'flowmap',
  'flowCorridor',
  'flowStroke',
  'isoLines',
  'ego',
  'text',
  'mesh',
  'pointCloud',
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
  'heatmap',
  'h3Summary',
  'quadbinSummary',
  'flowmap',
  'flowCorridor',
  'flowStroke',
  'isoLines',
  'ego',
  'text',
  'mesh',
  'pointCloud',
  'hexbin',
  'flowmap-bundled',
]);

export function datasetSupportsThree(dataset: Dataset): boolean {
  return THREE_GEO_RENDERABLE_TYPES.has(dataset.type);
}
