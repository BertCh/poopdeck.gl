import { Page, Locator, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');

/**
 * Dataset used for the rendering tests.
 *
 * `earthquakes` is chosen deliberately: it is small (~17MB so it loads fast in
 * CI), the demo opens at a low zoom that shows the whole feed at once, and the
 * data is dense across a multi-year time range — which makes it a good probe
 * for the time-filter regression test.
 */
export const TEST_DATASET =
  process.env.STT_RENDER_DATASET || 'earthquake-activity';
export const DEMO_PATH = `/demo/${TEST_DATASET}`;

export function ensureOutputDir(): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

export function outputPath(name: string): string {
  ensureOutputDir();
  return path.join(OUTPUT_DIR, name);
}

/** Console / page error sink wired up per test. */
export interface ErrorSink {
  consoleErrors: string[];
  pageErrors: string[];
}

export function attachErrorCollectors(page: Page): ErrorSink {
  const sink: ErrorSink = { consoleErrors: [], pageErrors: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      sink.consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    sink.pageErrors.push(`${err.name}: ${err.message}`);
  });
  return sink;
}

/**
 * Locate the deck.gl WebGL canvas inside the demo map viewport.
 *
 * The `.map-viewport` container holds both deck.gl's canvas and (for non-globe
 * datasets) the maplibre base-map canvas. deck.gl's canvas is the one we care
 * about; maplibre's canvas carries the `mapboxgl-canvas` class, so we exclude
 * it. If selection is ambiguous we fall back to the first canvas.
 */
export function deckCanvas(page: Page): Locator {
  return page.locator('.map-viewport canvas:not(.mapboxgl-canvas)').first();
}

export function mapViewport(page: Page): Locator {
  return page.locator('.map-viewport').first();
}

/**
 * Wait for the deck.gl canvas to exist and have a real backing WebGL context.
 * Throws a clear, distinguishable error if WebGL is unavailable in the
 * environment (so the suite reports "environment cannot run WebGL" rather than
 * producing a misleading pass/fail).
 */
export async function waitForWebGLCanvas(page: Page): Promise<void> {
  await deckCanvas(page).waitFor({ state: 'attached', timeout: 60_000 });

  const webglStatus = await page.evaluate(() => {
    const canvases = Array.from(
      document.querySelectorAll('.map-viewport canvas'),
    );
    for (const c of canvases) {
      const el = c as HTMLCanvasElement;
      const gl =
        (el.getContext('webgl2') as WebGL2RenderingContext | null) ||
        (el.getContext('webgl') as WebGLRenderingContext | null);
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          ok: true,
          renderer: dbg
            ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
            : 'unknown',
        };
      }
    }
    // Probe a throwaway canvas to distinguish "no deck canvas yet" from
    // "WebGL is fundamentally unavailable".
    const probe = document.createElement('canvas');
    const probeGl = probe.getContext('webgl2') || probe.getContext('webgl');
    return {
      ok: false,
      webglAvailable: !!probeGl,
      renderer: null as string | null,
    };
  });

  if (!webglStatus.ok && webglStatus.webglAvailable === false) {
    throw new Error(
      'WEBGL_UNAVAILABLE: This environment cannot create a WebGL context. ' +
        'deck.gl cannot render. Run on a machine/CI with SwiftShader or a GPU.',
    );
  }
  if (webglStatus.renderer) {
    console.log(`[render-test] WebGL renderer: ${webglStatus.renderer}`);
  }
}

/**
 * Decode a PNG buffer to its raw RGBA pixel data.
 *
 * We decode Playwright's *element screenshots* rather than reading the WebGL
 * canvas in-page. deck.gl creates its WebGL context without
 * `preserveDrawingBuffer`, so an in-page `canvas.toDataURL()` / `drawImage()`
 * of the deck canvas returns a blank buffer once the frame has been composited
 * — even though the scene is clearly visible on screen. Playwright screenshots
 * capture the *composited* output of the page and are therefore the reliable
 * source of rendered pixels regardless of `preserveDrawingBuffer`.
 */
function decodePng(buffer: Buffer): {
  width: number;
  height: number;
  data: Buffer;
} {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * Screenshot the map viewport, decode it, and report colour statistics.
 * `variance` is luminance variance; `uniqueColors` counts distinct RGB values;
 * `nonBackground` is the fraction of pixels far from the showcase background.
 */
export async function canvasPixelStats(page: Page): Promise<{
  variance: number;
  uniqueColors: number;
  nonBackground: number;
} | null> {
  let buffer: Buffer;
  try {
    buffer = await mapViewport(page).screenshot();
  } catch {
    return null;
  }
  let img: { width: number; height: number; data: Buffer };
  try {
    img = decodePng(buffer);
  } catch {
    return null;
  }
  const data = img.data;
  if (data.length === 0) return null;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let nonBackground = 0;
  const colorSet = new Set<number>();
  // Showcase background is roughly #242730 (36, 39, 48).
  const bg = [36, 39, 48];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += lum;
    sumSq += lum * lum;
    count++;
    colorSet.add((r << 16) | (g << 8) | b);
    const dist =
      Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
    if (dist > 30) nonBackground++;
  }
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return {
    variance,
    uniqueColors: colorSet.size,
    nonBackground: nonBackground / count,
  };
}

/**
 * Capture an RGBA pixel array of the rendered map viewport.
 *
 * Decodes a Playwright element screenshot (the composited output) — see
 * decodePng for why we cannot read the WebGL canvas in-page. Two captures of
 * the same viewport are directly comparable with pixelArrayDiffRatio.
 */
export async function captureCanvasPixels(
  page: Page,
): Promise<number[] | null> {
  let buffer: Buffer;
  try {
    buffer = await mapViewport(page).screenshot();
  } catch {
    return null;
  }
  try {
    const img = decodePng(buffer);
    return Array.from(img.data);
  } catch {
    return null;
  }
}

/** Fraction of pixels that differ meaningfully between two RGBA arrays. */
export function pixelArrayDiffRatio(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 1;
  let changed = 0;
  let total = 0;
  for (let i = 0; i < len; i += 4) {
    total++;
    const d =
      Math.abs(a[i] - b[i]) +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2]);
    if (d > 24) changed++;
  }
  return total === 0 ? 0 : changed / total;
}

/**
 * Measure FPS by counting requestAnimationFrame callbacks in-page over a
 * window. Also returns frame-time percentiles.
 */
export async function measureFps(
  page: Page,
  durationMs: number,
): Promise<{
  fps: number;
  frames: number;
  p50: number;
  p95: number;
  max: number;
}> {
  return page.evaluate(async (duration) => {
    return await new Promise<{
      fps: number;
      frames: number;
      p50: number;
      p95: number;
      max: number;
    }>((resolve) => {
      const frameTimes: number[] = [];
      let last = performance.now();
      const start = last;
      function tick(now: number) {
        frameTimes.push(now - last);
        last = now;
        if (now - start < duration) {
          requestAnimationFrame(tick);
        } else {
          const sorted = [...frameTimes].sort((x, y) => x - y);
          const pick = (p: number) =>
            sorted.length
              ? sorted[
                  Math.min(sorted.length - 1, Math.floor(p * sorted.length))
                ]
              : 0;
          const elapsed = now - start;
          resolve({
            fps: (frameTimes.length / elapsed) * 1000,
            frames: frameTimes.length,
            p50: pick(0.5),
            p95: pick(0.95),
            max: sorted.length ? sorted[sorted.length - 1] : 0,
          });
        }
      }
      requestAnimationFrame(tick);
    });
  }, durationMs);
}

/** Read the FPS value the showcase PerformanceMonitor displays, if visible. */
export async function readMonitorFps(page: Page): Promise<number | null> {
  // The monitor must be expanded for the FPS row to be in the DOM.
  const perfToggle = page.getByRole('button', { name: 'Perf' });
  if ((await perfToggle.count()) === 0) return null;
  // Expand if the FPS row isn't already present.
  const fpsRow = page.locator('text=FPS:').first();
  if ((await fpsRow.count()) === 0) {
    await perfToggle.click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  const rows = page.locator('.map-viewport >> text=FPS:');
  if ((await rows.count()) === 0) return null;
  // The value sits in the sibling span; grab the parent row text.
  const rowText = await rows
    .first()
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  const m = rowText.match(/FPS:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Get the time-scrubber range input inside the demo TimeControls. */
export function timeSlider(page: Page): Locator {
  // The progress scrubber is the range input whose min/max are large epoch
  // millisecond values (the speed sliders use small ranges like 0.25..20).
  return page.locator('input[type="range"]').first();
}

/** Set a range input to a value and dispatch input/change events React sees. */
export async function setRangeValue(
  locator: Locator,
  value: number,
): Promise<void> {
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

export async function getRangeBounds(
  locator: Locator,
): Promise<{ min: number; max: number; value: number }> {
  return locator.evaluate((el) => {
    const i = el as HTMLInputElement;
    return { min: Number(i.min), max: Number(i.max), value: Number(i.value) };
  });
}

/** Find the play/pause button in TimeControls by its glyph. */
export function playButton(page: Page): Locator {
  return page
    .locator('.map-viewport ~ * button, button')
    .filter({ hasText: /^[▶⏸]$/ })
    .first();
}
