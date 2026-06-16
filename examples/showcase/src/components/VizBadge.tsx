import React from "react";
import type { DatasetType } from "../types";

/**
 * Visualization-type badge. Each `DatasetType` gets a distinct color + a tiny
 * inline glyph so a catalog card's *technique* reads at a glance — a trip
 * ribbon, an OD arc, an H3 hex, a 3D column — before you read a word. The chip
 * still carries the editorial `techniqueTag` text (passed as `label`); the icon
 * and color come from the underlying `dataset.type`.
 *
 * Same hand-drawn, stroke-based glyph style as the source-attribution marks in
 * SourceLogo — generic domain glyphs, `currentColor` so icon + text share the
 * type's hue. No external icon library.
 */

const S = 11; // glyph box (px) — sits with the 10px uppercase label

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const svg = (children: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width={S} height={S} aria-hidden="true">
    {children}
  </svg>
);

// ── Glyphs ────────────────────────────────────────────────────────────────
// One filled dot inside a faint ring — a located feature.
const PointGlyph = svg(
  <>
    <circle cx="12" cy="12" r="8.5" {...stroke} strokeWidth={1.5} opacity={0.45} />
    <circle cx="12" cy="12" r="4" fill="currentColor" />
  </>,
);

// A bare polyline — a recorded route.
const PathGlyph = svg(<path {...stroke} d="M3 16.5 9 8.5 14.5 13.5 21 6" />);

// A trailing line with a bright head dot — an animated trip.
const TripsGlyph = svg(
  <>
    <path {...stroke} d="M3.5 17 9 11 13.5 13.5" opacity={0.6} />
    <circle cx="17.5" cy="9" r="2.7" fill="currentColor" />
  </>,
);

// A fading trail feeding a moving head dot — trip heads.
const TripHeadsGlyph = svg(
  <>
    <circle cx="4" cy="16.5" r="1.1" fill="currentColor" opacity={0.4} />
    <circle cx="8" cy="14" r="1.3" fill="currentColor" opacity={0.6} />
    <circle cx="12.5" cy="11.5" r="1.5" fill="currentColor" opacity={0.82} />
    <circle cx="17.5" cy="9" r="2.6" fill="currentColor" />
  </>,
);

// Concentric splat — a density field.
const HeatmapGlyph = svg(
  <>
    <circle cx="12" cy="12" r="9" {...stroke} strokeWidth={1.4} opacity={0.3} />
    <circle cx="12" cy="12" r="6" {...stroke} strokeWidth={1.5} opacity={0.55} />
    <circle cx="12" cy="12" r="2.8" fill="currentColor" />
  </>,
);

// A closed area outline.
const PolygonGlyph = svg(<path {...stroke} d="M12 3.5 20 9.2 17 19 7 19 4 9.2 Z" />);

// Flat-top hexagon — the H3 summary cell.
const SummaryGlyph = svg(
  <path {...stroke} d="M5.5 8 12 4.2 18.5 8 18.5 16 12 19.8 5.5 16 Z" />,
);

// A bow between two endpoints — an origin→destination arc.
const ArcGlyph = svg(
  <>
    <path {...stroke} d="M4 17.5Q12 2.5 20 17.5" />
    <circle cx="4" cy="17.5" r="2" fill="currentColor" />
    <circle cx="20" cy="17.5" r="2" fill="currentColor" />
  </>,
);

// Two weighted flows converging on a hub node — the OD flowmap.
const FlowmapGlyph = svg(
  <>
    <path {...stroke} d="M4.5 18Q9 7.5 12 11.5" />
    <path {...stroke} d="M19.5 18Q15 6.5 12 11.5" />
    <circle cx="12" cy="11.5" r="2.8" fill="currentColor" />
    <circle cx="4.5" cy="18" r="1.8" fill="currentColor" />
    <circle cx="19.5" cy="18" r="1.8" fill="currentColor" />
  </>,
);

// Several flows merging into one river — GPU edge-bundled flowmap.
const BundledFlowmapGlyph = svg(
  <>
    <path {...stroke} d="M4 6Q11 10 13 12Q11 14 4 18" />
    <path {...stroke} d="M4 12H13" />
    <path {...stroke} strokeWidth={2.4} d="M13 12Q17 12 20 12" />
    <circle cx="20" cy="12" r="2" fill="currentColor" />
  </>,
);

// An extruded 3D box — a column at a point.
const ColumnGlyph = svg(
  <>
    <path {...stroke} d="M12 3.5 18.5 7 12 10.5 5.5 7 Z" />
    <path {...stroke} d="M5.5 7v8L12 18.5V10.5" />
    <path {...stroke} d="M18.5 7v8L12 18.5" />
  </>,
);

// A 2×2 grid with one filled cell — the Quadbin square-cell summary.
const QuadbinGlyph = svg(
  <>
    <rect x="4.5" y="4.5" width="15" height="15" rx="1" {...stroke} />
    <path {...stroke} d="M12 4.5v15M4.5 12h15" />
    <rect x="5.6" y="5.6" width="5.8" height="5.8" fill="currentColor" opacity={0.85} />
  </>,
);

export interface VizDef {
  /** Short type label (fallback when no editorial `techniqueTag` is given). */
  label: string;
  /** Distinct hue for this viz type — drives icon + text + soft chip fill. */
  color: string;
  icon: React.ReactNode;
}

/**
 * Per-`DatasetType` icon + color. Hues are spread around the wheel and lean
 * dark enough to stay legible on the warm-paper chrome; siblings differ by
 * glyph (trips line vs. head dots; H3 hex vs. Quadbin square). `trips` keeps the
 * brand teal — it's the hero technique.
 */
export const VIZ_REGISTRY: Record<DatasetType, VizDef> = {
  point: { label: "Points", color: "#C8432F", icon: PointGlyph },
  path: { label: "Paths", color: "#2A8A60", icon: PathGlyph },
  trips: { label: "Trips", color: "#0A7790", icon: TripsGlyph },
  "trip-heads": { label: "Heads", color: "#2A6FB0", icon: TripHeadsGlyph },
  heatmap: { label: "Heatmap", color: "#C2671B", icon: HeatmapGlyph },
  polygon: { label: "Polygons", color: "#7A4DB3", icon: PolygonGlyph },
  summary: { label: "H3 summary", color: "#A93C76", icon: SummaryGlyph },
  arc: { label: "Arcs", color: "#3F54B6", icon: ArcGlyph },
  column: { label: "Columns", color: "#94701A", icon: ColumnGlyph },
  "quadbin-summary": { label: "Quadbin", color: "#6B7C26", icon: QuadbinGlyph },
  flowmap: { label: "Flowmap", color: "#C72C68", icon: FlowmapGlyph },
  "flowmap-bundled": { label: "Bundled flowmap", color: "#9B2C8C", icon: BundledFlowmapGlyph },
};

/** `#RRGGBB` → `rgba(r,g,b,a)`; used for the soft chip fill. */
function softFill(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The viz-type chip. Renders the type glyph + label, tinted with the type's
 * hue over a soft fill of the same hue. Pass `label` to show the editorial
 * `techniqueTag` (e.g. "Trips · SST gradient · globe"); it falls back to the
 * registry's short type name.
 */
export const VizBadge: React.FC<{
  type: DatasetType;
  label?: string;
  className?: string;
}> = ({ type, label, className = "" }) => {
  const def = VIZ_REGISTRY[type];
  if (!def) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide uppercase px-1.5 py-0.5 rounded ${className}`}
      style={{ background: softFill(def.color, 0.1), color: def.color }}
      title={label ?? def.label}
    >
      {def.icon}
      {label ?? def.label}
    </span>
  );
};

export default VizBadge;
