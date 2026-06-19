/**
 * Smooth, frame-rate-independent ego-follow camera for the AV cockpit.
 *
 * The previous ego-follow piped every {@link TimeController} tick through two
 * React state updates (cockpit `followTarget` → deck `viewState`) and eased the
 * camera with a fixed per-event factor (`v += (target - v) * 0.25`). Because
 * React coalesces those renders, the camera advanced in irregular wall-clock
 * steps — the "jerky and stilted" motion. Worse, the easing factor was applied
 * *per render event*, so its effective smoothing depended on how often React
 * happened to flush, not on elapsed time.
 *
 * This module replaces that with a single requestAnimationFrame loop (driven in
 * {@link AvDeck}) that samples the *desired* camera straight from the ego
 * polyline at the controller's live clock and eases toward it with a **time-
 * based exponential filter**: `alpha = 1 - exp(-dt / tau)`. Because `alpha` is
 * recomputed from the real elapsed `dt` each frame, the motion is identical
 * whether the loop runs at 30, 60 or 120 Hz, and it stays critically stable for
 * any frame delta. Everything here is pure + configurable so it can be unit
 * tested and tuned without touching the render code.
 */
import { egoSampleAt, type EgoPathPoint } from "./egoLayers";

/** Tunables for the ego-follow camera. See {@link DEFAULT_FOLLOW_CONFIG}. */
export interface FollowCameraConfig {
  /**
   * Position smoothing time constant in seconds — the camera closes ~63% of the
   * gap to the ego every `positionTau` s. Smaller snaps tighter to the car;
   * larger glides more (and lags more). 0 = no smoothing (snap).
   */
  positionTau: number;
  /**
   * Rotate the map so the ego's direction of travel points up the screen
   * (chase-cam feel). When false the camera keeps the user/dataset bearing and
   * only the centre tracks the car.
   */
  rotateToHeading: boolean;
  /** Bearing smoothing time constant in seconds (used only when rotateToHeading). */
  bearingTau: number;
  /** Zoom smoothing time constant in seconds (used only when `zoom` is set). */
  zoomTau: number;
  /**
   * Hold this zoom level while following. `undefined` leaves zoom to the user so
   * they can scroll freely; a number pins it (eased via `zoomTau`).
   */
  zoom?: number;
  /**
   * Look-ahead in milliseconds: aim the camera at where the ego *will* be in
   * `leadMs`, so the car sits a little lower in frame with more road ahead. 0
   * centres exactly on the live position.
   */
  leadMs: number;
}

/**
 * Calm, stable defaults — centre-tracking only (no rotation), zoom left to the
 * user. Tuned to read as a smooth glide rather than a rigid lock; flip
 * `rotateToHeading` on (and/or set `zoom`/`leadMs`) for a tighter chase cam.
 */
export const DEFAULT_FOLLOW_CONFIG: FollowCameraConfig = {
  positionTau: 0.35,
  rotateToHeading: false,
  bearingTau: 0.8,
  zoomTau: 0.5,
  zoom: undefined,
  leadMs: 0,
};

/**
 * Convert an ego heading (degrees, 0 = east, CCW positive — the convention the
 * ego layers use) to a deck/MapLibre bearing (degrees, 0 = north, CW positive).
 * Setting `viewState.bearing` to this value turns the map so the travel
 * direction points up the screen.
 */
export function headingToBearing(headingDeg: number): number {
  return (((90 - headingDeg) % 360) + 360) % 360;
}

/**
 * Frame-rate-independent exponential-smoothing factor for an elapsed `dtSec`
 * and time constant `tauSec`. Returns alpha ∈ [0, 1] such that
 * `v += (target - v) * alpha` advances ~63% of the remaining gap every `tau`
 * seconds, regardless of how large or small `dt` is. `tau <= 0` snaps (1);
 * `dt <= 0` holds (0).
 */
export function expAlpha(dtSec: number, tauSec: number): number {
  if (tauSec <= 0) return 1;
  if (dtSec <= 0) return 0;
  return 1 - Math.exp(-dtSec / tauSec);
}

/** Shortest signed angular delta `a`→`b` in degrees, in [-180, 180) (the
 *  antipodal case resolves to -180). */
export function shortestAngleDelta(a: number, b: number): number {
  return ((((b - a + 180) % 360) + 360) % 360) - 180;
}

/** Ease an angle (degrees) toward `target` along the shortest arc by `alpha`. */
export function smoothAngle(current: number, target: number, alpha: number): number {
  return current + shortestAngleDelta(current, target) * alpha;
}

/** The camera the follow loop is easing toward at a given time. */
export interface DesiredCamera {
  longitude: number;
  latitude: number;
  /** Present only when `config.rotateToHeading`. */
  bearing?: number;
  /** Present only when `config.zoom` is set. */
  zoom?: number;
}

/**
 * The camera target at `time`: the (lead-adjusted) interpolated ego position,
 * plus an optional travel-direction bearing and held zoom per `config`. Returns
 * null when the path is empty / unsampleable so the caller can hold the camera.
 */
export function desiredCameraAt(
  path: EgoPathPoint[] | null | undefined,
  time: number,
  config: FollowCameraConfig,
): DesiredCamera | null {
  const pose = egoSampleAt(path, time + config.leadMs);
  if (!pose) return null;
  const out: DesiredCamera = {
    longitude: pose.longitude,
    latitude: pose.latitude,
  };
  if (config.rotateToHeading) out.bearing = headingToBearing(pose.headingDeg);
  if (config.zoom !== undefined) out.zoom = config.zoom;
  return out;
}
