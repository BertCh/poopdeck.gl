import { Page, Locator } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASELINES_DIR = path.resolve(__dirname, '..', '..', 'baselines');
export const OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'output');

export interface FidelityResult {
  /** Where the current run wrote its frame. */
  currentPath: string;
  /** Where the baseline lives (whether or not it existed before). */
  baselinePath: string;
  /** Diff PNG path (only written when both images exist). */
  diffPath: string | null;
  /** Fraction of pixels that differ above the perceptual threshold. */
  diffRatio: number | null;
  /** Total mismatched pixel count. */
  mismatchedPixels: number | null;
  /** Image dimensions of the current capture, for the report. */
  width: number;
  height: number;
  /** "blessed" when no baseline existed before and we just wrote one. */
  status:
    | 'compared'
    | 'blessed'
    | 'baseline-missing'
    | 'size-mismatch'
    | 'capture-failed';
  /** Optional reason string for size-mismatch / capture-failed. */
  reason?: string;
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Screenshot the deck.gl/maplibre map viewport. Returns the raw PNG buffer or
 * null if the viewport isn't attached (e.g., the demo failed to mount).
 */
async function captureViewport(viewport: Locator): Promise<Buffer | null> {
  try {
    return await viewport.screenshot();
  } catch {
    return null;
  }
}

/**
 * Capture the current frame, diff against a baseline, and write artifacts.
 *
 * On a clean run with no existing baseline, the baseline is written and the
 * result is marked `blessed`. With `STT_BLESS_BASELINES=1` set in the env,
 * any existing baseline is overwritten — use this when an intentional render
 * change makes the suite go red.
 */
export async function captureAndDiff(
  page: Page,
  opts: {
    viewport: Locator;
    datasetId: string;
    anchorLabel: string;
    /** Perceptual threshold passed to pixelmatch (0..1). Higher = more lenient. */
    threshold?: number;
    /** When true, force-write the baseline regardless of whether one exists. */
    forceBless?: boolean;
  },
): Promise<FidelityResult> {
  const { viewport, datasetId, anchorLabel } = opts;
  const threshold = opts.threshold ?? 0.12;
  const forceBless = opts.forceBless ?? false;

  const baselineDir = path.join(BASELINES_DIR, datasetId);
  const outputDir = path.join(OUTPUT_DIR, datasetId);
  ensureDir(baselineDir);
  ensureDir(outputDir);

  const baselinePath = path.join(baselineDir, `${anchorLabel}.png`);
  const currentPath = path.join(outputDir, `${anchorLabel}-current.png`);
  const diffPath = path.join(outputDir, `${anchorLabel}-diff.png`);

  const buffer = await captureViewport(viewport);
  if (!buffer) {
    return {
      currentPath,
      baselinePath,
      diffPath: null,
      diffRatio: null,
      mismatchedPixels: null,
      width: 0,
      height: 0,
      status: 'capture-failed',
      reason: 'viewport screenshot returned no buffer',
    };
  }
  fs.writeFileSync(currentPath, buffer);
  const current = PNG.sync.read(buffer);

  const hasBaseline = fs.existsSync(baselinePath);
  if (forceBless || !hasBaseline) {
    fs.writeFileSync(baselinePath, buffer);
    return {
      currentPath,
      baselinePath,
      diffPath: null,
      diffRatio: null,
      mismatchedPixels: null,
      width: current.width,
      height: current.height,
      status: 'blessed',
    };
  }

  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      currentPath,
      baselinePath,
      diffPath: null,
      diffRatio: null,
      mismatchedPixels: null,
      width: current.width,
      height: current.height,
      status: 'size-mismatch',
      reason: `baseline ${baseline.width}x${baseline.height}, current ${current.width}x${current.height}`,
    };
  }

  const { width, height } = current;
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    { threshold, includeAA: false, alpha: 0.35 },
  );
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  const total = width * height;
  return {
    currentPath,
    baselinePath,
    diffPath,
    diffRatio: total > 0 ? mismatched / total : 0,
    mismatchedPixels: mismatched,
    width,
    height,
    status: 'compared',
  };
}
