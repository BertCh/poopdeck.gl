import React from "react";

/**
 * Source-attribution badges for the demo cards. These are NOT the official
 * brand logos — each source is represented by a simple, generic domain glyph
 * (a wave, a taxi, a map pin…) plus the source name, so we attribute the data
 * without reproducing trademarked marks. Swap in official assets per source by
 * replacing the `icon` here if licensing allows.
 */

interface SourceDef {
  label: string;
  color: string;
  icon: React.ReactNode;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const WaveIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path {...stroke} d="M2 9c2.2 0 2.2 2 4.4 2S8.6 9 10.8 9 13 11 15.2 11s2.2-2 4.4-2" />
    <path {...stroke} d="M2 14c2.2 0 2.2 2 4.4 2s2.2-2 4.4-2 2.2 2 4.4 2 2.2-2 4.4-2" />
  </svg>
);

const TaxiIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path {...stroke} d="M4 16v-3l1.8-4.2A2 2 0 0 1 7.6 7.5h8.8a2 2 0 0 1 1.8 1.3L20 13v3" />
    <path {...stroke} d="M3 16h18" />
    <path {...stroke} d="M9.5 7.5V6h5v1.5" />
    <circle {...stroke} cx="7.5" cy="16.5" r="1.6" />
    <circle {...stroke} cx="16.5" cy="16.5" r="1.6" />
  </svg>
);

const PinIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path {...stroke} d="M12 21s6-5.7 6-10.5A6 6 0 0 0 6 10.5C6 15.3 12 21 12 21z" />
    <circle {...stroke} cx="12" cy="10.5" r="2.2" />
  </svg>
);

const QuakeIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path {...stroke} d="M2 12h4l2.5-6 3.5 13 3-9 2 4h5" />
  </svg>
);

const PlaneIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path {...stroke} d="M10.5 3.5a1.5 1.5 0 0 1 3 0V9l7 4v2l-7-2v4l2 1.5V20l-3.5-1L11 20v-1.5L13 17v-4l-7 2v-2l7-4V3.5z" />
  </svg>
);

const LeafIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path {...stroke} d="M5 19c0-8 5-13 14-13 0 9-5 14-13 14-1 0-1-1-1-1z" />
    <path {...stroke} d="M5 19C9 15 13 12 17 10" />
  </svg>
);

export const SOURCE_REGISTRY: Record<string, SourceDef> = {
  noaa: { label: "NOAA", color: "#0B5FA5", icon: WaveIcon },
  tlc: { label: "NYC TLC", color: "#C9971C", icon: TaxiIcon },
  osm: { label: "OpenStreetMap", color: "#6FA84B", icon: PinIcon },
  usgs: { label: "USGS", color: "#1A7D3C", icon: QuakeIcon },
  opensky: { label: "OpenSky", color: "#2E6FB7", icon: PlaneIcon },
  gbif: { label: "GBIF", color: "#4CA86E", icon: LeafIcon },
};

export const SourceLogo: React.FC<{ id: string }> = ({ id }) => {
  const def = SOURCE_REGISTRY[id];
  if (!def) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium leading-none"
      style={{ color: def.color }}
      title={def.label}
    >
      {def.icon}
      {def.label}
    </span>
  );
};

export default SourceLogo;
