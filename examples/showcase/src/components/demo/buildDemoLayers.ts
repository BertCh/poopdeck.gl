/**
 * Shared data-layer builder for the live demo map AND the scrubber's hover
 * preview. Extracted verbatim from DemoViewer's `layers` memo so the two
 * surfaces render the same layer types + styling and cannot drift: the live
 * viewer calls this with the real governor/overview plumbing, and HoverPreview
 * calls it with empty plumbing + a flat (timeHeightScale 0) frozen controller.
 *
 * The space-time-cube OVERLAY layers (tile lattice, now-plane) deliberately
 * stay in DemoViewer — they ride the 20 Hz UI clock and are not part of the
 * dataset's own layer tree.
 */
import { SolidPolygonLayer } from '@deck.gl/layers';
import {
  AnimatedPointLayer,
  AnimatedPointCloudLayer,
  AnimatedPathLayer,
  AnimatedTripsLayer,
  FlowCorridorLayer,
  FlowStrokeLayer,
  AnimatedPolygonLayer,
  AnimatedHeatmapLayer,
  H3SummaryLayer,
  QuadbinSummaryLayer,
  AnimatedArcLayer,
  AnimatedColumnLayer,
  AnimatedTripHeadsLayer,
  FlowmapLayer,
  BundledFlowmapLayer,
  AnimatedBoundingBoxLayer,
  SplatLayer,
  ChevronFlowExtension,
} from '@poopdeck.gl/layers';
import type {
  HeatmapChannelSpec,
  OverviewPreloadResult,
} from '@poopdeck.gl/layers';
import type {
  BufferSource,
  BufferedRunway,
  TimeController,
} from '@poopdeck.gl/playback';
import { resolvePlaybackParams } from '@poopdeck.gl/playback';
import { tileLoadingProps } from '../../types';
import type { Dataset, SummaryToggleOption } from '../../types';

/**
 * luma.gl v9 render parameters for a FLAT GROUND DECAL — the AV HD-map
 * substrate (drivable-area / lane / crosswalk polygons + lane-divider lines).
 * nuScenes ships these as many OVERLAPPING, semi-transparent polygons all at
 * z=0; with normal depth testing the coplanar fragments fight for the depth
 * buffer and flicker as the camera moves. `depthCompare: 'always'` lets every
 * fragment pass (so the overlaps just alpha-composite in painter's order), and
 * `depthWriteEnabled: false` keeps the flat map out of the depth buffer so the
 * 3D content drawn ABOVE it (LIDAR cloud / object boxes) still depth-tests
 * correctly among itself. Same idiom as edge-bundler.ts's offscreen passes.
 */
const GROUND_DECAL_PARAMETERS = {
  depthCompare: 'always' as const,
  depthWriteEnabled: false,
};

/**
 * luma.gl v9 ADDITIVE-GLOW blend for the GLM lightning flash points: color
 * accumulates (`src-alpha`/`one`) instead of alpha-compositing, so overlapping
 * splat-shaped flashes SUM — isolated strikes read as faint sparks while
 * convective cores stack into a white-hot glow. This one point layer replaces
 * the old AnimatedHeatmapLayer density backdrop, whose per-frame re-aggregation
 * over a second copy of the full tileset was the demo's dominant cost (the
 * additive accumulation IS the density signal now). Module-scope so the
 * parameters object identity is stable across layer-list rebuilds.
 */
const LIGHTNING_ADDITIVE_PARAMETERS = {
  blendColorOperation: 'add' as const,
  blendColorSrcFactor: 'src-alpha' as const,
  blendColorDstFactor: 'one' as const,
  blendAlphaOperation: 'add' as const,
  blendAlphaSrcFactor: 'one' as const,
  blendAlphaDstFactor: 'one-minus-src-alpha' as const,
};

/**
 * Flash-point color shared by the standalone `lightning` demo and the
 * `weather` composite — MUST stay equal to the '#deecff' legend swatch both
 * dataset entries declare (datasets.ts), or the legend lies about the render.
 */
const LIGHTNING_FLASH_COLOR: [number, number, number, number] = [
  222, 236, 255, 255,
];

/**
 * The weather composite's de-emphasized flash-radius transform (the standalone
 * demo's lives on its dataset entry: sqrt(e)·0.12 into [1.2, 7]; the composite
 * shrinks lightning to an accent under the precip field). Module-scope on
 * purpose: AnimatedPointLayer's prepared-tile styleKey keys on function
 * IDENTITY, so an inline closure here would re-prepare every lightning tile
 * whenever the layer list is rebuilt.
 */
const WEATHER_LIGHTNING_RADIUS_TRANSFORM = (e: number) =>
  Math.max(1, Math.min(6, Math.sqrt(e) * 0.11));

/**
 * Categorical colors for the WPC frontal-analysis polylines AND their pip
 * polygons, keyed on the archives' shared `render_class` (NOT `front_type`:
 * wpc_fronts.py pre-splits each stationary front into alternating chunks so
 * the classic red/blue STNRY notation is a plain categorical mapping).
 * Troughs are pre-dashed at build time (paper-map convention, geographic
 * dashes) and carry no pips; the tan stays translucent so they read as
 * secondary structure under the storm layers. The cold/warm hexes are
 * legend-pinned in datasets.ts (#4084f0 / #e64038).
 */
const WEATHER_FRONT_COLORS: Record<string, [number, number, number, number]> = {
  COLD: [64, 132, 240, 235],
  WARM: [230, 64, 56, 235],
  OCFNT: [168, 88, 196, 235],
  STNRY_COLD: [64, 132, 240, 235],
  STNRY_WARM: [230, 64, 56, 235],
  TROF: [216, 168, 100, 185],
};

/**
 * Fronts fade duration (sim-ms). WPC analyses are 3-hourly and each feature's
 * end time is padded by EXACTLY this much at build time (wpc_fronts.py
 * --fade-pad-min), so the outgoing analysis ramps 1→0 while its successor
 * ramps 0→1 over the same span — a constant-alpha cross-dissolve instead of
 * the abutting-fade luminance dip. Change both sides together.
 */
const WEATHER_FRONT_FADE_MS = 2700000; // 45 sim-min

// ─── storm4d composite constants ─────────────────────────────────────────
// (docs/roadmap/storm-4d-greenfield-2026-07.md §9 — the binding contract.)

/**
 * The ONE shared vertical exaggeration for the storm4d scene (§9.0), applied
 * to EVERY altitude-bearing layer — volume gates (`alt_m`), cloud-top canopy
 * (`top_alt_m`), multi-level winds (`level_alt_m`), sounding ascent
 * (`alt_m`), couplet markers (`alt_m`), and the fixed 12 km warning prisms —
 * so a 10 km echo top, the anvil above it, and the prism walls all agree.
 * Mixed per-layer scales would make the scene lie about vertical structure.
 */
const STORM4D_ELEVATION_SCALE = 4;

/**
 * Height-graded alpha range for the CAPPI iso-line stack
 * (`stormVolumeMode: 'isolines'`), in RAW metres MSL — the archive's CAPPI
 * levels run 1 → 15 km. Ground sheets keep their band alpha; the anvil-level
 * sheets fade toward `elevationOpacityFar` so the stack stays readable from
 * above instead of the top sheet acting as a lid.
 */
const STORM4D_ISO_TOP_FADE_RANGE: [number, number] = [1000, 15000];

/**
 * Cross-dissolve span (sim-ms) between consecutive CAPPI iso-line scans.
 * BINDING: `nexrad_isolines.py --fade-ms` pads every contour's validity past
 * the NEXT scan's start by exactly this much, so the outgoing scan ramps 1→0
 * over the same span its successor ramps 0→1 — constant alpha through the
 * handoff. Change one side and the volume scans either blink or double up.
 */
const STORM4D_ISO_FADE_MS = 90000;

/**
 * Time window (sim-ms) for the iso-line layer ALONE — deliberately ~nothing.
 * The archive carries per-feature validity `[scan, next scan + fade]`, so the
 * playhead needs no window of its own to keep a scan on screen; a wide one
 * (like the dataset's 360 s, which the instantaneous point overlays DO need)
 * would stack two or three scans of contours on top of each other.
 */
const STORM4D_ISO_TIME_WINDOW_MS = 1000;

/**
 * Tile-SELECTION window (sim-ms) for the iso-line layer — deliberately much
 * wider than its render window. The tileset refreshes its visible set at most
 * every ~100 ms of wall clock, so selecting on a 1 s sim window would go stale
 * between refreshes and the layer would draw nothing (the baked-frame-sequence
 * failure `tileLoadTimeWindow` exists for).
 *
 * It also has to out-reach the archive's bucketing: `stt-build` files a feature
 * in the bucket of its START time only (`chunk_by_temporal_bucket`), while a
 * contour stays VALID for its whole ~6.4 min scan interval — so the bucket
 * holding the currently-drawn scan can be two buckets behind the playhead.
 * ±10 min covers that with margin; the RENDER window still shows exactly one
 * scan, because features are filtered individually on the GPU.
 */
const STORM4D_ISO_TILE_WINDOW_MS = 1200000;

/**
 * VTEC warning prism height in METRES (pre-exaggeration): a fixed 12 km —
 * roughly the storm's echo-top depth — so the prism walls enclose the whole
 * volume (§7 Q4 resolved: fixed, not echo-top-derived, for v1).
 */
const STORM4D_WARNING_HEIGHT_M = 12000;

/**
 * Warning prism fills by VTEC `phenom` — translucent walls under a constant
 * wireframe. TO red / SV amber / FF green (§9.2).
 */
const STORM4D_WARNING_COLORS: Record<string, [number, number, number, number]> =
  {
    TO: [255, 70, 70, 46],
    SV: [255, 190, 60, 36],
    FF: [80, 220, 120, 36],
  };

/**
 * Cloud-top "anvil canopy" fills by `bt_band` (§9.1 labels, 10 K isobands of
 * GOES C13 brightness temperature). Colder = higher = brighter/bluer, all
 * very translucent so the stacked band walls read as haze the volume pokes
 * through rather than an opaque lid.
 */
const STORM4D_CLOUDTOP_COLORS: Record<
  string,
  [number, number, number, number]
> = {
  '270-280': [70, 90, 120, 22],
  '260-270': [85, 110, 145, 26],
  '250-260': [100, 130, 170, 30],
  '240-250': [120, 155, 195, 34],
  '230-240': [145, 180, 215, 38],
  '220-230': [175, 205, 232, 44],
  '210-220': [205, 225, 244, 50],
  '200-210': [230, 242, 252, 58],
  '<200': [250, 252, 255, 66],
};

/**
 * Cloud-top canopy render parameters: keep the translucent EXTRUDED isobands
 * OUT of the depth buffer (`depthWriteEnabled: false`) so their overlapping
 * prism walls blend as pure haze instead of z-fighting. Depth TEST stays on
 * (default `depthCompare`), so already-drawn opaque geometry still occludes the
 * haze; because the canopy no longer writes depth, the gate VOLUME drawn AFTER
 * it reads cleanly THROUGH the anvil — the §9.1 "volume pokes through the haze"
 * intent, now literal. Same idiom as GROUND_DECAL_PARAMETERS, minus the
 * `depthCompare:'always'` (we WANT the canopy to sit behind foreground
 * geometry). Module-scope for stable object identity across layer-list rebuilds.
 *
 * The tile-seam artefact this used to also paper over — the tile grid printed
 * through the canopy as full-height curtains — is fixed at the source now:
 * AnimatedPolygonLayer no longer walls the synthetic edges the tiler laid along
 * tile boundaries (`seamWalls`, default false). Depth-write stays off for the
 * genuine overlapping-band blending it was always needed for.
 */
const STORM4D_CANOPY_PARAMETERS = { depthWriteEnabled: false };

/**
 * Vertical thickness (RAW metres, before STORM4D_ELEVATION_SCALE) of each
 * cloud-top isoband shell — `AnimatedPolygonLayer.elevationThickness`, so the
 * band spans `[top_alt_m − this, top_alt_m]` instead of rising from the ground.
 *
 * Sized against the band SPACING, not the scene: `goes_cloudtop.py`'s
 * piecewise BT→height curve puts the warm bands ~1,540 m apart and the three
 * coldest (215/205/195 K band-mids) only ~500 m apart, so anything at or above
 * ~500 m would fuse the anvil core into one block. 300 m keeps every shell
 * separate while still catching enough light on its walls to read as a plate
 * rather than a decal (×4 exaggeration ⇒ ~1.2 km on screen).
 */
const STORM4D_CANOPY_SHELL_M = 300;

/**
 * Storm-report fills by LSR `kind` (§9.1). Tornado reports pop red against
 * the dark map; hail ice-blue, wind gusts amber, damage orange, flood blue.
 */
const STORM4D_REPORT_COLORS: Record<string, [number, number, number, number]> =
  {
    tornado: [255, 64, 64, 250],
    hail: [170, 225, 255, 235],
    wind: [255, 200, 90, 235],
    damage: [255, 140, 60, 240],
    flood: [90, 150, 255, 235],
    other: [180, 180, 190, 210],
  };

/**
 * Surface-station fills by `gust_band` (§9.1 labels). Calm sites recede as
 * faint grey context; the band brightens toward the severe-gust reds so the
 * gust front reads as a wave of warming dots crossing the mesonet.
 */
const STORM4D_GUST_COLORS: Record<string, [number, number, number, number]> = {
  calm: [150, 155, 165, 90],
  breezy: [190, 205, 160, 160],
  windy: [250, 210, 90, 210],
  severe: [255, 140, 60, 240],
  extreme: [255, 60, 60, 255],
};

/**
 * Station dot radius from `gust_kt` (kt → px). Module-scope: the point
 * layer's prepared-tile styleKey keys on function IDENTITY (see
 * WEATHER_LIGHTNING_RADIUS_TRANSFORM), so an inline closure would re-prepare
 * every tile whenever the layer list rebuilds.
 */
const STORM4D_STATION_RADIUS_TRANSFORM = (gustKt: number) =>
  Math.max(1.5, Math.min(9, gustKt * 0.13));

/** Report marker radius from LSR `magnitude` (hail inches / gust kt / 0). */
const STORM4D_REPORT_RADIUS_TRANSFORM = (mag: number) =>
  Math.max(2.5, Math.min(8, 2.5 + mag * 0.08));

/** Couplet ring radius from `strength_ms` (peak gate-to-gate Δv, ≥30 m/s). */
const STORM4D_COUPLET_RADIUS_TRANSFORM = (dv: number) =>
  Math.max(6, Math.min(18, dv * 0.22));

const EARTH_POLYGON: number[][][] = [
  [
    [-180, 90],
    [0, 90],
    [180, 90],
    [180, -90],
    [0, -90],
    [-180, -90],
  ],
];

/**
 * Per-source registration API the app (the governor owner) hands down so that
 * EVERY layer in a composite is classified into the {@link PlaybackGovernor}'s
 * N-source registry, not just the field. This is Phase 0 of multi-source
 * coordination (docs/roadmap/playback-and-loading.md §5): the clock must
 * wait for every *required* source, while *optional* overlays load but never
 * gate (continue-and-degrade). Keyed by each layer's deck.gl `id`.
 *
 * The governor owner implements:
 *   registerSource(id, tileset, {required}) → governor.addSource(id, tileset, {required})
 *   unregisterSource(id)                    → governor.removeSource(id)
 *   onBufferChange(id, runway)              → governor.notifyBufferChange(runway)
 *     (the governor re-probes all sources itself; the runway arg is advisory.)
 */
export interface DemoSourceRegistry {
  registerSource: (
    id: string,
    tileset: BufferSource,
    opts?: { required?: boolean; weight?: number },
  ) => void;
  unregisterSource: (id: string) => void;
  onBufferChange: (id: string, runway: BufferedRunway) => void;
}

/**
 * Governor/overview callbacks the LIVE viewer wires through. The hover preview
 * passes none of these — it is a throwaway static render, not part of the
 * buffering machine.
 */
export interface DemoLayerPlumbing {
  /**
   * Multi-source registration API. When present, EACH layer's tileset is
   * registered as a classified governor source (field/primary = required,
   * overlays = optional). Preferred over the legacy single-source pair below.
   */
  registry?: DemoSourceRegistry;
  /**
   * @deprecated Legacy single-source plumbing (one shared field tileset → the
   * governor). Superseded by {@link DemoSourceRegistry}. Still honored when
   * `registry` is absent so callers can migrate independently; a caller passing
   * both gets the registry path (these are ignored).
   */
  onTilesetReady?: (tileset: BufferSource) => void;
  /** @deprecated See {@link DemoLayerPlumbing.onTilesetReady}. */
  onBufferChange?: (runway: BufferedRunway) => void;
  onOverviewPreload?: (result: OverviewPreloadResult) => void;
  /** Pin the coarse z0–z1 storyboard tiles (live viewer only). @default false */
  overviewPreload?: boolean;
}

export interface BuildDemoLayersArgs {
  dataset: Dataset;
  /**
   * The clock the layers read live time from (the shared one, or a frozen
   * preview one). Optional: omit it to have the layers resolve the controller
   * from `context.userData.stt.timeController` instead — the deck-idiomatic
   * global channel set by {@link useDeckClock}. The frozen-preview and
   * AV-cockpit surfaces pass it explicitly; the main live viewer relies on
   * userData so no per-layer prop is threaded.
   */
  timeController?: TimeController;
  useGlobe: boolean;
  /** Space-time-cube height scale (meters per sim-ms); 0 = flat. */
  timeHeightScale: number;
  /** Active summary-tier weight toggle, if the dataset declares one. */
  activeSummaryToggle?: SummaryToggleOption;
  plumbing?: DemoLayerPlumbing;
  /**
   * The viewer's `prefers-reduced-motion` setting, threaded from
   * `useReducedMotion()` by the live viewer AND the hover preview. Folded into
   * the concrete `interpolate` boolean the motion-glide point path receives, so
   * a reduced-motion viewer gets the discrete (non-gliding) render. Defaults to
   * false (motion allowed) for callers that don't thread it (e.g. AV cockpit).
   */
  reducedMotion?: boolean;
  /**
   * Fill-rate "performance mode" (AV cockpit). When true, the heavy LIDAR layer
   * trades a little fidelity for frame rate so the densest tiers (e.g. the
   * "ultra" raw cloud) stay smooth: raw dots render OPAQUE + non-antialiased
   * (depth-tested opaque writes early-z-reject occluded fragments, no per-frag
   * blend), and surfel disks discard faint rims sooner (higher `alphaCutoff`,
   * less overdraw). Pairs with `useDevicePixels={false}` at the DeckGL level —
   * see {@link AvDeck}. Off by default; only the `av` case reads it. @default false
   */
  perfMode?: boolean;
}

export function buildDemoLayers({
  dataset: selectedDataset,
  timeController,
  useGlobe,
  timeHeightScale,
  activeSummaryToggle,
  plumbing,
  perfMode = false,
  reducedMotion = false,
}: BuildDemoLayersArgs) {
  const {
    registry,
    onTilesetReady: legacyOnTilesetReady,
    onBufferChange: legacyOnBufferChange,
    onOverviewPreload,
    overviewPreload = false,
  } = plumbing ?? {};

  // Per-layer governor plumbing. Each layer registers ITS OWN tileset under its
  // deck.gl id with a role-based `required` flag (field/primary = required,
  // overlays = optional). When the app supplies a `registry`, that is the
  // multi-source path; otherwise we fall back to the legacy single-source pair
  // (which only the REQUIRED field carries) so un-migrated callers keep working.
  const sourceProps = (
    layerId: string,
    required: boolean,
  ): {
    onTilesetReady?: (tileset: BufferSource) => void;
    onBufferChange?: (runway: BufferedRunway) => void;
  } => {
    if (registry) {
      return {
        onTilesetReady: (tileset: BufferSource) =>
          registry.registerSource(layerId, tileset, { required }),
        onBufferChange: (runway: BufferedRunway) =>
          registry.onBufferChange(layerId, runway),
      };
    }
    // Legacy single-source fallback: only the REQUIRED (field/primary) layer
    // talks to the governor, exactly as before this wave. Overlays get nothing.
    return required
      ? {
          onTilesetReady: legacyOnTilesetReady,
          onBufferChange: legacyOnBufferChange,
        }
      : { onTilesetReady: undefined, onBufferChange: undefined };
  };

  const datasetDuration =
    selectedDataset.timeRange.end - selectedDataset.timeRange.start;
  // Cumulative ("draw and persist") datasets reveal progressively in the
  // shader, so the tile loader must keep every played-through bucket
  // resident. A symmetric window of 2× the dataset duration guarantees the
  // loader's [t-w/2, t+w/2] always covers the whole [start, end] range — at
  // metro/viewport scale this loads the visible city's tiles once and retains
  // them. Non-cumulative datasets keep their per-dataset rolling window.
  const isCumulative = !!selectedDataset.cumulative;
  const authoredTimeWindow = isCumulative
    ? datasetDuration * 2
    : selectedDataset.timeWindow || 86400000;
  // Single derivation path: resolvePlaybackParams pins the ONE baseSpeed
  // formula (span / targetPlaybackSeconds / 1000), ending the historical split
  // between calculateAnimationSpeed's ÷30 (the real, user-visible clock speed)
  // and this builder's ÷60. That ÷60 only ever fed the PREFETCH budget
  // (tileLoadingProps below), never the visible clock — so to keep every demo's
  // prefetch horizon byte-identical we preserve the 60s fallback explicitly for
  // datasets that don't author `targetPlaybackSeconds` (the resolver's own
  // default is 30). No archive metadata is available in this builder — the
  // tileset loads it async and BufferSource carries none — and the resolver has
  // no `cumulative` notion, so timeWindow is computed locally and passed through
  // as an override; params.timeWindow echoes it back unchanged. `wakeLength` is
  // deliberately NOT threaded: the resolver would raise timeWindow to
  // 2×wakeLength (the ship-traffic wake fix), a behavior change out of scope for
  // this behavior-preserving wiring (tracked as a followup + by the
  // dataset-archive-reconcile test).
  const { baseSpeed: playbackSpeed, timeWindow } = resolvePlaybackParams(
    undefined,
    {
      targetPlaybackSeconds: selectedDataset.targetPlaybackSeconds || 60,
      timeWindow: authoredTimeWindow,
      timeRange: selectedDataset.timeRange,
    },
  );

  // Number of DISTINCT archive-backed tilesets this call instantiates for the
  // active dataset (each layer owns its own tileset + cache, even where two
  // layers read one manifest; stacked heatmap channels share ONE tileset, so
  // they count once). Feeds the composite cache-budget scaling in baseProps.
  const archiveCount = (() => {
    switch (selectedDataset.type) {
      case 'trips':
        return 1 + (selectedDataset.headsOverlayUrl ? 1 : 0);
      case 'polygon':
        return (
          1 +
          (selectedDataset.riversUrl && selectedDataset.riversConfig ? 1 : 0)
        );
      case 'radar':
        return (
          1 +
          (selectedDataset.radarTracksUrl ? 1 : 0) +
          (selectedDataset.radarCellsUrl ? 1 : 0)
        );
      case 'weather':
        return (
          1 +
          (selectedDataset.windUrl ? 1 : 0) +
          (selectedDataset.radarTracksUrl ? 1 : 0) +
          (selectedDataset.radarCellsUrl ? 1 : 0) +
          (selectedDataset.lightningUrl ? 1 : 0) +
          (selectedDataset.frontsUrl ? 1 : 0) +
          (selectedDataset.frontsPipsUrl ? 1 : 0)
        );
      case 'storm4d':
        // Volume + nine context overlays = 10 tilesets with the full
        // storm-4d-greenfield entry (§9.2: archiveCount storm4d = 10).
        return (
          1 +
          (selectedDataset.outagesUrl ? 1 : 0) +
          (selectedDataset.cloudTopUrl ? 1 : 0) +
          (selectedDataset.wind3dUrl ? 1 : 0) +
          (selectedDataset.warningsUrl ? 1 : 0) +
          (selectedDataset.coupletUrl ? 1 : 0) +
          (selectedDataset.stationsUrl ? 1 : 0) +
          (selectedDataset.reportsUrl ? 1 : 0) +
          (selectedDataset.lightningUrl ? 1 : 0) +
          (selectedDataset.soundingUrl ? 1 : 0)
        );
      case 'av': {
        // Spacetime cube early-returns ONE tracks layer; otherwise the HD-map
        // substrate + the LIDAR branch (scene-split stage+actors = 2) + boxes.
        if (selectedDataset.avCube && selectedDataset.avTracksUrl) return 1;
        const lidarLayers =
          selectedDataset.lidarStage &&
          selectedDataset.avStaticUrl &&
          selectedDataset.avDynamicUrl
            ? 2
            : selectedDataset.avLidarUrl
              ? 1
              : 0;
        return Math.max(
          1,
          (selectedDataset.avMapPolyUrl ? 1 : 0) +
            (selectedDataset.avMapLineUrl ? 1 : 0) +
            lidarLayers +
            (selectedDataset.avObjectsUrl ? 1 : 0),
        );
      }
      default:
        return 1;
    }
  })();

  const baseProps = {
    id: selectedDataset.id,
    data: selectedDataset.url,
    // Seed with the initial time. The layer reads the live time from the
    // shared TimeController every draw — we deliberately do NOT thread
    // the React `currentTime` state in here, because that would invalidate
    // the layer prop tree at 60Hz and force deck.gl to re-run updateState
    // (and the trip consolidation cache) on every tick.
    currentTime: selectedDataset.timeRange.start,
    timeController,
    timeWindow,
    tileLoadTimeWindow: selectedDataset.tileLoadTimeWindow,
    timeRange: selectedDataset.timeRange,
    // Tile-tier dispatch. Defaults to 'auto' (summary overview at low zoom);
    // datasets can force 'raw' when the summary overlay obscures the story.
    tier: selectedDataset.tier,
    opacity: selectedDataset.opacity ?? 0.8,
    pickable: false,
    // Shared prefetch/concurrency recipe (see tileLoadingProps): a few real
    // seconds of sim-time lookahead, floored at the resident window.
    ...tileLoadingProps(timeWindow, playbackSpeed),
    // Per-dataset caches have no cross-dataset budget, so composites scale
    // each tileset's slice of the ~2 GiB budget; floors keep a slice viable
    // for dense datasets. Single-archive demos keep the layer defaults.
    ...(archiveCount > 1 && {
      maxCacheSize: Math.max(600, Math.floor(2000 / archiveCount)),
      maxCacheByteSize: Math.max(
        512 * 2 ** 20,
        Math.floor((2 * 2 ** 30) / archiveCount),
      ),
    }),
    // Playback-governor plumbing is NOT baked into baseProps anymore: each
    // single-layer demo and each composite layer applies its own role-based
    // `sourceProps(id, required)` so EVERY tileset is registered (Phase 0).
    // Storyboard preview tier: pin z0–z1 across the full time range so
    // scrubbing always renders SOMETHING (default 20 MiB budget gate — the
    // tileset rejects datasets with giant coarse tiles, e.g. satellites).
    overviewPreload,
    onOverviewPreload,
    // Space-time cube: 0 (inert) unless the dataset opts in via timeHeight.
    timeHeightScale,
    timeHeightOrigin: selectedDataset.timeRange.start,
  };

  switch (selectedDataset.type) {
    case 'point':
      return [
        new AnimatedPointLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          fillColor: selectedDataset.colorProperty || [31, 186, 214, 255],
          colorMapping: selectedDataset.colorMapping,
          colorMappingDefault: selectedDataset.colorMappingDefault,
          radius:
            selectedDataset.radiusProperty ?? selectedDataset.radius ?? 1000,
          // Per-dataset styling overrides; legacy datasets stay on the old
          // meters/×2 default so ship and flight markers keep their look.
          radiusUnits: selectedDataset.radiusUnits ?? 'meters',
          radiusScale: selectedDataset.radiusScale ?? 2,
          radiusMinPixels: selectedDataset.radiusMinPixels,
          radiusMaxPixels: selectedDataset.radiusMaxPixels,
          radiusTransform: selectedDataset.radiusTransform,
          stroked: selectedDataset.stroked,
          strokeColor: selectedDataset.strokeColor,
          lineWidthMinPixels: selectedDataset.lineWidthMinPixels,
          wakeLength: selectedDataset.wakeLength,
          wakeTailScale: selectedDataset.wakeTailScale,
          // Cumulative "draw the map" mode (e.g. OSM node creations): points
          // appear at their creation time and persist. fadeInDuration (sim-ms)
          // doubles as the "ink appearing" ramp.
          cumulative: selectedDataset.cumulative,
          fadeInDuration: selectedDataset.fadeInDuration,
          use3D: selectedDataset.use3D,
          elevationProperty: selectedDataset.elevationProperty,
          elevationScale: selectedDataset.elevationScale,
          // Motion glide: a CONCRETE boolean (never explicit-undefined, so it
          // can't shadow the layer's `interpolate: false` default) with the
          // reduced-motion preference folded in — a reduced-motion viewer gets
          // the discrete GPU path. `idProperty` is conditionally spread so it is
          // ABSENT (not undefined) when unset, per the defaultProps gotcha.
          interpolate: !!selectedDataset.interpolate && !reducedMotion,
          ...(selectedDataset.idProperty && {
            idProperty: selectedDataset.idProperty,
          }),
          // A finite gap makes the glide HOLD across data holes (coverage
          // dropouts) rather than fabricate a straight line; conditionally
          // spread so it is absent (not undefined, which would shadow the
          // layer's Infinity default) when the dataset does not set it.
          ...(selectedDataset.maxInterpolationGap != null && {
            maxInterpolationGap: selectedDataset.maxInterpolationGap,
          }),
          // DataFilter range control: conditionally spread so both keys are
          // absent by default (never explicit-undefined shadowing the
          // DataFilterExtension defaults). Composes WITH the time filter.
          ...(selectedDataset.filterProperty && {
            filterProperty: selectedDataset.filterProperty,
          }),
          ...(selectedDataset.filterRange && {
            filterRange: selectedDataset.filterRange,
          }),
        }),
      ];
    case 'pointCloud':
      // Colour comes from the tile's interleaved `point_rgba` vector column
      // (the layer's `colorVectorColumn` default), bound zero-copy and taking
      // precedence over every other colour path — so no fillColor/colorMapping
      // here. `z` already rides in the geometry via --point-elevation-column,
      // hence no elevationProperty either.
      //
      // fadeIn/fadeOut ramp alpha across a frame's lifetime. A frame-lattice
      // archive whose render window equals its frame spacing pulses each frame
      // in and out under ANY non-zero ramp — they must stay 0 here.
      return [
        new AnimatedPointCloudLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          pointSize: selectedDataset.pointSize ?? 2,
          sizeUnits: selectedDataset.pointSizeUnits ?? 'pixels',
          material: selectedDataset.pointMaterial ?? false,
          fadeInDuration: selectedDataset.fadeInDuration ?? 0,
          fadeOutDuration: selectedDataset.fadeOutDuration ?? 0,
        }),
      ];
    case 'path':
      return [
        new AnimatedPathLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          pathColor: selectedDataset.colorProperty ||
            selectedDataset.pathColor || [31, 186, 214, 255],
          pathWidth: selectedDataset.pathWidth ?? 3,
          widthUnits: selectedDataset.widthUnits ?? 'pixels',
          // Same fragment-cost story as trips: rounded is the dominant cost
          // on dense Manhattan paths at small widths; default off.
          capRounded: selectedDataset.capRounded ?? false,
          jointRounded: selectedDataset.jointRounded ?? false,
        }),
      ];
    case 'tripHeads':
      // A smooth moving point at each active trip's head via AnimatedTripHeadsLayer
      // (stock ScatterplotLayer + CPU per-frame position interpolation) — fp64,
      // no jitter, no custom GLSL.
      return [
        new AnimatedTripHeadsLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          headColor: selectedDataset.headColor ?? [253, 128, 93, 255],
          headRadiusPixels: selectedDataset.headRadiusPixels ?? 4,
          // World-space sizing (meters) so heads emerge on zoom like the
          // maritime points; defaults to pixels (legacy look).
          sizeUnits: selectedDataset.headSizeUnits,
          headRadius: selectedDataset.headRadius,
          headRadiusMinPixels: selectedDataset.headRadiusMinPixels,
          headRadiusMaxPixels: selectedDataset.headRadiusMaxPixels,
        }),
      ];
    case 'trips': {
      // Static-geometry overviews (flow corridors) carry a per-vertex ×
      // per-bucket value matrix and animate via FlowCorridorLayer — the
      // geometry loads once and only the active bucket column changes.
      // flowStroke (bixi-corridors): merged DIRECTED corridors whose per-PATH
      // width breathes with the active hour + twin offset ribbons. A
      // FlowCorridorLayer subclass, so it keeps the matrix colour animation.
      const TripsLayerCtor = selectedDataset.flowStroke
        ? FlowStrokeLayer
        : selectedDataset.flowMatrix
          ? FlowCorridorLayer
          : AnimatedTripsLayer;
      const tripsLayer = new TripsLayerCtor({
        ...baseProps,
        ...sourceProps(selectedDataset.id, true),
        // useGlobe / useGlobalBounds / zoomOverride let a dataset opt into
        // a global tile load without bespoke per-id branching here. Globe
        // mode forces global bounds because GlobeView's unproject() at low
        // zoom returns degenerate bounds — without it the tile loader sees
        // a tiny visible box and never requests the polar/back-side tiles.
        ...(selectedDataset.zoomOverride !== undefined && {
          zoomOverride: selectedDataset.zoomOverride,
        }),
        ...((selectedDataset.useGlobalBounds || useGlobe) && {
          useGlobalBounds: true,
        }),
        // A categorical `colorProperty` is passed as the property-name form
        // of `tripColor`; `colorMapping` keeps colors stable across tiles.
        tripColor: selectedDataset.colorProperty ??
          selectedDataset.tripColor ?? [31, 186, 214, 255],
        ...(selectedDataset.colorMapping && {
          colorMapping: selectedDataset.colorMapping,
        }),
        ...(selectedDataset.colorMappingDefault && {
          colorMappingDefault: selectedDataset.colorMappingDefault,
        }),
        // Per-vertex gradient (e.g. ocean-drifter SST) shades the line along
        // its length and takes precedence over categorical `tripColor`.
        ...(selectedDataset.tripGradient && {
          gradientProperty: selectedDataset.tripGradient.property,
          gradientDomain: selectedDataset.tripGradient.domain,
          gradientColorRamp: selectedDataset.tripGradient.colors,
        }),
        tripWidth: selectedDataset.tripWidth ?? 4,
        // World-space widths (meters) when a dataset opts in, so trails
        // thicken on zoom like the maritime points; defaults to pixels.
        widthUnits: selectedDataset.widthUnits ?? 'pixels',
        widthMinPixels: selectedDataset.widthMinPixels ?? 2,
        widthMaxPixels: selectedDataset.widthMaxPixels ?? 8,
        // FlowStrokeLayer breathing-width + twin-ribbon knobs. Only passed when
        // flowStroke (these are unknown props on the base/corridor layers).
        ...(selectedDataset.flowStroke && {
          widthScale: selectedDataset.flowWidthScale ?? 1,
          widthExponent: selectedDataset.flowWidthExponent ?? 0.5,
          minFlow: selectedDataset.flowMinFlow ?? 0,
          offsetWidths: selectedDataset.flowOffsetWidths ?? 0.6,
        }),
        trailLength: selectedDataset.trailLength ?? 60000,
        fadeTrail: selectedDataset.fadeTrail ?? true,
        // Rounded caps/joints are the dominant fragment-shader cost at small
        // widths; default off and let datasets opt in.
        capRounded: selectedDataset.capRounded ?? false,
        jointRounded: selectedDataset.jointRounded ?? false,
        // flowPersistenceMs (bixi-live): trailing-max persistence so a corridor
        // highlight binned at trip START stays lit for the ride's duration —
        // keeps the flow base in sync with the moving-heads overlay.
        ...(selectedDataset.flowPersistenceMs !== undefined && {
          persistenceMs: selectedDataset.flowPersistenceMs,
        }),
        // flowSignedDirection (bixi-live): the value matrix is SIGNED — the layer
        // colours by |value| (volume) and hands the sign to the chevron extension
        // so arrows flip per time-step. Harmless on non-corridor trips layers.
        ...(selectedDataset.flowSignedDirection && {
          signedFlow: true,
          // Direction window feeds chevronDirectionsFor (runs under signedFlow,
          // independent of per-trip), so pass it here — wide on coarse matrices.
          ...(selectedDataset.chevronDirectionWindowMs !== undefined && {
            chevronDirectionWindowMs: selectedDataset.chevronDirectionWindowMs,
          }),
        }),
        // chevronPerTripLight (bixi-live): the layer derives a rolling-window
        // AGGREGATE (→ ramp RGB) and packs an INSTANTANEOUS per-trip flow into the
        // color's ALPHA byte, so the chevron extension can flash arrows as trips
        // pass. Dual-set with the extension's `perTripLight` option below.
        ...(selectedDataset.chevronPerTripLight && {
          chevronPerTripLight: true,
          ...(selectedDataset.chevronAggregateWindowMs !== undefined && {
            chevronAggregateWindowMs: selectedDataset.chevronAggregateWindowMs,
          }),
          ...(selectedDataset.chevronInstantDomain !== undefined && {
            chevronInstantDomain: selectedDataset.chevronInstantDomain,
          }),
          ...(selectedDataset.chevronInstantDecayMs !== undefined && {
            chevronInstantDecayMs: selectedDataset.chevronInstantDecayMs,
          }),
        }),
        // flowDirectional (bixi-streets-flow): a directional-corridor archive
        // whose geometry is pre-oriented toward dominant flow. Overlay marching
        // chevrons via the public `extensions` prop — composeExtensions appends
        // it to the corridor PathLayer, and the matrix colour animation stays.
        // With flowSignedDirection, the chevrons flip per bucket (perBucketDirection).
        ...(selectedDataset.flowDirectional && {
          extensions: [
            new ChevronFlowExtension({
              period: selectedDataset.chevronPeriod,
              speed: selectedDataset.chevronSpeed,
              skew: selectedDataset.chevronSkew,
              duty: selectedDataset.chevronDuty,
              baseAlpha: selectedDataset.chevronBaseAlpha,
              // Static chevrons opt out of the per-vertex direction morph while the
              // layer still colours by |value| (signedFlow). Defaults to signedFlow.
              perBucketDirection:
                selectedDataset.chevronPerBucketDirection ??
                selectedDataset.flowSignedDirection,
              uniformSpacing: selectedDataset.chevronUniformSpacing,
              directionColor: selectedDataset.chevronDirectionColor,
              directionColors: selectedDataset.chevronDirectionColors,
              directionOffsetDegrees: selectedDataset.chevronDirectionOffset,
              perTripLight: selectedDataset.chevronPerTripLight,
              perTripFloor: selectedDataset.chevronPerTripFloor,
            }),
          ],
        }),
      });
      const tripsLayers: any[] = useGlobe
        ? [
            new SolidPolygonLayer({
              id: 'earth-background',
              data: EARTH_POLYGON,
              getPolygon: (d) => d as any,
              stroked: false,
              filled: true,
              getFillColor: selectedDataset.globeBackgroundColor ?? [
                36, 39, 48, 255,
              ],
            }),
            tripsLayer,
          ]
        : [tripsLayer];
      // Composite: overlay moving head-dots from a SECOND (per-trip, OSRM-routed)
      // archive on top of the flow corridors (bixi-live = directional flow +
      // moving riders). Painter order puts it last (topmost). Gating is
      // policy-driven: by DEFAULT the overlay registers as a REQUIRED governor
      // source, so the shared clock waits for the riders too (MSE-intersection
      // semantics) instead of animating the corridors while the heads run dry;
      // overlayGatesPlayback: false opts a decorative overlay back into
      // continue-and-degrade.
      if (selectedDataset.headsOverlayUrl) {
        tripsLayers.push(
          new AnimatedTripHeadsLayer({
            ...baseProps,
            id: `${selectedDataset.id}-heads`,
            ...sourceProps(
              `${selectedDataset.id}-heads`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.headsOverlayUrl,
            // Overlays never pin the storyboard preview tier (the primary does).
            overviewPreload: false,
            onOverviewPreload: undefined,
            headColor: selectedDataset.headColor ?? [253, 128, 93, 255],
            headRadiusPixels: selectedDataset.headRadiusPixels ?? 4,
            sizeUnits: selectedDataset.headSizeUnits,
            headRadius: selectedDataset.headRadius,
            headRadiusMinPixels: selectedDataset.headRadiusMinPixels,
            headRadiusMaxPixels: selectedDataset.headRadiusMaxPixels,
          }),
        );
      }
      return tripsLayers;
    }
    case 'heatmap': {
      // Stacked heatmaps now compile down to ONE HeatmapLayer with N
      // channels packed into the RGBA accumulator — half the draw calls
      // and one shared FBO. The legacy per-spec sublayer fanout is gone.
      const specs = selectedDataset.heatmapLayers ?? [];
      if (specs.length === 0) {
        return [
          new AnimatedHeatmapLayer({
            ...baseProps,
            ...sourceProps(selectedDataset.id, true),
            radiusPixels: 30,
            intensity: 1,
            colorRange: [
              [255, 255, 178, 255],
              [254, 204, 92, 255],
              [253, 141, 60, 255],
              [240, 59, 32, 255],
              [189, 0, 38, 255],
            ],
            weightProperty: selectedDataset.weightProperty,
          }),
        ];
      }
      // Pick the first spec's radius/intensity for the layer-wide values
      // (the per-channel intensity multiplier still composes on top).
      const first = specs[0];
      const channels: HeatmapChannelSpec[] = specs.slice(0, 4).map((spec) => ({
        id: spec.id,
        categoryFilter: spec.categoryFilter,
        colorRange: spec.colorRange,
        colorDomain: spec.colorDomain ?? undefined,
        intensity: spec.intensity ?? 1,
      }));
      return [
        new AnimatedHeatmapLayer({
          ...baseProps,
          id: `${selectedDataset.id}-heatmap`,
          ...sourceProps(`${selectedDataset.id}-heatmap`, true),
          radiusPixels: first.radiusPixels ?? 30,
          intensity: 1,
          weightProperty:
            first.weightProperty ?? selectedDataset.weightProperty,
          channels,
        }),
      ];
    }
    case 'lightning': {
      // GLM lightning from ONE flash-point archive, rendered as ONE additive
      // point layer. Each flash appears bright then fades + shrinks over
      // `wakeLength` sim-ms (the one-sided comet decay) so instantaneous events
      // read as a shimmering flicker on the compressed multi-day clock — and
      // because the splats blend ADDITIVELY, overlapping flashes in active
      // convection stack into the white-hot density glow the old
      // AnimatedHeatmapLayer backdrop used to provide. (That backdrop was a
      // SECOND full tileset over the same archive plus a consolidated-buffer
      // rebuild + GPU re-aggregation on every tile churn — the demo's dominant
      // cost. One layer, one tileset, density for free.)
      return [
        new AnimatedPointLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          fillColor: selectedDataset.colorProperty ?? LIGHTNING_FLASH_COLOR,
          colorMapping: selectedDataset.colorMapping,
          colorMappingDefault: selectedDataset.colorMappingDefault,
          radius: selectedDataset.radiusProperty ?? 'energy_fj',
          radiusUnits: selectedDataset.radiusUnits ?? 'pixels',
          radiusScale: selectedDataset.radiusScale ?? 1,
          radiusMinPixels: selectedDataset.radiusMinPixels ?? 1.2,
          radiusMaxPixels: selectedDataset.radiusMaxPixels ?? 7,
          radiusTransform: selectedDataset.radiusTransform,
          // Bright-then-fade "flash" lifetime on the compressed clock.
          wakeLength: selectedDataset.wakeLength ?? 700000,
          wakeTailScale: selectedDataset.wakeTailScale ?? 0.15,
          // Soft gaussian glow instead of a hard disk — sells the flash.
          splat: true,
          stroked: false,
          parameters: LIGHTNING_ADDITIVE_PARAMETERS,
        }),
      ];
    }
    case 'polygon': {
      const polygonLayers: any[] = [
        new AnimatedPolygonLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          // Rain→flood composite: the rain field spans many two-hour buckets, so
          // the default z0–z1 storyboard tier would pin ~2 tiles/bucket. Pin only
          // z0 (whole CONUS in one tile — the ideal scrub thumbnail) with a
          // roomier budget so the storyboard isn't rejected across a full year.
          // The 2-hourly archive has 4,380 z0 tiles (~81 MB); the budget must
          // clear that or the whole overview tier is dropped ('over-budget').
          // NB the archive MUST be built with --min-zoom 0 or z0/z1 don't exist
          // and the tier is empty ('no-tiles'). Only when the plumbing enabled
          // preload (live viewer); other contexts keep it off.
          ...(selectedDataset.riversUrl && baseProps.overviewPreload
            ? {
                overviewPreload: {
                  maxZoom: 0,
                  budgetBytes: 128 * 1024 * 1024,
                },
              }
            : {}),
          filled: selectedDataset.polygonFilled ?? true,
          fillColor: selectedDataset.colorProperty ||
            selectedDataset.polygonFillColor || [31, 186, 214, 180],
          // Categorical fills keyed by category STRING (stable across tiles);
          // only meaningful alongside a `colorProperty` fillColor.
          ...(selectedDataset.colorMapping && {
            colorMapping: selectedDataset.colorMapping,
          }),
          ...(selectedDataset.colorMappingDefault && {
            colorMappingDefault: selectedDataset.colorMappingDefault,
          }),
        }),
      ];
      // Rain→flood composite: overlay a river-discharge flow-matrix archive on
      // top of the precip-isoband field. FlowCorridorLayer (static geometry +
      // per-vertex×bucket value matrix) shares the primary's timeRange/timeWindow
      // — both archives are full-2019 daily. Gating is policy-driven: REQUIRED
      // by DEFAULT, so the clock waits for the heavy river archive instead of
      // sweeping past its loaded frontier (empty riverbeds under live rain);
      // overlayGatesPlayback: false opts back into continue-and-degrade.
      if (selectedDataset.riversUrl && selectedDataset.riversConfig) {
        const rc = selectedDataset.riversConfig;
        polygonLayers.push(
          new FlowCorridorLayer({
            ...baseProps,
            id: `${selectedDataset.id}-rivers`,
            ...sourceProps(
              `${selectedDataset.id}-rivers`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.riversUrl,
            overviewPreload: false,
            onOverviewPreload: undefined,
            tripColor: [31, 186, 214, 255],
            gradientProperty: rc.tripGradient.property,
            gradientDomain: rc.tripGradient.domain,
            gradientColorRamp: rc.tripGradient.colors,
            ...(rc.colorMappingDefault && {
              colorMappingDefault: rc.colorMappingDefault,
            }),
            tripWidth: rc.tripWidth ?? 'width',
            widthMinPixels: rc.widthMinPixels ?? 0.2,
            widthMaxPixels: rc.widthMaxPixels ?? 1.5,
            trailLength: 0,
            capRounded: false,
            jointRounded: false,
          }),
        );
      }
      return polygonLayers;
    }
    case 'h3Summary': {
      // If the dataset declares a toggle (e.g. pickup vs dropoff), the
      // active option overrides the base summary styling props. Otherwise
      // fall back to the dataset's single-weight settings.
      const weightProperty =
        activeSummaryToggle?.weightProperty ??
        selectedDataset.summaryWeightProperty ??
        'count';
      const colorRange =
        activeSummaryToggle?.colorRange ?? selectedDataset.summaryColorRange;
      const colorDomain =
        activeSummaryToggle?.colorDomain ?? selectedDataset.summaryColorDomain;
      const summaryId = `${selectedDataset.id}-${activeSummaryToggle?.id ?? 'default'}`;
      return [
        new H3SummaryLayer({
          id: summaryId,
          data: selectedDataset.url,
          currentTime: selectedDataset.timeRange.start,
          timeController,
          timeWindow,
          // Required (single-source) governor plumbing, keyed by the layer id.
          ...sourceProps(summaryId, true),
          weightProperty,
          colorRange,
          colorDomain,
          extruded: selectedDataset.summaryExtruded ?? false,
          elevationScale: selectedDataset.summaryElevationScale ?? 1,
          coverage: selectedDataset.summaryCoverage ?? 0.92,
          opacity: 0.85,
          pickable: false,
        }),
      ];
    }
    case 'arc':
      // Origin→destination flow arcs. Each tile feature is a 2-vertex
      // LineString (first vertex = source, last = target); the layer derives
      // instanced source/target positions and bows an arc between them, faded
      // in/out by the time window (pickup→dropoff overlap).
      return [
        new AnimatedArcLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          sourceColor: selectedDataset.colorProperty ??
            selectedDataset.arcSourceColor ?? [56, 196, 232, 210],
          targetColor: selectedDataset.arcTargetColor ?? [255, 142, 64, 220],
          ...(selectedDataset.colorPalette && {
            colorPalette: selectedDataset.colorPalette,
          }),
          width: selectedDataset.arcWidth ?? 1.5,
          widthUnits: selectedDataset.widthUnits ?? 'pixels',
          widthMinPixels: selectedDataset.widthMinPixels ?? 1,
          widthMaxPixels: selectedDataset.widthMaxPixels,
          greatCircle: selectedDataset.arcGreatCircle ?? false,
          arcHeight: selectedDataset.arcHeight ?? 1,
          fadeInDuration: selectedDataset.fadeInDuration ?? 300,
        }),
      ];
    case 'flowmap':
      // flowmap.gl-style animated OD flowmap: one weighted tapered arrow per
      // station-pair whose width tracks volume at the playhead (per-bucket
      // vertexValueMatrix decode, rendered via FlowLinesLayer), plus node
      // circles sized by incident flow. Geometry spans the whole time range —
      // loads once, animates from the matrix.
      return [
        new FlowmapLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          widthScale: selectedDataset.flowWidthScale ?? 1.1,
          widthMinPixels: selectedDataset.flowWidthMinPixels ?? 1,
          widthMaxPixels: selectedDataset.flowWidthMaxPixels ?? 12,
          sourceColor: selectedDataset.flowSourceColor ?? [56, 196, 232, 235],
          targetColor: selectedDataset.flowTargetColor ?? [255, 142, 64, 245],
          gap: selectedDataset.flowGap ?? 0.5,
          nodeRadiusScale: selectedDataset.flowNodeRadiusScale ?? 1.3,
          ...(selectedDataset.flowNodeRadiusUnits && {
            nodeRadiusUnits: selectedDataset.flowNodeRadiusUnits,
          }),
          ...(selectedDataset.flowNodeColor && {
            nodeColor: selectedDataset.flowNodeColor,
          }),
          minFlow: selectedDataset.flowMinFlow ?? 0.25,
        }),
      ];
    case 'flowmap-bundled':
      // Same OD flowmap, but compatible corridors are relaxed into smooth rivers
      // by a GPU kernel-density edge bundler (KDEEB/CUBu — density splat → advect
      // → resample → Laplacian smooth, cosmos.gl-style ping-pong float textures)
      // and rendered fully GPU-resident — the bundle is computed once and stays on
      // the GPU; only ribbon width animates. Falls back to straight arrows on
      // devices that can't additively blend into a float texture.
      return [
        new BundledFlowmapLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          widthScale: selectedDataset.flowWidthScale ?? 1.1,
          widthMinPixels: selectedDataset.flowWidthMinPixels ?? 1,
          widthMaxPixels: selectedDataset.flowWidthMaxPixels ?? 12,
          sourceColor: selectedDataset.flowSourceColor ?? [56, 196, 232, 235],
          targetColor: selectedDataset.flowTargetColor ?? [255, 142, 64, 245],
          gap: selectedDataset.flowGap ?? 0.5,
          nodeRadiusScale: selectedDataset.flowNodeRadiusScale ?? 1.3,
          ...(selectedDataset.flowNodeColor && {
            nodeColor: selectedDataset.flowNodeColor,
          }),
          minFlow: selectedDataset.flowMinFlow ?? 0.25,
          ...(selectedDataset.flowNodeRadiusUnits && {
            nodeRadiusUnits: selectedDataset.flowNodeRadiusUnits,
          }),
          ...(selectedDataset.flowNodeRadiusMaxPixels != null && {
            nodeRadiusMaxPixels: selectedDataset.flowNodeRadiusMaxPixels,
          }),
          subdivisionPoints: selectedDataset.flowSubdivisionPoints ?? 48,
          kernelRadius: selectedDataset.flowKernelRadius ?? 0.05,
          bundlingIterations: selectedDataset.flowBundlingIterations ?? 15,
          smoothingStrength: selectedDataset.flowSmoothingStrength ?? 0.5,
          ...(selectedDataset.flowMaxBundledEdges != null && {
            maxBundledEdges: selectedDataset.flowMaxBundledEdges,
          }),
          // Tiles built with `--bake-bundling` carry the rivers already; skip the
          // live GPU bundler and render the precomputed geometry.
          ...(selectedDataset.flowPreBundled && { preBundled: true }),
        }),
      ];
    case 'column':
      // Extruded 3D columns at point features; height from a numeric column.
      return [
        new AnimatedColumnLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          radius: selectedDataset.columnRadius ?? 100,
          radiusUnits: selectedDataset.columnRadiusUnits ?? 'meters',
          diskResolution: selectedDataset.columnDiskResolution ?? 12,
          extruded: true,
          elevation:
            selectedDataset.elevationProperty ??
            selectedDataset.columnElevation ??
            1000,
          elevationScale: selectedDataset.elevationScale ?? 1,
          fillColor: selectedDataset.colorProperty ??
            selectedDataset.columnFillColor ?? [253, 128, 93, 220],
          ...(selectedDataset.colorPalette && {
            colorPalette: selectedDataset.colorPalette,
          }),
          fadeInDuration: selectedDataset.fadeInDuration ?? 300,
        }),
      ];
    case 'quadbinSummary': {
      // CARTO Quadbin square-cell analog of the H3 summary tier. Mirrors the
      // `summary` case: the layer clamps to the tier's zoom band and reads the
      // aggregated `count` (or a toggle weight) per cell. Quadbin cells carry
      // no per-bucket TimeFilter — they are pre-aggregated per time bucket.
      const weightProperty =
        activeSummaryToggle?.weightProperty ??
        selectedDataset.summaryWeightProperty ??
        'count';
      const colorRange =
        activeSummaryToggle?.colorRange ?? selectedDataset.summaryColorRange;
      const colorDomain =
        activeSummaryToggle?.colorDomain ?? selectedDataset.summaryColorDomain;
      const quadbinId = `${selectedDataset.id}-${activeSummaryToggle?.id ?? 'default'}`;
      return [
        new QuadbinSummaryLayer({
          id: quadbinId,
          data: selectedDataset.url,
          currentTime: selectedDataset.timeRange.start,
          timeController,
          timeWindow,
          ...sourceProps(quadbinId, true),
          weightProperty,
          colorRange,
          colorDomain,
          extruded: selectedDataset.summaryExtruded ?? false,
          elevationScale: selectedDataset.summaryElevationScale ?? 1,
          coverage: selectedDataset.summaryCoverage ?? 0.92,
          opacity: 0.85,
          pickable: false,
        }),
      ];
    }
    case 'radar': {
      // Composite NEXRAD render. Three STT archives from one dataset entry:
      //   1. reflectivity CONTOUR BANDS (the field) — primary `url`, reuses
      //      baseProps verbatim and is the REQUIRED governor source so the clock
      //      gates on the heaviest stream (the categorical `dbz_band` fill, GPU
      //      CategoryColorExtension);
      //   2. storm-cell TRACKS (AnimatedTripsLayer, per-vertex intensity);
      //   3. storm-cell CENTROIDS (AnimatedPointLayer, sized by max_dbz).
      // Multi-source gating: the track/centroid overlays register as REQUIRED
      // governor sources by default (`overlayGatesPlayback ?? true`) — the
      // clock min-gates on all three archives, so the cells can no longer run
      // dry and vanish while the reflectivity field keeps sweeping. Set
      // `overlayGatesPlayback: false` on the dataset to opt back into
      // continue-and-degrade. Only the overview-preload tier stays field-only
      // (the storyboard pins the primary archive).
      // Painter order: field (backdrop) → tracks → centroids (topmost).
      const overlayBase = {
        ...baseProps,
        onOverviewPreload: undefined,
        overviewPreload: false,
      };
      const layers: any[] = [
        new AnimatedPolygonLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          filled: true,
          // String fillColor = property name → GPU categorical fill; colorMapping
          // keeps each dBZ band stable across tiles (the wildfires/severity pattern).
          fillColor: selectedDataset.colorProperty ?? 'dbz_band',
          ...(selectedDataset.colorMapping && {
            colorMapping: selectedDataset.colorMapping,
          }),
          ...(selectedDataset.colorMappingDefault && {
            colorMappingDefault: selectedDataset.colorMappingDefault,
          }),
          // Radar scans are discrete frames; without a sim-time-scaled fade
          // each scan's bands POP in/out as the window slides (the layer
          // default of 500 sim-ms is sub-frame on a compressed clock).
          // Dataset-tuned fadeIn/fadeOut cross-dissolves successive scans.
          ...(selectedDataset.fadeInDuration !== undefined && {
            fadeInDuration: selectedDataset.fadeInDuration,
          }),
          ...(selectedDataset.fadeOutDuration !== undefined && {
            fadeOutDuration: selectedDataset.fadeOutDuration,
          }),
        }),
      ];
      if (selectedDataset.radarTracksUrl) {
        layers.push(
          new AnimatedTripsLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-tracks`,
            ...sourceProps(
              `${selectedDataset.id}-tracks`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.radarTracksUrl,
            tripColor: selectedDataset.tripColor ?? [255, 255, 255, 200],
            // Per-vertex intensity (max_dbz over time) shades the trail.
            ...(selectedDataset.tripGradient && {
              gradientProperty: selectedDataset.tripGradient.property,
              gradientDomain: selectedDataset.tripGradient.domain,
              gradientColorRamp: selectedDataset.tripGradient.colors,
            }),
            tripWidth: selectedDataset.tripWidth ?? 3,
            widthUnits: selectedDataset.widthUnits ?? 'pixels',
            widthMinPixels: selectedDataset.widthMinPixels ?? 1.5,
            widthMaxPixels: selectedDataset.widthMaxPixels ?? 6,
            trailLength: selectedDataset.trailLength ?? 1800000,
            fadeTrail: selectedDataset.fadeTrail ?? true,
            capRounded: false,
            jointRounded: false,
          }),
        );
      }
      if (selectedDataset.radarCellsUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-cells`,
            ...sourceProps(
              `${selectedDataset.id}-cells`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.radarCellsUrl,
            fillColor: selectedDataset.radarCellColor ?? [255, 255, 255, 230],
            radius: selectedDataset.radiusProperty ?? 'max_dbz',
            radiusUnits: selectedDataset.radiusUnits ?? 'pixels',
            radiusScale: selectedDataset.radiusScale ?? 1,
            radiusMinPixels: selectedDataset.radiusMinPixels ?? 2,
            radiusMaxPixels: selectedDataset.radiusMaxPixels ?? 14,
            radiusTransform: selectedDataset.radiusTransform,
            stroked: selectedDataset.stroked ?? true,
            strokeColor: selectedDataset.strokeColor ?? [8, 12, 24, 220],
            lineWidthMinPixels: selectedDataset.lineWidthMinPixels ?? 1,
          }),
        );
      }
      return layers;
    }
    case 'weather': {
      // Composite WEATHER-SUITE render — up to seven archives on one
      // playhead. Painter order (bottom→top): wind drift dots → precip FIELD
      // → WPC surface fronts → front pips → precip cell tracks → cell
      // centroids → lightning flashes. Every time-animated archive registers as a REQUIRED governor
      // source by default (`overlayGatesPlayback ?? true`), so the shared
      // clock min-gates on ALL of them — MSE-intersection semantics; an
      // overlay can no longer run dry and render blank while the field keeps
      // animating. The governor's run-ahead fairness + weight shed keep the
      // heavier streams fed. Set `overlayGatesPlayback: false` on the dataset
      // to opt every overlay back into continue-and-degrade (text-track
      // semantics). Each animated layer still widens its OWN loader window
      // (trips → 2×trailLength, flashes → 2×wakeLength), so the shared short
      // field window never starves them. Lightning styling is fixed here (the
      // standalone `lightning` case's `radius*`/`wakeLength` fields collide
      // with the precip cells' on the flat Dataset type).
      const overlayBase = {
        ...baseProps,
        onOverviewPreload: undefined,
        overviewPreload: false,
      };
      const layers: any[] = [];

      // 0. HRRR wind — a minimal drifting PARTICLE FIELD (moving dots), the
      // background steering flow. Was AnimatedTripsLayer streamline ribbons;
      // switched to AnimatedTripHeadsLayer so the wind reads as a quiet swarm of
      // dots that drift with the storms instead of continental spaghetti. Big
      // GPU win too: heads draw one instanced circle per ACTIVE particle instead
      // of keeping ~3 h of continental ribbon geometry resident (the ribbons
      // left the solo wind demo GPU-bound ~33fps). The head position is
      // CPU-interpolated along each particle path once per frame. When the
      // archive carries a per-vertex value and the dataset sets `windGradient`,
      // each dot is colored by that scalar (here the 500 mb air TEMPERATURE it
      // rides, interpolated to the dot exactly like its position) — otherwise a
      // constant subtle `windHeadColor` backdrop.
      if (selectedDataset.windUrl) {
        layers.push(
          new AnimatedTripHeadsLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-wind`,
            ...sourceProps(
              `${selectedDataset.id}-wind`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.windUrl,
            headColor: selectedDataset.windHeadColor ?? [150, 180, 220, 115],
            // Per-vertex temperature gradient (falls back to headColor when unset
            // or where a dot has no sampled value).
            ...(selectedDataset.windGradient && {
              gradientProperty: selectedDataset.windGradient.property,
              gradientDomain: selectedDataset.windGradient.domain,
              gradientColorRamp: selectedDataset.windGradient.colors,
            }),
            headRadiusPixels: selectedDataset.windHeadRadiusPixels ?? 1.4,
            antialiasing: true,
            opacity: selectedDataset.windHeadOpacity ?? 0.6,
            // Heads need only the particle path NEAR the playhead resident to
            // interpolate the dot (no 90-min trail like the streamlines), so a
            // ~1-bucket window keeps the whole field complete across the 2 h
            // temporal buckets while loading far less geometry than the ribbons.
            timeWindow: 10800000, // 3 h — one+ bucket, field stays complete
          }),
        );
      }

      // 1. MRMS precip field — REQUIRED governor (categorical dbz_band fill).
      layers.push(
        new AnimatedPolygonLayer({
          ...baseProps,
          ...sourceProps(selectedDataset.id, true),
          filled: true,
          fillColor: selectedDataset.colorProperty ?? 'dbz_band',
          ...(selectedDataset.colorMapping && {
            colorMapping: selectedDataset.colorMapping,
          }),
          ...(selectedDataset.colorMappingDefault && {
            colorMappingDefault: selectedDataset.colorMappingDefault,
          }),
          // Cross-dissolve successive radar scans (see the `radar` case).
          ...(selectedDataset.fadeInDuration !== undefined && {
            fadeInDuration: selectedDataset.fadeInDuration,
          }),
          ...(selectedDataset.fadeOutDuration !== undefined && {
            fadeOutDuration: selectedDataset.fadeOutDuration,
          }),
        }),
      );

      // 2. WPC surface fronts — the synoptic skeleton over the precip field:
      // analyzed cold/warm/occluded/stationary fronts + troughs, redrawn every
      // 3 h (the coarsest cadence in the suite), spline-smoothed at build time
      // and colored categorically by `render_class`. Whole paths show for
      // their validity interval; successive analyses cross-dissolve (see
      // WEATHER_FRONT_FADE_MS — deliberately NOT the dataset's 7-min radar
      // fade, which would be sub-frame at the 3-h analysis step).
      if (selectedDataset.frontsUrl) {
        layers.push(
          new AnimatedPathLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-fronts`,
            ...sourceProps(
              `${selectedDataset.id}-fronts`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.frontsUrl,
            pathColor: 'render_class',
            colorMapping: WEATHER_FRONT_COLORS,
            colorMappingDefault: [200, 200, 210, 200],
            pathWidth: 2.6,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            fadeInDuration: WEATHER_FRONT_FADE_MS,
            fadeOutDuration: WEATHER_FRONT_FADE_MS,
          }),
        );
      }

      // 3. front pips — the classic notation (cold triangles, warm
      // semicircles, alternating for occluded/stationary) as small oriented
      // GEOGRAPHIC polygons baked on each front's advancing side by
      // wpc_fronts.py, drawn over the lines with the same categorical colors
      // and cross-dissolve so line + pips read as one symbol.
      if (selectedDataset.frontsPipsUrl) {
        layers.push(
          new AnimatedPolygonLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-fronts-pips`,
            ...sourceProps(
              `${selectedDataset.id}-fronts-pips`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.frontsPipsUrl,
            filled: true,
            stroked: false,
            fillColor: 'render_class',
            colorMapping: WEATHER_FRONT_COLORS,
            colorMappingDefault: [200, 200, 210, 200],
            fadeInDuration: WEATHER_FRONT_FADE_MS,
            fadeOutDuration: WEATHER_FRONT_FADE_MS,
          }),
        );
      }

      // 4. precip cell tracks.
      if (selectedDataset.radarTracksUrl) {
        layers.push(
          new AnimatedTripsLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-tracks`,
            ...sourceProps(
              `${selectedDataset.id}-tracks`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.radarTracksUrl,
            tripColor: selectedDataset.tripColor ?? [255, 255, 255, 200],
            ...(selectedDataset.tripGradient && {
              gradientProperty: selectedDataset.tripGradient.property,
              gradientDomain: selectedDataset.tripGradient.domain,
              gradientColorRamp: selectedDataset.tripGradient.colors,
            }),
            tripWidth: selectedDataset.tripWidth ?? 2.5,
            widthUnits: 'pixels',
            widthMinPixels: 1.2,
            widthMaxPixels: 5,
            trailLength: selectedDataset.trailLength ?? 3600000,
            fadeTrail: true,
            capRounded: false,
            jointRounded: false,
          }),
        );
      }

      // 5. precip cell centroids.
      if (selectedDataset.radarCellsUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-cells`,
            ...sourceProps(
              `${selectedDataset.id}-cells`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.radarCellsUrl,
            fillColor: selectedDataset.radarCellColor ?? [255, 255, 255, 220],
            radius: selectedDataset.radiusProperty ?? 'max_dbz',
            radiusUnits: 'pixels',
            radiusScale: 1,
            radiusMinPixels: selectedDataset.radiusMinPixels ?? 2,
            radiusMaxPixels: selectedDataset.radiusMaxPixels ?? 12,
            radiusTransform: selectedDataset.radiusTransform,
            stroked: false,
          }),
        );
      }

      // 6. GLM lightning flashes (topmost) — one ADDITIVE point layer; the
      // stacked splats double as the density glow (see the standalone
      // `lightning` case for why the heatmap backdrop was retired).
      if (selectedDataset.lightningUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-lightning`,
            ...sourceProps(
              `${selectedDataset.id}-lightning`,
              selectedDataset.overlayGatesPlayback ?? true,
            ),
            data: selectedDataset.lightningUrl,
            // De-emphasized copy of the standalone `lightning` case's flash
            // look (smaller radii; the flat Dataset type can't carry a second
            // set of radius fields here — they belong to the precip cells).
            // Retune the two cases TOGETHER; the color is legend-pinned.
            fillColor: LIGHTNING_FLASH_COLOR,
            radius: 'energy_fj',
            radiusUnits: 'pixels',
            radiusScale: 1,
            radiusMinPixels: 1,
            radiusMaxPixels: 6,
            radiusTransform: WEATHER_LIGHTNING_RADIUS_TRANSFORM,
            wakeLength: 700000,
            wakeTailScale: 0.15,
            splat: true,
            stroked: false,
            parameters: LIGHTNING_ADDITIVE_PARAMETERS,
          }),
        );
      }

      return layers;
    }
    case 'storm4d': {
      // Composite STORM-4D render — one supercell as a true 4D object, up to
      // ten archives on one playhead (§9.2 of the storm-4d roadmap is the
      // binding layer map). Painter order bottom→top: county outage decal →
      // cloud-top anvil canopy → multi-level winds → the NEXRAD gate VOLUME
      // (primary/governor) → VTEC warning prisms → couplet rings → surface
      // stations → storm reports → GLM lightning → sounding ascent. Every
      // time-animated overlay registers as a REQUIRED governor source by
      // default (`overlayGatesPlayback ?? true`), exactly like the weather
      // composite — MSE-intersection semantics, no overlay runs dry while
      // the volume keeps animating. ONE shared vertical exaggeration
      // (STORM4D_ELEVATION_SCALE) across every altitude-bearing layer.
      // Overlay styling is fixed here (the flat Dataset type's radius/color
      // fields belong to the volume; see the weather case's lightning note).
      //
      // `refinementStrategy: 'no-overlap'` on EVERY storm4d tileset: these
      // archives are full-duplication pyramids (every zoom level carries the
      // complete feature set — 18.3M radar gates per level on the volume), so
      // deck's best-available parent fallback fetched + decoded + drew up to
      // 4 extra complete copies of the visible data per bucket for zero
      // information gain. Measured at 4 fps / 2.7 s main-thread stalls before;
      // exact-zoom loading is what the data shape wants.
      const overlayBase = {
        ...baseProps,
        refinementStrategy: 'no-overlap' as const,
        onOverviewPreload: undefined,
        overviewPreload: false,
      };
      const gates = selectedDataset.overlayGatesPlayback ?? true;
      const layers: any[] = [];

      // 1. County power outages — flat, EMPHASIZED map regions (EAGLE-I 15-min
      // rollups on county geometry). Was dark-red prisms extruded by
      // `customers_out`, but the tall walls OCCLUDED the atmospheric layers
      // above them; the damage wake reads better as lit-up counties on the
      // ground. Drawn as a GROUND DECAL (GROUND_DECAL_PARAMETERS: no depth
      // write, always-pass depth) so the filled counties lie flat UNDER the 3D
      // volume / canopy / winds without z-fighting the basemap or occluding
      // anything drawn after them. The wake signal is now the spreading EXTENT
      // — counties light up behind the storm as the outage footprint grows
      // (the archive carries only numeric `customers_out`, and the polygon fill
      // is categorical/constant, so there is no per-county magnitude ramp); a
      // bright outline makes each affected county pop.
      if (selectedDataset.outagesUrl) {
        layers.push(
          new AnimatedPolygonLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-outages`,
            ...sourceProps(`${selectedDataset.id}-outages`, gates),
            data: selectedDataset.outagesUrl,
            filled: true,
            fillColor: [205, 50, 50, 100],
            extruded: false,
            stroked: true,
            getLineColor: [255, 100, 85, 215],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            lineWidthMinPixels: 1.2,
            parameters: GROUND_DECAL_PARAMETERS,
          }),
        );
      }

      // 2. GOES C13 cloud-top "anvil canopy" — BT isobands FLOATING at their
      // standard-atmosphere height (`top_alt_m`), very translucent so the
      // volume reads through the haze. Successive 5-min scans cross-dissolve
      // (the generator pads `end_timestamp`; the fades ramp the overlap).
      //
      // `elevationThickness` is what keeps the canopy aloft: a plain extrusion
      // is a PRISM rising out of the ground, so every isoband hung a curtain
      // from the basemap up to its 2–12 km top and the anvil read as a solid
      // wall of glass wrapped around the storm. The bands describe a SURFACE
      // (the height where the cloud top radiates), so each one now floats as a
      // thin shell hugging its own top — nested plates terracing up through the
      // troposphere, with the gate volume visible between them.
      if (selectedDataset.cloudTopUrl) {
        layers.push(
          new AnimatedPolygonLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-cloudtop`,
            ...sourceProps(`${selectedDataset.id}-cloudtop`, gates),
            data: selectedDataset.cloudTopUrl,
            filled: true,
            fillColor: 'bt_band',
            colorMapping: STORM4D_CLOUDTOP_COLORS,
            colorMappingDefault: [140, 160, 190, 24],
            extruded: true,
            elevation: 'top_alt_m',
            elevationThickness: STORM4D_CANOPY_SHELL_M,
            elevationScale: STORM4D_ELEVATION_SCALE,
            wireframe: false,
            stroked: false,
            // Translucent shell walls → haze, not z-fighting (see const).
            parameters: STORM4D_CANOPY_PARAMETERS,
            fadeInDuration: 150000,
            fadeOutDuration: 150000,
          }),
        );
      }

      // 3. Multi-level HRRR winds — a quiet drift-DOT field (one moving point
      // per active particle), each dot lifted to its pressure-level altitude
      // (`level_alt_m` × the shared exaggeration) so the storm-relative flow
      // still threads the volume at four heights (850/700/500/250 mb). Was
      // progressively-revealed path threads; switched to the same
      // AnimatedTripHeadsLayer drift-dot treatment the severe-weather-2024 wind
      // field uses, so the winds read as a swarm riding the volume rather than
      // a web of continental threads. Big residency win too: heads draw one
      // instanced circle per ACTIVE particle instead of keeping ~45 sim-min of
      // ribbon geometry live. Elevation is per-feature (a particle rides one
      // pressure surface for its whole life) — see AnimatedTripHeadsLayer's
      // elevationProperty, which mirrors the volume's `alt_m` lift.
      if (selectedDataset.wind3dUrl) {
        layers.push(
          new AnimatedTripHeadsLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-wind3d`,
            ...sourceProps(`${selectedDataset.id}-wind3d`, gates),
            data: selectedDataset.wind3dUrl,
            headColor: [130, 190, 235, 150],
            headRadiusPixels: 1.4,
            headBillboard: true, // camera-facing at altitude in the pitched scene
            antialiasing: true,
            opacity: 0.6,
            elevationProperty: 'level_alt_m',
            elevationScale: STORM4D_ELEVATION_SCALE,
            // One 2 h archive bucket resident keeps the whole particle field
            // complete (hrrr_advect pattern — see the weather wind overlay).
            timeWindow: 7200000,
          }),
        );
      }

      // 4. NEXRAD gate VOLUME — the primary/governor stream. 3D billboard
      // points stacked by beam altitude; the render-mode toggle (the reused
      // SummaryToggle segmented control) swaps the categorical color column
      // between reflectivity (`dbz_band`) and dealiased velocity
      // (`vel_band`) IN PLACE — same layer id, so the tileset + cache
      // survive the toggle and only tile styling re-prepares. The GPU dBZ
      // threshold (`filterProperty: 'dbz'`) composes with the time window;
      // scan-boundary pops are hidden by the dataset's cross-dissolve fades.
      //
      // `stormVolumeMode: 'isolines'` swaps that point cloud for the CAPPI
      // CONTOUR SHEETS (`storm4d-isolines`): the same volumes gridded to
      // constant-altitude slices and contoured at fixed dBZ levels, so the
      // storm reads as nested iso-line rings terracing up through the
      // troposphere instead of a haze of gates. Same archive slot, same
      // governor, same shared exaggeration — AnimatedPathLayer lifts every
      // ring by its own `alt_m` CAPPI height (see its `elevationProperty`
      // doc: "nested contour rings terrace into a hill"). The render-mode
      // toggle swaps the categorical column between echo strength
      // (`dbz_level`) and HEIGHT (`alt_band`) in place, exactly like the
      // volume's reflectivity/velocity swap.
      if (selectedDataset.stormVolumeMode === 'isolines') {
        layers.push(
          new AnimatedPathLayer({
            ...baseProps,
            refinementStrategy: 'no-overlap',
            ...sourceProps(selectedDataset.id, true),
            pathColor:
              activeSummaryToggle?.weightProperty ??
              selectedDataset.colorProperty ??
              'dbz_level',
            colorMapping:
              activeSummaryToggle?.colorMapping ?? selectedDataset.colorMapping,
            colorMappingDefault: selectedDataset.colorMappingDefault ?? [
              150, 160, 175, 120,
            ],
            elevationProperty: 'alt_m',
            elevationScale:
              selectedDataset.elevationScale ?? STORM4D_ELEVATION_SCALE,
            // Height-graded alpha: the upper sheets go translucent so the
            // stack reads from ABOVE too (you see down through the anvil to
            // the core instead of the 15 km roof hiding everything under it).
            // Keyed on the RAW metres, so it's stable across tiles.
            elevationOpacityRange: STORM4D_ISO_TOP_FADE_RANGE,
            elevationOpacityNear: 1,
            elevationOpacityFar: 0.45,
            pathWidth: 1.6,
            widthUnits: 'pixels',
            widthMinPixels: 1,
            widthMaxPixels: 3,
            capRounded: true,
            jointRounded: true,
            // The archive's numeric `dbz` column IS the contour level, so the
            // demo's threshold peels whole sheets off the stack.
            ...(selectedDataset.filterProperty && {
              filterProperty: selectedDataset.filterProperty,
            }),
            ...(selectedDataset.filterRange && {
              filterRange: selectedDataset.filterRange,
            }),
            // Per-feature validity + a matched cross-dissolve (see the consts)
            // — NOT the dataset's window/fades, which belong to the overlays.
            timeWindow: STORM4D_ISO_TIME_WINDOW_MS,
            tileLoadTimeWindow: STORM4D_ISO_TILE_WINDOW_MS,
            fadeInDuration: STORM4D_ISO_FADE_MS,
            fadeOutDuration: STORM4D_ISO_FADE_MS,
          }),
        );
      } else {
        layers.push(
          new AnimatedPointLayer({
            ...baseProps,
            // Full-duplication archive → exact-zoom loading (see overlayBase).
            refinementStrategy: 'no-overlap',
            ...sourceProps(selectedDataset.id, true),
            fillColor:
              activeSummaryToggle?.weightProperty ??
              selectedDataset.colorProperty ??
              'dbz_band',
            colorMapping:
              activeSummaryToggle?.colorMapping ?? selectedDataset.colorMapping,
            colorMappingDefault: selectedDataset.colorMappingDefault ?? [
              120, 120, 130, 60,
            ],
            billboard: true,
            use3D: true,
            elevationProperty: 'alt_m',
            // Shared scene exaggeration, overridable per-dataset (the
            // continental MRMS demo lifts a 19 km column against a 4,500 km
            // continent).
            elevationScale:
              selectedDataset.elevationScale ?? STORM4D_ELEVATION_SCALE,
            radius:
              selectedDataset.radiusProperty ?? selectedDataset.radius ?? 320,
            radiusUnits: selectedDataset.radiusUnits ?? 'meters',
            radiusScale: selectedDataset.radiusScale ?? 1,
            radiusMinPixels: selectedDataset.radiusMinPixels ?? 1.2,
            radiusMaxPixels: selectedDataset.radiusMaxPixels ?? 8,
            stroked: false,
            ...(selectedDataset.filterProperty && {
              filterProperty: selectedDataset.filterProperty,
            }),
            ...(selectedDataset.filterRange && {
              filterRange: selectedDataset.filterRange,
            }),
            ...(selectedDataset.fadeInDuration !== undefined && {
              fadeInDuration: selectedDataset.fadeInDuration,
            }),
            ...(selectedDataset.fadeOutDuration !== undefined && {
              fadeOutDuration: selectedDataset.fadeOutDuration,
            }),
          }),
        );
      }

      // 5. VTEC warning polygons — translucent prisms with wireframe edges,
      // extruded 12 km so the walls enclose the volume. One feature per SBW
      // phase (issue → SVS shrink → expire), colored by `phenom`.
      if (selectedDataset.warningsUrl) {
        layers.push(
          new AnimatedPolygonLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-warnings`,
            ...sourceProps(`${selectedDataset.id}-warnings`, gates),
            data: selectedDataset.warningsUrl,
            filled: true,
            fillColor: 'phenom',
            colorMapping: STORM4D_WARNING_COLORS,
            colorMappingDefault: [200, 200, 210, 30],
            extruded: true,
            elevation: STORM4D_WARNING_HEIGHT_M,
            elevationScale: STORM4D_ELEVATION_SCALE,
            wireframe: true,
            // Constant wireframe-edge color (SolidPolygonLayer.getLineColor
            // pass-through) over the translucent phenom-colored walls.
            getLineColor: [255, 255, 255, 170],
          }),
        );
      }

      // 6. Mesocyclone couplet markers — white stroked rings at beam height,
      // sized by the detected gate-to-gate Δv. The narrative payoff of the
      // velocity mode, visible in both modes.
      if (selectedDataset.coupletUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-couplet`,
            ...sourceProps(`${selectedDataset.id}-couplet`, gates),
            data: selectedDataset.coupletUrl,
            fillColor: [255, 255, 255, 26],
            stroked: true,
            strokeColor: [255, 255, 255, 235],
            lineWidthMinPixels: 1.5,
            radius: 'strength_ms',
            radiusUnits: 'pixels',
            radiusScale: 1,
            radiusMinPixels: 6,
            radiusMaxPixels: 18,
            radiusTransform: STORM4D_COUPLET_RADIUS_TRANSFORM,
            billboard: true,
            use3D: true,
            elevationProperty: 'alt_m',
            elevationScale: STORM4D_ELEVATION_SCALE,
          }),
        );
      }

      // 7. Surface stations — per-minute ASOS dots at ground, sized by gust
      // and colored by `gust_band`, so the gust front sweeps the mesonet.
      if (selectedDataset.stationsUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-stations`,
            ...sourceProps(`${selectedDataset.id}-stations`, gates),
            data: selectedDataset.stationsUrl,
            fillColor: 'gust_band',
            colorMapping: STORM4D_GUST_COLORS,
            colorMappingDefault: [150, 155, 165, 90],
            radius: 'gust_kt',
            radiusUnits: 'pixels',
            radiusScale: 1,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 9,
            radiusTransform: STORM4D_STATION_RADIUS_TRANSFORM,
            stroked: false,
          }),
        );
      }

      // 8. Local storm reports — wake-mode markers colored by `kind`,
      // arriving BEHIND the storm (ground truth trailing the radar).
      if (selectedDataset.reportsUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-reports`,
            ...sourceProps(`${selectedDataset.id}-reports`, gates),
            data: selectedDataset.reportsUrl,
            fillColor: 'kind',
            colorMapping: STORM4D_REPORT_COLORS,
            colorMappingDefault: [180, 180, 190, 210],
            radius: 'magnitude',
            radiusUnits: 'pixels',
            radiusScale: 1,
            radiusMinPixels: 2.5,
            radiusMaxPixels: 8,
            radiusTransform: STORM4D_REPORT_RADIUS_TRANSFORM,
            wakeLength: 3600000, // 1 sim-h fading wake behind the storm
            wakeTailScale: 0.2,
            stroked: false,
          }),
        );
      }

      // 9. GLM lightning — the existing continental archive, timeRange-
      // subset by the demo clock, rendered at GROUND with the additive
      // splat treatment (§7 Q1 resolved: no fabricated altitude). Styling
      // mirrors the weather composite's flash layer (color legend-pinned).
      if (selectedDataset.lightningUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-lightning`,
            ...sourceProps(`${selectedDataset.id}-lightning`, gates),
            data: selectedDataset.lightningUrl,
            fillColor: LIGHTNING_FLASH_COLOR,
            radius: 'energy_fj',
            radiusUnits: 'pixels',
            radiusScale: 1,
            radiusMinPixels: 1,
            radiusMaxPixels: 6,
            radiusTransform: WEATHER_LIGHTNING_RADIUS_TRANSFORM,
            wakeLength: 700000,
            wakeTailScale: 0.15,
            splat: true,
            stroked: false,
            parameters: LIGHTNING_ADDITIVE_PARAMETERS,
          }),
        );
      }

      // 10. Radiosonde ascent — the OAX 18Z special launch climbing through
      // the scene as a small bright trail (delight layer, topmost).
      if (selectedDataset.soundingUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-sounding`,
            ...sourceProps(`${selectedDataset.id}-sounding`, gates),
            data: selectedDataset.soundingUrl,
            fillColor: [200, 240, 255, 235],
            radius: 2.5,
            radiusUnits: 'pixels',
            radiusScale: 1,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 4,
            wakeLength: 3600000, // the trail = the last sim-hour of ascent
            wakeTailScale: 0.25,
            billboard: true,
            use3D: true,
            elevationProperty: 'alt_m',
            elevationScale: STORM4D_ELEVATION_SCALE,
            stroked: false,
          }),
        );
      }

      return layers;
    }
    case 'av': {
      // Composite AV-telemetry render (streetscape.gl style). Up to three STT
      // archives from one scene bundle, painter order LIDAR → ego → objects:
      //   1. accumulated LIDAR point cloud — the primary `url`; reuses baseProps
      //      verbatim so the playback governor gates on the heaviest stream
      //      (categorical `height_band` fill via the colorMapping machinery);
      //   2. the ego trajectory (AnimatedTripsLayer) from `avEgoUrl`;
      //   3. tracked-object oriented 3D boxes (AnimatedBoundingBoxLayer) from
      //      `avObjectsUrl`, colored by categorical `category`.
      // Multi-source gating: the LIDAR / ego / objects streams are co-equal
      // views of the SAME instant, so all three register as REQUIRED governor
      // sources. The gate is min(runway) over required sources and the heavy
      // LIDAR dominates it, so requiring the TINY ego trip + object boxes adds
      // ~no latency — but it keeps the boxes/ego locked to the cloud on seek /
      // cold-start / fast playback instead of trailing it (they're optional no
      // longer). The HD-map substrate stays OPTIONAL: it's a static backdrop,
      // not a per-instant view. Only the PRIMARY archive (`url` — LIDAR, or the
      // ego trips on LIDAR-less scenes like comma.ai) keeps the overview-preload
      // tier (the storyboard pins one archive).
      const overlayBase = {
        ...baseProps,
        onOverviewPreload: undefined,
        overviewPreload: false,
      };
      const isPrimaryStream = (streamUrl: string) =>
        streamUrl === selectedDataset.url;
      // Base layer props (overview tier on the primary only) + per-layer
      // governor plumbing keyed by the layer's own id, registered REQUIRED so
      // ego/objects stay in lock-step with the LIDAR. comma.ai (ego-only) gates
      // correctly on its ego stream, which is its primary.
      const propsForStream = (layerId: string, streamUrl: string) => {
        const primary = isPrimaryStream(streamUrl);
        return {
          // Overview-preload tier on the primary only; gate on ALL of these
          // streams (required:true) — see the block comment above.
          ...(primary ? baseProps : overlayBase),
          ...sourceProps(layerId, true),
        };
      };
      // ── CUBE / Spacetime ─────────────────────────────────────────────────
      // Hägerstrand space-time cube of the TRACK trajectories: the `tracks/`
      // archive (one LineString per track + the synthetic "ego" spine) drawn as
      // 3D ribbons climbing through the cube — time = altitude (timeHeightScale),
      // slope = speed — colored by categorical `category`. This is a CLEAN render:
      // the LIDAR / objects / HD-map pushes are GATED OFF so only the ribbons (and
      // the now-plane, added by AvDeck) read against the dark backdrop. The lift is
      // done by AnimatedTripsLayer via the shared `timeHeightScale` baseProp. We
      // early-return so none of the cloud/box/map layers below get pushed.
      if (selectedDataset.avCube && selectedDataset.avTracksUrl) {
        return [
          new AnimatedTripsLayer({
            ...baseProps,
            id: selectedDataset.id, // bare id → the cockpit's "lidar" toggle slot
            ...sourceProps(selectedDataset.id, true),
            data: selectedDataset.avTracksUrl,
            // Categorical `category` (object classes + "ego") → ribbon color via
            // the property-name form of tripColor; AV_OBJECT_COLORS keeps colors
            // stable across tiles (and paints the synthetic "ego" track cyan).
            tripColor: 'category',
            ...(selectedDataset.avObjectColors && {
              colorMapping: selectedDataset.avObjectColors,
            }),
            ...(selectedDataset.colorMappingDefault && {
              colorMappingDefault: selectedDataset.colorMappingDefault,
            }),
            // Full-scene trail with NO fade: every track's whole spacetime thread
            // stays drawn so the cube reads as a complete bundle of trajectories
            // (not a moving worm). The clock + now-plane convey "now".
            trailLength:
              selectedDataset.timeRange.end - selectedDataset.timeRange.start,
            fadeTrail: false,
            // World-space width (~1.5 m) so threads thicken on zoom like real
            // objects; clamped to a legible 2–6 px band.
            tripWidth: 1.5,
            widthUnits: 'meters',
            widthMinPixels: 2,
            widthMaxPixels: 6,
            // Rounded caps/joints read better on the climbing 3D threads.
            capRounded: true,
            jointRounded: true,
            opacity: selectedDataset.opacity ?? 0.9,
          }),
        ];
      }
      const layers: any[] = [];
      // HD-map substrate — drawn FIRST so it sits UNDER the LIDAR/ego/objects:
      // drivable-area / crosswalk POLYGONS + lane-divider / boundary LINES, each
      // colored by a categorical `map_layer` via `mapColors`. Both stay
      // hardcoded OPTIONAL governor sources — deliberately exempt from
      // `overlayGatesPlayback`: they are TIMELESS static substrates (one
      // full-range archive, loaded once), so they cannot "run dry"
      // mid-playback; gating on them would only delay start. This is the
      // text-track case, unlike the time-animated radar/weather overlays.
      if (selectedDataset.avMapPolyUrl) {
        layers.push(
          new AnimatedPolygonLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-map-poly`,
            ...sourceProps(`${selectedDataset.id}-map-poly`, false),
            data: selectedDataset.avMapPolyUrl,
            filled: true,
            fillColor: 'map_layer',
            ...(selectedDataset.mapColors && {
              colorMapping: selectedDataset.mapColors,
            }),
            opacity: 1, // per-layer alpha lives in mapColors
            // Flat ground decal: kill the coplanar-polygon z-fighting (the
            // nuScenes drivable-area / lane / crosswalk fills heavily overlap).
            parameters: GROUND_DECAL_PARAMETERS,
          }),
        );
      }
      if (selectedDataset.avMapLineUrl) {
        layers.push(
          new AnimatedPathLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-map-line`,
            ...sourceProps(`${selectedDataset.id}-map-line`, false),
            data: selectedDataset.avMapLineUrl,
            pathColor: 'map_layer',
            ...(selectedDataset.mapColors && {
              colorMapping: selectedDataset.mapColors,
            }),
            widthUnits: 'meters',
            pathWidth: 0.35,
            widthMinPixels: 1,
            capRounded: false,
            jointRounded: false,
            opacity: 1,
            // Same flat ground decal as map_poly — the dividers sit ON the
            // fills at z=0, so they fight the polygons without this.
            parameters: GROUND_DECAL_PARAMETERS,
          }),
        );
      }
      if (
        selectedDataset.lidarStage &&
        selectedDataset.avStaticUrl &&
        selectedDataset.avDynamicUrl
      ) {
        // SCENE-SPLIT ("stage + actors"): TWO surfel archives → TWO layers.
        //   • STATIC stage (the fixed environment, accumulated + ERASOR-scrubbed
        //     at build): an OPTIONAL governor source that loads once and persists
        //     (one timeless full-range archive). Rendered with an effectively
        //     infinite temporalSigma so every surfel stays full-bright from t=0
        //     regardless of the playhead — a backdrop, no reveal/fade. Muted vs
        //     the actors. Painted UNDER.
        //   • DYNAMIC actors (the moving returns, kept per-sweep): the PRIMARY /
        //     required animated stream, smearing over a short temporal Gaussian so
        //     traffic reads as motion. Painted OVER, bright.
        const stageStatic = selectedDataset.lidarStageStatic ?? true;
        const stageSigma = stageStatic
          ? 1e9
          : (selectedDataset.lidarSurfelTemporalSigma ?? 1800);
        const actorSigma = selectedDataset.lidarSurfelTemporalSigma ?? 200;
        layers.push(
          new SplatLayer({
            ...overlayBase,
            id: `${selectedDataset.id}-stage`,
            // OPTIONAL: loads coordinated but never gates the clock (HD-map idiom).
            ...sourceProps(`${selectedDataset.id}-stage`, false),
            data: selectedDataset.avStaticUrl,
            elevationProperty: 'z',
            elevationScale: selectedDataset.elevationScale ?? 1,
            // Always-present backdrop: a huge sigma pins each surfel full-bright
            // independent of its first_seen vs the playhead (no accreting reveal).
            temporalSigma: stageSigma,
            temporalSigmaDynamic: stageSigma,
            cumulative: false,
            sizeScale: selectedDataset.lidarSurfelSizeScale ?? 1,
            // Muted + recessive so the moving agents pop against it. Dim by
            // default; tune per-scene via lidarStageOpacity.
            opacity: selectedDataset.lidarStageOpacity ?? 0.42,
            ...(perfMode ? { alphaCutoff: 0.2 } : {}),
          }),
        );
        layers.push(
          new SplatLayer({
            ...propsForStream(selectedDataset.id, selectedDataset.avDynamicUrl),
            id: selectedDataset.id, // bare id → the cockpit's "lidar" toggle slot
            data: selectedDataset.avDynamicUrl,
            elevationProperty: 'z',
            elevationScale: selectedDataset.elevationScale ?? 1,
            // Moving agents (is_dynamic = 1): a short temporal Gaussian so each
            // sweep's returns smear into motion rather than freezing or streaking.
            temporalSigma: actorSigma,
            temporalSigmaDynamic:
              selectedDataset.lidarWorldbuildDynamicSigma ?? actorSigma,
            // POP vs the recessive stage: chunkier disks (sizeScale) + full
            // opacity + a tighter alphaCutoff so each actor return reads as a solid
            // agent (discard the faint gaussian rim) instead of a hazy smear. The
            // bake-time punchier actor colour grade (av_common actor_grade) does the
            // rest of the pop.
            sizeScale: selectedDataset.lidarActorSizeScale ?? 1.8,
            opacity: selectedDataset.opacity ?? 1,
            alphaCutoff: perfMode ? 0.2 : 0.1,
          }),
        );
      } else if (
        selectedDataset.avLidarUrl &&
        selectedDataset.lidarWorldbuild
      ) {
        // WORLDBUILD: the `-world` surfel cloud rendered as a CUMULATIVE scene
        // reconstruction. STATIC surfels (is_dynamic = 0) persist once revealed —
        // a HUGE/effectively-infinite temporalSigma keeps them at full brightness
        // for the rest of playback — so the 3D world accumulates as the car drives;
        // DYNAMIC surfels smear with the short `temporalSigmaDynamic` so moving
        // traffic still reads as motion. `cumulative:true` tells SplatLayer to keep
        // every revealed static surfel resident; `revealFade` ramps a newly-shown
        // surfel in. Same baked orientation/extent/color columns as the surfel path.
        layers.push(
          new SplatLayer({
            ...propsForStream(selectedDataset.id, selectedDataset.avLidarUrl),
            id: selectedDataset.id, // bare id → the cockpit's "lidar" toggle
            data: selectedDataset.avLidarUrl,
            elevationProperty: 'z',
            elevationScale: selectedDataset.elevationScale ?? 1,
            // Accumulate: static surfels persist once revealed (the world builds up).
            cumulative: true,
            revealFade: selectedDataset.lidarWorldbuildRevealFade ?? 0,
            // Static/persistent temporal width — large so revealed static surfels
            // stay full-bright; the surfel scenes' tuned sigma is a sensible floor.
            temporalSigma: selectedDataset.lidarSurfelTemporalSigma ?? 1e9,
            // Dynamic surfels (moving objects) smear over this short window.
            temporalSigmaDynamic:
              selectedDataset.lidarWorldbuildDynamicSigma ?? 200,
            sizeScale: selectedDataset.lidarSurfelSizeScale ?? 1,
            opacity: selectedDataset.opacity ?? 1,
            ...(perfMode ? { alphaCutoff: 0.2 } : {}),
          }),
        );
      } else if (selectedDataset.avLidarUrl && selectedDataset.lidarSurfel) {
        // Surfel splat: render the cloud as ORIENTED Gaussian disks (SplatLayer)
        // that brighten/fade around each sweep's instant — a "formal" splat over
        // time. The bundle (waymo_extract.py --surfel) bakes the per-return
        // orientation quaternion + extents + confidence columns SplatLayer reads.
        layers.push(
          new SplatLayer({
            ...propsForStream(selectedDataset.id, selectedDataset.avLidarUrl),
            id: selectedDataset.id, // bare id → the cockpit's "lidar" toggle
            data: selectedDataset.avLidarUrl,
            // Real altitude from the baked `z` column → a true 3D surface.
            elevationProperty: 'z',
            elevationScale: selectedDataset.elevationScale ?? 1,
            // Soft temporal Gaussian — the cloud evolves as the playhead moves.
            temporalSigma: selectedDataset.lidarSurfelTemporalSigma ?? 180,
            sizeScale: selectedDataset.lidarSurfelSizeScale ?? 1,
            opacity: selectedDataset.opacity ?? 1,
            // Perf mode: discard faint disk rims sooner so the heavy surfel
            // cloud writes far fewer blended fragments (overdraw is the cost).
            ...(perfMode ? { alphaCutoff: 0.2 } : {}),
          }),
        );
      } else if (selectedDataset.avLidarUrl && selectedDataset.lidarIso) {
        // Density ISO-LINES: the `lidar/` archive is windowed contour LineStrings
        // (waymo_extract.py --contours) — a live topographic map of where the
        // cloud clusters, re-cut per playhead window. Drawn as ground-plane paths
        // colored by the categorical `density_band` ramp. The dataset's tight
        // `timeWindow` (~260 ms) shows ~one window's contours at a time so the map
        // morphs as the car drives. Carries the bare `id` so the cockpit's "lidar"
        // toggle + governor source still resolve.
        //
        // ISO 3D (`lidarIso3d`): the `-iso3d` bundle contours density per HEIGHT
        // LAYER and tags every contour with a numeric `z_layer` (its slab's real
        // altitude, metres). AnimatedPathLayer lifts each ring to `z_layer ×
        // scale`, so the vertical axis carries REAL structure (a wall contours up
        // its whole height, a parked car only near the ground) — not an artificial
        // band→height map. Still colored by the categorical `density_band` ramp.
        const iso3d = selectedDataset.lidarIso3d ?? false;
        layers.push(
          new AnimatedPathLayer({
            ...propsForStream(selectedDataset.id, selectedDataset.avLidarUrl),
            id: selectedDataset.id,
            data: selectedDataset.avLidarUrl,
            pathColor: selectedDataset.colorProperty ?? 'density_band',
            colorMapping: selectedDataset.lidarColorMapping,
            colorMappingDefault: selectedDataset.lidarColorMappingDefault,
            widthUnits: 'pixels',
            // Lift to the real per-contour height (numeric `z_layer` column);
            // slightly heavier lines read better terraced against the backdrop.
            ...(iso3d
              ? {
                  elevationProperty: 'z_layer',
                  elevationScale: selectedDataset.lidarIsoElevationScale ?? 1,
                  // Fade upper slabs translucent so the stack reads top-down
                  // (see AnimatedPathLayer.elevationOpacity*). Unset ⇒ un-graded.
                  ...(selectedDataset.lidarIsoTopFade
                    ? {
                        elevationOpacityRange:
                          selectedDataset.lidarIsoTopFade.range,
                        elevationOpacityNear:
                          selectedDataset.lidarIsoTopFade.near ?? 1,
                        elevationOpacityFar:
                          selectedDataset.lidarIsoTopFade.far ?? 1,
                      }
                    : {}),
                  pathWidth: 2,
                }
              : { pathWidth: 1.6 }),
            widthMinPixels: 1,
            widthMaxPixels: 4,
            capRounded: true,
            jointRounded: true,
            opacity: selectedDataset.opacity ?? 0.95,
          }),
        );
      } else if (selectedDataset.avLidarUrl && selectedDataset.lidarScan) {
        // SWEEP / SCAN: raw LIDAR (the `-scan` bundle, AV2 only) with each return
        // stamped at its TRUE scan time + a per-point phase ramp (r/g/b). Rendered
        // as a WAKE-mode point cloud so the rotating scan-line sweeps across the
        // scene each revolution like a live radar — a short tail fading behind the
        // leading edge. The dataset factory set a tight timeWindow (~300 ms) so a
        // frame shows roughly one live sweep; the object boxes are protected by the
        // Math.max(timeWindow, 2000) floor below. 3D via the real `z` column.
        layers.push(
          new AnimatedPointLayer({
            ...propsForStream(selectedDataset.id, selectedDataset.avLidarUrl),
            id: selectedDataset.id, // bare id → the cockpit's "lidar" toggle
            data: selectedDataset.avLidarUrl,
            // Phase-ramp color baked per-point (r/g/b) — the rotating scan hue.
            rgbColorColumns: ['r', 'g', 'b'] as [string, string, string],
            // Wake mode: each return draws as a fading + shrinking tail behind the
            // sweep's leading edge, so the scan-line reads as a moving sweep.
            wakeLength: 60,
            wakeTailScale: 0.1,
            use3D: true,
            elevationProperty: 'z',
            elevationScale: selectedDataset.elevationScale ?? 1,
            radius: selectedDataset.radius ?? 1.6,
            radiusUnits: selectedDataset.radiusUnits ?? 'pixels',
            radiusScale: selectedDataset.radiusScale ?? 1,
            radiusMinPixels: selectedDataset.radiusMinPixels ?? 1,
            radiusMaxPixels: selectedDataset.radiusMaxPixels,
            // Billboarded round points so each return reads at its real height.
            billboard: true,
            // Perf mode: drop the 1px edge antialiasing (pure fill-rate win).
            antialiasing: perfMode ? false : true,
            opacity: selectedDataset.opacity ?? 1,
          }),
        );
      } else if (selectedDataset.avLidarUrl) {
        layers.push(
          new AnimatedPointLayer({
            ...propsForStream(selectedDataset.id, selectedDataset.avLidarUrl),
            id: selectedDataset.id, // bare id → the cockpit's "lidar" toggle
            data: selectedDataset.avLidarUrl,
            // String fillColor = property name → GPU categorical fill; the
            // height-band colorMapping keeps each band stable across tiles.
            fillColor: selectedDataset.colorProperty ?? 'height_band',
            colorMapping: selectedDataset.lidarColorMapping,
            colorMappingDefault: selectedDataset.lidarColorMappingDefault,
            // Camera-colored bundles (waymo_extract --colorize) bake per-point
            // r/g/b columns; paint each return its own sampled color (wins over
            // the height ramp) and render as soft gaussian splats for the
            // photographic point-cloud look.
            ...(selectedDataset.lidarRgb
              ? { rgbColorColumns: ['r', 'g', 'b'] as [string, string, string] }
              : {}),
            splat: selectedDataset.lidarSplat ?? false,
            // Temporal fades scaled to the (tight) LIDAR window so each sweep
            // SNAPS to full brightness with a short crisp edge instead of the
            // long soft ramp the 300 ms default produces on a sub-second window
            // (which caps peak alpha < 1 and re-smears the tail). Quarter-window
            // fades leave a half-window full-bright core. Surfel scenes take the
            // SplatLayer branch above and are unaffected (temporalSigma there).
            fadeInDuration: Math.round(timeWindow * 0.25),
            fadeOutDuration: Math.round(timeWindow * 0.25),
            // Place each return at its real height (`z`, metres) so the tilted
            // cockpit camera renders a true 3D point CLOUD — not flat dots. The
            // tile carries a numeric `z` column; AnimatedPointLayer now fills the
            // position's z from it. `elevationScale` lets a scene exaggerate.
            use3D: true,
            elevationProperty: 'z',
            elevationScale: selectedDataset.elevationScale ?? 1,
            // Additive-octree zoom LOD: load + render the UNION of zoom levels
            // [minZoom..cameraZoom]. Each return lives at one home zoom, so coarse
            // levels are a sparse overview and zooming in streams only the deeper
            // residual (the coarse tiles stay resident). Built with --lod.
            ...(selectedDataset.lidarLod
              ? { lodMode: 'additive' as const }
              : {}),
            radius: selectedDataset.radius ?? 1.4,
            radiusUnits: selectedDataset.radiusUnits ?? 'pixels',
            radiusScale: selectedDataset.radiusScale ?? 1,
            radiusMinPixels: selectedDataset.radiusMinPixels ?? 1,
            radiusMaxPixels: selectedDataset.radiusMaxPixels,
            // Camera-facing dots so the point CLOUD reads volumetrically at the
            // tilted cockpit pitch. With the default ground-flat disks, returns
            // lying in the thin (~3 m) ground band foreshorten into a flat
            // carpet and the 3D structure (placed via elevationProperty `z`)
            // is invisible; billboarded round points keep each return legible
            // at its real height from any angle.
            billboard: true,
            // Perf mode: drop the 1px edge antialiasing (a pure fill-rate win,
            // ~no visual change on a dense cloud). For the RAW (non-splat) path
            // also force fully OPAQUE points so they become depth-tested opaque
            // writes — occluded returns early-z-reject instead of blending. The
            // splat path keeps its translucency (its gaussian rim does the fade).
            antialiasing: perfMode ? false : true,
            // LIDAR reads best as a dense cloud rather than translucent splats.
            opacity:
              perfMode && !selectedDataset.lidarSplat
                ? 1
                : (selectedDataset.opacity ?? 0.9),
          }),
        );
      }
      // NOTE: no full-scene ego trail here by design. A whole-drive AnimatedTripsLayer
      // registered as a REQUIRED governor source, so the playback clock gated on its
      // tiles (stalls/artifacts). The ego car box + predicted ribbon (egoLayers.ts)
      // keep the vehicle visible without gating the clock.
      if (selectedDataset.avObjectsUrl) {
        layers.push(
          new AnimatedBoundingBoxLayer({
            ...propsForStream(
              `${selectedDataset.id}-objects`,
              selectedDataset.avObjectsUrl,
            ),
            id: `${selectedDataset.id}-objects`,
            data: selectedDataset.avObjectsUrl,
            // The box layer interpolates ONE box per track from the two keyframes
            // BRACKETING the playhead, so the loader must keep ≥2 keyframes (the
            // objects archive is 1 s-bucketed at ~2 Hz) resident at all times.
            // The iso LIDAR mode narrows the dataset `timeWindow` to ~260 ms to
            // show one contour window — far too tight for the boxes, which then
            // go inactive between their last resident keyframe and the next
            // bucket loading (the boxes flash in/out). Floor the objects loader
            // window so the boxes stay locked to the cloud regardless of mode.
            timeWindow: Math.max(timeWindow, 2000),
            // Categorical `category` → oriented box color via the same
            // colorMapping machinery AnimatedColumnLayer uses.
            colorProperty: 'category',
            colorMapping: selectedDataset.avObjectColors,
            colorMappingDefault: selectedDataset.colorMappingDefault,
            headingProperty: 'heading',
            lengthProperty: 'length',
            widthProperty: 'width',
            heightProperty: 'height',
            // Detection-box look: crisp 12-edge cuboid OUTLINES (no solid fill),
            // so the LIDAR returns inside each box stay visible — the
            // streetscape.gl / nuScenes-devkit style. Per-object color/heading/
            // dims drive each outline exactly as they would the fill.
            filled: false,
            stroked: true,
            strokeWidth: 1.6,
            // streetscape.gl refinements: class labels above each box, velocity
            // arrows (derived from speed+heading), and click-to-inspect picking
            // (overrides the baseProps pickable:false for the objects layer only).
            pickable: true,
            showLabels: true,
            labelProperty: 'category',
            showVelocity: true,
          }),
        );
      }
      return layers;
    }
    default:
      return [];
  }
}
