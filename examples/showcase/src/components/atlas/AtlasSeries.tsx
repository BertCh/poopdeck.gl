/**
 * Activation over the token axis — where transformer depth went.
 *
 * The map used to encode the layer index as point altitude at 150 km a layer,
 * which set a 1,650 km stack against families 0.7 km wide and produced the
 * towers this rebuild exists to remove. Depth reads far better as a 12-row
 * strip chart than it ever did as geometry, and as a chart it costs the map
 * nothing: X/Y/Z are free to be one isotropic embedding.
 *
 * Three rows, one clock:
 *   • layer × token — mean activation per (layer, token). Vertical structure
 *     here is a token exciting the whole stack; horizontal structure is a
 *     feature staying on across several tokens.
 *   • activity — total activation per token, the transport's own waveform.
 *   • selection — the inspected latent's series, fetched on demand by Range
 *     request, drawn under the metric currently selected.
 *
 * Everything is drawn to one canvas on data change; the playhead is a DOM rule
 * on top, so scrubbing never repaints the series.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import {
  decodeGrid,
  decodeSeries,
  densify,
  type NodeSeries,
} from './atlasSeriesData';
import type { AtlasMetricId, AtlasSidecar } from './atlasTypes';

export interface AtlasSeriesProps {
  sidecar: AtlasSidecar;
  tokenIndex: number;
  metric: AtlasMetricId;
  selection: NodeSeries | null;
  selectionLabel?: string;
  onSeekToken: (index: number) => void;
}

const GRID_H = 72;
const WAVE_H = 26;
const SEL_H = 30;

/** Dark → warm, matching the activation ramp's reading without importing it. */
function heat(t: number): [number, number, number] {
  const stops: [number, number, number][] = [
    [10, 13, 26],
    [32, 54, 110],
    [58, 124, 178],
    [142, 205, 198],
    [255, 233, 168],
  ];
  const f = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const g = f - i;
  return [0, 1, 2].map((c) =>
    Math.round(stops[i][c] + (stops[i + 1][c] - stops[i][c]) * g),
  ) as [number, number, number];
}

const AtlasSeries: React.FC<AtlasSeriesProps> = ({
  sidecar,
  tokenIndex,
  metric,
  selection,
  selectionLabel,
  onSeekToken,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLButtonElement | null>(null);

  const grid = useMemo(
    () => decodeGrid(sidecar.series?.layer_token),
    [sidecar],
  );
  const activity = useMemo(
    () => decodeSeries(sidecar.series?.activity),
    [sidecar],
  );
  const cols = grid?.cols ?? sidecar.trace.tokens.length;

  const selValues = useMemo(() => {
    if (!selection) return null;
    return densify(
      selection,
      cols,
      metric === 'attribution' ? 'attribution' : 'activation',
    );
  }, [selection, cols, metric]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(wrap.clientWidth));
    const h = GRID_H + WAVE_H + (selValues ? SEL_H : 0);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // ── layer × token ────────────────────────────────────────────────────
    if (grid && grid.max > 0) {
      const img = ctx.createImageData(Math.floor(w * dpr), Math.floor(GRID_H * dpr));
      const rowH = (GRID_H * dpr) / grid.rows;
      for (let py = 0; py < GRID_H * dpr; py += 1) {
        // Row 0 is layer 0; draw it at the BOTTOM so depth increases upward,
        // which is the one thing the old altitude encoding got right.
        const row = Math.min(grid.rows - 1, grid.rows - 1 - Math.floor(py / rowH));
        for (let px = 0; px < w * dpr; px += 1) {
          const c0 = Math.floor((px / (w * dpr)) * grid.cols);
          const c1 = Math.max(c0 + 1, Math.floor(((px + 1) / (w * dpr)) * grid.cols));
          let v = 0;
          for (let c = c0; c < c1 && c < grid.cols; c += 1) {
            const x = grid.values[row * grid.cols + c];
            if (x > v) v = x;
          }
          const [r, g, b] = heat(Math.log1p(v) / Math.log1p(grid.max));
          const o = (py * Math.floor(w * dpr) + px) * 4;
          img.data[o] = r;
          img.data[o + 1] = g;
          img.data[o + 2] = b;
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    // ── activity waveform ────────────────────────────────────────────────
    if (activity) {
      let max = 0;
      for (let i = 0; i < activity.length; i += 1)
        if (activity[i] > max) max = activity[i];
      ctx.fillStyle = 'rgba(120,170,255,0.32)';
      const base = GRID_H + WAVE_H;
      for (let px = 0; px < w; px += 1) {
        const c0 = Math.floor((px / w) * activity.length);
        const c1 = Math.max(c0 + 1, Math.floor(((px + 1) / w) * activity.length));
        let v = 0;
        for (let c = c0; c < c1 && c < activity.length; c += 1)
          if (activity[c] > v) v = activity[c];
        const bar = max > 0 ? (v / max) * (WAVE_H - 3) : 0;
        ctx.fillRect(px, base - bar, 1, bar);
      }
    }

    // ── selection ────────────────────────────────────────────────────────
    if (selValues) {
      const top = GRID_H + WAVE_H;
      const mid = top + SEL_H / 2;
      let max = 1e-9;
      for (let i = 0; i < selValues.length; i += 1)
        max = Math.max(max, Math.abs(selValues[i]));
      const signed = metric === 'attribution';
      ctx.strokeStyle = 'rgba(150,170,220,0.22)';
      ctx.beginPath();
      ctx.moveTo(0, signed ? mid : top + SEL_H - 1);
      ctx.lineTo(w, signed ? mid : top + SEL_H - 1);
      ctx.stroke();
      for (let px = 0; px < w; px += 1) {
        const c0 = Math.floor((px / w) * selValues.length);
        const c1 = Math.max(c0 + 1, Math.floor(((px + 1) / w) * selValues.length));
        let v = 0;
        for (let c = c0; c < c1 && c < selValues.length; c += 1) {
          if (Math.abs(selValues[c]) > Math.abs(v)) v = selValues[c];
        }
        if (v === 0) continue;
        const mag = (Math.abs(v) / max) * (signed ? SEL_H / 2 - 2 : SEL_H - 3);
        ctx.fillStyle =
          signed && v < 0 ? 'rgba(120,165,255,0.95)' : 'rgba(255,190,120,0.95)';
        if (signed) ctx.fillRect(px, v < 0 ? mid : mid - mag, 1, mag);
        else ctx.fillRect(px, top + SEL_H - 1 - mag, 1, mag);
      }
    }
  }, [grid, activity, selValues, metric]);

  const seek = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left) / Math.max(1, rect.width);
    onSeekToken(Math.round(f * (cols - 1)));
  };

  const playheadPct = cols > 1 ? (tokenIndex / (cols - 1)) * 100 : 0;

  return (
    <div style={css.shell}>
      <div style={css.legend}>
        <span>
          layer × token — <span style={css.dim}>depth up, time right</span>
        </span>
        {selectionLabel && (
          <span style={css.sel}>
            {selectionLabel} · {metric}
          </span>
        )}
      </div>
      {/* Same reasoning as the reading strip: one real <button>, so click and
          keyboard both come for free and the canvas stays presentational. */}
      <button
        type="button"
        ref={wrapRef}
        style={css.plot}
        onClick={seek}
        aria-label={`Activation series — seek by token, currently ${tokenIndex} of ${cols}`}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          onSeekToken(
            Math.min(cols - 1, Math.max(0, tokenIndex + d * (e.shiftKey ? 10 : 1))),
          );
        }}
      >
        <canvas ref={canvasRef} style={{ display: 'block' }} />
        <div style={{ ...css.playhead, left: `${playheadPct}%` }} />
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
    padding: '8px 10px 6px',
    marginBottom: 8,
  } as React.CSSProperties,
  legend: {
    display: 'flex',
    justifyContent: 'space-between',
    font: '11px ui-sans-serif, system-ui, sans-serif',
    color: '#8e9ab5',
    marginBottom: 6,
  } as React.CSSProperties,
  dim: { opacity: 0.65 } as React.CSSProperties,
  sel: { color: '#9ec9ff' } as React.CSSProperties,
  plot: {
    // A <button> for the semantics, styled back to a plain surface.
    appearance: 'none',
    border: 0,
    background: 'transparent',
    padding: 0,
    display: 'block',
    width: '100%',
    position: 'relative',
    cursor: 'crosshair',
    borderRadius: 4,
    overflow: 'hidden',
  } as React.CSSProperties,
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    background: 'rgba(255,255,255,0.85)',
    boxShadow: '0 0 6px rgba(255,255,255,0.5)',
    pointerEvents: 'none',
  } as React.CSSProperties,
};

export default AtlasSeries;
