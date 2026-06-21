// @poopdeck.gl/showcase
// SPDX-License-Identifier: MIT

/**
 * AvThreeViewer — the AV cockpit map viewport rendered by the Three.js + TSL
 * (WebGPU) engine via its react-three-fiber binding (`@poopdeck.gl/three/r3f`).
 * A drop-in alternative to {@link AvDeck}: same resolved Dataset av fields +
 * palettes + the same shared `TimeController`, composed declaratively as r3f layer
 * components inside `<SttCanvas>`. r3f owns the renderer + lifecycle; React
 * Suspense coordinates per-layer archive loading; mounting/unmounting a layer (a
 * stream toggle) adds/removes it from the scene with no manual bookkeeping.
 *
 * Parity notes vs the deck path:
 *   • LIDAR modes covered: surfel, worldbuild, scan, raw points, splat. The
 *     density `iso`/`iso3d` line modes are deck-only for now.
 *   • Click-to-inspect (ObjectInspector) is not yet wired on the Three path.
 */

import React, { useCallback, useMemo } from "react";
import type { TimeController } from "@poopdeck.gl/playback";
import type { RGBA } from "@poopdeck.gl/three";
import {
  SttCanvas,
  SttSurfelLayer,
  SttPointCloudLayer,
  SttBoundingBoxLayer,
  SttMapPolygonLayer,
  SttMapLineLayer,
  SttEgoLayer,
} from "@poopdeck.gl/three/r3f";
import type { Dataset } from "../../types";
import type { AvStreamKey } from "./sceneTypes";

export interface AvThreeViewerProps {
  dataset: Dataset;
  timeController: TimeController;
  visibleStreams: Set<AvStreamKey>;
  egoFollow: boolean;
  topDown: boolean;
  perfMode?: boolean;
  /** Pin the WebGL2 backend (no WebGPU). */
  forceWebGL?: boolean;
}

const RGB_COLUMNS: [string, string, string] = ["r", "g", "b"];

/** The LIDAR layer element for the dataset's render mode (mirrors buildDemoLayers `case 'av'`). */
function renderLidar(dataset: Dataset): React.ReactNode {
  const url = dataset.avLidarUrl;
  if (!url) return null;
  const rgb = dataset.lidarRgb ? RGB_COLUMNS : null;
  const opacity = dataset.opacity ?? 1;

  if (dataset.lidarWorldbuild) {
    return (
      <SttSurfelLayer
        url={url}
        id={dataset.id}
        rgbColumns={rgb ?? RGB_COLUMNS}
        cumulative
        temporalSigma={dataset.lidarSurfelTemporalSigma ?? 1e9}
        temporalSigmaDynamic={dataset.lidarWorldbuildDynamicSigma ?? 200}
        revealFade={dataset.lidarWorldbuildRevealFade ?? 0}
        sizeScale={dataset.lidarSurfelSizeScale ?? 1}
        opacity={opacity}
      />
    );
  }
  if (dataset.lidarSurfel) {
    return (
      <SttSurfelLayer
        url={url}
        id={dataset.id}
        rgbColumns={rgb ?? RGB_COLUMNS}
        temporalSigma={dataset.lidarSurfelTemporalSigma ?? 180}
        sizeScale={dataset.lidarSurfelSizeScale ?? 1}
        opacity={opacity}
      />
    );
  }
  if (dataset.lidarIso) {
    // Density iso-line modes are deck-only for now.
    return null;
  }

  const timeWindow = dataset.timeWindow ?? 1000;
  if (dataset.lidarScan) {
    return (
      <SttPointCloudLayer
        url={url}
        id={dataset.id}
        mode="wake"
        wakeLength={60}
        wakeTailScale={0.1}
        rgbColumns={rgb ?? RGB_COLUMNS}
        pointSize={0.09}
        opacity={opacity}
      />
    );
  }
  return (
    <SttPointCloudLayer
      url={url}
      id={dataset.id}
      mode="window"
      splat={dataset.lidarSplat ?? false}
      colorProperty={dataset.colorProperty ?? "height_band"}
      colorMapping={dataset.lidarColorMapping as Record<string, RGBA> | undefined}
      colorMappingDefault={dataset.lidarColorMappingDefault as RGBA | undefined}
      rgbColumns={rgb}
      elevationScale={dataset.elevationScale ?? 1}
      windowHalf={timeWindow / 2}
      fadeIn={Math.round(timeWindow * 0.25)}
      fadeOut={Math.round(timeWindow * 0.25)}
      pointSize={0.08}
      opacity={dataset.opacity ?? 0.95}
    />
  );
}

const AvThreeViewer: React.FC<AvThreeViewerProps> = ({
  dataset,
  timeController,
  visibleStreams,
  egoFollow,
  topDown,
  forceWebGL,
}) => {
  const getTime = useCallback(() => timeController.getTime(), [timeController]);
  const anchor = useMemo(
    () => ({
      longitude: dataset.initialViewState.longitude,
      latitude: dataset.initialViewState.latitude,
    }),
    [dataset.initialViewState.longitude, dataset.initialViewState.latitude],
  );

  return (
    <SttCanvas
      // Remount the whole scene (incl. the WebGPU context) only on a dataset
      // change; stream toggles just mount/unmount layer children.
      key={dataset.id}
      anchor={anchor}
      timeOrigin={dataset.timeRange.start}
      getTime={getTime}
      followEgo={egoFollow}
      topDown={topDown}
      forceWebGL={forceWebGL}
      headingDeg={dataset.initialViewState.bearing ?? 20}
    >
      {visibleStreams.has("lidar") && renderLidar(dataset)}

      {visibleStreams.has("map") && dataset.avMapPolyUrl && (
        <SttMapPolygonLayer
          url={dataset.avMapPolyUrl}
          id={`${dataset.id}-map-poly`}
          colorMapping={dataset.mapColors as Record<string, RGBA> | undefined}
        />
      )}
      {visibleStreams.has("map") && dataset.avMapLineUrl && (
        <SttMapLineLayer
          url={dataset.avMapLineUrl}
          id={`${dataset.id}-map-line`}
          colorMapping={dataset.mapColors as Record<string, RGBA> | undefined}
        />
      )}

      {visibleStreams.has("objects") && dataset.avObjectsUrl && (
        <SttBoundingBoxLayer
          url={dataset.avObjectsUrl}
          id={`${dataset.id}-objects`}
          colorProperty="category"
          colorMapping={dataset.avObjectColors as Record<string, RGBA> | undefined}
          colorMappingDefault={dataset.colorMappingDefault as RGBA | undefined}
          showVelocity
        />
      )}

      {visibleStreams.has("ego") && dataset.avEgoUrl && (
        <SttEgoLayer url={dataset.avEgoUrl} id={`${dataset.id}-ego`} />
      )}
    </SttCanvas>
  );
};

export default AvThreeViewer;
