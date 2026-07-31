/**
 * Neural-State Atlas (`/atlas`) — a transformer's internal state as a navigable
 * map, played on the token clock.
 *
 * The argument the page makes: every published atlas-of-embeddings tool renders
 * a STILL — Nomic Atlas, latent-scope and Neuronpedia all show a static map of
 * features, and none of them plays the token-by-token traversal of that map
 * during inference. The traversal is the thing this stack is uniquely equipped
 * for, and it is the whole reason this is a poopdeck demo rather than a re-skin
 * of latent-scope.
 *
 * Two things about the geometry, because they are the page's whole shape:
 *
 *   X/Y/Z are ONE isotropic manifold embedding of the 294,912 decoder
 *   directions. They are not axes of the model. In particular Z is NOT the
 *   transformer layer — encoding depth as altitude put a 1,650 km stack against
 *   families 0.7 km wide and rendered as towers in an empty plane. Depth is now
 *   a renderer prop (`elevationScale`) over a numeric column, and the default
 *   is FLAT, because a plan view is where the emergent structure reads.
 *
 *   The transformer layer is carried as colour on the map and as the layer ×
 *   token strip below, which is both more legible than altitude was and free of
 *   any geometric commitment.
 *
 * Responsibilities here (the /worlds orchestration pattern):
 *   • fetch `neural-atlas.json` — the generator sidecar carrying the pin, the
 *     coordinate frame, the token strings, the activation series, the metric
 *     domains and the published validation numbers;
 *   • own ONE TimeController + PlaybackGovernor via `usePlayback`, so the map,
 *     the reading strip, the series and the transport all read the same clock —
 *     and the clock IS the token index, because one token is one second by
 *     construction;
 *   • hold the metric in the ROUTE (`/atlas/:metric?`) so a link can carry
 *     "show me the attribution view" and browser back returns to activation;
 *   • honour `prefers-reduced-motion` (parked and scrubbable, never autoplaying).
 *
 * See `docs/roadmap/neural-atlas-2026-07.md` §14.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import DeckGL from '@deck.gl/react';
import { usePlayback } from '@poopdeck.gl/react';
import { resolveDataUrl } from '../datasets';
import { useReducedMotion } from '../lib/reducedMotion';
import AtlasPanel, {
  type AtlasSelection,
} from '../components/atlas/AtlasPanel';
import AtlasReadingStrip from '../components/atlas/AtlasReadingStrip';
import { buildPlacesLayer } from '../components/atlas/atlasPlaces';
import AtlasSeries from '../components/atlas/AtlasSeries';
import {
  fetchNodeSeries,
  resetNodeSeriesCache,
  type NodeSeries,
} from '../components/atlas/atlasSeriesData';
import {
  ATLAS_METRICS,
  SELECTABLE_METRICS,
  STATUS_ORDER,
  msToToken,
  tokenToMs,
  type AtlasMetricId,
  type AtlasSidecar,
  type InterpretationStatus,
} from '../components/atlas/atlasTypes';
import {
  buildAtlasLayers,
  metricDomainFor,
  type AtlasArchiveUrls,
} from '../components/atlas/buildAtlasLayers';

const TRACE_SLUG = 'wikitext';

const URLS: AtlasArchiveUrls = {
  anatomy: resolveDataUrl('/data/neural-atlas-anatomy/manifest.json'),
  manifolds: resolveDataUrl('/data/neural-atlas-manifolds/manifest.json'),
  trace: resolveDataUrl(`/data/neural-atlas-trace-${TRACE_SLUG}/manifest.json`),
};
const SIDECAR_URL = resolveDataUrl('/data/neural-atlas.json');

/**
 * Opening framing. The embedding fills a ±16° box about (0, 0) — inside the
 * record's "keep the atlas within roughly ±20° of the equator" build constant,
 * where the equirectangular mapping is isotropic. Pitch 0: the map is flat by
 * default and depth is opt-in.
 */
const INITIAL_VIEW = {
  longitude: 0,
  latitude: 0,
  zoom: 4.3,
  pitch: 0,
  bearing: 0,
};

/**
 * Tokens per second of wall clock.
 *
 * One token per second, because the unit of this demo is one token's
 * projection onto the atlas and you need time to actually look at it. The first
 * build ran at 90/s (11 ms each) and even 4/s is a flicker — at 250 ms a
 * constellation of ~330 points has appeared and gone before the eye settles.
 */
const DEFAULT_TOKENS_PER_SECOND = 1;

/**
 * How many tokens of tail a single frame shows, derived from the rate rather
 * than fixed.
 *
 * These pull in opposite directions: at a reading pace you want ONE token on
 * screen, so each projection is unambiguous and clears before the next; at a
 * sweep you want a few, or the map strobes. Tying the window to the rate gets
 * both instead of compromising at three.
 */
function tokensInWindowFor(rate: number): number {
  return Math.max(1, Math.min(4, Math.round(rate / 5)));
}

/** The anatomy is tiled to z10; clamping keeps deck from asking for more. */
const MAX_ZOOM = 10;

const NeuralAtlas: React.FC = () => {
  const { metric: metricParam } = useParams<{ metric?: string }>();
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();

  const [sidecar, setSidecar] = useState<AtlasSidecar | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewState, setViewState] = useState<any>(INITIAL_VIEW);
  const [selection, setSelection] = useState<AtlasSelection | null>(null);
  const [selectionPosition, setSelectionPosition] = useState<
    [number, number] | null
  >(null);
  const [nodeSeries, setNodeSeries] = useState<NodeSeries | null>(null);
  const [showAnatomy, setShowAnatomy] = useState(true);
  const [showTrace, setShowTrace] = useState(true);
  const [showDensity, setShowDensity] = useState(false);
  const [showPlaces, setShowPlaces] = useState(true);
  const [showManifolds, setShowManifolds] = useState(false);
  const [depth, setDepth] = useState(0);
  const [tokensPerSecond, setTokensPerSecond] = useState(
    DEFAULT_TOKENS_PER_SECOND,
  );
  const [visibleStatuses, setVisibleStatuses] = useState<
    Set<InterpretationStatus>
  >(() => new Set(STATUS_ORDER));

  const metric: AtlasMetricId = useMemo(() => {
    const m = metricParam as AtlasMetricId | undefined;
    return m && SELECTABLE_METRICS.includes(m) ? m : 'activation';
  }, [metricParam]);

  // ── sidecar ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    resetNodeSeriesCache();
    fetch(SIDECAR_URL)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then((doc: AtlasSidecar) => {
        if (!cancelled) setSidecar(doc);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── clock ─────────────────────────────────────────────────────────────────
  // The playhead IS the token index: the generator writes one token per second
  // from a synthetic epoch, so `msToToken` is exact rather than an estimate.
  const timeRange = useMemo(() => {
    if (!sidecar) return undefined;
    const { epoch_ms, ms_per_token } = sidecar.frame;
    return {
      start: epoch_ms,
      end: epoch_ms + sidecar.trace.tokens.length * ms_per_token,
    };
  }, [sidecar]);

  // One token = one second of sim time, so "tokens per second of wall clock" IS
  // the speed in sim-ms per wall-second. No conversion, and no way for the two
  // to drift apart.
  const baseSpeed = useMemo(
    () => (sidecar?.frame.ms_per_token ?? 1000) * tokensPerSecond,
    [sidecar, tokensPerSecond],
  );

  const playback = usePlayback({ timeRange, baseSpeed, loop: true });

  useEffect(() => {
    if (!sidecar) return;
    if (reducedMotion) playback.pause();
    else playback.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidecar, reducedMotion, timeRange]);

  const tokenIndex = useMemo(
    () => (sidecar ? msToToken(sidecar, playback.currentTime) : 0),
    [sidecar, playback.currentTime],
  );

  const onSeekToken = useCallback(
    (index: number) => {
      if (!sidecar) return;
      playback.onSeek(tokenToMs(sidecar, index));
    },
    [sidecar, playback],
  );

  // ── camera ────────────────────────────────────────────────────────────────
  const onViewStateChange = useCallback(({ viewState: vs }: any) => {
    // Clamped here rather than on the controller: deck's MapView takes maxZoom
    // as a VIEW prop, not a controller option, and clamping the state is the
    // one place that also catches a programmatic fly-to.
    setViewState({ ...vs, zoom: Math.min(vs.zoom ?? 0, MAX_ZOOM) });
  }, []);

  // Turning depth on wants a camera that can see it; flat wants a plan view.
  const onDepth = useCallback((next: number) => {
    setDepth(next);
    setViewState((vs: any) => ({
      ...vs,
      pitch: next > 0 ? Math.max(vs.pitch ?? 0, 45) : 0,
      bearing: next > 0 ? vs.bearing : 0,
    }));
  }, []);

  // ── selection series (lazy, one Range request) ───────────────────────────
  useEffect(() => {
    const spec = sidecar?.series?.node_series;
    const nodeId = selection?.node_id;
    if (!spec || typeof nodeId !== 'number') {
      setNodeSeries(null);
      return;
    }
    const ac = new AbortController();
    fetchNodeSeries(nodeId, spec, resolveDataUrl, ac.signal).then((s) => {
      if (!ac.signal.aborted) setNodeSeries(s);
    });
    return () => ac.abort();
  }, [sidecar, selection?.node_id]);

  // ── layers ────────────────────────────────────────────────────────────────
  const metricDomain = useMemo(
    () => metricDomainFor(metric, sidecar?.metric_domains),
    [metric, sidecar],
  );

  const tokensInWindow = tokensInWindowFor(tokensPerSecond);

  const layers = useMemo(() => {
    if (!sidecar || !timeRange) return [];
    return buildAtlasLayers({
      urls: URLS,
      timeController: playback.timeController,
      registry: playback.registry,
      timeRange,
      timeWindow: tokensInWindow * sidecar.frame.ms_per_token,
      playbackSpeed: baseSpeed,
      metric,
      metricDomain,
      visibleStatuses,
      depth,
      elevationColumn: sidecar.frame.elevation_column ?? 'z_embed_m',
      showAnatomy,
      showTrace,
      showDensity,
      showManifolds,
      pickable: true,
      selectionPosition,
    });
  }, [
    sidecar,
    timeRange,
    playback.timeController,
    playback.registry,
    baseSpeed,
    tokensInWindow,
    metric,
    metricDomain,
    visibleStatuses,
    depth,
    showAnatomy,
    showTrace,
    showDensity,
    showManifolds,
    selectionPosition,
  ]);

  // Places ride on top of the tiled layers and come from the sidecar, so they
  // are appended here rather than inside buildAtlasLayers — no archive, no
  // governor source, nothing to stream.
  const allLayers = useMemo(() => {
    const places = sidecar?.places ?? [];
    if (!showPlaces || !places.length) return layers;
    return [
      ...layers,
      buildPlacesLayer(places, { dimmed: !!selectionPosition }),
    ];
  }, [layers, sidecar, showPlaces, selectionPosition]);

  const onToggleLayer = useCallback(
    (k: 'anatomy' | 'trace' | 'density' | 'places' | 'manifolds') => {
      if (k === 'anatomy') setShowAnatomy((v) => !v);
      else if (k === 'trace') setShowTrace((v) => !v);
      else if (k === 'density') setShowDensity((v) => !v);
      else if (k === 'places') setShowPlaces((v) => !v);
      else setShowManifolds((v) => !v);
    },
    [],
  );

  const onToggleStatus = useCallback((s: InterpretationStatus) => {
    setVisibleStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      // An empty selection would render an empty map with no way back, so the
      // last one standing cannot be turned off.
      return next.size ? next : prev;
    });
  }, []);

  const neuronpediaHref = useCallback(
    (layer: number, feature: number) =>
      `https://www.neuronpedia.org/gpt2-small/${layer}-res-jb/${feature}`,
    [],
  );

  if (loadError) {
    return (
      <div style={shellStyle}>
        <div style={{ maxWidth: 560, padding: 28, color: '#e6ebf5' }}>
          <h1 style={{ font: '600 20px/1.3 ui-sans-serif, system-ui' }}>
            Neural-State Atlas
          </h1>
          <p style={{ color: '#98a4bd' }}>
            The atlas archives are not published on this deploy ({loadError}).
            They are generated by{' '}
            <code>scripts/data-generation/neural_atlas.py</code> and served from{' '}
            <code>examples/showcase/public/data</code> under{' '}
            <code>npm run dev</code>.
          </p>
          <Link to="/demos" style={{ color: '#8fd0ff' }}>
            ← back to the demos
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      {/* Basemap-free: these coordinates are an abstract plane that happens to
          be carried on lon/lat, and a coastline behind them would be a lie. */}
      <DeckGL
        viewState={viewState}
        onViewStateChange={onViewStateChange}
        controller={{ dragRotate: depth > 0, touchRotate: depth > 0 }}
        layers={allLayers}
        getTooltip={({ object }: any) => {
          if (!object) return null;
          // Anatomy points carry the label; trace events carry only the
          // latent's identity and its value, because repeating a label on 2.6 M
          // events is what made the trace archive four times bigger than it
          // needed to be.
          const text =
            object.label ||
            (typeof object.layer === 'number' &&
            typeof object.feature_index === 'number'
              ? `latent ${object.layer}/${object.feature_index}`
              : null);
          return text ? { text: String(text), style: tooltipStyle } : null;
        }}
        onClick={({ object, coordinate }: any) => {
          setSelection(object ?? null);
          setSelectionPosition(
            object && coordinate
              ? [coordinate[0] as number, coordinate[1] as number]
              : null,
          );
        }}
        // deck's `style` is a CSSStyleDeclaration, not React CSSProperties —
        // every value is a string.
        style={{ position: 'absolute', inset: '0' }}
      />

      {!sidecar && (
        <div style={{ ...overlayStyle, color: '#98a4bd' }}>
          Loading the atlas…
        </div>
      )}

      {sidecar && (
        <>
          <AtlasPanel
            sidecar={sidecar}
            metric={metric}
            onMetric={(m) =>
              navigate(m === 'activation' ? '/atlas' : `/atlas/${m}`)
            }
            visibleStatuses={visibleStatuses}
            onToggleStatus={onToggleStatus}
            showAnatomy={showAnatomy}
            showTrace={showTrace}
            showDensity={showDensity}
            showPlaces={showPlaces}
            showManifolds={showManifolds}
            onToggleLayer={onToggleLayer}
            depth={depth}
            onDepth={onDepth}
            selection={selection}
            neuronpediaHref={neuronpediaHref}
          />
          <div style={bottomStyle}>
            <AtlasSeries
              sidecar={sidecar}
              tokenIndex={tokenIndex}
              metric={metric}
              selection={nodeSeries}
              selectionLabel={
                selection?.label ||
                (typeof selection?.node_id === 'number'
                  ? `latent ${selection.layer}/${selection.feature_index}`
                  : undefined)
              }
              onSeekToken={onSeekToken}
            />
            <AtlasReadingStrip
              sidecar={sidecar}
              tokenIndex={tokenIndex}
              isPlaying={playback.isPlaying}
              onSeekToken={onSeekToken}
              onPlayPause={playback.onPlayPause}
              tokensPerSecond={tokensPerSecond}
              onTokensPerSecond={setTokensPerSecond}
            />
            <div style={{ color: '#8e9ab5', fontSize: 11.5, marginTop: 6 }}>
              Colour is {ATLAS_METRICS[metric].label.toLowerCase()}, over a{' '}
              {tokensInWindow === 1
                ? 'single-token'
                : `${tokensInWindow}-token`}{' '}
              window. X/Y/Z are one embedding of the latents — not axes of the
              model.
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const shellStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100vh',
  background:
    'radial-gradient(120% 100% at 50% 0%, #10131f 0%, #070810 55%, #04050a 100%)',
  overflow: 'hidden',
};

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  font: '13px ui-sans-serif, system-ui, sans-serif',
  pointerEvents: 'none',
};

const bottomStyle: React.CSSProperties = {
  position: 'absolute',
  left: 18,
  right: 400,
  bottom: 16,
};

const tooltipStyle = {
  background: 'rgba(10,12,20,0.94)',
  color: '#e6ebf5',
  fontSize: '12px',
  borderRadius: '6px',
  padding: '6px 9px',
  maxWidth: '320px',
};

export default NeuralAtlas;
