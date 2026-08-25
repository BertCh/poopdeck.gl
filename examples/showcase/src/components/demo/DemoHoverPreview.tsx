/**
 * Showcase glue for @poopdeck.gl/react's generic <HoverPreview>: turns a
 * showcase `Dataset` + the live `DemoCamera` into the layer tree, viewState,
 * sizing, and Mapbox static basemap the preview card needs. The reusable
 * frozen-clock render kernel lives in the package; everything dataset- or
 * Mapbox-specific stays here.
 */
import React, { useMemo } from 'react';
import { _GlobeView as GlobeView } from '@deck.gl/core';
import { HoverPreview } from '@poopdeck.gl/react/hover-preview';
import type { Dataset } from '../../types';
import { buildDemoLayers } from './buildDemoLayers';
import { withPreviewTileProps } from './previewTileProps';
import { useReducedMotion } from '../../lib/reducedMotion';
import {
  clampPreviewPitch,
  fitPreviewSize,
  previewZoom,
  staticBasemapUrl,
  type DemoCamera,
} from './previewBasemap';

export type { DemoCamera } from './previewBasemap';

export interface DemoHoverPreviewProps {
  dataset: Dataset;
  /** Camera to mirror; null until DemoViewer reports one (renders nothing). */
  camera: DemoCamera | null;
  /** Settled hovered timestamp (sim-ms). */
  time: number;
  /** Upper bounds for the card; actual size matches the live viewport aspect. */
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * NOTE: mount this keyed by `dataset.id` so a dataset switch gives the package
 * preview a fresh archive (its frozen controller + layer tree seed once).
 */
const DemoHoverPreview: React.FC<DemoHoverPreviewProps> = ({
  dataset,
  camera,
  time,
  maxWidth = 264,
  maxHeight = 180,
}) => {
  const useGlobe = dataset.useGlobe ?? false;
  // Same reduced-motion preference the live viewer threads, so the preview's
  // motion-glide point path degrades in lock-step with the main render.
  const reducedMotion = useReducedMotion();

  // Globe view is stable for the dataset's lifetime — recreating it each render
  // would churn deck's view tree.
  const views = useMemo(
    () =>
      useGlobe ? [new GlobeView({ id: 'globe', resolution: 10 })] : undefined,
    [useGlobe],
  );

  if (!camera) return null;

  // Match the live viewport: same aspect ratio AND the zoom that makes this
  // smaller box cover the SAME ground extent — so it reads as a scaled-down
  // copy, not a centered crop. Globe just mirrors the camera at the same zoom.
  const { width, height } = fitPreviewSize(
    camera.viewportWidth,
    camera.viewportHeight,
    maxWidth,
    maxHeight,
  );
  const zoom = useGlobe
    ? camera.zoom
    : previewZoom(camera.zoom, width, camera.viewportWidth);
  const cam: DemoCamera = {
    ...camera,
    zoom,
    pitch: clampPreviewPitch(camera.pitch),
  };
  const viewState: any = useGlobe ? { globe: cam } : cam;

  return (
    <HoverPreview
      time={time}
      timeRange={dataset.timeRange}
      // The preview's own tile-loading recipe (no prefetch, scratch cache, a
      // sliver of the request slots) on top of the live tree — see
      // previewTileProps.ts for why a second live-sized stack was a problem.
      buildLayers={(controller) =>
        withPreviewTileProps(
          buildDemoLayers({
            dataset,
            timeController: controller,
            useGlobe,
            timeHeightScale: 0,
            reducedMotion,
          }),
        )
      }
      viewState={viewState}
      views={views}
      width={width}
      height={height}
      basemapUrl={useGlobe ? null : staticBasemapUrl(cam, width, height)}
      parameters={useGlobe ? { cull: true } : undefined}
    />
  );
};

export default DemoHoverPreview;
