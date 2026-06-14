import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import DeckGL from "@deck.gl/react";
import { _GlobeView as GlobeView } from "@deck.gl/core";
import { SolidPolygonLayer } from "@deck.gl/layers";
import { AnimatedTripsLayer } from "@poopdeck.gl/layers";
import { PlaybackGovernor, TimeController } from "@poopdeck.gl/playback";
import type { BufferSource, BufferedRunway } from "@poopdeck.gl/playback";
import { getDatasetById, navDatasets } from "../datasets";
import { calculateAnimationSpeed, tileLoadingProps } from "../types";
import { SourceLogo } from "../components/SourceLogo";

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

const HomePage: React.FC = () => {
  const heroDataset = getDatasetById("ocean-drifters");

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
    g.requestPlay();
    return () => {
      governorRef.current = null;
      g.dispose();
      timeController.pause();
    };
  }, [timeController]);

  const handleTilesetReady = useCallback((tileset: BufferSource) => {
    tilesetRef.current = tileset;
    governorRef.current?.setSource(tileset);
  }, []);
  const handleBufferChange = useCallback(
    (runway: BufferedRunway) => governorRef.current?.notifyBufferChange(runway),
    [],
  );

  const views = useMemo(
    () => [new GlobeView({ id: "globe", resolution: 10 })],
    [],
  );

  // Open centered on the west coast of South America (the Humboldt Current) and
  // slowly spin. A requestAnimationFrame loop nudges the longitude each frame;
  // user drags flow back through onViewStateChange so the spin just resumes.
  const [viewState, setViewState] = useState<any>({
    globe: { longitude: -78, latitude: -20, zoom: 1.8, pitch: 0, bearing: 0 },
  });
  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const step = (now: number) => {
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
  }, []);

  const layers = useMemo(() => {
    if (!heroDataset) return [];
    const g = heroDataset.tripGradient;
    return [
      new SolidPolygonLayer({
        id: "hero-earth",
        data: EARTH_POLYGON,
        getPolygon: (d) => d as any,
        stroked: false,
        filled: true,
        getFillColor: [240, 240, 236, 255],
      }),
      new AnimatedTripsLayer({
        id: "hero-drifters",
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

  // The curated demos for the quiet index below the hero.
  const featured = navDatasets.slice(0, 6);

  return (
    // Scroll is owned by SiteChrome's container; this page just flows.
    <div
      className="min-h-full flex flex-col"
      style={{ background: "var(--page-bg)" }}
    >
      {/* Hero */}
      <div className="flex flex-col lg:flex-row lg:min-h-[490px]">
        {/* Left: content */}
        <div className="lg:w-[46%] flex flex-col justify-center px-5 sm:px-7 lg:px-12 py-8 sm:py-10 order-2 lg:order-1">
          <div className="max-w-md">
            <span className="eyebrow">Navigation &amp; observation</span>
            <h1
              className="font-display text-2xl sm:text-3xl lg:text-[2.6rem] font-bold mt-3 mb-5"
              style={{ color: "var(--ink-900)", lineHeight: 1.1 }}
            >
              poopdeck<span style={{ color: "var(--ink-400)" }}>.gl</span>
            </h1>

            <p
              className="text-base mb-4"
              style={{ color: "var(--ink-700)", lineHeight: 1.7 }}
            >
              Time-aware{" "}
              <a
                href="https://deck.gl"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)" }}
              >
                deck.gl
              </a>{" "}
              layers and a tile format for streaming animated geospatial data —
              built for things that move: ships, drifters, cars, and anything
              with a trace.
            </p>

            <div className="flex flex-wrap gap-3">
              <Link
                to="/story/drifters"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-sm font-medium transition-opacity"
                style={{ background: "var(--accent)", color: "#FFFFFF" }}
                onMouseOver={(e) => (e.currentTarget.style.opacity = "0.9")}
                onMouseOut={(e) => (e.currentTarget.style.opacity = "1")}
              >
                Read the drifters story <span>→</span>
              </Link>
              <Link
                to="/demos"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-sm font-medium transition-colors"
                style={{
                  border: "1px solid var(--hairline)",
                  color: "var(--ink-700)",
                }}
                onMouseOver={(e) =>
                  (e.currentTarget.style.borderColor = "var(--accent)")
                }
                onMouseOut={(e) =>
                  (e.currentTarget.style.borderColor = "var(--hairline)")
                }
              >
                View demos <span>→</span>
              </Link>
            </div>
          </div>
        </div>

        {/* Right: rotating globe (dark canvas) */}
        <div className="lg:w-[54%] h-56 sm:h-72 lg:h-auto order-1 lg:order-2 lg:min-h-[490px] p-3 sm:p-4 lg:p-6">
          <div className="w-full h-full rounded-lg overflow-hidden map-viewport relative">
            <DeckGL
              views={views}
              viewState={viewState}
              onViewStateChange={(e: any) =>
                setViewState({ globe: e.viewState })
              }
              controller={true}
              layers={layers}
              parameters={{ cull: true } as any}
            />

            <div
              className="absolute top-3 left-3 px-2.5 py-1 rounded text-xs glass"
              style={{ color: "rgba(255,255,255,0.85)" }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle"
                style={{ background: "#28B4C8" }}
              />
              Ocean current drifters
            </div>
          </div>
        </div>
      </div>

      {/* Quiet demo index */}
      <div
        className="px-5 sm:px-7 lg:px-12 py-8 sm:py-10"
        style={{ borderTop: "1px solid var(--hairline)" }}
      >
        <span className="eyebrow">Demos</span>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 sm:gap-x-8 gap-y-5 sm:gap-y-6 mt-4 max-w-4xl">
          {featured.map((d) => (
            <Link key={d.id} to={`/demos/${d.id}`} className="group block">
              <h3
                className="text-sm font-medium transition-colors"
                style={{ color: "var(--ink-900)" }}
                onMouseOver={(e) =>
                  (e.currentTarget.style.color = "var(--accent)")
                }
                onMouseOut={(e) =>
                  (e.currentTarget.style.color = "var(--ink-900)")
                }
              >
                {d.name}
              </h3>
              <p
                className="text-xs mt-1 line-clamp-2"
                style={{ color: "var(--ink-500)", lineHeight: 1.5 }}
              >
                {d.description}
              </p>
              {d.sources && d.sources.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                  {d.sources.map((s) => (
                    <SourceLogo key={s} id={s} />
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>

        {/* Quiet pointers into the full catalog and the documentation. */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-8">
          <Link
            to="/demos"
            className="text-sm font-medium transition-colors"
            style={{ color: "var(--accent)" }}
          >
            All demos →
          </Link>
          <Link
            to="/docs"
            className="text-sm font-medium transition-colors"
            style={{ color: "var(--accent)" }}
          >
            Documentation →
          </Link>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
