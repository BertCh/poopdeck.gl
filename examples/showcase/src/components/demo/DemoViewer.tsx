/**
 * The live demo map surface: layer construction, space-time-cube overlays,
 * globe auto-rotation, and the in-map chrome (legend, cube controls, summary
 * toggle, perf HUD). Mounted by both the fullscreen viewer (`/demo/:id`) and
 * the per-demo landing-page embed (`/demos/:id`); playback state arrives via
 * the shared `useDemoPlayback` hook so the two surfaces cannot drift.
 */
import React, {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import DeckGL from '@deck.gl/react';
import { _GlobeView as GlobeView } from '@deck.gl/core';
import { LineLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { Map, useControl } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { BufferSource } from '@poopdeck.gl/playback';
import type { Dataset, SummaryToggleOption } from '../../types';
import Legend from '../Legend';
import PerformanceMonitor from '../PerformanceMonitor';
import { buildDemoLayers } from './buildDemoLayers';
import { MAX_SAFE_PITCH } from './cameraLimits';
import type { DemoCamera } from './previewBasemap';
import { useDeckClock } from '@poopdeck.gl/react';
import type { PlaybackState } from '@poopdeck.gl/react';
import { useReducedMotion } from '../../lib/reducedMotion';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MAPBOX_ACCESS_TOKEN } from '../../lib/mapboxToken';

/**
 * Minimal slice of @poopdeck.gl/core's Tile that the space-time-cube lattice needs.
 * Kept local so the showcase doesn't grow a direct @poopdeck.gl/core dependency for
 * one overlay.
 */
interface LatticeTile {
  id: { z: number; x: number; y: number; t: number };
  timeRange: { start: number; end: number };
}

/** North-edge latitude of slippy-map tile row `y` at zoom with `n = 2^z` tiles. */
function tileLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}

/**
 * deck-inside-mapbox bridge for the `basemapTerrain` path: an INTERLEAVED
 * `MapboxOverlay` renders the deck layers inside the map's own frame, sharing
 * its terrain-aware projection and depth buffer — data with real z sits exactly
 * on the relief and is occluded behind ridges, neither of which the classic
 * deck-over-map compositing can do. `interleaved` is a construction-time
 * setting; everything else (layers, the `useDeckClock` trio) flows through
 * `setProps` every render, exactly like spreading onto `<DeckGL>` — Deck
 * accepts `userData`/`_animate`/`onBeforeRender` directly, so the shared
 * playback clock works unchanged on this path.
 */
function DeckGLOverlay(props: Record<string, unknown>) {
  const overlay = useControl<MapboxOverlay>(
    () => new MapboxOverlay({ ...props, interleaved: true }),
  );
  overlay.setProps(props);
  return null;
}

/**
 * Per-dataset basemap tuning shared by BOTH render paths: hide labels (all
 * symbol layers), sink the base/land fills to a near-black backdrop, and darken
 * the road/street lines, leaving water geometry for context. Type-based (not
 * layer-id) so it survives Mapbox style revisions; property differs per layer
 * type.
 */
function applyBasemapTuning(map: any, selectedDataset: Dataset): void {
  const hideLabels = selectedDataset.basemapHideLabels;
  const bg = selectedDataset.basemapBackgroundColor;
  const roadColor = selectedDataset.basemapRoadColor;
  if (!hideLabels && !bg && !roadColor) return;
  try {
    for (const layer of map.getStyle().layers ?? []) {
      if (hideLabels && layer.type === 'symbol') {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
      }
      if (bg) {
        if (layer.type === 'background') {
          map.setPaintProperty(layer.id, 'background-color', bg);
        } else if (layer.type === 'fill' && /land|earth/i.test(layer.id)) {
          map.setPaintProperty(layer.id, 'fill-color', bg);
        }
      }
      if (
        roadColor &&
        layer.type === 'line' &&
        /road|street|bridge|tunnel/i.test(layer.id)
      ) {
        map.setPaintProperty(layer.id, 'line-color', roadColor);
      }
    }
  } catch {
    // A style without the expected layers → leave the basemap as-is.
  }
}

/**
 * Anti-sink lift for terrain-draped dots, metres. With the interleaved depth
 * buffer a dot centred exactly ON the surface has half its disk clipped by the
 * slope behind it; a small constant lift keeps it legible. Sub-pixel at the
 * national zooms the ballet demos play at (~0.15 px/m even at z13).
 */
const TERRAIN_DOT_LIFT_M = 15;

/**
 * The embed's tap-to-interact shield, map-owned-camera edition: the classic
 * path passes `controller={false}` to deck; on the terrain path the map owns
 * the camera, so every mapbox interaction handler is switched off instead.
 */
const NONINTERACTIVE_MAP_PROPS = {
  dragPan: false,
  dragRotate: false,
  scrollZoom: false,
  boxZoom: false,
  doubleClickZoom: false,
  keyboard: false,
  touchZoomRotate: false,
  touchPitch: false,
} as const;

export interface DemoViewerProps {
  dataset: Dataset;
  playback: PlaybackState;
  /** Show the collapsed performance HUD chip (fullscreen viewer only). */
  showPerfHud?: boolean;
  /** false renders with controller off (embed tap-to-interact shield). */
  interactive?: boolean;
  /**
   * Push the top-left in-map controls (space-time cube / summary toggle) down
   * by N px so a host's floating header — the full-bleed fullscreen viewer —
   * doesn't overlap them. Default 0 (the embed frame has no floating header).
   */
  topLeftInset?: number;
  /**
   * Push the bottom-right legend up by N px so a host's floating transport bar
   * — which on phone widths spans the full width — doesn't cover it. Default 0
   * (the embed frame's transport sits BELOW the map, not on it).
   */
  bottomInset?: number;
  /**
   * Observe the live camera (for the scrubber hover-preview deck). Fired on
   * mount with the initial camera and on every user view-state change. Passing
   * it does NOT take control of the camera — the uncontrolled `initialViewState`
   * path is preserved; we only read what deck reports.
   */
  onCameraChange?: (camera: DemoCamera) => void;
}

const DemoViewer: React.FC<DemoViewerProps> = ({
  dataset: selectedDataset,
  playback,
  showPerfHud = false,
  interactive = true,
  topLeftInset = 0,
  bottomInset = 0,
  onCameraChange,
}) => {
  // Phone widths get collapsed in-map chips: a legend that opens on tap
  // instead of a permanently-parked card, and a narrower cube panel.
  const isMobile = useIsMobile();
  const {
    timeController,
    isPlaying,
    tilesetRef,
    currentTime,
    overviewPreload,
    registry,
    handleOverviewPreload,
    governor,
  } = playback;

  // Drive the shared playhead from deck's render loop (one frame clock, no
  // second rAF) and mirror the controller onto `context.userData.stt` so every
  // STT layer resolves time with no per-layer `timeController` prop.
  const deckClock = useDeckClock(timeController, isPlaying);

  // Active option for summary-tier weight toggles (e.g. pickup vs dropoff).
  // Reset to the dataset's first option whenever the dataset changes.
  const summaryToggleOptions =
    'summaryToggleWeights' in selectedDataset
      ? selectedDataset.summaryToggleWeights
      : undefined;
  const [summaryToggleId, setSummaryToggleId] = useState<string | undefined>(
    summaryToggleOptions?.[0]?.id,
  );
  useEffect(() => {
    setSummaryToggleId(summaryToggleOptions?.[0]?.id);
  }, [summaryToggleOptions]);
  const activeSummaryToggle: SummaryToggleOption | undefined = useMemo(() => {
    if (!summaryToggleOptions) return undefined;
    return (
      summaryToggleOptions.find((o) => o.id === summaryToggleId) ??
      summaryToggleOptions[0]
    );
  }, [summaryToggleOptions, summaryToggleId]);

  // Projection follows the dataset's tuned default (no user toggle in the
  // shipped UI). Globe-default demos (e.g. ocean currents) stay on the globe.
  const useGlobe = selectedDataset.useGlobe ?? false;

  // The viewer's reduced-motion preference. Read once here (reactive hook) and
  // threaded into buildDemoLayers so the motion-glide point path degrades to
  // the discrete render for viewers who asked the OS to reduce motion; the
  // globe auto-rotation effect below reads the same value.
  const reducedMotion = useReducedMotion();

  // ── Terrain basemap (`basemapTerrain` demos, Mercator viewer only) ────────
  // These demos render on the INTERLEAVED path (see DeckGLOverlay) and drape
  // their moving dots onto the relief with a per-frame height probe backed by
  // mapbox `queryTerrainElevation`. The probe must exist BEFORE the layers
  // memo below, which threads it into `buildDemoLayers`.
  const terrainEnabled =
    !useGlobe &&
    !selectedDataset.hideBasemap &&
    Boolean(selectedDataset.basemapTerrain);
  const terrainExaggeration =
    typeof selectedDataset.basemapTerrain === 'object'
      ? (selectedDataset.basemapTerrain.exaggeration ?? 1.5)
      : 1.5;
  const [terrainMap, setTerrainMap] = useState<any>(null);
  // Bumped on map idle: terrain DEM tiles land asynchronously, so a probe
  // answer for the same (lon, lat) refines over time. The bump (a) rebuilds
  // the probe closure, dropping its memo cache, and (b) rides into the layer
  // props so a PAUSED frame re-drapes (while playing, renderLayers runs every
  // frame anyway and 'idle' rarely fires).
  const [terrainRevision, setTerrainRevision] = useState(0);
  useEffect(() => {
    // Demo switched away from the terrain path — drop the map handle so the
    // probe memo can't outlive its map instance.
    if (!terrainEnabled && terrainMap) setTerrainMap(null);
  }, [terrainEnabled, terrainMap]);
  const getTerrainElevation = useMemo(() => {
    if (!terrainEnabled || !terrainMap) return null;
    // Baked-elevation archives carry their z in the tiles (vertexValues
    // channel) — no runtime probe, and no layer-array churn on map idle.
    if (selectedDataset.elevationFromVertexValues) return null;
    // Probe answers memoized on ~1e-4° cells (≤ 11 m at 47°N): sub-pixel at
    // the zooms these demos play at, and it turns the per-dot-per-frame
    // queryTerrainElevation traffic into cache hits for slow movers. Rebuilt
    // (cache dropped) on every terrainRevision bump as DEM coverage refines.
    // (`globalThis.Map`: the bare name is shadowed by react-map-gl's <Map>.)
    const cache = new globalThis.Map<number, number>();
    void terrainRevision;
    return (lon: number, lat: number): number | null => {
      const key = Math.round(lon * 1e4) * 4_000_000 + Math.round(lat * 1e4);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const z = terrainMap.queryTerrainElevation([lon, lat], {
        exaggerated: true,
      });
      if (z == null) return null; // DEM not resident here — don't cache unknowns
      if (cache.size > 200_000) cache.clear();
      const lifted = z + TERRAIN_DOT_LIFT_M;
      cache.set(key, lifted);
      return lifted;
    };
  }, [terrainEnabled, terrainMap, terrainRevision, selectedDataset]);

  // ── Space-time cube (time = height) ────────────────────────────────────────
  // `heightFactor` is the squash slider: 0 = flat map, 1 = full cube. It feeds
  // a single shader uniform (timeHeightScale, meters per sim-ms), so dragging
  // it morphs the city into the cube with zero data re-upload.
  const timeHeight = selectedDataset.timeHeight;
  const [heightFactor, setHeightFactor] = useState(1);
  const [showLattice, setShowLattice] = useState(true);
  useEffect(() => {
    setHeightFactor(timeHeight?.initialFactor ?? 1);
    setShowLattice(timeHeight?.tileLattice !== false);
  }, [selectedDataset, timeHeight]);
  const rangeDurationMs =
    selectedDataset.timeRange.end - selectedDataset.timeRange.start || 1;
  const timeHeightScale = timeHeight
    ? (heightFactor * timeHeight.rangeHeightMeters) / rangeDurationMs
    : 0;

  // STT tile lattice: every loaded tile is literally a box in (x, y, t) — its
  // slippy-tile footprint × its temporal bucket. Poll the tileset's loaded
  // set on a slow cadence (tile arrivals are bursty but the set is small) and
  // re-render only when membership changes, so the cube visibly fills in
  // box-by-box as the loader streams.
  const [latticeTiles, setLatticeTiles] = useState<LatticeTile[]>([]);
  useEffect(() => {
    setLatticeTiles([]);
    if (!timeHeight) return;
    let prevSig = '';
    const poll = setInterval(() => {
      const tileset = tilesetRef.current as
        | (BufferSource & { getVisibleTiles?: () => LatticeTile[] })
        | null;
      const tiles = tileset?.getVisibleTiles?.();
      if (!tiles) return;
      const sig = tiles
        .map((t) => `${t.id.z}/${t.id.x}/${t.id.y}/${t.id.t}`)
        .sort()
        .join(',');
      if (sig === prevSig) return;
      prevSig = sig;
      setLatticeTiles(
        tiles.map((t) => ({ id: { ...t.id }, timeRange: { ...t.timeRange } })),
      );
    }, 300);
    return () => clearInterval(poll);
  }, [selectedDataset, timeHeight, tilesetRef]);

  // Data-layer tree. Built by the shared `buildDemoLayers` helper so the
  // scrubber's hover-preview deck renders the exact same layers and cannot
  // drift from the live view. `currentTime` is deliberately NOT a dependency:
  // the layer pulls live time from the shared TimeController on every draw, and
  // including currentTime here rebuilt the prop tree every tick (60Hz), which
  // forced deck.gl to invalidate the trip consolidation cache and re-copy ~10M
  // vertex positions per frame on the NYC taxi dataset.
  const layers = useMemo(
    () =>
      // No `timeController` prop: the layers resolve it from
      // `context.userData.stt.timeController`, which `deckClock` sets on the
      // DeckGL surface below. This is the P1 "layers see time for free" path.
      buildDemoLayers({
        dataset: selectedDataset,
        useGlobe,
        timeHeightScale,
        activeSummaryToggle,
        reducedMotion,
        getTerrainElevation,
        terrainRevision,
        plumbing: {
          registry,
          onOverviewPreload: handleOverviewPreload,
          overviewPreload: true,
        },
      }),
    [
      selectedDataset,
      activeSummaryToggle,
      useGlobe,
      registry,
      handleOverviewPreload,
      timeHeightScale,
      reducedMotion,
      getTerrainElevation,
      terrainRevision,
    ],
  );

  // Cube overlay, part 1: the STT tile lattice and the ground extent it
  // defines. Deliberately does NOT depend on `currentTime` — a loaded tile's
  // box is fixed by its (x, y, t) address and the squash factor, so the
  // wireframe only changes when the loaded set or the slider does.
  //
  // It used to share one memo with the now-plane below, which DID depend on
  // `currentTime`. That rebuilt the whole `segments` array (12 edges per
  // loaded tile) and constructed a fresh LineLayer 20×/sec; because `data` was
  // a new array each time, deck.gl re-ran attribute generation and re-uploaded
  // the lattice's vertex buffers on every UI tick, for geometry that had not
  // moved. Splitting the memos keeps the LineLayer instance — and therefore
  // its attributes — alive across ticks.
  const cubeLattice = useMemo((): {
    layer: any | null;
    bounds: [number, number, number, number];
  } => {
    const fallback = (): [number, number, number, number] => {
      // No tiles yet — seed the plane around the camera target.
      const { longitude, latitude } = selectedDataset.initialViewState;
      return [
        longitude - 0.25,
        latitude - 0.2,
        longitude + 0.25,
        latitude + 0.2,
      ];
    };
    if (!timeHeight || timeHeightScale <= 0) {
      return { layer: null, bounds: fallback() };
    }
    const origin = selectedDataset.timeRange.start;
    const clampT = (t: number) =>
      Math.max(0, Math.min(rangeDurationMs, t - origin));

    // Union of loaded tile footprints — reused as the now-plane extent.
    let minLon = Infinity,
      minLat = Infinity,
      maxLon = -Infinity,
      maxLat = -Infinity;

    // The loaded set mixes in the pinned z0–z1 storyboard-overview tiles,
    // whose world-spanning boxes would dwarf the city. The lattice tells the
    // streaming story at the zoom actually serving the viewport — the finest
    // level present.
    const latticeZ = latticeTiles.reduce((m, t) => Math.max(m, t.id.z), 0);
    const viewTiles = latticeTiles.filter((t) => t.id.z === latticeZ);

    let layer: any = null;
    if (viewTiles.length > 0) {
      const segments: {
        s: [number, number, number];
        t: [number, number, number];
      }[] = [];
      for (const tile of viewTiles) {
        const { z, x, y } = tile.id;
        const n = 2 ** z;
        const lonW = (x / n) * 360 - 180;
        const lonE = ((x + 1) / n) * 360 - 180;
        const latN = tileLat(y, n);
        const latS = tileLat(y + 1, n);
        minLon = Math.min(minLon, lonW);
        maxLon = Math.max(maxLon, lonE);
        minLat = Math.min(minLat, latS);
        maxLat = Math.max(maxLat, latN);
        if (!showLattice) continue;
        const z0 = clampT(tile.timeRange.start) * timeHeightScale;
        const z1 = clampT(tile.timeRange.end) * timeHeightScale;
        const corners: [number, number][] = [
          [lonW, latS],
          [lonE, latS],
          [lonE, latN],
          [lonW, latN],
        ];
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          // Bottom edge, top edge, vertical pillar — 12 edges per box total.
          segments.push({ s: [a[0], a[1], z0], t: [b[0], b[1], z0] });
          segments.push({ s: [a[0], a[1], z1], t: [b[0], b[1], z1] });
          segments.push({ s: [a[0], a[1], z0], t: [a[0], a[1], z1] });
        }
      }
      if (segments.length > 0) {
        layer = new LineLayer({
          id: 'stt-tile-lattice',
          data: segments,
          getSourcePosition: (d: any) => d.s,
          getTargetPosition: (d: any) => d.t,
          getColor: [31, 186, 214, 100],
          getWidth: 1,
          widthUnits: 'pixels',
          pickable: false,
        });
      }
    }
    return {
      layer,
      bounds: minLon > maxLon ? fallback() : [minLon, minLat, maxLon, maxLat],
    };
  }, [
    selectedDataset,
    timeHeight,
    timeHeightScale,
    latticeTiles,
    showLattice,
    rangeDurationMs,
  ]);

  // Cube overlay, part 2: the rising now-plane. This one genuinely rides the
  // 10 Hz `currentTime` UI clock — but it is a single quad, so rebuilding it
  // per tick is free.
  const nowPlaneLayer = useMemo(() => {
    if (!timeHeight || timeHeightScale <= 0) return null;
    if (timeHeight.nowPlane === false) return null;
    const origin = selectedDataset.timeRange.start;
    const zNow =
      Math.max(0, Math.min(rangeDurationMs, currentTime - origin)) *
      timeHeightScale;
    const [minLon, minLat, maxLon, maxLat] = cubeLattice.bounds;
    return new SolidPolygonLayer({
      id: 'cube-now-plane',
      data: [
        [
          [minLon, minLat, zNow],
          [maxLon, minLat, zNow],
          [maxLon, maxLat, zNow],
          [minLon, maxLat, zNow],
        ],
      ],
      getPolygon: (d: any) => d,
      filled: true,
      getFillColor: [31, 186, 214, 22],
      pickable: false,
      // The plane is a reference surface — it must tint, not occlude, the
      // threads it intersects.
      parameters: { depthWriteEnabled: false } as any,
    });
  }, [
    selectedDataset,
    timeHeight,
    timeHeightScale,
    cubeLattice,
    currentTime,
    rangeDurationMs,
  ]);

  // One stable array for deck. `layers` alone (the common case — no cube
  // overlay) keeps its identity across UI ticks, and deck.gl's LayerManager
  // short-circuits an identical `layers` reference entirely, so a non-cube
  // demo does no layer matching at all on the 10 Hz UI clock.
  const allLayers = useMemo(() => {
    if (!cubeLattice.layer && !nowPlaneLayer) return layers;
    const out = [...layers];
    if (cubeLattice.layer) out.push(cubeLattice.layer);
    if (nowPlaneLayer) out.push(nowPlaneLayer);
    return out;
  }, [layers, cubeLattice, nowPlaneLayer]);

  const views = useMemo(
    () =>
      useGlobe ? [new GlobeView({ id: 'globe', resolution: 10 })] : undefined,
    [useGlobe],
  );
  const initialViewState = useMemo((): any => {
    if (useGlobe) return { globe: selectedDataset.initialViewState };
    // maxPitch is a MapState view-state constraint (not a controller option):
    // cube demos want to look down the time axis from above the 60° default.
    // The fallback is 70, not 85: at deck's default `altitude: 1.5` the top
    // screen ray clears the horizon at pitch 71.57°, `unproject` then returns
    // a ground point behind the camera, and the viewport lon/lat box the tile
    // loader selects against inverts — zero tiles on the latitude axis, a
    // near-whole-world column span on the longitude axis
    // (docs/roadmap/tile-loading-3d-2026-07.md §1/§4). The chassis repairs a
    // bad box now; this ceiling keeps every timeHeight demo out of the band in
    // the first place. Raising it back needs §4 read first.
    return selectedDataset.timeHeight
      ? {
          ...selectedDataset.initialViewState,
          maxPitch: selectedDataset.timeHeight.maxPitch ?? 70,
        }
      : selectedDataset.initialViewState;
  }, [selectedDataset, useGlobe]);

  // Slow globe auto-rotation. When a dataset opts in (useGlobe + autoRotate) we
  // take over the view state so a requestAnimationFrame loop can nudge the
  // longitude each frame. As soon as the user interacts (drag/zoom fires
  // onViewStateChange) we stop the spin for good and hand the globe over — the
  // demo is for exploring, so it shouldn't keep spinning out from under a click.
  // Non-rotating demos keep the uncontrolled `initialViewState` path untouched.
  // Auto-rotation is opt-in per dataset, but reduce-motion always wins (see the
  // `reducedMotion` read near the top): the globe stays put (and draggable)
  // instead of spinning on its own.
  const autoRotate = useGlobe && (selectedDataset.autoRotate ?? false);
  const [viewState, setViewState] = useState<any>(null);
  const rotateStoppedRef = useRef(false);
  useEffect(() => {
    setViewState(initialViewState);
    rotateStoppedRef.current = false;
  }, [initialViewState]);
  useEffect(() => {
    if (!autoRotate || reducedMotion) return;
    let raf = 0;
    let last: number | null = null;
    // Negative spins east→west (wind-following); very slow (~6 min/revolution).
    const DEG_PER_SEC = -1;
    const step = (now: number) => {
      if (rotateStoppedRef.current) return; // user took over — stop spinning
      if (last != null && now - last < 33) {
        raf = requestAnimationFrame(step);
        return;
      }
      const dt = last == null ? 0 : (now - last) / 1000;
      last = now;
      setViewState((vs: any) => {
        const cur = vs?.globe ?? vs;
        if (!cur) return vs;
        const longitude =
          ((cur.longitude + DEG_PER_SEC * dt + 540) % 360) - 180;
        return { globe: { ...cur, longitude } };
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate, reducedMotion]);

  // ── Camera reporting (scrubber hover-preview) ──────────────────────────────
  // The preview deck mirrors whatever the user is looking at, so we forward the
  // live camera AND viewport pixel size up (the size lets the preview match the
  // exact ground extent, not just re-center). Observing `onViewStateChange`
  // does NOT take control of the uncontrolled `initialViewState` path (only
  // passing `viewState` would); the autoRotate path already drives `viewState`,
  // so we just piggy-back. Camera and size arrive on separate deck callbacks,
  // so we keep both in refs and emit the merged snapshot from either.
  const cameraRef = useRef<any>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const emitCamera = useCallback(() => {
    const vs = cameraRef.current;
    if (!onCameraChange || !vs) return;
    onCameraChange({
      longitude: vs.longitude,
      latitude: vs.latitude,
      zoom: vs.zoom,
      pitch: vs.pitch,
      bearing: vs.bearing,
      viewportWidth: sizeRef.current?.width,
      viewportHeight: sizeRef.current?.height,
    });
  }, [onCameraChange]);
  // Seed the preview with the starting camera before any user interaction.
  useEffect(() => {
    cameraRef.current = selectedDataset.initialViewState;
    emitCamera();
  }, [emitCamera, selectedDataset]);
  const handleViewStateChange = useCallback(
    (e: any) => {
      if (autoRotate) {
        rotateStoppedRef.current = true;
        setViewState({ globe: e.viewState });
      }
      cameraRef.current = e.viewState;
      emitCamera();
    },
    [autoRotate, emitCamera],
  );
  const handleResize = useCallback(
    (size: { width: number; height: number }) => {
      sizeRef.current = size;
      emitCamera();
    },
    [emitCamera],
  );

  // Per-source runway probe for the perf HUD (pure read; the monitor polls it
  // only while expanded). Stable per governor instance so the HUD's poll
  // effect doesn't churn across playback frames.
  const getSourceRunways = useCallback(
    () => governor?.getSourceRunways() ?? [],
    [governor],
  );

  // A no-basemap demo has nothing behind the transparent deck canvas, so the
  // backdrop has to come from the container.
  const hideBasemap = Boolean(selectedDataset.hideBasemap) && !useGlobe;

  // ── Terrain-path map handlers ──────────────────────────────────────────────
  // On this path the MAP owns the camera (deck renders inside it), so the
  // scrubber hover-preview camera/size reporting hangs off map events instead
  // of the DeckGL callbacks the classic path uses.
  const handleTerrainMapLoad = useCallback(
    (evt: any) => {
      const map = evt.target;
      if (!map.getSource('mapbox-dem')) {
        map.addSource('mapbox-dem', {
          type: 'raster-dem',
          url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
          tileSize: 512,
          maxzoom: 14,
        });
      }
      // Subtle hillshade so the relief reads even face-on — the dark styles
      // ship no terrain shading of their own, and 3D silhouettes alone vanish
      // at low pitch. Its OWN raster-dem source: sharing the terrain's source
      // between setTerrain and a hillshade layer is a known mapbox-gl footgun.
      // Inserted below the first line/symbol layer so roads stay legible.
      try {
        if (!map.getSource('stt-hillshade-dem')) {
          map.addSource('stt-hillshade-dem', {
            type: 'raster-dem',
            url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
            tileSize: 512,
            maxzoom: 14,
          });
        }
        if (!map.getLayer('stt-hillshade')) {
          const styleLayers = map.getStyle().layers ?? [];
          const before = styleLayers.find(
            (l: any) => l.type === 'line' || l.type === 'symbol',
          )?.id;
          map.addLayer(
            {
              id: 'stt-hillshade',
              type: 'hillshade',
              source: 'stt-hillshade-dem',
              paint: {
                'hillshade-exaggeration': 0.55,
                'hillshade-shadow-color': '#000000',
                'hillshade-highlight-color': '#26354c',
                'hillshade-accent-color': '#000000',
              },
            },
            before,
          );
        }
      } catch {
        // Style without the expected layers — the relief still shows in 3D.
      }
      applyBasemapTuning(map, selectedDataset);
      const container = map.getContainer?.();
      if (container) {
        sizeRef.current = {
          width: container.clientWidth,
          height: container.clientHeight,
        };
      }
      setTerrainMap(map);
    },
    [selectedDataset],
  );
  const handleTerrainMove = useCallback(
    (evt: any) => {
      cameraRef.current = evt.viewState;
      emitCamera();
    },
    [emitCamera],
  );
  const handleTerrainIdle = useCallback(() => {
    // DEM coverage refined (or an interaction settled) — invalidate the probe
    // cache and nudge the layers so paused frames re-drape. See terrainRevision.
    // Baked-elevation demos don't use the probe; skip the churn entirely.
    if (selectedDataset.elevationFromVertexValues) return;
    setTerrainRevision((r) => r + 1);
  }, [selectedDataset]);
  const handleTerrainResize = useCallback(
    (evt: any) => {
      const container = evt?.target?.getContainer?.();
      if (container) {
        sizeRef.current = {
          width: container.clientWidth,
          height: container.clientHeight,
        };
        emitCamera();
      }
    },
    [emitCamera],
  );

  return (
    <div
      className="w-full h-full map-viewport"
      style={
        hideBasemap
          ? { background: selectedDataset.backdropColor ?? '#0a0f16' }
          : undefined
      }
    >
      {terrainEnabled ? (
        // ── Interleaved terrain path (`basemapTerrain` demos) ─────────────
        // The MAP owns the camera; deck renders inside its frame via the
        // MapboxOverlay control, sharing the terrain-aware projection and
        // depth buffer (dots sit ON the relief, occluded behind ridges).
        // A keyed, non-reused map so `onLoad` (dem source + hillshade +
        // tuning + probe handle) reliably runs for every mount.
        <Map
          key={selectedDataset.id}
          initialViewState={initialViewState}
          maxPitch={(initialViewState as any)?.maxPitch ?? MAX_SAFE_PITCH}
          style={{ width: '100%', height: '100%' }}
          mapStyle={
            selectedDataset.basemapStyle ?? 'mapbox://styles/mapbox/dark-v11'
          }
          mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
          projection={{ name: 'mercator' }}
          terrain={{
            source: 'mapbox-dem',
            exaggeration: terrainExaggeration,
          }}
          onLoad={handleTerrainMapLoad}
          onMove={handleTerrainMove}
          onIdle={handleTerrainIdle}
          onResize={handleTerrainResize}
          {...(!interactive && NONINTERACTIVE_MAP_PROPS)}
        >
          <DeckGLOverlay {...deckClock} layers={allLayers} />
        </Map>
      ) : (
        <DeckGL
          {...(autoRotate
            ? { viewState: viewState ?? initialViewState }
            : { initialViewState })}
          {...deckClock}
          onViewStateChange={handleViewStateChange}
          onResize={handleResize}
          controller={interactive}
          layers={allLayers}
          views={views}
          parameters={useGlobe ? ({ cull: true } as any) : undefined}
        >
          {!useGlobe && !hideBasemap && (
            <Map
              reuseMaps
              mapStyle={
                selectedDataset.basemapStyle ??
                'mapbox://styles/mapbox/dark-v11'
              }
              mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
              projection={{ name: 'mercator' }}
              terrain={
                selectedDataset.use3D
                  ? { source: 'mapbox-dem', exaggeration: 1.5 }
                  : undefined
              }
              onLoad={(evt) => {
                const map = evt.target;
                if (selectedDataset.use3D && !map.getSource('mapbox-dem')) {
                  map.addSource('mapbox-dem', {
                    type: 'raster-dem',
                    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
                    tileSize: 512,
                    maxzoom: 14,
                  });
                }
                applyBasemapTuning(map, selectedDataset);
              }}
            />
          )}
        </DeckGL>
      )}

      {/* Legend. On a phone it collapses to a tap-to-open pill and is lifted
          clear of the host's full-width transport bar (see bottomInset). */}
      {selectedDataset.legend && (
        <div
          className="absolute right-3"
          style={{
            // On a phone the same bottomInset has just lifted the basemap's
            // attribution row to sit directly under this corner, so clear it
            // too: a 24px control plus mapbox's own 10px margin.
            bottom: 12 + bottomInset + (isMobile ? 34 : 0),
            maxWidth: 'calc(100% - 1.5rem)',
          }}
        >
          <Legend legend={selectedDataset.legend} collapsible={isMobile} />
        </div>
      )}

      {/* Space-time cube controls: squash slider + tile-lattice toggle. */}
      {timeHeight && (
        <div
          className="absolute left-3 right-3 sm:right-auto"
          style={{ top: 12 + topLeftInset }}
        >
          <CubeControls
            heightFactor={heightFactor}
            onHeightFactor={setHeightFactor}
            showLattice={showLattice}
            onShowLattice={
              timeHeight.tileLattice !== false ? setShowLattice : undefined
            }
            compact={isMobile}
          />
        </div>
      )}

      {/* Summary-tier weight toggle (pickup ↔ dropoff style). */}
      {summaryToggleOptions && summaryToggleOptions.length > 1 && (
        <div
          className="absolute left-3 max-w-[calc(100%-1.5rem)]"
          style={{ top: 12 + topLeftInset }}
        >
          <SummaryToggle
            options={summaryToggleOptions}
            value={activeSummaryToggle?.id}
            onChange={setSummaryToggleId}
          />
        </div>
      )}

      {/* Perf HUD (collapsed chip; top-right because the Legend owns the
          bottom-right corner). Carries the storyboard-preload outcome plus the
          per-source runway rows (starvation made observable). */}
      {showPerfHud && (
        <PerformanceMonitor
          anchor="top-right"
          // Desktop's floating header is top-LEFT only, so the HUD keeps the
          // corner; the phone bar spans the full width and must be cleared.
          topInset={isMobile ? topLeftInset : 0}
          overviewPreload={overviewPreload}
          getSourceRunways={getSourceRunways}
        />
      )}
    </div>
  );
};

export default DemoViewer;

/**
 * Space-time-cube control chip: the "squash" slider morphs between the flat
 * map (0) and the full time-as-height cube (1) — it drives one shader
 * uniform, so dragging it is free. The lattice checkbox toggles the
 * loaded-STT-tile wireframe overlay.
 */
const CubeControls: React.FC<{
  heightFactor: number;
  onHeightFactor: (f: number) => void;
  showLattice: boolean;
  onShowLattice?: (show: boolean) => void;
  /** Phone layout: the panel spans the gutter instead of a fixed 170px box. */
  compact?: boolean;
}> = ({
  heightFactor,
  onHeightFactor,
  showLattice,
  onShowLattice,
  compact = false,
}) => {
  return (
    <div
      className="rounded px-3 py-2 flex flex-col gap-1.5"
      style={{
        background: 'rgba(36, 39, 48, 0.95)',
        border: '1px solid #3A414C',
        // A fixed min-width plus a full-width phone gutter would overflow the
        // map; let it be the gutter instead.
        minWidth: compact ? undefined : 170,
      }}
    >
      <div
        className="text-[10px] font-semibold tracking-widest"
        style={{ color: '#A0A7B4' }}
      >
        TIME = HEIGHT
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px]" style={{ color: '#6B7280' }}>
          flat
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(heightFactor * 100)}
          onChange={(e) => onHeightFactor(Number(e.target.value) / 100)}
          className="flex-1"
          style={{ accentColor: '#1FBAD6' }}
          aria-label="Time-as-height squash factor"
        />
        <span className="text-[10px]" style={{ color: '#6B7280' }}>
          cube
        </span>
      </div>
      {onShowLattice && (
        <label
          className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none"
          style={{ color: '#A0A7B4' }}
        >
          <input
            type="checkbox"
            checked={showLattice}
            onChange={(e) => onShowLattice(e.target.checked)}
            style={{ accentColor: '#1FBAD6' }}
          />
          STT tile lattice
        </label>
      )}
    </div>
  );
};

/**
 * Pickup/dropoff segmented control for summary-tier demos. Sits above the
 * map and swaps the H3SummaryLayer's weight column + ramp in place. Coloured
 * dots come from the first entry of each option's legendColors so the active
 * option visually matches the legend ramp on the opposite corner.
 */
const SummaryToggle: React.FC<{
  options: SummaryToggleOption[];
  value: string | undefined;
  onChange: (next: string) => void;
}> = ({ options, value, onChange }) => {
  return (
    // A <fieldset> rather than a div with role="group": the segmented toggle is
    // a set of form controls, so the native grouping element carries the
    // semantics (browser border/padding reset off, ours kept).
    <fieldset
      className="inline-flex items-center rounded overflow-hidden m-0 p-0 min-w-0"
      style={{
        background: 'rgba(36, 39, 48, 0.95)',
        border: '1px solid #3A414C',
      }}
      aria-label="Summary weight"
    >
      {options.map((opt, i) => {
        const active = opt.id === value;
        const swatch =
          opt.legendColors?.[opt.legendColors.length - 2] ??
          opt.legendColors?.[opt.legendColors.length - 1] ??
          '#1FBAD6';
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className="px-3 py-1.5 text-xs transition-colors flex items-center gap-1.5"
            style={{
              background: active ? '#1FBAD6' : 'transparent',
              color: active ? '#000' : '#A0A7B4',
              borderRight:
                i < options.length - 1 ? '1px solid #3A414C' : undefined,
            }}
            aria-pressed={active}
          >
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: swatch }}
            />
            <span className="font-semibold leading-tight truncate">
              {opt.label}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
};
