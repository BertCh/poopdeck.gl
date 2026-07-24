/**
 * The `worlds.json` contract — the scenario index for the World Model Scenario
 * Explorer (`/worlds`), written by `scripts/data-generation/cosmos_drive_dreams.py`.
 *
 * One file describes the whole gallery: the synthetic grid the scenarios are
 * laid out on, the shared looping clock every clip was rebased onto, and one
 * record per scenario (its cell origin, caption, agent counts, the generated
 * weather-variant videos, and — for the LiDAR "heroes" — its point-cloud
 * manifest). Asset paths inside are BUNDLE-RELATIVE and resolved against the
 * sidecar's own directory via {@link resolveWorldAsset}, so the bundle can move
 * between `public/data` and R2 without rewriting anything but the sidecar url.
 */

/** One scenario: a 10-second driving clip occupying one cell of the grid. */
export interface WorldScenario {
  /** Stable short id (`c-xxxxxxxx`), also the `scenario_id` baked into tiles. */
  id: string;
  /** Full source clip stem (`{uuid}_{start}_{end}`) — provenance, shown in the panel. */
  clip: string;
  /** Which 121-frame chunk of the source clip this world covers (0 or 1). */
  chunk: number;
  row: number;
  col: number;
  /** The cell's anchor (the clip's local frame is centred here). */
  origin: { lon: number; lat: number };
  hero: boolean;
  timeRange: { start: number; end: number };
  agentCount: number;
  hasPed: boolean;
  /** A truck, bus, trailer or construction vehicle is present. */
  hasLarge: boolean;
  /** The world's Cosmos manifestation, e.g. `"Rainy"` (`""` = none). */
  weather: string;
  /** Index of {@link weather} in {@link WorldsIndex.weathers}; -1 = none. */
  weatherId: number;
  /** Agent counts by canonical category (`car`, `pedestrian`, …). */
  counts: Record<string, number>;
  caption: string;
  /** `{chunkId: {weather: relativeMp4Path}}` — only the variants that exist. */
  videos: Record<string, Record<string, string>>;
  /** Heroes only: bundle-relative LiDAR manifest path. */
  lidar?: string;
}

export interface WorldsIndex {
  id: string;
  dataset: string;
  datasetUrl: string;
  license: string;
  attribution: string;
  /** Shared epoch every clip was rebased onto. */
  t0: number;
  /**
   * Loop length (ms) = the generated window (121 source frames). Every world's
   * geometry was built for exactly the frames its video covers, so position in
   * the loop maps 1:1 onto position in any world's video.
   */
  durationMs: number;
  /** Same span, named for the source chunking that defines it. */
  chunkMs: number;
  videoFrames: number;
  grid: {
    rows: number;
    cols: number;
    pitchM: number;
    lat: number;
    lon: number;
  };
  weathers: string[];
  scenarios: WorldScenario[];
}

/** Bundle root = the sidecar url minus its filename. */
export function worldsBaseUrl(worldsUrl: string): string {
  return worldsUrl.replace(/\/[^/]*$/, '');
}

/** Resolve a bundle-relative asset path (video, hero manifest) to a fetchable url. */
export function resolveWorldAsset(base: string, relative: string): string {
  return `${base}/${relative.replace(/^\//, '')}`;
}

/** A scenario's video variants flattened to `{chunk, weather, url}` triples. */
export interface WorldVideoVariant {
  chunk: string;
  weather: string;
  path: string;
}

export function videoVariants(scenario: WorldScenario): WorldVideoVariant[] {
  const out: WorldVideoVariant[] = [];
  for (const chunk of Object.keys(scenario.videos).sort()) {
    for (const weather of Object.keys(scenario.videos[chunk]).sort()) {
      out.push({ chunk, weather, path: scenario.videos[chunk][weather] });
    }
  }
  return out;
}

/** Stable key for a variant (used as the URL param + carousel selection). */
export function variantKey(v: WorldVideoVariant): string {
  return `${v.chunk}|${v.weather}`;
}

export function findScenario(
  index: WorldsIndex | null,
  id: string | undefined,
): WorldScenario | undefined {
  if (!index || !id) return undefined;
  return index.scenarios.find((s) => s.id === id);
}

/**
 * A filter chip: one numeric predicate the STT layers push down to the GPU via
 * the DataFilter extension.
 *
 * TWO constraints from the layer side shape this list, both verified in
 * `packages/layers`: the extension supports `filterSize: 1`, so exactly ONE
 * numeric column can be active at a time (chips are single-select, not
 * checkboxes); and it HIDES rather than dims (there is no "fade the
 * non-matching" mode), so the map/ego/box geometry of non-matching worlds
 * disappears while the anchor dots — a plain client-side layer — stay drawn at
 * low alpha to keep the grid legible.
 *
 * Every column here is baked onto every feature of all four archives by
 * `cosmos_drive_dreams.py` (see its `FILTER_COLS`).
 */
export interface WorldFilterChip {
  id: string;
  label: string;
  /** Numeric property baked on every feature. */
  filterProperty: string;
  filterRange: [number, number];
  /** Predicate mirrored on the client for the anchor-dot dimming. */
  match: (s: WorldScenario) => boolean;
}

const BIG = 1e6;

export const FILTER_CHIPS: WorldFilterChip[] = [
  {
    id: 'peds',
    label: 'With pedestrians',
    filterProperty: 'has_ped',
    filterRange: [1, 1],
    match: (s) => s.hasPed,
  },
  {
    id: 'dense',
    label: 'Dense traffic',
    filterProperty: 'agent_count',
    filterRange: [25, BIG],
    match: (s) => s.agentCount >= 25,
  },
  {
    id: 'quiet',
    label: 'Quiet streets',
    filterProperty: 'agent_count',
    filterRange: [0, 8],
    match: (s) => s.agentCount <= 8,
  },
  {
    id: 'large',
    label: 'Trucks & buses',
    filterProperty: 'has_large',
    filterRange: [1, 1],
    match: (s) => s.hasLarge,
  },
];

/** Weather chips are generated from the index (one per weather present). */
export function weatherChips(index: WorldsIndex): WorldFilterChip[] {
  const present = new Set(
    index.scenarios.map((s) => s.weather).filter((w) => w),
  );
  return index.weathers
    .filter((w) => present.has(w))
    .map((w) => {
      const id = index.weathers.indexOf(w);
      return {
        id: `wx-${w}`,
        label: w.replace(/_/g, ' '),
        filterProperty: 'weather_id',
        filterRange: [id, id] as [number, number],
        match: (s: WorldScenario) => s.weather === w,
      };
    });
}

/**
 * Per-weather accent color for the anchor dots + chips, so the overview reads
 * as a mosaic of generated conditions at a glance.
 */
export const WEATHER_COLORS: Record<string, [number, number, number]> = {
  Sunny: [255, 208, 92],
  Morning: [255, 173, 122],
  Golden_hour: [255, 146, 66],
  Night: [120, 140, 220],
  Rainy: [92, 190, 255],
  Snowy: [225, 240, 255],
  Foggy: [175, 185, 200],
};

export function weatherColor(weather: string): [number, number, number] {
  return WEATHER_COLORS[weather] ?? [160, 175, 195];
}

export function weatherCss(weather: string, alpha = 1): string {
  const [r, g, b] = weatherColor(weather);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
