/**
 * The live demo map surface: layer construction, space-time-cube overlays,
 * globe auto-rotation, and the in-map chrome (legend, cube controls, summary
 * toggle, perf HUD). Mounted by both the fullscreen viewer (`/demo/:id`) and
 * the per-demo landing-page embed (`/demos/:id`); playback state arrives via
 * the shared `useDemoPlayback` hook so the two surfaces cannot drift.
 */
import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import DeckGL from "@deck.gl/react";
import { _GlobeView as GlobeView } from "@deck.gl/core";
import { LineLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl";
import type { BufferSource } from "@stt/deck.gl";
import type { Dataset, SummaryToggleOption } from "../../types";
import Legend from "../Legend";
import PerformanceMonitor from "../PerformanceMonitor";
import { buildDemoLayers } from "./buildDemoLayers";
import type { DemoCamera } from "./HoverPreview";
import type { DemoPlayback } from "./useDemoPlayback";

const MAPBOX_ACCESS_TOKEN =
  (import.meta as any).env?.VITE_MAPBOX_TOKEN ||
  "pk.eyJ1IjoicmdjZ2VvZyIsImEiOiJjajBuNG1sMjUwMDFlMzNxcWY0M2RqMHI3In0.XfM0BMSqZqjRDcz-oJuadw";

/**
 * Minimal slice of @stt/core's Tile that the space-time-cube lattice needs.
 * Kept local so the showcase doesn't grow a direct @stt/core dependency for
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

export interface DemoViewerProps {
  dataset: Dataset;
  playback: DemoPlayback;
  /** Show the collapsed performance HUD chip (fullscreen viewer only). */
  showPerfHud?: boolean;
  /** false renders with controller off (embed tap-to-interact shield). */
  interactive?: boolean;
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
  onCameraChange,
}) => {
  const {
    timeController,
    tilesetRef,
    currentTime,
    overviewPreload,
    handleTilesetReady,
    handleBufferChange,
    handleOverviewPreload,
  } = playback;

  // Active option for summary-tier weight toggles (e.g. pickup vs dropoff).
  // Reset to the dataset's first option whenever the dataset changes.
  const summaryToggleOptions = selectedDataset.summaryToggleWeights;
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
    let prevSig = "";
    const poll = setInterval(() => {
      const tileset = tilesetRef.current as
        | (BufferSource & { getVisibleTiles?: () => LatticeTile[] })
        | null;
      const tiles = tileset?.getVisibleTiles?.();
      if (!tiles) return;
      const sig = tiles
        .map((t) => `${t.id.z}/${t.id.x}/${t.id.y}/${t.id.t}`)
        .sort()
        .join(",");
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
      buildDemoLayers({
        dataset: selectedDataset,
        timeController,
        useGlobe,
        timeHeightScale,
        activeSummaryToggle,
        plumbing: {
          onTilesetReady: handleTilesetReady,
          onBufferChange: handleBufferChange,
          onOverviewPreload: handleOverviewPreload,
          overviewPreload: true,
        },
      }),
    [
      selectedDataset,
      timeController,
      activeSummaryToggle,
      useGlobe,
      handleTilesetReady,
      handleBufferChange,
      handleOverviewPreload,
      timeHeightScale,
    ],
  );

  // Cube overlay layers: the tile lattice and the rising now-plane. Kept in a
  // SEPARATE memo from the data layers — these legitimately rebuild with the
  // 20 Hz `currentTime` UI state and the squash slider (tiny geometry), while
  // the data layers must NOT (their memo deliberately excludes currentTime).
  const cubeLayers = useMemo(() => {
    if (!timeHeight || timeHeightScale <= 0) return [];
    const origin = selectedDataset.timeRange.start;
    const clampT = (t: number) => Math.max(0, Math.min(rangeDurationMs, t - origin));
    const out: any[] = [];

    // Union of loaded tile footprints — reused as the now-plane extent.
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;

    // The loaded set mixes in the pinned z0–z1 storyboard-overview tiles,
    // whose world-spanning boxes would dwarf the city. The lattice tells the
    // streaming story at the zoom actually serving the viewport — the finest
    // level present.
    const latticeZ = latticeTiles.reduce((m, t) => Math.max(m, t.id.z), 0);
    const viewTiles = latticeTiles.filter((t) => t.id.z === latticeZ);

    if (viewTiles.length > 0) {
      const segments: { s: [number, number, number]; t: [number, number, number] }[] = [];
      for (const tile of viewTiles) {
        const { z, x, y } = tile.id;
        const n = 2 ** z;
        const lonW = (x / n) * 360 - 180;
        const lonE = ((x + 1) / n) * 360 - 180;
        const latN = tileLat(y, n);
        const latS = tileLat(y + 1, n);
        minLon = Math.min(minLon, lonW); maxLon = Math.max(maxLon, lonE);
        minLat = Math.min(minLat, latS); maxLat = Math.max(maxLat, latN);
        if (!showLattice) continue;
        const z0 = clampT(tile.timeRange.start) * timeHeightScale;
        const z1 = clampT(tile.timeRange.end) * timeHeightScale;
        const corners: [number, number][] = [
          [lonW, latS], [lonE, latS], [lonE, latN], [lonW, latN],
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
        out.push(
          new LineLayer({
            id: "stt-tile-lattice",
            data: segments,
            getSourcePosition: (d: any) => d.s,
            getTargetPosition: (d: any) => d.t,
            getColor: [31, 186, 214, 100],
            getWidth: 1,
            widthUnits: "pixels",
            pickable: false,
          }),
        );
      }
    }
    if (minLon > maxLon) {
      // No tiles yet — seed the plane around the camera target.
      const { longitude, latitude } = selectedDataset.initialViewState;
      minLon = longitude - 0.25; maxLon = longitude + 0.25;
      minLat = latitude - 0.2; maxLat = latitude + 0.2;
    }

    if (timeHeight.nowPlane !== false) {
      const zNow = clampT(currentTime) * timeHeightScale;
      const plane = [
        [minLon, minLat, zNow],
        [maxLon, minLat, zNow],
        [maxLon, maxLat, zNow],
        [minLon, maxLat, zNow],
      ];
      out.push(
        new SolidPolygonLayer({
          id: "cube-now-plane",
          data: [plane],
          getPolygon: (d: any) => d,
          filled: true,
          getFillColor: [31, 186, 214, 22],
          pickable: false,
          // The plane is a reference surface — it must tint, not occlude, the
          // threads it intersects.
          parameters: { depthWriteEnabled: false } as any,
        }),
      );
    }
    return out;
  }, [
    selectedDataset,
    timeHeight,
    timeHeightScale,
    latticeTiles,
    showLattice,
    currentTime,
    rangeDurationMs,
  ]);

  const views = useMemo(
    () =>
      useGlobe ? [new GlobeView({ id: "globe", resolution: 10 })] : undefined,
    [useGlobe],
  );
  const initialViewState = useMemo((): any => {
    if (useGlobe) return { globe: selectedDataset.initialViewState };
    // maxPitch is a MapState view-state constraint (not a controller option):
    // cube demos want to look down the time axis from above the 60° default.
    return selectedDataset.timeHeight
      ? {
          ...selectedDataset.initialViewState,
          maxPitch: selectedDataset.timeHeight.maxPitch ?? 85,
        }
      : selectedDataset.initialViewState;
  }, [selectedDataset, useGlobe]);

  // Slow globe auto-rotation. When a dataset opts in (useGlobe + autoRotate) we
  // take over the view state so a requestAnimationFrame loop can nudge the
  // longitude each frame. As soon as the user interacts (drag/zoom fires
  // onViewStateChange) we stop the spin for good and hand the globe over — the
  // demo is for exploring, so it shouldn't keep spinning out from under a click.
  // Non-rotating demos keep the uncontrolled `initialViewState` path untouched.
  const autoRotate = useGlobe && (selectedDataset.autoRotate ?? false);
  const [viewState, setViewState] = useState<any>(null);
  const rotateStoppedRef = useRef(false);
  useEffect(() => {
    setViewState(initialViewState);
    rotateStoppedRef.current = false;
  }, [initialViewState]);
  useEffect(() => {
    if (!autoRotate) return;
    let raf = 0;
    let last: number | null = null;
    // Negative spins east→west (wind-following); very slow (~6 min/revolution).
    const DEG_PER_SEC = -1;
    const step = (now: number) => {
      if (rotateStoppedRef.current) return; // user took over — stop spinning
      const dt = last == null ? 0 : (now - last) / 1000;
      last = now;
      setViewState((vs: any) => {
        const cur = vs?.globe ?? vs;
        if (!cur) return vs;
        const longitude = ((cur.longitude + DEG_PER_SEC * dt + 540) % 360) - 180;
        return { globe: { ...cur, longitude } };
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate]);

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

  return (
    <div className="w-full h-full map-viewport">
      <DeckGL
        {...(autoRotate
          ? { viewState: viewState ?? initialViewState }
          : { initialViewState })}
        onViewStateChange={handleViewStateChange}
        onResize={handleResize}
        controller={interactive}
        layers={cubeLayers.length > 0 ? [...layers, ...cubeLayers] : layers}
        views={views}
        parameters={useGlobe ? ({ cull: true } as any) : undefined}
      >
        {!useGlobe && (
          <Map
            reuseMaps
            mapStyle="mapbox://styles/mapbox/dark-v11"
            mapboxAccessToken={MAPBOX_ACCESS_TOKEN}
            projection={{ name: "mercator" }}
            terrain={
              selectedDataset.use3D
                ? { source: "mapbox-dem", exaggeration: 1.5 }
                : undefined
            }
            onLoad={(evt) => {
              const map = evt.target;
              if (selectedDataset.use3D && !map.getSource("mapbox-dem")) {
                map.addSource("mapbox-dem", {
                  type: "raster-dem",
                  url: "mapbox://mapbox.mapbox-terrain-dem-v1",
                  tileSize: 512,
                  maxzoom: 14,
                });
              }
            }}
          />
        )}
      </DeckGL>

      {/* Legend */}
      {selectedDataset.legend && (
        <div className="absolute bottom-3 right-3">
          <Legend legend={selectedDataset.legend} />
        </div>
      )}

      {/* Space-time cube controls: squash slider + tile-lattice toggle. */}
      {timeHeight && (
        <div className="absolute top-3 left-3">
          <CubeControls
            heightFactor={heightFactor}
            onHeightFactor={setHeightFactor}
            showLattice={showLattice}
            onShowLattice={
              timeHeight.tileLattice !== false ? setShowLattice : undefined
            }
          />
        </div>
      )}

      {/* Summary-tier weight toggle (pickup ↔ dropoff style). */}
      {summaryToggleOptions && summaryToggleOptions.length > 1 && (
        <div className="absolute top-3 left-3">
          <SummaryToggle
            options={summaryToggleOptions}
            value={activeSummaryToggle?.id}
            onChange={setSummaryToggleId}
          />
        </div>
      )}

      {/* Perf HUD (collapsed chip; top-right because the Legend owns the
          bottom-right corner). Carries the storyboard-preload outcome. */}
      {showPerfHud && (
        <PerformanceMonitor anchor="top-right" overviewPreload={overviewPreload} />
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
}> = ({ heightFactor, onHeightFactor, showLattice, onShowLattice }) => {
  return (
    <div
      className="rounded px-3 py-2 flex flex-col gap-1.5"
      style={{
        background: "rgba(36, 39, 48, 0.95)",
        border: "1px solid #3A414C",
        minWidth: 170,
      }}
    >
      <div
        className="text-[10px] font-semibold tracking-widest"
        style={{ color: "#A0A7B4" }}
      >
        TIME = HEIGHT
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px]" style={{ color: "#6B7280" }}>
          flat
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(heightFactor * 100)}
          onChange={(e) => onHeightFactor(Number(e.target.value) / 100)}
          className="flex-1"
          style={{ accentColor: "#1FBAD6" }}
          aria-label="Time-as-height squash factor"
        />
        <span className="text-[10px]" style={{ color: "#6B7280" }}>
          cube
        </span>
      </div>
      {onShowLattice && (
        <label
          className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none"
          style={{ color: "#A0A7B4" }}
        >
          <input
            type="checkbox"
            checked={showLattice}
            onChange={(e) => onShowLattice(e.target.checked)}
            style={{ accentColor: "#1FBAD6" }}
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
    <div
      className="inline-flex items-center rounded overflow-hidden"
      style={{ background: "rgba(36, 39, 48, 0.95)", border: "1px solid #3A414C" }}
      role="group"
      aria-label="Summary weight"
    >
      {options.map((opt, i) => {
        const active = opt.id === value;
        const swatch =
          opt.legendColors?.[opt.legendColors.length - 2] ??
          opt.legendColors?.[opt.legendColors.length - 1] ??
          "#1FBAD6";
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className="px-3 py-1.5 text-xs transition-colors flex items-center gap-1.5"
            style={{
              background: active ? "#1FBAD6" : "transparent",
              color: active ? "#000" : "#A0A7B4",
              borderRight:
                i < options.length - 1 ? "1px solid #3A414C" : undefined,
            }}
            aria-pressed={active}
          >
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: swatch }}
            />
            <span className="font-semibold leading-tight">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
};
