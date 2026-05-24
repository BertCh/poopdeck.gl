/**
 * MaplibreRenderer — mounts a MapLibre GL map and a single `@stt/maplibre`
 * custom layer for the supplied dataset. Drop into any page that already
 * owns a `TimeController`; this component subscribes to its `tick` event and
 * forwards `setCurrentTime` to the STT layer on every frame.
 *
 * Kept deliberately self-contained so it can sit next to the deck.gl
 * viewport on the DemoPage without leaking state.
 */

import React, { useEffect, useMemo, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  STTPointLayer,
  STTLineLayer,
  STTPolygonLayer,
  STTTripsLayer,
  STTHeatmapLayer,
  type STTBaseLayer,
  type RGBA8,
} from "@stt/maplibre";
import type { TimeController } from "@stt/deck.gl";
import type { Dataset } from "../types";

// CARTO's free dark style. We accept any style URL via prop, but this is the
// sensible default so we stay visually consistent with the deck.gl viewport
// (Mapbox dark-v11).
const DEFAULT_BASEMAP_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

export interface MaplibreRendererProps {
  dataset: Dataset;
  timeController: TimeController;
  /** Optional override for the basemap style URL or JSON. */
  basemapStyle?: string | maplibregl.StyleSpecification;
  /** Optional className applied to the outer container. */
  className?: string;
}

const MaplibreRenderer: React.FC<MaplibreRendererProps> = ({
  dataset,
  timeController,
  basemapStyle = DEFAULT_BASEMAP_STYLE,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const layerRef = useRef<STTBaseLayer | null>(null);

  // We snapshot the initial dataset so the dataset prop isn't accidentally
  // captured stale by the timeController subscription. Re-mounting on dataset
  // change is handled by React's keying — see the parent.
  const initialTime = useMemo(
    () => dataset.timeRange.start,
    [dataset.timeRange.start],
  );

  // Mount the map + STT layer once per (dataset, basemap) tuple.
  useEffect(() => {
    if (!containerRef.current) return;

    const view = dataset.initialViewState;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle,
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
      attributionControl: true,
    });
    mapRef.current = map;

    const sttLayer = makeSttLayer(dataset, initialTime);
    layerRef.current = sttLayer;

    map.on("load", () => {
      if (!sttLayer) return;
      map.addLayer(sttLayer as unknown as maplibregl.CustomLayerInterface);
    });

    return () => {
      layerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [dataset, basemapStyle, initialTime]);

  // Forward ticks → layer. We keep this in a separate effect so the
  // subscription survives a basemap-only swap.
  useEffect(() => {
    const onTick = (t: number) => {
      layerRef.current?.setCurrentTime(t);
    };
    timeController.on("tick", onTick);
    // Sync once on mount so the first frame doesn't render stale.
    layerRef.current?.setCurrentTime(timeController.getTime());
    return () => {
      timeController.off("tick", onTick);
    };
  }, [timeController]);

  return (
    <div ref={containerRef} className={className ?? "w-full h-full"} />
  );
};

export default MaplibreRenderer;

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

function makeSttLayer(
  dataset: Dataset,
  initialTime: number,
): STTBaseLayer | null {
  const base = {
    id: `stt-${dataset.id}`,
    url: dataset.url,
    currentTime: initialTime,
    timeWindow: dataset.timeWindow,
    autoRepaint: true,
  };
  switch (dataset.type) {
    case "point":
      return new STTPointLayer({
        ...base,
        color: [0.12, 0.73, 0.84, 0.95],
        radius: 4,
        colorProperty: dataset.colorProperty,
        radiusProperty: dataset.radiusProperty,
      });
    case "path":
      return new STTLineLayer({
        ...base,
        color: [1.0, 0.84, 0.0, 0.9],
        width: 2,
        colorProperty: dataset.colorProperty,
      });
    case "trips":
      return new STTTripsLayer({
        ...base,
        color: [0.12, 0.73, 0.84, 1],
        width: 2,
        trailLength: Math.max(dataset.timeWindow / 4, 30_000),
        colorProperty: dataset.colorProperty,
      });
    case "polygon":
      return new STTPolygonLayer({
        ...base,
        color: [0.94, 0.42, 0.13, 0.55],
        stroked: true,
        lineWidth: 1,
        lineColor: [0.2, 0.2, 0.25, 0.9],
        fillColorProperty: dataset.colorProperty,
      });
    case "heatmap": {
      const first = dataset.heatmapLayers?.[0];
      const colorRange: RGBA8[] | undefined = first?.colorRange as
        | RGBA8[]
        | undefined;
      return new STTHeatmapLayer({
        ...base,
        radiusPixels: first?.radiusPixels ?? 30,
        intensity: first?.intensity ?? 1,
        colorRange,
        weightProperty: first?.weightProperty ?? dataset.weightProperty,
      });
    }
    default:
      return null;
  }
}
