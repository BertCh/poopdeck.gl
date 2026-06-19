/**
 * Top-right camera inset for the AV cockpit — the dashcam / front-camera frame
 * active at the playhead. Reads `cameras.json` (the keyframe sidecar) and swaps
 * the `<img>` src to the latest frame at-or-before the clock, driven off the
 * shared TimeController tick (debounced to one swap per distinct url so we're
 * not reassigning `src` 60×/s).
 *
 * Missing camera stream → the parent hides this; a frame that fails to load
 * (placeholder bundles) just shows the empty frame chrome, no hard fail.
 */
import React, { useEffect, useRef, useState } from "react";
import type { TimeController } from "@poopdeck.gl/playback";
import { cameraFrameAt, type AvCameras } from "./sceneTypes";

export interface CameraInsetProps {
  cameras: AvCameras;
  /** Resolves a frame's scene-relative url to a fetchable URL. */
  resolveFrameUrl: (relativeUrl: string) => string;
  timeController: TimeController;
  /**
   * Sizing override for the root (default `w-56` for the desktop top-right
   * inset). The mobile chrome passes a smaller thumbnail width.
   */
  className?: string;
}

const CameraInset: React.FC<CameraInsetProps> = ({
  cameras,
  resolveFrameUrl,
  timeController,
  className,
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const lastUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const apply = (t: number) => {
      const frame = cameraFrameAt(cameras, t);
      if (!frame) return;
      if (frame.url === lastUrlRef.current) return; // same frame — skip the swap
      lastUrlRef.current = frame.url;
      setBroken(false);
      setSrc(resolveFrameUrl(frame.url));
    };
    apply(timeController.getTime());
    const off = timeController.on("tick", apply);
    return off;
  }, [cameras, resolveFrameUrl, timeController]);

  return (
    <div
      className={`overflow-hidden rounded-lg border border-white/10 bg-black/60 shadow-xl backdrop-blur-md ${
        className ?? "w-56"
      }`}
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-slate-400 border-b border-white/10 flex items-center justify-between">
        <span>{cameras.camera || "Camera"}</span>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
      </div>
      <div className="aspect-video bg-slate-900/80 flex items-center justify-center">
        {src && !broken ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img
            src={src}
            alt="Front camera frame"
            className="w-full h-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="text-[10px] text-slate-600">no frame</span>
        )}
      </div>
    </div>
  );
};

export default CameraInset;
