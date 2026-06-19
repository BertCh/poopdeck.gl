/**
 * AV Telemetry Cockpit — a streetscape.gl / avs.auto-style fullscreen surface
 * for one autonomous-vehicle scene. Orchestrates the deck + chrome:
 *
 *   • resolves the scene from the `/drive/:sceneId?` route param (default
 *     'av-synthetic') via the Dataset registry;
 *   • fetches `scene.json` (through the same data-base resolver the Dataset URLs
 *     use) for chrome / object colors / the real time range / the telemetry +
 *     camera sidecar refs, then fetches those sidecars;
 *   • owns ONE TimeController + PlaybackGovernor (the shared `usePlayback`
 *     hook), so the deck layers, the gauges, the camera inset, and the timeline
 *     all read the same clock;
 *   • renders {@link AvDeck} plus the floating chrome (scene switcher, stream
 *     panel, gauges, camera inset, timeline);
 *   • honors `prefers-reduced-motion` (no autoplay, no ego-follow easing).
 *
 * Missing streams simply hide their panel; a missing/blank bundle shows a
 * loading or "scene not generated yet" state instead of crashing.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePlayback } from "@poopdeck.gl/react";
import { datasets, getDatasetById } from "../datasets";
import { useReducedMotion } from "../lib/reducedMotion";
import { useIsMobile } from "../lib/useMediaQuery";
import type { Dataset, ColorRGBA } from "../types";
import AvDeck from "../components/av/AvDeck";
import AvMobileChrome from "../components/av/AvMobileChrome";
import StreamPanel from "../components/av/StreamPanel";
import MetricCharts from "../components/av/MetricCharts";
import CameraInset from "../components/av/CameraInset";
import SceneSwitcher from "../components/av/SceneSwitcher";
import Timeline, { type TimelineProps } from "../components/av/Timeline";
import ObjectInspector, {
  type PickedObject,
} from "../components/av/ObjectInspector";
import {
  type AvScene,
  type AvStreamKey,
  type AvTelemetry,
  type AvCameras,
} from "../components/av/sceneTypes";

const DEFAULT_SCENE_ID = "av-synthetic";
const LAYER_STREAMS: AvStreamKey[] = ["lidar", "ego", "objects", "map"];

/** Base url of a dataset's data dir (strip the trailing manifest filename). */
function sceneBaseUrl(dataset: Dataset): string {
  // dataset.avSceneUrl is the resolved scene.json url; its dir is the bundle root.
  const u = dataset.avSceneUrl ?? dataset.url;
  return u.replace(/\/[^/]*$/, "");
}

const AvCockpit: React.FC = () => {
  const { sceneId } = useParams<{ sceneId?: string }>();
  const reducedMotion = useReducedMotion();
  const isMobile = useIsMobile();

  // All AV scenes (for the switcher) + the active one.
  const avScenes = useMemo(
    () => datasets.filter((d) => d.type === "av"),
    [],
  );
  const dataset = useMemo(
    () => getDatasetById(sceneId ?? DEFAULT_SCENE_ID),
    [sceneId],
  );

  // ── Sidecars (scene.json + telemetry + cameras) ───────────────────────────
  const [scene, setScene] = useState<AvScene | null>(null);
  const [telemetry, setTelemetry] = useState<AvTelemetry | null>(null);
  const [cameras, setCameras] = useState<AvCameras | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Click-to-inspect selection (cleared when the scene changes).
  const [selectedObject, setSelectedObject] = useState<PickedObject | null>(null);
  useEffect(() => {
    setSelectedObject(null);
  }, [dataset]);

  useEffect(() => {
    if (!dataset || dataset.type !== "av") return;
    let cancelled = false;
    setScene(null);
    setTelemetry(null);
    setCameras(null);
    setLoadError(false);

    const run = async () => {
      try {
        const sceneUrl = dataset.avSceneUrl;
        const sc: AvScene | null = sceneUrl
          ? await fetch(sceneUrl).then((r) => (r.ok ? r.json() : null))
          : null;
        if (cancelled) return;
        setScene(sc);
        // Sidecars: prefer the scene's stream urls (resolved relative to the
        // bundle root); fall back to the Dataset's resolved urls.
        if (dataset.avTelemetryUrl) {
          const tel = await fetch(dataset.avTelemetryUrl)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          if (!cancelled && tel) setTelemetry(tel);
        }
        if (dataset.avCamerasUrl) {
          const cam = await fetch(dataset.avCamerasUrl)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          if (!cancelled && cam) setCameras(cam);
        }
        if (!sc) setLoadError(true);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  // Authoritative time range: scene.json wins; fall back to the Dataset's
  // placeholder window until it loads.
  const timeRange = useMemo(
    () => scene?.timeRange ?? dataset?.timeRange,
    [scene, dataset],
  );
  // Base wall→sim rate so the whole range plays in targetPlaybackSeconds.
  const baseSpeed = useMemo(() => {
    if (!timeRange) return 1000;
    const span = timeRange.end - timeRange.start;
    const secs = dataset?.targetPlaybackSeconds ?? 20;
    return span / (secs * 1000);
  }, [timeRange, dataset]);

  const playback = usePlayback({
    timeRange,
    baseSpeed,
    loop: true,
  });

  // Reduced motion: never autoplay. (usePlayback starts paused, so this is
  // belt-and-suspenders — keep it paused on mount/range change.)
  useEffect(() => {
    if (reducedMotion) playback.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, timeRange]);

  // ── Streams + visibility ──────────────────────────────────────────────────
  const presentStreams = useMemo<AvStreamKey[]>(() => {
    if (scene?.streams) {
      return (Object.keys(scene.streams) as AvStreamKey[]).filter(
        (k) => scene.streams![k],
      );
    }
    // No scene yet: infer from the Dataset's archive urls so the deck still
    // renders something before scene.json lands.
    const inferred: AvStreamKey[] = ["lidar"];
    if (dataset?.avEgoUrl) inferred.push("ego");
    if (dataset?.avObjectsUrl) inferred.push("objects");
    if (dataset?.avTelemetryUrl) inferred.push("telemetry");
    if (dataset?.avCamerasUrl) inferred.push("camera");
    return inferred;
  }, [scene, dataset]);

  const [visibleStreams, setVisibleStreams] = useState<Set<AvStreamKey>>(
    () => new Set(LAYER_STREAMS),
  );
  // Default every present LAYER stream to visible whenever the scene resolves.
  useEffect(() => {
    setVisibleStreams(
      new Set(presentStreams.filter((s) => LAYER_STREAMS.includes(s))),
    );
  }, [presentStreams]);
  const toggleStream = useCallback((s: AvStreamKey) => {
    setVisibleStreams((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  // Object colors: scene.json wins, else the Dataset copy.
  const objectColors = useMemo<Record<string, ColorRGBA> | undefined>(
    () => scene?.objectColors ?? dataset?.avObjectColors,
    [scene, dataset],
  );

  // ── Ego-follow camera ─────────────────────────────────────────────────────
  // The scene ships a lightweight ego polyline (additive `scene.streams.ego.path`)
  // that the cockpit can sample client-side. The smoothing + camera math lives
  // in {@link AvDeck} (a single rAF loop over `egoPath`); here we only own the
  // toggles. When the scene has no polyline the button is present but inert
  // (camera holds), which we surface in its title.
  const [egoFollow, setEgoFollow] = useState(false);
  const [topDown, setTopDown] = useState(false);
  const egoPath = useMemo<{ t: number; lon: number; lat: number }[] | null>(
    () => (scene?.streams?.ego as any)?.path ?? null,
    [scene],
  );

  if (!dataset || dataset.type !== "av") {
    return (
      <div className="fixed inset-0 bg-slate-950 text-slate-300 flex flex-col items-center justify-center gap-3">
        <div className="text-lg font-medium">Unknown AV scene</div>
        <Link to="/drive" className="text-cyan-400 text-sm underline">
          Open the default cockpit
        </Link>
      </div>
    );
  }

  const sceneName = scene?.name ?? dataset.name;
  const resolveFrameUrl = (rel: string) => `${sceneBaseUrl(dataset)}/${rel}`;
  const hasTelemetry =
    presentStreams.includes("telemetry") &&
    telemetry != null &&
    Object.keys(telemetry.fields ?? {}).length > 0;
  const hasCamera = presentStreams.includes("camera") && cameras != null;

  // Shared transport props — fed to the bottom timeline in either layout, so
  // desktop and mobile drive the SAME TimeController + PlaybackGovernor.
  const timelineProps: TimelineProps | null = timeRange
    ? {
        currentTime: playback.currentTime,
        timeRange,
        isPlaying: playback.isPlaying,
        bufferState: playback.bufferState,
        governor: playback.governor,
        onPlayPause: playback.onPlayPause,
        onSeek: playback.onSeek,
        onSpeedChange: playback.onSpeedChange,
        currentSpeedMultiplier: playback.speedMultiplier,
        targetPlaybackSeconds: dataset.targetPlaybackSeconds ?? 20,
        autoSpeed: playback.autoSpeed,
        onAutoSpeedSelect: playback.onAutoSpeedSelect,
      }
    : null;

  return (
    <div className="fixed inset-0 bg-slate-950 overflow-hidden">
      {/* The map fills the viewport; chrome floats over it. */}
      <div className="absolute inset-0">
        <AvDeck
          dataset={dataset}
          timeController={playback.timeController}
          visibleStreams={visibleStreams}
          registry={playback.registry}
          egoFollow={egoFollow}
          topDown={topDown}
          reducedMotion={reducedMotion}
          egoPath={egoPath}
          onSelectObject={setSelectedObject}
        />
      </div>

      {isMobile ? (
        <AvMobileChrome
          scene={scene}
          dataset={dataset}
          scenes={avScenes}
          sceneName={sceneName}
          timeController={playback.timeController}
          presentStreams={presentStreams}
          visibleStreams={visibleStreams}
          onToggleStream={toggleStream}
          objectColors={objectColors}
          telemetry={telemetry}
          hasTelemetry={hasTelemetry}
          cameras={cameras}
          hasCamera={hasCamera}
          resolveFrameUrl={resolveFrameUrl}
          egoFollow={egoFollow}
          onToggleEgoFollow={() => setEgoFollow((v) => !v)}
          egoPath={egoPath}
          topDown={topDown}
          onToggleTopDown={() => setTopDown((v) => !v)}
          selectedObject={selectedObject}
          onCloseObject={() => setSelectedObject(null)}
          timeline={timelineProps}
        />
      ) : (
        <>
      {/* Top-left: scene switcher + camera controls */}
      <div className="absolute top-3 left-3 flex flex-col gap-2">
        <SceneSwitcher
          scenes={avScenes}
          currentId={dataset.id}
          sceneName={sceneName}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEgoFollow((v) => !v)}
            aria-pressed={egoFollow}
            title={
              egoPath
                ? "Recenter the camera on the vehicle"
                : "Ego-follow (scene has no ego polyline — camera holds)"
            }
            className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
              egoFollow
                ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-100"
                : "border-white/10 bg-black/55 text-slate-300 hover:bg-white/5"
            }`}
          >
            Follow ego
          </button>
          <button
            type="button"
            onClick={() => setTopDown((v) => !v)}
            aria-pressed={topDown}
            title="Toggle perspective / top-down view"
            className={`rounded-md border px-2.5 py-1 text-xs backdrop-blur-md transition-colors ${
              topDown
                ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-100"
                : "border-white/10 bg-black/55 text-slate-300 hover:bg-white/5"
            }`}
          >
            {topDown ? "Top-down" : "Perspective"}
          </button>
        </div>
      </div>

      {/* Left rail: stream list (below the switcher) */}
      {scene && (
        <div className="absolute top-28 left-3">
          <StreamPanel
            scene={scene}
            presentStreams={presentStreams}
            visibleStreams={visibleStreams}
            onToggleStream={toggleStream}
            objectColors={objectColors}
          />
        </div>
      )}

      {/* Top-right: camera inset */}
      {hasCamera && (
        <div className="absolute top-3 right-3">
          <CameraInset
            cameras={cameras!}
            resolveFrameUrl={resolveFrameUrl}
            timeController={playback.timeController}
          />
        </div>
      )}

      {/* Bottom-left: telemetry strip-charts (Cabana / XVIZ-Metrics style) */}
      {hasTelemetry && (
        <div className="absolute bottom-20 left-3">
          <MetricCharts
            telemetry={telemetry!}
            timeController={playback.timeController}
          />
        </div>
      )}

      {/* Bottom-right: picked-object inspector (renders nothing until a click) */}
      <div className="absolute bottom-20 right-3">
        <ObjectInspector
          object={selectedObject}
          onClose={() => setSelectedObject(null)}
          objectColors={objectColors}
        />
      </div>

      {/* Bottom: timeline transport */}
      {timelineProps && (
        <div className="absolute bottom-3 left-3 right-3 mx-auto max-w-4xl">
          <Timeline {...timelineProps} />
        </div>
      )}

      {/* Exit + scene meta (top-center) */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-3">
        <Link
          to="/demos"
          className="rounded-md border border-white/10 bg-black/55 backdrop-blur-md px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
        >
          ← Demos
        </Link>
      </div>
        </>
      )}

      {/* Loading / empty state */}
      {!scene && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="rounded-lg bg-black/60 backdrop-blur-md px-5 py-3 text-sm text-slate-300">
            Loading scene…
          </div>
        </div>
      )}
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="rounded-lg bg-black/70 backdrop-blur-md px-5 py-4 text-sm text-slate-300 max-w-sm text-center">
            <div className="font-medium text-slate-100 mb-1">
              Scene bundle not found
            </div>
            <div className="text-slate-400">
              The tiles for <code className="text-slate-300">{dataset.id}</code>{" "}
              aren&apos;t generated yet. Run the{" "}
              <code className="text-slate-300">av_synthetic.py</code> adapter to
              build them.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AvCockpit;
