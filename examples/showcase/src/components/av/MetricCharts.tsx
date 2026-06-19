/**
 * Telemetry strip-charts for the AV cockpit — a Cabana / XVIZ-Metrics-style
 * panel of scrolling time-series strips, one per field present in
 * `telemetry.json` (speed / steer / accel / …). Each strip draws the field's
 * `[t, v]` samples within a moving `[t - windowMs, t]` window into a fixed
 * viewBox, with the playhead pinned at the right edge and a numeric readout of
 * the value at the cursor.
 *
 * Like {@link MetricGauges}, updates are driven imperatively off the shared
 * TimeController's `tick` (mutating the SVG `<path d>` / readout via refs) so
 * the cockpit does NOT re-render per frame — the strips stay locked to the same
 * clock the layers animate on. The window bounds are found with two binary
 * searches (`sampleIndexAtOrBefore`) so the work is O(visible samples).
 *
 * Reduced motion: render the field's WHOLE series statically (no scrolling
 * playhead, no per-tick redraw) — the value readout still tracks the playhead.
 *
 * Missing telemetry → the parent hides the panel (no hard fail).
 */
import React, { useEffect, useMemo, useRef } from "react";
import type { TimeController } from "@poopdeck.gl/playback";
import { useReducedMotion } from "../../lib/reducedMotion";
import {
  sampleIndexAtOrBefore,
  telemetryValueAt,
  type AvTelemetry,
  type AvTelemetryField,
} from "./sceneTypes";

export interface MetricChartsProps {
  telemetry: AvTelemetry;
  timeController: TimeController;
  /** Moving-window span in ms (default ~8 s). */
  windowMs?: number;
}

const DEFAULT_WINDOW_MS = 8000;

// Strip geometry (SVG user units; the element is responsively sized via CSS).
const W = 220;
const H = 34;
const PAD_Y = 4; // vertical inset so the trace doesn't touch the edges

/** Min/max of a field's values across ALL samples (the strip's y-domain). */
function fieldExtent(field: AvTelemetryField): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const [, v] of field.samples) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) {
    // Flat series — give the line some room so it doesn't hug an edge.
    const pad = Math.abs(min) > 1e-6 ? Math.abs(min) * 0.5 : 1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

function formatValue(key: string, v: number, unit: string): string {
  if (key === "speed") return `${(v * 3.6).toFixed(0)}`; // km/h, matches the gauges
  if (unit === "rad") return `${((v * 180) / Math.PI).toFixed(0)}`;
  if (unit === "frac") return `${(v * 100).toFixed(0)}`;
  return v.toFixed(1);
}

function unitLabel(key: string, unit: string): string {
  if (key === "speed") return "km/h";
  if (unit === "rad") return "deg";
  if (unit === "frac") return "%";
  return unit;
}

/** One field's strip-chart. */
const Strip: React.FC<{
  fieldKey: string;
  field: AvTelemetryField;
  timeController: TimeController;
  windowMs: number;
  reducedMotion: boolean;
}> = ({ fieldKey, field, timeController, windowMs, reducedMotion }) => {
  const pathRef = useRef<SVGPathElement | null>(null);
  const zeroRef = useRef<SVGLineElement | null>(null);
  const valueRef = useRef<HTMLSpanElement | null>(null);

  const { min, max } = useMemo(() => fieldExtent(field), [field]);

  // Map a value to a y in [PAD_Y, H-PAD_Y] (inverted: larger value → higher up).
  const yOf = useMemo(() => {
    const span = max - min || 1;
    return (v: number) => H - PAD_Y - ((v - min) / span) * (H - 2 * PAD_Y);
  }, [min, max]);

  // y of the zero line (clamped into view; null when 0 is off the domain).
  const zeroY = useMemo(() => {
    if (0 < min || 0 > max) return null;
    return yOf(0);
  }, [min, max, yOf]);

  // Static full-window trace (reduced motion): the whole series, mapped left→right.
  const staticPath = useMemo(() => {
    if (!reducedMotion) return "";
    const s = field.samples;
    if (s.length === 0) return "";
    const t0 = s[0][0];
    const t1 = s[s.length - 1][0];
    const tspan = t1 - t0 || 1;
    let d = "";
    for (let i = 0; i < s.length; i++) {
      const x = ((s[i][0] - t0) / tspan) * W;
      const y = yOf(s[i][1]);
      d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  }, [reducedMotion, field, yOf]);

  useEffect(() => {
    const samples = field.samples;

    const render = (t: number) => {
      // Value readout tracks the playhead in both modes.
      if (valueRef.current) {
        const v = telemetryValueAt(field, t);
        valueRef.current.textContent =
          v == null ? "–" : formatValue(fieldKey, v, field.unit);
      }
      if (reducedMotion) return; // static trace is drawn declaratively

      // Build the scrolling trace over [t - windowMs, t], pinned to the right.
      const t0 = t - windowMs;
      // First sample at-or-after the window start (one before the right edge of
      // the lower bound), via the shared binary search.
      const before = sampleIndexAtOrBefore(samples, t0);
      const start = before < 0 ? 0 : before; // include the bracketing sample so the line enters from the left
      const end = sampleIndexAtOrBefore(samples, t); // last sample at-or-before now
      if (pathRef.current) {
        if (end < 0 || samples.length === 0) {
          pathRef.current.setAttribute("d", "");
        } else {
          let d = "";
          let first = true;
          for (let i = start; i <= end; i++) {
            const x = ((samples[i][0] - t0) / windowMs) * W;
            const y = yOf(samples[i][1]);
            d += `${first ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
            first = false;
          }
          // Extend the trace to the right edge (the playhead "now") by holding
          // the last value, so the line always reaches the pinned cursor.
          const lastY = yOf(samples[end][1]);
          d += `L${W} ${lastY.toFixed(1)}`;
          pathRef.current.setAttribute("d", d);
        }
      }
    };

    render(timeController.getTime());
    if (reducedMotion) return; // no tick subscription under reduced motion
    const off = timeController.on("tick", render);
    return off;
  }, [field, fieldKey, timeController, windowMs, reducedMotion, yOf]);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-slate-400">
          {field.label}
        </span>
        <span className="text-[11px] text-slate-200 tabular-nums">
          <span ref={valueRef}>–</span>
          <span className="ml-0.5 text-[9px] text-slate-500">
            {unitLabel(fieldKey, field.unit)}
          </span>
        </span>
      </div>
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full overflow-hidden rounded bg-white/[0.03]"
      >
        {/* Faint zero baseline, when 0 sits inside the value domain. */}
        {zeroY != null && (
          <line
            ref={zeroRef}
            x1={0}
            x2={W}
            y1={zeroY}
            y2={zeroY}
            stroke="rgba(255,255,255,0.10)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          ref={pathRef}
          d={reducedMotion ? staticPath : ""}
          fill="none"
          stroke="rgb(94,212,255)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Playhead pinned at the right edge (scrolling mode only). */}
        {!reducedMotion && (
          <line
            x1={W}
            x2={W}
            y1={0}
            y2={H}
            stroke="rgba(94,212,255,0.55)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
};

const MetricCharts: React.FC<MetricChartsProps> = ({
  telemetry,
  timeController,
  windowMs = DEFAULT_WINDOW_MS,
}) => {
  const reducedMotion = useReducedMotion();
  const entries = Object.entries(telemetry.fields ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="w-64 rounded-lg border border-white/10 bg-black/55 px-3 py-2.5 shadow-xl backdrop-blur-md">
      <div className="flex flex-col gap-2.5">
        {entries.map(([key, field]) => (
          <Strip
            key={key}
            fieldKey={key}
            field={field}
            timeController={timeController}
            windowMs={windowMs}
            reducedMotion={reducedMotion}
          />
        ))}
      </div>
    </div>
  );
};

export default MetricCharts;
