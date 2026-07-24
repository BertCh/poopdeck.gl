/**
 * Layer tree for the World Model Scenario Explorer (`/worlds`).
 *
 * Four cross-scenario STT archives carry all 300 worlds at once, drawn in
 * painter order under a synthetic-grid camera:
 *
 *   1. HD-map polygons  (lane surfaces, crosswalks, road markings, signal
 *      footprints) — a TIMELESS full-range archive, optional governor source,
 *      zoom-gated to the fly-in ({@link MAP_DETAIL_ZOOM});
 *   2. HD-map lines     (lane centerlines, boundaries, stop lines) — likewise;
 *   2b. HD-map LOD points — a decimated additive-octree POINT sampling of the
 *      lane network shown at OVERVIEW in place of the crisp lines, so the gallery
 *      loads a sparse coarse tier instead of the full ~105 MB line archive at
 *      every zoom (each point has a `home_zoom`; `lodMode:'additive'`);
 *   3. ego trips        — the PRIMARY, and the only REQUIRED source: 300 short
 *      LineStrings, so the clock gates on something that loads fast and is
 *      always visibly moving;
 *   4. agent boxes      — mounted only when the camera is close enough for a
 *      2 m box to be more than a pixel ({@link BOX_ZOOM}); an optional source
 *      so mounting/unmounting can never hitch the shared clock;
 *   5. hero LiDAR       — one selected hero's point cloud, streamed only while
 *      that hero is selected and the camera is inside its cell;
 *   6. anchor dots      — a plain client-side ScatterplotLayer over the ~300
 *      worlds.json records. This is the reliable click target at overview zoom
 *      AND the only surface that can DIM (rather than hide) filtered-out
 *      worlds, since the GPU DataFilter extension is hide-only.
 *
 * The recipes here (governor plumbing via `sourceProps`, the shared prefetch
 * props, the composite cache split, the flat-ground-decal parameters) mirror
 * `buildDemoLayers`' `case 'av'` deliberately — this page needs a different
 * layer SET, not different tuning.
 */
import { ScatterplotLayer } from '@deck.gl/layers';
import {
  AnimatedBoundingBoxLayer,
  AnimatedPathLayer,
  AnimatedPointLayer,
  AnimatedPolygonLayer,
  AnimatedTripsLayer,
} from '@poopdeck.gl/layers';
import type {
  BufferSource,
  BufferedRunway,
  TimeController,
} from '@poopdeck.gl/playback';
import { tileLoadingProps } from '../../types';
import type { Dataset } from '../../types';
import type { DemoSourceRegistry } from '../demo/buildDemoLayers';
import {
  resolveWorldAsset,
  weatherColor,
  type WorldFilterChip,
  type WorldScenario,
  type WorldsIndex,
} from './worldsTypes';

/**
 * Flat ground decal for the HD-map substrate — the lane surfaces of 300 clips
 * are coplanar at z=0 and heavily overlapping, which z-fights without this.
 * Same values as `buildDemoLayers`' `GROUND_DECAL_PARAMETERS`.
 */
const GROUND_DECAL_PARAMETERS = {
  depthCompare: 'always' as const,
  depthWriteEnabled: false,
};

/**
 * Camera zoom at which the agent boxes mount. Below this a whole scenario is
 * ~40 px wide, so 300 scenarios' worth of interpolated boxes (~12k tracks
 * rebuilt on the CPU every frame) would cost the frame budget to draw
 * sub-pixel confetti. The ego trails + map carry the overview instead.
 */
export const BOX_ZOOM = 13.5;

/**
 * Camera zoom at which the crisp HD-map lines + polygons mount. Below this the
 * overview draws the additive-LOD point network ({@link WORLD_LAYER_IDS.mapPoints})
 * instead — the full `map_line` archive replicates every centerline at every zoom
 * (~105 MB) and is sub-pixel from far out, so streaming it for the whole gallery
 * is the overview's dominant cost. Set just below {@link BOX_ZOOM} so the road
 * surfaces resolve a beat before the agent boxes as you fly into a cell.
 */
export const MAP_DETAIL_ZOOM = 13;

/** Camera zoom at which a selected hero's LiDAR cloud starts streaming. */
export const HERO_LIDAR_ZOOM = 15;

/** Layer-id suffixes, exported so the page can unregister governor sources. */
export const WORLD_LAYER_IDS = {
  mapPoly: (id: string) => `${id}-map-poly`,
  mapLine: (id: string) => `${id}-map-line`,
  mapPoints: (id: string) => `${id}-map-points`,
  ego: (id: string) => id,
  objects: (id: string) => `${id}-objects`,
  heroLidar: (id: string) => `${id}-hero-lidar`,
  anchors: (id: string) => `${id}-anchors`,
};

export interface BuildWorldsLayersArgs {
  dataset: Dataset;
  worlds: WorldsIndex | null;
  timeController: TimeController;
  registry: DemoSourceRegistry;
  /** Active filter predicate, or null for "all worlds". */
  chip: WorldFilterChip | null;
  selected: WorldScenario | null;
  /** Live camera zoom — gates the boxes and the hero cloud. */
  zoom: number;
  /** Bundle root for hero-LiDAR manifests (see `worldsBaseUrl`). */
  worldsBase: string;
  reducedMotion: boolean;
}

export function buildWorldsLayers({
  dataset,
  worlds,
  timeController,
  registry,
  chip,
  selected,
  zoom,
  worldsBase,
  reducedMotion,
}: BuildWorldsLayersArgs): any[] {
  const timeRange = worlds
    ? { start: worlds.t0, end: worlds.t0 + worlds.durationMs }
    : dataset.timeRange;
  const timeWindow = dataset.timeWindow ?? 2000;
  const span = timeRange.end - timeRange.start;
  const playbackSpeed = span / ((dataset.targetPlaybackSeconds || 4) * 1000);

  const showBoxes = zoom >= BOX_ZOOM;
  // The crisp HD-map lines/polys mount only on zoom-in; the overview draws the
  // additive-LOD point network instead (the 105 MB line archive is sub-pixel
  // and heavy from far out — see MAP_DETAIL_ZOOM).
  const showMapDetail = zoom >= MAP_DETAIL_ZOOM;
  const showMapPoints = !showMapDetail && !!dataset.avMapPointsUrl;
  const heroLidarPath = selected?.hero ? selected.lidar : undefined;
  const showHeroLidar = !!heroLidarPath && zoom >= HERO_LIDAR_ZOOM;
  // Ego trip (always) + whichever map representation is mounted (2 crisp archives
  // when zoomed in, else the 1 LOD-point archive) + the conditional box/hero
  // clouds. Sizes the composite cache split across the tilesets actually loading.
  const archiveCount =
    1 +
    (showMapDetail
      ? (dataset.avMapPolyUrl ? 1 : 0) + (dataset.avMapLineUrl ? 1 : 0)
      : showMapPoints
        ? 1
        : 0) +
    (showBoxes ? 1 : 0) +
    (showHeroLidar ? 1 : 0);

  const sourceProps = (layerId: string, required: boolean) => ({
    onTilesetReady: (tileset: BufferSource) =>
      registry.registerSource(layerId, tileset, { required }),
    onBufferChange: (runway: BufferedRunway) =>
      registry.onBufferChange(layerId, runway),
  });

  // GPU filter push-down. Hide-only (there is no dim mode) and `filterSize: 1`,
  // so exactly one column is ever active — see FILTER_CHIPS.
  const filterProps = chip
    ? { filterProperty: chip.filterProperty, filterRange: chip.filterRange }
    : {};

  const baseProps = {
    // Seed only: the layers read live time off the shared controller each draw,
    // so the prop tree stays stable at 60 Hz.
    currentTime: timeRange.start,
    timeController,
    timeWindow,
    timeRange,
    opacity: dataset.opacity ?? 0.95,
    pickable: false,
    ...tileLoadingProps(timeWindow, playbackSpeed),
    // Composite cache split: each tileset takes a slice of the ~2 GiB budget.
    maxCacheSize: Math.max(600, Math.floor(2000 / archiveCount)),
    maxCacheByteSize: Math.max(
      512 * 2 ** 20,
      Math.floor((2 * 2 ** 30) / archiveCount),
    ),
    timeHeightScale: 0,
    timeHeightOrigin: timeRange.start,
  };

  const layers: any[] = [];
  const ids = WORLD_LAYER_IDS;

  // 1. HD-map polygons — timeless substrate, optional source (it cannot run
  //    dry mid-playback, so gating the clock on it would only delay start).
  //    Zoom-gated: the crisp surfaces only mount once you fly into a cell.
  if (showMapDetail && dataset.avMapPolyUrl) {
    layers.push(
      new AnimatedPolygonLayer({
        ...baseProps,
        id: ids.mapPoly(dataset.id),
        ...sourceProps(ids.mapPoly(dataset.id), false),
        data: dataset.avMapPolyUrl,
        filled: true,
        fillColor: 'map_layer',
        ...(dataset.mapColors && { colorMapping: dataset.mapColors }),
        opacity: 1, // per-layer alpha lives in mapColors
        parameters: GROUND_DECAL_PARAMETERS,
        ...filterProps,
      }),
    );
  }

  // 2. HD-map lines — likewise zoom-gated to the fly-in. At overview the full
  //    ~105 MB centerline archive (every feature replicated at every zoom) is
  //    sub-pixel and the gallery's dominant load, so the LOD points below stand
  //    in for it from far out.
  if (showMapDetail && dataset.avMapLineUrl) {
    layers.push(
      new AnimatedPathLayer({
        ...baseProps,
        id: ids.mapLine(dataset.id),
        ...sourceProps(ids.mapLine(dataset.id), false),
        data: dataset.avMapLineUrl,
        pathColor: 'map_layer',
        ...(dataset.mapColors && { colorMapping: dataset.mapColors }),
        widthUnits: 'meters',
        pathWidth: 0.35,
        widthMinPixels: 1,
        capRounded: false,
        jointRounded: false,
        opacity: 1,
        parameters: GROUND_DECAL_PARAMETERS,
        ...filterProps,
      }),
    );
  }

  // 2b. HD-map LOD point overview — the sparse dotted road network the gallery
  //     shows INSTEAD of the crisp lines below MAP_DETAIL_ZOOM. The archive tags
  //     each point with a single `home_zoom`, so with `lodMode: 'additive'` the
  //     client loads only the coarse tier (z10–11) at overview and densifies on
  //     zoom-in — the load stays cheap by construction, not by hiding features.
  //     Points are timeless (valid the whole loop), colored by the SAME
  //     `map_layer` ramp as the lines so the two read as one road network across
  //     the crossover. Optional source (a faint substrate; the ego trips remain
  //     the clock's required heartbeat).
  if (showMapPoints && dataset.avMapPointsUrl) {
    layers.push(
      new AnimatedPointLayer({
        ...baseProps,
        id: ids.mapPoints(dataset.id),
        ...sourceProps(ids.mapPoints(dataset.id), false),
        data: dataset.avMapPointsUrl,
        lodMode: 'additive',
        fillColor: 'map_layer',
        ...(dataset.mapColors && { colorMapping: dataset.mapColors }),
        colorMappingDefault: dataset.colorMappingDefault,
        radius: 1.3,
        radiusUnits: 'pixels',
        radiusMinPixels: 1,
        billboard: true,
        opacity: 1, // per-layer alpha lives in mapColors, matching the lines
        parameters: GROUND_DECAL_PARAMETERS,
        ...filterProps,
      }),
    );
  }

  // 3. Ego trips — the primary + only REQUIRED source. Unlike the cockpit
  //    (where a whole-drive trail gated the clock on a heavy archive), these
  //    are 300 ten-second paths totalling a few hundred KB, so gating here is
  //    both honest and cheap — and it is what makes the overview feel alive.
  layers.push(
    new AnimatedTripsLayer({
      ...baseProps,
      id: ids.ego(dataset.id),
      ...sourceProps(ids.ego(dataset.id), true),
      data: dataset.avEgoUrl ?? dataset.url,
      tripColor: dataset.tripColor ?? [120, 230, 255, 255],
      // FULL-span trail with a fade. At overview zoom the grid is ~19 m/px, so
      // a world's whole ~120 m route is only ~6 px — a short trail would be
      // sub-pixel and the gallery would look static. Drawing the whole route
      // and fading the tail makes each cell a dash that grows and resets, which
      // is what reads as "300 worlds all running" from far out.
      trailLength: span,
      fadeTrail: dataset.fadeTrail ?? true,
      widthUnits: 'meters',
      tripWidth: dataset.tripWidth ?? 2,
      widthMinPixels: 2,
      widthMaxPixels: 6,
      capRounded: true,
      jointRounded: true,
      ...filterProps,
    }),
  );

  // 4. Agent boxes — zoom-gated, optional source.
  if (showBoxes && dataset.avObjectsUrl) {
    layers.push(
      new AnimatedBoundingBoxLayer({
        ...baseProps,
        id: ids.objects(dataset.id),
        ...sourceProps(ids.objects(dataset.id), false),
        data: dataset.avObjectsUrl,
        // The layer interpolates one box per track from the two keyframes
        // bracketing the playhead, so the loader must always hold ≥2 of the
        // 10 Hz keyframes — floor the window well above the bucket size.
        timeWindow: Math.max(timeWindow, 2000),
        colorProperty: 'category',
        colorMapping: dataset.avObjectColors,
        colorMappingDefault: dataset.colorMappingDefault,
        headingProperty: 'heading',
        lengthProperty: 'length',
        widthProperty: 'width',
        heightProperty: 'height',
        // Wireframe detection boxes, streetscape.gl style.
        filled: false,
        stroked: true,
        strokeWidth: 1.6,
        pickable: true,
        // Labels + velocity arrows are per-box CPU text/geometry; at gallery
        // scale they'd swamp the frame, so they stay off even when zoomed in.
        showLabels: false,
        showVelocity: false,
      }),
    );
  }

  // 5. Hero LiDAR — lazily mounted for the selected hero only.
  if (showHeroLidar && heroLidarPath) {
    layers.push(
      new AnimatedPointLayer({
        ...baseProps,
        id: ids.heroLidar(dataset.id),
        ...sourceProps(ids.heroLidar(dataset.id), false),
        data: resolveWorldAsset(worldsBase, heroLidarPath),
        fillColor: 'height_band',
        colorMapping: dataset.lidarColorMapping,
        colorMappingDefault: dataset.lidarColorMappingDefault,
        // Quarter-window fades: each 100 ms sweep snaps in crisply instead of
        // smearing across the default 300 ms ramp on a sub-second window.
        fadeInDuration: Math.round(timeWindow * 0.25),
        fadeOutDuration: Math.round(timeWindow * 0.25),
        use3D: true,
        elevationProperty: 'z',
        radius: 1.4,
        radiusUnits: 'pixels',
        radiusMinPixels: 1,
        billboard: true,
        opacity: 0.9,
      }),
    );
  }

  // 6. Anchor dots — client-side, ~300 rows. Click target + the dimming
  //    surface for filtered-out worlds, tinted by generated weather.
  if (worlds) {
    const selectedId = selected?.id;
    layers.push(
      new ScatterplotLayer({
        id: ids.anchors(dataset.id),
        data: worlds.scenarios,
        pickable: true,
        getPosition: (s: WorldScenario) => [s.origin.lon, s.origin.lat],
        // Sized to a fraction of the cell so the dots read as world markers at
        // overview zoom and shrink out of the way once you fly in.
        radiusUnits: 'meters',
        getRadius: (s: WorldScenario) =>
          (s.id === selectedId ? 0.16 : 0.1) * worlds.grid.pitchM,
        radiusMinPixels: 2,
        radiusMaxPixels: 26,
        stroked: true,
        getLineColor: (s: WorldScenario) =>
          s.id === selectedId ? [255, 255, 255, 235] : [255, 255, 255, 40],
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        filled: true,
        getFillColor: (s: WorldScenario) => {
          const [r, g, b] = weatherColor(s.weather);
          // Hide-only GPU filtering means the STT geometry of non-matching
          // worlds vanishes; keeping their dot faint preserves the grid.
          const dim = chip && !chip.match(s);
          const hero = s.hero ? 30 : 0;
          if (s.id === selectedId) return [255, 255, 255, 220];
          return [r, g, b, dim ? 26 : 120 + hero];
        },
        // Boxes take over as the readable content once we're zoomed in, so the
        // dots recede rather than covering the scene.
        opacity: reducedMotion
          ? 0.9
          : Math.min(1, Math.max(0.15, 1 - (zoom - 12) / 4)),
        updateTriggers: {
          getFillColor: [chip?.id ?? '', selectedId ?? ''],
          getRadius: [selectedId ?? '', worlds.grid.pitchM],
          getLineColor: [selectedId ?? ''],
        },
      }),
    );
  }

  return layers;
}
