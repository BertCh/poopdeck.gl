// @poopdeck.gl/showcase
// SPDX-License-Identifier: MIT

/**
 * AvThreeViewer — the AV cockpit map viewport rendered by the Three.js + TSL
 * (WebGPU) engine via its react-three-fiber binding (`@poopdeck.gl/three/r3f`).
 * A drop-in alternative to {@link AvDeck}: same resolved Dataset av fields +
 * palettes + the same shared `TimeController`, composed declaratively as r3f layer
 * components inside `<STTCanvas>`. r3f owns the renderer + lifecycle; React
 * Suspense coordinates per-layer archive loading; mounting/unmounting a layer (a
 * stream toggle) adds/removes it from the scene with no manual bookkeeping.
 *
 * Parity notes vs the deck path:
 *   • LIDAR modes covered: surfel, worldbuild, scan, raw points, splat, the
 *     density `iso`/`iso3d` contour-line modes, scene-split `stage`, and the
 *     additive-octree zoom-`lod` union.
 *   • Each layer registers a governor source (via `registry`) under the same id
 *     the deck path uses, so the shared playback clock gates correctly and the
 *     cockpit transport (buffered bar / Auto-speed) reflects this renderer.
 *   • Click-to-inspect (ObjectInspector) is wired (`onPick`).
 *   • NOT covered: street basemap (geo scenes float on the dark backdrop), the
 *     Spacetime `cube` mode (no trips-layer port yet).
 */

import React, { useCallback, useMemo } from 'react';
import type { TimeController } from '@poopdeck.gl/playback';
import type { RGBA, STTPickInfo, STTSourceRegistry } from '@poopdeck.gl/three';
import {
  STTCanvas,
  STTSurfelLayer,
  STTPointLayer,
  STTBoundingBoxLayer,
  STTMapPolygonLayer,
  STTMapLineLayer,
  STTEgoLayer,
  STTIsoLayer,
} from '@poopdeck.gl/three/r3f';
import type { AvDataset } from '../../types';
import type { AvStreamKey } from './sceneTypes';
import type { PickedObject } from './ObjectInspector';

export interface AvThreeViewerProps {
  dataset: AvDataset;
  timeController: TimeController;
  /** Authoritative scene time range (epoch-ms) — drives the time origin + the
   *  governor's buffered span. Falls back to the dataset's placeholder. */
  timeRange?: { start: number; end: number };
  /** Playback governor source registry (so the Three path gates the clock too). */
  registry?: STTSourceRegistry;
  visibleStreams: Set<AvStreamKey>;
  egoFollow: boolean;
  topDown: boolean;
  /** Fill-rate performance mode: 1× device pixels + cheaper LIDAR fragments. */
  perfMode?: boolean;
  /** `prefers-reduced-motion`: snap the camera (no easing/damping). */
  reducedMotion?: boolean;
  /** scene.json `initialView` — authoritative anchor/bearing once the scene loads. */
  sceneView?: {
    longitude?: number;
    latitude?: number;
    zoom?: number;
    pitch?: number;
    bearing?: number;
  } | null;
  /** Pin the WebGL2 backend (no WebGPU). */
  forceWebGL?: boolean;
  /** Click-to-inspect: surface the picked object/ego to the cockpit inspector. */
  onSelectObject?: (object: PickedObject | null) => void;
}

const RGB_COLUMNS: [string, string, string] = ['r', 'g', 'b'];

/** The LIDAR layer element(s) for the dataset's render mode (mirrors buildDemoLayers `case 'av'`). */
function renderLidar(dataset: AvDataset, perfMode: boolean): React.ReactNode {
  const rgb = dataset.lidarRgb ? RGB_COLUMNS : null;
  const opacity = dataset.opacity ?? 1;
  // Perf mode: discard faint disk/splat rims sooner so the heavy cloud writes far
  // fewer blended fragments (overdraw is the cost). Mirrors deck's alphaCutoff.
  const surfelCutoff = perfMode ? 0.2 : undefined;

  // SCENE-SPLIT "stage + actors": TWO surfel archives → TWO layers. The STATIC
  // stage (avStaticUrl) is an OPTIONAL governor source painted under at an
  // effectively-infinite temporalSigma (a timeless backdrop, muted); the DYNAMIC
  // actors (avDynamicUrl) are the REQUIRED animated stream painted over, bright.
  // Mirrors buildDemoLayers.ts stage branch.
  if (dataset.lidarStage && dataset.avStaticUrl && dataset.avDynamicUrl) {
    const stageStatic = dataset.lidarStageStatic ?? true;
    const stageSigma = stageStatic
      ? 1e9
      : (dataset.lidarSurfelTemporalSigma ?? 1800);
    const actorSigma = dataset.lidarSurfelTemporalSigma ?? 200;
    return (
      <>
        <STTSurfelLayer
          url={dataset.avStaticUrl}
          id={`${dataset.id}-stage`}
          sourceRequired={false}
          rgbColumns={rgb ?? RGB_COLUMNS}
          temporalSigma={stageSigma}
          temporalSigmaDynamic={stageSigma}
          sizeScale={dataset.lidarSurfelSizeScale ?? 1}
          opacity={dataset.lidarStageOpacity ?? 0.42}
          alphaCutoff={perfMode ? 0.2 : undefined}
        />
        <STTSurfelLayer
          url={dataset.avDynamicUrl}
          id={dataset.id}
          rgbColumns={rgb ?? RGB_COLUMNS}
          temporalSigma={actorSigma}
          temporalSigmaDynamic={
            dataset.lidarWorldbuildDynamicSigma ?? actorSigma
          }
          sizeScale={dataset.lidarActorSizeScale ?? 1.8}
          opacity={opacity}
          alphaCutoff={perfMode ? 0.2 : 0.1}
        />
      </>
    );
  }

  const url = dataset.avLidarUrl;
  if (!url) return null;

  if (dataset.lidarWorldbuild) {
    return (
      <STTSurfelLayer
        url={url}
        id={dataset.id}
        rgbColumns={rgb ?? RGB_COLUMNS}
        cumulative
        temporalSigma={dataset.lidarSurfelTemporalSigma ?? 1e9}
        temporalSigmaDynamic={dataset.lidarWorldbuildDynamicSigma ?? 200}
        revealFade={dataset.lidarWorldbuildRevealFade ?? 0}
        sizeScale={dataset.lidarSurfelSizeScale ?? 1}
        opacity={opacity}
        alphaCutoff={surfelCutoff}
      />
    );
  }
  if (dataset.lidarSurfel) {
    return (
      <STTSurfelLayer
        url={url}
        id={dataset.id}
        rgbColumns={rgb ?? RGB_COLUMNS}
        temporalSigma={dataset.lidarSurfelTemporalSigma ?? 180}
        sizeScale={dataset.lidarSurfelSizeScale ?? 1}
        opacity={opacity}
        alphaCutoff={surfelCutoff}
      />
    );
  }
  if (dataset.lidarIso) {
    // Density iso-lines: windowed contour LineStrings colored by the categorical
    // `density_band` ramp; iso3d lifts each ring to its real altitude (`z_layer`).
    // Mirrors the deck `AnimatedPathLayer` branch in buildDemoLayers.
    const iso3d = dataset.lidarIso3d ?? false;
    const isoWindow = dataset.timeWindow ?? 260;
    return (
      <STTIsoLayer
        url={url}
        id={dataset.id}
        colorProperty={dataset.colorProperty ?? 'density_band'}
        colorMapping={
          dataset.lidarColorMapping as Record<string, RGBA> | undefined
        }
        colorMappingDefault={
          dataset.lidarColorMappingDefault as RGBA | undefined
        }
        elevationProperty={iso3d ? 'z_layer' : null}
        elevationScale={iso3d ? (dataset.lidarIsoElevationScale ?? 1) : 1}
        windowHalf={isoWindow / 2}
        fadeIn={Math.round(isoWindow * 0.25)}
        fadeOut={Math.round(isoWindow * 0.25)}
        opacity={dataset.opacity ?? 0.95}
      />
    );
  }

  const timeWindow = dataset.timeWindow ?? 1000;
  if (dataset.lidarScan) {
    return (
      <STTPointLayer
        url={url}
        id={dataset.id}
        mode="wake"
        wakeLength={60}
        wakeTailScale={0.1}
        rgbColumns={rgb ?? RGB_COLUMNS}
        pointSize={0.09}
        opacity={opacity}
        alphaCutoff={perfMode ? 0.1 : undefined}
      />
    );
  }
  return (
    <STTPointLayer
      url={url}
      id={dataset.id}
      // Additive-octree zoom LOD: load the UNION of all zoom levels (each return
      // lives at one home zoom), not just maxZoom — else the cloud is sparse.
      lodMode={dataset.lidarLod ? 'additive' : undefined}
      mode="window"
      splat={dataset.lidarSplat ?? false}
      colorProperty={dataset.colorProperty ?? 'height_band'}
      colorMapping={
        dataset.lidarColorMapping as Record<string, RGBA> | undefined
      }
      colorMappingDefault={dataset.lidarColorMappingDefault as RGBA | undefined}
      rgbColumns={rgb}
      elevationScale={dataset.elevationScale ?? 1}
      windowHalf={timeWindow / 2}
      fadeIn={Math.round(timeWindow * 0.25)}
      fadeOut={Math.round(timeWindow * 0.25)}
      pointSize={0.08}
      opacity={dataset.opacity ?? 0.95}
      // Raw/splat dots: in perf mode raise the cutoff so faint splat rims are
      // discarded earlier (fewer blended fragments on the densest clouds).
      alphaCutoff={perfMode ? (dataset.lidarSplat ? 0.2 : 0.1) : undefined}
    />
  );
}

const AvThreeViewer: React.FC<AvThreeViewerProps> = ({
  dataset,
  timeController,
  timeRange,
  registry,
  visibleStreams,
  egoFollow,
  topDown,
  perfMode = false,
  reducedMotion = false,
  sceneView,
  forceWebGL,
  onSelectObject,
}) => {
  const getTime = useCallback(() => timeController.getTime(), [timeController]);
  const handlePick = useCallback(
    (info: STTPickInfo | null) => {
      if (!onSelectObject) return;
      // `STTPickInfo` is now a discriminated union (`STTBoxPickInfo` |
      // `STTPointPickInfo`); the cockpit inspector only surfaces object/ego BOXES,
      // so narrow on `kind` before reading the box-only fields. A point-cloud hit
      // (or a miss) clears the selection.
      if (info && (info.kind === 'object' || info.kind === 'ego')) {
        onSelectObject({
          category: info.category,
          track_id: info.trackId,
          speed: info.speed,
          length: info.length,
          width: info.width,
          height: info.height,
          heading: info.heading,
        });
      } else {
        onSelectObject(null);
      }
    },
    [onSelectObject],
  );
  // Anchor + heading prefer scene.json's authoritative `initialView` (always in
  // sync with the bundle georef) over the hardcoded dataset fallback, so a
  // re-georef never parks the local frame over the old/empty location.
  const anchor = useMemo(
    () => ({
      longitude: sceneView?.longitude ?? dataset.initialViewState.longitude,
      latitude: sceneView?.latitude ?? dataset.initialViewState.latitude,
    }),
    [
      sceneView?.longitude,
      sceneView?.latitude,
      dataset.initialViewState.longitude,
      dataset.initialViewState.latitude,
    ],
  );
  const headingDeg =
    sceneView?.bearing ?? dataset.initialViewState.bearing ?? 20;
  // Authoritative origin = the range the shared clock actually spans (scene.json),
  // not the dataset placeholder — keeps the f32 rebasing consistent with getTime().
  const timeOrigin = (timeRange ?? dataset.timeRange).start;

  return (
    <STTCanvas
      // Remount the whole scene (incl. the WebGPU context) only on a dataset
      // change; stream toggles just mount/unmount layer children.
      key={dataset.id}
      anchor={anchor}
      timeOrigin={timeOrigin}
      timeRange={timeRange ?? dataset.timeRange}
      registry={registry}
      getTime={getTime}
      followEgo={egoFollow}
      topDown={topDown}
      forceWebGL={forceWebGL}
      headingDeg={headingDeg}
      pixelRatio={perfMode ? 1 : undefined}
      reducedMotion={reducedMotion}
      onPick={handlePick}
    >
      {visibleStreams.has('lidar') && renderLidar(dataset, perfMode)}

      {visibleStreams.has('map') && dataset.avMapPolyUrl && (
        <STTMapPolygonLayer
          url={dataset.avMapPolyUrl}
          id={`${dataset.id}-map-poly`}
          colorMapping={dataset.mapColors as Record<string, RGBA> | undefined}
        />
      )}
      {visibleStreams.has('map') && dataset.avMapLineUrl && (
        <STTMapLineLayer
          url={dataset.avMapLineUrl}
          id={`${dataset.id}-map-line`}
          colorMapping={dataset.mapColors as Record<string, RGBA> | undefined}
        />
      )}

      {visibleStreams.has('objects') && dataset.avObjectsUrl && (
        <STTBoundingBoxLayer
          url={dataset.avObjectsUrl}
          id={`${dataset.id}-objects`}
          colorProperty="category"
          colorMapping={
            dataset.avObjectColors as Record<string, RGBA> | undefined
          }
          colorMappingDefault={dataset.colorMappingDefault as RGBA | undefined}
          showVelocity
        />
      )}

      {visibleStreams.has('ego') && dataset.avEgoUrl && (
        <STTEgoLayer url={dataset.avEgoUrl} id={`${dataset.id}-ego`} />
      )}
    </STTCanvas>
  );
};

export default AvThreeViewer;
