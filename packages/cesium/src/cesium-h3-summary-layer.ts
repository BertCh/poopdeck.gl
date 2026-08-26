// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `h3Summary` for CesiumJS — an STT archive's SERVER-AGGREGATED summary tier
 * drawn as ramp-coloured, optionally extruded H3 cells on the WGS84 ellipsoid.
 *
 * ## What it renders, and why the kind exists
 *
 * A summary tile carries no point geometry at all: `stt-build --summary-tier h3`
 * pre-aggregates the raw tier into one row per H3 cell, storing the cell's u64
 * id in the Arrow `id` column (`BinaryFeatures.featureIds64` — the 32-bit
 * `featureIds` mirror TRUNCATES the high bits and is never read here) and the
 * aggregate values in ordinary numeric columns. That is the whole point of the
 * tier: a continental view of 400k earthquakes is ~2k cells instead of 400k
 * points, so the wire cost and the draw cost both collapse while the SHAPE of
 * the distribution survives.
 *
 * The trade is that the geometry must be reconstructed client-side. This layer:
 *
 *   1. reads each row's u64 id,
 *   2. resolves it to a lon/lat boundary ring through an **injected**
 *      `cellToBoundary` (see below),
 *   3. projects that ring to absolute f64 ECEF metres via `core/geo`
 *      `GlobeProjection({datum:'wgs84'})` — Cesium's own frame,
 *   4. colours the cell by its aggregate through `core/style` `rampColorAt`,
 *   5. optionally raises it into a prism `weight × elevationScale` metres tall,
 *   6. batches every cell into ONE `Primitive` of `PolygonGeometry`
 *      `GeometryInstance`s under a `PerInstanceColorAppearance`, and animates
 *      alpha per frame through the batch table.
 *
 * Steps 1–4 are pure and live in `lib/summary-cells.ts` (zero Cesium imports,
 * unit-tested in plain Node); this file only turns the result into Cesium
 * objects. The pure module is GENERIC over "a function from cell id to a
 * boundary ring", so the Quadbin sibling reuses the whole ring → ECEF →
 * instance path and supplies only its own decoder.
 *
 * ## ⚠ `h3-js` is INJECTED, never imported
 *
 * {@link STTH3SummaryLayerOptions.cellToBoundary} is REQUIRED and the
 * constructor THROWS without it. An H3 cell boundary is icosahedral geometry
 * only h3-js can produce, and we do not reimplement it — but `h3-js` is not a
 * dependency of `@poopdeck.gl/cesium` and must not become one. This package
 * ships exactly one runtime dependency (`@poopdeck.gl/core`) with `cesium` as a
 * peer; that thinness is the architectural claim the backend exists to prove
 * (docs/roadmap/renderer-architecture.md). `@poopdeck.gl/maplibre` injects the
 * same function for the same reason, and both consume `cellToBoundary(idx,
 * true)` — the exact call `@poopdeck.gl/layers` and `@poopdeck.gl/three` make —
 * so all four backends resolve a cell to the same ring.
 *
 * ```ts
 * import { cellToBoundary } from 'h3-js';
 * const layer = new STTH3SummaryLayer(scene, { cellToBoundary, extruded: true });
 * ```
 *
 * ## Documented deviations from deck (not silent approximations)
 *
 *   - **The ramp interpolates; deck's quantises.** deck's summary layers bucket
 *     into `colorRange.length` steps. `rampColorAt` blends between stops. The
 *     two agree AT the stops and this one is smoother between them — the same
 *     choice `@poopdeck.gl/maplibre` made, so a backend toggle does not change
 *     colour.
 *   - **The auto-fit colour domain widens monotonically.** deck re-fits per
 *     render, so a hot tile scrolling off repaints every cell that remains.
 *     Here the fit is seeded from the previous build and never narrows. Pin
 *     {@link STTH3SummaryLayerOptions.colorDomain} for a legend that is stable
 *     across a whole session.
 *   - **No `stroked` outline pass.** deck's `H3HexagonLayer` draws the hex grid
 *     as a second, line-based sublayer. Reproducing it here means a second
 *     `Primitive` of one `PolylineGeometry` per cell, which doubles the
 *     instance count for a decoration; the fill IS the data. If you need the
 *     lattice, compose an `STTPathLayer` over the same tiles.
 *   - **`coverage` shrinks in lon/lat**, like `@poopdeck.gl/three`, not in
 *     mercator like `@poopdeck.gl/maplibre` — on a globe there is no mercator to
 *     shrink in. The two differ only by mercator's latitude stretch ACROSS ONE
 *     CELL, second order at any zoom where a cell is legible.
 *   - **Extrusion conforms to the ellipsoid.** The prism is `PolygonGeometry`'s
 *     own `height`/`extrudedHeight`, so its walls follow the ellipsoid normal
 *     rather than a single locally-flat frame. deck extrudes in mercator-common
 *     space; over a res-2 cell spanning hundreds of km this backend is the more
 *     correct of the two, and visibly so near the poles.
 *   - **Extrusion is geometry-baked, colour is not.** `extruded` /
 *     `elevationScale` / `coverage` are constructor options; changing them
 *     means a new layer. Alpha animates for free through the batch table, which
 *     is the only thing that must be cheap per frame.
 *
 * ## What it deliberately does NOT do
 *
 * No Cesium `Entity` / `DataSource` (the whole package manages raw primitives
 * against `scene.primitives`, which is what keeps picking, animation and
 * lifecycle uniform). No camera reads or writes. No antimeridian or pole
 * special-casing — ECEF has no seam and no singularity, so the mercator
 * machinery `@poopdeck.gl/maplibre` needs has nothing to do here; see the
 * `lib/summary-cells.ts` header. And no shader path: `src/shaders.ts` was
 * deleted, so alpha is the shared `core/time-filter` oracle on the CPU,
 * identical math to every other backend.
 *
 * Rendering requires a live Cesium `Scene` (a browser canvas), so the drawn
 * result is browser-verify-only; every piece of maths it composes is unit-tested.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CoplanarPolygonGeometry,
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
import type { FeatureColorMode } from './lib/feature-color.js';
import {
  buildSummaryCells,
  h3BoundaryResolver,
  type CellBoundaryResolver,
  type H3CellToBoundary,
  type SummaryCellDiagnostics,
} from './lib/summary-cells.js';

export interface STTH3SummaryLayerOptions {
  id?: string;
  /**
   * **REQUIRED.** `h3-js`'s `cellToBoundary`, injected. The constructor throws
   * without it — see the file header for why this package refuses to import
   * `h3-js` itself.
   *
   * ```ts
   * import { cellToBoundary } from 'h3-js';
   * new STTH3SummaryLayer(scene, { cellToBoundary });
   * ```
   */
  cellToBoundary?: H3CellToBoundary;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /**
   * Numeric column driving BOTH the colour ramp and the extrusion height.
   * `'count'` is the implicit per-cell row count every summary tier bakes; any
   * aggregated column works (`'mean_magnitude'`, `'sum_value'`, …). A tile
   * missing the column paints every cell the ramp's LOW stop and warns once —
   * it never blanks.
   * @default 'count'
   */
  weightProperty?: string;
  /** Low→high ramp stops, each `[r,g,b,a]` in 0–255. @default 6-stop YlGnBu */
  colorRange?: readonly RGBA255[];
  /**
   * `[min, max]` the ramp spans. PIN THIS for a legend that is stable across a
   * session; left unset the layer fits from the cells it has seen, widening
   * monotonically as tiles arrive (never narrowing).
   * @default null (auto-fit)
   */
  colorDomain?: readonly [number, number] | null;
  /**
   * Escape hatch: colour through the shared constant/categorical/ramp
   * trichotomy instead of the weight ramp. The weight is still read for
   * extrusion.
   */
  colorMode?: FeatureColorMode;
  /** Shrink each cell toward its own centroid, 0..1 — the gap between neighbours.
   * Geometry-baked. @default 0.92 (deck's summary-layer default) */
  coverage?: number;
  /** Raise each cell into a prism whose top sits at `weight × elevationScale`
   * METRES. Geometry-baked. @default false */
  extruded?: boolean;
  /** METRES of height per unit of {@link weightProperty}. Inert while
   * `extruded` is false. @default 1 */
  elevationScale?: number;
  /**
   * Archive layer name the summary rows live under. Layers with a different
   * name are skipped, so a tile that ALSO carries its raw tier is not decoded
   * as cells — unless nothing matches, in which case any layer carrying a u64
   * id column is used and a warning names the mismatch.
   * @default 'summary'
   */
  summaryLayerName?: string;
  /**
   * Use `CoplanarPolygonGeometry` instead of `PolygonGeometry`: skips the
   * ellipsoid-conforming subdivision, so a cell is a FLAT plate through its
   * boundary. Much cheaper, and indistinguishable at high H3 resolutions where
   * a cell is small — but a low-resolution cell spanning hundreds of km will
   * visibly sink through the globe. Forced off when `extruded` is true (a
   * coplanar polygon has no walls). @default false
   */
  coplanar?: boolean;
  /**
   * Shade the cells with Cesium's per-instance lighting instead of drawing them
   * flat. Only meaningful when `extruded` is true, where it is what makes the
   * prism walls readable. @default true when `extruded`, else false
   */
  shaded?: boolean;
  /**
   * Called once per `setTiles` when the build had to skip rows, fall back on a
   * missing column, or use a differently-named layer. Defaults to a
   * `console.warn` — pass a no-op to silence, but do not silence it while you
   * are still wondering why the map looks wrong.
   */
  onDiagnostics?: (d: SummaryCellDiagnostics) => void;
}

/** The pick id attached to every instance — the package-wide shape. */
interface InstanceId {
  layerId: string;
  binary: BinaryFeatures;
  featureIndex: number;
}

interface CellEntry {
  id: InstanceId;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // base colour as BYTES — the batch table is u8, so setTime writes
  g: number; // these straight through without re-scaling
  b: number;
  a: number; // base alpha 0..1, multiplied by the time-filter alpha
  lastAlpha: number; // last alpha written; skip the write when unchanged
  /** Batch-table colour handle; cached on the first frame `primitive.ready`. */
  attrs: { color: Uint8Array } | null;
  lon: number; // cell centroid — the pick coordinate
  lat: number;
}

// One shared scratch for every per-frame batch-table write, so setTime
// allocates nothing. Safe because JS is single-threaded and setTime runs to
// completion synchronously; and it must stay a DISTINCT object from the batch
// table's own storage, because Cesium's attribute setter COPIES the bytes in
// (a stand-in that stored the reference would report the last write for every
// entry — see `armPrimitive` in the tests).
const SCRATCH_RGBA = new Uint8Array(4);

export class STTH3SummaryLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly opts: STTH3SummaryLayerOptions;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly resolve: CellBoundaryResolver;
  private primitive: Primitive | null = null;
  private entries: CellEntry[] = [];
  private attrsCached = false;
  private timeOrigin = 0;
  /**
   * Running auto-fit domain, seeded empty and only ever WIDENED. Carried across
   * rebuilds so an evicting tile never repaints the cells that remain.
   */
  private domain: [number, number] = [Infinity, -Infinity];

  constructor(scene: Scene, options: STTH3SummaryLayerOptions = {}) {
    if (typeof options.cellToBoundary !== 'function') {
      // Hard failure, not a silent blank layer: without a boundary resolver
      // every row decodes to nothing and the map is empty for a reason no
      // amount of staring at the archive explains.
      throw new Error(
        '[STTH3SummaryLayer] the `cellToBoundary` option is required. ' +
          '@poopdeck.gl/cesium does not depend on h3-js — inject it: ' +
          "import { cellToBoundary } from 'h3-js'; " +
          'new STTH3SummaryLayer(scene, { cellToBoundary })',
      );
    }
    this.id = options.id ?? 'stt-cesium-h3-summary';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.resolve = h3BoundaryResolver(options.cellToBoundary);
    // Unlike the collection-based layers there is nothing to register until the
    // first build: a Primitive is immutable once constructed, so `setTiles`
    // creates and adds it. `dispose` is still symmetric.
  }

  /** (Re)build the cells from decoded summary tiles. Rebases to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    // Pure id → ring → ECEF → colour assembly lives in the Cesium-free builder;
    // this method only turns each cell into a GeometryInstance.
    const build = buildSummaryCells(tiles, this.resolve, {
      weightProperty: this.opts.weightProperty,
      colorRange: this.opts.colorRange,
      colorDomain: this.opts.colorDomain,
      domainSeed: this.domain,
      colorMode: this.opts.colorMode,
      coverage: this.opts.coverage,
      extruded: this.opts.extruded,
      elevationScale: this.opts.elevationScale,
      summaryLayerName: this.opts.summaryLayerName,
    });
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitives are still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the
    // new set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous cells is
    // safe even when the emptiness is permanent: they sit at their true ECEF
    // positions, which the camera has by then left behind.
    if (build.cells.length === 0) {
      this.report(build.diagnostics);
      return; // also leaves the prior timeOrigin AND colour domain untouched
    }

    this.teardownPrimitive();
    this.entries = [];
    this.attrsCached = false;
    this.timeOrigin = build.timeOrigin;
    this.domain = build.domain;

    const extruded = this.opts.extruded ?? false;
    const shaded = this.opts.shaded ?? extruded;
    // A coplanar plate has no walls, so it cannot express an extrusion.
    const coplanar = (this.opts.coplanar ?? false) && !extruded;

    const instances: GeometryInstance[] = [];
    for (const cell of build.cells) {
      const n = cell.positions.length / 3;
      const positions: Cartesian3[] = new Array(n);
      for (let v = 0; v < n; v++) {
        positions[v] = new Cartesian3(
          cell.positions[v * 3],
          cell.positions[v * 3 + 1],
          cell.positions[v * 3 + 2],
        );
      }
      const id: InstanceId = {
        layerId: this.id,
        binary: cell.binary,
        featureIndex: cell.featureIndex,
      };
      const vertexFormat = shaded
        ? PerInstanceColorAppearance.VERTEX_FORMAT
        : PerInstanceColorAppearance.FLAT_VERTEX_FORMAT;
      const geometry = coplanar
        ? new CoplanarPolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(positions),
            vertexFormat,
          })
        : new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(positions),
            vertexFormat,
            // The ring is built at height 0 and the prism rides Cesium's own
            // height/extrudedHeight, so the walls follow the ellipsoid normal.
            // `extrudedHeight` is left undefined for a flat cell: passing 0
            // would ask for a zero-height prism (degenerate walls), not a cap.
            height: 0,
            ...(extruded && cell.height !== 0
              ? { height: cell.height, extrudedHeight: 0 }
              : {}),
          });
      instances.push(
        new GeometryInstance({
          geometry,
          attributes: {
            // Seed fully transparent; the first setTime writes the real alpha.
            color: ColorGeometryInstanceAttribute.fromColor(
              new Color(cell.r, cell.g, cell.b, 0),
            ),
          },
          id,
        }),
      );
      this.entries.push({
        id,
        start: cell.start,
        end: cell.end,
        // Bytes, computed ONCE here: the batch table is u8, so the per-frame
        // loop writes these straight through with no scaling.
        r: Math.round(cell.r * 255),
        g: Math.round(cell.g * 255),
        b: Math.round(cell.b * 255),
        a: cell.a,
        lastAlpha: NaN, // NaN !== anything → force the first setTime to write
        attrs: null,
        lon: cell.lon,
        lat: cell.lat,
      });
    }

    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({
        flat: !shaded,
        translucent: true, // alpha animates every frame; never opt into the opaque pass
        closed: extruded, // a prism is a closed solid; back faces can be culled
      }),
      asynchronous: false, // deterministic replace-all; no worker round-trip per tile load
    });
    this.scene.primitives.add(this.primitive);
    this.report(build.diagnostics);
  }

  /**
   * Advance to an absolute playhead time; recompute each cell's alpha via the
   * shared `timeFilterAlpha` oracle — the same math every other backend runs,
   * on the CPU because this backend has no shader path (`src/shaders.ts` was
   * deleted). Writes through the batch table, so a cell's alpha changes without
   * rebuilding or re-batching any geometry: one draw-call bucket, per-frame cost
   * proportional to the cells whose alpha actually MOVED.
   */
  setTime(absoluteMs: number): void {
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

  /** Hit-test → the shared `SttPickResult` (props joined via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | { id?: InstanceId }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id)
      return null;
    const { binary, featureIndex } = picked.id;
    const entry = this.entries.find(
      (e) => e.id.binary === binary && e.id.featureIndex === featureIndex,
    );
    return {
      object: getFeatureProperties(binary, featureIndex),
      index: featureIndex,
      layerId: this.id,
      // The cell CENTROID, not the hit point: a summary row describes the whole
      // cell, so reporting one of its corners would be a lie about where the
      // aggregate lives.
      coordinate: entry ? [entry.lon, entry.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  dispose(): void {
    this.teardownPrimitive();
    this.entries = [];
    this.attrsCached = false;
  }

  /**
   * Remove the current Primitive, and DESTROY it if the scene did not.
   * `PrimitiveCollection.remove` destroys what it removes (its
   * `destroyPrimitives` default is true), but it returns false for a primitive
   * the collection does not hold — a layer disposed twice, or a host that keeps
   * `destroyPrimitives: false`. Leaving that case alone leaks the GPU buffers
   * of every cell, which for a planet-scale summary tier is the whole tileset.
   */
  private teardownPrimitive(): void {
    const prim = this.primitive;
    this.primitive = null;
    if (!prim) return;
    const removed = this.scene.primitives.remove(prim);
    if (!removed && !prim.isDestroyed()) prim.destroy();
  }

  /** Surface what the build had to do to the data — never hide it. */
  private report(d: SummaryCellDiagnostics): void {
    if (
      d.skipped === 0 &&
      !d.missingIds &&
      !d.missingWeight &&
      !d.layerNameMismatch
    ) {
      return;
    }
    const sink = this.opts.onDiagnostics;
    if (sink) {
      sink(d);
      return;
    }
    const want = this.opts.summaryLayerName ?? 'summary';
    const notes: string[] = [];
    if (d.missingIds) {
      notes.push(
        `no u64 cell-id column (BinaryFeatures.featureIds64) — rebuild with \`stt-build --summary-tier h3\``,
      );
    }
    if (d.layerNameMismatch) {
      notes.push(
        `no layer named '${want}'; decoding the first layer that carries cell ids — pass summaryLayerName to override`,
      );
    }
    if (d.skipped > 0) {
      notes.push(
        `${d.skipped} cell id(s) did not decode as H3 — is this archive built with a different --summary-tier scheme?`,
      );
    }
    if (d.missingWeight) {
      notes.push(
        `no numeric column '${this.opts.weightProperty ?? 'count'}'; every cell fell back to weight 0`,
      );
    }
    console.warn(`[${this.id}] ${notes.join('; ')}`);
  }
}
