/**
 * Phone-width chrome for the AV telemetry cockpit (rendered by {@link AvCockpit}
 * below Tailwind's `md` breakpoint via {@link useIsMobile}). The desktop layout
 * scatters six floating glass panels around the edges — a 240px stream rail, a
 * 224px camera, a 256px chart panel, an inspector card, the switcher, and the
 * timeline — which collide and bury the map on a ~390px-wide screen. This
 * collapses that into a single-column layout that keeps the map the hero:
 *
 *   • a slim top bar (back · compact scene switcher · follow-ego + view toggles);
 *   • a small floating dashcam thumbnail beneath the bar;
 *   • a bottom sheet (a collapsed handle that expands to a scrollable panel) for
 *     the stream toggles + object legend + telemetry strips + attribution;
 *   • the picked-object inspector as a full-width card above the timeline;
 *   • the shared timeline transport pinned to the bottom.
 *
 * The deck itself ({@link AvDeck}) is identical to desktop — only the chrome
 * differs. Containers are `pointer-events-none` so their transparent gutters
 * never steal a map pan/pinch; the interactive blocks opt back in. Top and
 * bottom edges respect the iOS safe-area insets.
 */
import React, { useState } from "react";
import { Link } from "react-router-dom";
import type { TimeController } from "@poopdeck.gl/playback";
import type { Dataset, ColorRGBA } from "../../types";
import SceneSwitcher from "./SceneSwitcher";
import StreamPanel from "./StreamPanel";
import MetricCharts from "./MetricCharts";
import CameraInset from "./CameraInset";
import ObjectInspector, { type PickedObject } from "./ObjectInspector";
import Timeline, { type TimelineProps } from "./Timeline";
import type { AvScene, AvStreamKey, AvTelemetry, AvCameras } from "./sceneTypes";

export interface AvMobileChromeProps {
  scene: AvScene | null;
  dataset: Dataset;
  /** All AV scenes (for the switcher). */
  scenes: Dataset[];
  sceneName: string;
  timeController: TimeController;
  // Streams + legend
  presentStreams: AvStreamKey[];
  visibleStreams: Set<AvStreamKey>;
  onToggleStream: (s: AvStreamKey) => void;
  objectColors?: Record<string, ColorRGBA>;
  // Telemetry strips
  telemetry: AvTelemetry | null;
  hasTelemetry: boolean;
  // Camera inset
  cameras: AvCameras | null;
  hasCamera: boolean;
  resolveFrameUrl: (rel: string) => string;
  // Camera controls
  egoFollow: boolean;
  onToggleEgoFollow: () => void;
  egoPath: { t: number; lon: number; lat: number }[] | null;
  topDown: boolean;
  onToggleTopDown: () => void;
  /** Fill-rate performance mode (1× pixels + cheaper LIDAR fragments). */
  perfMode: boolean;
  onTogglePerfMode: () => void;
  /** Street basemap on/off (geo-registered scenes only; hidden on avLocalFrame). */
  showBasemap: boolean;
  onToggleBasemap: () => void;
  // Picked object
  selectedObject: PickedObject | null;
  onCloseObject: () => void;
  // Timeline transport (null until the time range resolves).
  timeline: TimelineProps | null;
}

const ICON = "h-[18px] w-[18px]";

const BackIcon = () => (
  <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

const FollowIcon = () => (
  <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="3.2" />
    <circle cx="12" cy="12" r="7.5" />
    <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
  </svg>
);

const CubeIcon = () => (
  <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden>
    <path d="M12 2.5l8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3z" />
    <path d="M12 12l8.5-4.7M12 12v9.5M12 12L3.5 7.3" />
  </svg>
);

const GridIcon = () => (
  <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
    <path d="M3.5 9.5h17M3.5 15h17M9.5 3.5v17M15 3.5v17" />
  </svg>
);

const BoltIcon = () => (
  <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" aria-hidden>
    <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z" />
  </svg>
);
const MapIcon = () => (
  <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" aria-hidden>
    <path d="M9 4L3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5z" />
    <path d="M9 4v13.5M15 6.5V20" />
  </svg>
);

const ChevronIcon: React.FC<{ up?: boolean }> = ({ up }) => (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
  </svg>
);

/** Compact glass icon-button used by the top-bar view toggles. */
const ToggleButton: React.FC<{
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
  children: React.ReactNode;
}> = ({ active, onClick, label, title, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    aria-label={label}
    title={title ?? label}
    className={`pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border backdrop-blur-md transition-colors ${
      active
        ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-100"
        : "border-white/10 bg-black/55 text-slate-300"
    }`}
  >
    {children}
  </button>
);

const AvMobileChrome: React.FC<AvMobileChromeProps> = ({
  scene,
  dataset,
  scenes,
  sceneName,
  timeController,
  presentStreams,
  visibleStreams,
  onToggleStream,
  objectColors,
  telemetry,
  hasTelemetry,
  cameras,
  hasCamera,
  resolveFrameUrl,
  egoFollow,
  onToggleEgoFollow,
  egoPath,
  topDown,
  onToggleTopDown,
  perfMode,
  onTogglePerfMode,
  showBasemap,
  onToggleBasemap,
  selectedObject,
  onCloseObject,
  timeline,
}) => {
  const [sheetOpen, setSheetOpen] = useState(false);
  const hasSheet = Boolean(scene) || hasTelemetry;

  return (
    <>
      {/* ── Top bar: back · scene switcher · view toggles ──────────────────── */}
      <header
        className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-2 bg-gradient-to-b from-black/70 via-black/40 to-transparent px-3 pb-4"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <Link
          to="/demos"
          aria-label="Back to demos"
          className="pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-slate-200 backdrop-blur-md"
        >
          <BackIcon />
        </Link>
        <div className="pointer-events-auto min-w-0 flex-1">
          <SceneSwitcher
            scenes={scenes}
            currentId={dataset.id}
            sceneName={sceneName}
            compact
          />
        </div>
        <ToggleButton
          active={egoFollow}
          onClick={onToggleEgoFollow}
          label="Follow vehicle"
          title={
            egoPath
              ? "Recenter the camera on the vehicle"
              : "Ego-follow (scene has no ego polyline — camera holds)"
          }
        >
          <FollowIcon />
        </ToggleButton>
        <ToggleButton
          active={topDown}
          onClick={onToggleTopDown}
          label="Toggle perspective / top-down view"
        >
          {topDown ? <GridIcon /> : <CubeIcon />}
        </ToggleButton>
        <ToggleButton
          active={perfMode}
          onClick={onTogglePerfMode}
          label="Performance mode"
          title="Performance mode — 1× pixels + cheaper LIDAR fragments for smooth dense clouds"
        >
          <BoltIcon />
        </ToggleButton>
        {/* Basemap on/off — geo-registered scenes only (no basemap is ever drawn
            for avLocalFrame scenes, so hide the control there). */}
        {!dataset.avLocalFrame && (
          <ToggleButton
            active={showBasemap}
            onClick={onToggleBasemap}
            label="Toggle the street basemap"
            title="Toggle the street basemap under the scene"
          >
            <MapIcon />
          </ToggleButton>
        )}
      </header>

      {/* ── Floating dashcam thumbnail (beneath the bar, right) ────────────── */}
      {hasCamera && (
        <div
          className="pointer-events-none absolute right-3 z-20 w-32"
          style={{ top: "calc(env(safe-area-inset-top) + 3.25rem)" }}
        >
          <CameraInset
            cameras={cameras!}
            resolveFrameUrl={resolveFrameUrl}
            timeController={timeController}
            className="w-full"
          />
        </div>
      )}

      {/* ── Bottom stack: sheet · inspector · timeline ─────────────────────── */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
        {/* Expandable sheet: stream toggles + legend + telemetry + attribution */}
        {hasSheet &&
          (sheetOpen ? (
            <div className="pointer-events-auto mx-3 mb-2 flex max-h-[45vh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/80 shadow-2xl backdrop-blur-md">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                <span className="text-[11px] uppercase tracking-wider text-slate-400">
                  Layers &amp; telemetry
                </span>
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  aria-label="Collapse panel"
                  aria-expanded
                  className="-mr-1 rounded p-1 text-slate-400 hover:text-slate-100"
                >
                  <ChevronIcon />
                </button>
              </div>
              <div className="space-y-3 overflow-y-auto overscroll-contain p-3">
                {scene && (
                  <StreamPanel
                    scene={scene}
                    presentStreams={presentStreams}
                    visibleStreams={visibleStreams}
                    onToggleStream={onToggleStream}
                    objectColors={objectColors}
                    className="w-full"
                    embedded
                  />
                )}
                {hasTelemetry && telemetry && (
                  <div className={scene ? "border-t border-white/10 pt-3" : ""}>
                    <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-400">
                      Telemetry
                    </div>
                    <MetricCharts
                      telemetry={telemetry}
                      timeController={timeController}
                      className="w-full"
                      embedded
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              aria-expanded={false}
              className="pointer-events-auto mx-3 mb-2 flex items-center justify-center gap-1.5 self-center rounded-full border border-white/10 bg-black/55 px-4 py-2 text-xs text-slate-300 backdrop-blur-md"
            >
              Layers &amp; telemetry
              <ChevronIcon up />
            </button>
          ))}

        {/* Picked-object inspector — full-width card above the timeline. */}
        {selectedObject && (
          <div className="pointer-events-auto mx-3 mb-2">
            <ObjectInspector
              object={selectedObject}
              onClose={onCloseObject}
              objectColors={objectColors}
              className="w-full"
            />
          </div>
        )}

        {/* Timeline transport (the shared component already carries its own
            glass card — just position it). */}
        {timeline && (
          <div className="pointer-events-auto mx-3">
            <Timeline {...timeline} />
          </div>
        )}
      </div>
    </>
  );
};

export default AvMobileChrome;
