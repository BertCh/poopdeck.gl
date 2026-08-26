// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTHexbinLayer` — a RUNTIME hexbin over the RAW point tier, for CesiumJS.
 *
 * ## What it renders
 *
 * A fixed-radius hex lattice of aggregate plates (or prisms, when `extruded`),
 * computed IN THE BROWSER from whatever raw features are resident, over
 * whatever slice of time the playhead is looking at. Every hex is one
 * `PolygonGeometry` `GeometryInstance` under a single batched `Primitive` with
 * a `PerInstanceColorAppearance`, exactly like `STTH3SummaryLayer` — one
 * draw-call bucket, per-frame alpha through the batch table.
 *
 * ## Why it exists, given `STTH3SummaryLayer` already draws hexagons
 *
 * They are not the same layer and one does not subsume the other:
 *
 *   - `STTH3SummaryLayer` DECODES a summary tier the archive baked. It needs
 *     `stt-build --summary`, it is blind to the playback window (it colours by
 *     a pre-computed column), and it costs nothing per frame. Reach for it on a
 *     planet-scale archive.
 *   - `STTHexbinLayer` (this) BINS the raw tier. It works on an ordinary point
 *     or trip archive with no summary tier at all, and its aggregate is LIVE:
 *     scrub the playhead and the hexes genuinely re-count, re-colour and
 *     re-extrude. The price is a CPU pass over every resident point each time
 *     the window bucket turns over.
 *
 * If your archive has a summary tier and you do not need the aggregate to
 * follow the playhead, use the H3 layer. This one is for the case the H3 layer
 * cannot serve.
 *
 * ## Time — a genuine re-aggregation, not a cross-fade
 *
 * `setTime` does two different things at two different rates:
 *
 *   1. **Per frame**, it writes each hex's alpha through the batch table via
 *      the shared `timeFilterAlpha` oracle — the same CPU math every other
 *      layer in this backend runs (there is no shader path; `src/shaders.ts`
 *      was deleted). This is the soft EDGE of the window only.
 *   2. **Per aggregation bucket**, it RE-BINS. `aggregationStepMs` quantises
 *      the playhead; when the bucket integer changes, the membership window
 *      moves with it and the whole aggregate is recomputed and re-batched. A
 *      hex holding 400 points at noon reports 3 at midnight — the count, the
 *      colour and the extrusion all move, because the underlying set moved.
 *      Cross-fading one static set of bins would have been cheaper and would
 *      have been a lie.
 *
 * **The cache key is `(resident tile set, weight config, window bucket)`** —
 * see `lib/hexbin.ts`'s `hexbinCacheKey` for the full rationale. Concretely:
 * `tileSetToken(tiles)` (tile ids + feature counts) ‖ `configToken(opts)`
 * (radius, weight column, aggregation, coverage, elevation scale, pinned
 * latitude, pinned domain) ‖ `aggregationBucket(playhead, aggregationStepMs)`.
 * Nothing frame-varying is in the key, which is exactly why a re-aggregation
 * happens on bucket crossings and never per frame. Recent aggregates are
 * memoised (`cacheSize`, default 8) so scrubbing back and forth across a few
 * buckets replays them for free.
 *
 * ## Geometry-kind guard
 *
 * Point tiles bin one entry per FEATURE; LineString tiles bin one entry per
 * **VERTEX** (so a trip archive hexbins track density, not the head of the
 * first few tracks); Polygon tiles are SKIPPED, with ONE named warning per
 * layer instance. The reasoning is in `lib/hexbin.ts`'s header.
 *
 * ## Documented deviations from deck's `HexagonLayer`
 *
 *   - **One weight column, not two accessors.** deck takes `getColorWeight` and
 *     `getElevationWeight` separately, each with its own aggregation. This
 *     backend reads BAKED columns and exposes a single weight name (resolved
 *     `colorWeight` → `elevationWeight` → `weightProperty`) driving BOTH colour
 *     and height. Two aggregations would double the per-re-aggregation pass
 *     over every resident point, and that pass is this layer's whole cost
 *     model. Two surfaces → two layers.
 *   - **Ground-uniform lattice, not screen-uniform.** deck bins in Web-Mercator
 *     space off `viewport.getDistanceScales()`, so its bins re-project as you
 *     pan. Ours is anchored to a pinned `latitudeReference` and never moves —
 *     the right trade on a globe, where a mercator lattice at 70°N would be a
 *     third of its nominal ground size. `radiusMeters` is deck's `cellSize`.
 *   - **The ramp domain only ever WIDENS.** Carried across rebuilds, seeded
 *     from the previous build, exactly as `STTH3SummaryLayer` does. Without it
 *     every re-aggregation would repaint the whole map as the window's local
 *     maximum wandered. Pin `colorDomain` for a fixed legend.
 *   - **One colour per hex, never per-vertex.** The batch-table animation path
 *     has no per-vertex colour, so there is no upper/lower-colour gradient on
 *     an extruded prism.
 *   - **`colorAggregation` is `aggregation`**, shared with the elevation, and
 *     there is no `getColorValue` / `getElevationValue` escape hatch: an
 *     arbitrary JS reducer would have to run over raw features on the main
 *     thread on every bucket crossing.
 *
 * ## Frames
 *
 * Absolute f64 ECEF metres throughout, no RTC (`Cartesian3` consumes CPU
 * doubles natively). **Nothing here is placed by a model matrix** — every ring
 * arrives already in ECEF and an extruded hex rides Cesium's own
 * `height`/`extrudedHeight`, whose walls follow the ellipsoid normal. That is
 * deliberate: a model matrix with an identity rotation points at the ECEF pole,
 * which is visibly wrong at the equator and wrong everywhere else too; the
 * correct construction would be a local east-north-up frame
 * (`Transforms.eastNorthUpToFixedFrame`), and this layer sidesteps the trap by
 * never needing one.
 *
 * Rendering requires a live Cesium `Scene` (a browser canvas), so the composed
 * result is browser-verify-only; every piece of maths it composes is unit-tested
 * in `test/hexbin.test.ts`.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  defined,
  type Scene,
} from 'cesium';
import {
  getFeatureProperties,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  aggregationBucket,
  buildHexbins,
  configToken,
  hexbinCacheKey,
  hexbinWindowFor,
  tileSetToken,
  type HexbinAggregation,
  type HexbinBuild,
  type HexbinDiagnostics,
} from './lib/hexbin.js';

export interface STTHexbinLayerOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;

  // ── lattice ──
  /** Hex circumradius (centre → corner) in metres. @default 1000 */
  radiusMeters?: number;
  /** deck's spelling of {@link radiusMeters}; `radiusMeters` wins if both are set. */
  cellSize?: number;
  /** Hex shrink toward its centre, 0–1. @default 1 (hexes tile with no gutter) */
  coverage?: number;
  /**
   * Pin the lattice's longitude-convergence latitude (deg). Left unset, the
   * first non-empty build pins the data's mean latitude (whole degrees) and the
   * layer carries it forever, so the lattice never migrates under the data.
   */
  latitudeReference?: number;

  // ── weight ──
  /** Numeric column driving BOTH colour and elevation. Unset → a COUNT hexbin. */
  colorWeight?: string;
  /** Fallback name for the same single column. */
  elevationWeight?: string;
  /** Legacy name for the same single column, matched last. */
  weightProperty?: string;
  /** How members of a bin combine. @default 'sum' (unweighted, that IS the count) */
  aggregation?: HexbinAggregation;

  // ── colour ──
  /** Low→high ramp stops, each `[r,g,b,a]` 0–255. @default 6-stop YlOrRd */
  colorRange?: readonly RGBA255[];
  /** `[min, max]` the ramp spans. PIN THIS for a stable legend. */
  colorDomain?: readonly [number, number];

  // ── elevation ──
  /** Draw prisms instead of flat plates. @default false */
  extruded?: boolean;
  /** METRES of height per unit of aggregate. @default 1 */
  elevationScale?: number;
  /** Lambert shading. @default follows {@link extruded} */
  shaded?: boolean;

  // ── re-aggregation ──
  /**
   * Playhead quantum (ms) at which the aggregate is recomputed. Left unset it
   * is derived as one eighth of the mode's own span (`windowHalf × 2`,
   * `wakeLength`, `trailLength`), which re-bins ~8 times per window traversal —
   * dense enough to read as continuous, coarse enough to be nowhere near
   * per-frame. `Infinity` (or `reaggregate: false`) freezes the aggregate at
   * whatever `setTiles` built.
   */
  aggregationStepMs?: number;
  /** Set false to bin once in `setTiles` and never again. @default true */
  reaggregate?: boolean;
  /** Memoised aggregates kept for scrubbing. @default 8 */
  cacheSize?: number;

  /**
   * Called once per build when the build had to skip something — a polygon
   * layer, a non-finite coordinate, a missing weight column. Defaults to one
   * `console.warn`. Pass a no-op to silence it; do NOT pass one to hide a
   * blank map.
   */
  onDiagnostics?: (d: HexbinDiagnostics) => void;
}

interface InstanceId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface BinEntry {
  id: InstanceId;
  /** Window, relative to `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Base colour as BYTES — the batch table is u8, so setTime writes straight through. */
  r: number;
  g: number;
  b: number;
  /** Base alpha 0..1, multiplied by the time-filter alpha. */
  a: number;
  /** Last alpha written; skip the batch-table write when unchanged. */
  lastAlpha: number;
  attrs: { color: Uint8Array } | null;
  lon: number;
  lat: number;
  /** The aggregate, surfaced through `pick`. */
  count: number;
  weight: number;
}

// One shared scratch for every per-frame batch-table write, so setTime
// allocates nothing. Safe because JS is single-threaded and setTime runs to
// completion synchronously; and it must stay a DISTINCT object from the batch
// table's own storage, because Cesium's attribute setter COPIES the bytes in
// (a stand-in that stored the reference would report the last write for every
// entry — see `armPrimitive` in the tests).
const SCRATCH_RGBA = new Uint8Array(4);
// Reused by `pick` so a hit-test allocates nothing either. Cesium's `scene.pick`
// only reads the Cartesian2.
const SCRATCH_PICK = new Cartesian2();

const DEFAULT_CACHE_SIZE = 8;
/** Re-bin ~8x per window traversal when the caller does not choose a step. */
const STEPS_PER_SPAN = 8;
/** A cumulative sweep traverses the WHOLE archive, so it wants a finer step. */
const CUMULATIVE_STEPS_PER_SPAN = 64;

/** `span / steps`, or `Infinity` when there is no span to quantise. */
function quantum(span: number, steps: number): number {
  if (!Number.isFinite(span) || span <= 0) return Infinity;
  return Math.max(1, span / steps);
}

/** Span of the union of every resident tile's `timeRange`, in ms. */
function tileSpanMs(tiles: readonly Tile[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const tile of tiles) {
    if (tile.timeRange.start < lo) lo = tile.timeRange.start;
    if (tile.timeRange.end > hi) hi = tile.timeRange.end;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? Math.max(0, hi - lo) : 0;
}

export class STTHexbinLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly opts: STTHexbinLayerOptions;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private primitive: Primitive | null = null;
  private entries: BinEntry[] = [];
  private attrsCached = false;
  private timeOrigin = 0;

  /** The resident tile set, held so a bucket crossing can re-bin without a refetch. */
  private tiles: readonly Tile[] = [];
  /** Identity of that tile set — part 1 of the cache key. */
  private tilesToken = '';
  /** Identity of the weight configuration — part 2 of the cache key. */
  private cfgToken = '';
  /** The key the CURRENT primitive was built under; `null` before the first build. */
  private builtKey: string | null = null;
  /** Bounded memo of pure builds, keyed by `hexbinCacheKey`. Insertion-ordered LRU. */
  private readonly cache = new Map<string, HexbinBuild>();

  /**
   * Running auto-fit ramp domain, seeded empty and only ever WIDENED. Carried
   * across re-aggregations so a moving window does not repaint the whole map
   * every time its local maximum wanders.
   */
  private domain: [number, number] = [Infinity, -Infinity];
  /** Pinned on the first non-empty build; keeps the lattice from migrating. */
  private latitudeReference: number | undefined;
  /** Last playhead seen, so `setTiles` bins the window the user is looking at. */
  private lastPlayhead = 0;
  /**
   * Span of the resident tiles' `timeRange` union. `cumulative` has no length
   * parameter of its own, so this is the only thing to quantise its running
   * total against.
   */
  private dataSpanMs = 0;
  /** One polygon warning per layer instance, not one per build. */
  private warnedPolygons = false;

  constructor(scene: Scene, options: STTHexbinLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-hexbin';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.latitudeReference = options.latitudeReference;
    // Nothing to register until the first build: a Primitive is immutable once
    // constructed, so `setTiles` creates and adds it. `dispose` stays symmetric.
  }

  /**
   * (Re)bin from decoded tiles. Rebases all times to one scene-wide origin.
   *
   * The pure build runs FIRST and an empty result bails BEFORE any teardown —
   * a hard rule across this package. Selection reports an empty visible set for
   * the frames between a viewport change and the first decoded tile of the new
   * set; tearing down first turns that transient into a blank frame (the "tiles
   * genuinely in view flash out" symptom). Holding the previous hexes is safe
   * even when the emptiness is permanent: they sit at their true ECEF
   * positions, which the camera has by then left behind. Bailing early ALSO
   * leaves the previous `timeOrigin` untouched — deliberate.
   */
  setTiles(tiles: Tile[]): void {
    // Computed up front so the pre-build window is the one this tile set
    // implies, but COMMITTED only past the empty bail — an empty publish must
    // not reset the span and freeze a cumulative sweep.
    const nextSpan = tileSpanMs(tiles);
    const nextTilesToken = tileSetToken(tiles);
    const nextCfgToken = configToken(this.buildOptions());
    // A new population invalidates every memoised aggregate — they were binned
    // over features that are no longer resident.
    if (nextTilesToken !== this.tilesToken || nextCfgToken !== this.cfgToken) {
      this.cache.clear();
    }
    const build = buildHexbins(tiles, {
      ...this.buildOptions(),
      window: this.windowAt(this.lastPlayhead, nextSpan),
    });
    // Report BEFORE the bail: a polygon-only tile set produces no bins, and
    // that is exactly the case the caller most needs told about.
    this.report(build.diagnostics);
    if (build.bins.length === 0) return; // bail while the OLD primitives still stand
    this.tiles = tiles;
    this.dataSpanMs = nextSpan;
    this.tilesToken = nextTilesToken;
    this.cfgToken = nextCfgToken;
    this.adopt(
      build,
      hexbinCacheKey(
        nextTilesToken,
        nextCfgToken,
        aggregationBucket(this.lastPlayhead, this.stepMs()),
      ),
    );
  }

  /**
   * Advance to an absolute playhead time.
   *
   * Two rates, as the file header describes: a RE-AGGREGATION when the window
   * bucket turns over (rebuilding the batched Primitive from a fresh pure
   * build, memoised on the `(tiles, config, bucket)` key), then the per-frame
   * alpha pass through the batch table via the shared `timeFilterAlpha` oracle
   * — the same math every other backend runs, on the CPU because this backend
   * has no shader path. One shared scratch, and a hex whose alpha did not move
   * costs a single compare rather than a GPU dirty.
   */
  setTime(absoluteMs: number): void {
    this.lastPlayhead = absoluteMs;
    this.maybeReaggregate(absoluteMs);

    const prim = this.primitive;
    if (!prim || !prim.ready) return; // batch table exists only after the first render
    if (!this.attrsCached) {
      for (const e of this.entries) {
        e.attrs = prim.getGeometryInstanceAttributes(e.id) as {
          color: Uint8Array;
        };
      }
      this.attrsCached = true;
    }

    const cur = absoluteMs - this.timeOrigin;
    const v = SCRATCH_RGBA;
    for (const e of this.entries) {
      const alpha =
        e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      if (alpha === e.lastAlpha || !e.attrs) continue; // unchanged — nothing to dirty
      e.lastAlpha = alpha;
      v[0] = e.r;
      v[1] = e.g;
      v[2] = e.b;
      v[3] = Math.round(alpha * 255);
      e.attrs.color = v; // setter copies the bytes into the batch table
    }
  }

  /**
   * Hit-test → the shared `SttPickResult`.
   *
   * **Documented deviation:** `object` is the AGGREGATE — `{count, weight,
   * weightProperty, aggregation}` — not one feature's properties, because a hex
   * describes a population, not a row. The properties of the representative
   * member that carried the instance id are still offered, honestly labelled
   * `sampleProperties`, for callers who want a specimen. `coordinate` is the
   * hex CENTRE, not the hit point, for the same reason.
   */
  pick(cssX: number, cssY: number): SttPickResult | null {
    SCRATCH_PICK.x = cssX;
    SCRATCH_PICK.y = cssY;
    const picked = this.scene.pick(SCRATCH_PICK) as
      | { id?: InstanceId }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id)
      return null;
    const { binary, featureIndex } = picked.id;
    const entry = this.entries.find(
      (e) => e.id.binary === binary && e.id.featureIndex === featureIndex,
    );
    return {
      object: {
        count: entry?.count ?? 0,
        weight: entry?.weight ?? 0,
        weightProperty:
          this.opts.colorWeight ??
          this.opts.elevationWeight ??
          this.opts.weightProperty ??
          null,
        aggregation: this.opts.aggregation ?? 'sum',
        sampleProperties: getFeatureProperties(binary, featureIndex),
      },
      index: featureIndex,
      layerId: this.id,
      coordinate: entry ? [entry.lon, entry.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  dispose(): void {
    this.teardownPrimitive();
    this.entries = [];
    this.attrsCached = false;
    this.cache.clear();
    this.tiles = [];
    this.builtKey = null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private buildOptions() {
    return {
      radiusMeters: this.opts.radiusMeters,
      cellSize: this.opts.cellSize,
      colorWeight: this.opts.colorWeight,
      elevationWeight: this.opts.elevationWeight,
      weightProperty: this.opts.weightProperty,
      aggregation: this.opts.aggregation,
      colorRange: this.opts.colorRange,
      colorDomain: this.opts.colorDomain,
      domainSeed: this.domain as readonly [number, number],
      coverage: this.opts.coverage,
      elevationScale: this.opts.elevationScale,
      latitudeReference: this.latitudeReference,
    };
  }

  /**
   * The aggregation quantum: explicit, else derived from the mode's own span.
   *
   * `window` / `wake` / `trail` carry their length in `timeFilter`, so the step
   * is one eighth of it. `cumulative` carries no length at all — its running
   * total sweeps the whole archive — so it quantises against the RESIDENT DATA
   * SPAN instead, finely enough (`CUMULATIVE_STEPS_PER_SPAN`) that the total
   * visibly grows rather than snapping. `none` has no notion of a moving
   * window, so its aggregate is static by definition.
   *
   * `Infinity` means "never re-aggregate": the aggregate `setTiles` built
   * stands until the tiles change.
   */
  private stepMs(span: number = this.dataSpanMs): number {
    if (this.opts.reaggregate === false) return Infinity;
    if (this.opts.aggregationStepMs !== undefined) {
      return this.opts.aggregationStepMs;
    }
    const p = this.params;
    switch (this.mode) {
      case 'window':
        return quantum((p.windowHalf ?? 0) * 2, STEPS_PER_SPAN);
      case 'wake':
        return quantum(p.wakeLength ?? 0, STEPS_PER_SPAN);
      case 'trail':
        return quantum(p.trailLength ?? 0, STEPS_PER_SPAN);
      case 'cumulative':
        return quantum(span, CUMULATIVE_STEPS_PER_SPAN);
      default:
        return Infinity;
    }
  }

  /**
   * The membership window to bin, or `null` for "bin everything" — which is
   * what a frozen aggregate (`reaggregate: false`, or a mode with no span to
   * quantise) means. `span` exists so `setTiles` can ask the question against
   * the tile set it is about to adopt rather than the one it still holds.
   */
  private windowAt(absoluteMs: number, span: number = this.dataSpanMs) {
    if (!Number.isFinite(this.stepMs(span))) return null;
    return hexbinWindowFor(this.mode, absoluteMs, this.params);
  }

  /**
   * Re-bin if — and only if — the window bucket turned over. Everything else in
   * the key is constant between `setTiles` calls, so this is one integer
   * compare on the frames that do not cross a boundary.
   */
  private maybeReaggregate(absoluteMs: number): void {
    if (this.tiles.length === 0) return;
    const step = this.stepMs();
    if (!Number.isFinite(step)) return; // frozen aggregate: `setTiles` had the last word
    const key = hexbinCacheKey(
      this.tilesToken,
      this.cfgToken,
      aggregationBucket(absoluteMs, step),
    );
    if (key === this.builtKey) return;

    let build = this.cache.get(key);
    if (build) {
      // Refresh LRU recency without recomputing.
      this.cache.delete(key);
      this.cache.set(key, build);
    } else {
      build = buildHexbins(this.tiles, {
        ...this.buildOptions(),
        window: this.windowAt(absoluteMs),
      });
      this.remember(key, build);
      this.report(build.diagnostics); // fresh work only; a cache hit re-reports nothing
    }
    // Unlike `setTiles`, an empty re-aggregation is REAL: the playhead has
    // genuinely moved somewhere with no data. Adopt it — holding stale hexes
    // here would be the cross-fade lie this layer exists to avoid. The key is
    // still recorded so the empty bucket is not recomputed every frame.
    this.adopt(build, key);
  }

  private remember(key: string, build: HexbinBuild): void {
    const cap = this.opts.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.cache.set(key, build);
    while (this.cache.size > Math.max(1, cap)) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /** Turn a pure build into the batched Primitive. Tears down the previous one. */
  private adopt(build: HexbinBuild, key: string): void {
    this.teardownPrimitive();
    this.entries = [];
    this.attrsCached = false;
    this.builtKey = key;
    if (build.bins.length === 0) return;

    this.timeOrigin = build.timeOrigin;
    this.domain = build.domain;
    this.latitudeReference ??= build.lattice.latitudeReference;

    const extruded = this.opts.extruded ?? false;
    const shaded = this.opts.shaded ?? extruded;
    const vertexFormat = shaded
      ? PerInstanceColorAppearance.VERTEX_FORMAT
      : PerInstanceColorAppearance.FLAT_VERTEX_FORMAT;

    // Seed each instance at the alpha the CURRENT playhead implies, not at 0.
    // The H3 layer can seed transparent because it batches once; this layer
    // re-batches on every bucket crossing, and a freshly-constructed Primitive
    // is `!ready` for one render pass — so a transparent seed would flash the
    // whole lattice out at every crossing. `lastAlpha` still starts at NaN, so
    // the first `setTime` after `ready` writes unconditionally and any
    // divergence corrects itself within a frame.
    const seedCur = this.lastPlayhead - build.timeOrigin;

    const instances: GeometryInstance[] = [];
    for (const bin of build.bins) {
      const n = bin.positions.length / 3;
      const positions: Cartesian3[] = new Array(n);
      for (let v = 0; v < n; v++) {
        positions[v] = new Cartesian3(
          bin.positions[v * 3],
          bin.positions[v * 3 + 1],
          bin.positions[v * 3 + 2],
        );
      }
      const id: InstanceId = {
        layerId: this.id,
        binary: bin.binary,
        featureIndex: bin.featureIndex,
      };
      instances.push(
        new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(positions),
            vertexFormat,
            // The ring is built at height 0 and the prism rides Cesium's own
            // height/extrudedHeight, so the walls follow the ellipsoid normal.
            // `extrudedHeight` stays undefined for a flat hex: passing 0 would
            // ask for a zero-height prism (degenerate walls), not a cap.
            height: 0,
            ...(extruded && bin.height !== 0
              ? { height: bin.height, extrudedHeight: 0 }
              : {}),
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(
              new Color(
                bin.r255 / 255,
                bin.g255 / 255,
                bin.b255 / 255,
                bin.a *
                  timeFilterAlpha(
                    this.mode,
                    seedCur,
                    bin.start,
                    bin.end,
                    this.params,
                  ),
              ),
            ),
          },
          id,
        }),
      );
      this.entries.push({
        id,
        start: bin.start,
        end: bin.end,
        // Bytes, computed ONCE: the batch table is u8, so the per-frame loop
        // writes these straight through with no scaling.
        r: bin.r255,
        g: bin.g255,
        b: bin.b255,
        a: bin.a,
        lastAlpha: NaN, // NaN !== anything → force the first setTime to write
        attrs: null,
        lon: bin.lon,
        lat: bin.lat,
        count: bin.count,
        weight: bin.weight,
      });
    }

    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({
        flat: !shaded,
        translucent: true, // alpha animates every frame; never opt into the opaque pass
        closed: extruded, // a prism is a closed solid; back faces can be culled
      }),
      asynchronous: false, // deterministic replace-all; no worker round-trip
    });
    this.scene.primitives.add(this.primitive);
  }

  /**
   * Remove the current Primitive, and DESTROY it if the scene did not.
   * `PrimitiveCollection.remove` destroys what it removes (its
   * `destroyPrimitives` default is true), but it returns false for a primitive
   * the collection does not hold — a layer disposed twice, or a host that keeps
   * `destroyPrimitives: false`. Leaving that case alone leaks the GPU buffers
   * of every hex, and this layer re-batches on every bucket crossing, so the
   * leak would be continuous rather than one-off.
   */
  private teardownPrimitive(): void {
    const prim = this.primitive;
    this.primitive = null;
    if (!prim) return;
    const removed = this.scene.primitives.remove(prim);
    if (!removed && !prim.isDestroyed()) prim.destroy();
  }

  /** Surface what the build had to do to the data — never hide it. */
  private report(d: HexbinDiagnostics): void {
    if (d.skippedPolygonLayers > 0 && !this.warnedPolygons) {
      this.warnedPolygons = true; // ONE named warning per layer, not one per build
      if (!this.opts.onDiagnostics) {
        console.warn(
          `[STTHexbinLayer:${this.id}] skipped ${d.skippedPolygonLayers} Polygon layer(s): ` +
            'a hexbin bins POINTS (and track VERTICES). A polygon contributes its AREA ' +
            'to a density surface, which needs a rasteriser — binning its ring vertices ' +
            'would weight it by tessellation detail. Render polygons with STTPolygonLayer, ' +
            'or bake a summary tier and use STTH3SummaryLayer.',
        );
      }
    }
    if (this.opts.onDiagnostics) {
      this.opts.onDiagnostics(d);
      return;
    }
    if (d.weightPropertyMissing) {
      console.warn(
        `[STTHexbinLayer:${this.id}] weight column not found on any resident layer; ` +
          'every entry weighed 1 (a COUNT hexbin).',
      );
    }
    if (d.skippedNonFinite > 0) {
      console.warn(
        `[STTHexbinLayer:${this.id}] skipped ${d.skippedNonFinite} entr(ies) with a ` +
          'non-finite coordinate.',
      );
    }
  }
}
