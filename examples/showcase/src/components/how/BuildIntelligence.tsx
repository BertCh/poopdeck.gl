import React from 'react';

/**
 * "The build tunes itself" — the stt-optimize story. The four-stage pipeline
 * gains a build-time analyst that profiles the source, measures each size
 * lever on a real sample, and recommends flags with a confidence grade — then
 * a doctor audits the built tileset. The load-bearing invariant is the
 * no-thinning firewall: reversible levers can be auto-applied, but lossy ones
 * are only ever surfaced for the user to opt into by hand.
 *
 * Figures: the analyze→build→inspect→doctor loop, the sample-encode
 * measurement (with per-column cost attribution), the analysis→advice firewall,
 * the doctor's severity-ranked findings, and the baked style_hints block.
 * Every flag, verb, rule code and field name mirrors crates/stt-optimize.
 */

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

const WARM = 'rgba(240, 193, 75, 0.9)';
const WARM_SOFT = 'rgba(240, 193, 75, 0.16)';
const WARM_INK = '#8a5a0a';

const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="rounded-lg p-4"
    style={{
      background: 'var(--surface)',
      border: '1px solid var(--hairline)',
    }}
  >
    {children}
  </div>
);

const SubHead: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4
    className="font-display text-[13px] font-semibold"
    style={{ color: 'var(--ink-900)' }}
  >
    {children}
  </h4>
);

const Arrow: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    aria-hidden="true"
    style={{ color: 'var(--ink-400)' }}
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
);

/* ── 1. The self-tuning loop ──────────────────────────────────────────── */

const LOOP: { t: string; d: string; accent?: boolean }[] = [
  {
    t: 'analyze · recommend',
    d: 'profile source · zoom + bucket + advice',
    accent: true,
  },
  {
    t: 'stt-build --auto',
    d: 'basic = zoom + bucket · encode = + byte levers',
  },
  { t: 'inspect · order-audit', d: 'per-column cost · range-read cost' },
  { t: 'doctor · diff', d: 'audit + before/after · CI gates', accent: true },
];

const TuneLoop: React.FC = () => (
  <Card>
    <SubHead>The pipeline gains a build-time analyst</SubHead>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {LOOP.map((n, i) => (
        <React.Fragment key={n.t}>
          {i > 0 ? <Arrow /> : null}
          <span
            className="rounded-md px-2.5 py-1.5"
            style={{
              background: n.accent
                ? 'var(--accent-soft)'
                : 'var(--surface-sunken)',
              border: `1px solid ${n.accent ? 'var(--accent)' : 'var(--hairline)'}`,
            }}
          >
            <span
              className="block font-mono text-[11px] font-semibold"
              style={{ color: n.accent ? 'var(--accent)' : 'var(--ink-900)' }}
            >
              {n.t}
            </span>
            <span
              className="block text-[10px] mt-0.5"
              style={{ color: 'var(--ink-500)' }}
            >
              {n.d}
            </span>
          </span>
        </React.Fragment>
      ))}
      <span
        className="rounded-md px-2 py-1 text-[10px] inline-flex items-center gap-1.5"
        style={{
          border: '1px dashed var(--hairline)',
          color: 'var(--ink-400)',
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 9a8 8 0 0 1 14-4l2 2M20 15a8 8 0 0 1-14 4l-2-2"
          />
        </svg>
        re-tune next build
      </span>
    </div>
    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      <span className="font-mono">stt-optimize</span> wraps the tiler with a
      loop that runs entirely at build time — nothing here touches the serve
      path. <span className="font-mono">analyze</span> picks the zoom range and
      temporal bucket and runs the advisors;{' '}
      <span className="font-mono">--auto</span> folds the safe ones in (bare, it
      only fills zoom + bucket; <span className="font-mono">--auto encode</span>{' '}
      also applies the non-lossy byte levers); then{' '}
      <span className="font-mono">inspect</span>,{' '}
      <span className="font-mono">diff</span> and{' '}
      <span className="font-mono">doctor</span> turn the manual tuning passes
      this project kept re-running by hand into commands CI can gate on (
      <span className="font-mono">diff --fail-on-growth</span>,{' '}
      <span className="font-mono">doctor --strict</span>).
    </p>
  </Card>
);

/* ── 2. Measure, don't guess ──────────────────────────────────────────── */

// A measured per-column cost split (illustrative of a hash-id-heavy dataset):
// the id column dominates, which is exactly the smell the doctor keys off.
const COLS: { name: string; pct: number; warm?: boolean }[] = [
  { name: 'id', pct: 41, warm: true },
  { name: 'geometry', pct: 34 },
  { name: 'properties', pct: 18 },
  { name: 'time', pct: 7 },
];

const MeasureFigure: React.FC = () => {
  let acc = 0;
  return (
    <Card>
      <SubHead>
        Measure, don't guess — every projection is a real encode
      </SubHead>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {[
          'source rows',
          'deterministic stride sample',
          'real stt-core encoder + zstd',
          'per-column bytes',
        ].map((t, i) => (
          <React.Fragment key={t}>
            {i > 0 ? <Arrow /> : null}
            <span
              className="rounded-md px-2.5 py-1.5 font-mono text-[10.5px]"
              style={{
                background:
                  i === 2 ? 'var(--accent-soft)' : 'var(--surface-sunken)',
                border: `1px solid ${i === 2 ? 'var(--accent)' : 'var(--hairline)'}`,
                color: i === 2 ? 'var(--accent)' : 'var(--ink-700)',
              }}
            >
              {t}
            </span>
          </React.Fragment>
        ))}
      </div>

      {/* per-column cost bar */}
      <div className="mt-4">
        <span className="eyebrow" style={{ fontSize: 9 }}>
          attributed compressed cost (each column re-encoded alone)
        </span>
        <div
          className="mt-1.5 flex h-6 w-full overflow-hidden rounded"
          style={{ border: '1px solid var(--hairline)' }}
        >
          {COLS.map((c) => {
            const seg = (
              <div
                key={c.name}
                className="flex items-center justify-center font-mono text-[9.5px]"
                style={{
                  width: `${c.pct}%`,
                  background: c.warm ? WARM_SOFT : 'var(--surface-sunken)',
                  color: c.warm ? WARM_INK : 'var(--ink-500)',
                  borderLeft: acc > 0 ? '1px solid var(--hairline)' : undefined,
                }}
              >
                {c.pct >= 12 ? `${c.name} ${c.pct}%` : c.pct}
              </div>
            );
            acc += c.pct;
            return seg;
          })}
        </div>
      </div>

      <p
        className="mt-3 text-[11px] leading-relaxed"
        style={{ color: 'var(--ink-500)' }}
      >
        Instead of a size formula, the analyzer keeps a deterministic stride
        sample of real geometries and property values and pushes it through the
        <em> production</em> encoder plus zstd, then attributes cost by
        re-encoding each column alone. That is where a projection like{' '}
        <span className="font-mono" style={{ color: WARM_INK }}>
          −36% sample encode (measured)
        </span>{' '}
        comes from — and how the doctor knows a near-incompressible{' '}
        <span className="font-mono">id</span> column, not the geometry, is
        eating the archive.
      </p>
    </Card>
  );
};

/* ── 3. The analysis → advice firewall ────────────────────────────────── */

const ANALYZERS = ['density', 'geometry', 'spatial', 'temporal', 'properties'];
const ADVISORS = ['quantize', 'temporal', 'layout', 'budget'];

interface Advice {
  flag: string;
  why: string;
  projected: string;
  confidence: 'high' | 'medium' | 'low';
}

const REVERSIBLE: Advice[] = [
  {
    flag: '--publish',
    why: 'decode-free win at rest (zstd 19)',
    projected: '−14% (measured)',
    confidence: 'high',
  },
  {
    flag: '--blob-ordering spatial',
    why: 'time-deep, few cells',
    projected: 'measured-best over 4 812 tiles',
    confidence: 'high',
  },
  {
    flag: '--pack-size 128',
    why: 'estimated archive ~7 GiB',
    projected: '~56 objects instead of ~112',
    confidence: 'medium',
  },
];
const LOSSY: Advice[] = [
  {
    flag: '--quantize-coords 1',
    why: 'coords dominate the bytes',
    projected: '−31% (measured)',
    confidence: 'high',
  },
  {
    flag: '--quantize-attrs-auto',
    why: 'raw f64 property columns',
    projected: '−9% (measured)',
    confidence: 'medium',
  },
  {
    flag: '--maximum-tile-features 20k',
    why: 'p99 tile is 12× the median',
    projected: 'drops features to fit',
    confidence: 'medium',
  },
];

const ConfBadge: React.FC<{ c: Advice['confidence'] }> = ({ c }) => {
  const style =
    c === 'high'
      ? { background: 'var(--accent)', color: '#fff' }
      : c === 'medium'
        ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
        : { background: 'var(--surface-sunken)', color: 'var(--ink-400)' };
  return (
    <span
      className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
      style={style}
    >
      {c}
    </span>
  );
};

const AdviceRow: React.FC<{ a: Advice; warm?: boolean }> = ({ a, warm }) => (
  <div
    className="rounded-md px-2.5 py-2"
    style={{
      background: warm ? WARM_SOFT : 'var(--surface)',
      border: `1px solid ${warm ? WARM : 'var(--hairline)'}`,
    }}
  >
    <div className="flex items-center justify-between gap-2">
      <span
        className="font-mono text-[11px] font-semibold"
        style={{ color: warm ? WARM_INK : 'var(--accent)' }}
      >
        {a.flag}
      </span>
      <ConfBadge c={a.confidence} />
    </div>
    <div
      className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[10.5px]"
      style={{ color: 'var(--ink-500)' }}
    >
      <span>{a.why}</span>
      <span
        className="font-mono"
        style={{ color: warm ? WARM_INK : 'var(--ink-700)' }}
      >
        · {a.projected}
      </span>
    </div>
  </div>
);

const FirewallFigure: React.FC = () => (
  <Card>
    <SubHead>From analysis to advice — with a no-thinning firewall</SubHead>

    {/* analyzers → advisors */}
    <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="flex flex-wrap gap-1.5">
        {ANALYZERS.map((a) => (
          <span
            key={a}
            className="rounded px-1.5 py-1 font-mono text-[10px]"
            style={{
              background: 'var(--surface-sunken)',
              border: '1px solid var(--hairline)',
              color: 'var(--ink-700)',
            }}
          >
            {a}
          </span>
        ))}
      </div>
      <span className="hidden sm:inline">
        <Arrow />
      </span>
      <div className="flex flex-wrap gap-1.5">
        {ADVISORS.map((a) => (
          <span
            key={a}
            className="rounded px-1.5 py-1 font-mono text-[10px]"
            style={{
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              color: 'var(--accent)',
            }}
          >
            {a} advisor
          </span>
        ))}
      </div>
    </div>
    <p className="mt-1.5 text-[10.5px]" style={{ color: 'var(--ink-400)' }}>
      five analyzers profile the source; four advisors turn that profile into
      flag recommendations, each carrying a measured projection and a confidence
      grade.
    </p>

    {/* the gate: two lanes */}
    <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* reversible */}
      <div
        className="rounded-lg p-3"
        style={{
          border: '1px solid var(--accent)',
          background: 'var(--accent-soft)',
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: 'var(--accent)' }}
            aria-hidden="true"
          />
          <span
            className="font-display text-[12px] font-semibold"
            style={{ color: 'var(--accent)' }}
          >
            Reversible → auto-appliable
          </span>
        </div>
        <p
          className="mt-1 text-[10.5px] leading-snug"
          style={{ color: 'var(--ink-500)' }}
        >
          Byte-level, undone on decode. Folded into{' '}
          <span className="font-mono">--auto encode</span> and appended to the
          pasteable command, in advisor order. Advice that carries a real
          tradeoff (spatial ordering hurts pan) is flagged{' '}
          <span className="font-mono">suggestion_only</span> and steps out of
          both.
        </p>
        <div className="mt-2.5 space-y-1.5">
          {REVERSIBLE.map((a) => (
            <AdviceRow key={a.flag} a={a} />
          ))}
        </div>
      </div>

      {/* lossy */}
      <div
        className="rounded-lg p-3"
        style={{ border: `1px solid ${WARM}`, background: 'var(--surface)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: WARM }}
            aria-hidden="true"
          />
          <span
            className="font-display text-[12px] font-semibold"
            style={{ color: WARM_INK }}
          >
            Lossy → surfaced only, never auto
          </span>
        </div>
        <p
          className="mt-1 text-[10.5px] leading-snug"
          style={{ color: 'var(--ink-500)' }}
        >
          Degrades data. Reported loudly with its projection, but <em>you</em>{' '}
          add it by hand — never in <span className="font-mono">--auto</span>,
          never in the command.
        </p>
        <div className="mt-2.5 space-y-1.5">
          {LOSSY.map((a) => (
            <AdviceRow key={a.flag} a={a} warm />
          ))}
        </div>
      </div>
    </div>

    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      This split is the project's{' '}
      <strong style={{ color: 'var(--ink-700)' }}>no-thinning</strong> principle
      made mechanical: a build never silently throws data away to hit a size
      target. Quantization and per-tile budgets can shrink an archive a lot — so
      they stay a deliberate, per-dataset choice, and the default build is
      byte-identical whether or not you ran the analyzer.
    </p>
  </Card>
);

/* ── 4. The doctor's findings ─────────────────────────────────────────── */

interface Finding {
  sev: 'high' | 'med';
  code: string;
  smell: string;
  fix: string;
}

const FINDINGS: Finding[] = [
  {
    sev: 'high',
    code: 'expensive-feature-ids',
    smell: 'near-incompressible hash-like ids dominate the bytes',
    fix: 'sequential ids / drop',
  },
  {
    sev: 'high',
    code: 'raw-f64-column',
    smell: 'plain Float64 property columns worth quantizing',
    fix: '--quantize-attr',
  },
  {
    sev: 'high',
    code: 'missing-summary-tier',
    smell: 'huge point dataset with no aggregated overview',
    fix: '--summary-tier quadbin',
  },
  {
    sev: 'med',
    code: 'unpaged-large',
    smell: 'whole-load directory on a large tile count',
    fix: 'layout: "paged"',
  },
  {
    sev: 'med',
    code: 'oversized-blobs',
    smell: 'individual tiles past 1 MiB compressed',
    fix: 'raise min-zoom / split',
  },
  {
    sev: 'med',
    code: 'z0-bomb',
    smell: 'deep pyramid under a tiny geographic extent',
    fix: 'clamp zoom range',
  },
  {
    sev: 'med',
    code: 'dead-columns',
    smell: 'constant / all-null property columns',
    fix: 'drop at source',
  },
];

const DoctorFigure: React.FC = () => (
  <Card>
    <SubHead>
      The doctor — severity-ranked findings on the built tileset
    </SubHead>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[11px]">
        <thead>
          <tr style={{ color: 'var(--ink-400)' }}>
            <th className="text-left font-medium pb-1.5 pr-2">sev</th>
            <th className="text-left font-medium pb-1.5 pr-3">
              finding (stable code)
            </th>
            <th className="text-left font-medium pb-1.5 pr-3">
              what it smells
            </th>
            <th className="text-left font-medium pb-1.5">remediation</th>
          </tr>
        </thead>
        <tbody>
          {FINDINGS.map((f) => (
            <tr key={f.code} style={{ borderTop: '1px solid var(--hairline)' }}>
              <td className="py-1.5 pr-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    background: f.sev === 'high' ? WARM : 'var(--ink-400)',
                  }}
                  aria-label={
                    f.sev === 'high' ? 'high severity' : 'medium severity'
                  }
                />
              </td>
              <td
                className="py-1.5 pr-3 font-mono"
                style={{ color: 'var(--ink-900)' }}
              >
                {f.code}
              </td>
              <td className="py-1.5 pr-3" style={{ color: 'var(--ink-500)' }}>
                {f.smell}
              </td>
              <td className="py-1.5">
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                  style={{
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                  }}
                >
                  {f.fix}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <p
      className="mt-3 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      Each rule keys off numbers already measured for <em>this</em> tileset —
      directory stats and per-column costs from{' '}
      <span className="font-mono">inspect</span> — and cites them in its
      message; the doctor never re-encodes, so every delta is labelled{' '}
      <span className="font-mono">(estimated from measured column costs)</span>.
      Run it with <span className="font-mono">--strict</span> and a fresh smell
      fails the build.
    </p>
  </Card>
);

/* ── 5. style_hints (Deeper) ──────────────────────────────────────────── */

const StyleHintsFigure: React.FC = () => (
  <Card>
    <SubHead>Deeper: the archive describes how to style itself</SubHead>
    <p
      className="mt-1 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      Every non-streaming build already bakes the cheap signals into{' '}
      <span className="font-mono">manifest.json</span> — the dominant layer kind
      and a suggested playback duration — so a client can open a strange archive
      and pick a clock with no config.{' '}
      <span className="font-mono">--style-hints</span> adds the expensive part:
      a full per-property profile with percentiles and a suggested colour
      domain.
    </p>
    <div className="mt-3 overflow-x-auto">
      <pre
        className="rounded-md p-3 text-[10.5px] leading-relaxed"
        style={{
          background: 'var(--surface-sunken)',
          border: '1px solid var(--hairline)',
          color: 'var(--ink-700)',
          fontFamily: MONO,
        }}
      >{`"style_hints": {
  "version": 1,
  "layer_hint": "trips",              // always baked
  "suggested_playback_seconds": 45,   // always baked
  "properties": [                     // --style-hints only
    { "name": "speed_kmh", "min": 0, "p50": 14.2, "p95": 31.6,
      "p97": 34.0, "p99": 41.8, "max": 58, "suggested_domain": [0, 34] },
    { "name": "route_id", "cardinality": 214 }
  ]
}`}</pre>
    </div>
    <p
      className="mt-2 text-[11px] leading-relaxed"
      style={{ color: 'var(--ink-500)' }}
    >
      The domain clamps at p97, not max — one outlier must not dim the whole
      ramp. Values are sampled at a deterministic stride (capped per property),
      so the block is byte-identical across rebuilds of the same input, safe to
      content-address alongside everything else.
    </p>
  </Card>
);

const BuildIntelligence: React.FC = () => (
  <div className="space-y-4">
    <TuneLoop />
    <MeasureFigure />
    <FirewallFigure />
    <DoctorFigure />
    <StyleHintsFigure />
  </div>
);

export default BuildIntelligence;
