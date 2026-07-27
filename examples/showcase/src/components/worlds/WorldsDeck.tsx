/**
 * The scenario-gallery DeckGL surface.
 *
 * Renders the synthetic grid of worlds on a dark, basemap-free MapView (the
 * cells are anchored to real lon/lat only because STT tiles are geographic —
 * there is no street network to show). Owns three things the layer builder
 * can't:
 *
 *   • CAMERA — a controlled `viewState` that flies to a scenario's cell on
 *     selection and back out on deselect (snapping instead of flying under
 *     reduced motion), plus a throttled zoom readout that gates the agent
 *     boxes and the hero LiDAR;
 *   • PICKING — a click on an anchor dot or an agent box selects that world;
 *     a click on empty space clears the selection;
 *   • SOURCE RECONCILIATION — the boxes and hero cloud mount conditionally, and
 *     an unmounted layer's governor source is NOT torn down on its own, so a
 *     hidden source would keep counting toward the buffer picture. The same
 *     idiom as AvDeck's stream-toggle reconciliation (`unregisterSource` is
 *     idempotent, so unregistering a never-registered id is a no-op).
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import DeckGL from '@deck.gl/react';
import { FlyToInterpolator } from '@deck.gl/core';
import type { TimeController } from '@poopdeck.gl/playback';
import type { SourceRegistry } from '@poopdeck.gl/react';
import {
  BOX_ZOOM,
  HERO_LIDAR_ZOOM,
  MAP_DETAIL_ZOOM,
  WORLD_LAYER_IDS,
  buildWorldsLayers,
} from './buildWorldsLayers';
import type {
  WorldFilterChip,
  WorldScenario,
  WorldsIndex,
} from './worldsTypes';
import type { WorldsDataset } from '../../types';

export interface WorldsDeckProps {
  dataset: WorldsDataset;
  worlds: WorldsIndex | null;
  worldsBase: string;
  timeController: TimeController;
  registry: SourceRegistry;
  chip: WorldFilterChip | null;
  selected: WorldScenario | null;
  reducedMotion: boolean;
  onSelect: (id: string | null) => void;
}

/** Detail-view framing when a world is selected. */
const DETAIL_ZOOM = 16.6;
const DETAIL_PITCH = 50;

/**
 * Overview framing computed from the grid the bundle actually shipped, so a
 * regenerated bundle with a different scenario count can't leave the camera
 * parked over empty ocean. Web-Mercator: one tile is 512 px, the world is
 * ~40,075 km at the equator (where the grid lives), so
 * `zoom = log2(worldMeters / (512 · metresPerPixel))`.
 */
function overviewCamera(
  worlds: WorldsIndex,
  fallback: {
    longitude: number;
    latitude: number;
    zoom?: number;
    pitch?: number;
    bearing?: number;
  },
) {
  const { rows, cols, pitchM, lat, lon } = worlds.grid;
  const extentM = Math.max(rows, cols) * pitchM;
  if (!Number.isFinite(extentM) || extentM <= 0) return fallback;
  // Assume a ~900 px viewport short side and leave ~12% margin around the grid.
  const metresPerPixel = (extentM * 1.12) / 900;
  const zoom = Math.log2(40075017 / (512 * metresPerPixel));
  return {
    longitude: lon,
    latitude: lat,
    zoom,
    pitch: fallback.pitch ?? 45,
    bearing: fallback.bearing ?? 0,
  };
}

const WorldsDeck: React.FC<WorldsDeckProps> = ({
  dataset,
  worlds,
  worldsBase,
  timeController,
  registry,
  chip,
  selected,
  reducedMotion,
  onSelect,
}) => {
  const [viewState, setViewState] = useState<any>(() => ({
    ...dataset.initialViewState,
  }));
  // Zoom drives conditional layers, so it lives in state — throttled to 0.05
  // steps (AvDeck's idiom) so a drag doesn't rebuild the layer tree per frame.
  const [zoom, setZoom] = useState<number>(
    () => dataset.initialViewState.zoom ?? 11.6,
  );
  const lastZoomRef = useRef(zoom);

  const applyViewState = useCallback((vs: any) => {
    setViewState(vs);
    if (
      typeof vs.zoom === 'number' &&
      Math.abs(vs.zoom - lastZoomRef.current) >= 0.05
    ) {
      lastZoomRef.current = vs.zoom;
      setZoom(vs.zoom);
    }
  }, []);

  // Fly to the selected world's cell; fly back to the overview on deselect.
  // Keyed on the id (not the object) so an unrelated worlds.json re-fetch
  // doesn't re-trigger the flight.
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    const overview = worlds
      ? overviewCamera(worlds, dataset.initialViewState as any)
      : {
          longitude: dataset.initialViewState.longitude,
          latitude: dataset.initialViewState.latitude,
          zoom: dataset.initialViewState.zoom ?? 11.6,
          pitch: dataset.initialViewState.pitch ?? 45,
          bearing: dataset.initialViewState.bearing ?? 0,
        };
    const target = selected
      ? {
          longitude: selected.origin.lon,
          latitude: selected.origin.lat,
          zoom: DETAIL_ZOOM,
          pitch: DETAIL_PITCH,
          bearing: 0,
        }
      : overview;
    setViewState({
      ...target,
      ...(reducedMotion
        ? { transitionDuration: 0 }
        : {
            transitionDuration: 'auto',
            transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }),
          }),
    });
    lastZoomRef.current = target.zoom ?? 11.6;
    setZoom(target.zoom ?? 11.6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, reducedMotion, worlds]);

  const layers = useMemo(
    () =>
      buildWorldsLayers({
        dataset,
        worlds,
        timeController,
        registry,
        chip,
        selected,
        zoom,
        worldsBase,
        reducedMotion,
      }),
    [
      dataset,
      worlds,
      timeController,
      registry,
      chip,
      selected,
      zoom,
      worldsBase,
      reducedMotion,
    ],
  );

  // Unregister the governor sources of layers that are currently unmounted, so
  // a zoomed-out gallery isn't waiting on a box/LiDAR source that no longer
  // loads. (Registration happens on mount via each layer's onTilesetReady.)
  const boxesMounted = zoom >= BOX_ZOOM;
  const heroMounted = !!selected?.hero && zoom >= HERO_LIDAR_ZOOM;
  // The HD map swaps representation at MAP_DETAIL_ZOOM: crisp lines/polys when
  // zoomed in, the LOD point overview when zoomed out. Drop whichever side is
  // unmounted so a hidden (optional) source doesn't linger in the buffer picture.
  const mapDetailMounted = zoom >= MAP_DETAIL_ZOOM;
  useEffect(() => {
    if (!boxesMounted)
      registry.unregisterSource(WORLD_LAYER_IDS.objects(dataset.id));
    if (!heroMounted)
      registry.unregisterSource(WORLD_LAYER_IDS.heroLidar(dataset.id));
    if (mapDetailMounted) {
      registry.unregisterSource(WORLD_LAYER_IDS.mapPoints(dataset.id));
    } else {
      registry.unregisterSource(WORLD_LAYER_IDS.mapPoly(dataset.id));
      registry.unregisterSource(WORLD_LAYER_IDS.mapLine(dataset.id));
    }
  }, [boxesMounted, heroMounted, mapDetailMounted, registry, dataset.id]);

  // Selecting a different hero swaps the LiDAR layer's data url under the same
  // layer id; drop the old source so the governor doesn't hold a stale handle.
  const heroId = selected?.hero ? selected.id : null;
  useEffect(() => {
    return () => {
      registry.unregisterSource(WORLD_LAYER_IDS.heroLidar(dataset.id));
    };
  }, [heroId, registry, dataset.id]);

  const handleClick = useCallback(
    (info: any) => {
      const layerId = String(info?.layer?.id ?? '');
      const obj = info?.object;
      if (!obj) {
        onSelect(null);
        return;
      }
      if (layerId.endsWith('-anchors')) {
        onSelect((obj as WorldScenario).id);
        return;
      }
      if (layerId.endsWith('-objects')) {
        // Agent boxes carry the baked `scenario_id` — clicking an agent selects
        // the world it belongs to.
        const props = obj.properties ?? obj;
        const sid = props.scenario_id ?? props.scenarioId;
        if (sid) onSelect(String(sid));
        return;
      }
      onSelect(null);
    },
    [onSelect],
  );

  return (
    <DeckGL
      viewState={viewState}
      onViewStateChange={(e: any) => applyViewState(e.viewState)}
      controller={{ dragRotate: true } as any}
      layers={layers}
      onClick={handleClick}
      pickingRadius={5}
      getCursor={({ isHovering }: any) => (isHovering ? 'pointer' : 'grab')}
      style={{ background: 'transparent' }}
    />
  );
};

export default WorldsDeck;
