import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import * as coreKernel from '@poopdeck.gl/core';
import {
  buildTrackIndex,
  sampleTrack,
  sampleTracks,
  lerp,
  lerpAngle,
  lerpDim,
  SINGLETON_HOLD_MS,
  type Track,
  type BoxTrackOptions,
  type BoxDefaults,
} from '../src/layers/box-tracks';
import * as threePackage from '../src/index';
import {
  writeBoxEdges,
  FLOATS_PER_BOX,
  BOX_EDGES,
} from '../src/geometry/box-edges';
import type { RGBA } from '../src/lib/color';

/**
 * `box-tracks` used to be a 344-line FORK of `@poopdeck.gl/core`'s track kernel
 * (its own `SINGLETON_HOLD_MS = 400`, no `maxGapMs` guard, no `angleUnit`), so
 * `@poopdeck.gl/three` shipped two track pools: this one behind the bounding-box
 * layer, and core's behind the icon + point-cloud layers. It is now a thin
 * adapter over core.
 *
 * The de-fork is guarded here by two DIFFERENTIALS against a hand transcription
 * of the pre-shim fork (`git show c13970a:packages/three/src/layers/box-tracks.ts`)
 * — one for the sampling half, one for the pooling half. The transcriptions are
 * copied, never imported: a differential that calls the same code on both sides
 * proves nothing. They stay in the tree after the deletion because they are the
 * only artefact that says what "behaviour preserving" meant here; delete them and
 * the next person changing `SINGLETON_HOLD_MS` or the dedupe order has no oracle.
 *
 * The pooling half is NOT obviously equivalent by reading: the fork sorted, then
 * permuted the arrays, then dropped ADJACENT equal times in a second pass; core
 * folds sort + de-dup into ONE permutation applied by a single reorder. They
 * agree only because both index-sort the same array with the same comparator and
 * both keep the FIRST entry of each equal-time run — which is a property of the
 * sort's stability, not something either implementation states.
 */

const OPTS: BoxTrackOptions = {
  trackIdProperty: 'track_id',
  colorProperty: 'category',
  colorMapping: { car: [255, 158, 0, 235] } as Record<string, RGBA>,
  colorMappingDefault: [150, 160, 175, 220],
  labelProperty: 'category',
  headingProperty: 'heading',
  lengthProperty: 'length',
  widthProperty: 'width',
  heightProperty: 'height',
  speedProperty: 'speed',
};
const DEF: BoxDefaults = {
  length: 4,
  width: 2,
  height: 1.6,
  fadeIn: 0,
  fadeOut: 0,
};

/** A tile with `count` object snapshots; per-keyframe columns are parallel arrays. */
function objectTile(
  trackIds: string[],
  starts: number[],
  cols: {
    lon: number[];
    lat: number[];
    heading?: number[];
    category?: string[];
    speed?: number[];
  },
  timeOffset = 0,
): Tile {
  const count = trackIds.length;
  const positions = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = cols.lon[i];
    positions[i * 2 + 1] = cols.lat[i];
  }
  const trackCats = Array.from(new Set(trackIds));
  const catCats = cols.category ? Array.from(new Set(cols.category)) : [];
  const features: BinaryFeatures = {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(starts),
    endTimes: new Float32Array(starts),
    timeOffset,
    numericProps: {
      ...(cols.heading ? { heading: new Float32Array(cols.heading) } : {}),
      ...(cols.speed ? { speed: new Float32Array(cols.speed) } : {}),
      length: new Float32Array(count).fill(4),
      width: new Float32Array(count).fill(2),
      height: new Float32Array(count).fill(1.6),
    },
    categoricalProps: {
      track_id: {
        indices: new Uint16Array(trackIds.map((t) => trackCats.indexOf(t))),
        categories: trackCats,
      },
      ...(cols.category
        ? {
            category: {
              indices: new Uint16Array(
                cols.category.map((c) => catCats.indexOf(c)),
              ),
              categories: catCats,
            },
          }
        : {}),
    },
    vectorProps: {},
  };
  return {
    id: { z: 18, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'objects',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

describe('lerpAngle', () => {
  it('takes the short way across the ±π seam', () => {
    const a = (179 * Math.PI) / 180;
    const b = (-179 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    // Should be ~180°, not ~0°.
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.05);
  });
  it('degrades gracefully with NaN endpoints', () => {
    expect(lerpAngle(NaN, 1, 0.5)).toBe(1);
    expect(lerpAngle(1, NaN, 0.5)).toBe(1);
  });
});

describe('lerpDim', () => {
  it('falls back when both endpoints are NaN', () => {
    expect(lerpDim(NaN, NaN, 0.5, 7)).toBe(7);
    expect(lerpDim(2, NaN, 0.5, 7)).toBe(2);
  });
});

describe('buildTrackIndex + sampleTrack', () => {
  it('pools keyframes per track across tiles and interpolates position', () => {
    const t1 = objectTile(
      ['A'],
      [0],
      { lon: [-71], lat: [42], heading: [0], category: ['car'] },
      1000,
    );
    const t2 = objectTile(
      ['A'],
      [1000],
      { lon: [-71.001], lat: [42], heading: [0], category: ['car'] },
      1000,
    );
    const idx = buildTrackIndex([t1, t2], OPTS);
    expect(idx.size).toBe(1);
    const track = idx.get('A')!;
    expect(track.times).toEqual([1000, 2000]); // rebased to absolute, sorted
    expect(track.color).toEqual([255, 158, 0, 235]); // category 'car'
    // Halfway in time -> halfway in lon.
    const s = sampleTrack(track, 1500, DEF)!;
    expect(s.lon).toBeCloseTo(-71.0005, 6);
  });

  it('returns null outside the keyframe span', () => {
    const t1 = objectTile(['A'], [0], { lon: [-71], lat: [42] }, 1000);
    const t2 = objectTile(['A'], [1000], { lon: [-71], lat: [42] }, 1000);
    const idx = buildTrackIndex([t1, t2], OPTS);
    expect(sampleTrack(idx.get('A')!, 500, DEF)).toBeNull(); // before first (1000)
    expect(sampleTrack(idx.get('A')!, 5000, DEF)).toBeNull(); // after last (2000)
  });

  it('emits one active sample per active track', () => {
    const tile = objectTile(
      ['A', 'B'],
      [0, 0],
      { lon: [-71, -71.001], lat: [42, 42.001], category: ['car', 'car'] },
      1000,
    );
    const idx = buildTrackIndex([tile], OPTS);
    // singletons held ±200ms around 1000
    const samples = sampleTracks(idx, 1000, DEF);
    expect(samples.length).toBe(2);
  });

  it('applies fade in/out into the sample alpha', () => {
    const t1 = objectTile(['A'], [0], { lon: [-71], lat: [42] }, 1000);
    const t2 = objectTile(['A'], [1000], { lon: [-71], lat: [42] }, 1000);
    const idx = buildTrackIndex([t1, t2], OPTS);
    const fade: BoxDefaults = { ...DEF, fadeIn: 200, fadeOut: 200 };
    // 100ms after first keyframe (1000) -> alpha 0.5
    expect(sampleTrack(idx.get('A')!, 1100, fade)!.alpha).toBeCloseTo(0.5, 5);
  });
});

/* ── The pre-shim fork, transcribed by hand ─────────────────────────────────
 * Verbatim from `packages/three/src/layers/box-tracks.ts` before the de-fork
 * (its `SINGLETON_HOLD_MS`, `lerp`/`lerpAngle`/`lerpDim`, `readCategorical`,
 * `resolveColor`, `buildTrackIndex`, `reorder`, `dedupeByTime`, `sampleTrack`),
 * with every helper it reached for inlined so the transcription imports NOTHING
 * from the code it is the oracle for.
 */

const FORK_SINGLETON_HOLD_MS = 400;

interface ForkSample {
  lon: number;
  lat: number;
  alt: number;
  heading: number;
  length: number;
  width: number;
  height: number;
  speed: number;
  alpha: number;
  track: Track;
}

function forkLerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function forkLerpAngle(a: number, b: number, f: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return a + d * f;
}

function forkLerpDim(
  a: number,
  b: number,
  f: number,
  fallback: number,
): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return forkLerp(a, b, f);
  if (af) return a;
  if (bf) return b;
  return fallback;
}

function forkReadCategorical(
  binary: BinaryFeatures,
  prop: string,
  i: number,
): string {
  const cat = binary.categoricalProps[prop];
  if (cat) {
    const idx = cat.indices[i];
    return idx === 0xffff ? '' : (cat.categories[idx] ?? '');
  }
  const num = binary.numericProps[prop];
  if (num) {
    const v = num[i];
    return Number.isFinite(v) ? String(v) : '';
  }
  return '';
}

/** The fork's `resolveColor`, with core/style's `resolveCategoryColor` inlined. */
function forkResolveColor(
  category: string,
  mapping: Record<string, RGBA>,
  fallback: RGBA,
): RGBA {
  let c = fallback;
  if (category != null && category !== '' && mapping) {
    const hit = mapping[category];
    if (hit) c = hit;
  }
  return [c[0], c[1], c[2], c[3] ?? 255];
}

const FORK_PARALLEL_KEYS = [
  'times',
  'lon',
  'lat',
  'alt',
  'heading',
  'length',
  'width',
  'height',
  'speed',
] as const;

function forkReorder(track: Track, order: number[]): void {
  for (const k of FORK_PARALLEL_KEYS) {
    const arr = track[k];
    track[k] = order.map((idx) => arr[idx]);
  }
}

function forkDedupeByTime(track: Track): void {
  const t = track.times;
  const keep: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (i === 0 || t[i] !== t[i - 1]) keep.push(i);
  }
  if (keep.length !== t.length) forkReorder(track, keep);
}

function forkBuildTrackIndex(
  tiles: Tile[],
  opts: BoxTrackOptions,
): Map<string, Track> {
  const tracks = new Map<string, Track>();
  let synthetic = 0;

  for (const tile of tiles) {
    for (const tileLayer of tile.layers) {
      const binary = tileLayer.features;
      const count = binary.featureCount;
      if (count === 0) continue;

      const dims = binary.positionDimensions ?? 2;
      const positions = binary.positions;
      const starts = binary.startTimes;
      const offset = binary.timeOffset;
      const trackCol = binary.categoricalProps[opts.trackIdProperty];
      const heading = binary.numericProps[opts.headingProperty] ?? null;
      const length = binary.numericProps[opts.lengthProperty] ?? null;
      const width = binary.numericProps[opts.widthProperty] ?? null;
      const height = binary.numericProps[opts.heightProperty] ?? null;
      const speed = binary.numericProps[opts.speedProperty] ?? null;

      for (let i = 0; i < count; i++) {
        let key: string;
        if (trackCol) {
          const idx = trackCol.indices[i];
          key =
            idx === 0xffff
              ? `∅${synthetic++}`
              : (trackCol.categories[idx] ?? `∅${synthetic++}`);
        } else {
          key = `∅${synthetic++}`;
        }

        let track = tracks.get(key);
        if (!track) {
          const category = opts.colorProperty
            ? forkReadCategorical(binary, opts.colorProperty, i)
            : '';
          track = {
            trackId: trackCol ? key : '',
            times: [],
            lon: [],
            lat: [],
            alt: [],
            heading: [],
            length: [],
            width: [],
            height: [],
            speed: [],
            color: forkResolveColor(
              category,
              opts.colorMapping,
              opts.colorMappingDefault,
            ),
            label: forkReadCategorical(binary, opts.labelProperty, i),
            category,
            singleton: false,
          };
          tracks.set(key, track);
        }

        const b = i * dims;
        track.times.push(starts[i] + offset);
        track.lon.push(positions[b]);
        track.lat.push(positions[b + 1]);
        track.alt.push(dims > 2 ? positions[b + 2] : 0);
        track.heading.push(heading ? heading[i] : NaN);
        track.length.push(length ? length[i] : NaN);
        track.width.push(width ? width[i] : NaN);
        track.height.push(height ? height[i] : NaN);
        track.speed.push(speed ? speed[i] : NaN);
      }
    }
  }

  for (const track of tracks.values()) {
    const n = track.times.length;
    if (n > 1) {
      const order = Array.from({ length: n }, (_, k) => k).sort(
        (a, b) => track.times[a] - track.times[b],
      );
      forkReorder(track, order);
      forkDedupeByTime(track);
    }
    track.singleton = track.times.length < 2;
  }

  return tracks;
}

function forkSampleTrack(
  track: Track,
  now: number,
  defaults: BoxDefaults,
): ForkSample | null {
  const { times } = track;
  const n = times.length;
  if (n === 0) return null;

  const first = times[0];
  const last = times[n - 1];
  const pad = track.singleton ? FORK_SINGLETON_HOLD_MS / 2 : 0;
  if (now < first - pad || now > last + pad) return null;

  let lo: number;
  let hi: number;
  let frac: number;
  if (n === 1) {
    lo = hi = 0;
    frac = 0;
  } else {
    const c = now < first ? first : now > last ? last : now;
    lo = 0;
    hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= c) lo = mid;
      else hi = mid;
    }
    const denom = times[hi] - times[lo];
    frac = denom > 0 ? (c - times[lo]) / denom : 0;
  }

  const length = forkLerpDim(
    track.length[lo],
    track.length[hi],
    frac,
    defaults.length,
  );
  const width = forkLerpDim(
    track.width[lo],
    track.width[hi],
    frac,
    defaults.width,
  );
  const height = forkLerpDim(
    track.height[lo],
    track.height[hi],
    frac,
    defaults.height,
  );
  const speedLo = track.speed[lo];
  const speedHi = track.speed[hi];
  const speed =
    Number.isFinite(speedLo) || Number.isFinite(speedHi)
      ? forkLerpDim(speedLo, speedHi, frac, 0)
      : NaN;

  let alpha = 1;
  if (defaults.fadeIn > 0) {
    const age = now - first;
    if (age < defaults.fadeIn)
      alpha *= Math.max(0, Math.min(1, age / defaults.fadeIn));
  }
  if (defaults.fadeOut > 0) {
    const remaining = last - now;
    if (remaining < defaults.fadeOut)
      alpha *= Math.max(0, Math.min(1, remaining / defaults.fadeOut));
  }

  return {
    lon: forkLerp(track.lon[lo], track.lon[hi], frac),
    lat: forkLerp(track.lat[lo], track.lat[hi], frac),
    alt: forkLerp(track.alt[lo], track.alt[hi], frac),
    heading: forkLerpAngle(track.heading[lo], track.heading[hi], frac),
    length,
    width,
    height,
    speed,
    alpha,
    track,
  };
}

/* ── Differential fixtures ──────────────────────────────────────────────── */

/** Deterministic PRNG — a differential that cannot be replayed is not a gate. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A pooled track as `buildTrackIndex` would emit it: strictly ascending times,
 * NaN-riddled optional columns (an absent column is NaN per keyframe, and the
 * fade/dimension fallbacks only fire on NaN, so NaN density IS the interesting
 * axis), headings straddling the ±π seam, and 1-keyframe singletons.
 */
function randomTrack(rnd: () => number): Track {
  const n = 1 + Math.floor(rnd() * 6);
  const times: number[] = [];
  let t = Math.floor(rnd() * 10_000);
  for (let i = 0; i < n; i++) {
    times.push(t);
    t += 1 + Math.floor(rnd() * 3000);
  }
  const col = (nanChance: number, gen: () => number): number[] =>
    times.map(() => (rnd() < nanChance ? NaN : gen()));
  return {
    trackId: 'T',
    times,
    lon: col(0, () => -180 + rnd() * 360),
    lat: col(0, () => -85 + rnd() * 170),
    alt: col(0, () => rnd() * 100),
    // Headings deliberately span more than one turn so the shortest-arc wrap
    // and its `%` normalization are exercised, not just the [-π, π] window.
    heading: col(0.35, () => -8 + rnd() * 16),
    length: col(0.4, () => 1 + rnd() * 10),
    width: col(0.4, () => 1 + rnd() * 5),
    height: col(0.4, () => 1 + rnd() * 4),
    speed: col(0.5, () => rnd() * 30),
    color: [1, 2, 3, 4],
    label: 'l',
    category: 'car',
    singleton: n < 2,
  };
}

const SAMPLE_FIELDS = [
  'lon',
  'lat',
  'alt',
  'heading',
  'length',
  'width',
  'height',
  'speed',
  'alpha',
] as const;

describe('de-fork differential — sampling', () => {
  it('agrees with the pre-shim fork on every field over 2000 random draws', () => {
    const rnd = mulberry32(0x50f7);
    let nonNull = 0;
    for (let draw = 0; draw < 2000; draw++) {
      const track = randomTrack(rnd);
      const n = track.times.length;
      const first = track.times[0];
      const last = track.times[n - 1];
      const pad = track.singleton ? FORK_SINGLETON_HOLD_MS / 2 : 0;
      // The cull boundaries themselves, not just the interior: `now === last + pad`
      // must still sample and `+1` must not.
      const nows = [
        first - pad - 1,
        first - pad,
        first,
        first + (last - first) * rnd(),
        last,
        last + pad,
        last + pad + 1,
        first - 5000 + rnd() * (last - first + 10_000),
      ];
      const defaults: BoxDefaults = {
        length: 1 + rnd() * 9,
        width: 1 + rnd() * 4,
        height: 1 + rnd() * 3,
        fadeIn: rnd() < 0.5 ? 0 : Math.floor(rnd() * 900),
        fadeOut: rnd() < 0.5 ? 0 : Math.floor(rnd() * 900),
      };
      for (const now of nows) {
        const want = forkSampleTrack(track, now, defaults);
        const got = sampleTrack(track, now, defaults);
        if (want === null || got === null) {
          expect(
            [want, got].map((s) => s === null),
            `null-ness at now=${now}, times=${track.times}`,
          ).toEqual([true, true]);
          continue;
        }
        nonNull++;
        for (const f of SAMPLE_FIELDS) {
          expect(
            Object.is(got[f], want[f]),
            `${f}: ${got[f]} !== ${want[f]} at now=${now}, times=${track.times}`,
          ).toBe(true);
        }
        // Identity, not a copy — the layer reads `s.track.color` off this.
        expect(got.track).toBe(track);
        // Key set AND key order: a `Sample` is enumerated by pick rows and by
        // snapshot assertions elsewhere, so an extra own property is a change.
        expect(Object.keys(got)).toEqual(Object.keys(want));
      }
    }
    // A suite of mutual nulls would satisfy every assertion above.
    expect(nonNull).toBeGreaterThan(4000);
  });
});

/* ── Pooling differential ───────────────────────────────────────────────── */

/** A randomized objects tile: optional columns, NULL track ids, 2D/3D positions. */
function randomTile(rnd: () => number, seq: number): Tile {
  const count = Math.floor(rnd() * 9); // 0..8, including the empty-layer skip
  const dims = rnd() < 0.3 ? 3 : 2;
  const positions = new Float64Array(count * dims);
  for (let i = 0; i < count * dims; i++) positions[i] = rnd() * 100 - 50;
  // Times drawn from a SMALL integer pool so exact duplicates occur both inside
  // one tile and across tiles — the only way the two de-dup strategies can be
  // told apart. Payloads at equal times differ (positions are random), so
  // keeping a different member of a run is detectable.
  const starts = new Float32Array(count);
  for (let i = 0; i < count; i++) starts[i] = Math.floor(rnd() * 6) * 500;
  const timeOffset = Math.floor(rnd() * 3) * 1000;

  const trackCats = ['A', 'B', 'C'];
  const indices = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    indices[i] = rnd() < 0.15 ? 0xffff : Math.floor(rnd() * trackCats.length);
  }
  const hasTrackCol = rnd() < 0.85;
  const catCats = ['car', 'truck', ''];
  const catIndices = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    catIndices[i] = rnd() < 0.1 ? 0xffff : Math.floor(rnd() * catCats.length);
  }

  const numeric = (name: string, chance: number) =>
    rnd() < chance
      ? {
          [name]: Float32Array.from({ length: count }, () =>
            rnd() < 0.2 ? NaN : rnd() * 20,
          ),
        }
      : {};

  const features: BinaryFeatures = {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: dims,
    positions,
    featureIds: new Uint32Array(count),
    startTimes: starts,
    endTimes: starts,
    timeOffset,
    numericProps: {
      ...numeric('heading', 0.8),
      ...numeric('length', 0.6),
      ...numeric('width', 0.6),
      ...numeric('height', 0.6),
      ...numeric('speed', 0.5),
    },
    categoricalProps: {
      ...(hasTrackCol ? { track_id: { indices, categories: trackCats } } : {}),
      ...(rnd() < 0.8
        ? { category: { indices: catIndices, categories: catCats } }
        : {}),
    },
    vectorProps: {},
  };
  return {
    id: { z: 18, x: seq, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 3000 },
    layers: [
      {
        name: 'objects',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

const TRACK_ARRAYS = [
  'times',
  'lon',
  'lat',
  'alt',
  'heading',
  'length',
  'width',
  'height',
  'speed',
] as const;

function expectTrackIndexEqual(
  got: Map<string, Track>,
  want: Map<string, Track>,
  where: string,
): void {
  expect([...got.keys()], `${where}: track keys`).toEqual([...want.keys()]);
  for (const [key, w] of want) {
    const g = got.get(key)!;
    for (const arr of TRACK_ARRAYS) {
      expect(g[arr].length, `${where}: ${key}.${arr} length`).toBe(
        w[arr].length,
      );
      for (let i = 0; i < w[arr].length; i++) {
        // Object.is, not toEqual: an absent column is NaN per keyframe and the
        // whole point is that the SAME keyframe survived de-dup.
        expect(
          Object.is(g[arr][i], w[arr][i]),
          `${where}: ${key}.${arr}[${i}] ${g[arr][i]} !== ${w[arr][i]}`,
        ).toBe(true);
      }
    }
    expect(g.color, `${where}: ${key}.color`).toEqual(w.color);
    expect(g.label, `${where}: ${key}.label`).toBe(w.label);
    expect(g.category, `${where}: ${key}.category`).toBe(w.category);
    expect(g.trackId, `${where}: ${key}.trackId`).toBe(w.trackId);
    expect(g.singleton, `${where}: ${key}.singleton`).toBe(w.singleton);
  }
}

describe('de-fork differential — pooling', () => {
  it('agrees with the pre-shim fork on 400 random tile sets', () => {
    const rnd = mulberry32(0x1dea);
    let deduped = 0;
    let totalKeyframes = 0;
    for (let draw = 0; draw < 400; draw++) {
      const tiles = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) =>
        randomTile(rnd, i),
      );
      // The fork mutates the track objects it builds, so each side gets its own
      // build over the SAME (immutable) tiles.
      const want = forkBuildTrackIndex(tiles, OPTS);
      const got = buildTrackIndex(tiles, OPTS);
      expectTrackIndexEqual(got, want, `draw ${draw}`);

      let pooled = 0;
      for (const tile of tiles) pooled += tile.layers[0].features.featureCount;
      let kept = 0;
      for (const track of want.values()) kept += track.times.length;
      totalKeyframes += kept;
      if (kept < pooled) deduped++;
    }
    // The de-dup path has to actually run, or this differential is vacuous.
    expect(deduped).toBeGreaterThan(50);
    expect(totalKeyframes).toBeGreaterThan(1000);
  });

  it('agrees on EMPTY column names, which the kernel would otherwise default', () => {
    // The one place the kernel and the fork genuinely disagreed: the kernel
    // reads `cfg.trackIdProperty || 'track_id'` (and likewise for label /
    // heading / length / width / height / speed), so '' silently picks up the
    // conventional column; the fork found no column at all. The shim routes ''
    // to a guaranteed-absent name to preserve that. Unreachable from
    // `STTBoundingBoxLayer` (every option defaults to a non-empty name) but
    // reachable by any external caller of the published `buildTrackIndex`.
    const variants: Record<string, BoxTrackOptions> = {
      'empty trackId': { ...OPTS, trackIdProperty: '' },
      'empty label': { ...OPTS, labelProperty: '' },
      'empty color': { ...OPTS, colorProperty: '' },
      'empty dims': {
        ...OPTS,
        headingProperty: '',
        lengthProperty: '',
        widthProperty: '',
        heightProperty: '',
        speedProperty: '',
      },
      'all empty': {
        ...OPTS,
        trackIdProperty: '',
        colorProperty: '',
        labelProperty: '',
        headingProperty: '',
        lengthProperty: '',
        widthProperty: '',
        heightProperty: '',
        speedProperty: '',
      },
    };
    const rnd = mulberry32(0xc0de);
    for (const [name, opts] of Object.entries(variants)) {
      for (let draw = 0; draw < 20; draw++) {
        const tiles = Array.from(
          { length: 1 + Math.floor(rnd() * 3) },
          (_, i) => randomTile(rnd, i),
        );
        expectTrackIndexEqual(
          buildTrackIndex(tiles, opts),
          forkBuildTrackIndex(tiles, opts),
          `${name} draw ${draw}`,
        );
      }
    }
  });

  it('keeps the FIRST snapshot of an equal-time run, in tile-array order', () => {
    // Two tiles carry a keyframe for A at the same absolute time (1500) with
    // different positions. Sort stability decides which survives de-dup; both
    // implementations must pick the one pooled first (tile order).
    const t1 = objectTile(
      ['A', 'A'],
      [500, 0],
      { lon: [-71, -70], lat: [42, 43] },
      1500,
    );
    const t2 = objectTile(['A'], [500], { lon: [-69], lat: [44] }, 1000);
    const want = forkBuildTrackIndex([t1, t2], OPTS);
    const got = buildTrackIndex([t1, t2], OPTS);
    expectTrackIndexEqual(got, want, 'equal-time run');
    const a = got.get('A')!;
    expect(a.times).toEqual([1500, 2000]);
    expect(a.lon).toEqual([-70, -71]); // 1500 from t1[1]; the t2 duplicate dropped
  });
});

/* ── The de-forked constant, and where it lands ─────────────────────────── */

describe('SINGLETON_HOLD_MS', () => {
  it('is still three-local 400, NOT the kernel default of 600', () => {
    expect(SINGLETON_HOLD_MS).toBe(400);
    // The drift this file exists to guard. Aligning the two is a deliberate
    // behaviour change on a published export (a lone AV box would linger 50%
    // longer) and needs its own commit + browser check — not a silent de-fork.
    expect(coreKernel.SINGLETON_HOLD_MS).toBe(600);
    expect(SINGLETON_HOLD_MS).not.toBe(coreKernel.SINGLETON_HOLD_MS);
  });

  it('reaches the sampler: a singleton is held for exactly ±200 ms', () => {
    const tile = objectTile(['A'], [0], { lon: [-71], lat: [42] }, 1000);
    const track = buildTrackIndex([tile], OPTS).get('A')!;
    expect(track.singleton).toBe(true);
    expect(sampleTrack(track, 1000 - 200, DEF)).not.toBeNull();
    expect(sampleTrack(track, 1000 - 201, DEF)).toBeNull();
    expect(sampleTrack(track, 1000 + 200, DEF)).not.toBeNull();
    expect(sampleTrack(track, 1000 + 201, DEF)).toBeNull();
    // 600/2 = 300 would still be inside the kernel default's window.
    expect(sampleTrack(track, 1000 + 250, DEF)).toBeNull();
  });
});

describe('package-root exports', () => {
  it('re-export the shim (and therefore core), not a second implementation', () => {
    expect(threePackage.SINGLETON_HOLD_MS).toBe(SINGLETON_HOLD_MS);
    expect(threePackage.buildTrackIndex).toBe(buildTrackIndex);
    expect(threePackage.sampleTrack).toBe(sampleTrack);
    expect(threePackage.sampleTracks).toBe(sampleTracks);
    // The pure math functions are core's, by identity — no copy left to drift.
    expect(threePackage.lerp).toBe(coreKernel.lerp);
    expect(threePackage.lerpAngle).toBe(coreKernel.lerpAngle);
    expect(threePackage.lerpDim).toBe(coreKernel.lerpDim);
    expect(lerp).toBe(coreKernel.lerp);
  });

  it('pools into the same index the core kernel builds', () => {
    const tiles = [
      objectTile(
        ['A', 'B'],
        [0, 500],
        { lon: [-71, -70], lat: [42, 43] },
        1000,
      ),
      objectTile(['A'], [500], { lon: [-69], lat: [44] }, 1000),
    ];
    const core = coreKernel.buildTrackIndex(tiles, {
      ...OPTS,
      colorMapping: OPTS.colorMapping,
      colorMappingDefault: OPTS.colorMappingDefault,
    });
    expectTrackIndexEqual(buildTrackIndex(tiles, OPTS), core.tracks, 'core');
  });
});

describe('writeBoxEdges', () => {
  it('writes 12 edges (24 verts) with axis-aligned corners at heading 0', () => {
    const out = new Float32Array(FLOATS_PER_BOX);
    const next = writeBoxEdges(out, 0, 0, 0, 0, 0, 4, 2, 1.6);
    expect(next).toBe(FLOATS_PER_BOX);
    expect(BOX_EDGES.length).toBe(12);
    // every x is ±2 (length/2), y is ±1 (width/2), z in {0,1.6}
    for (let i = 0; i < out.length; i += 3) {
      expect(Math.abs(out[i])).toBeCloseTo(2, 6);
      expect(Math.abs(out[i + 1])).toBeCloseTo(1, 6);
      expect(out[i + 2] === 0 || Math.abs(out[i + 2] - 1.6) < 1e-6).toBe(true);
    }
  });

  it('rotates the length axis toward +Y(north) at heading π/2', () => {
    const out = new Float32Array(FLOATS_PER_BOX);
    writeBoxEdges(out, 0, 0, 0, 0, Math.PI / 2, 4, 2, 1.6);
    // After 90° yaw, the ±length/2 footprint maps to ±2 along Y, ±1 along X.
    for (let i = 0; i < out.length; i += 3) {
      expect(Math.abs(out[i])).toBeCloseTo(1, 5); // x = ±width/2
      expect(Math.abs(out[i + 1])).toBeCloseTo(2, 5); // y = ±length/2
    }
  });

  it('offsets by the box centre', () => {
    const out = new Float32Array(FLOATS_PER_BOX);
    writeBoxEdges(out, 0, 100, 50, 5, 0, 4, 2, 1.6);
    // first vertex corner (-2,-1,0) + centre
    expect(out[0]).toBeCloseTo(98, 5);
    expect(out[1]).toBeCloseTo(49, 5);
    expect(out[2]).toBeCloseTo(5, 5);
  });
});
