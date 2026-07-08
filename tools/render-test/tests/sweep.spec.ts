import { test, expect, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  attachErrorCollectors,
  canvasPixelStats,
  getRangeBounds,
  mapViewport,
  playButton,
  setRangeValue,
  timeSlider,
  waitForWebGLCanvas,
} from './helpers.js';
import {
  DatasetManifestEntry,
  TIME_ANCHORS,
  loadManifest,
} from './lib/manifest.js';
import { collectMetrics, startInPageCollectors } from './lib/metrics.js';
import { BASELINES_DIR, OUTPUT_DIR, captureAndDiff } from './lib/fidelity.js';
import {
  AnchorResult,
  DatasetResult,
  SweepReport,
  writeReport,
} from './lib/report.js';

/**
 * Full-browser evaluation sweep for the @poopdeck.gl/showcase demo site.
 *
 * For every dataset published on `window.__STT_DATASETS`, the sweep:
 *   1. opens `/demo/<id>` in a fresh Chromium page,
 *   2. waits for the deck.gl canvas to render non-blank pixels,
 *   3. captures a "warmup" perf sample (10s) while the layer settles,
 *   4. scrubs to two fixed time anchors (25% / 75% of the dataset range),
 *   5. samples perf again at each anchor, then captures a viewport PNG
 *      and diffs it against the baseline under tools/render-test/baselines/.
 *
 * Results are written to tools/render-test/output/report.{html,json}.
 *
 * Modes:
 *   - default: compare current frames to committed baselines.
 *   - STT_BLESS_BASELINES=1: overwrite every baseline this run produces.
 *     Use after an intentional rendering change makes the suite go red.
 *   - STT_SWEEP_FILTER=<substring>: only run datasets whose id contains the
 *     substring. Handy when iterating on one demo.
 */

const SAMPLE_WINDOW_MS = Number(process.env.STT_SWEEP_SAMPLE_MS || 5_000);
const WARMUP_SETTLE_MS = Number(process.env.STT_SWEEP_WARMUP_MS || 8_000);
const BLESS = process.env.STT_BLESS_BASELINES === '1';
const FILTER = process.env.STT_SWEEP_FILTER || '';

/**
 * Max per-anchor pixel-diff ratio (fraction of pixels differing above the
 * perceptual threshold) we tolerate against a committed baseline before the
 * sweep fails. Deliberately GENEROUS: under software WebGL (llvmpipe/SwiftShader
 * on headless CI) AA, dithering, and timing jitter shift a non-trivial slice of
 * pixels even for an unchanged scene, so a tight gate would be flaky. This
 * catches gross regressions (blank canvas, wrong color ramp, missing geometry)
 * without tripping on rendering noise. Override with STT_SWEEP_MAX_DIFF.
 */
const MAX_DIFF_RATIO = Number(process.env.STT_SWEEP_MAX_DIFF || 0.35);

const FATAL_ERROR_PATTERNS = [
  /shader/i,
  /failed to compile/i,
  /failed to link/i,
  /glsl/i,
  /\bNaN\b/,
  /out of memory/i,
  /context lost/i,
];

async function recordRenderer(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const cs = Array.from(document.querySelectorAll('.map-viewport canvas'));
    for (const c of cs) {
      const el = c as HTMLCanvasElement;
      const gl =
        (el.getContext('webgl2') as WebGL2RenderingContext | null) ||
        (el.getContext('webgl') as WebGLRenderingContext | null);
      if (!gl) continue;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return (
        dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'
      ) as string;
    }
    return null;
  });
}

interface NetworkTally {
  archiveBytes: number;
  archiveFailures: number;
}

/**
 * Wire a `response` listener that totals bytes flowing into the .stt archive
 * URL for the current dataset. The browser's transferSize is unreliable when
 * the dev server uses gzip, so we read the body and use its length.
 *
 * `archiveFailures` increments for any of:
 *   - HTTP non-2xx,
 *   - text/html content-type (Vite serves its SPA fallback for missing files
 *     as 200 OK + HTML — without this check, a deleted .stt would look like a
 *     successful tiny load and the live-canvas heuristic would pass on the
 *     base map alone).
 */
function trackArchive(page: Page, archivePath: string): NetworkTally {
  const tally: NetworkTally = { archiveBytes: 0, archiveFailures: 0 };
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.endsWith(archivePath) && !url.includes(`${archivePath}?`)) return;
    if (!res.ok()) {
      tally.archiveFailures++;
      return;
    }
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) {
      tally.archiveFailures++;
      return;
    }
    try {
      const buf = await res.body();
      tally.archiveBytes += buf.byteLength;
    } catch {
      // Body may have been GC'd by the time we read it; the request still
      // tells us "archive loaded", so missing bytes are non-fatal.
    }
  });
  return tally;
}

async function waitForLiveCanvas(
  page: Page,
  timeoutMs = 60_000,
): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stats = await canvasPixelStats(page);
    if (stats && stats.variance > 15 && stats.uniqueColors > 20) {
      return Date.now() - start;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function runDataset(
  page: Page,
  dataset: DatasetManifestEntry,
): Promise<DatasetResult> {
  const errors: string[] = [];
  const sink = attachErrorCollectors(page);
  const tally = trackArchive(page, dataset.url);

  let webGLAvailable = true;
  try {
    await page.goto(`/demo/${dataset.id}`, { waitUntil: 'domcontentloaded' });
    await mapViewport(page).waitFor({ state: 'visible', timeout: 45_000 });
    await waitForWebGLCanvas(page);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(message);
    if (/WEBGL_UNAVAILABLE/.test(message)) webGLAvailable = false;
  }
  if (!webGLAvailable) {
    return {
      dataset,
      status: 'webgl-unavailable',
      errors,
      rendererTag: null,
      anchors: [],
      warmupMetrics: null,
      ttffMs: null,
      archiveBytes: tally.archiveBytes,
    };
  }

  // Settle: wait until the canvas actually contains a rendered scene. If we
  // never see non-blank pixels, distinguish "render failed" from "data file
  // is missing" by checking how many bytes the archive request transferred.
  const ttffMs = await waitForLiveCanvas(page);
  // A 4xx on the archive URL is unambiguous: even if the canvas now shows
  // non-blank pixels (the base map + globe background can fool the variance
  // heuristic), no STT geometry is on screen. Promote to data-missing.
  const archiveFailed = tally.archiveFailures > 0;
  if (ttffMs == null || archiveFailed) {
    const archiveMissing = archiveFailed || tally.archiveBytes === 0;
    return {
      dataset,
      status: archiveMissing ? 'data-missing' : 'render-failed',
      errors: [
        ...errors,
        ...sink.consoleErrors.filter((e) =>
          FATAL_ERROR_PATTERNS.some((p) => p.test(e)),
        ),
        ...sink.pageErrors,
      ],
      rendererTag: await recordRenderer(page),
      anchors: [],
      warmupMetrics: null,
      ttffMs,
      archiveBytes: tally.archiveBytes,
    };
  }

  const rendererTag = await recordRenderer(page);

  // Warmup sample — captures FPS during the period the layer is still
  // populating its caches. Often the worst-case window.
  await startInPageCollectors(page);
  await page.waitForTimeout(WARMUP_SETTLE_MS);
  const warmup = await collectMetrics(page, SAMPLE_WINDOW_MS);

  const slider = timeSlider(page);
  let bounds: { min: number; max: number; value: number } | null = null;
  try {
    bounds = await getRangeBounds(slider);
  } catch (err) {
    errors.push(
      `time slider not available: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const anchors: AnchorResult[] = [];
  if (bounds && bounds.max > bounds.min) {
    const span = bounds.max - bounds.min;
    const play = playButton(page);
    for (const anchor of TIME_ANCHORS) {
      const t = bounds.min + span * anchor.fraction;
      try {
        await setRangeValue(slider, t);
      } catch (err) {
        errors.push(
          `scrub to ${anchor.label} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        anchors.push({
          anchor: anchor.label,
          time: t,
          metrics: null,
          fidelity: null,
        });
        continue;
      }
      // Let the new frame settle. Capture the static fidelity frame BEFORE
      // playing — once playback starts, every PNG would be at a different
      // sim-time and baselines would never reproduce.
      await page.waitForTimeout(2_000);
      const fidelity = await captureAndDiff(page, {
        viewport: mapViewport(page),
        datasetId: dataset.id,
        anchorLabel: anchor.label,
        forceBless: BLESS,
      });

      // Perf sample. Start playback so the deck.gl layer actually exercises
      // its per-frame redraw cost; without play, FPS pegs the rAF cap because
      // the layer reads time from a stationary TimeController and skips draws.
      let playStarted = false;
      try {
        if ((await play.count()) > 0) {
          await play.click({ timeout: 2_000 });
          playStarted = true;
        }
      } catch {
        // Play button may not have rendered yet — fall back to static sample.
      }
      // Give playback a couple of rAFs to land before opening the window.
      if (playStarted) await page.waitForTimeout(500);
      await startInPageCollectors(page);
      const metrics = await collectMetrics(page, SAMPLE_WINDOW_MS);
      // Pause + re-anchor so the next iteration's scrub starts from a known
      // state and so the FPS overlay's idle measurement isn't misleading.
      if (playStarted) {
        try {
          await play.click({ timeout: 2_000 });
        } catch {
          /* ignore — page teardown will close the context anyway */
        }
        await setRangeValue(slider, t).catch(() => {});
      }
      anchors.push({ anchor: anchor.label, time: t, metrics, fidelity });
    }
  }

  const noisy = [...sink.consoleErrors, ...sink.pageErrors].filter((e) =>
    FATAL_ERROR_PATTERNS.some((p) => p.test(e)),
  );
  return {
    dataset,
    status: 'ok',
    errors: [...errors, ...noisy],
    rendererTag,
    anchors,
    warmupMetrics: warmup,
    ttffMs,
    archiveBytes: tally.archiveBytes,
  };
}

test.describe('STT showcase evaluation sweep', () => {
  // The sweep is one logical job; let Playwright give it the full timeout.
  test.setTimeout(60 * 60 * 1000);

  test('sweep every dataset, report perf + fidelity', async ({
    page,
    baseURL,
  }) => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.mkdirSync(BASELINES_DIR, { recursive: true });

    const manifest = await loadManifest(page);
    const filtered = FILTER
      ? manifest.filter((d) => d.id.includes(FILTER))
      : manifest;

    if (FILTER) {
      // eslint-disable-next-line no-console
      console.log(
        `[sweep] filter "${FILTER}" → ${filtered.length}/${manifest.length} datasets`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`[sweep] sweeping ${filtered.length} datasets`);
    }

    const start = Date.now();
    const results: DatasetResult[] = [];
    for (const dataset of filtered) {
      // eslint-disable-next-line no-console
      console.log(`[sweep] ▶ ${dataset.id}`);
      const r = await runDataset(page, dataset);
      results.push(r);
      const summary =
        r.status === 'ok'
          ? `fps=${r.warmupMetrics?.fps.toFixed(1) ?? '—'} ttff=${r.ttffMs ?? '—'}ms anchors=${r.anchors.length}`
          : r.status;
      // eslint-disable-next-line no-console
      console.log(`[sweep] ✓ ${dataset.id} — ${summary}`);
      // Reset listeners between runs by removing all this run's handlers.
      page.removeAllListeners('response');
    }

    const report: SweepReport = {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      baseURL: baseURL ?? 'http://localhost:3000',
      results,
    };
    const { jsonPath, htmlPath } = writeReport(report, OUTPUT_DIR);
    // eslint-disable-next-line no-console
    console.log(`[sweep] report → ${path.relative(process.cwd(), htmlPath)}`);
    // eslint-disable-next-line no-console
    console.log(`[sweep] data   → ${path.relative(process.cwd(), jsonPath)}`);

    // Fidelity gate. The report above is always written first so a failure
    // here still leaves the full HTML/JSON artifacts (with diff PNGs) behind.
    //
    // We only assert on anchors that were actually COMPARED against an existing
    // committed baseline — `blessed` (first run / STT_BLESS_BASELINES),
    // `baseline-missing`, `size-mismatch`, and `capture-failed` carry a null
    // diffRatio and are skipped, so the gate is a no-op when no baselines are
    // present (e.g. on CI, which ships none). The threshold is intentionally
    // generous (see MAX_DIFF_RATIO) so it goes red only on real regressions.
    const offenders: string[] = [];
    for (const r of results) {
      for (const a of r.anchors) {
        const fid = a.fidelity;
        if (!fid || fid.status !== 'compared' || fid.diffRatio == null)
          continue;
        if (fid.diffRatio > MAX_DIFF_RATIO) {
          offenders.push(
            `${r.dataset.id}@${a.anchor}: diffRatio=${fid.diffRatio.toFixed(4)} ` +
              `(> ${MAX_DIFF_RATIO}) — see ${path.relative(process.cwd(), fid.diffPath ?? fid.currentPath)}`,
          );
        }
      }
    }
    if (offenders.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[sweep] fidelity regressions:\n  ${offenders.join('\n  ')}`,
      );
    }
    expect(
      offenders,
      `fidelity diff exceeded ${MAX_DIFF_RATIO} for:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
