import { Page } from '@playwright/test';

/**
 * JSON-safe dataset summary the showcase publishes on `window.__STT_DATASETS`
 * (see `examples/showcase/src/main.tsx`). The runner reads this list once per
 * suite so the dataset enumeration always tracks the showcase exactly.
 */
export interface DatasetManifestEntry {
  id: string;
  name: string;
  type: string;
  url: string;
  timeRange: { start: number; end: number };
  targetPlaybackSeconds?: number;
  useGlobe: boolean;
}

/**
 * Fetch the dataset manifest from the running showcase. Navigates to `/` once,
 * waits for the SPA to evaluate `main.tsx`, then reads `window.__STT_DATASETS`.
 */
export async function loadManifest(page: Page): Promise<DatasetManifestEntry[]> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  return await page.waitForFunction(
    () => (window as unknown as { __STT_DATASETS?: DatasetManifestEntry[] }).__STT_DATASETS,
    { timeout: 30_000 },
  ).then((handle) => handle.jsonValue() as Promise<DatasetManifestEntry[]>);
}

/**
 * Fixed anchors at which we sample each dataset. 25% and 75% of the timeline
 * give two materially different rendered frames per dataset — enough to catch
 * scrub-related regressions in the golden diff without doubling the sample
 * cost by walking the whole range.
 */
export const TIME_ANCHORS = [
  { label: 't25', fraction: 0.25 },
  { label: 't75', fraction: 0.75 },
] as const;

export type TimeAnchorLabel = (typeof TIME_ANCHORS)[number]['label'];
