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
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import DeckGL from '@deck.gl/react';
import { SolidPolygonLayer } from '@deck.gl/layers';
import { Map } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { TimeController } from '@poopdeck.gl/playback';
import type { SourceRegistry } from '@poopdeck.gl/react';
import { buildDemoLayers } from '../demo/buildDemoLayers';
import { subscribeThrottledTick } from './throttledTick';
import { buildGoogle3DTilesLayer } from './googleTiles';
import {
  buildEgoFootprintLayer,
  buildEgoPathLayer,
  type EgoPathPoint,
} from './egoLayers';
import {
  DEFAULT_FOLLOW_CONFIG,
  desiredCameraAt,
  expAlpha,
  shortestAngleDelta,
  smoothAngle,
  type FollowCameraConfig,
} from './followCamera';
import type { PickedObject } from './ObjectInspector';
import type { AvDataset } from '../../types';
import type { AvStreamKey } from './sceneTypes';
import { MAPBOX_ACCESS_TOKEN } from '../../lib/mapboxToken';

export interface AvDeckProps {
  dataset: AvDataset;
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
  /**
   * Space-time-cube height scale (meters per sim-ms). 0 (default) renders flat;
   * > 0 (set only in the "Spacetime" render mode, when `dataset.avCube` is set)
   * lifts the track ribbons into a Hägerstrand cube and adds a rising now-plane.
   * @default 0
   */
  timeHeightScale?: number;
  /**
   * Live camera-zoom reporter (throttled to ~0.05-zoom steps). Drives the "Zoom
   * LOD" HUD, which shows which additive-octree levels are resident at the
   * current zoom. Fires on user drag/zoom AND the ego-follow camera.
   */
  onCameraZoom?: (zoom: number) => void;
  /**
   * Overlay Google Photorealistic 3D Tiles (deck.gl `Tile3DLayer`) UNDER the STT
   * layers. Only meaningful when {@link googleTilesApiKey} is set; the cockpit
   * gates the toggle on the scene opting in (`dataset.tiles3d`) + a configured
   * key. @default false
   */
  show3DTiles?: boolean;
  /** Google Maps Platform API key for {@link show3DTiles}. */
  googleTilesApiKey?: string;
  /** Receives the photoreal tiles' required data attribution (Google ToS). */
  onTiles3dAttribution?: (credits: string) => void;
  /**
   * Manual vertical trim (metres) on top of the auto-detected ground height for
   * {@link show3DTiles}. Positive RAISES the mesh, negative lowers it — lets the
   * user nudge the photoreal ground onto the cloud's streets when the auto-detect
   * (lowest nearby tile origin) sits a touch high or low. @default 0
   */
  tiles3dElevationAdjust?: number;
  /** Photoreal mesh opacity (0–1); below 1 ghosts it so the LIDAR pops. @default 1 */
  tiles3dOpacity?: number;
}

/** Which streams own which built layer (by the id suffix buildDemoLayers sets). */
function layerStream(layerId: string, datasetId: string): AvStreamKey {
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
const GOVERNED_STREAMS: AvStreamKey[] = ['lidar', 'ego', 'objects', 'map'];

/**
 * Camera pitch ceiling for every AvDeck framing (street-level AND the
 * space-time cube). Deliberately below deck's 71.57° horizon crossing at the
 * default `altitude: 1.5` — see the note at the `viewState` seed and
 * docs/roadmap/tile-loading-3d-2026-07.md §1/§4.
 */
const AV_MAX_PITCH = 70;

/** Governor source id(s) a stream registers — the inverse of {@link layerStream}. */
function streamSourceIds(stream: AvStreamKey, datasetId: string): string[] {
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
  timeHeightScale = 0,
  onCameraZoom,
  show3DTiles = false,
  googleTilesApiKey,
  onTiles3dAttribution,
  tiles3dElevationAdjust = 0,
  tiles3dOpacity = 1,
}) => {
  // Space-time-cube mode: the track ribbons climb time = altitude. We pull the
  // camera back + tilt it so the whole ~200 m-tall cube is framed (the pitch
  // CEILING stays put — see AV_MAX_PITCH), and we GATE OFF the ego-follow chase
  // (you don't chase a climbing worm — you want the static cube in view).
  const cubeMode = !!dataset.avCube && timeHeightScale > 0;
  // Controlled camera: seeded from the dataset, then driven by ego-follow and
  // the pitch toggle. The user can still drag/zoom (onViewStateChange).
  //
  // AV_MAX_PITCH is 70 everywhere below (it was 75 street-level / 85 in cube
  // mode). At deck's default `altitude: 1.5` the top screen ray clears the
  // horizon at pitch 71.57°: `unproject` then returns a ground point BEHIND the
  // camera and the viewport lon/lat box the tile loader selects against
  // inverts — an inverted latitude box selects zero tiles while every readiness
  // signal still reports "settled and fully buffered". See
  // docs/roadmap/tile-loading-3d-2026-07.md §1/§4. The chassis repairs a bad
  // box now; this ceiling keeps the cockpit out of the band at all. Both old
  // values sat above the cliff, so both moved.
  const [viewState, setViewState] = useState<any>(() => ({
    ...dataset.initialViewState,
    maxPitch: AV_MAX_PITCH,
  }));
  const viewRef = useRef(viewState);
  viewRef.current = viewState;

  // Report live zoom to the cockpit's "Zoom LOD" HUD, throttled to ~0.05-zoom
  // steps so the follow-cam's per-frame viewState updates don't spam the parent.
  const lastReportedZoom = useRef<number | null>(null);
  useEffect(() => {
    const z = viewState?.zoom;
    if (typeof z !== 'number' || !onCameraZoom) return;
    if (
      lastReportedZoom.current !== null &&
      Math.abs(lastReportedZoom.current - z) < 0.05
    )
      return;
    lastReportedZoom.current = z;
    onCameraZoom(z);
  }, [viewState?.zoom, onCameraZoom]);

  // Pitch toggle: morph between perspective (the dataset's initial pitch) and
  // a top-down plan view. Snaps under reduced motion, eases otherwise.
  const targetPitch = topDown ? 0 : (dataset.initialViewState.pitch ?? 55);

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
    setViewState({
      ...dataset.initialViewState,
      pitch: targetPitch,
      maxPitch: AV_MAX_PITCH,
    });
    // targetPitch is read fresh from this render's closure but is deliberately
    // NOT a dep — toggling top-down WITHIN a scene must not recenter the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  // scene.json's `initialView` is authoritative (always matches the bundle's tile
  // georef). The `[dataset]` effect + useState seed frame from the hardcoded
  // `dataset.initialViewState` fallback immediately; this snaps to the real
  // scene framing the moment scene.json resolves (or the scene switches), so the
  // camera can't drift from the data even if the hardcoded coords go stale. Pitch
  // still follows the perspective⇄top-down toggle. SKIP in cube mode — the cube
  // framing effect below owns the camera there (street-level zoom would clip the
  // ~200 m-tall cube).
  useEffect(() => {
    if (!sceneView || cubeMode) return;
    setViewState((vs: any) => ({
      ...vs,
      ...sceneView,
      pitch: targetPitch,
      maxPitch: AV_MAX_PITCH,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneView, cubeMode]);

  // Space-time-cube framing. When the "Spacetime" mode turns on, pull the camera
  // BACK + tilt it up so the whole time-as-height cube is in view rather than
  // the street-level cloud framing. The ceiling stays AV_MAX_PITCH — this
  // framing used to raise it to 85, which is inside the band where the tile
  // loader's viewport box inverts (docs/roadmap/tile-loading-3d-2026-07.md
  // §1/§4). Seeded from the scene
  // center (sceneView wins, else the dataset fallback). Snaps once on entering
  // cube mode; the user can then orbit freely. Leaving cube mode lets the
  // [dataset]/sceneView effects re-frame to street level on the next switch.
  useEffect(() => {
    if (!cubeMode) return;
    const center = sceneView ?? dataset.initialViewState;
    setViewState((vs: any) => ({
      ...vs,
      longitude: center.longitude ?? vs.longitude,
      latitude: center.latitude ?? vs.latitude,
      // Zoom out ~4 levels from the street framing so a ~200 m cube fits.
      zoom: (center.zoom ?? dataset.initialViewState.zoom ?? 18) - 4,
      pitch: topDown ? 0 : 58,
      bearing: center.bearing ?? dataset.initialViewState.bearing ?? 20,
      maxPitch: AV_MAX_PITCH,
    }));
    // Only re-run when cube mode toggles or the scene/view changes; topDown is
    // read fresh from the closure (toggling it within cube mode shouldn't recenter).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cubeMode, sceneView, dataset.id]);

  useEffect(() => {
    if (reducedMotion) {
      setViewState((vs: any) => ({ ...vs, pitch: targetPitch }));
      return;
    }
    let raf = 0;
    const step = () => {
      setViewState((vs: any) => {
        const next = vs.pitch + (targetPitch - vs.pitch) * 0.18;
        if (Math.abs(targetPitch - next) < 0.3)
          return { ...vs, pitch: targetPitch };
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
    // Gate the chase OFF in cube mode — you frame the static cube, not chase the
    // climbing ego worm up the time axis.
    if (cubeMode || !egoFollow || !egoPath || egoPath.length === 0) return;
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
      return timeController.on('tick', snap);
    }

    let raf = 0;
    let last = performance.now();
    let first = true; // first frame snaps, so enabling follow centres at once
    const step = () => {
      const now = performance.now();
      if (!first && now - last < 33) {
        raf = requestAnimationFrame(step);
        return;
      }
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
          const longitude =
            vs.longitude + (want.longitude - vs.longitude) * aPos;
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
          const dZoom =
            next.zoom !== undefined ? Math.abs(next.zoom - vs.zoom) : 0;
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
  }, [
    cubeMode,
    egoFollow,
    egoPath,
    followConfig,
    reducedMotion,
    timeController,
  ]);

  const tileLayers = useMemo(() => {
    const all = buildDemoLayers({
      dataset,
      timeController,
      useGlobe: false,
      timeHeightScale,
      plumbing: { registry },
      perfMode,
    });
    // Honor the stream toggles: drop any layer whose owning stream is hidden.
    return all.filter((l: any) =>
      visibleStreams.has(layerStream(l.id, dataset.id)),
    );
  }, [
    dataset,
    timeController,
    registry,
    visibleStreams,
    perfMode,
    timeHeightScale,
  ]);

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
  // single-instance OVERLAY layers (not tile layers), so they ride a
  // lightweight `egoTime` state while the heavy tile tree stays memoized and
  // animates on the controller's own clock. That state is published at the
  // 10 Hz UI rate, not per 60 Hz tick: each publish re-renders this tree and
  // rebuilds the deck `layers` array, and per-tick it was the dominant commit
  // source on /drive (119 commits/s × ~440 components → 18.8/s at 10 Hz;
  // display-capped fps unchanged, so the win is main-thread headroom on
  // slower machines). The ego dot moving in 100 ms steps is invisible at the
  // cockpit's speeds; a pause flushes the exact stop time.
  const [egoTime, setEgoTime] = useState(() => timeController.getTime());
  useEffect(() => {
    if (!egoPath || egoPath.length === 0) return;
    setEgoTime(timeController.getTime());
    return subscribeThrottledTick(timeController, setEgoTime);
  }, [egoPath, timeController]);
  const egoLayers = useMemo(() => {
    if (!egoPath || egoPath.length === 0 || !visibleStreams.has('ego'))
      return [];
    return [
      buildEgoPathLayer({ path: egoPath, time: egoTime }),
      buildEgoFootprintLayer({ path: egoPath, time: egoTime }),
    ];
  }, [egoPath, egoTime, visibleStreams]);

  // Space-time-cube "now" plane — a translucent quad rising with the playhead at
  // z = (egoTime − timeRange.start) × timeHeightScale, spanning the scene/ego
  // bbox. It rides the same per-tick `egoTime` state as the ego overlays (the
  // tile-layer ribbons stay memoized + clock-driven). depthWriteEnabled:false so
  // the plane TINTS the threads it crosses rather than occluding them. Same idiom
  // as the nyc-taxi-cube now-plane in DemoViewer. Cube mode only.
  const cubeOverlayLayers = useMemo(() => {
    if (!cubeMode) return [];
    // Scene extent: union of the ego polyline, else a small box around center.
    let minLon = Infinity,
      minLat = Infinity,
      maxLon = -Infinity,
      maxLat = -Infinity;
    if (egoPath && egoPath.length > 0) {
      for (const p of egoPath) {
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
      }
      // Pad the bbox a little so the plane fully covers the ribbon bundle.
      const padLon = (maxLon - minLon) * 0.15 || 0.001;
      const padLat = (maxLat - minLat) * 0.15 || 0.001;
      minLon -= padLon;
      maxLon += padLon;
      minLat -= padLat;
      maxLat += padLat;
    } else {
      const { longitude, latitude } = dataset.initialViewState;
      minLon = longitude - 0.002;
      maxLon = longitude + 0.002;
      minLat = latitude - 0.0015;
      maxLat = latitude + 0.0015;
    }
    const zNow =
      Math.max(0, egoTime - dataset.timeRange.start) * timeHeightScale;
    const plane = [
      [minLon, minLat, zNow],
      [maxLon, minLat, zNow],
      [maxLon, maxLat, zNow],
      [minLon, maxLat, zNow],
    ];
    return [
      new SolidPolygonLayer({
        id: `${dataset.id}-cube-now-plane`,
        data: [plane],
        getPolygon: (d: any) => d,
        filled: true,
        getFillColor: [31, 186, 214, 22],
        pickable: false,
        parameters: { depthWriteEnabled: false } as any,
      }),
    ];
  }, [
    cubeMode,
    egoPath,
    egoTime,
    timeHeightScale,
    dataset.id,
    dataset.initialViewState,
    dataset.timeRange.start,
  ]);

  // Google Photorealistic 3D Tiles backdrop. Built only when the cockpit turns
  // it on for a key-configured, opted-in scene. Drawn LAST (appended) so the
  // mesh composites correctly with the LIDAR: each point is drawn (and writes
  // depth) first, then the buildings depth-test against it — opaque buildings
  // still occlude returns behind them, but when the mesh is GHOSTED (opacity < 1)
  // it blends OVER the points behind it so they show THROUGH the translucent
  // buildings (drawing the tiles first instead discards those points on the depth
  // test, leaving nothing to show through). The layer renders in geographic
  // coords, so it lands at the scene's geo-anchor in the same MapView.
  //
  // Vertical alignment: Google's mesh uses TRUE WGS84-ellipsoidal heights while
  // the AV cloud sits at local z≈0, so the city would float ~200 m up. The mesh
  // is lowered by the local ground height (GroundedTile3DLayer). Prefer the
  // baked, per-scene `dataset.tiles3dGroundHeight` (measured from the tiles —
  // reliable + deterministic); only when a scene ships no baked value do we fall
  // back to AUTO-DETECTING it from the tiles nearest the anchor (frozen on the
  // first reading; reset on scene switch / toggle).
  const bakedGround = dataset.tiles3dGroundHeight;
  const [tiles3dGroundOffset, setTiles3dGroundOffset] = useState(0);
  const groundFrozenRef = useRef(false);
  useEffect(() => {
    groundFrozenRef.current = false;
    setTiles3dGroundOffset(0);
  }, [dataset.id, show3DTiles]);
  const anchorLng = sceneView?.longitude ?? dataset.initialViewState.longitude;
  const anchorLat = sceneView?.latitude ?? dataset.initialViewState.latitude;
  const tiles3dLayers = useMemo(() => {
    if (!show3DTiles || !googleTilesApiKey) return [];
    // Baked ground when present, else the live auto-detect; then the user's
    // manual trim (positive raises the mesh).
    const baseGround = bakedGround ?? tiles3dGroundOffset;
    return [
      buildGoogle3DTilesLayer({
        apiKey: googleTilesApiKey,
        sceneId: dataset.id,
        anchor: [anchorLng, anchorLat],
        elevationOffset: baseGround - tiles3dElevationAdjust,
        opacity: tiles3dOpacity,
        // Only auto-detect when the scene ships no baked ground height.
        onGroundHeight:
          bakedGround === undefined
            ? (h) => {
                if (groundFrozenRef.current) return;
                groundFrozenRef.current = true;
                setTiles3dGroundOffset(h);
              }
            : undefined,
        onAttribution: onTiles3dAttribution,
      }),
    ];
  }, [
    show3DTiles,
    googleTilesApiKey,
    dataset.id,
    anchorLng,
    anchorLat,
    bakedGround,
    tiles3dGroundOffset,
    tiles3dElevationAdjust,
    tiles3dOpacity,
    onTiles3dAttribution,
  ]);

  const layers = useMemo(
    () => [...tileLayers, ...egoLayers, ...cubeOverlayLayers, ...tiles3dLayers],
    [tileLayers, egoLayers, cubeOverlayLayers, tiles3dLayers],
  );

  // Click-to-inspect: only a hit on the objects layer feeds the inspector card.
  const handleClick = useCallback(
    (info: any) => {
      if (!onSelectObject) return;
      const id = String(info?.layer?.id ?? '');
      const o = info?.object;
      if (o && id.endsWith('-objects')) {
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
      // Additive-octree LOD scenes pack detail down to z22, so let the camera
      // zoom in far enough to reach the full-resolution residual (deck's default
      // maxZoom is 20, which would cap you short of the deepest levels). Other
      // scenes keep the default cap. `maxZoom` is a runtime-honored controller
      // option that deck's narrow ControllerOptions type omits, hence the cast.
      controller={
        { dragRotate: true, maxZoom: dataset.lidarLod ? 23 : 20 } as any
      }
      layers={layers}
      onClick={handleClick}
      pickingRadius={4}
      // Perf mode: render at 1× device pixels. On a 2–3× retina display this is
      // the single biggest fill-rate lever for the LIDAR cloud (4–9× fewer
      // fragments shaded/blended), at the cost of a softer image.
      useDevicePixels={perfMode ? false : true}
      style={{ background: 'transparent' }}
    >
      {/* Street basemap only for geo-registered scenes (nuScenes / Argoverse).
          Anchored local-frame scenes (Waymo — no disclosed lat/lon) drop it so the
          real road network can't visibly contradict the approximate anchor; the
          cloud then floats on the cockpit's dark backdrop. The `showBasemap`
          toggle lets a geo-registered scene drop it too — e.g. to read the
          camera-colored surfel surface against the dark backdrop. Also dropped
          while the Google 3D Tiles backdrop is on — the photoreal mesh carries
          its own ground, so the flat basemap underneath is redundant (and would
          peek through at the horizon). */}
      {showBasemap && !dataset.avLocalFrame && !show3DTiles && (
        <Map
          reuseMaps
          mapStyle="mapbox://styles/mapbox/dark-v11"
          mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
          projection={{ name: 'mercator' }}
        />
      )}
    </DeckGL>
  );
};

export default AvDeck;
