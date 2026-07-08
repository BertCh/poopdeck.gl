import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import StoryGlobe from '../components/story/StoryGlobe';
import { useScrollSpy } from '../components/story/useScrollSpy';
import {
  Eyebrow,
  Figure,
  PersonCard,
  StatCounter,
  MilestoneTimeline,
  DrifterDiagram,
} from '../components/story/parts';
import {
  ACT_INCEPTION,
  ACT_BUILDUP,
  ACT_CURRENTS,
  ACT_PAYOFF,
  HERO_FOCUS,
  PEOPLE,
  MILESTONES,
  STATS,
  SOURCES,
  IMG,
  type GlobeFocus,
  type StoryStep,
} from '../content/drifterStory';

// ── A scrolly "act" step: a glass card floating over the live globe ──────────
const GlobeStepCard: React.FC<{ step: StoryStep; active: boolean }> = ({
  step,
  active,
}) => (
  <section
    id={step.key}
    className={`story-step ${active ? 'story-step--active' : ''}`}
  >
    <div className="w-full px-5 sm:px-8 lg:px-14">
      <div className="story-step-card">
        {step.eyebrow && <Eyebrow tone="dark">{step.eyebrow}</Eyebrow>}
        {step.title && (
          <h2
            className="story-display mt-1.5"
            style={{
              fontSize: 'clamp(1.5rem, 3vw, 2rem)',
              color: 'var(--story-ink)',
            }}
          >
            {step.title}
          </h2>
        )}
        <div className="mt-3">
          {step.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        {step.note && (
          <div
            className="story-display mt-4 pt-3 text-xs"
            style={{
              borderTop: '1px solid rgba(255,255,255,0.12)',
              color: 'var(--story-warm)',
              letterSpacing: '0.02em',
            }}
          >
            {step.note}
          </div>
        )}
      </div>
    </div>
  </section>
);

const Act: React.FC<{ steps: StoryStep[]; activeId: string | null }> = ({
  steps,
  activeId,
}) => (
  <div className="story-act">
    {steps.map((s) => (
      <GlobeStepCard key={s.key} step={s} active={activeId === s.key} />
    ))}
  </div>
);

// small inline "fact chip" row used in the anatomy interlude
const Chip: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div
    className="px-3.5 py-2.5 rounded-lg"
    style={{ background: 'var(--surface-sunken)' }}
  >
    <div
      className="story-display"
      style={{ fontSize: '1.1rem', color: 'var(--ink-900)' }}
    >
      {v}
    </div>
    <div className="text-xs mt-0.5" style={{ color: 'var(--ink-500)' }}>
      {k}
    </div>
  </div>
);

const Pullquote: React.FC<{ children: React.ReactNode; cite?: string }> = ({
  children,
  cite,
}) => (
  <blockquote className="my-2">
    <p
      className="story-display"
      style={{
        fontSize: 'clamp(1.5rem, 3.4vw, 2.3rem)',
        lineHeight: 1.18,
        color: 'var(--accent)',
      }}
    >
      “{children}”
    </p>
    {cite && (
      <cite
        className="block mt-3 text-xs not-italic"
        style={{ color: 'var(--ink-500)' }}
      >
        {cite}
      </cite>
    )}
  </blockquote>
);

const DrifterStory: React.FC = () => {
  // Scroll targets, in DOM order: hero + each globe step + each interlude.
  const ids = useMemo(
    () => [
      'hero',
      'prologue',
      ...ACT_INCEPTION.steps.map((s) => s.key),
      'anatomy',
      ...ACT_BUILDUP.steps.map((s) => s.key),
      'array-culture',
      ...ACT_CURRENTS.steps.map((s) => s.key),
      'institutions',
      ...ACT_PAYOFF.steps.map((s) => s.key),
      'epilogue',
    ],
    [],
  );

  const focusMap = useMemo(() => {
    const m = new Map<string, GlobeFocus>();
    m.set('hero', HERO_FOCUS);
    [ACT_INCEPTION, ACT_BUILDUP, ACT_CURRENTS, ACT_PAYOFF].forEach((act) =>
      act.steps.forEach((s) => m.set(s.key, s.focus)),
    );
    return m;
  }, []);

  const activeId = useScrollSpy(ids);
  const [focus, setFocus] = useState<GlobeFocus>(HERO_FOCUS);
  const [stageActive, setStageActive] = useState(true);

  useEffect(() => {
    if (!activeId) return;
    const f = focusMap.get(activeId);
    if (f) {
      setFocus(f);
      setStageActive(true);
    } else {
      setStageActive(false);
    }
  }, [activeId, focusMap]);

  return (
    <div className="story-root custom-scrollbar">
      {/* Fixed cinematic globe behind everything; interludes scroll over it. */}
      <div
        className={`story-stage ${stageActive ? 'story-stage--live' : 'story-stage--idle'}`}
      >
        <StoryGlobe focus={focus} active={stageActive} />
      </div>

      <div className="story-flow">
        {/* ══ HERO ══ */}
        <section
          id="hero"
          className="story-step"
          style={{ minHeight: '100vh' }}
        >
          <div className="w-full px-5 sm:px-8 lg:px-14">
            <div style={{ maxWidth: '46rem' }}>
              <Eyebrow tone="dark">NOAA Global Drifter Program</Eyebrow>
              <h1
                className="story-display mt-4"
                style={{
                  fontSize: 'clamp(2.6rem, 7vw, 5.2rem)',
                  color: 'var(--story-ink)',
                  fontWeight: 600,
                }}
              >
                A planet that
                <br />
                helps record itself
              </h1>
              <p
                className="mt-6"
                style={{
                  fontSize: 'clamp(1.1rem, 2.2vw, 1.5rem)',
                  lineHeight: 1.5,
                  color: 'var(--story-ink-soft)',
                  maxWidth: '34rem',
                }}
              >
                For two centuries, we read the ocean from what it washed ashore.
                Now the ocean reports for itself — thousands of drifting buoys,
                each ribbon below a real one, colored by the temperature of the
                sea it crossed.
              </p>
              <div
                className="story-display mt-10 inline-flex items-center gap-2 text-sm"
                style={{ color: 'var(--story-ink-faint)' }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 22,
                    height: 36,
                    border: '1.5px solid var(--story-ink-faint)',
                    borderRadius: 12,
                    position: 'relative',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 6,
                      left: '50%',
                      width: 3,
                      height: 7,
                      marginLeft: -1.5,
                      background: 'var(--story-ink-faint)',
                      borderRadius: 2,
                    }}
                  />
                </span>
                Scroll to begin
              </div>
            </div>
          </div>
        </section>

        {/* ══ I · THE FLOTSAM AGE (interlude) ══ */}
        <section id="prologue" className="story-interlude">
          <div
            className="mx-auto px-5 sm:px-8 py-20 sm:py-28"
            style={{ maxWidth: '64rem' }}
          >
            <Eyebrow>I · The Flotsam Age</Eyebrow>
            <h2
              className="story-display mt-3"
              style={{
                fontSize: 'clamp(2rem, 4.5vw, 3rem)',
                color: 'var(--ink-900)',
              }}
            >
              Knowledge that washed ashore
            </h2>
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 mt-8 items-start">
              <div className="story-prose">
                <p className="story-dropcap">
                  For most of history, the ocean’s currents were known only by
                  what they delivered: wreckage on a far beach, a Japanese glass
                  fishing float washed up in the Americas, a bottle with a note
                  inside. The sea clearly connected distant places, but no one
                  could say by which path, or how fast.
                </p>
                <p>
                  As deputy postmaster, Benjamin Franklin was puzzled that mail
                  packets from England ran weeks slow, so he asked his cousin,
                  the Nantucket whaling captain Timothy Folger. Folger drew what
                  whalers already knew: a warm river running through the
                  Atlantic. Franklin printed it around 1768. The Gulf Stream
                  finally had a map, but still no way to watch it move.
                </p>
                <p>
                  The fix was an old and simple idea: let something ride the
                  flow and follow it. A drifting object shows you where the
                  water goes. The hard part was always the following — a bottle
                  records only where it started and where it washed up, often an
                  ocean and a decade apart.
                </p>
                <Pullquote cite="The premise of the modern drifter">
                  A drifter is a message in a bottle that writes back.
                </Pullquote>
              </div>
              <div className="flex flex-col gap-7">
                <Figure
                  asset={IMG.franklinChart}
                  alt="Franklin and Folger's 1769 chart of the Gulf Stream"
                  caption="Franklin & Folger’s chart of the Gulf Stream — the first scientific map of an ocean current, drawn from the knowledge of whalers."
                />
                <Figure
                  asset={IMG.challenger}
                  alt="HMS Challenger"
                  caption="HMS Challenger’s 1872–76 voyage charted the deep ocean by hand. For a century afterward, currents were still inferred rather than observed."
                />
              </div>
            </div>
          </div>
        </section>

        {/* ══ II · THE INSTRUMENT AGE (globe act) ══ */}
        <Act steps={ACT_INCEPTION.steps} activeId={activeId} />

        {/* anatomy interlude */}
        <section id="anatomy" className="story-interlude">
          <div
            className="mx-auto px-5 sm:px-8 py-20 sm:py-28"
            style={{ maxWidth: '64rem' }}
          >
            <Eyebrow>II · The Instrument Age</Eyebrow>
            <h2
              className="story-display mt-3"
              style={{
                fontSize: 'clamp(2rem, 4.5vw, 3rem)',
                color: 'var(--ink-900)',
              }}
            >
              Anatomy of a drifter
            </h2>
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 mt-8 items-center">
              <div className="flex justify-center">
                <DrifterDiagram />
              </div>
              <div className="story-prose">
                <p>
                  A modern drifter is simple — a float at the surface, a long
                  tether, and a perforated “holey-sock” drogue hanging at
                  fifteen meters. The float carries a battery, a satellite
                  transmitter, and a thermometer. The drogue does the real work.
                </p>
                <p>
                  The key number is the <em>drag-area ratio</em>. Peter Niiler’s
                  rule was at least forty times more drag below the surface than
                  above, so the buoy is pulled by the water rather than pushed
                  by the wind. A good drifter slips less than a centimeter a
                  second even in a stiff breeze. The fifteen-meter drogue also
                  sets what the program measures: not the surface skin or the
                  deep ocean, but the mixed layer just below, where the ocean
                  trades heat and weather with the air.
                </p>
                <p>
                  The drogue also separates two phases of a buoy’s life. While
                  it holds, the buoy follows the water and measures a current.
                  When it tears away — as many eventually do — the buoy becomes
                  instrumented flotsam, pushed around by the wind. Telling the
                  two apart, across thousands of buoys and decades, is a real
                  part of the work.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-10">
              <Chip k="drag below : above" v="≥ 40 : 1" />
              <Chip k="wind slip" v="< 1 cm/s" />
              <Chip k="working life" v="~450 days" />
              <Chip k="cost each" v="~$1,800" />
              <Chip k="modern reporting" v="hourly" />
            </div>

            <div className="grid sm:grid-cols-3 gap-7 mt-12 items-start">
              <Figure
                asset={IMG.drifterPhoto}
                alt="SVP drifters stowed and deployed"
                caption="The same buoy: stowed for the deck, and with its drogue extended in the water."
              />
              <Figure
                asset={IMG.tiros}
                alt="TIROS-N satellite"
                caption="TIROS-N, 1978 — the first satellite to carry Argos, the system that lets a buoy report its position."
              />
              <Figure
                asset={IMG.argos}
                alt="Argos system segments"
                caption="How a drifter is heard: a faint radio call, fixed from orbit by Doppler, relayed to the ground."
              />
            </div>
          </div>
        </section>

        {/* ══ III · THE ARRAY AGE (globe act) ══ */}
        <Act steps={ACT_BUILDUP.steps} activeId={activeId} />

        {/* array culture + people */}
        <section id="array-culture" className="story-interlude">
          <div
            className="mx-auto px-5 sm:px-8 py-20 sm:py-28"
            style={{ maxWidth: '64rem' }}
          >
            <Eyebrow>III · The Array Age</Eyebrow>
            <h2
              className="story-display mt-3"
              style={{
                fontSize: 'clamp(2rem, 4.5vw, 3rem)',
                color: 'var(--ink-900)',
              }}
            >
              The array, not the drifter
            </h2>
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 mt-8 items-start">
              <div className="story-prose">
                <p>
                  No single drifter lasts very long. Batteries fail, drogues
                  tear, hulls beach on distant shores, or a buoy is hauled
                  aboard a passing ship. The average working life is a little
                  more than a year.
                </p>
                <p>
                  What matters is not any one instrument but the array: always
                  decaying, always replenished, with roughly a thousand new
                  buoys added each year by research ships, volunteer merchant
                  vessels, and aircraft. Keeping it going is steady, collective,
                  unglamorous work.
                </p>
                <p>
                  A researcher up past midnight in the Gulf of Alaska drops ten
                  drifters over the rail during a transit, hoping to catch the
                  aurora through the clouds. The buoys go in; the aurora doesn’t
                  show. Repeat that ordinary act across decades and fifty
                  agencies and you get a global sensor network.
                </p>
              </div>
              <div className="story-prose">
                <p>
                  It works as a <em>commons</em>: the currents belong to no
                  nation, the data are free to anyone, and the benefits —
                  sharper forecasts, a longer climate record — reach almost
                  everyone while being noticed by almost no one.
                </p>
                <Figure
                  asset={IMG.globalPopulation}
                  alt="The global drifter array"
                  caption="The active array at a glance — every reporting drifter at once."
                  style={{ marginTop: '0.5rem' }}
                />
              </div>
            </div>

            <h3
              className="story-display mt-16 mb-2"
              style={{ fontSize: '1.4rem', color: 'var(--ink-900)' }}
            >
              The people who built it
            </h3>
            <p
              className="story-prose"
              style={{ maxWidth: '44rem', color: 'var(--ink-500)' }}
            >
              Big observing systems aren’t built by equations alone. They take
              engineers, organizers, data-keepers, ship crews, and the
              occasional scientist who can do several of those jobs at once.
            </p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 mt-7">
              {PEOPLE.map((p) => (
                <PersonCard key={p.name} person={p} />
              ))}
            </div>
          </div>
        </section>

        {/* ══ IV · WHAT THE DRIFTERS REVEALED (globe act) ══ */}
        <Act steps={ACT_CURRENTS.steps} activeId={activeId} />

        {/* institutions + pipeline + timeline */}
        <section id="institutions" className="story-interlude">
          <div
            className="mx-auto px-5 sm:px-8 py-20 sm:py-28"
            style={{ maxWidth: '64rem' }}
          >
            <Eyebrow>The work behind the picture</Eyebrow>
            <h2
              className="story-display mt-3"
              style={{
                fontSize: 'clamp(2rem, 4.5vw, 3rem)',
                color: 'var(--ink-900)',
              }}
            >
              From a satellite ping to a record
            </h2>
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 mt-8 items-start">
              <div className="story-prose">
                <p>
                  The program runs as a partnership. Scripps’s Lagrangian
                  Drifter Laboratory designs and builds the buoys and runs the
                  real-time feed; NOAA’s lab in Miami coordinates the global
                  array, runs quality control, and keeps the public archive.
                  Coordinating them is a set of international bodies set up to
                  observe the planet in common: the Data Buoy Cooperation Panel,
                  the WMO, UNESCO’s oceanographic commission, and the Global
                  Ocean Observing System.
                </p>
                <p>
                  A raw drifter doesn’t produce a tidy table. It produces
                  irregular satellite fixes, some of them wrong, an occasional
                  temperature, and eventually silence. Turning that into
                  trustworthy data is the real work: remove the bad positions,
                  flag the lost drogues, interpolate to even six-hour or hourly
                  steps, attach the metadata, and publish.
                </p>
                <div
                  className="story-display flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-sm"
                  style={{ color: 'var(--accent)' }}
                >
                  <span>float</span>
                  <span style={{ color: 'var(--ink-400)' }}>→</span>
                  <span>ping</span>
                  <span style={{ color: 'var(--ink-400)' }}>→</span>
                  <span>quality control</span>
                  <span style={{ color: 'var(--ink-400)' }}>→</span>
                  <span>interpolation</span>
                  <span style={{ color: 'var(--ink-400)' }}>→</span>
                  <span>archive</span>
                </div>
              </div>
              <div className="flex flex-col gap-7">
                <Figure
                  asset={IMG.climatology}
                  alt="Drifter-derived surface current climatology"
                  caption="Thirty years of tracks, averaged: a map of the world’s surface currents no fleet of ships could have drawn."
                />
                <Figure
                  asset={IMG.arrayGrowth}
                  alt="Growth of the drifter array over time"
                  caption="The array, filling in — from a handful of buoys in 1979 to a sustained global network."
                />
              </div>
            </div>

            <h3
              className="story-display mt-16 mb-8"
              style={{ fontSize: '1.4rem', color: 'var(--ink-900)' }}
            >
              Four and a half decades, in brief
            </h3>
            <MilestoneTimeline milestones={MILESTONES} />
          </div>
        </section>

        {/* ══ V · THE FORECAST AGE (globe act) ══ */}
        <Act steps={ACT_PAYOFF.steps} activeId={activeId} />

        {/* ══ EPILOGUE — planetary age (dark interlude) ══ */}
        <section
          id="epilogue"
          className="story-interlude story-interlude--dark"
        >
          <div
            className="mx-auto px-5 sm:px-8 py-20 sm:py-28"
            style={{ maxWidth: '64rem' }}
          >
            <Eyebrow tone="dark">V · The Planetary Age</Eyebrow>
            <h2
              className="story-display mt-3"
              style={{
                fontSize: 'clamp(2rem, 4.5vw, 3rem)',
                color: 'var(--story-ink)',
              }}
            >
              From exploring the ocean to monitoring the Earth
            </h2>
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 mt-8 items-start">
              <div
                className="story-prose"
                style={{ color: 'var(--story-ink-soft)' }}
              >
                <p>
                  Decades of trajectories now form a long public record of the
                  surface ocean. The drifters also mark a shift in what we ask
                  of the sea. Exploration asked: <em>what is out there?</em> The
                  array asks a harder question:{' '}
                  <em>what is changing, how fast, and what will it mean?</em>
                </p>
                <p>
                  There is a hard edge to that. We can monitor the ocean this
                  closely partly because we have changed it enough to need
                  watching — warming, acidifying, filling with our debris. The
                  same tracks that map the Gulf Stream also map where our
                  plastic collects.
                </p>
              </div>
              <Figure
                asset={IMG.svsDrifting}
                alt="Drifters migrating into the ocean gyres"
                caption="Seventeen thousand buoys, drawn from the program’s own database, spiraling into the great gyres."
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-12 mt-16">
              {STATS.map((s) => (
                <StatCounter key={s.label} stat={s} tone="dark" />
              ))}
            </div>

            <div className="mt-16 flex flex-wrap items-center gap-4">
              <Link
                to="/demo/ocean-drifters"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-medium"
                style={{ background: 'var(--story-cool)', color: '#04121a' }}
              >
                Explore the live globe <span aria-hidden>→</span>
              </Link>
              <Link
                to="/"
                className="text-sm"
                style={{ color: 'var(--story-ink-soft)' }}
              >
                ← Back to overview
              </Link>
            </div>

            {/* Sources & credits */}
            <div
              className="mt-20 pt-8"
              style={{ borderTop: '1px solid rgba(255,255,255,0.12)' }}
            >
              <Eyebrow tone="dark">Sources &amp; further reading</Eyebrow>
              <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-2 mt-4">
                {SOURCES.map((s) => (
                  <li key={s.href}>
                    <a
                      href={s.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm"
                      style={{ color: 'var(--story-ink-soft)' }}
                    >
                      {s.label}{' '}
                      <span
                        aria-hidden
                        style={{ color: 'var(--story-ink-faint)' }}
                      >
                        ↗
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
              <p
                className="text-xs mt-8"
                style={{
                  color: 'var(--story-ink-faint)',
                  lineHeight: 1.6,
                  maxWidth: '46rem',
                }}
              >
                Globe rendered from the NOAA Global Drifter Program trajectory
                archive using deck.gl. Imagery: NOAA AOML and NASA’s Scientific
                Visualization Studio (public domain); Franklin–Folger chart,
                Library of Congress; HMS Challenger, NOAA archive; Argos
                diagram, Vsatinet / Wikimedia (CC BY 4.0); Franklin portrait by
                Joseph-Siffred Duplessis (public domain). Attribution does not
                imply endorsement by NOAA or NASA.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default DrifterStory;
