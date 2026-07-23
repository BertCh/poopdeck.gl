/**
 * GOLDEN fixtures for the maplibre-backend correctness contract
 * (`../golden-correctness.test.ts`).
 *
 * A "golden" here is an EXPECTED value that does NOT come from the code under
 * test — it is hand-computed from the documented definition, lifted verbatim
 * from the upstream library (h3-js / CARTO / deck.gl), or read off the Web
 * Mercator / smoothstep formulae. The contract test feeds the corresponding
 * kernel the input and asserts it reproduces the golden, so a regression in the
 * kernel fails loudly against a fixed oracle rather than against itself.
 *
 * Everything is pure data (numbers + literals). No GL, no map, no imports from
 * the code under test, so nothing in here can drift silently WITH a kernel.
 *
 * There is deliberately NO pixel-image golden: the repo has no headless GL
 * context and the project rule keeps AESTHETICS human-verified in the browser.
 * These are the *numeric* invariants a maplibre renderer must satisfy — the
 * ones with exact answers — consolidated in one place.
 */

// ── 1. Time-filter goldens (all four modes) ─────────────────────────────────
//
// The window kernel takes half-window EDGES; a renderer resolves them from the
// playhead as `windowStart = currentTime - timeWindow/2`,
// `windowEnd = currentTime + timeWindow/2`. The fixtures carry `currentTime`
// and `timeWindow` so the DISCARD invariant — a feature fully outside
// `[t - w/2, t + w/2]` contributes zero — is stated in playhead terms.

export interface TimeWindowGolden {
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly currentTime: number;
  readonly timeWindow: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  /** Hand-computed alpha the window kernel must reproduce exactly. */
  readonly expected: number;
}

/** currentTime 1000, timeWindow 200 ⇒ half-window edges [900, 1100]. */
export const TIME_WINDOW_GOLDENS: readonly TimeWindowGolden[] = [
  {
    name: 'feature fully inside the window is fully lit',
    startTime: 950,
    endTime: 1050,
    currentTime: 1000,
    timeWindow: 200,
    fadeIn: 0,
    fadeOut: 0,
    expected: 1,
  },
  {
    name: 'feature entirely BEFORE the window is discarded (alpha 0)',
    startTime: 0,
    endTime: 800,
    currentTime: 1000,
    timeWindow: 200,
    fadeIn: 0,
    fadeOut: 0,
    expected: 0,
  },
  {
    name: 'feature entirely AFTER the window is discarded (alpha 0)',
    startTime: 1200,
    endTime: 1300,
    currentTime: 1000,
    timeWindow: 200,
    fadeIn: 0,
    fadeOut: 0,
    expected: 0,
  },
  {
    name: 'feature endTime exactly ON windowStart still overlaps (inclusive edge)',
    // endTime == windowStart (900): the overlap test is `endTime < windowStart`,
    // so a single-point touch is NOT discarded.
    startTime: 800,
    endTime: 900,
    currentTime: 1000,
    timeWindow: 200,
    fadeIn: 0,
    fadeOut: 0,
    expected: 1,
  },
  {
    name: 'fade-in ramps the leading edge to age/fadeIn',
    // age = windowEnd - startTime = 1100 - 1080 = 20; 20/50 = 0.4.
    startTime: 1080,
    endTime: 1090,
    currentTime: 1000,
    timeWindow: 200,
    fadeIn: 50,
    fadeOut: 0,
    expected: 0.4,
  },
  {
    name: 'fade-out ramps the trailing edge to remaining/fadeOut',
    // remaining = endTime - windowStart = 910 - 900 = 10; 10/50 = 0.2.
    startTime: 800,
    endTime: 910,
    currentTime: 1000,
    timeWindow: 200,
    fadeIn: 0,
    fadeOut: 50,
    expected: 0.2,
  },
];

export interface TrailGolden {
  readonly name: string;
  readonly vertexTime: number;
  readonly currentTime: number;
  readonly trailLength: number;
  readonly fadeTrail: number;
  readonly expected: number;
}

export const TRAIL_GOLDENS: readonly TrailGolden[] = [
  {
    name: 'vertex in the FUTURE is discarded',
    vertexTime: 1500,
    currentTime: 1000,
    trailLength: 200,
    fadeTrail: 1,
    expected: 0,
  },
  {
    name: 'vertex OLDER than trailLength is discarded',
    vertexTime: 500,
    currentTime: 1000,
    trailLength: 200,
    fadeTrail: 1,
    expected: 0,
  },
  {
    name: 'mid-trail comet fade is 1 - age/trailLength',
    // age = 100, trailLength 200 ⇒ 1 - 0.5 = 0.5.
    vertexTime: 900,
    currentTime: 1000,
    trailLength: 200,
    fadeTrail: 1,
    expected: 0.5,
  },
  {
    name: 'solid snake (fadeTrail 0) is fully lit inside the trail',
    vertexTime: 900,
    currentTime: 1000,
    trailLength: 200,
    fadeTrail: 0,
    expected: 1,
  },
  {
    name: 'degenerate trailLength <= 0 lights nothing (no 0/0)',
    vertexTime: 999,
    currentTime: 1000,
    trailLength: 0,
    fadeTrail: 1,
    expected: 0,
  },
];

export interface WakeGolden {
  readonly name: string;
  readonly startTime: number;
  readonly currentTime: number;
  readonly wakeLength: number;
  readonly expected: number;
}

export const WAKE_GOLDENS: readonly WakeGolden[] = [
  {
    name: 'at the head (age 0) the wake is full',
    startTime: 1000,
    currentTime: 1000,
    wakeLength: 500,
    expected: 1,
  },
  {
    name: 'half a wake-length back the wake is half lit',
    startTime: 750,
    currentTime: 1000,
    wakeLength: 500,
    expected: 0.5,
  },
  {
    name: 'a feature in the FUTURE (age < 0) is discarded',
    startTime: 1200,
    currentTime: 1000,
    wakeLength: 500,
    expected: 0,
  },
  {
    name: 'past the tail (age > wakeLength) is discarded',
    startTime: 400,
    currentTime: 1000,
    wakeLength: 500,
    expected: 0,
  },
  {
    name: 'degenerate wakeLength <= 0 lights nothing (no 0/0)',
    startTime: 1000,
    currentTime: 1000,
    wakeLength: 0,
    expected: 0,
  },
];

export interface CumulativeGolden {
  readonly name: string;
  readonly startTime: number;
  readonly currentTime: number;
  readonly fadeIn: number;
  readonly expected: number;
}

export const CUMULATIVE_GOLDENS: readonly CumulativeGolden[] = [
  {
    name: 'a feature whose start is in the FUTURE is not yet drawn',
    startTime: 1500,
    currentTime: 1000,
    fadeIn: 0,
    expected: 0,
  },
  {
    name: 'a started feature persists at full alpha with no fade',
    startTime: 500,
    currentTime: 1000,
    fadeIn: 0,
    expected: 1,
  },
  {
    name: 'a started feature stays lit long after (draw-and-persist)',
    startTime: 0,
    currentTime: 10_000_000,
    fadeIn: 0,
    expected: 1,
  },
  {
    name: 'fadeIn ramps the appearance to (currentTime-start)/fadeIn',
    // (1000 - 900) / 200 = 0.5.
    startTime: 900,
    currentTime: 1000,
    fadeIn: 200,
    expected: 0.5,
  },
];

// ── 2. Position quantization round-trip ─────────────────────────────────────
//
// A dense, tile-local mercator cluster (city-block scale) — the case the
// per-tile uint16 quantization targets. Round-tripping projected → quantize →
// GPU normalize (q/65535) → decode must land back within ONE quantization step,
// which for a city tile is sub-millimetre on the ground.

/** Stride-3 `[mx, my, mz]` mercator positions, one dense city-block cluster. */
export const QUANTIZATION_CLUSTER: Float32Array = new Float32Array([
  0.500001, 0.400002, 0, 0.500003, 0.400004, 0, 0.500005, 0.400001, 0, 0.500002,
  0.400005, 0,
]);

/**
 * The documented no-visible-loss epsilon: after the round trip every axis must
 * be within ONE quantization step (`scale / 65535`) of the original, and the
 * worst ground error across the cluster must be under 5 mm.
 */
export const QUANTIZATION_GROUND_EPSILON_M = 0.005;

/**
 * A buffer whose first vertex is the per-axis minimum and second the per-axis
 * maximum — the quantizer must map the extremes to 0 and 65535 exactly.
 */
export const QUANTIZATION_EXTREMES: Float32Array = new Float32Array([
  0.1, 0.2, 10, 0.3, 0.6, 20,
]);

// ── 3. DataFilter hard/soft ramp goldens ────────────────────────────────────
//
// Exact factors from deck's `step`/`smoothstep` semantics. `smoothstep` at its
// midpoint is exactly 0.5 (t = 0.5 ⇒ 0.5·0.5·(3 − 2·0.5) = 0.5), which pins the
// soft-margin values without any tolerance.

export interface DataFilterGolden {
  readonly name: string;
  readonly value: number;
  readonly range: readonly [number, number];
  readonly soft: readonly [number, number];
  readonly enabled: boolean;
  readonly expected: number;
}

export const DATA_FILTER_GOLDENS: readonly DataFilterGolden[] = [
  // Hard range [0, 10] (soft collapsed onto it ⇒ hard step, inclusive).
  {
    name: 'hard: value at the lower bound is included',
    value: 0,
    range: [0, 10],
    soft: [0, 10],
    enabled: true,
    expected: 1,
  },
  {
    name: 'hard: value at the upper bound is included',
    value: 10,
    range: [0, 10],
    soft: [0, 10],
    enabled: true,
    expected: 1,
  },
  {
    name: 'hard: value just below the lower bound is hidden',
    value: -0.001,
    range: [0, 10],
    soft: [0, 10],
    enabled: true,
    expected: 0,
  },
  {
    name: 'hard: value just above the upper bound is hidden',
    value: 10.001,
    range: [0, 10],
    soft: [0, 10],
    enabled: true,
    expected: 0,
  },
  // Soft margins [2, 8] inside a hard range [0, 10].
  {
    name: 'soft: value inside the soft plateau is fully lit',
    value: 5,
    range: [0, 10],
    soft: [2, 8],
    enabled: true,
    expected: 1,
  },
  {
    name: 'soft: left-margin midpoint is exactly 0.5 (smoothstep 0→2 at 1)',
    value: 1,
    range: [0, 10],
    soft: [2, 8],
    enabled: true,
    expected: 0.5,
  },
  {
    name: 'soft: right-margin midpoint is exactly 0.5 (1 − smoothstep 8→10 at 9)',
    value: 9,
    range: [0, 10],
    soft: [2, 8],
    enabled: true,
    expected: 0.5,
  },
  {
    name: 'soft: the inner soft edge (2) is fully lit',
    value: 2,
    range: [0, 10],
    soft: [2, 8],
    enabled: true,
    expected: 1,
  },
  {
    name: 'soft: the hard edge (0) fades to 0 once a margin exists',
    value: 0,
    range: [0, 10],
    soft: [2, 8],
    enabled: true,
    expected: 0,
  },
  // Inverted range hides everything (no auto-swap).
  {
    name: 'inverted range [10, 0] hides everything',
    value: 5,
    range: [10, 0],
    soft: [10, 0],
    enabled: true,
    expected: 0,
  },
  // NaN and disabled.
  {
    name: 'a NaN value is hidden when the filter is enabled',
    value: NaN,
    range: [0, 10],
    soft: [0, 10],
    enabled: true,
    expected: 0,
  },
  {
    name: 'a disabled filter renders everything, however far out of range',
    value: 1e9,
    range: [0, 1],
    soft: [0, 1],
    enabled: false,
    expected: 1,
  },
];

// ── 4. Cell-geometry goldens (injected H3 boundary + Quadbin ids) ───────────
//
// h3-js is an OPTIONAL (here absent) peer of this package, so the kernel takes
// `cellToBoundary` injected. These boundaries are verbatim `cellToBoundary(idx,
// true)` output from h3-js@4 — a genuine known cell standing in for the library
// — used both as the injected resolver and as the geometry oracle.

export interface H3Golden {
  readonly index: string;
  /** `cellToBoundary(index, true)` → GeoJSON [lng, lat], ring CLOSED by h3-js. */
  readonly boundary: readonly (readonly [number, number])[];
  /** Distinct rim vertices (boundary length minus h3-js's closing repeat). */
  readonly rimVertices: number;
}

/** res-9 San Francisco — the canonical H3 documentation cell, far from the seam. */
export const H3_SF: H3Golden = {
  index: '8928308280fffff',
  boundary: [
    [-122.41719971841658, 37.775197782893386],
    [-122.41612835779266, 37.77688044840227],
    [-122.41738797617619, 37.77838500493093],
    [-122.41971895414808, 37.77820687262238],
    [-122.4207902454188, 37.776524206993216],
    [-122.41953062807342, 37.77501967379261],
    [-122.41719971841658, 37.775197782893386],
  ],
  rimVertices: 6,
};

/** res-5 cell straddling the antimeridian — `latLngToCell(20, -179.99, 5)`. */
export const H3_ANTIMERIDIAN: H3Golden = {
  index: '855ab3cffffffff',
  boundary: [
    [-179.9366031180495, 19.979620696385894],
    [-179.92297040310055, 20.068963974365744],
    [179.9999432403449, 20.121291067273578],
    [179.9092294384495, 20.08415580289762],
    [179.89574875211053, 19.994748008387237],
    [179.97282966754992, 19.942539889218345],
    [-179.9366031180495, 19.979620696385894],
  ],
  rimVertices: 6,
};

/**
 * CARTO's published Quadbin root cell: `(0, 0, 0) → 0x480fffffffffffff`, the
 * whole mercator unit square. The bigint literal is the golden.
 */
export const QUADBIN_ROOT = 0x480fffffffffffffn;
export const QUADBIN_ROOT_TILE = { z: 0, x: 0, y: 0 } as const;
export const QUADBIN_ROOT_BOUNDS = {
  west: 0,
  east: 1,
  north: 0,
  south: 1,
} as const;

/**
 * A hand-specified slippy tile with EXACT mercator bounds — no id decode
 * needed, so the bounds are a pure golden for `quadbinTileToMercatorBounds`.
 * Tile (z2, x1, y1): west 1/4, east 2/4, north 1/4, south 2/4 (y grows south).
 */
export const QUADBIN_CHILD_TILE = { z: 2, x: 1, y: 1 } as const;
export const QUADBIN_CHILD_BOUNDS = {
  west: 0.25,
  east: 0.5,
  north: 0.25,
  south: 0.5,
} as const;

/**
 * A known-orientation mercator square (y grows SOUTH), wound SW → NW → NE → SE.
 * Its doubled shoelace area is +2, the module's canonical POSITIVE orientation;
 * the reverse is −2. `orientRingPositive` must leave the first untouched (same
 * reference) and flip the second.
 */
export const POSITIVE_SQUARE: readonly number[] = [0, 1, 0, 0, 1, 0, 1, 1];
export const POSITIVE_SQUARE_AREA2 = 2;

// ── 5. Flow value-matrix sampling goldens ───────────────────────────────────
//
// A 2×3 (rows × cols) matrix, flattened ROW-MAJOR as `vertexValueMatrix` bakes
// it. Sampling at an integer column returns that column's value exactly; between
// columns it is the linear blend `v0·(1−f) + v1·f`; outside `[0, cols−1]` it
// CLAMPS (a flow tile is timeless and must never blank).

export const FLOW_MATRIX_ROWS = 2;
export const FLOW_MATRIX_COLS = 3;
/** row 0 = [0, 10, 20], row 1 = [100, 50, 0]. */
export const FLOW_MATRIX_VALUES: readonly number[] = [0, 10, 20, 100, 50, 0];

export interface FlowSampleGolden {
  readonly name: string;
  readonly row: number;
  readonly bucket: number;
  readonly expected: number;
}

export const FLOW_SAMPLE_GOLDENS: readonly FlowSampleGolden[] = [
  { name: 'row 0, column 0 exact', row: 0, bucket: 0, expected: 0 },
  { name: 'row 0, column 1 exact', row: 0, bucket: 1, expected: 10 },
  { name: 'row 0, column 2 exact', row: 0, bucket: 2, expected: 20 },
  { name: 'row 0, halfway 0→1', row: 0, bucket: 0.5, expected: 5 },
  { name: 'row 0, halfway 1→2', row: 0, bucket: 1.5, expected: 15 },
  {
    name: 'row 0, below 0 clamps to column 0',
    row: 0,
    bucket: -1,
    expected: 0,
  },
  {
    name: 'row 0, above cols-1 clamps to the last column',
    row: 0,
    bucket: 5,
    expected: 20,
  },
  { name: 'row 1, column 0 exact', row: 1, bucket: 0, expected: 100 },
  { name: 'row 1, halfway 0→1', row: 1, bucket: 0.5, expected: 75 },
  { name: 'row 1, column 2 exact', row: 1, bucket: 2, expected: 0 },
];

/**
 * Flow bucket-axis golden: a uniform 3-column axis starting at epoch-ms 1000
 * with 100 ms columns. `bucketPositionAt` maps a playhead to a continuous
 * column, CLAMPED to `[0, numBuckets − 1]`.
 */
export const FLOW_AXIS = {
  numBuckets: 3,
  bucketWidthMs: 100,
  bucket0Abs: 1000,
} as const;

export interface FlowAxisGolden {
  readonly name: string;
  readonly absTimeMs: number;
  readonly expected: number;
}

export const FLOW_AXIS_GOLDENS: readonly FlowAxisGolden[] = [
  { name: 'left edge of column 0', absTimeMs: 1000, expected: 0 },
  { name: 'centre of column 1', absTimeMs: 1150, expected: 1.5 },
  { name: 'before the axis clamps to 0', absTimeMs: 500, expected: 0 },
  {
    name: 'past the axis clamps to numBuckets − 1',
    absTimeMs: 99_999,
    expected: 2,
  },
];
