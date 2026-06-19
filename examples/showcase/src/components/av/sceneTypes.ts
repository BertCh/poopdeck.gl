/**
 * Shared types + tiny client-side readers for the AV "scene bundle" sidecars
 * the cockpit consumes by path (docs/roadmap/av-cockpit.md §2). Everything the
 * deck layers need rides the STT archives; these are the small JSON sidecars the
 * cockpit chrome reads directly — the scene manifest, the CAN-bus gauge series,
 * and the camera keyframes.
 *
 * All timestamps are Unix-ms in the dataset's own clock (the same clock the
 * TimeController + STT layers animate on), so binary-searching at the playhead
 * lines the gauges/inset up with the rendered geometry.
 */
import type { ColorRGBA } from "../../types";

/** `scene.json` — the cockpit's source of truth (§2f). */
export interface AvScene {
  id: string;
  name: string;
  dataset?: string;
  datasetUrl?: string;
  license?: string;
  location?: string;
  description?: string;
  georef?: { originLat: number; originLon: number };
  timeRange: { start: number; end: number };
  initialView?: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
  };
  objectColors?: Record<string, ColorRGBA>;
  /** Present streams only; the cockpit shows a panel per key here. */
  streams?: Partial<
    Record<
      AvStreamKey,
      { url?: string; points?: number; categories?: string[] }
    >
  >;
}

export type AvStreamKey =
  | "lidar"
  | "ego"
  | "objects"
  | "map"
  | "telemetry"
  | "camera";

/** `telemetry.json` — CAN-bus gauges sidecar (§2d). */
export interface AvTelemetry {
  t0: number;
  hz?: number;
  fields: Record<string, AvTelemetryField>;
}

export interface AvTelemetryField {
  unit: string;
  label: string;
  /** [t_ms, value] pairs, sorted ascending by t_ms. */
  samples: [number, number][];
}

/** `cameras.json` — camera inset sidecar (§2e). */
export interface AvCameras {
  camera: string;
  /** url is relative to the scene dir (e.g. "cam/0001.jpg"). */
  frames: { t: number; url: string }[];
}

/**
 * Largest index `i` with `samples[i][0] <= t`, or -1 if `t` precedes the
 * first sample. Plain binary search over the sorted `[t, v]` series — called
 * every UI tick per gauge, so it stays allocation-free.
 */
export function sampleIndexAtOrBefore(
  samples: ArrayLike<[number, number]>,
  t: number,
): number {
  let lo = 0;
  let hi = samples.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** The active telemetry value at the playhead (clamped to the series ends). */
export function telemetryValueAt(
  field: AvTelemetryField,
  t: number,
): number | null {
  const { samples } = field;
  if (!samples || samples.length === 0) return null;
  const i = sampleIndexAtOrBefore(samples, t);
  if (i < 0) return samples[0][1];
  return samples[i][1];
}

/** Frame `{ t, url }` active at the playhead (the latest one at-or-before t). */
export function cameraFrameAt(
  cameras: AvCameras,
  t: number,
): { t: number; url: string } | null {
  const { frames } = cameras;
  if (!frames || frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Pre-start playhead: hold on the first frame.
  return ans < 0 ? frames[0] : frames[ans];
}
