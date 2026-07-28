/**
 * Layer tree for the Neural-State Atlas (`/atlas`).
 *
 * Per `docs/roadmap/neural-atlas-2026-07.md` §5.1 — ZERO new layer classes.
 * Every surface here is an existing `@poopdeck.gl/layers` layer with props.
 *
 *   1. atlas anatomy → `AnimatedPointLayer`. 294,912 latents at their position
 *      in ONE global manifold embedding of the decoder directions. This is the
 *      geography and it is the required governor source: the map must be up
 *      before the clock starts, or the first tokens land on an empty plane.
 *   2. the trace     → `AnimatedPointLayer` again, on the token clock. ~2.65 M
 *      activation events streamed by temporal bucket, never bundled.
 *   3. density field → `AnimatedHeatmapLayer` over the anatomy, off by default.
 *   4. concept loci  → `AnimatedPathLayer`, off by default.
 *
 * THERE ARE NO CLUSTER HULLS, and that is a finding rather than an omission
 * (§15.7). Four measurements agree: Leiden communities have an 80%-radius of
 * 2.98–3.58° on a 32° plane; a clumpier embedding (n=12, min_dist=0) made that
 * WORSE at 5.81°, because UMAP's islands cut across the partition; HDBSCAN on
 * the embedding itself finds two clusters with 18% noise; and 87.8% of
 * region-hull pairs overlapped when they were drawn. The cause is that an SAE
 * decoder dictionary is close to isotropic — random-pair cosine 0.0099, PCA-256
 * captures 62% of the variance — so it carries real LOCAL neighbourhood
 * structure and no macro-cluster structure to project.
 *
 * Boundaries drawn anyway would be the §3 failure exactly: a map is a
 * persuasive object, and a border implies a natural kind. So the map states
 * what is true instead — where the projection is DENSE, and what the published
 * explanations there have in common. Cluster identity survives as a per-latent
 * property for inspection and filtering, which is what it actually is.
 *
 * DEPTH. X/Y/Z are one isotropic embedding, but Z rides as a numeric COLUMN
 * (`z_embed_m`) rather than baked into the tile geometry. `use3D` is documented
 * upstream as an enabling hint; `elevationProperty` is the real switch. So flat
 * and 3-D are the same archive and the same tiles, and the toggle costs a prop
 * rather than a rebuild. Flat is the default because a plan view is where the
 * emergent structure reads.
 *
 * The trace's colour is driven by {@link AtlasMetric} through `rampProperty` /
 * `rampDomain` / `rampColorRamp`, so switching metric switches the COLUMN the
 * GPU reads and the legend the panel draws comes from the same record. There is
 * no code path that can colour by attribution under an activation legend.
 */
import {
  AnimatedHeatmapLayer,
  AnimatedPathLayer,
  AnimatedPointLayer,
} from '@poopdeck.gl/layers';
import type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';
import type { TimeController } from '@poopdeck.gl/playback';
import type { SourceRegistry } from '@poopdeck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { tileLoadingProps } from '../../types';
import {
  ATLAS_METRICS,
  LAYER_COLORS,
  SELECTION_COLOR,
  SELECTION_HALO,
  STATUS_ORDER,
  type AtlasMetricDomains,
  type AtlasMetricId,
  type InterpretationStatus,
} from './atlasTypes';

export const ATLAS_LAYER_IDS = {
  density: 'atlas-density',
  manifolds: 'atlas-manifolds',
  anatomy: 'atlas-anatomy',
  trace: 'atlas-trace',
  selection: 'atlas-selection',
} as const;

/**
 * Emphasis budget, in one place because it only works as a ratio.
 *
 * The anatomy is 294,912 points of context and the trace is a few hundred
 * points of event. If the context is drawn at anything like the event's weight
 * the event cannot win, no matter how bright it is — a quarter-million faint
 * points sum to a bright fog. So the context is pushed down hard and the
 * headroom that frees up is spent on the trace and the selection.
 */
const EMPHASIS = {
  /** Anatomy opacity with nothing selected. */
  contextIdle: 0.2,
  /** Anatomy opacity once something IS selected — everything else recedes. */
  contextFocused: 0.09,
  /** Trace opacity, always full: it is the thing the page is about. */
  trace: 1,
};

export interface AtlasArchiveUrls {
  anatomy: string;
  manifolds: string;
  trace: string;
}

export interface BuildAtlasLayersArgs {
  urls: AtlasArchiveUrls;
  timeController: TimeController;
  registry: SourceRegistry;
  timeRange: { start: number; end: number };
  /** Playback window in ms — one token is 1000 ms, so this is "tokens of tail". */
  timeWindow: number;
  playbackSpeed: number;
  metric: AtlasMetricId;
  /** `[min, max]` for the active metric's ramp. */
  metricDomain: [number, number];
  visibleStatuses: Set<InterpretationStatus>;
  /**
   * Vertical exaggeration of the embedding's third component. 0 = flat, and
   * flat is byte-identical to a 2-D render because `elevationProperty` is left
   * unset rather than being set with a zero scale.
   */
  depth: number;
  /** Column carrying that third component, from the sidecar's frame record. */
  elevationColumn: string;
  showAnatomy: boolean;
  showTrace: boolean;
  /** Smooth per-pixel density over the same archive. Off by default: it is a
   *  second tileset on the anatomy, and the point cloud's own overdraw is
   *  already a density field for most purposes. */
  showDensity: boolean;
  showManifolds: boolean;
  pickable: boolean;
  /**
   * `[lon, lat]` of the current selection, or null. Taken from the click's
   * coordinate rather than the picked feature, because the STT picking path
   * returns decoded PROPERTIES and the geometry does not ride along — at these
   * radii the difference is under a pixel.
   */
  selectionPosition: [number, number] | null;
}


export const CONCEPT_COLORS: Record<string, [number, number, number, number]> =
  {
    digits: [255, 214, 102, 255],
    weekdays: [126, 217, 255, 255],
    months: [178, 152, 255, 255],
    colours: [255, 140, 170, 255],
  };

export function buildAtlasLayers({
  urls,
  timeController,
  registry,
  timeRange,
  timeWindow,
  playbackSpeed,
  metric,
  metricDomain,
  visibleStatuses,
  depth,
  elevationColumn,
  showAnatomy,
  showTrace,
  showDensity,
  showManifolds,
  pickable,
  selectionPosition,
}: BuildAtlasLayersArgs): any[] {
  const spec = ATLAS_METRICS[metric];
  const focused = !!selectionPosition;
  const archiveCount =
    (showAnatomy ? 1 : 0) +
    (showTrace ? 1 : 0) +
    (showDensity ? 1 : 0) +
    (showManifolds ? 1 : 0) || 1;

  const sourceProps = (layerId: string, required: boolean) => ({
    onTilesetReady: (tileset: BufferSource) =>
      registry.registerSource(layerId, tileset, { required }),
    onBufferChange: (runway: BufferedRunway) =>
      registry.onBufferChange(layerId, runway),
  });

  // Only name the elevation column when depth is actually on: unset means z
  // stays 0 with no per-point pad, and setting it costs O(points) on every
  // change of the exaggeration.
  const elevation =
    depth > 0
      ? { use3D: true, elevationProperty: elevationColumn, elevationScale: depth }
      : {};

  const baseProps = {
    // Seed only — the layers read live time off the shared controller each draw.
    currentTime: timeRange.start,
    timeController,
    timeWindow,
    timeRange,
    ...tileLoadingProps(timeWindow, playbackSpeed),
    maxCacheSize: Math.max(400, Math.floor(1600 / archiveCount)),
    maxCacheByteSize: Math.max(
      384 * 2 ** 20,
      Math.floor((1.5 * 2 ** 30) / archiveCount),
    ),
    // Z is the embedding's third component, never time. The space-time-cube
    // reading of the same archive would be a separate view.
    timeHeightScale: 0,
    timeHeightOrigin: timeRange.start,
  };

  const layers: any[] = [];

  // 1. Density — a genuine per-pixel accumulation of the same points, under
  //    everything. This is what replaced the hulls: it says where the picture
  //    is dense, which is true, rather than where the model has borders, which
  //    it does not.
  if (showDensity) {
    layers.push(
      new AnimatedHeatmapLayer({
        ...baseProps,
        id: ATLAS_LAYER_IDS.density,
        ...sourceProps(ATLAS_LAYER_IDS.density, false),
        data: urls.anatomy,
        // Uniform weight: the question is "how many latents are here", not
        // "how loud are they" — loudness is what the trace is for.
        weightProperty: null,
        radiusPixels: 34,
        intensity: 1,
        threshold: 0.06,
        opacity: 0.5,
        pickable: false,
      }),
    );
  }

  // 2. The anatomy — the geography, and the REQUIRED source. Drawn as soft
  //    low-alpha splats so that overdraw in the dense filaments does the work
  //    of a density field: where the embedding piles latents up, the map glows.
  if (showAnatomy) {
    layers.push(
      new AnimatedPointLayer({
        ...baseProps,
        id: ATLAS_LAYER_IDS.anatomy,
        ...sourceProps(ATLAS_LAYER_IDS.anatomy, true),
        data: urls.anatomy,
        // The archive's per-feature min-zoom is a cumulative LOD budget, so
        // additive keeps every level resident as the map densifies rather than
        // swapping tiers under the camera.
        lodMode: 'additive',
        ...elevation,
        fillColor: 'layer_band',
        colorMapping: LAYER_COLORS,
        colorMappingDefault: [120, 130, 150, 200],
        radius: 1.1,
        radiusUnits: 'pixels',
        radiusMinPixels: 0.6,
        radiusMaxPixels: 2.4,
        billboard: true,
        splat: true,
        opacity: focused ? EMPHASIS.contextFocused : EMPHASIS.contextIdle,
        pickable,
        ...(visibleStatuses.size && visibleStatuses.size < STATUS_ORDER.length
          ? {
              // GPU push-down is range-based and hide-only, so the status
              // filter rides `label_confidence` where it maps cleanly and
              // otherwise widens rather than pretending to be exact.
              filterProperty: 'label_confidence',
              filterRange: statusConfidenceRange(visibleStatuses),
            }
          : {}),
      }),
    );
  }

  // 3. Concept loci — off by default; the detail view carries this argument now.
  if (showManifolds) {
    layers.push(
      new AnimatedPathLayer({
        ...baseProps,
        id: ATLAS_LAYER_IDS.manifolds,
        ...sourceProps(ATLAS_LAYER_IDS.manifolds, false),
        data: urls.manifolds,
        pathColor: 'concept',
        colorMapping: CONCEPT_COLORS,
        colorMappingDefault: [200, 200, 200, 200],
        widthUnits: 'pixels',
        pathWidth: 2,
        widthMinPixels: 1.5,
        widthMaxPixels: 4,
        capRounded: true,
        jointRounded: true,
        opacity: 0.85,
        pickable,
      }),
    );
  }

  // 4. The trace — the playback layer, and the reason this is an STT demo at
  //    all. Colour comes from the METRIC record, not from this call site.
  if (showTrace) {
    layers.push(
      new AnimatedPointLayer({
        ...baseProps,
        id: ATLAS_LAYER_IDS.trace,
        ...sourceProps(ATLAS_LAYER_IDS.trace, false),
        data: urls.trace,
        ...elevation,
        rampProperty: spec.column ?? undefined,
        rampDomain: metricDomain,
        rampColorRamp: spec.ramp,
        radius: 4.2,
        radiusUnits: 'pixels',
        radiusMinPixels: 2.2,
        radiusMaxPixels: 13,
        billboard: true,
        // `splat` is what makes these read as light rather than as dots: a soft
        // gaussian falloff over a dark field is a glow, and overlapping glows
        // accumulate into a bright core for free.
        splat: true,
        opacity: EMPHASIS.trace,
        // A fraction of a token's fade at each end: an event should read as a
        // pulse on its own token, not smear across the neighbours.
        fadeInDuration: Math.round(timeWindow * 0.2),
        fadeOutDuration: Math.round(timeWindow * 0.35),
        pickable,
      }),
    );
  }

  // 5. Selection — drawn last, over everything, and the only white on the map.
  //    Two rings: a wide soft halo that finds the point at any zoom, and a
  //    crisp hairline that says exactly which point it is.
  if (selectionPosition) {
    const marker = [{ position: selectionPosition }];
    layers.push(
      new ScatterplotLayer({
        id: `${ATLAS_LAYER_IDS.selection}-halo`,
        data: marker,
        getPosition: (d: any) => d.position,
        getRadius: 1,
        radiusUnits: 'pixels',
        radiusMinPixels: 17,
        radiusMaxPixels: 17,
        filled: false,
        stroked: true,
        getLineColor: [...SELECTION_HALO, 90] as [number, number, number, number],
        getLineWidth: 6,
        lineWidthUnits: 'pixels',
        pickable: false,
      }),
      new ScatterplotLayer({
        id: `${ATLAS_LAYER_IDS.selection}-ring`,
        data: marker,
        getPosition: (d: any) => d.position,
        getRadius: 1,
        radiusUnits: 'pixels',
        radiusMinPixels: 9,
        radiusMaxPixels: 9,
        filled: false,
        stroked: true,
        getLineColor: [...SELECTION_COLOR, 235] as [
          number,
          number,
          number,
          number,
        ],
        getLineWidth: 1.5,
        lineWidthUnits: 'pixels',
        pickable: false,
      }),
    );
  }

  return layers;
}

/**
 * Map a status selection onto a `label_confidence` range.
 *
 * Honest about its own approximation: the GPU DataFilter extension is a numeric
 * RANGE filter and status is categorical, so this can only express the
 * confidence-ordered prefix/suffix of a selection. `unlabeled` carries
 * confidence 0 and `reviewed` ≥ 0.70 by construction (the generator's
 * `_status_from_agreement`), so the common selections — "hide the unlabeled",
 * "reviewed only" — are exact; a mixed selection widens to the enclosing range
 * rather than silently dropping members.
 */
function statusConfidenceRange(
  visible: Set<InterpretationStatus>,
): [number, number] {
  let lo = 1;
  let hi = 0;
  const bounds: Record<InterpretationStatus, [number, number]> = {
    unlabeled: [0, 0.0001],
    contested: [0.0001, 0.4],
    tentative: [0.4, 0.7],
    reviewed: [0.7, 1],
    validated: [0.7, 1],
  };
  for (const s of visible) {
    lo = Math.min(lo, bounds[s][0]);
    hi = Math.max(hi, bounds[s][1]);
  }
  return hi >= lo ? [lo, hi] : [0, 1];
}

/**
 * The active metric's ramp domain, taken from the archive's own distribution.
 *
 * The first build hardcoded `p99: 12` for activation — the real p99 is 32.8 —
 * and `0.06` for attribution, which was at the time identically zero. A legend
 * whose domain is a guess is a legend that lies, so the numbers travel with the
 * data in `sidecar.metric_domains` and this only chooses between them.
 */
export function metricDomainFor(
  metric: AtlasMetricId,
  domains: AtlasMetricDomains | undefined,
): [number, number] {
  const spec = ATLAS_METRICS[metric];
  if (spec.diverging) {
    // Attribution is long-tailed and signed (max |x| is ~90× the 99.5th
    // percentile), so the ramp is set at p99.5 and the tail saturates rather
    // than flattening everything else to grey.
    const top = domains?.attribution?.abs_p995 ?? domains?.attribution?.abs_p99 ?? 1;
    return [-top, top];
  }
  const top = domains?.activation?.p99 ?? domains?.activation?.max ?? 1;
  return [0, top];
}
