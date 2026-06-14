// @poopdeck.gl/react
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/react contributors

/**
 * HoverPreview — a YouTube-style scrubber hover thumbnail: a small, independent
 * deck.gl instance that renders your layers AT a single frozen timestamp,
 * mirroring a supplied camera. Because a spatiotemporal map has no pre-baked
 * storyboard, the thumbnail is a real (coarse) render produced on demand.
 *
 * Renderer-agnostic about WHAT it draws: you supply `buildLayers(controller)`
 * (the frozen clock is handed in so your time-filtered layers read from it),
 * the `viewState` / `views`, the card size, and an optional `basemapUrl`. Pair
 * it with `PlaybackControls`' `renderPreview` prop.
 *
 * Cost note (opt-in feature): this is a SECOND WebGL context with its own
 * tileset/archive for the same data. Tiles it needs are largely the ones the
 * live loader already fetched, so the browser HTTP cache absorbs most of the
 * duplication; mount it only while the preview is visible.
 */
import React, { useMemo, useState, useEffect } from "react";
import DeckGL from "@deck.gl/react";
import { TimeController } from "@poopdeck.gl/playback";

export interface HoverPreviewProps {
  /** Settled hovered timestamp (sim-ms). */
  time: number;
  /** Full data range, used to seed the frozen clock. */
  timeRange?: { start: number; end: number };
  /**
   * Build the layers to render. The frozen preview clock is passed in — wire it
   * into your time-filtered layers so they paint the hovered instant. Called
   * once per mount (keyed to the controller identity).
   */
  buildLayers: (controller: TimeController) => unknown[];
  /** deck.gl viewState (camera) to render at. */
  viewState: unknown;
  /** deck.gl views (e.g. a GlobeView). Omit for the default map view. */
  views?: unknown;
  /** Card dimensions (px) — match these to the live viewport's aspect ratio. */
  width: number;
  height: number;
  /** Optional basemap image URL drawn behind the (transparent) deck canvas. */
  basemapUrl?: string | null;
  /** Background behind everything (default a dark surface). */
  background?: string;
  /** Forwarded to DeckGL `parameters` (e.g. `{ cull: true }` on a globe). */
  parameters?: unknown;
}

/**
 * NOTE: mount this keyed by your dataset/source id so a switch gives it a fresh
 * archive (the frozen controller + layer tree are seeded once per mount).
 */
export const HoverPreview: React.FC<HoverPreviewProps> = ({
  time,
  timeRange,
  buildLayers,
  viewState,
  views,
  width,
  height,
  basemapUrl,
  background = "#242730",
  parameters,
}) => {
  // A frozen clock the preview layers read from. speed 0 + never played; we
  // only ever poke it with setTime, which the layers observe as a tick.
  const [previewController] = useState(
    () => new TimeController({ initialTime: time, speed: 0, timeRange }),
  );
  useEffect(() => () => previewController.destroy(), [previewController]);

  // Drive the frame: the layers' tick handler turns this into a redraw + a
  // tileset update for the hovered time at the current camera.
  useEffect(() => {
    previewController.setTime(time);
  }, [previewController, time]);

  // Built once per mount — the layers read time from the controller via their
  // tick handler, so a new `time` is a redraw, not a rebuild. `buildLayers` is
  // expected to be stable for the controller's lifetime (mount the component
  // keyed by source id to rebuild on a data switch).
  const layers = useMemo(
    () => buildLayers(previewController),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewController],
  );

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        background,
        overflow: "hidden",
      }}
    >
      {/* Basemap behind the (transparent) deck canvas — omit on globe views,
          which render their own backdrop. */}
      {basemapUrl && (
        <img
          src={basemapUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          onError={(e) => {
            // Graceful fallback to the dark surface if the basemap errors.
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
      <DeckGL
        viewState={viewState as never}
        views={views as never}
        controller={false}
        layers={layers as never}
        parameters={parameters as never}
        style={{ position: "absolute", inset: "0" }}
      />
    </div>
  );
};
