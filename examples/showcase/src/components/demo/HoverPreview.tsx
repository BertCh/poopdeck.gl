/**
 * YouTube-style scrubber hover preview: a small, independent deck.gl instance
 * that renders the dataset's layers AT the hovered timestamp, mirroring the
 * live camera. Because a spatiotemporal map has no pre-baked storyboard, the
 * thumbnail is a real (coarse) render produced on demand when the cursor
 * settles — see the "live render on hover" option in the player-preview design.
 *
 * Cost note (opt-in feature): this is a SECOND WebGL context with its own
 * tileset/archive for the same data URL. Tiles it needs are largely the ones
 * the live loader already fetched, so the browser HTTP cache absorbs most of
 * the duplication; it stays mounted only while the preview toggle is on.
 *
 * The frame comes from the layers themselves: setting `previewController` time
 * fires the layers' tick handler → `setNeedsRedraw()` (and a tileset update for
 * the hovered time at the current camera), so we never poke deck directly.
 */
import React, { useMemo, useState, useEffect } from "react";
import DeckGL from "@deck.gl/react";
import { _GlobeView as GlobeView } from "@deck.gl/core";
import { TimeController } from "@stt/deck.gl";
import type { Dataset } from "../../types";
import { buildDemoLayers } from "./buildDemoLayers";
import {
  clampPreviewPitch,
  fitPreviewSize,
  previewZoom,
  staticBasemapUrl,
  type DemoCamera,
} from "./previewBasemap";

export type { DemoCamera } from "./previewBasemap";

export interface HoverPreviewProps {
  dataset: Dataset;
  /** Camera to mirror; null until DemoViewer reports one (renders nothing). */
  camera: DemoCamera | null;
  /** Settled hovered timestamp (sim-ms). */
  time: number;
  /** Upper bounds for the card; actual size matches the live viewport aspect. */
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * NOTE: mount this keyed by `dataset.id` so a dataset switch gives it a fresh
 * archive (the frozen controller and layer tree are seeded once per dataset).
 */
const HoverPreview: React.FC<HoverPreviewProps> = ({
  dataset,
  camera,
  time,
  maxWidth = 264,
  maxHeight = 180,
}) => {
  const useGlobe = dataset.useGlobe ?? false;

  // A frozen clock the preview layers read from. speed 0 + never played; we
  // only ever poke it with setTime, which the layers observe as a tick.
  const [previewController] = useState(
    () =>
      new TimeController({
        initialTime: time,
        speed: 0,
        timeRange: dataset.timeRange,
      }),
  );
  useEffect(() => () => previewController.destroy(), [previewController]);

  // Drive the frame: the layers' tick handler turns this into a redraw + a
  // tileset update for the hovered time at the current camera.
  useEffect(() => {
    previewController.setTime(time);
  }, [previewController, time]);

  // Same layer tree as the live view (shared builder), but flat (no cube) and
  // with no governor/overview plumbing — this render is a throwaway.
  const layers = useMemo(
    () =>
      buildDemoLayers({
        dataset,
        timeController: previewController,
        useGlobe,
        timeHeightScale: 0,
      }),
    [dataset, previewController, useGlobe],
  );

  const views = useMemo(
    () => (useGlobe ? [new GlobeView({ id: "globe", resolution: 10 })] : undefined),
    [useGlobe],
  );

  if (!camera) return null;

  // Match the live viewport: same aspect ratio (card shape) AND the zoom that
  // makes this smaller box cover the SAME ground extent — so it reads as a
  // scaled-down copy, not a centered crop. Globe has no fixed mercator extent,
  // so it just mirrors the camera at the same zoom.
  const { width, height } = fitPreviewSize(
    camera.viewportWidth,
    camera.viewportHeight,
    maxWidth,
    maxHeight,
  );
  const zoom = useGlobe
    ? camera.zoom
    : previewZoom(camera.zoom, width, camera.viewportWidth);

  // Clamp pitch so the (mercator) basemap and the data overlay agree.
  const cam: DemoCamera = {
    ...camera,
    zoom,
    pitch: clampPreviewPitch(camera.pitch),
  };
  const viewState: any = useGlobe ? { globe: cam } : cam;

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        background: "#242730",
        overflow: "hidden",
      }}
    >
      {/* Mercator basemap behind the (transparent) deck canvas. Globe demos
          render their own dark earth polygon, so they skip this. */}
      {!useGlobe && (
        <img
          src={staticBasemapUrl(cam, width, height)}
          alt=""
          aria-hidden="true"
          draggable={false}
          onError={(e) => {
            // Graceful fallback to the dark surface if the static API errors.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      )}
      {/* Sizes to the wrapper (absolute inset-0), like DemoViewer's deck. */}
      <DeckGL
        viewState={viewState}
        views={views}
        controller={false}
        layers={layers}
        parameters={useGlobe ? ({ cull: true } as any) : undefined}
        style={{ position: "absolute", inset: "0" }}
      />
    </div>
  );
};

export default HoverPreview;
