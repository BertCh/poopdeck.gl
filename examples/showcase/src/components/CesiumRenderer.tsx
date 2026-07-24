// Cesium renderer for the showcase — mounts a CesiumJS globe and streams an
// STT dataset through @poopdeck.gl/cesium's layer catalog (point / path /
// trips / tripHeads / arc via buildCesiumLayer). Reachable at
// /cesium/:datasetId.
//
// Perf design (parity with the deck backend, which draws a flat MapView):
//  1. Scene strip — a default Viewer runs a CONTINUOUS render loop redrawing the
//     whole lit globe + atmosphere + skybox every vsync. We set
//     requestRenderMode:true (render on demand → zero idle renders when paused),
//     drop 4× MSAA, and strip the sky/atmosphere/sun passes. The blue globe stays.
//  2. Cesium-time hook — the playhead is applied on every DRAWN frame via
//     scene.preRender (attachCesiumClock), off React's 20 Hz UI clock, and the
//     clock pumps scene.requestRender() so requestRenderMode still animates while
//     playing. requestRenderMode + that pump are an ATOMIC pair.
//  3. Streaming — SpatiotemporalTileset loads only the tiles in the camera
//     frustum at the view zoom, so N tracks the viewport, not the whole dataset.
//
// Cesium's static assets load from the CDN via CESIUM_BASE_URL. CesiumJS is
// Apache-2.0 (no ion token). Browser-verify only (needs a live WebGL Scene).

import { useEffect, useRef } from 'react';
import { Viewer, Rectangle, Ellipsoid, Math as CesiumMath } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  STTArchive,
  SpatiotemporalTileset,
  type BoundingBox,
} from '@poopdeck.gl/core';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';
import {
  applyViewStateToCamera,
  cesiumViewToViewState,
  attachCesiumClock,
} from '@poopdeck.gl/cesium';
import type { TimeController } from '@poopdeck.gl/playback';
import { buildCesiumLayer, cesiumLoaderTimeWindow } from './buildCesiumLayer';
import type { Dataset } from '../types';

// Set before any Viewer is created; runs when this lazily-loaded module imports.
if (typeof window !== 'undefined') {
  const w = window as unknown as { CESIUM_BASE_URL?: string };
  w.CESIUM_BASE_URL ??=
    'https://cdn.jsdelivr.net/npm/cesium@1.142.0/Build/Cesium/';
}

export interface CesiumRendererProps {
  dataset: Dataset;
  /**
   * Governor-owned playback clock. READ every rendered frame via scene.preRender
   * and applied to the layer; never advanced here (the controller self-drives).
   */
  timeController: TimeController;
}

export default function CesiumRenderer({
  dataset,
  timeController,
}: CesiumRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Build the viewer + layer + streaming tileset once per dataset. timeController
  // identity is stable for the page's life (usePlayback holds it in useState).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const viewer = new Viewer(el, {
      // Plain WGS84 globe, no Cesium ion imagery/terrain (no token needed).
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      // --- perf, look-preserving ---
      requestRenderMode: true, // render only on demand — the clock hook drives it (atomic pair)
      maximumRenderTimeChange: Infinity, // never self-render from clock time changes; we own every render
      msaaSamples: 1, // drop 4× MSAA resolve
      // --- perf, CHANGES THE LOOK (browser-verify): no starfield, no atmosphere limb halo ---
      skyBox: false,
      skyAtmosphere: false,
    });
    const { scene } = viewer;
    viewer.clock.shouldAnimate = false; // Cesium's own clock must not compete with the STT governor

    // Strip remaining per-frame globe passes we don't need (KEEP the blue globe).
    scene.fog.enabled = false;
    scene.sunBloom = false;
    if (scene.sun) scene.sun.show = false; // skyBox:false already nulls sun/moon — guarded no-op
    if (scene.moon) scene.moon.show = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.maximumScreenSpaceError = 8; // fewer solid-colour ellipsoid tiles (no imagery to lose)
    scene.debugShowFramesPerSecond = new URLSearchParams(
      window.location.search,
    ).has('fps');

    const layer = buildCesiumLayer(scene, dataset);
    if (!layer) {
      // CesiumDemoPage gates on CESIUM_SUPPORTED_TYPES; this is the belt to
      // that suspender (a direct URL to an unsupported dataset type).
      console.error(
        '[CesiumRenderer] unsupported dataset type',
        dataset.type,
        dataset.id,
      );
      viewer.destroy();
      return;
    }
    // Trips need the trail behind the playhead resident (deck auto-widens too).
    const loaderTimeWindow = cesiumLoaderTimeWindow(dataset);
    // Default opts here → read the zoom back below with default opts too (round-trips).
    applyViewStateToCamera(viewer.camera, dataset.initialViewState);

    // ---- Streaming + time-hook shared state (closed over by the callbacks) ----
    let disposed = false;
    let tileset: SpatiotemporalTileset | null = null;
    let view: { bounds: BoundingBox; zoom: number } | null = null;
    const scratchRect = new Rectangle();
    const archive = new STTArchive({ url: dataset.url });
    let removeChanged = () => {};
    let removeMoveEnd = () => {};

    // Cesium-time hook: apply the playhead every drawn frame AND keep temporal
    // prefetch tracking it (reusing the cached camera view — no per-frame
    // computeViewRectangle). requestRender:true pumps the render loop while playing.
    const detachClock = attachCesiumClock(
      scene,
      timeController,
      (t) => {
        layer.setTime(t);
        if (tileset && view) {
          tileset.update(
            {
              bounds: view.bounds,
              zoom: view.zoom,
              time: t,
              timeWindow: loaderTimeWindow,
            },
            true,
          );
        }
      },
      { requestRender: true },
    );

    // Live camera → {bounds, zoom}. computeViewRectangle gives the true footprint
    // (radians); height→zoom reuses the pure cesiumViewToViewState math.
    const cameraToStreamView = (
      metaBounds: BoundingBox,
      minZoom: number,
      maxZoom: number,
    ): { bounds: BoundingBox; zoom: number } => {
      const cam = scene.camera;
      const rect = cam.computeViewRectangle(Ellipsoid.WGS84, scratchRect);
      const bounds: BoundingBox =
        // Global datasets (satellite tracks, ocean drifters) opt out of
        // viewport-clipped loading, same as the deck path (useGlobalBounds).
        !dataset.useGlobalBounds && rect && rect.east >= rect.west
          ? {
              minLon: CesiumMath.toDegrees(rect.west),
              minLat: CesiumMath.toDegrees(rect.south),
              maxLon: CesiumMath.toDegrees(rect.east),
              maxLat: CesiumMath.toDegrees(rect.north),
            }
          : metaBounds; // whole-globe view, antimeridian crossing, or global opt-out → full extent
      if (dataset.zoomOverride !== undefined)
        return { bounds, zoom: dataset.zoomOverride };
      const c = cam.positionCartographic;
      const { zoom } = cesiumViewToViewState({
        longitude: CesiumMath.toDegrees(c.longitude),
        latitude: CesiumMath.toDegrees(c.latitude),
        height: c.height,
        headingRad: cam.heading,
        pitchRad: cam.pitch,
        rollRad: cam.roll,
      });
      return {
        bounds,
        zoom: Math.min(maxZoom, Math.max(minZoom, Math.round(zoom))),
      };
    };

    void (async () => {
      try {
        const meta = await archive.getMetadata();
        if (disposed) return;

        // Tiles arrive after the synchronous update() returns — republish the
        // resident set (replace-all: timeOrigin is self-consistent per rebuild).
        const republish = () => {
          if (disposed || !tileset) return;
          layer.setTiles(tileset.getVisibleTiles());
          layer.setTime(timeController.getTime());
          scene.requestRender(); // requestRenderMode won't repaint new geometry on its own
        };

        tileset = new SpatiotemporalTileset({
          minZoom: meta.minZoom,
          maxZoom: meta.maxZoom,
          temporalBucketMs: meta.temporalBucketMs,
          refinementStrategy: 'best-available',
          enablePrefetch: true,
          ...makeTilesetCallbacks(archive),
          onTileLoad: republish,
          onTileUnload: republish,
        });

        const onSettle = () => {
          if (disposed || !tileset) return;
          view = cameraToStreamView(meta.bounds, meta.minZoom, meta.maxZoom);
          tileset.update(
            {
              bounds: view.bounds,
              zoom: view.zoom,
              time: timeController.getTime(),
              timeWindow: loaderTimeWindow,
            },
            false, // debounced viewport change
          );
        };

        // Cesium raises `changed` after ≥percentageChanged movement; `moveEnd` on stop.
        scene.camera.percentageChanged = 0.1;
        removeChanged = scene.camera.changed.addEventListener(onSettle);
        removeMoveEnd = scene.camera.moveEnd.addEventListener(onSettle);

        // Seed the initial (already-framed) viewport.
        view = cameraToStreamView(meta.bounds, meta.minZoom, meta.maxZoom);
        tileset.update(
          {
            bounds: view.bounds,
            zoom: view.zoom,
            time: timeController.getTime(),
            timeWindow: loaderTimeWindow,
          },
          true,
        );
      } catch (err) {
        console.error('[CesiumRenderer] failed to load', dataset.id, err);
      }
    })();

    return () => {
      disposed = true;
      removeChanged();
      removeMoveEnd();
      detachClock();
      const ts = tileset;
      tileset = null;
      ts?.clear(); // aborts in-flight fetches; fires onTileUnload (guarded by `disposed`)
      layer.dispose();
      viewer.destroy();
      archive.finalize();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
