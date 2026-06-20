/**
 * The AV cockpit's DeckGL surface — a dark, tilted Mercator map that overlays
 * the scene's STT layer tree (LIDAR cloud → ego trail → object boxes) built by
 * the shared {@link buildDemoLayers} `case 'av'`, so the cockpit and the
 * standard DemoPage can't drift.
 *
 * Stream visibility: the parent owns a `visibleStreams` set; we omit a layer
 * whose stream is toggled off by filtering the built layer list on its id
 * suffix (`-ego` / `-objects`; the primary LIDAR layer carries the bare
 * dataset id). Omitting a layer drops both its draw and its tile fetches, and a
 * reconciliation effect unregisters the hidden stream's governor source so it
 * stops counting toward the playback gate (otherwise toggling off the required
 * LIDAR would leave the clock waiting on a frozen source).
 *
 * Camera: an optional ego-follow mode glides the map to keep the live ego
 * position centred (honored only when motion is allowed); a perspective⇄
 * top-down pitch toggle morphs the camera between an over-the-shoulder tilt and
 * a plan view. Both drive a controlled `viewState` so deck and the basemap stay
 * in sync. The follow easing is a single rAF loop with time-based smoothing —
 * see {@link followCamera} for why (and how it's configured).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { Map } from "react-map-gl";
import type { TimeController } from "@poopdeck.gl/playback";
import type { SourceRegistry } from "@poopdeck.gl/react";
import { buildDemoLayers } from "../demo/buildDemoLayers";
import {
  buildEgoFootprintLayer,
  buildEgoPathLayer,
  type EgoPathPoint,
} from "./egoLayers";
import {
  DEFAULT_FOLLOW_CONFIG,
  desiredCameraAt,
  expAlpha,
  shortestAngleDelta,
  smoothAngle,
  type FollowCameraConfig,
} from "./followCamera";
import type { PickedObject } from "./ObjectInspector";
import type { Dataset } from "../../types";
import type { AvStreamKey } from "./sceneTypes";

const MAPBOX_ACCESS_TOKEN =
  (import.meta as any).env?.VITE_MAPBOX_TOKEN ||
  "pk.eyJ1IjoicmdjZ2VvZyIsImEiOiJjajBuNG1sMjUwMDFlMzNxcWY0M2RqMHI3In0.XfM0BMSqZqjRDcz-oJuadw";

export interface AvDeckProps {
  dataset: Dataset;
  timeController: TimeController;
  /** Streams currently shown; a layer is omitted when its stream is off. */
  visibleStreams: Set<AvStreamKey>;
  /**
   * Multi-source governor registration (Phase 0): each present stream registers
   * as a classified source — the primary LIDAR (or ego on LIDAR-less scenes) is
   * required; the other streams are optional.
   */
  registry: SourceRegistry;
  /** Ego-follow camera toggle (snaps instead of easing under reduced motion). */
  egoFollow: boolean;
  /**
   * Follow-camera tuning (smoothing time constants, chase-cam rotation, held
   * zoom, look-ahead). Omit for {@link DEFAULT_FOLLOW_CONFIG}; pass a *stable*
   * (memoized) object if overriding, since it keys the follow effect.
   */
  followConfig?: FollowCameraConfig;
  /** true = top-down plan view; false = over-the-shoulder perspective. */
  topDown: boolean;
  reducedMotion: boolean;
  /** Lightweight ego polyline (`scene.streams.ego.path`) → ego car + path-prediction ribbon. */
  egoPath?: EgoPathPoint[] | null;
  /**
   * `scene.json`'s `initialView` — the AUTHORITATIVE camera framing, always in sync
   * with the bundle's tile georef. Preferred over `dataset.initialViewState` (which
   * is only a hardcoded pre-load fallback) the moment the scene resolves, so a
   * re-georef never leaves the camera parked over the old/empty location.
   */
  sceneView?: {
    longitude?: number;
    latitude?: number;
    zoom?: number;
    pitch?: number;
    bearing?: number;
  } | null;
  /** Click-to-inspect: receives a picked tracked object's decoded props (null = cleared). */
  onSelectObject?: (object: PickedObject | null) => void;
  /**
   * Fill-rate performance mode. When on, the deck renders at 1× device pixels
   * (`useDevicePixels={false}` — the single biggest lever for a fill-bound point
   * cloud on a retina display) and {@link buildDemoLayers} renders the LIDAR
   * cloud cheaper (opaque/non-AA raw dots, higher surfel alpha cutoff). Lets the
   * densest "ultra" raw cloud stay smooth. @default false
   */
  perfMode?: boolean;
  /**
   * Show the street basemap under geo-registered scenes. Ignored for
   * `avLocalFrame` scenes (which never draw a basemap). Lets the cockpit drop
   * the basemap so a camera-colored cloud / surfel surface floats on the dark
   * backdrop. @default true
   */
  showBasemap?: boolean;
}

/** Which streams own which built layer (by the id suffix buildDemoLayers sets). */
function layerStream(layerId: string, datasetId: string): AvStreamKey {
  if (layerId === `${datasetId}-ego`) return "ego";
  if (layerId === `${datasetId}-objects`) return "objects";
  if (
    layerId === `${datasetId}-map-poly` ||
    layerId === `${datasetId}-map-line`
  )
    return "map";
  return "lidar"; // the primary layer carries the bare dataset id
}

/** Tile streams that register a governor source (telemetry/camera are sidecars). */
const GOVERNED_STREAMS: AvStreamKey[] = ["lidar", "ego", "objects", "map"];

/** Governor source id(s) a stream registers — the inverse of {@link layerStream}. */
function streamSourceIds(stream: AvStreamKey, datasetId: string): string[] {
  switch (stream) {
    case "ego":
      return [`${datasetId}-ego`];
    case "objects":
      return [`${datasetId}-objects`];
    case "map":
      return [`${datasetId}-map-poly`, `${datasetId}-map-line`];
    case "lidar":
      return [datasetId]; // primary layer carries the bare dataset id
    default:
      return []; // telemetry / camera are sidecar JSON, not governor sources
  }
}

const AvDeck: React.FC<AvDeckProps> = ({
  dataset,
  timeController,
  visibleStreams,
  registry,
  egoFollow,
  followConfig = DEFAULT_FOLLOW_CONFIG,
  topDown,
  reducedMotion,
  egoPath,
  sceneView,
  onSelectObject,
  perfMode = false,
  showBasemap = true,
}) => {
  // Controlled camera: seeded from the dataset, then driven by ego-follow and
  // the pitch toggle. The user can still drag/zoom (onViewStateChange).
  const [viewState, setViewState] = useState<any>(() => ({
    ...dataset.initialViewState,
    maxPitch: 75,
  }));
  const viewRef = useRef(viewState);
  viewRef.current = viewState;

  // Pitch toggle: morph between perspective (the dataset's initial pitch) and
  // a top-down plan view. Snaps under reduced motion, eases otherwise.
  const targetPitch = topDown ? 0 : dataset.initialViewState.pitch ?? 55;

  // Re-frame the camera on a scene switch. `viewState` is seeded ONCE by the
  // useState initializer above, so without this the camera stays parked over
  // the PREVIOUS scene's location when `dataset` changes — and the AV scenes
  // sit in different cities (Boston / Pittsburgh / SF / …), so the new cloud
  // renders far off-screen and the map reads as blank ("the viewport didn't
  // update"). Snap to the new scene's framing, keeping the active perspective⇄
  // top-down pitch (a switch made while top-down stays top-down); the easing /
  // ego-follow effects take over from there. Guarded by a ref so it fires only
  // on a real scene change, not the initial mount (already framed above).
  const framedSceneIdRef = useRef(dataset.id);
  useEffect(() => {
    if (framedSceneIdRef.current === dataset.id) return;
    framedSceneIdRef.current = dataset.id;
    setViewState({ ...dataset.initialViewState, pitch: targetPitch, maxPitch: 75 });
    // targetPitch is read fresh from this render's closure but is deliberately
    // NOT a dep — toggling top-down WITHIN a scene must not recenter the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  // scene.json's `initialView` is authoritative (always matches the bundle's tile
  // georef). The `[dataset]` effect + useState seed frame from the hardcoded
  // `dataset.initialViewState` fallback immediately; this snaps to the real
  // scene framing the moment scene.json resolves (or the scene switches), so the
  // camera can't drift from the data even if the hardcoded coords go stale. Pitch
  // still follows the perspective⇄top-down toggle.
  useEffect(() => {
    if (!sceneView) return;
    setViewState((vs: any) => ({ ...vs, ...sceneView, pitch: targetPitch, maxPitch: 75 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneView]);

  useEffect(() => {
    if (reducedMotion) {
      setViewState((vs: any) => ({ ...vs, pitch: targetPitch }));
      return;
    }
    let raf = 0;
    const step = () => {
      setViewState((vs: any) => {
        const next = vs.pitch + (targetPitch - vs.pitch) * 0.18;
        if (Math.abs(targetPitch - next) < 0.3) return { ...vs, pitch: targetPitch };
        raf = requestAnimationFrame(step);
        return { ...vs, pitch: next };
      });
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [targetPitch, reducedMotion]);

  // Ego-follow camera. A single rAF loop samples the desired camera straight
  // from the ego polyline at the controller's LIVE clock and eases toward it
  // with a *time-based* exponential filter (alpha = 1 - exp(-dt/tau)). Because
  // the easing is keyed off the real elapsed dt — not a per-React-render lerp —
  // the glide is smooth and stable regardless of tick cadence or frame rate
  // (the old per-tick `v += (t-v)*0.25` jittered with React's flush timing).
  // It writes only the followed channels (lon/lat, + bearing when
  // rotateToHeading, + zoom when configured) via a functional update, so it
  // composes with the pitch loop and leaves the user's other adjustments alone.
  useEffect(() => {
    if (!egoFollow || !egoPath || egoPath.length === 0) return;
    const cfg = followConfig;

    // Reduced motion: never animate. Snap the followed channels now and on each
    // clock tick; run no rAF loop.
    if (reducedMotion) {
      const snap = () => {
        const want = desiredCameraAt(egoPath, timeController.getTime(), cfg);
        if (!want) return;
        setViewState((vs: any) => ({
          ...vs,
          longitude: want.longitude,
          latitude: want.latitude,
          ...(want.bearing !== undefined ? { bearing: want.bearing } : null),
          ...(want.zoom !== undefined ? { zoom: want.zoom } : null),
        }));
      };
      snap();
      return timeController.on("tick", snap);
    }

    let raf = 0;
    let last = performance.now();
    let first = true; // first frame snaps, so enabling follow centres at once
    const step = () => {
      const now = performance.now();
      // Clamp dt so a backgrounded tab (or a stale `last`) can't snap-jump.
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const want = desiredCameraAt(egoPath, timeController.getTime(), cfg);
      if (want) {
        const aPos = first ? 1 : expAlpha(dt, cfg.positionTau);
        const aBear = first ? 1 : expAlpha(dt, cfg.bearingTau);
        const aZoom = first ? 1 : expAlpha(dt, cfg.zoomTau);
        first = false;
        setViewState((vs: any) => {
          const longitude = vs.longitude + (want.longitude - vs.longitude) * aPos;
          const latitude = vs.latitude + (want.latitude - vs.latitude) * aPos;
          const next: any = { ...vs, longitude, latitude };
          if (want.bearing !== undefined) {
            next.bearing = smoothAngle(vs.bearing ?? 0, want.bearing, aBear);
          }
          if (want.zoom !== undefined) {
            next.zoom = vs.zoom + (want.zoom - vs.zoom) * aZoom;
          }
          // Bail out of the re-render once converged AND the clock is static, so
          // a paused, settled follow doesn't churn React every frame. (The rAF
          // keeps running and resumes easing the moment the playhead moves.)
          const dBear =
            next.bearing !== undefined
              ? Math.abs(shortestAngleDelta(vs.bearing ?? 0, next.bearing))
              : 0;
          const dZoom = next.zoom !== undefined ? Math.abs(next.zoom - vs.zoom) : 0;
          if (
            Math.abs(longitude - vs.longitude) < 1e-7 &&
            Math.abs(latitude - vs.latitude) < 1e-7 &&
            dBear < 1e-3 &&
            dZoom < 1e-4
          ) {
            return vs;
          }
          return next;
        });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [egoFollow, egoPath, followConfig, reducedMotion, timeController]);

  const tileLayers = useMemo(() => {
    const all = buildDemoLayers({
      dataset,
      timeController,
      useGlobe: false,
      timeHeightScale: 0,
      plumbing: { registry },
      perfMode,
    });
    // Honor the stream toggles: drop any layer whose owning stream is hidden.
    return all.filter((l: any) =>
      visibleStreams.has(layerStream(l.id, dataset.id)),
    );
  }, [dataset, timeController, registry, visibleStreams, perfMode]);

  // Lifecycle reconciliation. A layer filtered out above is unmounted by deck,
  // but the governor source it registered (via onTilesetReady while it was
  // visible) is NOT torn down on its own. Unregister every hidden stream's
  // source(s) so a toggled-off stream stops counting toward the gate/cost —
  // critically, so toggling off the required LIDAR can't strand the clock
  // waiting on a frozen source. unregisterSource is idempotent, so a stream
  // that was never registered (hidden from the start, or absent) is a no-op.
  useEffect(() => {
    for (const stream of GOVERNED_STREAMS) {
      if (visibleStreams.has(stream)) continue;
      for (const id of streamSourceIds(stream, dataset.id)) {
        registry.unregisterSource(id);
      }
    }
  }, [visibleStreams, registry, dataset.id]);

  // Ego car footprint + openpilot-style path-prediction ribbon. These are
  // single-instance OVERLAY layers (not tile layers), so they ride a lightweight
  // per-tick `egoTime` state while the heavy tile tree stays memoized and
  // animates on the controller's own clock.
  const [egoTime, setEgoTime] = useState(() => timeController.getTime());
  useEffect(() => {
    if (!egoPath || egoPath.length === 0) return;
    setEgoTime(timeController.getTime());
    return timeController.on("tick", (t: number) => setEgoTime(t));
  }, [egoPath, timeController]);
  const egoLayers = useMemo(() => {
    if (!egoPath || egoPath.length === 0 || !visibleStreams.has("ego")) return [];
    return [
      buildEgoPathLayer({ path: egoPath, time: egoTime }),
      buildEgoFootprintLayer({ path: egoPath, time: egoTime }),
    ];
  }, [egoPath, egoTime, visibleStreams]);

  const layers = useMemo(
    () => [...tileLayers, ...egoLayers],
    [tileLayers, egoLayers],
  );

  // Click-to-inspect: only a hit on the objects layer feeds the inspector card.
  const handleClick = useCallback(
    (info: any) => {
      if (!onSelectObject) return;
      const id = String(info?.layer?.id ?? "");
      const o = info?.object;
      if (o && id.endsWith("-objects")) {
        const p = o.properties ?? o;
        onSelectObject({
          category: p.category,
          track_id: p.track_id ?? p.trackId,
          speed: p.speed,
          length: p.length,
          width: p.width,
          height: p.height,
          heading: p.heading,
        });
      } else {
        onSelectObject(null);
      }
    },
    [onSelectObject],
  );

  return (
    <DeckGL
      viewState={viewState}
      onViewStateChange={(e: any) => setViewState(e.viewState)}
      controller={{ dragRotate: true }}
      layers={layers}
      onClick={handleClick}
      pickingRadius={4}
      // Perf mode: render at 1× device pixels. On a 2–3× retina display this is
      // the single biggest fill-rate lever for the LIDAR cloud (4–9× fewer
      // fragments shaded/blended), at the cost of a softer image.
      useDevicePixels={perfMode ? false : true}
      style={{ background: "transparent" }}
    >
      {/* Street basemap only for geo-registered scenes (nuScenes / Argoverse).
          Anchored local-frame scenes (Waymo — no disclosed lat/lon) drop it so the
          real road network can't visibly contradict the approximate anchor; the
          cloud then floats on the cockpit's dark backdrop. The `showBasemap`
          toggle lets a geo-registered scene drop it too — e.g. to read the
          camera-colored surfel surface against the dark backdrop. */}
      {showBasemap && !dataset.avLocalFrame && (
        <Map
          reuseMaps
          mapStyle="mapbox://styles/mapbox/dark-v11"
          mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
          projection={{ name: "mercator" }}
        />
      )}
    </DeckGL>
  );
};

export default AvDeck;
