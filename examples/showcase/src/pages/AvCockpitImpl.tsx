/**
 * AV Telemetry Cockpit — a streetscape.gl / avs.auto-style fullscreen surface
 * for one autonomous-vehicle scene. Orchestrates the deck + chrome:
 *
 *   • resolves the scene from the `/drive/:sceneId?` route param (default
 *     'av-synthetic') via the Dataset registry;
 *   • fetches `scene.json` (through the same data-base resolver the Dataset URLs
 *     use) for chrome / object colors / the real time range / the telemetry +
 *     camera sidecar refs, then fetches those sidecars;
 *   • owns ONE TimeController + PlaybackGovernor (the shared `usePlayback`
 *     hook), so the deck layers, the gauges, the camera inset, and the timeline
 *     all read the same clock;
 *   • renders {@link AvDeck} plus the floating chrome (scene switcher, stream
 *     panel, gauges, camera inset, timeline);
 *   • honors `prefers-reduced-motion` (no autoplay, no ego-follow easing).
 *
 * Missing streams simply hide their panel; a missing/blank bundle shows a
 * loading or "scene not generated yet" state instead of crashing.
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { usePlayback } from '@poopdeck.gl/react';
import { datasets, getDatasetById } from '../datasets';
import { useReducedMotion } from '../lib/reducedMotion';
import { useIsMobile } from '../lib/useMediaQuery';
import type { AvDataset, ColorRGBA } from '../types';
import AvDeck from '../components/av/AvDeck';
import AvThreeViewer from '../components/av/AvThreeViewer';
import AvMobileChrome from '../components/av/AvMobileChrome';
import StreamPanel from '../components/av/StreamPanel';
import MetricCharts from '../components/av/MetricCharts';
import CameraInset from '../components/av/CameraInset';
import SceneSwitcher from '../components/av/SceneSwitcher';
import Timeline, { type TimelineProps } from '../components/av/Timeline';
import ObjectInspector, {
  type PickedObject,
} from '../components/av/ObjectInspector';
import {
  type AvScene,
  type AvStreamKey,
  type AvTelemetry,
  type AvCameras,
  type AvLidarDensity,
} from '../components/av/sceneTypes';

const DEFAULT_SCENE_ID = 'av-synthetic';
const LAYER_STREAMS: AvStreamKey[] = ['lidar', 'ego', 'objects', 'map'];

/**
 * Google Maps Platform key for the Photorealistic 3D Tiles toggle (read once at
 * module load). Unset ⇒ the toggle is hidden everywhere — the feature no-ops
 * with no key, so nothing breaks when it isn't configured. Set it in the
 * showcase's `.env.local` (`VITE_GOOGLE_MAPS_API_KEY=…`).
 */
const GOOGLE_TILES_API_KEY: string | undefined = (import.meta as any).env
  ?.VITE_GOOGLE_MAPS_API_KEY;

/**
 * Default opacity for the Google Photorealistic 3D Tiles mesh when a scene
 * doesn't override it (`Dataset.tiles3dOpacity`). Ghosted by default so the LIDAR
 * cloud reads against the buildings — the value the user converged on across
 * scenes. Set to 1 for an opaque-by-default photoreal backdrop instead.
 */
const DEFAULT_TILES3D_OPACITY = 0.29;

/**
 * How the LIDAR cloud is rendered. `raw` = the base bundle's hard point dots
 * (height-band colored); `splat` / `surfel` / `iso` / `world` / `scan` each swap
 * to a separately-built bundle (`<id>-splat` / `<id>-surfel` / `<id>-iso` /
 * `<id>-world` / `<id>-scan`) rendered as soft point splats / oriented Gaussian
 * surfels / live density iso-lines / a cumulative worldbuild reconstruction / a
 * raw rotating sweep. These used to be separate scene entries; they're now a
 * per-scene toggle that swaps the active dataset. `iso3d` swaps to its OWN
 * `<id>-iso3d` bundle (density contoured per height layer, each contour tagged
 * with its real `z_layer` altitude) and lifts the iso-lines to true height — a
 * genuine 3D density field, not a band→height fake. `cube` is RENDER-ONLY: it
 * reads the BASE bundle + its `tracks/` archive and lifts the track trajectories
 * into a Hägerstrand space-time cube (no `-cube` bundle exists).
 */
type LidarRenderMode =
  | 'raw'
  | 'splat'
  | 'surfel'
  | 'iso'
  | 'iso3d'
  | 'world'
  | 'stage'
  | 'cube'
  | 'scan'
  | 'lod';

/** Label shown on each render-mode pill. */
const RENDER_MODE_LABELS: Record<LidarRenderMode, string> = {
  raw: 'Points',
  splat: 'Splat',
  surfel: 'Surfel',
  iso: 'Iso-lines',
  iso3d: 'Iso 3D',
  world: 'Worldbuild',
  stage: 'Stage',
  cube: 'Spacetime',
  scan: 'Sweep',
  lod: 'Zoom LOD',
};

/**
 * The AV scene bundle registered under `id`. The cockpit only ever mounts `av`
 * datasets, so an id that resolves to another family is not a cockpit route.
 */
function getAvSceneById(id: string): AvDataset | undefined {
  const d = getDatasetById(id);
  return d?.type === 'av' ? d : undefined;
}

/** Base url of a dataset's data dir (strip the trailing manifest filename). */
function sceneBaseUrl(dataset: AvDataset): string {
  // avSceneUrl is the resolved scene.json url; its dir is the bundle root.
  return dataset.avSceneUrl.replace(/\/[^/]*$/, '');
}

const AvCockpit: React.FC = () => {
  const { sceneId } = useParams<{ sceneId?: string }>();
  const reducedMotion = useReducedMotion();
  const isMobile = useIsMobile();
  // Height of the phone chrome's bottom stack, reported by AvMobileChrome.
  const [bottomChrome, setBottomChrome] = useState(0);

  // All AV scenes for the switcher — EXCLUDING the camera-splat / surfel render
  // variants. Those are no longer separate entries: they're folded into the
  // per-scene LIDAR render-mode toggle below (Points ⇄ Splat ⇄ Surfel), each
  // mode swapping to its own `<id>-splat` / `<id>-surfel` bundle.
  const avScenes = useMemo(
    () =>
      datasets.filter(
        (d): d is AvDataset =>
          d.type === 'av' &&
          !/-(?:splat|surfel|iso3d|iso|world|stage|scan|lod)$/.test(d.id),
      ),
    [],
  );

  // Resolve the BASE scene from the route. A deep-link straight to a render
  // variant (`/drive/<id>-splat`) still works: strip the suffix to the base and
  // seed the matching mode, so old links land on the same visual.
  const routeId = sceneId ?? DEFAULT_SCENE_ID;
  const { baseId, routeMode } = useMemo(() => {
    // `cube` is render-only (no `-cube` bundle) but a `/drive/<id>-cube` deep-link
    // should still land on it. `iso3d` / `world` / `scan` ARE real bundle suffixes;
    // match `iso3d` before the shorter `iso`. The guard below confirms the BASE
    // exists either way, since the suffix strips to the base id.
    const m = routeId.match(
      /^(.*)-(splat|surfel|iso3d|iso|world|stage|scan|lod)$/,
    );
    if (m && getAvSceneById(m[1])) {
      return { baseId: m[1], routeMode: m[2] as LidarRenderMode };
    }
    return { baseId: routeId, routeMode: 'raw' as LidarRenderMode };
  }, [routeId]);
  const baseDataset = useMemo(() => getAvSceneById(baseId), [baseId]);

  // ── URL query params hold every cockpit control selection ─────────────────
  // The controls below (render mode, stream visibility, follow / view / perf /
  // basemap toggles, LIDAR density) are DERIVED from the query string and write
  // back to it, so the cockpit's state is bookmarkable, shareable, and survives a
  // refresh. `setParam(key, null)` drops a param (default-valued URLs stay clean);
  // writes use `replace` so flipping a toggle doesn't pile up history entries.
  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const renderModes = useMemo<LidarRenderMode[]>(() => {
    if (!baseDataset) return [];
    // `splat` is ALWAYS offered: if the scene ships a camera-colored `<id>-splat`
    // bundle we swap to it (photographic), otherwise we splat the scene's own
    // cloud in place (render-only, height-band colors). `surfel` / `iso` each need
    // their own baked bundle (orientation columns / density-contour lines), so
    // they're only offered when that `<id>-surfel` / `<id>-iso` bundle exists.
    const modes: LidarRenderMode[] = ['raw', 'splat'];
    if (getAvSceneById(`${baseDataset.id}-surfel`)) modes.push('surfel');
    // Flat "Iso-lines" (`-iso`) and TRUE-3D "Iso 3D" (`-iso3d`) are each their
    // own baked bundle (the 3D one contours density per height layer).
    if (getAvSceneById(`${baseDataset.id}-iso`)) modes.push('iso');
    if (getAvSceneById(`${baseDataset.id}-iso3d`)) modes.push('iso3d');
    // Worldbuild needs its own `<id>-world` bundle (surfels + is_dynamic /
    // world_class columns + first-seen times).
    if (getAvSceneById(`${baseDataset.id}-world`)) modes.push('world');
    // Scene-split "Stage" needs its own `<id>-stage` bundle (a STATIC stage
    // archive + a DYNAMIC actors archive). HELD BACK in datasets.ts until the look
    // is verified, so this auto-gates off until that bundle is un-held + built.
    if (getAvSceneById(`${baseDataset.id}-stage`)) modes.push('stage');
    // Spacetime (cube) is HELD BACK from the shipped cockpit (see the held-back
    // note in datasets.ts). The render-only logic below stays dormant (the toggle
    // is not pushed and the `-cube` deep-link suffix is unmatched, so
    // `lidarRenderMode` is never "cube"); re-add this push + a squash-slider
    // chip (copy DemoViewer's private `CubeControls`) + the regex suffix to
    // ship it.
    // Spacetime (cube) is RENDER-ONLY — it reads the base bundle + its `tracks/`
    // archive. HELD BACK: the toggle is not offered (re-add `modes.push("cube")`
    // to ship it).
    // Sweep needs its own `<id>-scan` bundle (raw returns + true scan-time +
    // phase ramp) — only AV2 builds it, so this auto-gates scan to AV2 scenes.
    if (getAvSceneById(`${baseDataset.id}-scan`)) modes.push('scan');
    // Additive-octree zoom LOD needs its own `<id>-lod` bundle (one archive
    // where each return is materialized at a single home zoom). The client loads
    // the union of zoom levels and zooming in streams only the residual detail.
    if (getAvSceneById(`${baseDataset.id}-lod`)) modes.push('lod');
    return modes;
  }, [baseDataset]);

  // LIDAR render mode (`?mode=`). Each non-raw mode has its OWN data bundle (built
  // with --colorize / --surfel); picking a mode swaps the active dataset to that
  // bundle. The route suffix (`/drive/<id>-splat`) still seeds the default so old
  // deep-links land on the same visual; an explicit `?mode=` overrides it.
  // One radio GROUP name per mounted cockpit — native radios group by name,
  // so a hardcoded one would fuse two mounted cockpits into one group.
  const renderModeGroup = useId();
  const modeParam = searchParams.get('mode') as LidarRenderMode | null;
  const lidarRenderMode: LidarRenderMode =
    modeParam && renderModes.includes(modeParam) ? modeParam : routeMode;
  const setLidarRenderMode = useCallback(
    (m: LidarRenderMode) => {
      // Drop the param when it matches the route-derived default to keep a plain
      // `/drive/<id>` URL clean; write it explicitly otherwise (so a deep-linked
      // `-splat` route can still be flipped back to Points).
      setParam('mode', m === routeMode ? null : m);
    },
    [routeMode, setParam],
  );

  // The ACTIVE dataset everything downstream reads (deck, sidecars, density).
  const dataset = useMemo(() => {
    if (!baseDataset) return baseDataset;
    // Surfel / iso / world / scan: each a fully separate baked bundle (no in-place
    // fallback — fall back to the base if the bundle is missing).
    if (lidarRenderMode === 'surfel')
      return getAvSceneById(`${baseDataset.id}-surfel`) ?? baseDataset;
    if (lidarRenderMode === 'iso')
      return getAvSceneById(`${baseDataset.id}-iso`) ?? baseDataset;
    if (lidarRenderMode === 'iso3d')
      return getAvSceneById(`${baseDataset.id}-iso3d`) ?? baseDataset;
    if (lidarRenderMode === 'world')
      return getAvSceneById(`${baseDataset.id}-world`) ?? baseDataset;
    if (lidarRenderMode === 'stage')
      return getAvSceneById(`${baseDataset.id}-stage`) ?? baseDataset;
    if (lidarRenderMode === 'scan')
      return getAvSceneById(`${baseDataset.id}-scan`) ?? baseDataset;
    // Additive zoom LOD: swap to the `-lod` bundle (lidarLod → lodMode:'additive'
    // on the point layer; the engine loads + renders the union of zoom levels).
    if (lidarRenderMode === 'lod')
      return getAvSceneById(`${baseDataset.id}-lod`) ?? baseDataset;
    // Spacetime cube: a RENDER-ONLY clone of the BASE bundle with `avCube` set —
    // no bundle swap. buildDemoLayers reads the base + its `tracks/` archive and
    // lifts the trajectories into the time-as-height cube.
    if (lidarRenderMode === 'cube') return { ...baseDataset, avCube: true };
    if (lidarRenderMode === 'splat') {
      // Prefer the camera-colored `-splat` bundle when it exists (best look)…
      const variant = getAvSceneById(`${baseDataset.id}-splat`);
      if (variant) return variant;
      // …otherwise splat THIS scene's existing cloud in place — render-only, no
      // bundle swap (height-band colors instead of camera color). Match the
      // colored-variant's splat sizing/opacity so overlaps blend into surface.
      return {
        ...baseDataset,
        lidarSplat: true,
        radius: 2.4,
        radiusMinPixels: 1.4,
        opacity: 0.96,
      };
    }
    return baseDataset;
  }, [baseDataset, lidarRenderMode]);

  // ── Sidecars (scene.json + telemetry + cameras) ───────────────────────────
  const [scene, setScene] = useState<AvScene | null>(null);
  const [telemetry, setTelemetry] = useState<AvTelemetry | null>(null);
  const [cameras, setCameras] = useState<AvCameras | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Renderer backend: the deck.gl cockpit, or the Three.js + TSL (WebGPU) engine.
  const [renderer, setRenderer] = useState<'deck' | 'three'>('deck');
  // Live camera zoom (throttled by AvDeck) — drives the "Zoom LOD" HUD.
  const [liveZoom, setLiveZoom] = useState<number | null>(null);
  const handleCameraZoom = useCallback((z: number) => setLiveZoom(z), []);
  // Click-to-inspect selection (cleared when the scene changes).
  const [selectedObject, setSelectedObject] = useState<PickedObject | null>(
    null,
  );
  useEffect(() => {
    setSelectedObject(null);
  }, [dataset]);

  useEffect(() => {
    if (!dataset) return;
    let cancelled = false;
    setScene(null);
    setTelemetry(null);
    setCameras(null);
    setLoadError(false);

    const run = async () => {
      try {
        const sceneUrl = dataset.avSceneUrl;
        const sc: AvScene | null = sceneUrl
          ? await fetch(sceneUrl).then((r) => (r.ok ? r.json() : null))
          : null;
        if (cancelled) return;
        setScene(sc);
        // Sidecars: prefer the scene's stream urls (resolved relative to the
        // bundle root); fall back to the Dataset's resolved urls.
        if (dataset.avTelemetryUrl) {
          const tel = await fetch(dataset.avTelemetryUrl)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          if (!cancelled && tel) setTelemetry(tel);
        }
        if (dataset.avCamerasUrl) {
          const cam = await fetch(dataset.avCamerasUrl)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          if (!cancelled && cam) setCameras(cam);
        }
        if (!sc) setLoadError(true);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  // Authoritative time range: scene.json wins; fall back to the Dataset's
  // placeholder window until it loads.
  const timeRange = useMemo(
    () => scene?.timeRange ?? dataset?.timeRange,
    [scene, dataset],
  );
  // Base wall→sim rate so the whole range plays in targetPlaybackSeconds.
  const baseSpeed = useMemo(() => {
    if (!timeRange) return 1000;
    const span = timeRange.end - timeRange.start;
    const secs = dataset?.targetPlaybackSeconds ?? 20;
    return span / (secs * 1000);
  }, [timeRange, dataset]);

  const playback = usePlayback({
    timeRange,
    baseSpeed,
    loop: true,
  });

  // Reduced motion: never autoplay. (usePlayback starts paused, so this is
  // belt-and-suspenders — keep it paused on mount/range change.)
  useEffect(() => {
    if (reducedMotion) playback.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, timeRange]);

  // ── Streams + visibility ──────────────────────────────────────────────────
  const presentStreams = useMemo<AvStreamKey[]>(() => {
    if (scene?.streams) {
      return (Object.keys(scene.streams) as AvStreamKey[]).filter(
        (k) => scene.streams![k],
      );
    }
    // No scene yet: infer from the Dataset's archive urls so the deck still
    // renders something before scene.json lands.
    const inferred: AvStreamKey[] = ['lidar'];
    if (dataset?.avEgoUrl) inferred.push('ego');
    if (dataset?.avObjectsUrl) inferred.push('objects');
    if (dataset?.avTelemetryUrl) inferred.push('telemetry');
    if (dataset?.avCamerasUrl) inferred.push('camera');
    return inferred;
  }, [scene, dataset]);

  // Stream visibility (`?streams=`). No param ⇒ every present LAYER stream is
  // visible (the default); otherwise only the comma-listed present streams are.
  // Toggling writes the param, dropping it once everything is back on.
  const visibleStreams = useMemo<Set<AvStreamKey>>(() => {
    const layerPresent = presentStreams.filter((s) =>
      LAYER_STREAMS.includes(s),
    );
    const param = searchParams.get('streams');
    if (param === null) return new Set(layerPresent);
    const wanted = new Set(param ? (param.split(',') as AvStreamKey[]) : []);
    return new Set(layerPresent.filter((s) => wanted.has(s)));
  }, [presentStreams, searchParams]);
  const toggleStream = useCallback(
    (s: AvStreamKey) => {
      const layerPresent = presentStreams.filter((x) =>
        LAYER_STREAMS.includes(x),
      );
      const next = new Set(visibleStreams);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      const allOn =
        next.size === layerPresent.length &&
        layerPresent.every((x) => next.has(x));
      setParam(
        'streams',
        allOn ? null : layerPresent.filter((x) => next.has(x)).join(','),
      );
    },
    [presentStreams, visibleStreams, setParam],
  );

  // Object colors: scene.json wins, else the Dataset copy.
  const objectColors = useMemo<Record<string, ColorRGBA> | undefined>(
    () => scene?.objectColors ?? dataset?.avObjectColors,
    [scene, dataset],
  );

  // ── Ego-follow camera ─────────────────────────────────────────────────────
  // The scene ships a lightweight ego polyline (additive `scene.streams.ego.path`)
  // that the cockpit can sample client-side. The smoothing + camera math lives
  // in {@link AvDeck} (a single rAF loop over `egoPath`); here we only own the
  // toggles. When the scene has no polyline the button is present but inert
  // (camera holds), which we surface in its title.
  // Camera + render toggles, all URL-backed. follow / top-down default OFF (param
  // present only when ON); perf / basemap default ON (param present only when OFF)
  // so the common case keeps a clean URL.
  const egoFollow = searchParams.get('follow') === '1';
  const toggleEgoFollow = useCallback(
    () => setParam('follow', egoFollow ? null : '1'),
    [egoFollow, setParam],
  );
  const topDown = searchParams.get('view') === 'top';
  const toggleTopDown = useCallback(
    () => setParam('view', topDown ? null : 'top'),
    [topDown, setParam],
  );
  // Fill-rate performance mode (1× device pixels + cheaper LIDAR fragments).
  // DEFAULT ON for the AV cockpit: the scenes are dense, fill-bound point clouds
  // and 1× device pixels is the single biggest lever (4–9× fewer fragments on a
  // retina display) for almost no perceptible loss on a moving cloud. The toggle
  // stays so it can be flipped OFF to A/B against full-quality rendering.
  const perfMode = searchParams.get('perf') !== '0';
  const togglePerfMode = useCallback(
    () => setParam('perf', perfMode ? '0' : null),
    [perfMode, setParam],
  );
  // Street basemap under geo-registered scenes (nuScenes / Argoverse). Default ON
  // so the cloud overlays real streets; flip OFF to read a camera-colored splat /
  // surfel surface against the cockpit's dark backdrop (no-op on `avLocalFrame`
  // scenes, which never draw a basemap — the toggle is hidden for those). In the
  // Spacetime CUBE mode the basemap defaults OFF (a street map under a 200 m-tall
  // cube of ribbons just clutters it), but an explicit `?basemap=1` re-enables it.
  const cubeMode = lidarRenderMode === 'cube';
  const showBasemap = cubeMode
    ? searchParams.get('basemap') === '1'
    : searchParams.get('basemap') !== '0';
  const toggleBasemap = useCallback(
    () => setParam('basemap', showBasemap ? '0' : null),
    [showBasemap, setParam],
  );

  // ── Google Photorealistic 3D Tiles (`?tiles3d=`) ──────────────────────────
  // A deck-only overlay: the scene must opt in (`dataset.tiles3d`), a key must be
  // configured, and the deck.gl renderer must be active (a Tile3DLayer can't ride
  // the Three.js engine). When all three hold the cockpit shows a "3D Tiles"
  // toggle that loads Google's photoreal city mesh under the LIDAR cloud.
  const tiles3dCapable =
    !!baseDataset?.tiles3d && !!GOOGLE_TILES_API_KEY && renderer === 'deck';
  const show3DTiles = tiles3dCapable && searchParams.get('tiles3d') === '1';
  const toggle3DTiles = useCallback(
    () => setParam('tiles3d', searchParams.get('tiles3d') === '1' ? null : '1'),
    [searchParams, setParam],
  );
  // Google's ToS requires the per-tile data attribution be shown; AvDeck reports
  // the visible-tiles' copyright union here for the credit chip below. Cleared
  // when the overlay is off so a stale credit never lingers.
  const [tiles3dAttribution, setTiles3dAttribution] = useState('');
  useEffect(() => {
    if (!show3DTiles) setTiles3dAttribution('');
  }, [show3DTiles]);
  // Manual vertical trim (`?tiles3dz=`, metres) on top of AvDeck's auto-detected
  // ground height, for seating the photoreal ground on the cloud's streets when
  // auto-detect sits a touch high/low. Positive raises the mesh. Clamped to
  // ±150 m; 0 (centred) is the default. URL-only now — the trim slider was
  // removed from the cockpit chrome, so nothing writes this param in-app.
  const tiles3dElevAdjust = (() => {
    const n = Number(searchParams.get('tiles3dz'));
    return Number.isFinite(n) ? Math.max(-150, Math.min(150, n)) : 0;
  })();
  // Photoreal mesh opacity (`?tiles3dop=`, 0–100 → 0..1). Ghosts the buildings so
  // the LIDAR cloud reads against them (useful when the animated cloud drifts
  // slightly out of sync with the static mesh). Defaults to the scene's baked
  // `tiles3dOpacity`, else a global ghosted default (the user's repeated pick).
  // URL-only now — the opacity slider was removed from the cockpit chrome, so
  // nothing writes this param in-app.
  const tiles3dDefaultOpacity =
    baseDataset?.tiles3dOpacity ?? DEFAULT_TILES3D_OPACITY;
  const tiles3dOpacity = (() => {
    const p = searchParams.get('tiles3dop');
    if (p === null) return tiles3dDefaultOpacity;
    const n = Number(p);
    return Number.isFinite(n)
      ? Math.max(0, Math.min(1, n / 100))
      : tiles3dDefaultOpacity;
  })();

  const egoPath = useMemo<{ t: number; lon: number; lat: number }[] | null>(
    () => (scene?.streams?.ego as any)?.path ?? null,
    [scene],
  );

  // ── Space-time cube (Spacetime render mode) ────────────────────────────────
  // `heightFactor` is the squash slider (`?squash=`, 0–100 → 0..1): 0 = flat map,
  // 1 = full cube. It feeds one shader uniform (timeHeightScale, meters per
  // sim-ms), so dragging it morphs the trajectories into the cube with zero data
  // re-upload. Only meaningful in cube mode; the slider renders only then.
  const squashParam = searchParams.get('squash');
  const heightFactor = (() => {
    const n = squashParam == null ? 100 : Number(squashParam);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : 1;
  })();
  // (`setHeightFactor` — the squash slider's onChange — was removed with the
  // held-back Spacetime cube; re-add it with the squash-slider JSX to ship cube.)
  // Cube height in metres for the full range at squash 1 (≈200 m reads clearly at
  // the pulled-back cube framing without dwarfing the streets), divided by the
  // range duration → metres per sim-ms (the AnimatedTripsLayer / now-plane
  // uniform). 0 outside cube mode (flat).
  const rangeHeightMeters = baseDataset?.avCubeRangeHeightMeters ?? 200;
  const rangeDurationMs = timeRange
    ? Math.max(1, timeRange.end - timeRange.start)
    : 1;
  const timeHeightScale = cubeMode
    ? (heightFactor * rangeHeightMeters) / rangeDurationMs
    : 0;

  // ── LIDAR density selector ────────────────────────────────────────────────
  // Some sources (Waymo) bake several LIDAR archives at increasing point counts
  // (scene.json `streams.lidar.densities`); the user A/B's them live. Picking a
  // tier swaps the rendered archive's manifest url. null = the default (lightest).
  const lidarDensities = useMemo<AvLidarDensity[]>(
    () => scene?.streams?.lidar?.densities ?? [],
    [scene],
  );
  // Active LIDAR density tier (`?density=`). Validated against the scene's tiers
  // so a stale id (e.g. carried from another scene) falls back to the default
  // (lightest); the default tier is stored as no-param to keep the URL clean.
  const densityParam = searchParams.get('density');
  const lidarDensityId =
    densityParam && lidarDensities.some((d) => d.id === densityParam)
      ? densityParam
      : null;
  const onSelectLidarDensity = useCallback(
    (id: string) =>
      setParam(
        'density',
        lidarDensities[0] && id === lidarDensities[0].id ? null : id,
      ),
    [lidarDensities, setParam],
  );
  // Deck reads a density-swapped copy of the dataset (only avLidarUrl differs); a
  // fresh object identity re-runs the layer memo → reloads the lidar archive →
  // re-registers it with the governor under the same source id (dataset.id).
  const datasetForDeck = useMemo<AvDataset | undefined>(() => {
    if (!dataset) return dataset;
    const tier = lidarDensityId
      ? lidarDensities.find((d) => d.id === lidarDensityId)
      : undefined;
    if (!tier) return dataset;
    // Denser tiers ship a smaller point radius so a HARD-dot cloud reads as
    // structure. Soft camera-colored SPLATS fade at their rim (gaussian alpha),
    // so those sub-pixel ultra/full radii nearly vanish — scale them up (×2) with
    // a floor so the dense tiers stay prominent. No effect on non-splat scenes.
    const splat = !!dataset.lidarSplat;
    const r = (v: number) => (splat ? Math.max(v * 2, 1.4) : v);
    const rMin = (v: number) => (splat ? Math.max(v * 2, 1.0) : v);
    return {
      ...dataset,
      avLidarUrl: `${sceneBaseUrl(dataset)}/${tier.url}`,
      ...(tier.radius != null ? { radius: r(tier.radius) } : {}),
      ...(tier.radiusMinPixels != null
        ? { radiusMinPixels: rMin(tier.radiusMinPixels) }
        : {}),
    };
  }, [dataset, lidarDensityId, lidarDensities]);
  // Referentially stable per scene: `CameraInset` keys a TimeController
  // subscription on it, so an inline arrow tore that listener down and
  // re-subscribed it on every cockpit render (inferred, not profiled).
  const resolveFrameUrl = useCallback(
    (rel: string) => (dataset ? `${sceneBaseUrl(dataset)}/${rel}` : rel),
    [dataset],
  );

  if (!dataset) {
    return (
      <div className="fixed inset-0 bg-slate-950 text-slate-300 flex flex-col items-center justify-center gap-3">
        <div className="text-lg font-medium">Unknown AV scene</div>
        <Link to="/drive" className="text-cyan-400 text-sm underline">
          Open the default cockpit
        </Link>
      </div>
    );
  }

  // Base-stable name so the switcher label doesn't flip as the render mode
  // swaps the active dataset to a `-splat` / `-surfel` bundle.
  const sceneName = baseDataset?.name ?? dataset.name;
  const hasTelemetry =
    presentStreams.includes('telemetry') &&
    telemetry != null &&
    Object.keys(telemetry.fields ?? {}).length > 0;
  const hasCamera = presentStreams.includes('camera') && cameras != null;

  // Shared transport props — fed to the bottom timeline in either layout, so
  // desktop and mobile drive the SAME TimeController + PlaybackGovernor.
  const timelineProps: TimelineProps | null = timeRange
    ? {
        currentTime: playback.currentTime,
        timeRange,
        isPlaying: playback.isPlaying,
        bufferState: playback.bufferState,
        governor: playback.governor,
        onPlayPause: playback.onPlayPause,
        onSeek: playback.onSeek,
        onSpeedChange: playback.onSpeedChange,
        currentSpeedMultiplier: playback.speedMultiplier,
        targetPlaybackSeconds: dataset.targetPlaybackSeconds ?? 20,
        autoSpeed: playback.autoSpeed,
        onAutoSpeedSelect: playback.onAutoSpeedSelect,
      }
    : null;

  return (
    <div
      className="fixed inset-0 bg-slate-950 overflow-hidden"
      // Tells the basemap's bottom-docked controls (attribution + logo, a
      // licensing requirement) how much floating chrome to clear. Only the
      // phone layout stacks anything across the full width — see index.css.
      style={
        { '--stt-bottom-chrome': `${bottomChrome}px` } as React.CSSProperties
      }
    >
      {/* The map fills the viewport; chrome floats over it. */}
      <div className="absolute inset-0">
        {renderer === 'three' ? (
          <AvThreeViewer
            dataset={datasetForDeck ?? dataset}
            timeController={playback.timeController}
            timeRange={timeRange}
            registry={playback.registry}
            visibleStreams={visibleStreams}
            egoFollow={egoFollow}
            topDown={topDown}
            perfMode={perfMode}
            reducedMotion={reducedMotion}
            sceneView={scene?.initialView ?? null}
            onSelectObject={setSelectedObject}
          />
        ) : (
          <AvDeck
            dataset={datasetForDeck ?? dataset}
            timeController={playback.timeController}
            visibleStreams={visibleStreams}
            registry={playback.registry}
            egoFollow={egoFollow}
            topDown={topDown}
            reducedMotion={reducedMotion}
            egoPath={egoPath}
            sceneView={scene?.initialView ?? null}
            onSelectObject={setSelectedObject}
            perfMode={perfMode}
            showBasemap={showBasemap}
            timeHeightScale={timeHeightScale}
            onCameraZoom={
              lidarRenderMode === 'lod' ? handleCameraZoom : undefined
            }
            show3DTiles={show3DTiles}
            googleTilesApiKey={GOOGLE_TILES_API_KEY}
            onTiles3dAttribution={setTiles3dAttribution}
            tiles3dElevationAdjust={tiles3dElevAdjust}
            tiles3dOpacity={tiles3dOpacity}
          />
        )}
      </div>

      {/* "Zoom LOD" HUD: which additive-octree levels are resident at the current
          camera zoom. The cloud is one archive where each return lives at a single
          home zoom; the engine loads the union [minZoom..floor(zoom)], so zooming
          in streams only the deeper residual. */}
      {lidarRenderMode === 'lod' &&
        renderer === 'deck' &&
        (() => {
          const tier = lidarDensities.find((d) => d.lod || d.id === 'lod');
          const lo = tier?.minZoom ?? 14;
          const hi = tier?.maxZoom ?? 19;
          const z = liveZoom ?? hi;
          const resident = Math.max(lo, Math.min(hi, Math.floor(z)));
          const nLevels = resident - lo + 1;
          return (
            <div className="pointer-events-none absolute bottom-24 left-3 z-20 rounded-md border border-cyan-300/20 bg-black/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-cyan-100 backdrop-blur-md">
              <div className="mb-0.5 text-cyan-300/90">ADDITIVE OCTREE LOD</div>
              <div>
                camera&nbsp;<span className="text-white">z{z.toFixed(1)}</span>
              </div>
              <div>
                resident&nbsp;
                <span className="text-white">
                  z{lo}–z{resident}
                </span>
                &nbsp;
                <span className="text-cyan-300/60">
                  ({nLevels}/{hi - lo + 1} levels)
                </span>
              </div>
              {tier?.points ? (
                <div className="text-cyan-300/60">
                  {(tier.points / 1e6).toFixed(1)}M returns · one home zoom each
                </div>
              ) : null}
              <div className="mt-1 max-w-[15rem] text-[10px] text-slate-300/70">
                zoom in → deeper levels stream in; the coarse tiles stay
                resident.
              </div>
            </div>
          );
        })()}

      {isMobile ? (
        <AvMobileChrome
          scene={scene}
          dataset={baseDataset ?? dataset}
          scenes={avScenes}
          sceneName={sceneName}
          timeController={playback.timeController}
          presentStreams={presentStreams}
          visibleStreams={visibleStreams}
          onToggleStream={toggleStream}
          objectColors={objectColors}
          telemetry={telemetry}
          hasTelemetry={hasTelemetry}
          cameras={cameras}
          hasCamera={hasCamera}
          resolveFrameUrl={resolveFrameUrl}
          egoFollow={egoFollow}
          onToggleEgoFollow={toggleEgoFollow}
          egoPath={egoPath}
          topDown={topDown}
          onToggleTopDown={toggleTopDown}
          perfMode={perfMode}
          onTogglePerfMode={togglePerfMode}
          showBasemap={showBasemap}
          onToggleBasemap={toggleBasemap}
          selectedObject={selectedObject}
          onCloseObject={() => setSelectedObject(null)}
          timeline={timelineProps}
          onBottomChromeHeight={setBottomChrome}
        />
      ) : (
        <>
          {/* Top-left: scene switcher + camera controls */}
          <div className="absolute top-3 left-3 flex flex-col gap-2">
            <SceneSwitcher
              scenes={avScenes}
              currentId={baseDataset?.id ?? dataset.id}
              sceneName={sceneName}
            />
            <div className="flex gap-2">
              {/* Follow / perspective⇄top-down — hidden in the Spacetime CUBE mode
              (ego-follow is gated off and the cube wants a free static orbit, so
              chasing the climbing ego worm / snapping top-down would fight it). */}
              {!cubeMode && (
                <>
                  <button
                    type="button"
                    onClick={toggleEgoFollow}
                    aria-pressed={egoFollow}
                    title={
                      egoPath
                        ? 'Recenter the camera on the vehicle'
                        : 'Ego-follow (scene has no ego polyline — camera holds)'
                    }
                    className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
                      egoFollow
                        ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
                        : 'border-white/10 bg-black/55 text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    Follow ego
                  </button>
                  <button
                    type="button"
                    onClick={toggleTopDown}
                    aria-pressed={topDown}
                    title="Toggle perspective / top-down view"
                    className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
                      topDown
                        ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
                        : 'border-white/10 bg-black/55 text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    {topDown ? 'Top-down' : 'Perspective'}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={togglePerfMode}
                aria-pressed={perfMode}
                title="Performance mode — render at 1× pixels with cheaper LIDAR fragments so the densest (ultra / raw) clouds stay smooth"
                className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
                  perfMode
                    ? 'border-amber-300/60 bg-amber-400/20 text-amber-100'
                    : 'border-white/10 bg-black/55 text-slate-300 hover:bg-white/5'
                }`}
              >
                ⚡ Perf
              </button>
              {/* Renderer backend — the deck.gl cockpit, or the Three.js + TSL
              (WebGPU) engine. The Three path runs the LIDAR cloud as oriented
              Gaussian surfels / billboard splats in a local metric frame. */}
              <button
                type="button"
                onClick={() =>
                  setRenderer((r) => (r === 'three' ? 'deck' : 'three'))
                }
                aria-pressed={renderer === 'three'}
                title="Switch between the deck.gl renderer and the Three.js + TSL (WebGPU) engine"
                className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
                  renderer === 'three'
                    ? 'border-fuchsia-300/60 bg-fuchsia-400/20 text-fuchsia-100'
                    : 'border-white/10 bg-black/55 text-slate-300 hover:bg-white/5'
                }`}
              >
                {renderer === 'three' ? 'TSL · WebGPU' : 'deck.gl'}
              </button>
              {/* Basemap on/off — only for geo-registered scenes (avLocalFrame scenes
              never draw a basemap). Lets the camera-colored surfel surface read
              against the dark backdrop instead of over Miami's streets. */}
              {!(datasetForDeck ?? dataset)?.avLocalFrame && (
                <button
                  type="button"
                  onClick={toggleBasemap}
                  aria-pressed={showBasemap}
                  title="Toggle the street basemap under the scene"
                  className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
                    showBasemap
                      ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
                      : 'border-white/10 bg-black/55 text-slate-300 hover:bg-white/5'
                  }`}
                >
                  {showBasemap ? 'Basemap' : 'No basemap'}
                </button>
              )}
              {/* Google Photorealistic 3D Tiles — only when the scene opts in
              (`dataset.tiles3d`), a key is configured, and the deck renderer is
              active. Loads Google's photoreal city mesh under the cloud as a
              backdrop. */}
              {tiles3dCapable && (
                <button
                  type="button"
                  onClick={toggle3DTiles}
                  aria-pressed={show3DTiles}
                  title="Overlay Google Photorealistic 3D Tiles (real city mesh) under the LIDAR cloud"
                  className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
                    show3DTiles
                      ? 'border-emerald-300/60 bg-emerald-400/20 text-emerald-100'
                      : 'border-white/10 bg-black/55 text-slate-300 hover:bg-white/5'
                  }`}
                >
                  3D Tiles
                </button>
              )}
              {/* LIDAR render mode — Points ⇄ Splat ⇄ Surfel. Kept INSIDE the button
              row (not a new row) so the top-left container's height stays fixed
              and never grows into the `top-28` STREAMS panel below. Each pill
              swaps the active dataset so the cloud re-renders in that mode (a
              camera-colored `-splat`/`-surfel` bundle when one exists, else an
              in-place render-only splat) without leaving the scene. */}
              {renderModes.length > 1 && (
                <div
                  role="radiogroup"
                  aria-label="LIDAR render mode"
                  className="flex overflow-hidden rounded-md border border-white/10 bg-black/55 backdrop-blur-md"
                >
                  {renderModes.map((m) => {
                    const active = m === lidarRenderMode;
                    return (
                      // A REAL radio, not a button with role="radio": the
                      // native input carries the checked state and arrow-key
                      // traversal of the group, which the button faked with
                      // aria-checked and never wired to a key handler.
                      <label
                        key={m}
                        title={`Render the LIDAR cloud as ${RENDER_MODE_LABELS[m].toLowerCase()}`}
                        className={`px-2.5 py-1 text-xs transition-colors cursor-pointer focus-within:ring-2 focus-within:ring-cyan-300/70 ${
                          active
                            ? 'bg-cyan-400/20 text-cyan-100'
                            : 'text-slate-300 hover:bg-white/5'
                        }`}
                      >
                        <input
                          type="radio"
                          name={renderModeGroup}
                          className="sr-only"
                          checked={active}
                          onChange={() => setLidarRenderMode(m)}
                        />
                        {RENDER_MODE_LABELS[m]}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            {/* Spacetime CUBE squash slider HELD BACK with the cube mode (the
            slider chip + this JSX are removed; `cubeMode` is always false).
            Re-add — copying DemoViewer's private `CubeControls` — to ship
            Spacetime. */}
          </div>

          {/* Left rail: stream list (below the switcher) */}
          {scene && (
            <div className="absolute top-28 left-3">
              <StreamPanel
                scene={scene}
                presentStreams={presentStreams}
                visibleStreams={visibleStreams}
                onToggleStream={toggleStream}
                objectColors={objectColors}
                lidarDensityId={lidarDensityId}
                onSelectLidarDensity={onSelectLidarDensity}
              />
            </div>
          )}

          {/* Top-right: camera inset */}
          {hasCamera && (
            <div className="absolute top-3 right-3">
              <CameraInset
                cameras={cameras!}
                resolveFrameUrl={resolveFrameUrl}
                timeController={playback.timeController}
              />
            </div>
          )}

          {/* Bottom-left: telemetry strip-charts (Cabana / XVIZ-Metrics style) */}
          {hasTelemetry && (
            <div className="absolute bottom-20 left-3">
              <MetricCharts
                telemetry={telemetry!}
                timeController={playback.timeController}
              />
            </div>
          )}

          {/* Bottom-right: picked-object inspector (renders nothing until a click) */}
          <div className="absolute bottom-20 right-3">
            <ObjectInspector
              object={selectedObject}
              onClose={() => setSelectedObject(null)}
              objectColors={objectColors}
            />
          </div>

          {/* Bottom: timeline transport */}
          {timelineProps && (
            <div className="absolute bottom-3 left-3 right-3 mx-auto max-w-4xl">
              <Timeline {...timelineProps} />
            </div>
          )}

          {/* Exit + scene meta (top-center) */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-3">
            <Link
              to="/demos"
              className="rounded-md border border-white/10 bg-black/55 backdrop-blur-md px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
            >
              ← Demos
            </Link>
          </div>
        </>
      )}

      {/* Google Photorealistic 3D Tiles credit (shown while the mesh is on):
          the data attribution Google's ToS requires — the union of the visible
          tiles' sources, reported by AvDeck. Centered above the timeline so it
          clears the corner telemetry / inspector panels. (The height/opacity
          sliders that used to sit here were removed; both still read from their
          URL params — see `tiles3dz` / `tiles3dop` above.) */}
      {show3DTiles && (
        <div className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2">
          <div className="pointer-events-none max-w-[80vw] truncate rounded bg-black/60 px-2 py-0.5 text-[10px] text-slate-300 backdrop-blur-md">
            {tiles3dAttribution || 'Google Photorealistic 3D Tiles'}
          </div>
        </div>
      )}

      {/* Loading / empty state */}
      {!scene && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="rounded-lg bg-black/60 backdrop-blur-md px-5 py-3 text-sm text-slate-300">
            Loading scene…
          </div>
        </div>
      )}
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="rounded-lg bg-black/70 backdrop-blur-md px-5 py-4 text-sm text-slate-300 max-w-sm text-center">
            <div className="font-medium text-slate-100 mb-1">
              Scene bundle not found
            </div>
            <div className="text-slate-400">
              The tiles for <code className="text-slate-300">{dataset.id}</code>{' '}
              aren&apos;t generated yet. Run the{' '}
              <code className="text-slate-300">av_synthetic.py</code> adapter to
              build them.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AvCockpit;
