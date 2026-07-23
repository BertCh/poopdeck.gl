/**
 * Host render-signature adapter — normalizes every custom-layer `render`
 * calling convention the supported basemap hosts use into one {@link HostFrame}:
 *
 *   - maplibre v3/v4:  `render(gl, matrix)` — positional mercator-0..1 → clip MVP.
 *   - maplibre v4.6+:  `render(gl, matrix, {fov, nearZ, farZ, ...})` — same,
 *     plus a camera-options arg (fov in radians).
 *   - maplibre v5:     `render(gl, args)` — positional matrix REMOVED
 *     (maplibre/maplibre-gl-js#3854); args carry `defaultProjectionData`
 *     (projection uniforms incl. globe), `shaderData` (injectable vertex
 *     prelude keyed by `variantName`) and fov/nearZ/farZ (radians).
 *   - maplibre v6:     v5 shape plus `args.getProjectionData(params)`
 *     per-tile projection queries.
 *   - mapbox v3:       `render(gl, matrix, ...globe positional params)` —
 *     arg2 is still a matrix, so it rides the legacy path (its extra
 *     positional args, starting with a projection-spec object, are ignored).
 *
 * Detection is structural (duck-typed) so the package's maplibre-gl peer/dev
 * dependency can stay at ^4 while v5/v6 hosts work at runtime — no v5-only
 * type imports anywhere.
 *
 * The returned HostFrame is a per-layer SCRATCH: callers pass the same `out`
 * every frame and every matrix/vector field is a preallocated Float32Array
 * slot overwritten in place — the render hot path allocates nothing.
 */

/**
 * MapLibre's default vertical field of view (36.87° = atan(0.75)), in
 * radians. The pick-math fallback when the host didn't hand us camera params
 * (v3/v4 without the options arg).
 */
export const DEFAULT_FOV_RADIANS = 0.6435011087932844;

/** Shader-injection data for the host's current projection variant. */
export interface HostShaderData {
  /**
   * Program-cache key for the host's shader variant (mercator / globe /
   * transition on v5+). Always `'legacy'` on ≤v4 / mapbox hosts.
   */
  variantName: string;
  /**
   * Vertex-shader prelude injected by v5+ hosts. Declares the
   * `u_projection_*` uniforms plus `projectTile(vec2)` /
   * `projectTileWithElevation(vec2, float)` / `projectTileFor3D(vec2, float)`
   * taking 0..1 web-mercator input — exactly what our quantized decode
   * produces. Empty on legacy hosts.
   */
  prelude: string;
  /** `#define` line(s) accompanying the prelude (e.g. GLOBE). Empty on legacy hosts. */
  define: string;
}

/**
 * The v5 `defaultProjectionData` uniforms, copied into per-frame scratch
 * storage. Field ↔ uniform mapping (set after `useProgram` on a program built
 * with the prelude — see `STTBaseLayer.setPreludeProjectionUniforms`):
 * `mainMatrix` → `u_projection_matrix`, `tileMercatorCoords` →
 * `u_projection_tile_mercator_coords`, `clippingPlane` →
 * `u_projection_clipping_plane`, `projectionTransition` →
 * `u_projection_transition`, `fallbackMatrix` → `u_projection_fallback_matrix`.
 */
export interface HostProjectionData {
  mainMatrix: Float32Array;
  tileMercatorCoords: Float32Array;
  clippingPlane: Float32Array;
  projectionTransition: number;
  fallbackMatrix: Float32Array;
}

/** One normalized render invocation, whatever the host's signature was. */
export interface HostFrame {
  /**
   * `'legacy'` = positional-matrix hosts (maplibre ≤v4, mapbox v3);
   * `'v5'` = args-object hosts (maplibre v5/v6).
   */
  mode: 'legacy' | 'v5';
  /**
   * Mercator-0..1 → clip MVP. On legacy hosts this is the positional matrix;
   * on v5 hosts it mirrors `defaultProjectionData.mainMatrix` so matrix-based
   * consumers (the legacy `uMatrix` shader on a v5-mercator host, pick math)
   * keep working.
   */
  matrix: Float32Array;
  /** v5 projection uniforms; undefined on legacy frames. */
  projectionData?: HostProjectionData;
  /** Shader-injection data; `'legacy'` + empty strings on legacy frames. */
  shader: HostShaderData;
  /**
   * Vertical field of view in RADIANS, when the host provides it (maplibre
   * v4.6+ options arg, v5+ args). Undefined on plain v3/v4 and mapbox — fall
   * back to {@link DEFAULT_FOV_RADIANS} for CPU camera math.
   */
  fov?: number;
  nearZ?: number;
  farZ?: number;
  /**
   * v6 per-tile projection query, when the host provides one. Invoked with
   * the host args object as `this`, so calling through this reference is
   * always safe.
   */
  getProjectionData?: (params: Record<string, unknown>) => unknown;
  /**
   * True while the host is rendering (or transitioning to) the globe
   * (`projectionTransition > 0`). On globe, wrap ≠ 0 world copies must be
   * skipped and long edges subdivided or they get horizon-clipped.
   */
  isGlobe: boolean;
}

// ── structural shapes of the host arguments (local — never import v5 types) ──

interface V5ShaderData {
  variantName?: string;
  vertexShaderPrelude?: string;
  define?: string;
}

interface V5DefaultProjectionData {
  mainMatrix?: ArrayLike<number>;
  tileMercatorCoords?: ArrayLike<number>;
  clippingPlane?: ArrayLike<number>;
  projectionTransition?: number;
  fallbackMatrix?: ArrayLike<number>;
}

interface V5RenderArgs {
  fov?: number;
  nearZ?: number;
  farZ?: number;
  shaderData?: V5ShaderData;
  defaultProjectionData?: V5DefaultProjectionData;
  getProjectionData?: (params: Record<string, unknown>) => unknown;
}

/** v4.6/v4.7 third positional options arg (subset we consume). */
interface LegacyRenderOptions {
  fov?: unknown;
  nearZ?: unknown;
  farZ?: unknown;
}

// ── scratch internals (hidden behind the public HostFrame shape) ─────────────

interface HostFrameInternals {
  /** Preallocated projection-data struct reused across v5 frames. */
  _proj: HostProjectionData;
  /**
   * Rebind the stable getProjectionData wrapper to a new host args object
   * (or clear it). The wrapper itself is allocated once per frame object.
   */
  _setGpd(
    host: unknown,
    fn: ((params: Record<string, unknown>) => unknown) | undefined,
  ): void;
}

const IDENTITY16: readonly number[] = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];
/** Whole-mercator tile coords: projectTile() input is plain 0..1 mercator. */
const UNIT_TILE4: readonly number[] = [0, 0, 1, 1];
const ZERO4: readonly number[] = [0, 0, 0, 0];

const copy16 = (dst: Float32Array, src: ArrayLike<number>): void => {
  for (let i = 0; i < 16; i++) dst[i] = src[i];
};

const copyVec = (
  dst: Float32Array,
  src: ArrayLike<number> | undefined,
  fallback: readonly number[],
): void => {
  const s = src !== undefined && src.length >= dst.length ? src : fallback;
  for (let i = 0; i < dst.length; i++) dst[i] = s[i];
};

const isMatrixLike = (v: unknown): v is ArrayLike<number> => {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as ArrayLike<number>;
  return a.length === 16 && typeof a[0] === 'number';
};

const isV5Args = (v: unknown): v is V5RenderArgs =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as V5RenderArgs).defaultProjectionData === 'object' &&
  (v as V5RenderArgs).defaultProjectionData !== null;

/** Attach the lazily-created scratch internals to a (possibly hand-built) frame. */
function withInternals(out: HostFrame): HostFrame & HostFrameInternals {
  const o = out as HostFrame & Partial<HostFrameInternals>;
  if (!o._proj) {
    o._proj = {
      mainMatrix: new Float32Array(16),
      tileMercatorCoords: new Float32Array(4),
      clippingPlane: new Float32Array(4),
      projectionTransition: 0,
      fallbackMatrix: new Float32Array(16),
    };
    let gpdHost: unknown;
    let gpdFn: ((params: Record<string, unknown>) => unknown) | undefined;
    const wrapper = (params: Record<string, unknown>): unknown =>
      gpdFn?.call(gpdHost, params);
    o._setGpd = (host, fn) => {
      gpdHost = host;
      gpdFn = fn;
      o.getProjectionData = fn ? wrapper : undefined;
    };
  }
  return o as HostFrame & HostFrameInternals;
}

/** Allocate a scratch HostFrame (one per layer instance; reused every frame). */
export function createHostFrame(): HostFrame {
  const frame: HostFrame = {
    mode: 'legacy',
    matrix: new Float32Array(16),
    projectionData: undefined,
    shader: { variantName: 'legacy', prelude: '', define: '' },
    fov: undefined,
    nearZ: undefined,
    farZ: undefined,
    getProjectionData: undefined,
    isGlobe: false,
  };
  frame.matrix.set(IDENTITY16);
  withInternals(frame);
  return frame;
}

/**
 * Normalize a custom-layer render invocation's 2nd/3rd arguments into `out`
 * (mutated in place and returned; a fresh frame is allocated when omitted —
 * hot paths always pass their per-instance scratch).
 *
 * Dispatch: `arg2.defaultProjectionData` ⇒ v5/v6 args object; 16-element
 * matrix-like `arg2` ⇒ legacy positional matrix (capturing a v4.6+ camera
 * options `arg3` when its fov/nearZ/farZ are numeric — mapbox's positional
 * projection-spec arg3 fails that guard and is ignored).
 */
export function normalizeRenderArgs(
  arg2: unknown,
  arg3?: unknown,
  out: HostFrame = createHostFrame(),
): HostFrame {
  const o = withInternals(out);

  if (isV5Args(arg2)) {
    const pd = arg2.defaultProjectionData as V5DefaultProjectionData;
    const proj = o._proj;
    copyVec(proj.mainMatrix, pd.mainMatrix, IDENTITY16);
    copyVec(proj.fallbackMatrix, pd.fallbackMatrix, IDENTITY16);
    copyVec(proj.tileMercatorCoords, pd.tileMercatorCoords, UNIT_TILE4);
    copyVec(proj.clippingPlane, pd.clippingPlane, ZERO4);
    proj.projectionTransition = pd.projectionTransition ?? 0;
    o.matrix.set(proj.mainMatrix);
    o.projectionData = proj;
    const sd = arg2.shaderData;
    // A v5 host without shaderData (defensive) degrades to the legacy
    // uMatrix shader — mainMatrix IS the mercator MVP off-globe.
    o.shader.variantName = sd?.variantName ?? 'legacy';
    o.shader.prelude = sd?.vertexShaderPrelude ?? '';
    o.shader.define = sd?.define ?? '';
    o.fov = typeof arg2.fov === 'number' ? arg2.fov : undefined;
    o.nearZ = typeof arg2.nearZ === 'number' ? arg2.nearZ : undefined;
    o.farZ = typeof arg2.farZ === 'number' ? arg2.farZ : undefined;
    o._setGpd(
      arg2,
      typeof arg2.getProjectionData === 'function'
        ? arg2.getProjectionData
        : undefined,
    );
    o.isGlobe = proj.projectionTransition > 0;
    o.mode = 'v5';
    return o;
  }

  // Legacy positional matrix. Tolerate exotic hosts handing a non-array-like
  // iterable (materialized once — never the case for maplibre/mapbox, which
  // pass arrays/typed arrays).
  let mat: ArrayLike<number> | undefined = isMatrixLike(arg2)
    ? arg2
    : undefined;
  if (
    mat === undefined &&
    arg2 !== null &&
    arg2 !== undefined &&
    typeof (arg2 as Iterable<number>)[Symbol.iterator] === 'function'
  ) {
    const arr = Array.from(arg2 as Iterable<number>);
    if (arr.length >= 16) mat = arr;
  }
  if (mat) copy16(o.matrix, mat);
  const opts = arg3 as LegacyRenderOptions | null | undefined;
  const isCameraOptions =
    typeof opts === 'object' &&
    opts !== null &&
    (typeof opts.fov === 'number' ||
      typeof opts.nearZ === 'number' ||
      typeof opts.farZ === 'number');
  o.fov =
    isCameraOptions && typeof opts.fov === 'number' ? opts.fov : undefined;
  o.nearZ =
    isCameraOptions && typeof opts.nearZ === 'number' ? opts.nearZ : undefined;
  o.farZ =
    isCameraOptions && typeof opts.farZ === 'number' ? opts.farZ : undefined;
  o.projectionData = undefined;
  o.shader.variantName = 'legacy';
  o.shader.prelude = '';
  o.shader.define = '';
  o._setGpd(undefined, undefined);
  o.isGlobe = false;
  o.mode = 'legacy';
  return o;
}
