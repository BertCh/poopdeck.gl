/**
 * The Neural-State Atlas side panel: controls, the generated legend, the
 * inspection card, and the methodology.
 *
 * The legend is not authored here. It is derived from {@link ATLAS_METRICS} and
 * {@link INTERPRETATION_STATUS}, which is the whole point of §3 being a typed
 * enum — a metric cannot appear on the map without its meaning and its units
 * appearing under it, and a metric that is NOT available says so in place rather
 * than being quietly omitted from the picker.
 */
import React from 'react';
import {
  ATLAS_METRICS,
  INTERPRETATION_STATUS,
  REQUIRED_CAVEATS,
  STATUS_ORDER,
  type AtlasMetricId,
  type AtlasSidecar,
  type InterpretationStatus,
  statusStyle,
} from './atlasTypes';
import { CONCEPT_COLORS } from './buildAtlasLayers';

export interface AtlasSelection {
  label?: string;
  label_alt?: string;
  interpretation_status?: string;
  label_confidence?: number;
  /** Drives the lazily range-fetched activation series in {@link AtlasSeries}. */
  node_id?: number;
  layer?: number;
  feature_index?: number;
  region?: number;
  family?: number;
  firing_rate?: number;
  activation_max?: number;
  activation?: number;
  attribution?: number;
  token?: string;
  token_index?: number;
  member_count?: number;
  level?: string;
  concept?: string;
  structure?: string;
  families_spanned?: number;
}

export interface AtlasPanelProps {
  sidecar: AtlasSidecar;
  metric: AtlasMetricId;
  onMetric: (m: AtlasMetricId) => void;
  visibleStatuses: Set<InterpretationStatus>;
  onToggleStatus: (s: InterpretationStatus) => void;
  showAnatomy: boolean;
  showTrace: boolean;
  showDensity: boolean;
  showPlaces: boolean;
  showManifolds: boolean;
  onToggleLayer: (
    k: 'anatomy' | 'trace' | 'density' | 'places' | 'manifolds',
  ) => void;
  /** Vertical exaggeration of the embedding's third component; 0 = flat. */
  depth: number;
  onDepth: (next: number) => void;
  selection: AtlasSelection | null;
  neuronpediaHref: (layer: number, feature: number) => string;
}

const css = {
  panel: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    width: 372,
    maxWidth: '100%',
    height: '100%',
    overflowY: 'auto' as const,
    background: 'rgba(10,12,20,0.86)',
    backdropFilter: 'blur(10px)',
    borderLeft: '1px solid rgba(150,170,220,0.18)',
    color: '#e6ebf5',
    font: '13px/1.5 ui-sans-serif, system-ui, sans-serif',
    padding: '18px 18px 40px',
    boxSizing: 'border-box' as const,
  },
  h1: { font: '600 17px/1.25 inherit', margin: '0 0 4px' },
  sub: { color: '#98a4bd', margin: '0 0 16px', fontSize: 12 },
  h2: {
    font: '600 11px/1 inherit',
    letterSpacing: '0.09em',
    textTransform: 'uppercase' as const,
    color: '#8e9ab5',
    margin: '20px 0 8px',
  },
  card: {
    background: 'rgba(255,255,255,0.045)',
    border: '1px solid rgba(150,170,220,0.14)',
    borderRadius: 8,
    padding: 11,
  },
  row: { display: 'flex', justifyContent: 'space-between', gap: 10 },
  dim: { color: '#98a4bd' },
  mono: {
    font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#b8c2d8',
  },
  btn: (on: boolean) => ({
    appearance: 'none' as const,
    border: `1px solid ${on ? 'rgba(150,200,255,0.55)' : 'rgba(150,170,220,0.2)'}`,
    background: on ? 'rgba(90,150,240,0.22)' : 'transparent',
    color: on ? '#e9f1ff' : '#9aa6bf',
    borderRadius: 6,
    padding: '5px 9px',
    font: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  }),
};

function rampCss(ramp: [number, number, number, number][]): string {
  const stops = ramp.map(
    (c, i) =>
      `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)}) ${(
        (i / (ramp.length - 1)) *
        100
      ).toFixed(0)}%`,
  );
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function num(v: number | undefined, digits = 3): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

const AtlasPanel: React.FC<AtlasPanelProps> = ({
  sidecar,
  metric,
  onMetric,
  visibleStatuses,
  onToggleStatus,
  showAnatomy,
  showTrace,
  showDensity,
  showPlaces,
  showManifolds,
  onToggleLayer,
  depth,
  onDepth,
  selection,
  neuronpediaHref,
}) => {
  const spec = ATLAS_METRICS[metric];
  const v = sidecar.validation ?? {};
  const drift = v.atlas_drift_under_clustering_reseed;
  const dist = v.projection_distortion;
  const shatter = v.manifold_shattering_audit;
  // A trace pick carries a token index; an anatomy pick does not. The token
  // STRING is derived from the sidecar rather than repeated on 2.6 M events.
  const isTraceEvent = typeof selection?.token_index === 'number';
  const selectedToken =
    isTraceEvent && selection
      ? sidecar.trace.tokens[selection.token_index!]
      : undefined;

  return (
    <aside
      style={css.panel}
      aria-label="Neural-State Atlas controls and methodology"
    >
      <h1 style={css.h1}>Neural-State Atlas</h1>
      <p style={css.sub}>
        {sidecar.pin.nodes.toLocaleString()} sparse-autoencoder latents of{' '}
        {sidecar.pin.model}. X, Y and Z are one isotropic manifold embedding of
        the decoder directions — <em>not</em> axes of the model, and in
        particular Z is not the transformer layer. T is the token being read.
        This renders activations and estimated contributions. The model&rsquo;s
        weights are never in the picture.
      </p>

      {/* ── metric ─────────────────────────────────────────────────────── */}
      <h2 style={css.h2}>What the colour means</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(Object.keys(ATLAS_METRICS) as AtlasMetricId[]).map((id) => {
          const m = ATLAS_METRICS[id];
          const on = id === metric;
          return (
            <button
              key={id}
              type="button"
              style={{
                ...css.btn(on),
                opacity: m.unavailable ? 0.45 : 1,
                cursor: m.unavailable ? 'not-allowed' : 'pointer',
              }}
              disabled={!!m.unavailable}
              title={m.unavailable ?? m.meaning}
              onClick={() => onMetric(id)}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <div style={{ ...css.card, marginTop: 10 }}>
        <div style={{ marginBottom: 7 }}>{spec.meaning}</div>
        <div
          style={{
            height: 10,
            borderRadius: 5,
            background: rampCss(spec.ramp),
            border: '1px solid rgba(255,255,255,0.12)',
          }}
        />
        <div style={{ ...css.row, ...css.dim, fontSize: 11, marginTop: 5 }}>
          <span>{spec.diverging ? 'against the target' : 'off'}</span>
          <span>{spec.diverging ? 'toward the target' : 'strongly on'}</span>
        </div>
        <div style={{ ...css.mono, marginTop: 7 }}>{spec.units}</div>
      </div>
      {ATLAS_METRICS.intervention.unavailable && (
        <p style={{ ...css.dim, fontSize: 11.5, marginTop: 8 }}>
          <strong style={{ color: '#c3cde3' }}>Intervention</strong> and{' '}
          <strong style={{ color: '#c3cde3' }}>interpretation</strong> are
          listed and disabled on purpose — see their tooltips. The distinction
          between the four is the point; hiding the two we cannot show would
          flatter the two we can.
        </p>
      )}

      {/* ── layers ─────────────────────────────────────────────────────── */}
      <h2 style={css.h2}>Layers</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button
          type="button"
          style={css.btn(showAnatomy)}
          onClick={() => onToggleLayer('anatomy')}
        >
          Latents
        </button>
        <button
          type="button"
          style={css.btn(showTrace)}
          onClick={() => onToggleLayer('trace')}
        >
          Trace
        </button>
        <button
          type="button"
          style={css.btn(showPlaces)}
          title="Named density peaks. The map has these instead of cluster outlines — see below."
          onClick={() => onToggleLayer('places')}
        >
          Places
        </button>
        <button
          type="button"
          style={css.btn(showDensity)}
          title="Smooth per-pixel density over the same latents. A second tileset, so it is off by default."
          onClick={() => onToggleLayer('density')}
        >
          Density
        </button>
        <button
          type="button"
          style={css.btn(showManifolds)}
          onClick={() => onToggleLayer('manifolds')}
        >
          Concept loci
        </button>
      </div>
      <p style={{ ...css.dim, fontSize: 11.5, marginTop: 8 }}>
        <strong style={{ color: '#c3cde3' }}>
          There are no cluster outlines
        </strong>
        , and that is a result rather than an omission. This dictionary has no
        macro-cluster structure to outline: graph communities span ~3° of a 32°
        plane, a clumpier embedding made that worse, HDBSCAN on the embedding
        itself finds two clusters, and when hulls were drawn 87.8% of pairs
        overlapped. Random-pair decoder cosine is 0.0099 — the basis is close to
        isotropic, with real local neighbourhood structure and no continents. A
        border would imply a natural kind that is not there, so the map names
        its dense parts instead: each place is a density peak, labelled with the
        terms most over-represented among the published explanations nearest it.
      </p>

      <h2 style={css.h2}>Depth</h2>
      <div style={css.card}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={depth}
          onChange={(e) => onDepth(Number(e.target.value))}
          style={{ width: '100%' }}
          aria-label="Vertical exaggeration of the embedding's third component"
        />
        <div style={{ ...css.row, ...css.dim, fontSize: 11, marginTop: 4 }}>
          <span>flat</span>
          <span>{depth === 0 ? 'plan view' : `${depth.toFixed(2)}× true`}</span>
          <span>isotropic</span>
        </div>
        <p style={{ ...css.dim, fontSize: 11, margin: '8px 0 0' }}>
          The third embedding component, in the same units as X and Y. At 1.00
          the cloud has its true shape. This is a renderer prop over a numeric
          column, not a different archive — the first build baked transformer
          depth into the geometry at 150 km a layer and rendered as towers.
        </p>
      </div>
      {showManifolds && (
        <div style={{ ...css.card, marginTop: 10 }}>
          {Object.entries(CONCEPT_COLORS).map(([name, c]) => (
            <div
              key={name}
              style={{ ...css.row, alignItems: 'center', marginBottom: 3 }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <i
                  style={{
                    width: 14,
                    height: 3,
                    borderRadius: 2,
                    background: `rgb(${c[0]},${c[1]},${c[2]})`,
                  }}
                />
                {name}
              </span>
              <span style={{ ...css.dim, fontSize: 11 }}>
                {shatter?.probes?.[name]
                  ? `${shatter.probes[name].distinct_families} families`
                  : '—'}
              </span>
            </div>
          ))}
          <p style={{ ...css.dim, fontSize: 11, margin: '8px 0 0' }}>
            A line walks the latents that carry one known-continuous concept, in
            concept order. A tight locus means the basis represented it; a
            scribble across the continents means the basis shattered it.
          </p>
        </div>
      )}

      {/* ── interpretation status ──────────────────────────────────────── */}
      <h2 style={css.h2}>Interpretation status</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {STATUS_ORDER.map((s) => {
          const st = INTERPRETATION_STATUS[s];
          const on = visibleStatuses.has(s);
          return (
            <button
              key={s}
              type="button"
              title={st.blurb}
              style={{
                ...css.btn(on),
                borderColor: on ? st.color : 'rgba(150,170,220,0.2)',
                color: on ? st.color : '#9aa6bf',
              }}
              onClick={() => onToggleStatus(s)}
            >
              {st.label}
            </button>
          );
        })}
      </div>
      <p style={{ ...css.dim, fontSize: 11.5, marginTop: 8 }}>
        Status is measured, not asserted: Neuronpedia publishes several
        independent explanations per latent with their embeddings, and the
        status is the mean pairwise cosine between them. It styles the map — a
        tentative label never draws at the weight of a reviewed one.
      </p>

      {/* Reading position lives in the strip at the bottom of the map now, where
          it can be pinned, clicked and stepped. A 22-token read-only card in a
          scrolling aside could not be any of those things. */}

      {/* ── selection ──────────────────────────────────────────────────── */}
      <h2 style={css.h2}>Inspection</h2>
      {!selection && (
        <div style={{ ...css.card, ...css.dim }}>
          Click a latent, a continent or a concept locus.
        </div>
      )}
      {selection && (
        <div style={css.card}>
          {selection.concept ? (
            <>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {selection.concept} locus
              </div>
              <div style={css.row}>
                <span style={css.dim}>structure</span>
                <span>{selection.structure}</span>
              </div>
              <div style={css.row}>
                <span style={css.dim}>families spanned</span>
                <span>{selection.families_spanned}</span>
              </div>
            </>
          ) : selection.level ? (
            <>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {selection.level === 'region' ? 'Region' : 'Family'} —{' '}
                {selection.label || 'unlabeled'}
              </div>
              <div style={css.row}>
                <span style={css.dim}>members</span>
                <span>{selection.member_count?.toLocaleString()}</span>
              </div>
              <StatusChip value={selection.interpretation_status} />
              <p style={{ ...css.dim, fontSize: 11, margin: '8px 0 0' }}>
                A cluster&rsquo;s name is its most important labelled member,
                and it inherits that member&rsquo;s status. It is a stand-in for
                a cluster label, not one.
              </p>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {selection.label ||
                  (isTraceEvent
                    ? `latent ${selection.layer} / ${selection.feature_index}`
                    : 'No published explanation')}
              </div>
              {isTraceEvent && !selection.label && (
                <div style={{ ...css.dim, fontSize: 11.5, marginBottom: 6 }}>
                  Trace events carry the latent&rsquo;s identity, not its label
                  — the explanation lives once per latent in the anatomy archive
                  rather than 2.6 M times over. Click the same point with the
                  trace hidden, or follow the evidence link.
                </div>
              )}
              {selection.label_alt && (
                <div style={{ ...css.dim, fontSize: 11.5, marginBottom: 6 }}>
                  also explained as: {selection.label_alt}
                </div>
              )}
              <StatusChip value={selection.interpretation_status} />
              <div style={{ ...css.row, marginTop: 6 }}>
                <span style={css.dim}>layer / latent</span>
                <span>
                  {selection.layer} / {selection.feature_index}
                </span>
              </div>
              <div style={css.row}>
                <span style={css.dim}>label agreement</span>
                <span>{num(selection.label_confidence, 2)}</span>
              </div>
              {selection.firing_rate !== undefined && (
                <div style={css.row}>
                  <span style={css.dim}>firing rate</span>
                  <span>
                    {(selection.firing_rate * 100).toFixed(3)}% of tokens
                  </span>
                </div>
              )}
              {selection.activation !== undefined && (
                <div style={css.row}>
                  <span style={css.dim}>activation here</span>
                  <span>{num(selection.activation, 2)}</span>
                </div>
              )}
              {selection.attribution !== undefined && (
                <div style={css.row}>
                  <span style={css.dim}>attribution here</span>
                  <span>{num(selection.attribution, 4)}</span>
                </div>
              )}
              {selectedToken !== undefined && (
                <div style={css.row}>
                  <span style={css.dim}>
                    token {selection.token_index?.toLocaleString()}
                  </span>
                  <span style={css.mono}>{JSON.stringify(selectedToken)}</span>
                </div>
              )}
              {selection.layer !== undefined &&
                selection.feature_index !== undefined && (
                  <a
                    href={neuronpediaHref(
                      selection.layer,
                      selection.feature_index,
                    )}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{
                      color: '#8fd0ff',
                      fontSize: 12,
                      display: 'inline-block',
                      marginTop: 8,
                    }}
                  >
                    Evidence on Neuronpedia →
                  </a>
                )}
            </>
          )}
        </div>
      )}

      {/* ── methodology ────────────────────────────────────────────────── */}
      <h2 style={css.h2}>Read this before you trust the map</h2>
      {REQUIRED_CAVEATS.map((c) => (
        <div key={c.title} style={{ ...css.card, marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
          <div style={{ ...css.dim, fontSize: 11.5 }}>{c.body}</div>
        </div>
      ))}

      <h2 style={css.h2}>Published measurements</h2>
      <div style={css.card}>
        {dist && (
          <>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Projection distortion (k = {dist.k}, n ={' '}
              {dist.sample_n?.toLocaleString()})
            </div>
            <div style={css.row}>
              <span style={css.dim}>trustworthiness</span>
              <span>{num(dist.trustworthiness, 3)}</span>
            </div>
            <div style={css.row}>
              <span style={css.dim}>continuity</span>
              <span>{num(dist.continuity, 3)}</span>
            </div>
            <div style={css.row}>
              <span style={css.dim}>kNN overlap</span>
              <span>{num(dist.knn_overlap, 3)}</span>
            </div>
            <div style={{ ...css.mono, marginTop: 6 }}>{dist.source}</div>
          </>
        )}
        {drift && (
          <>
            <div style={{ fontWeight: 600, margin: '12px 0 4px' }}>
              Atlas drift under clustering reseed
            </div>
            <div style={css.row}>
              <span style={css.dim}>L0 centroid shift (median / p90)</span>
              <span>
                {num(drift.l0_centroid_shift_atlas_units?.median, 3)} /{' '}
                {num(drift.l0_centroid_shift_atlas_units?.p90, 3)}
              </span>
            </div>
            <div style={css.row}>
              <span style={css.dim}>L1 centroid shift (median)</span>
              <span>{num(drift.l1_centroid_shift_atlas_units?.median, 3)}</span>
            </div>
            <div style={css.row}>
              <span style={css.dim}>latents changing region</span>
              <span>
                {drift.l2_members_changing_region_fraction !== undefined
                  ? `${(drift.l2_members_changing_region_fraction * 100).toFixed(1)}%`
                  : '—'}
              </span>
            </div>
            <div style={{ ...css.mono, marginTop: 6 }}>
              {drift.atlas_unit_definition}
            </div>
            {drift.not_measured && (
              <div style={{ ...css.dim, fontSize: 11, marginTop: 6 }}>
                Not measured: {drift.not_measured}
              </div>
            )}
          </>
        )}
      </div>

      <h2 style={css.h2}>Provenance</h2>
      <div style={{ ...css.card, ...css.mono }}>
        <div>
          model {sidecar.pin.model} ({sidecar.pin.model_license})
        </div>
        <div>
          SAEs {sidecar.pin.sae_repo} ({sidecar.pin.sae_license})
        </div>
        <div>labels {sidecar.pin.labels}</div>
        <div>
          corpus {sidecar.pin.corpus?.config} ({sidecar.pin.corpus?.license})
        </div>
        <div>
          built {sidecar.generated_utc} @ {sidecar.git_commit}
        </div>
      </div>
      <p style={{ ...css.dim, fontSize: 11.5, marginTop: 8 }}>
        {sidecar.attribution_method}
      </p>
    </aside>
  );
};

const StatusChip: React.FC<{ value?: string }> = ({ value }) => {
  const st = statusStyle(value);
  return (
    <span
      title={st.blurb}
      style={{
        display: 'inline-block',
        border: `1px solid ${st.color}`,
        color: st.color,
        borderRadius: 5,
        padding: '1px 7px',
        fontSize: 11,
        opacity: 0.4 + st.weight * 0.6,
      }}
    >
      {st.label}
    </span>
  );
};

export default AtlasPanel;
