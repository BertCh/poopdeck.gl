/**
 * Bottom-left radial CAN-bus gauges for the AV cockpit. One gauge per field
 * present in `telemetry.json` (speed / steering / accel / …). Each reads the
 * active sample at the playhead by binary-searching the field's sorted
 * `[t, v]` series — driven off the shared TimeController's tick, so the gauges
 * stay locked to the same clock the layers animate on (and don't force a React
 * re-render of the whole cockpit per frame).
 *
 * Missing telemetry → the whole panel is hidden by the parent (no hard fail).
 */
import React, { useEffect, useRef } from "react";
import type { TimeController } from "@poopdeck.gl/playback";
import {
  telemetryValueAt,
  type AvTelemetry,
  type AvTelemetryField,
} from "./sceneTypes";

export interface MetricGaugesProps {
  telemetry: AvTelemetry;
  timeController: TimeController;
}

/** A field's typical magnitude, for normalizing the arc fill (0..1). */
function fieldScale(key: string, unit: string): { max: number; signed: boolean } {
  if (key === "speed") return { max: 30, signed: false }; // ~108 km/h
  if (key === "steer") return { max: Math.PI / 4, signed: true }; // ±45°
  if (key === "accel") return { max: 5, signed: true }; // ±5 m/s²
  if (unit === "frac") return { max: 1, signed: false };
  return { max: 10, signed: false };
}

function formatValue(key: string, v: number, unit: string): string {
  if (key === "speed") return `${(v * 3.6).toFixed(0)}`; // km/h for readability
  if (unit === "rad") return `${((v * 180) / Math.PI).toFixed(0)}°`;
  if (unit === "frac") return `${(v * 100).toFixed(0)}%`;
  return v.toFixed(1);
}

function unitLabel(key: string, unit: string): string {
  if (key === "speed") return "km/h";
  if (unit === "rad") return "deg";
  if (unit === "frac") return "%";
  return unit;
}

const R = 26;
const CIRC = 2 * Math.PI * R;

/** One radial gauge — an SVG ring whose fill arc tracks the field value. */
const Gauge: React.FC<{
  fieldKey: string;
  field: AvTelemetryField;
  timeController: TimeController;
}> = ({ fieldKey, field, timeController }) => {
  const arcRef = useRef<SVGCircleElement | null>(null);
  const valueRef = useRef<HTMLDivElement | null>(null);
  const { max, signed } = fieldScale(fieldKey, field.unit);

  useEffect(() => {
    const render = (t: number) => {
      const v = telemetryValueAt(field, t);
      if (v == null) return;
      // Normalize to 0..1 of the dial. Signed fields center at half-fill.
      const norm = signed
        ? Math.min(1, Math.max(0, 0.5 + v / max / 2))
        : Math.min(1, Math.max(0, v / max));
      if (arcRef.current) {
        arcRef.current.style.strokeDashoffset = `${CIRC * (1 - norm)}`;
      }
      if (valueRef.current) {
        valueRef.current.textContent = formatValue(fieldKey, v, field.unit);
      }
    };
    // Seed immediately, then follow the clock.
    render(timeController.getTime());
    const off = timeController.on("tick", render);
    return off;
  }, [field, fieldKey, timeController, max, signed]);

  return (
    <div className="flex flex-col items-center w-16">
      <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
        <circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          stroke="rgba(255,255,255,0.10)"
          strokeWidth="5"
        />
        <circle
          ref={arcRef}
          cx="32"
          cy="32"
          r={R}
          fill="none"
          stroke="rgb(94,212,255)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC}
          style={{ transition: "stroke-dashoffset 80ms linear" }}
        />
      </svg>
      <div className="-mt-11 flex flex-col items-center pointer-events-none">
        <div
          ref={valueRef}
          className="text-base font-semibold text-slate-100 tabular-nums leading-none"
        >
          –
        </div>
        <div className="text-[9px] text-slate-500 leading-none mt-0.5">
          {unitLabel(fieldKey, field.unit)}
        </div>
      </div>
      <div className="mt-5 text-[10px] uppercase tracking-wide text-slate-400">
        {field.label}
      </div>
    </div>
  );
};

const MetricGauges: React.FC<MetricGaugesProps> = ({
  telemetry,
  timeController,
}) => {
  const entries = Object.entries(telemetry.fields ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-black/55 backdrop-blur-md px-3 py-2.5 shadow-xl">
      <div className="flex items-end gap-2">
        {entries.map(([key, field]) => (
          <Gauge
            key={key}
            fieldKey={key}
            field={field}
            timeController={timeController}
          />
        ))}
      </div>
    </div>
  );
};

export default MetricGauges;
