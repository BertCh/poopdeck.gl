/**
 * World Model Scenario Explorer — a fullscreen gallery of 300 driving scenarios
 * from NVIDIA's Cosmos-Drive-Dreams, laid out on a synthetic grid and all
 * animating at once on one shared looping clock.
 *
 * The argument the page makes: the VECTOR scene is the authoritative artifact —
 * HD map, ego path, oriented agent boxes, LiDAR — and the world model's video is
 * one photoreal manifestation of it. So the gallery streams real geometry for
 * every world simultaneously, and selecting one plays its generated video locked
 * to the same playhead that drives the geometry.
 *
 * Responsibilities here (the AvCockpit orchestration pattern):
 *   • resolve the dataset + fetch the `worlds.json` scenario index;
 *   • own ONE TimeController + PlaybackGovernor via `usePlayback`, so the
 *     geometry, the video, and the timeline all read the same clock;
 *   • hold selection in the ROUTE (`/worlds/:worldId?`) so browser back also
 *     flies the camera back, and the filter/variant in search params;
 *   • honor `prefers-reduced-motion` (no autoplay, no camera flight, no video
 *     playback — scrubbing still works).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { usePlayback } from '@poopdeck.gl/react';
import { getDatasetById } from '../datasets';
import { useReducedMotion } from '../lib/reducedMotion';
import { useIsMobile } from '../lib/useMediaQuery';
import Timeline from '../components/av/Timeline';
import WorldsDeck from '../components/worlds/WorldsDeck';
import WorldSidePanel from '../components/worlds/WorldSidePanel';
import WorldsMobileChrome from '../components/worlds/WorldsMobileChrome';
import FilterChips from '../components/worlds/FilterChips';
import {
  FILTER_CHIPS,
  findScenario,
  weatherChips as buildWeatherChips,
  worldsBaseUrl,
  type WorldFilterChip,
  type WorldsIndex,
} from '../components/worlds/worldsTypes';

const DATASET_ID = 'cosmos-drive-dreams';

const CosmosWorlds: React.FC = () => {
  const { worldId } = useParams<{ worldId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const reducedMotion = useReducedMotion();
  const isMobile = useIsMobile();

  // The gallery mounts exactly one `worlds` bundle; anything else under that id
  // is not this page's dataset.
  const dataset = useMemo(() => {
    const d = getDatasetById(DATASET_ID);
    return d?.type === 'worlds' ? d : undefined;
  }, []);
  const [worlds, setWorlds] = useState<WorldsIndex | null>(null);
  const [loadError, setLoadError] = useState(false);

  // ── worlds.json ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!dataset?.worldsUrl) {
      setLoadError(true);
      return;
    }
    let cancelled = false;
    setWorlds(null);
    setLoadError(false);
    fetch(dataset.worldsUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((doc: WorldsIndex | null) => {
        if (cancelled) return;
        if (doc?.scenarios?.length) setWorlds(doc);
        else setLoadError(true);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  const worldsBase = useMemo(
    () => (dataset?.worldsUrl ? worldsBaseUrl(dataset.worldsUrl) : ''),
    [dataset],
  );

  // ── clock ─────────────────────────────────────────────────────────────────
  // worlds.json is authoritative (it knows the real longest clip); the Dataset
  // range is only the pre-load placeholder.
  const timeRange = useMemo(
    () =>
      worlds
        ? { start: worlds.t0, end: worlds.t0 + worlds.durationMs }
        : dataset?.timeRange,
    [worlds, dataset],
  );
  const baseSpeed = useMemo(() => {
    if (!timeRange) return 1000;
    const span = timeRange.end - timeRange.start;
    return span / ((dataset?.targetPlaybackSeconds ?? 4) * 1000);
  }, [timeRange, dataset]);

  const playback = usePlayback({ timeRange, baseSpeed, loop: true });

  // The gallery is only legible in motion, so it autoplays once the index is
  // in — except under reduced motion, where it stays parked and scrubbable.
  useEffect(() => {
    if (!worlds) return;
    if (reducedMotion) playback.pause();
    else playback.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worlds, reducedMotion, timeRange]);

  // ── selection + filter state ──────────────────────────────────────────────
  const selected = useMemo(
    () => findScenario(worlds, worldId) ?? null,
    [worlds, worldId],
  );

  const handleSelect = useCallback(
    (id: string | null) => {
      const search = searchParams.toString();
      navigate({
        pathname: id ? `/worlds/${id}` : '/worlds',
        search,
      });
    },
    [navigate, searchParams],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value === null) next.delete(key);
      else next.set(key, value);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const allChips = useMemo<WorldFilterChip[]>(
    () => (worlds ? [...FILTER_CHIPS, ...buildWeatherChips(worlds)] : []),
    [worlds],
  );
  const activeChipId = searchParams.get('filter');
  const chip = useMemo(
    () => allChips.find((c) => c.id === activeChipId) ?? null,
    [allChips, activeChipId],
  );
  const chipCounts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!worlds) return out;
    for (const c of allChips) {
      out[c.id] = worlds.scenarios.filter((s) => c.match(s)).length;
    }
    return out;
  }, [allChips, worlds]);

  const variant = searchParams.get('wx');
  const handleVariant = useCallback(
    (key: string) => setParam('wx', key),
    [setParam],
  );
  // A world's variants are its own, so clear the selection when it changes.
  useEffect(() => {
    setParam('wx', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  const contentChips = useMemo(
    () => allChips.filter((c) => !c.id.startsWith('wx-')),
    [allChips],
  );
  const wxChips = useMemo(
    () => allChips.filter((c) => c.id.startsWith('wx-')),
    [allChips],
  );

  // ── states ────────────────────────────────────────────────────────────────
  if (!dataset) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#05070d] text-slate-400">
        <div className="text-center">
          <p className="text-sm">
            Scenario explorer dataset is not registered.
          </p>
          <Link to="/demos" className="mt-2 inline-block text-xs underline">
            Back to demos
          </Link>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#05070d] px-6 text-slate-400">
        <div className="max-w-md text-center">
          <p className="text-sm text-slate-300">
            The scenario bundle isn&apos;t built yet.
          </p>
          <p className="mt-2 text-xs leading-relaxed">
            Generate it with{' '}
            <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px]">
              python scripts/data-generation/cosmos_drive_dreams.py
            </code>
            , which downloads the Cosmos-Drive-Dreams labels and writes{' '}
            <code className="font-mono text-[11px]">
              public/data/cosmos-drive-dreams/
            </code>
            .
          </p>
          <Link to="/demos" className="mt-3 inline-block text-xs underline">
            Back to demos
          </Link>
        </div>
      </div>
    );
  }

  const backdrop = dataset.backdropColor ?? '#05070d';

  return (
    <div className="relative h-screen w-full" style={{ background: backdrop }}>
      <WorldsDeck
        dataset={dataset}
        worlds={worlds}
        worldsBase={worldsBase}
        timeController={playback.timeController}
        registry={playback.registry}
        chip={chip}
        selected={selected}
        reducedMotion={reducedMotion}
        onSelect={handleSelect}
      />

      {!worlds && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/70 px-3 py-1.5 text-xs text-slate-300 shadow-lg">
            Loading worlds…
          </span>
        </div>
      )}

      {isMobile ? (
        <WorldsMobileChrome
          dataset={dataset}
          worlds={worlds}
          worldsBase={worldsBase}
          playback={playback}
          selected={selected}
          chips={contentChips}
          weatherChips={wxChips}
          activeChipId={activeChipId}
          chipCounts={chipCounts}
          onChipSelect={(id) => setParam('filter', id)}
          variant={variant}
          onVariantChange={handleVariant}
          onClose={() => handleSelect(null)}
          reducedMotion={reducedMotion}
        />
      ) : (
        <>
          {/* Title + back link */}
          <div className="pointer-events-none absolute left-4 top-4 z-10">
            <div className="pointer-events-auto rounded-lg border border-white/10 bg-black/60 px-3 py-2 shadow-xl backdrop-blur-md">
              <Link
                to="/demos"
                className="text-[10px] uppercase tracking-wider text-slate-500 transition-colors hover:text-slate-300"
              >
                ← Demos
              </Link>
              <h1 className="mt-0.5 text-sm font-medium text-slate-100">
                World Model Scenario Explorer
              </h1>
              <p className="mt-0.5 max-w-xs text-[11px] leading-relaxed text-slate-400">
                {worlds
                  ? `${worlds.scenarios.length} Cosmos-Drive-Dreams scenarios, every agent animating at once. Click a world to fly in.`
                  : 'Cosmos-Drive-Dreams scenarios on one shared clock.'}
              </p>
            </div>
          </div>

          {/* Filters */}
          {worlds && (
            <div className="absolute right-4 top-4 z-10 max-w-[46rem]">
              <FilterChips
                chips={contentChips}
                weatherChips={wxChips}
                activeId={activeChipId}
                onSelect={(id) => setParam('filter', id)}
                counts={chipCounts}
                total={worlds.scenarios.length}
              />
            </div>
          )}

          {/* Selected world */}
          {worlds && selected && (
            <div className="absolute bottom-20 right-4 top-20 z-10 flex items-start">
              <WorldSidePanel
                scenario={selected}
                worlds={worlds}
                worldsBase={worldsBase}
                timeController={playback.timeController}
                variant={variant}
                onVariantChange={handleVariant}
                onClose={() => handleSelect(null)}
                reducedMotion={reducedMotion}
                objectColors={dataset.avObjectColors}
                className="max-h-full w-80"
              />
            </div>
          )}

          {/* Transport */}
          <div className="absolute bottom-4 left-4 right-4 z-10">
            <Timeline
              {...playback}
              timeRange={timeRange ?? dataset.timeRange}
              targetPlaybackSeconds={dataset.targetPlaybackSeconds ?? 4}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default CosmosWorlds;
