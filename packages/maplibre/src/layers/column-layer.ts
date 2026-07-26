/**
 * Column geometry adapter — renders POINT-type tiles as instanced extruded
 * prisms (the 3D-bars primitive, and the space-time cube's building block).
 *
 * ── Shape of the draw ───────────────────────────────────────────────────────
 * One UNIT prism mesh is generated per `diskResolution` (module-level CPU cache,
 * {@link buildColumnMesh}) and uploaded once per GL context; every feature is
 * then ONE INSTANCE carrying its centre, time range, height, colour and filter
 * value. So a tile of 50k columns costs one `drawElementsInstanced`, one small
 * shared mesh and five per-feature attribute buffers — never 50k meshes.
 *
 * The mesh lives in "unit" space: `(x, y)` on the unit circle (radius 1),
 * `z ∈ {0, 1}` (base → top), plus a per-vertex `shade` (1.0 on the top cap,
 * {@link WALL_SHADE} on the side walls — the same 25%-darker convention
 * `STTPolygonLayer` uses for its extrusion walls). The vertex shader scales
 * that unit prism per instance:
 *
 *   posM   = centre.xy + (rotate(unit.xy, angle) + offset) * radius
 *   elevM  = centre.z + lift + unit.z * height * elevationScale
 *
 * with `radius` in MERCATOR units (metres or CSS pixels folded into
 * `uRadiusScale` on the CPU, {@link resolveColumnRadiusScale}) and every
 * elevation term in METRES.
 *
 * ── TIME-HEIGHT (the space-time cube) ───────────────────────────────────────
 * `timeHeightScale` is METRES OF ALTITUDE PER SIMULATION MILLISECOND, exactly
 * deck's `TimeFilterExtension` semantics: every vertex of a feature is lifted by
 * `(featureStartTime - timeHeightOrigin) * timeHeightScale` metres, so a stack
 * of columns climbs as the play-head advances and the flat map morphs into a
 * cube. The lift moves the WHOLE prism (base and top), it is NOT multiplied by
 * `elevationScale` (deck applies the lift in the extension, outside the layer's
 * own elevation scaling), and it applies in every time-filter mode. Columns
 * carry per-FEATURE times only, so the lift always reads `aTime.x` — deck's
 * per-VERTEX trail variant has no analogue here.
 *
 * ⚠ `timeHeightOrigin` is an ABSOLUTE epoch-ms time (relativized per tile at
 * draw time, like every other time in this backend) and defaults to 0. Leaving
 * it at 0 with a non-zero `timeHeightScale` lifts everything by ~55 million
 * years' worth of metres — set it to the dataset's `timeRange.start`. Same
 * default and same obligation as deck's `AnimatedColumnLayer`.
 *
 * ── Elevation units (D10) ───────────────────────────────────────────────────
 * `elevation` is METRES and the metres→shader-elevation conversion is
 * host-variant-dependent, identical to `STTPolygonLayer`'s extrusion path:
 *   - legacy `uMatrix` and the v5 MERCATOR prelude both take mercator-z, so the
 *     latitude-correct `mercatorZFromAltitude` factor at the tile's own centre
 *     latitude rides in `uMercatorZPerMeter` and multiplies the metres;
 *   - the v5 GLOBE prelude takes METRES (`spherePos * (1 + elev/GLOBE_RADIUS)`)
 *     while its transition FALLBACK term wants mercator-z again — so the globe
 *     branch feeds each side its own unit from the same two values.
 * Never re-adopt the pre-D10 flat `1e-7` factor.
 *
 * ── Feature surface ─────────────────────────────────────────────────────────
 *  - `timeFilterMode` — window (default) / wake / cumulative / trail, compiled
 *    in at PROGRAM-BUILD time (no mode uniform, no dynamic branch), so the
 *    program-cache key carries it. Wake additionally shrinks the FOOTPRINT
 *    toward `wakeTailScale` — deck's ColumnLayer routes `DECKGL_FILTER_SIZE`
 *    through its horizontal offset, not its elevation, so the tail thins rather
 *    than sinks.
 *  - `filterProperty`/`filterRange`/… — the DataFilter kernel
 *    (`shaders/data-filter.glsl.ts`), compiled in only when `filterProperty`
 *    is set. `filterTransformSize` shrinks the footprint (again deck's
 *    `DECKGL_FILTER_SIZE` target), `filterTransformColor` fades it.
 *  - `filled` / `stroked` — the prism body and a screen-space outline of its
 *    TOP ring. deck restricts `stroked` to `extruded: false` (it reuses one
 *    model for both passes); this backend has a dedicated ring mesh, so the
 *    outline is available on prisms too. Deliberate superset.
 *  - `renderingMode` — `'3d'` by DEFAULT (this kind is genuinely 3D, unlike the
 *    package's other five): maplibre then hands the layer a LEQUAL read-write
 *    depth mode shared with fill-extrusion/terrain, so prisms occlude each
 *    other and the basemap's own buildings correctly. See
 *    {@link STTColumnLayerOptions.renderingMode}.
 *
 * Every gate lands in the id-pick programs too (same snippets, same uniforms):
 * a column that is time-filtered, hard-filtered, collapsed to nothing or
 * painted with a zero-alpha colour must not be pickable — and because this kind
 * renders depth-TESTED, its id pass runs against a depth attachment as well
 * (`STTBaseLayer.pick`), so the prism the user can SEE wins the texel rather
 * than whichever one happened to be drawn last.
 *
 * ── Globe ───────────────────────────────────────────────────────────────────
 * No chord subdivision (`lib/globe.ts`) runs here, and that is a decision, not
 * an omission: subdivision exists so a LONG edge between two far-apart vertices
 * doesn't cut through the sphere, and a column's footprint is a
 * `radius`-sized disk — at the default 100 m radius its edges are ~1e-5 of one
 * subdivision cell even at z0. The prism is projected per-vertex through
 * `projectTileFor3D` (globe: through the sphere term with re-derived horizon
 * clipping), so curvature across the disk is already exact to within the
 * mesh's own faceting. A column whose radius approaches a subdivision cell
 * (hundreds of km) would need the kit; {@link STTColumnLayerOptions.radius}
 * documents that boundary.
 */

import type { Tile, STTTileLayer as STTLayer } from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_POLYGON_PALETTE } from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTBaseLayer,
  resolveTrailFade,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  type RGBA8,
} from '../base-layer.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import {
  TIME_WINDOW_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_TRAIL_GLSL,
} from '../shaders/time-window.glsl.js';
import { POSITION_DEQUANT_GLSL } from '../shaders/position-quantization.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  createDataFilterUniforms,
  extractFilterColumn,
  resolveDataFilterUniforms,
  type DataFilterRange,
  type DataFilterUniforms,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';
import { buildElevatedProjection } from '../shaders/globe-elevation.glsl.js';
import {
  mercatorZFromAltitude,
  metersToMercatorUnits,
  tileCenterLatitude,
} from '../lib/projection.js';

/**
 * The four real time-filter modes — the package-wide {@link STTTimeFilterMode}
 * under this layer's name.
 */
export type ColumnTimeFilterMode = STTTimeFilterMode;

/**
 * Brightness multiplier applied to the prism's SIDE WALLS so the extrusion
 * reads as a solid rather than a silhouette. Matches `STTPolygonLayer`'s
 * extruded-wall convention (25% darker) — one backend, one look. The top cap
 * always renders at full brightness.
 */
export const WALL_SHADE = 0.75;

/** deck `ColumnLayer` defaults, mirrored so a port reads identically. */
const DEFAULT_DISK_RESOLUTION = 20;
const DEFAULT_RADIUS = 100;
const DEFAULT_ELEVATION = 1000;

/** Fill palette shared with the deck `AnimatedColumnLayer` (opaque tableau). */
const DEFAULT_COLUMN_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_POLYGON_PALETTE;

// Immutable stand-in for callers with no host frame: hand-built test
// DrawContexts that omit `frame`. Never mutated (only normalizeRenderArgs
// mutates frames, and it never sees this one).
const LEGACY_FRAME: HostFrame = createHostFrame();

// Hoisted uniform fallbacks — a cache whose position buffer skipped
// quantization would otherwise allocate these every draw.
const IDENTITY_POS_SCALE: readonly number[] = [1, 1, 1];
const ZERO_POS_OFFSET: readonly number[] = [0, 0, 0];

const DEG_TO_RAD = Math.PI / 180;

// ── unit prism mesh ─────────────────────────────────────────────────────────

/** A unit-space prism mesh, shared by every instance of one layer. */
export interface ColumnMesh {
  /** Stride-4 vertices: `[unitX, unitY, unitZ (0|1), shade]`. */
  vertices: Float32Array;
  /** Triangle indices into {@link vertices}. */
  indices: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

/** A unit-space ring-outline mesh: one screen-space quad per ring edge. */
export interface ColumnStrokeMesh {
  /**
   * Stride-6 vertices: `[cornerSide, cornerAlong, aX, aY, bX, bY]` — the quad
   * corner (`side ∈ {-1, +1}`, `along ∈ {0, 1}`) plus the edge's two unit-space
   * endpoints, so the vertex stage can expand the edge in SCREEN space after
   * projecting both ends (the `STTLineLayer` / polygon-stroke scheme).
   */
  vertices: Float32Array;
  vertexCount: number;
}

/**
 * The unit ring: `diskResolution` points on the unit circle, or the caller's
 * own `vertices` (deck's `vertices` prop — offsets from the centre, expressed
 * relative to the radius). Returns a flat `[x0, y0, x1, y1, …]` array.
 *
 * A regular polygon INSCRIBES the unit circle (deck's ColumnGeometry does the
 * same), so `radius` is the circumradius and the rendered disk is slightly
 * smaller than a true circle of that radius — visibly so at `diskResolution`
 * 4–6, which is exactly what a caller asking for a square/hex column wants.
 */
export function columnUnitRing(
  diskResolution: number,
  vertices?: ReadonlyArray<readonly [number, number]> | null,
): Float64Array {
  if (vertices && vertices.length >= 3) {
    const out = new Float64Array(vertices.length * 2);
    for (let i = 0; i < vertices.length; i++) {
      out[i * 2] = vertices[i][0];
      out[i * 2 + 1] = vertices[i][1];
    }
    return out;
  }
  const n = sanitizeDiskResolution(diskResolution);
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * 2 * Math.PI;
    out[i * 2] = Math.cos(theta);
    out[i * 2 + 1] = Math.sin(theta);
  }
  return out;
}

/** Disk resolution clamped to a renderable polygon (deck's `min: 4`, we allow 3). */
function sanitizeDiskResolution(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DISK_RESOLUTION;
  return Math.max(3, Math.floor(n));
}

/**
 * CPU cache of the regular-polygon meshes, keyed `${diskResolution}:${extruded}`.
 * Meshes are pure geometry (no GL handles), so one entry serves every layer,
 * every map and every context in the page — the "generated once per
 * diskResolution" contract. Custom `vertices` bypass the cache (they are
 * caller-owned data, not a shared shape).
 */
const MESH_CACHE = new Map<string, ColumnMesh>();
const STROKE_MESH_CACHE = new Map<number, ColumnStrokeMesh>();

/**
 * Build (or fetch) the unit prism mesh.
 *
 * `extruded: false` emits the top cap ALONE — the flat-disk primitive, drawn
 * at `unitZ = 1` with `uElevationScale` uniformly 0 so the cap lands on the
 * base altitude. `extruded: true` adds a self-contained wall band (its own
 * duplicated top ring so the walls can carry {@link WALL_SHADE} without
 * darkening the cap), 2 triangles per ring edge.
 *
 * Winding is counter-clockwise seen from above for the cap; no face culling is
 * enabled, so back walls simply lose the depth test to front walls.
 */
export function buildColumnMesh(
  diskResolution: number,
  extruded: boolean,
  vertices?: ReadonlyArray<readonly [number, number]> | null,
): ColumnMesh {
  const custom = Boolean(vertices && vertices.length >= 3);
  const key = `${sanitizeDiskResolution(diskResolution)}:${extruded ? 1 : 0}`;
  if (!custom) {
    const hit = MESH_CACHE.get(key);
    if (hit) return hit;
  }

  const ring = columnUnitRing(diskResolution, vertices);
  const n = ring.length / 2;
  const vertexCount = extruded ? n * 3 : n;
  const out = new Float32Array(vertexCount * 4);
  const idx: number[] = [];

  // Top cap: one vertex per ring point at unitZ = 1, full brightness.
  for (let i = 0; i < n; i++) {
    out[i * 4] = ring[i * 2];
    out[i * 4 + 1] = ring[i * 2 + 1];
    out[i * 4 + 2] = 1;
    out[i * 4 + 3] = 1;
  }
  // Convex ring ⇒ a fan from vertex 0 triangulates it with no extra centre
  // vertex. (A concave custom `vertices` ring self-overlaps here, exactly as it
  // does in deck's ColumnGeometry — the prop is documented for convex shapes.)
  for (let i = 1; i < n - 1; i++) idx.push(0, i, i + 1);

  if (extruded) {
    const wallTop = n;
    const wallBottom = n * 2;
    for (let i = 0; i < n; i++) {
      const t = (wallTop + i) * 4;
      out[t] = ring[i * 2];
      out[t + 1] = ring[i * 2 + 1];
      out[t + 2] = 1;
      out[t + 3] = WALL_SHADE;
      const b = (wallBottom + i) * 4;
      out[b] = ring[i * 2];
      out[b + 1] = ring[i * 2 + 1];
      out[b + 2] = 0;
      out[b + 3] = WALL_SHADE;
    }
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const tA = wallTop + i;
      const tB = wallTop + next;
      const bA = wallBottom + i;
      const bB = wallBottom + next;
      idx.push(tA, bA, tB, tB, bA, bB);
    }
  }

  const mesh: ColumnMesh = {
    vertices: out,
    indices: Uint16Array.from(idx),
    vertexCount,
    indexCount: idx.length,
  };
  if (!custom) MESH_CACHE.set(key, mesh);
  return mesh;
}

/**
 * Build (or fetch) the ring-outline mesh: 6 vertices (2 triangles) per ring
 * edge, each carrying the quad corner plus BOTH unit-space endpoints so the
 * vertex stage can project the edge and expand it in screen space.
 */
export function buildColumnStrokeMesh(
  diskResolution: number,
  vertices?: ReadonlyArray<readonly [number, number]> | null,
): ColumnStrokeMesh {
  const custom = Boolean(vertices && vertices.length >= 3);
  const key = sanitizeDiskResolution(diskResolution);
  if (!custom) {
    const hit = STROKE_MESH_CACHE.get(key);
    if (hit) return hit;
  }
  const ring = columnUnitRing(diskResolution, vertices);
  const n = ring.length / 2;
  // Quad corners in the (side, along) convention the base layer's shared unit
  // quad uses, emitted as two triangles (0,1,2) + (2,1,3) so one non-indexed
  // draw covers the whole ring.
  const corners: ReadonlyArray<readonly [number, number]> = [
    [-1, 0],
    [1, 0],
    [-1, 1],
    [-1, 1],
    [1, 0],
    [1, 1],
  ];
  const out = new Float32Array(n * corners.length * 6);
  let w = 0;
  for (let e = 0; e < n; e++) {
    const next = (e + 1) % n;
    const ax = ring[e * 2];
    const ay = ring[e * 2 + 1];
    const bx = ring[next * 2];
    const by = ring[next * 2 + 1];
    for (const [side, along] of corners) {
      out[w++] = side;
      out[w++] = along;
      out[w++] = ax;
      out[w++] = ay;
      out[w++] = bx;
      out[w++] = by;
    }
  }
  const mesh: ColumnStrokeMesh = {
    vertices: out,
    vertexCount: n * corners.length,
  };
  if (!custom) STROKE_MESH_CACHE.set(key, mesh);
  return mesh;
}

// ── CPU references the shaders mirror (unit-tested) ─────────────────────────

/**
 * Space-time-cube lift in METRES — the JS twin of the shader's
 * `(aTime.x - uTimeHeightOrigin) * uTimeHeightScale`. Both times are
 * TILE-RELATIVE (the layer subtracts the tile's `timeOffset` from
 * `timeHeightOrigin` before it becomes a uniform), which is what keeps the
 * subtraction f32-exact.
 */
export function timeHeightLiftMeters(
  featureStartTimeRel: number,
  timeHeightOriginRel: number,
  timeHeightScale: number,
): number {
  return (featureStartTimeRel - timeHeightOriginRel) * timeHeightScale;
}

/**
 * Elevation (METRES) of a prism vertex — the JS twin of the shader's
 * `center.z + lift + aUnit.z * height * elevationScale`. `unitZ` is 0 at the
 * base and 1 at the top cap; `baseAltitudeM` is the tile's own per-feature
 * altitude (0 for a 2D archive).
 */
export function columnVertexElevationMeters(
  baseAltitudeM: number,
  liftM: number,
  heightM: number,
  elevationScale: number,
  unitZ: number,
): number {
  return baseAltitudeM + liftM + unitZ * heightM * elevationScale;
}

/**
 * Mercator units per ONE unit of `radius` — the CPU half of metric sizing, and
 * the whole reason `radiusUnits` costs no shader variant.
 *
 *  - `'meters'` (default, deck parity): the latitude-correct
 *    `metersToMercatorUnits` factor at the tile's centre latitude, so a column
 *    covers a fixed patch of ground and grows as you zoom in. Device-pixel
 *    independent by construction — a ground metre is a ground metre.
 *  - `'pixels'`: the inverse of maplibre's `512 · 2^zoom · dpr` DEVICE-pixel
 *    world, i.e. a footprint that holds its on-screen size. Constant-on-screen
 *    only for an UNPITCHED map: the conversion is a world-space scale resolved
 *    once per tile, so near the horizon a pitched view keeps the centre-of-view
 *    size instead of shrinking with depth (the same caveat
 *    `metersToPixelsAtLatitude` documents for screen-space widths).
 *
 * ⚠ `devicePixelRatio` is REQUIRED for the `'pixels'` branch to mean what every
 * other pixel in this package means. maplibre's `512 · 2^zoom` world is CSS
 * pixels, while `gl_PointSize` (point, trip-heads), `uViewport` (line, icon,
 * and this layer's OWN ring outline) and `metricPixelScaleAt`'s metres→pixels
 * conversion are all DEVICE pixels. Dropping the ratio here made one layer
 * disagree with itself: on a Retina display a `radius: 50, radiusUnits:
 * 'pixels'` disk drew 200 device px across while its `lineWidth: 25,
 * lineWidthUnits: 'pixels'` outline stayed 25 device px, so the ring thinned
 * relative to the column as dpr rose — and the same column drew twice the size
 * of an equally-sized icon sprite beside it.
 *
 * `coverage` (deck's 0..1 radius multiplier) folds in here so the shader sees
 * one scale.
 */
export function resolveColumnRadiusScale(
  radiusUnits: 'meters' | 'pixels',
  coverage: number,
  latitudeDeg: number,
  zoom: number,
  devicePixelRatio = 1,
): number {
  return radiusUnits === 'pixels'
    ? coverage / (512 * devicePixelRatio * Math.pow(2, zoom))
    : coverage * metersToMercatorUnits(1, latitudeDeg);
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set. Exported
 * for the prop-default tests; identical rule to the point layer's.
 */
export function resolveColumnTimeFilterMode(
  mode: ColumnTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): ColumnTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

// ── options ─────────────────────────────────────────────────────────────────

export interface STTColumnLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Sides of the column's cross-section (deck `diskResolution`). 20 ≈ a
   * cylinder; 6 is a hexbin bar; 4 a square post. Clamped to ≥ 3.
   * @default 20
   */
  diskResolution?: number;
  /**
   * Disk circumradius in {@link radiusUnits}.
   *
   * The globe path projects the footprint per vertex without chord
   * subdivision, which is exact to the mesh's own faceting as long as the
   * radius stays far below one subdivision cell (~300 km at z0 with maplibre's
   * default granularity). A radius in that league would need `lib/globe.ts`.
   * @default 100
   */
  radius?: number;
  /**
   * Unit for {@link radius}. `'meters'` (deck's ColumnLayer default) is ground
   * metric; `'pixels'` holds the footprint's on-screen size and means DEVICE
   * pixels — the same pixel {@link lineWidth}, `gl_PointSize` and every other
   * screen-space size in this package is expressed in. See
   * {@link resolveColumnRadiusScale} for the pitch caveat.
   * @default 'meters'
   */
  radiusUnits?: 'meters' | 'pixels';
  /** Disk rotation, counter-clockwise, in DEGREES (deck pass-through). @default 0 */
  angle?: number;
  /**
   * Custom cross-section replacing the regular polygon: points relative to the
   * centre, expressed in units of {@link radius} (deck's `vertices`). Needs ≥ 3
   * entries and should be convex — the fan triangulation self-overlaps
   * otherwise, exactly as deck's ColumnGeometry does. Bypasses the shared mesh
   * cache.
   * @default null
   */
  vertices?: ReadonlyArray<readonly [number, number]> | null;
  /** Disk offset from the feature position, relative to the radius. @default [0, 0] */
  offset?: readonly [number, number];
  /** Radius multiplier in 0..1 (deck pass-through). @default 1 */
  coverage?: number;
  /**
   * Extrude the columns into 3D prisms. `false` renders flat disks on the
   * ground (the mesh drops its wall band and `elevationScale` is forced to 0).
   * Pair with `map.setPitch(...)` for the relief to be visible.
   * @default true
   */
  extruded?: boolean;
  /** Draw the prism body. @default true */
  filled?: boolean;
  /**
   * Draw a screen-space outline around the TOP ring.
   *
   * deck's ColumnLayer only honours `stroked` when `extruded: false` (it reuses
   * one model for both passes); this backend carries a dedicated ring mesh, so
   * the outline works on prisms too — a deliberate superset.
   * @default false
   */
  stroked?: boolean;
  /** Outline colour when `stroked`. 0–1 floats or 0–255 ints (auto-detected). @default black */
  lineColor?: [number, number, number, number];
  /** Outline width in {@link lineWidthUnits} when `stroked`. @default 1 */
  lineWidth?: number;
  /**
   * Unit for {@link lineWidth}: `'pixels'` (screen-space, the historical
   * package convention) or `'meters'` (ground-metric, converted per tile at its
   * centre latitude).
   * @default 'pixels'
   */
  lineWidthUnits?: 'pixels' | 'meters';
  /**
   * Column height in METRES: a constant, or the NAME of a baked numeric column
   * (the accessor-alias convention — a column name, never a function). A tile
   * missing the named column falls back to {@link DEFAULT_ELEVATION}, matching
   * the deck adapter. A NEGATIVE height renders nothing (deck's
   * `shouldRender`), rather than a prism punched below the ground.
   * @default 1000
   */
  elevation?: number | string;
  /**
   * Dimensionless multiplier on every height (constant and column-driven
   * alike). Does NOT scale the {@link timeHeightScale} lift.
   * @default 1
   */
  elevationScale?: number;
  /**
   * Fill colour, `[r, g, b, a]`. Accepts 0–255 ints (the deck convention, and
   * what `colorPalette` uses) OR 0–1 floats — the range is auto-detected.
   * Ignored when {@link fillColorProperty} is set.
   * @default [255, 140, 0, 255]
   */
  color?: [number, number, number, number];
  /** Drive per-feature fill colour from a categorical column name. */
  fillColorProperty?: string;
  /** Palette (0–255 RGBA) sampled by category index when `fillColorProperty` is set. */
  colorPalette?: ReadonlyArray<RGBA8>;
  /**
   * Keyed category-STRING → 0–255 RGBA map (deck/three `colorMapping` parity):
   * a category renders the SAME colour in every tile regardless of per-tile
   * dictionary order. Unmapped categories fall back to
   * {@link colorMappingDefault}, then to the positional palette.
   */
  colorMapping?: Record<string, RGBA8>;
  /** Fill colour for categories absent from {@link colorMapping}. */
  colorMappingDefault?: RGBA8;
  /**
   * Space-time cube: METRES of altitude per simulation MILLISECOND. Every
   * vertex of a feature rises by `(startTime - timeHeightOrigin) * scale`.
   * 0 keeps the columns on the ground. See the module header for the origin
   * obligation.
   * @default 0
   */
  timeHeightScale?: number;
  /**
   * ABSOLUTE time (epoch ms) that maps to altitude 0 under
   * {@link timeHeightScale} — typically the archive's `timeRange.start`.
   * Relativized against each tile's `timeOffset` at draw time.
   * @default 0
   */
  timeHeightOrigin?: number;
  /**
   * Honour `prefers-reduced-motion`: forces {@link timeHeightScale} to 0 so the
   * columns stay at their base altitude (no rise, no flat↔cube morph). Time
   * playback and fades are unaffected.
   * @default false
   */
  reducedMotion?: boolean;
  /**
   * Time-filter mode. Unset ⇒ inferred from the knobs in deck's precedence
   * order (`wakeLength > 0` ⇒ wake, else `trailLength > 0` ⇒ trail, else
   * window). `'wake'`/`'trail'` degrade to `'window'` when their length knob is
   * non-positive (a zero-length wake would light nothing).
   *
   * `'cumulative'` carries the usual CALLER OBLIGATION: the shader does the
   * progressive reveal, the loader does not, so `timeWindow` must be wide
   * enough to keep already-revealed tiles resident.
   *
   * COMPILE-TIME and fixed for the layer's lifetime — construct a new layer to
   * change it.
   */
  timeFilterMode?: ColumnTimeFilterMode;
  /**
   * `wake` mode: milliseconds a column stays lit after its own start time,
   * alpha fading to 0 and its FOOTPRINT shrinking toward
   * {@link wakeTailScale}. Pass `timeWindow >= 2 * wakeLength` so the loader
   * actually holds the past half of the wake.
   * @default 0
   */
  wakeLength?: number;
  /** `wake` mode trailing-edge footprint multiplier (head = 1.0). @default 0.15 */
  wakeTailScale?: number;
  /**
   * `trail` mode: milliseconds a column stays lit after its start time.
   * Columns carry per-FEATURE times, so this reveals whole columns — the
   * per-VERTEX trail lives in `STTTripsLayer`.
   * @default 0
   */
  trailLength?: number;
  /**
   * `trail` mode head→tail fade: `1`/`true` (default) fades across
   * `trailLength`, `0`/`false` holds full alpha, intermediate numbers blend
   * (package-wide `resolveTrailFade` convention).
   */
  fadeTrail?: boolean | number;
  /**
   * MapLibre `CustomLayerInterface.renderingMode`.
   *
   * `'3d'` (the DEFAULT here, and the only layer in this package that departs
   * from the package-wide `'2d'`): the host installs a LEQUAL read-write depth
   * mode over `painter.depthRangeFor3D`, SHARED with fill-extrusion and
   * terrain, so prisms occlude one another and the basemap's own buildings.
   * The layer then leaves that depth state alone instead of disabling
   * `DEPTH_TEST` the way the flat layers do.
   *
   * `'2d'` restores the package's always-on-top behaviour (a read-only,
   * constant-per-layer depth slab): columns never occlude each other, which is
   * only what you want for flat disks or for compositing over a 2D basemap.
   * It is also the right choice for a TRANSLUCENT fill — depth writes cull the
   * back faces a see-through prism is supposed to show through, so pick either
   * an opaque `color` (the default) or `'2d'`.
   *
   * Read by the host at `addLayer` time — set it in the constructor, not later.
   * @default '3d'
   */
  renderingMode?: '2d' | '3d';
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled column program supports. Both knobs are structural (they add
 * uniforms/attributes/statements), so each combination is its own program and
 * each must appear in the program-cache key — {@link columnProgramKey}.
 */
export interface ColumnShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: ColumnTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
}

/** The out-of-the-box configuration: window mode, no column filter. */
const DEFAULT_SHADER_CONFIG: ColumnShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
});

/** The four draw passes, each with its own compiled program. */
export type ColumnPass = 'fill' | 'stroke' | 'pick-fill' | 'pick-stroke';

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<ColumnTimeFilterMode, string>> = Object.freeze(
  {
    window: TIME_WINDOW_GLSL,
    wake: TIME_WAKE_GLSL,
    cumulative: TIME_CUMULATIVE_GLSL,
    trail: TIME_TRAIL_GLSL,
  },
);

/**
 * Uniforms each mode reads. Only the active mode's block is declared, so an
 * unused uniform can never be silently mis-set.
 */
const MODE_UNIFORMS: Readonly<Record<ColumnTimeFilterMode, string>> =
  Object.freeze({
    window: `  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
`,
    wake: `  uniform float uCurrentTime;
  uniform float uWakeLength;
  uniform float uWakeTailScale;
`,
    cumulative: `  uniform float uCurrentTime;
  uniform float uFadeIn;
`,
    trail: `  uniform float uCurrentTime;
  uniform float uTrailLength;
  uniform float uFadeTrail;
`,
  });

/**
 * The `vAlpha = …` expression per mode. Every vertex of an instance carries its
 * feature's `aTime`, so `trail` reads `aTime.x` — a column reveals whole.
 */
const MODE_ALPHA: Readonly<Record<ColumnTimeFilterMode, string>> =
  Object.freeze({
    window:
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
  });

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * Disk rotation kernel. `rot` is `(cos angle, sin angle)` resolved on the CPU,
 * so the shader pays no transcendentals: this is deck's
 * `mat2(cos, sin, -sin, cos) * positions.xy` written out.
 */
const DISK_ROTATION_GLSL = `
vec2 sttRotateDisk(vec2 v, vec2 rot) {
  return vec2(v.x * rot.x - v.y * rot.y, v.x * rot.y + v.y * rot.x);
}
`;

/**
 * DataFilter application, shared by every pass. Deck's split: a HARD-filtered
 * feature (`0`) is hidden whatever the transform flags say, while a soft-margin
 * value only fades / shrinks when its flag is on (`DECKGL_FILTER_COLOR` /
 * `DECKGL_FILTER_SIZE`). deck's ColumnLayer routes `DECKGL_FILTER_SIZE` through
 * its horizontal offset, so the size transform thins the FOOTPRINT and leaves
 * the height alone.
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
    if (uFilterTransformSize > 0.5) {
      radius *= filterAlpha;
    }
`;

/**
 * Emit the projection of one `(mercatorXY, elevationMetres)` pair into a fresh
 * `vec4 ${out}` clip-space position.
 *
 * Legacy hosts multiply through `uMatrix` with the elevation converted to
 * mercator-z. Prelude hosts split by projection variant, mirroring
 * `STTPolygonLayer`'s extrusion path exactly (see the module header for the
 * unit table):
 *  - MERCATOR: `projectTileFor3D` takes mercator-z;
 *  - GLOBE: the sphere term takes METRES, and because `projectTileFor3D`
 *    deliberately PRESERVES z on globe ("Unlike interpolateProjection, this
 *    variant preserves the Z value", maplibre `_projection_globe.vertex.glsl`)
 *    the block re-derives the horizon-clip z itself — otherwise the back
 *    hemisphere would draw over the front — and feeds the transition's flat
 *    fallback mercator-z. The `0.2` constant is maplibre's own
 *    `z_globeness_threshold`.
 */
function projectBlock(
  usesPrelude: boolean,
  out: string,
  xy: string,
  elevM: string,
): string {
  return buildElevatedProjection({
    usesPrelude,
    xy,
    elevMeters: elevM,
    elevMercatorZ: `${elevM} * uMercatorZPerMeter`,
    // Two prism vertices are projected in one shader (`here` and, for the
    // outline's screen-space offset, `there`), so every declared name is
    // prefixed with the output's.
    names: {
      out,
      sphere: `${out}Sphere`,
      globe: `${out}Globe`,
      flat: `${out}Flat`,
    },
  });
}

/**
 * Declarations every column program shares: the unit-mesh attribute is per
 * pass, but the per-instance stream, the sizing/elevation uniforms and the
 * time/filter surface are identical, so the fill and stroke builders cannot
 * drift on a name.
 */
function sharedDeclarations(
  usesPrelude: boolean,
  cfg: ColumnShaderConfig,
): string {
  const legacy = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  return `  attribute vec3 aMercator;    // per-instance centre, per-tile-local UNSIGNED_SHORT — see sttDecodeMercatorPos
  attribute vec2 aTime;        // per-instance [startTime, endTime], tile-relative
  attribute float aElevation;  // per-instance height in METRES (when uUseFeatureElevation=1)
${cfg.filter ? FILTER_ATTRIBUTE : ''}${legacy}  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uRadius;
  uniform float uRadiusScale;  // radius units → mercator units (coverage folded in)
  uniform vec2 uDiskRotation;  // (cos angle, sin angle)
  uniform vec2 uDiskOffset;    // centre offset, relative to the radius
  uniform float uElevation;    // constant height in METRES
  uniform float uUseFeatureElevation;
  uniform float uElevationScale;
  uniform float uMercatorZPerMeter; // METRES → mercator-z at this tile's latitude
  uniform float uTimeHeightScale;   // space-time cube: metres per sim-ms
  uniform float uTimeHeightOrigin;  // tile-relative time mapped to altitude 0
`;
}

/**
 * The statements every pass runs before it knows where its vertex goes: decode
 * the instance centre, resolve the time alpha, resolve the height and the
 * footprint radius, then apply the wake shrink and the DataFilter.
 *
 * Order is deck's (`vs:#main-start` → `DECKGL_FILTER_SIZE`): the alpha is
 * computed FIRST so both the wake tail and the filter's size transform can read
 * it. `visible` is deck's `shouldRender` — a negative height collapses the
 * footprint instead of punching a prism below the ground.
 */
function preambleStatements(cfg: ColumnShaderConfig, colorGate = ''): string {
  const wakeSize =
    cfg.mode === 'wake'
      ? '    radius *= sttWakeSizeScale(vAlpha, uWakeTailScale);\n'
      : '';
  return `    vec3 center = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    vAlpha = ${MODE_ALPHA[cfg.mode]};
    float heightRaw = (uUseFeatureElevation > 0.5) ? aElevation : uElevation;
    float visible = (heightRaw >= 0.0) ? 1.0 : 0.0;
    float heightM = heightRaw * uElevationScale;
    float radius = uRadius * uRadiusScale * visible;
    float liftM = (aTime.x - uTimeHeightOrigin) * uTimeHeightScale;
${wakeSize}${cfg.filter ? FILTER_BODY : ''}${colorGate}`;
}

/**
 * Assemble the prism-body vertex shader.
 *
 * Legacy hosts (empty prelude) keep the `uMatrix` path; v5+ hosts get the
 * injected prelude + define prepended (maplibre's documented order) and project
 * through `projectTileFor3D` — this kind is genuinely 3D even when
 * `extruded: false`, because a non-zero `timeHeightScale` still lifts the disk
 * off the ground, and the globe branch re-derives horizon clipping itself so
 * nothing is lost by never taking the flat `projectTile` path.
 *
 * A fully-gated instance is dropped twice over: `gl_Position = vec4(0.0)`
 * collapses it at the vertex stage (the filter value is per-FEATURE, so the
 * instance collapses whole — no corner left pinned at the origin) and the
 * fragment shader's `if (vAlpha <= 0.0) discard;` backs that up.
 */
function buildColumnFillVs(
  shader: ShaderInjection,
  cfg: ColumnShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  // Both passes declare the colour surface. The visual pass paints with it; the
  // id pass reads only its ALPHA, so a prism painted `color: [r,g,b,0]` (or a
  // `colorMapping` entry with alpha 0, the idiomatic "hide this category"
  // spelling) is invisible AND unpickable — deck's `picking_filterPickingColor`
  // discards on the same condition. The gate is applied at the END of the
  // preamble, after the wake taper and the DataFilter have read `vAlpha` for
  // SIZE: a tint's opacity must never shrink the footprint.
  const idAttribute = isMain
    ? ''
    : '  attribute vec3 aIdColor;     // per-instance encoded pick id (UNSIGNED_BYTE normalized)\n';
  const payloadVarying = isMain
    ? '  varying vec4 vColor;\n  varying float vShade;\n'
    : '  varying vec3 vIdColor;\n';
  const colorGate = isMain
    ? ''
    : '    vAlpha *= ((uUseFeatureColor > 0.5) ? aColor.a : uColor.a);\n';
  const payloadAssign = isMain
    ? '    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;\n    vShade = aUnit.w;\n'
    : '    vIdColor = aIdColor;\n';

  return `${head}
  precision highp float;
  attribute vec4 aUnit;        // unit prism vertex: (x, y, zUnit 0|1, shade)
${sharedDeclarations(usesPrelude, cfg)}  attribute vec4 aColor;       // per-instance RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
${idAttribute}  uniform float uUseFeatureColor;
  uniform vec4 uColor;
${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${payloadVarying}${MODE_GLSL[cfg.mode]}${POSITION_DEQUANT_GLSL}${DISK_ROTATION_GLSL}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
${preambleStatements(cfg, colorGate)}    vec2 unitXY = sttRotateDisk(aUnit.xy, uDiskRotation);
    vec2 posM = center.xy + (unitXY + uDiskOffset) * radius;
    float elevM = center.z + liftM + aUnit.z * heightM;
${projectBlock(usesPrelude, 'here', 'posM', 'elevM')}    gl_Position = here;
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
${payloadAssign}  }
`;
}

/**
 * Assemble the ring-outline vertex shader: instanced screen-space line
 * expansion (the `STTLineLayer` / polygon-stroke scheme) over the TOP ring of
 * each prism. Both ends of the edge are projected in 3D — the outline has to
 * ride the cap, not the ground — and the perpendicular offset is applied in
 * screen pixels afterwards, so the expansion math is variant-independent.
 */
function buildColumnStrokeVs(
  shader: ShaderInjection,
  cfg: ColumnShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isId = kind === 'id';
  const idAttribute = isId
    ? '  attribute vec3 aIdColor;     // per-instance encoded pick id (UNSIGNED_BYTE normalized)\n'
    : '';
  const idVarying = isId ? '  varying vec3 vIdColor;\n' : '';
  const idAssign = isId ? '    vIdColor = aIdColor;\n' : '';
  // The outline's colour is a UNIFORM (`lineColor`), so the id pass declares
  // the same uniform purely to gate on its alpha: a ring drawn with
  // `lineColor: [r,g,b,0]` paints nothing and must not be pickable either.
  const colorGate = isId ? '    vAlpha *= uColor.a;\n' : '';

  return `${head}
  precision highp float;
  attribute vec2 aCorner;      // (side, along) per mesh vertex
  attribute vec4 aUnitAB;      // ring edge endpoints in unit space: (aX, aY, bX, bY)
${sharedDeclarations(usesPrelude, cfg)}${idAttribute}  uniform vec2 uViewport;
  uniform float uWidth;
  uniform vec4 uColor;         // outline colour (the FS paints it; the id pass gates on its alpha)
${MODE_UNIFORMS[cfg.mode]}${cfg.filter ? FILTER_UNIFORMS : ''}  varying float vAlpha;
${idVarying}${MODE_GLSL[cfg.mode]}${POSITION_DEQUANT_GLSL}${DISK_ROTATION_GLSL}${cfg.filter ? DATA_FILTER_GLSL : ''}
  void main() {
${preambleStatements(cfg, colorGate)}    vec2 unitA = sttRotateDisk(aUnitAB.xy, uDiskRotation);
    vec2 unitB = sttRotateDisk(aUnitAB.zw, uDiskRotation);
    vec2 posM = center.xy + (mix(unitA, unitB, aCorner.y) + uDiskOffset) * radius;
    vec2 neighborM = center.xy + (mix(unitB, unitA, aCorner.y) + uDiskOffset) * radius;
    float elevM = center.z + liftM + heightM;
${projectBlock(usesPrelude, 'here', 'posM', 'elevM')}${projectBlock(usesPrelude, 'there', 'neighborM', 'elevM')}    vec2 hereNdc = here.xy / here.w;
    vec2 thereNdc = there.xy / there.w;
    vec2 dirPx = (thereNdc - hereNdc) * 0.5 * uViewport;
    float lenPx = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / lenPx;
    float sideSign = (aCorner.y > 0.5) ? -1.0 : 1.0;
    vec2 perp = vec2(-dirN.y, dirN.x) * sideSign;
    vec2 offsetPx = perp * aCorner.x * uWidth * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;
    if (vAlpha <= 0.0) gl_Position = vec4(0.0);
${idAssign}  }
`;
}

/** Visual prism-body vertex source for a host variant + feature configuration. */
export function buildColumnVertexSource(
  shader: ShaderInjection,
  cfg: ColumnShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildColumnFillVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildColumnVertexSource}. */
export function buildColumnIdVertexSource(
  shader: ShaderInjection,
  cfg: ColumnShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildColumnFillVs(shader, cfg, 'id');
}

/** Visual ring-outline vertex source. */
export function buildColumnStrokeVertexSource(
  shader: ShaderInjection,
  cfg: ColumnShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildColumnStrokeVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildColumnStrokeVertexSource}. */
export function buildColumnStrokeIdVertexSource(
  shader: ShaderInjection,
  cfg: ColumnShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildColumnStrokeVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration.
 * `STTBaseLayer.getOrCreateProgram` appends `::${variantName}` (the HOST
 * variant) only, so two configurations sharing a base key would collide on one
 * program.
 */
export function columnProgramKey(
  pass: ColumnPass,
  cfg: ColumnShaderConfig,
): string {
  return `column:${pass}:${cfg.mode}${cfg.filter ? ':filter' : ''}`;
}

const FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  varying float vShade;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vColor.rgb * vShade, vColor.a * vAlpha);
  }
`;

const STROKE_FS_SOURCE = `
  precision highp float;
  uniform vec4 uColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(uColor.rgb, uColor.a * vAlpha);
  }
`;

/**
 * Id-pick fragment stage, shared by the body and outline pick programs. No
 * blending and no antialiasing: the readback must recover the byte triple
 * exactly. The `vAlpha` discard is what makes time-filtered and
 * DataFilter-hidden columns unpickable.
 */
const ID_FS_SOURCE = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vIdColor;
  void main() {
    if (vAlpha <= 0.0) discard;         // invisible columns are not pickable
    gl_FragColor = vec4(vIdColor, 1.0); // exact id bytes, fully opaque
  }
`;

// ── program handles ─────────────────────────────────────────────────────────

/**
 * Locations every column program shares. Resolved once per program; absent
 * uniforms come back null (a no-op for `gl.uniform*`) and absent attributes
 * come back -1, which is exactly how a mode/filter combination that doesn't
 * declare them reads.
 */
interface ColumnSharedHandles {
  program: WebGLProgram;
  /** True when the vertex source was built with the host prelude (v5+ variants). */
  usesPrelude: boolean;
  aMercator: number;
  aTime: number;
  aElevation: number;
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uRadiusScale: WebGLUniformLocation | null;
  uDiskRotation: WebGLUniformLocation | null;
  uDiskOffset: WebGLUniformLocation | null;
  uElevation: WebGLUniformLocation | null;
  uUseFeatureElevation: WebGLUniformLocation | null;
  uElevationScale: WebGLUniformLocation | null;
  uMercatorZPerMeter: WebGLUniformLocation | null;
  uTimeHeightScale: WebGLUniformLocation | null;
  uTimeHeightOrigin: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
  uCurrentTime: WebGLUniformLocation | null;
  uWakeLength: WebGLUniformLocation | null;
  uWakeTailScale: WebGLUniformLocation | null;
  uTrailLength: WebGLUniformLocation | null;
  uFadeTrail: WebGLUniformLocation | null;
  uFilterRange: WebGLUniformLocation | null;
  uFilterSoftRange: WebGLUniformLocation | null;
  uFilterEnabled: WebGLUniformLocation | null;
  uFilterTransformSize: WebGLUniformLocation | null;
  uFilterTransformColor: WebGLUniformLocation | null;
}

interface ColumnFillHandles extends ColumnSharedHandles {
  aUnit: number;
  /** Visual variant only (-1 on the id program). */
  aColor: number;
  /** Id-pick variant only (-1 on the visual program). */
  aIdColor: number;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

interface ColumnStrokeHandles extends ColumnSharedHandles {
  aCorner: number;
  aUnitAB: number;
  /** Id-pick variant only (-1 on the visual program). */
  aIdColor: number;
  uViewport: WebGLUniformLocation | null;
  uWidth: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

/** Per-instance attribute buffers held alongside the standard TileGpuCache. */
interface ColumnGpuCache extends TileGpuCache {
  /** Instances drawn for this tile — one per POINT feature. */
  instanceCount: number;
  /**
   * Metres → mercator-z at this tile's centre latitude (D10), resolved once at
   * build time so the draw path pays no transcendentals per frame.
   */
  mercatorZScale: number;
  colorBuffer?: WebGLBuffer;
  elevationBuffer?: WebGLBuffer;
  /** Per-instance DataFilter column; absent when the tile didn't bake it. */
  filterBuffer?: WebGLBuffer;
  /** Whether this tile supplies the filter column (the `enabled` gate). */
  hasFilterColumn?: boolean;
  /**
   * Host shader variant the cached VAOs' attribute locations were recorded
   * against. A VAO stores attribute SLOTS, which are per-program — when the
   * host flips variants (mercator ⇄ globe) the relinked program may assign
   * different slots, so the VAOs must be rebuilt against it.
   */
  vaoVariant?: string;
}

/**
 * MapLibre custom layer that renders STT point tiles as instanced extruded
 * prisms — the 3D-bars primitive and the space-time cube.
 *
 * ```ts
 * const layer = new STTColumnLayer({
 *   id: 'trips',
 *   url: '/data/taxi.stt',
 *   currentTime: t0,
 *   timeWindow: 3_600_000,
 *   radius: 120,          // metres
 *   elevation: 'rides',   // a baked numeric column, in metres
 *   elevationScale: 4,
 *   // space-time cube: 40 m of altitude per playback minute
 *   timeHeightScale: 40 / 60_000,
 *   timeHeightOrigin: t0,
 * });
 * layer.attach(map);
 * ```
 */
export class STTColumnLayer extends STTBaseLayer {
  /**
   * Host depth participation. Redeclared (the base defaults the package to
   * `'2d'`) because this kind is genuinely 3D — see
   * {@link STTColumnLayerOptions.renderingMode}. Assigned in the constructor
   * because the option decides it; maplibre reads it at `addLayer` time.
   */
  readonly renderingMode: '2d' | '3d';

  private readonly columnOpts: {
    diskResolution: number;
    radius: number;
    radiusUnits: 'meters' | 'pixels';
    angle: number;
    vertices: ReadonlyArray<readonly [number, number]> | null;
    offset: readonly [number, number];
    coverage: number;
    extruded: boolean;
    filled: boolean;
    stroked: boolean;
    lineColor: [number, number, number, number];
    lineWidth: number;
    lineWidthUnits: 'pixels' | 'meters';
    elevation: number | string;
    elevationScale: number;
    color: [number, number, number, number];
    fillColorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping?: Record<string, RGBA8>;
    colorMappingDefault?: RGBA8;
    timeHeightScale: number;
    timeHeightOrigin: number;
    reducedMotion: boolean;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
  };

  /** Mutated in place by the filter setters; read by `resolveDataFilterUniforms`. */
  private readonly filterOpts: STTDataFilterOptions;
  /** Allocated once — the per-draw uniform payload never allocates. */
  private readonly filterUniforms: DataFilterUniforms =
    createDataFilterUniforms();

  /**
   * Compiled shader configuration. Both knobs are fixed for the layer's
   * lifetime (mode is resolved once from the constructor options, the filter
   * branch from the presence of `filterProperty`), so the program-cache keys
   * are built once too and the draw path never concatenates a key.
   */
  private readonly shaderConfig: ColumnShaderConfig;
  private readonly programKeys: Readonly<Record<ColumnPass, string>>;

  /** `(cos, sin)` of `angle`, recomputed only when the prop moves. */
  private diskRotation: [number, number];

  /**
   * Handles of the most recently used host variant, memoized per `*Variant` so
   * the per-tile hot path skips the base cache's key-string build; the cache is
   * only consulted on a variant flip. Cleared together in onContextLost.
   */
  private fillHandles?: ColumnFillHandles;
  private fillVariant?: string;
  private strokeHandles?: ColumnStrokeHandles;
  private strokeVariant?: string;
  private pickFillHandles?: ColumnFillHandles;
  private pickFillVariant?: string;
  private pickStrokeHandles?: ColumnStrokeHandles;
  private pickStrokeVariant?: string;

  /** Shared unit-mesh GPU buffers — one upload per context, not per tile. */
  private meshVertexBuffer?: WebGLBuffer;
  private meshIndexBuffer?: WebGLBuffer;
  private strokeVertexBuffer?: WebGLBuffer;
  private mesh?: ColumnMesh;
  private strokeMesh?: ColumnStrokeMesh;

  private warnedCategoricalFilter = false;
  private warnedNoInstancing = false;

  constructor(opts: STTColumnLayerOptions) {
    super(opts);
    // Redeclared over the base's `'2d'`; `??` (not a spread) so an explicitly
    // passed `renderingMode: undefined` still lands on the default.
    this.renderingMode = opts.renderingMode ?? '3d';
    this.columnOpts = {
      diskResolution: sanitizeDiskResolution(
        opts.diskResolution ?? DEFAULT_DISK_RESOLUTION,
      ),
      radius: opts.radius ?? DEFAULT_RADIUS,
      radiusUnits: opts.radiusUnits ?? 'meters',
      angle: opts.angle ?? 0,
      vertices: opts.vertices ?? null,
      offset: opts.offset ?? [0, 0],
      coverage: opts.coverage ?? 1,
      extruded: opts.extruded ?? true,
      filled: opts.filled ?? true,
      stroked: opts.stroked ?? false,
      lineColor: opts.lineColor ?? [0, 0, 0, 1],
      lineWidth: opts.lineWidth ?? 1,
      lineWidthUnits: opts.lineWidthUnits ?? 'pixels',
      elevation: opts.elevation ?? DEFAULT_ELEVATION,
      elevationScale: opts.elevationScale ?? 1,
      color: opts.color ?? [255, 140, 0, 255],
      fillColorProperty: opts.fillColorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_COLUMN_PALETTE,
      colorMapping: opts.colorMapping,
      colorMappingDefault: opts.colorMappingDefault,
      timeHeightScale: opts.timeHeightScale ?? 0,
      timeHeightOrigin: opts.timeHeightOrigin ?? 0,
      reducedMotion: opts.reducedMotion ?? false,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
    };
    this.filterOpts = {
      filterProperty: opts.filterProperty,
      filterRange: opts.filterRange,
      filterSoftRange: opts.filterSoftRange,
      filterEnabled: opts.filterEnabled,
      filterTransformSize: opts.filterTransformSize,
      filterTransformColor: opts.filterTransformColor,
    };
    this.diskRotation = rotationOf(this.columnOpts.angle);
    this.shaderConfig = Object.freeze({
      mode: resolveColumnTimeFilterMode(
        opts.timeFilterMode,
        this.columnOpts.wakeLength,
        this.columnOpts.trailLength,
      ),
      // Compiled from the PROPERTY name alone: a tile that turns out not to
      // bake the column resolves `enabled: 0` and renders unfiltered, so one
      // program serves every tile of the layer.
      filter: Boolean(opts.filterProperty),
    });
    this.programKeys = Object.freeze({
      fill: columnProgramKey('fill', this.shaderConfig),
      stroke: columnProgramKey('stroke', this.shaderConfig),
      'pick-fill': columnProgramKey('pick-fill', this.shaderConfig),
      'pick-stroke': columnProgramKey('pick-stroke', this.shaderConfig),
    });
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  // ── runtime setters ───────────────────────────────────────────────────────

  /** Update the fill colour (0–1 floats or 0–255 ints). */
  setColor(color: [number, number, number, number]): void {
    this.columnOpts.color = color;
    this.map?.triggerRepaint();
  }

  /** Update the outline colour used when `stroked`. */
  setLineColor(color: [number, number, number, number]): void {
    this.columnOpts.lineColor = color;
    this.map?.triggerRepaint();
  }

  /** Update the disk radius, in `radiusUnits`. Uniform-only. */
  setRadius(radius: number): void {
    this.columnOpts.radius = radius;
    this.map?.triggerRepaint();
  }

  /** Update the height exaggeration. Uniform-only. */
  setElevationScale(scale: number): void {
    this.columnOpts.elevationScale = scale;
    this.map?.triggerRepaint();
  }

  /** Update the disk rotation, in DEGREES. Uniform-only. */
  setAngle(angleDegrees: number): void {
    this.columnOpts.angle = angleDegrees;
    this.diskRotation = rotationOf(angleDegrees);
    this.map?.triggerRepaint();
  }

  /**
   * Move the space-time-cube lift (metres per sim-ms). Uniform-only, so
   * animating the flat↔cube morph frame by frame is free. Pair with
   * {@link setTimeHeightOrigin}.
   */
  setTimeHeightScale(scale: number): void {
    this.columnOpts.timeHeightScale = scale;
    this.map?.triggerRepaint();
  }

  /** Move the absolute time that maps to altitude 0. Uniform-only. */
  setTimeHeightOrigin(absoluteMs: number): void {
    this.columnOpts.timeHeightOrigin = absoluteMs;
    this.map?.triggerRepaint();
  }

  /** Force the space-time-cube lift off for reduced-motion viewers. Uniform-only. */
  setReducedMotion(reduced: boolean): void {
    this.columnOpts.reducedMotion = reduced;
    this.map?.triggerRepaint();
  }

  /**
   * Toggle extrusion. The wall band is baked into the SHARED unit mesh, so this
   * drops the mesh buffers (rebuilt on the next draw); per-tile instance
   * buffers are untouched — extrusion is a mesh property, not a tile property.
   */
  setExtruded(extruded: boolean): void {
    if (this.columnOpts.extruded === extruded) return;
    this.columnOpts.extruded = extruded;
    this.releaseMesh();
    this.map?.triggerRepaint();
  }

  /** Toggle the prism body. */
  setFilled(filled: boolean): void {
    this.columnOpts.filled = filled;
    this.map?.triggerRepaint();
  }

  /** Toggle the ring outline. */
  setStroked(stroked: boolean): void {
    this.columnOpts.stroked = stroked;
    this.map?.triggerRepaint();
  }

  /**
   * Move the DataFilter's hard `[min, max]` bounds (the slider hot path).
   * Uniform-only: no relink, no tile rebuild. `null` idles the filter, which
   * renders everything.
   */
  setFilterRange(range: DataFilterRange | null): void {
    this.filterOpts.filterRange = range;
    this.map?.triggerRepaint();
  }

  /** Move the DataFilter's soft fade margin. Uniform-only, like `setFilterRange`. */
  setFilterSoftRange(range: DataFilterRange | null): void {
    this.filterOpts.filterSoftRange = range;
    this.map?.triggerRepaint();
  }

  /** Master DataFilter switch. `false` renders every column unfiltered. */
  setFilterEnabled(enabled: boolean): void {
    this.filterOpts.filterEnabled = enabled;
    this.map?.triggerRepaint();
  }

  // ── GL lifecycle ──────────────────────────────────────────────────────────

  protected onContextReady(): void {
    // Programs and the unit mesh are built lazily per shader variant on the
    // first draw (a v5 host recompiles per projection variant; after a context
    // restore the base cache is empty and relinks anyway), so there is nothing
    // worth pre-linking here — unlike the point layer, whose id program is
    // eager so the first `pick()` never stalls, this layer's first pick already
    // follows at least one rendered frame.
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Program lifetimes are owned by the base per-variant cache (deleted on
    // dispose, dropped on context loss — both before this hook runs); only the
    // handle references and our own mesh buffers are ours to release. Deletes
    // on an already-lost context are silently ignored, which is exactly the
    // reference-release this needs.
    this.fillHandles = undefined;
    this.fillVariant = undefined;
    this.strokeHandles = undefined;
    this.strokeVariant = undefined;
    this.pickFillHandles = undefined;
    this.pickFillVariant = undefined;
    this.pickStrokeHandles = undefined;
    this.pickStrokeVariant = undefined;
    this.deleteMeshBuffers(gl);
  }

  /**
   * GL state for the frame. Departs from the base in exactly one way: on a
   * `'3d'` layer the host has already installed its LEQUAL read-write depth
   * mode (`painter.setDepthMode(depthRangeFor3D)`) before calling us, so we
   * LEAVE IT ALONE — disabling `DEPTH_TEST` the way the flat layers do is what
   * would make prisms paint in tile order instead of by depth. `'2d'` keeps the
   * package's always-on-top behaviour.
   */
  protected applySharedGlState(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.renderingMode !== '3d') gl.disable(gl.DEPTH_TEST);
  }

  // ── tile cache ────────────────────────────────────────────────────────────

  /**
   * Build the per-tile cache: the base's quantized centres + times, plus the
   * per-instance colour / height / DataFilter columns when their props name a
   * property the tile actually bakes. Every one of them degrades to "use the
   * constant" rather than to "hide the tile".
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
  ): ColumnGpuCache | null {
    const baseCache = super.buildTileGpuCache(gl, tile, layer);
    if (!baseCache) return null;
    const f = layer.features;
    const cache = baseCache as ColumnGpuCache;
    const extras: WebGLBuffer[] = baseCache.extraBuffers
      ? [...baseCache.extraBuffers]
      : [];

    // One instance per POINT feature. `vertexCount` is the decoded position
    // count, which is the same number for point geometry — take the min so a
    // malformed tile under-draws instead of reading past a buffer.
    cache.instanceCount = Math.min(f.featureCount, baseCache.vertexCount);
    cache.mercatorZScale = mercatorZFromAltitude(
      1,
      tileCenterLatitude(tile.id.z, tile.id.y),
    );

    if (this.columnOpts.fillColorProperty) {
      const colors = this.expandCategoricalColors(
        f,
        this.columnOpts.fillColorProperty,
        this.columnOpts.colorPalette,
        this.columnOpts.colorMapping,
        this.columnOpts.colorMappingDefault,
      );
      if (colors) {
        cache.colorBuffer = this.uploadArrayBuffer(gl, colors);
        extras.push(cache.colorBuffer);
      }
    }

    if (typeof this.columnOpts.elevation === 'string') {
      const heights = this.getNumericProperty(f, this.columnOpts.elevation);
      if (heights) {
        cache.elevationBuffer = this.uploadArrayBuffer(gl, heights);
        extras.push(cache.elevationBuffer);
      }
    }

    if (this.shaderConfig.filter) {
      // One column == one instance, so the per-FEATURE column binds directly
      // (no expandFilterValues, which is for segment/vertex instancing).
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical && !this.warnedCategoricalFilter) {
        this.warnedCategoricalFilter = true;
        console.warn(
          `[${this.id}] filterProperty '${this.filterOpts.filterProperty}' is a ` +
            `categorical column; range filtering needs a numeric one — rendering unfiltered`,
        );
      }
      cache.hasFilterColumn = col.hasColumn;
      if (col.values) {
        cache.filterBuffer = this.uploadArrayBuffer(gl, col.values);
        extras.push(cache.filterBuffer);
      }
    }

    cache.extraBuffers = extras.length > 0 ? extras : undefined;
    return cache;
  }

  // ── shared mesh ───────────────────────────────────────────────────────────

  /**
   * Build + upload the shared unit meshes on first use. The CPU geometry comes
   * from the module-level cache (one per `diskResolution`, shared across every
   * layer in the page); only the GPU buffers are per-layer, because a
   * `WebGLBuffer` belongs to one context.
   */
  private ensureMesh(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!this.mesh) {
      this.mesh = buildColumnMesh(
        this.columnOpts.diskResolution,
        this.columnOpts.extruded,
        this.columnOpts.vertices,
      );
    }
    if (!this.meshVertexBuffer) {
      this.meshVertexBuffer = this.uploadArrayBuffer(gl, this.mesh.vertices);
      const indexBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);
      this.meshIndexBuffer = indexBuffer;
    }
  }

  /** Build + upload the shared ring-outline mesh on first stroked draw. */
  private ensureStrokeMesh(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (!this.strokeMesh) {
      this.strokeMesh = buildColumnStrokeMesh(
        this.columnOpts.diskResolution,
        this.columnOpts.vertices,
      );
    }
    if (!this.strokeVertexBuffer) {
      this.strokeVertexBuffer = this.uploadArrayBuffer(
        gl,
        this.strokeMesh.vertices,
      );
    }
  }

  private deleteMeshBuffers(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.meshVertexBuffer) gl.deleteBuffer(this.meshVertexBuffer);
    if (this.meshIndexBuffer) gl.deleteBuffer(this.meshIndexBuffer);
    if (this.strokeVertexBuffer) gl.deleteBuffer(this.strokeVertexBuffer);
    this.meshVertexBuffer = undefined;
    this.meshIndexBuffer = undefined;
    this.strokeVertexBuffer = undefined;
  }

  /**
   * Drop the shared mesh (CPU + GPU) and every VAO that recorded it. Called
   * when a geometry-defining prop moves; the next draw rebuilds both.
   */
  private releaseMesh(): void {
    this.mesh = undefined;
    this.strokeMesh = undefined;
    if (this.gl) this.deleteMeshBuffers(this.gl);
    // VAOs captured the old mesh buffer bindings — rebuildTileCaches drops
    // them along with the (unchanged but cheap to rebuild) instance buffers.
    this.rebuildTileCaches();
  }

  // ── uniforms ──────────────────────────────────────────────────────────────

  /**
   * Effective space-time-cube lift: `reducedMotion` forces it to 0 so the
   * columns stay at their base altitude for viewers who prefer reduced motion.
   */
  private effectiveTimeHeightScale(): number {
    return this.columnOpts.reducedMotion ? 0 : this.columnOpts.timeHeightScale;
  }

  /**
   * The constant height (metres) the shader falls back to. A property-driven
   * `elevation` whose column is missing from a tile lands here, on the deck
   * adapter's own fallback rather than on 0 (a 0-height prism is invisible,
   * which reads as a broken tile instead of a styling default).
   */
  private constantElevation(): number {
    const e = this.columnOpts.elevation;
    return typeof e === 'number' ? e : DEFAULT_ELEVATION;
  }

  /**
   * Mercator units per unit of `radius` for this tile — the metric-sizing
   * factor, resolved at the TILE CENTRE's latitude and the map's FRACTIONAL
   * zoom so the footprint changes continuously rather than stepping at integer
   * zooms, and across the DEVICE-pixel ratio so the `'pixels'` branch means the
   * same pixel as the layer's own outline width (memoized in the base — this
   * runs once per tile per frame).
   */
  private resolveRadiusScale(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    // Frame-hoisted (beginFrame); the live getter is the fallback for draws
    // issued outside a render pass, and ctx.zoom (floored) the last resort.
    const zoom = this.frameZoom ?? this.map?.getZoom() ?? ctx.zoom;
    return resolveColumnRadiusScale(
      this.columnOpts.radiusUnits,
      this.columnOpts.coverage,
      tileCenterLatitude(tile.id.z, tile.id.y),
      zoom,
      this.resolveDevicePixelRatio(gl),
    );
  }

  /**
   * Outline width in DEVICE pixels (what the screen-space expansion offsets
   * in). `'meters'` converts at the tile's centre latitude and the fractional
   * zoom, crossing the device-pixel ratio exactly like the line layer's
   * `widthUnits`.
   */
  private resolveLineWidth(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const { lineWidth, lineWidthUnits } = this.columnOpts;
    if (lineWidthUnits !== 'meters') return lineWidth;
    // Shared base helper (fractional zoom + dpr + tile-centre latitude).
    return this.metricPixelScale(gl, tile, ctx, lineWidth);
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode. Only the active
   * mode's uniforms exist in the program, so the switch is also what keeps a
   * stale mode's uniform from being written to a null location every draw.
   * `uCurrentTime` follows the package convention: absolute time minus the
   * tile's own `timeOffset`.
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnSharedHandles,
    cache: ColumnGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.columnOpts;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uWakeLength, o.wakeLength);
        gl.uniform1f(h.uWakeTailScale, o.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uTrailLength, o.trailLength);
        gl.uniform1f(h.uFadeTrail, o.fadeTrail);
        break;
      default: {
        gl.uniform1f(h.uWindowStart, ctx.windowStart);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
        const { fadeIn, fadeOut } = this.resolveFadeDurations();
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
      }
    }
  }

  /**
   * Upload the DataFilter uniforms for this tile. No-op unless the filter was
   * compiled in. A tile that didn't bake the column resolves to `enabled: 0`,
   * which the kernel reads as "render everything" — never as "hide everything".
   */
  private setFilterUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnSharedHandles,
    cache: ColumnGpuCache,
  ): void {
    if (!this.shaderConfig.filter) return;
    const u = resolveDataFilterUniforms(
      this.filterUniforms,
      this.filterOpts,
      cache.hasFilterColumn === true,
    );
    gl.uniform2fv(h.uFilterRange, u.range);
    gl.uniform2fv(h.uFilterSoftRange, u.softRange);
    gl.uniform1f(h.uFilterEnabled, u.enabled);
    gl.uniform1f(h.uFilterTransformSize, u.transformSize);
    gl.uniform1f(h.uFilterTransformColor, u.transformColor);
  }

  /**
   * Projection + sizing + elevation + time + filter uniforms — everything the
   * visual and id passes set identically, so the pickable prism always matches
   * the drawn one (including on globe, where the prelude owns projection).
   */
  private setSharedUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnSharedHandles,
    tile: Tile,
    cache: ColumnGpuCache,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) {
      // v5+ variant: the injected prelude's projectTile* own projection.
      this.setPreludeProjectionUniforms(gl, h.program, frame);
    } else {
      gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
    }
    const o = this.columnOpts;
    gl.uniform3fv(h.uPosScale, cache.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, cache.posOffset ?? ZERO_POS_OFFSET);
    gl.uniform1f(h.uRadius, o.radius);
    gl.uniform1f(h.uRadiusScale, this.resolveRadiusScale(gl, tile, ctx));
    gl.uniform2f(h.uDiskRotation, this.diskRotation[0], this.diskRotation[1]);
    gl.uniform2f(h.uDiskOffset, o.offset[0], o.offset[1]);
    gl.uniform1f(h.uElevation, this.constantElevation());
    // Program-level, not VAO-recorded: set every draw so a tile that lacks the
    // height column falls back to the constant on the very same frame.
    gl.uniform1f(
      h.uUseFeatureElevation,
      cache.elevationBuffer && h.aElevation >= 0 ? 1 : 0,
    );
    // `extruded: false` flattens by scaling every height to 0 — the cap then
    // lands on the base altitude (plus any space-time lift, which is NOT
    // scaled by this).
    gl.uniform1f(h.uElevationScale, o.extruded ? o.elevationScale : 0);
    gl.uniform1f(h.uMercatorZPerMeter, cache.mercatorZScale);
    gl.uniform1f(h.uTimeHeightScale, this.effectiveTimeHeightScale());
    // Absolute → tile-relative, the same rebasing every other time crosses.
    gl.uniform1f(h.uTimeHeightOrigin, o.timeHeightOrigin - cache.timeOffset);
    this.setTimeUniforms(gl, h, cache, ctx);
    this.setFilterUniforms(gl, h, cache);
  }

  // ── attribute binding ─────────────────────────────────────────────────────

  /**
   * Bind the per-instance stream every pass shares. Divisors are VAO state, so
   * these run inside the VAO recording on the visual path and on the default
   * VAO during a pick (where {@link releaseInstanceAttributes} resets them).
   */
  private bindInstanceAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnSharedHandles,
    cache: ColumnGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.positionBuffer);
    gl.enableVertexAttribArray(h.aMercator);
    gl.vertexAttribPointer(h.aMercator, 3, gl.UNSIGNED_SHORT, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aMercator, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
    gl.enableVertexAttribArray(h.aTime);
    gl.vertexAttribPointer(h.aTime, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aTime, 1);

    if (cache.elevationBuffer && h.aElevation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.elevationBuffer);
      gl.enableVertexAttribArray(h.aElevation);
      gl.vertexAttribPointer(h.aElevation, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aElevation, 1);
    }
    if (cache.filterBuffer && h.aFilterValue >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.filterBuffer);
      gl.enableVertexAttribArray(h.aFilterValue);
      gl.vertexAttribPointer(h.aFilterValue, 1, gl.FLOAT, false, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 1);
    }
  }

  /**
   * Undo {@link bindInstanceAttributes} on the DEFAULT VAO after a pick pass.
   * Attribute divisors are per-VAO state and a pick runs outside the host's
   * render pass, so every per-instance slot must go back to 0 — otherwise the
   * next non-instanced draw that lands on the same slot reads one element per
   * INSTANCE instead of per vertex (a real bug the M2 picking pass hit).
   */
  private releaseInstanceAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnSharedHandles,
    cache: ColumnGpuCache,
  ): void {
    gl.disableVertexAttribArray(h.aMercator);
    this.instSupport.vertexAttribDivisor(h.aMercator, 0);
    gl.disableVertexAttribArray(h.aTime);
    this.instSupport.vertexAttribDivisor(h.aTime, 0);
    if (cache.elevationBuffer && h.aElevation >= 0) {
      gl.disableVertexAttribArray(h.aElevation);
      this.instSupport.vertexAttribDivisor(h.aElevation, 0);
    }
    if (cache.filterBuffer && h.aFilterValue >= 0) {
      gl.disableVertexAttribArray(h.aFilterValue);
      this.instSupport.vertexAttribDivisor(h.aFilterValue, 0);
    }
  }

  /**
   * Bind the per-instance colour, which BOTH fill passes need: the visual one
   * paints it, the id one gates on its alpha. Returns whether the slot was
   * enabled, so a pick teardown disables exactly what it enabled.
   */
  private bindFillColor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnFillHandles,
    cache: ColumnGpuCache,
  ): boolean {
    if (!cache.colorBuffer || h.aColor < 0) return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.colorBuffer);
    gl.enableVertexAttribArray(h.aColor);
    gl.vertexAttribPointer(h.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aColor, 1);
    return true;
  }

  /**
   * The fill colour uniforms, identical in both passes — one resolution point,
   * so "an invisible column is unpickable" cannot drift.
   */
  private setFillColorUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnFillHandles,
    cache: ColumnGpuCache,
  ): void {
    gl.uniform4fv(h.uColor, this.rgba01Uniform('Color', this.columnOpts.color));
    gl.uniform1f(
      h.uUseFeatureColor,
      cache.colorBuffer && h.aColor >= 0 ? 1 : 0,
    );
  }

  /** Bind the shared prism mesh (divisor 0 — it repeats for every instance). */
  private bindFillMesh(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnFillHandles,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVertexBuffer!);
    gl.enableVertexAttribArray(h.aUnit);
    gl.vertexAttribPointer(h.aUnit, 4, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aUnit, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndexBuffer!);
  }

  /** Bind the shared ring mesh: interleaved `(corner.xy, unitA.xy, unitB.xy)`. */
  private bindStrokeMesh(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: ColumnStrokeHandles,
  ): void {
    const stride = 6 * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.strokeVertexBuffer!);
    gl.enableVertexAttribArray(h.aCorner);
    gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, stride, 0);
    this.instSupport.vertexAttribDivisor(h.aCorner, 0);
    gl.enableVertexAttribArray(h.aUnitAB);
    gl.vertexAttribPointer(h.aUnitAB, 4, gl.FLOAT, false, stride, 8);
    this.instSupport.vertexAttribDivisor(h.aUnitAB, 0);
  }

  // ── program resolution ────────────────────────────────────────────────────

  /** Resolve the locations every column program declares. */
  private resolveSharedHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
  ): ColumnSharedHandles {
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aElevation: gl.getAttribLocation(program, 'aElevation'),
      aFilterValue: this.shaderConfig.filter
        ? gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute)
        : -1,
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uRadius: gl.getUniformLocation(program, 'uRadius'),
      uRadiusScale: gl.getUniformLocation(program, 'uRadiusScale'),
      uDiskRotation: gl.getUniformLocation(program, 'uDiskRotation'),
      uDiskOffset: gl.getUniformLocation(program, 'uDiskOffset'),
      uElevation: gl.getUniformLocation(program, 'uElevation'),
      uUseFeatureElevation: gl.getUniformLocation(
        program,
        'uUseFeatureElevation',
      ),
      uElevationScale: gl.getUniformLocation(program, 'uElevationScale'),
      uMercatorZPerMeter: gl.getUniformLocation(program, 'uMercatorZPerMeter'),
      uTimeHeightScale: gl.getUniformLocation(program, 'uTimeHeightScale'),
      uTimeHeightOrigin: gl.getUniformLocation(program, 'uTimeHeightOrigin'),
      uWindowStart: gl.getUniformLocation(program, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(program, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(program, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(program, 'uFadeOut'),
      uCurrentTime: gl.getUniformLocation(program, 'uCurrentTime'),
      uWakeLength: gl.getUniformLocation(program, 'uWakeLength'),
      uWakeTailScale: gl.getUniformLocation(program, 'uWakeTailScale'),
      uTrailLength: gl.getUniformLocation(program, 'uTrailLength'),
      uFadeTrail: gl.getUniformLocation(program, 'uFadeTrail'),
      uFilterRange: gl.getUniformLocation(program, DATA_FILTER_NAMES.range),
      uFilterSoftRange: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.softRange,
      ),
      uFilterEnabled: gl.getUniformLocation(program, DATA_FILTER_NAMES.enabled),
      uFilterTransformSize: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.transformSize,
      ),
      uFilterTransformColor: gl.getUniformLocation(
        program,
        DATA_FILTER_NAMES.transformColor,
      ),
    };
  }

  private buildFillHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pick: boolean,
  ): ColumnFillHandles {
    const program = this.linkProgram(
      gl,
      pick
        ? buildColumnIdVertexSource(shader, this.shaderConfig)
        : buildColumnVertexSource(shader, this.shaderConfig),
      pick ? ID_FS_SOURCE : FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aUnit: gl.getAttribLocation(program, 'aUnit'),
      // Both passes declare it: the visual pass paints with it, the id pass
      // gates on its alpha (see buildColumnFillVs).
      aColor: gl.getAttribLocation(program, 'aColor'),
      aIdColor: pick ? gl.getAttribLocation(program, 'aIdColor') : -1,
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
    };
  }

  private buildStrokeHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
    pick: boolean,
  ): ColumnStrokeHandles {
    const program = this.linkProgram(
      gl,
      pick
        ? buildColumnStrokeIdVertexSource(shader, this.shaderConfig)
        : buildColumnStrokeVertexSource(shader, this.shaderConfig),
      pick ? ID_FS_SOURCE : STROKE_FS_SOURCE,
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aUnitAB: gl.getAttribLocation(program, 'aUnitAB'),
      aIdColor: pick ? gl.getAttribLocation(program, 'aIdColor') : -1,
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uWidth: gl.getUniformLocation(program, 'uWidth'),
      uColor: gl.getUniformLocation(program, 'uColor'),
    };
  }

  private readonly fillFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): ColumnFillHandles => this.buildFillHandles(gl, shader, false);

  private readonly pickFillFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): ColumnFillHandles => this.buildFillHandles(gl, shader, true);

  private readonly strokeFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): ColumnStrokeHandles => this.buildStrokeHandles(gl, shader, false);

  private readonly pickStrokeFactory = (
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): ColumnStrokeHandles => this.buildStrokeHandles(gl, shader, true);

  /**
   * Instancing is not optional for this layer — the whole draw model is one
   * shared mesh × N instances. A runtime without it (WebGL1 with no
   * `ANGLE_instanced_arrays`, i.e. EOL browsers only) is told once and skipped,
   * rather than silently drawing one prism per tile.
   */
  private ensureInstancing(): boolean {
    if (this.instSupport.enabled) return true;
    if (!this.warnedNoInstancing) {
      this.warnedNoInstancing = true;
      console.warn(
        `[${this.id}] instanced drawing is unavailable (no WebGL2 and no ` +
          `ANGLE_instanced_arrays); the column layer renders nothing`,
      );
    }
    return false;
  }

  // ── draw ──────────────────────────────────────────────────────────────────

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    const c = cache as ColumnGpuCache;
    if (c.instanceCount <= 0 || !this.ensureInstancing()) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;

    // VAO recordings capture attribute locations of the variant's linked
    // program; a variant flip (v5 mercator ⇄ globe) may relocate them, so drop
    // the recordings and re-capture under the new programs. The compiled mode
    // and filter branch are constant for the layer's lifetime, so the host
    // variant is the whole key.
    if (c.vaoVariant !== variant) {
      if (c.vao) this.vaoSupport.delete(c.vao);
      if (c.strokeVao) this.vaoSupport.delete(c.strokeVao);
      c.vao = undefined;
      c.strokeVao = undefined;
      c.vaoVariant = variant;
    }

    if (this.columnOpts.filled) {
      this.ensureMesh(gl);
      let h = this.fillHandles;
      if (!h || this.fillVariant !== variant) {
        h = this.getOrCreateProgram(
          gl,
          this.programKeys.fill,
          frame,
          this.fillFactory,
        );
        this.fillHandles = h;
        this.fillVariant = variant;
      }
      gl.useProgram(h.program);
      this.setSharedUniforms(gl, h, tile, c, ctx, frame);
      this.setFillColorUniforms(gl, h, c);

      this.bindVaoOrSetup(c, () => {
        this.bindFillMesh(gl, h!);
        this.bindInstanceAttributes(gl, h!, c);
        this.bindFillColor(gl, h!, c);
      });

      this.instSupport.drawElementsInstanced(
        gl.TRIANGLES,
        this.mesh!.indexCount,
        gl.UNSIGNED_SHORT,
        0,
        c.instanceCount,
      );
    }

    if (this.columnOpts.stroked) {
      this.ensureStrokeMesh(gl);
      let sh = this.strokeHandles;
      if (!sh || this.strokeVariant !== variant) {
        sh = this.getOrCreateProgram(
          gl,
          this.programKeys.stroke,
          frame,
          this.strokeFactory,
        );
        this.strokeHandles = sh;
        this.strokeVariant = variant;
      }
      gl.useProgram(sh.program);
      this.setSharedUniforms(gl, sh, tile, c, ctx, frame);
      gl.uniform2f(sh.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(sh.uWidth, this.resolveLineWidth(gl, tile, ctx));
      gl.uniform4fv(
        sh.uColor,
        this.rgba01Uniform('StrokeColor', this.columnOpts.lineColor),
      );

      this.bindVaoOrSetup(
        c,
        () => {
          this.bindStrokeMesh(gl, sh!);
          this.bindInstanceAttributes(gl, sh!, c);
        },
        'stroke',
      );

      this.instSupport.drawArraysInstanced(
        gl.TRIANGLES,
        0,
        this.strokeMesh!.vertexCount,
        c.instanceCount,
      );
    }
  }

  /**
   * Draw this column tile into the id-pick FBO, painting feature `i` the flat
   * colour `encodePickId(idBase + i)`. Mirrors {@link drawTile}'s projection
   * (including the v5+ prelude variant, resolved from the same host frame), its
   * footprint/height maths and — critically — its ALPHA GATES: the same
   * time-filter mode, the same DataFilter range and the same negative-height
   * collapse, so a column the user cannot see is never pickable.
   * Browser-verify-only (the enclosing FBO round-trip needs a live GPU); the
   * id-colour build + decode join are unit-tested in the base.
   *
   * One column == one instance == one feature, so the per-feature id colours
   * bind straight to the instance stream (no `expandPickIdColors`). The buffer
   * is rebuilt per pick and freed immediately: `idBase` shifts with whatever
   * tiles are loaded this frame, and picks are rare user-initiated events.
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    const c = cache as ColumnGpuCache;
    if (c.instanceCount <= 0 || !this.ensureInstancing()) return;
    const { filled, stroked } = this.columnOpts;
    // Nothing drawn is nothing pickable — and nothing to allocate for either.
    if (!filled && !stroked) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const variant = frame.shader.variantName;
    // `featureCount` — not the cache's instance count — is what the base sized
    // the id range from, so painting can never spill past `idBase + count`.
    const count = Math.min(layer.features.featureCount, c.instanceCount);
    if (count <= 0) return;
    const idColors = this.buildPickIdColors(count, idBase);
    const idBuffer = this.uploadArrayBuffer(gl, idColors);

    if (filled) {
      this.ensureMesh(gl);
      let h = this.pickFillHandles;
      if (!h || this.pickFillVariant !== variant) {
        h = this.getOrCreateProgram(
          gl,
          this.programKeys['pick-fill'],
          frame,
          this.pickFillFactory,
        );
        this.pickFillHandles = h;
        this.pickFillVariant = variant;
      }
      gl.useProgram(h.program);
      this.setSharedUniforms(gl, h, tile, c, ctx, frame);
      // The colour reaches the id program too — only its ALPHA is read, and it
      // is what keeps a transparent column out of the hit test.
      this.setFillColorUniforms(gl, h, c);

      // Raw attribute binds (no VAO): picking is a rare user-initiated pass,
      // and the temp id buffer is per-pass, so a cached VAO would just go stale.
      this.bindFillMesh(gl, h);
      this.bindInstanceAttributes(gl, h, c);
      const colorBound = this.bindFillColor(gl, h, c);
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
      gl.enableVertexAttribArray(h.aIdColor);
      gl.vertexAttribPointer(h.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      this.instSupport.vertexAttribDivisor(h.aIdColor, 1);

      this.instSupport.drawElementsInstanced(
        gl.TRIANGLES,
        this.mesh!.indexCount,
        gl.UNSIGNED_SHORT,
        0,
        count,
      );

      // Leave the default-VAO attribute slate — and every divisor — clean.
      gl.disableVertexAttribArray(h.aUnit);
      gl.disableVertexAttribArray(h.aIdColor);
      this.instSupport.vertexAttribDivisor(h.aIdColor, 0);
      if (colorBound) {
        gl.disableVertexAttribArray(h.aColor);
        this.instSupport.vertexAttribDivisor(h.aColor, 0);
      }
      this.releaseInstanceAttributes(gl, h, c);
    }

    if (stroked) {
      this.ensureStrokeMesh(gl);
      let sh = this.pickStrokeHandles;
      if (!sh || this.pickStrokeVariant !== variant) {
        sh = this.getOrCreateProgram(
          gl,
          this.programKeys['pick-stroke'],
          frame,
          this.pickStrokeFactory,
        );
        this.pickStrokeHandles = sh;
        this.pickStrokeVariant = variant;
      }
      gl.useProgram(sh.program);
      this.setSharedUniforms(gl, sh, tile, c, ctx, frame);
      gl.uniform2f(sh.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(sh.uWidth, this.resolveLineWidth(gl, tile, ctx));
      // Same outline colour as the visual pass — the id stage reads its alpha
      // so a fully transparent ring is not a hit target.
      gl.uniform4fv(
        sh.uColor,
        this.rgba01Uniform('StrokeColor', this.columnOpts.lineColor),
      );

      this.bindStrokeMesh(gl, sh);
      this.bindInstanceAttributes(gl, sh, c);
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
      gl.enableVertexAttribArray(sh.aIdColor);
      gl.vertexAttribPointer(sh.aIdColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      this.instSupport.vertexAttribDivisor(sh.aIdColor, 1);

      this.instSupport.drawArraysInstanced(
        gl.TRIANGLES,
        0,
        this.strokeMesh!.vertexCount,
        count,
      );

      gl.disableVertexAttribArray(sh.aCorner);
      gl.disableVertexAttribArray(sh.aUnitAB);
      gl.disableVertexAttribArray(sh.aIdColor);
      this.instSupport.vertexAttribDivisor(sh.aIdColor, 0);
      this.releaseInstanceAttributes(gl, sh, c);
    }

    gl.deleteBuffer(idBuffer);
  }
}

/** `(cos, sin)` of an angle in DEGREES — the CPU half of `sttRotateDisk`. */
function rotationOf(angleDegrees: number): [number, number] {
  const rad = angleDegrees * DEG_TO_RAD;
  return [Math.cos(rad), Math.sin(rad)];
}
