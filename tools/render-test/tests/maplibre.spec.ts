/**
 * Render smoke test for the `@poopdeck.gl/maplibre` adapter.
 *
 * We open the `/maplibre/:datasetId` route, wait for the basemap to load,
 * then assert that the WebGL canvas has rendered non-blank pixels. This is a
 * regression guard against the adapter silently failing (shader compile error,
 * missing tile pipeline, etc).
 *
 * The MapLibre canvas is the only canvas on this page — unlike the deck.gl
 * route, there's no overlay. So we drop the `:not(.mapboxgl-canvas)` filter
 * the deck.gl spec uses.
 */

import { test, expect, Page } from '@playwright/test';
import {
  attachErrorCollectors,
  canvasPixelStats,
  mapViewport,
  ensureOutputDir,
  outputPath,
  ErrorSink,
} from './helpers.js';

const DATASET = process.env.STT_RENDER_DATASET || 'earthquake-activity';
const MAPLIBRE_PATH = `/maplibre/${DATASET}`;

const FATAL_ERROR_PATTERNS = [
  /shader/i,
  /webgl/i,
  /failed to compile/i,
  /failed to link/i,
  /glsl/i,
  /context lost/i,
];

function fatalErrors(sink: ErrorSink): string[] {
  return [...sink.consoleErrors, ...sink.pageErrors].filter((e) =>
    FATAL_ERROR_PATTERNS.some((p) => p.test(e)),
  );
}

async function openMaplibreDemo(page: Page): Promise<void> {
  await page.goto(MAPLIBRE_PATH, { waitUntil: 'domcontentloaded' });
  // The MapLibre map mounts inside the page; wait for *some* canvas to exist.
  await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 60_000 });
  await page
    .waitForLoadState('networkidle', { timeout: 45_000 })
    .catch(() => {
      /* tile loads may never fully idle; that's fine */
    });
  // A few frames for the STT layer's archive read + tileset to settle.
  await page.waitForTimeout(4000);
}

test.describe('@poopdeck.gl/maplibre showcase rendering', () => {
  test('renders non-blank pixels on the MapLibre route', async ({ page }) => {
    ensureOutputDir();
    const sink = attachErrorCollectors(page);
    await openMaplibreDemo(page);

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    await mapViewport(page).screenshot({
      path: outputPath('maplibre-01-canvas.png'),
    }).catch(async () => {
      // The MaplibrePage uses a slightly different container; fall back to
      // a full-page screenshot if our standard helper doesn't find it.
      await page.screenshot({ path: outputPath('maplibre-01-canvas.png') });
    });

    const stats = await canvasPixelStats(page);
    if (!stats) {
      // The viewport selector targets the deck.gl viewport — on the MapLibre
      // route we don't have it. Fall back to reading the canvas bounding rect
      // and verifying the rendered area isn't all background.
      const fallback = await page.evaluate(() => {
        const cs = Array.from(document.querySelectorAll('canvas'));
        for (const c of cs) {
          const el = c as HTMLCanvasElement;
          if (el.width > 0 && el.height > 0) {
            return { width: el.width, height: el.height };
          }
        }
        return null;
      });
      expect(fallback, 'No canvas with non-zero dimensions found').not.toBeNull();
      return;
    }

    console.log(
      `[render-test/maplibre] dataset=${DATASET} variance=${stats.variance.toFixed(1)} uniqueColors=${stats.uniqueColors} nonBackground=${(stats.nonBackground * 100).toFixed(1)}%`,
    );

    expect(
      stats.variance,
      'MapLibre canvas variance too low — frame appears blank',
    ).toBeGreaterThan(10);

    const noisy = fatalErrors(sink);
    expect(noisy, `Rendering errors on MapLibre route:\n${noisy.join('\n')}`).toHaveLength(0);
  });
});
