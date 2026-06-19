/**
 * Left-rail stream list for the AV cockpit (streetscape.gl's "stream settings"
 * panel). One toggle per stream present in `scene.json.streams`; flipping a
 * toggle mutates the parent's `visibleStreams` set, which the deck reads to omit
 * a layer (and its tile fetches). Missing streams simply don't appear — no hard
 * fail. Below the toggles, the tracked-object category color legend.
 */
import React from "react";
import type { ColorRGBA } from "../../types";
import type { AvScene, AvStreamKey } from "./sceneTypes";

const STREAM_LABELS: Record<AvStreamKey, string> = {
  lidar: "LIDAR point cloud",
  ego: "Ego trajectory",
  objects: "Tracked objects",
  map: "HD map",
  telemetry: "CAN telemetry",
  camera: "Camera",
};

/** Streams that map to a deck layer (and so are meaningfully toggleable). */
const LAYER_STREAMS: AvStreamKey[] = ["lidar", "ego", "objects", "map"];

const rgba = (c: ColorRGBA) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;

export interface StreamPanelProps {
  scene: AvScene;
  /** All streams declared present in scene.json. */
  presentStreams: AvStreamKey[];
  visibleStreams: Set<AvStreamKey>;
  onToggleStream: (stream: AvStreamKey) => void;
  objectColors?: Record<string, ColorRGBA>;
}

const StreamPanel: React.FC<StreamPanelProps> = ({
  scene,
  presentStreams,
  visibleStreams,
  onToggleStream,
  objectColors,
}) => {
  const toggleable = presentStreams.filter((s) => LAYER_STREAMS.includes(s));
  const sidecars = presentStreams.filter((s) => !LAYER_STREAMS.includes(s));
  const categories = objectColors ? Object.entries(objectColors) : [];

  return (
    <div className="rounded-lg border border-white/10 bg-black/55 backdrop-blur-md p-3 text-slate-200 shadow-xl w-60">
      <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">
        Streams
      </div>

      <ul className="space-y-1">
        {toggleable.map((s) => {
          const on = visibleStreams.has(s);
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => onToggleStream(s)}
                aria-pressed={on}
                className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-white/5 transition-colors"
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-sm border ${
                    on
                      ? "border-cyan-300 bg-cyan-400/80"
                      : "border-white/25 bg-transparent"
                  }`}
                  aria-hidden
                />
                <span className={on ? "text-slate-100" : "text-slate-500"}>
                  {STREAM_LABELS[s]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {sidecars.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/10">
          {sidecars.map((s) => (
            <div
              key={s}
              className="flex items-center gap-2 px-2 py-1 text-xs text-slate-400"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {STREAM_LABELS[s]}
            </div>
          ))}
        </div>
      )}

      {categories.length > 0 && visibleStreams.has("objects") && (
        <div className="mt-3 pt-2 border-t border-white/10">
          <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
            Object classes
          </div>
          <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
            {categories.map(([cat, color]) => (
              <li key={cat} className="flex items-center gap-1.5 text-[11px]">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm shrink-0"
                  style={{ background: rgba(color) }}
                  aria-hidden
                />
                <span className="text-slate-300 truncate" title={cat}>
                  {cat.replace(/_/g, " ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(scene.dataset || scene.license) && (
        <div className="mt-3 pt-2 border-t border-white/10 text-[10px] leading-snug text-slate-500">
          {scene.dataset && (
            <div>
              Source:{" "}
              {scene.datasetUrl ? (
                <a
                  href={scene.datasetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 underline decoration-dotted"
                >
                  {scene.dataset}
                </a>
              ) : (
                scene.dataset
              )}
            </div>
          )}
          {scene.license && <div>License: {scene.license}</div>}
        </div>
      )}
    </div>
  );
};

export default StreamPanel;
