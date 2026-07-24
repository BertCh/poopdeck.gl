import React from 'react';
import { Link } from 'react-router';
import PipelineFlow from '../components/how/PipelineFlow';
import SpaceTimeDiagram from '../components/how/SpaceTimeDiagram';
import CoverLookback from '../components/how/CoverLookback';
import TrajectoryClipping from '../components/how/TrajectoryClipping';
import ArchiveAnatomy from '../components/how/ArchiveAnatomy';
import TileAnatomy from '../components/how/TileAnatomy';
import DecodePipeline from '../components/how/DecodePipeline';
import PlaybackDiagram from '../components/how/PlaybackDiagram';
import TechniquesGrid from '../components/how/TechniquesGrid';
import BuildIntelligence from '../components/how/BuildIntelligence';
import PackagesMap from '../components/how/PackagesMap';
import ParityKernel from '../components/how/ParityKernel';
import DesignDecisions from '../components/how/DesignDecisions';
import { useReducedMotion } from '../lib/reducedMotion';

/**
 * `/how-it-works` — the visual explainer for STT itself: the build→publish→
 * play pipeline, the space+time tiling idea, the archive and tile anatomy,
 * the video-style streaming model, and the component map. All diagrams are
 * hand-authored HTML/SVG on the site's design tokens; the only JS-driven
 * motion (the drifting playhead) gates on `useReducedMotion`.
 */

interface SectionDef {
  id: string;
  n: string;
  kicker: string;
  title: string;
  toc: string;
}

const SECTIONS: SectionDef[] = [
  {
    id: 'pipeline',
    n: '01',
    kicker: 'The pipeline',
    title: 'Four stages, no servers',
    toc: 'Pipeline',
  },
  {
    id: 'space-time',
    n: '02',
    kicker: 'The idea',
    title: 'Tiles cut in space and time',
    toc: 'Space × time',
  },
  {
    id: 'archive',
    n: '03',
    kicker: 'The archive',
    title: 'Three files, three round trips',
    toc: 'Archive',
  },
  {
    id: 'tile',
    n: '04',
    kicker: 'The payload',
    title: 'Inside a tile',
    toc: 'Tile',
  },
  {
    id: 'playback',
    n: '05',
    kicker: 'The runtime',
    title: 'Streamed like video',
    toc: 'Playback',
  },
  {
    id: 'techniques',
    n: '06',
    kicker: 'The levers',
    title: 'What keeps it small and smooth',
    toc: 'Techniques',
  },
  {
    id: 'intelligence',
    n: '07',
    kicker: 'The analyst',
    title: 'The build tunes itself',
    toc: 'Intelligence',
  },
  {
    id: 'parts',
    n: '08',
    kicker: 'The parts',
    title: 'Crates and packages',
    toc: 'Parts',
  },
  {
    id: 'design',
    n: '09',
    kicker: 'Rationale',
    title: "Why it's built this way",
    toc: 'Design',
  },
];

const Section: React.FC<{
  def: SectionDef;
  lede: React.ReactNode;
  children: React.ReactNode;
}> = ({ def, lede, children }) => (
  <section id={def.id} className="mt-14 sm:mt-16 scroll-mt-6">
    <div className="flex items-baseline gap-2">
      <span
        className="font-mono text-[11px] font-semibold"
        style={{ color: 'var(--accent)' }}
      >
        {def.n}
      </span>
      <span className="eyebrow">{def.kicker}</span>
    </div>
    <h2
      className="text-xl sm:text-2xl font-semibold mt-1.5"
      style={{
        color: 'var(--ink-900)',
        fontFamily: '"Fraunces", Georgia, serif',
        letterSpacing: '-0.02em',
      }}
    >
      {def.title}
    </h2>
    <p
      className="text-[13px] mt-2 mb-5 max-w-2xl"
      style={{ color: 'var(--ink-500)', lineHeight: 1.7 }}
    >
      {lede}
    </p>
    {children}
  </section>
);

const NEXT_LINKS: { to: string; title: string; blurb: string }[] = [
  {
    to: '/docs/architecture/system-overview',
    title: 'System Overview',
    blurb: 'The same architecture in prose, with links into every subsystem.',
  },
  {
    to: '/docs/spec/stt-packed-format',
    title: 'Packed Format spec',
    blurb: 'The normative directory, pack and manifest contract.',
  },
  {
    to: '/docs/intro/concepts',
    title: 'Core Concepts',
    blurb: 'Time windows, temporal LOD and optimistic rendering, defined.',
  },
  {
    to: '/demos',
    title: 'The demos',
    blurb: 'Every technique on this page, running on real datasets.',
  },
];

const HowItWorks: React.FC = () => {
  const reduced = useReducedMotion();

  const jump = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
  };

  return (
    <div className="min-h-full px-5 sm:px-7 lg:px-12 py-8 sm:py-12">
      <div className="max-w-5xl">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <span className="eyebrow">Architecture</span>
        <h1
          className="text-3xl sm:text-4xl font-semibold mt-2"
          style={{
            color: 'var(--ink-900)',
            fontFamily: '"Fraunces", Georgia, serif',
            letterSpacing: '-0.02em',
            lineHeight: 1.12,
          }}
        >
          How spatiotemporal tiles work
        </h1>
        <p
          className="text-sm mt-4 max-w-2xl"
          style={{ color: 'var(--ink-700)', lineHeight: 1.75 }}
        >
          Map tiles solved "the world is too big to send" by cutting space into
          a pyramid. STT applies the same cut to time: every tile is also sliced
          into time buckets, packed into static files, and streamed like video —
          buffered ahead of a playhead, animated entirely on the GPU. This page
          is the whole system, end to end.
        </p>

        <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-1.5">
          {SECTIONS.map((s) => (
            // Accent on hover as CSS, not onMouseOver/onMouseOut writing
            // `style`: these section chips are the keyboard route through the
            // page, and the JS version highlighted nothing on Tab.
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={jump(s.id)}
              className="rounded-full px-3 py-1 text-[11px] font-medium transition-colors border [color:var(--ink-500)] [border-color:var(--hairline)] hover:[color:var(--accent)] hover:[border-color:var(--accent)] focus-visible:[color:var(--accent)] focus-visible:[border-color:var(--accent)]"
              style={{ background: 'var(--surface)' }}
            >
              {s.n} · {s.toc}
            </a>
          ))}
        </nav>

        {/* ── 01 Pipeline ──────────────────────────────────────────────── */}
        <Section
          def={SECTIONS[0]}
          lede={
            <>
              One Rust CLI turns timestamped rows into an archive of static
              files; one TypeScript reader streams them into any renderer.
              Between the two there is only an object store — nothing computes
              per request.
            </>
          }
        >
          <PipelineFlow />
        </Section>

        {/* ── 02 Space × time ──────────────────────────────────────────── */}
        <Section
          def={SECTIONS[1]}
          lede={
            <>
              A classic tile is addressed by (z, x, y). An STT tile adds a
              fourth coordinate: the start of its time bucket. That one extra
              axis is what makes a map scrubbable — the viewer fetches only the
              buckets around the playhead, for only the tiles in view.
            </>
          }
        >
          <SpaceTimeDiagram />
          <div className="mt-4">
            <CoverLookback />
          </div>
          <div className="mt-4">
            <TrajectoryClipping />
          </div>
        </Section>

        {/* ── 03 Archive ───────────────────────────────────────────────── */}
        <Section
          def={SECTIONS[2]}
          lede={
            <>
              Millions of tiles would mean millions of URLs. Instead the archive
              is a handful of immutable, content-addressed objects: a directory
              that knows where every tile lives, and packs read by HTTP range.
              Anything that can serve a static file can serve STT.
            </>
          }
        >
          <ArchiveAnatomy />
        </Section>

        {/* ── 04 Tile ──────────────────────────────────────────────────── */}
        <Section
          def={SECTIONS[3]}
          lede={
            <>
              Each tile is columnar Apache Arrow — the layout GPUs and analytics
              engines already speak. Four required columns describe points,
              paths and polygons in time; optional columns layer on trips,
              per-vertex values, splats and pre-aggregation.
            </>
          }
        >
          <TileAnatomy />
          <div className="mt-4">
            <DecodePipeline />
          </div>
        </Section>

        {/* ── 05 Playback ──────────────────────────────────────────────── */}
        <Section
          def={SECTIONS[4]}
          lede={
            <>
              The runtime treats sim-time the way a video player treats seconds:
              buffer a runway ahead of the playhead, gate the clock on it, and
              never let the picture outrun the data. Rendering stays cheap
              because animation is a shader, not a data update.
            </>
          }
        >
          <PlaybackDiagram />
        </Section>

        {/* ── 06 Techniques ────────────────────────────────────────────── */}
        <Section
          def={SECTIONS[5]}
          lede={
            <>
              Every lever below is measured, opt-in and recorded in tile
              metadata — the reader reconstructs exact values on decode. In
              practice they compound to 4–6× smaller archives that animate at 60
              fps.
            </>
          }
        >
          <TechniquesGrid />
        </Section>

        {/* ── 07 Intelligence ──────────────────────────────────────────── */}
        <Section
          def={SECTIONS[6]}
          lede={
            <>
              The levers above are powerful and easy to misuse, so the toolchain
              ships its own analyst. It profiles the source, measures each lever
              on a real sample of the data, and recommends flags with a
              confidence grade — while a firewall guarantees it never throws
              data away to hit a size target unless you say so.
            </>
          }
        >
          <BuildIntelligence />
        </Section>

        {/* ── 08 Parts ─────────────────────────────────────────────────── */}
        <Section
          def={SECTIONS[7]}
          lede={
            <>
              The format lives in one Rust crate and one TypeScript package;
              everything else is a thin consumer. The same decoded tiles drive
              deck.gl, MapLibre, Three.js and Cesium — pick the renderer your
              app already uses.
            </>
          }
        >
          <PackagesMap />
          <div className="mt-4">
            <ParityKernel />
          </div>
        </Section>

        {/* ── 09 Design decisions ──────────────────────────────────────── */}
        <Section
          def={SECTIONS[8]}
          lede={
            <>
              Formats live or die on their constraints. These are the locked-in
              choices — each one traded away flexibility to buy something
              measurable, and each is written down in the spec so the trade
              stays visible.
            </>
          }
        >
          <DesignDecisions />
        </Section>

        {/* ── Where next ───────────────────────────────────────────────── */}
        <section className="mt-14 sm:mt-16 pb-4">
          <span className="eyebrow">Keep going</span>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {NEXT_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="group rounded-lg p-3.5 transition-colors"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--hairline)',
                }}
              >
                <span
                  className="font-display text-[13px] font-semibold inline-flex items-center gap-1"
                  style={{ color: 'var(--ink-900)' }}
                >
                  {l.title}
                  <svg
                    viewBox="0 0 24 24"
                    width="11"
                    height="11"
                    aria-hidden="true"
                    style={{ color: 'var(--accent)' }}
                  >
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 12h13M13 6l6 6-6 6"
                    />
                  </svg>
                </span>
                <p
                  className="mt-1 text-[11px] leading-relaxed"
                  style={{ color: 'var(--ink-500)' }}
                >
                  {l.blurb}
                </p>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

export default HowItWorks;
