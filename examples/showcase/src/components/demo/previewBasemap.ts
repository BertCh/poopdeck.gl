/**
 * Pure (React/deck-free) helpers for the scrubber hover preview, split out so
 * they're unit-testable without pulling in the whole deck.gl stack.
 */

const MAPBOX_ACCESS_TOKEN =
  (import.meta as any).env?.VITE_MAPBOX_TOKEN ||
  "pk.eyJ1IjoicmdjZ2VvZyIsImEiOiJjajBuNG1sMjUwMDFlMzNxcWY0M2RqMHI3In0.XfM0BMSqZqjRDcz-oJuadw";

/** The live camera, forwarded from DemoViewer's `onCameraChange`. */
export interface DemoCamera {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
  /** Live viewport pixel size (deck CSS px) — lets the preview match it exactly. */
  viewportWidth?: number;
  viewportHeight?: number;
}

/**
 * Fit a preview box to the live viewport's ASPECT RATIO within [maxW × maxH],
 * so the thumbnail is the same shape as what's on screen (not a fixed 16:9
 * crop). Falls back to 16:9 before the viewport size is known.
 */
export function fitPreviewSize(
  viewportWidth: number | undefined,
  viewportHeight: number | undefined,
  maxW = 264,
  maxH = 180,
): { width: number; height: number } {
  if (!viewportWidth || !viewportHeight || viewportWidth <= 0 || viewportHeight <= 0) {
    return { width: maxW, height: Math.round((maxW * 9) / 16) };
  }
  const aspect = viewportWidth / viewportHeight;
  let width = maxW;
  let height = Math.round(maxW / aspect);
  if (height > maxH) {
    height = maxH;
    width = Math.round(maxH * aspect);
  }
  return { width, height };
}

/**
 * The zoom that makes a `previewWidth`-wide viewport show the SAME ground
 * extent as the live `viewportWidth`-wide one at `mainZoom`. deck/mercator
 * extent ∝ width / 2^zoom, so the smaller preview must zoom OUT by
 * log2(previewWidth / viewportWidth). Identity when the size is unknown.
 */
export function previewZoom(
  mainZoom: number,
  previewWidth: number,
  viewportWidth: number | undefined,
): number {
  if (!viewportWidth || viewportWidth <= 0 || previewWidth <= 0) return mainZoom;
  return mainZoom + Math.log2(previewWidth / viewportWidth);
}

/**
 * Mapbox Static Images caps tilt at 60°; the cube demos look down the time
 * axis at up to 85°. Clamp BOTH the static basemap request and the preview
 * camera to the same value so the data overlay stays registered to the streets.
 */
export function clampPreviewPitch(pitch: number | undefined): number {
  return Math.max(0, Math.min(60, pitch ?? 0));
}

/**
 * Mapbox Static Images URL for `camera` at the preview's pixel size. Centered
 * on, and at the same zoom/bearing/(clamped)pitch as, the preview deck — so the
 * two line up exactly. `@2x` for crispness on HiDPI; chrome stripped.
 */
export function staticBasemapUrl(
  camera: DemoCamera,
  width: number,
  height: number,
  token: string = MAPBOX_ACCESS_TOKEN,
): string {
  const lon = camera.longitude;
  const lat = camera.latitude;
  const zoom = Math.max(0, Math.min(22, camera.zoom));
  const bearing = camera.bearing ?? 0;
  const pitch = clampPreviewPitch(camera.pitch);
  const pos = `${lon},${lat},${zoom},${bearing},${pitch}`;
  return (
    `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${pos}/` +
    `${Math.round(width)}x${Math.round(height)}@2x` +
    `?access_token=${token}&attribution=false&logo=false`
  );
}
