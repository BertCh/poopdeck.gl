// ─────────────────────────────────────────────────────────────────────────
// "A Planet That Helps Record Itself" — the NOAA Global Drifter Program story.
//
// All narrative facts here are drawn from sourced research (NOAA AOML, Scripps
// LDL, Lumpkin & Pazos 2007, Lumpkin et al. 2017, Elipot et al. 2016, and the
// primary obituaries / program pages cited in CREDITS at the bottom of the
// page). Accuracy notes that shaped the copy:
//   • Niiler is the "scientific father of the Global Drifter Program"; the
//     holey-sock drogue itself was developed at NOAA AOML (1979). His signature
//     contribution is the drag-area-ratio theory + the SVP synthesis.
//   • Rick Lumpkin led the program for years and retired from federal service
//     in March 2025 — described here as longtime lead, not "current director".
//   • Franklin's Gulf Stream chart traces to 1768–69 (London), credited with
//     Nantucket whaling captain Timothy Folger; Franklin published his own
//     version in 1786.
//   • The 1,250-buoy array was the program's INITIAL design goal (met 18 Sep
//     2005); the array has since grown beyond it.
//   • Coordinates flagged [EST] in research are framing estimates, not claims.
// ─────────────────────────────────────────────────────────────────────────

const D = (y: number, m = 0, day = 1) => Date.UTC(y, m, day);
export const DAY = 86_400_000;

// NOTE: the archive's temporal extent is deliberately NOT declared here. It
// used to be (`DATA_START`/`DATA_END`), and the hand-typed end drifted 6.75
// days past the real last fix — so every drift/spin beat played out over a
// week of empty ocean before the clock stopped. StoryGlobe now resolves the
// range from the archive manifest (`useArchiveMetadata` + `resolvePlaybackParams`),
// the same reconciliation path `/demo/:id` uses, so the story clock cannot
// drift from the data again. Story content declares only editorial MOMENTS.
//
// The manifest is one async GET away, though, so the FIRST beat of a cold
// visit is applied against the `ocean-drifters` placeholder in datasets.ts —
// which is why that literal must equal the archive extent exactly, and why
// `StoryClock.setArchiveRange` corrects the beat already on the clock (range
// only, never a re-seek) the moment the real extent lands. See
// components/story/storyClock.ts and test/story-clock.test.ts.

export type GlobeMode = 'spin' | 'sweep' | 'drift' | 'still';

export interface GlobeMarker {
  lng: number;
  lat: number;
  label: string;
  tone?: 'cool' | 'warm' | 'hot' | 'gold';
}

export interface GlobeFocus {
  lng: number;
  lat: number;
  zoom: number;
  /** Snapshot / center time (ms epoch). */
  time: number;
  mode: GlobeMode;
  /**
   * For mode 'sweep': play across this whole range. `start` is optional and
   * omitting it means "from the beginning of the archive" — StoryGlobe fills
   * it in from the resolved archive extent, so the sweep can never open on a
   * moment the data does not reach.
   */
  sweep?: { start?: number; end: number };
  /** Visible trail length, in days of sim-time. */
  trailDays?: number;
  /** Playback rate in sim-days per real second (sweep/drift/spin). */
  speedDays?: number;
  markers?: GlobeMarker[];
}

export interface StoryStep {
  key: string;
  focus: GlobeFocus;
  eyebrow?: string;
  title?: string;
  body: string[];
  /** Small stat chip shown under the card (optional). */
  note?: string;
}

export interface StoryAct {
  id: string;
  steps: StoryStep[];
}

// ── Shared focus presets ───────────────────────────────────────────────────
const FULL_ARRAY_TIME = D(2016, 0, 1);

// ════════════════════════════════════════════════════════════════════════
// ACT I — INCEPTION
// ════════════════════════════════════════════════════════════════════════
export const ACT_INCEPTION: StoryAct = {
  id: 'inception',
  steps: [
    {
      key: 'argos',
      eyebrow: 'October 1978',
      title: 'A way to listen from orbit',
      body: [
        'The satellite TIROS-N reached orbit in October 1978 carrying Argos, a tracking system built by the French space agency CNES with NASA and NOAA. Argos could fix the position of a small transmitter at sea from the Doppler shift of its signal.',
        'For the first time, a buoy could report its own position to a satellite from anywhere on the ocean, over and over.',
      ],
      // Open over the South Pacific, west of South America — already framing the
      // empty ocean where the first drifters will appear in the next beat.
      focus: {
        lng: -95,
        lat: -12,
        zoom: 1.4,
        time: D(1985, 0, 1),
        mode: 'spin',
        trailDays: 90,
        speedDays: 6,
      },
    },
    {
      key: 'first-fix',
      eyebrow: '14 February 1979',
      title: 'The first fix',
      body: [
        'The earliest drifters in this record began reporting from the equatorial Pacific in February 1979, part of the studies that became the Tropical Ocean–Global Atmosphere program. There were only a handful of them, in an otherwise empty ocean.',
        'Each ribbon is a real buoy, colored by the sea-surface temperature it measured as it drifted. This is where the record begins.',
      ],
      note: 'First transmission: 14 Feb 1979 · equatorial Pacific',
      focus: {
        lng: -140,
        lat: 0,
        zoom: 2.6,
        time: D(1981, 6, 1),
        mode: 'drift',
        trailDays: 220,
        speedDays: 10,
        markers: [
          { lng: -140, lat: 0, label: 'First drifters · 1979', tone: 'gold' },
        ],
      },
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════
// ACT II — THE ARRAY FILLS IN
// ════════════════════════════════════════════════════════════════════════
export const ACT_BUILDUP: StoryAct = {
  id: 'buildup',
  steps: [
    {
      key: 'sweep',
      eyebrow: '1979 → 2005',
      title: 'Twenty-six years in a minute',
      body: [
        'Watch the array fill in. Through the 1980s the standardized SVP drifter spread across the Pacific and North Atlantic, and by the mid-1990s into the Southern and Indian Oceans. Roughly a thousand new buoys went into the water each year, dropped from research ships, volunteer vessels, and aircraft.',
        'No survey by ship could have drawn this map. Each track is just a buoy going where the water took it.',
      ],
      focus: {
        // Open the sweep over the South Pacific, west of South America — the
        // empty ocean where the record begins — then let the globe turn as the
        // array fills in worldwide.
        lng: -95,
        lat: -12,
        zoom: 1.35,
        time: D(1992, 0, 1),
        mode: 'sweep',
        // `start` omitted → the resolved archive start (the first fix).
        sweep: { end: D(2005, 8, 18) },
        trailDays: 110,
        // The fastest beat by far — it compresses ~26 years over ~75 s. The
        // rate is a hand-tuned PACING choice; it no longer needs to be R2-safe
        // — the runway-gated cross-dissolve in StoryGlobe backstops loading on
        // era jumps, and the story-wide prefetch budget is sized to this beat.
        // (Governor-driven auto-speed for story beats is a possible follow-up;
        // see player-buffering WS-D.)
        speedDays: 130,
      },
    },
    {
      key: 'milestone-1250',
      eyebrow: '18 September 2005',
      title: 'Drifter number 1,250',
      body: [
        'Off Halifax, Nova Scotia, Peter Niiler and NOAA’s Mike Johnson lowered the 1,250th drifter from the deck of a tall ship, completing the array’s original goal: one buoy every five degrees of latitude and longitude across the world ocean.',
        'It was the first part of the Global Ocean Observing System to be finished — a plan decades in the making, completed with a buoy lowered over a rail.',
      ],
      note: 'First completed component of the Global Ocean Observing System',
      focus: {
        lng: -55,
        lat: 44,
        zoom: 3.4,
        time: D(2005, 8, 18),
        mode: 'drift',
        trailDays: 120,
        speedDays: 14,
        markers: [
          {
            lng: -63.6,
            lat: 44.6,
            label: 'Drifter 1,250 · Halifax',
            tone: 'gold',
          },
        ],
      },
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════
// ACT III — WHAT THE DRIFTERS REVEALED (currents tour)
// ════════════════════════════════════════════════════════════════════════
export const ACT_CURRENTS: StoryAct = {
  id: 'currents',
  steps: [
    {
      key: 'gulf-stream',
      eyebrow: 'The currents, revealed',
      title: 'The Gulf Stream',
      body: [
        'The current Franklin charted, now seen in motion. The warm jet peels away from the coast near Cape Hatteras and runs northeast across the Atlantic, its core glowing red where the water is far warmer than the sea around it, shedding loops and eddies as it goes.',
      ],
      focus: {
        lng: -60,
        lat: 38,
        zoom: 3.0,
        time: FULL_ARRAY_TIME,
        mode: 'drift',
        trailDays: 150,
        speedDays: 12,
      },
    },
    {
      key: 'kuroshio',
      title: 'The Kuroshio',
      body: [
        'The Pacific’s counterpart to the Gulf Stream. The "Black Current" sweeps north past Japan and turns east into the open ocean, carrying tropical warmth toward the cold sub-Arctic. You can see the boundary in the color of the tracks.',
      ],
      focus: {
        lng: 150,
        lat: 35,
        zoom: 3.0,
        time: FULL_ARRAY_TIME,
        mode: 'drift',
        trailDays: 150,
        speedDays: 12,
      },
    },
    {
      key: 'acc',
      title: 'The Antarctic Circumpolar Current',
      body: [
        'The largest current on Earth, and the only one that circles the planet unbroken. It rings Antarctica from west to east, moving more water than all the world’s rivers combined. The drifters here run blue, circling again and again.',
      ],
      focus: {
        lng: 60,
        lat: -58,
        zoom: 2.0,
        time: FULL_ARRAY_TIME,
        mode: 'drift',
        trailDays: 200,
        speedDays: 16,
      },
    },
    {
      key: 'agulhas',
      title: 'The Agulhas Retroflection',
      body: [
        'Off the tip of South Africa, the warm Agulhas Current overshoots, curls back on itself, and pinches off large spinning rings that carry warm water into the Atlantic. Drifters caught the rings as they formed, passing water from one ocean into the next.',
      ],
      focus: {
        lng: 22,
        lat: -39,
        zoom: 3.4,
        time: FULL_ARRAY_TIME,
        mode: 'drift',
        trailDays: 150,
        speedDays: 12,
      },
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════
// ACT IV — THE PAYOFF (weather, climate, response)
// ════════════════════════════════════════════════════════════════════════
export const ACT_PAYOFF: StoryAct = {
  id: 'payoff',
  steps: [
    {
      key: 'hurricanes',
      eyebrow: 'Into the storm',
      title: 'Dropped from the sky',
      body: [
        'When a hurricane is coming, the Air Force Hurricane Hunters fly drifters out and drop them in its path. Ahead of Hurricane Ana near Hawaii in 2014, ten were air-deployed and nine survived to radio back winds, pressure, currents, and the ocean’s heat down to 150 meters — the heat that feeds the storm.',
      ],
      note: '16 more were air-dropped ahead of Hurricane Teddy in 2020',
      focus: {
        lng: -158,
        lat: 19,
        zoom: 3.6,
        time: D(2014, 9, 17),
        mode: 'drift',
        trailDays: 90,
        speedDays: 10,
        markers: [
          { lng: -158, lat: 19, label: 'Hurricane Ana · 2014', tone: 'hot' },
        ],
      },
    },
    {
      key: 'deepwater',
      eyebrow: 'April 2010',
      title: 'Following the spill',
      body: [
        'When the Deepwater Horizon well blew out, the urgent question was where the oil would go. Drifters released into the Gulf mapped the Loop Current and the warm eddy spinning off it, the circulation that ended up keeping most of the oil offshore.',
      ],
      focus: {
        lng: -88,
        lat: 26,
        zoom: 4.0,
        time: D(2010, 5, 1),
        mode: 'drift',
        trailDays: 60,
        speedDays: 6,
        markers: [
          { lng: -88.39, lat: 28.74, label: 'Deepwater Horizon', tone: 'hot' },
        ],
      },
    },
    {
      key: 'garbage',
      eyebrow: 'Where things gather',
      title: 'Finding the garbage patches',
      body: [
        'A model built from fifteen thousand drifter tracks showed water — and everything floating in it — drifting slowly toward the calm centers of the great gyres. It reproduced the Great Pacific Garbage Patch and pointed to other accumulation zones before ships went out to confirm them.',
      ],
      focus: {
        lng: -150,
        lat: 35,
        zoom: 2.7,
        time: FULL_ARRAY_TIME,
        mode: 'drift',
        trailDays: 200,
        speedDays: 14,
        markers: [
          {
            lng: -145,
            lat: 38,
            label: 'N. Pacific Garbage Patch',
            tone: 'warm',
          },
        ],
      },
    },
    {
      key: 'sst',
      eyebrow: 'The everyday measurement',
      title: 'Ground truth for the satellites',
      body: [
        'Every drifter carries a thermometer. Together they form the in-situ reference that satellite sea-surface temperatures are calibrated against, which is why a reading from orbit can be trusted to a few hundredths of a degree, year after year. That calibration supports modern weather forecasts and the long climate record of a warming ocean.',
      ],
      focus: {
        lng: 0,
        lat: 5,
        zoom: 1.4,
        time: FULL_ARRAY_TIME,
        mode: 'spin',
        trailDays: 120,
        speedDays: 8,
      },
    },
  ],
};

export const ACTS: StoryAct[] = [
  ACT_INCEPTION,
  ACT_BUILDUP,
  ACT_CURRENTS,
  ACT_PAYOFF,
];

// ── Opening hero focus (the title screen) ───────────────────────────────────
export const HERO_FOCUS: GlobeFocus = {
  lng: -78,
  lat: -18,
  zoom: 1.5,
  time: D(2018, 0, 1),
  mode: 'spin',
  trailDays: 110,
  speedDays: 9,
};

// ════════════════════════════════════════════════════════════════════════
// PEOPLE  (photo-optional cards — only Franklin has a public-domain portrait)
// ════════════════════════════════════════════════════════════════════════
export interface Person {
  name: string;
  role: string;
  years?: string;
  initials: string;
  tone: string; // monogram background
  blurb: string;
  link?: { href: string; label: string };
  portrait?: { src: string; credit: string };
}

export const PEOPLE: Person[] = [
  {
    name: 'Peter Niiler',
    role: 'Scientific father of the Global Drifter Program · Scripps',
    years: '1937–2010',
    initials: 'PN',
    tone: '#0a7790',
    blurb:
      'Born in Tartu, Estonia, and trained as an engineer, Pearn “Peter” Niiler turned drifting buoys into instruments scientists could trust. His drag-area-ratio theory set the rule that a good drifter must have at least 40 times more drag below the surface than above, so it follows the water rather than the wind. Building a global array, a colleague wrote, took him being “engineer, organizer, manager, philosopher, politician, orator, and scientist” at once. In 2005 he helped lower the buoy that completed the array.',
    link: {
      href: 'https://scripps.ucsd.edu/news/obituary-notice-world-authority-ocean-circulation-peter-niiler',
      label: 'Scripps obituary',
    },
  },
  {
    name: 'Andrew Sybrandy',
    role: 'Engineer · Scripps Institution of Oceanography',
    initials: 'AS',
    tone: '#2a6f8e',
    blurb:
      'With Niiler, Sybrandy wrote the 1991 WOCE/TOGA SVP Lagrangian Drifter Construction Manual, the engineering document that let labs around the world build the exact same buoy, so a measurement off Japan meant the same thing as one off Brazil.',
    link: {
      href: 'https://search.worldcat.org/title/wocetoga-svp-lagrangian-drifter-construction-manual/oclc/28032829',
      label: 'The construction manual',
    },
  },
  {
    name: 'Rick Lumpkin',
    role: 'Longtime program lead · NOAA AOML (retired 2025)',
    initials: 'RL',
    tone: '#0b5fa5',
    blurb:
      'For two decades Lumpkin ran the Drifter Program from NOAA’s Miami lab and wrote its standard reviews. With Mayra Pazos he developed a way to detect when a drifter has lost its drogue, which corrected the velocity record for thousands of buoys, going back years.',
    link: {
      href: 'https://www.aoml.noaa.gov/global-drifter-program/',
      label: 'NOAA Global Drifter Program',
    },
  },
  {
    name: 'Mayra Pazos',
    role: 'Data Assembly Center · NOAA AOML',
    initials: 'MP',
    tone: '#1a7d6b',
    blurb:
      'Pazos has long run the quality control behind the archive, the work of turning millions of raw satellite pings into a trustworthy record. Her drogue-loss detection work with Lumpkin earned NOAA’s Employee of the Year award.',
    link: {
      href: 'https://www.aoml.noaa.gov/phod/gdp/',
      label: 'GDP Data Assembly Center',
    },
  },
  {
    name: 'Luca Centurioni',
    role: 'Director, Lagrangian Drifter Laboratory · Scripps',
    initials: 'LC',
    tone: '#0a7790',
    blurb:
      'Niiler’s collaborator and successor. Centurioni took over as program PI in 2010 and founded the Lagrangian Drifter Laboratory, which builds roughly a thousand drifters a year and keeps developing new ones — for salinity, for waves, and for use inside a typhoon.',
    link: {
      href: 'https://gdp.ucsd.edu/ldl/',
      label: 'Lagrangian Drifter Laboratory',
    },
  },
  {
    name: 'Shane Elipot',
    role: 'Physical oceanographer · University of Miami',
    initials: 'SE',
    tone: '#2a6f8e',
    blurb:
      'Elipot led the 2016 work that resampled the irregular Argos fixes into a uniform hourly dataset — hundreds of millions of positions and velocities, each with an error estimate — the version researchers use when the fine, fast motion of the ocean matters.',
    link: {
      href: 'https://www.aoml.noaa.gov/phod/gdp/hourly_data.php',
      label: 'The hourly dataset',
    },
  },
  {
    name: 'Adam Sykulski',
    role: 'Statistical oceanography · time-series modeling',
    initials: 'AS',
    tone: '#3a6f8e',
    blurb:
      'A raw drifter position is never a clean number. Sykulski’s statistical methods, used throughout the hourly product, separate real ocean motion and the day–night swing of temperature from the noise of the satellite fixes, turning irregular pings into estimates with stated uncertainty.',
    link: {
      href: 'https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2016JC011716',
      label: 'Hourly dataset method',
    },
  },
  {
    name: 'Nikolai Maximenko',
    role: 'Oceanographer · University of Hawaiʻi',
    initials: 'NM',
    tone: '#1a7d6b',
    blurb:
      'Maximenko showed that the drifters’ own statistics could predict where floating debris would gather. His 2012 model, with Niiler, reproduced the garbage patches from trajectories alone, locating them before ships went out to look.',
    link: {
      href: 'https://iprc.soest.hawaii.edu/people/maximenko.php',
      label: 'IPRC profile',
    },
  },
  {
    name: 'Benjamin Franklin',
    role: 'The forerunner, with Capt. Timothy Folger',
    years: '1706–1790',
    initials: 'BF',
    tone: '#6b5b3e',
    blurb:
      'Two centuries before the satellites, Franklin printed the first scientific chart of the Gulf Stream, drawn from the knowledge of Nantucket whalers. He asked the question the drifters would finally answer: which way, exactly, does the sea run?',
    link: {
      href: 'https://oceanservice.noaa.gov/facts/bfranklin.html',
      label: 'NOAA: Franklin & the Gulf Stream',
    },
    portrait: {
      src: '/story/img/franklin-portrait-duplessis.jpg',
      credit: 'Joseph-Siffred Duplessis, c. 1785 · public domain',
    },
  },
];

// ════════════════════════════════════════════════════════════════════════
// TIMELINE
// ════════════════════════════════════════════════════════════════════════
export interface Milestone {
  year: string;
  sort: number;
  title: string;
  detail: string;
}

export const MILESTONES: Milestone[] = [
  {
    year: '1768',
    sort: 1768,
    title: 'Franklin’s Gulf Stream chart',
    detail: 'Franklin & Folger print the first scientific map of a current.',
  },
  {
    year: '1978',
    sort: 1978,
    title: 'Argos reaches orbit',
    detail:
      'TIROS-N carries the CNES/NASA/NOAA tracking system — global positioning of buoys becomes possible.',
  },
  {
    year: '1979',
    sort: 1979,
    title: 'First fixes',
    detail: 'Holey-sock drifters begin reporting from the equatorial Pacific.',
  },
  {
    year: '1982',
    sort: 1982,
    title: 'Boulder meeting',
    detail:
      'Niiler convenes the gathering that launches the modern drifter effort.',
  },
  {
    year: '1988',
    sort: 1988,
    title: 'The SVP standard',
    detail:
      'Large-scale deployment of the standardized Surface Velocity Program drifter begins.',
  },
  {
    year: '1991',
    sort: 1991,
    title: 'The construction manual',
    detail:
      'Sybrandy & Niiler publish the blueprint that unifies the world’s drifters.',
  },
  {
    year: '1994',
    sort: 1994,
    title: 'Barometers go to sea',
    detail:
      'SVP-B drifters start measuring air pressure for weather prediction.',
  },
  {
    year: '2005',
    sort: 2005,
    title: '1,250-buoy array complete',
    detail:
      'The first finished component of the Global Ocean Observing System.',
  },
  {
    year: '2010',
    sort: 2010,
    title: 'Deepwater Horizon',
    detail: 'Drifters map the Gulf currents to forecast the oil’s path.',
  },
  {
    year: '2016',
    sort: 2016,
    title: 'The hourly dataset',
    detail: 'Elipot et al. publish a uniform, high-resolution drifter product.',
  },
  {
    year: '2024',
    sort: 2024,
    title: 'The 30,000th drifter',
    detail: 'Deployed in August — a tally across the program’s whole life.',
  },
];

// ════════════════════════════════════════════════════════════════════════
// HEADLINE STATS
// ════════════════════════════════════════════════════════════════════════
export interface Stat {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  label: string;
  sub?: string;
}

export const STATS: Stat[] = [
  {
    value: 30000,
    suffix: '+',
    label: 'drifters deployed',
    sub: 'across the program’s life, as of 2024',
  },
  {
    value: 1300,
    prefix: '~',
    label: 'reporting right now',
    sub: 'the live global array',
  },
  {
    value: 45,
    suffix: ' yrs',
    label: 'of continuous record',
    sub: 'February 1979 to today',
  },
  {
    value: 1000,
    prefix: '~',
    label: 'new buoys a year',
    sub: 'to keep the array full',
  },
  {
    value: 50,
    suffix: '+',
    label: 'partner agencies',
    sub: 'an international effort',
  },
  {
    value: 0.003,
    decimals: 3,
    suffix: ' K/yr',
    label: 'satellite SST stability',
    sub: 'held against the drifters',
  },
];

// ════════════════════════════════════════════════════════════════════════
// SOURCES & CREDITS
// ════════════════════════════════════════════════════════════════════════
export interface Source {
  label: string;
  href: string;
}

export const SOURCES: Source[] = [
  {
    label: 'NOAA AOML — Global Drifter Program',
    href: 'https://www.aoml.noaa.gov/global-drifter-program/',
  },
  {
    label:
      'Lumpkin & Pazos (2007), Measuring surface currents with SVP drifters',
    href: 'https://www.aoml.noaa.gov/phod/docs/LumpkinPazos.pdf',
  },
  {
    label:
      'Lumpkin et al. (2017), Advances in the Application of Surface Drifters',
    href: 'https://www.aoml.noaa.gov/phod/docs/Lumpkin_etal2016.pdf',
  },
  {
    label:
      'Elipot et al. (2016), A global surface drifter dataset at hourly resolution',
    href: 'https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2016JC011716',
  },
  {
    label: 'Maximenko, Hafner & Niiler (2012), Pathways of marine debris',
    href: 'https://pubmed.ncbi.nlm.nih.gov/21696778/',
  },
  {
    label: 'Scripps — Lagrangian Drifter Laboratory',
    href: 'https://gdp.ucsd.edu/ldl/',
  },
  {
    label: 'NOAA — Benjamin Franklin & the Gulf Stream',
    href: 'https://oceanservice.noaa.gov/facts/bfranklin.html',
  },
  {
    label: 'AOML ERDDAP — drifter data (freely downloadable)',
    href: 'https://erddap.aoml.noaa.gov/gdp/erddap/',
  },
];

/** Image credits, keyed by the asset filename under /story/img. */
export interface AssetCredit {
  src: string;
  credit: string;
}

export const IMG = {
  franklinChart: {
    src: '/story/img/franklin-folger-gulfstream-1769.jpg',
    credit:
      'Franklin & Folger Gulf Stream chart, London 1769 · Library of Congress · public domain',
  },
  challenger: {
    src: '/story/img/hms-challenger.jpg',
    credit:
      'HMS Challenger, Challenger Report 1885 · NOAA archive · public domain',
  },
  tiros: {
    src: '/story/img/tiros-n.jpg',
    credit: 'TIROS-N satellite · NASA / NOAA · public domain',
  },
  argos: {
    src: '/story/img/argos-segments.png',
    credit: 'Argos system segments · Vsatinet, Wikimedia · CC BY 4.0',
  },
  drifterPhoto: {
    src: '/story/img/drifter-buoys-noaa.jpg',
    credit: 'SVP drifters, stowed and deployed · NOAA AOML · public domain',
  },
  climatology: {
    src: '/story/img/noaa-climatology.jpg',
    credit:
      'Drifter-derived surface-current climatology · NOAA AOML · public domain',
  },
  oceanCurrents: {
    src: '/story/img/noaa-ocean-currents.jpg',
    credit: 'Mean surface currents from drifters · NOAA AOML · public domain',
  },
  arrayGrowth: {
    src: '/story/img/noaa-array-growth.jpeg',
    credit: 'Growth of the drifter array · NOAA AOML · public domain',
  },
  globalPopulation: {
    src: '/story/img/noaa-global-population.gif',
    credit: 'Global drifter array · NOAA AOML · public domain',
  },
  svsDrifting: {
    src: '/story/img/nasa-svs-drifting-at-sea.jpg',
    credit:
      'Drifting At Sea · NASA’s Scientific Visualization Studio · public domain',
  },
  svsGarbage: {
    src: '/story/img/nasa-svs-garbage-patches.png',
    credit:
      'Garbage Patch experiment · NASA’s Scientific Visualization Studio · public domain',
  },
} satisfies Record<string, AssetCredit>;
