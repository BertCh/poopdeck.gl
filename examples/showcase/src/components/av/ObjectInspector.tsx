/**
 * Object inspector — a streetscape.gl-style selection card for the AV cockpit.
 *
 * Purely presentational: the Lead wires picking in {@link AvDeck} (`pickable:true`
 * + `onClick`) and lifts the decoded tile-feature props into a {@link PickedObject},
 * which this card renders as a small glass panel (class + colour swatch, track id,
 * speed in km/h, L×W×H in metres, heading in degrees). A close button clears the
 * selection; the card is hidden entirely when `object` is null.
 *
 * Every field is optional — they come straight off decoded tile props, and not
 * every scene/object carries every column (AV2 has no real velocity in Round 1,
 * synthetic scenes may omit dimensions, etc.). Missing fields render as "—".
 */
import React from "react";
import type { ColorRGBA } from "../../types";

/**
 * The decoded tile-feature props for one picked object. All optional because
 * they come from per-dataset object columns that vary by scene; the card
 * degrades gracefully (shows "—") for anything absent.
 */
export interface PickedObject {
  /** Object class, e.g. `car` / `pedestrian` (the colour-swatch key). */
  category?: string;
  /** Per-object track identifier (string or numeric in the tile). */
  track_id?: string | number;
  /** Ground speed in m/s (CAN/annotation frame). */
  speed?: number;
  /** Box dimensions in metres. */
  length?: number;
  width?: number;
  height?: number;
  /** Heading in radians (CCW from +x, the av_common convention). */
  heading?: number;
}

export interface ObjectInspectorProps {
  object: PickedObject | null;
  onClose: () => void;
  /**
   * Class → RGBA palette (scene.json `objectColors`, falling back to the
   * Dataset's `avObjectColors`). Drives the colour swatch so the card matches
   * the rendered boxes.
   */
  objectColors?: Record<string, ColorRGBA>;
  /**
   * Sizing override for the root (default `w-56` for the desktop bottom-right
   * card). The mobile chrome passes `w-full` so it spans the bottom sheet.
   */
  className?: string;
}

/** A finite number, or undefined — guards against NaN/null tile props. */
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const css = (c: ColorRGBA | undefined): string =>
  c ? `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})` : "rgba(148,163,184,0.9)";

/** One label/value row. */
const Row: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex items-center justify-between gap-4 py-0.5">
    <span className="text-[10px] uppercase tracking-wide text-slate-500">
      {label}
    </span>
    <span className="text-xs text-slate-100 tabular-nums">{children}</span>
  </div>
);

const ObjectInspector: React.FC<ObjectInspectorProps> = ({
  object,
  onClose,
  objectColors,
  className,
}) => {
  if (!object) return null;

  const category = object.category ?? "object";
  const swatch = css(objectColors?.[category]);

  const speed = num(object.speed);
  const length = num(object.length);
  const width = num(object.width);
  const height = num(object.height);
  const heading = num(object.heading);

  const dims =
    length != null || width != null || height != null
      ? [length, width, height]
          .map((d) => (d != null ? d.toFixed(1) : "–"))
          .join(" × ")
      : "—";

  return (
    <div
      className={`rounded-lg border border-white/10 bg-black/60 text-slate-200 shadow-xl backdrop-blur-md ${
        className ?? "w-56"
      }`}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm ring-1 ring-white/20"
            style={{ background: swatch }}
            aria-hidden
          />
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-slate-100">
            {category}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="-mr-1 rounded px-1 text-slate-400 hover:text-slate-100"
        >
          ✕
        </button>
      </div>
      <div className="px-3 py-2">
        <Row label="Track">
          {object.track_id != null ? String(object.track_id) : "—"}
        </Row>
        <Row label="Speed">
          {speed != null ? (
            <>
              {(speed * 3.6).toFixed(0)}{" "}
              <span className="text-slate-500">km/h</span>
            </>
          ) : (
            "—"
          )}
        </Row>
        <Row label="L × W × H">
          {dims}
          {dims !== "—" && <span className="text-slate-500"> m</span>}
        </Row>
        <Row label="Heading">
          {heading != null ? (
            <>
              {(((heading * 180) / Math.PI + 360) % 360).toFixed(0)}
              <span className="text-slate-500">°</span>
            </>
          ) : (
            "—"
          )}
        </Row>
      </div>
    </div>
  );
};

export default ObjectInspector;
