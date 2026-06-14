/**
 * Showcase adapter over @poopdeck.gl/react's `usePlayback`: derives the generic
 * playback options (time range + base speed) from a showcase `Dataset`. Every
 * surface that mounts a live demo map (`/demo/:id`, the `/demos/:id` embed, the
 * home hero) goes through this so they can't drift apart.
 */
import { usePlayback, type PlaybackState } from "@poopdeck.gl/react";
import type { Dataset } from "../../types";
import { calculateAnimationSpeed } from "../../types";

export function useDemoPlayback(dataset: Dataset | undefined): PlaybackState {
  return usePlayback({
    timeRange: dataset?.timeRange,
    baseSpeed: dataset ? calculateAnimationSpeed(dataset) : undefined,
  });
}
