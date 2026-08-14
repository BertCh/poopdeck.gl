import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import DeckGL from '@deck.gl/react';
import { _GlobeView as GlobeView } from '@deck.gl/core';
import { SolidPolygonLayer } from '@deck.gl/layers';
import { AnimatedTripsLayer } from '@poopdeck.gl/layers';
import { PlaybackGovernor, TimeController } from '@poopdeck.gl/playback';
import type { BufferSource, BufferedRunway } from '@poopdeck.gl/playback';
import { getDatasetById } from '../../datasets';
import { calculateAnimationSpeed, tileLoadingProps } from '../../types';
import { useReducedMotion } from '../../lib/reducedMotion';

/**
 * The live rotating drifter globe on the landing hero.
 *
 * Split out of HomePage so ALL deck.gl/playback imports live here: HomePage
 * lazy-imports this behind a <ClientOnly> boundary, so the statically
 * prerendered landing HTML carries none of it — the globe chunk streams in
 * only after client hydration.
 */

// A single full-sphere quad gives the globe a light "ocean" backdrop (matching
// the paper page) and occludes the back-side tracks, so the drifter ribbons
// read as a planet rather than a tangle of overlapping lines.
const EARTH_POLYGON: number[][][] = [
  [
    [-180, 90],
    [0, 90],
    [180, 90],
    [180, -90],
    [0, -90],
    [-180, -90],
  ],
];

// Degrees of longitude the globe spins per second. Negative spins east→west,
// following the prevailing winds; very slow (~6 min per revolution).
const DEG_PER_SEC = -1;

const HomeGlobe: React.FC = () => {
  // The hero globe draws one TRIPS archive (the drifter tracks); a dataset of
  // any other family carries none of the trail props this layer reads.
  const hero = getDatasetById('ocean-drifters');
  const heroDataset = hero?.type === 'trips' ? hero : undefined;

  // When the viewer has asked the OS to reduce motion, the hero holds still: no
  // autoplay of the drifter trails and no globe spin. Reactive, so toggling the
  // setting re-runs the effects below and starts/stops the motion live.
  const reducedMotion = useReducedMotion();

  const baseAnimationSpeed = useMemo(() => {
    if (!heroDataset) return 1000;
    return calculateAnimationSpeed(heroDataset);
  }, [heroDataset]);

  const [timeController] = useState(
    () =>
      new TimeController({
        initialTime: heroDataset?.timeRange.start || 0,
        speed: baseAnimationSpeed,
        loop: true,
        timeRange: heroDataset?.timeRange,
      }),
  );

  // The trips layer reads the live time straight from `timeController` on every
  // draw, so we deliberately don't re-render this page on every tick.
  //
  // Don't play on mount: tiles stream from R2, and starting before the first
  // fixes load would skip past the earliest drifters (off the west coast of S.
  // America). The PlaybackGovernor holds the clock at timeRange.start in its
  // 'starting' state until the tileset reports a genuinely buffered runway,
  // with maxStartWaitMs as the same 4 s escape hatch the old first-tile gate
  // had — a slow or failed load never leaves the globe frozen.
  //
  // Created inside the effect (not useState): dispose() is terminal, and React
  // StrictMode's dev mount→cleanup→remount would otherwise revive a dead
  // instance whose requestPlay() silently no-ops. tilesetRef replays the
  // layer's one-shot onTilesetReady handover to a freshly created governor.
  const governorRef = useRef<PlaybackGovernor | null>(null);
  const tilesetRef = useRef<BufferSource | null>(null);
  useEffect(() => {
    const g = new PlaybackGovernor(timeController, { maxStartWaitMs: 4000 });
    governorRef.current = g;
    if (tilesetRef.current) g.setSource(tilesetRef.current);
    // Honor reduce-motion: leave the hero paused on its first frame (a live
    // "poster") instead of autoplaying the trails.
    if (!reducedMotion) g.requestPlay();
    return () => {
      governorRef.current = null;
      g.dispose();
      timeController.pause();
    };
  }, [timeController, reducedMotion]);

  const handleTilesetReady = useCallback((tileset: BufferSource) => {
    tilesetRef.current = tileset;
    governorRef.current?.setSource(tileset);
  }, []);
  const handleBufferChange = useCallback(
    (runway: BufferedRunway) => governorRef.current?.notifyBufferChange(runway),
    [],
  );

  const views = useMemo(
    () => [new GlobeView({ id: 'globe', resolution: 10 })],
    [],
  );

  // Open centered on the west coast of South America (the Humboldt Current) and
  // slowly spin. A requestAnimationFrame loop nudges the longitude each frame;
  // user drags flow back through onViewStateChange so the spin just resumes.
  const [viewState, setViewState] = useState<any>({
    globe: { longitude: -78, latitude: -20, zoom: 1.8, pitch: 0, bearing: 0 },
  });
  useEffect(() => {
    if (reducedMotion) return; // reduce-motion: keep the globe still
    let raf = 0;
    let last: number | null = null;
    const step = (now: number) => {
      if (last != null && now - last < 33) {
        raf = requestAnimationFrame(step);
        return;
      }
      const dt = last == null ? 0 : (now - last) / 1000;
      last = now;
      setViewState((vs: any) => {
        const cur = vs.globe;
        const longitude =
          ((cur.longitude + DEG_PER_SEC * dt + 540) % 360) - 180;
        return { globe: { ...cur, longitude } };
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  const layers = useMemo(() => {
    if (!heroDataset) return [];
    const g = heroDataset.tripGradient;
    return [
      new SolidPolygonLayer({
        id: 'hero-earth',
        data: EARTH_POLYGON,
        getPolygon: (d) => d as any,
        stroked: false,
        filled: true,
        getFillColor: [240, 240, 236, 255],
      }),
      new AnimatedTripsLayer({
        id: 'hero-drifters',
        data: heroDataset.url,
        currentTime: heroDataset.timeRange.start,
        timeController,
        timeWindow: heroDataset.timeWindow,
        timeRange: heroDataset.timeRange,
        // Shared prefetch/concurrency recipe — same budget the demo page
        // computes for this dataset, so the hero streams identically.
        ...tileLoadingProps(
          heroDataset.timeWindow ?? 86400000,
          baseAnimationSpeed,
        ),
        useGlobalBounds: true,
        zoomOverride: 0,
        // Start gating: the governor begins the hero animation once the
        // tileset reports a real buffered runway, so the earliest drifters
        // are on screen when playback starts instead of already scrolled
        // past while R2 was still loading.
        onTilesetReady: handleTilesetReady,
        onBufferChange: handleBufferChange,
        ...(g && {
          gradientProperty: g.property,
          gradientDomain: g.domain,
          gradientColorRamp: g.colors,
        }),
        ...(heroDataset.colorMappingDefault && {
          colorMappingDefault: heroDataset.colorMappingDefault,
        }),
        tripWidth: heroDataset.tripWidth ?? 1.5,
        widthMinPixels: heroDataset.widthMinPixels ?? 1,
        widthMaxPixels: heroDataset.widthMaxPixels ?? 3,
        trailLength: heroDataset.trailLength ?? 60000,
        fadeTrail: heroDataset.fadeTrail ?? true,
        opacity: heroDataset.opacity ?? 0.85,
        pickable: false,
      }),
    ];
  }, [
    heroDataset,
    timeController,
    baseAnimationSpeed,
    handleTilesetReady,
    handleBufferChange,
  ]);

  return (
    <DeckGL
      views={views}
      viewState={viewState}
      onViewStateChange={(e: any) => setViewState({ globe: e.viewState })}
      controller={true}
      layers={layers}
      parameters={{ cull: true } as any}
    />
  );
};

export default HomeGlobe;
