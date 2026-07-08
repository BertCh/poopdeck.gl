/**
 * Loader + types for the build-time density-profile sidecars that feed the
 * demo-page "cube laid down in a line" utility (CubeInLine).
 *
 * Each `/density/<id>.json` is emitted by `crates/stt-core/examples/density-profile.rs`
 * from a real archive's directory: the native tier downsampled into a sparse
 * `(sx, sy, tb)` occupancy+bytes cube, plus the true archive's blob-ordering
 * anchors (`autoChoice`, per-ordering adjacency breaks). Regenerate with
 * `examples/showcase/scripts/build-density-profiles.sh`.
 */
import { hilbert2, type Cell, type Walk } from './spaceCurve';

/** `[sx, sy, tb, count, bytes]` — one occupied grid cell. */
export type CubeTuple = [number, number, number, number, number];

export interface DensityProfile {
  id: string;
  label: string;
  zoom: number;
  spaceBits: number; // space grid side = 2^spaceBits per axis
  timeBins: number;
  tileCount: number; // native tiles behind this profile
  totalBytes: number; // deduped on-disk footprint
  featureCount: number;
  bucketMs: number;
  timeRange: { start: number; end: number };
  bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  spaceExtent: { x0: number; y0: number; x1: number; y1: number };
  tbSpan: number; // native time-bucket span
  autoChoice: Walk; // what `--blob-ordering auto` picks (cardinality heuristic)
  nativeSeeks: Record<Walk, number>; // adjacency breaks over the *real* tiles
  cube: CubeTuple[];
}

/** The four "poles" whose ordering tradeoff flips, shown in the switcher. */
export interface ProfileMeta {
  id: string;
  label: string;
  pole: string;
}

export const PROFILE_META: ProfileMeta[] = [
  { id: 'drifters', label: 'Ocean drifters', pole: 'time-deep' },
  { id: 'nyc-rideshare', label: 'NYC rideshare', pole: 'balanced' },
  { id: 'gtfs-nl', label: 'GTFS transit', pole: 'wide network' },
  { id: 'flights', label: 'Global flights', pole: 'space-heavy' },
];

export const PROFILE_IDS = PROFILE_META.map((p) => p.id);

/**
 * The profile id backing a dataset is its archive directory — the segment after
 * `/data/` in the manifest url. Datasets that share an archive (e.g. the taxi
 * cube reuses nyc-rideshare) therefore share a profile, which is correct: the
 * density is a property of the archive. Returns null for non-local urls.
 */
export function profileIdFromUrl(url: string): string | null {
  const m = url.match(/\/data\/([^/]+)\//);
  return m ? m[1] : null;
}

const cache = new Map<string, Promise<DensityProfile>>();

/** Lazily fetch (and cache) one density profile. */
export function loadDensityProfile(id: string): Promise<DensityProfile> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}density/${id}.json`).then((r) => {
      if (!r.ok) throw new Error(`density profile "${id}": HTTP ${r.status}`);
      return r.json() as Promise<DensityProfile>;
    });
    cache.set(id, p);
  }
  return p;
}

/** Expand the sparse tuple cube into working cells with 2D-Hilbert rank cached. */
export function expandCube(profile: DensityProfile): Cell[] {
  const { spaceBits } = profile;
  return profile.cube.map(([sx, sy, tb, count, bytes]) => ({
    sx,
    sy,
    tb,
    count,
    bytes,
    h2: hilbert2(spaceBits, sx, sy),
  }));
}
