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
//  3. Streaming — SpatioTemporalTileset loads only the tiles in the camera
//     frustum at the view zoom, so N tracks the viewport, not the whole dataset.
//  4. Republish coalescing — setTiles is a replace-all rebuild, and the tileset
//     fires one load callback per tile, so publishing per callback costs
//     O(features × tiles) of synchronous main-thread work per burst. Callbacks
//     arm; the rebuild happens once per drawn frame, and only when the visible
//     tile-key set actually changed.
//
// Cesium's static assets load from the CDN via CESIUM_BASE_URL. CesiumJS is
// Apache-2.0 (no ion token). Browser-verify only (needs a live WebGL Scene).

import { useEffect, useRef } from 'react';
import { Viewer, Rectangle, Ellipsoid, Math as CesiumMath } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  STTArchive,
  SpatioTemporalTileset,
  type BoundingBox,
} from '@poopdeck.gl/core';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';
import {
  applyViewStateToCamera,
  resolveCesiumStreamView,
  verticalFovRadians,
  TilePublishGate,
  attachCesiumClock,
  type CesiumViewOptions,
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

    // The REAL canvas height and the REAL vertical fov, read fresh each time —
    // the pair that turns a camera altitude into a zoom. Hard-coding 800 px and
    // treating Cesium's 60° `fov` as vertical costs ~1.0–1.3 zoom levels of
    // detail on a wide canvas (`fov` is the HORIZONTAL angle in landscape). Both
    // the framing below and the zoom read back from it use this, so the two stay
    // each other's inverse.
    const viewOptions = (): CesiumViewOptions => {
      const { canvas } = scene;
      const height = canvas.clientHeight || canvas.height;
      const width = canvas.clientWidth || canvas.width;
      return {
        viewportHeight: height > 0 ? height : undefined,
        fovRadians: verticalFovRadians(
          scene.camera.frustum as { fovy?: number; fov?: number },
          height > 0 ? width / height : undefined,
        ),
      };
    };
    applyViewStateToCamera(
      viewer.camera,
      dataset.initialViewState,
      viewOptions(),
    );

    // ---- Streaming + time-hook shared state (closed over by the callbacks) ----
    let disposed = false;
    let tileset: SpatioTemporalTileset | null = null;
    let view: { bounds: BoundingBox; zoom: number } | null = null;
    const scratchRect = new Rectangle();
    const archive = new STTArchive({ url: dataset.url });
    let removeChanged = () => {};
    let removeMoveEnd = () => {};
    let removePreRender = () => {};

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

    // Live camera → {bounds, zoom}, or null when the camera produced nothing
    // trustworthy — in which case the caller KEEPS the previous viewport
    // (docs/roadmap/tile-loading-3d-2026-07.md §4.1 rule 1). Everything
    // arithmetic lives in the pure, unit-tested resolveCesiumStreamView: the
    // Rectangle.MAX_VALUE rejection, the `west > east` seam encoding that must
    // NOT collapse to the archive's full extent, the normalizeViewportBounds
    // routing, and the floored zoom.
    const cameraToStreamView = (
      metaBounds: BoundingBox,
      minZoom: number,
      maxZoom: number,
    ): { bounds: BoundingBox; zoom: number } | null => {
      const cam = scene.camera;
      const c = cam.positionCartographic;
      return resolveCesiumStreamView({
        rect: cam.computeViewRectangle(Ellipsoid.WGS84, scratchRect),
        camera: {
          longitude: CesiumMath.toDegrees(c.longitude),
          latitude: CesiumMath.toDegrees(c.latitude),
          // An ALTITUDE, not a distance to the screen-centre ground point;
          // cesiumViewToViewState applies the tilt correction.
          height: c.height,
          headingRad: cam.heading,
          pitchRad: cam.pitch,
          rollRad: cam.roll,
        },
        archiveBounds: metaBounds,
        minZoom,
        maxZoom,
        // Global datasets (satellite tracks, ocean drifters) opt out of
        // viewport-clipped loading, same as the deck path (useGlobalBounds).
        useGlobalBounds: dataset.useGlobalBounds,
        zoomOverride: dataset.zoomOverride,
        view: viewOptions(),
      });
    };

    void (async () => {
      try {
        const meta = await archive.getMetadata();
        if (disposed) return;

        // Tiles arrive after the synchronous update() returns, ONE CALLBACK PER
        // TILE — and every Cesium layer's setTiles is a replace-all that rebuilds
        // one primitive per feature across the whole resident set, synchronously.
        // Rebuilding on each arrival is therefore O(features × tiles) of main-
        // thread work for a burst that only needed the last rebuild. So the
        // callbacks merely ARM a republish and the rebuild happens once on the
        // next drawn frame, and only when the visible key set actually changed
        // (TilePublishGate — which also refuses an empty set, so a momentary gap
        // in selection never blanks the layer).
        let republishArmed = false;
        const publishGate = new TilePublishGate();
        const flushRepublish = () => {
          if (!republishArmed) return;
          republishArmed = false;
          if (disposed || !tileset) return;
          const tiles = tileset.getVisibleTiles();
          if (!publishGate.offer(tiles).publish) return;
          layer.setTiles(tiles);
          layer.setTime(timeController.getTime());
          // One more frame. The batched-polyline layers cannot write an alpha
          // until the new Primitive has rendered once (the batch table behind
          // getGeometryInstanceAttributes only exists then), so under
          // requestRenderMode with a paused playhead the lines would otherwise
          // sit at their seeded alpha 0 — invisible — until the next interaction.
          scene.requestRender();
        };
        const republish = () => {
          if (disposed || republishArmed) return;
          republishArmed = true;
          scene.requestRender(); // requestRenderMode won't repaint new geometry — nor run preRender — on its own
        };
        removePreRender = scene.preRender.addEventListener(flushRepublish);

        tileset = new SpatioTemporalTileset({
          minZoom: meta.minZoom,
          maxZoom: meta.maxZoom,
          temporalBucketMs: meta.temporalBucketMs,
          refinementStrategy: 'best-available',
          enablePrefetch: true,
          ...makeTilesetCallbacks(archive),
          onTileLoad: republish,
          onTileUnload: republish,
        });

        const applyView = (
          next: { bounds: BoundingBox; zoom: number } | null,
          immediate: boolean,
        ) => {
          // A null resolve means the camera produced a box tile selection must
          // not trust (§4.1 rule 1): keep the previous viewport rather than
          // select against garbage. On the very first call there is no previous
          // one, so there is simply nothing to select yet — the next camera
          // event retries.
          if (next) view = next;
          if (!tileset || !view) return;
          tileset.update(
            {
              bounds: view.bounds,
              zoom: view.zoom,
              time: timeController.getTime(),
              timeWindow: loaderTimeWindow,
            },
            immediate,
          );
          // Arm a republish on the VIEWPORT edge too, not only on tile
          // load/unload. `TilePublishGate` refuses an empty set for a bounded
          // hold and then lets it through — but it only ever sees a set when
          // `flushRepublish` runs, and that is gated on `republishArmed`. Pan a
          // land dataset out over open ocean and nothing loads and nothing is
          // evicted, so neither callback fires, the gate is never offered the
          // empty set, its hold never expires, and the last tiles stay painted
          // over water indefinitely. Arming here costs one gate comparison per
          // camera settle and makes the hold actually bounded in practice.
          republish();
        };

        const onSettle = () => {
          if (disposed || !tileset) return;
          applyView(
            cameraToStreamView(meta.bounds, meta.minZoom, meta.maxZoom),
            false, // debounced viewport change
          );
        };

        // Cesium raises `changed` after ≥percentageChanged movement; `moveEnd` on stop.
        scene.camera.percentageChanged = 0.1;
        removeChanged = scene.camera.changed.addEventListener(onSettle);
        removeMoveEnd = scene.camera.moveEnd.addEventListener(onSettle);

        // Seed the initial (already-framed) viewport.
        applyView(
          cameraToStreamView(meta.bounds, meta.minZoom, meta.maxZoom),
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
      removePreRender();
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
