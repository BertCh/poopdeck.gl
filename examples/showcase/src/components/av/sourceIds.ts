/**
 * The two-way map between an AV scene's stream toggles and the deck layer /
 * playback-governor ids `buildDemoLayers`' `case 'av'` mints for them.
 *
 * `layerStream` reads a built layer's id back to the stream that owns it (so a
 * toggled-off stream's layer can be dropped from the tree); `streamSourceIds`
 * is its inverse (so a hidden stream's governor source can be unregistered);
 * `allSourceIds` is the union, for the teardown that runs when the ACTIVE
 * dataset changes id — a LIDAR render-mode switch re-ids every layer, and a
 * source left behind pins the playback gate at zero forever.
 *
 * Pure and dependency-free so it can be pinned against the real layer tree in
 * a node test (see `test/av-render-mode-switch.test.ts`); {@link AvDeck} is the
 * only runtime consumer.
 */
import type { AvStreamKey } from './sceneTypes';

/** Which streams own which built layer (by the id suffix buildDemoLayers sets). */
export function layerStream(layerId: string, datasetId: string): AvStreamKey {
  if (layerId === `${datasetId}-ego`) return 'ego';
  if (layerId === `${datasetId}-objects`) return 'objects';
  if (
    layerId === `${datasetId}-map-poly` ||
    layerId === `${datasetId}-map-line`
  )
    return 'map';
  return 'lidar'; // the primary layer carries the bare dataset id
}

/** Tile streams that register a governor source (telemetry/camera are sidecars). */
export const GOVERNED_STREAMS: AvStreamKey[] = [
  'lidar',
  'ego',
  'objects',
  'map',
];

/** Governor source id(s) a stream registers — the inverse of {@link layerStream}. */
export function streamSourceIds(
  stream: AvStreamKey,
  datasetId: string,
): string[] {
  switch (stream) {
    case 'ego':
      return [`${datasetId}-ego`];
    case 'objects':
      return [`${datasetId}-objects`];
    case 'map':
      return [`${datasetId}-map-poly`, `${datasetId}-map-line`];
    case 'lidar':
      return [datasetId]; // primary layer carries the bare dataset id
    default:
      return []; // telemetry / camera are sidecar JSON, not governor sources
  }
}

/**
 * EVERY governor source id a scene's layer tree can register, for the teardown
 * that runs when the active dataset changes id. It is the union of
 * {@link streamSourceIds} over the governed streams PLUS `<id>-stage` — the
 * scene-split "stage" backdrop, which is an optional source with no stream
 * toggle of its own.
 */
export function allSourceIds(datasetId: string): string[] {
  return [
    ...GOVERNED_STREAMS.flatMap((s) => streamSourceIds(s, datasetId)),
    `${datasetId}-stage`,
  ];
}
