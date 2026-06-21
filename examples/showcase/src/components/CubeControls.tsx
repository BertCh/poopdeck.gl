/**
 * Space-time-cube control chip: the "squash" slider morphs between the flat map
 * (0) and the full time-as-height cube (1). It drives a single shader uniform
 * (`timeHeightScale`, metres per sim-ms), so dragging it is free — no data
 * re-upload. An optional lattice checkbox toggles the loaded-STT-tile wireframe
 * overlay (used by the DemoViewer cube demos; the AV "Spacetime" cockpit mode
 * omits it).
 *
 * Copied out of DemoViewer's private `CubeControls` so the AV cockpit can reuse
 * the exact same chrome (same styling, same slider semantics) without growing a
 * cross-import into the demo viewer. Keep the two visually in sync.
 */
import React from "react";

export const CubeControls: React.FC<{
  heightFactor: number;
  onHeightFactor: (f: number) => void;
  /** Optional STT-tile lattice toggle (omit to hide the checkbox). */
  showLattice?: boolean;
  onShowLattice?: (show: boolean) => void;
  /** Heading shown on the chip. Defaults to "TIME = HEIGHT". */
  label?: string;
}> = ({
  heightFactor,
  onHeightFactor,
  showLattice,
  onShowLattice,
  label = "TIME = HEIGHT",
}) => {
  return (
    <div
      className="rounded px-3 py-2 flex flex-col gap-1.5"
      style={{
        background: "rgba(36, 39, 48, 0.95)",
        border: "1px solid #3A414C",
        minWidth: 170,
      }}
    >
      <div
        className="text-[10px] font-semibold tracking-widest"
        style={{ color: "#A0A7B4" }}
      >
        {label}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px]" style={{ color: "#6B7280" }}>
          flat
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(heightFactor * 100)}
          onChange={(e) => onHeightFactor(Number(e.target.value) / 100)}
          className="flex-1"
          style={{ accentColor: "#1FBAD6" }}
          aria-label="Time-as-height squash factor"
        />
        <span className="text-[10px]" style={{ color: "#6B7280" }}>
          cube
        </span>
      </div>
      {onShowLattice && (
        <label
          className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none"
          style={{ color: "#A0A7B4" }}
        >
          <input
            type="checkbox"
            checked={!!showLattice}
            onChange={(e) => onShowLattice(e.target.checked)}
            style={{ accentColor: "#1FBAD6" }}
          />
          STT tile lattice
        </label>
      )}
    </div>
  );
};

export default CubeControls;
