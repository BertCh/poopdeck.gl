import React, { useEffect, useRef, useState } from 'react';
import type {
  Person,
  Milestone,
  Stat,
  AssetCredit,
} from '../../content/drifterStory';
import { useReducedMotion } from '../../lib/reducedMotion';

// ── Small typographic helpers ───────────────────────────────────────────────
export const Eyebrow: React.FC<{
  children: React.ReactNode;
  tone?: 'dark' | 'light';
}> = ({ children, tone = 'light' }) => (
  <div
    className="story-eyebrow"
    style={{ color: tone === 'dark' ? 'var(--story-cool)' : 'var(--accent)' }}
  >
    {children}
  </div>
);

/** Fires `onEnter` once when the element first scrolls into view. */
function useInView<T extends HTMLElement>(onEnter: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onEnter();
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

// ── Figure with caption + credit ────────────────────────────────────────────
export const Figure: React.FC<{
  asset: AssetCredit;
  alt: string;
  caption?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}> = ({ asset, alt, caption, className, style }) => (
  <figure className={`story-figure ${className ?? ''}`} style={style}>
    <img src={asset.src} alt={alt} loading="lazy" />
    {caption && <figcaption className="story-figcaption">{caption}</figcaption>}
    <div
      className="story-credit"
      style={{ marginTop: caption ? '0.35rem' : '0.5rem' }}
    >
      {asset.credit}
    </div>
  </figure>
);

// ── People ───────────────────────────────────────────────────────────────────
const Monogram: React.FC<{ person: Person }> = ({ person }) =>
  person.portrait ? (
    <img
      src={person.portrait.src}
      alt={person.name}
      className="story-monogram"
      style={{ objectFit: 'cover' }}
      title={person.portrait.credit}
    />
  ) : (
    <div
      className="story-monogram"
      style={{ background: person.tone }}
      aria-hidden
    >
      {person.initials}
    </div>
  );

export const PersonCard: React.FC<{ person: Person }> = ({ person }) => (
  <div className="story-person">
    <div className="flex items-start gap-3.5">
      <Monogram person={person} />
      <div className="min-w-0">
        <h3
          className="story-display"
          style={{ fontSize: '1.18rem', color: 'var(--ink-900)' }}
        >
          {person.name}
        </h3>
        <div className="text-xs mt-0.5" style={{ color: 'var(--ink-500)' }}>
          {person.role}
          {person.years && (
            <span style={{ color: 'var(--ink-400)' }}> · {person.years}</span>
          )}
        </div>
      </div>
    </div>
    <p
      className="mt-3"
      style={{ fontSize: '0.97rem', lineHeight: 1.62, color: 'var(--ink-700)' }}
    >
      {person.blurb}
    </p>
    {person.link && (
      <a
        href={person.link.href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 mt-3 text-xs font-medium"
        style={{ color: 'var(--accent)' }}
      >
        {person.link.label} <span aria-hidden>↗</span>
      </a>
    )}
  </div>
);

// ── Count-up stat ─────────────────────────────────────────────────────────────
export const StatCounter: React.FC<{ stat: Stat; tone?: 'light' | 'dark' }> = ({
  stat,
  tone = 'light',
}) => {
  const dark = tone === 'dark';
  const numColor = dark ? 'var(--story-ink)' : 'var(--ink-900)';
  const labelColor = dark ? 'var(--story-ink-soft)' : 'var(--ink-700)';
  const subColor = dark ? 'var(--story-ink-faint)' : 'var(--ink-500)';
  const reducedMotion = useReducedMotion();
  const [val, setVal] = useState(reducedMotion ? stat.value : 0);
  const ref = useInView<HTMLDivElement>(() => {
    // Reduce-motion: show the final figure outright, no count-up.
    if (reducedMotion) {
      setVal(stat.value);
      return;
    }
    const dur = 1400;
    let raf = 0;
    let start: number | null = null;
    const step = (t: number) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / dur);
      // easeOutCubic
      const e = 1 - Math.pow(1 - p, 3);
      setVal(stat.value * e);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  });

  const display =
    stat.decimals != null
      ? val.toFixed(stat.decimals)
      : Math.round(val).toLocaleString('en-US');

  return (
    <div ref={ref}>
      <div
        className="story-stat-num"
        style={{ fontSize: 'clamp(2.2rem, 5vw, 3.4rem)', color: numColor }}
      >
        {stat.prefix}
        {display}
        {stat.suffix}
      </div>
      <div
        className="story-display"
        style={{ fontSize: '1rem', marginTop: '0.3rem', color: labelColor }}
      >
        {stat.label}
      </div>
      {stat.sub && (
        <div className="text-xs mt-1" style={{ color: subColor }}>
          {stat.sub}
        </div>
      )}
    </div>
  );
};

// ── Milestone timeline ────────────────────────────────────────────────────────
export const MilestoneTimeline: React.FC<{ milestones: Milestone[] }> = ({
  milestones,
}) => (
  <div className="relative">
    <div
      className="story-timeline-rail absolute left-0 right-0 hidden md:block"
      style={{ top: 7, height: 2, opacity: 0.5 }}
    />
    <ol className="grid grid-cols-1 md:grid-cols-11 gap-y-6 md:gap-y-0 md:gap-x-2">
      {milestones.map((m) => (
        <li key={m.year} className="relative md:pt-7">
          <span
            className="absolute hidden md:block rounded-full"
            style={{
              top: 2,
              left: 0,
              width: 12,
              height: 12,
              background: 'var(--accent)',
              border: '2px solid var(--story-paper)',
            }}
          />
          <div
            className="story-display"
            style={{
              fontSize: '1.15rem',
              color: 'var(--ink-900)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {m.year}
          </div>
          <div
            className="story-display mt-1"
            style={{
              fontSize: '0.82rem',
              color: 'var(--ink-700)',
              lineHeight: 1.25,
            }}
          >
            {m.title}
          </div>
          <div
            className="text-xs mt-1"
            style={{ color: 'var(--ink-500)', lineHeight: 1.45 }}
          >
            {m.detail}
          </div>
        </li>
      ))}
    </ol>
  </div>
);

// ── Annotated SVP-drifter diagram (hand-drawn SVG, no external license) ───────
export const DrifterDiagram: React.FC = () => {
  const ink = '#353a44';
  const faint = '#9aa1ad';
  const accent = '#0a7790';
  const label = (
    x: number,
    y: number,
    t: string,
    anchor: 'start' | 'end' = 'start',
  ) => (
    <text
      x={x}
      y={y}
      fontSize="12.5"
      fill={ink}
      fontFamily="Newsreader, Georgia, serif"
      textAnchor={anchor}
    >
      {t}
    </text>
  );
  return (
    <svg
      viewBox="-128 0 600 470"
      width="100%"
      role="img"
      aria-label="Anatomy of an SVP drifter"
      style={{ maxWidth: 560 }}
    >
      {/* sea surface */}
      <line
        x1="20"
        y1="120"
        x2="440"
        y2="120"
        stroke={faint}
        strokeWidth="1"
        strokeDasharray="2 4"
      />
      <text
        x="440"
        y="114"
        fontSize="11"
        fill={faint}
        textAnchor="end"
        fontFamily="Newsreader, Georgia, serif"
      >
        sea surface
      </text>

      {/* surface float */}
      <circle
        cx="200"
        cy="98"
        r="22"
        fill="#ffffff"
        stroke={ink}
        strokeWidth="1.6"
      />
      <circle cx="200" cy="98" r="3" fill={accent} />
      <line x1="200" y1="76" x2="200" y2="64" stroke={ink} strokeWidth="1.4" />
      <circle cx="200" cy="61" r="2.5" fill={ink} />

      {/* tether */}
      <line
        x1="200"
        y1="120"
        x2="200"
        y2="300"
        stroke={ink}
        strokeWidth="1.4"
      />

      {/* holey-sock drogue: a sectioned cylinder with holes, centred ~15 m */}
      <g>
        {[300, 330, 360, 390].map((y) => (
          <ellipse
            key={y}
            cx="200"
            cy={y}
            rx="34"
            ry="8"
            fill="none"
            stroke={ink}
            strokeWidth="1.4"
          />
        ))}
        <line
          x1="166"
          y1="300"
          x2="166"
          y2="390"
          stroke={ink}
          strokeWidth="1.4"
        />
        <line
          x1="234"
          y1="300"
          x2="234"
          y2="390"
          stroke={ink}
          strokeWidth="1.4"
        />
        {/* holes */}
        {[315, 345, 375].map((y) => (
          <g key={y}>
            <circle cx="184" cy={y} r="3.2" fill={faint} />
            <circle cx="216" cy={y} r="3.2" fill={faint} />
          </g>
        ))}
        <ellipse
          cx="200"
          cy="410"
          rx="22"
          ry="6"
          fill="none"
          stroke={ink}
          strokeWidth="1.4"
        />
        <line
          x1="166"
          y1="390"
          x2="178"
          y2="410"
          stroke={ink}
          strokeWidth="1.4"
        />
        <line
          x1="234"
          y1="390"
          x2="222"
          y2="410"
          stroke={ink}
          strokeWidth="1.4"
        />
      </g>

      {/* depth bracket */}
      <line
        x1="280"
        y1="120"
        x2="280"
        y2="345"
        stroke={faint}
        strokeWidth="1"
      />
      <line
        x1="276"
        y1="120"
        x2="284"
        y2="120"
        stroke={faint}
        strokeWidth="1"
      />
      <line
        x1="276"
        y1="345"
        x2="284"
        y2="345"
        stroke={faint}
        strokeWidth="1"
      />
      <text
        x="288"
        y="238"
        fontSize="12.5"
        fill={accent}
        fontFamily="Newsreader, Georgia, serif"
        fontStyle="italic"
      >
        ~15 m
      </text>

      {/* leader lines + labels */}
      <line x1="222" y1="92" x2="300" y2="78" stroke={faint} strokeWidth="1" />
      {label(304, 70, 'Surface float —')}
      {label(304, 86, 'transmitter, battery,')}
      {label(304, 102, 'thermometer')}

      <line
        x1="200"
        y1="210"
        x2="120"
        y2="200"
        stroke={faint}
        strokeWidth="1"
      />
      {label(116, 196, 'Tether', 'end')}

      <line x1="166" y1="345" x2="96" y2="345" stroke={faint} strokeWidth="1" />
      {label(92, 341, 'Holey-sock drogue —', 'end')}
      {label(92, 357, 'it grips the water, so', 'end')}
      {label(92, 373, 'the buoy follows the', 'end')}
      {label(92, 389, 'current, not the wind', 'end')}
    </svg>
  );
};
