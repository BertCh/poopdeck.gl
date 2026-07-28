/**
 * Neural-State Atlas — the framing contract, as types.
 *
 * `docs/roadmap/neural-atlas-2026-07.md` §3 says the four-way distinction between
 * what a colour on this map can MEAN is "a typed enum, not a disclaimer", and
 * that the legend renders FROM that union. This module is that enum. Everything
 * downstream — the ramp, the legend, the units line, the panel copy — is derived
 * from {@link ATLAS_METRICS}, so it is structurally impossible to draw an
 * attribution surface under an "activation" legend, which is the failure mode
 * this genre actually exhibits.
 *
 * The same applies to {@link INTERPRETATION_STATUS}: a label's status is a
 * RENDERING input, not a tooltip. A `tentative` label never draws in the same
 * weight as a `validated` one and a `contested` one draws its dissent, because
 * confidence that lives only in a tooltip is confidence nobody reads.
 */

/** A quantity this map is able to show — §3's four-way distinction. */
export type AtlasMetricId =
  | 'activation'
  | 'attribution'
  | 'intervention'
  | 'interpretation';

export interface AtlasMetric {
  id: AtlasMetricId;
  label: string;
  /** One line, in the user's language, of what the colour means. */
  meaning: string;
  /**
   * The numeric column in the trace archive this metric reads, or `null` when
   * the metric is not available under this build's pin.
   */
  column: string | null;
  /** Units, spelled out. A number without its units is dropped, not restated. */
  units: string;
  /** Low→high ramp stops, RGBA 0–255. */
  ramp: [number, number, number, number][];
  /** Signed metrics get a diverging ramp centred on zero. */
  diverging: boolean;
  /**
   * When set, the metric is NOT selectable and this is the reason — shown in the
   * UI rather than hidden, because "we can't show you this and here is why" is
   * the honest state and quietly omitting it is not.
   */
  unavailable?: string;
}

/**
 * Sequential ramp for a non-negative magnitude (dark → hot).
 *
 * Tuned for a near-black background, which means the bottom of the ramp has to
 * do MORE work than the top: a weak activation should disappear rather than
 * settle into a muddy blue haze that competes with the anatomy dust. So alpha
 * stays near zero through the first third, and the top lands on near-white
 * rather than on a mid-value gold — against #05070d, white is the only colour
 * with real headroom left.
 */
const ACTIVATION_RAMP: [number, number, number, number][] = [
  [10, 14, 34, 0],
  [40, 70, 165, 55],
  [70, 165, 240, 165],
  [175, 240, 245, 230],
  [255, 253, 235, 255],
];

/**
 * Diverging ramp for a SIGNED contribution (against ← 0 → toward).
 *
 * Same reasoning, applied to the middle: a near-zero attribution is the
 * majority of events (p50 is 3e-5) and it should vanish, not grey the map out.
 * The ends are pushed hot so sign reads at a glance.
 */
const ATTRIBUTION_RAMP: [number, number, number, number][] = [
  [90, 165, 255, 255],
  [70, 120, 225, 120],
  [90, 95, 115, 12],
  [255, 140, 90, 130],
  [255, 105, 60, 255],
];

export const ATLAS_METRICS: Record<AtlasMetricId, AtlasMetric> = {
  activation: {
    id: 'activation',
    label: 'Activation',
    meaning: 'The feature is on at this token.',
    column: 'activation',
    units: 'SAE latent activation, post-ReLU (dimensionless)',
    ramp: ACTIVATION_RAMP,
    diverging: false,
  },
  attribution: {
    id: 'attribution',
    label: 'Attribution',
    meaning:
      'The feature is associated with the selected output — gradient × activation, not causation.',
    column: 'attribution',
    units: 'd(target logit)/d(latent) × activation, in logits',
    ramp: ATTRIBUTION_RAMP,
    diverging: true,
  },
  intervention: {
    id: 'intervention',
    label: 'Intervention',
    meaning: 'Changing the feature changes the result.',
    column: null,
    units: 'Δ logit under ablation',
    ramp: ATTRIBUTION_RAMP,
    diverging: true,
    unavailable:
      'Not built. The literature reports simple linear-probe baselines outperforming SAEs at steering (AxBench, ICML 2025), so live "edit a feature and watch the model change" is counted out for this atlas — offline ablations on a curated few would be a separate metric, with its own column.',
  },
  interpretation: {
    id: 'interpretation',
    label: 'Interpretation',
    meaning: 'A generated label is consistent with held-out examples.',
    column: null,
    units: 'explanation agreement, mean pairwise cosine',
    ramp: ACTIVATION_RAMP,
    diverging: false,
    unavailable:
      'Not a per-token quantity. It is carried per NODE instead — see the label confidence and status on any selected feature, and the status filter below.',
  },
};

export const SELECTABLE_METRICS: AtlasMetricId[] = (
  Object.keys(ATLAS_METRICS) as AtlasMetricId[]
).filter((id) => !ATLAS_METRICS[id].unavailable);

// ---------------------------------------------------------------------------
// Interpretation status (§3) — a rendering input
// ---------------------------------------------------------------------------

export type InterpretationStatus =
  | 'unlabeled'
  | 'tentative'
  | 'reviewed'
  | 'contested'
  | 'validated';

export interface StatusStyle {
  label: string;
  /** Hex, for the legend swatch and the panel chip. */
  color: string;
  /** Multiplier on a label's drawn weight — this is what "gates rendering" means. */
  weight: number;
  blurb: string;
}

export const INTERPRETATION_STATUS: Record<InterpretationStatus, StatusStyle> =
  {
    validated: {
      label: 'Validated',
      color: '#7ce8b0',
      weight: 1,
      blurb: 'Label checked against held-out examples.',
    },
    reviewed: {
      label: 'Reviewed',
      color: '#8fd0ff',
      weight: 0.9,
      blurb:
        'Two or more independent explainer models agree (embedding cosine ≥ 0.70).',
    },
    tentative: {
      label: 'Tentative',
      color: '#e0c070',
      weight: 0.55,
      blurb: 'A single explanation, or weak agreement between explanations.',
    },
    contested: {
      label: 'Contested',
      color: '#ff8f6b',
      weight: 0.7,
      blurb:
        'Explanations disagree (cosine < 0.40). The dissenting label is shown alongside.',
    },
    unlabeled: {
      label: 'Unlabeled',
      color: '#6a7080',
      weight: 0.25,
      blurb: 'No published explanation for this latent.',
    },
  };

export const STATUS_ORDER: InterpretationStatus[] = [
  'validated',
  'reviewed',
  'tentative',
  'contested',
  'unlabeled',
];

export function statusStyle(value: string | undefined | null): StatusStyle {
  return (
    INTERPRETATION_STATUS[(value ?? 'unlabeled') as InterpretationStatus] ??
    INTERPRETATION_STATUS.unlabeled
  );
}

// ---------------------------------------------------------------------------
// Depth ramp — transformer layer as colour (and as altitude)
// ---------------------------------------------------------------------------

/**
 * `layer_band` → colour. The generator writes the band as a zero-padded STRING
 * (`L00`…`L11`) precisely so stt-build keeps the column categorical; an
 * all-numeric-string column is promoted to Numeric and silently no-ops a
 * categorical colour map.
 *
 * These are the CONTEXT colours — 294,912 latents that exist to give the trace
 * somewhere to happen. They are deliberately desaturated and pulled toward the
 * background: at full strength a quarter-million points at any saturation read
 * as a bright fog and the thing that is actually moving cannot win against it.
 * Hue still separates depth for anyone who looks, and the legible reading of
 * depth is the layer × token chart, not this.
 */
const LAYER_DIM = 0.42;
/** Background the dust is mixed toward, matching the page's radial gradient. */
const BACKDROP: [number, number, number] = [10, 13, 24];

export const LAYER_COLORS: Record<string, [number, number, number, number]> =
  Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => {
      const t = i / 11;
      // Deep indigo (early layers) → teal → warm sand (late layers).
      const stops: [number, number, number][] = [
        [58, 60, 150],
        [42, 130, 175],
        [70, 190, 165],
        [225, 200, 130],
      ];
      const f = t * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(f));
      const g = f - k;
      const c = stops[k].map((v, j) =>
        Math.round(v + (stops[k + 1][j] - v) * g),
      ) as [number, number, number];
      const muted = c.map((v, j) =>
        Math.round(BACKDROP[j] + (v - BACKDROP[j]) * LAYER_DIM),
      ) as [number, number, number];
      return [`L${String(i).padStart(2, '0')}`, [...muted, 235]];
    }),
  ) as Record<string, [number, number, number, number]>;

/** Selection emphasis: the one colour reserved for "you picked this". */
export const SELECTION_COLOR: [number, number, number] = [255, 255, 255];
export const SELECTION_HALO: [number, number, number] = [130, 205, 255];

// ---------------------------------------------------------------------------
// The generator sidecar
// ---------------------------------------------------------------------------

/** A u8/log1p-companded array carried inline in the sidecar. */
export interface AtlasQuantized {
  rows?: number;
  cols?: number;
  encoding: string;
  scale: number;
  data: string;
}

/** Where to find, and how to read, the node-indexed activation CSR blob. */
export interface AtlasNodeSeriesSpec {
  index_url: string;
  series_url: string;
  record_bytes: number;
  layout: string;
  activation_scale: number;
  attribution_scale: number;
  events: number;
  nodes: number;
}

export interface AtlasSeriesSpec {
  /** Mean activation per (transformer layer, token) — depth as a chart. */
  layer_token?: AtlasQuantized;
  /** Total activation per token, for the transport scrubber. */
  activity?: AtlasQuantized;
  node_series?: AtlasNodeSeriesSpec;
}

/** Per-metric distribution, so a legend never has to guess its own domain. */
export interface AtlasMetricDomains {
  activation?: { p50: number; p99: number; max: number };
  attribution?: {
    abs_p99: number;
    abs_p995: number;
    max_abs: number;
    negative_fraction: number;
  };
}

export interface AtlasSidecar {
  pin: {
    model: string;
    model_license: string;
    sae_repo: string;
    sae_license: string;
    labels: string;
    corpus: { repo: string; config: string; license: string; url: string };
    layers: number[];
    d_sae: number;
    nodes: number;
  };
  frame: {
    atlas_half_deg: number;
    origin: [number, number];
    epoch_ms: number;
    ms_per_token: number;
    /** Numeric column carrying the third embedding component, in metres. */
    elevation_column: string;
    elevation_extent_m: [number, number];
    lod_budget: number[];
    zoom_bands: { feature: number; max: number; trace_max: number };
  };
  metric_domains?: AtlasMetricDomains;
  trace: {
    slug: string;
    tokens: string[];
    targets: {
      window: number;
      target_token_id: number;
      target_token: string;
      at_token_index: number;
    }[];
    events: number;
  };
  series?: AtlasSeriesSpec;
  /** Named density peaks — the atlas has these instead of cluster hulls. */
  places?: import('./atlasPlaces').AtlasPlace[];
  validation: Record<string, any>;
  attribution_method: string;
  generated_utc: string;
  git_commit: string;
}

/** Token index → playhead ms, and back. One token is one second by construction. */
export function tokenToMs(sidecar: AtlasSidecar, tokenIndex: number): number {
  return sidecar.frame.epoch_ms + tokenIndex * sidecar.frame.ms_per_token;
}

export function msToToken(sidecar: AtlasSidecar, ms: number): number {
  return Math.max(
    0,
    Math.round((ms - sidecar.frame.epoch_ms) / sidecar.frame.ms_per_token),
  );
}

/**
 * The three sentences §3 requires on the methodology surface, because §2 says
 * they are true and a map is a persuasive object. They are code, not prose in a
 * doc, so the page cannot ship without them.
 */
export const REQUIRED_CAVEATS: { title: string; body: string }[] = [
  {
    title: 'Distance here is a projection artefact',
    body: 'Spatial distance on this map is a property of the layout, not a metric on the model. The measured distortion — trustworthiness, continuity and kNN overlap, with the k they were computed at — is published in the panel below.',
  },
  {
    title:
      'The continents are a property of the partition, not only of the model',
    body: 'The literature says individual sparse-autoencoder latents move between training seeds while the subspaces they span stay put (arXiv:2606.12138), which would make the continents the durable thing. This build measured a weaker, adjacent question — resample the CLUSTERING over a fixed dictionary — and the answer is uncomfortable: about half the latents change region and region centroids move most of the map. Local neighbourhood structure is deterministic (it comes from the decoder-direction graph); which continent a latent sits on is not. Read this map as "these things are near each other", never as "this is the grammar continent". The numbers are published below.',
  },
  {
    title: 'Fragmentation on this map is not fragmentation in the model',
    body: 'A concept that is continuous inside the model can appear here as scattered fragments, because the discrete feature basis shatters manifolds (arXiv:2509.02565; Goodfire; Anthropic lists it as a method limitation). The concept loci layer draws this directly.',
  },
];

/** Never permitted in copy on this surface. Kept as a list so it stays checkable. */
export const FORBIDDEN_FRAMINGS = [
  'map of thoughts',
  'reasoning',
  'consciousness',
  'model parameters',
];
