/**
 * The reading strip: the model's position in the text, scrubbable token by token.
 *
 * The first build put this in the side panel as a read-only 22-token window of
 * raw BPE pieces, and ran the clock at 8,128 tokens in 90 seconds — 90 tokens a
 * second, 11 ms each. Nothing was legible and nothing was seekable, which
 * defeated the one claim the page makes: that you can watch a model read.
 *
 * What changed:
 *   • it is a first-class surface at the bottom of the map, not a card;
 *   • the current token is PINNED at a fixed reading position and the text
 *     slides underneath it, so the eye has somewhere to rest — a window that
 *     re-flows around the playhead jitters horizontally on every token;
 *   • click any token to seek there; ← → step one token, shift steps ten,
 *     space plays and pauses;
 *   • the 64 per-window prediction targets are marked inline, because the
 *     attribution metric is defined against exactly those tokens and a reader
 *     otherwise has no way to know which token the colours are answering to.
 *
 * The playhead is the token index by construction (one token = one second of
 * sim time), so seeking is exact rather than an estimate.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AtlasSidecar } from './atlasTypes';

/** Where in the strip the current token sits, as a fraction of the width. */
const READING_POSITION = 0.32;
/** Tokens drawn either side of the playhead. Enough to fill a wide viewport. */
const HALF_WINDOW = 90;

export interface AtlasReadingStripProps {
  sidecar: AtlasSidecar;
  tokenIndex: number;
  isPlaying: boolean;
  onSeekToken: (index: number) => void;
  onPlayPause: () => void;
  /** Tokens per second of wall clock, for the rate read-out. */
  tokensPerSecond: number;
  onTokensPerSecond: (rate: number) => void;
}

/**
 * The unit of this demo is one token's projection onto the atlas, so the rates
 * are built around actually seeing one: `Read` holds each token for a full
 * second, `Study` for two. The old 90/s is still here as `Sweep`, but as an
 * explicit choice rather than as the only speed.
 */
const RATES: { label: string; rate: number; hint: string }[] = [
  { label: 'Study', rate: 0.5, hint: '2 s per token' },
  { label: 'Read', rate: 1, hint: '1 token/s — one projection at a time' },
  { label: 'Scan', rate: 8, hint: '8 tokens/s' },
  {
    label: 'Sweep',
    rate: 60,
    hint: '60 tokens/s — the whole session in ~2 min',
  },
];

const AtlasReadingStrip: React.FC<AtlasReadingStripProps> = ({
  sidecar,
  tokenIndex,
  isPlaying,
  onSeekToken,
  onPlayPause,
  tokensPerSecond,
  onTokensPerSecond,
}) => {
  const tokens = sidecar.trace.tokens;
  const total = tokens.length;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef<HTMLSpanElement | null>(null);

  /** token index → the window's prediction target, for the inline marks. */
  const targetAt = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of sidecar.trace.targets ?? []) {
      m.set(t.at_token_index, t.target_token);
    }
    return m;
  }, [sidecar]);

  const from = Math.max(0, tokenIndex - HALF_WINDOW);
  const to = Math.min(total, tokenIndex + HALF_WINDOW);
  const slice = useMemo(() => tokens.slice(from, to), [tokens, from, to]);

  // Pin the current token: measure where it landed and translate the track so
  // it sits at READING_POSITION. Layout-effect so the shift is committed in the
  // same frame the token changes and the text never visibly snaps.
  useEffect(() => {
    const track = trackRef.current;
    const cur = currentRef.current;
    if (!track || !cur) return;
    const anchor = track.parentElement!.clientWidth * READING_POSITION;
    track.style.transform = `translateX(${anchor - cur.offsetLeft}px)`;
  }, [tokenIndex, slice]);

  const step = useCallback(
    (delta: number) =>
      onSeekToken(Math.min(total - 1, Math.max(0, tokenIndex + delta))),
    [onSeekToken, tokenIndex, total],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(e.shiftKey ? 10 : 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(e.shiftKey ? -10 : -1);
      } else if (e.key === ' ') {
        e.preventDefault();
        onPlayPause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, onPlayPause]);

  return (
    <div style={css.shell}>
      <div style={css.head}>
        <button type="button" onClick={onPlayPause} style={css.play}>
          {isPlaying ? '❚❚' : '▶'}
        </button>
        <span style={css.count}>
          token{' '}
          <strong style={{ color: '#e6ebf5' }}>
            {tokenIndex.toLocaleString()}
          </strong>{' '}
          / {total.toLocaleString()}
        </span>
        <span style={css.rates}>
          {RATES.map((r) => (
            <button
              key={r.label}
              type="button"
              title={r.hint}
              onClick={() => onTokensPerSecond(r.rate)}
              style={css.rate(Math.abs(tokensPerSecond - r.rate) < 0.01)}
            >
              {r.label}
            </button>
          ))}
        </span>
        <span style={css.hint}>← → step · shift ×10 · space play</span>
      </div>

      {/* The strip as a whole is ONE focus stop with arrow-key control, rather
          than 180 individually tabbable token spans. A real <button> carries
          that natively; clicks are delegated off `data-token` so the spans stay
          presentational. */}
      <button
        type="button"
        style={css.viewport}
        aria-label={`Reading position: token ${tokenIndex} of ${total}`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            step(e.shiftKey ? 10 : 1);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            step(e.shiftKey ? -10 : -1);
          }
        }}
        onClick={(e) => {
          const hit = (e.target as HTMLElement).closest('[data-token]');
          const idx = hit?.getAttribute('data-token');
          if (idx != null) onSeekToken(Number(idx));
        }}
      >
        {/* The reading line: a fixed mark the current token is held against. */}
        <div style={{ ...css.anchor, left: `${READING_POSITION * 100}%` }} />
        <div ref={trackRef} style={css.track}>
          {slice.map((raw, i) => {
            const idx = from + i;
            const isCurrent = idx === tokenIndex;
            const isPast = idx < tokenIndex;
            const target = targetAt.get(idx);
            return (
              <span
                key={idx}
                data-token={idx}
                ref={isCurrent ? currentRef : undefined}
                title={
                  target
                    ? `token ${idx} — attribution target for this window: ${JSON.stringify(target)}`
                    : `token ${idx} — ${JSON.stringify(raw)}`
                }
                style={{
                  ...css.token,
                  color: isCurrent ? '#0a0c14' : isPast ? '#cdd7ee' : '#68738c',
                  background: isCurrent ? '#9ec9ff' : 'transparent',
                  borderBottom: target
                    ? '2px solid rgba(255,160,110,0.85)'
                    : '2px solid transparent',
                }}
              >
                {/* Raw BPE pieces carry their own leading space; render it so
                    the strip reads as prose rather than as a token list. */}
                {raw.replace(/\n/g, '⏎')}
              </span>
            );
          })}
        </div>
      </button>
    </div>
  );
};

const css = {
  shell: {
    background: 'rgba(10,12,20,0.86)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(150,170,220,0.18)',
    borderRadius: 10,
    padding: '9px 0 4px',
    overflow: 'hidden',
  } as React.CSSProperties,
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 12px 8px',
    font: '11.5px ui-sans-serif, system-ui, sans-serif',
    color: '#8e9ab5',
  } as React.CSSProperties,
  play: {
    appearance: 'none',
    border: '1px solid rgba(150,170,220,0.3)',
    background: 'rgba(255,255,255,0.06)',
    color: '#e6ebf5',
    borderRadius: 6,
    width: 30,
    height: 24,
    cursor: 'pointer',
    font: '11px/1 inherit',
  } as React.CSSProperties,
  count: { minWidth: 130 } as React.CSSProperties,
  rates: { display: 'flex', gap: 4 } as React.CSSProperties,
  rate: (on: boolean): React.CSSProperties => ({
    appearance: 'none',
    border: `1px solid ${on ? 'rgba(150,200,255,0.5)' : 'rgba(150,170,220,0.18)'}`,
    background: on ? 'rgba(90,150,240,0.22)' : 'transparent',
    color: on ? '#e9f1ff' : '#8e9ab5',
    borderRadius: 5,
    padding: '2px 8px',
    font: 'inherit',
    cursor: 'pointer',
  }),
  hint: { marginLeft: 'auto', opacity: 0.7 } as React.CSSProperties,
  viewport: {
    // A <button> for the semantics, styled back to a plain surface.
    appearance: 'none',
    border: 0,
    background: 'transparent',
    padding: 0,
    display: 'block',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    position: 'relative',
    overflow: 'hidden',
    height: 34,
    maskImage:
      'linear-gradient(90deg, transparent 0, #000 4%, #000 92%, transparent 100%)',
    WebkitMaskImage:
      'linear-gradient(90deg, transparent 0, #000 4%, #000 92%, transparent 100%)',
  } as React.CSSProperties,
  anchor: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    width: 1,
    background: 'rgba(158,201,255,0.28)',
    pointerEvents: 'none',
  } as React.CSSProperties,
  track: {
    position: 'absolute',
    top: 0,
    left: 0,
    whiteSpace: 'pre',
    font: '14px/34px ui-monospace, SFMono-Regular, Menlo, monospace',
    transition: 'transform 90ms linear',
    willChange: 'transform',
  } as React.CSSProperties,
  token: {
    cursor: 'pointer',
    borderRadius: 3,
    padding: '1px 0',
  } as React.CSSProperties,
};

export default AtlasReadingStrip;
